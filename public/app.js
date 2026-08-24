const conversation = document.querySelector("#conversation");
const chatForm = document.querySelector("#chatForm");
const messageInput = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const newChatButton = document.querySelector("#newChatButton");
const runtimeStatus = document.querySelector("#runtimeStatus");

let busy = false;
const markdown = typeof window.markdownit === "function"
  ? window.markdownit({
    html: false,
    linkify: true,
    breaks: true,
    typographer: false
  })
  : null;

boot();

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendMessage();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  chatForm.requestSubmit();
});

messageInput.addEventListener("input", resizeComposer);

newChatButton.addEventListener("click", () => {
  conversation.replaceChildren(createAssistantMessage("궁금한 내용을 물어보세요."));
  messageInput.value = "";
  resizeComposer();
  messageInput.focus();
});

async function boot() {
  try {
    const response = await fetch("/healthz");
    if (!response.ok) throw new Error("health unavailable");
    const status = await response.json();
    setRuntimeStatus(status.ok ? "연결됨" : "연결 확인 중", Boolean(status.ok));
  } catch {
    setRuntimeStatus("연결 확인 중", false);
  }
  messageInput.focus();
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (busy || message.length < 2) return;

  appendMessage("user", message);
  messageInput.value = "";
  resizeComposer();
  setBusy(true);
  const loadingMessage = appendLoadingMessage();

  try {
    const result = await postJson("/api/chat", {
      message,
      category: "auto"
    });

    loadingMessage.remove();
    appendMessage("assistant", result.text || "답변을 불러오지 못했습니다.");
  } catch (error) {
    loadingMessage.remove();
    appendMessage("assistant", messageOf(error), true);
  } finally {
    setBusy(false);
    messageInput.focus();
  }
}

function appendMessage(role, text, isError = false) {
  const message = role === "assistant" ? createAssistantMessage(text, isError) : createUserMessage(text);
  conversation.append(message);
  scrollToLatest();
  return message;
}

function createAssistantMessage(text, isError = false) {
  const article = document.createElement("article");
  article.className = `message assistant-message${isError ? " error-message" : ""}`;

  const avatar = document.createElement("div");
  avatar.className = "assistant-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "ㅋ";

  const content = document.createElement("div");
  content.className = "message-content";
  content.append(createMarkdownContent(text));

  article.append(avatar, content);
  return article;
}

function createUserMessage(text) {
  const article = document.createElement("article");
  article.className = "message user-message";

  const content = document.createElement("div");
  content.className = "message-content";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  content.append(paragraph);
  article.append(content);
  return article;
}

function createMarkdownContent(text) {
  const body = document.createElement("div");
  body.className = "markdown-body";

  if (!markdown) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    body.append(paragraph);
    return body;
  }

  body.innerHTML = markdown.render(text);
  secureMarkdownLinks(body);
  removeMarkdownImages(body);
  wrapMarkdownTables(body);
  return body;
}

function secureMarkdownLinks(body) {
  for (const link of body.querySelectorAll("a")) {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (!isSafeLink(href)) {
      link.replaceWith(document.createTextNode(link.textContent ?? ""));
      continue;
    }
    link.target = "_blank";
    link.rel = "noreferrer";
  }
}

function removeMarkdownImages(body) {
  for (const image of body.querySelectorAll("img")) image.remove();
}

function wrapMarkdownTables(body) {
  for (const table of body.querySelectorAll("table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-scroll";
    table.before(wrapper);
    wrapper.append(table);
  }
}

function isSafeLink(href) {
  try {
    const url = new URL(href, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function appendLoadingMessage() {
  const article = document.createElement("article");
  article.className = "message assistant-message loading-message";
  article.setAttribute("aria-label", "답변 생성 중");

  const avatar = document.createElement("div");
  avatar.className = "assistant-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "ㅋ";

  const dots = document.createElement("div");
  dots.className = "typing-dots";
  dots.setAttribute("aria-hidden", "true");
  dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));

  article.append(avatar, dots);
  conversation.append(article);
  scrollToLatest();
  return article;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  messageInput.disabled = value;
}

function setRuntimeStatus(label, connected) {
  runtimeStatus.lastChild.textContent = ` ${label}`;
  runtimeStatus.classList.toggle("connected", connected);
}

function resizeComposer() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: "smooth" });
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `요청에 실패했습니다. (${response.status})`);
  return result;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
