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
  getActiveSessionForUser,
  createSession,
  updateSession,
  listSessionsForUser,
  pruneSessions,
  getSessionById
} from "./lib/db.js";
import {
  generateUniqueUsername,
  inferCategory
} from "./lib/username.js";
import {
  assessPlanChange,
  createGeminiClient,
  extractJsonBlock,
  extractSources,
  formatSourcesMarkdown,
  generateSourcesForResult,
  getModelName,
  repairSources,
  streamMarketResponse,
  stripSourcesSection,
  validateSources,
  withDomains
} from "./lib/agent.js";

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

const braintrustLogger = initLogger({
  projectName: process.env.BRAINTRUST_PROJECT || "market-map",
  apiKey: process.env.BRAINTRUST_API_KEY
});

const BT_ERROR_WINDOW_MS = Number(process.env.BRAINTRUST_ERROR_WINDOW_MS || 60000);
const BT_ERROR_THRESHOLD = Number(process.env.BRAINTRUST_ERROR_THRESHOLD || 3);
let btErrorCount = 0;
let btErrorWindowStart = 0;
let btDisabled = false;

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

function sendFile(res, filename) {
  res.sendFile(path.join(publicDir, filename));
}


function createTrace({ sessionId, username, createdAt, rootSpan, rootSpanId, rootSpanSpanId }) {
  return {
    version: 2,
    session_id: sessionId,
    username,
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

  const message = typeof req.body?.message === "string" ? req.body.message : "";
  const trimmed = message.trim();

  if (!GEMINI_API_KEY) {
    sendEvent("error", {
      message: "Gemini API key is missing.",
      detail: "Set GEMINI_API_KEY in .env and restart the server."
    });
    res.end();
    return;
  }

  let session = getActiveSessionForUser(db, user.id);

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
      createdAt,
      rootSpan,
      rootSpanId,
      rootSpanSpanId
    });

    session = createSession(db, {
      id: sessionId,
      user_id: user.id,
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
      created_at: createdAt,
      updated_at: createdAt
    });
  }

  const chatHistory = parseJson(session.chat_history, []);
  const turnNumber = session.turn_count + 1;
  const initialMode = session.phase === "result" ? "result" : "plan";
  const hasPendingPlan =
    session.phase === "plan" &&
    session.plan_status === "awaiting_clarification" &&
    session.plan_text;

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
        let assessmentAction = null;
        let assessmentReason = null;
        let planUsage = null;

        if (initialMode === "plan") {
          if (hasPendingPlan) {
            const assessmentRaw = await traced(
              async (span) => {
                const raw = await assessPlanChange({
                  ai: gemini,
                  model: GEMINI_MODEL,
                  planText: session.plan_text,
                  userMessage: message
                });
                if (typeof span?.log === "function") {
                  span.log({ output: raw });
                }
                return raw;
              },
              {
                name: "Assess plan change",
                input: { plan: session.plan_text, message }
              }
            );
            const assessmentJson = extractJsonBlock(assessmentRaw || "");
            let parsedAssessment = null;
            try {
              parsedAssessment = assessmentJson ? JSON.parse(assessmentJson) : null;
            } catch {
              parsedAssessment = null;
            }
            assessmentAction =
              parsedAssessment?.action === "replan" ? "replan" : "keep";
            assessmentReason =
              typeof parsedAssessment?.reason === "string"
                ? parsedAssessment.reason
                : null;
            if (assessmentAction === "keep") {
              effectiveMode = "result";
            }
          }
        }

        if (initialMode === "plan" && effectiveMode === "plan") {
          const primaryPlanModel = modelOrder[0] || GEMINI_MODEL;
          sendActivity("plan", [`Calling ${primaryPlanModel}`]);
          const planStart = Date.now();
          const planResult = await streamMarketResponse({
            ai: gemini,
            models: modelOrder,
            mode: "plan",
            chatHistory,
            userMessage: message,
            stream: false,
            useGrounding: false,
            onModelFallback: (failedModel) => {
              const nextIdx = modelOrder.indexOf(failedModel) + 1;
              const nextModel = modelOrder[nextIdx];
              if (nextModel) {
                sendActivity("plan", [`Retrying ${nextModel}`]);
              }
            }
          });
          const planLatency = Date.now() - planStart;

          const planRaw = planResult.text || "";
          const planJsonBlock = extractJsonBlock(planRaw);
          let parsedPlan = null;
          try {
            parsedPlan = planJsonBlock ? JSON.parse(planJsonBlock) : null;
          } catch {
            parsedPlan = null;
          }

          const apologyText =
            typeof parsedPlan?.apology === "string" ? parsedPlan.apology.trim() : "";
          if (apologyText) {
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
                  llm_latency_ms: Date.now() - planStart,
                  model: planResult.model || GEMINI_MODEL
                }
              });
            }
            return {
              response: apologyText,
              sources: [],
              usage: planResult.usage || null,
              citationReport: { valid: [], invalid: [] },
              llmLatency: Date.now() - planStart,
              modelUsed: planResult.model || GEMINI_MODEL,
              modelAttempts: planResult.attempts || modelOrder,
              effectiveMode: "apology",
              planText: null,
              planQuestions: [],
              skipPlanPersist: true
            };
          }

          const planActivity = Array.isArray(parsedPlan?.activity)
            ? parsedPlan.activity.filter((step) => typeof step === "string" && step.trim())
            : [];
          const planModelLabel = planResult.model || GEMINI_MODEL;
          sendActivity(
            "plan",
            planActivity.map((step) => `${step} (${planModelLabel})`)
          );

          const clarifyingQuestions = Array.isArray(parsedPlan?.clarifying_questions)
            ? parsedPlan.clarifying_questions.filter((q) => typeof q === "string" && q.trim())
            : [];
          planText = typeof parsedPlan?.plan === "string" ? parsedPlan.plan.trim() : "";
          planQuestions = clarifyingQuestions;
          planText = planText.replace(/\n{3,}/g, "\n\n");
          let readyForResults = Boolean(parsedPlan?.ready_for_results);
          if (clarifyingQuestions.length === 0) {
            readyForResults = false;
          }
          planQuestions = clarifyingQuestions;
          planUsage = planResult.usage || null;

          const questionLine = clarifyingQuestions[0];
          const fallbackApology =
            "Sorry — I only cover software and technology markets. Share a category like CRM software and I’ll build a plan.";
          if (!planText || !questionLine) {
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
                  llm_latency_ms: Date.now() - planStart,
                  model: planResult.model || GEMINI_MODEL
                }
              });
            }
            return {
              response: fallbackApology,
              sources: [],
              usage: planUsage,
              citationReport: { valid: [], invalid: [] },
              llmLatency: Date.now() - planStart,
              modelUsed: planResult.model || GEMINI_MODEL,
              modelAttempts: planResult.attempts || modelOrder,
              effectiveMode: "apology",
              planText: null,
              planQuestions: [],
              skipPlanPersist: true
            };
          }
          const planDisplay = `### Plan\n${planText}\n\n**${questionLine}**`;

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
                clarifying_questions_count: clarifyingQuestions.length
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
              modelAttempts: planResult.attempts || modelOrder,
              effectiveMode: "plan",
              planText,
              planQuestions
            };
        }

        if (effectiveMode === "result" && session.plan_text) {
          planText = session.plan_text;
        }

        const resultPrompt = message;

        if (effectiveMode === "result") {
          const primaryModel = modelOrder[0] || GEMINI_MODEL;
          sendActivity("result", [`Calling ${primaryModel}`]);
        }

        const llmStart = Date.now();
        const llmResult = await streamMarketResponse({
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
        const llmLatency = Date.now() - llmStart;

        const resultRaw = llmResult.text || "";
        const resultActivityJson = extractJsonBlock(resultRaw);
        let resultActivity = [];
        if (resultActivityJson) {
          try {
            const parsed = JSON.parse(resultActivityJson);
            resultActivity = Array.isArray(parsed?.activity)
              ? parsed.activity.filter((step) => typeof step === "string" && step.trim())
              : [];
          } catch {
            resultActivity = [];
          }
        }
        if (resultActivity.length > 0) {
          const resultModelLabel = llmResult.model || GEMINI_MODEL;
          sendActivity(
            "result",
            resultActivity.map((step) => `${step} (${resultModelLabel})`)
          );
        }
        const withoutActivity = resultActivityJson
          ? resultRaw.replace(resultActivityJson, "").trim()
          : resultRaw;
        let cleaned = stripSourcesSection(withoutActivity);
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
                model: llmResult.model || GEMINI_MODEL
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
            modelAttempts: llmResult.attempts || modelOrder,
            effectiveMode: "apology",
            planText,
            planQuestions,
            skipPlanPersist: true
          };
        }
        let sources = [];
        let citationReport = { valid: [], invalid: [] };
        let repairedSources = [];

        const category = inferCategory(message, chatHistory);
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

        if (invalid.length > 0 || valid.length < 3) {
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
              plan_assessment_action: assessmentAction,
              plan_assessment_reason: assessmentReason
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
          modelAttempts: llmResult.attempts || modelOrder,
          effectiveMode: "result",
          planText,
          planQuestions
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
      model_attempts: turnResult.modelAttempts || modelOrder
    };

    const nextTrace = addTurnToTrace(trace, turnEntry);

    const updated = {
      chat_history: JSON.stringify(nextHistory),
      trace_json: JSON.stringify(nextTrace, null, 2),
      turn_count: turnNumber,
      updated_at: Date.now()
    };

    if (turnResult.effectiveMode === "result") {
      updated.status = "complete";
      updated.phase = "result";
      updated.plan_status = "executed";
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
            total_turns: turnNumber,
            status: "complete"
          }
        });
      }
    } else if (turnResult.skipPlanPersist) {
      updated.phase = "plan";
      updated.plan_text = null;
      updated.plan_questions = null;
      updated.plan_status = null;
    } else {
      updated.phase = "plan";
      updated.plan_text = turnResult.planText || session.plan_text || null;
      updated.plan_questions = turnResult.planQuestions
        ? JSON.stringify(turnResult.planQuestions)
        : session.plan_questions || null;
      updated.plan_status = "awaiting_clarification";
    }

    updateSession(db, session.id, updated);
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
