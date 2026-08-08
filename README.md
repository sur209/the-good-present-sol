# The Good Present

The Good Present is a warm, editorial gift-guide site for United States readers. This repository will contain the static Astro public site and the versioned content contract that a future local Editorial Studio must publish against.

The first vertical slice is the **Nurse Gifts** cluster. Published content is natural US English, budgets use USD, and purchases happen on external merchant sites.

## Architecture contract

- `content/products/` stores one catalog product per stable product ID.
- `content/clusters/` stores one published cluster hub per stable cluster ID.
- `content/guides/` stores one published gift guide per stable guide ID.
- `packages/content-schema/` is the only canonical public schema, validation, and route-building package.
- `apps/site/` is a static Astro consumer of validated public content.
- Stable IDs are record identity. Editable slugs are routing fields and never determine canonical filenames.
- Tags and taxonomies are metadata only. They never create public routes.
- The future Editorial Studio may add draft-only models, but it may publish only records accepted by the canonical public schemas.

The implementation is proceeding through the phases recorded in [docs/progress.md](docs/progress.md).

## Deliberate MVP boundary

This stage does not include an Editorial Studio, AI generation, brainstorming, legacy migration, authentication, a database, product imports, a CMS, public search or filters, accounts, comments, wish lists, carts, product-detail pages, localization routes, or redirects.

