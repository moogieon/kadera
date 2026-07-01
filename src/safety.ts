export interface SafetyResult {
  redirect: boolean;
  reason?: string;
  answer?: string;
}

export interface UnsupportedResearchResult {
  unsupported: boolean;
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

  if (
    /(비밀번호|패스워드|password|인증코드|계정|로그인|인스타|instagram|카카오|gmail|이메일).*(바꿔|변경|초기화|찾아|알려|로그인|접속|해킹|풀어|복구)/i.test(q) ||
    /(바꿔|변경|초기화|찾아|알려|로그인|접속|해킹|풀어|복구).*(비밀번호|패스워드|password|인증코드|계정|인스타|instagram|카카오|gmail|이메일)/i.test(q)
  ) {
    return {
      redirect: true,
      reason: "account_action",
      answer:
        "계정 비밀번호 변경, 로그인, 접속, 복구 같은 작업은 이 MCP가 대신 수행하지 않습니다. 공식 앱이나 웹사이트의 계정 복구 절차를 이용하고, 비밀번호나 인증코드는 누구에게도 공유하지 마세요."
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

export function screenUnsupportedResearchQuestion(question: string): UnsupportedResearchResult {
  const q = question.toLowerCase();
  const hasFantasySubject = /(외계인|유니콘|드래곤|마법사|좀비|귀신|요정|상상속|가상의)/.test(q);
  const asksHealthOrEffect = /(발가락|키.?성장|성장|건강|효과|좋아|나빠|먹으면|치료|예방|운동|영양|비타민|질병|아파|낫)/.test(q);

  if (hasFantasySubject && asksHealthOrEffect) {
    return {
      unsupported: true,
      reason: "non_empirical_subject",
      answer:
        "이 질문은 현실의 식품, 성분, 질환, 행동, 인체 조건처럼 연구로 검증 가능한 대상이 아닙니다. 그래서 관련 없는 논문을 억지로 붙이지 않고 검색을 중단합니다. 실제 제품명, 성분명, 증상, 나이 같은 확인 가능한 조건으로 다시 물어보면 근거 검색을 할 수 있습니다."
    };
  }

  return { unsupported: false };
}

export const standardSafetyNote =
  "이 답변은 연구 정보 제공용이며 진단이나 처방이 아닙니다. 증상, 약물, 임신, 영유아 건강처럼 개인 상태가 중요한 문제는 의사, 약사 등 전문가와 상담하세요.";
