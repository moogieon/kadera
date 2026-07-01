# 카더라 말고

맘카페, 블로그, 유튜브의 "카더라"를 실제 연구 문헌 기반으로 확인하는 한국어 MCP 서버입니다.

현재 MVP는 PlayMCP 등록을 염두에 둔 Streamable HTTP MCP 서버이며, 로컬 테스트용 stdio 엔트리포인트도 제공합니다.

## 기능

- `check_claim`: 한국어 질문을 받아 연구 문헌 기반 답변을 반환
- `find_evidence`: 답변 생성 없이 PubMed/Semantic Scholar 검색 결과 반환
- `popular_claims`: 개인정보 없이 익명 집계된 반복 질문 반환
- `data_sources`: 기획서 4장 API별 구현/활성/키 필요 상태 반환
- `runtime_status`: Gemini RAG 활성 여부와 공개 가능한 보안/캐시 상태 반환

## 안전 원칙

- API에서 실제 검색된 논문만 인용합니다.
- 검색 결과가 없으면 `insufficient_evidence`를 반환합니다.
- 응급, 진단, 처방, 복용량, 약물 병용 질문은 `safety_redirect`로 전문가 상담을 우선합니다.
- 개인별 질문 이력은 저장하지 않습니다. 캐시와 익명 주제 집계만 저장합니다.

## 요구사항

- Node.js 25 이상 권장
- npm 11 이상

Node 내장 SQLite를 사용하므로 별도 DB 서버 없이 시작할 수 있습니다. 실행 시 SQLite experimental warning이 출력될 수 있습니다.

## 로컬 실행

```bash
npm install
npm run build
PORT=3000 DATABASE_PATH=./data/kadera-malgo.sqlite npm start
```

Health check:

```bash
curl http://localhost:3000/healthz
```

브라우저 테스트 콘솔:

```text
http://localhost:3000/
```

MCP endpoint:

```text
http://localhost:3000/mcp
```

## stdio 실행

```bash
npm run start:stdio
```

## 환경 변수

```bash
PORT=3000
DATABASE_PATH=./data/kadera-malgo.sqlite
PUBMED_EMAIL=
PUBMED_API_KEY=
SEMANTIC_SCHOLAR_API_KEY=
CORE_API_KEY=
CONTACT_EMAIL=
KCI_API_KEY=
RISS_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]
```

`PUBMED_API_KEY`와 `SEMANTIC_SCHOLAR_API_KEY`는 없어도 동작하지만, rate limit 안정성을 위해 배포 환경에서는 설정하는 것이 좋습니다.
`CORE_API_KEY`, `KCI_API_KEY`, `RISS_API_KEY`가 없으면 해당 adapter는 비활성입니다.
`GEMINI_API_KEY`가 있으면 검색된 논문 메타데이터와 초록만 컨텍스트로 넘겨 한국어 RAG 합성 답변을 생성합니다. 기본 모델은 무료 티어가 있는 `gemini-3.1-flash-lite`이며, `GEMINI_MODEL`로 바꿀 수 있습니다. 없거나 실패하면 규칙 기반 근거 해석으로 자동 fallback합니다.

RAG 구조는 다음처럼 동작합니다.

1. PubMed, OpenAlex, Cochrane 보강, Semantic Scholar 등에서 관련 논문을 검색합니다.
2. 논문 제목, 초록, 연도, DOI, 근거 등급만 Gemini에 전달합니다.
3. Gemini는 전달된 논문 안에서만 한국어로 답변하고, 과거 근거와 최신 근거 흐름을 함께 설명합니다.
4. 모델이 없는 citation index를 반환하면 서버가 제거합니다.

검색 정책:

1. 질문 문맥으로 카테고리를 먼저 판단합니다. 사용자가 카테고리를 잘못 골라도 강한 신호가 있으면 보정합니다.
2. Gemini가 켜져 있으면 답변 전에 영어 논문 검색어를 먼저 설계합니다.
3. Semantic Scholar는 API key가 있을 때 최신 연도부터 검색하고, 결과가 없으면 1년씩 내려가며 최대 8년 전까지 탐색합니다.
4. Semantic Scholar에는 카테고리별 `fieldsOfStudy` 필터를 붙입니다. 예: 육아/건강은 Medicine, Biology, 심리는 Psychology, Medicine.
5. 수집된 논문은 질문 핵심 토큰, 근거 수준, 최신성, citation count 기준으로 다시 랭킹합니다.

전체 데이터 소스 상태는 [docs/data-sources.md](docs/data-sources.md)를 보세요.

## Docker

```bash
docker build -t kadera-malgo .
docker run --rm -p 3000:3000 -e PORT=3000 -v "$PWD/data:/app/data" kadera-malgo
```

## 검증

```bash
npm run typecheck
npm test
npm run build
```

현재 테스트는 다음을 확인합니다.

- 한국어 질문 카테고리 분류
- 영어 연구 검색어 변환
- 처방/복용량 질문의 safety redirect
- 검색 결과로 받은 논문만 citation에 포함
- Gemini RAG 합성에서도 존재하지 않는 citation index 제거
- 반복 질문 캐시 hit

## PlayMCP 등록 메모

공개 자료 기준 PlayMCP는 remote MCP 서버 등록을 지원하며 Streamable HTTP 기반으로 동작합니다. 등록용 URL은 배포 후 `/mcp` endpoint를 사용합니다.

공모전 일정은 계속 공식 페이지에서 재확인해야 합니다.

- 접수 마감: 2026-07-14
- 본선 사용자 투표: 2026-08-31 to 2026-09-28
- 시상식: 2026-10-23
