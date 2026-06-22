import type { Config } from "../config.js";
import { categories, type Category, type ClaimAnswer, type EvidenceInterpretation, type EvidenceSearchResult, type EvidenceStance, type Paper, type PracticalCheck, type Verdict } from "../types.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

interface GeminiClaimJson {
  answer_ko?: string;
  verdict?: Verdict;
  limitations?: string[];
  practical_checks?: PracticalCheck[];
  evidence_interpretation?: Array<{
    citationIndex?: number;
    stance?: EvidenceStance;
    reason_ko?: string;
  }>;
}

interface GeminiSearchPlanJson {
  category?: Category;
  query_terms?: string[];
  reason_ko?: string;
}

export interface SearchPlan {
  category: Exclude<Category, "auto">;
  queryTerms: string[];
  reason_ko?: string;
}

export class GeminiRagClient {
  constructor(private readonly config: Config, private readonly fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return Boolean(this.config.geminiApiKey);
  }

  async planSearch(
    question: string,
    fallbackCategory: Exclude<Category, "auto">,
    fallbackTerms: string[]
  ): Promise<SearchPlan> {
    if (!this.config.geminiApiKey) {
      return { category: fallbackCategory, queryTerms: fallbackTerms, reason_ko: "Gemini key 없음. 규칙 기반 검색어 사용." };
    }

    const payload = {
      question,
      allowed_categories: categories.filter((category) => category !== "auto"),
      fallback: {
        category: fallbackCategory,
        query_terms: fallbackTerms
      },
      rules: [
        "Return strict JSON only.",
        "Translate the Korean claim into precise English scholarly search terms.",
        "Prefer medical/research vocabulary, age group, condition, outcome, and population.",
        "Do not answer the claim. Only plan retrieval.",
        "Return 4 to 8 query_terms.",
        "Do not include broad generic terms unless needed."
      ],
      required_json_shape: {
        category: "health | childcare | education | exercise | nutrition | psychology",
        query_terms: ["English scholarly search term"],
        reason_ko: "short Korean explanation of why these search terms were selected"
      }
    };

    const response = await this.fetchFn(geminiUrl(this.config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are a retrieval planner for a Korean evidence-based claim checker. " +
                "You turn Korean user claims into precise English scholarly database search terms. " +
                "You never answer the claim in this step."
            }
          ]
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) throw new Error(`Gemini search planning failed: ${response.status}`);
    const json = (await response.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini search planning returned empty text");

    const plan = parseGeminiJson(text) as GeminiSearchPlanJson;
    return {
      category: sanitizeCategory(plan.category, fallbackCategory),
      queryTerms: sanitizeQueryTerms(plan.query_terms, fallbackTerms),
      reason_ko: plan.reason_ko?.trim()
    };
  }

  async synthesizeClaim(question: string, evidence: EvidenceSearchResult, fallback: ClaimAnswer): Promise<ClaimAnswer> {
    if (!this.config.geminiApiKey) return fallback;
    if (evidence.papers.length === 0) return fallback;

    const payload = {
      question,
      category: evidence.category,
      allowed_verdicts: ["supported", "mixed", "not_supported", "insufficient_evidence"],
      rules: [
        "Use only the provided evidence items.",
        "Do not invent citations, titles, authors, DOIs, URLs, statistics, or paper findings.",
        "If the evidence is only tangential or too weak, return insufficient_evidence.",
        "Preprints must be described as lower confidence than peer-reviewed systematic reviews or clinical studies.",
        "Answer in Korean for a general user, not as medical diagnosis or prescription.",
        "Synthesize the evidence like a person explaining what the papers say, not like a search result list.",
        "When years are available, compare older evidence and more recent evidence without exaggerating a trend.",
        "Use citation indices like [1], [2] only for the provided evidence items.",
        "The product exists because users hate agreeable, vague answers. Do not say both sides are right unless you specify exactly which side is right under which condition.",
        "If the question describes a debate between people, answer as a debate judge: claim A verdict, claim B verdict, what would change the verdict, and what evidence would settle it.",
        "Never mirror the user's framing. If the user asks 'is it bad?', do not just agree. If the user asks 'is it good?', do not just agree. Compare the claim against the evidence.",
        "Do not stop at 'it depends'. If the user asks about an amount, calculate concrete examples using plausible assumptions and clearly label them as examples.",
        "Do not ask the user to provide basic demographics before giving value. Provide default interpretation for adult male, adult female, pregnancy/lactation, children/adolescents, older adults, and major comorbidity groups when relevant.",
        "If demographics change the answer, include a '대상자별로 보면' section instead of only saying '개인마다 다릅니다'.",
        "For protein, supplements, exercise, or nutrition dosage questions, compare the user's amount against g/kg/day evidence ranges when possible.",
        "For protein and muscle gain questions, separate: muscle/lean mass evidence, total daily protein target, per-meal dose if evidence supports it, kidney safety in healthy adults, kidney disease caution, and unsupported claims such as hair loss if the provided evidence does not support them.",
        "For food additive, sweetener, supplement, cosmetic, medicine, device, or consumer product questions, include label names users should look for, common product categories, and a warning that exact brand formulas can change by country and date.",
        "For sweetener and zero-sugar drink questions, separate sugar-sweetened beverage evidence, non-sugar sweetener evidence, individual sweetener concerns, ADI/safety-agency context when available in evidence, and practical label-check guidance.",
        "When discussing studies, say what kind of study it was: randomized trial, cohort, systematic review/meta-analysis, mechanistic/lab, animal, or guideline review. Explain what was measured and what the study cannot prove.",
        "When available, identify where the study came from: publication year, journal/venue, institution/affiliation, publisher, and first author/research team. Do not invent institutions.",
        "Always include a '대표 연구를 뜯어보면' section in answer_ko. For 2 to 4 key evidence items, explain: study title/index, study type, what researchers actually did or compared, population if available, measured outcome, result direction, and why that supports or limits the answer.",
        "Do not only say 'research generally says'. The user must be able to say '아 그 연구는 그런 식으로 했구나'.",
        "Use a direct answer first: too much / reasonable / probably unnecessary / risky for specific groups.",
        "For common internet arguments, use this structure inside answer_ko: '판정', '누가 맞나', '숫자로 보면', '논문/연구가 실제로 말하는 것', '성분/제품 라벨에서 볼 것', '틀리기 쉬운 포인트', '내가 확인할 것'.",
        "Always include practical_checks: concrete things the user can observe, record, compare, or ask a professional about.",
        "For childcare/development questions, include around 10 parent-observable checks when evidence supports this style of guidance.",
        "For nutrition, exercise, education, psychology, and general health, include practical checks adapted to that domain."
      ],
      required_json_shape: {
        answer_ko:
          "Korean answer. Include direct answer, numeric examples if dose-related, what older papers suggested, what newer papers suggest, a '대표 연구를 뜯어보면' study-by-study section, confidence, and practical caveat. Avoid vague 'depends' without examples.",
        verdict: "supported | mixed | not_supported | insufficient_evidence",
        limitations: ["Korean limitation strings"],
        practical_checks: [
          {
            label: "short Korean label",
            what_to_try_ko: "specific thing to try or record",
            what_to_watch_ko: "what pattern to watch for",
            why_it_matters_ko: "why this matters based on provided evidence",
            urgency: "routine_observation | discuss_with_professional | seek_prompt_evaluation"
          }
        ],
        evidence_interpretation: [
          {
            citationIndex: "number from provided evidence only",
            stance: "supports | opposes | mixed | unclear",
            reason_ko: "short Korean reason based only on this evidence item"
          }
        ]
      },
      evidence: evidence.papers.slice(0, 8).map(toLlmEvidence)
    };

    const response = await this.fetchFn(geminiUrl(this.config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are a Korean evidence synthesis layer for a research-backed claim checker. " +
                "Think of the evidence items as the only books on your desk. " +
                "Your job is to explain what those books say in Korean, including whether older and newer papers differ. " +
                "Return strict JSON only. Ground every conclusion in the provided evidence list."
            }
          ]
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) throw new Error(`Gemini RAG synthesis failed: ${response.status}`);
    const json = (await response.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini RAG synthesis returned empty text");

    return mergeGeminiAnswer(parseGeminiJson(text) as GeminiClaimJson, fallback);
  }
}

function toLlmEvidence(paper: Paper, index: number): Record<string, unknown> {
  return {
    citationIndex: index + 1,
    source: paper.source,
    sourceId: paper.sourceId,
    title: paper.title,
    authors: paper.authors.slice(0, 6),
    venue: paper.venue,
    publisher: paper.publisher,
    institutions: paper.institutions?.slice(0, 4),
    year: paper.year,
    doi: paper.doi,
    url: paper.url,
    evidenceLevel: paper.evidenceLevel,
    publicationTypes: paper.publicationTypes,
    abstract: trimForPrompt(paper.abstract, 1400)
  };
}

function mergeGeminiAnswer(gemini: GeminiClaimJson, fallback: ClaimAnswer): ClaimAnswer {
  const verdict = isVerdict(gemini.verdict) ? gemini.verdict : fallback.verdict;
  const interpretations = sanitizeInterpretations(gemini.evidence_interpretation, fallback);

  return {
    ...fallback,
    answer_ko: gemini.answer_ko?.trim() || fallback.answer_ko,
    verdict,
    evidence_interpretation: interpretations.length > 0 ? interpretations : fallback.evidence_interpretation,
    practical_checks: sanitizePracticalChecks(gemini.practical_checks, fallback.practical_checks),
    limitations: sanitizeLimitations(gemini.limitations, fallback.limitations)
  };
}

function sanitizeInterpretations(
  items: GeminiClaimJson["evidence_interpretation"],
  fallback: ClaimAnswer
): EvidenceInterpretation[] {
  const citations = fallback.citations;
  return (items ?? [])
    .map((item) => {
      const citationIndex = Number(item.citationIndex);
      const citation = citations[citationIndex - 1];
      if (!citation || !isStance(item.stance)) return undefined;
      return {
        citationIndex,
        source: citation.source,
        title: citation.title,
        stance: item.stance,
        reason_ko: item.reason_ko?.trim() || "제공된 근거 안에서 모델이 해석한 방향입니다.",
        evidenceLevel: citation.evidenceLevel
      };
    })
    .filter((item): item is EvidenceInterpretation => Boolean(item));
}

function sanitizeLimitations(items: string[] | undefined, fallback: string[]): string[] {
  const clean = (items ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 5);
  return clean.length > 0 ? clean : fallback;
}

function sanitizePracticalChecks(items: PracticalCheck[] | undefined, fallback: PracticalCheck[] | undefined): PracticalCheck[] | undefined {
  const clean = (items ?? [])
    .map((item) => ({
      label: item.label?.trim(),
      what_to_try_ko: item.what_to_try_ko?.trim(),
      what_to_watch_ko: item.what_to_watch_ko?.trim(),
      why_it_matters_ko: item.why_it_matters_ko?.trim(),
      urgency: item.urgency
    }))
    .filter((item): item is PracticalCheck =>
      Boolean(
        item.label &&
          item.what_to_try_ko &&
          item.what_to_watch_ko &&
          item.why_it_matters_ko &&
          ["routine_observation", "discuss_with_professional", "seek_prompt_evaluation"].includes(item.urgency)
      )
    )
    .slice(0, 10);
  if (clean.length < 8 && fallback && fallback.length > clean.length) return fallback.slice(0, 10);
  return clean.length > 0 ? clean : fallback;
}

function parseGeminiJson(text: string): GeminiClaimJson | GeminiSearchPlanJson {
  const stripped = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(stripped) as GeminiClaimJson;
}

function sanitizeCategory(value: unknown, fallback: Exclude<Category, "auto">): Exclude<Category, "auto"> {
  return categories.includes(value as Category) && value !== "auto" ? (value as Exclude<Category, "auto">) : fallback;
}

function sanitizeQueryTerms(items: string[] | undefined, fallback: string[]): string[] {
  const clean = (items ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 80)
    .slice(0, 12);
  return clean.length > 0 ? clean : fallback;
}

function isVerdict(value: unknown): value is Verdict {
  return ["supported", "mixed", "not_supported", "insufficient_evidence"].includes(String(value));
}

function isStance(value: unknown): value is EvidenceStance {
  return ["supports", "opposes", "mixed", "unclear"].includes(String(value));
}

function trimForPrompt(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function geminiUrl(config: Config): string {
  const model = encodeURIComponent(config.geminiModel);
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  url.searchParams.set("key", config.geminiApiKey ?? "");
  return url.toString();
}
