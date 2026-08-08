import { resolve } from "node:path";

import { assertValidPublicContent, type PrimaryAxis } from "@the-good-present/content-schema";

import { readPublicContentSources } from "../../../../scripts/content-files.js";

// The override lets Studio publication tests build isolated canonical content without touching the repo.
const repositoryRoot = process.env.CONTENT_REPOSITORY_ROOT
  ? resolve(process.env.CONTENT_REPOSITORY_ROOT)
  : resolve(process.cwd(), "../..");
export const content = assertValidPublicContent(readPublicContentSources(repositoryRoot));
export const productsById = new Map(content.products.map((product) => [product.id, product]));
export const clustersById = new Map(content.clusters.map((cluster) => [cluster.id, cluster]));
export const guidesById = new Map(content.guides.map((guide) => [guide.id, guide]));

export const primaryAxisLabels: Record<PrimaryAxis, string> = {
  general: "General guide",
  occasion: "By occasion",
  recipient: "By recipient",
  "career-stage": "By career stage",
  "work-context": "By work context",
  "gift-style": "By gift style",
  budget: "By budget",
};

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
