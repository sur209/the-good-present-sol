# Content Opportunity Lab

Phase 5.0 establishes the smallest non-public domain for recording article opportunities before editorial planning. It does not generate, compare, evaluate, brief, draft, or publish content.

## Ownership and storage

The Studio-owned implementation lives in:

```text
apps/studio/src/modules/content-opportunity-lab/
editorial-data/article-candidates/{candidate-id}.json
```

Each filename stem must match its stable `candidate_...` ID. The module validates every record and its canonical cluster/content references, rejects unsafe paths, and writes JSON through the existing atomic same-directory file operation. These records are versioned editorial data outside `content/`; Astro continues to read only canonical products, clusters, and guides under `content/`.

`packages/content-schema` remains unchanged. Candidates are internal opportunity analysis, not a fourth public content type.

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

Every score is an integer from 0 to 5:

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

Phase 5.0 exposes only the early status advances `generated -> evaluated -> shortlisted`. The five human decisions produce these candidate outcomes:

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
- `/opportunities/{candidate-id}` for details, early status advances, and human decisions.

There is no candidate-generation or create form in Phase 5.0. Valid records may be imported or authored as structured JSON, then inspected and decided in the Studio. A decision updates only the candidate file.

## Existing-system boundaries

- I.0 Product Coverage Analysis remains the sole implementation of deterministic product-coverage signals. The Lab neither copies nor replaces that logic.
- Product catalog, product-source provenance, and affiliate operations are unchanged.
- No provider adapter or AI operation is called.
- No deterministic candidate comparison, AI generation/evaluation, product-first mode, coverage-first mode, or sourcing loop exists.
- No `EditorialBrief` or `GuideDraft` is created.
- No canonical content, public route, preview, or publication behavior is added.
- Any later GuideDraft work must enter the existing Goal 2 workflow and publish through its current validation and atomic publication boundary.

## Verification

The Studio tests cover strict schemas, the full score bounds, all five decisions, early status transitions, decision/target consistency, stable-ID paths, canonical references, atomic replacement, list/detail rendering, persisted decisions, and a real Astro build that excludes a sentinel candidate.

Run:

```sh
npm run test --workspace @the-good-present/studio
npm run verify
```
