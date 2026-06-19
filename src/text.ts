import type { Category } from "./types.js";

const whitespace = /\s+/g;
const punctuation = /[?!.,;:，。！？'"`“”‘’()[\]{}<>]/g;

export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(punctuation, " ")
    .replace(whitespace, " ")
    .trim();
}

export function classifyCategory(question: string, category: Category): Exclude<Category, "auto"> {
  const q = normalizeQuestion(question);
  const inferred = inferCategory(q);
  if (category !== "auto" && !isStrongCategoryConflict(q, category, inferred)) return category;
  return inferred;
}

function inferCategory(q: string): Exclude<Category, "auto"> {
  if (/(아이|애|아기|영유아|유아|어린이|초등|육아|분유|이유식|편식|고기 안 먹|영상 보여|눈.?마주|눈맞춤|시선|자폐|발달지연)/.test(q)) {
    return "childcare";
  }
  if (/(공부|학습|교육|외국어|영어|수학|학교|성적|집중력|암기)/.test(q)) {
    return "education";
  }
  if (/(식단|영양|비타민|영양제|탄수|단백질|프로틴|파우더|보충제|지방|간헐적|단식|오메가|철분|칼슘|제로|탄산|감미료|설탕|아스파탐|수크랄로스|스테비아)/.test(q)) {
    return "nutrition";
  }
  if (/(운동|근력|유산소|스트레칭|헬스|근육|부상|러닝|달리기)/.test(q)) {
    return "exercise";
  }
  if (/(불안|우울|스트레스|심리|수면|잠|집중|명상|공황)/.test(q)) {
    return "psychology";
  }
  return "health";
}

function isStrongCategoryConflict(q: string, requested: Category, inferred: Exclude<Category, "auto">): boolean {
  if (requested === inferred) return false;
  if (/(눈.?마주|눈맞춤|시선|자폐|발달지연|12개월|영아|아기|아이)/.test(q) && inferred === "childcare") {
    return true;
  }
  return false;
}

export function buildQueryTerms(question: string, category: Exclude<Category, "auto">): string[] {
  const q = normalizeQuestion(question);
  const terms = new Set<string>();

  for (const [pattern, english] of keywordMap) {
    if (pattern.test(q)) {
      for (const term of english) terms.add(term);
    }
  }

  for (const term of categoryDefaults[category]) terms.add(term);
  if (terms.size === 0) terms.add(q);
  return [...terms].slice(0, 20);
}

export function buildSearchQuery(terms: string[], category: Exclude<Category, "auto">): string {
  const categoryFilter = categorySearchFilters[category];
  const termQuery = terms.length > 1 ? `(${terms.map(formatSearchTerm).join(" OR ")})` : terms[0];
  return [termQuery, categoryFilter].filter(Boolean).join(" AND ");
}

function formatSearchTerm(term: string): string {
  return /\s/.test(term) ? `"${term}"` : term;
}

const categoryDefaults: Record<Exclude<Category, "auto">, string[]> = {
  health: ["health", "clinical study"],
  childcare: ["child", "infant", "development"],
  education: ["education", "learning"],
  exercise: ["exercise", "physical activity"],
  nutrition: ["nutrition", "diet"],
  psychology: ["psychology", "mental health"]
};

const categorySearchFilters: Record<Exclude<Category, "auto">, string> = {
  health: "(review OR clinical trial OR cohort)",
  childcare: "(infant OR toddler OR child OR pediatric OR development)",
  education: "(education OR learning)",
  exercise: "(exercise OR physical activity)",
  nutrition: "(nutrition OR diet)",
  psychology: "(psychology OR sleep OR anxiety OR mental health)"
};

const keywordMap: Array<[RegExp, string[]]> = [
  [/(공복|빈속)/, ["fasted exercise", "fasted cardio"]],
  [/(유산소|러닝|달리기)/, ["aerobic exercise"]],
  [/(살|체중|다이어트|감량|비만)/, ["weight loss", "body weight"]],
  [/(단백질)/, ["protein intake", "dietary protein"]],
  [/(단백질.*(파우더|보충제)|프로틴|웨이|whey|protein powder|protein supplement)/, ["whey protein supplementation", "protein powder", "protein supplement", "protein supplementation resistance training meta-analysis"]],
  [/(100g|100 g|그램|g이상|g 이상)/, ["protein dose", "grams per kilogram per day", "dose response protein intake"]],
  [/(근성장|근비대|근육량|근육.*성장|벌크|lean mass|hypertrophy)/, ["muscle hypertrophy", "lean body mass", "resistance training", "dietary protein muscle mass meta-analysis"]],
  [/(과다|과잉|너무 많이|많이 먹)/, ["high protein intake"]],
  [/(신장|콩팥|신부전|kidney|renal)/, ["kidney function", "renal function", "chronic kidney disease", "high protein diet kidney function", "protein intake renal function healthy adults"]],
  [/(탈모|머리.?빠|hair.?loss|alopecia)/, ["hair loss", "alopecia", "protein supplement hair loss"]],
  [/(스트레칭)/, ["stretching", "injury prevention"]],
  [/(부상)/, ["injury prevention"]],
  [/(간헐적|단식)/, ["intermittent fasting"]],
  [/(탄수|탄수화물)/, ["carbohydrate restriction"]],
  [/(제로|무설탕|zero|diet soda|다이어트.?콜라|탄산|콜라|사이다)/, ["non-sugar sweeteners", "low calorie sweeteners", "artificial sweeteners", "sugar-sweetened beverages", "diet soda"]],
  [/(감미료|아스파탐|수크랄로스|스테비아|에리스리톨|알룰로스|아세설팜|ace.?k|aspartame|sucralose|stevia|erythritol|allulose)/, ["aspartame", "sucralose", "acesulfame potassium", "stevia", "erythritol", "gut microbiome", "glucose tolerance"]],
  [/(혈당|인슐린|당뇨|대사|장내|마이크로바이옴)/, ["glucose metabolism", "insulin response", "type 2 diabetes", "gut microbiota", "metabolic health"]],
  [/(고기|육류)/, ["meat intake", "iron intake"]],
  [/(편식|안 먹)/, ["picky eating", "food refusal"]],
  [/(영상|스마트폰|유튜브|스크린)/, ["screen time"]],
  [/(눈.?마주|눈맞춤|눈.?맞춤|시선|아이컨택|eye.?contact)/, ["eye contact", "gaze behavior", "social attention", "joint attention", "autism spectrum disorder", "developmental screening"]],
  [/(12개월|돌|영아|아기|영유아|유아|infant|toddler)/, ["infant", "toddler"]],
  [/(자폐|autism|asd)/, ["autism spectrum disorder", "early signs autism"]],
  [/(발달지연|발달|사회성|상호작용)/, ["developmental delay", "social communication"]],
  [/(외국어|영어|언어)/, ["second language exposure", "bilingualism"]],
  [/(수면|잠)/, ["sleep deprivation", "sleep quality"]],
  [/(집중|주의력)/, ["attention", "cognition"]],
  [/(불안)/, ["anxiety"]],
  [/(우울)/, ["depression"]],
  [/(비타민 d|비타민d)/, ["vitamin D"]],
  [/(오메가)/, ["omega-3"]],
  [/(철분)/, ["iron deficiency"]],
  [/(칼슘)/, ["calcium"]]
];
