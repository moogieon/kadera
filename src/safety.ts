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

  if (
    /(죽고\s*싶|살고\s*싶지|사라지고\s*싶|내가\s*없어졌|목숨.*끊|자살.*(?:하고\s*싶|할까|할\s*것|계획)|극단적\s*선택.*(?:하고\s*싶|할까)|죽는\s*게\s*낫)/.test(q)
  ) {
    return {
      redirect: true,
      reason: "suicide_support"
    };
  }

  if (containsSensitiveData(q)) {
    return {
      redirect: true,
      reason: "sensitive_data",
      answer:
        "입력에 주민번호, 계좌·카드번호, 비밀번호, 인증코드 같은 민감정보가 포함되어 있어 검색하거나 답변에 다시 표시하지 않았습니다. 해당 정보를 지운 뒤 검증할 주장만 다시 적어주세요."
    };
  }

  if (
    /(호흡곤란|숨(?:이|을)?\s*(?:잘\s*)?(?:안|못)\s*(?:쉬|쉬어|쉬는)|입술.*파래|청색증|의식(?:이)?\s*(?:없|잃)|경련|가슴.*(?:통증|조이|압박)|식은땀.*가슴|피가.*(?:안\s*멈|멈추지)|심한\s*출혈|한쪽.*(?:팔|다리).*(?:안\s*움직|마비)|말(?:이)?\s*(?:어눌|안\s*나오)|아기.*숨.*(?:안|못)|약.*(?:한꺼번에|많이)\s*먹|응급)/.test(q) ||
    isOverdoseOrPoisoning(q)
  ) {
    return {
      redirect: true,
      reason: "emergency",
      answer:
        "이 증상은 논문을 비교하며 기다릴 상황이 아닐 수 있습니다. 지금 119에 연락하거나 가까운 응급실로 이동하고, 가능하면 혼자 있지 마세요. 의식이 없거나 호흡하지 않는 사람에게 물이나 약을 먹이지 마세요."
    };
  }

  if (
    /(비밀번호|패스워드|password|인증코드|인증번호|계정|로그인|인스타|instagram|카카오|gmail|이메일).*(바꿔|변경|초기화|찾아|알려|로그인|접속|해킹|잠금|풀|복구|알아내|가져와)/i.test(q) ||
    /(바꿔|변경|초기화|찾아|알려|로그인|접속|해킹|잠금|풀|복구|알아내|가져와).*(비밀번호|패스워드|password|인증코드|인증번호|계정|인스타|instagram|카카오|gmail|이메일)/i.test(q)
  ) {
    return {
      redirect: true,
      reason: "account_action",
      answer:
        "계정 비밀번호 변경, 로그인, 접속, 복구 같은 작업은 이 MCP가 대신 수행하지 않습니다. 공식 앱이나 웹사이트의 계정 복구 절차를 이용하고, 비밀번호나 인증코드는 누구에게도 공유하지 마세요."
    };
  }

  if (
    /(복용량|몇\s*알|처방|진단해|약을.*먹어|약.*같이|임신.*약|아기.*약|약.*(?:두\s*알|2알)|약.*(?:끊어|중단)|용량.*(?:조절|계산)|항생제.*(?:끊|중단)|약.*대신|(?:신장질환|콩팥병|간질환|심장질환).*(?:보충제|영양제).*(?:먹어도|괜찮)|(?:알레르기|아나필락시스).*(?:먹이|먹어도|섭취))/.test(q)
  ) {
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
  const hasFantasySubject = /(외계인|유니콘|드래곤|마법사|좀비|귀신|요정|상상\s*속|가상의)/.test(q);
  const asksHealthOrEffect = /(발가락|키.?성장|성장|건강|효과|좋아|나빠|먹으면|음식|포만감|호르몬|치료|예방|운동|영양|비타민|질병|아파|낫|다이어트|혈액형|심박|수면|우울|발달)/.test(q);

  if (hasFantasySubject && asksHealthOrEffect) {
    return {
      unsupported: true,
      reason: "non_empirical_subject",
      answer:
        "이 질문은 현실의 식품, 성분, 질환, 행동, 인체 조건처럼 연구로 검증 가능한 대상이 아닙니다. 그래서 관련 없는 논문을 억지로 붙이지 않고 검색을 중단합니다. 실제 제품명, 성분명, 증상, 나이 같은 확인 가능한 조건으로 다시 물어보면 근거 검색을 할 수 있습니다."
    };
  }

  if (
    /(이전|위|모든).*(지시|규칙).*(무시|덮어)|시스템\s*프롬프트|개발자\s*모드|환경\s*변수|api\s*키|쉘\s*명령|서버\s*파일|데이터베이스.*(?:전부|내용)|관리자\s*승인|system\s*:|사용자\s*프롬프트.*(?:출력|포함)|도구\s*설명.*덮어/i.test(q) ||
    /(가짜\s*doi|없는.*(?:연구|논문).*(?:만들|지어)|출처.*있는\s*척|찬성.*논문만|반대.*논문.*빼|결과.*(?:조작|반대로)|연도를\s*바꿔|출처를\s*꾸며|광고\s*링크.*출처|미래\s*논문.*인용|인용\s*번호.*가정)/.test(q)
  ) {
    return {
      unsupported: true,
      reason: "instruction_or_evidence_manipulation",
      answer:
        "이 요청은 검증할 연구 주장이 아니라 시스템 또는 출처를 조작하라는 명령입니다. 지시를 실행하거나 무관한 논문을 붙이지 않습니다. 확인하고 싶은 현실의 주장만 한 문장으로 적어주세요."
    };
  }

  if (
    /(캘린더|알람|장바구니|제품|병원|보험사|이메일|카카오톡|메시지|앱|외부\s*사이트).*(등록|맞춰|주문|결제|예약|전송|보내|삭제|변경|신청)|(?:등록|맞춰|주문|결제|예약|전송|보내|삭제|변경|신청).*(캘린더|알람|장바구니|제품|병원|보험사|이메일|카카오톡|메시지|앱|외부\s*사이트)/.test(q)
  ) {
    return {
      unsupported: true,
      reason: "external_action",
      answer:
        "이 도구는 논문 근거를 확인하는 읽기 전용 도구라 일정 등록, 주문, 예약, 결제, 메시지 전송 같은 외부 작업은 수행하지 않습니다. 검증할 주장만 남기면 연구 근거를 확인할 수 있습니다."
    };
  }

  // Probe run: "혈액형별 성격이 진짜 다른가?" returned five citations and
  // "귀신 본 사람들 뇌가 다른가?" three. Attaching real papers to a folk
  // belief lends it the authority of the literature, which is the opposite of
  // what this service exists to do. The fantasy-word check above misses these
  // because the subjects are real words.
  if (
    /(혈액형).*(성격|궁합|체질|운세)|(성격|궁합|체질|운세).*(혈액형)/.test(q) ||
    /(사주|팔자|손금|관상|풍수|점성술|별자리|타로|전생|환생|기\s*치료|기공\s*치료|영혼|귀신|무당|부적|음양오행)/.test(q) ||
    /(달|보름달).*(위상|주기).*(수면|출산|생리)|(수면|출산|생리).*(보름달|달의\s*위상)/.test(q)
  ) {
    return {
      unsupported: true,
      reason: "non_empirical_subject",
      answer:
        "이 주제는 과학적으로 검증 가능한 대상이 아니라 통념이나 믿음에 가깝습니다. 관련 논문을 붙이면 근거가 있는 것처럼 보일 수 있어 검색을 중단합니다. 확인하고 싶은 실제 식품, 성분, 행동, 증상으로 다시 물어보시면 근거를 찾아드릴 수 있습니다."
    };
  }

  // A request for a recommendation, a plan, or a personal choice has no claim
  // to verify. Every one of the ten probe questions in this shape came back
  // with citations attached to an opinion.
  if (
    /(추천\s*(?:해줘|해주세요|좀)|짜\s*줘|만들어\s*줘|골라\s*줘|정해\s*줘|알려만)/.test(q) ||
    /^(오늘|내일|지금)\s*(뭐|무엇)\s*(먹|할)/.test(q) ||
    /(?:제일|가장|더)\s*(?:이득|나을까|나은|좋을까|좋은\s*(?:거|건))/.test(q) ||
    /^(?:무슨|어떤|어느)\s+\S+\s*(?:사는|살|고르|선택)/.test(q) ||
    /(어디로?\s*가야|어느\s*병원|무슨\s*보험|어떤\s*헬스장)/.test(q)
  ) {
    return {
      unsupported: true,
      reason: "not_a_verifiable_claim",
      answer:
        "이 도구는 특정 주장이 연구로 뒷받침되는지 확인합니다. 추천이나 선택은 개인 상황에 따라 달라져 논문으로 답할 수 없습니다. 확인하고 싶은 주장을 한 문장으로 적어주시면 근거를 찾아드립니다. 예: '유산균이 장 건강에 도움 돼?'"
    };
  }

  if (
    /^(이거|그거|저거|둘\s*중|저번에\s*말한\s*거|아까\s*그거)/.test(q) &&
    !/(비타민|영양제|단백질|커피|운동|수면|아이|아기|약물명|성분명|제품명)/.test(q)
  ) {
    return {
      unsupported: true,
      reason: "missing_subject",
      answer:
        "무엇을 검증해야 하는지 대상이 빠져 있습니다. 식품·성분·행동·증상·대상 연령과 비교 기준을 한 문장에 넣어주세요. 예: '성인이 커피를 하루 세 잔 마시면 혈압이 올라가?'"
    };
  }

  if (
    /(빨간\s*통|초록색|그\s*제로\s*음료|브랜드\s*[a-z가-힣].*브랜드\s*[a-z가-힣]|그\s*영양제|그\s*제품|해외\s*직구.*(?:구미|영양제|보충제))/i.test(q) &&
    !/(성분|원재료|제품명|함량)/.test(q)
  ) {
    return {
      unsupported: true,
      reason: "missing_product_identity",
      answer:
        "제품을 특정할 이름·성분·함량이 없어 효과를 검증할 수 없습니다. 광고 색상이나 별칭 대신 제품명, 기능성 원료, 1회 섭취량을 적어주세요."
    };
  }

  return { unsupported: false };
}

/**
 * Probe run: "수면제 한꺼번에 많이 먹으면 어떻게 돼?", "약을 한꺼번에 다
 * 먹었는데 병원 안 가도 될까?" and "아이가 세제를 마셨는데 우유 먹이면 돼?"
 * were all answered with "관련해서 답할 만한 신뢰도 높은 연구를 찾지
 * 못했습니다." The pre-existing pattern needed the literal word 약 immediately
 * followed by 먹, so a named sedative or a swallowed household chemical fell
 * straight through.
 *
 * Deliberately narrow on quantity: "많이" alone still belongs to an ordinary
 * dose question ("커피 많이 마시면 안 좋아?"), so an explicit all-at-once or
 * overdose word is required.
 */
function isOverdoseOrPoisoning(question: string): boolean {
  const medicine = "약|약물|알약|수면제|진통제|해열제|감기약|안정제|신경안정제|항우울제|타이레놀|게보린|아스피린";
  const household = "세제|락스|표백제|농약|살충제|제초제|본드|시너|부동액|방부제|건조제|제습제|살균제|등유|휘발유";
  return (
    new RegExp(`(?:${medicine})[^.?!]{0,24}(?:한꺼번에|한번에|전부|모두|과다|여러\\s*알|한\\s*통)[^.?!]{0,12}(?:먹|복용|삼키|삼켰)`).test(question) ||
    new RegExp(`(?:한꺼번에|한번에|전부|과다)[^.?!]{0,12}(?:${medicine})[^.?!]{0,12}(?:먹|복용|삼키|삼켰)`).test(question) ||
    new RegExp(`(?:${household})[^.?!]{0,16}(?:마셨|마시게|먹었|먹였|삼켰|들이켰)`).test(question) ||
    /(과다\s*복용|음독|약물\s*중독|중독\s*증상)/.test(question)
  );
}

function containsSensitiveData(question: string): boolean {
  return (
    /(주민등록번호|주민번호|외국인등록번호|운전면허번호|면허번호|여권번호|카드번호|계좌번호|전화번호|휴대폰번호|차트번호|환자번호)/i.test(question) ||
    /(?:내|제)\s*(?:이메일|메일주소|집주소|주소)/i.test(question) ||
    /(?:비밀번호|패스워드|password|인증코드|인증번호)(?:는|은|:|=|\s)+(?:[a-z0-9!@#$%^&*_-]{4,})/i.test(question) ||
    /\b\d{6}-?[1-8]\d{6}\b/.test(question) ||
    /\b[mspod]\d{8}\b/i.test(question) ||
    /\b\d{2}-\d{2}-\d{6}-\d{2}\b/.test(question) ||
    /\b01[016789]-?\d{3,4}-?\d{4}\b/.test(question) ||
    /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.test(question) ||
    /\b(?:chart|patient)[-_ ]?(?:id|no)?[:# ]*[a-z0-9-]{4,}\b/i.test(question)
  );
}

export const standardSafetyNote =
  "이 답변은 연구 정보 제공용이며 진단이나 처방이 아닙니다. 증상, 약물, 임신, 영유아 건강처럼 개인 상태가 중요한 문제는 의사, 약사 등 전문가와 상담하세요.";
