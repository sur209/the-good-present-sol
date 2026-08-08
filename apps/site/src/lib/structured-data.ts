import {
  canonicalUrl,
  clusterPath,
  guidePath,
  type ClusterHub,
  type GiftGuide,
} from "@the-good-present/content-schema";

interface BreadcrumbEntry {
  name: string;
  path: string;
}

export function breadcrumbStructuredData(site: URL, entries: BreadcrumbEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      item: canonicalUrl(site, entry.path),
    })),
  };
}

export function websiteStructuredData(site: URL) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "The Good Present",
    url: canonicalUrl(site, "/"),
    inLanguage: "en-US",
    description: "Human-edited gift guides for people who show up for others.",
  };
}

export function clusterStructuredData(site: URL, cluster: ClusterHub, guides: GiftGuide[]) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: cluster.title,
    description: cluster.seoDescription,
    url: canonicalUrl(site, clusterPath(cluster.slug)),
    inLanguage: cluster.language,
    datePublished: cluster.publishedAt,
    dateModified: cluster.updatedAt ?? cluster.publishedAt,
    isPartOf: {
      "@type": "WebSite",
      name: "The Good Present",
      url: canonicalUrl(site, "/"),
    },
    hasPart: guides.map((guide) => ({
      "@type": "Article",
      headline: guide.title,
      description: guide.excerpt,
      url: canonicalUrl(site, guidePath(cluster.slug, guide.slug)),
    })),
  };
}

export function guideStructuredData(site: URL, cluster: ClusterHub, guide: GiftGuide) {
  const url = canonicalUrl(site, guidePath(cluster.slug, guide.slug));
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: guide.title,
    description: guide.seoDescription,
    url,
    mainEntityOfPage: url,
    inLanguage: guide.language,
    datePublished: guide.publishedAt,
    dateModified: guide.updatedAt ?? guide.publishedAt,
    publisher: {
      "@type": "Organization",
      name: "The Good Present",
      url: canonicalUrl(site, "/"),
    },
    author: {
      "@type": "Organization",
      name: "The Good Present",
    },
    isPartOf: {
      "@type": "CollectionPage",
      name: cluster.title,
      url: canonicalUrl(site, clusterPath(cluster.slug)),
    },
  };
}
