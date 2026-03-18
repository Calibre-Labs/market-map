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
  extractLeadingJsonObject,
  extractGroundingSources,
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
import {
  parseResultBody,
  normalizePlanPayload,
  validatePlanPayload,
  buildPlanBody,
  buildPlanDisplay
} from "./lib/plan.js";
import { toClientError } from "./lib/errors.js";
import {
  createTrace,
  addTurnToTrace,
  isSpanExportString,
  attachBraintrustCircuitBreaker,
  createEnsureRootParent
} from "./lib/trace.js";

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

const DEFAULT_FALLBACKS = ["gemini-2.5-flash", "gemini-2.5-pro-preview-06-05"];
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

attachBraintrustCircuitBreaker(braintrustLogger, {
  errorWindowMs: Number(process.env.BRAINTRUST_ERROR_WINDOW_MS || 60000),
  errorThreshold: Number(process.env.BRAINTRUST_ERROR_THRESHOLD || 3)
});

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

app.get("/healthz", (_req, res) => {
  try {
    db.prepare("SELECT 1 AS ok").get();
    return res.status(200).json({ ok: true });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Health check failed:", error);
    return res.status(503).json({ ok: false });
  }
});

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


function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function colorizeJsonForHtml(jsonText) {
  const tokenPattern =
    /"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let result = "";
  let lastIndex = 0;
  let match;

  while ((match = tokenPattern.exec(jsonText)) !== null) {
    const token = match[0];
    result += escapeHtml(jsonText.slice(lastIndex, match.index));
    let tokenClass = "json-number";
    if (token.startsWith('"')) {
      tokenClass = token.endsWith(":") ? "json-key" : "json-string";
    } else if (token === "true" || token === "false") {
      tokenClass = "json-boolean";
    } else if (token === "null") {
      tokenClass = "json-null";
    }
    result += `<span class="${tokenClass}">${escapeHtml(token)}</span>`;
    lastIndex = tokenPattern.lastIndex;
  }

  result += escapeHtml(jsonText.slice(lastIndex));
  return result;
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

const ensureRootParent = createEnsureRootParent(braintrustLogger, db, updateSession);

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
  const jsonText = JSON.stringify(payload, null, 2);
  const inline =
    req.query.inline === "1" ||
    req.query.inline === "true";
  const pretty =
    req.query.pretty === "1" ||
    req.query.pretty === "true";
  if (inline && pretty) {
    const highlightedJson = colorizeJsonForHtml(jsonText);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Trace ${session.id}</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        margin: 0;
        padding: 20px;
        background: #f7f4ee;
        color: #1b1814;
        font-family: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono",
          "Courier New", monospace;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        background: #fff;
        border: 1px solid #e4ded3;
        border-radius: 12px;
        padding: 16px;
        line-height: 1.5;
      }
      .json-key {
        color: #8b3b2b;
      }
      .json-string {
        color: #155f45;
      }
      .json-number {
        color: #1f4d7a;
      }
      .json-boolean {
        color: #5b2a86;
      }
      .json-null {
        color: #6a5f55;
      }
    </style>
  </head>
  <body>
    <pre>${highlightedJson}</pre>
  </body>
</html>`);
  }
  res.setHeader("Content-Type", "application/json");
  if (!inline) {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=trace-${session.id}.json`
    );
  }
  return res.send(jsonText);
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
      "Sorry — I only cover technology markets. Share a category like CRM software and I’ll build a plan.";
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

  const sendActivity = (mode) => {
    sendEvent("activity", { mode });
  };

  const sendThinking = (text) => {
    sendEvent("thinking", { text });
  };

  const sendProgress = (step) => {
    sendEvent("progress", { step });
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
            sendThinking("Checking if category changed");
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
            if (parsedAssessment.action === "replace") {
              sendThinking(`Detected category shift to "${parsedAssessment.candidateCategory}" (confidence: ${parsedAssessment.confidence.toFixed(2)})`);
            } else {
              sendThinking(`Staying with "${nextIntentAnchor}" (${parsedAssessment.action})`);
            }

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
          sendActivity("plan");
          sendProgress(0);
          sendThinking(`Generating research plan using ${primaryPlanModel}`);
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
                sendThinking(`Model ${failedModel} unavailable, switching to ${nextModel}`);
              }
            }
          });
          let planLatency = Date.now() - planStart;

          const fallbackApology =
            "Sorry — I only cover technology markets. Share a category like CRM software and I’ll build a plan.";
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
            sendThinking("Plan format invalid, retrying");
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
                  sendThinking(`Model ${failedModel} unavailable, switching to ${nextModel}`);
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
          for (const step of planActivity) {
            sendThinking(step);
          }
          sendProgress(1);

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
          sendActivity("result");
          sendProgress(0);
          sendThinking(`Segmenting market for "${nextIntentAnchor || message}"`);
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
              sendThinking(`Model ${failedModel} unavailable, switching to ${nextModel}`);
            }
          }
        });
        let llmLatency = Date.now() - llmStart;
        let modelAttempts = llmResult.attempts || modelOrder;

        sendProgress(1);
        sendThinking("Ranking top 3 companies");

        let parsedResult = parseResultBody(llmResult.text || "");
        let cleaned = parsedResult.cleaned;
        let resultActivity = parsedResult.activity;
        if (resultActivity.length > 0) {
          for (const step of resultActivity) {
            sendThinking(step);
          }
        }
        if (!cleaned) {
          const retryPrompt =
            effectiveMode === "result" && planText
              ? `Generate the final output now using this plan and clarification.\n\nPlan:\n${planText}\n\nCategory anchor:\n${nextIntentAnchor || "(none)"}\n\nClarification:\n${message}\n\nReturn the full result format, not only activity JSON.`
              : `Category anchor:\n${nextIntentAnchor || "(none)"}\n\nUser request:\n${message}\n\nReturn the full result format, not only activity JSON.`;
          sendThinking("Result format invalid, retrying");
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
                sendThinking(`Model ${failedModel} unavailable, switching to ${nextModel}`);
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
            for (const step of resultActivity) {
              sendThinking(step);
            }
          }
          if (!cleaned) {
            throw new Error("Empty result response from model.");
          }
        }

        sendProgress(2);
        sendThinking("Checking result quality");
        const lowerCleaned = cleaned.toLowerCase();
        if (
          lowerCleaned.includes("only cover technology markets") ||
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
        sendProgress(3);
        sendThinking("Preparing citations");

        let sources = [];
        let citationReport = { valid: [], invalid: [] };
        let repairedSources = [];

        const category = nextIntentAnchor || inferCategory(message, chatHistory);
        let sourceOrigin = "grounding";
        let rawSources = [];

        sendProgress(4);
        sendThinking("Extracting sources from grounded search");
        rawSources = extractGroundingSources(llmResult.grounding);
        sourceOrigin = "grounding";

        if (rawSources.length === 0) {
          sendThinking("No grounding sources, searching independently");
          try {
            const gathered = await generateSourcesForResult({
              ai: gemini,
              model: GEMINI_MODEL,
              category,
              resultText: cleaned
            });
            if (Array.isArray(gathered) && gathered.length > 0) {
              rawSources = gathered;
              sourceOrigin = "generated";
            }
          } catch {
            // fall through to repair
          }
        }

        sendThinking(`Found ${rawSources.length} candidate sources`);

        let valid = [];
        let invalid = [];

        if (rawSources.length > 0) {
          sendThinking(`Validating ${rawSources.length} source URLs`);
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
          valid = validation.valid;
          invalid = validation.invalid;
          sendThinking(`${valid.length} valid, ${invalid.length} invalid`);
        }

        if (valid.length < 3) {
          sendThinking(`Need more sources (have ${valid.length}), repairing`);
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
          sendThinking(`After repair: ${valid.length} valid, ${invalid.length} invalid`);
        }

        sources = withDomains(valid).slice(0, 8);
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
          sources = withDomains(fallback).slice(0, 8);
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

        const finalText = `${cleaned}\n\n---\n\n${sourcesMarkdown}`;

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
                generated_count: 0,
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

let server = null;
let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`Received ${signal}. Shutting down gracefully...`);

  const forceTimer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);
  if (typeof forceTimer.unref === "function") forceTimer.unref();

  const finish = (exitCode) => {
    clearTimeout(forceTimer);
    try {
      db.close();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error while closing database:", error);
    }
    process.exit(exitCode);
  };

  if (!server) {
    finish(0);
    return;
  }

  server.close((error) => {
    if (error) {
      // eslint-disable-next-line no-console
      console.error("Error while closing HTTP server:", error);
      finish(1);
      return;
    }
    finish(0);
  });
}

if (process.env.NODE_ENV !== "test") {
  server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Market Map running on http://localhost:${PORT}`);
  });

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export { app, db };
