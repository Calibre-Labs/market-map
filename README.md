# Market Map

A minimal multi-turn market research agent with a signup flow, chat UI, Gemini API, Braintrust logging, and downloadable session traces.

**What it does**
- Sign up with a unique username (3 random digits appended).
- Chat in Plan Mode, then Result Mode with exactly 3 top companies ranked + metrics.
- Streams agent activity (plan steps, citation checks) in the chat.
- Starts a new session after each result is shared and keeps the last 50 sessions.
- Public profile page with JSON trace downloads.


## Local Setup

### 1) Install dependencies
```bash
npm install
```

### 2) Configure environment
```bash
cp .env.example .env
```

Fill in:
- `GEMINI_API_KEY`
- `BRAINTRUST_API_KEY`

Optional:
- `GEMINI_MODEL` (default: `gemini-3.1-flash-lite-preview`)
- `GEMINI_FALLBACK_MODELS` (comma-separated, default: `gemini-3.1-flash-lite-preview, gemini-2.5-flash`)
- `FRONTEND_ORIGIN` (comma-separated allowed origins for split-domain deploys)
- `COOKIE_DOMAIN` (shared cookie domain for split-domain deploys)
- `BRAINTRUST_PROJECT` (default: `market-map`)
- `SQLITE_PATH` (default: `./data/market-map.sqlite`)


Local note:
- For `localhost`, leave `COOKIE_DOMAIN` blank (or delete the line) so cookies persist.
- `FRONTEND_ORIGIN` can be left blank as well. These are only useful for online deployments

### 3) Run
```bash
npm run dev
```
Open `http://localhost:3000`.

### 4) Tests
```bash
npm test
```

## Railway Deploy (with SQLite Volume) if you want to deploy the app online yourself

1. Create a Railway project and service for this repo.
2. Add a **Volume** mounted at `/app/data`.
3. Set environment variables in Railway:
   - `GEMINI_API_KEY`
   - `BRAINTRUST_API_KEY`
   - `BRAINTRUST_PROJECT` (optional)
   - `GEMINI_MODEL` (optional)
   - `SQLITE_PATH=/app/data/market-map.sqlite`
4. Deploy with start command:
   - `npm run start`
5. Set Railway health check path to:
   - `/healthz`

The volume preserves users + traces across deploys.

## App Behavior

### Signup
- User enters a base name.
- The system normalizes it and appends three digits (e.g., `atlas123`).
- Usernames are **case-insensitive** and unique in SQLite.
- Username is stored in a cookie (`mm_user`).

### Sessions
- Each session has one SQLite row and one JSON trace blob.
- A session ends after Result Mode is generated.
- The next user message starts a new session (new root trace).
- Sessions are isolated per browser tab (`tab_id`) so opening a new tab starts a separate active session.
- Only the most recent 50 sessions per user are retained.
- Sessions store immutable `intent_origin` (first category) and mutable `intent_anchor` (current focus).

### Traces
- Each session stores a JSON trace with all turns, responses, and sources.
- Download traces from the public profile page: `/u/:username`.

### Braintrust Logging
- One root trace per session.
- One span per turn, including:
  - `chat_history` + current input
  - metadata: `turn_number`, `latency_ms`, `token_counts`, `model`
  - intent metadata: anchor/candidate/decision/confidence
- Nested spans for:
  - LLM call
  - Citation checks + repairs

## Runtime Stage Pipeline and Session FSM

This section is synced to the current implementation in:
- `lib/agent.js`
- `lib/fsm.js`
- `server.js`

### Runtime Stage Pipeline and Data Handoff

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

### Explicit Session FSM

Defined states (`SESSION_FSM_STATES`):
- `NEW`
- `PLAN_DRAFT`
- `AWAITING_CLARIFICATION`
- `AWAITING_INTENT_CONFIRMATION`
- `RESULT`
- `COMPLETE`

#### Derived state mapping (`deriveSessionState`)
- `status=complete` => `COMPLETE`
- `status!=active` => `NEW`
- `phase=result` => `RESULT`
- `phase!=plan` => `NEW`
- `phase=plan` and `plan_status=awaiting_clarification` and `intent_change_status=pending` => `AWAITING_INTENT_CONFIRMATION`
- `phase=plan` and `plan_status=awaiting_clarification` => `AWAITING_CLARIFICATION`
- else => `PLAN_DRAFT`

#### Reducer events and target states
- `RESULT_READY` => expected `COMPLETE`
- `PLAN_RESET` => expected `PLAN_DRAFT`
- `PLAN_READY` + `intent_change_status=pending` => expected `AWAITING_INTENT_CONFIRMATION`
- `PLAN_READY` + otherwise => expected `AWAITING_CLARIFICATION`

If computed `to` state does not match the expected target, reducer throws.

#### Invariants (`validateSessionInvariants`)
- If `status=complete`:
  - `phase` must be `result`
  - `plan_status` must be `executed`
- If `plan_status=awaiting_clarification`:
  - `phase` must be `plan`
  - `plan_text` must be non-empty
- If `intent_change_status=pending`:
  - `plan_status` must be `awaiting_clarification`
  - `intent_candidate` must be non-empty

### Stage Output -> Next Stage Input (Quick Map)

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

## Notes
- Citations are validated with `HEAD` / `GET` and replaced if invalid.
- The UI streams plan activity and citation checks as status messages.
- If the primary model is overloaded (503/UNAVAILABLE), the server retries with fallback models.
- Braintrust logging auto-disables after repeated flush errors to avoid noisy failures.

## File Map
- `server.js` — Express server, sessions, SSE, Braintrust integration
- `lib/db.js` — SQLite schema + persistence helpers
- `lib/agent.js` — Gemini calls, grounding, citations, validation
- `lib/username.js` — username rules + plan confirmation helpers
- `public/` — static UI (signup, chat, profile)
