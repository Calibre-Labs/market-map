# AI PRD: Market Map Agent (v2.0)

**Owner:** [Name]  | **Status:** Active Development  | **Default Model:** Gemini 3.1 Flash Lite

## 1. Problem & Business Value

Teams doing fast market scans spend significant time manually collecting company metrics and source links before they can compare top players.

**Proposed solution:** A multi-turn AI agent that takes a software/technology market category, asks one clarifying question, then returns a ranked top 3 with supporting sources and a downloadable trace.

## 2. Prompt Logic & Dataset

### System Instruction (Summary)

You are a market research analyst for software and technology categories. 
- First provide a concise plan and one clarifying question. 
- Then provide exactly 3 ranked companies with numeric evidence and sources. 
- If input is empty or non-technical, return a brief apology and redirect.

### Golden Dataset

Link to 50 prompt evaluation set across 5 different user intents
* Top companies in known category
* Companies that compete with a specific product
* Metrics for a set of known companies
* Companies that have an attribute in common 
* Vague entries that are not technology

### Graceful Failure

- If input is unrelated to software/technology, return apology mode (no fabricated ranking).
- If source validation fails, return result with explicit source fallback label.
- If model is overloaded/unavailable, retry with configured fallback models.

## 3. Tool Specification

The agent should use the following existing tools determinsitically:

| Tool Name | Action | Input Param | Purpose |
| --- | --- | --- | --- |
| `Plan_Change_Assessment` | Evaluate whether user changed market intent | `current_message`, `intent_origin`, `intent_anchor`, `chat_history` | Decide whether to keep current plan, auto-shift intent, or ask for confirmation. |
| `Source_Validate` | HTTP `HEAD` / `GET` checks | `sources[]` | Filter broken citations before final output. |
| `Source_Repair` | Regenerate citation candidates | `category`, `result_text` | Replace invalid or missing sources. |


## 4. Evaluation Criteria

| Metric | Target | Why It Matters |
| --- | --- | --- |
| Top-3 Format Compliance | 100% | Output must be consistent and comparable. |
| Source Validity Rate | > 90% | Users must trust links behind numeric claims. |
| Plan Question Compliance | 100% | Plan mode must ask exactly one clarifying question. |
| End-to-End Success Rate | > 100% | Valid prompts should complete plan -> result without failure. |
| Time to First Token | < 2.5s median (local target) | Must feel faster than manual research setup. |

Note: generic tone/helpfulness scoring is secondary to structure, metrics, and citation quality.

## 5. Edge Cases Handling

- **Non-technical input:** immediately return apology mode and steer user to valid categories.
- **Empty input:** return short apology guidance, no ranking.
- **Intent shift mid-session:** detect likely category change and require user confirmation when confidence is low.
- **Broken citations:** run validation and repair pass before emitting final source list.
- **Model overload / 503:** retry across fallback model order.
- **Stale active sessions:** auto-close after idle timeout sweep to prevent state drift.

## 6. Prototype & Early Findings

**Internal Demo:** Link 

**Early findings:**
- It struggles to rank business units within large public companies that don't report results
- It doesn't always fetch the most fresh metrics and sources, citation URLs have high failure rates
- It doesn't understand casual terms of art like ai-native  

## 7. Technical Constraints

- **Data/privacy:** app stores username cookie and chat/trace content in SQLite; scrub unnecessary PII in prompts.
- **Cost/latency:** default to Gemini 3.1 Flash Lite; use limited fallback model chain to bound response time and spend.
