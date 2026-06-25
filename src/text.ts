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

export function buildKoreanSearchQueries(question: string, category: Exclude<Category, "auto">): string[] {
  const q = normalizeQuestion(question);
  const queries = new Set<string>();

  if (category === "childcare") {
    if (/(눈.?마주|눈맞춤|시선|아이컨택)/.test(q)) {
      ["눈맞춤", "공동주의", "영유아 발달", "발달선별검사", "자폐"].forEach((term) => queries.add(term));
    }
    if (/(발달지연|발달|사회성|상호작용|개월|아기|아이|영유아|유아)/.test(q)) {
      ["영유아 발달", "발달지연", "발달선별검사"].forEach((term) => queries.add(term));
    }
    if (/(편식|고기|이유식|분유)/.test(q)) {
      ["영유아 영양", "이유식", "편식"].forEach((term) => queries.add(term));
    }
  }

  if (category === "nutrition") {
    if (/(단백질|프로틴|파우더|보충제)/.test(q)) {
      ["단백질 섭취", "고단백 식이", "단백질 보충제"].forEach((term) => queries.add(term));
    }
    if (/(크레아틴|creatine)/i.test(q)) {
      ["크레아틴", "크레아틴 보충제", "운동 보충제"].forEach((term) => queries.add(term));
    }
    if (/(신장|콩팥|신부전)/.test(q)) {
      ["신장 기능", "만성콩팥병", "고단백 식이"].forEach((term) => queries.add(term));
    }
    if (/(제로|무설탕|탄산|감미료|아스파탐|수크랄로스|스테비아)/.test(q)) {
      ["인공감미료", "비당류 감미료", "제로 음료", "혈당"].forEach((term) => queries.add(term));
    }
    if (/(간헐적|단식)/.test(q)) {
      ["간헐적 단식", "시간제한 식사", "체중 감량"].forEach((term) => queries.add(term));
    }
  }

  if (category === "health") {
    if (/(비만|체중|감량|살)/.test(q)) {
      ["비만", "체중 감량", "비만 치료"].forEach((term) => queries.add(term));
    }
    if (/(음식|식품|먹|식단|나쁜|안.?좋|피하|원인|위험|가공|패스트|탄산|설탕|당류)/.test(q)) {
      ["비만 식습관", "가공식품", "당류 음료", "패스트푸드"].forEach((term) => queries.add(term));
    }
    if (/(비타민\s*d|비타민d)/.test(q)) queries.add("비타민 D");
    if (/(감기|호흡기|상기도)/.test(q)) ["감기", "호흡기 감염"].forEach((term) => queries.add(term));
    if (/(커피|카페인)/.test(q)) ["커피", "카페인", "혈압"].forEach((term) => queries.add(term));
  }

  if (category === "exercise") {
    if (/(근성장|근비대|근육|헬스|저항운동)/.test(q)) {
      ["저항운동", "근비대", "근육량"].forEach((term) => queries.add(term));
    }
    if (/(공복|유산소|러닝|달리기)/.test(q)) {
      ["공복 운동", "유산소 운동", "체중 감량"].forEach((term) => queries.add(term));
    }
  }

  if (category === "psychology") {
    if (/(수면|잠)/.test(q)) ["수면", "수면 부족"].forEach((term) => queries.add(term));
    if (/(비만|체중|살)/.test(q)) ["비만", "체중 증가"].forEach((term) => queries.add(term));
    if (/(불안|우울|스트레스)/.test(q)) ["불안", "우울", "스트레스"].forEach((term) => queries.add(term));
  }

  if (category === "education") {
    if (/(학습|공부|교육|집중|암기)/.test(q)) ["학습", "교육", "집중력"].forEach((term) => queries.add(term));
  }

  const compactQuestion = question.replace(/[?!.,;:，。！？'"`“”‘’()[\]{}<>]/g, " ").replace(/\s+/g, " ").trim();
  if (compactQuestion.length >= 2 && compactQuestion.length <= 20) queries.add(compactQuestion);

  return [...queries].slice(0, 8);
}

export function buildSearchQuery(terms: string[], category: Exclude<Category, "auto">): string {
  const categoryFilter = categorySearchFilters[category];
  const termQuery = buildFocusedTermQuery(terms) ?? (terms.length > 1 ? `(${terms.map(formatSearchTerm).join(" OR ")})` : terms[0]);
  return [termQuery, categoryFilter].filter(Boolean).join(" AND ");
}

export function buildLooseSearchQuery(terms: string[], category: Exclude<Category, "auto">): string {
  const defaults = new Set(categoryDefaults[category].map((term) => term.toLowerCase()));
  const picked = terms
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => !defaults.has(term.toLowerCase()))
    .slice(0, 8);
  return (picked.length > 0 ? picked : terms.slice(0, 8)).join(" ");
}

export function buildFocusedSearchQueries(question: string, terms: string[], category: Exclude<Category, "auto">): string[] {
  const categoryFilter = categorySearchFilters[category];
  const queries = new Set<string>([buildSearchQuery(terms, category)]);
  for (const variant of intentSearchQueries(question, category)) {
    queries.add([variant, categoryFilter].filter(Boolean).join(" AND "));
  }
  return [...queries].slice(0, 4);
}

export function buildLooseSearchQueries(question: string, terms: string[], category: Exclude<Category, "auto">): string[] {
  const queries = new Set<string>([buildLooseSearchQuery(terms, category)]);
  for (const variant of intentSearchQueries(question, category)) queries.add(variant);
  return [...queries].slice(0, 5);
}

function formatSearchTerm(term: string): string {
  return /\s/.test(term) ? `"${term}"` : term;
}

function buildFocusedTermQuery(terms: string[]): string | undefined {
  const lowered = terms.map((term) => term.toLowerCase());
  const protein = pickTerms(terms, lowered, /(protein|whey)/, 5);
  const kidney = pickTerms(terms, lowered, /(kidney|renal)/, 4);
  const muscle = pickTerms(terms, lowered, /(muscle|hypertrophy|lean mass|resistance training)/, 4);
  const sweetener = pickTerms(terms, lowered, /(sweetener|aspartame|sucralose|stevia|erythritol|acesulfame|diet soda|sugar-sweetened)/, 6);
  const metabolic = pickTerms(terms, lowered, /(glucose|insulin|diabetes|microbiome|microbiota|metabolic)/, 5);
  const eyeContact = pickTerms(terms, lowered, /(eye contact|gaze|joint attention|social attention)/, 5);
  const development = pickTerms(terms, lowered, /(infant|toddler|autism|development|screening|social communication)/, 6);
  const fasted = pickTerms(terms, lowered, /(fasted|fasting)/, 4);
  const aerobic = pickTerms(terms, lowered, /(aerobic|cardio|exercise)/, 4);
  const weight = pickTerms(terms, lowered, /(weight|fat oxidation|body fat)/, 4);

  if (protein.length > 0 && kidney.length > 0) {
    return joinQueryGroups([protein, kidney], [...muscle, ...pickTerms(terms, lowered, /(dose|grams per kilogram|high protein)/, 4)]);
  }
  if (protein.length > 0 && muscle.length > 0) {
    return joinQueryGroups([protein, muscle], pickTerms(terms, lowered, /(dose|grams per kilogram|high protein)/, 4));
  }
  if (sweetener.length > 0 && metabolic.length > 0) {
    return joinQueryGroups([sweetener, metabolic], pickTerms(terms, lowered, /(beverage|diet soda|sugar-sweetened)/, 4));
  }
  if (eyeContact.length > 0 && development.length > 0) {
    return joinQueryGroups([eyeContact, development], []);
  }
  if (fasted.length > 0 && aerobic.length > 0) {
    return joinQueryGroups([fasted, aerobic], weight);
  }

  return undefined;
}

function pickTerms(terms: string[], lowered: string[], pattern: RegExp, limit: number): string[] {
  const picked: string[] = [];
  for (const [index, term] of terms.entries()) {
    if (!pattern.test(lowered[index] ?? "")) continue;
    picked.push(term);
    if (picked.length >= limit) break;
  }
  return picked;
}

function joinQueryGroups(requiredGroups: string[][], optionalTerms: string[]): string {
  const required = requiredGroups.filter((group) => group.length > 0).map((group) => `(${group.map(formatSearchTerm).join(" OR ")})`);
  const optional = optionalTerms.length > 0 ? ` OR ${optionalTerms.map(formatSearchTerm).join(" OR ")}` : "";
  return `(${required.join(" AND ")}${optional})`;
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
  [/(비만|살|체중).*(음식|식품|먹|식단|나쁜|안.?좋|피하|원인|위험)|((음식|식품|식단|가공|패스트|탄산|설탕|당류).*(비만|살|체중))/, ["obesity dietary risk factors", "ultra-processed foods obesity", "sugar-sweetened beverages obesity", "fast food obesity", "energy-dense foods weight gain", "dietary patterns obesity"]],
  [/(단백질)/, ["protein intake", "dietary protein"]],
  [/(크레아틴|creatine)/i, ["creatine supplementation", "creatine monohydrate", "creatine safety", "creatine renal function", "creatine hair loss"]],
  [/(단백질.*(파우더|보충제)|프로틴|웨이|whey|protein powder|protein supplement)/, ["whey protein supplementation", "protein powder", "protein supplement", "protein supplementation resistance training meta-analysis"]],
  [/(100g|100 g|그램|g이상|g 이상)/, ["protein dose", "grams per kilogram per day", "dose response protein intake"]],
  [/(근성장|근비대|근육량|근육.*성장|벌크|lean mass|hypertrophy)/, ["muscle hypertrophy", "lean body mass", "resistance training", "dietary protein muscle mass meta-analysis"]],
  [/(과다|과잉|너무 많이|많이 먹)/, ["high protein intake"]],
  [/(신장|콩팥|신부전|kidney|renal)/, ["kidney function", "renal function", "chronic kidney disease", "high protein diet kidney function", "protein intake renal function healthy adults"]],
  [/(탈모|머리.?빠|hair.?loss|alopecia)/, ["hair loss", "alopecia", "protein supplement hair loss"]],
  [/(스트레칭)/, ["stretching", "injury prevention"]],
  [/(부상)/, ["injury prevention"]],
  [/(전자담배|vape|vaping|e-?cigarette)/i, ["electronic cigarettes", "e-cigarettes", "vaping", "tobacco harm reduction", "combustible cigarettes"]],
  [/(간헐적|단식)/, ["intermittent fasting"]],
  [/(간헐적|단식).*(체중|감량|살|다이어트)|(체중|감량|살|다이어트).*(간헐적|단식)/, ["intermittent fasting weight loss", "time-restricted eating weight loss", "alternate-day fasting body weight", "intermittent fasting randomized trial", "intermittent fasting meta-analysis"]],
  [/(탄수|탄수화물)/, ["carbohydrate restriction"]],
  [/(제로|무설탕|zero|diet soda|다이어트.?콜라|탄산|콜라|사이다)/, ["non-sugar sweeteners", "low calorie sweeteners", "artificial sweeteners", "sugar-sweetened beverages", "diet soda"]],
  [/(감미료|아스파탐|수크랄로스|스테비아|에리스리톨|알룰로스|아세설팜|ace.?k|aspartame|sucralose|stevia|erythritol|allulose)/, ["aspartame", "sucralose", "acesulfame potassium", "stevia", "erythritol", "gut microbiome", "glucose tolerance"]],
  [/(혈당|인슐린|당뇨|대사|장내|마이크로바이옴)/, ["glucose metabolism", "insulin response", "type 2 diabetes", "gut microbiota", "metabolic health"]],
  [/(고기|육류)/, ["meat intake", "iron intake"]],
  [/(편식|안 먹)/, ["picky eating", "food refusal"]],
  [/(프로바이오틱스|유산균|probiotic)/i, ["probiotics", "probiotic supplementation", "gut microbiota"]],
  [/(변비|constipation)/i, ["constipation", "bowel movement", "intestinal transit"]],
  [/(영상|스마트폰|유튜브|스크린)/, ["screen time"]],
  [/(눈.?마주|눈맞춤|눈.?맞춤|시선|아이컨택|eye.?contact)/, ["eye contact", "gaze behavior", "social attention", "joint attention", "autism spectrum disorder", "developmental screening"]],
  [/(12개월|돌|영아|아기|영유아|유아|infant|toddler)/, ["infant", "toddler"]],
  [/(자폐|autism|asd)/, ["autism spectrum disorder", "early signs autism"]],
  [/(발달지연|발달|사회성|상호작용)/, ["developmental delay", "social communication"]],
  [/(외국어|영어|언어)/, ["second language exposure", "bilingualism"]],
  [/(조기교육|조기.?영어|영어.*(아이|어릴|유아|소아|어린이))/, ["early childhood bilingual education", "early foreign language learning children", "second language exposure preschool", "bilingualism cognitive development children"]],
  [/(수면|잠)/, ["sleep deprivation", "sleep quality"]],
  [/(수면|잠).*(비만|살|체중|찌|증가)|(비만|살|체중|찌|증가).*(수면|잠)/, ["short sleep duration obesity", "sleep deprivation weight gain", "sleep duration body weight", "sleep restriction appetite", "sleep obesity meta-analysis"]],
  [/(집중|주의력)/, ["attention", "cognition"]],
  [/(불안)/, ["anxiety"]],
  [/(우울)/, ["depression"]],
  [/(비타민 d|비타민d)/, ["vitamin D", "vitamin D supplementation", "cholecalciferol", "25-hydroxyvitamin D"]],
  [/(비타민\s*d|비타민d).*(감기|호흡기|상기도|예방)|(감기|호흡기|상기도|예방).*(비타민\s*d|비타민d)/, ["vitamin D respiratory tract infection", "vitamin D common cold", "vitamin D supplementation acute respiratory infections", "cholecalciferol respiratory infection meta-analysis"]],
  [/(오메가)/, ["omega-3"]],
  [/(철분)/, ["iron deficiency"]],
  [/(칼슘)/, ["calcium"]],
  [/(커피|coffee)/i, ["coffee", "coffee consumption"]],
  [/(카페인|caffeine)/i, ["caffeine"]],
  [/(임산부|임신|수유|pregnan|maternal).*(커피|카페인|coffee|caffeine)|(커피|카페인|coffee|caffeine).*(임산부|임신|수유|pregnan|maternal)/i, ["maternal caffeine consumption", "caffeine pregnancy outcomes", "coffee pregnancy", "pregnancy caffeine intake"]],
  [/(커피|카페인|coffee|caffeine).*(혈압|고혈압|blood pressure|hypertension)|(혈압|고혈압|blood pressure|hypertension).*(커피|카페인|coffee|caffeine)/i, ["coffee blood pressure", "coffee hypertension", "caffeine blood pressure", "coffee consumption hypertension meta-analysis"]]
];

function intentSearchQueries(question: string, category: Exclude<Category, "auto">): string[] {
  const q = normalizeQuestion(question);
  const variants: string[] = [];

  if (/(비만|살|체중|obesity|weight)/i.test(q) && /(음식|식품|먹|식단|나쁜|안.?좋|피하|원인|위험|food|diet)/i.test(q)) {
    variants.push(
      "\"ultra-processed foods\" obesity",
      "\"sugar-sweetened beverages\" obesity",
      "\"fast food\" obesity",
      "\"energy-dense foods\" \"weight gain\"",
      "\"dietary patterns\" obesity"
    );
  }

  if (category === "nutrition" && /(당|설탕|탄산|음료|sweetened|beverage)/i.test(q)) {
    variants.push("\"sugar-sweetened beverages\" \"weight gain\"", "\"added sugar\" obesity");
  }

  if (/(단백질|프로틴|whey|protein)/i.test(q) && /(신장|콩팥|renal|kidney)/i.test(q)) {
    variants.push("\"high protein diet\" \"kidney function\"", "\"protein intake\" \"renal function\" \"healthy adults\"");
  }

  if (/(크레아틴|creatine)/i.test(q)) {
    variants.push("\"creatine supplementation\" safety", "\"creatine monohydrate\" \"renal function\"", "\"creatine\" \"hair loss\"");
  }

  if (/(공복|fasted|fasting)/i.test(q) && /(유산소|cardio|aerobic|exercise)/i.test(q)) {
    variants.push("\"fasted aerobic exercise\" \"fat oxidation\"", "\"fed versus fasted exercise\"", "\"fasted cardio\" \"weight loss\"");
  }

  if (/(간헐적|단식|intermittent fasting|time.?restricted)/i.test(q)) {
    variants.push("\"intermittent fasting\" \"weight loss\"", "\"time-restricted eating\" \"weight loss\"", "\"intermittent fasting\" \"randomized trial\"");
  }

  if (/(수면|잠|sleep)/i.test(q) && /(비만|살|체중|찌|obesity|weight)/i.test(q)) {
    variants.push("\"short sleep duration\" obesity", "\"sleep deprivation\" \"weight gain\"", "\"sleep duration\" \"body weight\"");
  }

  if (/(비타민\s*d|비타민d|vitamin d)/i.test(q) && /(감기|호흡기|상기도|cold|respiratory)/i.test(q)) {
    variants.push("\"vitamin D\" \"respiratory tract infection\"", "\"vitamin D supplementation\" \"common cold\"", "\"cholecalciferol\" \"respiratory infection\"");
  }

  if (/(커피|카페인|coffee|caffeine)/i.test(q) && /(혈압|고혈압|blood pressure|hypertension)/i.test(q)) {
    variants.push("\"coffee\" \"blood pressure\"", "\"coffee consumption\" hypertension", "\"caffeine\" \"blood pressure\"");
  }

  if (/(임산부|임신|pregnan|maternal)/i.test(q) && /(커피|카페인|coffee|caffeine)/i.test(q)) {
    variants.push("\"maternal caffeine consumption\" pregnancy", "\"caffeine intake\" \"pregnancy outcomes\"", "\"coffee\" pregnancy caffeine");
  }

  if (/(영어|외국어|bilingual|language)/i.test(q) && /(조기|어릴|아이|유아|children|preschool|early)/i.test(q)) {
    variants.push("\"early foreign language learning\" children", "\"second language exposure\" preschool", "\"bilingualism\" children cognitive development");
  }

  if (/(전자담배|vaping|e-?cigarette)/i.test(q)) {
    variants.push("\"electronic cigarettes\" \"combustible cigarettes\"", "\"e-cigarettes\" harm", "\"vaping\" respiratory health");
  }

  if (/(프로바이오틱스|유산균|probiotic)/i.test(q) && /(변비|장|constipation|gut|bowel)/i.test(q)) {
    variants.push("\"probiotics\" constipation", "\"probiotic supplementation\" \"bowel movement\"", "\"probiotics\" \"gut health\"");
  }

  if (/(눈.?마주|눈맞춤|시선|eye.?contact)/i.test(q) && /(아기|아이|영아|유아|infant|toddler|autism|자폐)/i.test(q)) {
    variants.push("\"eye contact\" infant autism", "\"joint attention\" infant autism", "\"social communication\" toddler autism");
  }

  return variants;
}
