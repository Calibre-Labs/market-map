export function normalizeBaseName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function randomDigits() {
  return Math.floor(100 + Math.random() * 900).toString();
}

export function wantsResult(message) {
  const normalized = message.toLowerCase();
  return /\b(yes|yep|yeah|ok|okay|go ahead|proceed|continue|do it|looks good|sounds good|ready|generate|result|final|ship it)\b/.test(
    normalized
  );
}

export function isConfirmation(message) {
  const trimmed = message.trim();
  if (!trimmed) return false;
  return wantsResult(trimmed) && trimmed.split(/\s+/).length <= 4;
}

export function inferCategory(message, chatHistory) {
  if (!isConfirmation(message)) return message;
  for (let i = chatHistory.length - 1; i >= 0; i -= 1) {
    const entry = chatHistory[i];
    if (entry.role === "user" && !isConfirmation(entry.content || "")) {
      return entry.content;
    }
  }
  return message;
}

export function hasClarifyingQuestions(text) {
  if (!text) return false;
  if (text.includes("?")) return true;
  const lower = text.toLowerCase();
  if (lower.includes("clarifying question")) return true;
  if (lower.includes("questions:")) return true;
  return false;
}

export function generateUniqueUsername(base, lookupFn) {
  const normalized = normalizeBaseName(base);
  if (!normalized) return null;
  for (let i = 0; i < 8; i += 1) {
    const candidate = `${normalized}${randomDigits()}`;
    const exists = lookupFn(candidate);
    if (!exists) return candidate;
  }
  return null;
}
