# Affiliate operations contract

Affiliate operations are local editorial tooling. They do not create links, call merchant APIs, scrape pages, import reports, or publish public content.

## Boundaries

- Public products remain the only source for merchant-facing fields and URLs.
- Guides reference products by stable `productId`; they never carry `productUrl`, `affiliateUrl`, tracking IDs, or account identifiers.
- `productDestination(product)` in `packages/content-schema/` resolves a valid `affiliateUrl` first and a valid ordinary `productUrl` second.
- Astro renders direct external anchors. There is no internal redirect or outbound URL proxy.
- Product URLs are validated as absolute HTTP(S) values before they enter the canonical content graph.
- Guide publication still goes through the existing Studio Goal 2 publication boundary.

## Link behavior

| Catalog state                        | Public result                 | Relation and label                        |
| ------------------------------------ | ----------------------------- | ----------------------------------------- |
| Valid `affiliateUrl`                 | Uses the affiliate URL        | `sponsored nofollow noopener`, “View at…” |
| No affiliate URL, valid `productUrl` | Uses the ordinary product URL | `nofollow noopener`, “View product at…”   |
| Neither URL is valid                 | No merchant CTA               | No outbound anchor                        |

All merchant links use `target="_blank"` and `rel` values containing `noopener`. The link is direct and the merchant is named in the visible label. Demo `example.com` destinations are labeled as demonstrations and are not launch-ready shopping links.

AI receives selected product context without either URL field. Strict generated-response schemas reject extra URL fields, generated copy rejects URLs, and the draft-to-public transform constructs recommendations without any product or affiliate fields. Product selection and affiliate URL editing remain separate manual Studio actions.

## Internal program records

Records live at `editorial-data/affiliate-programs/{record-id}.json` and are read only by `apps/studio/src/modules/affiliate-operations/`. The local schema is intentionally owned by that Studio module because no public runtime consumes it.

Each record may contain:

```json
{
  "id": "amazon-us",
  "programId": "amazon-associates",
  "marketplace": "amazon.com",
  "storeOrAssociateId": "editorial-account-id",
  "allowedTrackingIds": ["approved-tag"],
  "disclosureText": "The Good Present may earn a commission from qualifying purchases made through merchant links.",
  "disclosureVersion": "2026-08-08",
  "enabled": false
}
```

The committed seed record deliberately omits the store/associate identifier and tracking IDs until an editor has verified them. The Studio page at `/affiliate-programs` shows each record, enabled state, and missing configuration. It is read-only. Unknown credential fields such as API keys, tokens, passwords, or secrets are rejected by the strict schema; if a future program needs server credentials, they belong in the local server environment or a separately designed secret store, never in these records.

The current record is merchant-neutral at the contract level even though the seed status entry names Amazon as the first possible program. No Amazon integration or automatic link generation exists.

## Disclosure placement

The global disclosure is the public `/affiliate-disclosure/` page and its persistent footer link. A short near-link disclosure appears on a guide when at least one recommendation resolves to an affiliate URL. It explains the possible commission and that the merchant controls current product terms. Ordinary direct product links do not receive affiliate wording or the `sponsored` relation.

## Verification

From the repository root:

```sh
npm run content:validate
npm run typecheck
npm run test
npm run build
```

The tests cover central affiliate-first resolution, ordinary and missing destinations, safe target/rel attributes, strict AI URL boundaries, the Studio status page, and a static-output scan confirming that program identifiers do not enter Astro output.
