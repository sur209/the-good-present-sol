import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";

import { z } from "zod";

import {
  productDisplayName,
  productDestination,
  productSchema,
  type Product,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";

import {
  MockGuideGenerationProvider,
  ProviderError,
  createGuideGenerationProvider,
  parseExactStructuredContent,
  resolveAiConfiguration,
  type GuideGenerationProvider,
  type ProviderCallMetadata,
  type StructuredGenerationRequest,
} from "./ai-provider.ts";
import {
  addGuideToGroup,
  moveGuideInGroup,
  removeGuideFromGroup,
  reopenClusterDraft,
  validateClusterDraft,
} from "./cluster-editor.ts";
import { DraftStore, assertSafeDraftId } from "./draft-store.ts";
import {
  DEFAULT_GIFT_COUNT,
  MAX_GIFT_COUNT,
  MIN_GIFT_COUNT,
  clusterDraftSchema,
  createClusterDraft,
  createGuideDraft,
  editorialDraftSchema,
  guideDraftSchema,
  guideOutlineSchema,
  type GuideDraft,
} from "./drafts.ts";
import {
  SAFE_IDEA_COPY_VERSION,
  MANUAL_EDITORIAL_COPY_VERSION,
  addManualRecommendation,
  applyDeterministicIdeaCopyFallback,
  classifyObservedClaimMatches,
  clearRecommendationProduct,
  completeGuideEditorialMetadata,
  duplicateProductIds,
  generateFinalGuide,
  generateGuideOutline,
  generateIdeaOnlyRecommendation,
  generateIdeaOnlyRecommendationBatchWithRecovery,
  generateIdeaOnlyRecommendationWithRecovery,
  generateProductBackedRecommendationWithRecovery,
  guideDraftReadiness,
  moveRecommendation,
  normalizeQuestionnaire,
  productBackedCopyFailureReason,
  regenerateRecommendation,
  removeRecommendation,
  reopenGuideDraft,
  selectRecommendationProduct,
  updateRecommendationEditorialCopy,
  updateRecommendationDirectAffiliateUrl,
  validateGuideDraft,
} from "./guide-editor.ts";
import {
  generatedRecommendationSchema,
  guideMetadataPromptInputSchema,
  prepareFinalPrompt,
} from "./final-prompt.ts";
import {
  OUTLINE_PROMPT_VERSION,
  outlinePromptInputSchema,
  outlineQualityIssues,
  prepareOutlinePrompt,
} from "./outline-prompt.ts";
import {
  ProductCatalog,
  matchProducts,
  productUsage,
  suggestProductsForSlot,
  validateProductUrl,
} from "./product-catalog.ts";
import {
  prepareRecommendationFieldRepairPrompt,
  prepareRecommendationPrompt,
  recommendationFieldRepairInputSchema,
  recommendationPromptInputSchema,
} from "./recommendation-prompt.ts";
import {
  generatedIdeaRecommendationSchema,
  ideaRecommendationBatchPromptInputSchema,
  prepareIdeaRecommendationPrompt,
} from "./idea-prompt.ts";
import {
  affiliateProgramSchema,
  missingAffiliateProgramConfiguration,
  readAffiliateProgramRecords,
} from "./modules/affiliate-operations/programs.ts";
import {
  createAmazonProductSourceRecord,
  extractAmazonAsin,
  isApprovedAmazonUsHost,
  normalizeAmazonUrl,
  validateAmazonAffiliateIntake,
} from "./modules/affiliate-operations/amazon.ts";
import { validateAffiliateOperations } from "./modules/affiliate-operations/validation.ts";
import {
  DataForSeoProductDiscoverySource,
  ProductDiscoveryError,
  SerpApiProductDiscoverySource,
  createProductDiscoverySource,
  generateProductSearchPlans,
  prepareProductSearchPlanningPrompt,
  resolveProductDiscoveryConfiguration,
  runProductDiscovery,
  updateProductSearchPlan,
  type ProductDiscoverySource,
} from "./modules/product-sources/discovery.ts";
import {
  ProductSourceStore,
  findDuplicateProductSource,
  findProductSource,
  productSourcePath,
  productSourceRecordSchema,
  readProductSourceRecords,
  type ProductSourceRecord,
} from "./modules/product-sources/records.ts";
import {
  commitManualProductIntake,
  prepareManualProductIntake,
  type ManualProductIntakeInput,
} from "./modules/product-intelligence/intake.ts";
import { productEditorialCopyPromptInputSchema } from "./modules/product-intelligence/editorial-copy.ts";
import {
  AUTOPILOT_LIMITS,
  assessAutomaticProductCandidate,
  chooseAutomaticProductCandidate,
  completeIdeaOnlyRecommendationCopy,
  completeProductBackedRecommendationCopy,
  ideaOnlyRecommendationNeedsCopyRepair,
  recommendationHasLegacyIdeaFallback,
  resolveRecommendationSlotAutonomously,
} from "./modules/product-intelligence/autopilot.ts";
import {
  GUIDE_AUTOPILOT_MAX_CONCURRENT_SLOTS,
  completeGuideAutonomously,
  guideAutopilotOutcomeSchema,
} from "./modules/product-intelligence/guide-autopilot.ts";
import { analyzeProductCoverage } from "./modules/product-intelligence/coverage.ts";
import {
  guideCurationNextAction,
  guideCurationProgress,
  selectGuideWideResolutionSlots,
} from "./modules/product-intelligence/curation.ts";
import { inspectManualProductUrl } from "./modules/product-intelligence/manual-url.ts";
import { productGapReportSchema } from "./modules/product-intelligence/gaps.ts";
import {
  EditorialBenchmarkStore,
  createEditorialBenchmark,
  editorialBenchmarkSchema,
  retireEditorialBenchmark,
} from "./modules/product-intelligence/benchmarks.ts";
import {
  EDITORIAL_FEEDBACK_POLICY,
  EditorialFeedbackStore,
  createEditorialFeedbackEvent,
  editorialFeedbackEventSchema,
  summarizeEditorialFeedback,
} from "./modules/product-intelligence/feedback.ts";
import {
  PRODUCT_CLASS_PROFILES,
  PRODUCT_FIT_RANKING_POLICY_V1,
  ProductFitEvaluationStore,
  evaluateProductFitBatch,
  evaluateProductFitBatchAttempt,
  mockProductFitEvaluation,
  orderProductFitEvaluations,
  prepareProductFitEvaluationPrompt,
  productFitEvaluationBatchSchema,
  productFitPromptInputSchema,
  resolveProductClassProfile,
  type ProductFitEvaluation,
} from "./modules/product-intelligence/fit.ts";
import {
  ProductSourcingRequestStore,
  addProductSourceCandidates,
  assertProductSourcingOrigin,
  assignSourcedProductToDraftSlot,
  catalogMatchesForRequest,
  completeProductSourcingRequestAsIdeaOnly,
  createProductSourcingRequest,
  createProductSourcingRequestForDraftSlot,
  findProductSourcingRequestForDraftSlot,
  linkProductSourceCandidate,
  productSourcingPrefillForDraftSlot,
  productSourceCandidateSchema,
  productSourcingRequestSchema,
  productSourcingRequestPath,
  productSourcingReturnPath,
  reviewProductSourceCandidates,
  selectCanonicalProductForRequest,
  transitionProductSourcingRequest,
  type ProductDiscoveryMode,
  type ProductSourceCandidateInput,
} from "./modules/product-intelligence/sourcing.ts";
import {
  ArticleCandidateStore,
  applyCandidateDecision,
  articleCandidatePath,
  articleCandidateSchema,
  transitionArticleCandidate,
  type ArticleCandidate,
} from "./modules/content-opportunity-lab/candidates.ts";
import {
  OPPORTUNITY_SIGNAL_KINDS,
  compareArticleCandidate,
  normalizeComparisonText,
  type ApprovedEditorialBriefComparisonRecord,
} from "./modules/content-opportunity-lab/comparison.ts";
import {
  DEFAULT_OPPORTUNITY_CANDIDATE_COUNT,
  MAX_OPPORTUNITY_CANDIDATE_COUNT,
  OPPORTUNITY_GENERATION_PROMPT_VERSION,
  generateDivergentOpportunities,
  generatedOpportunityBatchSchema,
  opportunityCoverageSignals,
  opportunityGenerationRequestSchema,
  opportunityGenerationSessionPath,
  opportunityGenerationSessionSchema,
  prepareOpportunityGenerationPrompt,
} from "./modules/content-opportunity-lab/generation.ts";
import {
  OPPORTUNITY_EVALUATION_PROMPT_VERSION,
  OpportunityEvaluationStore,
  evaluateConvergentOpportunities,
  importedEvaluationSignalSchema,
  opportunityAiJudgmentSchema,
  opportunityEvaluationBatchSchema,
  opportunityEvaluationSessionPath,
  opportunityEvaluationSessionSchema,
  prepareOpportunityEvaluationPrompt,
} from "./modules/content-opportunity-lab/evaluation.ts";
import {
  EditorialBriefStore,
  approveCandidateForBrief,
  approveEditorialBrief,
  convertApprovedBriefToGuideDraft,
  editorialBriefPath,
  editorialBriefSchema,
  updateEditorialBrief,
} from "./modules/content-opportunity-lab/review.ts";
import { Publisher, clusterDraftToPublic, guideDraftToPublic } from "./publication.ts";
import { REPOSITORY_ROOT, atomicWriteJson, readPublicContent } from "./repository.ts";
import { STUDIO_HOST, createStudioServer } from "./server.ts";

const execFileAsync = promisify(execFile);

async function productDiscoveryFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(`./modules/product-sources/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function nurseCluster(content: ValidatedPublicContent) {
  const cluster = content.clusters.find(({ id }) => id === "cluster_nurse-gifts");
  assert.ok(cluster);
  return cluster;
}

async function generatedGuideDraft(id: string, giftCount = 3) {
  const content = new ProductCatalog().read();
  const draft = guideDraftSchema.parse({
    ...createGuideDraft(id),
    clusterId: nurseCluster(content).id,
    primaryAxis: "recipient",
    primaryIntent: "Help a friend choose a useful gift for a nurse.",
    questionnaire: normalizeQuestionnaire({ giftCount: String(giftCount) }),
  });
  return generateGuideOutline(draft, content, new MockGuideGenerationProvider());
}

async function selectedGuideDraft(id: string, giftCount = 3) {
  const content = new ProductCatalog().read();
  let draft = await generatedGuideDraft(id, giftCount);
  draft = guideDraftSchema.parse({
    ...draft,
    slug: id.replace(/^guide_/, "").replaceAll("_", "-"),
  });
  for (const [index, recommendation] of draft.recommendations.entries()) {
    draft = selectRecommendationProduct(
      draft,
      recommendation.id,
      content.products[index]!.id,
      content,
    );
  }
  return draft;
}

function sourceRecord(
  productId: string,
  overrides: Partial<ProductSourceRecord> = {},
): ProductSourceRecord {
  return productSourceRecordSchema.parse({
    id: "source_test",
    productId,
    sourceKind: "manual",
    provider: "Test provider",
    marketplace: "test.example",
    externalId: "external-123",
    sourceUrl: "https://test.example/products/external-123",
    importMethod: "manual",
    importedAt: "2026-08-08T00:00:00.000Z",
    sourceStatus: "active",
    ...overrides,
  });
}

function articleCandidate(overrides: Partial<ArticleCandidate> = {}): ArticleCandidate {
  return articleCandidateSchema.parse({
    schemaVersion: 1,
    recordType: "article-candidate",
    id: "candidate_nurse-shift-recovery",
    clusterId: "cluster_nurse-gifts",
    proposedTitle: "Recovery Gifts for Nurses After a Long Shift",
    proposedSlug: "shift-recovery",
    primaryAxis: "work-context",
    primaryIntent: "Help gift-givers support a nurse's recovery after demanding shifts.",
    problemSolved: "Separates off-shift recovery needs from broad practical gift advice.",
    targetAudience: "Friends and family buying for working nurses.",
    secondaryTaxonomies: {
      recipients: ["nurses"],
      workContexts: ["post-shift recovery"],
      giftStyles: ["restorative"],
    },
    proposedSections: [
      {
        heading: "Decompression after work",
        purpose: "Cover products that help create a deliberate transition out of work mode.",
      },
      {
        heading: "Daytime rest",
        purpose: "Address sleep and comfort needs after overnight schedules.",
      },
    ],
    distinctiveProductCategories: ["recovery tools", "sleep support"],
    closestExistingContentIds: ["guide_nurse-practical"],
    overlapSignals: [
      {
        contentId: "guide_nurse-practical",
        kind: "section-scope",
        level: "medium",
        reason: "The practical guide contains one sleep item but does not own recovery intent.",
      },
    ],
    scores: {
      intentDifferentiation: 4,
      editorialUsefulness: 5,
      productDifferentiation: 3,
      audienceClarity: 4,
      seasonalValue: 1,
      commercialPotential: 3,
      visualDistributionPotential: 3,
      productReusePotential: 2,
      thinContentRisk: 2,
      cannibalizationRisk: 2,
      maintenanceCost: 1,
    },
    advisory: {
      recommendation: "hold",
      reason: "Confirm enough distinct product categories before approving a brief.",
    },
    sourceSignalIds: ["gap_nurse-night-shift"],
    status: "generated",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  });
}

function opportunityContentFixture(): ValidatedPublicContent {
  return {
    products: [
      productSchema.parse({
        schemaVersion: 1,
        id: "product_fixture-care-kit",
        name: "Portable care kit",
        merchant: "Fixture Merchant",
        shortDescription: "A compact set for everyday routines.",
        categories: ["care accessories", "portable organization"],
        recipients: ["nurses"],
        status: "active",
      }),
    ],
    guides: [
      {
        schemaVersion: 1,
        id: "guide_nurse-practical",
        pageType: "gift-guide",
        clusterId: "cluster_nurse-gifts",
        slug: "practical",
        language: "en-US",
        title: "Practical Gifts for Nurses",
        excerpt: "Useful gifts organized around real routines.",
        introduction: "Choose a gift that solves one modest everyday problem well.",
        primaryAxis: "gift-style",
        primaryIntent: "Help a giver choose a useful gift for a nurse.",
        taxonomies: { recipients: ["nurses"], giftStyles: ["practical"] },
        seoTitle: "Practical Gifts for Nurses | The Good Present",
        seoDescription: "A fixture guide for practical nurse gift ideas.",
        status: "published",
        publishedAt: "2026-08-03",
        recommendations: [
          {
            id: "practical_fixture-care-kit",
            productResolution: "unresolved",
            position: 1,
            heading: "A compact care kit",
            editorialDescription: "A small kit keeps a few everyday items together.",
            whyItFits: "It supports an existing routine without adding clutter.",
            editorialStatus: "ready",
          },
        ],
      },
    ],
    clusters: [
      {
        schemaVersion: 1,
        id: "cluster_nurse-gifts",
        pageType: "cluster-hub",
        slug: "nurse-gifts",
        language: "en-US",
        title: "Nurse Gifts",
        excerpt: "Thoughtful gifts for nurses.",
        introduction: "Start with the recipient and the routine the gift should support.",
        seoTitle: "Nurse Gifts | The Good Present",
        seoDescription: "A fixture cluster for nurse gift guides.",
        navigationGroups: [
          {
            id: "group_fixture-practical",
            label: "Practical gifts",
            axis: "gift-style",
            guideIds: ["guide_nurse-practical"],
          },
        ],
        status: "published",
        publishedAt: "2026-08-01",
      },
    ],
  };
}

async function writeOpportunityContentFixture(repository: string) {
  const content = opportunityContentFixture();
  for (const [directory, records] of [
    ["products", content.products],
    ["guides", content.guides],
    ["clusters", content.clusters],
  ] as const) {
    await mkdir(join(repository, "content", directory), { recursive: true });
    for (const record of records) {
      await atomicWriteJson(join(repository, "content", directory, `${record.id}.json`), record);
    }
  }
  return readPublicContent(repository);
}

function configuredAmazonProgram() {
  return affiliateProgramSchema.parse({
    id: "amazon-us",
    programId: "amazon-associates",
    marketplace: "amazon.com",
    storeOrAssociateId: "thegoodpresent-20",
    allowedTrackingIds: ["thegoodpresent-20", "seasonal-20"],
    approvedHosts: ["amazon.com", "www.amazon.com", "smile.amazon.com", "amzn.to", "a.co"],
    disclosureText: "The Good Present may earn from qualifying purchases.",
    disclosureVersion: "2026-08-08",
    enabled: true,
  });
}

function amazonIntakeInput(
  overrides: Partial<Parameters<typeof validateAmazonAffiliateIntake>[0]> = {},
) {
  return {
    productUrl: "https://www.amazon.com/dp/B012345678",
    affiliateUrl: "https://www.amazon.com/dp/B012345678?tag=thegoodpresent-20",
    trackingId: "thegoodpresent-20",
    ...overrides,
  };
}

function manualProductIntakeInput(
  overrides: Partial<ManualProductIntakeInput> = {},
): ManualProductIntakeInput {
  return {
    productUrl: "https://www.amazon.com/dp/Z123456789",
    asin: "Z123456789",
    name: "Manual intake product",
    brand: "Manual Brand",
    merchant: "Amazon",
    shortDescription: "Original editorial copy for a manually reviewed product.",
    sourceFacts: ["Vacuum insulated", "BPA-free materials"],
    verifiedFacts: ["Vacuum insulated"],
    verifiedFactsConfirmed: true,
    categories: ["nurse gifts"],
    interests: ["practical gifts"],
    recipients: ["nurses"],
    occasions: ["graduation"],
    image: "https://images.example.test/manual-intake.png",
    imageAlt: "A manually reviewed product",
    imageRightsNotes: "Editor verified the image reference and rights status.",
    provenanceNotes: "Entered from an editor-verified source record.",
    status: "active",
    ...overrides,
  };
}

function manualProductIntakeForm(
  input: ManualProductIntakeInput,
  overrides: Record<string, string> = {},
): URLSearchParams {
  const values: Record<string, string> = {
    name: input.name,
    merchant: input.merchant,
    shortDescription: input.shortDescription,
    sourceFacts: input.sourceFacts.join("\n"),
    verifiedFacts: input.verifiedFacts.join("\n"),
    status: input.status,
  };
  for (const [name, value] of Object.entries({
    productUrl: input.productUrl,
    affiliateUrl: input.affiliateUrl,
    asin: input.asin,
    trackingId: input.trackingId,
    brand: input.brand,
    priceLabel: input.priceLabel,
    image: input.image,
    imageAlt: input.imageAlt,
    imageRightsNotes: input.imageRightsNotes,
    provenanceNotes: input.provenanceNotes,
    categories: input.categories?.join(","),
    interests: input.interests?.join(","),
    recipients: input.recipients?.join(","),
    occasions: input.occasions?.join(","),
    productId: input.productId,
    sourceId: input.sourceId,
    importedAt: input.importedAt,
  })) {
    if (value !== undefined) values[name] = value;
  }
  if (input.verifiedFactsConfirmed) values.verifiedFactsConfirmed = "yes";
  return new URLSearchParams({ ...values, ...overrides });
}

function productCoverageFixture() {
  const base = readPublicContent();
  const template = base.products[0]!;
  const product = (id: string, overrides: Partial<Product> = {}): Product => ({
    ...template,
    id,
    name: id,
    merchant: "Coverage fixture",
    shortDescription: "Coverage fixture product.",
    categories: [],
    recipients: [],
    occasions: [],
    status: "active",
    ...overrides,
  });
  const products = [
    product("product_reused", {
      categories: ["common"],
      recipients: ["nurses", "students", "caregivers"],
    }),
    product("product_common-two", { categories: ["common"] }),
    product("product_common-three", { categories: ["common"] }),
    product("product_single", { categories: ["single"] }),
    product("product_unused"),
    product("product_inactive", {
      categories: ["common", "inactive-only"],
      recipients: ["one", "two", "three", "four"],
      status: "inactive",
    }),
  ];
  const recommendation = base.guides[0]!.recommendations[0]!;
  assert.ok(recommendation.productId);
  const guide = (id: string, index: number, duplicate = false) => ({
    ...base.guides[0]!,
    id,
    clusterId: "cluster_low-diversity",
    slug: `coverage-${index}`,
    title: `Coverage guide ${index}`,
    recommendations: [
      { ...recommendation, id: `${id}_one`, position: 1, productId: "product_reused" },
      ...(duplicate
        ? [{ ...recommendation, id: `${id}_two`, position: 2, productId: "product_reused" }]
        : []),
    ],
  });
  const guides = [
    guide("guide_coverage-one", 1, true),
    guide("guide_coverage-two", 2),
    guide("guide_coverage-three", 3),
  ];
  const content: ValidatedPublicContent = {
    products,
    guides,
    clusters: [
      {
        ...base.clusters[0]!,
        id: "cluster_low-diversity",
        slug: "coverage-low-diversity",
        title: "Low-diversity cluster",
        navigationGroups: [],
      },
    ],
  };
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_coverage-draft"),
    title: "Coverage draft",
    status: "selecting-products",
    recommendations: [
      {
        id: "slot_orbital-telescope",
        position: 1,
        slotLabel: "Orbital telescope",
        slotIntent: "A telescope for deep-space observation",
        searchTerms: ["astronomy", "telescope"],
        editorialStatus: "unassigned",
      },
    ],
  });
  const report = productGapReportSchema.parse({
    schemaVersion: 1,
    id: "gap_coverage-brief",
    recordType: "product-gap-report",
    guideId: draft.id,
    clusterId: "cluster_low-diversity",
    route: "/coverage-low-diversity/draft/",
    checkedAt: "2026-08-09",
    status: "blocked",
    candidateProductIds: [],
    catalogSnapshot: {
      activeCandidateProductIds: [],
      verifiedCandidateProductIds: [],
      productSourceRecordCount: 0,
    },
    slots: [
      {
        id: "requirement_dark-sky",
        label: "Dark-sky field guide",
        category: "Dark-sky field guide",
        status: "unassigned",
        reason: "No canonical product covers this structured brief requirement.",
      },
    ],
    gaps: ["The brief requirement has no catalog coverage."],
    blockers: ["No product is assigned."],
    nextActions: ["Review the catalog manually."],
  });
  return { content, draft, report };
}

function fitSourcingRequest(
  requestId: string,
  candidateId: string,
  productClass: string,
  overrides: { name?: string; sourceFacts?: string[]; observedPrice?: string } = {},
) {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const base = createProductSourcingRequest(
    {
      origin: {
        kind: "recommendation-slot",
        guideDraftId: "guide_fit-evaluation",
        recommendationSlotId: `slot_${requestId.replace(/^request_/, "")}`,
      },
      intendedRole: `Serve the ${productClass} role in a specific work routine.`,
      requiredCategory: productClass,
      audience: "A nurse or firefighter in the stated work context",
      occasion: "Career milestone",
      budgetContext: "Under $75",
      mustHaveVerifiedFacts: [],
      exclusions: ["generic profession slogans"],
      searchTerms: [productClass],
    },
    now,
    requestId,
  );
  const withCandidate = addProductSourceCandidates(
    base,
    [
      {
        id: candidateId,
        sourceKind: "serpapi",
        provider: "SerpAPI",
        merchant: "Observed merchant",
        name: overrides.name ?? `${productClass} candidate`,
        sourceFacts: overrides.sourceFacts ?? ["Observed material detail"],
        query: productClass,
        observedAt: now.toISOString(),
        ...(overrides.observedPrice ? { observedPrice: overrides.observedPrice } : {}),
      },
    ],
    now,
  );
  return productSourcingRequestSchema.parse({
    ...withCandidate,
    searchPlan: {
      productClass,
      mustHaveAttributes: [],
      usefulAttributes: [],
      exclusions: withCandidate.exclusions,
      queries: [productClass],
      providerId: "mock",
      modelId: "mock-editorial-v1",
      promptVersion: "product-search-plan-v1",
      plannedAt: now.toISOString(),
    },
  });
}

test("discrimina borradores estrictos de hub y guía", () => {
  const cluster = createClusterDraft("cluster_test", new Date("2026-08-08T00:00:00.000Z"));
  const guide = createGuideDraft("guide_test", new Date("2026-08-08T00:00:00.000Z"));

  assert.equal(editorialDraftSchema.parse(cluster).draftType, "cluster-hub");
  assert.equal(editorialDraftSchema.parse(guide).draftType, "gift-guide");
  assert.equal(clusterDraftSchema.safeParse({ ...cluster, recommendations: [] }).success, false);
  assert.equal(guideDraftSchema.safeParse({ ...guide, navigationGroups: [] }).success, false);
});

test("crea borradores incompletos válidos con identidad estable", () => {
  const cluster = createClusterDraft("cluster_test");
  const guide = createGuideDraft("guide_test");

  assert.equal(cluster.id, "cluster_test");
  assert.equal(cluster.status, "editing");
  assert.equal(guide.id, "guide_test");
  assert.equal(guide.questionnaire.giftCount, DEFAULT_GIFT_COUNT);
  assert.equal(guide.status, "questionnaire");
});

test("limita la cantidad de regalos entre 3 y 20", () => {
  const guide = createGuideDraft("guide_test");
  assert.equal(
    guideDraftSchema.safeParse({
      ...guide,
      questionnaire: { giftCount: MIN_GIFT_COUNT - 1 },
    }).success,
    false,
  );
  assert.equal(
    guideDraftSchema.safeParse({
      ...guide,
      questionnaire: { giftCount: MAX_GIFT_COUNT + 1 },
    }).success,
    false,
  );
});

test("guarda, relee y reemplaza borradores con escritura atómica", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-drafts-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DraftStore(directory);
  const created = await store.save(
    createGuideDraft("guide_atomic", new Date("2026-08-08T00:00:00.000Z")),
    new Date("2026-08-08T01:00:00.000Z"),
  );
  const updated = await store.save(
    { ...created, title: "A useful guide" },
    new Date("2026-08-08T02:00:00.000Z"),
  );

  assert.equal((await store.read(created.id)).title, "A useful guide");
  assert.equal(updated.updatedAt, "2026-08-08T02:00:00.000Z");
  assert.deepEqual((await store.list()).errors, []);
  assert.deepEqual(await readdir(directory), ["guide_atomic.json"]);
  assert.equal(
    JSON.parse(await readFile(join(directory, "guide_atomic.json"), "utf8")).id,
    created.id,
  );
});

test("limpia el temporal si falla el reemplazo atómico", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-write-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "guide_failure.json");
  await mkdir(target);

  await assert.rejects(atomicWriteJson(target, { id: "guide_failure" }));
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("rechaza nombres inseguros y el Studio sólo enlaza loopback", () => {
  assert.throws(() => assertSafeDraftId("../outside"), /no válido/);
  assert.throws(() => assertSafeDraftId("Guide Uppercase"), /no válido/);
  assert.equal(STUDIO_HOST, "127.0.0.1");
});

test("sirve la lista y crea un borrador por HTTP sólo en loopback", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-http-"));
  const server = createStudioServer(new DraftStore(directory));
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, STUDIO_HOST);
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const homeResponse = await fetch(origin);
  assert.equal(homeResponse.status, 200);
  assert.match(await homeResponse.text(), /Borradores editoriales/);

  const createResponse = await fetch(`${origin}/drafts/cluster`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: "Nurses", slug: "nurses" }),
    redirect: "manual",
  });
  assert.equal(createResponse.status, 303);
  assert.match(createResponse.headers.get("location") ?? "", /^\/drafts\/cluster_/);
  assert.equal((await readdir(directory)).length, 1);
});

test("busca productos por texto y etiquetas, filtra estado y muestra uso", () => {
  const content = new ProductCatalog().read();
  const matches = matchProducts(content.products, "drinkware nurses", "active");
  assert.ok(matches.some((product) => product.id === "product_insulated-tumbler"));
  assert.ok(
    productUsage(content.guides, "product_insulated-tumbler").some(
      (guide) => guide.id === "guide_nurse-practical",
    ),
  );
  assert.equal(matchProducts(content.products, "", "inactive").length, 0);
});

test("explains every coverage signal with canonical IDs without rewarding artificial reuse", () => {
  const { content, draft, report } = productCoverageFixture();
  const analysis = analyzeProductCoverage(content, [draft], [report]);
  const health = analysis.catalogHealth;

  assert.ok(health.activeProductsUnused.some((product) => product.productId === "product_unused"));
  assert.deepEqual(
    health.inactiveProducts.map(({ product }) => product.productId),
    ["product_inactive"],
  );
  assert.equal(
    health.activeProductsUnused.some((product) => product.productId === "product_inactive"),
    false,
  );
  const reused = health.productsReusedAcrossGuides.find(
    ({ product }) => product.productId === "product_reused",
  )!;
  assert.deepEqual(
    reused.guides.map(({ guideId }) => guideId),
    ["guide_coverage-one", "guide_coverage-three", "guide_coverage-two"],
  );
  assert.equal(reused.guides.length, 3, "duplicate recommendations count once per guide");
  assert.deepEqual(
    health.substantialCategories
      .find(({ category }) => category === "common")
      ?.products.map(({ productId }) => productId),
    ["product_common-three", "product_common-two", "product_reused"],
  );
  assert.equal(
    health.substantialCategories
      .find(({ category }) => category === "common")
      ?.products.some(({ productId }) => productId === "product_inactive"),
    false,
  );
  assert.deepEqual(
    health.singleProductCategories
      .find(({ category }) => category === "single")
      ?.products.map(({ productId }) => productId),
    ["product_single"],
  );
  assert.deepEqual(health.clustersWithLowCategoryDiversity[0]?.categories, ["common"]);
  assert.equal(health.clustersWithLowCategoryDiversity[0]?.guides.length, 3);
  assert.equal(health.clustersWithLowCategoryDiversity[0]?.products.length, 1);
  assert.deepEqual(
    health.productsWithBroadMetadata.map(({ productId }) => productId),
    ["product_reused"],
  );
  assert.deepEqual(
    analysis.editorialCoverage.draftSlotsWithoutSuitableProducts.map(({ slotId }) => slotId),
    ["slot_orbital-telescope"],
  );
  assert.deepEqual(
    analysis.editorialCoverage.briefRequirementsWithoutCatalogCoverage.map(({ slotId }) => slotId),
    ["requirement_dark-sky"],
  );
});

test("applies explicit thresholds and preserves editorial signals with an empty catalog", () => {
  const { content, draft, report } = productCoverageFixture();
  const stricter = analyzeProductCoverage(content, [draft], [report], {
    reusedGuideCount: 4,
    substantialCategoryProductCount: 4,
    minimumClusterCategoryCount: 1,
    broadMetadataValueCount: 4,
    minimumSlotMatchTokenCount: 4,
  });
  assert.equal(stricter.catalogHealth.productsReusedAcrossGuides.length, 0);
  assert.equal(stricter.catalogHealth.substantialCategories.length, 0);
  assert.equal(stricter.catalogHealth.clustersWithLowCategoryDiversity.length, 0);
  assert.equal(stricter.catalogHealth.productsWithBroadMetadata.length, 0);
  assert.throws(
    () => analyzeProductCoverage(content, [], [], { reusedGuideCount: 0 }),
    /positive integer/,
  );

  const empty = analyzeProductCoverage(
    { products: [], guides: [], clusters: [] },
    [draft],
    [report],
  );
  assert.deepEqual(empty.catalogHealth.activeProductsUnused, []);
  assert.deepEqual(empty.catalogHealth.inactiveProducts, []);
  assert.deepEqual(empty.catalogHealth.substantialCategories, []);
  assert.deepEqual(empty.catalogHealth.singleProductCategories, []);
  assert.equal(empty.editorialCoverage.draftSlotsWithoutSuitableProducts.length, 1);
  assert.equal(empty.editorialCoverage.briefRequirementsWithoutCatalogCoverage.length, 1);
});

test("shows traceability in Studio and excludes product intelligence from the public build", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-intelligence-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const draftStore = new DraftStore(join(repository, "drafts"));
  const { draft, report } = productCoverageFixture();
  const sentinel = "INTERNAL_COVERAGE_SENTINEL_20260809";
  await draftStore.save({
    ...draft,
    title: sentinel,
    recommendations: [
      {
        ...draft.recommendations[0]!,
        slotLabel: sentinel,
        searchTerms: [sentinel],
      },
    ],
  });
  await mkdir(join(repository, "editorial-data", "product-gaps"), { recursive: true });
  await writeFile(
    join(repository, "editorial-data", "product-gaps", `${report.id}.json`),
    `${JSON.stringify({
      ...report,
      slots: [
        {
          ...report.slots[0]!,
          category: sentinel,
          reason: `${sentinel} remains Studio-only.`,
        },
      ],
    })}\n`,
  );
  const sourcingRequest = createProductSourcingRequest(
    {
      origin: {
        kind: "recommendation-slot",
        guideDraftId: draft.id,
        recommendationSlotId: draft.recommendations[0]!.id,
      },
      intendedRole: sentinel,
      requiredCategory: sentinel,
      audience: "Studio-only audience",
      occasion: "Studio-only occasion",
      budgetContext: "Studio-only budget",
      searchTerms: [sentinel],
    },
    new Date("2026-08-09T00:00:00.000Z"),
    "request_intelligence-sentinel",
  );
  await new ProductSourcingRequestStore(repository).save(sourcingRequest);
  await new EditorialFeedbackStore(repository).record({
    eventType: "recommendation-left-idea-only",
    guideId: draft.id,
    recommendationId: draft.recommendations[0]!.id,
    requestId: sourcingRequest.id,
    rationale: `${sentinel} remains internal feedback evidence.`,
  });
  const catalog = new ProductCatalog(repository);
  const server = createStudioServer(
    draftStore,
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    new ProductSourceStore(repository),
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(repository, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://${STUDIO_HOST}:${address.port}/product-intelligence`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Cobertura de productos/);
  assert.match(html, new RegExp(sentinel));
  assert.match(html, /gap_coverage-brief/);
  assert.match(html, /no proponen guías/);
  const sourcingResponse = await fetch(
    `http://${STUDIO_HOST}:${address.port}/product-sourcing/${sourcingRequest.id}`,
  );
  assert.equal(sourcingResponse.status, 200);
  assert.match(await sourcingResponse.text(), new RegExp(sentinel));

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const outputFiles = await readdir(join(REPOSITORY_ROOT, "apps", "site", "dist"), {
    recursive: true,
  });
  const outputHtml = (
    await Promise.all(
      outputFiles
        .filter((file) => file.endsWith(".html"))
        .map((file) => readFile(join(REPOSITORY_ROOT, "apps", "site", "dist", file), "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(
    outputFiles.join("\n"),
    /product-intelligence|gap_coverage-brief|request_intelligence-sentinel|editorial-feedback|feedback_event/,
  );
  assert.doesNotMatch(outputHtml, new RegExp(sentinel));
  assert.doesNotMatch(outputHtml, /product-gap-report|editorial-data/);
});

test("valida candidatos, puntajes separados, decisiones y transiciones acotadas", () => {
  const generated = articleCandidate();
  assert.equal(generated.scores.intentDifferentiation, 4);
  assert.equal(generated.scores.cannibalizationRisk, 2);
  assert.equal(
    articleCandidateSchema.safeParse({ ...generated, aggregateScore: 42 }).success,
    false,
  );
  assert.equal(
    articleCandidateSchema.safeParse({
      ...generated,
      scores: { ...generated.scores, editorialUsefulness: 11 },
    }).success,
    false,
  );
  assert.equal(
    articleCandidateSchema.safeParse({ ...generated, status: "rejected" }).success,
    false,
  );

  const evaluated = transitionArticleCandidate(
    generated,
    "evaluated",
    new Date("2026-08-09T01:00:00.000Z"),
  );
  const shortlisted = transitionArticleCandidate(
    evaluated,
    "shortlisted",
    new Date("2026-08-09T02:00:00.000Z"),
  );
  assert.equal(shortlisted.status, "shortlisted");
  assert.throws(() => transitionArticleCandidate(generated, "shortlisted"), /Cannot transition/);

  for (const [action, expectedStatus, targetContentId] of [
    ["create-article", "approved-for-brief", undefined],
    ["add-as-section", "converted-to-section", "guide_nurse-practical"],
    ["merge", "merged", "guide_nurse-practical"],
    ["hold", "evaluated", undefined],
    ["reject", "rejected", undefined],
  ] as const) {
    const decided = applyCandidateDecision(evaluated, {
      action,
      reason: `Human decision: ${action}.`,
      ...(targetContentId ? { targetContentId } : {}),
    });
    assert.equal(decided.status, expectedStatus);
    assert.equal(decided.decision?.action, action);
  }
  const held = applyCandidateDecision(evaluated, {
    action: "hold",
    reason: "Keep the evaluated candidate without shortlisting it.",
  });
  assert.equal(held.status, "evaluated");
  assert.throws(
    () =>
      applyCandidateDecision(evaluated, {
        action: "add-as-section",
        reason: "A target is required.",
      }),
    /target content ID/,
  );

  const approved = applyCandidateDecision(evaluated, {
    action: "create-article",
    reason: "Approve planning without creating a brief or draft here.",
  });
  const tracedLaterState = articleCandidateSchema.parse({
    ...approved,
    status: "converted-to-draft",
    editorialBriefId: "brief_nurse-shift-recovery",
    guideDraftId: "guide_nurse-shift-recovery",
  });
  assert.equal(tracedLaterState.editorialBriefId, "brief_nurse-shift-recovery");
  assert.equal(tracedLaterState.guideDraftId, "guide_nurse-shift-recovery");
});

test("usa una raíz de contenido explícita y aislada para Opportunity Lab", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-opportunity-fixture-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const expected = opportunityContentFixture();
  const content = await writeOpportunityContentFixture(repository);
  const catalog = new ProductCatalog(repository);

  assert.notEqual(repository, REPOSITORY_ROOT);
  assert.equal(catalog.root, repository);
  assert.deepEqual(content, expected);
  assert.deepEqual(catalog.read(), expected);
  assert.deepEqual(
    content.products.map(({ id }) => id),
    ["product_fixture-care-kit"],
  );
});

test("persiste un brief editable, exige aprobación y crea un GuideDraft sin contenido público", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-editorial-brief-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const content = await writeOpportunityContentFixture(repository);
  const candidateStore = new ArticleCandidateStore(repository);
  const briefStore = new EditorialBriefStore(repository, candidateStore);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const evaluated = transitionArticleCandidate(articleCandidate(), "evaluated");
  await candidateStore.save(evaluated);

  const created = await approveCandidateForBrief(
    evaluated,
    "The editor approved a distinct recovery article for planning.",
    candidateStore,
    briefStore,
    new Date("2026-08-09T03:00:00.000Z"),
  );
  assert.equal(created.candidate.status, "approved-for-brief");
  assert.equal(created.candidate.editorialBriefId, created.brief.id);
  assert.equal(created.brief.status, "draft");
  assert.equal(
    editorialBriefSchema.parse(
      JSON.parse(await readFile(editorialBriefPath(repository, created.brief.id), "utf8")),
    ).id,
    created.brief.id,
  );

  const edited = updateEditorialBrief(created.brief, {
    workingTitle: "Recovery Gifts for Nurses After Long Shifts",
    proposedSlug: "nurse-shift-recovery-gifts",
    primaryAxis: created.brief.primaryAxis,
    primaryIntent: created.brief.primaryIntent,
    targetAudience: created.brief.targetAudience,
    problemSolved: created.brief.problemSolved,
    differentiation: "Own the off-shift recovery problem rather than broad practical utility.",
    plannedSections: created.brief.plannedSections,
    productRequirements: ["sleep support", "recovery tools"],
    researchQuestions: ["Which product facts require source verification?"],
    expectedInternalLinks: ["guide_nurse-practical"],
    relatedContentIds: ["guide_nurse-practical"],
    editorialEvidenceNotes: ["Confirm the section boundary during copy review."],
    risks: ["Avoid unsupported health claims."],
  });
  await briefStore.save(edited);
  assert.equal(briefStore.get(edited.id).workingTitle, edited.workingTitle);
  await assert.rejects(
    convertApprovedBriefToGuideDraft(edited, candidateStore, briefStore, draftStore, content),
    /Approve the brief/,
  );

  const approved = approveEditorialBrief(edited, new Date("2026-08-09T04:00:00.000Z"));
  await briefStore.save(approved);
  assert.throws(() => updateEditorialBrief(approved, {} as never), /draft brief/);
  const converted = await convertApprovedBriefToGuideDraft(
    approved,
    candidateStore,
    briefStore,
    draftStore,
    content,
    new Date("2026-08-09T05:00:00.000Z"),
  );
  assert.equal(converted.brief.status, "converted-to-guide-draft");
  assert.equal(converted.candidate.status, "converted-to-draft");
  assert.equal(converted.candidate.guideDraftId, converted.draft.id);
  assert.equal(converted.draft.status, "questionnaire");
  assert.equal(converted.draft.slug, edited.proposedSlug);
  assert.equal(converted.draft.recommendations.length, 0);
  assert.equal(converted.draft.questionnaire.recipient, edited.targetAudience);
  assert.equal(converted.draft.questionnaire.interests, "sleep support; recovery tools");
  assert.equal(converted.draft.questionnaire.avoid, "Avoid unsupported health claims.");
  assert.match(converted.draft.questionnaire.additional ?? "", /Own the off-shift recovery/);
  assert.match(converted.draft.questionnaire.additional ?? "", /Which product facts require/);
  assert.deepEqual(
    prepareOutlinePrompt(converted.draft, content).input.questionnaire,
    converted.draft.questionnaire,
  );
  assert.equal((await draftStore.read(converted.draft.id)).id, converted.draft.id);
  await assert.rejects(
    readFile(join(repository, "content", "guides", `${converted.draft.id}.json`), "utf8"),
  );
});

test("normaliza y explica por separado cada señal determinista", () => {
  assert.equal(
    normalizeComparisonText("  Récupération—NURSE'S Gifts!  "),
    "recuperation nurses gifts",
  );
  const candidate = articleCandidate({ proposedSlug: "shift-recovery" });
  const exactBrief: ApprovedEditorialBriefComparisonRecord = {
    id: "brief_exact-recovery",
    clusterId: candidate.clusterId,
    status: "approved",
    proposedTitle: candidate.proposedTitle,
    proposedSlug: candidate.proposedSlug,
    primaryAxis: candidate.primaryAxis,
    primaryIntent: candidate.primaryIntent,
    taxonomies: candidate.secondaryTaxonomies,
    problemSolved: candidate.problemSolved,
    proposedSections: candidate.proposedSections,
    productCategories: candidate.distinctiveProductCategories,
  };
  const partialBrief: ApprovedEditorialBriefComparisonRecord = {
    ...exactBrief,
    id: "brief_partial-recovery",
    proposedSlug: "shift-comfort",
    primaryAxis: "occasion",
  };
  const report = compareArticleCandidate(
    candidate,
    opportunityContentFixture(),
    [createGuideDraft("guide_comparison-draft")],
    [],
    [exactBrief, partialBrief],
  );
  const exact = report.nearestEditorialState.find(({ targetId }) => targetId === exactBrief.id);
  const partial = report.nearestEditorialState.find(({ targetId }) => targetId === partialBrief.id);
  assert.ok(exact && partial);
  assert.deepEqual(
    exact.signals.map(({ kind }) => kind),
    OPPORTUNITY_SIGNAL_KINDS,
  );
  assert.ok(exact.signals.every(({ level, reason }) => level === "high" && reason.length > 0));
  assert.equal(partial.signals.find(({ kind }) => kind === "slug-tokens")?.level, "medium");
  assert.equal(partial.signals.find(({ kind }) => kind === "primary-axis")?.level, "low");
  assert.ok(
    report.nearestEditorialState.some(({ targetKind }) => targetKind === "published-cluster"),
  );
  assert.ok(report.nearestEditorialState.some(({ targetKind }) => targetKind === "guide-draft"));
});

test("separa colisiones públicas, conserva decisiones previas y permite el override humano", () => {
  const content = opportunityContentFixture();
  const current = articleCandidate({ proposedSlug: "practical" });
  const shortlisted = transitionArticleCandidate(
    transitionArticleCandidate(current, "evaluated"),
    "shortlisted",
  );
  const priorBase = transitionArticleCandidate(
    transitionArticleCandidate(articleCandidate({ id: "candidate_prior" }), "evaluated"),
    "shortlisted",
  );
  const histories = [
    applyCandidateDecision(articleCandidate({ id: "candidate_rejected", status: "evaluated" }), {
      action: "reject",
      reason: "Rejected after review.",
    }),
    applyCandidateDecision(priorBase, {
      action: "merge",
      reason: "Merged into the practical guide.",
      targetContentId: "guide_nurse-practical",
    }),
    applyCandidateDecision(
      transitionArticleCandidate(
        transitionArticleCandidate(articleCandidate({ id: "candidate_held" }), "evaluated"),
        "shortlisted",
      ),
      { action: "hold", reason: "Held for changed evidence." },
    ),
    applyCandidateDecision(
      transitionArticleCandidate(
        transitionArticleCandidate(
          articleCandidate({
            id: "candidate_section",
            sourceSignalIds: ["gap_prior-evidence"],
          }),
          "evaluated",
        ),
        "shortlisted",
      ),
      {
        action: "add-as-section",
        reason: "Converted to a section.",
        targetContentId: "guide_nurse-practical",
      },
    ),
    articleCandidate({ id: "candidate_undecided" }),
  ];
  const report = compareArticleCandidate(current, content, [], histories);
  assert.match(report.publicContractViolations.join("\n"), /guide_nurse-practical/);
  assert.deepEqual(report.priorDecisionHistory.map(({ decision }) => decision?.action).sort(), [
    "add-as-section",
    "hold",
    "merge",
    "reject",
  ]);
  assert.equal(report.priorDecisionHistory.length, 4);
  assert.equal(
    report.priorDecisionHistory.find(({ targetId }) => targetId === "candidate_rejected")
      ?.evidenceChange?.changed,
    false,
  );
  assert.deepEqual(
    report.priorDecisionHistory.find(({ targetId }) => targetId === "candidate_section")
      ?.evidenceChange?.addedSourceSignalIds,
    ["gap_nurse-night-shift"],
  );

  const deliberate = applyCandidateDecision(shortlisted, {
    action: "create-article",
    reason: "The editor accepts the visible overlap and deliberately approves planning.",
  });
  assert.equal(deliberate.status, "approved-for-brief");
  assert.equal(current.advisory.recommendation, "hold");
});

test("construye un prompt divergente determinista y rechaza evidencia o campos protegidos", async () => {
  const content = opportunityContentFixture();
  const request = {
    clusterId: "cluster_nurse-gifts",
    sessionMode: "intent-first" as const,
    sessionObjective: "find-missing-intents" as const,
    editorialIntent: "Find a distinct audience problem within the nurse gifts cluster.",
    candidateCount: 2,
    targetMarket: "US",
    language: "en-US",
    planningHorizon: "Next six months",
  };
  const draft = createGuideDraft("guide_prompt-context");
  const first = prepareOpportunityGenerationPrompt(request, content, [draft], [], []);
  const second = prepareOpportunityGenerationPrompt(request, content, [draft], [], []);
  assert.equal(first.prompt, second.prompt);
  assert.equal(first.version, OPPORTUNITY_GENERATION_PROMPT_VERSION);
  assert.match(first.prompt, /conceptually distinct/);
  assert.match(first.prompt, /Do not rank, score, shortlist/);
  assert.doesNotMatch(first.prompt, /AI_API_KEY|authorization/i);

  const mock = new MockGuideGenerationProvider();
  const generated = await mock.generateStructured({
    operation: "opportunity-candidates",
    prompt: first.prompt,
    input: first.input,
    schema: generatedOpportunityBatchSchema,
  });
  assert.equal(generated.candidates.length, 2);
  assert.ok(
    generated.candidates.every(
      ({ evidenceBasis }) => evidenceBasis === "editorial-hypothesis-only",
    ),
  );
  assert.equal(
    generatedOpportunityBatchSchema.safeParse({
      candidates: [{ ...generated.candidates[0], id: "candidate_ai-controlled" }],
    }).success,
    false,
  );
  for (const category of ["Multicolor click pen set", "retractable click pen", "click-top pen"]) {
    assert.equal(
      generatedOpportunityBatchSchema.safeParse({
        candidates: [{ ...generated.candidates[0], distinctiveProductCategories: [category] }],
      }).success,
      true,
    );
  }
  for (const problemSolved of [
    "The prior page received 100 clicks.",
    "The category has a 25% conversion rate.",
    "The keyword receives 1,000 monthly searches.",
    "Traffic data proves this audience converts.",
  ]) {
    assert.equal(
      generatedOpportunityBatchSchema.safeParse({
        candidates: [{ ...generated.candidates[0], problemSolved }],
      }).success,
      false,
    );
  }
  assert.equal(
    generatedOpportunityBatchSchema.safeParse({
      candidates: [
        {
          ...generated.candidates[0],
          problemSolved: "Targets a high search volume with low keyword difficulty.",
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    generatedOpportunityBatchSchema.safeParse({
      candidates: Array.from({ length: MAX_OPPORTUNITY_CANDIDATE_COUNT + 1 }, (_, index) => ({
        ...generated.candidates[0],
        proposedTitle: `Distinct candidate ${index}`,
      })),
    }).success,
    false,
  );
  assert.equal(
    generatedOpportunityBatchSchema.safeParse({
      candidates: Array.from({ length: MAX_OPPORTUNITY_CANDIDATE_COUNT }, (_, index) => ({
        ...generated.candidates[0],
        proposedTitle: `Allowed candidate ${index}`,
      })),
    }).success,
    true,
  );
});

test("ejecuta los tres modos I.1 con procedencia y el ciclo de vida ordinario", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-opportunity-modes-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const content = await writeOpportunityContentFixture(repository);
  const productCoverage = analyzeProductCoverage(content);
  const coverageSignal = opportunityCoverageSignals(productCoverage)[0]!;
  const sourceProduct = content.products.find(
    ({ categories, status }) => status === "active" && Boolean(categories?.length),
  );
  assert.ok(sourceProduct);
  const candidateStore = new ArticleCandidateStore(repository);
  const provider = new MockGuideGenerationProvider();
  const requests = [
    {
      clusterId: "cluster_nurse-gifts",
      sessionMode: "intent-first" as const,
      sessionObjective: "find-missing-intents" as const,
      editorialIntent: "Help families choose for a nurse facing a specific work transition.",
      candidateCount: 1,
      targetMarket: "US",
      language: "en-US",
    },
    {
      clusterId: "cluster_nurse-gifts",
      sessionMode: "product-first" as const,
      sessionObjective: "reuse-existing-products" as const,
      sourceProductIds: [sourceProduct.id],
      candidateCount: 1,
      targetMarket: "US",
      language: "en-US",
    },
    {
      clusterId: "cluster_nurse-gifts",
      sessionMode: "coverage-first" as const,
      sessionObjective: "find-section-opportunities" as const,
      sourceCoverageSignalIds: [coverageSignal.id],
      candidateCount: 1,
      targetMarket: "US",
      language: "en-US",
    },
  ];

  assert.equal(
    opportunityGenerationRequestSchema.safeParse({
      ...requests[0],
      editorialIntent: undefined,
    }).success,
    false,
  );
  assert.equal(
    opportunityGenerationRequestSchema.safeParse({
      ...requests[1],
      sourceProductIds: [],
    }).success,
    false,
  );
  assert.equal(
    opportunityGenerationRequestSchema.safeParse({
      ...requests[2],
      sourceCoverageSignalIds: [],
    }).success,
    false,
  );

  const generated: ArticleCandidate[] = [];
  for (const request of requests) {
    const result = await generateDivergentOpportunities(request, {
      content,
      drafts: [],
      existingCandidates: candidateStore.list(),
      productCoverage,
      provider,
      candidateStore,
      repositoryRoot: repository,
    });
    assert.equal(result.candidates[0]?.sessionMode, request.sessionMode);
    assert.equal(result.candidates[0]?.status, "generated");
    assert.equal(result.comparisons.length, 1);
    generated.push(result.candidates[0]!);
  }

  const productFirst = generated[1]!;
  assert.deepEqual(productFirst.sourceProductIds, [sourceProduct.id]);
  assert.ok(productFirst.sourceCategoryIds?.length);
  assert.ok(
    productFirst.primaryIntent && productFirst.problemSolved && productFirst.targetAudience,
  );
  assert.ok(productFirst.proposedSections.length);
  assert.ok(productFirst.distinctiveProductCategories.length >= 2);
  assert.ok(productFirst.differentiation && productFirst.maintenanceImplications);
  assert.deepEqual(generated[2]?.sourceCoverageSignalIds, [coverageSignal.id]);
  assert.deepEqual(generated[2]?.sourceProductIds, coverageSignal.sourceProductIds);
  assert.deepEqual(
    generated[2]?.sourceCategoryIds,
    coverageSignal.sourceCategories.map(({ id }) => id),
  );

  const evaluationStore = new OpportunityEvaluationStore(repository);
  const evaluated = await evaluateConvergentOpportunities(
    { candidateIds: generated.map(({ id }) => id) },
    {
      content,
      drafts: [],
      existingCandidates: generated,
      productCoverage,
      provider,
      candidateStore,
      evaluationStore,
    },
  );
  assert.ok(evaluated.candidates.every(({ status }) => status === "evaluated"));
  const rejected = applyCandidateDecision(evaluated.candidates[0]!, {
    action: "reject",
    reason: "The editor found no justified public action.",
  });
  const section = applyCandidateDecision(
    transitionArticleCandidate(evaluated.candidates[1]!, "shortlisted"),
    {
      action: "add-as-section",
      reason: "The editor chose a substantive section instead of a new URL.",
      targetContentId: "guide_nurse-practical",
    },
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(section.status, "converted-to-section");
});

test("construye un prompt convergente determinista y valida puntajes, destinos y procedencia", () => {
  const content = opportunityContentFixture();
  const candidate = articleCandidate();
  const importedSignal = {
    id: "signal_manual-window",
    source: "Manual analytics export",
    dateRange: { from: "2026-07-01", to: "2026-07-31" },
    summary: "Editors observed repeated interest in post-shift recovery during this window.",
  };
  const request = { candidateIds: [candidate.id], importedSignals: [importedSignal] };
  const coverage = analyzeProductCoverage(content);
  const first = prepareOpportunityEvaluationPrompt(request, content, [], [candidate], coverage);
  const second = prepareOpportunityEvaluationPrompt(request, content, [], [candidate], coverage);
  assert.equal(first.prompt, second.prompt);
  assert.equal(first.version, OPPORTUNITY_EVALUATION_PROMPT_VERSION);
  assert.match(first.prompt, /system-derived facts/);
  assert.match(first.prompt, /Missing evidence.*never be treated as zero/);
  assert.match(first.prompt, /Do not calculate or return a composite score/);
  assert.match(first.prompt, /omit its corresponding risk-action field entirely/);
  assert.match(first.prompt, /Never use null or an empty string for any conditional field/);
  assert.doesNotMatch(
    first.prompt.match(/Return exactly one JSON object[^\n]*:\n([^\n]+)/)?.[1] ?? "",
    /RiskAction|targetContentId/,
  );
  assert.doesNotMatch(first.prompt, /AI_API_KEY|authorization/i);

  assert.equal(importedEvaluationSignalSchema.safeParse(importedSignal).success, true);
  assert.equal(
    importedEvaluationSignalSchema.safeParse({
      ...importedSignal,
      dateRange: { from: "2026-08-01", to: "2026-07-01" },
    }).success,
    false,
  );
  const judgment = {
    candidateId: candidate.id,
    scores: { ...candidate.scores, editorialUsefulness: 10 },
    recommendation: "hold" as const,
    explanation: "Keep the candidate pending a human comparison.",
    missingEvidence: [],
    productConcentrationRisk: "The candidate spans more than one product category.",
    catalogVolatility: "Catalog support must be rechecked before brief approval.",
  };
  assert.equal(opportunityAiJudgmentSchema.safeParse(judgment).success, true);
  assert.equal(
    opportunityAiJudgmentSchema.safeParse({
      ...judgment,
      scores: { ...judgment.scores, intentDifferentiation: 11 },
    }).success,
    false,
  );
  assert.equal(
    opportunityAiJudgmentSchema.safeParse({
      ...judgment,
      scores: { ...judgment.scores, intentDifferentiation: -1 },
    }).success,
    false,
  );
  assert.equal(
    opportunityAiJudgmentSchema.safeParse({ ...judgment, recommendation: "merge" }).success,
    false,
  );
  assert.equal(
    opportunityAiJudgmentSchema.safeParse({
      ...judgment,
      recommendation: "merge",
      targetContentId: "guide_nurse-practical",
    }).success,
    true,
  );
  assert.equal(
    opportunityAiJudgmentSchema.safeParse({
      ...judgment,
      targetContentId: "guide_nurse-practical",
    }).success,
    false,
  );
  assert.equal(
    opportunityAiJudgmentSchema.safeParse({
      ...judgment,
      scores: { ...judgment.scores, thinContentRisk: 7 },
    }).success,
    false,
  );
  assert.equal(
    opportunityAiJudgmentSchema.safeParse({
      ...judgment,
      scores: { ...judgment.scores, thinContentRisk: 7 },
      thinContentRiskAction: "Compare the proposed sections and hold if two cannot stand alone.",
    }).success,
    true,
  );
});

test("evalúa un lote sólo hasta evaluated y guarda metadata validada sin respuesta cruda", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-opportunity-evaluation-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const content = await writeOpportunityContentFixture(repository);
  const candidateStore = new ArticleCandidateStore(repository);
  const evaluationStore = new OpportunityEvaluationStore(repository);
  const candidate = articleCandidate({ proposedTitle: "PRIVATE_EVALUATION_SENTINEL" });
  await candidateStore.save(candidate);
  const result = await evaluateConvergentOpportunities(
    {
      candidateIds: [candidate.id],
      importedSignals: [
        {
          id: "signal_manual-window",
          source: "Manual export",
          dateRange: { from: "2026-07-01", to: "2026-07-31" },
          summary: "Observed editor-supplied interest during the stated window.",
        },
      ],
    },
    {
      content,
      drafts: [],
      existingCandidates: [candidate],
      productCoverage: analyzeProductCoverage(content),
      provider: new MockGuideGenerationProvider(),
      candidateStore,
      evaluationStore,
      now: new Date("2026-08-09T14:00:00.000Z"),
    },
  );

  assert.equal(result.candidates[0]?.status, "evaluated");
  assert.equal(result.candidates[0]?.decision, undefined);
  assert.equal(result.candidates[0]?.advisory.recommendation, "hold");
  assert.equal(result.candidates[0]?.scores.editorialUsefulness, 7);
  assert.deepEqual(result.candidates[0]?.sourceSignalIds, [
    "gap_nurse-night-shift",
    "signal_manual-window",
  ]);
  const stored = opportunityEvaluationSessionSchema.parse(
    JSON.parse(
      await readFile(opportunityEvaluationSessionPath(repository, result.session.id), "utf8"),
    ),
  );
  assert.equal(stored.providerId, "mock");
  assert.equal(stored.importedSignals[0]?.source, "Manual export");
  assert.equal("rawResponse" in stored, false);
  assert.doesNotMatch(JSON.stringify(stored), /api[_-]?key|authorization|bearer/i);
  assert.equal(candidateStore.get(candidate.id).status, "evaluated");
});

test("rechaza salida convergente inválida sin escribir candidatos ni evaluaciones", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-opportunity-evaluation-failure-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const content = await writeOpportunityContentFixture(repository);
  const candidateStore = new ArticleCandidateStore(repository);
  const evaluationStore = new OpportunityEvaluationStore(repository);
  const candidate = articleCandidate();
  await candidateStore.save(candidate);
  const invalidProvider: GuideGenerationProvider = {
    providerId: "invalid-evaluation-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      return request.schema.parse({
        batchSynthesis: "Invalid provider fixture.",
        evaluations: [
          {
            candidateId: candidate.id,
            scores: { ...candidate.scores, maintenanceCost: 11 },
            recommendation: "hold",
            explanation: "This must fail the score boundary.",
            missingEvidence: [],
          },
        ],
      });
    },
  };

  await assert.rejects(
    evaluateConvergentOpportunities(
      { candidateIds: [candidate.id] },
      {
        content,
        drafts: [],
        existingCandidates: [candidate],
        productCoverage: analyzeProductCoverage(content),
        provider: invalidProvider,
        candidateStore,
        evaluationStore,
      },
    ),
  );
  assert.equal(candidateStore.get(candidate.id).status, "generated");
  assert.deepEqual(evaluationStore.list(), []);
});

test("genera 20 candidatos mock, compara antes de persistir y guarda metadata sin credenciales", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-opportunity-generation-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const content = await writeOpportunityContentFixture(repository);
  const candidateStore = new ArticleCandidateStore(repository);
  const provider = new MockGuideGenerationProvider();
  const result = await generateDivergentOpportunities(
    {
      clusterId: "cluster_nurse-gifts",
      sessionMode: "intent-first",
      sessionObjective: "expand-cluster",
      editorialIntent: "Expand the cluster from a concrete gift-giver problem.",
      targetMarket: "US",
      language: "en-US",
    },
    {
      content,
      drafts: [],
      existingCandidates: [],
      provider,
      candidateStore,
      repositoryRoot: repository,
      now: new Date("2026-08-09T12:00:00.000Z"),
    },
  );

  assert.equal(result.candidates.length, DEFAULT_OPPORTUNITY_CANDIDATE_COUNT);
  assert.equal(result.comparisons.length, DEFAULT_OPPORTUNITY_CANDIDATE_COUNT);
  assert.equal(candidateStore.list().length, DEFAULT_OPPORTUNITY_CANDIDATE_COUNT);
  assert.ok(result.candidates.every(({ status }) => status === "generated"));
  assert.ok(result.candidates.every(({ advisory }) => advisory.recommendation === "hold"));
  assert.ok(
    result.candidates.every(({ scores }) => Object.values(scores).every((score) => score === 0)),
  );
  assert.ok(result.candidates.every(({ id }) => /^candidate_[a-f0-9-]+$/.test(id)));
  assert.ok(result.candidates.every(({ proposedSlug }) => !proposedSlug.includes("candidate_")));
  assert.ok(
    result.candidates.every(({ overlapSignals }) =>
      overlapSignals.every(({ reason }) => /shared|match|containment/i.test(reason)),
    ),
  );

  const storedSession = opportunityGenerationSessionSchema.parse(
    JSON.parse(
      await readFile(opportunityGenerationSessionPath(repository, result.session.id), "utf8"),
    ),
  );
  assert.equal(storedSession.requestedCandidateCount, DEFAULT_OPPORTUNITY_CANDIDATE_COUNT);
  assert.equal(storedSession.providerId, "mock");
  assert.doesNotMatch(JSON.stringify(storedSession), /api[_-]?key|authorization|bearer/i);
  assert.ok(
    result.candidates.every(({ generationSessionId }) => generationSessionId === result.session.id),
  );

  const sourceCandidate = transitionArticleCandidate(result.candidates[0]!, "evaluated");
  await candidateStore.save(sourceCandidate);
  const regenerated = await generateDivergentOpportunities(
    {
      clusterId: sourceCandidate.clusterId,
      sessionMode: "intent-first",
      sessionObjective: "expand-cluster",
      editorialIntent: sourceCandidate.primaryIntent,
      candidateCount: 1,
      targetMarket: "US",
      language: "en-US",
      regenerateFromCandidateId: sourceCandidate.id,
    },
    {
      content,
      drafts: [],
      existingCandidates: candidateStore.list(),
      provider,
      candidateStore,
      repositoryRoot: repository,
      now: new Date("2026-08-09T13:00:00.000Z"),
    },
  );
  assert.equal(regenerated.session.regenerationRequest?.sourceCandidateId, sourceCandidate.id);
  assert.equal(
    regenerated.session.regenerationRequest?.sourceGenerationSessionId,
    result.session.id,
  );
  assert.equal(regenerated.candidates[0]?.generationSessionId, regenerated.session.id);
  assert.equal(regenerated.candidates[0]?.regeneratedFromCandidateId, sourceCandidate.id);
  assert.equal(regenerated.candidates[0]?.regeneratedFromSessionId, result.session.id);
});

test("no persiste ante límites inválidos, salida inválida o fallas del proveedor", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-opportunity-failure-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const content = await writeOpportunityContentFixture(repository);
  const candidateStore = new ArticleCandidateStore(repository);
  let calls = 0;
  const invalidProvider: GuideGenerationProvider = {
    providerId: "invalid-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      calls += 1;
      return request.schema.parse({ candidates: [] });
    },
  };
  const generationContext = {
    content,
    drafts: [],
    existingCandidates: [],
    provider: invalidProvider,
    candidateStore,
    repositoryRoot: repository,
  };

  await assert.rejects(
    generateDivergentOpportunities(
      {
        clusterId: "cluster_nurse-gifts",
        sessionMode: "intent-first",
        sessionObjective: "expand-cluster",
        editorialIntent: "Expand the cluster from a concrete gift-giver problem.",
        candidateCount: MAX_OPPORTUNITY_CANDIDATE_COUNT + 1,
        targetMarket: "US",
        language: "en-US",
      },
      generationContext,
    ),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    generateDivergentOpportunities(
      {
        clusterId: "cluster_nurse-gifts",
        sessionMode: "intent-first",
        sessionObjective: "expand-cluster",
        editorialIntent: "Expand the cluster from a concrete gift-giver problem.",
        candidateCount: 1,
        targetMarket: "US",
        language: "en-US",
      },
      generationContext,
    ),
  );
  assert.equal(calls, 1);

  const failedProvider: GuideGenerationProvider = {
    providerId: "failed-fixture",
    async generateStructured<T>(): Promise<T> {
      throw new ProviderError("Provider unavailable.", "network");
    },
  };
  await assert.rejects(
    generateDivergentOpportunities(
      {
        clusterId: "cluster_nurse-gifts",
        sessionMode: "intent-first",
        sessionObjective: "expand-cluster",
        editorialIntent: "Expand the cluster from a concrete gift-giver problem.",
        candidateCount: 1,
        targetMarket: "US",
        language: "en-US",
      },
      { ...generationContext, provider: failedProvider },
    ),
    /Provider unavailable/,
  );
  const rejected = applyCandidateDecision(
    transitionArticleCandidate(articleCandidate(), "evaluated"),
    { action: "reject", reason: "The editor rejected this exact idea." },
  );
  const repeatedProvider: GuideGenerationProvider = {
    providerId: "repeated-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      return request.schema.parse({
        candidates: [
          {
            proposedTitle: rejected.proposedTitle,
            primaryAxis: rejected.primaryAxis,
            primaryIntent: rejected.primaryIntent,
            problemSolved: rejected.problemSolved,
            targetAudience: rejected.targetAudience,
            secondaryTaxonomies: rejected.secondaryTaxonomies,
            proposedSections: rejected.proposedSections,
            distinctiveProductCategories: rejected.distinctiveProductCategories,
            differentiation: "This does not differ from the rejected premise.",
            maintenanceImplications: "Recheck catalog support during ordinary maintenance.",
            productRequirements: rejected.distinctiveProductCategories,
            catalogGaps: [],
            potentialOverlapHypothesis: "This repeats the rejected editorial premise.",
            evidenceBasis: "editorial-hypothesis-only",
          },
        ],
      });
    },
  };
  await assert.rejects(
    generateDivergentOpportunities(
      {
        clusterId: rejected.clusterId,
        sessionMode: "intent-first",
        sessionObjective: "expand-cluster",
        editorialIntent: rejected.primaryIntent,
        candidateCount: 1,
        targetMarket: "US",
        language: "en-US",
      },
      {
        ...generationContext,
        existingCandidates: [rejected],
        provider: repeatedProvider,
      },
    ),
    /repite la oportunidad rechazada/,
  );
  assert.deepEqual(candidateStore.list(), []);
});

test("persiste candidatos atómicamente por ID seguro y valida referencias canónicas", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-opportunities-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await writeOpportunityContentFixture(repository);
  const store = new ArticleCandidateStore(repository);
  const candidate = articleCandidate();
  await store.save(candidate);
  assert.equal(store.get(candidate.id).proposedSlug, "shift-recovery");
  assert.equal(store.list().length, 1);
  assert.equal(
    JSON.parse(await readFile(articleCandidatePath(repository, candidate.id), "utf8")).id,
    candidate.id,
  );

  const evaluated = transitionArticleCandidate(candidate, "evaluated");
  await store.save(evaluated);
  assert.equal(store.get(candidate.id).status, "evaluated");
  assert.throws(() => articleCandidatePath(repository, "candidate_../outside"), /ID.*seguro/);
  await assert.rejects(
    store.save(articleCandidate({ id: "candidate_missing-cluster", clusterId: "cluster_missing" })),
    /cluster canónico/,
  );
  await assert.rejects(
    store.save(
      articleCandidate({
        id: "candidate_missing-content",
        closestExistingContentIds: ["guide_missing"],
      }),
    ),
    /contenido canónico/,
  );
  assert.deepEqual(
    (await readdir(join(repository, "editorial-data", "article-candidates"))).filter((name) =>
      name.endsWith(".tmp"),
    ),
    [],
  );
});

test("expone lista y detalle internos, guarda la decisión y excluye candidatos del build", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-opportunity-http-"));
  await writeOpportunityContentFixture(repository);
  const sentinel = "INTERNAL_OPPORTUNITY_SENTINEL_20260809";
  const candidateStore = new ArticleCandidateStore(repository);
  const candidate = articleCandidate({ proposedTitle: sentinel });
  await candidateStore.save(candidate);
  const approvedBrief: ApprovedEditorialBriefComparisonRecord = {
    id: "brief_http-comparison",
    clusterId: candidate.clusterId,
    status: "approved",
    proposedTitle: candidate.proposedTitle,
    proposedSlug: candidate.proposedSlug,
    primaryAxis: candidate.primaryAxis,
    primaryIntent: candidate.primaryIntent,
    taxonomies: candidate.secondaryTaxonomies,
    problemSolved: candidate.problemSolved,
    proposedSections: candidate.proposedSections,
    productCategories: candidate.distinctiveProductCategories,
  };
  const catalog = new ProductCatalog(repository);
  const server = createStudioServer(
    new DraftStore(join(repository, "drafts")),
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    new ProductSourceStore(repository),
    candidateStore,
    [approvedBrief],
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(repository, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const listResponse = await fetch(`${origin}/opportunities`);
  const listHtml = await listResponse.text();
  assert.equal(listResponse.status, 200);
  assert.match(listHtml, new RegExp(sentinel));
  assert.match(listHtml, /no son métricas SEO objetivas/);
  assert.match(listHtml, /Generación divergente/);
  assert.match(listHtml, /Evaluación convergente/);
  assert.match(listHtml, /Buscar candidatos de localización/);

  const generationResponse = await fetch(`${origin}/opportunities/generate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      promptVersion: OPPORTUNITY_GENERATION_PROMPT_VERSION,
      clusterId: "cluster_nurse-gifts",
      sessionMode: "intent-first",
      sessionObjective: "find-section-opportunities",
      editorialIntent: "Find a focused audience problem that may fit an existing guide section.",
      candidateCount: "2",
      targetMarket: "US",
      language: "en-US",
    }),
    redirect: "manual",
  });
  assert.equal(generationResponse.status, 303);
  assert.equal(candidateStore.list().length, 3);
  assert.equal(
    (await readdir(join(repository, "editorial-data", "opportunity-generation-sessions"))).length,
    1,
  );
  const evaluationResponse = await fetch(`${origin}/opportunities/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      promptVersion: OPPORTUNITY_EVALUATION_PROMPT_VERSION,
      candidateId: candidate.id,
      signalId: "signal_http-window",
      signalSource: "Manual HTTP fixture",
      signalFrom: "2026-07-01",
      signalTo: "2026-07-31",
      signalSummary: "Editor-supplied observation for the integration test.",
    }),
    redirect: "manual",
  });
  assert.equal(evaluationResponse.status, 303);
  assert.equal(candidateStore.get(candidate.id).status, "evaluated");
  assert.equal(
    (await readdir(join(repository, "editorial-data", "opportunity-evaluations"))).length,
    1,
  );
  const detailResponse = await fetch(`${origin}/opportunities/${candidate.id}`);
  const detailHtml = await detailResponse.text();
  assert.equal(detailResponse.status, 200);
  assert.match(detailHtml, /Señales de solapamiento/);
  assert.match(detailHtml, /Diferenciación de intención/);
  assert.match(detailHtml, /Comparación determinista/);
  assert.match(detailHtml, /Violaciones del contrato público/);
  assert.match(detailHtml, /guía publicada/);
  assert.match(detailHtml, /EditorialBrief aprobado/);
  assert.match(detailHtml, /sólo la decisión humana de crear artículo inicia un brief/);
  assert.match(detailHtml, /Regenerar alternativas/);
  assert.match(detailHtml, /Juicio de IA/);
  assert.match(detailHtml, /Evidencia determinista/);
  assert.match(detailHtml, /Cobertura I\.0/);
  assert.match(detailHtml, /Manual HTTP fixture/);
  for (const action of ["create-article", "add-as-section", "merge", "hold", "reject"]) {
    assert.match(detailHtml, new RegExp(`<option value="${action}">`));
  }
  const targetGuidePath = join(repository, "content", "guides", "guide_nurse-practical.json");
  const targetGuideBeforeDecisions = await readFile(targetGuidePath, "utf8");

  const decisionResponse = await fetch(`${origin}/opportunities/${candidate.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "add-as-section",
      reason: "The closest guide already owns enough of this intent.",
      targetContentId: "guide_nurse-practical",
    }),
    redirect: "manual",
  });
  assert.equal(decisionResponse.status, 303);
  assert.equal(candidateStore.get(candidate.id).status, "converted-to-section");
  assert.equal(candidateStore.get(candidate.id).decision?.targetContentId, "guide_nurse-practical");
  assert.equal(candidateStore.get(candidate.id).advisory.recommendation, "hold");
  assert.equal(candidateStore.get(candidate.id).decision?.action, "add-as-section");
  await assert.rejects(readFile(join(repository, "drafts", `${candidate.id}.json`), "utf8"));
  await assert.rejects(
    readFile(join(repository, "content", "guides", `${candidate.id}.json`), "utf8"),
  );

  for (const [action, expectedStatus, targetContentId] of [
    ["merge", "merged", "guide_nurse-practical"],
    ["hold", "evaluated", undefined],
    ["reject", "rejected", undefined],
  ] as const) {
    const routeCandidate = transitionArticleCandidate(
      articleCandidate({
        id: `candidate_http-${action}`,
        proposedSlug: `http-${action}`,
      }),
      "evaluated",
    );
    await candidateStore.save(routeCandidate);
    const response = await fetch(`${origin}/opportunities/${routeCandidate.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action,
        reason: `The editor chose ${action} independently of the AI recommendation.`,
        ...(targetContentId ? { targetContentId } : {}),
      }),
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    const persisted = candidateStore.get(routeCandidate.id);
    assert.equal(persisted.id, routeCandidate.id);
    assert.equal(persisted.status, expectedStatus);
    assert.equal(persisted.decision?.action, action);
    assert.equal(persisted.decision?.targetContentId, targetContentId);
  }

  for (const [id, action, targetContentId, expectedError] of [
    ["candidate_http-section-no-target", "add-as-section", undefined, /target content ID/],
    ["candidate_http-merge-missing-target", "merge", "guide_missing", /guide_missing/],
  ] as const) {
    const invalidCandidate = transitionArticleCandidate(
      articleCandidate({ id, proposedSlug: id.replaceAll("_", "-") }),
      "evaluated",
    );
    await candidateStore.save(invalidCandidate);
    const response = await fetch(`${origin}/opportunities/${invalidCandidate.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action,
        reason: "This invalid target decision must be rejected.",
        ...(targetContentId ? { targetContentId } : {}),
      }),
      redirect: "manual",
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), expectedError);
    assert.equal(candidateStore.get(invalidCandidate.id).status, "evaluated");
    assert.equal(candidateStore.get(invalidCandidate.id).decision, undefined);
  }
  assert.equal(await readFile(targetGuidePath, "utf8"), targetGuideBeforeDecisions);

  const briefSentinel = "PRIVATE_BRIEF_SENTINEL_20260809";
  const briefCandidate = transitionArticleCandidate(
    articleCandidate({
      id: "candidate_http-brief",
      proposedTitle: briefSentinel,
      proposedSlug: "http-brief-sentinel",
    }),
    "evaluated",
  );
  await candidateStore.save(briefCandidate);
  const approveForBriefResponse = await fetch(
    `${origin}/opportunities/${briefCandidate.id}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "create-article",
        reason: "The editor approves a separate article brief.",
      }),
      redirect: "manual",
    },
  );
  assert.equal(approveForBriefResponse.status, 303);
  const briefLocation = approveForBriefResponse.headers.get("location");
  assert.match(briefLocation ?? "", /^\/opportunities\/briefs\/brief_/);
  const briefId = briefLocation!.split("/").at(-1)!;
  const persistedBriefCandidate = candidateStore.get(briefCandidate.id);
  assert.equal(persistedBriefCandidate.id, briefCandidate.id);
  assert.equal(persistedBriefCandidate.decision?.action, "create-article");
  assert.equal(persistedBriefCandidate.editorialBriefId, briefId);
  const briefResponse = await fetch(`${origin}${briefLocation}`);
  assert.equal(briefResponse.status, 200);
  assert.match(await briefResponse.text(), /Brief editable/);

  const saveBriefResponse = await fetch(`${origin}${briefLocation}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      workingTitle: briefSentinel,
      proposedSlug: "http-brief-sentinel",
      primaryAxis: "work-context",
      primaryIntent: briefCandidate.primaryIntent,
      targetAudience: briefCandidate.targetAudience,
      problemSolved: briefCandidate.problemSolved,
      differentiation: "A human-edited distinction from the closest practical guide.",
      plannedSections:
        "Recovery context | Define the off-shift problem.\nResearch plan | List facts to verify.",
      productRequirements: "sleep support\nrecovery tools",
      researchQuestions: "Which facts require source verification?",
      expectedInternalLinks: "guide_nurse-practical",
      relatedContentIds: "guide_nurse-practical",
      editorialEvidenceNotes: "Human note kept separate from AI interpretation.",
      risks: "Avoid unsupported health claims.",
    }),
    redirect: "manual",
  });
  assert.equal(saveBriefResponse.status, 303);
  const approveBriefResponse = await fetch(`${origin}${briefLocation}/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(),
    redirect: "manual",
  });
  assert.equal(approveBriefResponse.status, 303);
  const convertBriefResponse = await fetch(`${origin}${briefLocation}/convert`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(),
    redirect: "manual",
  });
  assert.equal(convertBriefResponse.status, 303);
  const draftLocation = convertBriefResponse.headers.get("location");
  assert.match(draftLocation ?? "", /^\/drafts\/guide_/);
  const guideDraftId = draftLocation!.split("/").at(-1)!;
  const convertedDraft = guideDraftSchema.parse(
    JSON.parse(await readFile(join(repository, "drafts", `${guideDraftId}.json`), "utf8")),
  );
  assert.equal(convertedDraft.status, "questionnaire");
  assert.equal(convertedDraft.title, briefSentinel);
  assert.equal(convertedDraft.recommendations.length, 0);
  const convertedBrief = editorialBriefSchema.parse(
    JSON.parse(await readFile(editorialBriefPath(repository, briefId), "utf8")),
  );
  assert.equal(convertedBrief.status, "converted-to-guide-draft");
  assert.equal(convertedBrief.guideDraftId, guideDraftId);
  assert.equal(candidateStore.get(briefCandidate.id).guideDraftId, guideDraftId);
  const draftResponse = await fetch(`${origin}${draftLocation}`);
  const draftHtml = await draftResponse.text();
  assert.equal(draftResponse.status, 200);
  assert.match(draftHtml, /Siguiente paso: generar el esquema/);
  assert.match(
    draftHtml,
    new RegExp(`/drafts/${guideDraftId}/outline-prompt">Revisar y generar esquema`),
  );
  assert.match(draftHtml, /Revisá y generá el esquema/);

  const outlinePromptResponse = await fetch(`${origin}${draftLocation}/outline-prompt`);
  const outlinePromptHtml = await outlinePromptResponse.text();
  assert.equal(outlinePromptResponse.status, 200);
  assert.match(outlinePromptHtml, /A human-edited distinction/);
  assert.match(outlinePromptHtml, /sleep support/);
  assert.match(outlinePromptHtml, /Which facts require source verification/);

  const generateOutlineResponse = await fetch(`${origin}${draftLocation}/outline/generate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ promptVersion: OUTLINE_PROMPT_VERSION }),
    redirect: "manual",
  });
  assert.equal(generateOutlineResponse.status, 303);
  const outlinedDraft = guideDraftSchema.parse(
    JSON.parse(await readFile(join(repository, "drafts", `${guideDraftId}.json`), "utf8")),
  );
  const expectedSlotIds = Array.from(
    { length: outlinedDraft.questionnaire.giftCount },
    (_, index) => `${guideDraftId}_slot-${index + 1}`,
  );
  assert.equal(outlinedDraft.status, "outline-ready");
  assert.equal(outlinedDraft.generationMetadata?.providerId, "mock");
  assert.deepEqual(
    outlinedDraft.outline?.slots.map(({ id }) => id),
    expectedSlotIds,
  );
  assert.deepEqual(
    outlinedDraft.recommendations.map(({ id }) => id),
    expectedSlotIds,
  );
  assert.ok(outlinedDraft.recommendations.every(({ productId }) => productId === undefined));
  await assert.rejects(
    readFile(join(repository, "content", "guides", `${guideDraftId}.json`), "utf8"),
  );

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const outputFiles = await readdir(join(REPOSITORY_ROOT, "apps", "site", "dist"), {
    recursive: true,
  });
  const outputHtml = (
    await Promise.all(
      outputFiles
        .filter((file) => file.endsWith(".html"))
        .map((file) => readFile(join(REPOSITORY_ROOT, "apps", "site", "dist", file), "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(
    outputFiles.join("\n"),
    /opportunities|article-candidates|opportunity-generation-sessions|opportunity-evaluations/,
  );
  assert.doesNotMatch(outputHtml, new RegExp(sentinel));
  assert.doesNotMatch(outputHtml, new RegExp(briefSentinel));
  assert.doesNotMatch(outputHtml, /article-candidate|candidate_nurse-shift-recovery/);
});

test("acepta sólo URLs HTTP(S) absolutas", () => {
  assert.equal(validateProductUrl(undefined), true);
  assert.equal(validateProductUrl("https://example.com/product"), true);
  assert.equal(validateProductUrl("http://example.com/product"), true);
  assert.equal(validateProductUrl("ftp://example.com/product"), false);
  assert.equal(validateProductUrl("/relative"), false);
});

test("reconoce formas Amazon y extrae el ASIN solo del texto de la URL", () => {
  for (const url of [
    "https://www.amazon.com/dp/B012345678",
    "https://amazon.com/gp/product/B012345678?psc=1",
    "https://www.amazon.com/gp/aw/d/B012345678/ref=dp_iou_view_item",
  ]) {
    assert.equal(extractAmazonAsin(url), "B012345678");
  }
  assert.equal(extractAmazonAsin("https://www.amazon.com/dp/not-an-asin"), undefined);
  assert.equal(extractAmazonAsin("https://amzn.to/short-code"), undefined);
  assert.equal(
    normalizeAmazonUrl("HTTPS://WWW.AMAZON.COM/dp/B012345678?z=2&tag=thegoodpresent-20#fragment"),
    "https://www.amazon.com/dp/B012345678?tag=thegoodpresent-20&z=2",
  );
});

test("valida hosts Amazon US, https y tracking tags sin red", () => {
  for (const host of [
    "https://amazon.com",
    "https://www.amazon.com",
    "https://smile.amazon.com",
    "https://amzn.to",
    "https://a.co",
  ]) {
    assert.equal(isApprovedAmazonUsHost(host), true);
  }
  assert.equal(isApprovedAmazonUsHost("https://not-amazon.example"), false);

  const program = configuredAmazonProgram();
  const correct = validateAmazonAffiliateIntake(amazonIntakeInput(), program);
  assert.deepEqual(correct.errors, []);
  assert.deepEqual(correct.warnings, []);

  const missingTag = validateAmazonAffiliateIntake(
    amazonIntakeInput({ affiliateUrl: "https://www.amazon.com/dp/B012345678" }),
    program,
  );
  assert.deepEqual(missingTag.errors, []);
  assert.ok(missingTag.warnings.some((warning) => warning.includes("tracking tag")));

  const unexpectedTag = validateAmazonAffiliateIntake(
    amazonIntakeInput({ affiliateUrl: "https://www.amazon.com/dp/B012345678?tag=other-20" }),
    program,
  );
  assert.ok(unexpectedTag.errors.some((error) => error.includes("tracking tag visible")));

  const unexpectedHost = validateAmazonAffiliateIntake(
    amazonIntakeInput({ productUrl: "https://not-amazon.example/dp/B012345678" }),
    program,
  );
  assert.ok(unexpectedHost.errors.some((error) => error.includes("host no")));

  const shortLink = validateAmazonAffiliateIntake(
    amazonIntakeInput({ affiliateUrl: "https://amzn.to/short-code" }),
    program,
  );
  assert.deepEqual(shortLink.errors, []);
  assert.ok(shortLink.warnings.some((warning) => warning.includes("enlace corto")));

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("Amazon network access should not happen");
  }) as typeof fetch;
  try {
    validateAmazonAffiliateIntake(amazonIntakeInput(), program);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("bloquea ASIN y URL afiliada normalizada duplicados", () => {
  const program = configuredAmazonProgram();
  const input = amazonIntakeInput();
  const firstValidation = validateAmazonAffiliateIntake(input, program);
  const first = createAmazonProductSourceRecord(
    "product_badge-reel",
    { ...input, sourceId: "source_amazon_first" },
    firstValidation,
  );
  const duplicate = validateAmazonAffiliateIntake(input, program, [first]);
  assert.ok(duplicate.errors.some((error) => error.includes("ASIN ya")));
  assert.ok(duplicate.errors.some((error) => error.includes("URL afiliada normalizada")));
});

test("lee configuración de afiliados sin secretos y detecta faltantes", () => {
  const records = readAffiliateProgramRecords();
  assert.equal(records.length, 1);
  const program = records[0]!.program;
  assert.ok(program);
  assert.equal(program.programId, "amazon-associates");
  assert.deepEqual(missingAffiliateProgramConfiguration(program), [
    "store or associate identifier",
    "allowed tracking ID",
  ]);
  assert.equal("apiKey" in program, false);
  assert.equal("secret" in program, false);
});

test("muestra el estado de afiliados sólo dentro del Studio", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-affiliate-status-"));
  const server = createStudioServer(new DraftStore(directory));
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://${STUDIO_HOST}:${address.port}/affiliate-programs`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /amazon-associates/);
  assert.match(html, /store or associate identifier/);
  assert.doesNotMatch(html, /apiKey|password|accessToken|clientSecret/i);

  const qaResponse = await fetch(`http://${STUDIO_HOST}:${address.port}/affiliate-operations`);
  const qaHtml = await qaResponse.text();
  assert.equal(qaResponse.status, 200);
  assert.match(qaHtml, /QA de enlaces afiliados/);
  assert.match(qaHtml, /product_shift-tote/);
  assert.match(qaHtml, /affiliateUrl\.program/);
});

test("reporta cobertura, tracking, programas, hosts, disclosure y protocolos con severidades distintas", async (context) => {
  const base = readPublicContent();
  const productById = (id: string) => base.products.find((product) => product.id === id)!;
  const withoutUrls = (id: string) => {
    const { affiliateUrl: _affiliateUrl, productUrl: _productUrl, ...product } = productById(id);
    return product;
  };
  const replacements = new Map<string, Product>([
    [
      "product_badge-reel",
      {
        ...productById("product_badge-reel"),
        productUrl: "https://www.amazon.com/dp/B012345678",
        affiliateUrl: "https://www.amazon.com/dp/B012345678?tag=thegoodpresent-20",
      },
    ],
    [
      "product_coffee-card",
      {
        ...withoutUrls("product_coffee-card"),
        affiliateUrl: "https://www.amazon.com/dp/C012345678?tag=wrong-tag",
      },
    ],
    [
      "product_compression-socks",
      {
        ...withoutUrls("product_compression-socks"),
        productUrl: "https://merchant.test/compression-socks",
      },
    ],
    ["product_sleep-mask", withoutUrls("product_sleep-mask")],
    [
      "product_pocket-notebook",
      {
        ...withoutUrls("product_pocket-notebook"),
        affiliateUrl: "https://unknown.example/pocket-notebook",
      },
    ],
    [
      "product_hand-cream",
      {
        ...withoutUrls("product_hand-cream"),
        affiliateUrl: "https://disabled.example/hand-cream?tag=disabled-tag",
      },
    ],
    [
      "product_rechargeable-penlight",
      {
        ...withoutUrls("product_rechargeable-penlight"),
        affiliateUrl: "https://amzn.to/short-code",
      },
    ],
    [
      "product_insulated-tumbler",
      { ...withoutUrls("product_insulated-tumbler"), affiliateUrl: "javascript:alert(1)" },
    ],
    [
      "product_shift-tote",
      {
        ...withoutUrls("product_shift-tote"),
        merchant: "Amazon",
        productUrl: "https://www.amazon.com/dp/D012345678",
      },
    ],
  ]);
  const baseRecommendation = base.guides[0]!.recommendations[0]!;
  assert.ok(baseRecommendation.productId);
  const content = {
    ...base,
    products: base.products.map((product) => replacements.get(product.id) ?? product),
    guides: [
      {
        ...base.guides[0]!,
        recommendations: [
          "product_badge-reel",
          "product_coffee-card",
          "product_compression-socks",
          "product_sleep-mask",
          "product_pocket-notebook",
          "product_hand-cream",
          "product_rechargeable-penlight",
          "product_insulated-tumbler",
          "product_shift-tote",
        ].map((productId, index) => ({
          ...baseRecommendation,
          id: `qa_${index + 1}`,
          productId,
          position: index + 1,
        })),
      },
    ],
  };
  const disabledProgram = affiliateProgramSchema.parse({
    ...configuredAmazonProgram(),
    id: "disabled-store",
    programId: "disabled-program",
    marketplace: "disabled.example",
    approvedHosts: ["disabled.example"],
    allowedTrackingIds: ["disabled-tag"],
    enabled: false,
  });
  const siteDistRoot = await mkdtemp(join(tmpdir(), "good-present-affiliate-qa-output-"));
  context.after(() => rm(siteDistRoot, { recursive: true, force: true }));
  const routeDirectory = join(siteDistRoot, "nurse-gifts", "graduation");
  await mkdir(routeDirectory, { recursive: true });
  await writeFile(
    join(routeDirectory, "index.html"),
    '<html><article class="recommendation"></article></html>',
  );

  const report = validateAffiliateOperations(
    content,
    [
      {
        file: "editorial-data/affiliate-programs/amazon-us.json",
        program: configuredAmazonProgram(),
      },
      { file: "editorial-data/affiliate-programs/disabled-store.json", program: disabledProgram },
    ],
    { siteDistRoot },
  );

  assert.equal(report.coverage.filter((entry) => entry.kind === "affiliate").length, 5);
  assert.equal(report.coverage.filter((entry) => entry.kind === "ordinary").length, 1);
  assert.equal(report.coverage.filter((entry) => entry.kind === "amazon-pending").length, 1);
  assert.equal(report.coverage.filter((entry) => entry.kind === "none").length, 2);
  assert.ok(report.warnings.length > 0);
  assert.ok(report.errors.length > 0);
  assert.ok(
    report.warnings.some(
      (finding) => finding.productId === "product_shift-tote" && finding.field === "affiliateUrl",
    ),
  );
  assert.equal(
    report.errors.some((finding) => finding.productId === "product_shift-tote"),
    false,
  );
  assert.ok(report.warnings.every((finding) => finding.severity === "warning"));
  assert.ok(report.errors.every((finding) => finding.severity === "error"));
  assert.ok(
    report.warnings.some((finding) => finding.reason.includes("Sólo hay una URL ordinaria")),
  );
  assert.ok(report.warnings.some((finding) => finding.reason.includes("No hay URL de salida")));
  assert.ok(
    report.warnings.some((finding) => finding.reason.includes("No hay un programa afiliado")),
  );
  assert.ok(report.errors.some((finding) => finding.reason.includes("no está aprobado")));
  assert.ok(report.errors.some((finding) => finding.reason.includes("desactivado")));
  assert.ok(report.errors.some((finding) => finding.reason.includes("no coincide")));
  assert.ok(report.warnings.some((finding) => finding.reason.includes("enlace corto")));
  assert.ok(report.errors.some((finding) => finding.reason.includes("protocolo inseguro")));
  assert.ok(report.errors.some((finding) => finding.field === "guide-disclosure"));
  for (const finding of report.findings) {
    assert.ok(finding.productId);
    assert.ok(finding.product);
    assert.ok(finding.guideId);
    assert.ok(finding.guide);
    assert.ok(finding.route);
    assert.ok(finding.field);
    assert.ok(finding.reason);
  }
});

test("valida fuentes, conserva campos no pÃºblicos y acepta los cuatro tipos", () => {
  const source = sourceRecord("product_badge-reel");
  assert.equal(source.sourceKind, "manual");
  const amazonSource = productSourceRecordSchema.parse({
    ...source,
    id: "source_manual-amazon",
    sourceKind: "manual-amazon",
    provider: "Amazon Associates",
    marketplace: "amazon.com",
    externalId: "B012345678",
    sourceUrl: "https://www.amazon.com/dp/B012345678",
    originalProductUrl: "https://www.amazon.com/dp/B012345678",
    originalAffiliateUrl: "https://www.amazon.com/dp/B012345678?tag=approved-20",
    normalizedAffiliateUrl: "https://www.amazon.com/dp/B012345678?tag=approved-20",
    trackingId: "approved-20",
  });
  assert.equal(amazonSource.sourceKind, "manual-amazon");
  for (const sourceKind of ["csv-import", "amazon-creators-api"] as const) {
    assert.equal(
      productSourceRecordSchema.safeParse({ ...source, id: `source_${sourceKind}`, sourceKind })
        .success,
      true,
    );
  }
  assert.equal(
    productSourceRecordSchema.safeParse({
      ...source,
      externalId: undefined,
      marketplace: undefined,
    }).success,
    true,
  );
  assert.equal(
    productSourceRecordSchema.safeParse({
      ...source,
      externalId: "external-123",
      marketplace: undefined,
    }).success,
    false,
  );
  assert.equal(
    productSourceRecordSchema.safeParse({ ...source, sourceUrl: "ftp://test.example/item" })
      .success,
    false,
  );
  assert.equal(
    productSourceRecordSchema.safeParse({ ...source, publicAsin: "leak" }).success,
    false,
  );
});

test("detecta duplicados y encuentra una fuente por proveedor, marketplace e ID", () => {
  const first = sourceRecord("product_badge-reel");
  const second = sourceRecord("product_sleep-mask", { id: "source_second" });
  assert.equal(
    findProductSource([first], "test provider", "TEST.EXAMPLE", "EXTERNAL-123")?.id,
    first.id,
  );
  assert.equal(findDuplicateProductSource([first], second)?.id, first.id);
  assert.equal(findDuplicateProductSource([first], first), undefined);
  assert.equal(
    findDuplicateProductSource(
      [first],
      sourceRecord("product_sleep-mask", {
        id: "source_other-marketplace",
        marketplace: "other.example",
      }),
    ),
    undefined,
  );
});

test("persiste fuentes por ID, bloquea huÃ©rfanas y mantiene la salida pÃºblica separada", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-sources-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const store = new ProductSourceStore(repository);
  const saved = await store.save(
    sourceRecord("product_badge-reel", { id: "source_persisted" }),
    catalog.read().products,
  );
  assert.equal(readProductSourceRecords(repository)[0]?.source?.id, saved.id);
  assert.equal(store.forProduct("product_badge-reel", catalog.read().products).length, 1);
  await assert.rejects(
    store.save(
      sourceRecord("product_sleep-mask", { id: "source_duplicate" }),
      catalog.read().products,
    ),
    /ID externo.*ya existe/,
  );
  await store.save(
    sourceRecord("product_badge-reel", {
      id: "source_persisted",
      externalId: "external-updated",
      lastReviewedAt: "2026-08-09T00:00:00.000Z",
    }),
    catalog.read().products,
  );
  assert.equal(
    store.get("source_persisted", catalog.read().products).externalId,
    "external-updated",
  );
  await assert.rejects(
    store.save(sourceRecord("product_missing", { id: "source_missing" }), catalog.read().products),
    /producto canónico.*product_missing/,
  );
  assert.throws(() => productSourcePath(repository, "../outside"), /ID.*seguro/);
  assert.deepEqual(
    (await readdir(join(repository, "editorial-data", "product-sources"))).filter((name) =>
      name.endsWith(".tmp"),
    ),
    [],
  );

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const outputFiles = await readdir(join(REPOSITORY_ROOT, "apps", "site", "dist"), {
    recursive: true,
  });
  assert.doesNotMatch(outputFiles.join("\n"), /source_persisted/);
  const outputText = (
    await Promise.all(
      outputFiles
        .filter((file) => file.endsWith(".html"))
        .map((file) => readFile(join(REPOSITORY_ROOT, "apps", "site", "dist", file), "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(outputText, /source_persisted|external-updated|test\.example/);
});

test("muestra y guarda provenance desde el editor de producto sin tocar el producto canÃ³nico", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-source-http-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const sourceStore = new ProductSourceStore(repository);
  const server = createStudioServer(
    new DraftStore(join(repository, "drafts")),
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(repository, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const productId = "product_badge-reel";
  const editor = await fetch(`${origin}/products/${productId}/edit`);
  assert.match(await editor.text(), /Provenance non pública/);

  const response = await fetch(`${origin}/products/${productId}/sources`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      sourceKind: "manual",
      provider: "Amazon",
      marketplace: "amazon.com",
      externalId: "ASIN-HTTP",
      sourceUrl: "https://amazon.com/dp/ASIN-HTTP",
      importMethod: "manual",
      importedAt: "2026-08-08T00:00:30.123",
      sourceStatus: "needs-review",
      notes: "Captured by an editor.",
    }),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `/products/${productId}/edit?saved=source`);
  const savedSource = sourceStore.forProduct(productId, catalog.read().products)[0]!;
  assert.match(savedSource.id, /^source_/);
  assert.equal(savedSource.importedAt, "2026-08-08T00:00:30.123Z");
  const sourceEditor = await fetch(
    `${origin}/products/${productId}/edit?sourceId=${encodeURIComponent(savedSource.id)}`,
  );
  assert.match(await sourceEditor.text(), /name="importedAt" value="2026-08-08T00:00:30\.123"/);
  assert.equal(catalog.get(productId).id, productId);
});

test("guarda el intake Amazon solo despues de confirmacion explicita", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-amazon-intake-http-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  await mkdir(join(repository, "editorial-data", "affiliate-programs"), { recursive: true });
  await atomicWriteJson(
    join(repository, "editorial-data", "affiliate-programs", "amazon-us.json"),
    configuredAmazonProgram(),
  );
  const catalog = new ProductCatalog(repository);
  const sourceStore = new ProductSourceStore(repository);
  const server = createStudioServer(
    new DraftStore(join(repository, "drafts")),
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(repository, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const productId = "product_badge-reel";
  const form = amazonIntakeInput();

  const editor = await fetch(`${origin}/products/${productId}/edit`);
  const editorHtml = await editor.text();
  assert.match(editorHtml, /Intake manual Amazon US/);
  assert.match(editorHtml, /amazon-affiliate/);

  const previewResponse = await fetch(`${origin}/products/${productId}/amazon-affiliate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  assert.equal(previewResponse.status, 200);
  assert.match(await previewResponse.text(), /Validacion local completada/);
  assert.equal(sourceStore.forProduct(productId, catalog.read().products).length, 0);
  assert.match(catalog.get(productId).affiliateUrl ?? "", /example\.com/);

  const saveResponse = await fetch(`${origin}/products/${productId}/amazon-affiliate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, confirm: "yes" }),
    redirect: "manual",
  });
  assert.equal(saveResponse.status, 303);
  assert.equal(saveResponse.headers.get("location"), `/products/${productId}/edit?saved=amazon`);

  const product = catalog.get(productId);
  assert.equal(product.productUrl, "https://www.amazon.com/dp/B012345678");
  assert.equal(product.affiliateUrl, "https://www.amazon.com/dp/B012345678?tag=thegoodpresent-20");
  const source = sourceStore.forProduct(productId, catalog.read().products)[0]!;
  assert.equal(source.sourceKind, "manual-amazon");
  assert.equal(source.productId, productId);
  assert.equal(source.externalId, "B012345678");
  assert.equal(source.originalAffiliateUrl, form.affiliateUrl);
  assert.equal(source.normalizedAffiliateUrl, product.affiliateUrl);
  assert.equal(source.trackingId, form.trackingId);
});

test("escribe productos por ID y bloquea desactivar uno publicado", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-catalog-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const product = await catalog.save({
    schemaVersion: 1,
    id: "product_test-catalog",
    name: "Test catalog item",
    merchant: "Test merchant",
    productUrl: "https://example.com/test-catalog",
    shortDescription: "A deterministic test product.",
    categories: ["test"],
    status: "inactive",
    lastCheckedAt: "2026-08-08",
  });

  const file = join(repository, "content", "products", `${product.id}.json`);
  assert.equal(JSON.parse(await readFile(file, "utf8")).id, product.id);
  assert.equal(catalog.get(product.id).status, "inactive");
  assert.deepEqual(
    (await readdir(join(repository, "content", "products"))).filter((name) =>
      name.endsWith(".tmp"),
    ),
    [],
  );

  const usedId = catalog.read().guides[0]!.recommendations[0]!.productId;
  assert.ok(usedId);
  const usedProduct = catalog.get(usedId);
  await assert.rejects(
    catalog.save({ ...usedProduct, status: "inactive" }),
    /dejaría inválido el contenido publicado/,
  );
});

test("expone búsqueda y alta manual de productos por HTTP", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-http-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const server = createStudioServer(
    new DraftStore(join(repository, "drafts")),
    new ProductCatalog(repository),
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(repository, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const listResponse = await fetch(`${origin}/products?q=tumbler&status=active`);
  assert.equal(listResponse.status, 200);
  assert.match(await listResponse.text(), /Leak-Resistant Insulated Tumbler/);
  const unsafeReturnPage = await fetch(
    `${origin}/products/new?returnTo=${encodeURIComponent("https://evil.example")}`,
  );
  assert.doesNotMatch(await unsafeReturnPage.text(), /evil\.example/);
  const productDirectory = join(repository, "content", "products");
  const beforeCount = (await readdir(productDirectory)).length;

  const createResponse = await fetch(`${origin}/products`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Manual product",
      merchant: "Manual merchant",
      shortDescription: "Created from the native product form.",
      productUrl: "https://example.com/manual-product",
      status: "inactive",
      lastCheckedAt: "2026-08-08",
    }),
    redirect: "manual",
  });
  assert.equal(createResponse.status, 303);
  assert.equal(createResponse.headers.get("location"), "/products?saved=1");
  assert.equal((await readdir(productDirectory)).length, beforeCount + 1);
});

test("prepara el ingreso asistido y separa fuente, hechos verificados y copy editorial", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-intake-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });

  const preview = prepareManualProductIntake(manualProductIntakeInput(), repository);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.product?.verifiedFacts?.[0], "Vacuum insulated");
  assert.equal(preview.source?.sourceKind, "manual");
  assert.equal(preview.source?.externalId, "Z123456789");
  assert.deepEqual(preview.source?.sourceFacts, ["Vacuum insulated", "BPA-free materials"]);
  assert.equal("sourceFacts" in (preview.product ?? {}), false);
  assert.equal("imageRightsNotes" in (preview.product ?? {}), false);

  const invalid = prepareManualProductIntake(
    manualProductIntakeInput({ productUrl: "ftp://amazon.example/item", name: "" }),
    repository,
  );
  assert.ok(invalid.errors.some((error) => error.includes("productUrl")));
  assert.ok(invalid.errors.some((error) => error.includes("name")));

  const unconfirmed = prepareManualProductIntake(
    manualProductIntakeInput({ verifiedFactsConfirmed: false }),
    repository,
  );
  assert.ok(unconfirmed.errors.some((error) => error.includes("Afirmá")));

  const exactPrice = prepareManualProductIntake(
    manualProductIntakeInput({ priceLabel: "$19.99" }),
    repository,
  );
  assert.ok(exactPrice.errors.some((error) => error.includes("precio actual exacto")));

  await mkdir(join(repository, "editorial-data", "affiliate-programs"), { recursive: true });
  await atomicWriteJson(
    join(repository, "editorial-data", "affiliate-programs", "amazon-us.json"),
    configuredAmazonProgram(),
  );
  const affiliatePreview = prepareManualProductIntake(
    manualProductIntakeInput({
      productUrl: "https://www.amazon.com/dp/Y123456789",
      asin: "Y123456789",
      affiliateUrl: "https://www.amazon.com/dp/Y123456789?tag=thegoodpresent-20",
      trackingId: "thegoodpresent-20",
      name: "Manual intake affiliate product",
    }),
    repository,
  );
  assert.deepEqual(affiliatePreview.errors, []);
  assert.equal(
    affiliatePreview.product?.affiliateUrl,
    "https://www.amazon.com/dp/Y123456789?tag=thegoodpresent-20",
  );
  assert.equal(affiliatePreview.source?.sourceKind, "manual-amazon");
  assert.equal(affiliatePreview.source?.productId, affiliatePreview.product?.id);
});

test("guarda producto y fuente con rollback y previene duplicados", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-intake-atomic-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });

  const firstPreview = prepareManualProductIntake(manualProductIntakeInput(), repository);
  assert.deepEqual(firstPreview.errors, []);
  await commitManualProductIntake(firstPreview, repository);
  const catalog = new ProductCatalog(repository);
  const sourceStore = new ProductSourceStore(repository);
  const firstProduct = catalog
    .read()
    .products.find((product) => product.name === "Manual intake product")!;
  const firstSource = sourceStore.forProduct(firstProduct.id, catalog.read().products)[0]!;
  assert.equal(firstSource.productId, firstProduct.id);
  assert.deepEqual(firstSource.sourceFacts, ["Vacuum insulated", "BPA-free materials"]);

  const duplicate = prepareManualProductIntake(manualProductIntakeInput(), repository);
  assert.ok(duplicate.duplicates.some((match) => match.kind === "asin"));
  assert.ok(duplicate.errors.some((error) => error.includes("ASIN ya está vinculado")));
  assert.ok(duplicate.errors.some((error) => error.includes("producto parece duplicar")));

  const identityDuplicate = prepareManualProductIntake(
    manualProductIntakeInput({
      productUrl: "https://www.amazon.com/dp/Y123456789",
      asin: "Y123456789",
    }),
    repository,
  );
  assert.ok(
    identityDuplicate.errors.some((error) => error.includes("coinciden nombre, marca y comercio")),
  );

  const failedPreview = prepareManualProductIntake(
    manualProductIntakeInput({
      productUrl: "https://www.amazon.com/dp/X123456789",
      asin: "X123456789",
      name: "Rollback product",
    }),
    repository,
  );
  assert.deepEqual(failedPreview.errors, []);
  let writes = 0;
  await assert.rejects(
    commitManualProductIntake(failedPreview, repository, async (file, data) => {
      writes += 1;
      if (writes === 2) throw new Error("injected source failure");
      await atomicWriteJson(file, data);
    }),
    /injected source failure/,
  );
  assert.equal(writes, 2);
  await assert.rejects(
    readFile(join(repository, "content", "products", `${failedPreview.product!.id}.json`)),
    /ENOENT/,
  );
  assert.equal(sourceStore.list(catalog.read().products).length, 1);
  assert.doesNotThrow(() => catalog.read());
});

test("crea un producto desde el Studio, lo selecciona en un GuideDraft y excluye la fuente del build", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-intake-integration-"));
  context.after(async () => {
    await rm(repository, { recursive: true, force: true });
  });
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourceStore = new ProductSourceStore(repository);
  const draft = await generateGuideOutline(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_manual-intake"),
      clusterId: catalog.read().clusters[0]!.id,
      primaryAxis: "recipient",
      primaryIntent: "Help a nurse choose a practical graduation gift.",
      questionnaire: normalizeQuestionnaire({ giftCount: "3" }),
    }),
    catalog.read(),
    new MockGuideGenerationProvider(),
  );
  await draftStore.save(draft);

  const server = createStudioServer(
    draftStore,
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const input = manualProductIntakeInput({
    productUrl: "https://www.amazon.com/dp/W123456789",
    asin: "W123456789",
    name: "HTTP intake product",
    sourceFacts: ["INTERNAL_SOURCE_FACT_20260808"],
    verifiedFacts: ["INTERNAL_SOURCE_FACT_20260808"],
  });
  const returnTo = `/drafts/${draft.id}`;
  const pageResponse = await fetch(
    `${origin}/products/intake?returnTo=${encodeURIComponent(returnTo)}`,
  );
  const pageHtml = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(pageHtml, /Información de la fuente/);
  assert.match(pageHtml, /Copy editorial original/);

  const previewResponse = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: manualProductIntakeForm(input, { returnTo }),
  });
  assert.equal(previewResponse.status, 200);
  assert.match(await previewResponse.text(), /Vista previa lista/);
  assert.equal(
    catalog.read().products.some((product) => product.id === input.productId),
    false,
  );

  const saveResponse = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: manualProductIntakeForm(input, { returnTo, confirm: "yes" }),
    redirect: "manual",
  });
  assert.equal(saveResponse.status, 303);
  assert.equal(saveResponse.headers.get("location"), returnTo);
  const product = catalog.read().products.find((item) => item.name === input.name)!;
  const source = sourceStore.forProduct(product.id, catalog.read().products)[0]!;
  assert.equal(source.productId, product.id);
  assert.deepEqual(source.sourceFacts, input.sourceFacts);

  const selectedDraft = guideDraftSchema.parse(await draftStore.read(draft.id));
  const slot = selectedDraft.recommendations[0]!;
  const selectionResponse = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/${slot.id}/product`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ productId: product.id }),
      redirect: "manual",
    },
  );
  assert.equal(selectionResponse.status, 303);
  assert.equal(
    guideDraftSchema.parse(await draftStore.read(draft.id)).recommendations[0]!.productId,
    product.id,
  );

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const outputFiles = await readdir(join(REPOSITORY_ROOT, "apps", "site", "dist"), {
    recursive: true,
  });
  const outputHtml = (
    await Promise.all(
      outputFiles
        .filter((file) => file.endsWith(".html"))
        .map((file) => readFile(join(REPOSITORY_ROOT, "apps", "site", "dist", file), "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(outputFiles.join("\n"), new RegExp(source.id));
  assert.doesNotMatch(outputHtml, /INTERNAL_SOURCE_FACT_20260808|rights status/);
  assert.doesNotMatch(outputHtml, /editorial-data|manual-amazon|amazon-us/);
});

test("inspecciona URLs manuales sin red y separa producto, afiliado y ASIN", () => {
  const amazon = inspectManualProductUrl({
    url: "https://www.amazon.com/gp/product/B012345678?tag=thegoodpresent-20",
  });
  assert.deepEqual(amazon.errors, []);
  assert.equal(amazon.productUrl, "https://www.amazon.com/dp/B012345678");
  assert.equal(
    amazon.affiliateUrl,
    "https://www.amazon.com/gp/product/B012345678?tag=thegoodpresent-20",
  );
  assert.equal(amazon.asin, "B012345678");
  assert.equal(amazon.trackingId, "thegoodpresent-20");

  const shortAmazon = inspectManualProductUrl({ url: "https://amzn.to/short-code" });
  assert.deepEqual(shortAmazon.errors, []);
  assert.ok(shortAmazon.warnings.some((warning) => warning.includes("enlace corto")));
  assert.equal(shortAmazon.asin, undefined);

  const merchant = inspectManualProductUrl({
    url: "https://merchant.example/items/shift-wrap?b=2&a=1#details",
    affiliateUrl: "https://affiliate.example/go/shift-wrap?b=2&a=1",
  });
  assert.deepEqual(merchant.errors, []);
  assert.equal(merchant.productUrl, "https://merchant.example/items/shift-wrap?a=1&b=2");
  assert.equal(merchant.affiliateUrl, "https://affiliate.example/go/shift-wrap?a=1&b=2");
  assert.equal(merchant.asin, undefined);
});

test("prefill de sourcing reutiliza contexto conocido sin inventar datos faltantes", () => {
  const draft = guideDraftSchema.parse({
    ...addManualRecommendation(
      createGuideDraft("guide_sourcing-prefill"),
      "Structural firefighting gloves",
      "Protect hands during academy drills.",
      ["NFPA firefighter gloves", "academy turnout gear"],
      "slot_sourcing-prefill",
    ),
    primaryIntent: "Equip a firefighter rookie for academy training.",
    taxonomies: { occasions: ["Fire academy graduation"] },
    budgetContext: { currency: "USD", label: "Under $150" },
    recommendations: [
      {
        id: "slot_sourcing-prefill",
        position: 1,
        slotLabel: "Structural firefighting gloves",
        slotIntent: "Protect hands during academy drills.",
        searchTerms: ["NFPA firefighter gloves", "academy turnout gear"],
        budgetHint: "$80–$120",
        editorialStatus: "unassigned",
      },
    ],
  });
  const slot = draft.recommendations[0]!;
  const inherited = productSourcingPrefillForDraftSlot(draft, slot, {
    targetAudience: "Firefighter rookies entering academy training.",
    risks: ["Exclude costume-grade protective equipment."],
  });

  assert.deepEqual(inherited, {
    intendedRole: "Protect hands during academy drills.",
    requiredCategory: "Structural firefighting gloves",
    audience: "Firefighter rookies entering academy training.",
    occasion: "Fire academy graduation",
    budgetContext: "$80–$120",
    mustHaveVerifiedFacts: [],
    exclusions: ["Exclude costume-grade protective equipment."],
    searchTerms: ["NFPA firefighter gloves", "academy turnout gear"],
  });

  const minimal = addManualRecommendation(
    createGuideDraft("guide_sourcing-missing"),
    "Known slot label",
    undefined,
    undefined,
    "slot_sourcing-missing",
  );
  const missing = productSourcingPrefillForDraftSlot(minimal, minimal.recommendations[0]!);
  assert.equal(missing.audience, undefined);
  assert.equal(missing.occasion, undefined);
  assert.equal(missing.budgetContext, undefined);
  assert.deepEqual(missing.mustHaveVerifiedFacts, []);
  assert.deepEqual(missing.exclusions, []);
  assert.deepEqual(missing.searchTerms, ["Known slot label"]);
});

test("resume ocho slots con matching I.0 y sourcing sin tomar decisiones editoriales", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-slot-triage-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const content = catalog.read();
  const assignedProduct = content.products.find(({ id }) => id === "product_badge-reel");
  const matchedProduct = content.products.find(({ id }) => id === "product_insulated-tumbler");
  const weakProduct = content.products.find(({ id }) => id === "product_shift-tote");
  assert.ok(assignedProduct && matchedProduct && weakProduct);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const recommendations = [
    {
      id: "slot_triage-assigned",
      position: 1,
      slotLabel: assignedProduct.name,
      productId: assignedProduct.id,
      editorialStatus: "ready" as const,
    },
    {
      id: "slot_triage-generate",
      position: 2,
      slotLabel: "Insulated tumbler",
      searchTerms: ["insulated", "tumbler"],
      productId: matchedProduct.id,
      editorialStatus: "needs-generation" as const,
    },
    {
      id: "slot_triage-match",
      position: 3,
      slotLabel: "Insulated tumbler",
      searchTerms: ["insulated", "tumbler"],
      editorialStatus: "needs-generation" as const,
    },
    {
      id: "slot_triage-review-fit",
      position: 4,
      slotLabel: "Portable Exam Prep Study Cards",
      searchTerms: ["firefighter exam prep", "study flashcards"],
      productId: weakProduct.id,
      editorialStatus: "needs-generation" as const,
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `slot_triage-missing-${index + 1}`,
      position: index + 5,
      slotLabel: `Xylophonic quasar ${index + 1}`,
      searchTerms: [`xylophonic-${index + 1}`, `quasar-${index + 1}`],
      editorialStatus: "needs-generation" as const,
    })),
  ];
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_slot-triage"),
      status: "selecting-products",
      recommendations,
    }),
  );
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const request = await sourcingStore.save(
    createProductSourcingRequest(
      {
        origin: {
          kind: "recommendation-slot",
          guideDraftId: draft.id,
          recommendationSlotId: "slot_triage-missing-1",
        },
        intendedRole: "Find a deliberately unmatched fixture",
        requiredCategory: "Xylophonic quasar 1",
        audience: "Test editors",
        occasion: "Regression testing",
        budgetContext: "No known budget",
        searchTerms: ["xylophonic-1", "quasar-1"],
      },
      new Date("2026-08-10T12:00:00.000Z"),
      "request_slot-triage",
    ),
  );
  const server = createStudioServer(draftStore, catalog);
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const html = await (await fetch(`${origin}/drafts/${draft.id}`)).text();
  assert.match(html, /Resumen de slots/);
  assert.match(html, /Asignado/);
  assert.match(html, /Listo para generar recomendación/);
  assert.match(html, /Posible coincidencia determinista/);
  assert.match(html, /Sin coincidencia determinista · sourcing probable/);
  assert.match(html, /Producto asignado · revisar encaje/);
  assert.doesNotMatch(html, /coincidencia creíble/i);
  assert.match(html, /Sourcing activo/);
  assert.match(html, /El umbral determinista I\.0 es de 2 tokens compartidos/);
  assert.match(html, /Structured Shift Tote · I\.0: 0 tokens compartidos/);
  assert.match(
    html,
    new RegExp(`/drafts/${draft.id}/recommendations/slot_triage-review-fit/prompt`),
  );
  for (const recommendation of recommendations) {
    assert.match(html, new RegExp(`href="#slot-${recommendation.id}"`));
    assert.match(html, new RegExp(`id="slot-${recommendation.id}"`));
  }
  assert.match(html, new RegExp(`/product-sourcing/${request.id}`));

  const unchangedDraft = guideDraftSchema.parse(await draftStore.read(draft.id));
  assert.deepEqual(unchangedDraft.recommendations, recommendations);
  assert.equal(
    unchangedDraft.recommendations.find(({ id }) => id === "slot_triage-review-fit")!.productId,
    weakProduct.id,
  );
  assert.ok(
    unchangedDraft.recommendations
      .filter(({ productId }) => !productId)
      .every(({ editorialStatus }) => editorialStatus === "needs-generation"),
  );
  assert.equal(sourcingStore.get(request.id).status, "open");
  assert.deepEqual(sourcingStore.get(request.id).approvedProductIds, []);
  assert.ok(validateGuideDraft(unchangedDraft, content).errors.length > 0);
});

test("muestra la brecha de monetización Amazon y la acción existente sin desresolver el Product", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-amazon-pending-studio-"));
  context.after(() => rm(repository, { recursive: true, force: true }));

  await Promise.all(
    ["products", "guides", "clusters"].map((directory) =>
      mkdir(join(repository, "content", directory), { recursive: true }),
    ),
  );
  const catalog = new ProductCatalog(repository);
  const product = await catalog.save({
    schemaVersion: 1,
    id: "product_amazon-pending-fixture",
    name: "Amazon pending fixture",
    merchant: "Amazon",
    productUrl: "https://www.amazon.com/dp/B012345678",
    shortDescription: "A test product without an affiliate destination.",
    status: "active",
  });

  const draftStore = new DraftStore(join(repository, "drafts"));
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_amazon-pending"),
      status: "selecting-products",
      recommendations: [
        {
          id: "slot_amazon-pending",
          position: 1,
          slotLabel: product.name,
          productId: product.id,
          editorialStatus: "ready",
        },
      ],
    }),
  );
  const server = createStudioServer(draftStore, catalog);
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const html = await (
    await fetch(`http://${STUDIO_HOST}:${address.port}/drafts/${draft.id}`)
  ).text();
  assert.match(html, /Producto resuelto · monetización Amazon pendiente/);
  assert.match(html, /Agregar link de afiliado/);
  assert.match(html, new RegExp(`/products/${product.id}/edit`));
  assert.match(html, new RegExp(product.name));
});

test("resuelve una coincidencia de catÃ¡logo por I.2 y exige asignaciÃ³n exacta aparte", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-catalog-first-resolution-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_catalog-first-resolution"),
      status: "selecting-products",
      questionnaire: {
        giftCount: 8,
        recipient: "Inherited audience",
        occasion: "Inherited occasion",
        budget: "Inherited budget",
      },
      recommendations: [
        {
          id: "slot_catalog-first-resolution",
          position: 1,
          slotLabel: "Insulated tumbler",
          slotIntent: "Keep drinks secure during long shifts.",
          searchTerms: ["insulated", "tumbler"],
          editorialStatus: "needs-generation",
        },
      ],
    }),
  );
  const server = createStudioServer(draftStore, catalog);
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const editor = await (await fetch(`${origin}/drafts/${draft.id}`)).text();
  assert.match(editor, /Buscar en catalogo/);
  assert.match(editor, /Pegar URL de producto\/afiliado/);
  assert.match(editor, /evidencia determinista, no encaje editorial/);
  assert.match(editor, /value="Inherited audience"/);
  assert.doesNotMatch(editor, /Crear solicitud para este slot/);

  const selection = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/slot_catalog-first-resolution/catalog`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        productId: "product_insulated-tumbler",
        fulfillmentStatus: "fulfilled",
      }),
      redirect: "manual",
    },
  );
  assert.equal(selection.status, 303);
  const request = new ProductSourcingRequestStore(repository).list()[0]!;
  assert.deepEqual(request.approvedProductIds, ["product_insulated-tumbler"]);
  assert.equal(
    guideDraftSchema.parse(await draftStore.read(draft.id)).recommendations[0]!.productId,
    undefined,
  );

  const assignment = await fetch(`${origin}/product-sourcing/${request.id}/assign`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ productId: "product_insulated-tumbler" }),
    redirect: "manual",
  });
  assert.equal(assignment.status, 303);
  assert.equal(
    guideDraftSchema.parse(await draftStore.read(draft.id)).recommendations[0]!.productId,
    "product_insulated-tumbler",
  );
});

test("mantiene el ciclo de vida y los IDs exactos de una solicitud de sourcing", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-sourcing-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const now = new Date("2026-08-09T10:00:00.000Z");
  const draft = addManualRecommendation(
    createGuideDraft("guide_sourcing-lifecycle", now),
    "Insulated drinkware",
    "Keep a nurse hydrated during a long shift.",
    ["insulated", "tumbler"],
    "slot_sourcing-lifecycle",
  );
  const request = createProductSourcingRequest(
    {
      origin: {
        kind: "recommendation-slot",
        guideDraftId: draft.id,
        recommendationSlotId: "slot_sourcing-lifecycle",
      },
      intendedRole: "Practical hydration support",
      requiredCategory: "Insulated drinkware",
      audience: "Working nurses",
      occasion: "Graduation",
      budgetContext: "Under $50",
      mustHaveVerifiedFacts: ["Leak-resistant lid"],
      exclusions: ["Disposable drinkware"],
      searchTerms: ["insulated", "tumbler"],
    },
    now,
    "request_sourcing-lifecycle",
  );

  assertProductSourcingOrigin(request.origin, { drafts: [draft] });
  assertProductSourcingOrigin(
    { kind: "candidate", candidateId: "candidate_exact" },
    { candidates: [{ id: "candidate_exact" }] },
  );
  assertProductSourcingOrigin(
    { kind: "brief", briefId: "brief_exact" },
    { briefs: [{ id: "brief_exact" }] },
  );
  assertProductSourcingOrigin({ kind: "guide-draft", guideDraftId: draft.id }, { drafts: [draft] });
  assert.throws(
    () =>
      assertProductSourcingOrigin(
        {
          kind: "recommendation-slot",
          guideDraftId: draft.id,
          recommendationSlotId: "slot_missing",
        },
        { drafts: [draft] },
      ),
    /does not exist/,
  );
  assert.equal(
    productSourcingReturnPath(request),
    `/drafts/${draft.id}#slot-slot_sourcing-lifecycle`,
  );
  assert.throws(
    () => transitionProductSourcingRequest(request, "fulfilled", now),
    /Invalid sourcing transition/,
  );
  const held = transitionProductSourcingRequest(
    request,
    "held",
    new Date("2026-08-09T11:00:00.000Z"),
  );
  const reopened = transitionProductSourcingRequest(
    held,
    "open",
    new Date("2026-08-09T12:00:00.000Z"),
  );
  assert.equal(reopened.status, "open");
  assert.equal(reopened.createdAt, request.createdAt);

  const store = new ProductSourcingRequestStore(repository);
  await store.save(reopened);
  assert.equal(store.get(request.id).origin.kind, "recommendation-slot");
  assert.equal(
    JSON.parse(await readFile(productSourcingRequestPath(repository, request.id), "utf8")).id,
    request.id,
  );
  assert.throws(() => productSourcingRequestPath(repository, "../unsafe"), /not safe/);
});

test("cumple desde catálogo o intake manual y vuelve al slot sin abrir la publicación", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-sourcing-fulfillment-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const content = catalog.read();
  const draft = guideDraftSchema.parse({
    ...addManualRecommendation(
      createGuideDraft("guide_sourcing-fulfillment"),
      "Insulated tumbler",
      "Keep drinks secure during long shifts.",
      ["insulated", "tumbler"],
      "slot_sourcing-fulfillment",
    ),
    clusterId: content.clusters[0]!.id,
    slug: "sourcing-fulfillment",
    primaryAxis: "recipient",
    primaryIntent: "Choose a practical gift for a nurse.",
    title: "Sourcing fulfillment fixture",
  });
  const requestInput = {
    origin: {
      kind: "recommendation-slot" as const,
      guideDraftId: draft.id,
      recommendationSlotId: "slot_sourcing-fulfillment",
    },
    intendedRole: "Shift hydration",
    requiredCategory: "Insulated tumbler",
    audience: "Working nurses",
    occasion: "Graduation",
    budgetContext: "Under $50",
    mustHaveVerifiedFacts: [],
    exclusions: ["Disposable cups"],
    searchTerms: ["insulated", "tumbler"],
  };
  const request = createProductSourcingRequest(
    requestInput,
    new Date("2026-08-09T10:00:00.000Z"),
    "request_existing-catalog",
  );
  const existing = catalogMatchesForRequest(request, content.products)[0]!;
  assert.equal(existing.id, "product_insulated-tumbler");
  assert.throws(
    () =>
      selectCanonicalProductForRequest(
        createProductSourcingRequest({
          ...requestInput,
          mustHaveVerifiedFacts: ["Verified leak-resistant lid"],
        }),
        existing.id,
        content.products,
        "fulfilled",
      ),
    /missing required verified facts/,
  );
  const fulfilled = selectCanonicalProductForRequest(
    request,
    existing.id,
    content.products,
    "fulfilled",
  );
  const assigned = assignSourcedProductToDraftSlot(fulfilled, existing.id, draft, content);
  assert.equal(assigned.recommendations[0]!.productId, existing.id);
  assert.equal(assigned.recommendations[0]!.editorialStatus, "needs-generation");
  assert.ok(validateGuideDraft(assigned, content).errors.length > 0);
  assert.throws(() => guideDraftToPublic(assigned, content), /slot|obligatorio|lista/i);

  const preview = prepareManualProductIntake(
    manualProductIntakeInput({
      productUrl: "https://www.amazon.com/dp/M123456789",
      asin: "M123456789",
      name: "Manually sourced recovery wrap",
      categories: ["recovery tools"],
      interests: ["recovery"],
      sourceFacts: ["Reusable wrap"],
      verifiedFacts: ["Reusable wrap"],
    }),
    repository,
  );
  assert.deepEqual(preview.errors, []);
  const intake = await commitManualProductIntake(preview, repository);
  const manualRequest = createProductSourcingRequest(
    {
      ...requestInput,
      origin: { kind: "guide-draft", guideDraftId: draft.id },
      intendedRole: "Off-shift recovery",
      requiredCategory: "Recovery tools",
      mustHaveVerifiedFacts: ["Reusable wrap"],
      searchTerms: ["recovery", "wrap"],
    },
    new Date("2026-08-09T11:00:00.000Z"),
    "request_manual-intake",
  );
  const manuallyFulfilled = selectCanonicalProductForRequest(
    manualRequest,
    intake.product.id,
    catalog.read().products,
    "fulfilled",
  );
  assert.deepEqual(manuallyFulfilled.approvedProductIds, [intake.product.id]);

  const secondExplicitSelection = selectCanonicalProductForRequest(
    createProductSourcingRequest(
      { ...requestInput, origin: { kind: "guide-draft", guideDraftId: draft.id } },
      new Date("2026-08-09T12:00:00.000Z"),
      "request_same-product-second-time",
    ),
    existing.id,
    content.products,
    "fulfilled",
  );
  assert.deepEqual(secondExplicitSelection.approvedProductIds, [existing.id]);
});

test("revisa candidatos API por lote sin permitirles saltar el Product canónico", () => {
  const content = readPublicContent();
  const product = content.products.find(({ id }) => id === "product_insulated-tumbler")!;
  const request = createProductSourcingRequest(
    {
      origin: { kind: "guide-draft", guideDraftId: "guide_api-fixture" },
      intendedRole: "Hydration during shifts",
      requiredCategory: "Insulated drinkware",
      audience: "Working nurses",
      occasion: "Graduation",
      budgetContext: "Under $50",
      mustHaveVerifiedFacts: [],
      exclusions: [],
      searchTerms: ["insulated", "tumbler"],
    },
    new Date("2026-08-09T10:00:00.000Z"),
    "request_api-fixture",
  );
  const withCandidates = addProductSourceCandidates(
    request,
    [
      {
        id: "source_candidate_api-tumbler",
        sourceKind: "amazon-creators-api",
        provider: "Amazon Creators API",
        marketplace: "amazon.com",
        externalId: "B123456789",
        sourceUrl: "https://www.amazon.com/dp/B123456789",
        name: "API tumbler fixture",
        sourceFacts: ["Fixture fact for review"],
      },
      {
        id: "source_candidate_manual-reject",
        sourceKind: "manual",
        provider: "Manual fixture",
        name: "Rejected fixture",
      },
    ],
    new Date("2026-08-09T11:00:00.000Z"),
  );
  assert.throws(
    () =>
      linkProductSourceCandidate(
        withCandidates,
        "source_candidate_api-tumbler",
        product.id,
        "source_api-tumbler",
        content.products,
        [],
      ),
    /Review and approve/,
  );
  assert.throws(
    () =>
      selectCanonicalProductForRequest(
        withCandidates,
        "source_candidate_api-tumbler",
        content.products,
        "fulfilled",
      ),
    /canonical Product/,
  );
  const reviewed = reviewProductSourceCandidates(
    withCandidates,
    [
      { candidateId: "source_candidate_api-tumbler", decision: "approved-for-intake" },
      { candidateId: "source_candidate_manual-reject", decision: "rejected" },
    ],
    new Date("2026-08-09T12:00:00.000Z"),
  );
  const source = sourceRecord(product.id, {
    id: "source_api-tumbler",
    sourceKind: "amazon-creators-api",
    provider: "Amazon Creators API",
    marketplace: "amazon.com",
    externalId: "B123456789",
    importMethod: "api",
  });
  const linked = linkProductSourceCandidate(
    reviewed,
    "source_candidate_api-tumbler",
    product.id,
    source.id,
    content.products,
    [source],
    new Date("2026-08-09T13:00:00.000Z"),
  );
  assert.equal(linked.sourceCandidates[0]!.status, "linked-to-product");
  assert.equal(linked.status, "open");
  assert.deepEqual(linked.approvedProductIds, []);
  const fulfilled = selectCanonicalProductForRequest(
    linked,
    product.id,
    content.products,
    "fulfilled",
  );
  assert.deepEqual(fulfilled.approvedProductIds, [product.id]);
});

test("genera SearchPlans para varios slots con una sola llamada editorial y todo el contexto conocido", async () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_discovery-planning", now),
    title: "Night-shift recovery gifts",
    primaryAxis: "work-context",
    primaryIntent: "Help nurses recover around overnight shifts.",
    taxonomies: {
      recipients: ["nurses"],
      workContexts: ["night shift"],
      giftStyles: ["practical"],
    },
    budgetContext: { currency: "USD", label: "Under $50", maximum: 50 },
    questionnaire: {
      giftCount: 3,
      recipient: "Night-shift nurses",
      occasion: "Graduation",
      budget: "Under $50",
      interests: "daytime sleep and recovery",
      avoid: "decorative-only gifts",
      additional: "Needs to work in a shared home.",
    },
    recommendations: [
      {
        id: "slot_sleep-support",
        position: 1,
        slotLabel: "Sleep support",
        slotIntent: "Reduce light during daytime sleep after a shift.",
        searchTerms: ["blackout", "sleep mask"],
        budgetHint: "Under $35",
        editorialStatus: "needs-generation",
      },
      {
        id: "slot_meal-support",
        position: 2,
        slotLabel: "Meal support",
        slotIntent: "Carry a secure meal through an overnight shift.",
        searchTerms: ["leak resistant", "lunch container"],
        editorialStatus: "needs-generation",
      },
    ],
  });
  const requests = draft.recommendations.map((slot, index) =>
    createProductSourcingRequest(
      {
        origin: {
          kind: "recommendation-slot",
          guideDraftId: draft.id,
          recommendationSlotId: slot.id,
        },
        intendedRole: slot.slotIntent!,
        requiredCategory: slot.slotLabel,
        audience: "Night-shift nurses",
        occasion: "Graduation",
        budgetContext: slot.budgetHint ?? "Under $50",
        mustHaveVerifiedFacts: index === 0 ? ["Adjustable fit"] : ["Leak-resistant lid"],
        exclusions: ["decorative-only gifts"],
        searchTerms: slot.searchTerms!,
      },
      now,
      `request_discovery-plan-${index + 1}`,
    ),
  );
  const brief = editorialBriefSchema.parse({
    schemaVersion: 1,
    recordType: "editorial-brief",
    id: "brief_discovery-planning",
    sourceCandidateId: "candidate_discovery-planning",
    clusterId: "cluster_nurse-gifts",
    workingTitle: "Night-shift recovery gifts",
    proposedSlug: "night-shift-recovery-gifts",
    primaryAxis: "work-context",
    primaryIntent: "Support recovery around overnight shifts.",
    targetAudience: "Night-shift nurses",
    problemSolved: "Daytime sleep and overnight routines need context-specific support.",
    differentiation: "Organized around the overnight work cycle.",
    plannedSections: [{ heading: "Daytime sleep", purpose: "Support recovery after work." }],
    productRequirements: ["daytime sleep support", "secure meal storage"],
    researchQuestions: [],
    expectedInternalLinks: [],
    relatedContentIds: [],
    evidenceNotes: {
      deterministic: [],
      observed: [],
      aiInterpretation: [],
      humanDecision: "Approved for fixture.",
      editorial: [],
    },
    risks: ["Avoid unsupported health claims"],
    status: "converted-to-guide-draft",
    guideDraftId: draft.id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    approvedAt: now.toISOString(),
    convertedAt: now.toISOString(),
  });
  const prepared = prepareProductSearchPlanningPrompt(requests, [draft], [brief]);
  assert.equal(prepared.input.slots[0]!.editorialProblem, brief.problemSolved);
  assert.equal(prepared.input.slots[0]!.recommendationSlot?.id, "slot_sleep-support");
  assert.equal(
    prepared.input.slots[0]!.guide?.questionnaire.interests,
    draft.questionnaire.interests,
  );
  assert.deepEqual(prepared.input.slots[0]!.guide?.taxonomies, [
    "nurses",
    "night shift",
    "practical",
  ]);
  assert.match(prepared.input.slots[0]!.guide?.budgetContext ?? "", /maximum 50 USD/);
  assert.match(prepared.prompt, /editorial problem -> use case -> Product class -> concrete query/);

  const mock = new MockGuideGenerationProvider();
  let calls = 0;
  const trackingProvider: GuideGenerationProvider = {
    providerId: mock.providerId,
    modelId: mock.modelId,
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      calls += 1;
      assert.equal(request.operation, "product-search-plans");
      return mock.generateStructured(request);
    },
  };
  const planned = await generateProductSearchPlans(
    requests,
    trackingProvider,
    [draft],
    [brief],
    now,
  );
  assert.equal(calls, 1);
  assert.equal(planned.length, 2);
  assert.ok(planned.every(({ searchPlan }) => searchPlan && searchPlan.queries.length <= 3));
  assert.deepEqual(planned[0]!.searchPlan?.mustHaveAttributes, ["Adjustable fit"]);
});

test("mapea fixtures SerpAPI al candidato I.2 observado y sanea vacíos, forma, cuota y timeout", async () => {
  const observedAt = "2026-08-11T12:00:00.000Z";
  let requestedUrl = "";
  const success = new SerpApiProductDiscoverySource("fixture-key", 100, async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(await productDiscoveryFixture("serpapi-success")), {
      status: 200,
    });
  });
  const candidates = await success.search({
    query: "night shift leak resistant tumbler",
    candidateLimit: 4,
    observedAt,
  });
  assert.equal(new URL(requestedUrl).searchParams.get("engine"), "google_shopping");
  assert.equal(new URL(requestedUrl).searchParams.get("api_key"), "fixture-key");
  assert.equal(candidates[0]!.discoveryMode, "general");
  assert.equal(candidates[0]!.sourceKind, "serpapi");
  assert.equal(candidates[0]!.provider, "SerpAPI");
  assert.equal(candidates[0]!.merchant, "Example Merchant");
  assert.equal(candidates[0]!.query, "night shift leak resistant tumbler");
  assert.equal(candidates[0]!.observedPrice, "$29.99");
  assert.equal(candidates[0]!.observedRating, 4.7);
  assert.equal(candidates[0]!.observedReviewCount, 321);
  assert.equal(candidates[0]!.sourceUrl, "https://www.google.com/shopping/product/1001?gl=us");
  assert.equal(candidates[0]!.productUrl, undefined);
  productSourceCandidateSchema.parse({
    ...candidates[0],
    id: "source_candidate_serpapi-fixture",
    status: "needs-review",
    addedAt: observedAt,
  });

  const direct = new SerpApiProductDiscoverySource(
    "fixture-key",
    100,
    async () =>
      new Response(
        JSON.stringify({
          shopping_results: [
            {
              title: "Direct merchant candidate",
              product_link: "https://merchant.example/products/direct",
              source: "Example Merchant",
            },
          ],
        }),
        { status: 200 },
      ),
  );
  assert.equal(
    (await direct.search({ query: "direct merchant product", candidateLimit: 1, observedAt }))[0]!
      .productUrl,
    "https://merchant.example/products/direct",
  );

  const adapterFor = (fixture: string) =>
    new SerpApiProductDiscoverySource(
      "fixture-key",
      100,
      async () =>
        new Response(JSON.stringify(await productDiscoveryFixture(fixture)), { status: 200 }),
    );
  assert.deepEqual(
    await adapterFor("serpapi-empty").search({ query: "none", candidateLimit: 4, observedAt }),
    [],
  );
  await assert.rejects(
    () =>
      adapterFor("serpapi-malformed").search({
        query: "malformed",
        candidateLimit: 4,
        observedAt,
      }),
    (error) => error instanceof ProductDiscoveryError && error.code === "malformed",
  );
  await assert.rejects(
    () => adapterFor("serpapi-quota").search({ query: "quota", candidateLimit: 4, observedAt }),
    (error) => error instanceof ProductDiscoveryError && error.code === "quota",
  );
  const timeoutFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      const fallback = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(fallback);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  await assert.rejects(
    () =>
      new SerpApiProductDiscoverySource("fixture-key", 5, timeoutFetch).search({
        query: "timeout",
        candidateLimit: 4,
        observedAt,
      }),
    (error) => error instanceof ProductDiscoveryError && error.code === "timeout",
  );
});

test("usa el modo Amazon oficial de SerpAPI sólo cuando se pide y normaliza evidencia sin crear Product", async () => {
  const observedAt = "2026-08-11T12:00:00.000Z";
  const beforeProducts = readPublicContent().products.length;
  let requestedUrl = "";
  let calls = 0;
  const adapter = new SerpApiProductDiscoverySource("fixture-key", 100, async (input) => {
    calls++;
    requestedUrl = String(input);
    return new Response(JSON.stringify(await productDiscoveryFixture("serpapi-amazon-success")), {
      status: 200,
    });
  });
  const candidates = await adapter.search({
    query: "large capacity hydration reservoir",
    candidateLimit: 2,
    observedAt,
    discoveryMode: "amazon",
  });

  const params = new URL(requestedUrl).searchParams;
  assert.equal(calls, 1);
  assert.equal(params.get("engine"), "amazon");
  assert.equal(params.get("k"), "large capacity hydration reservoir");
  assert.equal(params.get("amazon_domain"), "amazon.com");
  assert.equal(params.get("language"), "en_US");
  assert.equal(params.get("q"), null);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]!.sourceKind, "serpapi");
  assert.equal(candidates[0]!.provider, "SerpAPI");
  assert.equal(candidates[0]!.discoveryMode, "amazon");
  assert.equal(candidates[0]!.marketplace, "amazon.com");
  assert.equal(candidates[0]!.externalId, "B0ABC12345");
  assert.equal(
    candidates[0]!.productUrl,
    "https://www.amazon.com/Hydration-Reservoir/dp/B0ABC12345/",
  );
  assert.equal(candidates[0]!.merchant, undefined);
  assert.equal(candidates[0]!.brand, "HydraPak");
  assert.equal(candidates[1]!.brand, undefined);
  assert.equal(candidates[0]!.observedPrice, "$54.95");
  assert.equal(candidates[0]!.observedRating, 4.6);
  assert.equal(candidates[0]!.observedReviewCount, 742);
  assert.equal(candidates[0]!.providerResultPosition, 1);
  assert.match(candidates[0]!.observedImageUrl ?? "", /^https:\/\/m\.media-amazon\.com\//);
  assert.equal(readPublicContent().products.length, beforeProducts);

  const responseAdapter = (payload: unknown, timeoutMs = 100) =>
    new SerpApiProductDiscoverySource(
      "fixture-key",
      timeoutMs,
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    );
  assert.deepEqual(
    await responseAdapter({ organic_results: [] }).search({
      query: "empty",
      candidateLimit: 4,
      observedAt,
      discoveryMode: "amazon",
    }),
    [],
  );
  await assert.rejects(
    () =>
      responseAdapter({ organic_results: [{ title: "missing link" }] }).search({
        query: "malformed",
        candidateLimit: 4,
        observedAt,
        discoveryMode: "amazon",
      }),
    (error) => error instanceof ProductDiscoveryError && error.code === "malformed",
  );
  await assert.rejects(
    () =>
      responseAdapter({ error: "Your account has run out of searches." }).search({
        query: "quota",
        candidateLimit: 4,
        observedAt,
        discoveryMode: "amazon",
      }),
    (error) => error instanceof ProductDiscoveryError && error.code === "quota",
  );
  const timeoutFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      const fallback = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(fallback);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  await assert.rejects(
    () =>
      new SerpApiProductDiscoverySource("fixture-key", 5, timeoutFetch).search({
        query: "timeout",
        candidateLimit: 4,
        observedAt,
        discoveryMode: "amazon",
      }),
    (error) => error instanceof ProductDiscoveryError && error.code === "timeout",
  );
});

test("acota Amazon a una llamada, deduplica ASIN y no usa DataForSEO ni fallback general", async () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const request = productSourcingRequestSchema.parse({
    ...createProductSourcingRequest(
      {
        origin: { kind: "guide-draft", guideDraftId: "guide_amazon-discovery" },
        intendedRole: "Carry water on a demanding assignment.",
        requiredCategory: "Large-capacity hydration reservoir",
        audience: "Wildland firefighters",
        occasion: "First season",
        budgetContext: "Under $75",
        searchTerms: ["large capacity hydration reservoir"],
      },
      now,
      "request_amazon-discovery",
    ),
    searchPlan: {
      productClass: "Hydration reservoir",
      mustHaveAttributes: ["large capacity"],
      usefulAttributes: ["durable"],
      exclusions: [],
      queries: ["large capacity hydration reservoir", "hydration bladder", "water reservoir"],
      providerId: "mock",
      promptVersion: "product-search-plan-v1",
      plannedAt: now.toISOString(),
    },
  });
  let calls = 0;
  const source = new SerpApiProductDiscoverySource("fixture-key", 100, async () => {
    calls++;
    return new Response(JSON.stringify(await productDiscoveryFixture("serpapi-amazon-success")), {
      status: 200,
    });
  });
  const result = await runProductDiscovery(request, source, {
    products: [],
    forceExternal: true,
    discoveryMode: "amazon",
    round: 1,
    now,
  });
  assert.equal(calls, 1);
  assert.equal(result.sourceCandidates.length, 1);
  assert.equal(result.sourceCandidates[0]!.externalId, "B0ABC12345");
  assert.equal(result.sourceCandidates[0]!.discoveryMode, "amazon");
  assert.deepEqual(result.discoveryRounds[0]!.queries, ["large capacity hydration reservoir"]);
  assert.equal(result.discoveryRounds[0]!.providerCalls, 1);
  assert.equal(result.discoveryRounds[0]!.storedCandidateCount, 1);
  assert.equal(result.discoveryRounds[0]!.discoveryMode, "amazon");

  let dataForSeoCalls = 0;
  const dataForSeo: ProductDiscoverySource = {
    providerId: "dataforseo",
    paidUsage: true,
    supportedModes: ["general"],
    async search() {
      dataForSeoCalls++;
      return [];
    },
  };
  await assert.rejects(
    () =>
      runProductDiscovery(request, dataForSeo, {
        products: [],
        forceExternal: true,
        discoveryMode: "amazon",
        round: 1,
        now,
      }),
    /requires the configured SerpAPI provider/,
  );
  assert.equal(dataForSeoCalls, 0);

  let failedCalls = 0;
  const failedSerp: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["general", "amazon"],
    async search(input) {
      failedCalls++;
      assert.equal(input.discoveryMode, "amazon");
      throw new ProductDiscoveryError("fixture quota", "quota");
    },
  };
  const failed = await runProductDiscovery(request, failedSerp, {
    products: [],
    forceExternal: true,
    discoveryMode: "amazon",
    round: 1,
    now,
  });
  assert.equal(failedCalls, 1);
  assert.equal(failed.discoveryRounds[0]!.status, "failed");
  assert.equal(failed.discoveryRounds[0]!.failureCode, "quota");
  assert.deepEqual(failed.sourceCandidates, []);
});

test("reutiliza candidatos sólo dentro del modo solicitado sin perder candidatos de otro modo", async () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const observedAt = now.toISOString();
  const planned = productSourcingRequestSchema.parse({
    ...createProductSourcingRequest(
      {
        origin: { kind: "guide-draft", guideDraftId: "guide_mode-aware-reuse" },
        intendedRole: "Keep drinks secure during a long shift.",
        requiredCategory: "Insulated tumbler",
        audience: "Working nurses",
        occasion: "Graduation",
        budgetContext: "Under $50",
        searchTerms: ["mode-aware query"],
      },
      now,
      "request_mode-aware-reuse",
    ),
    searchPlan: {
      productClass: "Insulated tumbler",
      mustHaveAttributes: [],
      usefulAttributes: [],
      exclusions: [],
      queries: ["mode-aware query"],
      providerId: "mock",
      promptVersion: "product-search-plan-v1",
      plannedAt: observedAt,
    },
  });
  const candidateForMode = (
    discoveryMode: ProductDiscoveryMode,
    index: number,
  ): ProductSourceCandidateInput => {
    const externalId = discoveryMode === "amazon" ? `B0MODE000${index}` : `general-${index}`;
    const productUrl =
      discoveryMode === "amazon"
        ? `https://www.amazon.com/dp/${externalId}`
        : `https://merchant.example/${externalId}`;
    return {
      id: `source_candidate_${discoveryMode}-${index}`,
      sourceKind: "serpapi",
      provider: "SerpAPI",
      discoveryMode,
      marketplace: discoveryMode === "amazon" ? "amazon.com" : "google.com",
      externalId,
      sourceUrl: productUrl,
      productUrl,
      name: `${discoveryMode} candidate ${index}`,
      sourceFacts: [],
      query: "mode-aware query",
      observedAt,
    };
  };
  const withModeCandidates = (discoveryMode: ProductDiscoveryMode) =>
    addProductSourceCandidates(
      planned,
      Array.from({ length: 4 }, (_, index) => candidateForMode(discoveryMode, index)),
      now,
    );
  const generalCandidates = withModeCandidates("general");
  const amazonCandidates = withModeCandidates("amazon");
  const calls: ProductDiscoveryMode[] = [];
  const source: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["general", "amazon"],
    async search(input) {
      const discoveryMode = input.discoveryMode ?? "general";
      calls.push(discoveryMode);
      return [candidateForMode(discoveryMode, 9)];
    },
  };

  const amazonRun = await runProductDiscovery(generalCandidates, source, {
    products: [],
    forceExternal: true,
    discoveryMode: "amazon",
    round: 1,
    now,
  });
  assert.deepEqual(calls, ["amazon"]);
  assert.equal(amazonRun.sourceCandidates.length, 5);
  assert.ok(
    generalCandidates.sourceCandidates.every(({ id }) =>
      amazonRun.sourceCandidates.some((candidate) => candidate.id === id),
    ),
  );
  assert.equal(amazonRun.discoveryRounds[0]!.discoveryMode, "amazon");
  assert.equal(amazonRun.discoveryRounds[0]!.providerCalls, 1);
  assert.equal(amazonRun.discoveryRounds[0]!.storedCandidateCount, 1);

  calls.length = 0;
  const generalRun = await runProductDiscovery(amazonCandidates, source, {
    products: [],
    forceExternal: true,
    discoveryMode: "general",
    round: 1,
    now,
  });
  assert.deepEqual(calls, ["general"]);
  assert.equal(generalRun.sourceCandidates.length, 5);
  assert.ok(
    amazonCandidates.sourceCandidates.every(({ id }) =>
      generalRun.sourceCandidates.some((candidate) => candidate.id === id),
    ),
  );
  assert.equal(generalRun.discoveryRounds[0]!.discoveryMode, "general");
  assert.equal(generalRun.discoveryRounds[0]!.providerCalls, 1);

  calls.length = 0;
  const sameModeBound = await runProductDiscovery(amazonCandidates, source, {
    products: [],
    forceExternal: true,
    discoveryMode: "amazon",
    round: 1,
    now,
  });
  assert.deepEqual(calls, []);
  assert.equal(sameModeBound.discoveryRounds[0]!.status, "reused-candidates");
  assert.equal(sameModeBound.sourceCandidates.length, 4);

  const compatibleRecent = productSourcingRequestSchema.parse({
    ...amazonCandidates,
    id: "request_mode-aware-compatible",
    origin: { kind: "guide-draft", guideDraftId: "guide_mode-aware-compatible" },
  });
  const sameModeReuse = await runProductDiscovery(planned, source, {
    products: [],
    allRequests: [compatibleRecent],
    discoveryMode: "amazon",
    round: 1,
    now,
  });
  assert.deepEqual(calls, []);
  assert.equal(sameModeReuse.discoveryRounds[0]!.status, "reused-candidates");
  assert.equal(sameModeReuse.sourceCandidates.length, 4);

  const incompatibleRecent = productSourcingRequestSchema.parse({
    ...compatibleRecent,
    id: "request_mode-aware-incompatible",
    origin: { kind: "guide-draft", guideDraftId: "guide_mode-aware-incompatible" },
    requiredCategory: "Electrolyte tablets",
    searchPlan: { ...compatibleRecent.searchPlan!, productClass: "Electrolyte tablets" },
  });
  calls.length = 0;
  const incompatibleReuseBlocked = await runProductDiscovery(planned, source, {
    products: [],
    allRequests: [incompatibleRecent],
    discoveryMode: "amazon",
    round: 1,
    now,
  });
  assert.deepEqual(calls, ["amazon"]);
  assert.equal(incompatibleReuseBlocked.discoveryRounds[0]!.status, "stored");

  calls.length = 0;
  const catalogProduct = readPublicContent().products[0]!;
  const catalogBypassed = await runProductDiscovery(planned, source, {
    products: [catalogProduct],
    benchmarkProductIds: [catalogProduct.id],
    forceExternal: true,
    discoveryMode: "amazon",
    round: 1,
    now,
  });
  assert.deepEqual(calls, ["amazon"]);
  assert.equal(catalogBypassed.discoveryRounds[0]!.providerCalls, 1);

  calls.length = 0;
  const recentBeforeFreshDiscovery = await runProductDiscovery(planned, source, {
    products: [catalogProduct],
    allRequests: [compatibleRecent],
    skipCatalogReuse: true,
    discoveryMode: "amazon",
    round: 1,
    now,
  });
  assert.deepEqual(calls, []);
  assert.equal(recentBeforeFreshDiscovery.discoveryRounds[0]!.status, "reused-candidates");

  const existingAmazon = addProductSourceCandidates(planned, [candidateForMode("amazon", 0)], now);
  const beforeProducts = readPublicContent().products.length;
  let duplicateCalls = 0;
  const duplicate = await runProductDiscovery(
    existingAmazon,
    {
      ...source,
      async search() {
        duplicateCalls++;
        return [candidateForMode("amazon", 0)];
      },
    },
    { products: [], forceExternal: true, discoveryMode: "amazon", round: 1, now },
  );
  assert.equal(duplicateCalls, 1);
  assert.equal(duplicate.sourceCandidates.length, 1);
  assert.equal(duplicate.discoveryRounds[0]!.storedCandidateCount, 0);
  assert.equal(readPublicContent().products.length, beforeProducts);

  const empty = await runProductDiscovery(
    planned,
    {
      ...source,
      async search(input) {
        assert.equal(input.discoveryMode, "amazon");
        return [];
      },
    },
    { products: [], forceExternal: true, discoveryMode: "amazon", round: 1, now },
  );
  assert.equal(empty.discoveryRounds[0]!.status, "empty");
  assert.equal(empty.discoveryRounds[0]!.providerCalls, 1);
  assert.equal(empty.discoveryRounds[0]!.storedCandidateCount, 0);
  assert.deepEqual(empty.sourceCandidates, []);

  for (const code of ["timeout", "quota", "malformed"] as const) {
    const failed = await runProductDiscovery(
      planned,
      {
        ...source,
        async search(input) {
          assert.equal(input.discoveryMode, "amazon");
          throw new ProductDiscoveryError(`fixture ${code}`, code);
        },
      },
      { products: [], forceExternal: true, discoveryMode: "amazon", round: 1, now },
    );
    assert.equal(failed.discoveryRounds[0]!.status, "failed");
    assert.equal(failed.discoveryRounds[0]!.discoveryMode, "amazon");
    assert.equal(failed.discoveryRounds[0]!.providerCalls, 1);
    assert.equal(failed.discoveryRounds[0]!.failureCode, code);
  }
});

test("mantiene DataForSEO apagado por defecto y exige selección, enablement, policy y Basic auth", async () => {
  assert.deepEqual(resolveProductDiscoveryConfiguration({}), { provider: "disabled" });
  assert.equal(createProductDiscoverySource({}), undefined);
  assert.throws(
    () => resolveProductDiscoveryConfiguration({ PRODUCT_DISCOVERY_PROVIDER: "dataforseo" }),
    /remains disabled/,
  );
  assert.throws(
    () =>
      resolveProductDiscoveryConfiguration({
        PRODUCT_DISCOVERY_PROVIDER: "dataforseo",
        DATAFORSEO_ENABLED: "true",
      }),
    /PAID_POLICY/,
  );
  const environment = {
    PRODUCT_DISCOVERY_PROVIDER: "dataforseo",
    DATAFORSEO_ENABLED: "true",
    PRODUCT_DISCOVERY_PAID_POLICY: "allow-paid-dataforseo",
    DATAFORSEO_LOGIN: "fixture-login",
    DATAFORSEO_PASSWORD: "fixture-password",
  };
  assert.equal(createProductDiscoverySource(environment)?.providerId, "dataforseo");

  let requestedUrl = "";
  let authorization = "";
  const adapter = new DataForSeoProductDiscoverySource(
    "fixture-login",
    "fixture-password",
    100,
    async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(await productDiscoveryFixture("dataforseo-success")), {
        status: 200,
      });
    },
  );
  const candidates = await adapter.search({
    query: "compact overnight work tumbler",
    candidateLimit: 4,
    observedAt: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(requestedUrl, "https://api.dataforseo.com/v3/serp/google/organic/live/advanced");
  assert.equal(
    authorization,
    `Basic ${Buffer.from("fixture-login:fixture-password").toString("base64")}`,
  );
  assert.equal(candidates[0]!.sourceKind, "dataforseo");
  assert.equal(candidates[0]!.domain, "shop.example.com");
  assert.equal(candidates[0]!.externalId, "dfs-product-2001");
  assert.equal(candidates[0]!.observedPrice, "$32.50");
  assert.equal(candidates[0]!.observedReviewCount, 85);
});

test("acota consultas, concurrencia, candidatos y rondas sin cumplir ni asignar el slot", async () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const draft = addManualRecommendation(
    createGuideDraft("guide_bounded-discovery", now),
    "Hard shell badge case",
    "Protect a badge during a commute.",
    ["hard shell", "badge case", "commute"],
    "slot_bounded-discovery",
  );
  const base = createProductSourcingRequest(
    {
      origin: {
        kind: "recommendation-slot",
        guideDraftId: draft.id,
        recommendationSlotId: "slot_bounded-discovery",
      },
      intendedRole: "Protect a badge during a commute.",
      requiredCategory: "Hard shell badge case",
      audience: "Working nurses",
      occasion: "New job",
      budgetContext: "Under $40",
      mustHaveVerifiedFacts: [],
      exclusions: ["soft sleeves"],
      searchTerms: ["hard shell", "badge case", "commute"],
    },
    now,
    "request_bounded-discovery",
  );
  const request = productSourcingRequestSchema.parse({
    ...base,
    searchPlan: {
      productClass: "Hard shell badge case",
      mustHaveAttributes: [],
      usefulAttributes: ["compact"],
      exclusions: ["soft sleeves"],
      queries: ["hard shell badge case", "protect badge commute", "compact badge holder"],
      providerId: "mock",
      modelId: "mock-editorial-v1",
      promptVersion: "product-search-plan-v1",
      plannedAt: now.toISOString(),
    },
  });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const source: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    async search(input) {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Array.from({ length: 4 }, (_, index) => ({
        sourceKind: "serpapi" as const,
        provider: "SerpAPI",
        merchant: "Fixture Merchant",
        marketplace: "google.com",
        externalId: `${input.query}-${index}`,
        sourceUrl: `https://www.google.com/shopping/product/${encodeURIComponent(input.query)}/${index}`,
        productUrl: `https://www.google.com/shopping/product/${encodeURIComponent(input.query)}/${index}`,
        name: `${input.query} fixture ${index}`,
        sourceFacts: [],
        query: input.query,
        observedAt: input.observedAt,
      }));
    },
  };
  const beforeCatalogCount = readPublicContent().products.length;
  const first = await runProductDiscovery(request, source, {
    products: [],
    allRequests: [request],
    forceExternal: true,
    round: 1,
    now,
  });
  assert.equal(calls, 3);
  assert.equal(maxActive, 2);
  assert.equal(first.sourceCandidates.length, 4);
  assert.equal(first.discoveryRounds[0]!.providerCalls, 3);
  assert.equal(first.discoveryRounds[0]!.status, "stored");
  assert.equal(first.status, "open");
  assert.deepEqual(first.approvedProductIds, []);
  assert.equal(draft.recommendations[0]!.productId, undefined);
  assert.equal(readPublicContent().products.length, beforeCatalogCount);
  const second = await runProductDiscovery(first, source, {
    products: [],
    forceExternal: true,
    round: 2,
    now: new Date("2026-08-11T13:00:00.000Z"),
  });
  assert.equal(second.discoveryRounds.length, 2);
  await assert.rejects(
    () => runProductDiscovery(second, source, { products: [], forceExternal: true, round: 3 }),
    /second and final discovery round/,
  );
});

test("deduplica resultados, reutiliza catálogo/candidatos y nunca hace fallback pago oculto", async () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const base = createProductSourcingRequest(
    {
      origin: { kind: "guide-draft", guideDraftId: "guide_discovery-reuse" },
      intendedRole: "Keep drinks secure during a long shift.",
      requiredCategory: "Insulated tumbler",
      audience: "Working nurses",
      occasion: "Graduation",
      budgetContext: "Under $50",
      mustHaveVerifiedFacts: [],
      exclusions: [],
      searchTerms: ["insulated tumbler"],
    },
    now,
    "request_discovery-reuse",
  );
  const planned = productSourcingRequestSchema.parse({
    ...base,
    searchPlan: {
      productClass: "Insulated tumbler",
      mustHaveAttributes: [],
      usefulAttributes: [],
      exclusions: [],
      queries: ["insulated tumbler"],
      providerId: "mock",
      promptVersion: "product-search-plan-v1",
      plannedAt: now.toISOString(),
    },
  });
  let providerCalls = 0;
  const shouldNotCall: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    async search() {
      providerCalls += 1;
      throw new Error("unexpected external call");
    },
  };
  const catalogReuse = await runProductDiscovery(planned, shouldNotCall, {
    products: readPublicContent().products,
    round: 1,
    now,
  });
  assert.equal(catalogReuse.discoveryRounds[0]!.status, "reused-catalog");
  assert.equal(providerCalls, 0);

  const duplicates = new SerpApiProductDiscoverySource(
    "fixture-key",
    100,
    async () =>
      new Response(JSON.stringify(await productDiscoveryFixture("serpapi-duplicates")), {
        status: 200,
      }),
  );
  const deduped = await runProductDiscovery(planned, duplicates, {
    products: [],
    forceExternal: true,
    round: 1,
    now,
  });
  assert.equal(deduped.sourceCandidates.length, 1);

  const recentRequest = productSourcingRequestSchema.parse({
    ...planned,
    id: "request_recent-discovery",
    origin: { kind: "guide-draft", guideDraftId: "guide_recent-discovery" },
    sourceCandidates: deduped.sourceCandidates,
    discoveryRounds: [],
  });
  const recentReuse = await runProductDiscovery(planned, shouldNotCall, {
    products: [],
    allRequests: [recentRequest],
    round: 1,
    now,
  });
  assert.equal(recentReuse.discoveryRounds[0]!.status, "reused-candidates");
  assert.equal(providerCalls, 0);

  let staleCandidateCalls = 0;
  const staleCandidateRun = await runProductDiscovery(
    planned,
    {
      providerId: "serpapi",
      paidUsage: true,
      async search() {
        staleCandidateCalls++;
        return [];
      },
    },
    {
      products: [],
      allRequests: [recentRequest],
      round: 1,
      now: new Date("2026-09-11T12:00:00.000Z"),
    },
  );
  assert.equal(staleCandidateCalls, 1);
  assert.equal(staleCandidateRun.discoveryRounds[0]!.status, "empty");

  const empty = new SerpApiProductDiscoverySource(
    "fixture-key",
    100,
    async () =>
      new Response(JSON.stringify(await productDiscoveryFixture("serpapi-empty")), { status: 200 }),
  );
  const zero = await runProductDiscovery(planned, empty, {
    products: [],
    forceExternal: true,
    round: 1,
    now,
  });
  assert.equal(zero.discoveryRounds[0]!.status, "empty");
  assert.deepEqual(zero.sourceCandidates, []);

  let dataForSeoCalls = 0;
  const failedSerp: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    async search() {
      throw new ProductDiscoveryError("fixture quota", "quota");
    },
  };
  const unusedDataForSeo: ProductDiscoverySource = {
    providerId: "dataforseo",
    paidUsage: true,
    async search() {
      dataForSeoCalls += 1;
      return [];
    },
  };
  assert.equal(unusedDataForSeo.providerId, "dataforseo");
  const failed = await runProductDiscovery(planned, failedSerp, {
    products: [],
    forceExternal: true,
    round: 1,
    now,
  });
  assert.equal(failed.discoveryRounds[0]!.status, "failed");
  assert.equal(failed.discoveryRounds[0]!.failureCode, "quota");
  assert.equal(failed.discoveryRounds[0]!.provider, "serpapi");
  assert.equal(dataForSeoCalls, 0);
});

test("prioriza benchmarks canónicos y permite editar el SearchPlan sin fallback externo", async () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const product = new ProductCatalog().read().products[0]!;
  const request = productSourcingRequestSchema.parse({
    ...createProductSourcingRequest(
      {
        origin: { kind: "guide-draft", guideDraftId: "guide_benchmark-priority" },
        intendedRole: "A deliberately unrelated role",
        requiredCategory: "Xylophonic object",
        audience: "Known audience",
        occasion: "Known occasion",
        budgetContext: "Known budget",
        searchTerms: ["xylophonic"],
      },
      now,
      "request_benchmark-priority",
    ),
    searchPlan: {
      productClass: "Xylophonic object",
      mustHaveAttributes: [],
      usefulAttributes: [],
      exclusions: [],
      queries: ["xylophonic object"],
      providerId: "mock",
      promptVersion: "product-search-plan-v1",
      plannedAt: now.toISOString(),
    },
  });
  const edited = updateProductSearchPlan(request, {
    productClass: "Edited object class",
    mustHaveAttributes: ["required attribute"],
    usefulAttributes: ["useful attribute"],
    exclusions: ["excluded attribute"],
    queries: ["edited query"],
  });
  assert.equal(edited.searchPlan!.productClass, "Edited object class");
  assert.deepEqual(edited.searchPlan!.queries, ["edited query"]);
  assert.equal(edited.searchPlan!.providerId, "mock");

  let calls = 0;
  const source: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    async search() {
      calls++;
      return [];
    },
  };
  const reused = await runProductDiscovery(edited, source, {
    products: [product],
    benchmarkProductIds: [product.id],
    round: 1,
    now,
  });
  assert.equal(reused.discoveryRounds[0]!.status, "reused-catalog");
  assert.equal(calls, 0);
});

test("mantiene precio y ratings descubiertos como evidencia observada durante P.1", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-discovery-intake-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const observedAt = "2026-08-11T12:00:00.000Z";
  const adapter = new SerpApiProductDiscoverySource(
    "fixture-key",
    100,
    async () =>
      new Response(JSON.stringify(await productDiscoveryFixture("serpapi-success")), {
        status: 200,
      }),
  );
  const candidate = (
    await adapter.search({ query: "shift tumbler", candidateLimit: 4, observedAt })
  )[0]!;
  const before = readPublicContent(repository).products.length;
  const preview = prepareManualProductIntake(
    {
      productUrl: candidate.productUrl,
      name: "Editor-authored insulated work tumbler",
      merchant: candidate.merchant!,
      shortDescription: "An editor-reviewed tumbler candidate for demanding work routines.",
      sourceFacts: candidate.sourceFacts ?? [],
      verifiedFacts: [],
      verifiedFactsConfirmed: false,
      status: "active",
      discoveryProvenance: {
        sourceKind: "serpapi",
        provider: candidate.provider,
        marketplace: candidate.marketplace,
        externalId: candidate.externalId,
        sourceUrl: candidate.sourceUrl,
        observedAt,
      },
    },
    repository,
  );
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.source?.sourceKind, "serpapi");
  assert.equal(preview.source?.importMethod, "api");
  assert.equal(preview.source?.lastSynchronizedAt, observedAt);
  assert.equal(preview.source?.sourceUrl, "https://www.google.com/shopping/product/1001?gl=us");
  assert.ok(preview.source?.sourceFacts?.some((fact) => fact.includes("Observed rating")));
  assert.equal(preview.product?.productUrl, undefined);
  assert.equal("observedRating" in preview.product!, false);
  assert.equal("observedReviewCount" in preview.product!, false);
  assert.equal("priceLabel" in preview.product!, false);
  assert.equal(productSchema.safeParse(preview.product).success, true);
  assert.equal(readPublicContent(repository).products.length, before, "preview creates no Product");
});

test("mantiene URLs de Google Shopping como evidencia no pública durante la revisión P.1", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-shopping-evidence-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const sourceStore = new ProductSourceStore(repository);
  const requestStore = new ProductSourcingRequestStore(repository);
  const observedAt = "2026-08-11T12:00:00.000Z";
  const googleUrl =
    "https://www.google.com/search?tbm=shop&q=Force+DSL+3L&prds=pid:google-product-force-dsl";
  const saved = await requestStore.save(
    addProductSourceCandidates(
      createProductSourcingRequest(
        {
          origin: { kind: "guide-draft", guideDraftId: "guide_force-dsl-review" },
          intendedRole: "Carry water on a wildland fire assignment",
          requiredCategory: "Hydration reservoir",
          audience: "Wildland firefighters",
          occasion: "First season",
          budgetContext: "Under $75",
          mustHaveVerifiedFacts: [],
          exclusions: [],
          searchTerms: ["hydration reservoir"],
        },
        new Date(observedAt),
        "request_force-dsl-review",
      ),
      [
        {
          id: "source_candidate_force-dsl-review",
          sourceKind: "serpapi",
          provider: "SerpAPI",
          merchant: "HydraPak",
          domain: "www.google.com",
          marketplace: "google.com",
          externalId: "google-product-force-dsl",
          sourceUrl: googleUrl,
          productUrl: googleUrl,
          name: "Force DSL 3L",
          sourceFacts: ["Observed merchant: HydraPak", "Observed price: $53.00"],
          query: "hydration reservoir",
          observedAt,
          observedPrice: "$53.00",
        },
      ],
      new Date(observedAt),
    ),
  );
  const candidate = saved.sourceCandidates[0]!;
  const server = createStudioServer(
    new DraftStore(join(repository, "drafts")),
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const reviewPath = `/products/intake?requestId=${saved.id}&candidateId=${candidate.id}`;
  const reviewHtml = await (await fetch(`${origin}${reviewPath}`)).text();

  assert.match(reviewHtml, /name="name" required value="Force DSL 3L"/);
  assert.match(reviewHtml, /name="brand" value=""/);
  assert.match(reviewHtml, /name="merchant" required value="HydraPak"/);
  assert.match(reviewHtml, /name="productUrl" value=""/);
  assert.doesNotMatch(reviewHtml, /name="productUrl" value="https:\/\/www\.google\.com/);
  assert.match(reviewHtml, /name="discoverySourceUrl" value="https:\/\/www\.google\.com\/search\?/);
  assert.match(reviewHtml, /URL de descubrimiento no pública/);
  assert.match(reviewHtml, /Precio observado: \$53\.00/);

  const intakeForm = new URLSearchParams({
    requestId: saved.id,
    candidateId: candidate.id,
    name: "Force DSL 3L",
    merchant: "HydraPak",
    shortDescription: "A hydration reservoir reviewed for demanding field assignments.",
    sourceFacts: candidate.sourceFacts.join("\n"),
    status: "active",
    discoverySourceKind: "serpapi",
    discoveryProvider: "SerpAPI",
    discoveryObservedAt: observedAt,
    discoveryMarketplace: "google.com",
    discoveryExternalId: "google-product-force-dsl",
    discoverySourceUrl: googleUrl,
    confirm: "yes",
  });
  const unconfirmed = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: intakeForm,
  });
  assert.equal(unconfirmed.status, 400);
  assert.match(await unconfirmed.text(), /confirmIdentity/);
  assert.equal(
    catalog.read().products.some(({ name }) => name === "Force DSL 3L"),
    false,
  );

  for (const name of ["confirmIdentity", "confirmProvenance", "confirmFacts", "confirmDescription"])
    intakeForm.set(name, "yes");
  const committed = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: intakeForm,
    redirect: "manual",
  });
  assert.equal(committed.status, 303);
  const product = catalog.read().products.find(({ name }) => name === "Force DSL 3L")!;
  assert.equal(product.brand, undefined);
  assert.equal(product.merchant, "HydraPak");
  assert.equal(product.productUrl, undefined);
  assert.equal(productDestination(product), undefined);
  const source = sourceStore.forProduct(product.id, catalog.read().products)[0]!;
  assert.equal(source.provider, "SerpAPI");
  assert.equal(source.sourceUrl, googleUrl);
  assert.ok(source.sourceFacts?.includes("Observed price: $53.00"));
  assert.doesNotMatch(
    await readFile(join(repository, "content", "products", `${product.id}.json`), "utf8"),
    /google\.com/,
  );
  assert.equal(requestStore.get(saved.id).sourceCandidates[0]!.status, "linked-to-product");
  assert.deepEqual(requestStore.get(saved.id).approvedProductIds, []);
});

test("P.1 prellena sólo evidencia semánticamente segura de candidatos Amazon", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-amazon-prefill-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const beforeCount = catalog.read().products.length;
  const requestStore = new ProductSourcingRequestStore(repository);
  const observedAt = "2026-08-11T12:00:00.000Z";
  const saved = await requestStore.save(
    addProductSourceCandidates(
      createProductSourcingRequest(
        {
          origin: { kind: "guide-draft", guideDraftId: "guide_amazon-prefill" },
          intendedRole: "Carry water on a demanding assignment.",
          requiredCategory: "Hydration reservoir",
          audience: "Wildland firefighters",
          occasion: "First season",
          budgetContext: "Under $75",
          searchTerms: ["hydration reservoir"],
        },
        new Date(observedAt),
        "request_amazon-prefill",
      ),
      [
        {
          id: "source_candidate_amazon-brand-prefill",
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          brand: "HydraPak",
          marketplace: "amazon.com",
          externalId: "B0ABC12345",
          sourceUrl: "https://www.amazon.com/Hydration-Reservoir/dp/B0ABC12345/ref=sr_1_1",
          productUrl: "https://www.amazon.com/Hydration-Reservoir/dp/B0ABC12345/",
          name: "Large-capacity hydration reservoir",
          sourceFacts: ["Observed price: $54.95", "Observed rating: 4.6"],
          query: "large capacity hydration reservoir",
          observedAt,
          observedPrice: "$54.95",
          observedRating: 4.6,
          observedReviewCount: 742,
          observedImageUrl: "https://m.media-amazon.com/images/I/example._AC_UL320_.jpg",
          providerResultPosition: 1,
        },
        {
          id: "source_candidate_amazon-merchant-prefill",
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          merchant: "Explicit observed merchant",
          marketplace: "amazon.com",
          externalId: "B0DEF12345",
          sourceUrl: "https://www.amazon.com/dp/B0DEF12345/ref=sr_1_2",
          productUrl: "https://www.amazon.com/dp/B0DEF12345/",
          name: "Merchant-evidenced reservoir",
          sourceFacts: [],
          query: "hydration reservoir",
          observedAt,
        },
        {
          id: "source_candidate_amazon-url-prefill",
          sourceKind: "manual",
          provider: "Manual",
          sourceUrl: "https://www.amazon.com/dp/B08KBWHZPM/ref=example",
          productUrl: "https://www.amazon.com/dp/B08KBWHZPM/",
          name: "Amazon URL candidate",
          sourceFacts: [],
        },
        {
          id: "source_candidate_amazon-asin-prefill",
          sourceKind: "manual",
          provider: "Manual",
          marketplace: "amazon.com",
          externalId: "B0GHI12345",
          name: "Amazon ASIN candidate",
          sourceFacts: [],
        },
        {
          id: "source_candidate_non-amazon-prefill",
          sourceKind: "manual",
          provider: "Manual",
          sourceUrl: "https://merchant.example/products/reservoir",
          productUrl: "https://merchant.example/products/reservoir",
          name: "Non-Amazon candidate",
          sourceFacts: [],
        },
      ],
      new Date(observedAt),
    ),
  );
  const server = createStudioServer(
    new DraftStore(join(repository, "drafts")),
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    new ProductSourceStore(repository),
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const brandHtml = await (
    await fetch(
      `${origin}/products/intake?requestId=${saved.id}&candidateId=source_candidate_amazon-brand-prefill`,
    )
  ).text();
  assert.match(brandHtml, /name="name" required value="Large-capacity hydration reservoir"/);
  assert.match(brandHtml, /name="brand" value="HydraPak"/);
  assert.match(brandHtml, /name="merchant" required value="Amazon"/);
  assert.match(brandHtml, /name="asin" value="B0ABC12345"/);
  assert.match(
    brandHtml,
    /name="productUrl" value="https:\/\/www\.amazon\.com\/Hydration-Reservoir\/dp\/B0ABC12345\/"/,
  );
  assert.match(brandHtml, /Precio observado: \$54\.95/);
  assert.match(brandHtml, /Rating observado: 4\.6/);
  assert.match(brandHtml, /Reseñas observadas: 742/);
  assert.match(brandHtml, /Imagen observada, sin derechos verificados/);
  assert.match(brandHtml, /<summary>Trazabilidad interna<\/summary>/);

  const merchantHtml = await (
    await fetch(
      `${origin}/products/intake?requestId=${saved.id}&candidateId=source_candidate_amazon-merchant-prefill`,
    )
  ).text();
  assert.match(merchantHtml, /name="brand" value=""/);
  assert.match(merchantHtml, /name="merchant" required value="Explicit observed merchant"/);

  const urlHtml = await (
    await fetch(
      `${origin}/products/intake?requestId=${saved.id}&candidateId=source_candidate_amazon-url-prefill`,
    )
  ).text();
  assert.match(urlHtml, /name="brand" value=""/);
  assert.match(urlHtml, /name="merchant" required value="Amazon"/);
  assert.match(urlHtml, /name="asin" value="B08KBWHZPM"/);
  assert.match(urlHtml, /name="affiliateUrl" value=""/);

  const asinHtml = await (
    await fetch(
      `${origin}/products/intake?requestId=${saved.id}&candidateId=source_candidate_amazon-asin-prefill`,
    )
  ).text();
  assert.match(asinHtml, /name="merchant" required value="Amazon"/);
  assert.match(asinHtml, /name="asin" value="B0GHI12345"/);

  const nonAmazonHtml = await (
    await fetch(
      `${origin}/products/intake?requestId=${saved.id}&candidateId=source_candidate_non-amazon-prefill`,
    )
  ).text();
  assert.match(nonAmazonHtml, /name="merchant" required value=""/);

  const unconfirmed = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      requestId: saved.id,
      candidateId: "source_candidate_amazon-url-prefill",
      productUrl: "https://www.amazon.com/dp/B08KBWHZPM/",
      asin: "B08KBWHZPM",
      name: "Amazon URL candidate",
      merchant: "Amazon",
      shortDescription: "An editor-authored description for the candidate under review.",
      status: "active",
      confirm: "yes",
    }),
  });
  assert.equal(unconfirmed.status, 400);
  assert.match(await unconfirmed.text(), /confirmIdentity/);
  assert.equal(catalog.read().products.length, beforeCount);
});

test("P.1 genera un borrador editorial aislado y conserva el flujo manual ante fallos", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-editorial-copy-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourceStore = new ProductSourceStore(repository);
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_editorial-copy"),
      status: "selecting-products",
      questionnaire: {
        giftCount: 8,
        recipient: "Wildland firefighters",
        occasion: "First season",
        budget: "Under $25",
      },
      recommendations: [
        {
          id: "slot_editorial-copy",
          position: 1,
          slotLabel: "Electrolyte Tablets or Powder",
          slotIntent: "Offer a compact hydration option for demanding workdays.",
          searchTerms: ["electrolyte tablets"],
          editorialStatus: "unassigned",
        },
      ],
    }),
  );
  const requestStore = new ProductSourcingRequestStore(repository);
  const observedAt = "2026-08-11T12:00:00.000Z";
  const saved = await requestStore.save(
    addProductSourceCandidates(
      createProductSourcingRequest(
        {
          origin: {
            kind: "recommendation-slot",
            guideDraftId: draft.id,
            recommendationSlotId: "slot_editorial-copy",
          },
          intendedRole: "Offer a compact hydration option for demanding workdays.",
          requiredCategory: "Electrolyte tablets or powder",
          audience: "Wildland firefighters",
          occasion: "First season",
          budgetContext: "Under $25",
          mustHaveVerifiedFacts: ["Portable format"],
          exclusions: ["Unsupported medical claims"],
          searchTerms: ["electrolyte tablets"],
        },
        new Date(observedAt),
        "request_editorial-copy",
      ),
      [
        {
          id: "source_candidate_editorial-copy",
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          marketplace: "amazon.com",
          externalId: "B08KBWHZPM",
          sourceUrl: "https://www.amazon.com/dp/B08KBWHZPM/ref=sr_1_1",
          productUrl: "https://www.amazon.com/dp/B08KBWHZPM/",
          name: "Fluid Tactical Effervescent Electrolyte Tablets Variety Pack",
          sourceFacts: [
            "Observed form: effervescent electrolyte tablets",
            "Observed price: $19.99",
            "Observed rating: 4.2 from 497 reviews",
          ],
          query: "electrolyte tablets",
          observedAt,
          observedPrice: "$19.99",
          observedRating: 4.2,
          observedReviewCount: 497,
        },
      ],
      new Date(observedAt),
    ),
  );
  const candidate = saved.sourceCandidates[0]!;
  const beforeProducts = structuredClone(catalog.read().products);
  const beforeRequest = structuredClone(saved);
  const beforeDraft = structuredClone(await draftStore.read(draft.id));
  const providerRequests: StructuredGenerationRequest<unknown>[] = [];
  let providerOutcome: "valid" | "timeout" | "malformed" = "valid";
  const provider: GuideGenerationProvider = {
    providerId: "editorial-copy-fixture",
    async generateStructured<T>(generationRequest: StructuredGenerationRequest<T>): Promise<T> {
      providerRequests.push(generationRequest as StructuredGenerationRequest<unknown>);
      if (providerOutcome === "timeout") {
        throw new ProviderError(
          "El proveedor tardó demasiado en responder. Probá de nuevo.",
          "timeout",
        );
      }
      if (providerOutcome === "malformed") return {} as T;
      return generationRequest.schema.parse({
        shortDescription:
          "Effervescent electrolyte tablets presented as a compact hydration option for long, demanding workdays.",
      });
    },
  };
  let discoveryCalls = 0;
  const discoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    async search() {
      discoveryCalls++;
      return [];
    },
  };
  const server = createStudioServer(
    draftStore,
    catalog,
    provider,
    new Publisher(repository),
    sourceStore,
    undefined,
    [],
    undefined,
    undefined,
    discoverySource,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const reviewPath = `/products/intake?requestId=${saved.id}&candidateId=${candidate.id}`;

  const initialHtml = await (await fetch(`${origin}${reviewPath}`)).text();
  assert.match(initialHtml, /formaction="\/products\/intake\/editorial-copy"/);
  assert.match(initialHtml, /Generar descripción editorial/);
  assert.match(initialHtml, /name="shortDescription" rows="3" required><\/textarea>/);
  assert.equal(providerRequests.length, 0, "opening P.1 must not generate copy");
  assert.equal(discoveryCalls, 0);

  const generationForm = new URLSearchParams({
    returnTo: `/drafts/${draft.id}/curation`,
    requestId: saved.id,
    candidateId: candidate.id,
    productUrl: candidate.productUrl!,
    asin: candidate.externalId!,
    name: candidate.name,
    merchant: "Amazon",
    shortDescription: "Existing editor text submitted through the explicit generation action.",
    sourceFacts: candidate.sourceFacts.join("\n"),
    status: "active",
    discoverySourceKind: "serpapi",
    discoveryProvider: candidate.provider,
    discoveryObservedAt: observedAt,
    discoveryMarketplace: candidate.marketplace!,
    discoveryExternalId: candidate.externalId!,
    discoverySourceUrl: candidate.sourceUrl!,
    confirm: "yes",
    confirmDescription: "yes",
  });
  const generatedResponse = await fetch(`${origin}/products/intake/editorial-copy`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: generationForm,
  });
  assert.equal(generatedResponse.status, 200);
  const generatedHtml = await generatedResponse.text();
  assert.equal(providerRequests.length, 1, "one explicit action makes one AI call");
  assert.equal(providerRequests[0]!.operation, "product-editorial-copy");
  const providerInput = productEditorialCopyPromptInputSchema.parse(providerRequests[0]!.input);
  assert.equal(providerInput.observedProduct.title, candidate.name);
  assert.equal(providerInput.observedProduct.merchant, "Amazon");
  assert.deepEqual(providerInput.observedProduct.sourceFacts, [candidate.sourceFacts[0]]);
  assert.deepEqual(providerInput.editorialContext.origin, saved.origin);
  assert.equal(providerInput.editorialContext.productClass, saved.requiredCategory);
  assert.equal(providerInput.editorialContext.intendedRole, saved.intendedRole);
  assert.equal(providerInput.editorialContext.audience, saved.audience);
  assert.equal(providerInput.editorialContext.occasion, saved.occasion);
  assert.equal(providerInput.editorialContext.budgetContext, saved.budgetContext);
  assert.deepEqual(
    providerInput.editorialContext.mustHaveRequirements,
    saved.mustHaveVerifiedFacts,
  );
  assert.deepEqual(providerInput.editorialContext.exclusions, saved.exclusions);
  assert.match(providerRequests[0]!.prompt, /do not fetch them/i);
  assert.doesNotMatch(providerRequests[0]!.prompt, /\$19\.99|4\.2 from 497 reviews/);
  assert.match(
    generatedHtml,
    /Effervescent electrolyte tablets presented as a compact hydration option/,
  );
  assert.match(generatedHtml, /Borrador generado/);
  assert.doesNotMatch(
    generatedHtml,
    /name="confirmDescription" value="yes" checked/,
    "generation must not preserve or satisfy editorial confirmation",
  );
  assert.match(
    generatedHtml,
    /name="verifiedFacts" rows="4"><\/textarea>/,
    "observed and generated text must not become verified facts",
  );
  assert.equal(discoveryCalls, 0, "copy generation must not run product discovery");
  assert.deepEqual(catalog.read().products, beforeProducts);
  assert.deepEqual(requestStore.get(saved.id), beforeRequest);
  assert.deepEqual(await draftStore.read(draft.id), beforeDraft);
  assert.deepEqual(sourceStore.list(catalog.read().products), []);

  const editedForm = new URLSearchParams(generationForm);
  editedForm.set("shortDescription", "Editor-adjusted copy remains fully editable.");
  editedForm.delete("confirm");
  editedForm.delete("confirmDescription");
  const editedResponse = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: editedForm,
  });
  assert.equal(editedResponse.status, 200);
  assert.match(await editedResponse.text(), /Editor-adjusted copy remains fully editable\./);
  assert.equal(providerRequests.length, 1, "manual editing must not call AI");
  assert.deepEqual(catalog.read().products, beforeProducts);

  providerOutcome = "timeout";
  generationForm.set("shortDescription", "Keep this editor text after a provider failure.");
  const failedResponse = await fetch(`${origin}/products/intake/editorial-copy`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: generationForm,
  });
  assert.equal(failedResponse.status, 502);
  const failedHtml = await failedResponse.text();
  assert.equal(providerRequests.length, 2, "provider failure must not trigger a retry");
  assert.match(failedHtml, /Keep this editor text after a provider failure\./);
  assert.match(failedHtml, /El proveedor tardó demasiado/);
  assert.match(failedHtml, /Generar descripción editorial/);

  providerOutcome = "malformed";
  generationForm.set("shortDescription", "Keep this editor text after malformed output.");
  const malformedResponse = await fetch(`${origin}/products/intake/editorial-copy`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: generationForm,
  });
  assert.equal(malformedResponse.status, 502);
  const malformedHtml = await malformedResponse.text();
  assert.equal(providerRequests.length, 3, "invalid output must not trigger a retry");
  assert.match(malformedHtml, /Keep this editor text after malformed output\./);
  assert.match(malformedHtml, /no cumple el esquema de descripción editorial/);
  assert.equal(discoveryCalls, 0);
  assert.deepEqual(catalog.read().products, beforeProducts);
  assert.deepEqual(requestStore.get(saved.id), beforeRequest);
  assert.deepEqual(await draftStore.read(draft.id), beforeDraft);
});

test("resuelve una URL manual como candidato, usa P.1/P.0 y vuelve al mismo I.2", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-manual-url-resolution-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourceStore = new ProductSourceStore(repository);
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_manual-url-resolution"),
      status: "selecting-products",
      questionnaire: {
        giftCount: 8,
        recipient: "Known recipient",
        occasion: "Known occasion",
        budget: "Known budget",
      },
      recommendations: [
        {
          id: "slot_manual-url-resolution",
          position: 1,
          slotLabel: "Recovery wrap",
          slotIntent: "Support recovery after a long shift.",
          searchTerms: ["recovery", "wrap"],
          editorialStatus: "needs-generation",
        },
      ],
    }),
  );
  const server = createStudioServer(
    draftStore,
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const resolveResponse = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/slot_manual-url-resolution/resolve-url`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        url: "https://merchant.example/items/shift-wrap?b=2&a=1",
      }),
      redirect: "manual",
    },
  );
  assert.equal(resolveResponse.status, 303);
  const reviewLocation = new URL(resolveResponse.headers.get("location")!, origin);
  assert.equal(reviewLocation.pathname, "/products/intake");
  const requestId = reviewLocation.searchParams.get("requestId")!;
  const candidateId = reviewLocation.searchParams.get("candidateId")!;
  const requestStore = new ProductSourcingRequestStore(repository);
  const request = requestStore.get(requestId);
  const candidate = request.sourceCandidates.find(({ id }) => id === candidateId)!;
  assert.equal(request.origin.kind, "recommendation-slot");
  assert.equal(request.audience, "Known recipient");
  assert.equal(request.occasion, "Known occasion");
  assert.equal(candidate.status, "needs-review");
  assert.equal(candidate.canonicalProductId, undefined);
  assert.equal(candidate.productUrl, "https://merchant.example/items/shift-wrap?a=1&b=2");
  assert.equal(
    catalog.read().products.some(({ name }) => name === "Shift recovery wrap"),
    false,
  );

  const reviewHtml = await (
    await fetch(`${origin}${resolveResponse.headers.get("location")!}`)
  ).text();
  assert.match(reviewHtml, /Revision P\.1 del candidato/);
  assert.match(reviewHtml, /name="confirmIdentity"/);
  assert.match(reviewHtml, /name="name" required value="Pasted Manual URL"/);
  assert.match(reviewHtml, /value="https:\/\/merchant\.example\/items\/shift-wrap\?b=2&amp;a=1"/);

  const intakeForm = new URLSearchParams({
    returnTo: `/product-sourcing/${request.id}`,
    requestId: request.id,
    candidateId,
    productUrl: "https://merchant.example/items/shift-wrap?a=1&b=2",
    name: "Shift recovery wrap",
    merchant: "merchant.example",
    shortDescription: "A durable recovery wrap for review.",
    sourceFacts: "Reusable wrap",
    verifiedFacts: "Reusable wrap",
    verifiedFactsConfirmed: "yes",
    status: "active",
  });
  const previewResponse = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: intakeForm,
  });
  assert.equal(previewResponse.status, 200);
  assert.match(await previewResponse.text(), /Vista previa lista/);
  assert.equal(
    catalog.read().products.some(({ name }) => name === "Shift recovery wrap"),
    false,
  );

  for (const name of [
    "confirmIdentity",
    "confirmProvenance",
    "confirmFacts",
    "confirmDescription",
    "confirm",
  ])
    intakeForm.set(name, "yes");
  const commitResponse = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: intakeForm,
    redirect: "manual",
  });
  assert.equal(commitResponse.status, 303);
  const product = catalog.read().products.find(({ name }) => name === "Shift recovery wrap")!;
  const source = sourceStore.forProduct(product.id, catalog.read().products)[0]!;
  const linked = requestStore.get(request.id);
  const linkedCandidate = linked.sourceCandidates.find(({ id }) => id === candidateId)!;
  assert.equal(linkedCandidate.status, "linked-to-product");
  assert.equal(linkedCandidate.canonicalProductId, product.id);
  assert.equal(linkedCandidate.productSourceId, source.id);
  assert.deepEqual(linked.approvedProductIds, []);
  assert.equal(
    guideDraftSchema.parse(await draftStore.read(draft.id)).recommendations[0]!.productId,
    undefined,
  );
});

test("crea, cumple y asigna una solicitud al slot exacto por HTTP", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-sourcing-http-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourceStore = new ProductSourceStore(repository);
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...addManualRecommendation(
        createGuideDraft("guide_sourcing-http"),
        "Insulated tumbler",
        "Keep a nurse hydrated during a long shift.",
        ["insulated", "tumbler"],
        "slot_sourcing-http",
      ),
      questionnaire: {
        giftCount: 8,
        recipient: "Inherited draft audience",
        occasion: "Inherited draft occasion",
        budget: "Inherited draft budget",
        avoid: "Inherited draft exclusion",
      },
      recommendations: [
        {
          id: "slot_sourcing-http",
          position: 1,
          slotLabel: "Insulated tumbler",
          slotIntent: "Keep a nurse hydrated during a long shift.",
          searchTerms: ["insulated", "tumbler"],
          budgetHint: "Inherited slot budget",
          editorialStatus: "unassigned",
        },
      ],
    }),
  );
  const server = createStudioServer(
    draftStore,
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const editorHtml = await (await fetch(`${origin}/drafts/${draft.id}`)).text();
  assert.match(editorHtml, /value="Inherited draft audience"/);
  assert.match(editorHtml, /value="Inherited draft occasion"/);
  assert.match(editorHtml, /value="Inherited slot budget"/);
  assert.match(editorHtml, />Inherited draft exclusion<\/textarea>/);
  assert.match(editorHtml, /value="insulated, tumbler"/);

  const createResponse = await fetch(`${origin}/product-sourcing`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      originKind: "recommendation-slot",
      guideDraftId: draft.id,
      recommendationSlotId: "slot_sourcing-http",
      intendedRole: "Shift hydration",
      requiredCategory: "Insulated tumbler",
      audience: "Working nurses",
      occasion: "Graduation",
      budgetContext: "Under $50",
      exclusions: "Disposable cups",
      searchTerms: "insulated,tumbler",
    }),
    redirect: "manual",
  });
  assert.equal(createResponse.status, 303);
  const location = createResponse.headers.get("location")!;
  assert.match(location, /^\/product-sourcing\/request_/);
  const createdRequest = new ProductSourcingRequestStore(repository).list()[0]!;
  assert.equal(createdRequest.audience, "Working nurses");
  assert.equal(createdRequest.occasion, "Graduation");
  assert.equal(createdRequest.budgetContext, "Under $50");
  assert.deepEqual(createdRequest.exclusions, ["Disposable cups"]);
  assert.deepEqual(createdRequest.searchTerms, ["insulated", "tumbler"]);
  assert.equal(createdRequest.origin.kind, "recommendation-slot");
  assert.equal(createdRequest.origin.guideDraftId, draft.id);
  assert.equal(createdRequest.origin.recommendationSlotId, "slot_sourcing-http");
  const detail = await (await fetch(`${origin}${location}`)).text();
  assert.match(detail, /Abrir el intake manual/);
  assert.match(detail, /product_insulated-tumbler/);

  const fulfillResponse = await fetch(`${origin}${location}/products`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      productId: "product_insulated-tumbler",
      fulfillmentStatus: "fulfilled",
    }),
    redirect: "manual",
  });
  assert.equal(fulfillResponse.status, 303);
  const assignResponse = await fetch(`${origin}${location}/assign`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ productId: "product_insulated-tumbler" }),
    redirect: "manual",
  });
  assert.equal(assignResponse.status, 303);
  assert.equal(
    assignResponse.headers.get("location"),
    `/drafts/${draft.id}#slot-slot_sourcing-http`,
  );
  const assigned = guideDraftSchema.parse(await draftStore.read(draft.id));
  assert.equal(assigned.recommendations[0]!.productId, "product_insulated-tumbler");
  assert.ok(validateGuideDraft(assigned, catalog.read()).errors.length > 0);
});

test("renderiza sólo destinos del catálogo y distingue enlaces afiliados", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-affiliate-build-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const ordinary = catalog.get("product_badge-reel");
  const { affiliateUrl: _ordinaryAffiliateUrl, ...ordinaryWithoutAffiliate } = ordinary;
  await catalog.save({
    ...ordinaryWithoutAffiliate,
    productUrl: "https://merchant.test/badge-reel",
  });
  const amazonAffiliateProduct = catalog.get("product_shift-tote");
  const {
    affiliateUrl: _existingAmazonAffiliateUrl,
    productUrl: _existingAmazonProductUrl,
    ...amazonAffiliateWithoutLinks
  } = amazonAffiliateProduct;
  await catalog.save({
    ...amazonAffiliateWithoutLinks,
    merchant: "Amazon",
    productUrl: "https://www.amazon.com/dp/B012345678",
    affiliateUrl: "https://www.amazon.com/dp/B012345678?tag=thegoodpresent-20",
  });
  const amazonPendingProduct = catalog.get("product_compression-socks");
  const {
    affiliateUrl: _existingPendingAffiliateUrl,
    productUrl: _existingPendingProductUrl,
    ...amazonPendingWithoutLinks
  } = amazonPendingProduct;
  await catalog.save({
    ...amazonPendingWithoutLinks,
    merchant: "Amazon",
    productUrl: "https://www.amazon.com/dp/C012345678",
  });
  const unavailable = catalog.get("product_sleep-mask");
  const {
    affiliateUrl: _unavailableAffiliateUrl,
    productUrl: _unavailableProductUrl,
    ...unavailableWithoutLinks
  } = unavailable;
  await catalog.save(unavailableWithoutLinks);

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const graduation = await readFile(
    join(REPOSITORY_ROOT, "apps", "site", "dist", "nurse-gifts", "graduation", "index.html"),
    "utf8",
  );
  const practical = await readFile(
    join(REPOSITORY_ROOT, "apps", "site", "dist", "nurse-gifts", "practical", "index.html"),
    "utf8",
  );
  const card = (html: string, productName: string): string => {
    const nameIndex = html.lastIndexOf(productName);
    assert.ok(nameIndex >= 0, `Missing ${productName}`);
    const start = html.lastIndexOf("<article", nameIndex);
    const end = html.indexOf("</article>", nameIndex);
    assert.ok(start >= 0 && end >= 0);
    return html.slice(start, end + "</article>".length);
  };

  const affiliateCard = card(graduation, "Local Coffee Shop Gift Card");
  assert.match(affiliateCard, /href="https:\/\/example\.com\/gifts\/coffee-shop-card"/);
  assert.match(affiliateCard, /target="_blank"/);
  assert.match(affiliateCard, /rel="sponsored nofollow noopener"/);

  const ordinaryCard = card(graduation, "Low-Profile Badge Reel");
  assert.match(ordinaryCard, /href="https:\/\/merchant\.test\/badge-reel"/);
  assert.match(ordinaryCard, /View product at/);
  assert.match(ordinaryCard, /rel="nofollow noopener"/);
  assert.doesNotMatch(ordinaryCard, /sponsored/);

  const amazonAffiliateCard = card(graduation, "Structured Shift Tote");
  assert.match(
    amazonAffiliateCard,
    /href="https:\/\/www\.amazon\.com\/dp\/B012345678\?tag=thegoodpresent-20"/,
  );
  assert.match(amazonAffiliateCard, /rel="sponsored nofollow noopener"/);

  const amazonPendingCard = card(practical, "Everyday Compression Socks");
  assert.doesNotMatch(amazonPendingCard, /href=/);
  assert.match(amazonPendingCard, /Why it fits/);

  const unavailableCard = card(practical, "Blackout Sleep Mask");
  assert.doesNotMatch(unavailableCard, /href=/);

  const staticFiles = await readdir(join(REPOSITORY_ROOT, "apps", "site", "dist"), {
    recursive: true,
  });
  const staticHtml = (
    await Promise.all(
      staticFiles
        .filter((file) => file.endsWith(".html"))
        .map((file) => readFile(join(REPOSITORY_ROOT, "apps", "site", "dist", file), "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(staticHtml, /amazon-associates|storeOrAssociateId|allowedTrackingIds/);
});

test("quitar un afiliado Amazon conserva la identidad del Product y la recomendación", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-amazon-identity-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });

  const catalog = new ProductCatalog(repository);
  const original = catalog.get("product_compression-socks");
  const {
    affiliateUrl: _originalAffiliateUrl,
    productUrl: _originalProductUrl,
    ...withoutLinks
  } = original;
  await catalog.save({
    ...withoutLinks,
    merchant: "Amazon",
    productUrl: "https://www.amazon.com/dp/E012345678",
    affiliateUrl: "https://www.amazon.com/dp/E012345678?tag=thegoodpresent-20",
  });

  const before = catalog.read();
  const beforeGuide = before.guides.find((guide) => guide.id === "guide_nurse-practical")!;
  const beforeRecommendation = beforeGuide.recommendations.find(
    ({ productId }) => productId === original.id,
  );
  assert.ok(beforeRecommendation);

  const withAffiliate = catalog.get(original.id);
  const { affiliateUrl: _removedAffiliateUrl, ...withoutAffiliate } = withAffiliate;
  await catalog.save(withoutAffiliate);

  const after = catalog.read();
  const afterProduct = after.products.find(({ id }) => id === original.id);
  const afterGuide = after.guides.find((guide) => guide.id === "guide_nurse-practical")!;
  const afterRecommendation = afterGuide.recommendations.find(
    ({ id }) => id === beforeRecommendation.id,
  );
  assert.ok(afterProduct);
  assert.equal(afterProduct.id, original.id);
  assert.equal(productDestination(afterProduct), undefined);
  assert.equal(afterRecommendation?.productId, original.id);
});

test("renderiza disclosure en guías con afiliados y lo omite sin enlaces afiliados", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-disclosure-build-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  for (const productId of [
    "product_pocket-notebook",
    "product_badge-reel",
    "product_hand-cream",
    "product_compression-socks",
    "product_sleep-mask",
    "product_coffee-card",
  ]) {
    const product = catalog.get(productId);
    const { affiliateUrl: _affiliateUrl, ...ordinaryProduct } = product;
    await catalog.save({
      ...ordinaryProduct,
      productUrl: `https://merchant.test/${productId}`,
    });
  }

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const graduation = await readFile(
    join(REPOSITORY_ROOT, "apps", "site", "dist", "nurse-gifts", "graduation", "index.html"),
    "utf8",
  );
  const under25 = await readFile(
    join(REPOSITORY_ROOT, "apps", "site", "dist", "nurse-gifts", "under-25", "index.html"),
    "utf8",
  );
  assert.match(graduation, /guide-disclosure/);
  assert.doesNotMatch(under25, /guide-disclosure/);
});

test("reabre un hub publicado conservando identidad y ruta", () => {
  const content = new ProductCatalog().read();
  const published = nurseCluster(content);
  const draft = reopenClusterDraft(published, new Date("2026-08-08T12:00:00.000Z"));
  const validation = validateClusterDraft(draft, content);

  assert.equal(draft.id, published.id);
  assert.equal(draft.slug, published.slug);
  assert.deepEqual(draft.navigationGroups, published.navigationGroups);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.route, "/nurse-gifts/");
});

test("valida slugs reservados y grupos de navegación canónicos", () => {
  const content = new ProductCatalog().read();
  const draft = reopenClusterDraft(nurseCluster(content));
  const firstGroup = draft.navigationGroups[0]!;
  const broken = {
    ...draft,
    slug: "about",
    navigationGroups: [
      { ...firstGroup, guideIds: [firstGroup.guideIds[0]!, firstGroup.guideIds[0]!] },
      { ...firstGroup },
    ],
  };
  const validation = validateClusterDraft(broken, content);

  assert.ok(validation.errors.some((error) => error.includes("reserved public path")));
  assert.ok(validation.errors.some((error) => error.includes("ID de grupo")));
  assert.ok(validation.errors.some((error) => error.includes("duplicada en el grupo")));
});

test("agrega, ordena y quita sólo hijos publicados del cluster", () => {
  const content = new ProductCatalog().read();
  const source = reopenClusterDraft(nurseCluster(content));
  const groupId = source.navigationGroups[0]!.id;
  const empty = {
    ...source,
    navigationGroups: [{ ...source.navigationGroups[0]!, guideIds: [] }],
  };
  const nurseGuides = content.guides.filter(({ clusterId }) => clusterId === source.id);
  const firstId = nurseGuides[0]!.id;
  const secondId = nurseGuides[1]!.id;
  const withFirst = addGuideToGroup(empty, groupId, firstId, content);
  const withSecond = addGuideToGroup(withFirst, groupId, secondId, content);
  const moved = moveGuideInGroup(withSecond, groupId, secondId, -1);
  const removed = removeGuideFromGroup(moved, groupId, secondId);

  assert.deepEqual(moved.navigationGroups[0]!.guideIds, [secondId, firstId]);
  assert.deepEqual(removed.navigationGroups[0]!.guideIds, [firstId]);
  assert.throws(() => addGuideToGroup(withFirst, groupId, firstId, content), /ya está incluida/);
  assert.throws(
    () => addGuideToGroup({ ...empty, id: "cluster_other" }, groupId, firstId, content),
    /pertenezcan a este cluster/,
  );
});

test("reabre, previsualiza y valida un hub por HTTP", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-cluster-http-"));
  const store = new DraftStore(directory);
  const server = createStudioServer(store);
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const reopenResponse = await fetch(`${origin}/drafts/reopen/cluster/cluster_nurse-gifts`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "",
    redirect: "manual",
  });
  assert.equal(reopenResponse.status, 303);
  assert.equal(reopenResponse.headers.get("location"), "/drafts/cluster_nurse-gifts");

  const editorResponse = await fetch(`${origin}/drafts/cluster_nurse-gifts`);
  assert.match(await editorResponse.text(), /Navegación curada/);
  const previewResponse = await fetch(`${origin}/drafts/cluster_nurse-gifts/preview`);
  const previewHtml = await previewResponse.text();
  assert.match(previewHtml, /Ruta canónica: <code>\/nurse-gifts\/<\/code>/);
  assert.match(previewHtml, /Metadata de publicación/);
  const validationResponse = await fetch(`${origin}/drafts/cluster_nurse-gifts/validate`);
  assert.match(await validationResponse.text(), /listo para la publicación/);
  assert.equal((await store.read("cluster_nurse-gifts")).status, "ready-to-publish");
});

test("normaliza respuestas opcionales y aplica el valor predeterminado", () => {
  assert.deepEqual(normalizeQuestionnaire({ recipient: "  ", giftCount: "" }), {
    giftCount: DEFAULT_GIFT_COUNT,
  });
  assert.deepEqual(
    normalizeQuestionnaire({
      recipient: "  night-shift nurses  ",
      interests: "  reading and travel ",
      giftCount: "12",
    }),
    {
      recipient: "night-shift nurses",
      interests: "reading and travel",
      giftCount: 12,
    },
  );
  assert.throws(() => normalizeQuestionnaire({ giftCount: "2" }));
  assert.throws(() => normalizeQuestionnaire({ giftCount: "21" }));
  assert.throws(() => normalizeQuestionnaire({ giftCount: "4.5" }));
});

test("construye un prompt de esquema determinista y sin selección comercial", () => {
  const content = new ProductCatalog().read();
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_outline"),
    clusterId: content.clusters[0]!.id,
    primaryAxis: "budget",
    primaryIntent: "Help a friend choose a thoughtful nurse gift under $50.",
    taxonomies: { recipients: ["nurses"], budgetLabels: ["under $50"] },
    budgetContext: { currency: "USD", label: "Under $50", maximum: 50 },
    questionnaire: normalizeQuestionnaire({ recipient: "a nurse friend", giftCount: "4" }),
  });
  const first = prepareOutlinePrompt(draft, content);
  const second = prepareOutlinePrompt(draft, content);

  assert.equal(first.prompt, second.prompt);
  assert.equal(first.version, "outline-v2");
  assert.match(first.prompt, /exactly one JSON object/);
  assert.match(first.prompt, /one concrete, commercially recognizable/);
  assert.match(first.prompt, /broader editorial need or use case in intent/);
  assert.match(first.prompt, /Keep every searchTerm within that one Product class/);
  assert.match(first.prompt, /Maintain useful variety/);
  assert.match(first.prompt, /Do not select or name a commercial product/);
  assert.match(first.prompt, /Do not suggest additional public pages/);
  assert.equal(first.input.requestedRecommendationCount, 4);
  assert.equal(first.input.currency, "USD");
  assert.deepEqual(first.input.slotIds, [
    "guide_outline_slot-1",
    "guide_outline_slot-2",
    "guide_outline_slot-3",
    "guide_outline_slot-4",
  ]);
});

test("exige un concepto concreto por slot y rechaza búsquedas de clases heterogéneas", async () => {
  const classes = [
    "Portable Phone Charger",
    "Travel Umbrella",
    "Recipe Journal",
    "Picnic Blanket",
    "Adjustable Desk Lamp",
    "Plant Mister",
    "Strategy Board Game",
    "Canvas Tool Roll",
  ];
  const valid = guideOutlineSchema.parse({
    provisionalTitle: "Concrete gift guide",
    audienceSummary: "People choosing useful gifts for a friend.",
    editorialAngle: "Each section names a distinct gift while its intent carries the story.",
    recommendationCount: classes.length,
    slots: classes.map((label, index) => ({
      id: `slot-${index + 1}`,
      label,
      intent:
        index === 0
          ? "Makes it easier to stay connected during long days away from an outlet."
          : "Adds a distinct practical option to the broader guide.",
      searchTerms: [
        label.toLocaleLowerCase("en-US"),
        `compact ${label.toLocaleLowerCase("en-US")}`,
        `${label.toLocaleLowerCase("en-US")} for travel`,
        `giftable ${label.toLocaleLowerCase("en-US")}`,
      ],
    })),
  });
  assert.deepEqual(outlineQualityIssues(valid), []);
  assert.equal(new Set(valid.slots.map(({ label }) => label)).size, 8);

  const broad = guideOutlineSchema.parse({
    ...valid,
    slots: valid.slots.map((slot, index) =>
      index === 0
        ? {
            ...slot,
            label: "Rest and sleep support between shifts",
            intent: "Makes recovery easier after demanding overnight work.",
            searchTerms: [
              "blackout sleep mask",
              "white noise machine",
              "cooling pillow",
              "blackout curtains",
              "aromatherapy pillow mist",
            ],
          }
        : slot,
    ),
  });
  assert.equal(guideOutlineSchema.safeParse(broad).success, true);
  assert.deepEqual(outlineQualityIssues(broad), [
    "Slot 1 label must name one concrete gift class.",
    "Slot 1 search terms span unrelated gift classes.",
  ]);

  const content = new ProductCatalog().read();
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_broad-outline"),
    clusterId: content.clusters[0]!.id,
    primaryAxis: "work-context",
    primaryIntent: "Help a friend choose a useful gift after demanding shifts.",
  });
  const provider: GuideGenerationProvider = {
    providerId: "broad-outline-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      assert.equal(request.operation, "outline");
      const input = outlinePromptInputSchema.parse(request.input);
      return {
        ...broad,
        slots: broad.slots.map((slot, index) => ({ ...slot, id: input.slotIds[index]! })),
      } as T;
    },
  };
  await assert.rejects(
    generateGuideOutline(draft, content, provider),
    /label must name one concrete gift class.*search terms span unrelated gift classes/,
  );
});

test("rechaza esquemas truncados, conteos inconsistentes e IDs repetidos", () => {
  const base = {
    provisionalTitle: "Test guide",
    audienceSummary: "Test audience",
    editorialAngle: "Test angle",
    recommendationCount: 3,
    slots: [1, 2, 3].map((position) => ({
      id: `slot-${position}`,
      label: `Slot ${position}`,
      intent: `Intent ${position}`,
      searchTerms: [`term ${position}`],
    })),
  };
  assert.equal(guideOutlineSchema.safeParse(base).success, true);
  assert.equal(guideOutlineSchema.safeParse({ ...base, recommendationCount: 4 }).success, false);
  assert.equal(
    guideOutlineSchema.safeParse({
      ...base,
      slots: [base.slots[0], base.slots[0], base.slots[2]],
    }).success,
    false,
  );
  assert.equal(
    guideOutlineSchema.safeParse({ ...base, slots: base.slots.slice(0, 2) }).success,
    false,
  );
});

test("el mock genera slots validados y guarda metadatos sin productos", async () => {
  const content = new ProductCatalog().read();
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_mock-outline"),
    clusterId: content.clusters[0]!.id,
    primaryAxis: "occasion",
    primaryIntent: "Celebrate a nurse starting a new role.",
    questionnaire: normalizeQuestionnaire({ occasion: "new role", giftCount: "8" }),
  });
  const generated = await generateGuideOutline(
    draft,
    content,
    new MockGuideGenerationProvider(),
    new Date("2026-08-08T15:00:00.000Z"),
  );

  assert.equal(generated.status, "outline-ready");
  assert.equal(generated.outline?.slots.length, 8);
  assert.equal(generated.recommendations.length, 8);
  assert.equal(generated.recommendations[0]!.id, "guide_mock-outline_slot-1");
  assert.equal(new Set(generated.outline!.slots.map(({ label }) => label)).size, 8);
  assert.deepEqual(outlineQualityIssues(generated.outline!), []);
  assert.ok(
    generated.outline!.slots.every(({ label, searchTerms }) =>
      searchTerms.every((term) => term.includes(label.toLocaleLowerCase("en-US"))),
    ),
  );
  const outlineText = generated
    .outline!.slots.flatMap(({ label, searchTerms }) => [label, ...searchTerms])
    .join(" ")
    .toLocaleLowerCase("en-US");
  assert.ok(
    content.products.every(
      (product) =>
        !outlineText.includes(productDisplayName(product).toLocaleLowerCase("en-US")) &&
        (!product.brand || !outlineText.includes(product.brand.toLocaleLowerCase("en-US"))),
    ),
  );
  assert.ok(generated.recommendations.every((slot) => !slot.productId));
  assert.ok(generated.recommendations.every((slot) => slot.editorialStatus === "needs-generation"));
  assert.equal(generated.generationMetadata?.providerId, "mock");
  assert.equal(generated.generationMetadata?.validation.success, true);
  assert.match(generated.generationMetadata?.prompt ?? "", /Structured input/);
});

test("valida de nuevo la salida aunque el proveedor viole su contrato", async () => {
  const content = new ProductCatalog().read();
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_bad-provider"),
    clusterId: content.clusters[0]!.id,
    primaryAxis: "general",
    primaryIntent: "Choose a useful nurse gift.",
  });
  const invalidProvider: GuideGenerationProvider = {
    providerId: "invalid-test",
    async generateStructured<T>() {
      return { prose: "not the expected shape" } as T;
    },
  };

  await assert.rejects(generateGuideOutline(draft, content, invalidProvider));
});

test("rechaza IDs de recomendación elegidos por el proveedor", async () => {
  const content = new ProductCatalog().read();
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_provider-identity"),
    clusterId: content.clusters[0]!.id,
    primaryAxis: "general",
    primaryIntent: "Choose a useful nurse gift.",
    questionnaire: normalizeQuestionnaire({ giftCount: "3" }),
  });
  const mock = new MockGuideGenerationProvider();
  const provider: GuideGenerationProvider = {
    providerId: "identity-test",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      const generated = await mock.generateStructured(request);
      const changed = structuredClone(generated as { slots: Array<{ id: string }> });
      changed.slots[0]!.id = "provider_owned-id";
      return changed as T;
    },
  };

  await assert.rejects(
    generateGuideOutline(draft, content, provider),
    /IDs estables asignados por el Studio/,
  );
});

test("muestra el prompt antes de generar un esquema mock por HTTP", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-outline-http-"));
  const store = new DraftStore(directory);
  const content = new ProductCatalog().read();
  await store.save(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_http-outline"),
      clusterId: content.clusters[0]!.id,
      slug: "http-outline",
      primaryAxis: "recipient",
      primaryIntent: "Help a friend choose a useful gift for a nurse.",
      questionnaire: normalizeQuestionnaire({ giftCount: "3" }),
    }),
  );
  const server = createStudioServer(store);
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const editor = await fetch(`${origin}/drafts/guide_http-outline`);
  const editorHtml = await editor.text();
  assert.match(editorHtml, /Cuestionario opcional/);
  assert.match(editorHtml, /min="3" max="20"/);
  const prompt = await fetch(`${origin}/drafts/guide_http-outline/outline-prompt`);
  assert.match(await prompt.text(), /Revisar prompt de esquema/);

  const blocked = await fetch(`${origin}/drafts/guide_http-outline/outline/generate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ promptVersion: "outline-v1" }),
  });
  assert.equal(blocked.status, 400);

  const generated = await fetch(`${origin}/drafts/guide_http-outline/outline/generate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ promptVersion: OUTLINE_PROMPT_VERSION }),
    redirect: "manual",
  });
  assert.equal(generated.status, 303);
  const saved = await store.read("guide_http-outline");
  assert.equal(saved.draftType, "gift-guide");
  assert.equal(saved.outline?.slots.length, 3);

  const edited = await store.save(
    updateRecommendationEditorialCopy(
      saved,
      saved.recommendations[0]!.id,
      {
        editorialDescription: "Manual copy that must survive.",
        whyItFits: "It reflects an accepted editorial choice.",
      },
      true,
    ),
  );
  const regenerationPrompt = await fetch(`${origin}/drafts/guide_http-outline/outline-prompt`);
  const regenerationHtml = await regenerationPrompt.text();
  assert.match(regenerationHtml, /reemplazaría recomendaciones con trabajo editorial o comercial/);
  assert.match(regenerationHtml, /<button type="submit" disabled>/);

  const rejectedRegeneration = await fetch(`${origin}/drafts/guide_http-outline/outline/generate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ promptVersion: OUTLINE_PROMPT_VERSION }),
  });
  assert.equal(rejectedRegeneration.status, 400);
  assert.match(await rejectedRegeneration.text(), /evitar perder cambios/);
  assert.deepEqual(
    guideDraftSchema.parse(await store.read(edited.id)).recommendations,
    edited.recommendations,
  );
});

test("sugiere productos activos con coincidencia textual determinista", () => {
  const content = new ProductCatalog().read();
  const suggestions = suggestProductsForSlot(content.products, {
    slotLabel: "Insulated nurse drinkware",
    slotIntent: "A reusable tumbler for long shifts",
    searchTerms: ["insulated tumbler", "nurse drinkware"],
  });

  assert.equal(suggestions[0]?.id, "product_insulated-tumbler");
  assert.ok(suggestions.every((product) => product.status === "active"));
  assert.deepEqual(
    suggestions,
    suggestProductsForSlot(content.products, {
      slotLabel: "Insulated nurse drinkware",
      slotIntent: "A reusable tumbler for long shifts",
      searchTerms: ["insulated tumbler", "nurse drinkware"],
    }),
  );
});

test("seleccionar y reemplazar conserva la identidad editorial del slot", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_replace-product");
  const slot = draft.recommendations[0]!;
  const firstProduct = content.products.find(
    ({ id, status }) =>
      status === "active" &&
      content.guides.some((guide) =>
        guide.recommendations.some(({ productId }) => productId === id),
      ),
  );
  assert.ok(firstProduct);
  const secondProduct = content.products.find(
    ({ id, status }) => status === "active" && id !== firstProduct.id,
  );
  assert.ok(secondProduct);
  const selected = selectRecommendationProduct(draft, slot.id, firstProduct.id, content);
  const withCopy = guideDraftSchema.parse({
    ...selected,
    recommendations: selected.recommendations.map((recommendation) =>
      recommendation.id === slot.id
        ? {
            ...recommendation,
            heading: "Existing heading",
            editorialDescription: "Existing description",
            whyItFits: "Existing rationale",
          }
        : recommendation,
    ),
  });
  const replaced = selectRecommendationProduct(withCopy, slot.id, secondProduct.id, content);
  const result = replaced.recommendations.find((recommendation) => recommendation.id === slot.id)!;

  assert.equal(selected.recommendations[0]!.editorialStatus, "needs-generation");
  assert.equal(result.id, slot.id);
  assert.equal(result.position, slot.position);
  assert.equal(result.slotLabel, slot.slotLabel);
  assert.equal(result.slotIntent, slot.slotIntent);
  assert.equal(result.productId, secondProduct.id);
  assert.equal(result.heading, "Existing heading");
  assert.equal(result.editorialDescription, "Existing description");
  assert.equal(result.editorialStatus, "needs-review");
  assert.ok(content.products.some((product) => product.id === firstProduct.id));
  assert.ok(
    content.guides.some((guide) =>
      guide.recommendations.some((recommendation) => recommendation.productId === firstProduct.id),
    ),
  );
});

test("bloquea duplicados accidentales y admite confirmación explícita", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_duplicate-product");
  const productId = content.products[0]!.id;
  const first = selectRecommendationProduct(
    draft,
    draft.recommendations[0]!.id,
    productId,
    content,
  );

  assert.throws(
    () => selectRecommendationProduct(first, first.recommendations[1]!.id, productId, content),
    /Confirmá explícitamente/,
  );
  const confirmed = selectRecommendationProduct(
    first,
    first.recommendations[1]!.id,
    productId,
    content,
    true,
  );
  assert.deepEqual(duplicateProductIds(confirmed), [productId]);
  const cleared = clearRecommendationProduct(confirmed, confirmed.recommendations[1]!.id);
  assert.equal(cleared.recommendations[1]!.productId, undefined);
  assert.equal(cleared.recommendations[1]!.editorialStatus, "needs-generation");
});

test("mueve, elimina y agrega slots sin cambiar IDs sobrevivientes", async () => {
  const draft = await generatedGuideDraft("guide_slot-order");
  const firstId = draft.recommendations[0]!.id;
  const thirdId = draft.recommendations[2]!.id;
  const moved = moveRecommendation(draft, thirdId, -1);
  const added = addManualRecommendation(
    moved,
    "Manual comfort slot",
    "A manually curated purpose",
    ["comfort gift"],
    "slot_manual",
  );
  const removed = removeRecommendation(added, firstId);

  assert.equal(moved.recommendations[1]!.id, thirdId);
  assert.equal(added.recommendations.at(-1)!.id, "slot_manual");
  assert.deepEqual(
    removed.recommendations.map((recommendation) => recommendation.position),
    [1, 2, 3],
  );
  assert.ok(removed.recommendations.some((recommendation) => recommendation.id === thirdId));
});

test("regenera normalmente un esquema que todavía no tiene trabajo editorial", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_fresh-outline", 4);
  let calls = 0;
  const mock = new MockGuideGenerationProvider();
  const provider: GuideGenerationProvider = {
    providerId: "fresh-outline-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      calls++;
      return mock.generateStructured(request);
    },
  };
  const regenerated = await generateGuideOutline(
    guideDraftSchema.parse({
      ...draft,
      questionnaire: { ...draft.questionnaire, giftCount: 3 },
    }),
    content,
    provider,
  );

  assert.equal(calls, 1);
  assert.equal(regenerated.recommendations.length, 3);
  assert.ok(
    regenerated.recommendations.every(
      ({ editorialStatus }) => editorialStatus === "needs-generation",
    ),
  );
});

test("bloquea reducir el esquema si eliminaría una recomendación editada", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_edited-outline", 4);
  const editedId = draft.recommendations[3]!.id;
  const generated = await generateIdeaOnlyRecommendation(
    draft,
    editedId,
    content,
    new MockGuideGenerationProvider(),
  );
  const edited = guideDraftSchema.parse({
    ...updateRecommendationEditorialCopy(
      generated,
      editedId,
      {
        editorialDescription: "Accepted copy for the fourth recommendation.",
        whyItFits: "It preserves a deliberate editorial choice.",
      },
      true,
    ),
    questionnaire: { ...draft.questionnaire, giftCount: 3 },
  });
  let providerCalls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "blocked-outline-fixture",
    async generateStructured<T>(): Promise<T> {
      providerCalls++;
      throw new Error("The provider must not be called for destructive regeneration.");
    },
  };

  await assert.rejects(
    generateGuideOutline(edited, content, provider),
    /reemplazaría recomendaciones con trabajo editorial o comercial/,
  );
  assert.equal(providerCalls, 0);
  assert.equal(edited.recommendations.find(({ id }) => id === editedId)!.editorialStatus, "ready");
});

test("bloquea regenerar el esquema cuando existe un enlace afiliado directo", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_monetized-outline");
  const monetized = updateRecommendationDirectAffiliateUrl(
    draft,
    draft.recommendations[0]!.id,
    "https://www.amazon.com/dp/B0ABCDEF12?tag=outline-20",
  );

  await assert.rejects(
    generateGuideOutline(monetized, content, new MockGuideGenerationProvider()),
    /reemplazaría recomendaciones con trabajo editorial o comercial/,
  );
});

test("bloquea regenerar el esquema después de seleccionar productos", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_locked-outline");
  const selected = selectRecommendationProduct(
    draft,
    draft.recommendations[0]!.id,
    content.products[0]!.id,
    content,
  );
  await assert.rejects(
    generateGuideOutline(selected, content, new MockGuideGenerationProvider()),
    /reemplazaría recomendaciones con trabajo editorial o comercial/,
  );
});

test("selecciona, reemplaza y vuelve desde alta de producto por HTTP", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-selection-http-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const store = new DraftStore(join(repository, "drafts"));
  const catalog = new ProductCatalog(repository);
  const draft = await generatedGuideDraft("guide_http-selection");
  await store.save(draft);
  const server = createStudioServer(store, catalog);
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(repository, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const firstSlot = draft.recommendations[0]!.id;
  const secondSlot = draft.recommendations[1]!.id;
  const firstProduct = catalog.read().products[0]!;
  const secondProduct = catalog.read().products[1]!;

  const search = await fetch(`${origin}/drafts/${draft.id}?slot=${firstSlot}&productQ=tumbler`);
  const searchHtml = await search.text();
  assert.match(searchHtml, /Resultados del catálogo/);
  assert.match(searchHtml, /Crear un producto nuevo y volver/);

  const selected = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/${firstSlot}/product`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ productId: firstProduct.id }),
      redirect: "manual",
    },
  );
  assert.equal(selected.status, 303);

  const duplicateBlocked = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/${secondSlot}/product`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ productId: firstProduct.id }),
    },
  );
  assert.equal(duplicateBlocked.status, 400);
  const duplicateAllowed = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/${secondSlot}/product`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ productId: firstProduct.id, allowDuplicate: "yes" }),
      redirect: "manual",
    },
  );
  assert.equal(duplicateAllowed.status, 303);

  await fetch(`${origin}/drafts/${draft.id}/recommendations/${firstSlot}/product`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ productId: secondProduct.id }),
    redirect: "manual",
  });
  const replaced = await store.read(draft.id);
  assert.equal(replaced.draftType, "gift-guide");
  assert.equal(replaced.recommendations[0]!.editorialStatus, "needs-review");
  assert.match(await (await fetch(`${origin}/drafts/${draft.id}`)).text(), /Revisión obligatoria/);

  const newProductPage = await fetch(
    `${origin}/products/new?returnTo=${encodeURIComponent(`/drafts/${draft.id}`)}`,
  );
  assert.match(await newProductPage.text(), /name="returnTo"/);
  const returnResponse = await fetch(`${origin}/products`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      returnTo: `/drafts/${draft.id}`,
      name: "Draft-local catalog addition",
      merchant: "Test merchant",
      shortDescription: "Created without losing the guide draft.",
      status: "inactive",
    }),
    redirect: "manual",
  });
  assert.equal(returnResponse.headers.get("location"), `/drafts/${draft.id}`);
});

test("el prompt final contiene sólo datos seleccionados y ninguna URL", async () => {
  const content = new ProductCatalog().read();
  const draft = await selectedGuideDraft("guide_final-prompt");
  const first = prepareFinalPrompt(draft, content);
  const second = prepareFinalPrompt(draft, content);

  assert.equal(first.prompt, second.prompt);
  assert.equal(first.input.recommendations.length, draft.recommendations.length);
  assert.deepEqual(
    first.input.recommendations.map((recommendation) => recommendation.product.id),
    draft.recommendations.map((recommendation) => recommendation.productId),
  );
  assert.doesNotMatch(first.prompt, /https?:\/\//i);
  assert.doesNotMatch(first.prompt, /affiliateUrl/);
  assert.match(first.prompt, new RegExp(productDisplayName(content.products[0]!)));
  assert.match(first.prompt, /Return exactly one JSON object/);
  for (const recommendation of first.input.recommendations) {
    assert.deepEqual(
      Object.keys(recommendation.product).sort(),
      ["id", "name", ...(recommendation.product.verifiedFacts ? ["verifiedFacts"] : [])].sort(),
    );
    assert.equal("merchant" in recommendation.product, false);
    assert.equal("shortDescription" in recommendation.product, false);
    assert.equal("priceLabel" in recommendation.product, false);
  }
});

test("el mock genera una guía completa lista con IDs y orden intactos", async () => {
  const content = new ProductCatalog().read();
  const draft = await selectedGuideDraft("guide_final-mock");
  const generated = await generateFinalGuide(
    draft,
    content,
    new MockGuideGenerationProvider(),
    new Date("2026-08-08T18:00:00.000Z"),
  );

  assert.ok(generated.title);
  assert.ok(generated.excerpt);
  assert.ok(generated.introduction);
  assert.ok(generated.seoTitle);
  assert.ok(generated.seoDescription);
  assert.deepEqual(
    generated.recommendations.map(({ id, productId, position }) => ({ id, productId, position })),
    draft.recommendations.map(({ id, productId, position }) => ({ id, productId, position })),
  );
  assert.ok(
    generated.recommendations.every((recommendation) => recommendation.editorialStatus === "ready"),
  );
  assert.equal(generated.generationMetadata?.promptVersion, "final-guide-v4");
  assert.deepEqual(validateGuideDraft(generated, content).errors, []);
});

test("rechaza respuestas finales que cambian identidad o agregan URLs", async () => {
  const content = new ProductCatalog().read();
  const draft = await selectedGuideDraft("guide_adversarial-final");
  const mock = new MockGuideGenerationProvider();
  const changedIdentity: GuideGenerationProvider = {
    providerId: "changed-identity",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      const response = await mock.generateStructured(request);
      if (request.operation !== "final-guide") return response;
      const changed = structuredClone(response as { recommendations: Array<{ id: string }> });
      changed.recommendations[0]!.id = "slot-unselected";
      return changed as T;
    },
  };
  const injectedAffiliateField: GuideGenerationProvider = {
    providerId: "affiliate-field-injection",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      const response = await mock.generateStructured(request);
      if (request.operation !== "final-guide") return response;
      const changed = structuredClone(
        response as { recommendations: Array<Record<string, unknown>> },
      );
      changed.recommendations[0]!.affiliateUrl = "https://example.com/attacker";
      return changed as T;
    },
  };
  const injectedUrl: GuideGenerationProvider = {
    providerId: "url-injection",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      const response = await mock.generateStructured(request);
      if (request.operation !== "final-guide") return response;
      const changed = structuredClone(
        response as { recommendations: Array<{ editorialDescription: string }> },
      );
      changed.recommendations[0]!.editorialDescription = "See https://example.com/unsafe";
      return changed as T;
    },
  };

  await assert.rejects(generateFinalGuide(draft, content, changedIdentity), /cambió IDs/);
  await assert.rejects(generateFinalGuide(draft, content, injectedUrl), /no puede contener URLs/);
  await assert.rejects(generateFinalGuide(draft, content, injectedAffiliateField));
});

test("regenera sólo el slot reemplazado y lo devuelve a ready", async () => {
  const content = new ProductCatalog().read();
  const complete = await generateFinalGuide(
    await selectedGuideDraft("guide_single-regeneration"),
    content,
    new MockGuideGenerationProvider(),
  );
  const target = complete.recommendations[0]!;
  const replacement = content.products[3]!;
  const replaced = selectRecommendationProduct(complete, target.id, replacement.id, content);
  const untouched = structuredClone(replaced.recommendations[1]);
  const prepared = prepareRecommendationPrompt(replaced, target.id, content);
  const regenerated = await regenerateRecommendation(
    replaced,
    target.id,
    content,
    new MockGuideGenerationProvider(),
  );
  const result = regenerated.recommendations[0]!;

  assert.equal(prepared.input.recommendation.product.id, replacement.id);
  assert.doesNotMatch(prepared.prompt, /https?:\/\//i);
  assert.equal(result.id, target.id);
  assert.equal(result.position, target.position);
  assert.equal(result.productId, replacement.id);
  assert.equal(result.editorialStatus, "ready");
  assert.deepEqual(regenerated.recommendations[1], untouched);
  assert.equal(regenerated.generationMetadata?.promptVersion, "single-recommendation-v4");
});

test("la edición manual sólo marca ready con copia mínima completa", async () => {
  const content = new ProductCatalog().read();
  const draft = await selectedGuideDraft("guide_manual-ready");
  const slotId = draft.recommendations[0]!.id;

  assert.throws(
    () => updateRecommendationEditorialCopy(draft, slotId, { heading: "Only a heading" }, true),
    /se requieren descripción editorial y motivo/,
  );
  const ready = updateRecommendationEditorialCopy(
    draft,
    slotId,
    {
      heading: "Manual heading",
      editorialDescription: "Manual editorial description grounded in the selected product.",
      whyItFits: "It serves the stable slot purpose.",
    },
    true,
  );
  assert.equal(ready.recommendations[0]!.editorialStatus, "ready");
  assert.equal(ready.recommendations[0]!.editorialPromptVersion, MANUAL_EDITORIAL_COPY_VERSION);
  assert.ok(
    validateGuideDraft(ready, content).errors.some((error) => error.includes("no está listo")),
  );
});

test("separa la preparación editorial de la resolución de Product sin cambiar el slot estable", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_unresolved-ready");
  const slot = draft.recommendations[0]!;
  const readyIdea = updateRecommendationEditorialCopy(
    draft,
    slot.id,
    {
      heading: "A recovery ritual shaped around their routine",
      editorialDescription: "Choose a format that matches how they prefer to unwind at home.",
      whyItFits: "The idea is useful before a particular Product has been selected.",
      considerations: "Look for easy care and a size that suits their space.",
    },
    true,
  );
  const unresolved = readyIdea.recommendations[0]!;
  assert.equal(unresolved.id, slot.id);
  assert.equal(unresolved.productId, undefined);
  assert.equal(unresolved.editorialStatus, "ready");
  assert.deepEqual(guideDraftReadiness(readyIdea), {
    recommendationCount: readyIdea.recommendations.length,
    editorialReadyCount: 1,
    productResolvedCount: 0,
    productPendingCount: readyIdea.recommendations.length,
    editorialComplete: false,
    productComplete: false,
  });

  const resolved = selectRecommendationProduct(
    readyIdea,
    slot.id,
    content.products[0]!.id,
    content,
  );
  assert.equal(resolved.recommendations[0]!.id, slot.id);
  assert.equal(resolved.recommendations[0]!.productId, content.products[0]!.id);
  assert.equal(resolved.recommendations[0]!.editorialStatus, "needs-review");
  assert.throws(() => prepareFinalPrompt(readyIdea, content), /no tiene producto/);
});

test("selecciona slots de resolución pendientes y resume el progreso sin mezclar estados", () => {
  const content = new ProductCatalog().read();
  const product = content.products[0]!;
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_wide-selection"),
    recommendations: [
      {
        id: "slot_resolved-ready",
        position: 1,
        slotLabel: "Resolved gift",
        productId: product.id,
        editorialDescription: "Reviewed Product copy.",
        whyItFits: "It fits the resolved slot.",
        editorialStatus: "ready",
      },
      {
        id: "slot_unresolved-review",
        position: 2,
        slotLabel: "Insulated tumbler",
        editorialStatus: "needs-generation",
      },
      {
        id: "slot_unresolved-ready",
        position: 3,
        slotLabel: "Recovery ritual",
        editorialDescription: "Choose a format that suits their routine.",
        whyItFits: "It remains useful without a specific Product.",
        selectionGuidance: "Compare care, comfort, and ease of use.",
        editorialStatus: "ready",
      },
    ],
  });
  const request = addProductSourceCandidates(
    createProductSourcingRequestForDraftSlot(
      draft,
      draft.recommendations[1]!,
      undefined,
      new Date("2026-08-11T12:00:00.000Z"),
      "request_wide-selection",
    ),
    [
      {
        sourceKind: "manual",
        provider: "Observed source",
        name: "Candidate needing review",
        sourceFacts: [],
      },
    ],
  );

  assert.deepEqual(
    selectGuideWideResolutionSlots(draft).map(({ id }) => id),
    ["slot_unresolved-review", "slot_unresolved-ready"],
  );
  assert.deepEqual(
    selectGuideWideResolutionSlots(draft, ["slot_unresolved-ready"]).map(({ id }) => id),
    ["slot_unresolved-ready"],
  );
  assert.deepEqual(
    selectGuideWideResolutionSlots(draft, ["slot_resolved-ready"], true).map(({ id }) => id),
    ["slot_resolved-ready"],
  );
  assert.throws(
    () => selectGuideWideResolutionSlots(draft, ["slot_resolved-ready"]),
    /No unresolved Product slots/,
  );
  const progress = guideCurationProgress(draft, content, [request]);
  assert.equal(progress.totalRecommendations, 3);
  assert.equal(progress.editorialReady, 2);
  assert.equal(progress.editorialPending, 1);
  assert.equal(progress.editorialComplete, false);
  assert.equal(progress.ideaReadyProductUnresolved, 1);
  assert.equal(progress.candidateReview, 1);
  assert.equal(progress.productResolved, 1);
  assert.equal(progress.productPending, 2);
  assert.equal(progress.affiliateReady, Number(Boolean(productDestination(product))));
  assert.equal(progress.affiliateDestinationMissing, Number(!productDestination(product)));
  const editoriallyComplete = guideDraftSchema.parse({
    ...draft,
    recommendations: draft.recommendations.map((slot) =>
      slot.id === "slot_unresolved-review"
        ? {
            ...slot,
            editorialDescription: "A complete generic description.",
            whyItFits: "A complete generic rationale.",
            selectionGuidance: "Compare fit and care.",
            editorialStatus: "ready",
          }
        : slot,
    ),
  });
  const completeProgress = guideCurationProgress(editoriallyComplete, content, [request]);
  assert.equal(completeProgress.editorialComplete, true);
  assert.equal(completeProgress.editorialReady, 3);
  assert.equal(completeProgress.productResolved, 1);
  assert.equal(completeProgress.productPending, 2);
  assert.equal(
    guideCurationNextAction(draft, draft.recommendations[1]!, content, request),
    "use-catalog-product",
  );
  assert.equal(
    guideCurationNextAction(
      draft,
      draft.recommendations[1]!,
      { ...content, products: [] },
      request,
    ),
    "review-candidate",
  );
});

test("cura slots sin resolver en lote, hereda contexto y crea o reutiliza I.2", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-guide-curation-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const content = catalog.read();
  const store = new DraftStore(join(repository, "drafts"));
  const draft = await store.save(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_bulk-curation"),
      clusterId: content.clusters[0]!.id,
      primaryAxis: "recipient",
      primaryIntent: "Choose useful gifts without forcing a Product for every slot.",
      questionnaire: {
        giftCount: 3,
        recipient: "Inherited audience",
        occasion: "Inherited occasion",
        budget: "Inherited budget",
        avoid: "Inherited exclusion",
      },
      recommendations: [
        {
          id: "slot_bulk-resolved",
          position: 1,
          slotLabel: "Resolved slot",
          productId: content.products[0]!.id,
          editorialDescription: "Reviewed copy.",
          whyItFits: "It fits.",
          editorialStatus: "ready",
        },
        {
          id: "slot_bulk-catalog",
          position: 2,
          slotLabel: "Insulated tumbler",
          slotIntent: "Keep drinks secure during a long shift.",
          searchTerms: ["insulated", "tumbler"],
          editorialStatus: "needs-generation",
        },
        {
          id: "slot_bulk-external",
          position: 3,
          slotLabel: "Xylophonic recovery object",
          slotIntent: "Support a quiet recovery routine.",
          searchTerms: ["xylophonic", "recovery"],
          editorialStatus: "needs-generation",
        },
      ],
    }),
  );
  const mock = new MockGuideGenerationProvider();
  let searchPlanCalls = 0;
  const provider: GuideGenerationProvider = {
    providerId: mock.providerId,
    modelId: mock.modelId,
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation === "product-search-plans") searchPlanCalls++;
      return mock.generateStructured(request);
    },
  };
  let discoveryCalls = 0;
  const discoveryModes: string[] = [];
  const discoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["general", "amazon"],
    async search(input) {
      discoveryCalls++;
      discoveryModes.push(input.discoveryMode ?? "general");
      return [
        {
          sourceKind: "serpapi",
          provider: "SerpAPI",
          name: `Observed ${input.query}`,
          sourceUrl: `https://merchant.example/${discoveryCalls}`,
          productUrl: `https://merchant.example/${discoveryCalls}`,
          sourceFacts: ["Observed fixture evidence"],
          query: input.query,
          observedAt: input.observedAt,
        },
      ];
    },
  };
  const server = createStudioServer(
    store,
    catalog,
    provider,
    new Publisher(repository),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    discoverySource,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const initialHtml = await (await fetch(`${origin}/drafts/${draft.id}/curation`)).text();
  assert.match(initialHtml, /Buscar productos para slots sin resolver/);
  assert.match(initialHtml, /Siguiente acción recomendada/);
  assert.match(initialHtml, /IDs y trazabilidad/);
  assert.match(initialHtml, /Pegar URL/);
  assert.match(initialHtml, /Editar guía de selección/);
  assert.match(initialHtml, /DataForSEO sólo existe cuando fue elegido y habilitado/);

  const prepared = await fetch(`${origin}/drafts/${draft.id}/curation/prepare`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(),
    redirect: "manual",
  });
  assert.equal(prepared.status, 303);
  assert.equal(searchPlanCalls, 1);
  assert.equal(discoveryCalls, 0, "preparing or opening the board must not run discovery");
  const sourcingStore = new ProductSourcingRequestStore(repository);
  let requests = sourcingStore.list();
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(
      ({ audience, occasion, budgetContext, exclusions, searchPlan }) =>
        audience === "Inherited audience" &&
        occasion === "Inherited occasion" &&
        budgetContext === "Inherited budget" &&
        exclusions.includes("Inherited exclusion") &&
        Boolean(searchPlan),
    ),
  );
  assert.equal(
    requests.some(
      ({ origin: requestOrigin }) =>
        requestOrigin.kind === "recommendation-slot" &&
        requestOrigin.recommendationSlotId === "slot_bulk-resolved",
    ),
    false,
  );
  const preparedHtml = await (await fetch(`${origin}/drafts/${draft.id}/curation`)).text();
  assert.match(preparedHtml, /Buscar productos/);
  assert.match(preparedHtml, /Buscar en Amazon/);
  assert.match(preparedHtml, /name="discoveryMode" value="general"/);
  assert.match(preparedHtml, /name="discoveryMode" value="amazon"/);
  assert.equal(discoveryCalls, 0, "rendering explicit actions must not call either mode");

  const forcedDiscovery = await fetch(`${origin}/drafts/${draft.id}/curation/discover`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ slotId: "slot_bulk-catalog", forceExternal: "yes" }),
    redirect: "manual",
  });
  assert.equal(forcedDiscovery.status, 303);
  assert.ok(discoveryCalls > 0, "the explicit curation action must override weak catalog reuse");
  assert.ok(discoveryModes.every((mode) => mode === "general"));
  assert.equal(
    findProductSourcingRequestForDraftSlot(sourcingStore.list(), draft.id, "slot_bulk-catalog")!
      .discoveryRounds[0]!.providerCalls,
    discoveryCalls,
  );
  const outcomeHtml = await (await fetch(`${origin}/drafts/${draft.id}/curation`)).text();
  assert.match(
    outcomeHtml,
    /Último descubrimiento:<\/strong> General · \d+ búsquedas? · \d+ candidatos?/,
  );

  const externalRequest = findProductSourcingRequestForDraftSlot(
    requests,
    draft.id,
    "slot_bulk-external",
  )!;
  const externalWithCandidate = addProductSourceCandidates(externalRequest, [
    {
      sourceKind: "serpapi",
      provider: "SerpAPI",
      name: "Observed external candidate",
      sourceUrl: "https://merchant.example/observed",
      sourceFacts: ["Observed description: internal discovery evidence"],
      query: externalRequest.searchPlan!.queries[0]!,
      observedAt: "2026-08-11T12:00:00.000Z",
    },
  ]);
  await sourcingStore.save(
    productSourcingRequestSchema.parse({
      ...externalWithCandidate,
      discoveryRounds: [
        {
          round: 1,
          provider: "serpapi",
          discoveryMode: "amazon",
          status: "empty",
          queries: [externalRequest.searchPlan!.queries[0]!],
          providerCalls: 1,
          storedCandidateCount: 0,
          attemptedAt: "2026-08-11T12:00:00.000Z",
        },
      ],
    }),
  );
  const boardHtml = await (await fetch(`${origin}/drafts/${draft.id}/curation`)).text();
  assert.match(boardHtml, /Último descubrimiento:<\/strong> Amazon · 1 búsqueda · sin resultados/);
  for (const action of [
    "Usar Product existente",
    "Revisar este candidato",
    "Rechazar",
    "Editar plan de búsqueda",
    "Ver evidencia",
  ]) {
    assert.match(boardHtml, new RegExp(action));
  }
  assert.match(boardHtml, /Product class/);
  assert.match(boardHtml, /name="forceExternal" value="yes"/);
  assert.doesNotMatch(boardHtml, /productClassMatch:|negativeCriticalDimensions:/);

  const selected = await fetch(`${origin}/drafts/${draft.id}/curation/use-product`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      slotId: "slot_bulk-catalog",
      productId: "product_insulated-tumbler",
    }),
    redirect: "manual",
  });
  assert.equal(selected.status, 303);
  const resolvedDraft = guideDraftSchema.parse(await store.read(draft.id));
  assert.equal(
    resolvedDraft.recommendations.find(({ id }) => id === "slot_bulk-catalog")!.productId,
    "product_insulated-tumbler",
  );
  requests = sourcingStore.list();
  assert.equal(requests.length, 2);
  assert.equal(
    findProductSourcingRequestForDraftSlot(requests, draft.id, "slot_bulk-catalog")!.status,
    "fulfilled",
  );

  await fetch(`${origin}/drafts/${draft.id}/curation/prepare`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ slotId: "slot_bulk-external" }),
    redirect: "manual",
  });
  assert.equal(sourcingStore.list().length, 2);
  assert.equal(searchPlanCalls, 1);

  await fetch(`${origin}/drafts/${draft.id}/recommendations/slot_bulk-catalog/product/clear`, {
    method: "POST",
    redirect: "manual",
  });
  await fetch(`${origin}/drafts/${draft.id}/curation/prepare`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ slotId: "slot_bulk-catalog" }),
    redirect: "manual",
  });
  const replacementRequest = findProductSourcingRequestForDraftSlot(
    sourcingStore.list(),
    draft.id,
    "slot_bulk-catalog",
  )!;
  assert.equal(replacementRequest.status, "open");
  assert.ok(replacementRequest.searchPlan);
  assert.equal(sourcingStore.list().length, 3);
  assert.equal(searchPlanCalls, 2);
});

test("genera idea-only segura con contexto heredado y deja Stage 2 Product-backed sin cambios", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_safe-idea-only");
  const slot = draft.recommendations[0]!;
  const request = productSourcingRequestSchema.parse({
    ...createProductSourcingRequestForDraftSlot(
      draft,
      slot,
      undefined,
      new Date("2026-08-11T12:00:00.000Z"),
      "request_safe-idea-only",
    ),
    searchPlan: {
      productClass: "Recovery accessory",
      mustHaveAttributes: ["easy care"],
      usefulAttributes: ["comfortable format"],
      exclusions: ["hard-to-clean materials"],
      queries: ["recovery accessory gift"],
      providerId: "mock",
      modelId: "mock-editorial-v1",
      promptVersion: "product-search-plan-v1",
      plannedAt: "2026-08-11T12:00:00.000Z",
    },
  });
  const prepared = prepareIdeaRecommendationPrompt(draft, slot.id, content, request);
  const serializedInput = JSON.stringify(prepared.input);
  assert.doesNotMatch(serializedInput, /merchant|affiliate|productUrl|sourceCandidates/);
  assert.doesNotMatch(
    prepared.prompt,
    new RegExp(
      content.products.map(({ name }) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    ),
  );
  assert.equal(prepared.input.guide.title, draft.title ?? draft.outline?.provisionalTitle);
  assert.equal(prepared.input.guide.audience, draft.outline?.audienceSummary);
  assert.equal(prepared.input.guide.editorialAngle, draft.outline?.editorialAngle);
  assert.equal(prepared.input.recommendation.productClassProfile.classId, "generic");
  assert.ok(prepared.input.recommendation.whatToLookFor.includes("specific use case"));
  assert.doesNotMatch(serializedInput, /easy care|comfortable format|hard-to-clean materials/);

  const generated = await generateIdeaOnlyRecommendation(
    draft,
    slot.id,
    content,
    new MockGuideGenerationProvider(),
    request,
  );
  const idea = generated.recommendations[0]!;
  assert.equal(idea.id, slot.id);
  assert.equal(idea.position, slot.position);
  assert.equal(idea.productId, undefined);
  assert.equal(idea.editorialStatus, "ready");
  assert.ok(idea.bestFor);
  assert.ok(idea.selectionGuidance);
  assert.equal(generated.generationMetadata?.promptVersion, "idea-recommendation-v5");
  assert.throws(() => prepareFinalPrompt(generated, content), /no tiene producto/);

  for (const unsafeCopy of [
    content.products[0]!.name,
    "$29.99",
    "4.8 rating",
    "20 oz",
    "at least 15g protein",
    "around 200 calories",
    "improves comfort by 40%",
  ]) {
    const unsafe: GuideGenerationProvider = {
      providerId: "unsafe-idea",
      async generateStructured<T>(generationRequest: StructuredGenerationRequest<T>): Promise<T> {
        assert.equal(generationRequest.operation, "idea-recommendation");
        return {
          id: slot.id,
          position: slot.position,
          heading: "Generic recovery idea",
          editorialDescription: unsafeCopy,
          whyItFits: "It suits the recipient.",
          bestFor: "Someone whose routine suits the idea.",
          selectionGuidance: "Compare care and comfort.",
        } as T;
      },
    };
    await assert.rejects(
      generateIdeaOnlyRecommendation(draft, slot.id, content, unsafe, request),
      /no puede/,
    );
  }
  assert.throws(() =>
    generatedIdeaRecommendationSchema.parse({
      id: slot.id,
      position: slot.position,
      heading: "Generic idea",
      editorialDescription: "Useful guidance.",
      whyItFits: "It fits.",
      selectionGuidance: "Compare care.",
      productName: "Injected Product",
    }),
  );
});

test("el fallback determinista conserva identidad, Product y metadata comercial", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_safe-fallback-state");
  const selected = selectRecommendationProduct(
    draft,
    draft.recommendations[0]!.id,
    content.products[0]!.id,
    content,
  );
  const enriched = updateRecommendationDirectAffiliateUrl(
    selected,
    selected.recommendations[0]!.id,
    "https://www.amazon.com/dp/B0ABCDEF12?tag=fallback-20&ref_=safe",
  );
  const before = enriched.recommendations[0]!;
  const untouched = enriched.recommendations[1]!;
  const completed = applyDeterministicIdeaCopyFallback(enriched, before.id);
  const after = completed.recommendations[0]!;

  assert.equal(after.id, before.id);
  assert.equal(after.position, before.position);
  assert.equal(after.productId, before.productId);
  assert.equal(after.directAffiliateUrl, before.directAffiliateUrl);
  assert.equal(after.slotIntent, before.slotIntent);
  assert.deepEqual(after.searchTerms, before.searchTerms);
  assert.equal(after.budgetHint, before.budgetHint);
  assert.equal(after.editorialPromptVersion, SAFE_IDEA_COPY_VERSION);
  assert.equal(after.editorialStatus, "ready");
  assert.deepEqual(completed.recommendations[1], untouched);
});

test("la generación editorial exitosa conserva el enlace directo y la referencia Product", async () => {
  const content = new ProductCatalog().read();
  const draft = await selectedGuideDraft("guide_safe-generated-state");
  const withAffiliate = updateRecommendationDirectAffiliateUrl(
    draft,
    draft.recommendations[0]!.id,
    "https://www.amazon.com/dp/B0ABCDEF12?tag=success-20",
  );
  const before = withAffiliate.recommendations[0]!;
  const untouched = withAffiliate.recommendations[1]!;
  const generated = await regenerateRecommendation(
    withAffiliate,
    before.id,
    content,
    new MockGuideGenerationProvider(),
  );
  const after = generated.recommendations[0]!;

  assert.equal(after.id, before.id);
  assert.equal(after.position, before.position);
  assert.equal(after.productId, before.productId);
  assert.equal(after.directAffiliateUrl, before.directAffiliateUrl);
  assert.equal(after.editorialStatus, "ready");
  assert.deepEqual(generated.recommendations[1], untouched);
});

test("el repair agotado usa fallback sin reescribir afiliación ni identidad", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_exhausted-fallback-state");
  const monetized = updateRecommendationDirectAffiliateUrl(
    draft,
    draft.recommendations[0]!.id,
    "https://www.amazon.com/dp/B0ABCDEF12?tag=exhausted-20",
  );
  const before = monetized.recommendations[0]!;
  const operations: string[] = [];
  const provider: GuideGenerationProvider = {
    providerId: "identity-changing-batch-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      operations.push(request.operation);
      const input = request.input as {
        recommendations: Array<{ id: string; position: number }>;
      };
      return {
        recommendations: input.recommendations.map((recommendation) => ({
          id: recommendation.id,
          position: recommendation.position + 1,
          heading: "Unsafe identity change",
          editorialDescription: "This response must be rejected.",
          whyItFits: "It cannot replace stable recommendation identity.",
          bestFor: "No accepted recommendation",
          selectionGuidance: "Reject the mismatched position.",
        })),
      } as T;
    },
  };

  const completed = await generateIdeaOnlyRecommendationBatchWithRecovery(
    monetized,
    [before.id],
    content,
    provider,
  );
  const after = completed.draft.recommendations[0]!;

  assert.deepEqual(operations, ["idea-recommendation-batch", "idea-recommendation-batch-repair"]);
  assert.equal(after.id, before.id);
  assert.equal(after.position, before.position);
  assert.equal(after.directAffiliateUrl, before.directAffiliateUrl);
  assert.equal(after.productId, before.productId);
  assert.equal(after.editorialPromptVersion, SAFE_IDEA_COPY_VERSION);
  assert.ok(completed.slots[0]!.warnings.includes("idea-editorial-copy-fallback-used"));
});

test("recupera copy idea-only campo por campo y reporta diagnósticos compactos", async () => {
  const content = new ProductCatalog().read();
  const draft = await generatedGuideDraft("guide_idea-copy-diagnostics");
  const slot = draft.recommendations[0]!;
  const base = {
    id: slot.id,
    position: slot.position,
    heading: "A thoughtful recovery accessory",
    editorialDescription: "A well-chosen format can fit naturally into an established routine.",
    whyItFits: "It makes the gift useful without depending on a particular brand or model.",
    bestFor: "Someone who values practical recovery rituals",
    selectionGuidance: "Compare comfort, care, and fit with the recipient's routine.",
    considerations: "Personal preferences should guide the final choice.",
  };
  const providerFor = (response: Record<string, unknown>): GuideGenerationProvider => ({
    providerId: "idea-copy-diagnostic-fixture",
    modelId: "deepseek-style-fixture",
    async generateStructured<T>(generationRequest: StructuredGenerationRequest<T>): Promise<T> {
      assert.equal(generationRequest.operation, "idea-recommendation");
      assert.equal(generationRequest.schema.safeParse({ ...base, extra: true }).success, false);
      const { heading: _heading, ...missingRequired } = base;
      assert.equal(generationRequest.schema.safeParse(missingRequired).success, false);
      return response as T;
    },
  });
  const prepared = prepareIdeaRecommendationPrompt(draft, slot.id, content);
  assert.match(prepared.prompt, /bestFor: required non-empty string, at most 120 characters/);
  assert.match(prepared.prompt, /selectionGuidance: required non-empty string, at most 500/);
  assert.match(prepared.prompt, /considerations: optional non-empty string/);
  assert.match(
    prepared.prompt,
    /target at most 80 characters for heading, 450 for editorialDescription/,
  );
  assert.match(prepared.prompt, /Avoid stock openings and repeated boilerplate across the guide/);
  assert.match(prepared.prompt, /Night-shift nurses often/);
  assert.match(prepared.prompt, /comfort during long shifts/);
  assert.match(prepared.prompt, /Avoid claims about circulation, recovery, sleep effects/);
  assert.doesNotMatch(prepared.prompt, /description\"|whyFit\"|selectionGuide\"/);
  assert.doesNotThrow(() => generatedIdeaRecommendationSchema.parse(base));

  const valid = await completeIdeaOnlyRecommendationCopy(draft, slot.id, {
    catalog: new ProductCatalog(),
    provider: providerFor(base),
  });
  assert.deepEqual(valid.actionsPerformed, ["generated-idea-only-copy"]);
  assert.deepEqual(valid.warnings, []);
  assert.equal(valid.draft.recommendations[0]!.editorialDescription, base.editorialDescription);

  for (const considerations of [null, undefined]) {
    const normalized = await completeIdeaOnlyRecommendationCopy(draft, slot.id, {
      catalog: new ProductCatalog(),
      provider: providerFor({ ...base, considerations }),
    });
    assert.deepEqual(normalized.warnings, []);
    assert.equal(normalized.draft.recommendations[0]!.considerations, undefined);
  }

  for (const [field, value, diagnostic] of [
    ["editorialDescription", content.products[0]!.name, "idea-copy-product-leak"],
    ["whyItFits", "Available from Amazon for this gift.", "idea-copy-merchant-leak"],
    ["considerations", "Compare ASIN B0ABCDEF12 before choosing.", "idea-copy-asin-leak"],
    ["bestFor", "The audience described by this slot in Studio.", "idea-copy-internal-terminology"],
    ["selectionGuidance", "Choose a 20 oz format.", "idea-copy-unsupported-numeric-claim"],
  ] as const) {
    const recovery = await generateIdeaOnlyRecommendationWithRecovery(
      draft,
      slot.id,
      content,
      providerFor({ ...base, [field]: value }),
    );
    assert.equal(recovery.usedDeterministicFallback, false);
    assert.ok(recovery.repairedFields.includes(field));
    assert.deepEqual(recovery.diagnostics, [diagnostic]);
    const repairedSlot = recovery.draft.recommendations[0]!;
    assert.equal(repairedSlot.heading, base.heading);
    if (field !== "whyItFits") assert.equal(repairedSlot.whyItFits, base.whyItFits);
    assert.notEqual(repairedSlot[field], value);
  }

  const wrongType = await generateIdeaOnlyRecommendationWithRecovery(
    draft,
    slot.id,
    content,
    providerFor({ ...base, selectionGuidance: 42 }),
  );
  assert.equal(wrongType.usedDeterministicFallback, false);
  assert.deepEqual(wrongType.diagnostics, ["idea-copy-schema-invalid"]);
  assert.deepEqual(wrongType.diagnosticDetails, [
    {
      code: "idea-copy-schema-invalid",
      contractVersion: "idea-recommendation-v5",
      providerId: "idea-copy-diagnostic-fixture",
      modelId: "deepseek-style-fixture",
      path: "selectionGuidance",
      expected: "string",
      received: "number",
    },
  ]);
  assert.equal(wrongType.draft.recommendations[0]!.heading, base.heading);
  assert.notEqual(wrongType.draft.recommendations[0]!.selectionGuidance, 42);

  for (const invalid of [
    { field: "bestFor", value: "x".repeat(121), expected: "string-max-120" },
    { field: "selectionGuidance", value: ["Compare care."], expected: "string" },
  ] as const) {
    const recovery = await generateIdeaOnlyRecommendationWithRecovery(
      draft,
      slot.id,
      content,
      providerFor({ ...base, [invalid.field]: invalid.value }),
    );
    assert.deepEqual(recovery.diagnostics, ["idea-copy-schema-invalid"]);
    assert.equal(recovery.diagnosticDetails[0]!.path, invalid.field);
    assert.equal(recovery.diagnosticDetails[0]!.expected, invalid.expected);
    assert.match(
      recovery.diagnosticDetails[0]!.received!,
      /^(?:string\(length=121\)|array\(length=1\))$/,
    );
    assert.equal(recovery.draft.recommendations[0]!.heading, base.heading);
  }

  for (const [provider, diagnostic] of [
    [
      providerFor(Object.fromEntries(Object.entries(base).filter(([key]) => key !== "heading"))),
      "idea-copy-schema-invalid",
    ],
    [
      {
        providerId: "idea-copy-timeout-fixture",
        async generateStructured<T>(): Promise<T> {
          throw new ProviderError("Fixture timeout.", "timeout");
        },
      } satisfies GuideGenerationProvider,
      "idea-copy-provider-failure",
    ],
  ] as const) {
    const completion = await completeIdeaOnlyRecommendationCopy(draft, slot.id, {
      catalog: new ProductCatalog(),
      provider,
    });
    assert.deepEqual(completion.actionsPerformed, ["generated-safe-idea-only-fallback"]);
    assert.equal(completion.warnings.length, 2);
    assert.match(completion.warnings[0]!, new RegExp(`^${diagnostic} `));
    assert.match(completion.warnings[0]!, /provider=.+ contract=idea-recommendation-v5/);
    if (diagnostic === "idea-copy-schema-invalid") {
      assert.match(completion.warnings[0]!, /path=heading expected=custom received=missing/);
    } else {
      assert.match(completion.warnings[0]!, /reason=timeout/);
    }
    assert.equal(completion.warnings[1], "idea-editorial-copy-fallback-used");
    assert.equal(completion.draft.recommendations[0]!.editorialStatus, "ready");
  }
});

test("reintenta metadata una vez y conserva contexto específico en el fallback", async () => {
  const content = new ProductCatalog().read();
  const outlined = await generatedGuideDraft("guide_metadata-retry");
  const title = "Night-Shift Comfort Gifts for Nurses";
  const audience = "nurses who regularly work overnight";
  const primaryIntent =
    "Help friends choose gifts that make demanding shifts feel more manageable.";
  const editorialAngle = "Favor concrete comfort and organization needs over generic nurse themes.";
  const giftContext = "Portable organizer caddy";
  const draft = guideDraftSchema.parse({
    ...outlined,
    title,
    primaryIntent,
    questionnaire: { ...outlined.questionnaire, recipient: audience },
    outline: {
      ...outlined.outline!,
      editorialAngle,
      slots: outlined.outline!.slots.map((slot, index) =>
        index === 0 ? { ...slot, label: giftContext } : slot,
      ),
    },
    recommendations: outlined.recommendations.map((slot, index) =>
      index === 0 ? { ...slot, slotLabel: giftContext } : slot,
    ),
  });
  const metadata = {
    excerpt: "A concise guide to thoughtful gifts for overnight nurses.",
    introduction: "Choose around the realities of overnight work and daytime rest.",
    seoTitle: title,
    seoDescription: "Comfort-minded gifts for nurses who work overnight.",
  };
  let recoveredCalls = 0;
  const recovered = await completeGuideEditorialMetadata(draft, content, {
    providerId: "metadata-retry-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      recoveredCalls++;
      return (recoveredCalls === 1 ? { excerpt: 42 } : request.schema.parse(metadata)) as T;
    },
  });
  assert.equal(recoveredCalls, 2);
  assert.deepEqual(recovered.actionsPerformed, ["generated-guide-metadata"]);
  assert.deepEqual(recovered.warnings, []);
  assert.equal(recovered.draft.introduction, metadata.introduction);

  let failedCalls = 0;
  const fallback = await completeGuideEditorialMetadata(draft, content, {
    providerId: "metadata-fallback-fixture",
    async generateStructured<T>(): Promise<T> {
      failedCalls++;
      return {} as T;
    },
  });
  assert.equal(failedCalls, 2, "one initial metadata call plus one bounded retry");
  assert.deepEqual(fallback.actionsPerformed, ["generated-safe-guide-metadata-fallback"]);
  assert.deepEqual(fallback.warnings, ["guide-metadata-fallback-used"]);
  const publicMetadata = [
    fallback.draft.excerpt,
    fallback.draft.introduction,
    fallback.draft.seoTitle,
    fallback.draft.seoDescription,
  ].join(" ");
  for (const context of [title, audience, primaryIntent, editorialAngle, giftContext]) {
    assert.match(publicMetadata, new RegExp(context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("alinea el contrato Product-backed, permite identidad canónica y clasifica cada fallback", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-copy-contract-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const product = productSchema.parse({
    schemaVersion: 1,
    id: "product_copy-contract",
    name: "Trail Anti-Chafe Balm",
    merchant: "Fixture merchant",
    shortDescription: "Observed listing description that generation must never receive.",
    verifiedFacts: ["Product type: anti-chafe balm"],
    priceLabel: "$24.99 observed",
    status: "active",
  });
  assert.equal(productDisplayName(product), product.name);
  await catalog.save(product);
  const base = await generatedGuideDraft("guide_product-copy-contract");
  const slot = base.recommendations[0]!;
  const draft = selectRecommendationProduct(base, slot.id, product.id, catalog.read());
  const ideaCopy = {
    heading: "A portable charger that is easy to keep close",
    editorialDescription:
      "A compact charging option can help keep a phone ready during long days away from an outlet.",
    whyItFits: "It answers a concrete need without turning the gift into workplace-themed merch.",
    bestFor: "Someone who relies on a phone throughout a long workday",
    selectionGuidance: "Compare size, device compatibility, and ease of carrying.",
    considerations: "Confirm compatibility with the recipient's usual phone and cable.",
  };
  const ideaBackedDraft = selectRecommendationProduct(
    updateRecommendationEditorialCopy(base, slot.id, ideaCopy, true),
    slot.id,
    product.id,
    catalog.read(),
  );
  const enrichmentPrompt = prepareRecommendationPrompt(ideaBackedDraft, slot.id, catalog.read());
  assert.deepEqual(enrichmentPrompt.input.recommendation.existingCopy, {
    heading: ideaCopy.heading,
    editorialDescription: ideaCopy.editorialDescription,
    whyItFits: ideaCopy.whyItFits,
    bestFor: ideaCopy.bestFor,
    considerations: ideaCopy.considerations,
  });
  assert.match(enrichmentPrompt.prompt, /use the selected Product only to enrich/);
  assert.match(enrichmentPrompt.prompt, /Never mention a slot, Product slot/);
  assert.match(enrichmentPrompt.prompt, /Avoid stock openings and repeated boilerplate/);
  assert.match(enrichmentPrompt.prompt, /comfort during long shifts/);
  const metadataBefore = {
    title: draft.title,
    excerpt: draft.excerpt,
    introduction: draft.introduction,
    conclusion: draft.conclusion,
    seoTitle: draft.seoTitle,
    seoDescription: draft.seoDescription,
  };
  const validResponse = {
    id: slot.id,
    productId: product.id,
    position: slot.position,
    heading: null,
    editorialDescription:
      "Trail Anti-Chafe Balm is a grounded option for an established active routine.",
    whyItFits: "Its verified product type matches the practical purpose of this gift.",
    bestFor: null,
    considerations: null,
  };
  const providerFor = (response: Record<string, unknown>): GuideGenerationProvider => ({
    providerId: "product-copy-contract-fixture",
    modelId: "deepseek-style-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation === "recommendation-field-repair") {
        const input = recommendationFieldRepairInputSchema.parse(request.input);
        assert.equal(input.field, "editorialDescription");
        return {
          value: "This anti-chafe balm fits the practical purpose of this gift.",
        } as T;
      }
      assert.equal(request.operation, "single-recommendation");
      const input = recommendationPromptInputSchema.parse(request.input);
      assert.deepEqual(input.recommendation.product, {
        id: product.id,
        name: productDisplayName(product),
        verifiedFacts: product.verifiedFacts,
      });
      const serialized = JSON.stringify(input.recommendation.product);
      assert.doesNotMatch(
        serialized,
        /merchant|shortDescription|priceLabel|rating|review|snippet/i,
      );
      assert.match(request.prompt, /Return exactly these fields and no aliases or extra fields/);
      assert.match(request.prompt, /Optional fields may be omitted or null/);
      assert.equal(request.prompt.includes(product.shortDescription), false);
      return response as T;
    },
  });

  const normalized = generatedRecommendationSchema.parse(validResponse);
  assert.equal(normalized.heading, undefined);
  assert.equal(normalized.bestFor, undefined);
  assert.equal(normalized.considerations, undefined);
  assert.throws(() =>
    generatedRecommendationSchema.parse({
      ...validResponse,
      editorialDescription: undefined,
      description: "An unsupported alias.",
    }),
  );

  const completed = await completeProductBackedRecommendationCopy(draft, slot.id, {
    catalog,
    provider: providerFor(validResponse),
  });
  assert.deepEqual(completed.actionsPerformed, ["generated-product-recommendation-copy"]);
  assert.deepEqual(completed.warnings, []);
  assert.equal(completed.draft.recommendations[0]!.productId, product.id);
  assert.equal(
    completed.draft.recommendations[0]!.editorialPromptVersion,
    "single-recommendation-v4",
  );
  assert.deepEqual(
    {
      title: completed.draft.title,
      excerpt: completed.draft.excerpt,
      introduction: completed.draft.introduction,
      conclusion: completed.draft.conclusion,
      seoTitle: completed.draft.seoTitle,
      seoDescription: completed.draft.seoDescription,
    },
    metadataBefore,
  );

  for (const [response, diagnostic] of [
    [
      { ...validResponse, whyItFits: undefined },
      /recommendation-copy-schema-invalid path=whyItFits expected=string received=missing/,
    ],
    [
      { ...validResponse, bestFor: ["Active field workers"] },
      /recommendation-copy-schema-invalid path=bestFor expected=string received=array\(length=1\)/,
    ],
    [
      { ...validResponse, editorialDescription: { text: "Do not coerce this object." } },
      /recommendation-copy-schema-invalid path=editorialDescription expected=string received=object/,
    ],
    [
      { ...validResponse, productId: "product_changed" },
      /recommendation-copy-product-identity-invalid .*reason=id-productId-or-position-changed/,
    ],
  ] as const) {
    const fallback = await completeProductBackedRecommendationCopy(draft, slot.id, {
      catalog,
      provider: providerFor(response),
    });
    assert.deepEqual(fallback.actionsPerformed, ["generated-safe-product-copy-fallback"]);
    assert.equal(fallback.warnings.length, 1);
    assert.match(fallback.warnings[0]!, diagnostic);
    assert.match(
      fallback.warnings[0]!,
      /provider=product-copy-contract-fixture model=deepseek-style-fixture contract=single-recommendation-v4/,
    );
    assert.equal(fallback.draft.recommendations[0]!.productId, product.id);
    assert.equal(fallback.draft.recommendations[0]!.editorialStatus, "ready");
  }

  const claimRepair = await completeProductBackedRecommendationCopy(draft, slot.id, {
    catalog,
    provider: providerFor({
      ...validResponse,
      editorialDescription: "Available now for $24.99.",
    }),
  });
  assert.deepEqual(claimRepair.actionsPerformed, ["repaired-product-recommendation-copy-fields"]);
  assert.deepEqual(claimRepair.warnings, []);
  assert.equal(claimRepair.draft.recommendations[0]!.whyItFits, validResponse.whyItFits);
  assert.equal(
    claimRepair.draft.recommendations[0]!.editorialDescription,
    "This anti-chafe balm fits the practical purpose of this gift.",
  );
  assert.equal(
    claimRepair.draft.recommendations[0]!.editorialPromptVersion,
    "single-recommendation-v4",
  );

  const providerFailure = await completeProductBackedRecommendationCopy(ideaBackedDraft, slot.id, {
    catalog,
    provider: {
      providerId: "product-copy-timeout-fixture",
      modelId: "timeout-model",
      async generateStructured<T>(): Promise<T> {
        throw new ProviderError("Fixture timeout.", "timeout");
      },
    },
  });
  assert.match(
    providerFailure.warnings[0]!,
    /^recommendation-copy-provider-failure reason=timeout provider=product-copy-timeout-fixture model=timeout-model contract=single-recommendation-v4$/,
  );
  assert.equal(providerFailure.draft.recommendations[0]!.productId, product.id);
  for (const [field, value] of Object.entries(ideaCopy)) {
    assert.equal(
      providerFailure.draft.recommendations[0]![
        field as keyof GuideDraft["recommendations"][number]
      ],
      value,
    );
  }
  assert.doesNotMatch(
    JSON.stringify(providerFailure.draft.recommendations[0]),
    /\b(?:slot|sourcing|candidate|resolved Product)\b/i,
  );

  const safeGeneratedSiblings = {
    editorialDescription:
      "A compact charging option can help keep a phone ready through a demanding day.",
    whyItFits: "It answers a clear need for someone who depends on a phone away from home.",
    bestFor: "Someone who spends long days away from an outlet",
  };
  const internalLanguageOperations: StructuredGenerationRequest<unknown>["operation"][] = [];
  const internalHeading = await completeProductBackedRecommendationCopy(ideaBackedDraft, slot.id, {
    catalog,
    provider: {
      providerId: "product-copy-internal-language-fixture",
      async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
        internalLanguageOperations.push(request.operation);
        if (request.operation === "single-recommendation") {
          return {
            id: slot.id,
            productId: product.id,
            position: slot.position,
            heading: "Shoulder Bag Option for the Portable Organizer Slot",
            ...safeGeneratedSiblings,
          } as T;
        }
        assert.equal(request.operation, "recommendation-field-repair");
        return { value: "Resolved Product candidate from sourcing for this slot." } as T;
      },
    },
  });
  const safeRecommendation = internalHeading.draft.recommendations[0]!;
  assert.deepEqual(internalHeading.actionsPerformed, [
    "repaired-product-recommendation-copy-fields",
  ]);
  assert.deepEqual(internalLanguageOperations, [
    "single-recommendation",
    "recommendation-field-repair",
  ]);
  assert.equal(safeRecommendation.productId, product.id);
  assert.equal(safeRecommendation.heading, ideaCopy.heading);
  assert.equal(safeRecommendation.editorialDescription, safeGeneratedSiblings.editorialDescription);
  assert.equal(safeRecommendation.whyItFits, safeGeneratedSiblings.whyItFits);
  assert.equal(safeRecommendation.bestFor, safeGeneratedSiblings.bestFor);
  assert.equal(safeRecommendation.selectionGuidance, ideaCopy.selectionGuidance);
  assert.doesNotMatch(
    JSON.stringify(safeRecommendation),
    /\b(?:slot|sourcing|candidate|resolved Product)\b/i,
  );
  assert.match(internalHeading.warnings[0]!, /reason=internal-terminology/);
});

test("distingue identidad Product y repara sólo el campo con claims observados", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-observed-claim-repair-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const product = productSchema.parse({
    schemaVersion: 1,
    id: "product_observed-claim-repair",
    name: "Field Brand Trail Anti-Chafe Balm | 2.5 oz | 320mg Sodium | Long Lasting Protection",
    brand: "Field Brand",
    merchant: "Fixture merchant",
    shortDescription:
      "Merino wool material; stainless steel shell; reduce friction; inner thigh use; twist-up package; certified organic; twelve hour performance.",
    verifiedFacts: ["Material: merino wool"],
    status: "active",
  });
  await catalog.save(product);
  const base = await generatedGuideDraft("guide_observed-claim-repair");
  const originalSlot = base.recommendations[0]!;
  const shaped = guideDraftSchema.parse({
    ...base,
    recommendations: base.recommendations.map((slot) =>
      slot.id === originalSlot.id
        ? {
            ...slot,
            slotLabel: "Anti-Chafe Balm",
            slotIntent: "Reduce friction during long days on foot.",
          }
        : slot,
    ),
  });
  const draft = selectRecommendationProduct(shaped, originalSlot.id, product.id, catalog.read());
  const claimContext = {
    productClass: "Anti-Chafe Balm",
    slotPurpose: "Reduce friction during long days on foot.",
    guideContext: [draft.title!, draft.primaryIntent!],
  };

  const identityMatches = classifyObservedClaimMatches(
    "Field Brand Trail Anti-Chafe Balm is an anti-chafe balm choice.",
    product,
    claimContext,
  );
  assert.ok(identityMatches.length > 0);
  assert.ok(identityMatches.every(({ classification }) => classification === "identity-safe"));
  assert.deepEqual(classifyObservedClaimMatches("Trail balm", product, claimContext), []);

  const verifiedMatch = classifyObservedClaimMatches(
    "The verified material is merino wool.",
    product,
    claimContext,
  ).find(({ matched }) => matched === "merino wool");
  assert.deepEqual(verifiedMatch, {
    matched: "merino wool",
    source: "short-description",
    identitySafe: false,
    verifiedSafe: true,
    classification: "verified-safe",
  });
  const marketingMatch = classifyObservedClaimMatches(
    "It offers long lasting protection.",
    product,
    claimContext,
  ).find(({ matched }) => matched === "long lasting protection");
  assert.deepEqual(marketingMatch, {
    matched: "long lasting protection",
    source: "listing-title",
    identitySafe: false,
    verifiedSafe: false,
    classification: "observed-only",
  });
  assert.equal(
    classifyObservedClaimMatches("It can reduce friction.", product, claimContext).find(
      ({ matched }) => matched === "reduce friction",
    )?.classification,
    "ambiguous",
  );

  const copyWith = (editorialDescription: string) => ({
    editorialDescription,
    whyItFits: "This gift category suits the guide.",
    editorialPromptVersion: "single-recommendation-v4",
  });
  for (const value of [
    "The 2.5 oz size is useful.",
    "It contains 320mg sodium.",
    "It lasts 12 hours.",
    "It has UPF 50+ protection.",
  ]) {
    assert.equal(
      productBackedCopyFailureReason(copyWith(value), product, undefined, claimContext),
      "unsupported-numeric-claim",
    );
  }
  assert.equal(
    productBackedCopyFailureReason(copyWith("It suits a 12-hour shift."), product, undefined, {
      ...claimContext,
      guideContext: ["Gifts for Nurses Working 12-Hour Shifts"],
    }),
    "unsupported-numeric-claim",
  );
  for (const value of [
    "It has a stainless steel shell.",
    "It promises twelve hour performance.",
    "It is intended for inner thigh use.",
    "It uses a twist-up package.",
    "It is certified organic.",
    "It offers long lasting protection.",
    "It can reduce friction.",
  ]) {
    assert.equal(
      productBackedCopyFailureReason(copyWith(value), product, undefined, claimContext),
      "observed-listing-claim",
    );
  }

  const canonicalName = productDisplayName(product);
  const generated = {
    id: originalSlot.id,
    productId: product.id,
    position: originalSlot.position,
    heading: canonicalName,
    editorialDescription: `${canonicalName} offers long lasting protection.`,
    whyItFits: "This anti-chafe balm fits a guide focused on comfort during long days on foot.",
    bestFor: "Someone who spends long days on foot",
  };
  const operations: StructuredGenerationRequest<unknown>["operation"][] = [];
  const provider: GuideGenerationProvider = {
    providerId: "field-repair-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      operations.push(request.operation);
      if (request.operation === "single-recommendation") return generated as T;
      assert.equal(request.operation, "recommendation-field-repair");
      const input = recommendationFieldRepairInputSchema.parse(request.input);
      assert.equal(input.field, "editorialDescription");
      assert.deepEqual(input.product, {
        name: canonicalName,
        brand: product.brand,
        verifiedFacts: product.verifiedFacts,
      });
      assert.equal(input.productClass, "Anti-Chafe Balm");
      assert.equal(input.slotPurpose, "Reduce friction during long days on foot.");
      const serialized = JSON.stringify(input);
      assert.doesNotMatch(serialized, /merchant|shortDescription|priceLabel|rating|review/i);
      assert.equal(request.prompt.includes(product.name), false);
      assert.equal(request.prompt.includes(product.shortDescription), false);
      assert.equal(request.prompt.includes(generated.editorialDescription), false);
      return {
        value: `${canonicalName} is an anti-chafe balm choice for this guide.`,
      } as T;
    },
  };
  const siblingsBefore = draft.recommendations.slice(1);
  const repaired = await generateProductBackedRecommendationWithRecovery(
    draft,
    originalSlot.id,
    catalog.read(),
    provider,
  );
  assert.deepEqual(operations, ["single-recommendation", "recommendation-field-repair"]);
  assert.deepEqual(repaired.repairedFields, ["editorialDescription"]);
  assert.deepEqual(repaired.repairedClaims, [
    {
      field: "editorialDescription",
      matched: "long lasting protection",
      source: "listing-title",
      identitySafe: false,
      verifiedSafe: false,
      classification: "observed-only",
    },
  ]);
  assert.deepEqual(repaired.diagnosticDetails, []);
  assert.equal(repaired.draft.recommendations[0]!.productId, product.id);
  assert.equal(repaired.draft.recommendations[0]!.heading, canonicalName);
  assert.equal(repaired.draft.recommendations[0]!.whyItFits, generated.whyItFits);
  assert.equal(repaired.draft.recommendations[0]!.bestFor, generated.bestFor);
  assert.deepEqual(repaired.draft.recommendations.slice(1), siblingsBefore);
  assert.equal(catalog.get(product.id).name, product.name);

  const failedRepair = await completeProductBackedRecommendationCopy(draft, originalSlot.id, {
    catalog,
    provider: {
      providerId: "field-repair-timeout-fixture",
      async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
        if (request.operation === "single-recommendation") return generated as T;
        throw new ProviderError("Fixture timeout.", "timeout");
      },
    },
  });
  assert.deepEqual(failedRepair.actionsPerformed, ["repaired-product-recommendation-copy-fields"]);
  assert.equal(failedRepair.draft.recommendations[0]!.whyItFits, generated.whyItFits);
  assert.notEqual(
    failedRepair.draft.recommendations[0]!.editorialDescription,
    generated.editorialDescription,
  );
  assert.match(
    failedRepair.warnings[0]!,
    /^recommendation-copy-provider-failure path=editorialDescription reason=timeout matched="long lasting protection" source=listing-title identitySafe=false verifiedSafe=false classification=observed-only provider=field-repair-timeout-fixture contract=single-recommendation-field-repair-v1$/,
  );

  const emptyFactsProduct = productSchema.parse({
    schemaVersion: 1,
    id: "product_empty-facts-repair",
    name: "Field Brand Hydration Tablets | Fast Recovery",
    brand: "Field Brand",
    merchant: "Fixture merchant",
    shortDescription: "Observed hydration and performance copy.",
    status: "active",
  });
  const emptyFactsContent = {
    ...catalog.read(),
    products: [...catalog.read().products, emptyFactsProduct],
  };
  const emptyFactsDraft = selectRecommendationProduct(
    shaped,
    originalSlot.id,
    emptyFactsProduct.id,
    emptyFactsContent,
  );
  const emptyFactsRepair = prepareRecommendationFieldRepairPrompt(
    emptyFactsDraft,
    originalSlot.id,
    "whyItFits",
    emptyFactsContent,
  );
  assert.deepEqual(emptyFactsRepair.input.product.verifiedFacts, []);
  assert.equal(emptyFactsRepair.prompt.includes(emptyFactsProduct.name), false);
  assert.equal(emptyFactsRepair.prompt.includes(emptyFactsProduct.shortDescription), false);
});

test("reabre una guía publicada con identidad y copia listas", () => {
  const content = new ProductCatalog().read();
  const published = content.guides[0]!;
  const draft = reopenGuideDraft(published, content, new Date("2026-08-08T20:00:00.000Z"));

  assert.equal(draft.id, published.id);
  assert.equal(draft.slug, published.slug);
  assert.deepEqual(
    draft.recommendations.map((recommendation) => recommendation.id),
    published.recommendations
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((recommendation) => recommendation.id),
  );
  assert.ok(
    draft.recommendations.every((recommendation) => recommendation.editorialStatus === "ready"),
  );
  assert.deepEqual(validateGuideDraft(draft, content).errors, []);
});

test("regenera por HTTP el slot 4 aunque los demás no tengan producto", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-final-http-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(directory, "content"), { recursive: true });
  const store = new DraftStore(join(directory, "drafts"));
  const catalog = new ProductCatalog(directory);
  const content = catalog.read();
  const draft = await selectedGuideDraft("guide_http-final", 4);
  await store.save(draft);
  const server = createStudioServer(
    store,
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(directory),
    new ProductSourceStore(directory),
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const promptResponse = await fetch(`${origin}/drafts/${draft.id}/final-prompt`);
  assert.match(await promptResponse.text(), /Revisar prompt de generación final/);
  const generatedResponse = await fetch(`${origin}/drafts/${draft.id}/final/generate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ promptVersion: "final-guide-v4" }),
    redirect: "manual",
  });
  assert.equal(generatedResponse.status, 303);
  let saved = await store.read(draft.id);
  assert.equal(saved.draftType, "gift-guide");
  assert.ok(
    saved.recommendations.every((recommendation) => recommendation.editorialStatus === "ready"),
  );

  const preview = await fetch(`${origin}/drafts/${draft.id}/preview`);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /Ruta canónica: <code>\/nurse-gifts\/http-final\/<\/code>/);
  assert.match(previewHtml, /Metadata de publicación/);
  assert.match(previewHtml, /Título SEO/);
  assert.doesNotMatch(previewHtml, /Structured input|promptVersion/);
  const validation = await fetch(`${origin}/drafts/${draft.id}/validate`);
  assert.match(await validation.text(), /lista para la publicación/);
  assert.equal((await store.read(draft.id)).status, "ready-to-publish");

  saved = await store.read(draft.id);
  assert.equal(saved.draftType, "gift-guide");
  const target = saved.recommendations[3]!;
  const replacement = content.products[4]!;
  await fetch(`${origin}/drafts/${draft.id}/recommendations/${target.id}/product`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ productId: replacement.id }),
    redirect: "manual",
  });
  assert.equal((await store.read(draft.id)).status, "selecting-products");

  let focusedDraft = guideDraftSchema.parse(await store.read(draft.id));
  for (const recommendation of focusedDraft.recommendations) {
    if (recommendation.id !== target.id) {
      focusedDraft = clearRecommendationProduct(focusedDraft, recommendation.id);
    }
  }
  await store.save(focusedDraft);
  const identities = focusedDraft.recommendations.map(({ id, productId, position }) => ({
    id,
    productId,
    position,
  }));
  assert.throws(() => prepareFinalPrompt(focusedDraft, content), /no tiene producto/);
  await assert.rejects(
    regenerateRecommendation(
      focusedDraft,
      focusedDraft.recommendations[0]!.id,
      content,
      new MockGuideGenerationProvider(),
    ),
    /no tiene producto/,
  );
  const prepared = prepareRecommendationPrompt(focusedDraft, target.id, content);
  assert.equal(prepared.input.recommendation.recommendationId, target.id);
  assert.equal(prepared.input.recommendation.product.id, replacement.id);
  assert.deepEqual(
    prepared.input.guide.approvedOutline.slots.map((slot) => slot.id),
    [target.id],
  );

  const singlePrompt = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/${target.id}/prompt`,
  );
  assert.equal(singlePrompt.status, 200);
  assert.match(await singlePrompt.text(), /Regenerar una recomendación/);
  const regenerated = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/${target.id}/regenerate`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ promptVersion: "single-recommendation-v4" }),
      redirect: "manual",
    },
  );
  assert.equal(regenerated.status, 303);
  const finalDraft = await store.read(draft.id);
  assert.equal(finalDraft.draftType, "gift-guide");
  assert.deepEqual(
    finalDraft.recommendations.map(({ id, productId, position }) => ({ id, productId, position })),
    identities,
  );
  assert.equal(finalDraft.recommendations[3]!.productId, replacement.id);
  assert.equal(finalDraft.recommendations[3]!.editorialStatus, "ready");
});

test("transforma borradores completos al esquema público sin campos editoriales", async () => {
  const content = readPublicContent();
  const draft = await generateFinalGuide(
    await selectedGuideDraft("guide_public-shape"),
    content,
    new MockGuideGenerationProvider(),
  );
  const guide = guideDraftToPublic(draft, content, new Date("2026-08-09T00:00:00.000Z"));
  const publicGuide = guide as unknown as Record<string, unknown>;
  const recommendation = guide.recommendations[0] as unknown as Record<string, unknown>;

  for (const draftOnlyField of [
    "createdAt",
    "draftType",
    "generationMetadata",
    "outline",
    "questionnaire",
  ]) {
    assert.equal(draftOnlyField in publicGuide, false);
  }
  assert.equal("slotLabel" in recommendation, false);
  assert.equal("selectionRationale" in recommendation, false);
  assert.equal(guide.status, "published");
  assert.equal(guide.updatedAt, "2026-08-09");

  const emptyHub = clusterDraftSchema.parse({
    ...createClusterDraft("cluster_empty-public"),
    slug: "empty-public",
    title: "Empty public hub",
    excerpt: "A complete cluster excerpt.",
    introduction: "A complete cluster introduction.",
    seoTitle: "Empty public hub",
    seoDescription: "A complete cluster SEO description.",
  });
  assert.deepEqual(clusterDraftToPublic(emptyHub, content).navigationGroups, []);
});

test("publica y renderiza una idea sin Product ni CTA, conservando QA e I.0", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-unresolved-build-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const publisher = new Publisher(repository);
  const content = publisher.read();
  const existing = content.guides[0]!;
  const original = existing.recommendations[0]!;
  assert.ok(original.productId);

  let draft = reopenGuideDraft(existing, content);
  draft = clearRecommendationProduct(draft, original.id);
  draft = updateRecommendationEditorialCopy(
    draft,
    original.id,
    {
      heading: "A low-effort recovery ritual",
      editorialDescription: "Shape the gift around how they already decompress after a long day.",
      whyItFits: "It stays useful without pretending one specific item fits everyone.",
      considerations: "Favor easy care and a format that works in their available space.",
    },
    true,
  );
  const unresolvedDraft = draft.recommendations.find(({ id }) => id === original.id)!;
  assert.equal(unresolvedDraft.id, original.id);
  assert.equal(unresolvedDraft.productId, undefined);
  assert.equal(unresolvedDraft.editorialStatus, "ready");
  const validation = validateGuideDraft(draft, content);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.readiness.editorialComplete, true);
  assert.equal(validation.readiness.productComplete, false);
  assert.equal(validation.readiness.productPendingCount, 1);

  await publisher.publishGuide(draft, new Date("2026-08-11T12:00:00.000Z"));
  const published = publisher.read();
  const publicGuide = published.guides.find(({ id }) => id === existing.id)!;
  const publicIdea = publicGuide.recommendations.find(({ id }) => id === original.id)!;
  assert.equal(publicIdea.id, original.id);
  assert.equal(publicIdea.productResolution, "unresolved");
  assert.equal(publicIdea.productId, undefined);
  assert.doesNotMatch(JSON.stringify(publicIdea), /autopilot|deferred|pending/i);

  const intelligence = analyzeProductCoverage(published);
  assert.ok(
    intelligence.editorialCoverage.publishedRecommendationsWithoutProducts.some(
      ({ guideId, recommendationId }) =>
        guideId === existing.id && recommendationId === original.id,
    ),
  );
  const affiliate = validateAffiliateOperations(published, []);
  assert.equal(
    affiliate.errors.some(({ field }) => field === "productId"),
    false,
  );
  assert.equal(
    affiliate.coverage.length,
    published.guides.flatMap(({ recommendations }) =>
      recommendations.filter(({ productId }) => productId),
    ).length,
  );

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const cluster = published.clusters.find(({ id }) => id === existing.clusterId)!;
  const html = await readFile(
    join(REPOSITORY_ROOT, "apps", "site", "dist", cluster.slug, existing.slug, "index.html"),
    "utf8",
  );
  const ideaIndex = html.indexOf('id="pick-1"');
  const ideaStart = html.lastIndexOf("<article", ideaIndex);
  const ideaEnd = html.indexOf("</article>", ideaIndex);
  assert.ok(ideaIndex >= 0 && ideaStart >= 0 && ideaEnd >= 0);
  const ideaCard = html.slice(ideaStart, ideaEnd + "</article>".length);
  assert.doesNotMatch(ideaCard, /href=|recommendation__catalog|recommendation__commerce/);
  assert.doesNotMatch(
    ideaCard,
    new RegExp(content.products.find(({ id }) => id === original.productId)!.name),
  );

  const resolved = publicGuide.recommendations.find(({ productId }) => productId)!;
  const resolvedProduct = published.products.find(({ id }) => id === resolved.productId)!;
  const resolvedIndex = html.indexOf(productDisplayName(resolvedProduct));
  const resolvedStart = html.lastIndexOf("<article", resolvedIndex);
  const resolvedEnd = html.indexOf("</article>", resolvedIndex);
  const resolvedCard = html.slice(resolvedStart, resolvedEnd + "</article>".length);
  assert.match(resolvedCard, /href=.*rel="sponsored nofollow noopener"/);
  assert.equal(resolvedCard.includes(resolvedProduct.shortDescription), false);
  if (resolvedProduct.priceLabel) {
    assert.equal(resolvedCard.includes(resolvedProduct.priceLabel), false);
  }

  const reopenedIdea = reopenGuideDraft(publicGuide, published);
  const attached = selectRecommendationProduct(
    reopenedIdea,
    original.id,
    original.productId!,
    published,
  );
  const attachedSlot = attached.recommendations.find(({ id }) => id === original.id)!;
  assert.equal(attached.id, existing.id);
  assert.equal(attachedSlot.id, original.id);
  assert.equal(attachedSlot.position, original.position);
  assert.equal(attachedSlot.editorialStatus, "needs-review");
  assert.ok(
    validateGuideDraft(attached, published).errors.some((error) => /no está listo/.test(error)),
  );

  const focused = await regenerateRecommendation(
    attached,
    original.id,
    published,
    new MockGuideGenerationProvider(),
  );
  assert.equal(
    focused.recommendations.find(({ id }) => id === original.id)!.editorialStatus,
    "ready",
  );
  const republished = await publisher.publishGuide(focused, new Date("2026-08-11T13:00:00.000Z"));
  const resolvedAgain = publisher
    .read()
    .guides.find(({ id }) => id === existing.id)!
    .recommendations.find(({ id }) => id === original.id)!;
  assert.equal(republished.id, existing.id);
  assert.equal(resolvedAgain.id, original.id);
  assert.equal(resolvedAgain.position, original.position);
  assert.equal(resolvedAgain.productId, original.productId);
});

test("monetiza una recomendación directamente sin Product ni trabajo de sourcing", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-direct-affiliate-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const store = new DraftStore(join(repository, "drafts"));
  const catalog = new ProductCatalog(repository);
  const publisher = new Publisher(repository);
  const sourceStore = new ProductSourceStore(repository);
  const content = catalog.read();
  const existing = content.guides[0]!;
  const original = existing.recommendations[0]!;
  let draft = clearRecommendationProduct(reopenGuideDraft(existing, content), original.id);
  draft = updateRecommendationEditorialCopy(
    draft,
    original.id,
    {
      heading: "A low-effort recovery ritual",
      editorialDescription: "Shape the gift around how they already decompress after a long day.",
      whyItFits: "It stays useful without pretending one specific item fits everyone.",
      considerations: "Favor easy care and a format that works in their available space.",
    },
    true,
  );
  draft = await store.save(draft);
  const untouchedRecommendation = structuredClone(
    draft.recommendations.find(({ id }) => id === original.id)!,
  );
  let providerCalls = 0;
  let discoveryCalls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "must-not-run",
    async generateStructured<T>(): Promise<T> {
      providerCalls++;
      throw new Error("Affiliate save must not call an LLM or P.2.");
    },
  };
  const discoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search() {
      discoveryCalls++;
      throw new Error("Affiliate save must not run discovery.");
    },
  };
  const server = createStudioServer(
    store,
    catalog,
    provider,
    publisher,
    sourceStore,
    undefined,
    undefined,
    undefined,
    undefined,
    discoverySource,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const slotPath = `/drafts/${draft.id}/recommendations/${original.id}/direct-affiliate`;
  const slotAnchor = `/drafts/${draft.id}#slot-${original.id}`;

  const editorBefore = await (await fetch(`${origin}/drafts/${draft.id}`)).text();
  assert.match(editorBefore, /Completar guía automáticamente/);
  assert.match(editorBefore, /Curación de Products \(opcional\)/);
  assert.match(editorBefore, /Monetización/);
  assert.match(editorBefore, /Sin enlace afiliado/);
  assert.ok(
    editorBefore.includes(`<form method="post" action="${slotPath}"><label>Amazon affiliate link`),
  );
  assert.equal(editorBefore.includes(`#slot-${original.id}/direct-affiliate`), false);

  const directAffiliateUrl =
    "https://www.amazon.com/dp/B012345678?tag=thegoodpresent-20&utm_source=studio";
  const savedResponse = await fetch(`${origin}${slotPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ directAffiliateUrl }),
    redirect: "manual",
  });
  assert.equal(savedResponse.status, 303);
  assert.equal(savedResponse.headers.get("location"), slotAnchor);
  let saved = guideDraftSchema.parse(await store.read(draft.id));
  let savedRecommendation = saved.recommendations.find(({ id }) => id === original.id)!;
  assert.equal(savedRecommendation.productId, undefined);
  assert.equal(savedRecommendation.directAffiliateUrl, directAffiliateUrl);
  const { directAffiliateUrl: _directAffiliateUrl, ...withoutDirectAffiliateUrl } =
    savedRecommendation;
  assert.deepEqual(withoutDirectAffiliateUrl, untouchedRecommendation);
  assert.equal(providerCalls, 0, "0 LLM or P.2 calls");
  assert.equal(discoveryCalls, 0, "0 discovery calls");

  const editorAfterSave = await (await fetch(`${origin}/drafts/${draft.id}`)).text();
  assert.ok(
    editorAfterSave.includes(
      `<form method="post" action="${slotPath}"><button type="submit">Quitar enlace</button></form>`,
    ),
  );
  assert.equal(editorAfterSave.includes(`#slot-${original.id}/direct-affiliate`), false);

  const preview = await (await fetch(`${origin}/drafts/${draft.id}/preview`)).text();
  assert.match(preview, />View on Amazon<\/a>/);
  await publisher.publishGuide(saved, new Date("2026-09-13T12:00:00.000Z"));
  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const published = publisher.read();
  const publicGuide = published.guides.find(({ id }) => id === existing.id)!;
  const publicRecommendation = publicGuide.recommendations.find(({ id }) => id === original.id)!;
  assert.equal(publicRecommendation.directAffiliateUrl, directAffiliateUrl);
  const cluster = published.clusters.find(({ id }) => id === existing.clusterId)!;
  const html = await readFile(
    join(REPOSITORY_ROOT, "apps", "site", "dist", cluster.slug, existing.slug, "index.html"),
    "utf8",
  );
  const cardIndex = html.indexOf(`id="pick-${original.position}"`);
  const card = html.slice(
    html.lastIndexOf("<article", cardIndex),
    html.indexOf("</article>", cardIndex),
  );
  assert.match(card, />View on Amazon<\/a>/);
  assert.match(card, /rel="sponsored nofollow noopener"/);
  assert.match(card, /tag=thegoodpresent-20/);
  assert.match(card, /utm_source=studio/);
  assert.equal(card.replace(/<[^>]+>/g, " ").includes(directAffiliateUrl), false);
  assert.match(html, /class="guide-disclosure/);
  const affiliateQa = validateAffiliateOperations(
    published,
    [{ file: "amazon-us.json", program: configuredAmazonProgram() }],
    { siteDistRoot: join(REPOSITORY_ROOT, "apps", "site", "dist") },
  );
  assert.equal(
    affiliateQa.coverage.find(({ productId }) => productId === original.id)?.destination,
    directAffiliateUrl,
  );
  assert.equal(
    affiliateQa.errors.some(({ productId }) => productId === original.id),
    false,
  );

  const untaggedUrl = "https://www.amazon.com/dp/B012345678?utm_source=studio";
  await fetch(`${origin}${slotPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ directAffiliateUrl: untaggedUrl }),
  });
  saved = guideDraftSchema.parse(await store.read(draft.id));
  savedRecommendation = saved.recommendations.find(({ id }) => id === original.id)!;
  assert.equal(savedRecommendation.directAffiliateUrl, untaggedUrl);
  assert.equal(savedRecommendation.directAffiliateUrl.includes("tag="), false);
  const editorWithWarning = await (await fetch(`${origin}/drafts/${draft.id}`)).text();
  assert.match(editorWithWarning, /No se detectó un tag afiliado/);

  for (const invalid of [
    "http://www.amazon.com/dp/B012345678",
    "https://amazon.com.evil.test/dp/B012345678",
  ]) {
    const response = await fetch(`${origin}${slotPath}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ directAffiliateUrl: invalid }),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(
    guideDraftSchema
      .parse(await store.read(draft.id))
      .recommendations.find(({ id }) => id === original.id)!.directAffiliateUrl,
    untaggedUrl,
  );

  const removedResponse = await fetch(`${origin}${slotPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(),
    redirect: "manual",
  });
  assert.equal(removedResponse.status, 303);
  assert.equal(removedResponse.headers.get("location"), slotAnchor);
  savedRecommendation = guideDraftSchema
    .parse(await store.read(draft.id))
    .recommendations.find(({ id }) => id === original.id)!;
  assert.equal(savedRecommendation.directAffiliateUrl, undefined);
  assert.deepEqual(savedRecommendation, untouchedRecommendation);
  const previewAfterRemoval = await (await fetch(`${origin}/drafts/${draft.id}/preview`)).text();
  assert.doesNotMatch(previewAfterRemoval, />View on Amazon<\/a>/);
  assert.equal(providerCalls, 0);
  assert.equal(discoveryCalls, 0);
});

test("deriva identidad pública concisa sin convertir el título observado en copy", () => {
  const product = productSchema.parse({
    schemaVersion: 1,
    id: "product_observed-title-display",
    name: "Trail Fuel - 40 Count Electrolyte Tablets | 320mg Sodium | Fast Recovery Claims",
    merchant: "Amazon",
    shortDescription: "An observed provider snippet with ratings, performance, and usage claims.",
    priceLabel: "$19.99 observed",
    status: "active",
  });
  assert.equal(productDisplayName(product), "Trail Fuel Electrolyte Tablets");
  assert.notEqual(productDisplayName(product), product.name);
  assert.match(product.name, /40 Count|320mg|Fast Recovery/);
});

test("permite hechos verificados y bloquea claims observados en copy Product-backed", async () => {
  const baseContent = new ProductCatalog().read();
  const product = productSchema.parse({
    schemaVersion: 1,
    id: "product_verified-copy-discipline",
    name: "Trail Socks | Odor Resistant Listing Claim",
    merchant: "Example merchant",
    shortDescription: "An observed odor resistant option for demanding field work.",
    verifiedFacts: ["Material: merino wool"],
    status: "active",
  });
  const content = { ...baseContent, products: [...baseContent.products, product] };
  const selected = await selectedGuideDraft("guide_verified-copy-discipline");
  const slot = selected.recommendations[0]!;
  const draft = selectRecommendationProduct(selected, slot.id, product.id, content);
  const response = {
    id: slot.id,
    productId: product.id,
    position: slot.position,
    heading: productDisplayName(product),
    editorialDescription:
      "Its verified merino wool material gives the recommendation a grounded detail.",
    whyItFits: "The choice fits the recipient's established routine.",
  };
  const providerFor = (editorialDescription: string): GuideGenerationProvider => ({
    providerId: "verified-copy-fixture",
    async generateStructured<T>(): Promise<T> {
      return { ...response, editorialDescription } as T;
    },
  });

  const verified = await regenerateRecommendation(
    draft,
    slot.id,
    content,
    providerFor(response.editorialDescription),
  );
  assert.equal(verified.recommendations[0]!.productId, product.id);
  assert.match(verified.recommendations[0]!.editorialDescription!, /merino wool/i);
  await assert.rejects(
    regenerateRecommendation(
      draft,
      slot.id,
      content,
      providerFor("Its odor resistant construction is ideal for demanding field work."),
    ),
    /verifiedFacts/,
  );
});

test("publica por ID estable, conserva publishedAt y rechaza conflictos antes de escribir", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-publication-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const publisher = new Publisher(repository);
  const content = publisher.read();
  const existing = content.guides[0]!;
  const changedSlug = `${existing.slug}-revised`;
  const draft = guideDraftSchema.parse({
    ...reopenGuideDraft(existing, content),
    slug: changedSlug,
  });

  const result = await publisher.publishGuide(draft, new Date("2026-08-09T12:00:00.000Z"));
  const saved = JSON.parse(
    await readFile(join(repository, "content", "guides", `${existing.id}.json`), "utf8"),
  );
  assert.equal(result.action, "updated");
  assert.equal(result.file, `content/guides/${existing.id}.json`);
  assert.equal(saved.id, existing.id);
  assert.equal(saved.slug, changedSlug);
  assert.equal(saved.publishedAt, existing.publishedAt);
  assert.equal(saved.updatedAt, "2026-08-09");
  assert.equal(
    (await readdir(join(repository, "content", "guides"))).some((file) => file.endsWith(".tmp")),
    false,
  );

  const conflicting = guideDraftSchema.parse({
    ...(await generateFinalGuide(
      await selectedGuideDraft("guide_conflicting-publication"),
      content,
      new MockGuideGenerationProvider(),
    )),
    slug: changedSlug,
  });
  await assert.rejects(publisher.publishGuide(conflicting), /slug ya pertenece/);
  await assert.rejects(
    readFile(join(repository, "content", "guides", `${conflicting.id}.json`), "utf8"),
    /ENOENT/,
  );

  const canonicalFile = join(repository, "content", "guides", `${existing.id}.json`);
  const beforeInvalidRelationship = await readFile(canonicalFile, "utf8");
  const current = publisher.read();
  const invalidRelationship = guideDraftSchema.parse({
    ...reopenGuideDraft(
      current.guides.find((guide) => guide.id === existing.id)!,
      current,
    ),
    relatedGuideIds: ["guide_missing"],
  });
  await assert.rejects(publisher.publishGuide(invalidRelationship), /no está publicada/);
  assert.equal(await readFile(canonicalFile, "utf8"), beforeInvalidRelationship);
  assert.doesNotThrow(() => readPublicContent(repository));
});

test("el botón Publicar escribe contenido canónico y explica commit y push", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-publish-http-"));
  const draftsDirectory = await mkdtemp(join(tmpdir(), "good-present-publish-drafts-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const store = new DraftStore(draftsDirectory);
  const content = readPublicContent(repository);
  const complete = await generateFinalGuide(
    await selectedGuideDraft("guide_http-publication"),
    content,
    new MockGuideGenerationProvider(),
  );
  await store.save(guideDraftSchema.parse({ ...complete, status: "ready-to-publish" }));
  const server = createStudioServer(
    store,
    new ProductCatalog(repository),
    new MockGuideGenerationProvider(),
    new Publisher(repository),
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await Promise.all([
      rm(repository, { recursive: true, force: true }),
      rm(draftsDirectory, { recursive: true, force: true }),
    ]);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(
    `http://${STUDIO_HOST}:${address.port}/drafts/${complete.id}/publish`,
    {
      method: "POST",
    },
  );
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Contenido creado/);
  assert.match(html, /todavía hay que hacer commit y push/);
  assert.match(html, new RegExp(`content/guides/${complete.id}\\.json`));
  assert.doesNotThrow(() => readPublicContent(repository));
});

test("publicar una guía y enlazarla desde su hub produce ambas páginas reales", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-publish-build-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const publisher = new Publisher(repository);
  const initial = publisher.read();
  const selected = await selectedGuideDraft("guide_editorial-integration");
  const otherSelectedProductIds = new Set(
    selected.recommendations.slice(1).flatMap(({ productId }) => (productId ? [productId] : [])),
  );
  const sharedProductId = initial.guides
    .flatMap(({ recommendations }) => recommendations)
    .map(({ productId }) => productId)
    .find((productId) => productId && !otherSelectedProductIds.has(productId));
  assert.ok(sharedProductId);
  const draft = await generateFinalGuide(
    selectRecommendationProduct(
      selected,
      selected.recommendations[0]!.id,
      sharedProductId,
      initial,
    ),
    initial,
    new MockGuideGenerationProvider(),
    new Date("2026-08-09T13:00:00.000Z"),
  );
  const guideResult = await publisher.publishGuide(draft, new Date("2026-08-09T13:01:00.000Z"));
  const afterGuide = publisher.read();
  const publishedGuide = afterGuide.guides.find((item) => item.id === draft.id)!;
  const cluster = afterGuide.clusters.find((item) => item.id === draft.clusterId)!;
  let clusterDraft = reopenClusterDraft(cluster);
  clusterDraft = addGuideToGroup(
    clusterDraft,
    clusterDraft.navigationGroups[0]!.id,
    draft.id,
    afterGuide,
  );
  await publisher.publishCluster(clusterDraft, new Date("2026-08-09T13:02:00.000Z"));

  const linked = publisher.read();
  const linkedGuide = linked.guides.find((item) => item.id === draft.id)!;
  const revisedGuideSlug = `${linkedGuide.slug}-revised`;
  const guideUpdate = guideDraftSchema.parse({
    ...reopenGuideDraft(linkedGuide, linked),
    slug: revisedGuideSlug,
    title: `${linkedGuide.title} Updated`,
  });
  const guideUpdateResult = await publisher.publishGuide(
    guideUpdate,
    new Date("2026-08-10T13:03:00.000Z"),
  );
  const afterGuideUpdate = publisher.read();
  const finalGuide = afterGuideUpdate.guides.find((item) => item.id === draft.id)!;
  const revisedClusterSlug = `${cluster.slug}-revised`;
  await publisher.publishCluster(
    clusterDraftSchema.parse({
      ...reopenClusterDraft(afterGuideUpdate.clusters.find((item) => item.id === cluster.id)!),
      slug: revisedClusterSlug,
    }),
    new Date("2026-08-10T13:04:00.000Z"),
  );

  const catalog = new ProductCatalog(repository);
  const directProductId = finalGuide.recommendations[0]!.productId;
  assert.ok(directProductId);
  const directProduct = catalog.get(directProductId);
  const otherGuide = publisher
    .read()
    .guides.find(
      (guide) =>
        guide.id !== finalGuide.id &&
        guide.recommendations.some(
          (recommendation) => recommendation.productId === directProduct.id,
        ),
    );
  assert.ok(otherGuide);
  const otherRecommendation = structuredClone(
    otherGuide.recommendations.find(
      (recommendation) => recommendation.productId === directProduct.id,
    )!,
  );
  const { affiliateUrl: _affiliateUrl, ...productWithoutAffiliate } = directProduct;
  const directUrl = "https://example.com/direct-product-only";
  await catalog.save({ ...productWithoutAffiliate, productUrl: directUrl });
  const afterProductUpdate = catalog.read();
  assert.deepEqual(
    afterProductUpdate.guides
      .find((guide) => guide.id === otherGuide.id)!
      .recommendations.find((recommendation) => recommendation.id === otherRecommendation.id),
    otherRecommendation,
  );
  assert.doesNotThrow(() => readPublicContent(repository));

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const output = join(REPOSITORY_ROOT, "apps", "site", "dist");
  const hubHtml = await readFile(join(output, revisedClusterSlug, "index.html"), "utf8");
  const guideHtml = await readFile(
    join(output, revisedClusterSlug, revisedGuideSlug, "index.html"),
    "utf8",
  );
  const otherGuideHtml = await readFile(
    join(output, revisedClusterSlug, otherGuide.slug, "index.html"),
    "utf8",
  );
  assert.equal(guideResult.route, `/${cluster.slug}/${publishedGuide.slug}/`);
  assert.equal(guideUpdateResult.route, `/${cluster.slug}/${revisedGuideSlug}/`);
  assert.equal(finalGuide.id, publishedGuide.id);
  assert.equal(finalGuide.publishedAt, publishedGuide.publishedAt);
  assert.equal(finalGuide.updatedAt, "2026-08-10");
  assert.match(hubHtml, new RegExp(`/${revisedClusterSlug}/${revisedGuideSlug}/`));
  assert.match(guideHtml, new RegExp(`href=["']/${revisedClusterSlug}/["']`));
  assert.match(guideHtml, /Updated/);
  assert.match(guideHtml, new RegExp(directUrl));
  assert.match(otherGuideHtml, new RegExp(directUrl));
  const finalCluster = publisher.read().clusters.find((item) => item.id === cluster.id)!;
  assert.equal(finalCluster.slug, revisedClusterSlug);
  assert.equal(finalCluster.publishedAt, cluster.publishedAt);
  assert.equal(
    finalCluster.navigationGroups.some((group) => group.guideIds.includes(finalGuide.id)),
    true,
  );
  await assert.doesNotReject(
    readFile(join(repository, "content", "guides", `${finalGuide.id}.json`), "utf8"),
  );
  await assert.doesNotReject(
    readFile(join(repository, "content", "clusters", `${cluster.id}.json`), "utf8"),
  );
});

test("configura mock, OpenAI y DeepSeek sin asumir un modelo real", () => {
  assert.deepEqual(resolveAiConfiguration({}), { provider: "mock" });
  const shared = {
    AI_PROVIDER: "openai-compatible",
    AI_API_KEY: "test-secret",
    AI_MODEL: "explicit-test-model",
  };
  const openai = resolveAiConfiguration(shared);
  const deepseek = resolveAiConfiguration({ ...shared, AI_VENDOR: "deepseek" });

  assert.equal(openai.provider, "openai-compatible");
  assert.equal(openai.vendor, "openai");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.timeoutMs, 60_000);
  assert.equal(deepseek.provider, "openai-compatible");
  assert.equal(deepseek.vendor, "deepseek");
  assert.equal(deepseek.baseUrl, "https://api.deepseek.com");
  assert.throws(
    () => resolveAiConfiguration({ ...shared, AI_MODEL: "" }),
    /AI_MODEL es obligatorio/,
  );
  assert.throws(
    () => resolveAiConfiguration({ ...shared, AI_BASE_URL: "https://user:secret@example.com" }),
    /sin credenciales/,
  );
});

test("el adaptador compatible envía JSON mode y valida el objeto exacto", async () => {
  const environment = {
    AI_PROVIDER: "openai-compatible",
    AI_VENDOR: "deepseek",
    AI_API_KEY: "test-secret",
    AI_MODEL: "explicit-test-model",
    AI_TIMEOUT_MS: "500",
  };
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"answer":"ready"}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "request-usage-test" },
      },
    );
  };
  const provider = createGuideGenerationProvider(environment, fakeFetch);
  const schema = z.strictObject({ answer: z.literal("ready") });
  const result = await provider.generateStructured({
    operation: "outline",
    prompt: 'Return JSON shaped like {"answer":"ready"}.',
    input: {},
    schema,
  });
  const body = JSON.parse(String(requestedInit?.body));

  assert.deepEqual(result, { answer: "ready" });
  assert.equal(requestedUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(new Headers(requestedInit?.headers).get("authorization"), "Bearer test-secret");
  assert.equal(body.model, "explicit-test-model");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /JSON/);
  assert.doesNotMatch(String(requestedInit?.body), /test-secret/);
  assert.deepEqual(provider.lastCallMetadata, {
    requestId: "request-usage-test",
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
  });

  const truncated = createGuideGenerationProvider(
    environment,
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: '{"answer":"ready"}' } }],
          usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
        }),
        { status: 200 },
      ),
  );
  await assert.rejects(
    truncated.generateStructured({
      operation: "outline",
      prompt: 'Return JSON shaped like {"answer":"ready"}.',
      input: {},
      schema,
    }),
    (error) => error instanceof ProviderError && error.code === "truncated",
  );
  assert.deepEqual(truncated.lastCallMetadata, {
    inputTokens: 20,
    outputTokens: 30,
    totalTokens: 50,
  });
});

test("rechaza fences, prosa, vacíos, JSON roto y objetos fuera de esquema", () => {
  const schema = z.strictObject({ answer: z.string() });
  assert.deepEqual(parseExactStructuredContent('{"answer":"ok"}', schema), { answer: "ok" });
  for (const content of [
    '```json\n{"answer":"ok"}\n```',
    '{"answer":"ok"} trailing prose',
    "",
    '{"answer":',
    "[]",
  ]) {
    assert.throws(
      () => parseExactStructuredContent(content, schema),
      (error) =>
        (error instanceof ProviderError && error.code.includes("invalid")) ||
        (error instanceof ProviderError && error.code === "empty-response"),
    );
  }
  assert.throws(
    () => parseExactStructuredContent('{"different":"shape"}', schema),
    (error) => error instanceof ProviderError && error.code === "invalid-schema",
  );
});

test("resume rutas Zod sin exponer la respuesta inválida del proveedor", () => {
  const providerSecret = "sk-provider-output-secret";
  const malformed = JSON.stringify({
    batchSynthesis: "Batch fixture.",
    evaluations: [
      {
        candidateId: "candidate_schema-fixture",
        scores: {
          intentDifferentiation: 6,
          editorialUsefulness: 7,
          productDifferentiation: 5,
          audienceClarity: 7,
          seasonalValue: 4,
          commercialPotential: 5,
          visualDistributionPotential: 5,
          productReusePotential: 6,
          thinContentRisk: 4,
          cannibalizationRisk: 5,
          maintenanceCost: 4,
        },
        recommendation: "hold",
        explanation: "Keep this candidate under review.",
        missingEvidence: [],
        productConcentrationRisk: "Review category breadth.",
        catalogVolatility: "Recheck active catalog support.",
        thinContentRiskAction: "",
        cannibalizationRiskAction: "",
      },
    ],
    [providerSecret]: `Bearer ${providerSecret}`,
  });

  assert.throws(
    () => parseExactStructuredContent(malformed, opportunityEvaluationBatchSchema),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "invalid-schema");
      assert.equal(
        error.message,
        "La respuesta del proveedor no cumple el esquema editorial esperado.",
      );
      const summary = error.debugSummary();
      assert.match(
        summary,
        /evaluations\.0\.thinContentRiskAction: expected=string-min-1 received=empty/,
      );
      assert.match(
        summary,
        /evaluations\.0\.cannibalizationRiskAction: expected=string-min-1 received=empty/,
      );
      assert.match(
        summary,
        /\$: expected=no-unexpected-fields received=unexpected-fields\(count=1\)/,
      );
      assert.doesNotMatch(summary, /sk-provider|Bearer|output-secret/);
      assert.doesNotMatch(error.message, /evaluations|RiskAction|sk-provider/);
      return true;
    },
  );
});

test("sanitiza autenticación, rate limit, red, timeout, vacíos y rechazos", async () => {
  const environment = {
    AI_PROVIDER: "openai-compatible",
    AI_VENDOR: "openai",
    AI_API_KEY: "test-secret",
    AI_MODEL: "explicit-test-model",
    AI_TIMEOUT_MS: "10",
  };
  const schema = z.strictObject({ answer: z.string() });
  const request = {
    operation: "outline" as const,
    prompt: 'Return JSON shaped like {"answer":"ok"}.',
    input: {},
    schema,
  };
  const failureFrom = async (fakeFetch: typeof fetch) => {
    try {
      await createGuideGenerationProvider(environment, fakeFetch).generateStructured(request);
      assert.fail("Expected provider failure");
    } catch (error) {
      assert.ok(error instanceof ProviderError);
      return error;
    }
  };

  const authentication = await failureFrom(
    async () =>
      new Response('{"error":"test-secret must never surface"}', {
        status: 401,
        headers: { "x-request-id": "request-test" },
      }),
  );
  assert.equal(authentication.code, "authentication");
  assert.doesNotMatch(authentication.message, /test-secret|must never surface/);
  assert.equal(
    authentication.debugSummary(),
    "code=authentication status=401 requestId=request-test cause=Error",
  );

  const limited = await failureFrom(async () => new Response("limited", { status: 429 }));
  assert.equal(limited.code, "rate-limit");

  const network = await failureFrom(async () => {
    throw new Error("socket unavailable");
  });
  assert.equal(network.code, "network");
  assert.equal(network.cause instanceof Error, true);

  const timeoutFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      const fallback = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
      const rejectOnAbort = () => {
        clearTimeout(fallback);
        reject(signal.reason);
      };
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
  const timeout = await failureFrom(timeoutFetch);
  assert.equal(timeout.code, "timeout");

  for (const [payload, code] of [
    [{ choices: [] }, "empty-response"],
    [{ choices: [{ message: { content: "" } }] }, "empty-response"],
    [{ choices: [{ message: { refusal: "unsafe", content: null } }] }, "refusal"],
    [{ choices: [{ finish_reason: "content_filter", message: { content: null } }] }, "refusal"],
    [
      { choices: [{ finish_reason: "length", message: { content: '{"answer":"ok"}' } }] },
      "truncated",
    ],
  ] as const) {
    const failure = await failureFrom(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    );
    assert.equal(failure.code, code);
  }
});

test("resuelve perfiles de clase dogfood versionados con fallback generico", () => {
  assert.ok(PRODUCT_CLASS_PROFILES.length >= 6);
  assert.equal(
    resolveProductClassProfile("all-weather notebook").classId,
    "weatherproof-field-notebook",
  );
  assert.equal(
    resolveProductClassProfile("large capacity water bladder").classId,
    "hydration-reservoir",
  );
  assert.equal(
    resolveProductClassProfile("everyday compression socks").classId,
    "compression-socks",
  );
  assert.equal(
    resolveProductClassProfile("protective stethoscope case").classId,
    "protective-equipment-case",
  );
  assert.equal(resolveProductClassProfile("unmodeled retirement experience").classId, "generic");
  assert.ok(PRODUCT_CLASS_PROFILES.every(({ version }) => version === 1));
});

test("mantiene dimensiones independientes de encaje y regalo sin total opaco", () => {
  const request = fitSourcingRequest(
    "request_fit-dimensions",
    "source_candidate_fit-dimensions",
    "Weatherproof field notebook",
  );
  const prepared = prepareProductFitEvaluationPrompt(
    [{ request, candidateId: "source_candidate_fit-dimensions" }],
    { content: readPublicContent() },
  );
  assert.match(prepared.prompt, /"editorialFunctionalFit"/);
  assert.match(prepared.prompt, /copy the exact requestId/);
  const output = mockProductFitEvaluation(prepared.input);
  const evaluation = output.evaluations[0]!;
  assert.deepEqual(Object.keys(evaluation.editorialFunctionalFit), [
    "productClassMatch",
    "slotSpecificity",
    "guideRelevance",
    "recipientFit",
    "contextFit",
    "budgetCompatibility",
  ]);
  assert.deepEqual(Object.keys(evaluation.consumerGiftValue), [
    "practicalUsefulness",
    "giftDesirability",
    "giftabilityPresentation",
    "easeOfChoosingCorrectly",
    "compatibilitySelectionRisk",
    "perceivedValue",
    "emotionalRelevanceMemorability",
  ]);
  assert.equal("total" in evaluation, false);
  assert.equal("totalScore" in evaluation, false);
  assert.equal(
    productFitEvaluationBatchSchema.safeParse({ ...output, totalScore: 100 }).success,
    false,
  );
  assert.equal(
    productFitEvaluationBatchSchema.safeParse({
      ...output,
      evaluations: [{ ...evaluation, selectedProductId: "product_forbidden" }],
    }).success,
    false,
  );
  assert.equal(
    productFitEvaluationBatchSchema.safeParse({
      ...output,
      evaluations: [
        {
          ...evaluation,
          editorialFunctionalFit: {
            productClassMatch: evaluation.editorialFunctionalFit.productClassMatch,
          },
        },
      ],
    }).success,
    false,
  );
});

test("evalua candidatos y slots en un solo lote estricto sin canonicalizar, cumplir ni asignar", async () => {
  const requests = [
    fitSourcingRequest(
      "request_fit-batch-one",
      "source_candidate_fit-batch-one",
      "Weatherproof field notebook",
    ),
    fitSourcingRequest(
      "request_fit-batch-two",
      "source_candidate_fit-batch-two",
      "Compression socks",
      { sourceFacts: [], observedPrice: "$24.00" },
    ),
  ];
  const before = structuredClone(requests);
  const mock = new MockGuideGenerationProvider();
  let calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: mock.providerId,
    modelId: mock.modelId,
    lastCallMetadata: {
      requestId: "provider-fit-batch",
      inputTokens: 800,
      outputTokens: 400,
      totalTokens: 1200,
    },
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      calls += 1;
      assert.equal(request.operation, "product-fit-evaluations");
      return mock.generateStructured(request);
    },
  };
  const session = await evaluateProductFitBatch(
    requests.map((request) => ({ request, candidateId: request.sourceCandidates[0]!.id })),
    { content: readPublicContent(), provider, now: new Date("2026-08-11T14:00:00.000Z") },
  );
  assert.equal(calls, 1);
  assert.equal(session.providerCallCount, 1);
  assert.equal(session.candidateCount, 2);
  assert.equal(session.providerUsage?.totalTokens, 1200);
  assert.equal(session.aiInterpretation.evaluations.length, 2);
  assert.equal(session.rankingPolicyVersion, "product-fit-ranking-v1");
  assert.deepEqual(requests, before);
  assert.ok(requests.every(({ status }) => status === "open"));
  assert.ok(requests.every(({ approvedProductIds }) => approvedProductIds.length === 0));
  assert.ok(
    requests.every(({ sourceCandidates }) =>
      sourceCandidates.every(({ canonicalProductId }) => canonicalProductId === undefined),
    ),
  );
  assert.equal(
    session.input.candidates[0]!.providerObservedEvidence.sourceFacts[0],
    "Observed material detail",
  );
  assert.equal(session.input.candidates[0]!.canonicalProductEvidence, undefined);

  const repository = await mkdtemp(join(tmpdir(), "tgp-fit-session-"));
  try {
    const store = new ProductFitEvaluationStore(repository);
    await store.save(session);
    assert.equal(store.list()[0]!.id, session.id);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("ordena con politica v1 inspeccionable y conserva todas las dimensiones", () => {
  const request = fitSourcingRequest(
    "request_fit-ordering",
    "source_candidate_fit-ordering",
    "Insulated tumbler",
  );
  const prepared = prepareProductFitEvaluationPrompt(
    [{ request, candidateId: "source_candidate_fit-ordering" }],
    { content: readPublicContent() },
  );
  const base = mockProductFitEvaluation(prepared.input).evaluations[0]!;
  const stronger = structuredClone(base) as ProductFitEvaluation;
  stronger.candidateId = "source_candidate_fit-stronger";
  stronger.editorialFunctionalFit.productClassMatch = {
    assessment: "positive",
    rationale: "Exact class evidence is visible.",
  };
  stronger.consumerGiftValue.practicalUsefulness = {
    assessment: "positive",
    rationale: "The use is specific and credible.",
  };
  const weaker = structuredClone(base) as ProductFitEvaluation;
  weaker.candidateId = "source_candidate_fit-weaker";
  weaker.editorialFunctionalFit.productClassMatch = {
    assessment: "negative",
    rationale: "The observed result is the wrong class.",
  };
  const ordered = orderProductFitEvaluations([weaker, stronger]);
  assert.equal(ordered[0]!.candidateId, stronger.candidateId);
  assert.equal(PRODUCT_FIT_RANKING_POLICY_V1.automaticWinner, false);
  assert.equal(PRODUCT_FIT_RANKING_POLICY_V1.totalScore, false);
  assert.deepEqual(ordered[0]!.consumerGiftValue, stronger.consumerGiftValue);
});

test("separa repeticion dentro de una guia de reuso entre guias", () => {
  const content = readPublicContent();
  const usedRecommendation = content.guides
    .flatMap(({ recommendations }) => recommendations)
    .find(({ productId }) => productId !== undefined);
  assert.ok(usedRecommendation?.productId);
  const productId = usedRecommendation.productId;
  const base = fitSourcingRequest(
    "request_fit-collection",
    "source_candidate_fit-collection",
    "Insulated tumbler",
  );
  const candidate = base.sourceCandidates[0]!;
  const request = productSourcingRequestSchema.parse({
    ...base,
    sourceCandidates: [
      {
        ...candidate,
        status: "linked-to-product",
        reviewedAt: "2026-08-11T13:00:00.000Z",
        canonicalProductId: productId,
        productSourceId: "source_fit-collection",
      },
    ],
  });
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_fit-evaluation", new Date("2026-08-11T12:00:00.000Z")),
    status: "selecting-products",
    recommendations: [
      {
        id: "slot_fit-collection",
        position: 1,
        slotLabel: "Current selection",
        productId,
        editorialStatus: "needs-generation",
      },
    ],
  });
  const prepared = prepareProductFitEvaluationPrompt([{ request, candidateId: candidate.id }], {
    content,
    drafts: [draft],
  });
  const deterministic = prepared.input.candidates[0]!.deterministicEvidence;
  assert.equal(deterministic.inGuideCanonicalProductRepeat, true);
  assert.ok(deterministic.crossGuideReuseGuideIds.length >= 1);
  assert.ok(deterministic.crossGuideReuseGuideIds.every((id) => id !== draft.id));
  const collection = mockProductFitEvaluation(prepared.input).evaluations[0]!.collectionQuality;
  assert.equal(collection.inGuideDistinctiveness.assessment, "negative");
  assert.ok("repeatedProductClass" in collection);
  assert.ok("repeatedFunctionalRole" in collection);
});

test("crea benchmarks internos consultivos sin seleccionar ni alterar perfiles", async () => {
  const content = readPublicContent();
  const product = content.products[0]!;
  const profilesBefore = structuredClone(PRODUCT_CLASS_PROFILES);
  const benchmark = createEditorialBenchmark(
    {
      canonicalProductId: product.id,
      productClass: "Insulated tumbler",
      context: {
        guideId: "guide_fit-benchmark",
        recommendationSlotId: "slot_fit-benchmark",
        semanticContext: "A useful shift drinkware gift",
      },
      audienceTags: ["nurses"],
      contextTags: ["night shift"],
      editorRationale: "Specific to the routine and easier to choose than generic alternatives.",
      strongFitReasons: ["more-specific", "better-context-fit", "less-generic"],
      attributesOrReasons: ["clear real-world use", "familiar gift presentation"],
      rejectedAlternativeIds: ["source_candidate_rejected-alternative"],
    },
    content.products,
    new Date("2026-08-11T15:00:00.000Z"),
    "benchmark_fit-example",
  );
  assert.equal(editorialBenchmarkSchema.parse(benchmark).canonicalProductId, product.id);
  assert.equal("selectedProductId" in benchmark, false);
  assert.equal("rankingBoost" in benchmark, false);
  assert.equal(
    retireEditorialBenchmark(benchmark, new Date("2026-08-11T16:00:00.000Z")).status,
    "inactive",
  );
  assert.deepEqual(PRODUCT_CLASS_PROFILES, profilesBefore);

  const repository = await mkdtemp(join(tmpdir(), "tgp-benchmark-"));
  try {
    const store = new EditorialBenchmarkStore(repository);
    await store.save(benchmark);
    assert.equal(store.list(content.products)[0]!.status, "active");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }

  const request = fitSourcingRequest(
    "request_fit-benchmark",
    "source_candidate_fit-benchmark",
    "Insulated tumbler",
  );
  const prepared = prepareProductFitEvaluationPrompt(
    [{ request, candidateId: "source_candidate_fit-benchmark" }],
    { content, benchmarks: [benchmark] },
  );
  const summary = prepared.input.candidates[0]!.editorialBenchmarks[0]!;
  assert.equal(summary.benchmarkId, benchmark.id);
  assert.equal(summary.editorRationale, benchmark.editorRationale);
  assert.equal("sourceDiscoverySessionId" in summary, false);
  assert.match(prepared.prompt, /not training data, selection instructions, or ranking boosts/i);
  assert.deepEqual(request.approvedProductIds, []);
});

test("persiste eventos editoriales con referencias estables y valida razones", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "tgp-feedback-events-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const event = createEditorialFeedbackEvent(
    {
      eventType: "candidate-rejected",
      guideId: "guide_feedback-example",
      recommendationId: "slot_feedback-example",
      requestId: "request_feedback-example",
      candidateId: "source_candidate_feedback-example",
      provider: "SerpAPI",
      candidateSourceKind: "serpapi",
      discoveryMode: "amazon",
      productClassProfile: { classId: "insulated-drinkware", version: 1 },
      rankingPolicyVersion: "product-fit-ranking-v1",
      reason: "wrong-product-class",
      rationale: "The result was a phone case rather than drinkware.",
      diagnosticAreas: ["provider-quality", "product-class-profile"],
    },
    new Date("2026-08-11T16:00:00.000Z"),
    "feedback_event_stable-example",
  );
  assert.equal(editorialFeedbackEventSchema.parse(event).candidateId, event.candidateId);
  assert.equal(event.requestId, "request_feedback-example");
  assert.equal(event.productClassProfile?.version, 1);
  assert.equal(event.rankingPolicyVersion, "product-fit-ranking-v1");
  assert.equal(event.discoveryMode, "amazon");
  assert.equal(
    editorialFeedbackEventSchema.safeParse({ ...event, reason: "not-a-reason" }).success,
    false,
  );
  assert.equal(
    editorialFeedbackEventSchema.safeParse({ ...event, recommendationId: "slot/unsafe" }).success,
    false,
  );

  const store = new EditorialFeedbackStore(repository);
  await store.save(event);
  const read = store.list();
  assert.equal(read.length, 1);
  assert.equal(read[0]!.id, event.id);
  assert.equal(read[0]!.candidateId, "source_candidate_feedback-example");
  await assert.rejects(() => store.save(event), /already exists/);
});

test("resume decisiones editoriales con denominadores visibles y sin llamadas de IA", () => {
  const context = {
    guideId: "guide_feedback-summary",
    recommendationId: "slot_feedback-summary",
    requestId: "request_feedback-summary",
    productClassProfile: { classId: "insulated-drinkware", version: 1 },
    rankingPolicyVersion: "product-fit-ranking-v1",
  } as const;
  const events = [
    createEditorialFeedbackEvent({
      ...context,
      eventType: "catalog-product-selected",
      canonicalProductId: "product_feedback-catalog",
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "candidate-approved-for-intake",
      candidateId: "source_candidate_feedback-auto-accepted",
      provider: "SerpAPI",
      candidateSourceKind: "serpapi",
      benchmarkId: "benchmark_feedback-example",
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "candidate-rejected",
      candidateId: "source_candidate_feedback-auto-rejected",
      provider: "SerpAPI",
      candidateSourceKind: "serpapi",
      reason: "provider-results-poor",
      diagnosticAreas: ["provider-quality"],
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "manual-url-supplied-after-automatic-discovery-insufficient",
      candidateId: "source_candidate_feedback-manual",
      provider: "Manual",
      candidateSourceKind: "manual",
      reason: "manual-choice-better",
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "automatic-discovery-invoked",
      provider: "DataForSEO",
      candidateSourceKind: "dataforseo",
      discoveryRound: 1,
      providerInvocationCount: 2,
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "search-again-requested",
      reason: "provider-results-poor",
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "recommendation-left-idea-only",
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "recommendation-published",
      publicationResolution: "idea-only",
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "idea-only-recommendation-resolved",
      canonicalProductId: "product_feedback-later",
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "product-assigned",
      canonicalProductId: "product_feedback-later",
    }),
    createEditorialFeedbackEvent({
      ...context,
      eventType: "product-marked-benchmark",
      canonicalProductId: "product_feedback-later",
      benchmarkId: "benchmark_feedback-example",
    }),
  ];
  const summary = summarizeEditorialFeedback(events);

  assert.equal(summary.eventCount, events.length);
  assert.deepEqual(summary.catalogResolutionRate, { numerator: 1, denominator: 4, rate: 0.25 });
  assert.deepEqual(summary.automaticCandidateAcceptanceRate, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.deepEqual(summary.manualUrlRate, { numerator: 1, denominator: 4, rate: 0.25 });
  assert.deepEqual(summary.ideaOnlyPublicationRate, { numerator: 1, denominator: 1, rate: 1 });
  assert.deepEqual(summary.laterProductResolutionRate, { numerator: 1, denominator: 1, rate: 1 });
  assert.deepEqual(summary.searchAgainRate, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(summary.rejectionReasons["provider-results-poor"], 1);
  assert.deepEqual(summary.providerAcceptanceRate.SerpAPI, {
    accepted: 1,
    rejected: 1,
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.equal(summary.dataForSeoPaidProviderInvocationCount, 2);
  assert.deepEqual(summary.benchmarkCreationRate, { numerator: 1, denominator: 1, rate: 1 });
  assert.deepEqual(summary.benchmarkAssociatedLaterAcceptanceRate, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.equal(summary.diagnosticAreaCounts["provider-quality"], 1);
  assert.equal(EDITORIAL_FEEDBACK_POLICY.onlineLearning, false);
  assert.equal(EDITORIAL_FEEDBACK_POLICY.automaticRankingMutation, false);

  const retired = createEditorialFeedbackEvent({
    eventType: "benchmark-retired",
    canonicalProductId: "product_feedback-later",
    benchmarkId: "benchmark_feedback-example",
  });
  assert.equal(retired.eventType, "benchmark-retired");
});

function strongAutopilotProvider(
  onOperation?: (operation: StructuredGenerationRequest<unknown>["operation"]) => void,
): GuideGenerationProvider {
  const mock = new MockGuideGenerationProvider();
  return {
    providerId: "autopilot-fixture",
    modelId: "autopilot-fixture-v1",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      onOperation?.(request.operation);
      if (request.operation !== "product-fit-evaluations") {
        return mock.generateStructured(request);
      }
      const input = productFitPromptInputSchema.parse(request.input);
      const batch = mockProductFitEvaluation(input);
      for (const evaluation of batch.evaluations) {
        const positive = (rationale: string) => ({ assessment: "positive" as const, rationale });
        evaluation.editorialFunctionalFit.productClassMatch = positive("Exact class evidence.");
        evaluation.editorialFunctionalFit.slotSpecificity = positive("Exact slot purpose.");
        evaluation.editorialFunctionalFit.guideRelevance = positive("Relevant to the Guide.");
        evaluation.consumerGiftValue.practicalUsefulness = positive("Credible practical use.");
        evaluation.consumerGiftValue.giftDesirability = positive("Defensible gift value.");
        evaluation.evidenceOperations.evidenceQuality = positive("Identity evidence is complete.");
        evaluation.collectionQuality.inGuideDistinctiveness = positive("No in-Guide duplicate.");
      }
      return request.schema.parse(batch);
    },
  };
}

function autopilotDraft(id: string, slotId: string, slotLabel = "Hydration reservoir"): GuideDraft {
  const content = readPublicContent();
  return guideDraftSchema.parse({
    ...createGuideDraft(id, new Date("2026-09-06T12:00:00.000Z")),
    status: "selecting-products",
    clusterId: content.clusters[0]!.id,
    slug: id.replace(/^guide_/, "").replaceAll("_", "-"),
    primaryAxis: "recipient",
    primaryIntent: "Choose a useful gift for a demanding work routine.",
    questionnaire: {
      giftCount: 3,
      recipient: "A field professional",
      occasion: "Career milestone",
      budget: "Under $75",
    },
    recommendations: [
      {
        id: slotId,
        position: 1,
        slotLabel,
        slotIntent: `Choose a practical ${slotLabel.toLocaleLowerCase("en-US")}.`,
        searchTerms: [slotLabel.toLocaleLowerCase("en-US")],
        editorialStatus: "needs-generation",
      },
    ],
  });
}

function autopilotRequest(
  draft: GuideDraft,
  candidateIds: readonly string[] = ["source_candidate_autopilot"],
  now = new Date("2026-09-06T12:00:00.000Z"),
  slotId = draft.recommendations[0]!.id,
) {
  const slot = draft.recommendations.find(({ id }) => id === slotId)!;
  const request = createProductSourcingRequest(
    {
      origin: {
        kind: "recommendation-slot",
        guideDraftId: draft.id,
        recommendationSlotId: slot.id,
      },
      intendedRole: slot.slotIntent!,
      requiredCategory: slot.slotLabel,
      audience: "A field professional",
      occasion: "Career milestone",
      budgetContext: "Under $75",
      mustHaveVerifiedFacts: [],
      exclusions: [],
      searchTerms: [slot.slotLabel.toLocaleLowerCase("en-US")],
    },
    now,
    `request_${draft.id.replace(/^guide_/, "")}${slotId === draft.recommendations[0]!.id ? "" : `_${slotId.replace(/^slot_/, "")}`}`,
  );
  const candidates = candidateIds.map((id, index) => {
    const asin = `B0AUTO${String(index + 1).padStart(4, "0")}`;
    return {
      id,
      sourceKind: "serpapi" as const,
      provider: "SerpAPI",
      discoveryMode: "amazon" as const,
      brand: "Field Brand",
      merchant: "Amazon",
      marketplace: "amazon.com",
      externalId: asin,
      sourceUrl: `https://www.amazon.com/dp/${asin}/ref=sr_1_${index + 1}`,
      productUrl: `https://www.amazon.com/dp/${asin}`,
      name: `${slot.slotLabel} ${index + 1}`,
      sourceFacts: [`Observed class: ${slot.slotLabel}`, `Observed ASIN: ${asin}`],
      query: slot.slotLabel,
      observedAt: now.toISOString(),
    };
  });
  const withCandidates = candidates.length
    ? addProductSourceCandidates(request, candidates, now)
    : request;
  return productSourcingRequestSchema.parse({
    ...withCandidates,
    searchPlan: {
      productClass: slot.slotLabel,
      mustHaveAttributes: [],
      usefulAttributes: [slot.slotIntent!],
      exclusions: [],
      queries: [slot.slotLabel, `${slot.slotLabel} field use`],
      providerId: "fixture",
      promptVersion: "product-search-plan-v1",
      plannedAt: now.toISOString(),
    },
  });
}

test("clasifica resultados P.2 por candidate ID sin perder evaluaciones válidas", async () => {
  const draft = autopilotDraft("guide_autopilot-p2-parse", "slot_autopilot-p2-parse");
  const candidateIds = [
    "source_candidate_parse-valid-one",
    "source_candidate_parse-valid-two",
    "source_candidate_parse-invalid",
    "source_candidate_parse-duplicate",
  ] as const;
  const request = autopilotRequest(draft, candidateIds);
  const mock = new MockGuideGenerationProvider();
  const provider: GuideGenerationProvider = {
    providerId: "partial-parser-fixture",
    async generateStructured<T>(generation: StructuredGenerationRequest<T>): Promise<T> {
      const batch = mockProductFitEvaluation(productFitPromptInputSchema.parse(generation.input));
      const byId = new Map(
        batch.evaluations.map((evaluation) => [evaluation.candidateId, evaluation]),
      );
      return generation.schema.parse({
        batchSynthesis: batch.batchSynthesis,
        evaluations: [
          byId.get(candidateIds[1]),
          byId.get(candidateIds[0]),
          { ...byId.get(candidateIds[2]), consumerGiftValue: {} },
          byId.get(candidateIds[3]),
          byId.get(candidateIds[3]),
        ],
      });
    },
  };

  const attempt = await evaluateProductFitBatchAttempt(
    request.sourceCandidates.map(({ id }) => ({ request, candidateId: id })),
    { content: readPublicContent(), drafts: [draft], provider },
  );

  assert.deepEqual(
    attempt.session?.aiInterpretation.evaluations.map(({ candidateId }) => candidateId),
    [candidateIds[0], candidateIds[1]],
  );
  assert.deepEqual(attempt.failures, [
    {
      requestId: request.id,
      candidateId: candidateIds[2],
      code: "schema-invalid-result",
    },
    {
      requestId: request.id,
      candidateId: candidateIds[3],
      code: "malformed-result",
    },
  ]);
  assert.equal(attempt.malformedResultCount, 0);
  await assert.rejects(
    evaluateProductFitBatch(
      request.sourceCandidates.map(({ id }) => ({ request, candidateId: id })),
      { content: readPublicContent(), drafts: [draft], provider },
    ),
    (error) => error instanceof ProviderError && error.code === "invalid-schema",
  );
});

test("Autopilot aplica un gate P.2 conservador, resuelve un ganador claro y rechaza overlap, exclusiones, duplicados y empates", async () => {
  const draft = autopilotDraft("guide_autopilot-gate", "slot_autopilot-gate");
  const request = autopilotRequest(draft, [
    "source_candidate_autopilot-one",
    "source_candidate_autopilot-two",
  ]);
  const provider = strongAutopilotProvider();
  const session = await evaluateProductFitBatch(
    request.sourceCandidates.map(({ id }) => ({ request, candidateId: id })),
    { content: readPublicContent(), drafts: [draft], provider },
  );
  const [first, second] = session.aiInterpretation.evaluations;
  assert.ok(first && second);
  assert.equal(
    assessAutomaticProductCandidate(
      request,
      request.sourceCandidates[0]!,
      first,
      readPublicContent(),
    ).accepted,
    true,
  );

  const wrongClass = structuredClone(first) as ProductFitEvaluation;
  wrongClass.editorialFunctionalFit.productClassMatch = {
    assessment: "negative",
    rationale: "Token overlap points to the wrong Product class.",
  };
  assert.equal(
    assessAutomaticProductCandidate(
      request,
      request.sourceCandidates[0]!,
      wrongClass,
      readPublicContent(),
    ).accepted,
    false,
  );

  const duplicate = structuredClone(first) as ProductFitEvaluation;
  duplicate.collectionQuality.inGuideDistinctiveness = {
    assessment: "negative",
    rationale: "The Product already occupies another slot.",
  };
  assert.equal(
    assessAutomaticProductCandidate(
      request,
      request.sourceCandidates[0]!,
      duplicate,
      readPublicContent(),
    ).accepted,
    false,
  );

  const excludedRequest = productSourcingRequestSchema.parse({
    ...request,
    exclusions: ["Observed class: Hydration reservoir"],
  });
  assert.equal(
    assessAutomaticProductCandidate(
      excludedRequest,
      excludedRequest.sourceCandidates[0]!,
      first,
      readPublicContent(),
    ).accepted,
    false,
  );

  assert.equal(
    chooseAutomaticProductCandidate(request, [first, second], readPublicContent()).candidate,
    undefined,
    "equal candidates must become idea-only rather than a stable-ID tie-break selection",
  );
  second.collectionQuality.inGuideDistinctiveness = {
    assessment: "neutral",
    rationale: "No distinctiveness advantage is established.",
  };
  assert.equal(
    chooseAutomaticProductCandidate(request, [first, second], readPublicContent()).candidate?.id,
    first.candidateId,
  );
});

test("Autopilot crea Product y provenance una vez, cumple I.2, asigna el slot exacto y deja Amazon sin CTA", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-product-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-product", "slot_autopilot-product"),
  );
  await sourcingStore.save(autopilotRequest(draft, ["source_candidate_autopilot-product"]));
  let productExistedBeforeCopy = false;
  const provider = strongAutopilotProvider((operation) => {
    if (operation === "product-editorial-copy") {
      productExistedBeforeCopy = catalog
        .read()
        .products.some(({ name }) => name === "Hydration reservoir 1");
    }
  });
  const beforeProductCount = catalog.read().products.length;
  const result = await resolveRecommendationSlotAutonomously(
    draft,
    "slot_autopilot-product",
    { draftStore, catalog, sourcingStore, sourceStore, fitStore, provider },
    { now: new Date("2026-09-06T13:00:00.000Z") },
  );

  assert.equal(result.status, "resolved-product");
  assert.equal(result.reasonCode, "product-selected");
  assert.equal(result.resolutionStrategy, "existing-candidate");
  assert.equal(result.executionEvidence.amazonDiscoveryAttempted, false);
  assert.equal(result.executionEvidence.providerCallCount, 0);
  assert.equal(result.executionEvidence.p2ProviderCallCount, 1);
  assert.equal(result.executionEvidence.recoveryUsed, false);
  assert.equal(result.executionEvidence.sourcingBudgetExhausted, false);
  assert.equal(result.executionEvidence.candidatesEvaluated, 1);
  assert.equal(
    result.executionEvidence.bestCandidate?.candidateId,
    "source_candidate_autopilot-product",
  );
  assert.deepEqual(result.executionEvidence.bestCandidate?.p2GateFailures, []);
  assert.equal(result.affiliateDestinationStatus, "affiliate-destination-missing");
  assert.equal(productExistedBeforeCopy, true, "Product copy runs only after canonical creation");
  assert.equal(catalog.read().products.length, beforeProductCount + 1);
  const product = catalog.get(result.productId!);
  assert.equal(product.affiliateUrl, undefined);
  assert.equal(productDestination(product), undefined);
  assert.deepEqual(product.verifiedFacts ?? [], []);
  assert.equal(sourceStore.forProduct(product.id, catalog.read().products).length, 1);
  const fulfilled = sourcingStore.get(result.sourcingRequestId);
  assert.equal(fulfilled.status, "fulfilled");
  assert.deepEqual(fulfilled.approvedProductIds, [product.id]);
  const completedDraft = await draftStore.read(draft.id);
  assert.equal(completedDraft.draftType, "gift-guide");
  assert.equal(completedDraft.recommendations[0]!.id, "slot_autopilot-product");
  assert.equal(completedDraft.recommendations[0]!.productId, product.id);
  assert.equal(completedDraft.recommendations[0]!.editorialStatus, "ready");
  assert.equal(
    catalog.read().guides.some(({ id }) => id === draft.id),
    false,
    "no publication",
  );

  const reuseDraft = await draftStore.save(
    autopilotDraft(
      "guide_autopilot-reuse",
      "slot_autopilot-reuse",
      "Hydration reservoir for smoke-jumper packs",
    ),
  );
  await sourcingStore.save(autopilotRequest(reuseDraft, []));
  let catalogReuseDiscoveryCalls = 0;
  const unusedDiscoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search() {
      catalogReuseDiscoveryCalls++;
      return [];
    },
  };
  const reused = await resolveRecommendationSlotAutonomously(
    reuseDraft,
    "slot_autopilot-reuse",
    {
      draftStore,
      catalog,
      sourcingStore,
      sourceStore,
      fitStore,
      provider,
      discoverySource: unusedDiscoverySource,
    },
    { now: new Date("2026-09-06T13:30:00.000Z") },
  );
  assert.equal(reused.status, "resolved-product");
  assert.equal(reused.resolutionStrategy, "catalog-reuse");
  assert.equal(reused.reasonCode, "product-selected");
  assert.ok(reused.executionEvidence.catalogCandidatesConsidered > 0);
  assert.equal(reused.executionEvidence.catalogReuseResult, "product-reused");
  assert.equal(reused.executionEvidence.providerCallCount, 0);
  assert.equal(catalogReuseDiscoveryCalls, 0);
  assert.equal(reused.productId, product.id);
  assert.equal(catalog.read().products.length, beforeProductCount + 1);
  assert.equal(sourceStore.forProduct(product.id, catalog.read().products).length, 1);
  const freshReuseInput = fitStore
    .list()
    .flatMap(({ input }) => input.candidates)
    .find(({ requestId }) => requestId === reused.sourcingRequestId);
  assert.equal(
    freshReuseInput?.requestContext.requiredCategory,
    "Hydration reservoir for smoke-jumper packs",
  );
  assert.equal(freshReuseInput?.canonicalProductEvidence?.productId, product.id);
  const reusedCandidate = sourcingStore
    .get(reused.sourcingRequestId)
    .sourceCandidates.find(({ canonicalProductId }) => canonicalProductId === product.id);
  assert.equal(
    reusedCandidate?.query,
    undefined,
    "catalog reuse must not invent a discovery query",
  );
});

test("Autopilot mantiene discovery y P.2 en el slot exacto y rechaza overlap de otra clase", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-slot-scope-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-neck-scope", "slot_autopilot-neck-scope", "UPF Neck Gaiter"),
  );
  const targetRequest = autopilotRequest(draft, []);
  await sourcingStore.save(targetRequest);

  const electrolyteDraft = autopilotDraft(
    "guide_autopilot-electrolyte-scope",
    "slot_autopilot-electrolyte-scope",
    "Electrolyte Tablets",
  );
  const electrolyteRequest = autopilotRequest(electrolyteDraft, [
    "source_candidate_autopilot-electrolyte-scope",
  ]);
  await sourcingStore.save(
    productSourcingRequestSchema.parse({
      ...electrolyteRequest,
      sourceCandidates: electrolyteRequest.sourceCandidates.map((candidate) => ({
        ...candidate,
        query: "UPF Neck Gaiter",
      })),
      searchPlan: {
        ...electrolyteRequest.searchPlan!,
        queries: ["UPF Neck Gaiter"],
      },
    }),
  );

  const discoveryQueries: string[] = [];
  const discoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search(input) {
      discoveryQueries.push(input.query);
      assert.match(input.query, /neck gaiter/i);
      assert.doesNotMatch(input.query, /electrolyte/i);
      return [
        {
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          marketplace: "amazon.com",
          externalId: "B0WRONG001",
          sourceUrl: "https://www.amazon.com/dp/B0WRONG001",
          productUrl: "https://www.amazon.com/dp/B0WRONG001",
          name: "Cooling electrolyte tablets for hot outdoor work",
          sourceFacts: ["Observed form: electrolyte tablets"],
          query: input.query,
          observedAt: input.observedAt,
        },
        {
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          marketplace: "amazon.com",
          externalId: "B0GAITER01",
          sourceUrl: "https://www.amazon.com/dp/B0GAITER01",
          productUrl: "https://www.amazon.com/dp/B0GAITER01",
          name: "UPF neck gaiter for sun and dust protection",
          sourceFacts: ["Observed form: neck gaiter", "Observed claim: UPF sun protection"],
          query: input.query,
          observedAt: input.observedAt,
        },
      ];
    },
  };
  const baseProvider = strongAutopilotProvider();
  let p2Calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "slot-scope-fixture",
    modelId: "slot-scope-fixture-v1",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation !== "product-fit-evaluations") {
        return baseProvider.generateStructured(request);
      }
      p2Calls++;
      assert.match(request.prompt, /"editorialFunctionalFit"/);
      const input = productFitPromptInputSchema.parse(request.input);
      for (const candidate of input.candidates) {
        assert.equal(candidate.requestId, targetRequest.id);
        assert.equal(candidate.requestContext.requiredCategory, "UPF Neck Gaiter");
        assert.equal(candidate.requestContext.plannedProductClass, "UPF Neck Gaiter");
        assert.equal(candidate.requestContext.intendedRole, draft.recommendations[0]!.slotIntent);
        assert.equal(candidate.productClassProfile.classId, "generic");
      }
      const batch = productFitEvaluationBatchSchema.parse(
        await baseProvider.generateStructured(request),
      );
      const wrong = batch.evaluations.find((evaluation) => {
        const observed = input.candidates.find(
          ({ candidateId }) => candidateId === evaluation.candidateId,
        );
        return observed?.providerObservedEvidence.name.includes("electrolyte");
      });
      assert.ok(wrong);
      wrong.editorialFunctionalFit.productClassMatch = {
        assessment: "negative",
        rationale: "Electrolyte tablets are not a neck-gaiter Product class.",
      };
      return request.schema.parse(batch);
    },
  };

  const result = await resolveRecommendationSlotAutonomously(
    draft,
    "slot_autopilot-neck-scope",
    { draftStore, catalog, sourcingStore, sourceStore, fitStore, provider, discoverySource },
    { now: new Date("2026-09-06T13:45:00.000Z") },
  );

  assert.equal(result.status, "resolved-product");
  assert.equal(result.reasonCode, "product-selected");
  assert.equal(result.resolutionStrategy, "amazon-discovery");
  assert.equal(discoveryQueries.length, 1);
  assert.equal(p2Calls, 1);
  assert.equal(result.executionEvidence.candidatesEvaluated, 2);
  assert.match(result.executionEvidence.bestCandidate!.name, /neck gaiter/i);
  const scoped = sourcingStore.get(result.sourcingRequestId);
  assert.equal(scoped.origin.kind, "recommendation-slot");
  assert.ok(
    scoped.sourceCandidates.every(
      ({ id }) => id !== "source_candidate_autopilot-electrolyte-scope",
    ),
  );
  assert.equal(result.discoveryAttempts[0]!.status, "stored");
  assert.equal(result.discoveryAttempts[0]!.providerCalls, 1);
});

test("Autopilot reintenta el mismo lote completo tras una respuesta P.2 inválida", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-p2-recovery-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-p2-recovery", "slot_autopilot-p2-recovery", "UPF Neck Gaiter"),
  );
  const candidateIds = [
    "source_candidate_partial-one",
    "source_candidate_partial-two",
    "source_candidate_partial-three",
    "source_candidate_partial-recovered",
  ] as const;
  await sourcingStore.save(autopilotRequest(draft, candidateIds));

  const strong = strongAutopilotProvider();
  const p2Inputs: Array<z.infer<typeof productFitPromptInputSchema>> = [];
  const provider: GuideGenerationProvider = {
    providerId: "partial-recovery-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation !== "product-fit-evaluations") {
        return strong.generateStructured(request);
      }
      const input = productFitPromptInputSchema.parse(request.input);
      p2Inputs.push(input);
      const batch = productFitEvaluationBatchSchema.parse(await strong.generateStructured(request));
      if (p2Inputs.length === 1) {
        batch.evaluations = batch.evaluations
          .filter(({ candidateId }) => candidateId !== candidateIds[3])
          .reverse();
      }
      for (const evaluation of batch.evaluations) {
        if (evaluation.candidateId === candidateIds[3]) continue;
        evaluation.editorialFunctionalFit.productClassMatch = {
          assessment: "negative",
          rationale: "Fixture candidates deliberately fail the Product class gate.",
        };
      }
      return request.schema.parse(batch);
    },
  };

  const result = await resolveRecommendationSlotAutonomously(draft, "slot_autopilot-p2-recovery", {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });

  assert.equal(result.status, "resolved-product");
  assert.equal(result.reasonCode, "product-selected");
  assert.equal(result.candidateId, candidateIds[3]);
  assert.deepEqual(
    p2Inputs.map(({ candidates }) => candidates.map(({ candidateId }) => candidateId)),
    [[...candidateIds], [...candidateIds]],
  );
  assert.deepEqual(p2Inputs[1], p2Inputs[0]);
  assert.equal(result.executionEvidence.candidatesEvaluated, 4);
  assert.equal(result.executionEvidence.p2ProviderCallCount, 2);
  assert.equal(result.executionEvidence.p2RecoveryAttempted, true);
  assert.equal(result.executionEvidence.candidatesRecovered, 1);
  assert.deepEqual(result.executionEvidence.p2Attempts, [
    {
      kind: "primary",
      candidatesSent: 4,
      candidatesEvaluated: 3,
      candidatesFailed: 1,
      unmappedMalformedResults: 0,
      candidateResults: candidateIds.map((candidateId) => ({
        candidateId,
        status: candidateId === candidateIds[3] ? "missing-result" : "valid",
      })),
    },
    {
      kind: "recovery",
      candidatesSent: 4,
      candidatesEvaluated: 4,
      candidatesFailed: 0,
      unmappedMalformedResults: 0,
      candidateResults: candidateIds.map((candidateId) => ({ candidateId, status: "valid" })),
    },
  ]);
  assert.deepEqual(result.executionEvidence.candidateEvaluationFailures, []);
  assert.ok(!result.warnings.includes("candidate-evaluation-partial-failure"));
  assert.deepEqual(
    fitStore
      .list()
      .map(({ candidateCount }) => candidateCount)
      .sort((left, right) => left - right),
    [4],
  );
});

test("Autopilot reintenta una respuesta P.2 con schema inválido una sola vez", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-p2-schema-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-p2-schema", "slot_autopilot-p2-schema"),
  );
  await sourcingStore.save(autopilotRequest(draft, ["source_candidate_autopilot-p2-schema"]));
  const strong = strongAutopilotProvider();
  let p2Calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "schema-recovery-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation !== "product-fit-evaluations") {
        return strong.generateStructured(request);
      }
      p2Calls++;
      if (p2Calls === 1) throw new ProviderError("Fixture invalid schema.", "invalid-schema");
      return strong.generateStructured(request);
    },
  };

  const result = await resolveRecommendationSlotAutonomously(draft, draft.recommendations[0]!.id, {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });

  assert.equal(result.status, "resolved-product");
  assert.equal(p2Calls, AUTOPILOT_LIMITS.maxP2ProviderCalls);
  assert.equal(result.executionEvidence.p2RecoveryAttempted, true);
  assert.equal(result.executionEvidence.candidatesRecovered, 1);
  assert.equal(result.executionEvidence.sourcingBudgetExhausted, false);
  assert.deepEqual(
    result.executionEvidence.p2Attempts.map(({ kind }) => kind),
    ["primary", "recovery"],
  );
});

test("Autopilot descarta una respuesta parcial cuando falla el reintento completo", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-p2-partial-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-p2-partial", "slot_autopilot-p2-partial", "UPF Neck Gaiter"),
  );
  const candidateIds = [
    "source_candidate_partial-fail-one",
    "source_candidate_partial-fail-two",
    "source_candidate_partial-fail-three",
    "source_candidate_partial-fail-four",
  ] as const;
  await sourcingStore.save(autopilotRequest(draft, candidateIds));

  const mock = new MockGuideGenerationProvider();
  let p2Calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "partial-failure-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation !== "product-fit-evaluations") {
        return mock.generateStructured(request);
      }
      p2Calls++;
      if (p2Calls === 2) throw new ProviderError("Fixture recovery timeout.", "timeout");
      const batch = mockProductFitEvaluation(productFitPromptInputSchema.parse(request.input));
      batch.evaluations = batch.evaluations.slice(0, 3).reverse();
      return request.schema.parse(batch);
    },
  };

  const result = await resolveRecommendationSlotAutonomously(draft, "slot_autopilot-p2-partial", {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });

  assert.equal(result.status, "resolved-idea-only");
  assert.equal(result.reasonCode, "evaluation-infrastructure-failed");
  assert.equal(result.executionEvidence.candidatesEvaluated, 0);
  assert.equal(result.executionEvidence.p2ProviderCallCount, 2);
  assert.equal(result.executionEvidence.p2RecoveryAttempted, true);
  assert.equal(result.executionEvidence.candidatesRecovered, 0);
  assert.deepEqual(result.executionEvidence.p2Attempts, [
    {
      kind: "primary",
      candidatesSent: 4,
      candidatesEvaluated: 3,
      candidatesFailed: 1,
      unmappedMalformedResults: 0,
      candidateResults: candidateIds.map((candidateId) => ({
        candidateId,
        status: candidateId === candidateIds[3] ? "missing-result" : "valid",
      })),
    },
    {
      kind: "recovery",
      candidatesSent: 4,
      candidatesEvaluated: 0,
      candidatesFailed: 4,
      unmappedMalformedResults: 0,
      candidateResults: candidateIds.map((candidateId) => ({
        candidateId,
        status: "provider-failure",
      })),
    },
  ]);
  assert.deepEqual(
    result.executionEvidence.candidateEvaluationFailures.map(({ candidateId, reasonCode }) => ({
      candidateId,
      reasonCode,
    })),
    candidateIds.map((candidateId) => ({ candidateId, reasonCode: "provider-failure" })),
  );
  assert.ok(result.warnings.includes("candidate-evaluation-failed"));
  assert.equal(result.executionEvidence.bestCandidate, undefined);
  assert.deepEqual(fitStore.list(), []);
});

test("Autopilot usa falla de infraestructura sólo con cero evaluaciones tras la recuperación", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-p2-zero-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-p2-zero", "slot_autopilot-p2-zero", "UPF Neck Gaiter"),
  );
  const missingCandidateId = "source_candidate_zero-valid";
  await sourcingStore.save(autopilotRequest(draft, [missingCandidateId]));

  const mock = new MockGuideGenerationProvider();
  let p2Calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "zero-valid-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation !== "product-fit-evaluations") {
        return mock.generateStructured(request);
      }
      p2Calls++;
      if (p2Calls === 2) throw new ProviderError("Fixture provider failure.", "network");
      return request.schema.parse({
        batchSynthesis: "The fixture deliberately omits the selected candidate.",
        evaluations: [],
      });
    },
  };

  const result = await resolveRecommendationSlotAutonomously(draft, "slot_autopilot-p2-zero", {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });

  assert.equal(result.status, "resolved-idea-only");
  assert.equal(result.reasonCode, "evaluation-infrastructure-failed");
  assert.equal(result.executionEvidence.candidatesEvaluated, 0);
  assert.equal(result.executionEvidence.p2ProviderCallCount, 2);
  assert.equal(result.executionEvidence.bestCandidate, undefined);
  assert.deepEqual(result.executionEvidence.p2Attempts, [
    {
      kind: "primary",
      candidatesSent: 1,
      candidatesEvaluated: 0,
      candidatesFailed: 1,
      unmappedMalformedResults: 0,
      candidateResults: [{ candidateId: missingCandidateId, status: "missing-result" }],
    },
    {
      kind: "recovery",
      candidatesSent: 1,
      candidatesEvaluated: 0,
      candidatesFailed: 1,
      unmappedMalformedResults: 0,
      candidateResults: [{ candidateId: missingCandidateId, status: "provider-failure" }],
    },
  ]);
  assert.deepEqual(result.executionEvidence.candidateEvaluationFailures, [
    {
      candidateId: missingCandidateId,
      name: "UPF Neck Gaiter 1",
      reasonCode: "provider-failure",
    },
  ]);
  assert.ok(result.warnings.includes("candidate-evaluation-failed"));
  assert.ok(!result.warnings.includes("candidate-evaluation-partial-failure"));
  assert.deepEqual(fitStore.list(), []);
});

test("Autopilot agota como máximo una llamada P.2 y una recuperación técnica por slot", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-p2-bound-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-p2-bound", "slot_autopilot-p2-bound", "UPF Neck Gaiter"),
  );
  await sourcingStore.save(autopilotRequest(draft, ["source_candidate_p2-bound-initial"]));

  const mock = new MockGuideGenerationProvider();
  let p2Calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "p2-bound-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation !== "product-fit-evaluations") {
        return mock.generateStructured(request);
      }
      p2Calls++;
      if (p2Calls === 1) {
        return request.schema.parse({
          batchSynthesis: "The initial candidate is deliberately omitted.",
          evaluations: [],
        });
      }
      if (p2Calls === 2) throw new ProviderError("Fixture recovery failure.", "network");
      return request.schema.parse(
        mockProductFitEvaluation(productFitPromptInputSchema.parse(request.input)),
      );
    },
  };
  let discoveryCalls = 0;
  const discoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search(input) {
      discoveryCalls++;
      const asin = `B0BOUND${String(discoveryCalls).padStart(3, "0")}`;
      return [
        {
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          marketplace: "amazon.com",
          externalId: asin,
          sourceUrl: `https://www.amazon.com/dp/${asin}`,
          productUrl: `https://www.amazon.com/dp/${asin}`,
          name: `UPF neck gaiter bound fixture ${discoveryCalls}`,
          sourceFacts: ["Observed class: neck gaiter"],
          query: input.query,
          observedAt: input.observedAt,
        },
      ];
    },
  };

  const result = await resolveRecommendationSlotAutonomously(draft, "slot_autopilot-p2-bound", {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
    discoverySource,
  });

  assert.equal(result.status, "resolved-idea-only");
  assert.equal(result.reasonCode, "evaluation-infrastructure-failed");
  assert.equal(discoveryCalls, 0);
  assert.equal(p2Calls, AUTOPILOT_LIMITS.maxP2ProviderCalls);
  assert.equal(
    result.executionEvidence.p2Attempts.filter(({ kind }) => kind === "recovery").length,
    AUTOPILOT_LIMITS.maxP2RecoveryCalls,
  );
  assert.deepEqual(
    result.executionEvidence.p2Attempts.map(({ kind }) => kind),
    ["primary", "recovery"],
  );
  assert.equal(result.executionEvidence.sourcingBudgetExhausted, true);
});

test("Autopilot termina tras un rechazo P.2 sin repetir búsqueda ni refinamiento", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-idea-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-idea", "slot_autopilot-idea", "UPF neck gaiter"),
  );
  const empty = autopilotRequest(draft, []);
  await sourcingStore.save(empty);
  const queries: string[] = [];
  const discoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search(input) {
      queries.push(input.query);
      const asin = `B0WEAK${String(queries.length).padStart(4, "0")}`;
      return [
        {
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          merchant: "Amazon",
          marketplace: "amazon.com",
          externalId: asin,
          sourceUrl: `https://www.amazon.com/dp/${asin}/ref=search`,
          productUrl: `https://www.amazon.com/dp/${asin}`,
          name: `Electrolyte tablets overlap fixture ${queries.length}`,
          sourceFacts: ["Observed class: electrolyte tablets"],
          query: input.query,
          observedAt: input.observedAt,
        },
      ];
    },
  };
  const beforeProducts = catalog.read().products.length;
  const result = await resolveRecommendationSlotAutonomously(
    draft,
    "slot_autopilot-idea",
    {
      draftStore,
      catalog,
      sourcingStore,
      sourceStore,
      fitStore,
      provider: new MockGuideGenerationProvider(),
      discoverySource,
    },
    { now: new Date("2026-09-06T14:00:00.000Z") },
  );

  assert.equal(result.status, "resolved-idea-only");
  assert.equal(result.reasonCode, "no-candidate-passed-product-gate");
  assert.equal(queries.length, 1);
  assert.equal(result.discoveryAttempts.length, 1);
  assert.equal(
    result.executionEvidence.catalogCandidatesConsidered,
    catalogMatchesForRequest(empty, catalog.read().products, AUTOPILOT_LIMITS.maxCatalogCandidates)
      .length,
  );
  assert.equal(result.executionEvidence.recentSourceCandidatesConsidered, 0);
  assert.equal(result.executionEvidence.amazonDiscoveryAttempted, true);
  assert.equal(result.executionEvidence.providerCallCount, 1);
  assert.equal(result.executionEvidence.candidatesReturned, 1);
  assert.equal(result.executionEvidence.candidatesEvaluated, 1);
  assert.equal(result.executionEvidence.p2ProviderCallCount, 1);
  assert.equal(result.executionEvidence.recoveryUsed, false);
  assert.equal(result.executionEvidence.searchRefinementAttempted, false);
  assert.equal(result.executionEvidence.sourcingBudgetExhausted, false);
  assert.ok(result.executionEvidence.bestCandidate);
  assert.ok(result.executionEvidence.bestCandidate.p2GateFailures.length > 0);
  assert.equal(
    result.discoveryAttempts.reduce((sum, attempt) => sum + attempt.providerCalls, 0),
    1,
  );
  assert.equal(catalog.read().products.length, beforeProducts);
  assert.equal(sourcingStore.get(result.sourcingRequestId).status, "completed-idea-only");
  const completed = await draftStore.read(draft.id);
  assert.equal(completed.draftType, "gift-guide");
  const slot = completed.recommendations[0]!;
  assert.equal(slot.id, "slot_autopilot-idea");
  assert.equal(slot.productId, undefined);
  assert.equal(slot.editorialStatus, "ready");
  assert.doesNotMatch(JSON.stringify(slot), /Amazon|ASIN|Electrolyte|\$|https?:\/\//i);
});

test("Autopilot puede reintentar un Product pendiente sin recrear el slot", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-retry-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-retry", "slot_autopilot-retry", "Insulated tumbler"),
  );
  const firstRequest = await sourcingStore.save(
    autopilotRequest(draft, ["source_candidate_autopilot-retry"]),
  );

  const fallback = await resolveRecommendationSlotAutonomously(
    draft,
    "slot_autopilot-retry",
    {
      draftStore,
      catalog,
      sourcingStore,
      sourceStore,
      fitStore,
      provider: new MockGuideGenerationProvider(),
    },
    { now: new Date("2026-09-06T15:00:00.000Z") },
  );
  assert.equal(fallback.status, "resolved-idea-only");
  const pendingDraft = guideDraftSchema.parse(await draftStore.read(draft.id));
  const pendingSlot = pendingDraft.recommendations[0]!;
  assert.equal(pendingSlot.editorialStatus, "ready");
  assert.equal(pendingSlot.productId, undefined);
  assert.equal(guideDraftReadiness(pendingDraft).editorialComplete, true);
  assert.equal(guideDraftReadiness(pendingDraft).productComplete, false);

  const retryDiscovery: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search(input) {
      return [
        {
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          merchant: "Amazon",
          marketplace: "amazon.com",
          externalId: "B0RETRY001",
          sourceUrl: "https://www.amazon.com/dp/B0RETRY001",
          productUrl: "https://www.amazon.com/dp/B0RETRY001",
          name: "Insulated tumbler retry fixture",
          sourceFacts: ["Observed class: insulated tumbler"],
          query: input.query,
          observedAt: input.observedAt,
        },
      ];
    },
  };
  const retry = await resolveRecommendationSlotAutonomously(
    pendingDraft,
    pendingSlot.id,
    {
      draftStore,
      catalog,
      sourcingStore,
      sourceStore,
      fitStore,
      provider: strongAutopilotProvider(),
      discoverySource: retryDiscovery,
    },
    { now: new Date("2026-09-06T16:00:00.000Z") },
  );
  assert.equal(retry.status, "resolved-product");
  assert.notEqual(retry.sourcingRequestId, firstRequest.id);
  assert.equal(sourcingStore.get(firstRequest.id).status, "completed-idea-only");
  assert.equal(sourcingStore.get(retry.sourcingRequestId).status, "fulfilled");
  const resolvedDraft = guideDraftSchema.parse(await draftStore.read(draft.id));
  const resolvedSlot = resolvedDraft.recommendations[0]!;
  assert.equal(resolvedDraft.id, pendingDraft.id);
  assert.equal(resolvedSlot.id, pendingSlot.id);
  assert.equal(resolvedSlot.position, pendingSlot.position);
  assert.equal(resolvedSlot.slotIntent, pendingSlot.slotIntent);
  assert.ok(resolvedSlot.productId);
  assert.equal(resolvedSlot.editorialStatus, "ready");
});

test("un Product pendiente admite backfill de catálogo y P.1 sin cambiar la identidad", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-pending-backfill-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const makePendingDraft = async (id: string, slotId: string) => {
    const base = autopilotDraft(id, slotId, "Insulated tumbler");
    const ready = updateRecommendationEditorialCopy(
      base,
      slotId,
      {
        heading: "A practical hydration upgrade",
        editorialDescription: "Choose a durable format that fits the recipient's daily routine.",
        whyItFits: "It is useful even before a specific Product is selected.",
        selectionGuidance: "Compare capacity, care, and portability.",
      },
      true,
    );
    await draftStore.save(ready);
    const request = autopilotRequest(ready, []);
    await sourcingStore.save(
      completeProductSourcingRequestAsIdeaOnly(request, new Date("2026-09-06T17:00:00.000Z")),
    );
    return { draft: ready, request };
  };
  const catalogPending = await makePendingDraft("guide_catalog-backfill", "slot_catalog-backfill");
  const p1Pending = await makePendingDraft("guide_p1-backfill", "slot_p1-backfill");
  const server = createStudioServer(
    draftStore,
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const curationHtml = await (
    await fetch(`${origin}/drafts/${catalogPending.draft.id}/curation`)
  ).text();
  assert.match(curationHtml, /Editorialmente lista · Product pendiente/);
  assert.match(curationHtml, /Resolver automáticamente/);
  assert.match(curationHtml, /Usar Product existente/);
  assert.match(curationHtml, /Pegar URL/);
  assert.doesNotMatch(curationHtml, /Sourcing integrado: completed-idea-only/);

  const catalogProduct = catalog.get("product_insulated-tumbler");
  const catalogResponse = await fetch(
    `${origin}/drafts/${catalogPending.draft.id}/curation/use-product`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        slotId: "slot_catalog-backfill",
        productId: catalogProduct.id,
      }),
      redirect: "manual",
    },
  );
  assert.equal(catalogResponse.status, 303);
  const catalogBackfilled = guideDraftSchema.parse(await draftStore.read(catalogPending.draft.id));
  const catalogSlot = catalogBackfilled.recommendations[0]!;
  assert.equal(catalogSlot.id, "slot_catalog-backfill");
  assert.equal(catalogSlot.position, 1);
  assert.equal(catalogSlot.slotIntent, catalogPending.draft.recommendations[0]!.slotIntent);
  assert.equal(catalogSlot.productId, catalogProduct.id);
  assert.equal(catalogSlot.editorialStatus, "needs-review");
  assert.equal(sourcingStore.get(catalogPending.request.id).status, "completed-idea-only");
  const catalogFollowUp = findProductSourcingRequestForDraftSlot(
    sourcingStore.list(),
    catalogPending.draft.id,
    catalogSlot.id,
  )!;
  assert.notEqual(catalogFollowUp.id, catalogPending.request.id);
  assert.equal(catalogFollowUp.status, "fulfilled");

  const asin = "R123456789";
  const urlResponse = await fetch(
    `${origin}/drafts/${p1Pending.draft.id}/recommendations/slot_p1-backfill/resolve-url`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: `https://www.amazon.com/dp/${asin}` }),
      redirect: "manual",
    },
  );
  assert.equal(urlResponse.status, 303);
  assert.match(urlResponse.headers.get("location")!, /^\/products\/intake\?/);
  const p1Request = findProductSourcingRequestForDraftSlot(
    sourcingStore.list(),
    p1Pending.draft.id,
    "slot_p1-backfill",
  )!;
  assert.notEqual(p1Request.id, p1Pending.request.id);
  assert.equal(p1Request.status, "open");
  const candidate = p1Request.sourceCandidates[0]!;
  const input = manualProductIntakeInput({
    productUrl: `https://www.amazon.com/dp/${asin}`,
    asin,
    name: "P.1 backfill tumbler",
  });
  const intakeResponse = await fetch(`${origin}/products/intake`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: manualProductIntakeForm(input, {
      requestId: p1Request.id,
      candidateId: candidate.id,
      confirmIdentity: "yes",
      confirmProvenance: "yes",
      confirmFacts: "yes",
      confirmDescription: "yes",
      confirm: "yes",
    }),
    redirect: "manual",
  });
  assert.equal(intakeResponse.status, 303);
  const p1Product = catalog.read().products.find(({ name }) => name === input.name)!;
  assert.ok(p1Product);
  const fulfillResponse = await fetch(`${origin}/product-sourcing/${p1Request.id}/products`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ productId: p1Product.id, fulfillmentStatus: "fulfilled" }),
    redirect: "manual",
  });
  assert.equal(fulfillResponse.status, 303);
  const assignResponse = await fetch(`${origin}/product-sourcing/${p1Request.id}/assign`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ productId: p1Product.id }),
    redirect: "manual",
  });
  assert.equal(assignResponse.status, 303);
  const p1Backfilled = guideDraftSchema.parse(await draftStore.read(p1Pending.draft.id));
  const p1Slot = p1Backfilled.recommendations[0]!;
  assert.equal(p1Backfilled.id, p1Pending.draft.id);
  assert.equal(p1Slot.id, "slot_p1-backfill");
  assert.equal(p1Slot.position, 1);
  assert.equal(p1Slot.slotIntent, p1Pending.draft.recommendations[0]!.slotIntent);
  assert.equal(p1Slot.productId, p1Product.id);
  assert.equal(p1Slot.editorialStatus, "needs-review");
  assert.equal(sourcingStore.get(p1Pending.request.id).status, "completed-idea-only");
});

test("Autopilot reintenta una falla técnica de discovery una sola vez", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-timeout-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-timeout", "slot_autopilot-timeout", "Trail radio"),
  );
  await sourcingStore.save(autopilotRequest(draft, []));
  let providerCalls = 0;
  const discoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search() {
      providerCalls++;
      throw new ProductDiscoveryError("fixture timeout", "timeout");
    },
  };

  const result = await resolveRecommendationSlotAutonomously(
    draft,
    "slot_autopilot-timeout",
    {
      draftStore,
      catalog,
      sourcingStore,
      sourceStore,
      fitStore,
      provider: new MockGuideGenerationProvider(),
      discoverySource,
    },
    { now: new Date("2026-09-06T14:30:00.000Z") },
  );

  assert.equal(result.status, "resolved-idea-only");
  assert.equal(result.reasonCode, "amazon-provider-timeout");
  assert.match(result.reasonExplanation, /tiempo de espera/i);
  assert.equal(providerCalls, AUTOPILOT_LIMITS.maxDiscoveryCalls);
  assert.equal(result.executionEvidence.amazonDiscoveryAttempted, true);
  assert.equal(result.executionEvidence.providerCallCount, providerCalls);
  assert.equal(result.executionEvidence.candidatesReturned, 0);
  assert.equal(result.executionEvidence.searchRefinementAttempted, false);
  assert.equal(result.executionEvidence.discoveryRecoveryAttempted, true);
  assert.equal(result.executionEvidence.recoveryUsed, true);
  assert.equal(result.executionEvidence.sourcingBudgetExhausted, true);
});

test("Autopilot usa copy determinista y específico cuando falla la generación idea-only", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-copy-failure-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const slotLabel = "Impact-Resistant Polarized Sunglasses";
  const longAudience =
    "Friends and family choosing for a field professional who works long outdoor shifts";
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...autopilotDraft("guide_autopilot-copy-failure", "slot_autopilot-copy-failure", slotLabel),
      questionnaire: {
        giftCount: 3,
        recipient: longAudience,
        occasion: "Career milestone",
        budget: "Under $75",
      },
    }),
  );
  await sourcingStore.save(
    productSourcingRequestSchema.parse({
      ...autopilotRequest(draft, ["source_candidate_autopilot-copy-failure"]),
      mustHaveVerifiedFacts: ["A deliberately unavailable verified fact"],
    }),
  );
  const mock = new MockGuideGenerationProvider();
  const provider: GuideGenerationProvider = {
    providerId: "idea-copy-failure-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation === "idea-recommendation") {
        throw new ProviderError("Fixture idea-copy timeout.", "timeout");
      }
      return mock.generateStructured(request);
    },
  };

  const result = await resolveRecommendationSlotAutonomously(draft, draft.recommendations[0]!.id, {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });
  const completed = guideDraftSchema.parse(await draftStore.read(draft.id));
  const slot = completed.recommendations[0]!;
  const editorialFields = [
    slot.heading,
    slot.editorialDescription,
    slot.whyItFits,
    slot.bestFor,
    slot.selectionGuidance,
    slot.considerations,
  ].join(" ");

  assert.equal(result.status, "resolved-idea-only");
  assert.equal(result.reasonCode, "no-candidate-passed-product-gate");
  assert.ok(result.actionsPerformed.includes("generated-safe-idea-only-fallback"));
  assert.ok(result.warnings.some((warning) => warning.startsWith("idea-copy-provider-failure ")));
  assert.ok(result.warnings.includes("idea-editorial-copy-fallback-used"));
  assert.match(slot.heading!, new RegExp(slotLabel));
  assert.ok(slot.editorialDescription);
  assert.ok(slot.whyItFits);
  assert.ok(slot.bestFor);
  assert.ok(slot.selectionGuidance);
  assert.ok(slot.considerations);
  assert.equal(slot.productId, undefined);
  assert.equal(slot.editorialStatus, "ready");
  assert.doesNotMatch(
    editorialFields,
    /A practical gift idea|Field Brand|Amazon|B0AUTO0001|https?:|ASIN|this slot|Product class|recommendation'?s purpose|structured input|editorial system/i,
  );
  assert.doesNotMatch(slot.heading!, new RegExp(longAudience));
});

test("Autopilot reintenta P.2 una vez sin sumar discovery y la UI explica cero candidatos", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-autopilot-failure-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const draft = await draftStore.save(
    autopilotDraft("guide_autopilot-failure", "slot_autopilot-failure"),
  );
  await sourcingStore.save(autopilotRequest(draft, ["source_candidate_autopilot-failure"]));
  const mock = new MockGuideGenerationProvider();
  const provider: GuideGenerationProvider = {
    providerId: "autopilot-evaluation-failure",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation === "product-fit-evaluations") throw new Error("fixture failure");
      return mock.generateStructured(request);
    },
  };
  let requiredDiscoveryCalls = 0;
  const requiredDiscoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search() {
      requiredDiscoveryCalls++;
      return [];
    },
  };
  const result = await resolveRecommendationSlotAutonomously(draft, "slot_autopilot-failure", {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
    discoverySource: requiredDiscoverySource,
  });
  assert.equal(result.status, "resolved-idea-only");
  assert.equal(result.reasonCode, "evaluation-infrastructure-failed");
  assert.ok(result.warnings.includes("candidate-evaluation-failed"));
  assert.equal(result.executionEvidence.candidatesEvaluated, 0);
  assert.equal(result.executionEvidence.bestCandidate, undefined);
  assert.equal(result.executionEvidence.p2ProviderCallCount, AUTOPILOT_LIMITS.maxP2ProviderCalls);
  assert.equal(result.executionEvidence.p2RecoveryAttempted, true);
  assert.equal(result.executionEvidence.sourcingBudgetExhausted, true);
  assert.equal(requiredDiscoveryCalls, 0, "P.2 infrastructure recovery owns the second call");
  assert.equal(result.executionEvidence.amazonDiscoveryAttempted, false);

  const uiDraft = await draftStore.save(autopilotDraft("guide_autopilot-ui", "slot_autopilot-ui"));
  let emptyProviderCalls = 0;
  const emptyDiscoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search() {
      emptyProviderCalls++;
      return [];
    },
  };
  const server = createStudioServer(
    draftStore,
    catalog,
    new MockGuideGenerationProvider(),
    new Publisher(repository),
    sourceStore,
    undefined,
    [],
    undefined,
    undefined,
    emptyDiscoverySource,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const curation = await (await fetch(`${origin}/drafts/${uiDraft.id}/curation`)).text();
  assert.match(curation, /Resolver automáticamente/);
  const response = await fetch(
    `${origin}/drafts/${uiDraft.id}/recommendations/slot_autopilot-ui/autopilot`,
    { method: "POST" },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(emptyProviderCalls, 1);
  assert.match(html, /Editorialmente lista · Product pendiente/);
  assert.match(html, /podés agregar el Product ahora o más adelante/);
  assert.match(html, /amazon-no-candidates/);
  assert.match(html, /Evidencia compacta de ejecución/);
  assert.match(html, /Llamadas P\.2/);
  assert.match(html, /Recuperación P\.2/);
  assert.match(html, /<li>no-evaluable-candidate<\/li>/);
  assert.doesNotMatch(html, /Mejor candidato/);
  assert.doesNotMatch(html, /Evaluaciones no recuperadas/);
  assert.doesNotMatch(html, /Advertencias no bloqueantes/);
  assert.doesNotMatch(html, /<ul>\s*<\/ul>/);
});

test("detecta sólo las señales estrechas del fallback histórico", () => {
  const audience =
    "Friends, family, and romantic partners choosing for a field professional with long outdoor shifts";
  const slot = {
    ...autopilotDraft("guide_legacy-copy-signals", "slot_legacy-copy-signals").recommendations[0]!,
    heading: "Extra capacity for long shifts",
    editorialDescription: "A useful idea for demanding days outdoors.",
    whyItFits: "It makes a long routine a little easier.",
    selectionGuidance: "Compare fit, care, and ease of use.",
    considerations: "Personal preferences may matter most.",
    editorialStatus: "ready" as const,
  };

  assert.equal(
    recommendationHasLegacyIdeaFallback(
      { ...slot, heading: `Hydration for ${audience}` },
      audience,
    ),
    true,
  );
  assert.equal(
    recommendationHasLegacyIdeaFallback(
      { ...slot, editorialDescription: "Choose among hydration options for long shifts." },
      audience,
    ),
    true,
  );
  assert.equal(
    recommendationHasLegacyIdeaFallback(
      {
        ...slot,
        whyItFits: "It supports this recommendation's purpose: carry extra water.",
      },
      audience,
    ),
    true,
  );
  assert.equal(
    recommendationHasLegacyIdeaFallback(
      {
        ...slot,
        considerations:
          "Confirm personal fit, compatibility, and care requirements before choosing.",
      },
      audience,
    ),
    true,
  );
  assert.equal(
    recommendationHasLegacyIdeaFallback(
      {
        ...slot,
        editorialDescription: `${slot.slotLabel} can make a thoughtful gift when it matches the recipient's real routine and preferences.`,
      },
      audience,
    ),
    true,
  );
  assert.equal(recommendationHasLegacyIdeaFallback(slot, audience), false);
});

test("Guide Autopilot preserva una guía resuelta, omite sourcing y muestra un resumen compacto", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-guide-autopilot-ready-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourceStore = new ProductSourceStore(repository);
  const providerOperations: string[] = [];
  const provider = strongAutopilotProvider((operation) => providerOperations.push(operation));
  const generatedComplete = await generateFinalGuide(
    await selectedGuideDraft("guide_guide-autopilot-ready"),
    catalog.read(),
    new MockGuideGenerationProvider(),
  );
  const manualMetadata = {
    excerpt: "Manual guide excerpt.",
    introduction: "Manual guide introduction.",
    seoTitle: "Manual guide SEO title",
    seoDescription: "Manual guide SEO description.",
  };
  const complete = guideDraftSchema.parse({ ...generatedComplete, ...manualMetadata });
  const productWithoutDestination = catalog.get(complete.recommendations[0]!.productId!);
  const {
    productUrl: _productUrl,
    affiliateUrl: _affiliateUrl,
    ...withoutDestination
  } = productWithoutDestination;
  await catalog.save(withoutDestination);
  const saved = await draftStore.save(complete);
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);

  const result = await completeGuideAutonomously(saved, {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reasonCode, "guide-completed");
  assert.equal(result.counts.totalRecommendations, 3);
  assert.equal(result.counts.editorialReady, 3);
  assert.equal(result.counts.productResolved, 3);
  assert.equal(result.counts.productPending, 0);
  assert.ok(result.counts.affiliatePending >= 1, "missing affiliate coverage cannot block success");
  assert.equal(result.execution.externalDiscoveryCalls, 0);
  assert.equal(result.execution.p2Calls, 0);
  assert.equal(result.execution.editorialCalls, 0);
  assert.equal(result.execution.peakConcurrentSlots, 1);
  assert.equal(providerOperations.length, 0);
  assert.equal(sourcingStore.list().length, 0);
  assert.deepEqual(await draftStore.read(saved.id), saved);
  assert.deepEqual(
    {
      excerpt: saved.excerpt,
      introduction: saved.introduction,
      seoTitle: saved.seoTitle,
      seoDescription: saved.seoDescription,
    },
    manualMetadata,
  );
  assert.ok(
    result.slots.every(
      ({ action, status }) =>
        action === "preserved-ready-product-slot" && status === "product-resolved",
    ),
  );
  guideAutopilotOutcomeSchema.parse(result);

  const publicGuide = guideDraftToPublic(saved, catalog.read());
  assert.doesNotMatch(
    JSON.stringify(publicGuide),
    /singleSlotResult|sourcingRequestId|reasonCode|externalDiscoveryCalls/i,
  );

  const server = createStudioServer(
    draftStore,
    catalog,
    provider,
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;
  const curation = await (await fetch(`${origin}/drafts/${saved.id}/curation`)).text();
  assert.match(curation, /Completar guía automáticamente/);
  assert.match(curation, new RegExp(`/drafts/${saved.id}/autopilot`));
  assert.match(curation, /Regeneración enfocada/);
  assert.match(curation, /Buscar alternativas/);
  const response = await fetch(`${origin}/drafts/${saved.id}/autopilot`, { method: "POST" });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Guía completada automáticamente/);
  assert.match(html, /Editorial:<\/strong> 3\/3 listas/);
  assert.match(html, /Products:<\/strong> 3 resueltos · 0 pendientes/);
  assert.match(
    html,
    new RegExp(
      `Afiliación:<\\/strong> ${result.counts.affiliateReady} listas · ${result.counts.affiliatePending} pendientes`,
    ),
  );
  assert.match(html, /Estado editorial de la guía:<\/strong> completa/);
  assert.match(html, /Llamadas de discovery externo<\/dt><dd>0/);
  assert.match(html, /Llamadas LLM para planificar búsquedas<\/dt><dd>0/);
  assert.match(html, /Invocaciones P\.2<\/dt><dd>0/);
  assert.match(html, /Invocaciones editoriales<\/dt><dd>0/);
  assert.match(html, /Invocaciones de metadata de guía<\/dt><dd>0/);
  assert.match(html, /Reintentos técnicos<\/dt><dd>0/);
  assert.doesNotMatch(html, /Advertencias no bloqueantes/);
  assert.doesNotMatch(html, /<ul>\s*<\/ul>/);
});

test("Guide Autopilot completa metadata, repara copy histórico y filtra claims no verificados sin sourcing", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-guide-autopilot-copy-repair-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const sparseProduct = productSchema.parse({
    schemaVersion: 1,
    id: "product_sparse-claims",
    name: "Trail Hydration Tablets | 40 Count | 320mg Sodium",
    merchant: "Amazon",
    productUrl: "https://www.amazon.com/dp/B0SPARSE01",
    shortDescription:
      "A quick-dissolving 40-count tablet pack with 320mg sodium for demanding exercise.",
    priceLabel: "$19.99 observed",
    status: "active",
  });
  await catalog.save(sparseProduct);
  const base = await generateFinalGuide(
    await selectedGuideDraft("guide_guide-autopilot-copy-repair"),
    catalog.read(),
    new MockGuideGenerationProvider(),
  );
  const {
    excerpt: _excerpt,
    introduction: _introduction,
    seoTitle: _seoTitle,
    seoDescription: _seoDescription,
    ...withoutGeneratedMetadata
  } = base;
  const [legacy, specific, productBacked] = base.recommendations;
  const specificCopy = {
    heading: "Calorie-Dense Meal Pouches Variety Pack",
    editorialDescription: "Choose a practical format that fits the recipient's routine.",
    whyItFits: "It keeps convenient meal variety close during demanding days.",
    bestFor: "Someone who values convenient meals during demanding days.",
    selectionGuidance: "Compare dietary fit, preparation needs, and pack variety.",
    considerations: "Confirm dietary preferences before choosing.",
  };
  const manualTitle = "Manual field-ready gift guide";
  const manualConclusion = "A manually written conclusion that must remain unchanged.";
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...withoutGeneratedMetadata,
      title: manualTitle,
      conclusion: manualConclusion,
      recommendations: [
        {
          id: legacy!.id,
          position: legacy!.position,
          slotLabel: "Impact-Resistant Polarized Sunglasses",
          slotIntent: "Support eye comfort around bright light and airborne dust.",
          searchTerms: ["polarized eye protection"],
          heading: "A practical gift idea",
          editorialDescription: "Amazon candidate B0LEAK0001 from Field Brand.",
          whyItFits: "https://www.amazon.com/dp/B0LEAK0001",
          bestFor: "$39.99 live price",
          selectionGuidance: "Candidate-specific selection copy.",
          considerations: "ASIN B0LEAK0001",
          editorialStatus: "ready",
        },
        {
          id: specific!.id,
          position: specific!.position,
          slotLabel: "Calorie-Dense Meal Pouches Variety Pack",
          slotIntent: "Offer convenient meal variety.",
          searchTerms: ["meal pouch variety"],
          ...specificCopy,
          editorialStatus: "ready",
        },
        {
          id: productBacked!.id,
          position: productBacked!.position,
          slotLabel: "Hydration support for long outdoor shifts",
          slotIntent: "Offer an easy-to-carry hydration option for demanding days.",
          searchTerms: ["portable hydration option"],
          productId: sparseProduct.id,
          heading: sparseProduct.name,
          editorialDescription: `${sparseProduct.name} from ${sparseProduct.merchant}. ${sparseProduct.shortDescription}`,
          whyItFits: "The 320mg sodium formulation supports demanding exercise.",
          bestFor: "Someone who wants a quick-dissolving 40-count supply.",
          considerations: "The observed listing says it dissolves quickly.",
          editorialPromptVersion: "single-recommendation-v2",
          editorialStatus: "ready",
        },
      ],
    }),
  );
  const pendingRequest = autopilotRequest(
    draft,
    ["source_candidate_guide-autopilot-copy-repair"],
    new Date("2026-09-08T12:00:00.000Z"),
    legacy!.id,
  );
  await sourcingStore.save(pendingRequest);
  const providerOperations: string[] = [];
  let metadataMissingFields: string[] = [];
  let productPrompt:
    z.infer<typeof recommendationPromptInputSchema>["recommendation"]["product"] | undefined;
  const strongProvider = strongAutopilotProvider();
  const provider: GuideGenerationProvider = {
    providerId: "guide-copy-polish-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      providerOperations.push(request.operation);
      if (request.operation === "guide-metadata") {
        metadataMissingFields = guideMetadataPromptInputSchema.parse(request.input).missingFields;
      }
      if (request.operation === "single-recommendation") {
        const input = recommendationPromptInputSchema.parse(request.input);
        if (input.recommendation.product.id === sparseProduct.id) {
          productPrompt = structuredClone(input.recommendation.product);
        }
      }
      return strongProvider.generateStructured(request);
    },
  };
  const sourceCount = sourceStore.list(catalog.read().products).length;
  const requestSnapshot = structuredClone(sourcingStore.list());

  const first = await completeGuideAutonomously(draft, {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });
  const repaired = guideDraftSchema.parse(await draftStore.read(draft.id));
  const repairedLegacy = repaired.recommendations[0]!;
  const preservedSpecific = repaired.recommendations[1]!;
  const conservativeProduct = repaired.recommendations[2]!;
  const editorialFields = [
    repairedLegacy.heading,
    repairedLegacy.editorialDescription,
    repairedLegacy.whyItFits,
    repairedLegacy.bestFor,
    repairedLegacy.selectionGuidance,
    repairedLegacy.considerations,
  ].join(" ");
  const productBody = [
    conservativeProduct.editorialDescription,
    conservativeProduct.whyItFits,
    conservativeProduct.bestFor,
    conservativeProduct.considerations,
  ].join(" ");

  assert.equal(first.status, "completed");
  assert.equal(first.counts.editorialReady, 3);
  assert.equal(first.counts.productResolved, 1);
  assert.equal(first.counts.productPending, 2);
  assert.equal(
    first.slots.find(({ slotId }) => slotId === legacy!.id)!.action,
    "repaired-generic-idea-copy",
  );
  assert.equal(
    first.slots.find(({ slotId }) => slotId === specific!.id)!.action,
    "preserved-ready-product-pending-slot",
  );
  assert.equal(
    first.slots.find(({ slotId }) => slotId === productBacked!.id)!.action,
    "completed-product-copy",
  );
  assert.match(repairedLegacy.heading!, /Impact-Resistant Polarized Sunglasses/);
  assert.ok(repairedLegacy.bestFor);
  assert.ok(repairedLegacy.selectionGuidance);
  assert.ok(repairedLegacy.considerations);
  assert.doesNotMatch(
    editorialFields,
    /A practical gift idea|Amazon|Field Brand|B0LEAK0001|https?:|\$39\.99|ASIN|this slot|Product class|recommendation'?s purpose|structured input|editorial system/i,
  );
  assert.doesNotMatch(
    repairedLegacy.heading!,
    new RegExp(draft.questionnaire.recipient ?? "this cannot match"),
  );
  assert.deepEqual(
    {
      heading: preservedSpecific.heading,
      editorialDescription: preservedSpecific.editorialDescription,
      whyItFits: preservedSpecific.whyItFits,
      bestFor: preservedSpecific.bestFor,
      selectionGuidance: preservedSpecific.selectionGuidance,
      considerations: preservedSpecific.considerations,
    },
    specificCopy,
  );
  assert.equal(repaired.title, manualTitle);
  assert.equal(repaired.conclusion, manualConclusion);
  assert.ok(repaired.excerpt);
  assert.ok(repaired.introduction);
  assert.ok(repaired.seoTitle);
  assert.ok(repaired.seoDescription);
  assert.deepEqual(metadataMissingFields.sort(), [
    "excerpt",
    "introduction",
    "seoDescription",
    "seoTitle",
  ]);
  assert.deepEqual(validateGuideDraft(repaired, catalog.read()).errors, []);
  assert.equal(conservativeProduct.productId, sparseProduct.id);
  assert.equal(conservativeProduct.heading, productDisplayName(sparseProduct));
  assert.equal(conservativeProduct.editorialStatus, "ready");
  assert.equal(conservativeProduct.editorialPromptVersion, "single-recommendation-v4");
  assert.doesNotMatch(
    productBody,
    /Amazon|320\s*mg|40[- ]?count|quick-dissolving|dissolves quickly/i,
  );
  assert.deepEqual(productPrompt, {
    id: sparseProduct.id,
    name: productDisplayName(sparseProduct),
  });
  assert.deepEqual(providerOperations, [
    "guide-metadata",
    "idea-recommendation-batch",
    "single-recommendation",
  ]);
  assert.equal(first.execution.externalDiscoveryCalls, 0);
  assert.equal(first.execution.productPlanningCalls, 0);
  assert.equal(first.execution.p2Calls, 0);
  assert.equal(first.execution.editorialCalls, 2);
  assert.equal(first.execution.guideMetadataCalls, 1);
  assert.deepEqual(sourcingStore.list(), requestSnapshot);
  assert.equal(sourceStore.list(catalog.read().products).length, sourceCount);
  assert.equal(first.counts.affiliateReady, Number(Boolean(productDestination(sparseProduct))));
  assert.equal(first.counts.affiliatePending, 1 - first.counts.affiliateReady);

  const publicGuide = guideDraftToPublic(repaired, catalog.read());
  assert.equal(publicGuide.recommendations[0]!.heading, repairedLegacy.heading);
  assert.doesNotMatch(
    JSON.stringify(publicGuide),
    /A practical gift idea|singleSlotResult|sourcingRequestId|reasonCode|executionEvidence|sourceCandidates|verifiedFacts|generationMetadata|editorialPromptVersion/i,
  );

  providerOperations.length = 0;
  const second = await completeGuideAutonomously(repaired, {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });
  assert.equal(second.status, "completed");
  assert.equal(second.execution.editorialCalls, 0);
  assert.equal(second.execution.externalDiscoveryCalls, 0);
  assert.equal(second.execution.p2Calls, 0);
  assert.deepEqual(await draftStore.read(draft.id), repaired);
  assert.deepEqual(providerOperations, []);
  assert.deepEqual(sourcingStore.list(), requestSnapshot);

  const server = createStudioServer(
    draftStore,
    catalog,
    provider,
    new Publisher(repository),
    sourceStore,
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const curation = await (
    await fetch(`http://${STUDIO_HOST}:${address.port}/drafts/${draft.id}/curation`)
  ).text();
  assert.match(curation, /Editorial:<\/strong> 3\/3 listas/);
  assert.match(curation, /Products:<\/strong> 1 resueltos · 2 pendientes/);
  assert.match(
    curation,
    new RegExp(
      `Afiliación:<\\/strong> ${first.counts.affiliateReady} listas · ${first.counts.affiliatePending} pendientes`,
    ),
  );
  assert.match(curation, /Estado editorial de la guía:<\/strong> completa/);
  assert.match(curation, /Intentar monetizar Products/);
  assert.match(curation, new RegExp(`/drafts/${draft.id}/autopilot/products`));
  assert.match(curation, /Resolver automáticamente/);
  assert.doesNotMatch(curation, /completamente lista/);
  const preview = await (
    await fetch(`http://${STUDIO_HOST}:${address.port}/drafts/${draft.id}/preview`)
  ).text();
  assert.match(preview, new RegExp(productDisplayName(sparseProduct)));
  assert.equal(preview.includes(sparseProduct.name), false);
  assert.equal(preview.includes(sparseProduct.shortDescription), false);
  assert.equal(preview.includes(sparseProduct.priceLabel!), false);
});

test("Guide Autopilot completa una guía mixta sin sourcing y converge sin sobrescribir copy manual", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-guide-autopilot-mixed-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const now = new Date("2026-09-07T12:00:00.000Z");
  const base = await generateFinalGuide(
    await selectedGuideDraft("guide_guide-autopilot-mixed", 4),
    catalog.read(),
    new MockGuideGenerationProvider(),
    now,
  );
  const [preservedProduct, productCopy, preservedIdea, unresolved] = base.recommendations;
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...base,
      recommendations: [
        {
          ...preservedProduct!,
          editorialPromptVersion: MANUAL_EDITORIAL_COPY_VERSION,
          heading: "Manual Product heading",
          editorialDescription: "Manual Product description that must remain byte-for-byte.",
          whyItFits: "Manual Product rationale that must remain byte-for-byte.",
        },
        {
          ...productCopy!,
          heading: "Stale Product heading",
          editorialStatus: "needs-review",
        },
        {
          id: preservedIdea!.id,
          position: preservedIdea!.position,
          slotLabel: "Guide Autopilot Pending Idea",
          slotIntent: "Keep this useful while Product enrichment remains pending.",
          searchTerms: ["pending guide idea"],
          heading: "Manual generic heading",
          editorialDescription: "Manual generic description with no Product-specific claims.",
          whyItFits: "Manual generic rationale remains useful without a Product.",
          selectionGuidance: "Compare fit, care, and everyday usefulness.",
          considerations: "Confirm personal preferences before choosing.",
          editorialStatus: "ready",
        },
        {
          id: unresolved!.id,
          position: unresolved!.position,
          slotLabel: "Guide Autopilot Strong Unique Item",
          slotIntent: "Resolve one trustworthy and distinct Product.",
          searchTerms: ["guide autopilot strong unique item"],
          editorialStatus: "needs-generation",
        },
      ],
    }),
    now,
  );
  assert.equal(draft.recommendations[0]!.editorialPromptVersion, MANUAL_EDITORIAL_COPY_VERSION);
  const weakRequest = productSourcingRequestSchema.parse({
    ...autopilotRequest(draft, ["source_candidate_guide-autopilot-weak"], now, preservedIdea!.id),
    mustHaveVerifiedFacts: ["A deliberately unavailable verified fact"],
  });
  const strongRequest = autopilotRequest(
    draft,
    ["source_candidate_guide-autopilot-strong"],
    now,
    unresolved!.id,
  );
  await sourcingStore.save(weakRequest);
  await sourcingStore.save(strongRequest);
  const requestSnapshot = structuredClone(sourcingStore.list());
  const providerOperations: string[] = [];
  const strongProvider = strongAutopilotProvider();
  const ordinaryProvider = new MockGuideGenerationProvider();
  const provider: GuideGenerationProvider = {
    providerId: "guide-autopilot-selective-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      providerOperations.push(request.operation);
      if (request.operation === "product-fit-evaluations") {
        const input = productFitPromptInputSchema.parse(request.input);
        if (input.candidates.every(({ requestId }) => requestId !== strongRequest.id)) {
          return ordinaryProvider.generateStructured(request);
        }
      }
      return strongProvider.generateStructured(request);
    },
  };

  const first = await completeGuideAutonomously(
    draft,
    { draftStore, catalog, sourcingStore, sourceStore, fitStore, provider },
    { now },
  );
  const completed = guideDraftSchema.parse(await draftStore.read(draft.id));
  const completedById = new Map(completed.recommendations.map((slot) => [slot.id, slot]));

  assert.equal(first.status, "completed", JSON.stringify(first));
  assert.deepEqual(first.counts, {
    totalRecommendations: 4,
    editorialReady: 4,
    productResolved: 2,
    productPending: 2,
    affiliateReady: first.counts.affiliateReady,
    affiliatePending: 2 - first.counts.affiliateReady,
    genericRecommendations: 2,
    slotsWithWarnings: 0,
  });
  assert.equal(first.execution.productPendingFallbacks, 0);
  assert.equal(first.execution.productsCreated + first.execution.productsReused, 0);
  assert.equal(first.execution.editorialCalls, 2);
  assert.equal(first.execution.externalDiscoveryCalls, 0);
  assert.equal(first.execution.productPlanningCalls, 0);
  assert.equal(first.execution.p2Calls, 0);
  assert.equal(first.execution.maxConcurrentSlots, GUIDE_AUTOPILOT_MAX_CONCURRENT_SLOTS);
  assert.equal(completedById.get(preservedProduct!.id)!.heading, "Manual Product heading");
  assert.equal(
    completedById.get(preservedProduct!.id)!.editorialDescription,
    "Manual Product description that must remain byte-for-byte.",
  );
  assert.notEqual(completedById.get(productCopy!.id)!.heading, "Stale Product heading");
  assert.equal(completedById.get(productCopy!.id)!.editorialStatus, "ready");
  assert.equal(completedById.get(preservedIdea!.id)!.heading, "Manual generic heading");
  assert.equal(completedById.get(preservedIdea!.id)!.productId, undefined);
  assert.doesNotMatch(
    JSON.stringify(completedById.get(preservedIdea!.id)),
    /Field Brand|Amazon|Guide Autopilot Pending Idea 1/i,
  );
  assert.equal(completedById.get(unresolved!.id)!.productId, undefined);
  assert.equal(completedById.get(unresolved!.id)!.editorialStatus, "ready");
  assert.equal(
    providerOperations.filter((operation) => operation === "idea-recommendation-batch").length,
    1,
    "only the incomplete idea slot needs idea-only copy",
  );
  assert.equal(
    providerOperations.filter((operation) => operation === "single-recommendation").length,
    1,
    "only the existing Product-backed copy needing work is generated",
  );
  assert.equal(
    first.slots.find(({ slotId }) => slotId === preservedIdea!.id)!.action,
    "preserved-ready-product-pending-slot",
  );
  assert.equal(
    first.slots.find(({ slotId }) => slotId === unresolved!.id)!.action,
    "repaired-generic-idea-copy",
  );
  assert.equal(
    first.slots.find(({ slotId }) => slotId === unresolved!.id)!.singleSlotResult,
    undefined,
  );
  assert.deepEqual(sourcingStore.list(), requestSnapshot);
  assert.deepEqual(fitStore.list(), []);

  const productCount = catalog.read().products.length;
  const sourceCount = sourceStore.list(catalog.read().products).length;
  const requestCount = sourcingStore.list().length;
  providerOperations.length = 0;
  const second = await completeGuideAutonomously(
    completed,
    { draftStore, catalog, sourcingStore, sourceStore, fitStore, provider },
    { now: new Date("2026-09-08T12:00:00.000Z") },
  );
  const converged = guideDraftSchema.parse(await draftStore.read(draft.id));

  assert.equal(second.status, "completed");
  assert.deepEqual(second.counts, first.counts);
  assert.deepEqual(
    converged.recommendations.map(({ id, productId, heading, editorialDescription }) => ({
      id,
      productId,
      heading,
      editorialDescription,
    })),
    completed.recommendations.map(({ id, productId, heading, editorialDescription }) => ({
      id,
      productId,
      heading,
      editorialDescription,
    })),
  );
  assert.equal(catalog.read().products.length, productCount);
  assert.equal(sourceStore.list(catalog.read().products).length, sourceCount);
  assert.equal(
    sourcingStore.list().length,
    requestCount,
    "a guide rerun does not rediscover an already-ready Product-pending slot",
  );
  assert.deepEqual(providerOperations, []);
  assert.equal(second.execution.editorialCalls, 0);
  assert.equal(second.execution.p2Calls, 0);
  guideDraftToPublic(converged, catalog.read());
});

test("Guide Autopilot aisla fallas P.2, limita llamadas y acepta que todos los slots queden como idea", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-guide-autopilot-failures-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const now = new Date("2026-09-08T15:00:00.000Z");
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...autopilotDraft(
        "guide_guide-autopilot-failures",
        "slot_guide-autopilot-provider-failure",
        "Guide Autopilot Provider Failure Item",
      ),
      recommendations: [
        {
          id: "slot_guide-autopilot-provider-failure",
          position: 1,
          slotLabel: "Guide Autopilot Provider Failure Item",
          slotIntent: "Fall back safely after a P.2 provider failure.",
          searchTerms: ["provider failure item"],
          editorialStatus: "needs-generation",
        },
        {
          id: "slot_guide-autopilot-following-success",
          position: 2,
          slotLabel: "Guide Autopilot Following Success Item",
          slotIntent: "Resolve after the preceding slot fails.",
          searchTerms: ["following success item"],
          editorialStatus: "needs-generation",
        },
      ],
    }),
    now,
  );
  const failedRequest = autopilotRequest(
    draft,
    ["source_candidate_guide-provider-failure"],
    now,
    "slot_guide-autopilot-provider-failure",
  );
  const successfulRequest = autopilotRequest(
    draft,
    ["source_candidate_guide-following-success"],
    now,
    "slot_guide-autopilot-following-success",
  );
  await sourcingStore.save(failedRequest);
  await sourcingStore.save(successfulRequest);
  const strong = strongAutopilotProvider();
  let activeProviderCalls = 0;
  let peakProviderCalls = 0;
  let p2Calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "guide-autopilot-isolation-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      activeProviderCalls++;
      peakProviderCalls = Math.max(peakProviderCalls, activeProviderCalls);
      try {
        if (request.operation === "product-fit-evaluations") {
          p2Calls++;
          const input = productFitPromptInputSchema.parse(request.input);
          if (input.candidates[0]!.requestId === failedRequest.id) {
            throw new ProviderError("fixture P.2 timeout", "timeout");
          }
        }
        return await strong.generateStructured(request);
      } finally {
        activeProviderCalls--;
      }
    },
  };

  const isolated = await completeGuideAutonomously(
    draft,
    { draftStore, catalog, sourcingStore, sourceStore, fitStore, provider },
    { now, sourceProducts: true },
  );
  const isolatedDraft = guideDraftSchema.parse(await draftStore.read(draft.id));

  assert.equal(isolated.status, "completed-with-warnings");
  assert.equal(isolated.counts.editorialReady, 2);
  assert.equal(isolated.counts.productResolved, 1);
  assert.equal(isolated.counts.productPending, 1);
  assert.equal(isolated.counts.slotsWithWarnings, 1, JSON.stringify(isolated));
  assert.ok(
    isolated.warnings.some((warning) => warning.includes("evaluation-infrastructure-failed")),
  );
  assert.equal(
    isolated.slots.find(({ slotId }) => slotId === "slot_guide-autopilot-provider-failure")!.status,
    "product-pending",
  );
  assert.equal(
    isolated.slots.find(({ slotId }) => slotId === "slot_guide-autopilot-following-success")!
      .status,
    "product-resolved",
  );
  assert.ok(
    isolatedDraft.recommendations.every(({ editorialStatus }) => editorialStatus === "ready"),
  );
  assert.ok(p2Calls <= 2 * AUTOPILOT_LIMITS.maxP2ProviderCalls);
  assert.equal(peakProviderCalls, 1);
  assert.equal(isolated.execution.peakConcurrentSlots, 1);

  const allFallbackDraft = await draftStore.save(
    guideDraftSchema.parse({
      ...draft,
      id: "guide_guide-autopilot-all-fallback",
      slug: "guide-autopilot-all-fallback",
      recommendations: draft.recommendations.map((slot, index) => ({
        ...slot,
        id: `slot_guide-autopilot-all-fallback-${index + 1}`,
        productId: undefined,
        heading: undefined,
        editorialDescription: undefined,
        whyItFits: undefined,
        selectionGuidance: undefined,
        considerations: undefined,
        editorialStatus: "needs-generation" as const,
      })),
    }),
    now,
  );
  for (const slot of allFallbackDraft.recommendations) {
    await sourcingStore.save(
      productSourcingRequestSchema.parse({
        ...autopilotRequest(
          allFallbackDraft,
          [`source_candidate_${slot.id.replace(/^slot_/, "")}`],
          now,
          slot.id,
        ),
        mustHaveVerifiedFacts: ["A deliberately unavailable verified fact"],
      }),
    );
  }
  const allFallback = await completeGuideAutonomously(
    allFallbackDraft,
    { draftStore, catalog, sourcingStore, sourceStore, fitStore, provider: strong },
    { now, sourceProducts: true },
  );

  assert.equal(allFallback.status, "completed");
  assert.equal(allFallback.counts.editorialReady, 2);
  assert.equal(allFallback.counts.productResolved, 0);
  assert.equal(allFallback.counts.productPending, 2);
  assert.equal(allFallback.counts.genericRecommendations, 2);
  assert.equal(allFallback.execution.productPendingFallbacks, 2);
  assert.ok(allFallback.slots.every(({ status }) => status === "product-pending"));
  const persistedFallback = guideDraftSchema.parse(await draftStore.read(allFallbackDraft.id));
  assert.ok(persistedFallback.recommendations.every(({ productId }) => productId === undefined));
  for (const slot of persistedFallback.recommendations) {
    assert.equal(
      findProductSourcingRequestForDraftSlot(sourcingStore.list(), persistedFallback.id, slot.id)
        ?.status,
      "completed-idea-only",
    );
  }
});

test("Guide Autopilot completa ocho slots sin sourcing y reserva el presupuesto para la acción explícita", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-guide-autopilot-budget-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const now = new Date("2026-09-09T12:00:00.000Z");
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...autopilotDraft(
        "guide_guide-autopilot-budget",
        "slot_guide-autopilot-budget-1",
        "Bounded sourcing item 1",
      ),
      recommendations: Array.from({ length: 8 }, (_, index) => ({
        id: `slot_guide-autopilot-budget-${index + 1}`,
        position: index + 1,
        slotLabel: `Bounded sourcing item ${index + 1}`,
        slotIntent: `Keep sourcing work independent for slot ${index + 1}.`,
        searchTerms: [`bounded sourcing item ${index + 1}`],
        editorialStatus: "needs-generation" as const,
      })),
    }),
    now,
  );
  let discoveryCalls = 0;
  let p2Calls = 0;
  let lastCallMetadata: ProviderCallMetadata | undefined;
  const providerOperations: string[] = [];
  const editorialPrompts: string[] = [];
  const editorialBatchSizes: number[] = [];
  const mock = new MockGuideGenerationProvider();
  const provider: GuideGenerationProvider = {
    providerId: "guide-budget-fixture",
    get lastCallMetadata() {
      return lastCallMetadata;
    },
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      providerOperations.push(request.operation);
      if (
        request.operation === "idea-recommendation-batch" ||
        request.operation === "idea-recommendation-batch-repair"
      ) {
        editorialPrompts.push(request.prompt);
        editorialBatchSizes.push(
          (request.input as { recommendations: unknown[] }).recommendations.length,
        );
      }
      if (request.operation === "product-fit-evaluations") p2Calls++;
      const generated = await mock.generateStructured(request);
      lastCallMetadata =
        request.operation === "product-fit-evaluations"
          ? { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
          : { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
      return generated;
    },
  };
  const discoverySource: ProductDiscoverySource = {
    providerId: "serpapi",
    paidUsage: true,
    supportedModes: ["amazon"],
    async search(input) {
      discoveryCalls++;
      const asin = `B0COST${String(discoveryCalls).padStart(4, "0")}`;
      return [
        {
          sourceKind: "serpapi",
          provider: "SerpAPI",
          discoveryMode: "amazon",
          marketplace: "amazon.com",
          externalId: asin,
          sourceUrl: `https://www.amazon.com/dp/${asin}`,
          productUrl: `https://www.amazon.com/dp/${asin}`,
          name: input.query,
          sourceFacts: [`Observed query: ${input.query}`],
          query: input.query,
          observedAt: input.observedAt,
        },
      ];
    },
  };

  const editorial = await completeGuideAutonomously(
    draft,
    { draftStore, catalog, sourcingStore, sourceStore, fitStore, provider, discoverySource },
    { now },
  );

  assert.equal(editorial.status, "completed", JSON.stringify(editorial));
  assert.equal(editorial.counts.editorialReady, 8);
  assert.equal(editorial.counts.productResolved, 0);
  assert.equal(editorial.counts.productPending, 8);
  assert.equal(discoveryCalls, 0);
  assert.equal(p2Calls, 0);
  assert.equal(editorial.execution.externalDiscoveryCalls, 0);
  assert.equal(editorial.execution.productPlanningCalls, 0);
  assert.equal(editorial.execution.p2Calls, 0);
  assert.equal(editorial.execution.productsCreated, 0);
  assert.equal(editorial.execution.productsReused, 0);
  assert.equal(editorial.execution.editorialCalls, 1);
  assert.equal(editorial.execution.editorialBatchCalls, 1);
  assert.equal(editorial.execution.editorialRepairCalls, 0);
  assert.equal(editorial.execution.guideMetadataCalls, 1);
  assert.deepEqual(editorial.execution.providerUsage, {
    editorial: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    guideMetadata: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  });
  assert.deepEqual(editorialBatchSizes, [8]);
  assert.equal(
    providerOperations.filter((operation) => operation === "idea-recommendation-batch").length,
    1,
  );
  assert.equal(providerOperations.filter((operation) => operation === "guide-metadata").length, 1);
  assert.match(editorialPrompts[0]!, /Vary sentence structure, phrasing, and openings/);
  assert.match(editorialPrompts[0]!, /learning notes, non-sensitive reminders/);
  assert.match(editorialPrompts[0]!, /patient-identifying or confidential information/);
  assert.ok(
    editorial.slots.every(
      ({ action, status, editorialReady, productId, singleSlotResult }) =>
        action === "repaired-generic-idea-copy" &&
        status === "product-pending" &&
        editorialReady &&
        productId === undefined &&
        singleSlotResult === undefined,
    ),
  );
  const completedEditorialDraft = guideDraftSchema.parse(await draftStore.read(draft.id));
  assert.deepEqual(
    completedEditorialDraft.recommendations.map(({ id }) => id),
    draft.recommendations.map(({ id }) => id),
  );
  assert.ok(
    completedEditorialDraft.recommendations.every(
      ({
        productId,
        editorialStatus,
        heading,
        editorialDescription,
        whyItFits,
        bestFor,
        selectionGuidance,
        considerations,
      }) =>
        productId === undefined &&
        editorialStatus === "ready" &&
        [
          heading,
          editorialDescription,
          whyItFits,
          bestFor,
          selectionGuidance,
          considerations,
        ].every(Boolean),
    ),
  );
  assert.deepEqual(sourcingStore.list(), []);
  assert.deepEqual(fitStore.list(), []);

  const result = await completeGuideAutonomously(
    guideDraftSchema.parse(await draftStore.read(draft.id)),
    { draftStore, catalog, sourcingStore, sourceStore, fitStore, provider, discoverySource },
    { now: new Date("2026-09-09T12:30:00.000Z"), sourceProducts: true },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.counts.editorialReady, 8);
  assert.equal(result.counts.productPending, 8);
  assert.equal(discoveryCalls, 8);
  assert.equal(p2Calls, 8);
  assert.equal(result.execution.externalDiscoveryCalls, 8);
  assert.equal(result.execution.productPlanningCalls, 0);
  assert.equal(result.execution.p2Calls, 8);
  assert.equal(result.execution.editorialCalls, 0);
  assert.equal(result.execution.editorialBatchCalls, 0);
  assert.equal(result.execution.editorialRepairCalls, 0);
  assert.equal(result.execution.guideMetadataCalls, 0);
  assert.equal(result.execution.technicalRetries, 0);
  assert.deepEqual(result.execution.providerUsage, {
    p2: { inputTokens: 80, outputTokens: 160, totalTokens: 240 },
  });
  assert.ok(result.execution.externalDiscoveryCalls <= 8 * AUTOPILOT_LIMITS.maxDiscoveryCalls);
  assert.ok(result.execution.p2Calls <= 8 * AUTOPILOT_LIMITS.maxP2ProviderCalls);
  assert.equal(result.execution.slotsStoppedBySourcingBudget, 0);
  assert.ok(
    result.slots.every(
      ({ status, singleSlotResult }) =>
        status === "product-pending" &&
        singleSlotResult?.reasonCode === "no-candidate-passed-product-gate" &&
        singleSlotResult.sourcing.externalDiscoveryCalls === 1 &&
        singleSlotResult.sourcing.p2Calls === 1 &&
        !singleSlotResult.sourcing.recoveryUsed,
    ),
  );
  assert.equal(
    result.slots.reduce(
      (sum, { singleSlotResult }) => sum + (singleSlotResult?.sourcing.p2Calls ?? 0),
      0,
    ),
    result.execution.p2Calls,
  );
  const worstNow = new Date("2026-09-09T13:00:00.000Z");
  const worstDraft = await draftStore.save(
    guideDraftSchema.parse({
      ...draft,
      id: "guide_guide-autopilot-worst-budget",
      slug: "guide-autopilot-worst-budget",
      recommendations: draft.recommendations.map((slot, index) => ({
        ...slot,
        id: `slot_guide-autopilot-worst-budget-${slot.position}`,
        slotLabel: `Technical failure item ${index + 1}`,
        slotIntent: `Remain editorially usable after technical failure ${index + 1}.`,
        searchTerms: [`technical failure item ${index + 1}`],
      })),
    }),
    worstNow,
  );
  const discoveryCallsBeforeWorstCase = discoveryCalls;
  p2Calls = 0;
  const worstProvider: GuideGenerationProvider = {
    providerId: "guide-worst-budget-fixture",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation === "product-fit-evaluations") {
        p2Calls++;
        throw new ProviderError("Fixture P.2 timeout.", "timeout");
      }
      return mock.generateStructured(request);
    },
  };
  const worst = await completeGuideAutonomously(
    worstDraft,
    {
      draftStore,
      catalog,
      sourcingStore,
      sourceStore,
      fitStore,
      provider: worstProvider,
      discoverySource,
    },
    { now: worstNow, sourceProducts: true },
  );

  assert.equal(worst.counts.editorialReady, 8);
  assert.equal(worst.counts.productPending, 8);
  assert.equal(discoveryCalls - discoveryCallsBeforeWorstCase, 8);
  assert.equal(p2Calls, 16);
  assert.equal(worst.execution.externalDiscoveryCalls, 8);
  assert.equal(worst.execution.p2Calls, 16);
  assert.equal(worst.execution.technicalRetries, 8);
  assert.equal(worst.execution.productPlanningCalls, 0);
  assert.equal(
    worst.slots.reduce(
      (sum, { singleSlotResult }) => sum + (singleSlotResult?.sourcing.p2Calls ?? 0),
      0,
    ),
    worst.execution.p2Calls,
  );
});

test("Guide Autopilot conserva hermanos válidos y repara sólo los slots fallidos en un lote", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-guide-autopilot-repair-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourcingStore = new ProductSourcingRequestStore(repository);
  const sourceStore = new ProductSourceStore(repository);
  const fitStore = new ProductFitEvaluationStore(repository);
  const now = new Date("2026-09-10T12:00:00.000Z");
  const draft = await draftStore.save(
    guideDraftSchema.parse({
      ...autopilotDraft(
        "guide_guide-autopilot-batch-repair",
        "slot_guide-autopilot-batch-repair-1",
      ),
      title: "Gifts for Nurses Working 12-Hour Shifts",
      recommendations: Array.from({ length: 8 }, (_, index) => ({
        id: `slot_guide-autopilot-batch-repair-${index + 1}`,
        position: index + 1,
        slotLabel: index === 3 ? "24-ounce hydration option" : `Batch repair gift ${index + 1}`,
        slotIntent: `Offer distinct choosing guidance for gift ${index + 1}.`,
        searchTerms: [`batch repair gift ${index + 1}`],
        ...(index === 4 ? { budgetHint: "Under $50" } : {}),
        editorialStatus: "needs-generation" as const,
      })),
    }),
    now,
  );
  const mock = new MockGuideGenerationProvider();
  const operations: string[] = [];
  let repairedIds: string[] = [];
  let lastCallMetadata: ProviderCallMetadata | undefined;
  const provider: GuideGenerationProvider = {
    providerId: "guide-batch-repair-fixture",
    get lastCallMetadata() {
      return lastCallMetadata;
    },
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      operations.push(request.operation);
      const generated = await mock.generateStructured(request);
      if (request.operation === "idea-recommendation-batch") {
        const response = generated as { recommendations: Record<string, unknown>[] };
        response.recommendations.forEach((recommendation, index) => {
          recommendation.heading = `Primary editorial heading ${index + 1}`;
        });
        response.recommendations[0]!.editorialDescription =
          "A useful choice for the realities of 12-hour shifts.";
        response.recommendations[1]!.whyItFits =
          "It can make a 12-hour workday feel more considered.";
        response.recommendations[2]!.selectionGuidance = "Choose a 20 oz format.";
        response.recommendations[3]!.selectionGuidance =
          "Compare 24-ounce options for fit and care.";
        response.recommendations[4]!.considerations = "Keep the final choice under $50.";
        response.recommendations[5]!.whyItFits = ["invalid"];
      } else if (request.operation === "idea-recommendation-batch-repair") {
        const input = ideaRecommendationBatchPromptInputSchema.parse(request.input);
        repairedIds = input.recommendations.map(({ id }) => id);
        const response = generated as { recommendations: Record<string, unknown>[] };
        response.recommendations[0]!.heading = "Repaired editorial heading 3";
        response.recommendations[1]!.selectionGuidance = 42;
      }
      lastCallMetadata =
        request.operation === "guide-metadata"
          ? { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
          : request.operation === "idea-recommendation-batch"
            ? { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
            : { inputTokens: 20, outputTokens: 40, totalTokens: 60 };
      return generated;
    },
  };

  const result = await completeGuideAutonomously(draft, {
    draftStore,
    catalog,
    sourcingStore,
    sourceStore,
    fitStore,
    provider,
  });
  const completed = guideDraftSchema.parse(await draftStore.read(draft.id));

  assert.equal(result.counts.editorialReady, 8);
  assert.equal(result.execution.editorialCalls, 2);
  assert.equal(result.execution.editorialBatchCalls, 1);
  assert.equal(result.execution.editorialRepairCalls, 1);
  assert.equal(result.execution.guideMetadataCalls, 1);
  assert.ok(result.execution.editorialCalls <= 2);
  assert.deepEqual(
    operations.filter((operation) => operation.startsWith("idea-recommendation-batch")),
    ["idea-recommendation-batch", "idea-recommendation-batch-repair"],
  );
  assert.deepEqual(repairedIds, [
    "slot_guide-autopilot-batch-repair-3",
    "slot_guide-autopilot-batch-repair-6",
  ]);
  assert.deepEqual(result.execution.providerUsage, {
    editorial: { inputTokens: 120, outputTokens: 240, totalTokens: 360 },
    guideMetadata: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });
  assert.equal(completed.recommendations[0]!.heading, "Primary editorial heading 1");
  assert.equal(
    completed.recommendations[0]!.editorialDescription,
    "A useful choice for the realities of 12-hour shifts.",
  );
  assert.equal(
    completed.recommendations[1]!.whyItFits,
    "It can make a 12-hour workday feel more considered.",
  );
  assert.equal(completed.recommendations[2]!.heading, "Repaired editorial heading 3");
  assert.equal(
    completed.recommendations[3]!.selectionGuidance,
    "Compare 24-ounce options for fit and care.",
  );
  assert.equal(completed.recommendations[4]!.considerations, "Keep the final choice under $50.");
  assert.equal(completed.recommendations[5]!.heading, "Batch repair gift 6");
  assert.equal(completed.recommendations[5]!.editorialPromptVersion, SAFE_IDEA_COPY_VERSION);
  assert.deepEqual(result.slots[0]!.warnings, []);
  assert.deepEqual(result.slots[1]!.warnings, []);
  assert.deepEqual(result.slots[3]!.warnings, []);
  assert.deepEqual(result.slots[4]!.warnings, []);
  for (const index of [0, 1, 3, 4]) {
    assert.equal(
      ideaOnlyRecommendationNeedsCopyRepair(
        completed,
        completed.recommendations[index]!.id,
        catalog.read(),
      ),
      false,
    );
  }
  assert.ok(completed.recommendations.every(({ editorialStatus }) => editorialStatus === "ready"));
  assert.equal(result.execution.externalDiscoveryCalls, 0);
  assert.equal(result.execution.productPlanningCalls, 0);
  assert.equal(result.execution.p2Calls, 0);
  assert.equal(result.execution.productsCreated, 0);
  assert.equal(result.execution.productsReused, 0);
  assert.deepEqual(sourcingStore.list(), []);
  assert.deepEqual(fitStore.list(), []);
});
