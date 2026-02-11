const chat = document.getElementById("chat");
const messageInput = document.getElementById("message");
const sendButton = document.getElementById("send");
const userHandle = document.getElementById("user-handle");
const profileLink = document.getElementById("profile-link");

let isStreaming = false;

function getApiBase() {
  if (window.API_BASE) return window.API_BASE;
  const host = window.location.hostname;
  if (host.endsWith(".calibrelabs.ai") && !host.startsWith("api.")) {
    return `https://api.${host}`;
  }
  return "";
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const last = chat.lastElementChild;
    if (last && typeof last.scrollIntoView === "function") {
      last.scrollIntoView({ behavior: "smooth", block: "end" });
      return;
    }
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  });
}

function scrollToBottomSoon() {
  scrollToBottom();
  setTimeout(scrollToBottom, 120);
  setTimeout(scrollToBottom, 260);
}

function renderMarkdown(text) {
  if (!window.marked || !window.DOMPurify) return text;
  const html = marked.parse(text, { breaks: true });
  return DOMPurify.sanitize(html);
}

function addMessage(content, role, isHtml = false) {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  if (isHtml) {
    el.innerHTML = content;
  } else {
    el.textContent = content;
  }
  chat.appendChild(el);
  scrollToBottomSoon();
  return el;
}

function createActivityContainer(anchor) {
  const el = document.createElement("div");
  el.className = "message status";
  el.dataset.role = "activity";
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(el, anchor);
  } else {
    chat.appendChild(el);
  }
  return el;
}

function appendActivity(container, message) {
  if (!container) return;
  const line = document.createElement("div");
  line.textContent = message;
  container.appendChild(line);
  scrollToBottomSoon();
}

function createRadar(container) {
  const steps = ["Segment", "Longlist", "Evidence", "Rank", "Cite"];
  const el = document.createElement("div");
  el.className = "radar";
  const items = steps.map((label) => {
    const step = document.createElement("div");
    step.className = "radar-step";
    const dot = document.createElement("span");
    dot.className = "radar-dot";
    const text = document.createElement("span");
    text.className = "radar-label";
    text.textContent = label;
    step.appendChild(dot);
    step.appendChild(text);
    el.appendChild(step);
    return step;
  });
  container.appendChild(el);

  let maxSteps = items.length;
  let currentProgress = 0;

  const setProgress = (index) => {
    currentProgress = index;
    const clamped = Math.max(0, Math.min(index, maxSteps));
    items.forEach((item, idx) => {
      const disabled = idx >= maxSteps;
      item.classList.toggle("is-disabled", disabled);
      item.classList.toggle("is-complete", !disabled && idx < clamped);
      item.classList.toggle("is-active", !disabled && idx === clamped && clamped < maxSteps);
    });
    if (clamped >= maxSteps && maxSteps > 0) {
      items[maxSteps - 1].classList.add("is-complete");
    }
  };

  const setMode = (mode) => {
    maxSteps = mode === "plan" ? 2 : items.length;
    setProgress(Math.min(currentProgress, maxSteps));
  };

  return {
    count: items.length,
    setMode,
    setProgress,
    reset: () => setProgress(0),
    complete: () => setProgress(maxSteps)
  };
}

function createSourceCounter(container) {
  const el = document.createElement("div");
  el.className = "source-counter is-hidden";
  const label = document.createElement("span");
  label.className = "source-counter-label";
  label.textContent = "Sources found:";
  const count = document.createElement("span");
  count.className = "source-counter-count";
  count.textContent = "0";
  el.appendChild(label);
  el.appendChild(count);
  container.appendChild(el);
  return {
    setCount: (value) => {
      count.textContent = String(value);
    },
    show: () => el.classList.remove("is-hidden"),
    hide: () => el.classList.add("is-hidden")
  };
}

function countSourcesMarkdown(text) {
  if (!text) return 0;
  const matches = text.match(/\]\((https?:\/\/[^)\s]+)\)/g);
  return matches ? matches.length : 0;
}

function createAssistantMessage() {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.dataset.role = "assistant";
  chat.appendChild(el);
  return el;
}

async function loadUser() {
  const res = await fetch(`${getApiBase()}/api/me`, { credentials: "include" });
  if (!res.ok) {
    window.location.href = "/";
    return null;
  }
  const data = await res.json();
  userHandle.textContent = data.username;
  profileLink.href = `/u/${data.username}`;
  return data;
}

function setupPlaceholder() {
  addMessage(
    "Share a market category and I’ll find the top 3 players. Example: CRM software.",
    "assistant"
  );
}

function parseSseEvent(block) {
  const lines = block.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.replace("event:", "").trim();
    }
    if (line.startsWith("data:")) {
      data += line.replace("data:", "").trim();
    }
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

async function streamResponse(message, assistantEl) {
  const activityEl = createActivityContainer(assistantEl);
  const activityMetaEl = document.createElement("div");
  activityMetaEl.className = "activity-meta";
  const activityLinesEl = document.createElement("div");
  activityLinesEl.className = "activity-lines";
  activityEl.appendChild(activityMetaEl);
  activityEl.appendChild(activityLinesEl);
  const radar = createRadar(activityMetaEl);
  const sourceCounter = createSourceCounter(activityMetaEl);
  radar.reset();
  let planEl = null;
  let activityTimer = null;
  let activityCompleted = false;
  let spinnerInterval = null;
  let spinnerEl = null;
  let liveLine = null;
  let radarIndex = 0;

  const runActivity = (mode, steps = []) => {
    if (!activityLinesEl) return;
    activityLinesEl.textContent = "";
    activityCompleted = false;
    if (activityTimer) clearInterval(activityTimer);
    if (!steps.length) return;
    radar.setMode(mode);
    radarIndex = 0;
    radar.setProgress(radarIndex);
    if (mode === "result") {
      sourceCounter.show();
      sourceCounter.setCount(0);
    }
    if (mode === "plan") {
      sourceCounter.hide();
    }
    if (spinnerInterval) clearInterval(spinnerInterval);
    if (spinnerEl) spinnerEl.remove();
    liveLine = document.createElement("div");
    spinnerEl = document.createElement("span");
    spinnerEl.className = "spinner";
    spinnerEl.textContent = "|";
    const spinnerFrames = ["|", "/", "-", "\\"];
    let spinnerIdx = 0;
    spinnerInterval = setInterval(() => {
      spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
      if (spinnerEl) spinnerEl.textContent = spinnerFrames[spinnerIdx];
    }, 150);
    const liveText = document.createElement("span");
    liveText.textContent = steps[0];
    liveLine.appendChild(spinnerEl);
    liveLine.appendChild(liveText);
    activityLinesEl.appendChild(liveLine);
    let idx = 1;
    if (idx >= steps.length) return;
    activityTimer = setInterval(() => {
      if (liveLine) {
        const doneLine = document.createElement("div");
        const doneText = liveLine.querySelector("span:last-child");
        doneLine.textContent = doneText ? doneText.textContent : "";
        activityLinesEl.insertBefore(doneLine, liveLine);
        radarIndex = Math.min(radarIndex + 1, radar.count);
        radar.setProgress(radarIndex);
      }
      if (liveLine) {
        const nextText = steps[idx] || "";
        const textNode = liveLine.querySelector("span:last-child");
        if (textNode) {
          textNode.textContent = nextText;
        }
      }
      idx += 1;
      if (idx >= steps.length) {
        clearInterval(activityTimer);
        activityTimer = null;
      }
    }, 450);
  };

  const finalizeActivity = () => {
    if (!activityLinesEl) return;
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    if (spinnerEl) {
      spinnerEl.remove();
      spinnerEl = null;
    }
    if (!activityCompleted) {
      appendActivity(activityLinesEl, "Completed");
      activityCompleted = true;
    }
    radar.complete();
  };
  const res = await fetch(`${getApiBase()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    credentials: "include"
  });

  if (!res.ok || !res.body) {
    addMessage("Something went wrong. Try again.", "assistant");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop();

    for (const part of parts) {
      const parsed = parseSseEvent(part.trim());
      if (!parsed) continue;
      const { event, data } = parsed;
      if (event === "activity") {
        runActivity(data.mode, Array.isArray(data.steps) ? data.steps : []);
      }
      if (event === "plan") {
        if (!planEl) {
          planEl = document.createElement("div");
          planEl.className = "message assistant";
          planEl.dataset.role = "assistant";
          activityEl.parentNode.insertBefore(planEl, activityEl.nextSibling);
        }
        planEl.innerHTML = renderMarkdown(data.text || "");
        scrollToBottomSoon();
      }
      if (event === "token") {
        assistantText += data.text;
        assistantEl.innerHTML = renderMarkdown(assistantText);
        scrollToBottomSoon();
      }
      if (event === "final") {
        if (data.sources) {
          assistantText += `\n\n${data.sources}`;
          assistantEl.innerHTML = renderMarkdown(assistantText);
          const count = countSourcesMarkdown(data.sources);
          sourceCounter.setCount(count);
          if (count > 0) sourceCounter.show();
        }
        scrollToBottomSoon();
        finalizeActivity();
      }
      if (event === "error") {
        const detail = data.detail ? `\n${data.detail}` : "";
        assistantEl.textContent = `${data.message}${detail}`;
        scrollToBottomSoon();
        finalizeActivity();
      }
    }
  }
}

async function handleSend() {
  const message = messageInput.value.trim();
  if (!message || isStreaming) return;
  addMessage(message, "user");
  messageInput.value = "";
  const assistantEl = createAssistantMessage();
  isStreaming = true;
  sendButton.disabled = true;
  await streamResponse(message, assistantEl);
  isStreaming = false;
  sendButton.disabled = false;
}

sendButton.addEventListener("click", handleSend);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
});

loadUser();
setupPlaceholder();
