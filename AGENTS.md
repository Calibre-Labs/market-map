# AGENTS.md — Market Map

This file captures what went wrong in our Braintrust logging integration and the generalized best practices to avoid those failures in future agents.

## Corrections We Made (Root Causes → Fixes)
- Version mismatch: the Braintrust SDK version in `package.json` did not exist on npm and caused install errors. We updated to the latest stable SDK line.
- Invalid span encoding: `span.export()` was treated as a string, but it is async in the current SDK. We awaited it to avoid encoding invalid parent strings.
- Broken parent references: we passed span objects into `parent`, which expects a serialized export string. We removed explicit `parent` in nested spans and relied on context.
- Trace fragmentation: per-turn spans became separate traces because we used encoded parent strings across requests. We switched to `parentSpanIds` using `rootSpanId` + `spanId` stored in SQLite.
- Stale root spans: existing sessions had invalid parent data. We added a repair path and then fully reset the SQLite file to start clean.
- Missing content in Braintrust: only metadata was logged. We now log `input` and `output` on each turn span, plus LLM output for the LLM call span.
- Streaming response parsing: SDK stream chunk shape varied, causing `chunk.text()` errors. We added a robust chunk-to-text parser and guarded `stream.response`.

## Braintrust Trace Logging Best Practices (Generalized)
### 1) Version and Encoding Safety
- Keep all services on the same Braintrust SDK major/minor version.
- Treat `span.export()` as async; always `await` it.
- Never pass span objects into `parent`. `parent` expects a serialized span string.

### 2) Parentage Across Requests
- For multi-turn sessions, store `rootSpanId` and `spanId` in persistent storage.
- Use `parentSpanIds: { rootSpanId, spanId }` when creating per-turn spans across requests.
- Avoid using serialized span strings across long-lived sessions unless you fully control encoding and versioning.

### 3) Root Trace Lifecycle
- Create one root trace per conversation session.
- End the session when results are generated.
- On new user input after completion, start a new root trace.

### 4) Always Log Inputs + Outputs
- Log `input` on every turn span: include current message + full chat history.
- Log `output` on every turn span: store the final response text.
- Log LLM outputs on LLM spans for visibility into model behavior.

### 5) Minimal, Useful Metadata
- Always include `turn_number`, `mode`, `model`, `latency_ms`, `llm_latency_ms`.
- Include `token_counts` when available.
- Add `username` (or user id) so traces can be filtered by user.

### 6) Streaming-First Robustness
- Handle multiple stream chunk shapes: `chunk.text()`, `chunk.text`, and `chunk.candidates`.
- Guard `stream.response` and usage metadata (it may be missing).
- Treat network, rate limit, and overload errors explicitly and retry with fallbacks.

### 7) Error Surfaces
- Send actionable error messages to the client (e.g., missing API key, model overload).
- Log the error stack server-side for debugging.

## Other Core Principles
- Simplicity: prefer a minimal implementation with clear data flow and few moving parts.
- Deterministic sessioning: session boundaries must be explicit and enforced.
- Single source of truth: keep session state in one place (SQLite) and keep it small.
- Observability by default: if it’s not logged, it’s not debuggable.
- Defensive coding: treat external SDKs as unreliable at edges; guard every optional field.
- Replace, don’t patch: if a session’s trace state is corrupted, regenerate or reset it.
- Change control: do not introduce new code or behavioral changes without explicit approval.
