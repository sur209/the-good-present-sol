import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";

import { z } from "zod";

import type { Product, ValidatedPublicContent } from "@the-good-present/content-schema";

import {
  MockGuideGenerationProvider,
  ProviderError,
  createGuideGenerationProvider,
  parseExactStructuredContent,
  resolveAiConfiguration,
  type GuideGenerationProvider,
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
} from "./drafts.ts";
import {
  addManualRecommendation,
  clearRecommendationProduct,
  duplicateProductIds,
  generateFinalGuide,
  generateGuideOutline,
  moveRecommendation,
  normalizeQuestionnaire,
  regenerateRecommendation,
  removeRecommendation,
  reopenGuideDraft,
  selectRecommendationProduct,
  updateRecommendationEditorialCopy,
  validateGuideDraft,
} from "./guide-editor.ts";
import { prepareFinalPrompt } from "./final-prompt.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";
import {
  ProductCatalog,
  matchProducts,
  productUsage,
  suggestProductsForSlot,
  validateProductUrl,
} from "./product-catalog.ts";
import { prepareRecommendationPrompt } from "./recommendation-prompt.ts";
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
import { analyzeProductCoverage } from "./modules/product-intelligence/coverage.ts";
import { productGapReportSchema } from "./modules/product-intelligence/gaps.ts";
import {
  ProductSourcingRequestStore,
  addProductSourceCandidates,
  assertProductSourcingOrigin,
  assignSourcedProductToDraftSlot,
  catalogMatchesForRequest,
  createProductSourcingRequest,
  linkProductSourceCandidate,
  productSourcingRequestPath,
  productSourcingReturnPath,
  reviewProductSourceCandidates,
  selectCanonicalProductForRequest,
  transitionProductSourcingRequest,
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

async function generatedGuideDraft(id: string, giftCount = 3) {
  const content = new ProductCatalog().read();
  const draft = guideDraftSchema.parse({
    ...createGuideDraft(id),
    clusterId: content.clusters[0]!.id,
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
    /product-intelligence|gap_coverage-brief|request_intelligence-sentinel/,
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

test("persiste un brief editable, exige aprobación y crea un GuideDraft sin contenido público", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-editorial-brief-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
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
    convertApprovedBriefToGuideDraft(
      edited,
      candidateStore,
      briefStore,
      draftStore,
      readPublicContent(repository),
    ),
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
    readPublicContent(repository),
    new Date("2026-08-09T05:00:00.000Z"),
  );
  assert.equal(converted.brief.status, "converted-to-guide-draft");
  assert.equal(converted.candidate.status, "converted-to-draft");
  assert.equal(converted.candidate.guideDraftId, converted.draft.id);
  assert.equal(converted.draft.status, "questionnaire");
  assert.equal(converted.draft.slug, edited.proposedSlug);
  assert.equal(converted.draft.recommendations.length, 0);
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
    readPublicContent(),
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
  const content = readPublicContent();
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
  const content = readPublicContent();
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
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const content = readPublicContent(repository);
  const productCoverage = analyzeProductCoverage(content);
  const coverageSignal = opportunityCoverageSignals(productCoverage)[0]!;
  const sourceProduct = content.products.find(({ status }) => status === "active")!;
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
  const content = readPublicContent();
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
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const content = readPublicContent(repository);
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
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const content = readPublicContent(repository);
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
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const content = readPublicContent(repository);
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
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const content = readPublicContent(repository);
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
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
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
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
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
  ]);
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
        ].map((productId, index) => ({
          ...base.guides[0]!.recommendations[0]!,
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
  assert.equal(report.coverage.filter((entry) => entry.kind === "none").length, 2);
  assert.ok(report.warnings.length > 0);
  assert.ok(report.errors.length > 0);
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
    `/drafts/${draft.id}?slot=slot_sourcing-lifecycle`,
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

test("crea, cumple y asigna una solicitud al slot exacto por HTTP", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-sourcing-http-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const draftStore = new DraftStore(join(repository, "drafts"));
  const sourceStore = new ProductSourceStore(repository);
  const draft = await draftStore.save(
    addManualRecommendation(
      createGuideDraft("guide_sourcing-http"),
      "Insulated tumbler",
      "Keep a nurse hydrated during a long shift.",
      ["insulated", "tumbler"],
      "slot_sourcing-http",
    ),
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
    `/drafts/${draft.id}?slot=slot_sourcing-http`,
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
  const published = content.clusters[0]!;
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
  const draft = reopenClusterDraft(content.clusters[0]!);
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
  const source = reopenClusterDraft(content.clusters[0]!);
  const groupId = source.navigationGroups[0]!.id;
  const empty = {
    ...source,
    navigationGroups: [{ ...source.navigationGroups[0]!, guideIds: [] }],
  };
  const firstId = content.guides[0]!.id;
  const secondId = content.guides[1]!.id;
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
  assert.match(first.prompt, /exactly one JSON object/);
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
    questionnaire: normalizeQuestionnaire({ occasion: "new role", giftCount: "5" }),
  });
  const generated = await generateGuideOutline(
    draft,
    content,
    new MockGuideGenerationProvider(),
    new Date("2026-08-08T15:00:00.000Z"),
  );

  assert.equal(generated.status, "outline-ready");
  assert.equal(generated.outline?.slots.length, 5);
  assert.equal(generated.recommendations.length, 5);
  assert.equal(generated.recommendations[0]!.id, "guide_mock-outline_slot-1");
  assert.ok(generated.recommendations.every((slot) => !slot.productId));
  assert.ok(generated.recommendations.every((slot) => slot.editorialStatus === "unassigned"));
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
    body: new URLSearchParams({ promptVersion: "old-version" }),
  });
  assert.equal(blocked.status, 400);

  const generated = await fetch(`${origin}/drafts/guide_http-outline/outline/generate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ promptVersion: "outline-v1" }),
    redirect: "manual",
  });
  assert.equal(generated.status, 303);
  const saved = await store.read("guide_http-outline");
  assert.equal(saved.draftType, "gift-guide");
  assert.equal(saved.outline?.slots.length, 3);
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
  const firstProduct = content.products[0]!;
  const secondProduct = content.products[1]!;
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
  assert.equal(cleared.recommendations[1]!.editorialStatus, "unassigned");
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
    /Quitá las selecciones/,
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
  assert.match(first.prompt, new RegExp(content.products[0]!.name));
  assert.match(first.prompt, /Return exactly one JSON object/);
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
  assert.equal(generated.generationMetadata?.promptVersion, "final-guide-v1");
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
  assert.equal(regenerated.generationMetadata?.promptVersion, "single-recommendation-v1");
});

test("la edición manual sólo marca ready con copia mínima completa", async () => {
  const content = new ProductCatalog().read();
  const draft = await selectedGuideDraft("guide_manual-ready");
  const slotId = draft.recommendations[0]!.id;

  assert.throws(
    () => updateRecommendationEditorialCopy(draft, slotId, { heading: "Only a heading" }, true),
    /se requieren producto, descripción editorial y motivo/,
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
  assert.ok(
    validateGuideDraft(ready, content).errors.some((error) => error.includes("no está listo")),
  );
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

test("genera, previsualiza, reemplaza y regenera una recomendación por HTTP", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-final-http-"));
  const store = new DraftStore(directory);
  const content = new ProductCatalog().read();
  const draft = await selectedGuideDraft("guide_http-final");
  await store.save(draft);
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

  const promptResponse = await fetch(`${origin}/drafts/${draft.id}/final-prompt`);
  assert.match(await promptResponse.text(), /Revisar prompt de generación final/);
  const generatedResponse = await fetch(`${origin}/drafts/${draft.id}/final/generate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ promptVersion: "final-guide-v1" }),
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
  const target = saved.recommendations[0]!;
  const replacement = content.products[3]!;
  await fetch(`${origin}/drafts/${draft.id}/recommendations/${target.id}/product`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ productId: replacement.id }),
    redirect: "manual",
  });
  assert.equal((await store.read(draft.id)).status, "selecting-products");
  const singlePrompt = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/${target.id}/prompt`,
  );
  assert.match(await singlePrompt.text(), /Regenerar una recomendación/);
  const regenerated = await fetch(
    `${origin}/drafts/${draft.id}/recommendations/${target.id}/regenerate`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ promptVersion: "single-recommendation-v1" }),
      redirect: "manual",
    },
  );
  assert.equal(regenerated.status, 303);
  const finalDraft = await store.read(draft.id);
  assert.equal(finalDraft.draftType, "gift-guide");
  assert.equal(finalDraft.recommendations[0]!.productId, replacement.id);
  assert.equal(finalDraft.recommendations[0]!.editorialStatus, "ready");
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
  const draft = await generateFinalGuide(
    await selectedGuideDraft("guide_editorial-integration"),
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
  const directProduct = catalog.get(finalGuide.recommendations[0]!.productId);
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
      }),
      { status: 200, headers: { "content-type": "application/json" } },
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
        /evaluations\.0\.thinContentRiskAction: Too small: expected string to have >=1 characters/,
      );
      assert.match(
        summary,
        /evaluations\.0\.cannibalizationRiskAction: Too small: expected string to have >=1 characters/,
      );
      assert.match(summary, /\$: Unrecognized field\(s\)/);
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
