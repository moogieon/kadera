interface RxNavApproximateResponse {
  approximateGroup?: {
    candidate?: Array<{
      rxcui?: string;
      name?: string;
      rank?: string;
    }>;
  };
}

interface RxNavRelatedResponse {
  relatedGroup?: {
    conceptGroup?: Array<{
      tty?: string;
      conceptProperties?: Array<{
        name?: string;
      }>;
    }>;
  };
}

/**
 * RxNorm is used only to normalize a possible medicine brand or typo before
 * scholarly retrieval. It never contributes a health claim or a citation.
 */
export class RxNavClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async resolveActiveIngredients(terms: string[]): Promise<string[]> {
    return uniqueStrings((await this.resolveIngredientAliases(terms)).map((alias) => alias.ingredient));
  }

  /**
   * Keep the term the user actually typed alongside the ingredient it resolves
   * to. Retrieval only needs the ingredient, but the answer then talks about
   * "티르제파타이드" to someone who asked about "마운자로" and never says they
   * are the same drug. The pairing is what makes the answer readable.
   */
  async resolveIngredientAliases(terms: string[]): Promise<IngredientAlias[]> {
    const candidates = candidateTermsWithMention(terms).slice(0, 6);
    // The explicit table is authoritative and free; RxNorm only fills gaps.
    const known = candidates.flatMap((candidate) => {
      const ingredient = ingredientForKoreanBrand(candidate.mention);
      return ingredient ? [{ mention: candidate.mention, ingredient }] : [];
    });
    if (candidates.length === 0) return known;

    const resolved = await Promise.allSettled(
      candidates.map(async (candidate) => ({ candidate, ingredients: await this.resolveTerm(candidate.candidate) }))
    );
    const aliases: IngredientAlias[] = [...known];
    const seen = new Set(known.map((alias) => `${alias.mention.toLowerCase()}|${alias.ingredient.toLowerCase()}`));
    for (const result of resolved) {
      if (result.status !== "fulfilled") continue;
      for (const ingredient of result.value.ingredients) {
        const key = `${result.value.candidate.mention.toLowerCase()}|${ingredient.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        aliases.push({ mention: result.value.candidate.mention, ingredient });
      }
    }
    return aliases;
  }

  private async resolveTerm(term: string): Promise<string[]> {
    const approximateUrl = new URL("https://rxnav.nlm.nih.gov/REST/approximateTerm.json");
    approximateUrl.searchParams.set("term", term);
    approximateUrl.searchParams.set("maxEntries", "4");
    const approximateResponse = await this.fetchFn(approximateUrl);
    if (!approximateResponse.ok) return [];
    const approximate = await approximateResponse.json() as RxNavApproximateResponse;
    const rxcuis = uniqueStrings((approximate.approximateGroup?.candidate ?? [])
      .filter((candidate) => candidate.rxcui && isCloseMedicineName(term, candidate.name))
      .sort((left, right) => Number(left.rank ?? "999") - Number(right.rank ?? "999"))
      .map((candidate) => candidate.rxcui)
      .filter((value): value is string => Boolean(value)))
      .slice(0, 2);
    if (rxcuis.length === 0) return [];

    const related = await Promise.allSettled(rxcuis.map(async (rxcui) => {
      const relatedUrl = new URL(`https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/related.json`);
      relatedUrl.searchParams.set("tty", "IN");
      const response = await this.fetchFn(relatedUrl);
      if (!response.ok) return [];
      const json = await response.json() as RxNavRelatedResponse;
      return (json.relatedGroup?.conceptGroup ?? [])
        .filter((group) => group.tty === "IN")
        .flatMap((group) => group.conceptProperties ?? [])
        .map((property) => property.name?.trim())
        .filter((name): name is string => Boolean(name));
    }));
    return uniqueStrings(related.flatMap((result) => result.status === "fulfilled" ? result.value : []));
  }
}

export interface IngredientAlias {
  /** The term as the user or planner wrote it, e.g. "마운자로". */
  mention: string;
  /** The RxNorm active ingredient it resolves to, e.g. "tirzepatide". */
  ingredient: string;
}

interface CandidateTerm {
  /** The romanized or cleaned string sent to RxNorm. */
  candidate: string;
  /** The original text it came from, preserved for the reader-facing glossary. */
  mention: string;
}

/**
 * Romanized Hangul does not reliably reach the English brand spelling: 위고비
 * becomes "wigobi", which RxNorm scores three edits from "Wegovy". The planner
 * guesses just as badly and differently every call ("Wigobi", "Wigo-bi",
 * "MyunJaro"), and those words appear in no paper at all. The brands Korean
 * users actually ask about are therefore listed explicitly. Verified against
 * the ingredient name RxNorm returns for the English brand.
 */
export interface KoreanBrand {
  /** RxNorm active ingredient, the term scholarly databases index. */
  ingredient: string;
  /** The English brand name papers also use, when one exists. */
  brand?: string;
}

export const koreanBrands: Record<string, KoreanBrand> = {
  위고비: { ingredient: "semaglutide", brand: "Wegovy" },
  오젬픽: { ingredient: "semaglutide", brand: "Ozempic" },
  마운자로: { ingredient: "tirzepatide", brand: "Mounjaro" },
  삭센다: { ingredient: "liraglutide", brand: "Saxenda" },
  타이레놀: { ingredient: "acetaminophen", brand: "Tylenol" },
  부루펜: { ingredient: "ibuprofen", brand: "Brufen" },
  이지엔: { ingredient: "ibuprofen" },
  아스피린: { ingredient: "aspirin" },
  게보린: { ingredient: "acetaminophen" },
  판콜에이: { ingredient: "acetaminophen" },
  콘택골드: { ingredient: "chlorpheniramine" },
  훼스탈: { ingredient: "pancreatin" },
  베아제: { ingredient: "pancreatin" },
  겔포스: { ingredient: "antacid" },
  까스활명수: { ingredient: "antacid" },
  크레스토: { ingredient: "rosuvastatin", brand: "Crestor" },
  리피토: { ingredient: "atorvastatin", brand: "Lipitor" },
  아토르바: { ingredient: "atorvastatin" },
  자디앙: { ingredient: "empagliflozin", brand: "Jardiance" },
  포시가: { ingredient: "dapagliflozin", brand: "Forxiga" },
  트루리시티: { ingredient: "dulaglutide", brand: "Trulicity" },
  콘서타: { ingredient: "methylphenidate", brand: "Concerta" },
  아모잘탄: { ingredient: "amlodipine" },
  노바스크: { ingredient: "amlodipine", brand: "Norvasc" },
  라니티딘: { ingredient: "ranitidine" },
  잔탁: { ingredient: "ranitidine", brand: "Zantac" },
  타미플루: { ingredient: "oseltamivir", brand: "Tamiflu" },
  듀파락: { ingredient: "lactulose", brand: "Duphalac" },
  우루사: { ingredient: "ursodeoxycholic acid" },
  케토톱: { ingredient: "ketoprofen" },
  프로페시아: { ingredient: "finasteride", brand: "Propecia" },
  미녹시딜: { ingredient: "minoxidil" },
  비아그라: { ingredient: "sildenafil", brand: "Viagra" },
  자낙스: { ingredient: "alprazolam", brand: "Xanax" },
  스틸녹스: { ingredient: "zolpidem", brand: "Stilnox" }
};

/** Retrieval terms for a brand: the ingredient first, then the English brand. */
export function koreanBrandSearchTerms(mention: string): string[] {
  const brand = koreanBrands[mention];
  if (!brand) return [];
  return brand.brand ? [brand.ingredient, brand.brand] : [brand.ingredient];
}

export function ingredientForKoreanBrand(token: string): string | undefined {
  return koreanBrands[token]?.ingredient;
}

/**
 * Reader-facing brand pairs for a Korean question. Only the verified table is
 * used: RxNorm's approximate match returns every ingredient of a matched
 * product, so a liquid Tylenol resolves to ethanol among others. That is
 * tolerable noise for retrieval and unacceptable in a printed glossary.
 * Runs offline, so the MCP path can use it inside its latency budget.
 */
export function resolveKoreanBrandAliases(text: string): IngredientAlias[] {
  const seen = new Set<string>();
  return hangulTokens(text).flatMap((token) => {
    const ingredient = ingredientForKoreanBrand(token);
    if (!ingredient || seen.has(token)) return [];
    seen.add(token);
    return [{ mention: token, ingredient }];
  });
}

function candidateTermsWithMention(terms: string[]): CandidateTerm[] {
  // Korean brand names are often transliterated inconsistently by a general
  // model. The standard Hangul-to-Latin form gives RxNorm a stable candidate
  // without maintaining a hand-written product dictionary.
  const korean = terms.flatMap((term) => hangulTokens(term)
    .map((token) => ({ candidate: romanizeHangul(token), mention: token })))
    .filter((entry) => entry.candidate.length >= 3);
  const latin = terms
    .map((term) => term
      .replace(/\b(?:resolve|resolving)\s+(?:to\s+)?(?:the\s+)?canonical\b.*$/i, " ")
      .replace(/\b(?:medication|medicine|drug|injection|injectable|tablet|capsule|treatment)\b/gi, " ")
      .replace(/[^a-z0-9\s-]/gi, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter((term) => /[a-z]/i.test(term) && term.length >= 3 && term.length <= 60)
    .map((term) => ({ candidate: term, mention: term }));
  const seen = new Set<string>();
  return [...korean, ...latin].filter((entry) => {
    const key = entry.candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A Korean particle fuses to the noun, so "위고비와" never reaches RxNorm as
// "wigobi". Stripping is ambiguous in the other direction ("마운자로" ends in
// what looks like the particle 로), so try both forms and let RxNorm decide.
const koreanParticle = /(?:이랑|에서|에게|으로|부터|까지|보다|처럼|랑|과|와|은|는|이|가|을|를|의|도|만|에|로)$/;

/**
 * Korean medicine brand names are three syllables or longer (위고비, 마운자로,
 * 타이레놀). Two-syllable tokens are ordinary words, and RxNorm's approximate
 * match happily turns one into a drug: "차이" resolved to ethanol, which would
 * have been printed to the reader as a glossary entry.
 */
const nonMedicineWords = new Set([
  "차이점", "부작용", "이상반응", "효과가", "비교해", "무엇이", "어느것", "어떤게", "가격이",
  "성분이", "복용법", "사용법", "체중감량", "다이어트", "괜찮아", "안전해", "위험해"
]);

function hangulTokens(value: string): string[] {
  const tokens = (value.match(/[가-힣]{3,16}/g) ?? [])
    .filter((token) => !nonMedicineWords.has(token))
    .flatMap((token) => {
      const stripped = token.replace(koreanParticle, "");
      return stripped !== token && stripped.length >= 3 ? [token, stripped] : [token];
    });
  return [...new Set(tokens)];
}

function romanizeHangul(value: string): string {
  const initials = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
  const vowels = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
  const finals = ["", "g", "kk", "gs", "n", "nj", "nh", "d", "l", "lg", "lm", "lb", "ls", "lt", "lp", "lh", "m", "b", "bs", "s", "ss", "ng", "j", "ch", "k", "t", "p", "h"];
  return Array.from(value).map((character) => {
    const offset = character.charCodeAt(0) - 0xac00;
    if (offset < 0 || offset >= 11_172) return "";
    const initial = Math.floor(offset / 588);
    const vowel = Math.floor((offset % 588) / 28);
    const final = offset % 28;
    return `${initials[initial]}${vowels[vowel]}${finals[final]}`;
  }).join("");
}

function isCloseMedicineName(input: string, candidateName: string | undefined): boolean {
  if (!candidateName) return false;
  const source = normalizeName(input);
  if (source.length < 3) return false;
  const candidateParts = candidateName
    .split(/[\s[\](),/]+/)
    .map(normalizeName)
    .filter((part) => part.length >= 3);
  // Deliberately strict. Loosening this to absorb Hangul romanization noise
  // was tried and matched 타이레놀 to ethanol and 부루펜 to bupivacaine. A
  // missing alias costs nothing; a confidently wrong drug name is a safety
  // problem. Known Korean brands are handled by an explicit table instead.
  return candidateParts.some((part) => {
    const longest = Math.max(source.length, part.length);
    const allowedDistance = Math.max(1, Math.floor(longest * 0.25));
    return levenshteinDistance(source, part) <= allowedDistance;
  });
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]!;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const upper = previous[rightIndex]!;
      previous[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = upper;
    }
  }
  return previous[right.length]!;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const clean = value?.replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const key = clean.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [clean];
  });
}
