---
name: dashboard-data-hygiene
description: Maintain OpenClaw dashboard data quality and presentation consistency. Use when updating session ingestion/display, token aggregation, query sanitization, or agent overview card rendering (style, insight, and emoji defaults).
---

# Dashboard Data Hygiene

## Enforce Session Visibility Rules

- Exclude sessions with no token activity (`total_tokens`, `input_tokens`, and `output_tokens` all zero) from dashboard displays.
- Apply the same rule in ingestion and read paths so historical and fresh data stay consistent.
- Keep session retention at 90 days for session-level detail; preserve long-term token aggregates in daily buckets.

## Sanitize Input Query Text

- Remove transport metadata before display, including:
- `Conversation info (untrusted metadata)` wrappers.
- Metadata-only fenced blocks (for example blocks containing `conversation_label`, channel/session/time keys).
- Timestamp/channel prefixes such as `[Wed 2026-02-18 13:39 GMT+8]`.
- Normalize whitespace and truncate safely for table display.
- Prefer user intent text after metadata preambles (for example keep the content starting from meaningful text such as `没错...`).

## Keep Agent Core Block Consistent

- Make the highlighted core block default to `Style` first (fallback to summary only when style is unavailable).
- Show `感悟` as a second line only when it is materially different from the style/summary line.
- Attach an insight emoji by heuristic from latest insight text, and fall back to `✨` when no stronger signal exists.
- Limit visual changes to the core block area unless the user asks for broader UI updates.

## Implementation Checklist

- Update backend normalization first, then verify frontend rendering.
- Re-run ingestion/refresh to ensure cleaned queries overwrite stale text.
- Manually verify:
- No zero-token sessions in Overview/Sessions tables.
- Query text no longer contains metadata wrappers.
- Agent core labels render with emoji and remain readable at narrow widths.
