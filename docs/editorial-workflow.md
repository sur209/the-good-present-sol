# Editorial workflow

The Editorial Studio is a local owner tool at `http://127.0.0.1:4322`. Its interface and validation guidance are Spanish; the public cluster and guide records it creates are US English (`en-US`) with USD budget context.

## Start locally

From a clean checkout:

```sh
npm ci
npm run verify
npm run studio
```

No credentials are needed in the default mock mode. The Studio stores validated working files at `drafts/{draft-id}.json`. That directory is git-ignored by default because drafts can contain questionnaire answers, prompts, and unfinished copy. Back it up explicitly if local history matters. Canonical files under `content/` remain version-controlled.

## Identity and routes

The draft ID is assigned once and is also the canonical public record ID and filename stem. It is not a normal editable field. A slug is editable routing data: changing it changes the route but never the canonical filename or update identity.

A public URL exists only after publishing a cluster or guide record. Primary axes define the main editorial lens: `general`, `occasion`, `recipient`, `career-stage`, `work-context`, `gift-style`, or `budget`. Secondary taxonomies classify a guide but never create combinatorial routes, filters, or pages. Related guides are editorial links, not hierarchy. A child guide belongs to exactly one cluster.

## Product catalog and Amazon links

Products are edited at `/products/{product-id}/edit`. Ordinary product destinations remain manual catalog fields. Amazon affiliate URLs use the dedicated **Intake manual Amazon US** section:

1. Configure the non-public Amazon profile with the verified account identifier and approved tracking IDs. The seed profile is disabled and intentionally contains no real account identifier or tracking ID.
2. Paste the Amazon product URL and the Special Link created by SiteStripe or Associates Central. Select the approved tracking ID shown by the profile.
3. Review the local validation. It checks `https`, the exact Amazon US host allowlist, probable ASINs found only in the pasted URL, visible tracking tags, duplicate ASINs, and duplicate normalized affiliate URLs. Short links receive a warning because the Studio cannot inspect their destination without a network request.
4. Confirm explicitly before saving. The product stores the normalized public URLs; the non-public source ledger stores the original submitted strings, normalized affiliate URL, ASIN when visible, tracking ID, and canonical product ID.

The Studio does not generate or repair Amazon links, fetch Amazon pages, expand redirects, parse HTML, use browser automation, call Creators API, or accept Amazon credentials. Tracking mismatches are shown before a write. Product and source changes do not publish guides; any guide change still follows the Goal 2 preview, validation, and publication workflow below.

## Assisted manual product intake

Use `/products/intake` for a new product when the editor has a pasted product URL from Amazon or another merchant, an optional affiliate URL, and editor-verified catalog information. The Studio does not fetch merchant pages, scrape HTML, expand short links, download images, call Creators API, copy marketplace descriptions, or generate an affiliate URL.

1. Enter the product URL and/or ASIN. The Studio checks only the submitted strings, approved Amazon HTTPS hosts, and safe generic HTTP(S) syntax.
2. Enter source facts and original editorial fields separately. Select only facts supported by the entered source facts and affirm that support before saving.
3. Add an image reference only when its alt text and rights/provenance notes are known. Use a durable price label or range; exact current prices are not stored.
4. Review the proposed canonical `Product` and non-public source record. Duplicate ASINs and likely duplicate canonical products block the write.
5. Confirm explicitly. The Studio writes the product and source record together with rollback on partial failure.
6. If the product is being added for a guide, return to the GuideDraft, select the new active product by stable ID, and continue through the normal copy review and Goal 2 publication workflow.

ASINs, source facts, tracking IDs, original URLs, and provenance notes remain internal Studio data. They do not enter the Astro build or guide records.

## Product-gap sourcing and return

Use `/product-sourcing`, a brief requirement, or a GuideDraft slot to create a traceable sourcing request. A slot-origin request stores both the GuideDraft ID and the exact stable recommendation-slot ID.

1. Record the intended role, required category, audience, occasion, budget context, must-have verified facts, exclusions, and search terms. A slot-origin request derives audience, occasion/work context, budget, slot purpose, search terms, and exclusions from its GuideDraft, slot, questionnaire, taxonomies, and originating brief when available; the editor fills only genuinely missing or changed values. Keep the request `open`, or deliberately mark it `held` or `rejected`.
2. In an unresolved slot, use **Buscar en catálogo** to inspect active canonical Products. The page shows the existing deterministic I.0 token evidence, threshold, and current Guide reuse; it does not label editorial fit or choose a Product automatically. A Product must contain every must-have fact in its canonical `verifiedFacts`; selecting it as partial or complete fulfillment is always an explicit editor action.
3. For external discovery, select one or more open requests and use **Generate SearchPlans**. One batched call through the existing editorial provider derives the editorial problem, use case, Product class, attributes, exclusions, and one to three queries from the stored request, GuideDraft, exact slot, questionnaire, originating brief, budget, and taxonomies. Known context is not re-entered.
4. On a planned request, use **Run external discovery**. The page shows the single configured provider and paid-use state. The run reuses catalog/recent evidence first, skips resolved slots, makes at most three provider calls with concurrency two, and stores at most four external candidates. The default first round never continues automatically; **Run second and final round** is a separate editor action. SerpAPI failure never falls back to DataForSEO. With discovery disabled or unconfigured, continue with catalog, URL, or idea-only paths.
5. Use **Pegar URL de producto/afiliado** when the editor has a product or affiliate URL. The same request is created or reused automatically, the URL is parsed locally, and the candidate opens in the existing P.1 intake with the Guide/slot context and URL evidence prefilled. Amazon parsing reuses A.1; non-Amazon parsing only normalizes safe HTTP(S) values.
6. Review any manual or provider candidate as observed evidence. Price, rating/review metadata, merchant, identifiers, and query provenance do not become canonical facts. `approved-for-intake` is not fulfillment. Complete ordinary P.1 intake and source-provenance review; confirmed intake creates the canonical Product and P.0 source record and links them to the same candidate.
7. Before intake or selection, optionally choose candidates across one or more requests and use **Evaluar candidatos seleccionados**. The ProductFitEvaluator makes one structured call for the batch, shows every editorial/functional, consumer/gift-value, evidence/operations, and collection dimension separately, and stores visible `product-fit-ranking-v1` ordering signals without a total or winner. Unknown evidence remains unknown. The evaluator cannot verify facts, approve/reject a candidate, create/select a Product, fulfill I.2, or assign a slot.
8. Optionally add manual or future Creators API candidates to the same queue. A later P.3 source must implement the existing Product discovery/source interface and reuse this lifecycle.
9. Select the canonical Product separately for I.2, then return to an originating brief or use **Assign to originating slot**. Assignment reuses the ordinary Goal 2 product-selection function and returns to that exact slot.
10. When a manually chosen canonical Product is an especially strong example, optionally open **Marcar como referencia editorial**, choose one or more structured reasons, and add a concise rationale. This stores an internal EditorialBenchmark for the exact Guide/slot context. It does not re-select the Product, boost later rankings, alter ProductClassProfiles, become hidden training data, or force reuse.
11. Review or generate recommendation copy and run preview/readiness checks. Sourcing never marks copy ready and never publishes; an unresolved slot can be editorially ready while its sourcing request remains a Product gap.

The request, source candidate, fit-evaluation session, EditorialBenchmark, canonical Product, and GuideDraft recommendation slot remain separate records. A source candidate cannot be assigned to a draft; fit interpretation and benchmarks are advisory; neither candidate approval nor canonical-product linking fulfills a request.

## Opportunity review and brief handoff

Use `/opportunities` to review non-public article candidates. Divergent generation and convergent evaluation use the existing provider adapter, but their scores, comparisons, and recommendations are advisory. The editor controls shortlist and every outcome.

1. Evaluate a generated candidate and shortlist it when it deserves a final human decision.
2. Choose Approve for brief, Convert to section, Merge into existing content, Hold, or Reject. Section and merge require an existing canonical guide ID. Merge, hold, and rejection require a reason; the Studio retains the explicit human outcome.
3. Approve for brief creates a draft `EditorialBrief` and opens `/opportunities/briefs/{brief-id}`. Edit its planning fields and evidence notes, then approve it explicitly. Candidate approval and brief approval are separate actions.
4. Convert an approved brief to create one ordinary `GuideDraft`. The draft receives a system-owned Goal 2 `guide_...` ID and starts at the questionnaire stage with no product selections, recommendations, generated final copy, canonical file, route, or publication.
5. Continue in the gift-guide workflow below. Preview, validation, and publication remain explicit later actions.

Convert to section and merge record only the target and reason; they do not edit, delete, merge, publish, or unpublish the target guide. Hold and reject create no content. Regenerate alternatives creates a linked generation session rather than a new editorial decision, and unchanged rejected ideas are blocked unless the input evidence changes.

## Cluster-hub workflow

1. Create a cluster draft or reopen a published hub by stable ID.
2. Edit its slug, title, excerpt, introduction, SEO title, and SEO description.
3. Add and order curated navigation groups; choose each group's label and primary axis.
4. Add and order only already-published child guides belonging to this cluster. Empty working groups are omitted at publication.
5. Preview the canonical route and run validation.
6. Publish to `content/clusters/{cluster-id}.json`.
7. Review the repository diff, run `npm run verify`, then commit and push manually.

Cluster hubs do not use questionnaires, product slots, or guide-copy generation.

## Gift-guide workflow

1. Create a guide draft or reopen a published guide by stable ID.
2. Choose its published cluster, slug, one primary axis, and a distinct primary intent. Add secondary taxonomies, budget context, and same-cluster related guides only when editorially useful.
3. Optionally answer the questionnaire. Blank answers are allowed; gift count defaults to 8 and accepts 3–20.
4. Preview the deterministic outline prompt, then generate an outline and stable editorial slots. The mock provider works offline and invents no commercial products.
5. Search the active catalog or use deterministic suggestions for each slot when a Product is available. Products can be created, edited, reused, selected, cleared, or replaced; slots can be added, removed, and reordered. Product selection is not required to finish generic editorial guidance.
6. For Product-backed generation, preview the final prompt and generate guide copy using only the selected Product records. Every slot must have an active Product; the existing exact-ID, catalog-field, verified-fact, price-label, and no-URL rules remain unchanged.
7. Edit guide and recommendation copy manually as needed. An unresolved slot may be marked `ready` once it has a description and why-it-fits and the editor confirms it contains no Product name, merchant, price, rating/review, availability, unsupported Product specification, or commercial claim.
8. Product resolution and editorial readiness are separate. Resolving a ready idea preserves its recommendation ID and position but returns its copy to `needs-generation`; replacing a Product returns it to `needs-review`; clearing a Product with existing copy also requires review before the slot can be published as generic again.
9. Preview the canonical nested route and validate. A missing Product is valid only for a complete, ready unresolved idea. Missing/inactive referenced Products, unresolved copy, duplicate slugs, bad relations, and non-ready recommendations block publication.
10. Publish to `content/guides/{guide-id}.json`, update the cluster's curated group separately if it should link the new guide, and publish the hub.
11. Review the repository diff, run `npm run verify`, then commit and push manually.

Updating a catalog product changes what every referencing guide resolves. Resolving an idea or replacing a product ID changes only that one recommendation and never changes its stable recommendation ID or position.

## Publication boundary

Publish creates or updates by stable ID, validates the complete candidate content graph, and atomically replaces the stable-ID file. Product-backed recommendations retain the original public shape. Ready slots without a Product become the strict idea-only branch with `productResolution: "unresolved"` and no `productId`. Publication strips questionnaire, prompt, outline, generation, selection, and review metadata; preserves `publishedAt` during updates; and refreshes `updatedAt`. A successful local publication is not an Internet deployment. GitHub Pages builds only after canonical changes are committed and pushed.

The Studio does not automate Git, unpublish records, delete public content, schedule publication, or expire content.

## Current scope and later stages

The implemented Opportunity Lab covers candidate generation, comparison, advisory evaluation, human review, briefs, and the GuideDraft handoff. Product sourcing includes bounded, editor-triggered SerpAPI discovery and optionally enabled DataForSEO discovery, but excludes automated product or affiliate intake loops, autonomous search, provider fallback, Search Console, Pinterest, performance feedback, embeddings, broad merchant import, price or stock synchronization, authentication, databases, rich-text editing, multilingual publishing, and automatic publication. The earlier P.2 batch-import concept is deferred as a possible future source adapter and is not implemented.

Legacy migration is a separate future stage. Opportunity records and briefs remain outside canonical content, and their decisions cannot silently create public routes. Unpublishing and deletion also require a separate recovery-aware design.
