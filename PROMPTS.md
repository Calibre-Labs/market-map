# Prompt Templates (Unified)

This file combines the previous `PROMPTS.md` and `data/llm-prompts.md` content.

## Section 1: Annotation and Review Prompts

### 1.1 Data annotation app

#### GOAL

Build a web application that allows human reviewers to inspect multi-turn conversational traces and record structured annotations. Focus on fast, minimal review workflow. Avoid unnecessary features.

#### DATA

An example set of traces is attached.

Design the system to accept traces shaped like the example, including:
- Multi-turn conversations
- Per-turn metadata
- Optional tool information
- Braintrust span identifiers

Assume future traces will follow a similar structure.

#### CORE UX

Display one trace per screen using a 3-column layout:

Left: Input (User messages and relevant context)
Center: Output (Model responses and system outputs)
Right: Feedback (A single multiline feedback text box for open-code notes)

Important: The input and output columns must support vertical scrolling so long responses do not get cut off.

##### NAVIGATION

Left arrow = previous trace
Right arrow = next trace
Include small Prev/Next buttons.

Important: Hotkeys should work even when the cursor is in the feedback box.

##### PROGRESS

Add a simple progress indicator at the top:
Shows how many traces are reviewed vs total.

##### DISPLAY RULES

Use monospace font for code-like content when it appears in input/output (JSON-ish blocks, tool-call-like text, etc.).

Keep the layout minimal and readable.

### 1.2 Trace Code Clustering

Cluster the notes in the REVIEWER_FEEDBACK field into an organized set of distinct trace codes that can be applied to new traces with independent binary (yes/no) judgments per code.

#### INPUT
- A list of traces (JSON objects)
- Each trace may contain:
  - <REVIEWER_FEEDBACK> (string; may be empty)
  - turns[] (array). Use turns[].response as the trace output to quote behavior.
  - optional identifiers (session_id, tab_id, trace_id, etc.)

#### INSTRUCTIONS
- Only cluster non-empty REVIEWER_FEEDBACK. Ignore empty strings.
- Normalize feedback into atomic issues (split multi-issue feedback into separate bullets when needed).
- Create a set of trace codes (categories). Each trace code must be independently applicable (multi-label).

For each trace code, provide:
- **Name** (short, descriptive)
- **Description** (one sentence)
- **Examples** (1–3), ideally at least 2 unless it appears only once:
  - Include a short quote from REVIEWER_FEEDBACK
  - Include a short quote from the relevant turns[].response showing the behavior
  - Include any available trace identifier(s) (e.g., session_id, tab_id) if present

#### CONSTRAINTS
- Use only evidence from the traces; do not invent facts.
- Prefer short, representative quotes.

#### OUTPUT
Output format (Markdown):
## <Trace Code Name>
**Description:** <one sentence>

**Examples:**
1. **Annotation:** “...”
   **Output:** “...”
   **Trace:** <id(s) if present>
2. ...

## Section 2: Market Map LLM Prompts and State Machine

This section is synced to the current implementation in:
- `lib/agent.js`
- `lib/fsm.js`
- `server.js`

### 2.1 Prompt Catalog

#### 2.1.1 `buildSystemInstruction(mode)` common instruction

```text
You are a market research analyst covering software and technology.
Current date: {{today}}

Core task:
- Research the market category mentioned by the user.
- Rank the top 3 players.
- Ranking priority: revenue -> valuation -> number of customers -> number of G2 ratings.

Output rules:
- Be concise. Use markdown with line breaks for readability.
- Use fresh numeric evidence for metrics, ideally from the last 12 months.
- Keep metrics as consistent across the 3 companies as possible.
- If the input is empty or entirely unrelated to technology, respond with a brief apology and remind the user of your task.
```

#### 2.1.2 Plan mode suffix

```text
Plan Mode:
- Provide a specific plan to research the market category mentioned by the user.
- Identify candidate segments and a concrete longlist of likely players based on fresh metrics ideally fro the last 12 months.
- Select only the most useful metrics for this category and explain why each is appropriate.
- Do NOT blindly list all ranking-priority metrics unless they are all clearly appropriate and available.
- Always ask exactly 1 clarifying question to polish segment selection.
- The clarifying question must include at least 2 options (inline).
- If the input is nonsense or unrelated to software/technology, return an apology instead of a plan.
- Do NOT provide the final ranking or a 3-company table.

Return ONLY valid JSON in this exact shape:
{
  "plan_overview": "...",
  "segments": ["..."],
  "longlist_players": ["..."],
  "selected_metrics": [
    {"name": "...", "why": "..."}
  ],
  "clarifying_questions": ["..."],
  "ready_for_results": true,
  "activity": ["..."],
  "apology": "..."
}

Rules:
- "plan_overview" short sentences with no extra blank lines.
- "segments" must contain 2-5 items unless you are apologizing.
- "longlist_players" must contain 5-8 companies unless you are apologizing.
- "selected_metrics" must contain 2-3 items unless you are apologizing.
- Each metric object must include non-empty "name" and "why"; keep "why" to one concise phrase (about 6-12 words).
- "clarifying_questions" must be an array of exactly 1 item unless you are apologizing in which case it's none.
- If a clarifying question is present, set "ready_for_results" to false.
- "activity" must be 2-4 items, 3-6 words each, present tense, no punctuation.
- "apology" must be a brief apology string ONLY when the input is nonsense/unrelated; otherwise set it to an empty string.
- Do not include any extra keys or non-JSON text.
```

#### 2.1.3 Result mode suffix

```text
Result Mode:
- Execute the plan. Provide exactly 3 companies.
- Each company must include 2 metrics to support the ranking.
- Provide a brief rationale for the ranking basis with the longlist of companies considered but not chosen for the top 3.
- Do NOT include a Sources section; the system will add it.

Output format (exactly):
{ "activity": ["..."] }
<blank line>
### Category: <Category Name>

| Rank | Company | Key Metrics |
|------|---------|-------------|
| 1 | **Company** | metric; metric |
| 2 | **Company** | metric; metric |
| 3 | **Company** | metric; metric |

**Rationale:** <single concise sentence with exclusions inline if needed>

Rules:
- Prefer the most recent available metric values (latest fiscal period or TTM).
- "activity" must be 2-4 items, 3-6 words each, present tense, no punctuation.
- Keep whitespace minimal (no extra blank lines beyond the format above).
- Use semicolons between metrics.
```

#### 2.1.4 Intent change classifier (`assessIntentChange`)

System instruction:

```text
You are a classifier for a market research agent. Determine whether the user's latest message refines the current category or replaces it.

Return ONLY valid JSON in this exact shape:
{
  "action": "refine" | "replace" | "unclear",
  "candidate_category": "...",
  "confidence": 0.0,
  "reason": "short reason"
}

Rules:
- Output only JSON, no extra text.
- Use "refine" when the user is narrowing/scoping/confirming within the same category.
- If the latest message answers or selects from the active clarifying question/options, choose "refine".
- Use "replace" only when the user clearly switches to a different category.
- Use "unclear" when there is ambiguity.
- confidence must be between 0 and 1.
- candidate_category should be non-empty only for replace.
```

User content template:

```text
Intent anchor:
${intentAnchor || "(none)"}

Plan:
${planText || "(none)"}

Active clarifying question/options:
${activeQuestions.join("\n") || "(none)"}

Recent user turns:
${recentTurns.join("\n") || "(none)"}

Latest user message:
${userMessage}
```

#### 2.1.5 Input validity classifier (`assessInputValidity`)

```text
You are a classifier for a market research agent. Determine if the user input is a valid software/technology market category.

Return ONLY valid JSON in this exact shape:
{
  "valid": true|false,
  "reason": "short reason"
}

Rules:
- Output only JSON, no extra text.
- valid=true if the input is a software/technology market category or clearly related.
- valid=false if it is nonsense, unrelated, or non-technical.
```

#### 2.1.6 Citation prompts

`repairSources` prompt:

```text
Provide 4 valid sources that directly support the numeric metrics in the result below.
Category: ${category}

Result:
${resultText}

Return JSON only in this shape:
{
  "sources": [
    {"title": "...", "url": "..."}
  ]
}
```

`generateSourcesForResult` prompt:

```text
Find 3-5 sources that directly support the numeric metrics in the result below. Prefer primary sources (company filings, investor relations, earnings releases) or authoritative sources (G2, Gartner, Forrester) that mention the numbers.

Category: ${category}

Result:
${resultText}

Return JSON only in this shape:
{
  "sources": [
    {"title": "...", "url": "..."}
  ]
}

Rules:
- Only include sources that support the specific metrics shown.
- No commentary or extra text.
```

### 2.2 Runtime Stage Pipeline and Data Handoff

#### Stage A: Session load and mode selection
- Inputs:
  - persisted session (`status`, `phase`, `plan_status`, `plan_text`, `plan_questions`, intent fields)
  - `chat_history`
  - new user message
- Logic:
  - derive state via `deriveSessionState(session)`
  - `initialMode = result` only when FSM state is `RESULT`; otherwise `plan`
  - `hasPendingPlan = true` only when state is `AWAITING_CLARIFICATION` or `AWAITING_INTENT_CONFIRMATION` and `plan_text` exists
- Outputs to next stage:
  - `initialMode`
  - `hasPendingPlan`
  - `intentOrigin`, `intentAnchor`, `intentCandidate`, `intentChangeStatus`

#### Stage B: Pending-plan intent handling (only when `initialMode=plan` and `hasPendingPlan=true`)
- Inputs:
  - user message
  - stored plan text/questions
  - current intent anchor/candidate
- Logic branches:
  - if pending candidate already exists:
    - affirmative user message => accept replace and continue plan flow with new anchor
    - negative user message => reject replace and switch to `effectiveMode=result`
    - otherwise => emit confirmation prompt and return early
  - if no pending candidate:
    - call `assessIntentChange`
    - `replace` with confidence >= `INTENT_REPLACE_CONFIDENCE` (default `0.8`) => accept replace
    - `replace` with confidence >= `INTENT_CONFIRM_CONFIDENCE` (default `0.45`) => ask confirmation and return early
    - else => treat as refine, switch to `effectiveMode=result`
- Outputs to next stage:
  - `effectiveMode`
  - updated intent fields
  - possible immediate confirmation response (short-circuit)

#### Stage C: Plan generation (`initialMode=plan` and `effectiveMode=plan`)
- Inputs:
  - prompt mode `plan`
  - `chatHistory`
  - wrapped user message:

```text
Category anchor: ${nextIntentAnchor}

User message:
${planInputMessage}
```

- Parsing/validation:
  - parse JSON block
  - normalize and dedupe lists
  - validate contract:
    - `plan_overview`: required
    - `segments`: 2-5
    - `longlist_players`: 5-8
    - `selected_metrics`: 2-3
    - `clarifying_questions`: exactly 1
  - one retry if invalid
  - if still invalid => fallback apology
- Outputs to next stage:
  - `planText` (canonical stored text used later for results)
  - `planQuestions` (exactly one question)
  - rendered plan response (`### Plan` + overview + focus metrics + clarification)
  - `effectiveMode=plan`

#### Stage D: Result generation (`effectiveMode=result`)
- Inputs:
  - mode `result`
  - if available, `session.plan_text` (or newly produced plan text)
  - result prompt wrapper:

```text
Use this plan context while producing the final market result:
${planText}

Category anchor:
${nextIntentAnchor || "(none)"}

User clarification:
${message}
```

  - fallback wrapper (no plan text):

```text
Category anchor:
${nextIntentAnchor || "(none)"}

User request:
${message}
```

- Parsing:
  - parse leading activity JSON + cleaned markdown body
  - retry once if body is empty/format-only
- Outputs to next stage:
  - cleaned result markdown
  - activity steps
  - usage/model metadata

#### Stage E: Citations
- Inputs:
  - result text + category
- Logic:
  - gather sources via `generateSourcesForResult`
  - validate URLs (`HEAD` then `GET` fallback)
  - if none valid, attempt `repairSources`
  - attach markdown sources footer
- Outputs:
  - final assistant response with `Sources`
  - citation report (`valid`, `invalid`)

#### Stage F: Persistence and FSM reducer
- Inputs:
  - `turnResult` from stages above
  - next chat history and trace
- Reducer (`reduceSessionAfterTurn`) decides event:
  - `RESULT_READY` when `effectiveMode=result`
  - `PLAN_RESET` when `skipPlanPersist=true` (apology/reset path)
  - `PLAN_READY` otherwise
- Outputs:
  - persisted session updates
  - transition tuple `{from, event, to}`

### 2.3 Explicit Session FSM

Defined states (`SESSION_FSM_STATES`):
- `NEW`
- `PLAN_DRAFT`
- `AWAITING_CLARIFICATION`
- `AWAITING_INTENT_CONFIRMATION`
- `RESULT`
- `COMPLETE`

#### 2.3.1 Derived state mapping (`deriveSessionState`)
- `status=complete` => `COMPLETE`
- `status!=active` => `NEW`
- `phase=result` => `RESULT`
- `phase!=plan` => `NEW`
- `phase=plan` and `plan_status=awaiting_clarification` and `intent_change_status=pending` => `AWAITING_INTENT_CONFIRMATION`
- `phase=plan` and `plan_status=awaiting_clarification` => `AWAITING_CLARIFICATION`
- else => `PLAN_DRAFT`

#### 2.3.2 Reducer events and target states
- `RESULT_READY` => expected `COMPLETE`
- `PLAN_RESET` => expected `PLAN_DRAFT`
- `PLAN_READY` + `intent_change_status=pending` => expected `AWAITING_INTENT_CONFIRMATION`
- `PLAN_READY` + otherwise => expected `AWAITING_CLARIFICATION`

If computed `to` state does not match the expected target, reducer throws.

#### 2.3.3 Invariants (`validateSessionInvariants`)
- If `status=complete`:
  - `phase` must be `result`
  - `plan_status` must be `executed`
- If `plan_status=awaiting_clarification`:
  - `phase` must be `plan`
  - `plan_text` must be non-empty
- If `intent_change_status=pending`:
  - `plan_status` must be `awaiting_clarification`
  - `intent_candidate` must be non-empty

### 2.4 Stage Output -> Next Stage Input (Quick Map)

- Session state -> mode routing:
  - `deriveSessionState(session)` -> `initialMode`, `hasPendingPlan`
- Intent classifier output -> routing/action:
  - `{action, candidate_category, confidence}` -> `effectiveMode`, pending-confirmation prompt, or anchor replacement
- Plan JSON -> result context:
  - normalized/validated plan -> stored `plan_text` + `plan_questions`
  - stored `plan_text` is injected into next result prompt
- Result markdown -> citation stage:
  - cleaned result text -> source generation/repair/validation
- Turn result -> reducer event:
  - `effectiveMode` and `skipPlanPersist` -> `RESULT_READY` / `PLAN_READY` / `PLAN_RESET`
- Reducer updates -> next turn behavior:
  - persisted `status/phase/plan_status/intent_*` -> next `deriveSessionState()`
