const form = document.getElementById("signup-form");
const input = document.getElementById("username");
const errorEl = document.getElementById("signup-error");

function getApiBase() {
  if (window.API_BASE) return window.API_BASE;
  const host = window.location.hostname;
  if (host.endsWith(".calibrelabs.ai") && !host.startsWith("api.")) {
    return `https://api.${host}`;
  }
  return "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";

  const username = input.value.trim();
  if (!username) {
    errorEl.textContent = "Please enter a name.";
    return;
  }

  try {
    const res = await fetch(`${getApiBase()}/api/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
      credentials: "include"
    });

    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || "Something went wrong.";
      return;
    }

    window.location.href = "/";
  } catch (error) {
    errorEl.textContent = "Network error. Please try again.";
  }
});
