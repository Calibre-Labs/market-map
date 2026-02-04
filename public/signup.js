const form = document.getElementById("signup-form");
const input = document.getElementById("username");
const errorEl = document.getElementById("signup-error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";

  const username = input.value.trim();
  if (!username) {
    errorEl.textContent = "Please enter a name.";
    return;
  }

  try {
    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username })
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
