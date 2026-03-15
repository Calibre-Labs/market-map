function getApiBase() {
  if (window.API_BASE) return window.API_BASE;
  const host = window.location.hostname;
  if (host.endsWith(".calibrelabs.ai") && !host.startsWith("api.")) {
    return `https://api.${host}`;
  }
  return "";
}
