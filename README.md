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
- `GEMINI_MODEL` (default: `gemini-2.5-flash`)
- `GEMINI_FALLBACK_MODELS` (comma-separated, default: `gemini-2.5-flash, gemini-2.5-flash-lite`)
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
- The UI streams plan activity and citation checks as status messages.
- If the primary model is overloaded (503/UNAVAILABLE), the server retries with fallback models.
- Braintrust logging auto-disables after repeated flush errors to avoid noisy failures.

## File Map
- `server.js` — Express server, sessions, SSE, Braintrust integration
- `lib/db.js` — SQLite schema + persistence helpers
- `lib/agent.js` — Gemini calls, grounding, citations, validation
- `lib/username.js` — username rules + plan confirmation helpers
- `public/` — static UI (signup, chat, profile)
