---
name: integrations-openai-ai-server lib template quirks
description: Gotchas when copying the OpenAI AI integration template lib into an api-server package
---

The `lib/integrations-openai-ai-server/` template (copied via the ai-integrations-openai skill)
ships with a strict-mode type error: `response.data[0]` in `src/image/client.ts` must be
`response.data?.[0]` (the OpenAI images response types `data` as optional). Until fixed, the whole
lib fails to build, which cascades into `typecheck:libs` failing.

**Why:** the template predates a stricter OpenAI SDK typing; the repo runs `tsc --build` across all
libs, so one lib error blocks every consumer.

**How to apply:** after copying the template and wiring tsconfig references, run
`pnpm exec tsc -b lib/integrations-openai-ai-server --force`; patch any `response.data[0]` →
`response.data?.[0]` before expecting `typecheck:libs` to pass.

gpt-5 family (e.g. `gpt-5-mini`) chat.completions calls use `max_completion_tokens` (not
`max_tokens`) and reject a custom `temperature`; `response_format: { type: "json_object" }` works
for structured extraction.
