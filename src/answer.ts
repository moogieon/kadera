import { strongestEvidenceLevel } from "./evidence.js";
import { standardSafetyNote } from "./safety.js";
import type { ClaimAnswer, Citation, EvidenceInterpretation, EvidenceSearchResult, EvidenceStance, Paper, PracticalCheck, Verdict } from "./types.js";

export function composeAnswer(
  question: string,
  evidence: EvidenceSearchResult,
  cached: boolean
): ClaimAnswer {
  const topPapers = evidence.papers.slice(0, 5);

  if (topPapers.length === 0) {
    const sourceProblem =
      evidence.sourceErrors.length > 0
        ? ` 검색 중 일부 데이터 소스 오류가 있었습니다: ${evidence.sourceErrors
            .map((error) => `${error.source}: ${error.message}`)
            .join("; ")}`
        : "";
    return {
      answer_ko:
        `현재 연결된 연구 데이터베이스에서 "${question}"에 대해 신뢰할 만한 관련 연구를 찾지 못했습니다.` +
        " 없는 논문을 지어내지 않기 위해 결론을 보류합니다." +
        sourceProblem,
      verdict: "insufficient_evidence",
      evidence_level: "unknown",
      citations: [],
      practical_checks: buildPracticalChecks(question, evidence.category),
      limitations: [
        "검색 결과가 없거나 관련성이 낮아 결론을 내리지 않았습니다.",
        "표현을 바꾸거나 더 구체적인 대상, 기간, 조건을 넣어 다시 질문하면 결과가 달라질 수 있습니다."
      ],
      safety_note: standardSafetyNote,
      cached,
      category: evidence.category,
      query_terms: evidence.queryTerms
    };
  }

  const evidenceLevel = strongestEvidenceLevel(topPapers);
  const citations = topPapers.map(toCitation);
  const first = topPapers[0];
  const supporting = topPapers.slice(1, 3);
  const interpretation = interpretEvidence(topPapers);
  const verdict = decideVerdict(interpretation);
  const synthesis = buildSynthesis(question, verdict, evidenceLevel, interpretation);
  const chronology = buildChronology(topPapers);

  const answer = [
    synthesis,
    chronology,
    `가장 강한 근거 수준은 ${evidenceLevelLabel(evidenceLevel)}입니다.`,
    `우선 확인한 핵심 문헌은 "${first.title}"${first.year ? `(${first.year})` : ""}입니다.`,
    supporting.length > 0
      ? `함께 볼 만한 연구로 ${supporting
          .map((paper) => `"${paper.title}"${paper.year ? `(${paper.year})` : ""}`)
          .join(", ")}도 검색되었습니다.`
      : "",
    interpretation.length > 0 ? `근거 해석: ${interpretation.map(formatInterpretation).join(" ")}` : "",
    "결론은 출처의 연구 설계와 대상자가 내 상황과 맞는지까지 확인해야 합니다. 아래 출처 링크를 기준으로 원문을 확인하세요."
  ]
    .filter(Boolean)
    .join(" ");

  return {
    answer_ko: answer,
    verdict,
    evidence_level: evidenceLevel,
    citations,
    evidence_interpretation: interpretation,
    practical_checks: buildPracticalChecks(question, evidence.category),
    limitations: buildLimitations(topPapers, evidence.sourceErrors.length),
    safety_note: standardSafetyNote,
    cached,
    category: evidence.category,
    query_terms: evidence.queryTerms
  };
}

export function formatAnswerForText(answer: ClaimAnswer): string {
  const citations = formatVisibleCitations(answer.citations);
  const practicalChecks = answer.practical_checks?.slice(0, 3).map((item, index) => {
    return `${index + 1}. ${item.label}: ${item.what_to_try_ko} ${item.what_to_watch_ko}`;
  });

  return [
    answer.answer_ko,
    "",
    `판정: ${verdictLabel(answer.verdict)}`,
    `근거 수준: ${evidenceLevelLabel(answer.evidence_level)}`,
    ...(practicalChecks?.length
      ? [
          "",
          "바로 확인해볼 것:",
          ...practicalChecks
        ]
      : []),
    "",
    "대표 출처:",
    citations,
    "",
    answer.safety_note
  ].join("\n");
}

function formatVisibleCitations(citations: Citation[]): string {
  if (citations.length === 0) return "검색된 대표 출처 없음";

  return citations
    .slice(0, 3)
    .map((citation, index) => {
      const year = citation.year ? `${citation.year}` : "연도 미상";
      const venue = citation.venue || sourceLabel(citation.source);
      const institution = citation.institutions?.[0] ? `, ${citation.institutions[0]}` : "";
      const meta = [year, venue ? `${venue}${institution}` : ""].filter(Boolean).join(", ");
      const title = truncate(citation.title, 92);
      return `[${index + 1}] ${title} (${meta})\n${citation.url}`;
    })
    .join("\n");
}

function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "supported":
      return "근거가 대체로 지지";
    case "mixed":
      return "근거가 혼재";
    case "not_supported":
      return "근거상 단정 어려움/반대 신호";
    case "insufficient_evidence":
      return "직접 근거 부족";
    case "safety_redirect":
      return "안전 우선 안내";
  }
}

function sourceLabel(source: Citation["source"]): string {
  switch (source) {
    case "pubmed":
      return "PubMed";
    case "semantic_scholar":
      return "Semantic Scholar";
    case "openalex":
      return "OpenAlex";
    case "europe_pmc":
      return "Europe PMC";
    case "core":
      return "CORE";
    case "cochrane_crossref":
      return "Cochrane/Crossref";
    case "who_gho":
      return "WHO";
    case "cdc":
      return "CDC";
    case "myhealthfinder":
      return "MyHealthfinder";
    case "arxiv":
      return "arXiv";
    case "biorxiv":
      return "bioRxiv";
    case "medrxiv":
      return "medRxiv";
    case "crossref":
      return "Crossref";
    case "eric":
      return "ERIC";
    case "psyarxiv":
      return "PsyArXiv";
    case "kci":
      return "KCI";
    case "riss":
      return "RISS";
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function buildPracticalChecks(question: string, category: string): PracticalCheck[] | undefined {
  const q = question.toLowerCase();
  if (category === "childcare" && /(눈.?마주|눈맞춤|시선|자폐|발달|사회성|상호작용|개월|아기|아이)/.test(q)) {
    return infantDevelopmentChecks;
  }
  if (/(단백질|프로틴|파우더|보충제|whey|protein)/.test(q)) return proteinSupplementChecks;
  if (/(제로|무설탕|탄산|콜라|사이다|감미료|아스파탐|수크랄로스|스테비아|에리스리톨|zero|diet soda|sweetener)/.test(q)) {
    return sweetenerDrinkChecks;
  }
  switch (category) {
    case "childcare":
      return childcareChecks;
    case "nutrition":
      return nutritionChecks;
    case "exercise":
      return exerciseChecks;
    case "education":
      return educationChecks;
    case "psychology":
      return psychologyChecks;
    default:
      return healthChecks;
  }
}

const infantDevelopmentChecks: PracticalCheck[] = [
    {
      label: "이름 부르면 돌아보는지",
      what_to_try_ko: "아이 뒤나 옆에서 평소 목소리로 이름을 불러봅니다.",
      what_to_watch_ko: "소리에는 반응하지만 이름에는 거의 반응하지 않는 패턴이 반복되는지 봅니다.",
      why_it_matters_ko: "이름 반응은 사회적 주의와 의사소통 발달을 보는 대표 관찰 지표입니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "눈맞춤이 상황에 따라 달라지는지",
      what_to_try_ko: "밥 먹을 때, 놀이할 때, 안아줄 때처럼 편한 상황에서 짧은 눈맞춤이 생기는지 봅니다.",
      what_to_watch_ko: "모든 상황에서 눈을 거의 피하거나 사람 얼굴보다 물건만 오래 보는지 확인합니다.",
      why_it_matters_ko: "연구들은 눈맞춤 하나보다 사회적 맥락 속 시선 사용을 더 중요하게 봅니다.",
      urgency: "routine_observation"
    },
    {
      label: "공동주의가 되는지",
      what_to_try_ko: "장난감을 가리키며 '저거 봐'라고 말하고 아이가 손가락 방향이나 물체를 보는지 확인합니다.",
      what_to_watch_ko: "가리키기, 보여주기, 같이 보기 행동이 거의 없는지 봅니다.",
      why_it_matters_ko: "공동주의는 자폐 스펙트럼 초기 연구에서 반복적으로 다뤄지는 사회적 의사소통 지표입니다.",
      urgency: "seek_prompt_evaluation"
    },
    {
      label: "부모 표정을 참고하는지",
      what_to_try_ko: "낯선 장난감이나 소리가 났을 때 부모 얼굴을 한 번 쳐다보는지 봅니다.",
      what_to_watch_ko: "불확실한 상황에서도 보호자 얼굴을 거의 참고하지 않는지 확인합니다.",
      why_it_matters_ko: "사회적 참조는 아이가 사람의 표정과 반응을 정보로 쓰는지 보여줍니다.",
      urgency: "routine_observation"
    },
    {
      label: "까꿍 같은 상호놀이 반응",
      what_to_try_ko: "까꿍, 짝짜꿍, 주고받기 놀이를 반복해봅니다.",
      what_to_watch_ko: "웃음, 기대, 차례 기다림, 다시 해달라는 신호가 있는지 봅니다.",
      why_it_matters_ko: "상호작용 놀이 반응은 단순 시선보다 넓은 사회적 반응성을 보여줍니다.",
      urgency: "routine_observation"
    },
    {
      label: "요구 표현 방식",
      what_to_try_ko: "원하는 물건을 살짝 보이게 두고 아이가 어떻게 요청하는지 기다립니다.",
      what_to_watch_ko: "보호자 손만 끌고 가거나, 눈맞춤 없이 울기만 하는 패턴이 반복되는지 봅니다.",
      why_it_matters_ko: "요구할 때 사람을 의사소통 대상으로 쓰는지 확인할 수 있습니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "소리와 청력 반응",
      what_to_try_ko: "문소리, 장난감 소리, 작은 목소리 등 여러 소리에 반응하는지 봅니다.",
      what_to_watch_ko: "이름 반응 저하가 청력 문제와 구분되는지 확인해야 합니다.",
      why_it_matters_ko: "눈맞춤이나 이름 반응 문제처럼 보여도 청력 문제가 섞일 수 있습니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "몸짓 사용",
      what_to_try_ko: "안녕, 주세요, 가리키기, 고개 젓기 같은 몸짓이 있는지 봅니다.",
      what_to_watch_ko: "12개월 전후에 의사소통 몸짓이 거의 없는지 확인합니다.",
      why_it_matters_ko: "몸짓은 말이 나오기 전 사회적 의사소통의 중요한 신호입니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "반복 행동이나 감각 민감성",
      what_to_try_ko: "특정 소리, 빛, 촉감에 과하게 힘들어하거나 같은 행동을 오래 반복하는지 기록합니다.",
      what_to_watch_ko: "시선 문제와 감각 반응, 반복 행동이 함께 나타나는지 봅니다.",
      why_it_matters_ko: "최근 연구들은 사회적 주의뿐 아니라 감각 반응 차이도 함께 봅니다.",
      urgency: "discuss_with_professional"
    },
    {
      label: "2주 정도 짧게 기록하기",
      what_to_try_ko: "날짜, 상황, 반응을 짧게 적고 가능하면 10초 정도 영상으로 남깁니다.",
      what_to_watch_ko: "컨디션 문제인지, 여러 상황에서 반복되는 패턴인지 구분합니다.",
      why_it_matters_ko: "전문가 평가 때 실제 상황 기록이 있으면 판단 정확도가 올라갑니다.",
      urgency: "seek_prompt_evaluation"
    }
];

const childcareChecks: PracticalCheck[] = [
  {
    label: "나이와 발달 단계 확인",
    what_to_try_ko: "질문을 아이의 실제 월령, 조산 여부, 최근 질병 여부와 함께 정리합니다.",
    what_to_watch_ko: "월령 기대 범위에서 벗어난 변화가 반복되는지 봅니다.",
    why_it_matters_ko: "육아 연구는 월령과 발달 단계에 따라 해석이 크게 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "반복되는 패턴인지 확인",
    what_to_try_ko: "하루 한 번씩 같은 상황에서 1-2주 기록합니다.",
    what_to_watch_ko: "컨디션이 좋을 때도 같은 문제가 반복되는지 봅니다.",
    why_it_matters_ko: "일회성 행동보다 여러 상황에서 반복되는 패턴이 더 중요합니다.",
    urgency: "routine_observation"
  },
  {
    label: "먹기, 잠, 놀이를 같이 보기",
    what_to_try_ko: "문제 행동만 보지 말고 수면, 식사, 놀이 반응도 함께 적습니다.",
    what_to_watch_ko: "여러 영역에서 동시에 변화가 있는지 확인합니다.",
    why_it_matters_ko: "소아 발달과 건강은 단일 증상보다 전체 기능을 함께 봐야 합니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "영상 기록 남기기",
    what_to_try_ko: "걱정되는 장면을 10-20초 정도 짧게 촬영합니다.",
    what_to_watch_ko: "전문가에게 보여줄 수 있는 대표 상황을 확보합니다.",
    why_it_matters_ko: "진료실에서는 평소 행동이 재현되지 않을 수 있습니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "갑작스러운 퇴행 확인",
    what_to_try_ko: "하던 말을 안 하거나, 하던 행동을 잃었는지 되짚어봅니다.",
    what_to_watch_ko: "기술 상실이 있으면 단순 관찰보다 평가가 우선입니다.",
    why_it_matters_ko: "발달 퇴행은 빠른 평가가 필요한 신호입니다.",
    urgency: "seek_prompt_evaluation"
  },
  {
    label: "가족력과 환경 변화",
    what_to_try_ko: "가족 발달력, 이사, 어린이집 적응, 양육자 변화 등을 같이 봅니다.",
    what_to_watch_ko: "환경 변화 이후 일시적 변화인지 구분합니다.",
    why_it_matters_ko: "발달과 행동은 생물학적 요인과 환경 요인이 함께 작용합니다.",
    urgency: "routine_observation"
  },
  {
    label: "소아청소년과 상담 기준",
    what_to_try_ko: "기록한 내용과 영상을 들고 정기검진 또는 소아청소년과에서 상담합니다.",
    what_to_watch_ko: "걱정이 지속되거나 여러 영역에서 겹치면 지체하지 않습니다.",
    why_it_matters_ko: "선별검사와 발달평가는 조기 개입 여부를 판단하는 데 도움이 됩니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const nutritionChecks: PracticalCheck[] = [
  {
    label: "대상자별 기준 확인",
    what_to_try_ko: "답변의 성인 남성/여성, 임신·수유, 소아·청소년, 노인, 기저질환자 기준 중 내 상황과 가까운 줄을 봅니다.",
    what_to_watch_ko: "건강한 성인 연구인지, 질환자나 소아에게도 적용 가능한 근거인지 구분합니다.",
    why_it_matters_ko: "영양 연구는 건강한 성인, 임신부, 소아, 노인, 질환자에서 결론이 달라질 수 있습니다.",
    urgency: "routine_observation"
  },
  {
    label: "현재 섭취량 기록",
    what_to_try_ko: "3일 정도 먹은 양을 대략 기록합니다.",
    what_to_watch_ko: "문제 성분을 실제로 많이 먹는지 확인합니다.",
    why_it_matters_ko: "효과와 위험은 섭취량에 따라 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "기저질환 확인",
    what_to_try_ko: "신장, 간, 심혈관, 대사질환 여부를 확인합니다.",
    what_to_watch_ko: "질환이 있으면 일반인 연구를 그대로 적용하지 않습니다.",
    why_it_matters_ko: "영양 권고는 기저질환에서 가장 크게 달라집니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "혈액검사와 지표",
    what_to_try_ko: "필요하면 검진 결과의 eGFR, 크레아티닌, 지질, 혈당 등을 확인합니다.",
    what_to_watch_ko: "수치 변화가 있으면 식단 실험보다 진료가 우선입니다.",
    why_it_matters_ko: "영양 효과는 체감보다 객관 지표로 보는 게 안전합니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "한 가지 변화만 적용",
    what_to_try_ko: "식단을 바꿀 때 한 번에 하나씩 2-4주 관찰합니다.",
    what_to_watch_ko: "무엇 때문에 변화가 생겼는지 구분합니다.",
    why_it_matters_ko: "여러 변화를 동시에 하면 원인 판단이 어렵습니다.",
    urgency: "routine_observation"
  },
  {
    label: "극단 식단 피하기",
    what_to_try_ko: "특정 영양소를 과하게 늘리거나 완전히 끊지 않습니다.",
    what_to_watch_ko: "피로, 소화 문제, 체중 급변이 있는지 봅니다.",
    why_it_matters_ko: "대부분의 영양 근거는 극단보다 적정 범위에서 해석됩니다.",
    urgency: "routine_observation"
  },
  {
    label: "전문가 상담 기준",
    what_to_try_ko: "질환, 약 복용, 임신, 소아 식단이면 의사나 영양사와 상의합니다.",
    what_to_watch_ko: "개인 조건이 중요한 경우 일반 논문 답변으로 결정하지 않습니다.",
    why_it_matters_ko: "개인화가 필요한 영역은 안전성 판단이 우선입니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const proteinSupplementChecks: PracticalCheck[] = [
  {
    label: "체중 기준 g/kg 계산",
    what_to_try_ko: "하루 총 단백질 g을 체중 kg으로 나눕니다. 예: 70kg에 100g이면 1.43g/kg/day입니다.",
    what_to_watch_ko: "목표가 근성장인지, 감량 중 근손실 방지인지, 그냥 건강관리인지 구분합니다.",
    why_it_matters_ko: "스포츠영양 연구는 절대량 100g보다 g/kg/day 기준으로 비교합니다.",
    urgency: "routine_observation"
  },
  {
    label: "파우더만 100g인지 총 단백질 100g인지 구분",
    what_to_try_ko: "제품 스쿱의 단백질 함량을 확인합니다. 파우더 100g은 단백질 100g이 아닐 수 있습니다.",
    what_to_watch_ko: "식사 단백질까지 합친 하루 총량을 따로 계산합니다.",
    why_it_matters_ko: "논문 기준은 보충제 무게가 아니라 실제 단백질 섭취량입니다.",
    urgency: "routine_observation"
  },
  {
    label: "1.6g/kg/day 근처인지 보기",
    what_to_try_ko: "근력운동 중이면 체중 x 1.6g을 기준점으로 계산합니다.",
    what_to_watch_ko: "이보다 훨씬 높아도 근성장 추가 이득이 크지 않을 수 있습니다.",
    why_it_matters_ko: "저항운동 메타분석에서 약 1.6g/kg/day 이후 추가 이득이 작아지는 결과가 보고됩니다.",
    urgency: "routine_observation"
  },
  {
    label: "운동 자극이 충분한지",
    what_to_try_ko: "주당 운동 횟수, 세트 수, 점진적 과부하 여부를 기록합니다.",
    what_to_watch_ko: "운동이 부족하면 단백질만 늘려도 근성장 효과가 제한됩니다.",
    why_it_matters_ko: "단백질 보충 효과는 저항운동과 함께 볼 때 가장 의미 있습니다.",
    urgency: "routine_observation"
  },
  {
    label: "신장질환 위험요인 확인",
    what_to_try_ko: "eGFR, 크레아티닌, 단백뇨, 당뇨, 고혈압, 가족력을 확인합니다.",
    what_to_watch_ko: "위험요인이 있으면 고단백 식단을 자가 판단하지 않습니다.",
    why_it_matters_ko: "건강한 성인 연구와 CKD 환자 연구는 결론이 다릅니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "소화와 식단 대체 여부",
    what_to_try_ko: "파우더 때문에 식사, 채소, 지방, 탄수화물이 밀려나는지 봅니다.",
    what_to_watch_ko: "복부팽만, 설사, 식욕저하, 식단 단조로움이 생기는지 확인합니다.",
    why_it_matters_ko: "고단백 자체보다 전체 식단 질 저하가 문제가 될 수 있습니다.",
    urgency: "routine_observation"
  },
  {
    label: "2-4주 성과 지표",
    what_to_try_ko: "체중, 허리둘레, 운동 중량, 반복 수, 컨디션을 기록합니다.",
    what_to_watch_ko: "단백질을 늘린 뒤 실제 훈련 성과나 체성분 변화가 있는지 봅니다.",
    why_it_matters_ko: "개인 적용에서는 논문 평균보다 내 반응을 함께 봐야 합니다.",
    urgency: "routine_observation"
  }
];

const sweetenerDrinkChecks: PracticalCheck[] = [
  {
    label: "설탕 탄산 대체인지 확인",
    what_to_try_ko: "제로음료가 기존 설탕 탄산을 줄이는 대체인지, 물 대신 추가로 늘어난 음료인지 구분합니다.",
    what_to_watch_ko: "설탕 음료를 줄인 경우와 전체 음료량이 늘어난 경우는 해석이 다릅니다.",
    why_it_matters_ko: "제로음료의 이득은 주로 당류와 칼로리 대체에서 나옵니다.",
    urgency: "routine_observation"
  },
  {
    label: "원재료명에서 감미료 찾기",
    what_to_try_ko: "라벨에서 아스파탐, 아세설팜칼륨, 수크랄로스, 스테비올배당체, 에리스리톨, 알룰로스를 확인합니다.",
    what_to_watch_ko: "제품명보다 실제 감미료 조합을 봅니다.",
    why_it_matters_ko: "연구와 안전성 논쟁은 '제로' 전체가 아니라 감미료 종류별로 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "하루 캔 수 기록",
    what_to_try_ko: "1주일 동안 하루 몇 캔인지 적습니다.",
    what_to_watch_ko: "매일 여러 캔이면 감미료뿐 아니라 카페인, 산, 식습관 대체 문제도 같이 봅니다.",
    why_it_matters_ko: "섭취 빈도와 양이 위험 해석의 핵심입니다.",
    urgency: "routine_observation"
  },
  {
    label: "혈당 이슈가 있으면 직접 비교",
    what_to_try_ko: "당뇨나 혈당 관리 중이면 같은 식사 조건에서 혈당 반응을 기록합니다.",
    what_to_watch_ko: "제로음료 자체보다 같이 먹는 음식과 단맛 갈망 변화도 봅니다.",
    why_it_matters_ko: "감미료의 대사 반응은 개인차가 크다는 연구들이 있습니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "소화 불편감 확인",
    what_to_try_ko: "복부팽만, 설사, 가스가 특정 제품 뒤 반복되는지 봅니다.",
    what_to_watch_ko: "당알코올이나 일부 감미료는 사람에 따라 위장 불편감을 만들 수 있습니다.",
    why_it_matters_ko: "안전성 논쟁과 별개로 개인 적용에서는 위장 반응이 중요합니다.",
    urgency: "routine_observation"
  },
  {
    label: "페닐케톤뇨증 예외",
    what_to_try_ko: "본인이나 가족에게 페닐케톤뇨증이 있으면 아스파탐 표시를 피합니다.",
    what_to_watch_ko: "라벨의 '페닐알라닌 함유' 표시를 확인합니다.",
    why_it_matters_ko: "아스파탐은 페닐알라닌 공급원이므로 해당 질환에서는 예외적으로 중요합니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const exerciseChecks: PracticalCheck[] = [
  {
    label: "목표 명확화",
    what_to_try_ko: "체중감량, 심폐지구력, 근력, 통증 완화 중 목표를 하나로 잡습니다.",
    what_to_watch_ko: "목표에 맞는 연구인지 확인합니다.",
    why_it_matters_ko: "운동 연구는 목표 지표에 따라 결론이 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "운동 강도 기록",
    what_to_try_ko: "시간, 강도, 빈도, 통증 여부를 기록합니다.",
    what_to_watch_ko: "효과보다 부상 신호가 먼저 나타나는지 봅니다.",
    why_it_matters_ko: "운동 효과는 용량과 회복에 좌우됩니다.",
    urgency: "routine_observation"
  },
  {
    label: "통증 위치 확인",
    what_to_try_ko: "운동 중 또는 다음 날 통증 위치와 강도를 적습니다.",
    what_to_watch_ko: "날카로운 통증, 붓기, 저림은 중단 신호입니다.",
    why_it_matters_ko: "부상 위험은 성과보다 먼저 관리해야 합니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "점진적 증가",
    what_to_try_ko: "강도나 시간을 한 번에 크게 올리지 않습니다.",
    what_to_watch_ko: "수면, 피로, 통증이 악화되는지 봅니다.",
    why_it_matters_ko: "대부분 운동 권고는 점진적 과부하를 전제로 합니다.",
    urgency: "routine_observation"
  },
  {
    label: "기저질환 확인",
    what_to_try_ko: "심장질환, 호흡기질환, 임신, 수술 후 상태를 확인합니다.",
    what_to_watch_ko: "가슴통증, 호흡곤란, 어지럼이 있으면 중단합니다.",
    why_it_matters_ko: "운동 안전성은 개인 건강 상태에 따라 달라집니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const educationChecks: PracticalCheck[] = [
  {
    label: "측정할 결과 정하기",
    what_to_try_ko: "성적, 이해도, 집중시간, 기억 유지 중 무엇을 볼지 정합니다.",
    what_to_watch_ko: "느낌이 아니라 측정 가능한 변화가 있는지 봅니다.",
    why_it_matters_ko: "교육 연구는 outcome 정의가 중요합니다.",
    urgency: "routine_observation"
  },
  {
    label: "기간 정하기",
    what_to_try_ko: "최소 1-2주 같은 방식으로 적용합니다.",
    what_to_watch_ko: "하루 컨디션 효과와 실제 학습 효과를 구분합니다.",
    why_it_matters_ko: "학습 효과는 단기 기분보다 반복 성과로 봐야 합니다.",
    urgency: "routine_observation"
  },
  {
    label: "기초 수준 확인",
    what_to_try_ko: "시작 전 현재 점수나 수행 시간을 기록합니다.",
    what_to_watch_ko: "개입 전후를 비교할 기준을 만듭니다.",
    why_it_matters_ko: "baseline 없이 효과를 판단하기 어렵습니다.",
    urgency: "routine_observation"
  }
];

const psychologyChecks: PracticalCheck[] = [
  {
    label: "증상 강도 기록",
    what_to_try_ko: "불안, 우울, 수면, 집중을 0-10점으로 매일 기록합니다.",
    what_to_watch_ko: "2주 이상 지속되거나 악화되는지 봅니다.",
    why_it_matters_ko: "심리 연구와 임상 판단 모두 지속 기간과 기능 저하를 중요하게 봅니다.",
    urgency: "routine_observation"
  },
  {
    label: "생활 기능 확인",
    what_to_try_ko: "학교, 일, 관계, 식사, 수면에 영향이 있는지 봅니다.",
    what_to_watch_ko: "기능 저하가 있으면 자가관리보다 상담이 우선입니다.",
    why_it_matters_ko: "증상의 심각도는 불편감뿐 아니라 기능 손상으로 판단합니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "위험 신호",
    what_to_try_ko: "자해 생각, 극단적 선택 생각, 공황 수준의 증상이 있는지 확인합니다.",
    what_to_watch_ko: "있다면 즉시 주변 도움과 전문기관에 연결합니다.",
    why_it_matters_ko: "위험 신호는 연구 검토보다 안전 확보가 우선입니다.",
    urgency: "seek_prompt_evaluation"
  }
];

const healthChecks: PracticalCheck[] = [
  {
    label: "대상자와 조건 확인",
    what_to_try_ko: "나이, 성별, 임신, 질환, 약 복용 여부를 적습니다.",
    what_to_watch_ko: "검색된 연구 대상과 내 조건이 다른지 확인합니다.",
    why_it_matters_ko: "건강 연구는 대상자 조건에 따라 적용 가능성이 달라집니다.",
    urgency: "routine_observation"
  },
  {
    label: "증상 기간과 강도",
    what_to_try_ko: "언제 시작됐고 얼마나 심한지 기록합니다.",
    what_to_watch_ko: "갑자기 심해지거나 오래 지속되는지 봅니다.",
    why_it_matters_ko: "기간과 강도는 상담 필요성을 판단하는 핵심 정보입니다.",
    urgency: "discuss_with_professional"
  },
  {
    label: "위험 신호 확인",
    what_to_try_ko: "호흡곤란, 흉통, 의식저하, 심한 통증 같은 신호가 있는지 봅니다.",
    what_to_watch_ko: "위험 신호가 있으면 검색보다 응급 대응이 우선입니다.",
    why_it_matters_ko: "일부 증상은 일반 정보 제공으로 다루면 안 됩니다.",
    urgency: "seek_prompt_evaluation"
  }
];

function buildLimitations(papers: Paper[], sourceErrorCount: number): string[] {
  const limitations = [
    "자동 MVP 답변은 검색된 문헌의 제목, 초록, 메타데이터를 근거로 하며 원문 전문 검토를 대체하지 않습니다.",
    "현재 효과 방향 판정은 보수적으로 처리합니다. 상반된 연구가 있을 수 있으므로 원문과 대상자를 확인해야 합니다."
  ];
  if (!papers.some((paper) => paper.evidenceLevel === "systematic_review")) {
    limitations.push("검색 결과 안에서 체계적 문헌고찰 또는 메타분석이 최상위로 확인되지 않았습니다.");
  }
  if (sourceErrorCount > 0) {
    limitations.push("일부 데이터 소스 검색이 실패해 결과가 불완전할 수 있습니다.");
  }
  return limitations;
}

function toCitation(paper: Paper): Citation {
  return {
    source: paper.source,
    sourceId: paper.sourceId,
    title: paper.title,
    authors: paper.authors,
    venue: paper.venue,
    publisher: paper.publisher,
    institutions: paper.institutions,
    year: paper.year,
    doi: paper.doi,
    url: paper.url,
    evidenceLevel: paper.evidenceLevel
  };
}

function interpretEvidence(papers: Paper[]): EvidenceInterpretation[] {
  return papers.map((paper, index) => {
    const stance = classifyStance(paper);
    return {
      citationIndex: index + 1,
      source: paper.source,
      title: paper.title,
      stance,
      reason_ko: reasonForStance(stance, paper),
      evidenceLevel: paper.evidenceLevel
    };
  });
}

function classifyStance(paper: Paper): EvidenceStance {
  const text = normalizeEvidenceText(`${paper.title} ${paper.abstract ?? ""} ${paper.publicationTypes.join(" ")}`);
  if (!text.trim()) return "unclear";

  const negativeHits = countMatches(text, negativeSignals);
  const mixedHits = countMatches(text, mixedSignals);
  const positiveHits = countMatches(text, positiveSignals);

  if (negativeHits > positiveHits && negativeHits >= 1) return "opposes";
  if (mixedHits > 0 && positiveHits <= 1 && negativeHits <= 1) return "mixed";
  if (positiveHits > negativeHits && positiveHits >= 1) return "supports";
  if (mixedHits > 0) return "mixed";
  return "unclear";
}

function decideVerdict(interpretation: EvidenceInterpretation[]): Verdict {
  const scores = { supports: 0, opposes: 0, mixed: 0, unclear: 0 };
  for (const item of interpretation) {
    scores[item.stance] += evidenceWeight(item.evidenceLevel);
  }

  if (scores.supports >= 4 && scores.supports >= scores.opposes * 1.5 && scores.supports >= scores.mixed) {
    return "supported";
  }
  if (scores.opposes >= 3 && scores.opposes >= scores.supports * 1.3) {
    return "not_supported";
  }
  if (scores.supports === 0 && scores.opposes === 0 && scores.mixed === 0) {
    return "insufficient_evidence";
  }
  return "mixed";
}

function buildSynthesis(
  question: string,
  verdict: Verdict,
  evidenceLevel: string,
  interpretation: EvidenceInterpretation[]
): string {
  const counts = interpretation.reduce(
    (acc, item) => {
      acc[item.stance] += 1;
      return acc;
    },
    { supports: 0, opposes: 0, mixed: 0, unclear: 0 }
  );

  const suffix = `상위 근거 해석은 지지 ${counts.supports}건, 반박/효과 제한 ${counts.opposes}건, 혼재 ${counts.mixed}건, 불명확 ${counts.unclear}건입니다.`;

  switch (verdict) {
    case "supported":
      return `요약하면, "${question}"에 대해 현재 검색된 ${evidenceLevelLabel(evidenceLevel)} 중심 근거는 대체로 주장과 같은 방향입니다. ${suffix}`;
    case "not_supported":
      return `요약하면, "${question}"에 대해 현재 검색된 근거는 주장대로 단정하기 어렵거나 반대 방향 신호가 더 큽니다. ${suffix}`;
    case "insufficient_evidence":
      return `요약하면, "${question}"에 대해 문헌은 검색됐지만 제목/초록만으로는 주장 방향을 해석하기 어렵습니다. ${suffix}`;
    default:
      return `요약하면, "${question}"에 대해 관련 연구 근거는 있지만 결과가 완전히 한 방향으로 모이지 않습니다. ${suffix}`;
  }
}

function formatInterpretation(item: EvidenceInterpretation): string {
  const label: Record<EvidenceStance, string> = {
    supports: "지지",
    opposes: "반박/제한",
    mixed: "혼재",
    unclear: "불명확"
  };
  return `[${item.citationIndex}] ${label[item.stance]} - ${item.reason_ko}`;
}

function buildChronology(papers: Paper[]): string {
  const dated = papers
    .filter((paper) => typeof paper.year === "number")
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  if (dated.length < 2) return "";

  const oldest = dated[0];
  const newest = dated[dated.length - 1];
  if (!oldest?.year || !newest?.year || oldest.year === newest.year) return "";

  return `근거 흐름으로 보면 ${oldest.year}년 전후 문헌부터 ${newest.year}년 문헌까지 검색됐고, 최신 문헌일수록 연구 설계와 대상자를 함께 확인해야 합니다.`;
}

function reasonForStance(stance: EvidenceStance, paper: Paper): string {
  const design = evidenceLevelLabel(paper.evidenceLevel);
  switch (stance) {
    case "supports":
      return `${design} 문헌의 제목/초록에서 효과, 연관성, 개선 또는 감소 신호가 확인됩니다.`;
    case "opposes":
      return `${design} 문헌의 제목/초록에서 유의하지 않음, 효과 제한, 근거 부족 신호가 확인됩니다.`;
    case "mixed":
      return `${design} 문헌의 제목/초록에서 제한적이거나 일관되지 않은 결과 신호가 확인됩니다.`;
    default:
      return `${design} 문헌이지만 제목/초록 메타데이터만으로 효과 방향을 분류하지 않았습니다.`;
  }
}

function evidenceWeight(level: string): number {
  switch (level) {
    case "systematic_review":
      return 4;
    case "clinical_study":
      return 3;
    case "official_guidance":
      return 3;
    case "observational_study":
      return 2;
    case "preprint":
      return 1;
    default:
      return 1;
  }
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function evidenceLevelLabel(level: string): string {
  switch (level) {
    case "systematic_review":
      return "체계적 문헌고찰/메타분석급";
    case "clinical_study":
      return "임상연구급";
    case "observational_study":
      return "관찰연구급";
    case "preprint":
      return "프리프린트급";
    case "official_guidance":
      return "공식 권고급";
    default:
      return "분류 불명";
  }
}

const negativeSignals = [
  /\bno significant\b/,
  /\bnot significant\b/,
  /\bnot associated\b/,
  /\bno association\b/,
  /\bdid not\b/,
  /\bdoes not\b/,
  /\bfailed to\b/,
  /\binsufficient evidence\b/,
  /\blittle evidence\b/,
  /\bno evidence\b/,
  /\bnot effective\b/,
  /\bnot improve\b/,
  /\bnot reduce\b/,
  /\bwithout improvement\b/
];

const mixedSignals = [
  /\bmixed\b/,
  /\binconsistent\b/,
  /\bheterogeneous\b/,
  /\blimited evidence\b/,
  /\buncertain\b/,
  /\bconflicting\b/,
  /\bmay\b/,
  /\bpreliminary\b/
];

const positiveSignals = [
  /\bsignificant\b/,
  /\bassociated with\b/,
  /\breduced\b/,
  /\breduction\b/,
  /\bimproved\b/,
  /\bimprovement\b/,
  /\beffective\b/,
  /\bbeneficial\b/,
  /\blower\b/,
  /\bgreater\b/,
  /\bincreased\b/,
  /\bdecreased\b/,
  /\bweight loss\b/,
  /\bprevention\b/,
  /\bbetter\b/
];
