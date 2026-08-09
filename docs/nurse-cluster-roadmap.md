# Nurse Gifts cluster roadmap

Phase 3.0 was a documentation-only audit and implementation backlog. It approved four editorial briefs, not four public records. Phase 3.1 below records the nursing-students GuideDraft and its product-data publication gate. Phase 3.2 below records the personalized GuideDraft and its product-data publication gate. Phase 3.3 below records the night-shift GuideDraft and its product-data publication gate. Later implementation must use the existing product intake, source-provenance, affiliate QA, GuideDraft, preview, and atomic publication workflows.

The proposed sections below are editorial beats for later drafting and recommendation selection. They do not require a new public schema field.

## Page status

| Page                          | Stable ID                      | Slug and route                                        | Primary axis                                          | Status                                                   |
| ----------------------------- | ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Nurse Gifts hub               | `cluster_nurse-gifts`          | `nurse-gifts` - `/nurse-gifts/`                       | Hub groups use `occasion`, `gift-style`, and `budget` | Published; audited                                       |
| Nurse graduation gifts        | `guide_nurse-graduation`       | `graduation` - `/nurse-gifts/graduation/`             | `occasion`                                            | Published; audited                                       |
| Practical gifts for nurses    | `guide_nurse-practical`        | `practical` - `/nurse-gifts/practical/`               | `gift-style`                                          | Published; audited                                       |
| Nurse gifts under $25         | `guide_nurse-under-25`         | `under-25` - `/nurse-gifts/under-25/`                 | `budget`                                              | Published; audited                                       |
| Gifts for nursing students    | `guide_nurse-nursing-students` | `nursing-students` - `/nurse-gifts/nursing-students/` | `career-stage`                                        | Draft complete; publication blocked by product-data gaps |
| Personalized gifts for nurses | `guide_nurse-personalized`     | `personalized` - `/nurse-gifts/personalized/`         | `gift-style`                                          | Draft complete; publication blocked by product-data gaps |
| Gifts for night-shift nurses  | `guide_nurse-night-shift`      | `night-shift` - `/nurse-gifts/night-shift/`           | `work-context`                                        | Draft complete; publication blocked by product-data gaps |
| Christmas gifts for nurses    | Not assigned                   | `christmas` - `/nurse-gifts/christmas/`               | `occasion`                                            | Brief approved; no draft or public record                |

The remaining Christmas brief stays deliberately unassigned until an editor creates its GuideDraft. A working slug is not record identity, and the blocked nursing-students, personalized, and night-shift drafts do not reserve public URLs.

## Existing implementation audit

All four published records use schema version 1, `en-US`, stable-ID filenames, and the canonical `cluster_nurse-gifts` relationship. Each guide has one explicit primary intent, six ready recommendations, only active product references, and two valid same-cluster related-guide links.

### Hub groups

| Group ID            | Label                 | Axis         | Guide IDs                |
| ------------------- | --------------------- | ------------ | ------------------------ |
| `group_by-occasion` | Celebrate a milestone | `occasion`   | `guide_nurse-graduation` |
| `group_by-style`    | Lead with usefulness  | `gift-style` | `guide_nurse-practical`  |
| `group_by-budget`   | Keep it under $25     | `budget`     | `guide_nurse-under-25`   |

The hub has no product references. Its groups are curated links, not taxonomy-generated routes.

### Guide intent, products, and related links

| Guide ID                 | Explicit primary intent                                                                                                    | Product references in order                                                                                                                                 | Related guide IDs                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `guide_nurse-graduation` | Help someone choose a meaningful nursing graduation gift that balances celebration with the graduate's next-step routines. | `product_shift-tote`, `product_stethoscope-case`, `product_insulated-tumbler`, `product_rechargeable-penlight`, `product_badge-reel`, `product_coffee-card` | `guide_nurse-practical`, `guide_nurse-under-25`   |
| `guide_nurse-practical`  | Find a genuinely useful nurse gift that supports a real workday or recovery routine without feeling clinical or generic.   | `product_compression-socks`, `product_insulated-tumbler`, `product_lunch-container`, `product_shift-tote`, `product_hand-cream`, `product_sleep-mask`       | `guide_nurse-graduation`, `guide_nurse-under-25`  |
| `guide_nurse-under-25`   | Help someone choose a useful, personal nurse gift while keeping the total product budget at or below $25.                  | `product_pocket-notebook`, `product_badge-reel`, `product_hand-cream`, `product_compression-socks`, `product_sleep-mask`, `product_coffee-card`             | `guide_nurse-graduation`, `guide_nurse-practical` |

All 11 catalog products appear in at least one published guide. Seven are reused with guide-specific recommendation copy; the stethoscope case, penlight, lunch containers, and pocket notebooks appear once.

### Catalog-readiness rule for these briefs

"Catalog-covered" below means that an active canonical product with compatible stored metadata already exists. It does not mean that current merchant facts or destinations are launch-ready. Every seed product currently names `Example Merchant (demo)`, points to `example.com`, has no `lastCheckedAt`, and has no stored `verifiedFacts`; no product-source records are present in this checkout. Before later publication, editors must verify the exact item and required facts through the existing source/intake workflow, replace demo destinations through the existing affiliate-link intake, and run affiliate QA.

A "gap" means the current catalog has no product whose stored facts establish the required role. This roadmap does not create products or invent merchant capabilities.

## Approved brief 1: Gifts for nursing students

- **Working title and slug:** "Thoughtful Gifts for Nursing Students"; `nursing-students`.
- **Primary axis:** `career-stage`.
- **Primary intent:** Help someone choose a gift for a person currently in nursing school that supports study and clinical-training routines without guessing at program requirements or treating them as an employed nurse.
- **Target audience:** Family, friends, partners, and mentors buying for an enrolled nursing student before graduation.
- **Buying problem solved:** The buyer wants something encouraging and useful now, but may not know the student's program rules, clinical-placement requirements, size, or existing equipment.
- **Distinctive editorial criteria:** Prefer portable, program-agnostic support for study, placement days, organization, and recovery; verify fit and school rules for wearable or clinical-adjacent items; avoid employer-specific assumptions, required-equipment claims, and graduation framing.
- **Proposed sections:** How to ask about program requirements; study and organization; clinical-day carry and small essentials; comfort between class and placement; flexible encouragement; what not to guess.
- **Required product categories:** Study organization; clinical-day carry or protection; small school-approved accessory; personal-fit comfort; flexible food/drink treat; one off-shift recovery option.
- **Catalog products that may be reused:** `product_pocket-notebook`, `product_badge-reel`, `product_stethoscope-case`, `product_rechargeable-penlight`, `product_compression-socks`, and `product_coffee-card`. Their current recipient metadata includes nursing students, but equipment, policy, fit, and merchant facts still require verification.
- **Product gaps:** A verified structured study/planning option beyond pocket notes; a clearly student-appropriate off-shift recovery option that does not duplicate the under-$25 list; launch-ready sources and destinations for every reused demo product.
- **Expected internal links:** The hub through standard breadcrumbs/back links; `guide_nurse-graduation` for readers approaching completion; `guide_nurse-under-25` for a strict budget. Later hub placement should use a career-stage group; its stable group ID is decided in the hub draft, not here.
- **Similarity risk:** It can collapse into graduation if it celebrates completion, or into under-$25 if it becomes a list of small accessories. Keep every criterion anchored to active study and clinical-training life.

## Phase 3.1 implementation record: Nursing students

The approved nursing-students brief was taken through the existing Studio draft workflow on 2026-08-09. The new stable guide ID is `guide_nurse-nursing-students`; the working slug remains `nursing-students`, so the intended route remains `/nurse-gifts/nursing-students/` without making the slug the record identity.

- **GuideDraft:** `drafts/guide_nurse-nursing-students.json` (git-ignored working data).
- **Product-gap report:** `editorial-data/product-gaps/gap_nurse-nursing-students.json`.
- **Primary axis:** `career-stage`.
- **Primary intent:** Help someone choose a gift for a person currently in nursing school that supports study and clinical-training routines without guessing at program requirements or treating them as an employed nurse.
- **Draft coverage:** Five active catalog candidates have original guide-specific copy and remain `needs-review`; the off-shift recovery slot is `unassigned` because no distinct verified candidate exists.
- **Publication decision:** Blocked. The assigned candidates have no stored `verifiedFacts`, `lastCheckedAt`, or product-source records, and their destinations are demo URLs. No fabricated product, merchant, price, policy, fit, or availability claim was added.
- **Public-content decision:** No `content/guides/` file, hub navigation group, route output, or reciprocal public link was written. The existing hub therefore continues to link only to published guides.

The draft uses the two existing same-cluster editorial targets from the brief: `guide_nurse-graduation` for readers approaching completion and `guide_nurse-under-25` for strict budgets. Those links remain draft-only until the guide clears product review and is published through the normal atomic workflow.

## Approved brief 2: Personalized gifts for nurses

- **Working title and slug:** "Personalized Gifts for Nurses That Still Feel Like Them"; `personalized`.
- **Primary axis:** `gift-style`.
- **Primary intent:** Help a buyer choose a genuinely personalizable nurse gift whose name, initials, date, color, or message reflects the recipient without relying on generic profession slogans.
- **Target audience:** Close family, friends, partners, colleagues, and mentors who know enough about the recipient to make a durable customization choice.
- **Buying problem solved:** The buyer wants the gift to feel one-of-one but needs to judge whether the personalization is useful, tasteful, correctly specified, and deliverable on time.
- **Distinctive editorial criteria:** Require verified customization options for the exact product; record what can be customized, character or artwork limits, proofing, lead time, return limits, and workplace suitability; favor recipient-specific details over nurse branding; reject unsupported engraving or monogram claims.
- **Proposed sections:** When personalization adds meaning; what detail to personalize; work-safe personalized options; off-shift options; ordering and proof checklist; mistakes that cannot be returned.
- **Required product categories:** Personalized work accessory; personalized carry or organization item; personalized drinkware or home-use item; message-led keepsake; fast-turnaround option; one fully off-shift option based on the recipient's interests.
- **Catalog products that may be reused:** None are currently eligible because no canonical record stores customization facts. The form factors represented by `product_badge-reel`, `product_insulated-tumbler`, `product_shift-tote`, and `product_stethoscope-case` may be reassessed only if editors verify that the exact existing item supports customization. A stable product ID must never be reused for a different personalized item.
- **Product gaps:** Verified customization coverage across several categories; stored lead-time, proof, character-limit, placement, and return facts; a non-work personalized option; launch-ready product sources and destinations.
- **Expected internal links:** The hub; `guide_nurse-practical` for buyers who decide usefulness matters more than customization; `guide_nurse-graduation` when the personalization marks that specific milestone. Later hub placement can reuse `group_by-style` only after its label is broadened beyond usefulness.
- **Similarity risk:** Without exact customization facts, this becomes the general hub or practical guide with "add their name" appended. Do not publish the guide until the catalog can support multiple genuinely personalized categories.

## Phase 3.2 implementation record: Personalized nurse gifts

The approved personalized brief was taken through the existing Studio GuideDraft workflow on 2026-08-09. The new stable guide ID is `guide_nurse-personalized`; the working slug remains `personalized`, so the intended route remains `/nurse-gifts/personalized/` without making the slug the record identity.

- **GuideDraft:** `drafts/guide_nurse-personalized.json` (git-ignored working data).
- **Product-gap report:** `editorial-data/product-gaps/gap_nurse-personalized.json`.
- **Primary axis:** `gift-style`.
- **Primary intent:** Help a buyer choose personalization that feels useful and specific rather than generic or decorative-only.
- **Draft coverage:** Six original US English editorial slots cover personalized work accessories, carry or organization, drinkware or home use, message-led keepsakes, fast turnaround, and an off-shift interest. All six remain `unassigned` because no active catalog record stores verified customization facts.
- **Generation boundary:** The first-stage outline is complete with stable slots. The existing final-generation stage was not run because it requires selected products and would have no truthful product input.
- **Publication decision:** Blocked. The active form-factor leads have no verified customization method, placement, character or artwork limits, proofing, lead-time, workplace-suitability, return, or launch-ready destination facts; the product-source ledger is empty and all candidate destinations are demo URLs.
- **Public-content decision:** No `content/guides/` file, hub navigation group, public route output, or reciprocal public link was written. The existing hub continues to link only to published guides.

The draft keeps `guide_nurse-practical` as the usefulness comparison and `guide_nurse-graduation` as the milestone-specific comparison. Those links remain draft-only until product review clears the publication gate. The exact personalized products must be verified through the existing intake and provenance workflow; no existing product ID may be repurposed for a different item.

## Approved brief 3: Gifts for night-shift nurses

- **Working title and slug:** "Thoughtful Gifts for Night-Shift Nurses"; `night-shift`.
- **Primary axis:** `work-context`.
- **Primary intent:** Help someone choose a gift that supports the specific overnight cycle - preparing, eating and hydrating during off-hours, commuting, and resting in daylight - without making medical or performance claims.
- **Target audience:** Family, friends, partners, and coworkers buying for a nurse who regularly works overnight shifts.
- **Buying problem solved:** The buyer knows the schedule is demanding but needs an option shaped around overnight constraints rather than a generic work accessory or caffeine joke.
- **Distinctive editorial criteria:** Tie each pick to an overnight-specific moment; prioritize quiet, darkness, portability, cleaning, and preference fit; check workplace rules; avoid sleep-health claims, stimulant framing, and clinical equipment unless the recipient requested it.
- **Proposed sections:** Map the overnight routine; before-shift preparation; meals and drinks during off-hours; the commute and transition home; daytime light and noise control; preference checks before buying.
- **Required product categories:** Daytime light control; daytime noise control; overnight meal support; stop-and-start drinkware; commute/shift organization; off-shift decompression that is not clinical gear.
- **Catalog products that may be reused:** `product_sleep-mask`, `product_lunch-container`, `product_insulated-tumbler`, and `product_shift-tote`. All already appear in the practical guide, so no more than the needed bridge items should be reused and every recommendation needs a night-shift-specific rationale.
- **Product gaps:** A verified daytime noise-control option; a room-rest option beyond a wearable mask; an off-shift transition or decompression option; enough night-shift-specific coverage to prevent the product mix from duplicating `guide_nurse-practical`; launch-ready sources and destinations.
- **Expected internal links:** The hub; `guide_nurse-practical` for schedule-neutral utility; `guide_nurse-under-25` for budget alternatives. Later hub placement should use a work-context group created through the normal hub draft workflow.
- **Similarity risk:** The current practical guide already names night shift in taxonomy and recommends the sleep mask. If new coverage cannot produce at least two materially distinct night-shift categories, this intent belongs as a practical-guide section rather than a new page.

## Phase 3.3 implementation record: Night-shift nurse gifts

The approved night-shift brief was taken through the existing Studio GuideDraft workflow on 2026-08-09. The new stable guide ID is `guide_nurse-night-shift`; the working slug remains `night-shift`, so the intended route remains `/nurse-gifts/night-shift/` without making the slug the record identity.

- **GuideDraft:** `drafts/guide_nurse-night-shift.json` (git-ignored working data).
- **Product-gap report:** `editorial-data/product-gaps/gap_nurse-night-shift.json`.
- **Primary axis:** `work-context`.
- **Primary intent:** Help a buyer choose gifts suited to meals, hydration, daytime sleep, commuting, and recovery around night shifts.
- **Draft coverage:** Four active catalog candidates have original night-shift-specific copy and remain `needs-review`: the sleep mask, lunch container, tumbler, and shift tote. The daytime-noise and off-shift-decompression slots are `unassigned` because the catalog has no distinct verified candidates for them.
- **Generation boundary:** The first-stage outline is complete with six stable slots. The existing final-generation stage was not run because two required slots are unassigned and the four selected candidates still need product review.
- **Publication decision:** Blocked. The four candidates have no stored `verifiedFacts`, `lastCheckedAt`, or product-source records; all destinations are demo URLs; and two required categories remain unassigned.
- **Public-content decision:** No `content/guides/` file, hub navigation group, public route output, or reciprocal public link was written. The existing hub continues to link only to published guides.

The draft keeps `guide_nurse-practical` as the schedule-neutral comparison and `guide_nurse-under-25` as the budget comparison. Those links remain draft-only until the missing categories and product review gates are cleared. Reused products keep their stable catalog IDs and are not treated as new night-shift-specific products.

## Approved brief 4: Christmas gifts for nurses

- **Working title and slug:** "Thoughtful Christmas Gifts for Nurses"; `christmas`.
- **Primary axis:** `occasion`.
- **Primary intent:** Help someone choose a Christmas gift for a nurse that fits the relationship, holiday timing, and the recipient's real preferences instead of defaulting to seasonal nurse merchandise.
- **Target audience:** Family, friends, partners, and coworkers planning an individual or small-group Christmas gift.
- **Buying problem solved:** The buyer needs to balance warmth, budget, delivery timing, workplace norms, dietary or personal preferences, and how well they know the recipient.
- **Distinctive editorial criteria:** Organize choices by relationship and holiday-giving situation; include order-by and return considerations only when verified; distinguish individual from team gifts; favor off-shift interests and consumable/flexible options; avoid generic slogans, unverified delivery promises, and Christmas-only relabeling of the evergreen hub.
- **Proposed sections:** Choose by relationship; small colleague gestures; useful winter/off-shift comfort; gifts for someone you know well; flexible or consumable choices; holiday timing, delivery, and returns checklist.
- **Required product categories:** Small colleague gift; shareable or consumable option; cozy off-shift comfort; practical individual gift; flexible gift card; interest-led non-work gift.
- **Catalog products that may be reused:** `product_coffee-card`, `product_hand-cream`, `product_sleep-mask`, `product_insulated-tumbler`, `product_compression-socks`, and `product_pocket-notebook`, subject to preference, fit, price, source, and destination verification.
- **Product gaps:** A verified shareable/consumable option with relevant dietary or allergen facts; an interest-led product unrelated to nursing; verified holiday delivery/return facts where editorially needed; launch-ready sources and destinations.
- **Expected internal links:** The hub; `guide_nurse-under-25` for smaller exchanges; `guide_nurse-practical` for recipients who prefer utility. Later hub placement can reuse `group_by-occasion` only after its milestone-specific label is broadened.
- **Similarity risk:** It becomes the general hub with seasonal wrapping if the occasion changes only the introduction. Keep selection logic tied to relationship, exchange size, recipient preference, and verified holiday ordering constraints.

## Recommended implementation order

| Order | Brief            | Why this order                                                                                             | Gate before GuideDraft publication work                                                                  |
| ----- | ---------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1     | Nursing students | Clearest new career-stage intent and the strongest compatible catalog coverage.                            | Verify program-sensitive facts, fill the planning/recovery gaps, and replace demo destinations.          |
| 2     | Christmas        | Distinct occasion and a fixed seasonal editorial deadline; several evergreen candidates can be reassessed. | Add consumable and interest-led coverage, then verify holiday-sensitive facts close to publication.      |
| 3     | Night shift      | Valid work-context intent, but the current reusable mix overlaps heavily with practical.                   | Add at least two materially distinct night-shift categories or keep the need inside the practical guide. |
| 4     | Personalized     | Strong intent in principle but zero current products have stored customization facts.                      | Establish verified multi-category customization coverage before drafting recommendations.                |

For each later guide: close product gaps with the existing manual product-intake and source-provenance workflows; run affiliate intake and QA; create the GuideDraft in the existing Studio; preview and publish atomically; then update the hub through its existing draft/publication flow. This order does not authorize any of those later changes.

## Route and output verification

The shared `guidePath()` helper produced all four proposed paths. Each slug matches the canonical slug pattern, is absent from `RESERVED_PUBLIC_PATHS`, and collides with neither the three current Nurse Gifts slugs nor their routes.

| Slug               | Canonical proposed route         | Valid | Reserved | Existing collision |
| ------------------ | -------------------------------- | ----- | -------- | ------------------ |
| `nursing-students` | `/nurse-gifts/nursing-students/` | Yes   | No       | No                 |
| `personalized`     | `/nurse-gifts/personalized/`     | Yes   | No       | No                 |
| `night-shift`      | `/nurse-gifts/night-shift/`      | Yes   | No       | No                 |
| `christmas`        | `/nurse-gifts/christmas/`        | Yes   | No       | No                 |

The personalized path was also checked with the shared route helper and remains collision-free. Because its GuideDraft is blocked before publication, `apps/site/dist/nurse-gifts/personalized/index.html` was not generated and the hub contains no link to it.

The night-shift path was also checked with the shared route helper and remains collision-free. Because its GuideDraft is blocked before publication, `apps/site/dist/nurse-gifts/night-shift/index.html` was not generated and the hub contains no link to it.

Baseline checks passed before documentation changes:

- `npm run content:validate`: 11 products, 1 cluster, and 3 guides.
- `npm run build`: 9 static pages, including only the hub and the three existing Nurse Gifts child routes.
- Baseline `apps/site/dist/`: 14 files with composite SHA-256 `36E4729DAC7F47228DBB46D8B07E073C65C2884D176D8129DFDEE55A873492B5`.

The Phase 3.0 final `npm run verify` reproduced that 14-file public artifact and composite hash. At that point, only this roadmap and `docs/progress.md` changed; Phases 3.2 and 3.3 add blocked product-gap reports while keeping their ignored drafts and public content out of the artifact.
