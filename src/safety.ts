export interface SafetyResult {
  redirect: boolean;
  reason?: string;
  answer?: string;
}

export function screenSafety(question: string): SafetyResult {
  const q = question.toLowerCase();

  if (/(숨.?안|호흡곤란|의식.?없|경련|발작|가슴.?통증|심한 출혈|자살|극단적 선택|약.*많이 먹|응급)/.test(q)) {
    return {
      redirect: true,
      reason: "emergency",
      answer:
        "응급 가능성이 있는 내용입니다. 이 경우 논문 근거를 찾아 일반 답변을 드리는 것보다 즉시 119 또는 가까운 응급실, 지역 응급상담 기관에 연락하는 것이 우선입니다."
    };
  }

  if (/(복용량|몇 알|처방|진단|약을.*먹어|약.*같이|임신.*약|아기.*약)/.test(q)) {
    return {
      redirect: true,
      reason: "medical_advice",
      answer:
        "복용량, 처방, 진단, 약물 병용은 개인 상태에 따라 위험이 달라질 수 있어 이 도구가 답하면 안 되는 영역입니다. 의사, 약사, 소아청소년과 등 전문가에게 현재 복용 중인 약과 상태를 알려 상담하세요."
    };
  }

  return { redirect: false };
}

export const standardSafetyNote =
  "이 답변은 연구 정보 제공용이며 진단이나 처방이 아닙니다. 증상, 약물, 임신, 영유아 건강처럼 개인 상태가 중요한 문제는 의사, 약사 등 전문가와 상담하세요.";
