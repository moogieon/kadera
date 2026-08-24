import type { Category } from "./types.js";
import { normalizeQuestion } from "./text.js";

export interface ClaimSignature {
  text: string;
  tokens: string[];
  category: Exclude<Category, "auto">;
  direction: "benefit" | "harm" | "association" | "unclear";
  numericSignature: string;
}

const stopwords = new Set([
  "그냥", "정도", "정말", "일반적으로", "사실", "맞아", "맞나요", "맞지", "있어", "있나요",
  "하면", "해도", "한다", "하는", "이라고", "이라는", "말이", "말은", "건가", "거야", "뭐야",
  "얼마나", "어떻게", "왜", "좀", "더", "꼭", "무조건", "실제로", "관련", "연구", "논문"
]);

export function buildClaimSignature(
  question: string,
  category: Exclude<Category, "auto">,
  queryTerms: string[]
): ClaimSignature {
  const normalized = normalizeQuestion(question);
  const questionTokens = normalized
    .split(/\s+/)
    .map(cleanToken)
    .filter((token) => token.length >= 2 && !stopwords.has(token));
  const queryTokens = queryTerms
    .flatMap((term) => term.toLowerCase().split(/[^a-z0-9가-힣]+/))
    .map(cleanToken)
    .filter((token) => token.length >= 2 && !stopwords.has(token));
  const tokens = [...new Set([...questionTokens, ...queryTokens])].slice(0, 40);
  return {
    text: tokens.join(" "),
    tokens,
    category,
    direction: inferDirection(normalized),
    numericSignature: extractNumericSignature(normalized)
  };
}

export function signatureSimilarity(left: ClaimSignature, rightTokens: string[]): number {
  if (left.tokens.length === 0 || rightTokens.length === 0) return 0;
  const right = new Set(rightTokens);
  const overlap = left.tokens.filter((token) => right.has(token)).length;
  const denominator = Math.min(left.tokens.length, right.size);
  return denominator > 0 ? overlap / denominator : 0;
}

function inferDirection(question: string): ClaimSignature["direction"] {
  const negations = question.match(/(?:안\s|않|없|아니)/g)?.length ?? 0;
  if (negations >= 2 || /(?:지만|반면|둘\s*중|vs\.?|뭐가\s*더)/.test(question)) return "unclear";
  if (/(안\s*(?:좋|도움|효과)|좋지\s*않|효과\s*(?:없|않)|도움(?:이|은|도)?\s*(?:없|않))/.test(question)) return "harm";
  if (/(위험|질환|혈압|사망|부작용).*(높|올|늘|증가|생기)|(?:높|올|늘|증가).*(위험|질환|혈압|사망|부작용)/.test(question)) return "harm";
  if (/(예방|도움|개선|좋아|회복|건강해)|(위험|질환|혈압|사망|부작용).*(줄|낮|감소)/.test(question)) return "benefit";
  if (/(안\s*좋|나쁘|나쁜|위험|상해|망치|높아져|올라가|질환|부작용|암|탈모)/.test(question)) return "harm";
  if (/(효과|줄어|낮아|회복|건강해)/.test(question)) return "benefit";
  if (/(영향|관련|연관|차이|변화)/.test(question)) return "association";
  return "unclear";
}

function extractNumericSignature(question: string): string {
  const digitValues = [...question.matchAll(/\d+(?:\.\d+)?\s*(?:mg|kg|g|ml|l|잔|개|회|분|시간|일|주|개월|년|%|세)?/gi)]
    .map((match) => match[0].replace(/\s+/g, "").toLowerCase());
  const nativeNumbers: Record<string, string> = {
    한: "1",
    두: "2",
    세: "3",
    네: "4",
    다섯: "5",
    여섯: "6",
    일곱: "7",
    여덟: "8",
    아홉: "9",
    열: "10",
    스무: "20"
  };
  const wordValues = [...question.matchAll(/(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무)\s*(잔|개|회|분|시간|일|주|개월|년|세)/g)]
    .map((match) => `${nativeNumbers[match[1] ?? ""] ?? match[1]}${match[2] ?? ""}`);
  const values = [...digitValues, ...wordValues].sort();
  return [...new Set(values)].join("|");
}

function cleanToken(value: string): string {
  return value.replace(/[^a-z0-9가-힣]/g, "").trim();
}
