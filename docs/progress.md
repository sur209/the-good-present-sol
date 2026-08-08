# Progress

## Phase status

| Phase | Status | Outcome |
| --- | --- | --- |
| 0 — Architecture and content contract | Complete | Defined stable identity, public records, routes, replacement semantics, future compatibility, and exclusions |
| 1 — Repository and Astro foundation | Not started | — |
| 2 — Shared schemas and validation | Not started | — |
| 3 — Seed vertical slice | Not started | — |
| 4 — Public editorial experience | Not started | — |
| 5 — SEO, accessibility, and deployment | Not started | — |
| 6 — Ponytail audit | Not started | — |

## Current contract

- Source of truth: stable-ID-named JSON files under `content/`.
- Shared boundary: pure schemas, validation, error formatting, and route helpers in `packages/content-schema/`.
- Public output: static Astro assets in `apps/site/dist/`.
- URL policy: only differentiated, substantial editorial intents receive routes; taxonomies never create pages.
- MVP scope: Nurse Gifts hub plus graduation, practical, and under-$25 guides.

## Verification log

- Phase 0: `git diff --check` passed; required architecture, URL-policy, replacement, redirect-boundary, and public-status terms confirmed. Ponytail review kept the phase to the four required documentation files with no speculative code or placeholder subsystems.
