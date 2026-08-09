# AI providers

The Studio defaults to a deterministic mock provider. Real generation is an explicit server-side opt-in through one OpenAI-compatible Chat Completions adapter; OpenAI and DeepSeek are configuration profiles, not separate implementations.

## Configure

Copy `.env.example` to `.env`, edit it locally, and run `npm run studio`. The Studio uses Node's built-in env-file loader. `.env` and its variants are git-ignored; `.env.example` is the credential-free template.

| Variable        | Meaning                                                              | Default          |
| --------------- | -------------------------------------------------------------------- | ---------------- |
| `AI_PROVIDER`   | `mock` or `openai-compatible`                                        | `mock`           |
| `AI_VENDOR`     | `openai` or `deepseek` when real mode is enabled                     | `openai`         |
| `AI_BASE_URL`   | Optional absolute HTTP(S) compatible base URL, without query or auth | Profile base URL |
| `AI_API_KEY`    | Required only for real mode                                          | none             |
| `AI_MODEL`      | Required explicit provider model identifier in real mode             | none             |
| `AI_TIMEOUT_MS` | Positive integer request timeout                                     | `60000`          |
| `STUDIO_PORT`   | Optional local Studio port                                           | `4322`           |

No model is hard-coded as universally available. Choose an identifier enabled for the provider account and verify it against that provider's current documentation.

### Offline mock

```env
AI_PROVIDER=mock
```

The mock is deterministic, needs no Internet or credential, and supports outline, final-guide, single-recommendation, divergent opportunity-candidate generation, and convergent opportunity evaluation. Opportunity fixtures combine ten editorial problem lenses with five audience contexts, allowing the same provider boundary to return the default 20 or any requested count up to 50 without external data. The convergent fixture returns separate advisory judgments and a human-review hold without taking an editorial action. Tests always inject mock or fake HTTP responses.

### OpenAI profile

```env
AI_PROVIDER=openai-compatible
AI_VENDOR=openai
AI_BASE_URL=
AI_API_KEY=replace-locally
AI_MODEL=replace-with-an-enabled-model-id
AI_TIMEOUT_MS=60000
```

A blank base URL resolves to `https://api.openai.com/v1`; the adapter posts to `/chat/completions`. OpenAI recommends the Responses API for new projects, but this Studio intentionally uses Chat Completions as the smallest shared compatibility boundary. See the official [OpenAI Create chat completion reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

### DeepSeek profile

```env
AI_PROVIDER=openai-compatible
AI_VENDOR=deepseek
AI_BASE_URL=
AI_API_KEY=replace-locally
AI_MODEL=replace-with-an-enabled-model-id
AI_TIMEOUT_MS=60000
```

A blank base URL resolves to `https://api.deepseek.com`; the adapter posts to `/chat/completions`. DeepSeek documents the same `response_format: { "type": "json_object" }` mode and notes that content can occasionally be empty, which the Studio reports rather than repairing. See the official [DeepSeek JSON Output guide](https://api-docs.deepseek.com/guides/json_mode/).

`AI_BASE_URL` exists for compatible endpoints and testing. Use only a trusted service: the server sends the configured bearer credential to that origin.

## Structured-output contract

Every operation builds a deterministic prompt that says `JSON`, includes a compact object-shape example, and requires exactly one object with no prose or Markdown. The adapter sends JSON mode, takes only the first choice's message content, and rejects:

- empty choices or content;
- refusals and content-filter failures;
- length-truncated responses;
- Markdown fences or trailing prose;
- malformed, truncated, non-object, or schema-invalid JSON.

It never silently repairs output. The operation-specific Zod schema validates the parsed object again, followed by domain validation for stable IDs, selected products, ordering, forbidden URLs, and publication readiness.

For `opportunity-candidates`, the response schema exposes only editorial proposal fields. It rejects protected IDs/product identities, URLs, extra fields, duplicate titles, invented external metrics or performance claims, and counts above 50. The Studio, not the model, assigns candidate IDs and proposed slugs, applies an unassessed `hold` gate, runs deterministic Opportunity Lab comparison, validates each existing-domain record, and then persists candidates. Generation-session metadata stores the provider/model IDs and exact prompt but never configuration or credentials.

For `opportunity-evaluations`, the deterministic prompt supplies candidate facts, authoritative 5.1 comparison reports, authoritative I.0 product coverage, and optional imported signals with provenance and date range as separate structures. The strict response must evaluate every selected candidate exactly once, keep all eleven 0–10 judgments separate, omit a composite score, explain every recommendation, require a published-guide target only for section/merge advice, and add an actionable explanation for high thin-content or cannibalization risk. The Studio validates the response, advances candidates only to `evaluated`, and stores the validated judgment and credential-free metadata without the complete raw provider response. Shortlisting and later decisions remain human actions.

## Credentials and diagnostics

The API key exists only in the local server process and the outbound Authorization header. It is never rendered in the browser, passed to Astro, written to a draft, included in generation metadata, logged, or published. Complete provider responses and provider error bodies are not persisted or logged.

The Studio shows short Spanish errors. Its terminal logs only a safe code plus HTTP status, request ID when available, and cause type. The thrown `ProviderError` retains its original `cause` for an attached local debugger without exposing that cause to the browser.

| Symptom                        | Check                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| Missing configuration at start | Set provider/vendor values exactly; real mode needs both key and model |
| Credentials rejected           | Check the selected vendor and rotate/replace the local key             |
| Rate limit                     | Wait and retry later; inspect provider account limits                  |
| Timeout or network failure     | Check connectivity, trusted base URL, and `AI_TIMEOUT_MS`              |
| Empty or refused output        | Review the safe UI message and prompt preview; retry deliberately      |
| Invalid JSON/schema            | Keep the draft, inspect the prompt, and retry or use mock/manual copy  |

There is no automatic retry, streaming, provider SDK, tool calling, Responses API, Assistants API, embedding, ranking, automatic editorial decision, or vendor-specific agent behavior in this MVP.
