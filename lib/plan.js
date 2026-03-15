import { extractLeadingJsonObject, stripSourcesSection } from "./agent.js";

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function parseResultBody(text) {
  const raw = typeof text === "string" ? text : "";
  let activity = [];
  let content = raw;
  const leadingJson = extractLeadingJsonObject(raw);
  if (leadingJson) {
    const parsed = parseJson(leadingJson.json, null);
    activity = Array.isArray(parsed?.activity)
      ? parsed.activity.filter((step) => typeof step === "string" && step.trim())
      : [];
    content = leadingJson.remainder;
  }
  return {
    activity,
    cleaned: stripSourcesSection(content).trim()
  };
}

export function compactList(value, max) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const list = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(trimmed);
    if (list.length >= max) break;
  }
  return list;
}

export function compactSelectedMetrics(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const metrics = [];
  for (const entry of value) {
    if (!entry) continue;
    const name =
      typeof entry.name === "string"
        ? entry.name.trim()
        : typeof entry.metric === "string"
        ? entry.metric.trim()
        : "";
    const why =
      typeof entry.why === "string"
        ? entry.why.trim()
        : typeof entry.reason === "string"
        ? entry.reason.trim()
        : "";
    if (!name || !why) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    metrics.push({ name, why });
    if (metrics.length >= 3) break;
  }
  return metrics;
}

export function normalizePlanPayload(parsedPlan) {
  const apology =
    typeof parsedPlan?.apology === "string" ? parsedPlan.apology.trim() : "";
  const planOverview =
    typeof parsedPlan?.plan_overview === "string"
      ? parsedPlan.plan_overview.trim()
      : typeof parsedPlan?.plan === "string"
      ? parsedPlan.plan.trim()
      : "";
  const segments = compactList(parsedPlan?.segments, 5);
  const longlistPlayers = compactList(
    parsedPlan?.longlist_players || parsedPlan?.longlist,
    8
  );
  const selectedMetrics = compactSelectedMetrics(parsedPlan?.selected_metrics);
  const clarifyingQuestions = compactList(parsedPlan?.clarifying_questions, 1);
  const activity = compactList(parsedPlan?.activity, 4);
  const readyForResults = Boolean(parsedPlan?.ready_for_results);

  return {
    apology,
    planOverview,
    segments,
    longlistPlayers,
    selectedMetrics,
    clarifyingQuestions,
    activity,
    readyForResults
  };
}

export function validatePlanPayload(plan) {
  if (plan.apology) return { valid: true, errors: [] };
  const errors = [];
  if (!plan.planOverview) errors.push("missing_plan_overview");
  if (plan.segments.length < 2 || plan.segments.length > 5) {
    errors.push("segments_out_of_range");
  }
  if (plan.longlistPlayers.length < 5 || plan.longlistPlayers.length > 8) {
    errors.push("longlist_out_of_range");
  }
  if (plan.selectedMetrics.length < 2 || plan.selectedMetrics.length > 3) {
    errors.push("metrics_out_of_range");
  }
  if (plan.clarifyingQuestions.length !== 1) {
    errors.push("questions_out_of_range");
  }
  return { valid: errors.length === 0, errors };
}

export function buildPlanBody(plan) {
  const metricSummary = plan.selectedMetrics
    .map((metric) => `${metric.name} (${metric.why})`)
    .join("; ");
  return [
    plan.planOverview,
    `Segments: ${plan.segments.join(", ")}`,
    `Longlist players: ${plan.longlistPlayers.join(", ")}`,
    `Selected metrics: ${metricSummary}`
  ]
    .filter(Boolean)
    .join("\n");
}

export function joinHumanList(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function normalizeQuestionLine(value) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/^[*\-\d.)\s]+/, "").trim();
  if (!cleaned) return "";
  return /[?]$/.test(cleaned) ? cleaned : `${cleaned}?`;
}

function normalizeMetricWhy(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\s+/g, " ")
    .replace(/^\(+\s*/, "")
    .replace(/\s*\)+$/, "")
    .replace(/[;:.,!?]+$/, "")
    .trim();
}

export function buildPlanDisplay(plan) {
  const overview =
    typeof plan.planOverview === "string" ? plan.planOverview.trim() : "";
  const segmentSummary = joinHumanList(plan.segments);
  const longlistSummary = joinHumanList(plan.longlistPlayers);
  const focusMetrics = plan.selectedMetrics
    .map((metric) => {
      const name = typeof metric.name === "string" ? metric.name.trim() : "";
      const why = normalizeMetricWhy(metric.why);
      if (!name) return "";
      return why ? `${name} (${why})` : name;
    })
    .filter(Boolean)
    .join("; ");

  const normalizedQuestions = plan.clarifyingQuestions
    .map(normalizeQuestionLine)
    .filter(Boolean);
  const clarification =
    normalizedQuestions[0] ||
    "Would you prefer to focus on specific sub-segments or a broader market scope?";

  return `### Plan\n\n**Overview:** ${overview}\n\n**Segments:** ${segmentSummary}\n\n**Longlist:** ${longlistSummary}\n\n**Focus metrics:** ${focusMetrics}\n\n<br>\n\n**Clarification:** *${clarification}*`;
}
