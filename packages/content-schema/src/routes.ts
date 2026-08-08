export const PUBLIC_PATHS = {
  home: "/",
  giftGuides: "/gift-guides/",
  about: "/about/",
  affiliateDisclosure: "/affiliate-disclosure/",
  notFound: "/404.html",
} as const;

export const RESERVED_PUBLIC_PATHS = [
  "",
  "about",
  "affiliate-disclosure",
  "gift-guides",
  "404.html",
] as const;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

function requireSlug(value: string, label: string): string {
  if (!isValidSlug(value)) {
    throw new TypeError(`${label} must be a lowercase URL-safe slug; received "${value}".`);
  }

  return value;
}

export function clusterPath(clusterSlug: string): string {
  const slug = requireSlug(clusterSlug, "Cluster slug");

  if ((RESERVED_PUBLIC_PATHS as readonly string[]).includes(slug)) {
    throw new TypeError(`Cluster slug "${slug}" collides with a reserved public path.`);
  }

  return `/${slug}/`;
}

export function guidePath(clusterSlug: string, guideSlug: string): string {
  return `${clusterPath(clusterSlug)}${requireSlug(guideSlug, "Guide slug")}/`;
}

export function canonicalUrl(site: string | URL, publicPath: string): string {
  const origin = new URL(site);

  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new TypeError(`Site URL must use http or https; received "${origin.protocol}".`);
  }

  if (!publicPath.startsWith("/") || publicPath.startsWith("//")) {
    throw new TypeError(`Public path must be root-relative; received "${publicPath}".`);
  }

  return new URL(publicPath, origin).toString();
}
