import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  PRIMARY_AXES,
  primaryAxisSchema,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";
import { z } from "zod";

import type { GuideGenerationProvider } from "../../ai-provider.ts";
import type { EditorialDraft } from "../../drafts.ts";
import { atomicWriteJson } from "../../repository.ts";
import type { ProductCoverageAnalysis } from "../product-intelligence/coverage.ts";
import {
  ArticleCandidateStore,
  OPPORTUNITY_SESSION_MODES,
  articleCandidateSchema,
  candidateSectionsSchema,
  candidateTaxonomiesSchema,
  type ArticleCandidate,
} from "./candidates.ts";
import {
  compareArticleCandidate,
  normalizeComparisonText,
  type ApprovedEditorialBriefComparisonRecord,
  type OpportunityComparisonReport,
} from "./comparison.ts";

export const OPPORTUNITY_GENERATION_PROMPT_VERSION = "opportunity-divergent-v2";
export const DEFAULT_OPPORTUNITY_CANDIDATE_COUNT = 20;
export const MAX_OPPORTUNITY_CANDIDATE_COUNT = 50;
export const OPPORTUNITY_GENERATION_SESSIONS_DIRECTORY =
  "editorial-data/opportunity-generation-sessions";

export const OPPORTUNITY_SESSION_OBJECTIVES = [
  "expand-cluster",
  "find-missing-intents",
  "find-seasonal-opportunities",
  "find-section-opportunities",
  "reuse-existing-products",
  "review-cannibalization",
  "find-localization-candidates",
] as const;

const nonEmptyText = z.string().trim().min(1);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const productId = safeId.regex(/^product_/);
const categoryId = safeId.regex(/^category_/);
const coverageSignalId = safeId.regex(/^coverage_/);

const sourceCategorySchema = z.strictObject({ id: categoryId, label: nonEmptyText });
const sourceProductSchema = z.strictObject({
  id: productId,
  name: nonEmptyText,
  status: z.enum(["active", "inactive"]),
  categories: z.array(sourceCategorySchema),
});

export const opportunityCoverageSignalSchema = z.strictObject({
  id: coverageSignalId,
  kind: z.enum([
    "active-product-unused",
    "product-reused",
    "substantial-category",
    "single-product-category",
    "low-cluster-diversity",
    "broad-product-metadata",
    "draft-slot-gap",
    "brief-requirement-gap",
  ]),
  summary: nonEmptyText,
  sourceProductIds: z.array(productId),
  sourceCategories: z.array(sourceCategorySchema),
});

export type OpportunityCoverageSignal = z.infer<typeof opportunityCoverageSignalSchema>;

export const importedSignalSummarySchema = z.strictObject({
  id: safeId,
  provenanceLabel: nonEmptyText,
  summary: nonEmptyText,
});

export const opportunityGenerationRequestSchema = z
  .strictObject({
    clusterId: safeId,
    sessionMode: z.enum(OPPORTUNITY_SESSION_MODES),
    sessionObjective: z.enum(OPPORTUNITY_SESSION_OBJECTIVES),
    editorialIntent: nonEmptyText.optional(),
    sourceProductIds: z.array(productId).max(100).default([]),
    sourceCategoryIds: z.array(categoryId).max(100).default([]),
    sourceCoverageSignalIds: z.array(coverageSignalId).max(100).default([]),
    candidateCount: z
      .number()
      .int()
      .min(1)
      .max(MAX_OPPORTUNITY_CANDIDATE_COUNT)
      .default(DEFAULT_OPPORTUNITY_CANDIDATE_COUNT),
    targetMarket: nonEmptyText.default("US"),
    language: nonEmptyText.default("en-US"),
    planningHorizon: nonEmptyText.optional(),
    importedSignalSummaries: z.array(importedSignalSummarySchema).max(100).optional(),
    regenerateFromCandidateId: safeId.regex(/^candidate_/).optional(),
  })
  .superRefine((request, context) => {
    if (request.sessionMode === "intent-first" && !request.editorialIntent) {
      context.addIssue({
        code: "custom",
        path: ["editorialIntent"],
        message: "Intent-first sessions require an editorial intent.",
      });
    }
    if (
      request.sessionMode === "product-first" &&
      !request.sourceProductIds.length &&
      !request.sourceCategoryIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceProductIds"],
        message: "Product-first sessions require at least one product or category source ID.",
      });
    }
    if (request.sessionMode === "coverage-first" && !request.sourceCoverageSignalIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceCoverageSignalIds"],
        message: "Coverage-first sessions require at least one I.0 coverage signal ID.",
      });
    }
    if (
      request.sessionMode !== "product-first" &&
      (request.sourceProductIds.length || request.sourceCategoryIds.length)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceProductIds"],
        message: "Only product-first sessions accept direct product or category sources.",
      });
    }
    if (request.sessionMode !== "coverage-first" && request.sourceCoverageSignalIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceCoverageSignalIds"],
        message: "Only coverage-first sessions accept I.0 coverage signal sources.",
      });
    }
  });

export type OpportunityGenerationRequest = z.input<typeof opportunityGenerationRequestSchema>;

const contextRecordSchema = z.strictObject({
  id: safeId,
  kind: z.enum([
    "published-cluster",
    "published-guide",
    "cluster-draft",
    "guide-draft",
    "editorial-brief",
    "candidate-history",
  ]),
  title: nonEmptyText,
  status: nonEmptyText.optional(),
  primaryAxis: primaryAxisSchema.optional(),
  primaryIntent: nonEmptyText.optional(),
  taxonomies: z.array(nonEmptyText),
  sections: z.array(nonEmptyText),
  productCategories: z.array(nonEmptyText),
  priorDecision: nonEmptyText.optional(),
});

export const opportunityGenerationPromptInputSchema = z.strictObject({
  selectedCluster: z.strictObject({ id: safeId, title: nonEmptyText }),
  sessionMode: z.enum(OPPORTUNITY_SESSION_MODES),
  sessionObjective: z.enum(OPPORTUNITY_SESSION_OBJECTIVES),
  editorialIntent: nonEmptyText.optional(),
  sourceProducts: z.array(sourceProductSchema),
  sourceCategories: z.array(sourceCategorySchema),
  sourceCoverageSignals: z.array(opportunityCoverageSignalSchema),
  candidateCount: z.number().int().min(1).max(MAX_OPPORTUNITY_CANDIDATE_COUNT),
  targetMarket: nonEmptyText,
  language: nonEmptyText,
  planningHorizon: nonEmptyText.optional(),
  publishedPages: z.array(contextRecordSchema),
  drafts: z.array(contextRecordSchema),
  approvedBriefs: z.array(contextRecordSchema),
  priorCandidateDecisions: z.array(contextRecordSchema),
  primaryAxes: z.array(primaryAxisSchema),
  taxonomyValues: z.array(nonEmptyText),
  availableProductCategories: z.array(nonEmptyText),
  importedSignalSummaries: z.array(importedSignalSummarySchema),
  regenerationSource: contextRecordSchema.optional(),
});

export type OpportunityGenerationPromptInput = z.infer<
  typeof opportunityGenerationPromptInputSchema
>;

const FORBIDDEN_EXTERNAL_EVIDENCE =
  /\b(?:search volume|keyword difficulty|monthly searches?|search demand|impressions?|click-through rate|ctr|\d[\d,.]*\s+clicks?|clicks? (?:count|rate|performance|traffic)|conversion rate|conversions?|affiliate (?:revenue|sales|performance)|pinterest (?:views|saves|performance)|search console|google analytics|traffic data|trending|best-?selling|high-demand|proven performer)\b/i;
const URL_LIKE = /(?:https?:\/\/|www\.)/i;

export const generatedOpportunitySchema = z.strictObject({
  proposedTitle: nonEmptyText,
  primaryAxis: primaryAxisSchema,
  primaryIntent: nonEmptyText,
  problemSolved: nonEmptyText,
  targetAudience: nonEmptyText,
  secondaryTaxonomies: candidateTaxonomiesSchema,
  proposedSections: candidateSectionsSchema,
  distinctiveProductCategories: z.array(nonEmptyText).min(1),
  differentiation: nonEmptyText,
  maintenanceImplications: nonEmptyText,
  productRequirements: z.array(nonEmptyText).min(1),
  catalogGaps: z.array(nonEmptyText),
  potentialOverlapHypothesis: nonEmptyText,
  evidenceBasis: z.literal("editorial-hypothesis-only"),
});

export const generatedOpportunityBatchSchema = z
  .strictObject({
    candidates: z.array(generatedOpportunitySchema).min(1).max(MAX_OPPORTUNITY_CANDIDATE_COUNT),
  })
  .superRefine((batch, context) => {
    const serialized = JSON.stringify(batch);
    if (URL_LIKE.test(serialized)) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Generated opportunities must not contain URLs.",
      });
    }
    if (FORBIDDEN_EXTERNAL_EVIDENCE.test(serialized)) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Generated opportunities must not assert external evidence or metrics.",
      });
    }
    const titles = new Set<string>();
    batch.candidates.forEach((candidate, index) => {
      const title = normalizeComparisonText(candidate.proposedTitle);
      if (titles.has(title)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "proposedTitle"],
          message: "Generated opportunity titles must be conceptually distinct.",
        });
      }
      titles.add(title);
    });
  });

export type GeneratedOpportunity = z.infer<typeof generatedOpportunitySchema>;
export type GeneratedOpportunityBatch = z.infer<typeof generatedOpportunityBatchSchema>;

export const opportunityGenerationSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recordType: z.literal("opportunity-generation-session"),
  id: safeId.regex(/^generation_/),
  clusterId: safeId,
  sessionMode: z.enum(OPPORTUNITY_SESSION_MODES),
  sessionObjective: z.enum(OPPORTUNITY_SESSION_OBJECTIVES),
  editorialIntent: nonEmptyText.optional(),
  sourceProductIds: z.array(productId),
  sourceCategoryIds: z.array(categoryId),
  sourceCoverageSignalIds: z.array(coverageSignalId),
  requestedCandidateCount: z.number().int().min(1).max(MAX_OPPORTUNITY_CANDIDATE_COUNT),
  targetMarket: nonEmptyText,
  language: nonEmptyText,
  planningHorizon: nonEmptyText.optional(),
  importedSignalSummaries: z.array(importedSignalSummarySchema),
  providerId: nonEmptyText,
  modelId: nonEmptyText.optional(),
  promptVersion: z.literal(OPPORTUNITY_GENERATION_PROMPT_VERSION),
  prompt: nonEmptyText,
  generatedAt: z.iso.datetime({ offset: true }),
  candidateIds: z
    .array(safeId.regex(/^candidate_/))
    .min(1)
    .max(MAX_OPPORTUNITY_CANDIDATE_COUNT),
  regenerationRequest: z
    .strictObject({
      sourceCandidateId: safeId.regex(/^candidate_/),
      sourceGenerationSessionId: safeId.regex(/^generation_/).optional(),
    })
    .optional(),
});

export type OpportunityGenerationSession = z.infer<typeof opportunityGenerationSessionSchema>;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function opportunityCategoryId(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return categoryId.parse(`category_${slug}`);
}

export function opportunityCatalogCategories(
  content: ValidatedPublicContent,
): z.infer<typeof sourceCategorySchema>[] {
  return unique(
    content.products
      .filter(({ status }) => status === "active")
      .flatMap(({ categories }) => categories ?? [])
      .map((label) => label.trim().toLocaleLowerCase("en-US")),
  ).map((label) => ({ id: opportunityCategoryId(label), label }));
}

function sourceCategories(labels: readonly string[]): z.infer<typeof sourceCategorySchema>[] {
  return unique(labels.map((label) => label.trim().toLocaleLowerCase("en-US"))).map((label) => ({
    id: opportunityCategoryId(label),
    label,
  }));
}

export function opportunityCoverageSignals(
  analysis: ProductCoverageAnalysis,
): OpportunityCoverageSignal[] {
  const { catalogHealth, editorialCoverage } = analysis;
  return [
    ...catalogHealth.activeProductsUnused.map((product) => ({
      id: `coverage_active-unused_${product.productId}`,
      kind: "active-product-unused" as const,
      summary: `${product.productId} is active and appears in no published guide.`,
      sourceProductIds: [product.productId],
      sourceCategories: sourceCategories(product.categories),
    })),
    ...catalogHealth.productsReusedAcrossGuides.map(({ product, guides }) => ({
      id: `coverage_product-reused_${product.productId}`,
      kind: "product-reused" as const,
      summary: `${product.productId} appears in ${guides.length} distinct published guides.`,
      sourceProductIds: [product.productId],
      sourceCategories: sourceCategories(product.categories),
    })),
    ...catalogHealth.substantialCategories.map(({ category, products }) => ({
      id: `coverage_substantial-category_${opportunityCategoryId(category)}`,
      kind: "substantial-category" as const,
      summary: `${category} has ${products.length} distinct active products.`,
      sourceProductIds: products.map(({ productId: id }) => id),
      sourceCategories: sourceCategories([category]),
    })),
    ...catalogHealth.singleProductCategories.map(({ category, products }) => ({
      id: `coverage_single-product-category_${opportunityCategoryId(category)}`,
      kind: "single-product-category" as const,
      summary: `${category} has exactly one active product.`,
      sourceProductIds: products.map(({ productId: id }) => id),
      sourceCategories: sourceCategories([category]),
    })),
    ...catalogHealth.clustersWithLowCategoryDiversity.map(
      ({ clusterId, categories, products }) => ({
        id: `coverage_low-cluster-diversity_${clusterId}`,
        kind: "low-cluster-diversity" as const,
        summary: `${clusterId} uses ${categories.length} active product categories.`,
        sourceProductIds: products.map(({ productId: id }) => id),
        sourceCategories: sourceCategories(categories),
      }),
    ),
    ...catalogHealth.productsWithBroadMetadata.map((product) => ({
      id: `coverage_broad-product-metadata_${product.productId}`,
      kind: "broad-product-metadata" as const,
      summary: `${product.productId} has broad recipient or occasion metadata under I.0 thresholds.`,
      sourceProductIds: [product.productId],
      sourceCategories: sourceCategories(product.categories),
    })),
    ...editorialCoverage.draftSlotsWithoutSuitableProducts.map((slot) => ({
      id: `coverage_draft-slot-gap_${slot.guideId}_${slot.slotId}`,
      kind: "draft-slot-gap" as const,
      summary: `${slot.guideId}/${slot.slotId} has no suitable active catalog match under the I.0 threshold.`,
      sourceProductIds: [],
      sourceCategories: [],
    })),
    ...editorialCoverage.briefRequirementsWithoutCatalogCoverage.map((requirement) => ({
      id: `coverage_brief-requirement-gap_${requirement.reportId}_${requirement.slotId}`,
      kind: "brief-requirement-gap" as const,
      summary: `${requirement.reportId}/${requirement.slotId} records an unassigned requirement: ${requirement.reason}`,
      sourceProductIds: [],
      sourceCategories: sourceCategories([requirement.requirement]),
    })),
  ]
    .map((signal) => opportunityCoverageSignalSchema.parse(signal))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function flattenTaxonomies(
  taxonomies: ArticleCandidate["secondaryTaxonomies"] | undefined,
): string[] {
  return unique(Object.values(taxonomies ?? {}).flatMap((values) => values ?? []));
}

function resolvedProductCategories(
  productIds: readonly (string | undefined)[],
  content: ValidatedPublicContent,
): string[] {
  const products = new Map(content.products.map((product) => [product.id, product]));
  return unique(productIds.flatMap((id) => (id ? (products.get(id)?.categories ?? []) : [])));
}

function publishedContext(
  clusterId: string,
  content: ValidatedPublicContent,
): z.infer<typeof contextRecordSchema>[] {
  const cluster = content.clusters.find(({ id }) => id === clusterId)!;
  const guides = content.guides.filter((guide) => guide.clusterId === clusterId);
  return [
    {
      id: cluster.id,
      kind: "published-cluster" as const,
      title: cluster.title,
      status: cluster.status,
      taxonomies: unique(guides.flatMap((guide) => flattenTaxonomies(guide.taxonomies))),
      sections: cluster.navigationGroups.map(({ label }) => label),
      productCategories: resolvedProductCategories(
        guides.flatMap((guide) => guide.recommendations.map(({ productId }) => productId)),
        content,
      ),
    },
    ...guides.map((guide) => ({
      id: guide.id,
      kind: "published-guide" as const,
      title: guide.title,
      status: guide.status,
      primaryAxis: guide.primaryAxis,
      primaryIntent: guide.primaryIntent,
      taxonomies: flattenTaxonomies(guide.taxonomies),
      sections: guide.recommendations.map(({ heading, whyItFits }) =>
        `${heading ?? ""} ${whyItFits}`.trim(),
      ),
      productCategories: resolvedProductCategories(
        guide.recommendations.map(({ productId }) => productId),
        content,
      ),
    })),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function draftContext(
  clusterId: string,
  drafts: readonly EditorialDraft[],
  content: ValidatedPublicContent,
): z.infer<typeof contextRecordSchema>[] {
  return drafts
    .filter((draft) =>
      draft.draftType === "cluster-hub" ? draft.id === clusterId : draft.clusterId === clusterId,
    )
    .map((draft) => {
      if (draft.draftType === "cluster-hub") {
        return {
          id: draft.id,
          kind: "cluster-draft" as const,
          title: draft.title ?? "Untitled cluster draft",
          status: draft.status,
          taxonomies: [],
          sections: draft.navigationGroups.map(({ label }) => label),
          productCategories: [],
        };
      }
      return {
        id: draft.id,
        kind: "guide-draft" as const,
        title: draft.title ?? draft.outline?.provisionalTitle ?? "Untitled guide draft",
        status: draft.status,
        ...(draft.primaryAxis ? { primaryAxis: draft.primaryAxis } : {}),
        ...(draft.primaryIntent ? { primaryIntent: draft.primaryIntent } : {}),
        taxonomies: flattenTaxonomies(draft.taxonomies),
        sections:
          draft.outline?.slots.map(({ label, intent }) => `${label} ${intent}`) ??
          draft.recommendations.map(({ slotLabel, slotIntent }) =>
            `${slotLabel} ${slotIntent ?? ""}`.trim(),
          ),
        productCategories: resolvedProductCategories(
          draft.recommendations.map(({ productId }) => productId),
          content,
        ),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function briefContext(
  clusterId: string,
  briefs: readonly ApprovedEditorialBriefComparisonRecord[],
): z.infer<typeof contextRecordSchema>[] {
  return briefs
    .filter((brief) => brief.clusterId === clusterId)
    .map((brief) => ({
      id: brief.id,
      kind: "editorial-brief" as const,
      title: brief.proposedTitle,
      status: brief.status,
      primaryAxis: brief.primaryAxis,
      primaryIntent: brief.primaryIntent,
      taxonomies: flattenTaxonomies(brief.taxonomies),
      sections: brief.proposedSections.map(({ heading, purpose }) => `${heading} ${purpose}`),
      productCategories: unique(brief.productCategories),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function historyContext(
  clusterId: string,
  candidates: readonly ArticleCandidate[],
): z.infer<typeof contextRecordSchema>[] {
  return candidates
    .filter((candidate) => candidate.clusterId === clusterId && candidate.decision)
    .map((candidate) => ({
      id: candidate.id,
      kind: "candidate-history" as const,
      title: candidate.proposedTitle,
      status: candidate.status,
      primaryAxis: candidate.primaryAxis,
      primaryIntent: candidate.primaryIntent,
      taxonomies: flattenTaxonomies(candidate.secondaryTaxonomies),
      sections: candidate.proposedSections.map(({ heading, purpose }) => `${heading} ${purpose}`),
      productCategories: unique(candidate.distinctiveProductCategories),
      priorDecision: `${candidate.decision!.action}: ${candidate.decision!.reason}`,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function prepareOpportunityGenerationPrompt(
  request: OpportunityGenerationRequest,
  content: ValidatedPublicContent,
  drafts: readonly EditorialDraft[],
  candidates: readonly ArticleCandidate[],
  approvedBriefs: readonly ApprovedEditorialBriefComparisonRecord[] = [],
  productCoverage?: ProductCoverageAnalysis,
) {
  const parsed = opportunityGenerationRequestSchema.parse(request);
  const cluster = content.clusters.find(({ id }) => id === parsed.clusterId);
  if (!cluster) throw new TypeError(`No existe el cluster canónico "${parsed.clusterId}".`);

  const publishedPages = publishedContext(cluster.id, content);
  const draftRecords = draftContext(cluster.id, drafts, content);
  const briefRecords = briefContext(cluster.id, approvedBriefs);
  const historyRecords = historyContext(cluster.id, candidates);
  const catalogCategories = opportunityCatalogCategories(content);
  const catalogCategoryById = new Map(catalogCategories.map((category) => [category.id, category]));
  const coverageSignals = productCoverage ? opportunityCoverageSignals(productCoverage) : [];
  const coverageSignalById = new Map(coverageSignals.map((signal) => [signal.id, signal]));
  const selectedCoverageSignals = parsed.sourceCoverageSignalIds.map((id) => {
    const signal = coverageSignalById.get(id);
    if (!signal) throw new TypeError(`No existe la señal determinista I.0 "${id}".`);
    return signal;
  });
  const directCategories = parsed.sourceCategoryIds.map((id) => {
    const category = catalogCategoryById.get(id);
    if (!category) throw new TypeError(`No existe la categoría activa "${id}".`);
    return category;
  });
  const productById = new Map(content.products.map((product) => [product.id, product]));
  const selectedProductIds = unique([
    ...parsed.sourceProductIds,
    ...selectedCoverageSignals.flatMap(({ sourceProductIds }) => sourceProductIds),
  ]);
  const selectedProducts = selectedProductIds.map((id) => {
    const product = productById.get(id);
    if (!product) throw new TypeError(`No existe el producto canónico "${id}".`);
    if (parsed.sessionMode === "product-first" && product.status !== "active") {
      throw new TypeError(`El producto "${id}" debe estar activo para una sesión product-first.`);
    }
    return sourceProductSchema.parse({
      id: product.id,
      name: product.name,
      status: product.status,
      categories: sourceCategories(product.categories ?? []),
    });
  });
  const selectedCategories = [
    ...directCategories,
    ...selectedProducts.flatMap(({ categories }) => categories),
    ...selectedCoverageSignals.flatMap(({ sourceCategories: categories }) => categories),
  ].filter(
    (category, index, records) => records.findIndex(({ id }) => id === category.id) === index,
  );
  const regenerationCandidate = parsed.regenerateFromCandidateId
    ? candidates.find(({ id }) => id === parsed.regenerateFromCandidateId)
    : undefined;
  if (parsed.regenerateFromCandidateId && !regenerationCandidate) {
    throw new TypeError(`No existe la oportunidad fuente "${parsed.regenerateFromCandidateId}".`);
  }
  if (regenerationCandidate?.status === "generated") {
    throw new TypeError("Evaluá la oportunidad antes de regenerar alternativas.");
  }
  if (
    regenerationCandidate?.clusterId !== undefined &&
    regenerationCandidate.clusterId !== cluster.id
  ) {
    throw new TypeError("La oportunidad fuente debe pertenecer al cluster seleccionado.");
  }
  const regenerationSource = regenerationCandidate
    ? {
        id: regenerationCandidate.id,
        kind: "candidate-history" as const,
        title: regenerationCandidate.proposedTitle,
        status: regenerationCandidate.status,
        primaryAxis: regenerationCandidate.primaryAxis,
        primaryIntent: regenerationCandidate.primaryIntent,
        taxonomies: flattenTaxonomies(regenerationCandidate.secondaryTaxonomies),
        sections: regenerationCandidate.proposedSections.map(
          ({ heading, purpose }) => `${heading} ${purpose}`,
        ),
        productCategories: unique(regenerationCandidate.distinctiveProductCategories),
        ...(regenerationCandidate.decision
          ? {
              priorDecision: `${regenerationCandidate.decision.action}: ${regenerationCandidate.decision.reason}`,
            }
          : {}),
      }
    : undefined;
  const input = opportunityGenerationPromptInputSchema.parse({
    selectedCluster: { id: cluster.id, title: cluster.title },
    sessionMode: parsed.sessionMode,
    sessionObjective: parsed.sessionObjective,
    ...(parsed.editorialIntent ? { editorialIntent: parsed.editorialIntent } : {}),
    sourceProducts: selectedProducts,
    sourceCategories: selectedCategories,
    sourceCoverageSignals: selectedCoverageSignals,
    candidateCount: parsed.candidateCount,
    targetMarket: parsed.targetMarket,
    language: parsed.language,
    ...(parsed.planningHorizon ? { planningHorizon: parsed.planningHorizon } : {}),
    publishedPages,
    drafts: draftRecords,
    approvedBriefs: briefRecords,
    priorCandidateDecisions: historyRecords,
    primaryAxes: [...PRIMARY_AXES],
    taxonomyValues: unique(
      [...publishedPages, ...draftRecords, ...briefRecords, ...historyRecords].flatMap(
        ({ taxonomies }) => taxonomies,
      ),
    ),
    availableProductCategories: unique(
      content.products
        .filter(({ status }) => status === "active")
        .flatMap(({ categories }) => categories ?? []),
    ),
    importedSignalSummaries: parsed.importedSignalSummaries ?? [],
    ...(regenerationSource ? { regenerationSource } : {}),
  });
  const prompt = `You are performing divergent editorial opportunity generation for The Good Present.

Generate exactly ${input.candidateCount} conceptually distinct candidates for the selected cluster and session objective in ${input.sessionMode} mode. Prefer different audience problems, primary intents, section structures, and product-category combinations over keyword permutations.

Intent-first starts from the supplied audience, problem, occasion, or editorial intent and must identify product requirements and possible catalog gaps. Product-first starts only from the editor-selected source products/categories, but every proposal still needs a genuine audience, concrete problem, distinct primary intent, substantive sections, explicit differentiation, at least two product categories, and maintenance implications; never center a proposal on one product. Coverage-first interprets only the selected deterministic I.0 signals and must leave page, section, merge, hold, or no-action judgment to convergent evaluation and the editor. Products and catalog gaps are evidence and raw material, never automatic justification for a public URL.

This is ideation only. Do not rank, score, shortlist, approve, reject, merge, create a brief or draft, or publish anything. Do not return IDs, slugs, URLs, publication state, product identities, merchants, affiliate details, search volume, keyword difficulty, traffic, social, product, or affiliate performance claims. Treat imported signal summaries, when present, only as editor-supplied context; never recast them as observed metrics. Every candidate must set evidenceBasis to exactly "editorial-hypothesis-only".${input.regenerationSource ? " This is an explicit request for alternatives: every proposal must differ meaningfully from the supplied regeneration source in audience problem, intent, or structure." : ""}

Return exactly one JSON object with this shape and no additional fields:
{"candidates":[{"proposedTitle":"...","primaryAxis":"one supplied axis","primaryIntent":"...","problemSolved":"...","targetAudience":"...","secondaryTaxonomies":{"occasions":["..."]},"proposedSections":[{"heading":"...","purpose":"..."}],"distinctiveProductCategories":["..."],"differentiation":"...","maintenanceImplications":"...","productRequirements":["..."],"catalogGaps":["..."],"potentialOverlapHypothesis":"...","evidenceBasis":"editorial-hypothesis-only"}]}

Planning input:
${JSON.stringify(input, null, 2)}`;
  return { version: OPPORTUNITY_GENERATION_PROMPT_VERSION, input, prompt };
}

const MOCK_THEMES = [
  {
    title: "Shift-transition support",
    axis: "work-context",
    intent: "Help a giver support the transition between demanding work and restorative time.",
    problem: "Broad practical lists rarely organize gifts around the transition out of work.",
    sections: ["Leaving work mode", "Restoring everyday routines"],
    overlap:
      "May share practical categories with broad work-gift coverage while owning a distinct transition intent.",
  },
  {
    title: "Milestone recognition",
    axis: "occasion",
    intent:
      "Match a gift to a specific professional milestone without defaulting to generic congratulations.",
    problem: "Milestone gifts need context that general occasion pages do not provide.",
    sections: ["Marking the achievement", "Supporting the next chapter"],
    overlap:
      "May touch graduation coverage but differentiates by the milestone selected for the session.",
  },
  {
    title: "Small-space workday upgrades",
    axis: "work-context",
    intent: "Find useful gifts that fit constrained work and storage environments.",
    problem: "Many useful gifts become impractical when storage and carrying space are limited.",
    sections: ["Compact essentials", "Portable organization"],
    overlap:
      "May overlap a practical guide at category level but narrows the problem to space constraints.",
  },
  {
    title: "Off-duty recovery rituals",
    axis: "gift-style",
    intent: "Support repeatable off-duty rituals rather than one-time novelty gifts.",
    problem:
      "Recovery suggestions are often scattered instead of organized around repeatable routines.",
    sections: ["Creating a recovery cue", "Sustaining the ritual"],
    overlap:
      "May share comfort categories with existing pages while proposing a ritual-based structure.",
  },
  {
    title: "Season-change preparation",
    axis: "occasion",
    intent: "Help a giver anticipate routine changes associated with the planning season.",
    problem:
      "Seasonal pages can become decorative lists instead of solving timely routine changes.",
    sections: ["Preparing for the season", "Useful seasonal comforts"],
    overlap: "May overlap occasion coverage but frames seasonality around practical preparation.",
  },
  {
    title: "Team appreciation moments",
    axis: "recipient",
    intent:
      "Support thoughtful appreciation from a team without turning the idea into a generic group gift list.",
    problem: "Team gifts need a clear relationship and use context to avoid impersonal choices.",
    sections: ["Shared appreciation", "Individual recognition"],
    overlap:
      "May share recipient language with broad pages but uses team relationships as the main lens.",
  },
  {
    title: "Personalized daily rituals",
    axis: "gift-style",
    intent: "Use personalization only when it improves a daily routine or sense of ownership.",
    problem: "Personalized gift coverage can prioritize decoration over usefulness.",
    sections: ["Useful personalization", "Details worth confirming"],
    overlap:
      "May overlap personalized coverage while narrowing the standard to routine usefulness.",
  },
  {
    title: "Early-career confidence",
    axis: "career-stage",
    intent: "Help a giver support confidence during an early-career transition.",
    problem:
      "Broad career-stage lists can miss the practical and emotional needs of a first transition.",
    sections: ["Building confidence", "Supporting new routines"],
    overlap: "May approach student or graduation topics but centers the first working transition.",
  },
  {
    title: "Purposeful budget bundles",
    axis: "budget",
    intent: "Combine modest categories around one coherent recipient problem.",
    problem: "Budget pages often sort by price without giving a small set a shared purpose.",
    sections: ["Choosing one purpose", "Combining complementary categories"],
    overlap:
      "May share a budget ceiling with existing coverage but changes the structure from price list to purposeful bundle.",
  },
  {
    title: "Section-sized care upgrades",
    axis: "general",
    intent:
      "Identify focused ideas that may work better as a useful section than as a broad standalone page.",
    problem: "Some narrow needs deserve coverage but may not support an independent guide.",
    sections: ["The focused need", "Where the section could fit"],
    overlap:
      "Is deliberately close to existing coverage so a human can review possible section placement.",
  },
] as const;

const MOCK_AUDIENCES = [
  "close family members",
  "friends choosing a practical gift",
  "coworkers planning a thoughtful gesture",
  "partners supporting everyday routines",
  "long-distance givers who need clear context",
] as const;

export function mockOpportunityGeneration(
  input: OpportunityGenerationPromptInput,
): GeneratedOpportunityBatch {
  const clusterName = input.selectedCluster.title.replace(/\s+gifts?$/i, "");
  const categories = unique([
    ...input.sourceCategories.map(({ label }) => label),
    ...input.availableProductCategories,
  ]);
  const availableCategories = categories.length ? categories : ["practical accessories"];
  return generatedOpportunityBatchSchema.parse({
    candidates: Array.from({ length: input.candidateCount }, (_, index) => {
      const theme = MOCK_THEMES[(index + (input.regenerationSource ? 1 : 0)) % MOCK_THEMES.length]!;
      const audience = MOCK_AUDIENCES[Math.floor(index / MOCK_THEMES.length)]!;
      return {
        proposedTitle: `${theme.title} for ${clusterName}: ${audience}`,
        primaryAxis: theme.axis,
        primaryIntent: theme.intent,
        problemSolved: theme.problem,
        targetAudience: audience,
        secondaryTaxonomies: {},
        proposedSections: theme.sections.map((heading) => ({
          heading,
          purpose: `Develop ${heading.toLocaleLowerCase("en-US")} for ${audience}.`,
        })),
        distinctiveProductCategories: unique([
          availableCategories[index % availableCategories.length]!,
          availableCategories[(index + 1) % availableCategories.length]!,
        ]),
        differentiation: theme.overlap,
        maintenanceImplications:
          "Review catalog availability and section fit during ordinary editorial maintenance.",
        productRequirements: theme.sections,
        catalogGaps: [],
        potentialOverlapHypothesis: theme.overlap,
        evidenceBasis: "editorial-hypothesis-only" as const,
      };
    }),
  });
}

function systemSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new TypeError("No se pudo derivar un slug seguro del título generado.");
  return slug;
}

function assertNoProtectedOutput(
  generated: GeneratedOpportunityBatch,
  content: ValidatedPublicContent,
): void {
  const serialized = JSON.stringify(generated).toLocaleLowerCase("en-US");
  const protectedValues = [
    ...content.clusters.map(({ id }) => id),
    ...content.guides.map(({ id }) => id),
    ...content.products.flatMap(({ id, name }) => [id, name]),
  ];
  const found = protectedValues.find((value) =>
    serialized.includes(value.toLocaleLowerCase("en-US")),
  );
  if (found) {
    throw new TypeError("La respuesta generada intentó controlar una identidad protegida.");
  }
}

function assertNoUnchangedRejectedIdeas(
  generated: GeneratedOpportunityBatch,
  candidates: readonly ArticleCandidate[],
  sourceEvidenceIds: readonly string[],
): void {
  const rejected = candidates.filter(({ decision }) => decision?.action === "reject");
  for (const proposal of generated.candidates) {
    const repeated = rejected.find((candidate) => {
      const sameTitle =
        normalizeComparisonText(candidate.proposedTitle) ===
        normalizeComparisonText(proposal.proposedTitle);
      const sameCore =
        candidate.primaryAxis === proposal.primaryAxis &&
        normalizeComparisonText(candidate.primaryIntent) ===
          normalizeComparisonText(proposal.primaryIntent) &&
        normalizeComparisonText(candidate.problemSolved) ===
          normalizeComparisonText(proposal.problemSolved);
      const priorEvidenceIds = [
        ...(candidate.sourceSignalIds ?? []),
        ...(candidate.sourceProductIds ?? []),
        ...(candidate.sourceCategoryIds ?? []),
        ...(candidate.sourceCoverageSignalIds ?? []),
      ];
      const changedInput = sourceEvidenceIds.some((id) => !priorEvidenceIds.includes(id));
      return (sameTitle || sameCore) && !changedInput;
    });
    if (repeated) {
      throw new TypeError(
        `La propuesta repite la oportunidad rechazada "${repeated.id}" sin evidencia nueva.`,
      );
    }
  }
}

const UNASSESSED_SCORES: ArticleCandidate["scores"] = {
  intentDifferentiation: 0,
  editorialUsefulness: 0,
  productDifferentiation: 0,
  audienceClarity: 0,
  seasonalValue: 0,
  commercialPotential: 0,
  visualDistributionPotential: 0,
  productReusePotential: 0,
  thinContentRisk: 0,
  cannibalizationRisk: 0,
  maintenanceCost: 0,
};

function deterministicOverlaps(report: OpportunityComparisonReport) {
  const kindMap = {
    "primary-intent": "primary-intent",
    "proposed-sections": "section-scope",
    "product-categories": "product-categories",
  } as const;
  const signals = report.nearestEditorialState.flatMap((comparison) => {
    if (
      comparison.targetKind !== "published-cluster" &&
      comparison.targetKind !== "published-guide"
    ) {
      return [];
    }
    return comparison.signals.flatMap((signal) => {
      const kind = kindMap[signal.kind as keyof typeof kindMap];
      return kind && signal.level !== "low"
        ? [
            {
              contentId: comparison.targetId,
              kind,
              level: signal.level,
              reason: signal.reason,
            },
          ]
        : [];
    });
  });
  return {
    closestExistingContentIds: unique(signals.map(({ contentId }) => contentId)),
    overlapSignals: signals,
  };
}

function composeCandidate(
  proposal: GeneratedOpportunity,
  clusterId: string,
  content: ValidatedPublicContent,
  drafts: readonly EditorialDraft[],
  candidates: readonly ArticleCandidate[],
  approvedBriefs: readonly ApprovedEditorialBriefComparisonRecord[],
  generationSessionId: string,
  sessionMode: ArticleCandidate["sessionMode"],
  sourceSignalIds: readonly string[],
  sourceProductIds: readonly string[],
  sourceCategoryIds: readonly string[],
  sourceCoverageSignalIds: readonly string[],
  regenerationSource: ArticleCandidate | undefined,
  now: Date,
): { candidate: ArticleCandidate; comparison: OpportunityComparisonReport } {
  const timestamp = now.toISOString();
  const seed = articleCandidateSchema.parse({
    schemaVersion: 1,
    recordType: "article-candidate",
    id: `candidate_${randomUUID()}`,
    clusterId,
    proposedTitle: proposal.proposedTitle,
    proposedSlug: systemSlug(proposal.proposedTitle),
    primaryAxis: proposal.primaryAxis,
    primaryIntent: proposal.primaryIntent,
    problemSolved: proposal.problemSolved,
    targetAudience: proposal.targetAudience,
    secondaryTaxonomies: proposal.secondaryTaxonomies,
    proposedSections: proposal.proposedSections,
    distinctiveProductCategories: proposal.distinctiveProductCategories,
    closestExistingContentIds: [],
    overlapSignals: [],
    scores: UNASSESSED_SCORES,
    advisory: {
      recommendation: "hold",
      reason: `AI-generated editorial hypothesis only. Potential overlap hypothesis: ${proposal.potentialOverlapHypothesis} Scores are unassessed and no editorial decision was made.`,
    },
    generationSessionId,
    sessionMode,
    sourceProductIds,
    sourceCategoryIds,
    sourceCoverageSignalIds,
    differentiation: proposal.differentiation,
    maintenanceImplications: proposal.maintenanceImplications,
    productRequirements: proposal.productRequirements,
    catalogGaps: proposal.catalogGaps,
    ...(sourceSignalIds.length ? { sourceSignalIds } : {}),
    ...(regenerationSource
      ? {
          regeneratedFromCandidateId: regenerationSource.id,
          ...(regenerationSource.generationSessionId
            ? { regeneratedFromSessionId: regenerationSource.generationSessionId }
            : {}),
        }
      : {}),
    status: "generated",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const comparison = compareArticleCandidate(seed, content, drafts, candidates, approvedBriefs);
  return {
    candidate: articleCandidateSchema.parse({ ...seed, ...deterministicOverlaps(comparison) }),
    comparison,
  };
}

export function opportunityGenerationSessionPath(repositoryRoot: string, id: string): string {
  opportunityGenerationSessionSchema.shape.id.parse(id);
  return resolve(repositoryRoot, OPPORTUNITY_GENERATION_SESSIONS_DIRECTORY, `${id}.json`);
}

export interface GenerateDivergentOpportunitiesContext {
  content: ValidatedPublicContent;
  drafts: readonly EditorialDraft[];
  existingCandidates: readonly ArticleCandidate[];
  approvedBriefs?: readonly ApprovedEditorialBriefComparisonRecord[];
  productCoverage?: ProductCoverageAnalysis;
  provider: GuideGenerationProvider;
  candidateStore: ArticleCandidateStore;
  repositoryRoot: string;
  now?: Date;
}

export async function generateDivergentOpportunities(
  request: OpportunityGenerationRequest,
  context: GenerateDivergentOpportunitiesContext,
) {
  const prepared = prepareOpportunityGenerationPrompt(
    request,
    context.content,
    context.drafts,
    context.existingCandidates,
    context.approvedBriefs,
    context.productCoverage,
  );
  const exactResponseSchema = generatedOpportunityBatchSchema.refine(
    ({ candidates }) => candidates.length === prepared.input.candidateCount,
    `The provider must return exactly ${prepared.input.candidateCount} candidates.`,
  );
  const generated = exactResponseSchema.parse(
    await context.provider.generateStructured({
      operation: "opportunity-candidates",
      prompt: prepared.prompt,
      input: prepared.input,
      schema: exactResponseSchema,
      mockResponse: () => mockOpportunityGeneration(prepared.input),
    }),
  );
  assertNoProtectedOutput(generated, context.content);
  assertNoUnchangedRejectedIdeas(generated, context.existingCandidates, [
    ...prepared.input.importedSignalSummaries.map(({ id }) => id),
    ...prepared.input.sourceProducts.map(({ id }) => id),
    ...prepared.input.sourceCategories.map(({ id }) => id),
    ...prepared.input.sourceCoverageSignals.map(({ id }) => id),
  ]);
  if (prepared.input.sessionMode === "product-first") {
    const activeCategories = new Set(
      prepared.input.availableProductCategories.map(normalizeComparisonText),
    );
    const sourceCategories = new Set(
      prepared.input.sourceCategories.map(({ label }) => normalizeComparisonText(label)),
    );
    const invalid = generated.candidates.find(
      ({ distinctiveProductCategories }) =>
        new Set(distinctiveProductCategories.map(normalizeComparisonText)).size < 2 ||
        !distinctiveProductCategories.some((category) =>
          sourceCategories.has(normalizeComparisonText(category)),
        ) ||
        distinctiveProductCategories.some(
          (category) => !activeCategories.has(normalizeComparisonText(category)),
        ),
    );
    if (invalid) {
      throw new TypeError(
        "Cada candidato product-first debe usar una categoría fuente y al menos dos categorías activas distintas.",
      );
    }
  }
  if (prepared.input.sessionObjective === "reuse-existing-products") {
    const available = new Set(
      prepared.input.availableProductCategories.map(normalizeComparisonText),
    );
    const unavailable = generated.candidates
      .flatMap(({ distinctiveProductCategories }) => distinctiveProductCategories)
      .find((category) => !available.has(normalizeComparisonText(category)));
    if (unavailable) {
      throw new TypeError(
        `La categoría generada "${unavailable}" no existe en el catálogo activo para esta sesión.`,
      );
    }
  }

  const now = context.now ?? new Date();
  const approvedBriefs = context.approvedBriefs ?? [];
  const generationSessionId = `generation_${randomUUID()}`;
  const regenerationSource = prepared.input.regenerationSource
    ? context.existingCandidates.find(({ id }) => id === prepared.input.regenerationSource?.id)
    : undefined;
  const composed = generated.candidates.map((proposal) =>
    composeCandidate(
      proposal,
      prepared.input.selectedCluster.id,
      context.content,
      context.drafts,
      context.existingCandidates,
      approvedBriefs,
      generationSessionId,
      prepared.input.sessionMode,
      prepared.input.importedSignalSummaries.map(({ id }) => id),
      prepared.input.sourceProducts.map(({ id }) => id),
      prepared.input.sourceCategories.map(({ id }) => id),
      prepared.input.sourceCoverageSignals.map(({ id }) => id),
      regenerationSource,
      now,
    ),
  );
  const session = opportunityGenerationSessionSchema.parse({
    schemaVersion: 1,
    recordType: "opportunity-generation-session",
    id: generationSessionId,
    clusterId: prepared.input.selectedCluster.id,
    sessionMode: prepared.input.sessionMode,
    sessionObjective: prepared.input.sessionObjective,
    ...(prepared.input.editorialIntent ? { editorialIntent: prepared.input.editorialIntent } : {}),
    sourceProductIds: prepared.input.sourceProducts.map(({ id }) => id),
    sourceCategoryIds: prepared.input.sourceCategories.map(({ id }) => id),
    sourceCoverageSignalIds: prepared.input.sourceCoverageSignals.map(({ id }) => id),
    requestedCandidateCount: prepared.input.candidateCount,
    targetMarket: prepared.input.targetMarket,
    language: prepared.input.language,
    ...(prepared.input.planningHorizon ? { planningHorizon: prepared.input.planningHorizon } : {}),
    importedSignalSummaries: prepared.input.importedSignalSummaries,
    providerId: context.provider.providerId,
    ...(context.provider.modelId ? { modelId: context.provider.modelId } : {}),
    promptVersion: prepared.version,
    prompt: prepared.prompt,
    generatedAt: now.toISOString(),
    candidateIds: composed.map(({ candidate }) => candidate.id),
    ...(regenerationSource
      ? {
          regenerationRequest: {
            sourceCandidateId: regenerationSource.id,
            ...(regenerationSource.generationSessionId
              ? { sourceGenerationSessionId: regenerationSource.generationSessionId }
              : {}),
          },
        }
      : {}),
  });

  for (const { candidate } of composed) await context.candidateStore.save(candidate);
  await atomicWriteJson(
    opportunityGenerationSessionPath(context.repositoryRoot, session.id),
    session,
  );
  return {
    session,
    candidates: composed.map(({ candidate }) => candidate),
    comparisons: composed.map(({ comparison }) => comparison),
  };
}
