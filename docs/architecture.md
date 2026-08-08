# Architecture

## Concise contract

The Good Present is a static publishing system with three version-controlled public record types: products, cluster hubs, and gift guides. JSON files under `content/` are the canonical published source. A small TypeScript package owns the public schemas, cross-record validation, error formatting, and route helpers. The Astro site reads those records at build time and produces static assets only.

```text
content/*.json -> packages/content-schema -> apps/site -> apps/site/dist
                              ^
                              |
                    future local Studio
```

The future Studio can manage richer drafts locally, but publication is a one-way boundary: it must write only records accepted by the public package. Draft-only metadata must never enter `content/`.

## Repository structure

```text
/
|-- apps/
|   `-- site/                 static Astro public site
|-- packages/
|   `-- content-schema/       canonical public contract
|-- content/
|   |-- products/             one file per stable product ID
|   |-- clusters/             one file per stable cluster ID
|   `-- guides/               one file per stable guide ID
|-- scripts/                  repository-level read-only content tooling
|-- docs/
|-- .github/workflows/
|-- package.json
`-- README.md
```

The shared package remains independent of Astro and UI code. Repository tooling may read files and pass source-aware records into its pure validation functions; the package itself does not write files, run servers, access databases, perform HTTP requests, or operate Git.

## Page types

| Type          | Responsibility                                                                                | Product list                                   |
| ------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `cluster-hub` | Introduce one coherent cluster and curate navigation to published child guides                | Optional; not required for the MVP             |
| `gift-guide`  | Resolve one differentiated intent with an explicit primary axis and editorial recommendations | Required and references catalog products by ID |

A hub group is an editorial navigation choice, not a taxonomy result. It may reuse a guide in multiple groups, may only contain guides in its own cluster, and creates no route of its own. Empty groups do not render.

## Identity and routes

Every product, cluster, and guide has a stable unique `id`. Canonical JSON filenames equal that stable ID. A slug is editable public routing data; changing it does not rename the canonical file or change record identity.

Pure functions in `packages/content-schema/` are the only route constructors used by the public site and future Studio:

```text
clusterPath(clusterSlug)             -> /{clusterSlug}/
guidePath(clusterSlug, guideSlug)    -> /{clusterSlug}/{guideSlug}/
canonicalUrl(site, publicPath)       -> absolute canonical URL
```

The initial routes are:

```text
/
/gift-guides/
/nurse-gifts/
/nurse-gifts/graduation/
/nurse-gifts/practical/
/nurse-gifts/under-25/
/about/
/affiliate-disclosure/
/404.html
```

`about`, `affiliate-disclosure`, `gift-guides`, `404.html`, and the empty root segment are reserved. Cluster slugs cannot collide with them. Guide slugs are unique within a cluster. No nested faceted route is supported.

## Editorial axes and taxonomies

Each guide selects exactly one controlled primary axis:

```text
general | occasion | recipient | career-stage | work-context | gift-style | budget
```

`primaryIntent` states the differentiated reader need in plain language. Secondary occasions, recipients, career stages, work contexts, gift styles, and budget labels help describe or navigate content; they never generate routes. In particular, `/nurse-gifts/under-25/` is a curated gift guide with a USD maximum of 25, not a filtered catalog view.

## Rule for creating a public URL

A new public page exists only when all of these are true:

1. It represents a clearly differentiated user intent.
2. It can use distinct editorial criteria.
3. It can contain materially differentiated products or recommendations.
4. It answers the need better than a section inside an existing page.
5. It is not merely a keyword permutation.
6. It can support substantial editorial content.

Software must never create a route merely because tags or taxonomy values exist.

## Build and deployment boundary

The public app uses Astro strict TypeScript and static output. Content validation runs independently and when Astro loads its configuration, so invalid public records cannot build or deploy. The exact public build command is `npm run build`; output is `apps/site/dist/`. GitHub Pages receives only that static directory. No server runtime, API route, AI credential, database, or Studio process is involved.

`npm run verify` checks formatting, strict TypeScript and Astro diagnostics, unit tests, content through the build boundary, and the production build. The public `site` is `https://thegoodpresent.com`; canonical metadata and sitemap URLs use centralized public paths from the shared package.

## GitHub Pages and custom domain

`.github/workflows/deploy-pages.yml` runs on pushes to `main` and manual dispatch. It installs with `npm ci`, then runs content validation, formatting checks, type checking, tests, and the public build in separate steps. It verifies and uploads `apps/site/dist/`, then deploys the artifact with GitHub's official Pages actions.

`apps/site/public/CNAME` contains `thegoodpresent.com` and Astro copies it into the built artifact. GitHub's custom Actions publishing flow treats the custom-domain value in repository Pages settings as authoritative and may ignore an artifact `CNAME`; the file remains part of this contract because the MVP explicitly requires it and because it makes the intended domain visible in the static output.

Initial repository-owner setup:

1. In **Settings → Pages**, choose **GitHub Actions** as the publishing source.
2. Verify ownership of `thegoodpresent.com` in GitHub before use.
3. Add `thegoodpresent.com` as the custom domain in Pages settings.
4. Configure the apex DNS records supported by the DNS provider using GitHub's current custom-domain instructions; avoid wildcard DNS records.
5. Optionally configure `www` as GitHub recommends for the apex-domain variant.
6. Enable **Enforce HTTPS** once DNS and certificate provisioning complete.

DNS values can change, so this repository intentionally does not duplicate IP addresses. Use GitHub's current [custom-domain documentation](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) when configuring DNS.

## Future compatibility

### Editorial Studio

The Studio may later add Spanish-language interface copy and draft schemas. It must keep stable IDs, call the shared route helpers, and publish only schema-version-1 `en-US` records accepted by the canonical package. Public slugs remain editable independently of IDs. Draft review state, prompts, provider output, brainstorming, and operational metadata stay outside canonical public files.

### Localization

Public records carry an explicit `language` value so later schema versions can evolve deliberately. This MVP publishes only `en-US`; it does not add Spanish routes or `hreflang`.

### Redirects

No redirect schema, directory, fixture, validator, page, stub, or management UI exists in this stage. A later iteration may map an old internal path to the closest canonical replacement when a published slug changes. That implementation must reject chains, loops, external targets, and unrelated homepage fallbacks.

GitHub Pages cannot configure server-side HTTP status redirects, and static HTML redirect pages are not equivalent to HTTP 301 responses. True status-code redirects may require different hosting. Stable IDs and centralized route construction preserve enough information for that future work without implementing it now.

## Explicit exclusions

The MVP excludes the local Studio, AI generation, brainstorming, legacy-content migration, authentication, databases, CMS integration, product imports, production API routes, redirect infrastructure, public search, facets, accounts, comments, wish lists, carts, product-detail pages, programmatic taxonomy pages, non-nurse clusters, and Spanish public pages.
