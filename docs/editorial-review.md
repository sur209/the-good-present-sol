# Editorial Review v1

On a completed guide, save edits and choose **Revisar editorialmente**. Studio reviews the saved editorial text with the configured provider in one structured call. The report can contain zero issues. Mock mode is explicitly labeled as simulated and does not diagnose copy quality.

Select localized suggestions and choose **Aplicar correcciones seleccionadas**. A correction replaces one complete editorial field only when its location is unambiguous and its original text matches exactly. Unknown fields, partial quotes, URLs, and suggestions without replacements remain advisory. Selecting overlapping replacements for the same field fails without saving any of them.

The field mapping follows the existing draft model:

| Editorial content                    | Draft field                            |
| ------------------------------------ | -------------------------------------- |
| Title / subtitle                     | `title` / `excerpt`                    |
| Introduction / conclusion            | `introduction` / `conclusion`          |
| SEO copy, explicitly reviewed        | `seoTitle` / `seoDescription`          |
| Recommendation heading / description | `heading` / `editorialDescription`     |
| Fit / intended recipient             | `whyItFits` / `bestFor`                |
| How to choose / considerations       | `selectionGuidance` / `considerations` |

The snapshot includes audience and intent context but excludes Product IDs, affiliate URLs, commercial internals, and generation traces. SHA-256 covers the editorial snapshot. Content or context changes make the report stale, including changes caused by applying a selection. Run review again before applying further corrections. The original fingerprint and applied issue timestamps remain in history. Changing only an affiliate URL, Product assignment, or workflow status does not invalidate editorial text; correction application preserves their latest values.

All selected corrections are validated before a draft is saved. Studio compares the current saved draft with the one used to prepare the correction, using the existing local store with a serialized save queue. This rejects competing saves within the Studio instance. As with the existing JSON stores, it does not coordinate multiple Studio processes or external file editors. The draft is saved before its issue history is marked applied; if history writing fails, Studio reports that partial success explicitly and the old report is stale.

Reports live in `editorial-data/editorial-reviews/<review-id>.json`, one record per review. They contain stable issue IDs, guide/slot/field locations, issue type and severity, explanations, original/replacement field text, applied timestamps, the fingerprint, provider/model identifiers, and compact usage metrics. They do not duplicate whole guides or retain full prompts/provider traces. Failed reviews are recorded separately from successful reviews with zero issues.

**Feedback editorial** summarizes reviews, failed reviews, issue counts by type, applied/unapplied suggestions, and the 20 most recent issues. Counts represent observed issue occurrences: repeated reviews may record the same unresolved problem again. Unapplied means no suggestion was applied through this action, not that a later manual edit failed to resolve the problem.

One structural failure allows at most one technical retry. Network, authentication, rate-limit, timeout, and refusal failures do not retry automatically. Token totals include both calls when usage is available; an em dash means unknown usage, not zero. Request-local usage avoids mixing metrics with concurrent provider calls.

Review and correction never call discovery, Product creation, sourcing, or P.2. Applying suggestions makes no LLM call. Generation prompts, outline/batching, Product/affiliate identity, and publication behavior are unchanged. Feedback is evidence for later human decisions; it never changes prompts or source code automatically.

## Validation and dogfood

Run the focused suite with:

```sh
node --disable-warning=ExperimentalWarning --experimental-strip-types --test apps/studio/src/editorial-review.test.ts
```

The Studio workspace test command includes this suite. Fixtures cover the supplied meta-process sentence, generic compression-socks sentence and grammar alternative, legitimate repetition of “10-hour shifts,” and substantive selection guidance. Canned HTTP provider responses check the structured contract, prompt safeguards, and correction/storage behavior; they are not evidence of live model quality.

On 2026-09-14, the configured `deepseek-v4-flash` provider reviewed the existing saved guide `guide_c2091332-f98f-4fe6-ba2e-775b87bfa636` (“Gifts for Nurses Working 10-Hour Shifts”). It returned zero issues in one review call, with zero repairs: 6,110 input tokens, 6,186 output tokens, 12,296 total tokens. The current saved version contained substantive recommendations and did not contain the quoted meta-process or generic fallback sentences. Necessary topic repetition was not flagged. No corrections were applied; all 248 pre-existing JSON files checked were unchanged. The successful local report is `review_c692cd62-6b49-4321-b567-676e983973ba`; an earlier network-blocked attempt remains as a failed review with unknown token usage.

An additional approved live fixture check used a separate copy of that guide with the two supplied bad sentences inserted. It found exactly two issues: `meta-process-language` (major, introduction) and `generic-or-thin-copy` (moderate, compression-socks description, with the grammar error explicitly explained). Both mapped to complete, exact fields and proposed shopper-facing replacements. It did not flag excessive repetition or the unchanged substantive recommendations. This check used one call, zero repairs, and 5,865 input / 4,499 output / 10,364 total tokens. The test copy was never saved as a draft, no corrections were applied, and the synthetic report was kept outside real-guide feedback history.

The full Studio suite passes with tracked content. Running it against this workspace's additional untracked dogfood content exposes three Opportunity Lab failures (external-evidence validation in mock opportunity generation); those are outside this feature. Keep generated/editorial dogfood JSON out of the implementation commit.
