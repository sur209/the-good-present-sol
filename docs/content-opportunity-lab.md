# Content Opportunity Lab

Phase 5.0 establishes the smallest non-public domain for recording article opportunities before editorial planning. Phase 5.1 adds read-only, deterministic comparison against the editorial state. Phase 5.2 adds provider-neutral divergent candidate generation. Phase 5.3 adds advisory convergent AI evaluation of a selected candidate batch. No Lab phase makes an automatic editorial decision, creates briefs or drafts, or publishes content.

## Ownership and storage

The Studio-owned implementation lives in:

```text
apps/studio/src/modules/content-opportunity-lab/
editorial-data/article-candidates/{candidate-id}.json
editorial-data/opportunity-generation-sessions/{generation-id}.json
editorial-data/opportunity-evaluations/{evaluation-id}.json
```

Each filename stem must match its stable `candidate_...` ID. The module validates every record and its canonical cluster/content references, rejects unsafe paths, and writes JSON through the existing atomic same-directory file operation. These records are versioned editorial data outside `content/`; Astro continues to read only canonical products, clusters, and guides under `content/`.

`packages/content-schema` remains unchanged. Candidates are internal opportunity analysis, not a fourth public content type.

Generation-session records contain the selected cluster/objective, market, language, optional planning horizon and imported summaries, provider/model IDs, prompt version, exact prompt, timestamp, and system-assigned candidate IDs. They never contain provider credentials or complete provider envelopes.

Evaluation records keep four distinct structures: candidate facts, system-derived 5.1 comparison and I.0 product-coverage evidence, optional imported signals with source and date range, and validated AI judgments. Human decisions remain only on their candidate records. Evaluation metadata includes provider/model IDs, prompt version, exact prompt, and timestamp, but no credentials or complete provider envelope.

## ArticleCandidate contract

An `ArticleCandidate` contains:

- stable candidate and canonical cluster IDs;
- a proposed title and slug;
- one canonical primary axis and a primary intent;
- the problem solved and target audience;
- secondary taxonomies, proposed sections, and distinctive product categories;
- closest existing cluster/guide IDs and explicit overlap signals with kind, level, and reason;
- eleven separate bounded editorial scores;
- an advisory recommendation and reason;
- optional imported source-signal IDs;
- an optional human decision;
- optional `EditorialBrief` and `GuideDraft` IDs for later traceability; and
- a status plus creation/update timestamps.

The optional trace IDs are references only. Phase 5.0 does not define an `EditorialBrief`, create a `GuideDraft`, or call the Goal 2 publication workflow.

## Scores

Every score is an integer from 0 to 10:

- intent differentiation;
- editorial usefulness;
- product differentiation;
- audience clarity;
- seasonal value;
- commercial potential;
- visual-distribution potential;
- product-reuse potential;
- thin-content risk;
- cannibalization risk; and
- maintenance cost.

These values are separate editorial aids. They are not objective SEO metrics, are not combined into an aggregate score, and do not authorize an editorial decision. Risk and cost fields also retain their own direction instead of being inverted into a ranking.

## Status and decisions

The candidate statuses are:

```text
generated
evaluated
shortlisted
approved-for-brief
converted-to-section
merged
converted-to-draft
rejected
```

Phase 5.0 exposes only the early status advances `generated -> evaluated -> shortlisted`. Phase 5.3 uses only the first transition after a validated evaluation; shortlisting and all later outcomes remain human actions. The five human decisions produce these candidate outcomes:

| Decision         | Candidate outcome      | Requirement                                       |
| ---------------- | ---------------------- | ------------------------------------------------- |
| `create-article` | `approved-for-brief`   | Candidate must already be shortlisted             |
| `add-as-section` | `converted-to-section` | Shortlisted; requires an existing target guide ID |
| `merge`          | `merged`               | Shortlisted; requires an existing target guide ID |
| `hold`           | status unchanged       | Evaluated or shortlisted                          |
| `reject`         | `rejected`             | Evaluated or shortlisted                          |

`converted-to-draft` is retained in the schema so a later workflow can preserve traceability, but there is deliberately no transition or conversion operation for it in this phase. Candidate statuses never duplicate `GuideDraft` editing, review, or `ready-to-publish` states.

## Studio interface

The existing local Spanish Studio provides:

- `/opportunities` for the candidate list; and
- `/opportunities` batch selection for convergent evaluation, with one optional imported signal carrying source and date range; and
- `/opportunities/{candidate-id}` for facts, deterministic evidence, imported evidence, AI judgment, early status advances, and human decisions.

There is no candidate-generation or create form in Phase 5.0. Valid records may be imported or authored as structured JSON, then inspected and decided in the Studio. A decision updates only the candidate file.

## Deterministic comparison

Phase 5.1 calculates comparisons at read time and saves no score, snapshot, recommendation, or decision. It compares every candidate with:

- published cluster hubs and gift guides from canonical content;
- every valid `ClusterDraft` and `GuideDraft`;
- approved `EditorialBrief` comparison records supplied by their owning workflow; and
- other candidates whose human decision is `reject`, `merge`, `hold`, or `add-as-section`.

This checkout has no serialized `EditorialBrief` contract or records: the four approved Nurse Gifts briefs are explicitly documentation-only in `docs/nurse-cluster-roadmap.md`. Phase 5.1 therefore defines only the narrow read model needed by comparison and accepts those records through the existing Studio composition boundary. It does not invent a brief persistence format, backfill documentation into new records, or change the 5.0 candidate contract.

Each target produces eight separate signals:

| Signal               | Comparable values                                                                 |
| -------------------- | --------------------------------------------------------------------------------- |
| Normalized title     | Unicode-normalized, lowercased title                                              |
| Proposed slug tokens | Hyphen-separated slug terms                                                       |
| Primary axis         | Exact guide/draft/brief axis; a hub-navigation axis is reported as medium overlap |
| Primary intent       | Meaningful normalized terms                                                       |
| Taxonomies           | Exact normalized values and meaningful terms across all taxonomy lists            |
| Problem solved       | Explicit problem text when the target contract provides it                        |
| Proposed sections    | Candidate headings/purposes and available target groups, slots, or headings       |
| Product categories   | Candidate categories or categories resolved from canonical product IDs            |

Text and list signals use explicit containment thresholds: at least two thirds is `high`, at least one third is `medium`, and less is `low`. Exact normalized text is `high`. Missing target data is an explained `low`, never an inferred semantic match. Common English connective and gift words are ignored; there are no embeddings, stemming, external services, or AI calls.

The Studio shows every signal and its shared values. Records are ordered by visible counts of `high` signals and then `medium` signals; those counts are presentation order, not an aggregate opportunity score or truth score. Published route collisions are listed separately as hard public-contract violations.

Prior decisions retain the 5.0 action, reason, date, and optional target ID. The comparison also shows added, removed, and shared `sourceSignalIds`, making a repeated idea with unchanged evidence explicit. A changed evidence ID is evidence of a changed input, not automatic permission to recreate the idea.

The existing advisory recommendation remains advisory. A valid deliberate human decision may disagree with it; comparison never rejects, merges, holds, shortlists, or creates anything automatically.

## Divergent AI generation

Phase 5.2 adds a generation form to `/opportunities` and one `opportunity-candidates` operation to the existing structured-generation provider. It uses the same mock-by-default and OpenAI/DeepSeek-compatible adapter and exact JSON/Zod validation boundary as guide generation.

Supported session objectives are cluster expansion, missing intents, seasonal ideas, section opportunities, existing-product reuse, possible cannibalization review, and localization candidates. The deterministic prompt may include the selected cluster, its published pages, matching drafts, supplied approved briefs, prior human candidate decisions, canonical primary axes, observed taxonomy values, active-catalog product categories, target market/language, planning horizon, and imported signal summaries supplied by later modules. The default is 20 candidates; the request and response boundaries reject more than 50.

Each untrusted proposal must contain a title, one canonical primary axis, one primary intent, problem solved, audience, secondary taxonomies, proposed sections, distinctive product categories, a potential-overlap hypothesis, and the literal provenance marker `editorial-hypothesis-only`. Strict output rejects extra fields, URLs, duplicate normalized titles, protected canonical IDs/product identities, and external-performance language such as search volume, keyword difficulty, Search Console, Pinterest, traffic, conversion, or affiliate-performance claims.

The AI does not return candidate IDs, slugs, statuses, scores, decisions, URLs, product identities, or affiliate data. The Studio assigns a random stable candidate ID, derives the non-public proposed slug, sets `generated`, fills the authoritative 5.0 score fields with zero as an explicit **unassessed** sentinel, and forces the advisory action to `hold`. The advisory reason labels the potential-overlap text as an AI hypothesis; zero is not a low evaluation and the candidate has not entered convergent review.

Before any write, the Studio validates the full batch as 5.0 `ArticleCandidate` records and runs the authoritative 5.1 comparison for every candidate. Only 5.1 medium/high primary-intent, proposed-section, and product-category signals become stored overlap records; their canonical IDs, levels, and reasons come from deterministic comparison, not the model. Public contract violations remain visible on candidate detail and do not become automatic decisions. After all candidates and the generation-session record validate, candidate files use the existing atomic store and the session metadata uses the existing atomic JSON writer.

## Convergent AI evaluation

Phase 5.3 adds one `opportunity-evaluations` operation to the same structured-generation provider. The dedicated deterministic prompt evaluates one to 50 selected `generated` candidates together. It receives candidate facts, complete 5.1 comparison reports, existing public pages, drafts, supplied approved briefs, prior rejected/merged/held/section-converted history, and the existing I.0 product-coverage analysis. Candidate-set synthesis and likely candidate-to-candidate overlap remain explicitly AI interpretation; the evaluator does not create a second deterministic comparison implementation.

Optional imported signals require a stable ID, source label, inclusive ISO date range, and editor-supplied summary. Missing imported evidence is not assigned a numeric zero. The validated response returns eleven separate integer 0–10 judgments, a batch synthesis, missing-evidence notes, an explanation, and one advisory recommendation for every selected candidate. There is no composite score. `add-as-section` and `merge` require an existing published-guide target; other recommendations reject a target. Thin-content or cannibalization risk of 7 or more requires a corresponding actionable explanation.

Provider output is untrusted JSON and must evaluate every selected candidate exactly once. A successful evaluation copies the validated scores and advisory explanation into the existing candidate contract, preserves imported signal IDs, and advances only `generated -> evaluated`. The evaluation record preserves the separated evidence and AI judgment plus credential-free generation metadata. It stores the validated editorial result, not the raw provider envelope.

The Studio labels deterministic evidence, imported factual signals, AI judgment, and human decision separately. An editor may then shortlist and deliberately choose any valid human outcome, including one that contradicts the AI recommendation. Evaluation never shortlists, creates a brief or draft, changes canonical content, or publishes.

## Existing-system boundaries

- I.0 Product Coverage Analysis remains the sole implementation of deterministic product-coverage signals. The Lab neither copies nor replaces that logic.
- Product catalog, product-source provenance, and affiliate operations are unchanged.
- The existing provider adapter is reused unchanged apart from the two Lab structured operations; there is no second adapter, SDK, retry, streaming, agent, embedding, or retrieval layer.
- Deterministic comparison and I.0 product coverage remain local and authoritative; convergent AI interpretation adds no ranking, product-first mode, coverage-first mode, or sourcing loop.
- No `EditorialBrief` or `GuideDraft` is created.
- No canonical content, public route, preview, or publication behavior is added.
- Any later GuideDraft work must enter the existing Goal 2 workflow and publish through its current validation and atomic publication boundary.

## Verification

The Studio tests cover strict schemas, the full score bounds, all five decisions, early status transitions, decision/target consistency, stable-ID paths, canonical references, atomic replacement, normalization, all eight comparison signal kinds, low/medium/high thresholds, public-contract separation, approved-brief input, prior-decision evidence history, deterministic divergent and convergent prompts, imported-signal provenance, risk actions, target requirements, mock output, malformed provider output, provider failure, default/maximum limits, credential-free metadata, human override, unpublished integration behavior, and real Astro builds that exclude candidates, generation sessions, and evaluation records.

Run:

```sh
npm run test --workspace @the-good-present/studio
npm run verify
```
