import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  MockGuideGenerationProvider,
  type GuideGenerationProvider,
  type StructuredGenerationRequest,
} from "./ai-provider.ts";
import { DraftStore } from "./draft-store.ts";
import { createGuideDraft, guideDraftSchema } from "./drafts.ts";
import { completeGuideEditorially } from "./editorial-completion.ts";
import { resolveProductClassProfile } from "./editorial-guidance.ts";
import {
  EditorialReviewStore,
  applyEditorialCorrections,
  reviewGuideEditorially,
} from "./editorial-review.ts";
import {
  generateGuideOutline,
  ideaOnlyCopyDiagnostic,
  updateRecommendationDirectAffiliateUrl,
  validateGuideDraft,
} from "./guide-editor.ts";
import { prepareIdeaRecommendationPrompt } from "./idea-prompt.ts";
import { ProductCatalog } from "./product-catalog.ts";
import { Publisher } from "./publication.ts";
import { REPOSITORY_ROOT, readEditorialContent } from "./repository.ts";
import { STUDIO_HOST, createStudioServer } from "./server.ts";

const execFileAsync = promisify(execFile);
const checkpointDate = new Date("2026-09-14T12:00:00.000Z");
const clusterId = "cluster_editorial-isolation";

async function createEditorialRoot(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "good-present-editorial-isolation-"));
  await Promise.all([
    mkdir(join(repository, "content", "clusters"), { recursive: true }),
    mkdir(join(repository, "content", "guides"), { recursive: true }),
  ]);
  await writeFile(
    join(repository, "content", "clusters", `${clusterId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: clusterId,
        pageType: "cluster-hub",
        slug: "editorial-isolation",
        language: "en-US",
        title: "Editorial Isolation Gifts",
        excerpt: "Gift ideas developed without requiring a Product acquisition workflow.",
        introduction:
          "A focused collection of practical gift ideas, organized around the recipient and the moment.",
        seoTitle: "Editorial Isolation Gift Ideas",
        seoDescription:
          "Explore practical gift ideas developed independently from optional Product acquisition tools.",
        navigationGroups: [],
        status: "published",
        publishedAt: "2026-09-14",
        updatedAt: "2026-09-14",
      },
      null,
      2,
    )}\n`,
  );
  return repository;
}

test("Stage 4 checkpoint: an eight-idea guide completes and publishes with optional stores absent or malformed", async (context) => {
  const repository = await createEditorialRoot();
  context.after(() => rm(repository, { recursive: true, force: true }));
  const store = new DraftStore(join(repository, "drafts"), repository);
  const mock = new MockGuideGenerationProvider();
  const operations: string[] = [];
  let reviewOriginal = "";
  const provider: GuideGenerationProvider = {
    providerId: "stage4-checkpoint",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      operations.push(request.operation);
      if (request.operation === "editorial-review") {
        return request.schema.parse({
          issues: [
            {
              type: "awkward-language",
              severity: "minor",
              location: "recommendation",
              recommendationId: "guide_stage4-checkpoint_slot-1",
              field: "editorialDescription",
              explanation: "Use a more direct opening.",
              originalText: reviewOriginal,
              replacementText:
                "This idea can be thoughtful when it fits the recipient's everyday routine and preferences.",
            },
          ],
        });
      }
      return mock.generateStructured(request);
    },
  };

  const fresh = await store.save(
    guideDraftSchema.parse({
      ...createGuideDraft("guide_stage4-checkpoint", checkpointDate),
      clusterId,
      slug: "eight-editorial-ideas",
      primaryAxis: "recipient",
      primaryIntent: "Help a friend choose a useful, personal everyday gift.",
      title: "Eight Useful Gift Ideas",
      questionnaire: {
        giftCount: 8,
        recipient: "A friend with a busy everyday routine",
        occasion: "A thoughtful surprise",
        budget: "A flexible, modest budget",
      },
    }),
    checkpointDate,
  );
  assert.deepEqual(readEditorialContent(repository).guides, []);
  await assert.rejects(readFile(join(repository, "content", "products")), /ENOENT/);

  const outlined = await generateGuideOutline(
    fresh,
    readEditorialContent(repository),
    provider,
    checkpointDate,
  );
  const savedOutline = await store.save(outlined, checkpointDate, fresh);
  assert.equal(savedOutline.recommendations.length, 8);

  const completion = await completeGuideEditorially(
    savedOutline,
    { content: readEditorialContent(repository), draftStore: store, provider },
    checkpointDate,
  );
  assert.equal(completion.status, "completed");
  assert.equal(completion.counts.editorialReady, 8);
  assert.equal(completion.execution.editorialBatchCalls, 1);
  assert.equal(completion.execution.guideMetadataCalls, 1);
  let completed = guideDraftSchema.parse(await store.read(fresh.id));
  assert.equal(
    completed.recommendations.every(({ editorialStatus }) => editorialStatus === "ready"),
    true,
  );

  reviewOriginal = completed.recommendations[0]!.editorialDescription!;
  const review = await reviewGuideEditorially(completed, provider, checkpointDate);
  assert.equal(review.status, "completed");
  assert.equal(review.issues.length, 1);
  await new EditorialReviewStore(repository).save(review);
  const correction = applyEditorialCorrections(
    completed,
    review,
    [review.issues[0]!.id],
    checkpointDate,
  );
  completed = await store.save(correction.draft, checkpointDate, completed);
  assert.equal(
    completed.recommendations[0]!.editorialDescription,
    review.issues[0]!.replacementText,
  );

  await Promise.all([
    mkdir(join(repository, "content", "products"), { recursive: true }),
    mkdir(join(repository, "editorial-data", "product-intelligence"), { recursive: true }),
    mkdir(join(repository, "editorial-data", "article-candidates"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(repository, "editorial-data", "product-intelligence", "request_broken.json"),
      "{ malformed sourcing",
    ),
    writeFile(
      join(repository, "editorial-data", "article-candidates", "candidate_broken.json"),
      "{ malformed opportunity",
    ),
  ]);

  const server = createStudioServer(
    store,
    new ProductCatalog(repository),
    provider,
    new Publisher(repository),
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const editor = await fetch(`${origin}/drafts/${completed.id}`);
  assert.equal(editor.status, 200);
  assert.match(await editor.text(), /Curación de Products \(opcional\)/);

  const slotId = completed.recommendations[0]!.id;
  const affiliateUrl = "https://www.amazon.com/dp/B012345678?tag=stage4-20";
  const affiliateResponse = await fetch(
    `${origin}/drafts/${completed.id}/recommendations/${slotId}/direct-affiliate`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        revision: String(completed.revision),
        directAffiliateUrl: affiliateUrl,
      }),
      redirect: "manual",
    },
  );
  assert.equal(affiliateResponse.status, 303);
  completed = guideDraftSchema.parse(await store.read(completed.id));
  const previewWithAffiliate = await fetch(`${origin}/drafts/${completed.id}/preview`);
  assert.equal(previewWithAffiliate.status, 200);
  assert.match(await previewWithAffiliate.text(), /View on Amazon/);

  const removeAffiliateResponse = await fetch(
    `${origin}/drafts/${completed.id}/recommendations/${slotId}/direct-affiliate`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ revision: String(completed.revision) }),
      redirect: "manual",
    },
  );
  assert.equal(removeAffiliateResponse.status, 303);
  completed = guideDraftSchema.parse(await store.read(completed.id));
  assert.equal(completed.recommendations[0]!.directAffiliateUrl, undefined);
  assert.deepEqual(validateGuideDraft(completed, readEditorialContent(repository)).errors, []);

  const validation = await fetch(`${origin}/drafts/${completed.id}/validate`);
  assert.equal(validation.status, 200);
  assert.match(await validation.text(), /lista para la publicación/);
  completed = guideDraftSchema.parse(await store.read(completed.id));
  const defaultCompletion = await fetch(`${origin}/drafts/${completed.id}/autopilot`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ revision: String(completed.revision) }),
  });
  assert.equal(defaultCompletion.status, 200);
  assert.match(await defaultCompletion.text(), /Guía editorial completada/);

  const publication = await fetch(`${origin}/drafts/${completed.id}/publish`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ revision: String(completed.revision) }),
  });
  assert.equal(publication.status, 200);
  assert.match(await publication.text(), /Contenido creado/);
  assert.equal(
    JSON.parse(
      await readFile(join(repository, "content", "guides", `${completed.id}.json`), "utf8"),
    ).recommendations.length,
    8,
  );
  assert.deepEqual(await readdir(join(repository, "content", "products")), []);

  for (const path of ["/product-sourcing", "/opportunities"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 400, `${path} must expose its own malformed optional state`);
    assert.match(await response.text(), /malformed|Invalid/i);
  }
  assert.deepEqual(operations, [
    "outline",
    "guide-metadata",
    "idea-recommendation-batch",
    "editorial-review",
  ]);
  assert.equal(
    operations.some((operation) => /product|fit|search|opportunity/.test(operation)),
    false,
  );
});

test("Stage 4 policy: catalog names and sourcing history cannot redefine idea-only copy", () => {
  const draft = guideDraftSchema.parse({
    ...createGuideDraft("guide_travel-umbrella-policy", checkpointDate),
    primaryAxis: "general",
    primaryIntent: "Offer practical ideas for a rainy commute.",
    title: "Rainy Commute Gift Ideas",
    recommendations: [
      {
        id: "slot_travel-umbrella",
        position: 1,
        slotLabel: "Travel Umbrella",
        slotIntent: "Make wet commutes easier.",
        searchTerms: ["travel umbrella", "rainy commute"],
        editorialStatus: "needs-generation",
      },
    ],
  });
  const beforeUnrelatedHistory = prepareIdeaRecommendationPrompt(draft, "slot_travel-umbrella");
  const unrelatedSourcingHistory = {
    requestId: "request_unrelated",
    requiredCategory: "Ceramic planter",
    status: "fulfilled",
  };
  assert.ok(JSON.stringify(unrelatedSourcingHistory));
  const afterUnrelatedHistory = prepareIdeaRecommendationPrompt(draft, "slot_travel-umbrella");

  assert.deepEqual(afterUnrelatedHistory, beforeUnrelatedHistory);
  assert.equal(
    ideaOnlyCopyDiagnostic("A travel umbrella can help with a rainy commute."),
    undefined,
  );
  assert.equal(ideaOnlyCopyDiagnostic("Available from Amazon now."), "idea-copy-merchant-leak");
  assert.equal(
    ideaOnlyCopyDiagnostic("Choose a 20 oz format."),
    "idea-copy-unsupported-numeric-claim",
  );
  assert.equal(resolveProductClassProfile("Insulated tumbler").classId, "insulated-drinkware");
  assert.ok(resolveProductClassProfile("Travel Umbrella").importantAttributes.length > 0);
});

test("Stage 4 module boundary: core generation loads while optional runtimes are blocked", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-stage4-loader-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const loader = join(directory, "block-optional.mjs");
  await writeFile(
    loader,
    `export async function resolve(specifier, context, nextResolve) {
  if (/content-opportunity-lab|product-sources\\/discovery|product-intelligence\\/(?:fit|sourcing|autopilot|guide-autopilot)/.test(specifier)) {
    throw new Error(\`optional runtime imported by core: \${specifier}\`);
  }
  return nextResolve(specifier, context);
}\n`,
  );
  const modules = ["editorial-completion.ts", "idea-prompt.ts", "ai-provider.ts"].map(
    (file) => pathToFileURL(join(REPOSITORY_ROOT, "apps", "studio", "src", file)).href,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    "--experimental-loader",
    pathToFileURL(loader).href,
    "--input-type=module",
    "--eval",
    `await Promise.all(${JSON.stringify(modules)}.map((module) => import(module))); console.log("core-loaded");`,
  ]);
  assert.match(stdout, /core-loaded/);
});
