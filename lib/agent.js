import { GoogleGenAI } from "@google/genai";
import { traced } from "braintrust";

const DEFAULT_MODEL = "gemini-3-flash-preview";
const groundingTool = { googleSearch: {} };

export function createGeminiClient(apiKey) {
  return new GoogleGenAI({ apiKey });
}

export function buildSystemInstruction(mode) {
  const common = `You are a market research analyst covering software and technology.\n\nCore task:\n- Research the market category mentioned by the user.\n- Rank the top 3 players.\n- Ranking priority: revenue -> valuation -> number of customers -> number of G2 ratings.\n\nOutput rules:\n- Be concise. Use markdown with line breaks for readability.\n- Use numeric evidence for metrics.\n- Keep metrics as consistent across the 3 companies as possible.\n- If the input is empty or entirely unrelated to technology, respond with a brief apology and remind the user of your task.\n`;

  if (mode === "plan") {
    return `${common}\nPlan Mode:\n- Provide a brief plan to research the market category mentioned by the user.\n- Include the segments identified, a longlist of players, the metrics available, and your chosen ranking approach.\n- Always ask 1-2 clarifying questions to polish segment selection.\n- Each clarifying question must include at least 2 options (inline).\n- If the input is nonsense or unrelated to software/technology, return an apology instead of a plan.\n- Do NOT provide the final ranking or a 3-company table.\n\nReturn ONLY valid JSON in this exact shape:\n{\n  \"plan\": \"...\",\n  \"clarifying_questions\": [\"...\"],\n  \"ready_for_results\": true,\n  \"activity\": [\"...\"],\n  \"apology\": \"...\"\n}\n\nRules:\n- \"plan\" short sentences with a few bullet points.\n- \"clarifying_questions\" must be an array of 1-2 items unless you are apologizing in which case it's none.\n- If clarifying questions are present, set \"ready_for_results\" to false.\n- \"activity\" must be 2-4 items, 3-6 words each, present tense, no punctuation.\n- \"apology\" must be a brief apology string ONLY when the input is nonsense/unrelated; otherwise set it to an empty string.\n- Do not include any extra keys or non-JSON text.\n`;
  }

  return `${common}\nResult Mode:\n- Execute the plan. Provide exactly 3 companies.\n- Each company must include 2 metrics to support the ranking.\n- Provide a brief rationale for the ranking basis with the long list of companies considered but not chosen for the top 3.\n- Do NOT include a Sources section; the system will add it.\n\nOutput format (exactly):\n{ \"activity\": [\"...\"] }\n<blank line>\n### Category: <Category Name>\n\n| Rank | Company | Key Metrics |\n|------|---------|-------------|\n| 1 | **Company** | metric; metric |\n| 2 | **Company** | metric; metric |\n| 3 | **Company** | metric; metric |\n\n**Rationale:** <single concise sentence with exclusions inline if needed>\n\nRules:\n- \"activity\" must be 2-4 items, 3-6 words each, present tense, no punctuation.\n- Keep whitespace minimal (no extra blank lines beyond the format above).\n- Use semicolons between metrics.\n`;
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


export async function assessPlanChange({ ai, model, planText, userMessage }) {
  const systemInstruction =
    "You are a classifier for a market research agent. Decide whether the user's latest message requires revising the existing plan.\n\nReturn ONLY valid JSON in this exact shape:\n{\n  \"action\": \"keep\" | \"replan\",\n  \"reason\": \"short reason\"\n}\n\nRules:\n- Output only JSON, no extra text.\n- Choose \"keep\" if the message simply clarifies scope (persona, geo, segment) or says to proceed.\n- Choose \"replan\" if the message changes the category, segment, or ranking approach.";
  const contents = [
    {
      role: "user",
      parts: [
        {
          text: `Plan:\n${planText || "(none)"}\n\nUser message:\n${userMessage}`
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

export async function assessInputValidity({ ai, model, message }) {
  const systemInstruction =
    "You are a classifier for a market research agent. Determine if the user input is a valid software/technology market category.\n\nReturn ONLY valid JSON in this exact shape:\n{\n  \"valid\": true|false,\n  \"reason\": \"short reason\"\n}\n\nRules:\n- Output only JSON, no extra text.\n- valid=true if the input is a software/technology market category or clearly related.\n- valid=false if it is nonsense, unrelated, or non-technical.";
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: message || "" }] }],
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

export function extractSources(grounding) {
  if (!grounding || !Array.isArray(grounding.groundingChunks)) return [];
  const seen = new Set();
  const sources = [];
  for (const chunk of grounding.groundingChunks) {
    const web = chunk.web || chunk.webSource || chunk.source;
    const url = web?.uri || web?.url;
    const title = web?.title || web?.name;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: title || url, url });
  }
  return sources;
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
  return `**Sources:** ${parts.join(", ")}`;
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
  const valid = [];
  const invalid = [];
  for (const source of sources) {
    const ok = await fetchWithFallback(source.url);
    if (ok) valid.push(source);
    else invalid.push(source);
  }
  return { valid, invalid };
}

export async function repairSources({
  ai,
  model,
  category
}) {
  return traced(
    async (span) => {
      const prompt = `Provide 4 valid sources with the latest numeric metrics for top companies cited in the category: ${category}.\nReturn JSON only in this shape:\n{\n  "sources": [\n    {"title": "...", "url": "..."}\n  ]\n}`;

      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          tools: [groundingTool],
          temperature: 0.2
        }
      });

      const text =
        typeof response.text === "function" ? response.text() : response.text;
      const jsonBlock = extractJsonBlock(text || "");
      if (!jsonBlock) return [];
      const parsed = JSON.parse(jsonBlock);
      if (!parsed?.sources || !Array.isArray(parsed.sources)) return [];
      const sources = parsed.sources
        .filter((s) => s && s.url)
        .map((s) => ({
          title: s.title || s.url,
          url: s.url
        }));
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
    {
      name: "Citation repair",
      input: { category }
    }
  );
}

export function withDomains(sources) {
  return sources.map((source) => ({
    ...source,
    domain: source.domain || toDomain(source.url)
  }));
}
