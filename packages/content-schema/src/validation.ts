import type { z } from "zod";

import { RESERVED_PUBLIC_PATHS } from "./routes.js";
import {
  clusterHubSchema,
  giftGuideSchema,
  productSchema,
  type ClusterHub,
  type GiftGuide,
  type Product,
} from "./schemas.js";

export interface SourceRecord {
  file: string;
  data: unknown;
  readError?: string;
}

export interface PublicContentSources {
  products: SourceRecord[];
  clusters: SourceRecord[];
  guides: SourceRecord[];
}

export interface ValidationIssue {
  file: string;
  recordId: string;
  field: string;
  reason: string;
}

export interface ValidatedPublicContent {
  products: Product[];
  clusters: ClusterHub[];
  guides: GiftGuide[];
}

export type ValidationResult =
  { success: true; data: ValidatedPublicContent } | { success: false; issues: ValidationIssue[] };

interface LocatedRecord<T> {
  file: string;
  record: T;
}

function recordId(data: unknown): string {
  if (typeof data === "object" && data !== null && "id" in data && typeof data.id === "string") {
    return data.id || "<unknown>";
  }

  return "<unknown>";
}

function fieldPath(path: PropertyKey[]): string {
  if (path.length === 0) return "$record";

  return path.reduce<string>(
    (field, segment) =>
      typeof segment === "number"
        ? `${field}[${segment}]`
        : field
          ? `${field}.${String(segment)}`
          : String(segment),
    "",
  );
}

function parseRecords<T>(
  sources: SourceRecord[],
  schema: z.ZodType<T>,
  issues: ValidationIssue[],
): LocatedRecord<T>[] {
  const records: LocatedRecord<T>[] = [];

  for (const source of sources) {
    const id = recordId(source.data);

    if (source.readError) {
      issues.push({ file: source.file, recordId: id, field: "$file", reason: source.readError });
      continue;
    }

    const parsed = schema.safeParse(source.data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          file: source.file,
          recordId: id,
          field: fieldPath(issue.path),
          reason: issue.message,
        });
      }
      continue;
    }

    records.push({ file: source.file, record: parsed.data });
  }

  return records;
}

function addDuplicateIssues<T>(
  records: LocatedRecord<T>[],
  value: (record: T) => string,
  recordIdValue: (record: T) => string,
  field: string,
  label: string,
  issues: ValidationIssue[],
): void {
  const seen = new Map<string, string>();

  for (const located of records) {
    const current = value(located.record);
    const firstFile = seen.get(current);
    if (firstFile) {
      issues.push({
        file: located.file,
        recordId: recordIdValue(located.record),
        field,
        reason: `Duplicate ${label} "${current}"; first declared in ${firstFile}.`,
      });
    } else {
      seen.set(current, located.file);
    }
  }
}

function indexFirstById<T extends { id: string }>(records: LocatedRecord<T>[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const { record } of records) {
    if (!index.has(record.id)) index.set(record.id, record);
  }
  return index;
}

function fileStem(file: string): string {
  return (file.replaceAll("\\", "/").split("/").at(-1) ?? file).replace(/\.json$/i, "");
}

function validateFilenames<T extends { id: string }>(
  records: LocatedRecord<T>[],
  issues: ValidationIssue[],
): void {
  for (const { file, record } of records) {
    const stem = fileStem(file);
    if (stem !== record.id) {
      issues.push({
        file,
        recordId: record.id,
        field: "$file",
        reason: `Canonical filename must be "${record.id}.json" because files are named by stable ID, not slug; received "${stem}.json".`,
      });
    }
  }
}

function validateClusterRelations(
  clusters: LocatedRecord<ClusterHub>[],
  guidesById: Map<string, GiftGuide>,
  issues: ValidationIssue[],
): void {
  for (const { file, record: cluster } of clusters) {
    const groupIds = new Set<string>();

    cluster.navigationGroups.forEach((group, groupIndex) => {
      if (groupIds.has(group.id)) {
        issues.push({
          file,
          recordId: cluster.id,
          field: `navigationGroups[${groupIndex}].id`,
          reason: `Duplicate navigation group ID "${group.id}" in this hub.`,
        });
      }
      groupIds.add(group.id);

      const guideIds = new Set<string>();
      group.guideIds.forEach((guideId, guideIndex) => {
        const field = `navigationGroups[${groupIndex}].guideIds[${guideIndex}]`;
        if (guideIds.has(guideId)) {
          issues.push({
            file,
            recordId: cluster.id,
            field,
            reason: `Duplicate guide ID "${guideId}" in this navigation group.`,
          });
        }
        guideIds.add(guideId);

        const guide = guidesById.get(guideId);
        if (!guide) {
          issues.push({
            file,
            recordId: cluster.id,
            field,
            reason: `Hub references nonexistent published guide "${guideId}".`,
          });
        } else if (guide.clusterId !== cluster.id) {
          issues.push({
            file,
            recordId: cluster.id,
            field,
            reason: `Guide "${guideId}" belongs to cluster "${guide.clusterId}", not "${cluster.id}".`,
          });
        }
      });
    });
  }
}

function validateGuideRelations(
  guides: LocatedRecord<GiftGuide>[],
  clustersById: Map<string, ClusterHub>,
  guidesById: Map<string, GiftGuide>,
  productsById: Map<string, Product>,
  issues: ValidationIssue[],
): void {
  for (const { file, record: guide } of guides) {
    if (!clustersById.has(guide.clusterId)) {
      issues.push({
        file,
        recordId: guide.id,
        field: "clusterId",
        reason: `Guide references nonexistent published cluster "${guide.clusterId}".`,
      });
    }

    const relatedIds = new Set<string>();
    (guide.relatedGuideIds ?? []).forEach((relatedId, index) => {
      const field = `relatedGuideIds[${index}]`;
      if (relatedIds.has(relatedId)) {
        issues.push({
          file,
          recordId: guide.id,
          field,
          reason: `Duplicate related guide ID "${relatedId}".`,
        });
      }
      relatedIds.add(relatedId);

      if (relatedId === guide.id) {
        issues.push({
          file,
          recordId: guide.id,
          field,
          reason: "A guide cannot relate to itself.",
        });
        return;
      }

      const related = guidesById.get(relatedId);
      if (!related) {
        issues.push({
          file,
          recordId: guide.id,
          field,
          reason: `Related guide "${relatedId}" does not exist or is not published.`,
        });
      } else if (related.clusterId !== guide.clusterId) {
        issues.push({
          file,
          recordId: guide.id,
          field,
          reason: `Related guide "${relatedId}" belongs to cluster "${related.clusterId}", not "${guide.clusterId}".`,
        });
      }
    });

    const recommendationIds = new Set<string>();
    const positions = new Set<number>();
    guide.recommendations.forEach((recommendation, index) => {
      if (recommendationIds.has(recommendation.id)) {
        issues.push({
          file,
          recordId: guide.id,
          field: `recommendations[${index}].id`,
          reason: `Duplicate recommendation ID "${recommendation.id}" in this guide.`,
        });
      }
      recommendationIds.add(recommendation.id);

      if (positions.has(recommendation.position)) {
        issues.push({
          file,
          recordId: guide.id,
          field: `recommendations[${index}].position`,
          reason: `Duplicate recommendation position ${recommendation.position} in this guide.`,
        });
      }
      positions.add(recommendation.position);

      const product = productsById.get(recommendation.productId);
      if (!product) {
        issues.push({
          file,
          recordId: guide.id,
          field: `recommendations[${index}].productId`,
          reason: `Recommendation references nonexistent product "${recommendation.productId}".`,
        });
      } else if (product.status !== "active") {
        issues.push({
          file,
          recordId: guide.id,
          field: `recommendations[${index}].productId`,
          reason: `Published guide references inactive product "${recommendation.productId}".`,
        });
      }
    });
  }
}

export function validatePublicContent(sources: PublicContentSources): ValidationResult {
  const issues: ValidationIssue[] = [];
  const products = parseRecords(sources.products, productSchema, issues);
  const clusters = parseRecords(sources.clusters, clusterHubSchema, issues);
  const guides = parseRecords(sources.guides, giftGuideSchema, issues);

  validateFilenames(products, issues);
  validateFilenames(clusters, issues);
  validateFilenames(guides, issues);

  addDuplicateIssues(
    products,
    (record) => record.id,
    (record) => record.id,
    "id",
    "product ID",
    issues,
  );
  addDuplicateIssues(
    clusters,
    (record) => record.id,
    (record) => record.id,
    "id",
    "cluster ID",
    issues,
  );
  addDuplicateIssues(
    guides,
    (record) => record.id,
    (record) => record.id,
    "id",
    "guide ID",
    issues,
  );
  addDuplicateIssues(
    clusters,
    (record) => record.slug,
    (record) => record.id,
    "slug",
    "cluster slug",
    issues,
  );
  addDuplicateIssues(
    guides,
    (record) => `${record.clusterId}/${record.slug}`,
    (record) => record.id,
    "slug",
    "guide slug inside its cluster",
    issues,
  );

  for (const { file, record } of clusters) {
    if ((RESERVED_PUBLIC_PATHS as readonly string[]).includes(record.slug)) {
      issues.push({
        file,
        recordId: record.id,
        field: "slug",
        reason: `Cluster slug "${record.slug}" collides with a reserved public path.`,
      });
    }
  }

  const productsById = indexFirstById(products);
  const clustersById = indexFirstById(clusters);
  const guidesById = indexFirstById(guides);
  validateClusterRelations(clusters, guidesById, issues);
  validateGuideRelations(guides, clustersById, guidesById, productsById, issues);

  if (issues.length > 0) return { success: false, issues };

  return {
    success: true,
    data: {
      products: products.map(({ record }) => record),
      clusters: clusters.map(({ record }) => record),
      guides: guides.map(({ record }) => record),
    },
  };
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  const label = issues.length === 1 ? "error" : "errors";
  return [
    `Public content validation failed with ${issues.length} ${label}:`,
    ...issues.map(
      ({ file, recordId: id, field, reason }) =>
        `- ${file} :: record "${id}" :: ${field}: ${reason}`,
    ),
  ].join("\n");
}

export class ContentValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(formatValidationIssues(issues));
    this.name = "ContentValidationError";
    this.issues = issues;
  }
}

export function assertValidPublicContent(sources: PublicContentSources): ValidatedPublicContent {
  const result = validatePublicContent(sources);
  if (!result.success) throw new ContentValidationError(result.issues);
  return result.data;
}
