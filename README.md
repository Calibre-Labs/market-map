# Market Map

A minimal multi-turn market research agent with a signup flow, Claude-like chat UI, Gemini API, Braintrust logging, and downloadable session traces.

**What it does**
- Sign up with a unique username (3 random digits appended).
- Chat in Plan Mode, then Result Mode with exactly 3 companies + metrics.
- Streams agent activity (plan steps, citation checks) in the chat.
- Starts a new session after each result and keeps the last 50 sessions.
- Public profile page with JSON trace downloads.

## Task Checklist
- [x] Scaffold Node.js server + static UI
- [x] Add SQLite persistence (users + sessions)
- [x] Unique usernames with 3-digit suffix + cookies
- [x] Session lifecycle + Braintrust tracing (root per session, spans per turn)
- [x] Gemini API integration (Plan/Result) + grounding
- [x] Citation validation + replacement flow
- [x] SSE streaming pipeline + UI handling
- [x] Signup, chat (Claude-like), and public profile UI
- [x] README with reproducible steps

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
- `GEMINI_MODEL` (default: `gemini-2.5-flash`)
- `GEMINI_FALLBACK_MODELS` (comma-separated, default: `gemini-2.5-flash,gemini-2.5-flash-lite`)
- `FRONTEND_ORIGIN` (comma-separated allowed origins for split-domain deploys)
- `COOKIE_DOMAIN` (shared cookie domain for split-domain deploys)
- `BRAINTRUST_PROJECT` (default: `market-map`)
- `BRAINTRUST_ERROR_WINDOW_MS` (default: `60000`)
- `BRAINTRUST_ERROR_THRESHOLD` (default: `3`)
- `SQLITE_PATH` (default: `./data/market-map.sqlite`)

Local note:
- For `localhost`, leave `COOKIE_DOMAIN` blank (or delete the line) so cookies persist.
- `FRONTEND_ORIGIN` can be left blank for same-origin local dev. If you run a separate frontend, set it to `http://localhost:3000`.

### 3) Run
```bash
npm run dev
```
Open `http://localhost:3000`.

### 4) Tests
```bash
npm test
```

## Railway Deploy (with SQLite Volume) after local tests pass

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
- Only the most recent 50 sessions per user are retained.

### Traces
- Each session stores a JSON trace with all turns, responses, and sources.
- Download traces from the public profile page: `/u/:username`.

### Braintrust Logging
- One root trace per session.
- One span per turn, including:
  - `chat_history` + current input
  - metadata: `turn_number`, `latency_ms`, `token_counts`, `model`
- Nested spans for:
  - LLM call
  - Citation checks + repairs

## Notes
- Citations are validated with `HEAD` / `GET` and replaced if invalid.
- If grounding doesn’t return enough sources, the system triggers a citation repair call.
- The UI streams plan activity and citation checks as status messages.
- If the primary model is overloaded (503/UNAVAILABLE), the server retries with fallback models.
- Braintrust logging auto-disables after repeated flush errors to avoid noisy failures.

## File Map
- `server.js` — Express server, sessions, SSE, Braintrust integration
- `lib/db.js` — SQLite schema + persistence helpers
- `lib/agent.js` — Gemini calls, grounding, citations, validation
- `lib/username.js` — username rules + plan confirmation helpers
- `public/` — static UI (signup, chat, profile)
