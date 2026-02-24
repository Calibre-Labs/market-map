import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { initLogger, traced, updateSpan } from "braintrust";
import {
  initDb,
  createUser,
  getUserByUsername,
  getUserByUsernameKey,
  getActiveSessionForUserAndTab,
  createSession,
  updateSession,
  listSessionsForUser,
  pruneSessions,
  getSessionById,
  listStaleActiveSessions
} from "./lib/db.js";
import {
  generateUniqueUsername,
  inferCategory,
  inferIntentAnchorFromHistory,
  isAffirmative,
  isNegative
} from "./lib/username.js";
import {
  assessIntentChange,
  createGeminiClient,
  extractJsonBlock,
  extractSources,
  formatSourcesMarkdown,
  generateSourcesForResult,
  getModelName,
  parseIntentChangeDecision,
  repairSources,
  streamMarketResponse,
  stripSourcesSection,
  validateSources,
  withDomains
} from "./lib/agent.js";
import {
  deriveSessionState,
  reduceSessionAfterTurn,
  SESSION_FSM_STATES
} from "./lib/fsm.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "data", "market-map.sqlite");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = getModelName(process.env.GEMINI_MODEL);
const GEMINI_FALLBACK_MODELS = process.env.GEMINI_FALLBACK_MODELS || "";
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || "";

const DEFAULT_FALLBACKS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const INTENT_REPLACE_CONFIDENCE = Number(
  process.env.INTENT_REPLACE_CONFIDENCE || 0.8
);
const INTENT_CONFIRM_CONFIDENCE = Number(
  process.env.INTENT_CONFIRM_CONFIDENCE || 0.45
);

function parseFallbackModels(value) {
  return value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function buildModelOrder(primary, fallbackValue) {
  const fallbackModels = parseFallbackModels(fallbackValue);
  const order = [primary, ...DEFAULT_FALLBACKS, ...fallbackModels].filter(Boolean);
  return Array.from(new Set(order));
}

function normalizeTabId(value) {
  if (typeof value !== "string") return null;
  const tabId = value.trim();
  if (!tabId) return null;
  if (tabId.length > 120) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(tabId)) return null;
  return tabId;
}

const braintrustLogger = initLogger({
  projectName: process.env.BRAINTRUST_PROJECT || "market-map",
  apiKey: process.env.BRAINTRUST_API_KEY
});

const BT_ERROR_WINDOW_MS = Number(process.env.BRAINTRUST_ERROR_WINDOW_MS || 60000);
const BT_ERROR_THRESHOLD = Number(process.env.BRAINTRUST_ERROR_THRESHOLD || 3);
let btErrorCount = 0;
let btErrorWindowStart = 0;
let btDisabled = false;

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const SESSION_IDLE_TIMEOUT_MS = parsePositiveInt(
  process.env.SESSION_IDLE_TIMEOUT_MS,
  30 * 60 * 1000
);
const SESSION_SWEEP_INTERVAL_MS = parsePositiveInt(
  process.env.SESSION_SWEEP_INTERVAL_MS,
  5 * 60 * 1000
);
const SESSION_SWEEP_BATCH_SIZE = parsePositiveInt(
  process.env.SESSION_SWEEP_BATCH_SIZE,
  100
);
let lastSessionSweepAt = 0;

function attachBraintrustCircuitBreaker() {
  const state = braintrustLogger?.loggingState;
  const bgLogger = state?.bgLogger?.();
  if (!bgLogger) return;
  bgLogger.onFlushError = (err) => {
    const now = Date.now();
    if (!btErrorWindowStart || now - btErrorWindowStart > BT_ERROR_WINDOW_MS) {
      btErrorWindowStart = now;
      btErrorCount = 0;
    }
    btErrorCount += 1;
    if (!btDisabled && btErrorCount >= BT_ERROR_THRESHOLD) {
      btDisabled = true;
      state.disable();
      // eslint-disable-next-line no-console
      console.warn(
        `Braintrust logging disabled after ${btErrorCount} errors in ${BT_ERROR_WINDOW_MS}ms.`,
        err
      );
    }
  };
}

attachBraintrustCircuitBreaker();

const db = initDb(DB_PATH);
const gemini = createGeminiClient(GEMINI_API_KEY);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && FRONTEND_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.static(publicDir));

if (
  process.env.NODE_ENV !== "test" &&
  SESSION_IDLE_TIMEOUT_MS > 0 &&
  SESSION_SWEEP_INTERVAL_MS > 0
) {
  const sweepTimer = setInterval(() => {
    maybeSweepStaleActiveSessions({ force: true });
  }, SESSION_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === "function") {
    sweepTimer.unref();
  }
}

function sendFile(res, filename) {
  res.sendFile(path.join(publicDir, filename));
}


function createTrace({
  sessionId,
  username,
  tabId,
  createdAt,
  rootSpan,
  rootSpanId,
  rootSpanSpanId
}) {
  return {
    version: 2,
    session_id: sessionId,
    username,
    tab_id: tabId || null,
    created_at: createdAt,
    braintrust: {
      root_span: rootSpan,
      root_span_id: rootSpanId,
      root_span_span_id: rootSpanSpanId
    },
    turns: []
  };
}

function addTurnToTrace(trace, turn) {
  return {
    ...trace,
    turns: [...trace.turns, turn]
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function finalizeSessionAsAbandoned(session, { reason, now } = {}) {
  if (!session || session.status !== "active") return false;
  const closedAt = Number.isFinite(now) ? now : Date.now();
  const chatHistory = parseJson(session.chat_history, []);
  const turns = Array.isArray(chatHistory) ? chatHistory : [];
  const firstUser = turns.find((entry) => entry?.role === "user");
  const lastUser = [...turns].reverse().find((entry) => entry?.role === "user");

  if (session.root_span) {
    try {
      updateSpan({
        exported: session.root_span,
        input: {
          first_msg: firstUser?.content || session.intent_origin || null
        },
        output: {
          final_response: null,
          final_mode: "abandoned"
        },
        metadata: {
          username: session.username,
          session_id: session.id,
          tab_id: session.tab_id || null,
          total_turns: session.turn_count || 0,
          status: "abandoned",
          close_reason: reason || "abandoned",
          last_user_msg: lastUser?.content || null,
          last_activity_at: session.updated_at || null,
          closed_at: closedAt
        }
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("Failed to finalize abandoned session span:", session.id, error);
    }
  }

  updateSession(db, session.id, {
    status: "abandoned",
    updated_at: closedAt
  });
  return true;
}

function sweepStaleActiveSessions(now = Date.now()) {
  if (SESSION_IDLE_TIMEOUT_MS <= 0 || SESSION_SWEEP_BATCH_SIZE <= 0) return 0;
  const cutoff = now - SESSION_IDLE_TIMEOUT_MS;
  const staleSessions = listStaleActiveSessions(db, cutoff, SESSION_SWEEP_BATCH_SIZE);
  let closedCount = 0;
  for (const session of staleSessions) {
    if (
      finalizeSessionAsAbandoned(session, {
        reason: "inactivity_timeout",
        now
      })
    ) {
      closedCount += 1;
    }
  }
  return closedCount;
}

function maybeSweepStaleActiveSessions({ force = false, now = Date.now() } = {}) {
  if (SESSION_IDLE_TIMEOUT_MS <= 0 || SESSION_SWEEP_INTERVAL_MS <= 0) return 0;
  if (!force && now - lastSessionSweepAt < SESSION_SWEEP_INTERVAL_MS) return 0;
  lastSessionSweepAt = now;
  try {
    return sweepStaleActiveSessions(now);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("Stale session sweep failed:", error);
    return 0;
  }
}

function extractLeadingJsonObject(text) {
  const source = typeof text === "string" ? text.trimStart() : "";
  if (!source.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          json: source.slice(0, i + 1),
          remainder: source.slice(i + 1).trim()
        };
      }
    }
  }
  return null;
}

function parseResultBody(text) {
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

function compactList(value, max) {
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

function compactSelectedMetrics(value) {
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

function normalizePlanPayload(parsedPlan) {
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

function validatePlanPayload(plan) {
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

function buildPlanBody(plan) {
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

function joinHumanList(items) {
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

function buildPlanDisplay(plan) {
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

function isSpanExportString(value) {
  if (typeof value !== "string") return false;
  const idx = value.indexOf(":");
  if (idx <= 0) return false;
  const prefix = value.slice(0, idx);
  return /^[0-9]+$/.test(prefix);
}

async function ensureRootParent(session) {
  if (session.root_span_id && session.root_span_span_id) {
    return {
      rootSpanId: session.root_span_id,
      spanId: session.root_span_span_id
    };
  }

  const rootSpanHandle = braintrustLogger.startSpan({
    name: `Session ${session.id}`,
    type: "trace"
  });
  const exported = await rootSpanHandle.export();
  const rootSpanId = rootSpanHandle.rootSpanId;
  const spanId = rootSpanHandle.spanId;
  rootSpanHandle.end();

  updateSession(db, session.id, {
    root_span: exported,
    root_span_id: rootSpanId,
    root_span_span_id: spanId,
    updated_at: Date.now()
  });

  const trace = parseJson(session.trace_json, null);
  if (trace) {
    trace.braintrust = {
      root_span: exported,
      root_span_id: rootSpanId,
      root_span_span_id: spanId
    };
    updateSession(db, session.id, {
      trace_json: JSON.stringify(trace, null, 2),
      updated_at: Date.now()
    });
  }

  return { rootSpanId, spanId };
}

function toClientError(err) {
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

app.get("/", (req, res) => {
  const username = req.cookies.mm_user;
  if (!username) return sendFile(res, "signup.html");
  const user = getUserByUsername(db, username);
  if (!user) return sendFile(res, "signup.html");
  return sendFile(res, "chat.html");
});

app.get("/u/:username", (req, res) => {
  return sendFile(res, "profile.html");
});

app.get("/api/me", (req, res) => {
  const username = req.cookies.mm_user;
  if (!username) return res.status(401).json({ error: "Not signed in" });
  const user = getUserByUsername(db, username);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  return res.json({ username: user.username });
});

app.post("/api/signup", (req, res) => {
  const base = typeof req.body?.username === "string" ? req.body.username : "";
  const unique = generateUniqueUsername(base, (candidate) =>
    getUserByUsernameKey(db, candidate)
  );
  if (!unique) {
    return res.status(400).json({ error: "Please enter a different name." });
  }

  const createdAt = Date.now();
  try {
    const user = createUser(db, {
      username: unique,
      usernameKey: unique,
      createdAt
    });
    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 365
    };
    if (COOKIE_DOMAIN) cookieOptions.domain = COOKIE_DOMAIN;
    if (process.env.NODE_ENV === "production") cookieOptions.secure = true;
    res.cookie("mm_user", user.username, cookieOptions);
    return res.json({ username: user.username });
  } catch (error) {
    return res.status(400).json({ error: "Name already taken." });
  }
});

app.get("/api/profile/:username", (req, res) => {
  const username = req.params.username;
  const user = getUserByUsername(db, username);
  if (!user) return res.status(404).json({ error: "User not found" });
  const sessions = listSessionsForUser(db, user.id, 50);
  return res.json({
    user: { username: user.username, created_at: user.created_at },
    sessions
  });
});

app.get("/api/trace/:id", (req, res) => {
  const session = getSessionById(db, req.params.id);
  if (!session) return res.status(404).json({ error: "Trace not found" });
  const trace = parseJson(session.trace_json, null);
  const payload = trace ? [trace] : [];
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=trace-${session.id}.json`
  );
  return res.send(JSON.stringify(payload, null, 2));
});

app.get("/api/traces/:username", (req, res) => {
  const username = req.params.username;
  const user = getUserByUsername(db, username);
  if (!user) return res.status(404).json({ error: "User not found" });
  const sessions = listSessionsForUser(db, user.id, 50);
  const traces = sessions
    .map((session) => {
      const full = getSessionById(db, session.id);
      if (!full?.trace_json) return null;
      return parseJson(full.trace_json, null);
    })
    .filter(Boolean);
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=traces-${username}.json`
  );
  return res.send(JSON.stringify(traces, null, 2));
});

app.post("/api/session/close", (req, res) => {
  const username = req.cookies.mm_user;
  if (!username) return res.status(204).end();
  const user = getUserByUsername(db, username);
  if (!user) return res.status(204).end();

  const tabId = normalizeTabId(req.query?.tab_id || req.body?.tab_id);
  if (!tabId) return res.status(204).end();

  maybeSweepStaleActiveSessions();

  const session = getActiveSessionForUserAndTab(db, user.id, tabId);
  if (!session || session.status !== "active") {
    return res.status(204).end();
  }

  finalizeSessionAsAbandoned(session, { reason: "tab_closed", now: Date.now() });
  return res.status(204).end();
});

app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const username = req.cookies.mm_user;
  if (!username) {
    sendEvent("error", { message: "Please sign up first." });
    res.end();
    return;
  }

  const user = getUserByUsername(db, username);
  if (!user) {
    sendEvent("error", { message: "Please sign up first." });
    res.end();
    return;
  }

  maybeSweepStaleActiveSessions();

  const message = typeof req.body?.message === "string" ? req.body.message : "";
  const tabId = normalizeTabId(req.body?.tab_id);
  const trimmed = message.trim();

  if (!GEMINI_API_KEY) {
    sendEvent("error", {
      message: "Gemini API key is missing.",
      detail: "Set GEMINI_API_KEY in .env and restart the server."
    });
    res.end();
    return;
  }

  let session = getActiveSessionForUserAndTab(db, user.id, tabId);

  if (!session || session.status !== "active") {
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();
    const rootSpanHandle = braintrustLogger.startSpan({
      name: `Session ${sessionId}`,
      type: "trace"
    });
    const rootSpan = await rootSpanHandle.export();
    const rootSpanId = rootSpanHandle.rootSpanId;
    const rootSpanSpanId = rootSpanHandle.spanId;
    rootSpanHandle.end();

    const trace = createTrace({
      sessionId,
      username: user.username,
      tabId,
      createdAt,
      rootSpan,
      rootSpanId,
      rootSpanSpanId
    });

    session = createSession(db, {
      id: sessionId,
      user_id: user.id,
      tab_id: tabId,
      username: user.username,
      status: "active",
      phase: "plan",
      turn_count: 0,
      chat_history: JSON.stringify([]),
      trace_json: JSON.stringify(trace, null, 2),
      root_span: rootSpan,
      root_span_id: rootSpanId,
      root_span_span_id: rootSpanSpanId,
      plan_text: null,
      plan_questions: null,
      plan_status: null,
      intent_origin: trimmed || null,
      intent_anchor: trimmed || null,
      intent_candidate: null,
      intent_candidate_confidence: null,
      intent_change_status: "none",
      created_at: createdAt,
      updated_at: createdAt
    });
  }

  const chatHistory = parseJson(session.chat_history, []);
  let intentOrigin =
    typeof session.intent_origin === "string" ? session.intent_origin.trim() : "";
  let intentAnchor =
    typeof session.intent_anchor === "string" ? session.intent_anchor.trim() : "";
  if (!intentOrigin) {
    intentOrigin = inferIntentAnchorFromHistory(chatHistory) || intentAnchor || trimmed;
  }
  if (!intentAnchor) {
    intentAnchor = intentOrigin || inferIntentAnchorFromHistory(chatHistory) || trimmed;
  }
  if (intentOrigin || intentAnchor) {
    const backfill = {};
    if (!session.intent_origin && intentOrigin) backfill.intent_origin = intentOrigin;
    if (!session.intent_anchor && intentAnchor) backfill.intent_anchor = intentAnchor;
    if (Object.keys(backfill).length > 0) {
      backfill.updated_at = Date.now();
      session = updateSession(db, session.id, backfill);
    }
  }
  const sessionIntentCandidate =
    typeof session.intent_candidate === "string" ? session.intent_candidate.trim() : "";
  const sessionIntentCandidateConfidence = Number.isFinite(
    Number(session.intent_candidate_confidence)
  )
    ? Number(session.intent_candidate_confidence)
    : null;
  const sessionIntentChangeStatus =
    typeof session.intent_change_status === "string" && session.intent_change_status
      ? session.intent_change_status
      : "none";
  const turnNumber = session.turn_count + 1;
  const fsmState = deriveSessionState(session);
  const initialMode =
    fsmState === SESSION_FSM_STATES.RESULT ? "result" : "plan";
  const hasPendingPlan =
    (fsmState === SESSION_FSM_STATES.AWAITING_CLARIFICATION ||
      fsmState === SESSION_FSM_STATES.AWAITING_INTENT_CONFIRMATION) &&
    Boolean(session.plan_text);

  if (!trimmed) {
    const apology =
      "Sorry — I only cover software and technology markets. Share a category like CRM software and I’ll build a plan.";
    sendEvent("token", { text: apology });
    sendEvent("final", { sources: "" });

    const updatedHistory = [...chatHistory, { role: "user", content: message }, { role: "assistant", content: apology }];
    const trace = parseJson(
      session.trace_json,
      createTrace({
        sessionId: session.id,
        username: session.username,
        tabId: session.tab_id || tabId || null,
        createdAt: session.created_at,
        rootSpan: session.root_span,
        rootSpanId: session.root_span_id,
        rootSpanSpanId: session.root_span_span_id
      })
    );

    const turnEntry = {
      turn: turnNumber,
      mode: "plan",
      user: message,
      started_at: Date.now(),
      finished_at: Date.now(),
      latency_ms: 0,
      model: GEMINI_MODEL,
      tokens: null,
      response_markdown: apology,
      sources: []
    };

    const nextTrace = addTurnToTrace(trace, turnEntry);
    updateSession(db, session.id, {
      chat_history: JSON.stringify(updatedHistory),
      trace_json: JSON.stringify(nextTrace, null, 2),
      turn_count: turnNumber,
      updated_at: Date.now()
    });

    res.end();
    return;
  }

  const rootParent = await ensureRootParent(session);
  const modelOrder = buildModelOrder(GEMINI_MODEL, GEMINI_FALLBACK_MODELS);
  const startedAt = Date.now();

  const sendActivity = (mode, steps) => {
    if (Array.isArray(steps) && steps.length > 0) {
      sendEvent("activity", { mode, steps });
    }
  };

  const chatHistoryWithUser = [...chatHistory, { role: "user", content: message }];

  try {
    const turnResult = await traced(
      async (turnSpan) => {
        let effectiveMode = initialMode;
        let planText = "";
        let planQuestions = [];
        let planUsage = null;
        const intentAnchorBefore = intentAnchor || "";
        let nextIntentAnchor = intentAnchorBefore || trimmed;
        let nextIntentCandidate = sessionIntentCandidate || "";
        let nextIntentCandidateConfidence = sessionIntentCandidateConfidence;
        let nextIntentChangeStatus = sessionIntentChangeStatus || "none";
        let intentDecisionAction = null;
        let intentDecisionReason = null;
        let intentDecisionConfidence = null;
        let intentDecisionCandidate = null;
        let planInputMessage = message;
        const storedPlanQuestions = parseJson(session.plan_questions || "[]", []);
        const getIntentPayload = () => ({
          intentOrigin: intentOrigin || null,
          intentAnchor: nextIntentAnchor || null,
          intentCandidate: nextIntentCandidate || null,
          intentCandidateConfidence: nextIntentCandidateConfidence,
          intentChangeStatus: nextIntentChangeStatus || "none",
          intentDecision: {
            action: intentDecisionAction,
            candidate: intentDecisionCandidate,
            confidence: intentDecisionConfidence,
            reason: intentDecisionReason
          }
        });

        if (initialMode === "plan" && hasPendingPlan) {
          if (nextIntentChangeStatus === "pending" && nextIntentCandidate) {
            if (isAffirmative(message)) {
              intentDecisionAction = "replace";
              intentDecisionCandidate = nextIntentCandidate;
              intentDecisionConfidence = nextIntentCandidateConfidence ?? 1;
              intentDecisionReason = "User confirmed pending category switch.";
              nextIntentAnchor = nextIntentCandidate;
              nextIntentCandidate = "";
              nextIntentCandidateConfidence = null;
              nextIntentChangeStatus = "accepted";
              planInputMessage = nextIntentAnchor;
            } else if (isNegative(message)) {
              intentDecisionAction = "refine";
              intentDecisionCandidate = nextIntentCandidate;
              intentDecisionConfidence = nextIntentCandidateConfidence ?? 1;
              intentDecisionReason = "User rejected pending category switch.";
              nextIntentCandidate = "";
              nextIntentCandidateConfidence = null;
              nextIntentChangeStatus = "rejected";
              effectiveMode = "result";
            } else {
              const confirmationPrompt = `I can switch focus from "${nextIntentAnchor}" to "${nextIntentCandidate}". Should I switch, or keep "${nextIntentAnchor}" and continue?`;
              sendEvent("token", { text: confirmationPrompt });
              sendEvent("final", { sources: "" });
              if (typeof turnSpan.log === "function") {
                turnSpan.log({
                  input: {
                    message,
                    chat_history: chatHistoryWithUser
                  },
                  output: confirmationPrompt,
                  metadata: {
                    username: user.username,
                    turn_number: turnNumber,
                    mode: "plan",
                    latency_ms: Date.now() - startedAt,
                    intent_anchor_before: intentAnchorBefore,
                    intent_anchor_after: nextIntentAnchor,
                    intent_candidate: nextIntentCandidate,
                    intent_candidate_confidence: nextIntentCandidateConfidence,
                    intent_decision_action: "pending_confirmation",
                    intent_change_status: nextIntentChangeStatus
                  }
                });
              }
              return {
                response: confirmationPrompt,
                sources: [],
                usage: null,
                citationReport: { valid: [], invalid: [] },
                llmLatency: 0,
                modelUsed: GEMINI_MODEL,
                modelAttempts: modelOrder,
                effectiveMode: "plan",
                planText: session.plan_text || null,
                planQuestions: Array.isArray(storedPlanQuestions)
                  ? storedPlanQuestions
                  : [],
                intentAnchor: nextIntentAnchor,
                intentCandidate: nextIntentCandidate,
                intentCandidateConfidence: nextIntentCandidateConfidence,
                intentChangeStatus: nextIntentChangeStatus,
                intentDecision: {
                  action: "pending_confirmation",
                  confidence: nextIntentCandidateConfidence,
                  reason: "Awaiting explicit confirmation."
                }
              };
            }
          } else {
            const assessmentRaw = await traced(
              async (span) => {
                const raw = await assessIntentChange({
                  ai: gemini,
                  model: GEMINI_MODEL,
                  intentAnchor: nextIntentAnchor,
                  planText: session.plan_text,
                  planQuestions: storedPlanQuestions,
                  userMessage: message,
                  recentUserTurns: chatHistory
                    .filter((entry) => entry.role === "user")
                    .map((entry) => entry.content)
                });
                if (typeof span?.log === "function") {
                  span.log({ output: raw });
                }
                return raw;
              },
              {
                name: "Assess intent change",
                input: {
                  intent_origin: intentOrigin || null,
                  intent_anchor: nextIntentAnchor,
                  plan: session.plan_text,
                  plan_questions: storedPlanQuestions,
                  message
                }
              }
            );
            const parsedAssessment = parseIntentChangeDecision(assessmentRaw);
            intentDecisionAction = parsedAssessment.action;
            intentDecisionReason = parsedAssessment.reason;
            intentDecisionConfidence = parsedAssessment.confidence;
            intentDecisionCandidate = parsedAssessment.candidateCategory;

            if (
              parsedAssessment.action === "replace" &&
              parsedAssessment.confidence >= INTENT_REPLACE_CONFIDENCE
            ) {
              nextIntentAnchor = parsedAssessment.candidateCategory;
              nextIntentCandidate = "";
              nextIntentCandidateConfidence = null;
              nextIntentChangeStatus = "accepted";
              planInputMessage = nextIntentAnchor;
            } else if (
              parsedAssessment.action === "replace" &&
              parsedAssessment.confidence >= INTENT_CONFIRM_CONFIDENCE
            ) {
              nextIntentCandidate = parsedAssessment.candidateCategory;
              nextIntentCandidateConfidence = parsedAssessment.confidence;
              nextIntentChangeStatus = "pending";
              const confirmationPrompt = `I read this as a possible category switch from "${nextIntentAnchor}" to "${nextIntentCandidate}". Should I switch, or keep "${nextIntentAnchor}" and continue?`;
              sendEvent("token", { text: confirmationPrompt });
              sendEvent("final", { sources: "" });
              if (typeof turnSpan.log === "function") {
                turnSpan.log({
                  input: {
                    message,
                    chat_history: chatHistoryWithUser
                  },
                  output: confirmationPrompt,
                  metadata: {
                    username: user.username,
                    turn_number: turnNumber,
                    mode: "plan",
                    latency_ms: Date.now() - startedAt,
                    intent_anchor_before: intentAnchorBefore,
                    intent_anchor_after: nextIntentAnchor,
                    intent_candidate: nextIntentCandidate,
                    intent_candidate_confidence: nextIntentCandidateConfidence,
                    intent_decision_action: "pending_confirmation",
                    intent_decision_reason: intentDecisionReason,
                    intent_change_status: nextIntentChangeStatus
                  }
                });
              }
              return {
                response: confirmationPrompt,
                sources: [],
                usage: null,
                citationReport: { valid: [], invalid: [] },
                llmLatency: 0,
                modelUsed: GEMINI_MODEL,
                modelAttempts: modelOrder,
                effectiveMode: "plan",
                planText: session.plan_text || null,
                planQuestions: Array.isArray(storedPlanQuestions)
                  ? storedPlanQuestions
                  : [],
                intentAnchor: nextIntentAnchor,
                intentCandidate: nextIntentCandidate,
                intentCandidateConfidence: nextIntentCandidateConfidence,
                intentChangeStatus: nextIntentChangeStatus,
                intentDecision: {
                  action: intentDecisionAction,
                  candidate: intentDecisionCandidate,
                  confidence: intentDecisionConfidence,
                  reason: intentDecisionReason
                }
              };
            } else {
              effectiveMode = "result";
              nextIntentCandidate = "";
              nextIntentCandidateConfidence = null;
              nextIntentChangeStatus = "none";
            }
          }
        }

        if (initialMode === "plan" && effectiveMode === "plan") {
          const primaryPlanModel = modelOrder[0] || GEMINI_MODEL;
          sendActivity("plan", [`Calling ${primaryPlanModel}`]);
          const planStart = Date.now();
          let planResult = await streamMarketResponse({
            ai: gemini,
            models: modelOrder,
            mode: "plan",
            chatHistory,
            userMessage: `Category anchor: ${nextIntentAnchor}\n\nUser message:\n${planInputMessage}`,
            stream: false,
            useGrounding: true,
            onModelFallback: (failedModel) => {
              const nextIdx = modelOrder.indexOf(failedModel) + 1;
              const nextModel = modelOrder[nextIdx];
              if (nextModel) {
                sendActivity("plan", [`Retrying ${nextModel}`]);
              }
            }
          });
          let planLatency = Date.now() - planStart;

          const fallbackApology =
            "Sorry — I only cover software and technology markets. Share a category like CRM software and I’ll build a plan.";
          let modelAttempts = planResult.attempts || modelOrder;
          let planUsage = planResult.usage || null;
          let rawPlanText = planResult.text || "";
          let normalizedPlan = normalizePlanPayload(
            (() => {
              const planJsonBlock = extractJsonBlock(rawPlanText);
              if (!planJsonBlock) return null;
              try {
                return JSON.parse(planJsonBlock);
              } catch {
                return null;
              }
            })()
          );
          let planValidation = validatePlanPayload(normalizedPlan);

          if (!planValidation.valid) {
            sendActivity("plan", ["Retrying plan formatting"]);
            const retryPrompt = `Return ONLY valid JSON in the required plan schema.\n\nCategory anchor: ${nextIntentAnchor}\n\nUser message:\n${planInputMessage}`;
            const retryStart = Date.now();
            const retriedPlan = await streamMarketResponse({
              ai: gemini,
              models: modelOrder,
              mode: "plan",
              chatHistory,
              userMessage: retryPrompt,
              stream: false,
              useGrounding: true,
              onModelFallback: (failedModel) => {
                const nextIdx = modelOrder.indexOf(failedModel) + 1;
                const nextModel = modelOrder[nextIdx];
                if (nextModel) {
                  sendActivity("plan", [`Retrying ${nextModel}`]);
                }
              }
            });
            planLatency += Date.now() - retryStart;
            planResult = retriedPlan;
            rawPlanText = planResult.text || "";
            planUsage = planResult.usage || null;
            modelAttempts = Array.from(
              new Set([...(modelAttempts || []), ...(retriedPlan.attempts || [])])
            );
            normalizedPlan = normalizePlanPayload(
              (() => {
                const planJsonBlock = extractJsonBlock(rawPlanText);
                if (!planJsonBlock) return null;
                try {
                  return JSON.parse(planJsonBlock);
                } catch {
                  return null;
                }
              })()
            );
            planValidation = validatePlanPayload(normalizedPlan);
          }

          if (normalizedPlan.apology) {
            const apologyText = normalizedPlan.apology;
            sendEvent("token", { text: apologyText });
            sendEvent("final", { sources: "" });
            if (typeof turnSpan.log === "function") {
              turnSpan.log({
                input: {
                  message,
                  chat_history: chatHistoryWithUser
                },
                output: apologyText,
                metadata: {
                  username: user.username,
                  turn_number: turnNumber,
                  mode: "apology",
                  latency_ms: Date.now() - startedAt,
                  llm_latency_ms: planLatency,
                  model: planResult.model || GEMINI_MODEL,
                  intent_anchor_before: intentAnchorBefore,
                  intent_anchor_after: nextIntentAnchor,
                  intent_candidate: nextIntentCandidate || null,
                  intent_candidate_confidence: nextIntentCandidateConfidence,
                  intent_decision_action: intentDecisionAction,
                  intent_decision_reason: intentDecisionReason,
                  intent_change_status: nextIntentChangeStatus
                }
              });
            }
            return {
              response: apologyText,
              sources: [],
              usage: planUsage,
              citationReport: { valid: [], invalid: [] },
              llmLatency: planLatency,
              modelUsed: planResult.model || GEMINI_MODEL,
              modelAttempts,
              effectiveMode: "apology",
              planText: null,
              planQuestions: [],
              skipPlanPersist: true,
              ...getIntentPayload()
            };
          }

          if (!planValidation.valid) {
            sendEvent("token", { text: fallbackApology });
            sendEvent("final", { sources: "" });
            if (typeof turnSpan.log === "function") {
              turnSpan.log({
                input: {
                  message,
                  chat_history: chatHistoryWithUser
                },
                output: fallbackApology,
                metadata: {
                  username: user.username,
                  turn_number: turnNumber,
                  mode: "apology",
                  latency_ms: Date.now() - startedAt,
                  llm_latency_ms: planLatency,
                  model: planResult.model || GEMINI_MODEL,
                  plan_validation_errors: planValidation.errors,
                  intent_anchor_before: intentAnchorBefore,
                  intent_anchor_after: nextIntentAnchor,
                  intent_candidate: nextIntentCandidate || null,
                  intent_candidate_confidence: nextIntentCandidateConfidence,
                  intent_decision_action: intentDecisionAction,
                  intent_decision_reason: intentDecisionReason,
                  intent_change_status: nextIntentChangeStatus
                }
              });
            }
            return {
              response: fallbackApology,
              sources: [],
              usage: planUsage,
              citationReport: { valid: [], invalid: [] },
              llmLatency: planLatency,
              modelUsed: planResult.model || GEMINI_MODEL,
              modelAttempts,
              effectiveMode: "apology",
              planText: null,
              planQuestions: [],
              skipPlanPersist: true,
              ...getIntentPayload()
            };
          }

          const planActivity = normalizedPlan.activity;
          const planModelLabel = planResult.model || GEMINI_MODEL;
          sendActivity(
            "plan",
            planActivity.map((step) => `${step} (${planModelLabel})`)
          );

          planQuestions = normalizedPlan.clarifyingQuestions;
          planText = buildPlanBody(normalizedPlan);
          let readyForResults = normalizedPlan.readyForResults;
          if (planQuestions.length > 0) {
            readyForResults = false;
          }
          const planDisplay = buildPlanDisplay(normalizedPlan);

          sendEvent("token", { text: planDisplay });
          sendEvent("final", { sources: "" });

          if (typeof turnSpan.log === "function") {
            turnSpan.log({
              input: {
                message,
                chat_history: chatHistoryWithUser
              },
              output: planDisplay,
              metadata: {
                username: user.username,
                turn_number: turnNumber,
                mode: "plan",
                latency_ms: Date.now() - startedAt,
                llm_latency_ms: planLatency,
                model: planResult.model || GEMINI_MODEL,
                token_counts: planUsage,
                plan_ready: readyForResults,
                clarifying_questions_count: planQuestions.length,
                intent_anchor_before: intentAnchorBefore,
                intent_anchor_after: nextIntentAnchor,
                intent_candidate: nextIntentCandidate || null,
                intent_candidate_confidence: nextIntentCandidateConfidence,
                intent_decision_action: intentDecisionAction,
                intent_decision_reason: intentDecisionReason,
                intent_change_status: nextIntentChangeStatus
              }
            });
          }

            return {
              response: planDisplay,
              sources: [],
              usage: planUsage,
              citationReport: { valid: [], invalid: [] },
              llmLatency: planLatency,
              modelUsed: planResult.model || GEMINI_MODEL,
              modelAttempts,
              effectiveMode: "plan",
              planText,
              planQuestions,
              ...getIntentPayload()
            };
        }

        if (effectiveMode === "result" && session.plan_text) {
          planText = session.plan_text;
        }

        const resultPrompt =
          effectiveMode === "result" && planText
            ? `Use this plan context while producing the final market result:\n${planText}\n\nCategory anchor:\n${nextIntentAnchor || "(none)"}\n\nUser clarification:\n${message}`
            : `Category anchor:\n${nextIntentAnchor || "(none)"}\n\nUser request:\n${message}`;

        if (effectiveMode === "result") {
          const primaryModel = modelOrder[0] || GEMINI_MODEL;
          sendActivity("result", [`Calling ${primaryModel}`]);
        }

        const llmStart = Date.now();
        let llmResult = await streamMarketResponse({
          ai: gemini,
          models: modelOrder,
          mode: "result",
          chatHistory,
          userMessage: resultPrompt,
          stream: false,
          useGrounding: true,
          onModelFallback: (failedModel) => {
            const nextIdx = modelOrder.indexOf(failedModel) + 1;
            const nextModel = modelOrder[nextIdx];
            if (nextModel) {
              sendActivity("result", [`Retrying ${nextModel}`]);
            }
          }
        });
        let llmLatency = Date.now() - llmStart;
        let modelAttempts = llmResult.attempts || modelOrder;

        let parsedResult = parseResultBody(llmResult.text || "");
        let cleaned = parsedResult.cleaned;
        let resultActivity = parsedResult.activity;
        if (resultActivity.length > 0) {
          const resultModelLabel = llmResult.model || GEMINI_MODEL;
          sendActivity(
            "result",
            resultActivity.map((step) => `${step} (${resultModelLabel})`)
          );
        }
        if (!cleaned) {
          const retryPrompt =
            effectiveMode === "result" && planText
              ? `Generate the final output now using this plan and clarification.\n\nPlan:\n${planText}\n\nCategory anchor:\n${nextIntentAnchor || "(none)"}\n\nClarification:\n${message}\n\nReturn the full result format, not only activity JSON.`
              : `Category anchor:\n${nextIntentAnchor || "(none)"}\n\nUser request:\n${message}\n\nReturn the full result format, not only activity JSON.`;
          sendActivity("result", ["Retrying response formatting"]);
          const retryStart = Date.now();
          const retriedResult = await streamMarketResponse({
            ai: gemini,
            models: modelOrder,
            mode: "result",
            chatHistory,
            userMessage: retryPrompt,
            stream: false,
            useGrounding: false,
            onModelFallback: (failedModel) => {
              const nextIdx = modelOrder.indexOf(failedModel) + 1;
              const nextModel = modelOrder[nextIdx];
              if (nextModel) {
                sendActivity("result", [`Retrying ${nextModel}`]);
              }
            }
          });
          llmLatency += Date.now() - retryStart;
          llmResult = retriedResult;
          modelAttempts = Array.from(new Set([...(modelAttempts || []), ...(retriedResult.attempts || [])]));
          parsedResult = parseResultBody(llmResult.text || "");
          cleaned = parsedResult.cleaned;
          resultActivity = parsedResult.activity;
          if (resultActivity.length > 0) {
            const retryModelLabel = llmResult.model || GEMINI_MODEL;
            sendActivity(
              "result",
              resultActivity.map((step) => `${step} (${retryModelLabel})`)
            );
          }
          if (!cleaned) {
            throw new Error("Empty result response from model.");
          }
        }
        const lowerCleaned = cleaned.toLowerCase();
        if (
          lowerCleaned.includes("only cover software and technology markets") ||
          lowerCleaned.startsWith("sorry")
        ) {
          sendEvent("token", { text: cleaned });
          sendEvent("final", { sources: "" });
          if (typeof turnSpan.log === "function") {
            turnSpan.log({
              input: {
                message,
                chat_history: chatHistoryWithUser
              },
              output: cleaned,
              metadata: {
                username: user.username,
                turn_number: turnNumber,
                mode: "apology",
                latency_ms: Date.now() - startedAt,
                llm_latency_ms: llmLatency,
                model: llmResult.model || GEMINI_MODEL,
                intent_anchor_before: intentAnchorBefore,
                intent_anchor_after: nextIntentAnchor,
                intent_candidate: nextIntentCandidate || null,
                intent_candidate_confidence: nextIntentCandidateConfidence,
                intent_decision_action: intentDecisionAction,
                intent_decision_reason: intentDecisionReason,
                intent_change_status: nextIntentChangeStatus
              }
            });
          }
          return {
            response: cleaned,
            sources: [],
            usage: llmResult.usage || null,
            citationReport: { valid: [], invalid: [] },
            llmLatency,
            modelUsed: llmResult.model || GEMINI_MODEL,
            modelAttempts,
            effectiveMode: "apology",
            planText,
            planQuestions,
            skipPlanPersist: true,
            ...getIntentPayload()
          };
        }
        let sources = [];
        let citationReport = { valid: [], invalid: [] };
        let repairedSources = [];

        const category = nextIntentAnchor || inferCategory(message, chatHistory);
        let sourceOrigin = "grounding";
        let rawSources = [];
        let gatheredSources = [];
        try {
          gatheredSources = await generateSourcesForResult({
            ai: gemini,
            model: GEMINI_MODEL,
            category,
            resultText: cleaned
          });
        } catch {
          gatheredSources = [];
        }
        if (Array.isArray(gatheredSources) && gatheredSources.length > 0) {
          rawSources = gatheredSources;
          sourceOrigin = "generated";
        } else {
          rawSources = extractSources(llmResult.grounding);
        }
        const validation = await traced(
          async (span) => {
            const result = await validateSources(rawSources);
            if (typeof span?.log === "function") {
              span.log({
                output: {
                  valid_count: result.valid.length,
                  invalid_count: result.invalid.length,
                  valid_urls: result.valid.map((s) => s.url),
                  invalid_urls: result.invalid.map((s) => s.url)
                }
              });
            }
            return result;
          },
          {
            name: "Citation check",
            input: { source_origin: sourceOrigin, sources: rawSources.map((s) => s.url) }
          }
        );

        let valid = validation.valid;
        let invalid = validation.invalid;

        if (valid.length < 3) {
          const repaired = await repairSources({
            ai: gemini,
            model: GEMINI_MODEL,
            category,
            resultText: cleaned
          });
          repairedSources = repaired;
          const repairedValidation = await traced(
            async (span) => {
              const result = await validateSources(repaired);
              if (typeof span?.log === "function") {
                span.log({
                  output: {
                    valid_count: result.valid.length,
                    invalid_count: result.invalid.length,
                    valid_urls: result.valid.map((s) => s.url),
                    invalid_urls: result.invalid.map((s) => s.url)
                  }
                });
              }
              return result;
            },
            {
              name: "Citation re-check",
              input: { sources: repaired.map((s) => s.url) }
            }
          );
          valid = repairedValidation.valid;
          invalid = repairedValidation.invalid;
        }

        sources = withDomains(valid).slice(0, 4);
        citationReport = { valid: valid, invalid: invalid };
        let sourcesMarkdown = formatSourcesMarkdown(sources);
        let citationBasis = sources.length > 0 ? "valid" : "none";
        let citationUnverified = false;
        if (sources.length === 0) {
          const fallback =
            invalid.length > 0
              ? invalid
              : repairedSources.length > 0
              ? repairedSources
              : rawSources;
          sources = withDomains(fallback).slice(0, 4);
          if (sources.length > 0) {
            citationBasis = invalid.length > 0 ? "invalid" : repairedSources.length > 0 ? "repaired" : "raw";
            citationUnverified = true;
            sourcesMarkdown = formatSourcesMarkdown(sources).replace(
              "**Sources:**",
              "**Sources (unverified):**"
            );
          } else {
            citationBasis = "none";
            sourcesMarkdown = "**Sources:** (unavailable)";
          }
        }
        sendEvent("token", { text: cleaned });
        sendEvent("final", { sources: sourcesMarkdown });

        const finalText = `${cleaned}\n\n${sourcesMarkdown}`;

        if (typeof turnSpan.log === "function") {
          turnSpan.log({
            input: {
              message,
              chat_history: chatHistoryWithUser
            },
            output: finalText,
            metadata: {
              username: user.username,
              turn_number: turnNumber,
              mode: "result",
              latency_ms: Date.now() - startedAt,
              llm_latency_ms: llmLatency,
              model: llmResult.model || GEMINI_MODEL,
              token_counts: llmResult.usage || null,
              plan_auto_advance: initialMode === "plan" && effectiveMode === "result",
              citation_valid_count: valid.length,
              citation_invalid_count: invalid.length,
              citation_report: {
                valid: valid.map((entry) => entry.url),
                invalid: invalid.map((entry) => entry.url)
              },
              citation_pipeline: {
                source_origin: sourceOrigin,
                generated_count: gatheredSources.length,
                raw_count: rawSources.length,
                valid_count: valid.length,
                invalid_count: invalid.length,
                repaired_count: repairedSources.length,
                used_count: sources.length,
                basis: citationBasis,
                unverified: citationUnverified
              },
              intent_anchor_before: intentAnchorBefore,
              intent_anchor_after: nextIntentAnchor,
              intent_candidate: nextIntentCandidate || null,
              intent_candidate_confidence: nextIntentCandidateConfidence,
              intent_decision_action: intentDecisionAction,
              intent_decision_candidate: intentDecisionCandidate,
              intent_decision_confidence: intentDecisionConfidence,
              intent_decision_reason: intentDecisionReason,
              intent_change_status: nextIntentChangeStatus
            }
          });
        }

        return {
          response: finalText,
          sources,
          usage: llmResult.usage,
          citationReport,
          llmLatency,
          modelUsed: llmResult.model || GEMINI_MODEL,
          modelAttempts,
          effectiveMode: "result",
          planText,
          planQuestions,
          ...getIntentPayload()
        };
      },
      {
        name: `Turn ${turnNumber}`,
        parentSpanIds: rootParent,
        input: { message, chat_history: chatHistoryWithUser }
      }
    );

    const nextHistory = [
      ...chatHistoryWithUser,
      { role: "assistant", content: turnResult.response }
    ];

    const trace = parseJson(
      session.trace_json,
      createTrace({
        sessionId: session.id,
        username: session.username,
        tabId: session.tab_id || tabId || null,
        createdAt: session.created_at,
        rootSpan: session.root_span,
        rootSpanId: rootParent.rootSpanId,
        rootSpanSpanId: rootParent.spanId
      })
    );

    const kind = turnResult.effectiveMode || initialMode;
    const isPlan = kind === "plan";
    const isResult = kind === "result";
    const isApology = kind === "apology";
    const turnEntry = {
      turn: turnNumber,
      user: message,
      plan: isPlan ? turnResult.planText || null : null,
      question: isPlan ? (turnResult.planQuestions?.[0] || null) : null,
      response: isResult || isApology ? turnResult.response : null,
      kind,
      sources: Array.isArray(turnResult.sources)
        ? turnResult.sources.map((source) => ({
            title: source.title || source.url,
            url: source.url
          }))
        : [],
      citations: turnResult.citationReport
        ? {
            valid: turnResult.citationReport.valid.length,
            invalid: turnResult.citationReport.invalid.length
          }
        : null,
      model: turnResult.modelUsed || GEMINI_MODEL,
      latency_ms: Date.now() - startedAt,
      llm_latency_ms: turnResult.llmLatency || null,
      tokens: turnResult.usage || null,
      model_attempts: turnResult.modelAttempts || modelOrder,
      intent: {
        tab_id: session.tab_id || tabId || null,
        origin: turnResult.intentOrigin || intentOrigin || null,
        anchor: turnResult.intentAnchor || intentAnchor || null,
        candidate: turnResult.intentCandidate || null,
        candidate_confidence: turnResult.intentCandidateConfidence ?? null,
        change_status: turnResult.intentChangeStatus || "none",
        decision: turnResult.intentDecision || null
      }
    };

    const nextTrace = addTurnToTrace(trace, turnEntry);
    const transitionResult = reduceSessionAfterTurn({
      session,
      turnResult,
      nextHistory,
      nextTrace,
      turnNumber,
      now: Date.now(),
      fallbackIntentOrigin: intentOrigin,
      fallbackIntentAnchor: intentAnchor
    });

    if (transitionResult.transition.event === "RESULT_READY") {
      pruneSessions(db, user.id, 50);
      if (session.root_span) {
        const firstUser = nextHistory.find((entry) => entry.role === "user");
        updateSpan({
          exported: session.root_span,
          input: {
            first_msg: firstUser?.content || null
          },
          output: {
            final_response: turnResult.response,
            final_mode: turnResult.effectiveMode
          },
          metadata: {
            username: session.username,
            session_id: session.id,
            tab_id: session.tab_id || tabId || null,
            total_turns: turnNumber,
            status: "complete",
            intent_origin: turnResult.intentOrigin || intentOrigin || null,
            intent_anchor: turnResult.intentAnchor || intentAnchor || null
          }
        });
      }
    }

    updateSession(db, session.id, transitionResult.updates);
  } catch (error) {
    const clientError = toClientError(error);
    sendEvent("error", clientError);
    // eslint-disable-next-line no-console
    console.error("Chat error:", error);
  } finally {
    res.end();
  }
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Market Map running on http://localhost:${PORT}`);
  });
}

export { app, db };
