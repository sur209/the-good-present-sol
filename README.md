# The Good Present

The Good Present is a warm, editorial gift-guide site for United States readers. This repository contains the static Astro public site and the versioned content contract that a future local Editorial Studio must publish against.

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

## Repository map

```text
apps/site/                  Astro public site; static output in apps/site/dist/
packages/content-schema/    canonical Zod schemas, validation, types, and routes
content/products/           stable-ID-named product records
content/clusters/           stable-ID-named cluster-hub records
content/guides/             stable-ID-named published guide records
scripts/                    read-only content and Astro command tooling
docs/                       architecture, contract, and progress notes
.github/workflows/          GitHub Pages build and deployment
```

The current public slice is available at `/nurse-gifts/`, with graduation, practical, and under-$25 child guides. No taxonomy value creates a route automatically.

## Local commands

Use Node 22.12 or newer and npm 9.6.5 or newer. From a clean checkout:

```sh
npm ci
npm run dev
```

The development server prints the local URL. No database, credentials, globally installed package, or server runtime is required. Published records are read directly from `content/` and validated when Astro starts.

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

The Astro launcher disables framework telemetry for deterministic local and CI execution; it does not change any user-level Astro setting.

## Content and publication

Stable IDs identify records and name canonical files; slugs are editable route fields. See [docs/content-contract.md](docs/content-contract.md) before adding a product, hub, or guide, and run `npm run content:validate` after every content edit. The shared package is the publication boundary for the future local Studio.

Seed merchant destinations use visibly labeled `example.com` demo links. They demonstrate affiliate placement and must be replaced with verified editorial destinations before launch.

## Static deployment

`npm run build` validates content through the Astro build and writes only static assets to `apps/site/dist/`. The workflow in `.github/workflows/deploy-pages.yml` installs from `package-lock.json`, runs validation and all checks, builds only the public site, verifies `CNAME`, uploads that directory, and deploys it to GitHub Pages.

Before the first deployment, set the repository's **Settings → Pages → Source** to **GitHub Actions**, configure `thegoodpresent.com` as the custom domain, set the required DNS records with the domain provider, verify the domain, and enable HTTPS when GitHub makes the option available. See [docs/architecture.md](docs/architecture.md#github-pages-and-custom-domain) for the hosting boundary.

## Deliberate MVP boundary

This stage does not include an Editorial Studio, AI generation, brainstorming, legacy migration, authentication, a database, product imports, a CMS, public search or filters, accounts, comments, wish lists, carts, product-detail pages, localization routes, or redirects.
