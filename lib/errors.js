export function toClientError(err) {
  const message = err?.message || "Unknown error";
  const lower = message.toLowerCase();
  if (lower.includes("overloaded") || lower.includes("unavailable") || lower.includes("503")) {
    return {
      message: "The model is overloaded.",
      detail: "Retried fallback models; all were unavailable."
    };
  }
  if (lower.includes("api key") || lower.includes("apikey")) {
    return {
      message: "Missing or invalid Gemini API key.",
      detail: "Set GEMINI_API_KEY in your .env and restart the server."
    };
  }
  if (lower.includes("429") || lower.includes("rate")) {
    return {
      message: "Rate limit reached.",
      detail: "Please wait a moment and try again."
    };
  }
  if (lower.includes("401") || lower.includes("403")) {
    return {
      message: "Authentication failed.",
      detail: "Verify your Gemini API key and project access."
    };
  }
  if (lower.includes("enotfound") || lower.includes("econnrefused")) {
    return {
      message: "Network connection failed.",
      detail: "Check your internet connection or outbound firewall."
    };
  }
  if (lower.includes("empty result response")) {
    return {
      message: "The model returned an empty result.",
      detail: "Please retry. If it happens again, reply with a slightly more specific scope."
    };
  }
  return {
    message: "Something went wrong.",
    detail: message
  };
}
