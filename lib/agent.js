import { GoogleGenAI } from "@google/genai";
import { traced } from "braintrust";

const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";
const groundingTool = { googleSearch: {} };

export function createGeminiClient(apiKey) {
  return new GoogleGenAI({ apiKey });
}

export function buildSystemInstruction(mode) {
  const today = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());
  const common = `You are a market research analyst covering software and technology.\nCurrent date: ${today}\n\nCore task:\n- Research the market category mentioned by the user.\n- Rank the top 3 players.\n- Ranking priority: revenue -> valuation -> number of customers -> number of G2 ratings.\n\nOutput rules:\n- Be concise. Use markdown with line breaks for readability.\n- Use fresh numeric evidence for metrics, ideally from the last 12 months.\n- Keep metrics as consistent across the 3 companies as possible.\n- If the input is empty or entirely unrelated to technology, respond with a brief apology and remind the user of your task.\n`;

  if (mode === "plan") {
    return `${common}\nPlan Mode:\n- Provide a specific plan to research the market category mentioned by the user.\n- Identify candidate segments and a concrete longlist of likely players based on fresh metrics ideally from the last 12 months.\n- For each longlist player, include a short descriptor metric (latest reported revenue or valuation) in parentheses.\n- Select only the most useful metrics for this category and explain why each is appropriate.\n- Do NOT blindly list all ranking-priority metrics unless they are all clearly appropriate and available.\n- Always ask exactly 1 clarifying question to polish segment selection.\n- The clarifying question must include at least 2 options (inline).\n- If the input is nonsense or unrelated to software/technology, return an apology instead of a plan.\n- Do NOT provide the final ranking or a 3-company table.\n\nReturn ONLY valid JSON in this exact shape:\n{\n  \"plan_overview\": \"...\",\n  \"segments\": [\"...\"],\n  \"longlist_players\": [\"...\"],\n  \"selected_metrics\": [\n    {\"name\": \"...\", \"why\": \"...\"}\n  ],\n  \"clarifying_questions\": [\"...\"],\n  \"ready_for_results\": true,\n  \"activity\": [\"...\"],\n  \"apology\": \"...\"\n}\n\nRules:\n- \"plan_overview\" short sentences with no extra blank lines.\n- \"segments\" must contain 2-5 items unless you are apologizing.\n- \"longlist_players\" must contain 5-8 items unless you are apologizing. Each item must be \"Company Name (metric)\" where metric is latest revenue or valuation.\n- \"selected_metrics\" must contain 2-3 items unless you are apologizing.\n- Each metric object must include non-empty \"name\" and \"why\"; keep \"why\" to one concise phrase (about 6-12 words).\n- \"clarifying_questions\" must be an array of exactly 1 item unless you are apologizing in which case it's none.\n- If a clarifying question is present, set \"ready_for_results\" to false.\n- \"activity\" must be 2-4 items, 3-6 words each, present tense, no punctuation.\n- \"apology\" must be a brief apology string ONLY when the input is nonsense/unrelated; otherwise set it to an empty string.\n- Do not include any extra keys or non-JSON text.\n`;
  }

  return `${common}\nResult Mode:\n- Execute the plan. Provide exactly 3 companies.\n- Each company must include 2 metrics to support the ranking.\n- Provide a structured rationale that exposes the reasoning behind the ranking.\n- Do NOT include a Sources section; the system will add it.\n\nOutput format (exactly):\n{ \"activity\": [\"...\"] }\n<blank line>\n### Category: <Category Name>\n\n| Rank | Company | Key Metrics |\n|------|---------|-------------|\n| 1 | **Company** | metric; metric |\n| 2 | **Company** | metric; metric |\n| 3 | **Company** | metric; metric |\n\n**Rationale:**\n- **Why this ranking:** <1 sentence on the primary differentiator between #1 and #2>\n- **Key highlight:** <1 standout metric or finding that most influenced the ranking>\n- **Also considered:** <comma-separated list of longlist companies not in top 3>\n\nRules:\n- Prefer the most recent available metric values (latest fiscal period or TTM).\n- \"Rationale\" must have exactly 3 bullet points as shown.\n- \"activity\" must be 2-4 items, 3-6 words each, present tense, no punctuation.\n- Keep whitespace minimal (no extra blank lines beyond the format above).\n- Use semicolons between metrics.\n`;
}

export function toGeminiContents(chatHistory, userMessage) {
  const contents = (chatHistory || []).map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }]
  }));
  contents.push({ role: "user", parts: [{ text: userMessage }] });
  return contents;
}

export function stripSourcesSection(text) {
  return text.replace(/\n{2,}(Sources|Source)\s*:\s*[\s\S]*$/i, "").trim();
}

export function getModelName(envModel) {
  return envModel || DEFAULT_MODEL;
}

function shouldRetryModel(err) {
  const message = err?.message || "";
  return /overloaded|unavailable|503|fetch failed|sending request|econnreset|etimedout|enotfound|network/i.test(
    message
  );
}

function chunkToText(chunk) {
  if (!chunk) return "";
  if (typeof chunk === "string") return chunk;
  if (typeof chunk.text === "function") {
    try {
      return chunk.text();
    } catch {
      return "";
    }
  }
  if (typeof chunk.text === "string") return chunk.text;
  const parts = chunk.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

export function extractJsonBlock(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export function extractLeadingJsonObject(text) {
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

function normalizeSourceUrl(value) {
  if (typeof value !== "string") return null;
  let url = value.trim();
  if (!url) return null;
  if (url.startsWith("www.")) {
    url = `https://${url}`;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

function dedupeSources(sources) {
  const seen = new Set();
  const unique = [];
  for (const source of sources) {
    const url = normalizeSourceUrl(source?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({
      title: source?.title || url,
      url
    });
  }
  return unique;
}

function extractSourcesFromText(text) {
  const raw = typeof text === "string" ? text : "";
  const candidates = [];

  const tryParse = (jsonText) => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed?.sources)) return;
      for (const entry of parsed.sources) {
        if (!entry) continue;
        candidates.push({
          title: entry.title || entry.name || entry.url || entry.uri,
          url: entry.url || entry.uri
        });
      }
    } catch {
      // ignore parse failures
    }
  };

  const leading = extractLeadingJsonObject(raw);
  if (leading) tryParse(leading.json);

  const broadJson = extractJsonBlock(raw);
  if (broadJson && broadJson !== leading?.json) tryParse(broadJson);

  // Final fallback: recover plain URLs from model text.
  const urlMatches = raw.match(/https?:\/\/[^\s)\]>"']+/gi) || [];
  for (const url of urlMatches) {
    candidates.push({ title: url, url });
  }

  return dedupeSources(candidates);
}

function readChunkSource(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  const options = [
    chunk.web,
    chunk.webSource,
    chunk.source,
    chunk.retrievedContext,
    chunk.context,
    chunk.document,
    chunk
  ];
  for (const entry of options) {
    if (!entry || typeof entry !== "object") continue;
    const url = entry.uri || entry.url || entry.link;
    const title = entry.title || entry.name || url;
    if (url) return { title, url };
  }
  return null;
}

export function extractGroundingSources(grounding) {
  if (!grounding || typeof grounding !== "object") return [];
  const chunks = Array.isArray(grounding.groundingChunks)
    ? grounding.groundingChunks
    : [];
  const fromChunks = chunks
    .map((chunk) => readChunkSource(chunk))
    .filter(Boolean);
  const fromDirect = Array.isArray(grounding.sources)
    ? grounding.sources.map((source) => ({
        title: source?.title || source?.name || source?.url || source?.uri,
        url: source?.url || source?.uri
      }))
    : [];
  return dedupeSources(fromChunks.concat(fromDirect));
}

function collectSourcesFromResponse(response) {
  const text =
    typeof response?.text === "function" ? response.text() : response?.text || "";
  const grounding = response?.candidates?.[0]?.groundingMetadata || null;
  return dedupeSources([
    ...extractSourcesFromText(text),
    ...extractGroundingSources(grounding)
  ]);
}


export function parseIntentChangeDecision(rawText) {
  const json = extractJsonBlock(rawText || "");
  let parsed = null;
  try {
    parsed = json ? JSON.parse(json) : null;
  } catch {
    parsed = null;
  }

  const action = ["refine", "replace", "unclear"].includes(parsed?.action)
    ? parsed.action
    : "unclear";
  const candidateCategory =
    typeof parsed?.candidate_category === "string"
      ? parsed.candidate_category.trim()
      : "";
  const confidenceValue = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.min(1, Math.max(0, confidenceValue))
    : 0;
  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";

  if (action === "replace" && !candidateCategory) {
    return {
      action: "unclear",
      candidateCategory: "",
      confidence: 0,
      reason: reason || "Missing replacement category."
    };
  }

  return {
    action,
    candidateCategory,
    confidence,
    reason
  };
}

export async function assessIntentChange({
  ai,
  model,
  intentAnchor,
  planText,
  planQuestions,
  userMessage,
  recentUserTurns
}) {
  const systemInstruction =
    "You are a classifier for a market research agent. Determine whether the user's latest message refines the current category or replaces it.\n\nReturn ONLY valid JSON in this exact shape:\n{\n  \"action\": \"refine\" | \"replace\" | \"unclear\",\n  \"candidate_category\": \"...\",\n  \"confidence\": 0.0,\n  \"reason\": \"short reason\"\n}\n\nRules:\n- Output only JSON, no extra text.\n- Use \"refine\" when the user is narrowing/scoping/confirming within the same category.\n- If the latest message answers or selects from the active clarifying question/options, choose \"refine\".\n- Use \"replace\" only when the user clearly switches to a different category.\n- Use \"unclear\" when there is ambiguity.\n- confidence must be between 0 and 1.\n- candidate_category should be non-empty only for replace.";
  const recentTurns = Array.isArray(recentUserTurns)
    ? recentUserTurns.filter((turn) => typeof turn === "string" && turn.trim()).slice(-5)
    : [];
  const activeQuestions = Array.isArray(planQuestions)
    ? planQuestions.filter((q) => typeof q === "string" && q.trim()).slice(0, 2)
    : [];
  const contents = [
    {
      role: "user",
      parts: [
        {
          text: `Intent anchor:\n${intentAnchor || "(none)"}\n\nPlan:\n${planText || "(none)"}\n\nActive clarifying question/options:\n${activeQuestions.join("\n") || "(none)"}\n\nRecent user turns:\n${recentTurns.join("\n") || "(none)"}\n\nLatest user message:\n${userMessage}`
        }
      ]
    }
  ];
  const response = await ai.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction,
      temperature: 0
    }
  });
  const raw = typeof response.text === "function" ? response.text() : response.text;
  return raw;
}

export async function streamMarketResponse({
  ai,
  models,
  mode,
  chatHistory,
  userMessage,
  sendToken,
  onModelFallback,
  stream = true,
  useGrounding = true
}) {
  const contents = toGeminiContents(chatHistory, userMessage);
  const systemInstruction = buildSystemInstruction(mode);

  let lastError = null;
  const tried = [];

  for (const model of models) {
    try {
      const result = await traced(
        async (span) => {
          let fullText = "";
          let finalResponse = null;
          const tools = useGrounding ? [groundingTool] : [];

          if (stream) {
            const streamResult = await ai.models.generateContentStream({
              model,
              contents,
              config: {
                systemInstruction,
                tools,
                temperature: 0.2
              }
            });

            for await (const chunk of streamResult) {
              const chunkText = chunkToText(chunk);
              if (chunkText) {
                fullText += chunkText;
                if (sendToken) sendToken(chunkText);
              }
            }

            try {
              if (streamResult?.response) {
                finalResponse =
                  typeof streamResult.response.then === "function"
                    ? await streamResult.response
                    : streamResult.response;
              }
            } catch {
              finalResponse = null;
            }
          } else {
            const response = await ai.models.generateContent({
              model,
              contents,
              config: {
                systemInstruction,
                tools,
                temperature: 0.2
              }
            });
            finalResponse = response;
            fullText =
              typeof response.text === "function" ? response.text() : response.text;
          }

          const usage = finalResponse?.usageMetadata || null;
          const grounding =
            finalResponse?.candidates?.[0]?.groundingMetadata || null;

          if (typeof span?.log === "function") {
            span.log({
              output: fullText,
              metadata: {
                model,
                token_counts: usage || null
              }
            });
          }

          return {
            text: fullText,
            usage,
            grounding,
            model
          };
        },
        {
          name: "LLM call",
          input: {
            mode,
            message: userMessage,
            chat_history: chatHistory,
            model
          }
        }
      );
      return { ...result, attempts: tried.concat(model) };
    } catch (err) {
      lastError = err;
      tried.push(model);
      if (!shouldRetryModel(err)) {
        throw err;
      }
      if (onModelFallback) onModelFallback(model, err);
    }
  }

  throw lastError;
}

function toDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function formatSourcesMarkdown(sources) {
  const parts = sources.map((source) => {
    const domain = source.domain || toDomain(source.url);
    const title = source.title || source.url;
    const label = domain ? `${title}` : title;
    return `[${label}](${source.url})`;
  });
  return `**Sources:**\n${parts.join(", ")}`;
}

async function fetchWithFallback(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal
    });
    if (head.ok) return true;
  } catch {
    // ignore
  } finally {
    clearTimeout(timeout);
  }

  const controller2 = new AbortController();
  const timeout2 = setTimeout(() => controller2.abort(), 7000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller2.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout2);
  }
}

export async function validateSources(sources) {
  const checks = await Promise.all(
    sources.map(async (source) => ({
      source,
      ok: await fetchWithFallback(source.url)
    }))
  );
  const valid = [];
  const invalid = [];
  for (const check of checks) {
    if (check.ok) valid.push(check.source);
    else invalid.push(check.source);
  }
  return { valid, invalid };
}

async function fetchSourcesWithGrounding({ ai, model, category, prompt, spanName }) {
  return traced(
    async (span) => {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          tools: [groundingTool],
          temperature: 0.2
        }
      });

      const sources = collectSourcesFromResponse(response);
      if (typeof span?.log === "function") {
        span.log({
          output: {
            count: sources.length,
            urls: sources.map((s) => s.url)
          }
        });
      }
      return sources;
    },
    { name: spanName, input: { category } }
  );
}

export async function repairSources({ ai, model, category, resultText }) {
  const prompt = `Provide 6-8 valid sources that directly support the numeric metrics in the result below. Each source must reference a specific company named in the result.\nCategory: ${category}\n\nResult:\n${resultText}\n\nReturn JSON only in this shape:\n{\n  "sources": [\n    {"title": "...", "url": "..."}\n  ]\n}\n\nRules:\n- Every source must be tied to a specific company or metric in the result.\n- Prefer primary sources (earnings releases, investor relations pages, SEC filings) and authoritative analyst sources (G2, Gartner, Forrester, IDC).\n- No generic industry overview pages.`;
  return fetchSourcesWithGrounding({ ai, model, category, prompt, spanName: "Citation repair" });
}

export async function generateSourcesForResult({ ai, model, category, resultText }) {
  const prompt = `Find 6-8 sources that directly support the companies and numeric metrics in the result below. Each source must be tied to a specific company named in the result.\n\nCategory: ${category}\n\nResult:\n${resultText}\n\nReturn JSON only in this shape:\n{\n  "sources": [\n    {"title": "...", "url": "..."}\n  ]\n}\n\nRules:\n- Every source must reference a specific company or metric from the result.\n- Prefer primary sources (company filings, investor relations, earnings releases, SEC filings) or authoritative sources (G2, Gartner, Forrester, IDC).\n- Aim for at least 2 sources per company in the result.\n- No generic industry overview pages.\n- No commentary or extra text.`;
  return fetchSourcesWithGrounding({ ai, model, category, prompt, spanName: "Citation gather" });
}

export function withDomains(sources) {
  return sources.map((source) => ({
    ...source,
    domain: source.domain || toDomain(source.url)
  }));
}
