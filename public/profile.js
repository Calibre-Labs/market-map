const title = document.getElementById("profile-title");
const subtitle = document.getElementById("profile-subtitle");
const tableBody = document.querySelector("#trace-table tbody");
const bulkDownload = document.getElementById("bulk-download");

function getApiBase() {
  if (window.API_BASE) return window.API_BASE;
  const host = window.location.hostname;
  if (host.endsWith(".calibrelabs.ai") && !host.startsWith("api.")) {
    return `https://api.${host}`;
  }
  return "";
}

function formatDate(ts) {
  const date = new Date(ts);
  return date.toLocaleString();
}

async function loadProfile() {
  const parts = window.location.pathname.split("/");
  const username = decodeURIComponent(parts[parts.length - 1]);

  const res = await fetch(`${getApiBase()}/api/profile/${username}`, {
    credentials: "include"
  });
  if (!res.ok) {
    title.textContent = "Profile not found";
    subtitle.textContent = "";
    return;
  }

  const data = await res.json();
  title.textContent = data.user.username;
  subtitle.textContent = `Joined ${formatDate(data.user.created_at)}`;
  if (bulkDownload) {
    bulkDownload.href = `${getApiBase()}/api/traces/${encodeURIComponent(
      data.user.username
    )}`;
    bulkDownload.setAttribute("download", "");
  }

  tableBody.innerHTML = "";
  data.sessions.forEach((session) => {
    const row = document.createElement("tr");

    const sessionCell = document.createElement("td");
    sessionCell.textContent = session.id.slice(0, 8);

    const statusCell = document.createElement("td");
    statusCell.innerHTML = `<span class="badge">${session.status}</span>`;

    const turnCell = document.createElement("td");
    turnCell.textContent = session.turn_count;

    const createdCell = document.createElement("td");
    createdCell.textContent = formatDate(session.created_at);

    const downloadCell = document.createElement("td");
    const link = document.createElement("a");
    link.href = `${getApiBase()}/api/trace/${session.id}`;
    link.textContent = "Download JSON";
    link.setAttribute("download", "");
    downloadCell.appendChild(link);

    row.appendChild(sessionCell);
    row.appendChild(statusCell);
    row.appendChild(turnCell);
    row.appendChild(createdCell);
    row.appendChild(downloadCell);

    tableBody.appendChild(row);
  });
}

loadProfile();
