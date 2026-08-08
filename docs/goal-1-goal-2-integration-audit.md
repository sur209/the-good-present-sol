# Goal 1 + Goal 2 integration audit

## Audit scope

- Audited baseline commit: `3acd42d39d057d077ece3b77304fd68e07062a36` on `main`.
- Audit date: 2026-08-08.
- Scope: the implemented Goal 1 public Astro system and Goal 2 local Editorial Studio as one publishing system.
- Source of truth: `README.md`, `docs/architecture.md`, `docs/content-contract.md`, `docs/editorial-workflow.md`, `docs/ai-providers.md`, and `docs/progress.md`.
- Deferred roadmap work was treated as out of scope, not as a defect.

The audit traced canonical JSON through validation and Astro route generation; a guide draft through outline generation, product selection, final copy, preview, validation, publication, reopen, and update; reused products across guides; shared route construction; provider configuration and failures; atomic writes; and the production artifact boundary.

## Baseline verification

The untouched baseline passed:

```text
npm.cmd run verify
```

Baseline result: formatting, strict TypeScript, zero Astro diagnostics, 47 tests, canonical validation of 11 products / 1 cluster / 3 guides, and a 9-page static build all passed.

## Concrete findings and fixes

### High — The outline provider controlled canonical recommendation identity

The outline output schema required the provider to invent slot IDs, and `generateGuideOutline` persisted those values as draft recommendation IDs. Those IDs later became canonical `GuideRecommendation.id` values. This violated the boundary that AI may propose editorial content but may not choose stable identity.

Fix:

- The Studio now assigns deterministic slot IDs before generation.
- Existing recommendation IDs are preserved by position when an outline is regenerated before product selection.
- The prompt tells the provider to echo the assigned IDs in order.
- The validated response is rejected if any assigned ID changes.
- The mock provider follows the same contract as compatible real providers.

No public schema version or parallel identity field was added.

### Medium — Preview and Astro disagreed on outbound product destinations

Studio preview used `affiliateUrl ?? productUrl`, while Astro rendered only `affiliateUrl`. A valid product with only `productUrl` therefore showed a merchant link in preview but lost it after publication.

Fix:

- Added the canonical `productDestination` helper to the existing public content package.
- Studio preview and Astro now share the same affiliate-first fallback.
- Existing HTTP(S) schema validation and safe external-link attributes remain unchanged.

### Low — Publication metadata was not reviewable in preview

Guide and cluster previews showed content and routes but omitted their SEO metadata; guide preview also omitted the primary editorial axis, intent, and budget context shown by the public guide. The editor could not review those material fields in the approval representation.

Fix:

- Cluster preview now shows SEO title and description.
- Guide preview now shows editorial axis, intent, optional budget context, SEO title, and SEO description.

This changes only the existing preview surface; it adds no public fields or workflow stage.

## Verified scenarios

### A — Update existing published content

An isolated repository publication updated an existing guide, preserved its stable ID, canonical stable-ID filename, original `publishedAt`, recommendations, and relationships, refreshed `updatedAt`, and rendered the changed title in the Astro output.

### B — Change guide slug

The same isolated scenario changed a guide slug. The guide ID and filename remained unchanged, hub membership stayed ID-based, and Astro emitted the updated nested route without creating a second guide.

### C — Change cluster slug

The isolated scenario then changed the parent cluster slug. The cluster ID, filename, original `publishedAt`, navigation guide IDs, and child guide `clusterId` stayed unchanged. Astro emitted the hub and child guide under the new cluster segment using the shared route contract. No redirect was added.

### D — Product reuse

A central product used by the newly published guide and an existing guide was changed from an affiliate destination to a `productUrl`-only destination. Both built pages resolved the new central destination, while the existing guide recommendation record and its guide-specific copy remained unchanged.

### E — Selective product replacement

Replacing Product A with Product B in one draft recommendation preserved recommendation ID, position, slot label, slot intent, and unrelated editorial copy while moving the slot to `needs-review`. Product A remained in the canonical catalog and in other published guides. Single-slot regeneration returned only the replaced slot to `ready` without changing sibling recommendations.

### F — Invalid relationship

Publishing a guide with a nonexistent related-guide ID failed with an actionable same-cluster publication error. The existing canonical file was byte-for-byte unchanged and the full public graph remained valid.

### G — Provider failure

Fake provider responses covered authentication rejection, rate limiting, network failure, timeout, empty choices/content, refusal, truncation, Markdown fences, trailing prose, malformed JSON, non-object JSON, and schema-invalid JSON. Errors retained typed internal causes and safe diagnostic codes while excluding response bodies and the test credential from UI-safe messages and debug summaries. Generation rejects before the caller saves a draft, and providers have no canonical writer or publication path.

### H — Publication failure

The atomic JSON writer was forced to fail at replacement. It removed its same-directory temporary file and left no partial destination record. Candidate publication validation also rejected a bad relationship before canonical mutation.

### I — Production build isolation

The canonical production build emitted 14 files: 9 HTML pages, static metadata/assets, one CSS asset, zero JavaScript files, and zero source maps. A recursive artifact scan found no draft fields or files, prompts, provider configuration variable names, credential variable names, Studio endpoints, loopback hosts, repository paths, Studio source paths, or local filesystem paths. All 18 representative outbound product controls used `target="_blank"` and `rel="sponsored nofollow noopener"`.

## Contract results

- Products, clusters, guides, relationships, and filenames use stable IDs; slugs remain mutable route fields.
- `GuideDraft.id` is the canonical guide ID. No `sourceId`, `sourceSlug`, or publication-only identity exists.
- Studio, publication results, Astro pages, structured data, breadcrumbs, and cards use the shared route builders.
- The hub-and-spoke model still has only `cluster-hub` and `gift-guide` public page types.
- Full-graph validation covers duplicate IDs/routes, filename mismatches, reserved cluster slugs, missing/cross-cluster guide relations, duplicate/self related guides, recommendation identity/position conflicts, and missing/inactive products.
- Draft-to-public transforms construct strict public records and strip questionnaire, outline, prompt, generation, selection, and review metadata.
- Existing `publishedAt` values are preserved and canonical writes remain stable-ID based and atomic.
- Product updates remain central; product replacement remains recommendation-local.
- AI receives no product or affiliate URLs, cannot choose persisted identities, cannot write files, and cannot publish.
- Mock, OpenAI, and DeepSeek-compatible behavior still uses one provider boundary and one OpenAI-compatible real adapter.
- Credentials remain server/environment-only and are not logged, drafted, published, or bundled.
- Public product links resolve only validated canonical destinations and fail gracefully when neither destination field exists.

## Complexity audit

The final whole-repository Ponytail audit found no removable dependency, speculative service or plugin layer, duplicate repository or publication pipeline, hand-rolled standard-library replacement, or dead roadmap scaffold.

The provider interface has two real implementations; repository helpers serve draft, product, and publication writes; Zod owns trust-boundary validation; Astro and its sitemap/check integrations are active; and `productDestination` removes a real cross-app divergence. Result: `Lean already. Ship.`

## Remaining known limitations

- Canonical seed destinations still use visibly labeled `example.com` demo affiliate URLs and must be replaced with verified editorial destinations before launch.
- Publication assumes one local editor. It performs one validated atomic record replacement at a time and intentionally has no concurrency lock or generalized multi-record transaction.
- Real provider accounts were not contacted during the audit; provider transport and failure behavior were verified with deterministic fakes.
- A slug change intentionally creates no redirect in this phase.

## Deferred roadmap functionality

These are deliberate exclusions, not Goal 1 / Goal 2 defects:

- redirects and legacy migration;
- unpublishing and canonical deletion;
- affiliate operations, merchant APIs, scraping, product feeds, and automated price/stock maintenance;
- brainstorming, opportunity scoring, overlap/cannibalization analysis, embeddings, RAG, or agents;
- authentication, databases, hosted Studio services, scheduled publication, or automatic Git/deployment;
- public search, filters/facets, taxonomy-generated pages, product pages, accounts, carts, comments, wish lists, or localization routes.

## Verification commands and final results

Commands run from the repository root:

```text
npm.cmd run test --workspace @the-good-present/studio
npm.cmd run typecheck
npm.cmd run verify
git diff --check
```

Additional artifact checks recursively inspected `apps/site/dist/` for Studio/draft/provider/credential/local-path markers, JavaScript, source maps, route output, canonical metadata, recommendation counts, and safe outbound-link attributes.

Final result before commit:

- format check: passed;
- TypeScript and Astro diagnostics: passed, 0 errors / 0 warnings / 0 hints;
- tests: 49 passed (43 Studio + 6 shared content/route tests);
- canonical content validation: passed for 11 products, 1 cluster, and 3 guides;
- production build: passed, 9 pages;
- public artifact isolation scan: passed;
- Ponytail audit: `Lean already. Ship.`;
- `git diff --check`: passed.
