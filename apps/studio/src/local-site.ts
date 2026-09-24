import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

import { guidePath, type GiftGuide } from "@the-good-present/content-schema";

import type { GuideDraft } from "./drafts.ts";
import type { ManualReviewRecord } from "./manual-review.ts";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function within(root: string, path: string): string {
  const result = resolve(root, path);
  const remainder = relative(root, result);
  if (remainder === ".." || remainder.startsWith(`..${sep}`)) {
    throw new TypeError("Ruta local no válida.");
  }
  return result;
}

function routeParts(pathname: string, prefix: string): string[] {
  if (!pathname.startsWith(prefix)) throw new TypeError("Ruta local no válida.");
  const parts = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "..")) {
    throw new TypeError("Ruta local no válida.");
  }
  return parts;
}

export function localGuideForPath(
  pathname: string,
  guides: readonly GiftGuide[],
  clusters: readonly { id: string; slug: string }[],
): GiftGuide | undefined {
  const route = pathname.replace(/^\/local/, "");
  return guides.find((guide) => {
    const cluster = clusters.find((item) => item.id === guide.clusterId);
    return cluster && guidePath(cluster.slug, guide.slug) === route;
  });
}

export async function localPublicAsset(
  repositoryRoot: string,
  pathname: string,
): Promise<{ body: Buffer; contentType: string }> {
  const parts = routeParts(pathname, "/local-assets/");
  if (!parts.length || !["_astro", "images"].includes(parts[0]!)) {
    throw new TypeError("Solo se sirven recursos públicos del sitio.");
  }
  const root = resolve(repositoryRoot, "apps/site/dist");
  const file = within(root, parts.join("/"));
  return {
    body: await readFile(file),
    contentType: mimeTypes[extname(file)] ?? "application/octet-stream",
  };
}

export async function localPublicPage(
  repositoryRoot: string,
  pathname: string,
  guide?: GiftGuide,
  draft?: GuideDraft,
  records: readonly ManualReviewRecord[] = [],
): Promise<string> {
  const parts = routeParts(pathname, "/local/");
  const root = resolve(repositoryRoot, "apps/site/dist");
  const file = within(root, [...parts, "index.html"].join("/"));
  let html: string;
  try {
    html = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TypeError("La copia local no está generada. Ejecutá npm run build una vez.");
    }
    throw error;
  }
  const payload = JSON.stringify({
    guideId: guide?.id,
    originalRecommendations: guide?.recommendations.map(
      ({ id, position, productId, directAffiliateUrl }) => ({
        id,
        position,
        productId,
        directAffiliateUrl,
      }),
    ),
    draft,
    records,
  }).replaceAll("<", "\\u003c");
  const toolbar = `<div id="local-review-root"></div><script type="application/json" id="local-review-data">${payload}</script><script src="/local-review.js" defer></script>`;
  return html
    .replace(/\b(href|src)="\/([^"]*)"/g, (_match, attr: string, target: string) => {
      const prefix =
        target.startsWith("_astro/") || target.startsWith("images/") ? "/local-assets/" : "/local/";
      return `${attr}="${prefix}${target}"`;
    })
    .replace(
      "</head>",
      '<meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/local-review.css"></head>',
    )
    .replace("</body>", `${toolbar}</body>`);
}
