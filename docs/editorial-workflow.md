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
5. Search the active catalog or use deterministic suggestions for each slot. Products can be created, edited, reused, selected, cleared, or replaced; slots can be added, removed, and reordered.
6. Preview the final prompt and generate guide copy using only the selected product records. AI output cannot set product or affiliate URLs.
7. Edit guide and recommendation copy manually as needed.
8. When replacing a product, the recommendation ID and position stay fixed and its copy becomes `needs-review`. Regenerate only that recommendation or edit it, then mark it `ready`.
9. Preview the canonical nested route and validate. Missing/inactive products, unresolved copy, duplicate slugs, bad relations, and non-ready recommendations block publication.
10. Publish to `content/guides/{guide-id}.json`, update the cluster's curated group separately if it should link the new guide, and publish the hub.
11. Review the repository diff, run `npm run verify`, then commit and push manually.

Updating a catalog product changes what every referencing guide resolves. Replacing a product ID changes only that one recommendation.

## Publication boundary

Publish creates or updates by stable ID, validates the complete candidate content graph, and atomically replaces the stable-ID file. It strips questionnaire, prompt, outline, generation, selection, and review metadata; preserves `publishedAt` during updates; and refreshes `updatedAt`. A successful local publication is not an Internet deployment. GitHub Pages builds only after canonical changes are committed and pushed.

The Studio does not automate Git, unpublish records, delete public content, schedule publication, or expire content.

## Current scope and later stages

This stage deliberately excludes article brainstorming, opportunity generation, title/intent similarity scoring, content-overlap or cannibalization analysis, embeddings, automated merchant search/imports, price or stock synchronization, authentication, databases, rich-text editing, and multilingual publishing.

Legacy migration is a separate future stage. An opportunity lab may later propose or compare content, but it must remain outside this deterministic publishing workflow and cannot silently create public routes. Unpublishing and deletion also require a separate recovery-aware design.
