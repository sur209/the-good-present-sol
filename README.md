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

## Local commands

Use Node 22.12 or newer and npm 9.6.5 or newer:

```sh
npm install
npm run dev
```

The root workspace commands are:

| Command                    | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `npm run dev`              | Start the public Astro site locally                             |
| `npm run build`            | Validate content and build static assets into `apps/site/dist/` |
| `npm run preview`          | Preview the built public site                                   |
| `npm run typecheck`        | Check all TypeScript and Astro files                            |
| `npm run test`             | Run workspace tests                                             |
| `npm run content:validate` | Validate all canonical public content                           |
| `npm run format`           | Format tracked source files                                     |
| `npm run format:check`     | Check formatting without changes                                |
| `npm run verify`           | Run the important non-interactive checks and production build   |

No globally installed command is required. The Astro launcher disables framework telemetry for deterministic local and CI execution; it does not change any user-level Astro setting.

## Deliberate MVP boundary

This stage does not include an Editorial Studio, AI generation, brainstorming, legacy migration, authentication, a database, product imports, a CMS, public search or filters, accounts, comments, wish lists, carts, product-detail pages, localization routes, or redirects.
