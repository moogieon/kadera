# 데이터 소스 상태

기획서 4장의 API를 구현 상태, 키 필요 여부, 신청/문서 링크 기준으로 정리한다.

## 구현 완료

| Source | 용도 | 키 | Env | 링크 | 비고 |
|---|---|---:|---|---|---|
| PubMed E-utilities | 의학, 영양, 운동, 발달 연구 | 선택 | `PUBMED_API_KEY`, `PUBMED_EMAIL` | https://www.ncbi.nlm.nih.gov/books/NBK25501/ | 키 없이 가능. 키가 있으면 rate limit 완화 |
| Semantic Scholar Graph API | 전 분야 논문, citation count | 선택 권장 | `SEMANTIC_SCHOLAR_API_KEY` | https://api.semanticscholar.org/api-docs/graph | 키 없이 가능하지만 429 발생 가능 |
| OpenAlex | 전 분야 보강, JSON 메타데이터 | 불필요 | `CONTACT_EMAIL` 권장 | https://developers.openalex.org/ | 인증 불필요. polite pool용 email 권장 |
| Europe PMC | 생명과학, PubMed 보강 | 불필요 | - | https://europepmc.org/RestfulWebService | health/childcare/nutrition/exercise 우선 |
| Crossref | DOI, 서지 보강 | 불필요 | `CONTACT_EMAIL` 권장 | https://www.crossref.org/documentation/retrieve-metadata/rest-api/ | 메타데이터 보정용 |
| ERIC | 교육/학습 논문 | 불필요 | - | https://eric.ed.gov/?api | education 카테고리 우선 |
| MyHealthfinder | 일반인용 공식 건강 권고 | 불필요 | - | https://odphp.health.gov/myhealthfinder/api/v4/itemlist.json?Type=topic | ODPHP 공식 콘텐츠 |
| arXiv | 프리프린트 | 불필요 | - | https://info.arxiv.org/help/api/user-manual.html | 낮은 근거 등급으로 처리 |
| bioRxiv / medRxiv | 최신 생명/의학 프리프린트 | 불필요 | - | https://api.biorxiv.org/ / https://api.medrxiv.org/ | 키워드 검색이 아니라 최근 feed 보조 |
| CORE | 오픈액세스 full text | 필요 | `CORE_API_KEY` | https://api.core.ac.uk/docs/v3 | 키 없으면 비활성 |
| Cochrane 보강 | 메타분석 우선 탐색 | 불필요 | `CONTACT_EMAIL` 권장 | https://www.crossref.org/documentation/retrieve-metadata/rest-api/ | Cochrane 전용 public API 대신 Crossref에서 Cochrane Database 항목 탐색 |
| WHO GHO OData | 세계보건기구 보건 지표 통계 | 불필요 | - | https://www.who.int/data/gho/info/gho-odata-api | OData Indicator 검색 후 지표값을 official statistics로 보강 |
| CDC | 질병·예방·백신 공식 데이터셋 | 불필요 | - | https://dev.socrata.com/ | Socrata catalog API에서 `domains=data.cdc.gov`와 `q` 검색 |
| KCI | 한국 논문/참고문헌 | 필요 | `KCI_API_KEY` | https://www.kci.go.kr/kciportal/po/openapi/openDataView.kci?datasetBean.dtstSeqNo=1 | KCI `articleSearch` + `referenceSearch` adapter. 키 없으면 비활성 |
| RISS | 학술연구정보·학위논문 | 필요 | `RISS_API_KEY` | https://www.data.go.kr/data/3046254/openapi.do | RISS apiSearchJournal adapter. 키 없으면 비활성 |
| PsyArXiv | 심리학 프리프린트 | 불필요 | - | https://api.osf.io/v2/preprint_providers/psyarxiv/preprints/ | OSF Preprints API에서 PsyArXiv provider 직접 검색 |

## 키가 필요한 것

- `CORE_API_KEY`: CORE API key. https://api.core.ac.uk/docs/v3
- `KCI_API_KEY`: KCI Open API 인증키. https://www.kci.go.kr/kciportal/po/openapi/openDataView.kci?datasetBean.dtstSeqNo=1
- `RISS_API_KEY`: 공공데이터포털 RISS 학술연구정보 활용신청 키. https://www.data.go.kr/data/3046254/openapi.do

## 키는 선택이지만 배포 전 권장

- `PUBMED_API_KEY`: NCBI E-utilities rate limit 완화. https://www.ncbi.nlm.nih.gov/books/NBK25501/
- `SEMANTIC_SCHOLAR_API_KEY`: Semantic Scholar 429 완화. https://api.semanticscholar.org/api-docs/graph
- `CONTACT_EMAIL`: OpenAlex/Crossref polite pool. https://developers.openalex.org/ / https://www.crossref.org/documentation/retrieve-metadata/rest-api/

## MCP에서 확인

서버 실행 후 `data_sources` tool을 호출하면 위 상태가 structured JSON으로 반환된다.
