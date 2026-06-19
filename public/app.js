const form = document.querySelector("#claimForm");
const questionInput = document.querySelector("#question");
const categoryInput = document.querySelector("#category");
const limitInput = document.querySelector("#limit");
const submitButton = document.querySelector("#submitButton");
const runtimeBadge = document.querySelector("#runtimeBadge");
const logs = document.querySelector("#logs");
const answer = document.querySelector("#answer");
const verdict = document.querySelector("#verdict");
const papers = document.querySelector("#papers");
const paperCount = document.querySelector("#paperCount");
const rawJson = document.querySelector("#rawJson");
const clearLogs = document.querySelector("#clearLogs");
const copyJson = document.querySelector("#copyJson");

let lastJson = {};

boot();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runClaim();
});

clearLogs.addEventListener("click", () => {
  logs.innerHTML = "";
});

copyJson.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(lastJson, null, 2));
  addLog("Raw JSON을 클립보드에 복사했습니다.", "ok");
});

document.querySelectorAll("[data-sample]").forEach((button) => {
  button.addEventListener("click", () => {
    questionInput.value = button.dataset.sample;
    categoryInput.value = button.dataset.category || "auto";
  });
});

async function boot() {
  try {
    const status = await getJson("/api/runtime-status");
    runtimeBadge.textContent = status.llm.enabled
      ? `Gemini RAG ON · ${status.llm.model}`
      : `Gemini RAG OFF · ${status.llm.fallback}`;
    runtimeBadge.classList.toggle("on", Boolean(status.llm.enabled));
    addLog(`런타임 확인: ${runtimeBadge.textContent}`, "ok");

    const dataSources = await getJson("/api/data-sources");
    const enabled = dataSources.sources.filter((source) => source.enabled).length;
    addLog(`데이터소스 ${dataSources.sources.length}개 등록, ${enabled}개 활성`, "ok");
  } catch (error) {
    addLog(`초기화 실패: ${messageOf(error)}`, "error");
  }
}

async function runClaim() {
  const payload = {
    question: questionInput.value.trim(),
    category: categoryInput.value,
    limit: Number(limitInput.value || 5),
    skipCache: true
  };
  if (payload.question.length < 2) return;

  setBusy(true);
  resetResult();
  addLog(`질문 입력: ${payload.question}`, "info");
  addLog(`카테고리=${payload.category}, 소스별 limit=${payload.limit}`, "info");

  try {
    addLog("1단계: 연구 데이터소스에서 근거 수집 시작", "info");
    addLog("2단계: 같은 근거 묶음으로 AI/RAG 답변 합성", "info");
    const resultBundle = await postJson("/api/research-claim", payload);
    const evidence = resultBundle.evidence;
    const result = resultBundle.answer;
    addLog(`검색어 변환: ${evidence.queryTerms.join(", ")}`, "ok");
    addLog(`분류된 카테고리: ${evidence.category}`, "ok");
    if (evidence.sourceTraces?.length) {
      const totalCandidates = evidence.sourceTraces.reduce((sum, trace) => sum + (trace.paperCount || 0), 0);
      addLog(`전체 후보 ${totalCandidates}건 중 최종 ${evidence.papers.length}건 선별`, "ok");
      evidence.sourceTraces.forEach((trace) => {
        const message =
          trace.status === "fulfilled"
            ? `${trace.source} 검색 완료: ${trace.paperCount}건${trace.message ? ` · ${trace.message}` : ""}`
            : `${trace.source} 검색 실패: ${trace.message}`;
        addLog(message, trace.status === "fulfilled" ? "ok" : "warn");
      });
    }
    if (!evidence.sourceTraces?.length && evidence.sourceErrors.length > 0) {
      evidence.sourceErrors.forEach((error) => addLog(`${error.source} 오류: ${error.message}`, "warn"));
    }
    addLog(`관련 논문 ${evidence.papers.length}건 선별`, evidence.papers.length ? "ok" : "warn");
    renderPapers(evidence.papers);

    addLog(`최종 판정: ${result.verdict}, 근거수준: ${result.evidence_level}`, "ok");
    addLog(`인용 ${result.citations.length}건, 캐시=${result.cached ? "hit" : "miss"}`, "ok");
    renderAnswer(result);
    setRaw({ evidence, answer: result });
  } catch (error) {
    addLog(`실패: ${messageOf(error)}`, "error");
    answer.textContent = messageOf(error);
    answer.classList.remove("empty");
  } finally {
    setBusy(false);
  }
}

function renderAnswer(result) {
  verdict.textContent = result.verdict;
  verdict.className = `pill ${result.verdict}`;
  answer.classList.remove("empty");

  const citations = result.citations
    .map((citation, index) => {
      const year = citation.year ? `, ${citation.year}` : "";
      const doi = citation.doi ? `, DOI ${escapeHtml(citation.doi)}` : "";
      return `<li><a href="${escapeAttribute(citation.url)}" target="_blank" rel="noreferrer">[${index + 1}] ${escapeHtml(citation.title)}</a><span>${escapeHtml(citation.source)}${year}${doi}</span></li>`;
    })
    .join("");

  const interpretations = (result.evidence_interpretation || [])
    .map((item) => `<li>[${item.citationIndex}] ${escapeHtml(item.stance)} · ${escapeHtml(item.reason_ko)}</li>`)
    .join("");

  const practicalChecks = (result.practical_checks || [])
    .map(
      (item, index) => `
        <li>
          <strong>${index + 1}. ${escapeHtml(item.label)}</strong>
          <span>해보기: ${escapeHtml(item.what_to_try_ko)}</span>
          <span>관찰: ${escapeHtml(item.what_to_watch_ko)}</span>
          <span>이유: ${escapeHtml(item.why_it_matters_ko)}</span>
        </li>
      `
    )
    .join("");

  answer.innerHTML = `
    <p>${escapeHtml(result.answer_ko)}</p>
    <div class="answer-meta">
      <span>카테고리 ${escapeHtml(result.category)}</span>
      <span>검색어 ${escapeHtml(result.query_terms.join(", "))}</span>
    </div>
    <h3>근거 해석</h3>
    <ul>${interpretations || "<li>해석 없음</li>"}</ul>
    <h3>확인해볼 것</h3>
    <ul class="checks">${practicalChecks || "<li>체크 포인트 없음</li>"}</ul>
    <h3>출처</h3>
    <ul class="citations">${citations || "<li>출처 없음</li>"}</ul>
    <h3>한계</h3>
    <ul>${result.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
  `;
}

function renderPapers(items) {
  paperCount.textContent = `${items.length}건`;
  if (items.length === 0) {
    papers.className = "papers empty";
    papers.textContent = "관련 근거가 없습니다.";
    return;
  }

  papers.className = "papers";
  papers.innerHTML = items
    .map((paper, index) => {
      const authors = paper.authors?.slice(0, 4).join(", ") || "저자 정보 없음";
      const abstract = paper.abstract ? escapeHtml(paper.abstract.slice(0, 420)) : "초록 없음";
      return `
        <article class="paper">
          <div class="paper-top">
            <span class="paper-index">${index + 1}</span>
            <span class="source">${escapeHtml(paper.source)}</span>
            <span class="level">${escapeHtml(paper.evidenceLevel)}</span>
            <span class="year">${paper.year || ""}</span>
          </div>
          <h3><a href="${escapeAttribute(paper.url)}" target="_blank" rel="noreferrer">${escapeHtml(paper.title)}</a></h3>
          <p class="authors">${escapeHtml(authors)}</p>
          <p>${abstract}</p>
        </article>
      `;
    })
    .join("");
}

function resetResult() {
  answer.textContent = "수집 중입니다.";
  answer.className = "answer empty";
  papers.textContent = "근거 수집 중입니다.";
  papers.className = "papers empty";
  paperCount.textContent = "0건";
  verdict.textContent = "진행 중";
  verdict.className = "pill";
  setRaw({});
}

function setRaw(value) {
  lastJson = value;
  rawJson.textContent = JSON.stringify(value, null, 2);
}

function addLog(text, type = "info") {
  const li = document.createElement("li");
  li.className = type;
  li.innerHTML = `<time>${new Date().toLocaleTimeString("ko-KR", { hour12: false })}</time><span>${escapeHtml(text)}</span>`;
  logs.appendChild(li);
  logs.scrollTop = logs.scrollHeight;
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "수집 중" : "검증";
}

async function getJson(url) {
  const response = await fetch(url);
  return readJson(response);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJson(response);
}

async function readJson(response) {
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || response.statusText);
  return json;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
