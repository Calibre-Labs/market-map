# Prompt templates

## Data annotation app

## GOAL

Build a web application that allows human reviewers to inspect multi-turn conversational traces and record structured annotations. Focus on fast, minimal review workflow. Avoid unnecessary features.

## DATA

An example set of traces is attached.

Design the system to accept traces shaped like the example, including:
- Multi-turn conversations
- Per-turn metadata
- Optional tool information
- Braintrust span identifiers

Assume future traces will follow a similar structure.

## CORE UX

Display one trace per screen using a 3-column layout:

Left: Input (User messages and relevant context)
Center: Output (Model responses and system outputs)
Right: Feedback (A single multiline feedback text box for open-code notes)

Important: The input and output columns must support vertical scrolling so long responses do not get cut off.

### NAVIGATION

Left arrow = previous trace
Right arrow = next trace
Include small Prev/Next buttons.

Important: Hotkeys should work even when the cursor is in the feedback box.

### PROGRESS

Add a simple progress indicator at the top:
Shows how many traces are reviewed vs total.

### DISPLAY RULES

Use monospace font for code-like content when it appears in input/output (JSON-ish blocks, tool-call-like text, etc.).

Keep the layout minimal and readable.


## CLUSTERING FOR TRACE CODES

Cluster the notes in the REVIEWER_FEEDBACK field into an organized set of distinct trace codes that can be applied to new traces with independent binary (yes/no) judgments per code.

### INPUT
- A list of traces (JSON objects)
- Each trace may contain:
  - <REVIEWER_FEEDBACK> (string; may be empty)
  - turns[] (array). Use turns[].response as the trace output to quote behavior.
  - optional identifiers (session_id, tab_id, trace_id, etc.)

### INSTRUCTIONS
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
 
### CONSTRAINTS
- Use only evidence from the traces; do not invent facts.
- Prefer short, representative quotes.

### OUTPUT
Output format (Markdown):
## <Trace Code Name>
**Description:** <one sentence>

**Examples:**
1. **Annotation:** “...”
   **Output:** “...”
   **Trace:** <id(s) if present>
2. ...
