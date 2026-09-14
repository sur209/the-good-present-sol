import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGuideGenerationProvider,
  MockGuideGenerationProvider,
  ProviderError,
  type GuideGenerationProvider,
} from "./ai-provider.ts";
import { DraftStore } from "./draft-store.ts";
import { createGuideDraft, guideDraftSchema, type GuideDraft } from "./drafts.ts";
import {
  EditorialReviewStore,
  applyEditorialCorrections,
  editorialFingerprint,
  editorialIssueCanApply,
  editorialReviewIsStale,
  editorialSnapshot,
  prepareEditorialReviewPrompt,
  reviewGuideEditorially,
  summarizeEditorialReviews,
  type EditorialIssue,
} from "./editorial-review.ts";
import { ProductCatalog } from "./product-catalog.ts";
import { REPOSITORY_ROOT } from "./repository.ts";
import { createStudioServer, STUDIO_HOST } from "./server.ts";

const metaCopy =
  "The editorial approach keeps each suggestion distinct so the guide feels varied rather than repetitive.";
const genericCopy =
  "A well-chosen compression socks turns an everyday need into a gift that feels considered and personal.";
const goodCopy =
  "Choose a lunch bag with room for the containers they already use, an easy-to-wipe lining, and a handle that fits over their work tote. Check the staff-room refrigerator space before buying a bulky model.";
const fixedMeta =
  "Choose a gift around the part of their day you know best, whether that is packing lunch, commuting, or unwinding at home.";
const fixedGeneric =
  "Choose compression socks together so the recipient can check the sizing and pick the feel they prefer.";

function fixture(): GuideDraft {
  return guideDraftSchema.parse({
    ...createGuideDraft("guide_editorial-review"),
    status: "ready-to-publish",
    clusterId: "cluster_nurses",
    slug: "gifts-for-10-hour-shifts",
    primaryAxis: "work-context",
    primaryIntent: "Help friends choose gifts for nurses working 10-hour shifts.",
    title: "Gifts for Nurses Working 10-Hour Shifts",
    excerpt: "Choose around their lunch routine, commute, and time at home.",
    introduction: metaCopy,
    conclusion: "Ask what they already use before choosing a gift.",
    seoTitle: "Gifts for Nurses Working 10-Hour Shifts",
    seoDescription: "Gift ideas for workday breaks and unwinding at home.",
    questionnaire: { giftCount: 3, recipient: "Nurses working 10-hour shifts" },
    generationMetadata: {
      providerId: "test",
      generatedAt: "2026-09-01T00:00:00.000Z",
      promptVersion: "unchanged",
      prompt: "PRIVATE_GENERATION_TRACE",
      validation: { success: true },
    },
    recommendations: [
      {
        id: "slot_socks",
        position: 1,
        slotLabel: "Compression socks",
        heading: "Compression socks",
        editorialDescription: genericCopy,
        whyItFits: "A spare pair fits the laundry routine of a nurse working 10-hour shifts.",
        bestFor: "Nurses who already wear compression socks during 10-hour shifts.",
        selectionGuidance: "Ask about their preferred size and fit.",
        considerations: "Choose together if you do not know their preference.",
        editorialStatus: "ready",
        directAffiliateUrl: "https://www.amazon.com/dp/B012345678?tag=review-20",
        productId: "product_existing",
        editorialPromptVersion: "unchanged",
      },
      {
        id: "slot_lunch",
        position: 2,
        slotLabel: "Lunch bag",
        heading: "A lunch bag sized for their containers",
        editorialDescription: goodCopy,
        whyItFits: "Packing a meal for 10-hour shifts is easier when their usual containers fit.",
        bestFor: "Nurses who pack meals for 10-hour shifts.",
        selectionGuidance: "Measure their containers and check the refrigerator space.",
        editorialStatus: "ready",
      },
      {
        id: "slot_notes",
        position: 3,
        slotLabel: "Pocket notebook",
        heading: "A notebook for personal reminders",
        editorialDescription:
          "Pick a pocket-size notebook for grocery lists and reminders at home. Ask whether they prefer lined or blank pages.",
        whyItFits: "A small notebook can stay in their bag between errands.",
        considerations: "Keep it for personal notes; do not record patient information.",
        editorialStatus: "ready",
      },
    ],
  });
}

function proposedIssues(): Omit<EditorialIssue, "id" | "appliedAt">[] {
  return [
    {
      type: "meta-process-language",
      severity: "moderate",
      location: "guide",
      recommendationId: null,
      field: "introduction",
      explanation: "This describes the editorial process instead of helping the shopper.",
      originalText: metaCopy,
      replacementText: fixedMeta,
    },
    {
      type: "generic-or-thin-copy",
      severity: "moderate",
      location: "recommendation",
      recommendationId: "slot_socks",
      field: "editorialDescription",
      explanation: "Generic gift filler and an incorrect singular article/verb for plural socks.",
      originalText: genericCopy,
      replacementText: fixedGeneric,
    },
  ];
}

// Canned provider responses verify the contract and transport, not live model quality.
// The real-provider dogfood checks are documented in docs/editorial-review.md.
function respondingProvider(
  responses: unknown[] = [{ issues: proposedIssues() }],
  usages: (object | undefined)[] = [
    { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
  ],
) {
  const calls: { messages: { content: string }[]; response_format: { type: string } }[] = [];
  const provider = createGuideGenerationProvider(
    {
      AI_PROVIDER: "openai-compatible",
      AI_VENDOR: "openai",
      AI_MODEL: "test-review",
      AI_API_KEY: "test-only",
    },
    async (_url, options) => {
      calls.push(JSON.parse(String(options?.body)));
      const index = Math.min(calls.length - 1, responses.length - 1);
      const content = responses[index];
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: typeof content === "string" ? content : JSON.stringify(content) },
          },
        ],
        ...(usages[index] ? { usage: usages[index] } : {}),
      });
    },
  );
  return { provider, calls };
}

test("editorial review: one whole-guide invocation, stable locations, issue types and tokens", async () => {
  const draft = fixture();
  const before = structuredClone(draft);
  const { provider, calls } = respondingProvider();
  const review = await reviewGuideEditorially(draft, provider);
  assert.equal(review.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.response_format.type, "json_object");
  assert.deepEqual(review.metrics, {
    reviewInvocations: 1,
    repairInvocations: 0,
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
  });
  assert.deepEqual(
    review.issues.map(({ type, location, recommendationId, field }) => ({
      type,
      location,
      recommendationId,
      field,
    })),
    proposedIssues().map(({ type, location, recommendationId, field }) => ({
      type,
      location,
      recommendationId,
      field,
    })),
  );
  assert.equal(new Set(review.issues.map(({ id }) => id)).size, 2);
  assert.equal(review.guideId, draft.id);
  assert.equal(review.contentFingerprint, editorialFingerprint(draft));
  assert.deepEqual(draft, before);
  for (const slot of draft.recommendations)
    assert.ok(calls[0]!.messages[1]!.content.includes(slot.id));
  const snapshot = JSON.stringify(editorialSnapshot(draft));
  assert.doesNotMatch(
    snapshot,
    /product_existing|directAffiliateUrl|amazon\.com|PRIVATE_GENERATION_TRACE|editorialPromptVersion/,
  );
  assert.match(snapshot, /seoTitle/);
  assert.match(snapshot, /selectionGuidance/);
});

test("editorial review: dogfood A/B grammar alternatives are valid structured findings", async () => {
  const { provider } = respondingProvider([
    { issues: [proposedIssues()[0], { ...proposedIssues()[1], type: "awkward-language" }] },
  ]);
  const review = await reviewGuideEditorially(fixture(), provider);
  assert.deepEqual(
    review.issues.map(({ type }) => type),
    ["meta-process-language", "awkward-language"],
  );
  assert.equal(review.issues[0]!.replacementText, fixedMeta);
  assert.equal(review.issues[1]!.replacementText, fixedGeneric);
  assert.ok(review.issues.every((issue) => editorialIssueCanApply(fixture(), issue)));
});

test("editorial review: dogfood C/D good copy and legitimate topic repetition can return zero issues", async () => {
  const draft = fixture();
  draft.introduction = fixedMeta;
  draft.recommendations[0]!.editorialDescription = fixedGeneric;
  const { provider, calls } = respondingProvider([{ issues: [] }]);
  const review = await reviewGuideEditorially(draft, provider);
  assert.equal(review.status, "completed");
  assert.deepEqual(review.issues, []);
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(editorialSnapshot(draft)).split("10-hour shifts").length > 4);
  const prompt = prepareEditorialReviewPrompt(draft);
  for (const text of [
    goodCopy,
    "Do NOT flag every occurrence",
    "Zero issues",
    "stylistic preference",
    "Do not homogenize",
    "Do not invent unsupported facts",
    "sensitive-context",
    "overstrong-claim",
  ])
    assert.ok(prompt.includes(text), text);
});

test("editorial review: localized correction changes exactly one field and preserves every sibling and identity", async () => {
  const draft = fixture();
  const before = structuredClone(draft);
  const { provider, calls } = respondingProvider();
  const review = await reviewGuideEditorially(draft, provider);
  const issue = review.issues[1]!;
  const appliedAt = new Date("2026-09-14T01:00:00Z");
  const result = applyEditorialCorrections(draft, review, [issue.id], appliedAt);
  const expected = structuredClone(draft);
  expected.recommendations[0]!.editorialDescription = fixedGeneric;
  assert.deepEqual(result.draft, expected);
  assert.deepEqual(draft, before);
  assert.equal(result.draft.recommendations[0]!.id, "slot_socks");
  assert.equal(result.draft.recommendations[0]!.productId, "product_existing");
  assert.equal(
    result.draft.recommendations[0]!.directAffiliateUrl,
    draft.recommendations[0]!.directAffiliateUrl,
  );
  assert.equal(calls.length, 1);
  assert.equal(review.issues[1]!.appliedAt, undefined);
  assert.equal(result.review.issues[1]!.appliedAt, appliedAt.toISOString());
  assert.equal(result.review.issues[0]!.appliedAt, undefined);
  assert.equal(result.review.contentFingerprint, review.contentFingerprint);
  assert.ok(editorialReviewIsStale(result.draft, result.review));
  assert.throws(
    () => applyEditorialCorrections(result.draft, result.review, [review.issues[0]!.id]),
    /desactualizado/,
  );
});

test("editorial review: multiple distinct fields apply together; overlapping and unknown selections fail atomically", async () => {
  const draft = fixture();
  const { provider } = respondingProvider();
  const review = await reviewGuideEditorially(draft, provider);
  const result = applyEditorialCorrections(
    draft,
    review,
    review.issues.map(({ id }) => id),
  );
  assert.equal(result.draft.introduction, fixedMeta);
  assert.equal(result.draft.recommendations[0]!.editorialDescription, fixedGeneric);
  assert.ok(result.review.issues.every(({ appliedAt }) => appliedAt));
  const overlapping = {
    ...review,
    issues: [
      ...review.issues,
      { ...review.issues[0]!, id: "duplicate", replacementText: "Another suggestion." },
    ],
  };
  assert.throws(
    () => applyEditorialCorrections(draft, overlapping, [review.issues[0]!.id, "duplicate"]),
    /superponen/,
  );
  assert.throws(() => applyEditorialCorrections(draft, review, ["unknown"]), /campo exacto/);
  assert.throws(() => applyEditorialCorrections(draft, review, []), /Seleccioná/);
  assert.equal(draft.introduction, metaCopy);
});

test("editorial review: advisory and unsafe field mappings cannot mutate a draft", async () => {
  const draft = fixture();
  const { provider } = respondingProvider();
  const review = await reviewGuideEditorially(draft, provider);
  for (const changes of [
    { field: "productId", originalText: "product_existing" },
    { field: "directAffiliateUrl", originalText: draft.recommendations[0]!.directAffiliateUrl! },
    { field: "id", originalText: "slot_socks" },
    { field: "slotLabel", originalText: "Compression socks" },
    { field: "__proto__" },
    { recommendationId: "missing-slot" },
    { location: "guide" as const },
    { originalText: "compression socks" },
    { replacementText: null },
    { replacementText: genericCopy },
    { replacementText: "Visit https://example.com" },
  ]) {
    const issue = { ...review.issues[1]!, ...changes };
    assert.equal(editorialIssueCanApply(draft, issue), false, JSON.stringify(changes));
    assert.throws(
      () => applyEditorialCorrections(draft, { ...review, issues: [issue] }, [issue.id]),
      /campo exacto/,
    );
  }
  draft.recommendations[1]!.id = draft.recommendations[0]!.id;
  assert.equal(editorialIssueCanApply(draft, review.issues[1]!), false);
});

test("editorial review: content/context edits invalidate reports; affiliate/status changes alone do not", async () => {
  const draft = fixture();
  const { provider } = respondingProvider();
  const review = await reviewGuideEditorially(draft, provider);
  for (const field of [
    "title",
    "excerpt",
    "introduction",
    "conclusion",
    "seoTitle",
    "seoDescription",
    "primaryIntent",
  ] as const) {
    const edited = { ...draft, [field]: "Changed editorial text" };
    assert.ok(editorialReviewIsStale(edited, review), field);
    assert.throws(
      () => applyEditorialCorrections(edited, review, [review.issues[0]!.id]),
      /desactualizado/,
    );
  }
  const edited = structuredClone(draft);
  edited.recommendations[2]!.considerations = "Changed sibling field";
  assert.ok(editorialReviewIsStale(edited, review));
  assert.ok(editorialReviewIsStale({ ...draft, id: "guide_other" }, review));
  const commercial = structuredClone(draft);
  commercial.recommendations[0]!.directAffiliateUrl =
    "https://www.amazon.com/dp/B012345678?tag=changed-20";
  commercial.recommendations[0]!.productId = "product_other";
  commercial.status = "editing";
  commercial.updatedAt = "2026-09-14T01:00:00.000Z";
  assert.equal(editorialReviewIsStale(commercial, review), false);
  const result = applyEditorialCorrections(commercial, review, [review.issues[1]!.id]);
  assert.equal(
    result.draft.recommendations[0]!.directAffiliateUrl,
    commercial.recommendations[0]!.directAffiliateUrl,
  );
  assert.equal(result.draft.recommendations[0]!.productId, "product_other");
});

test("editorial review: technical repair is bounded to one invocation and includes both token usages", async () => {
  for (const invalid of ["{broken", { issues: [{ type: "invented" }] }]) {
    const { provider, calls } = respondingProvider(
      [invalid, { issues: [] }],
      [
        { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      ],
    );
    const review = await reviewGuideEditorially(fixture(), provider);
    assert.equal(review.status, "completed");
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.messages[1]!.content, /Technical retry/);
    assert.deepEqual(review.metrics, {
      reviewInvocations: 1,
      repairInvocations: 1,
      inputTokens: 30,
      outputTokens: 6,
      totalTokens: 36,
    });
  }
  const { provider, calls } = respondingProvider(["{broken", "{still broken"]);
  const failed = await reviewGuideEditorially(fixture(), provider);
  assert.equal(failed.status, "failed");
  assert.equal(calls.length, 2);
  assert.equal(failed.metrics.totalTokens, null);
  assert.deepEqual(failed.issues, []);
});

test("editorial review: request-local token usage wins over a concurrent call's shared metadata", async () => {
  const provider: GuideGenerationProvider = {
    providerId: "concurrent-test",
    lastCallMetadata: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 },
    async generateStructured(request) {
      request.onCallMetadata?.({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      return request.schema.parse({ issues: [] });
    },
  };
  const review = await reviewGuideEditorially(fixture(), provider);
  assert.equal(review.metrics.totalTokens, 15);
});

test("editorial review: no retry for network, credentials, rate limits or refusals; incomplete guides never call provider", async () => {
  for (const code of ["network", "authentication", "rate-limit", "refusal", "timeout"] as const) {
    let calls = 0;
    const provider: GuideGenerationProvider = {
      providerId: "test",
      async generateStructured() {
        calls++;
        throw new ProviderError("SECRET_TRACE", code);
      },
    };
    const report = await reviewGuideEditorially(fixture(), provider);
    assert.equal(calls, 1);
    assert.equal(report.status, "failed");
    assert.equal(report.metrics.repairInvocations, 0);
    assert.equal(report.metrics.totalTokens, null);
    assert.doesNotMatch(JSON.stringify(report), /SECRET_TRACE/);
    await assert.rejects(reviewGuideEditorially(createGuideDraft(), provider), /Completá/);
    const incomplete = fixture();
    delete incomplete.recommendations[1]!.selectionGuidance;
    await assert.rejects(reviewGuideEditorially(incomplete, provider), /Completá/);
    assert.equal(calls, 1);
  }
});

test("editorial review: history persists stable IDs, detected/applied state, failed and zero-issue reviews", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "editorial-review-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EditorialReviewStore(root);
  assert.deepEqual(await store.list(), []);
  const draft = fixture();
  const { provider } = respondingProvider();
  const review = await store.save(await reviewGuideEditorially(draft, provider));
  assert.deepEqual(await store.read(review.id), review);
  const result = applyEditorialCorrections(draft, review, [review.issues[0]!.id]);
  await store.save(result.review);
  const clean = respondingProvider([{ issues: [] }]);
  await store.save(await reviewGuideEditorially(draft, clean.provider));
  const bad = respondingProvider(["{bad", "{bad"]);
  await store.save(await reviewGuideEditorially(draft, bad.provider));
  const summary = summarizeEditorialReviews(await store.list());
  assert.equal(summary.reviewsRun, 3);
  assert.equal(summary.failedReviews, 1);
  assert.equal(summary.totalIssues, 2);
  assert.equal(summary.applied, 1);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.byType["meta-process-language"], 1);
  assert.equal(summary.byType["generic-or-thin-copy"], 1);
  assert.equal(summary.byType["excessive-repetition"], 0);
  assert.equal(summary.recentIssues[0]!.guideId, draft.id);
  assert.ok(
    summary.recentIssues.every(
      ({ reviewId, createdAt }) => reviewId === review.id && createdAt === review.createdAt,
    ),
  );
  const persisted = await readFile(join(store.directory, `${review.id}.json`), "utf8");
  assert.doesNotMatch(
    persisted,
    /PRIVATE_GENERATION_TRACE|product_existing|directAffiliateUrl|questionnaire/,
  );
  await assert.rejects(store.read("../outside"), /ID/);
});

test("editorial review: compare-before-save rejects competing corrections without losing sibling changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "editorial-review-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DraftStore(root);
  const draft = await store.save(fixture());
  const { provider } = respondingProvider();
  const review = await reviewGuideEditorially(draft, provider);
  const first = applyEditorialCorrections(draft, review, [review.issues[0]!.id]);
  const second = applyEditorialCorrections(draft, review, [review.issues[1]!.id]);
  const saves = await Promise.allSettled([
    store.save(first.draft, new Date(), draft),
    store.save(second.draft, new Date(), draft),
  ]);
  assert.equal(saves[0]!.status, "fulfilled");
  assert.equal(saves[1]!.status, "rejected");
  const saved = (await store.read(draft.id)) as GuideDraft;
  assert.equal(saved.introduction, fixedMeta);
  assert.equal(saved.recommendations[0]!.editorialDescription, genericCopy);
  await store.save({ ...saved, conclusion: "A subsequent normal save still works." });
});

test("editorial review: Studio review/apply/history flow has zero discovery, P.2, Product writes or extra LLM calls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "editorial-review-http-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(root, "content"), { recursive: true });
  const store = new DraftStore(join(root, "drafts"));
  const catalog = new ProductCatalog(root);
  const draft = fixture();
  draft.clusterId = catalog.read().clusters[0]!.id;
  draft.recommendations[0]!.productId = catalog.read().products[0]!.id;
  await store.save(draft);
  const before = await store.read(draft.id);
  const productsBefore = new Map(
    await Promise.all(
      (await readdir(join(root, "content/products"))).map(
        async (name) =>
          [name, await readFile(join(root, "content/products", name), "utf8")] as const,
      ),
    ),
  );
  const transport = respondingProvider();
  const operations: string[] = [];
  const provider: GuideGenerationProvider = {
    providerId: transport.provider.providerId,
    get lastCallMetadata() {
      return transport.provider.lastCallMetadata;
    },
    generateStructured(request) {
      operations.push(request.operation);
      assert.ok(["editorial-review", "editorial-review-repair"].includes(request.operation));
      return transport.provider.generateStructured(request);
    },
  };
  let discoveryCalls = 0;
  const server = createStudioServer(
    store,
    catalog,
    provider,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    {
      providerId: "serpapi",
      paidUsage: true,
      async search() {
        discoveryCalls++;
        throw new Error("Discovery must not run");
      },
    },
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://${STUDIO_HOST}:${address.port}`;
  const path = `/drafts/${draft.id}`;
  const post = (suffix: string, body = new URLSearchParams()) =>
    fetch(`${base}${path}${suffix}`, { method: "POST", body, redirect: "manual" });
  const response = await post("/editorial-review");
  assert.equal(response.status, 303);
  assert.deepEqual(await store.read(draft.id), before);
  const reviews = new EditorialReviewStore(root);
  const review = (await reviews.list())[0]!;
  let html = await (await fetch(`${base}${path}`)).text();
  for (const text of [
    "Revisar editorialmente",
    "Aplicar correcciones seleccionadas",
    "meta-process-language",
    "Texto original",
    "Reemplazo sugerido",
    "Informe vigente",
    "100 / 25 / 125",
  ])
    assert.ok(html.includes(text), text);
  const applied = await post(
    "/editorial-review/apply",
    new URLSearchParams({ reviewId: review.id, issueId: review.issues[1]!.id }),
  );
  assert.equal(applied.status, 303);
  const saved = (await store.read(draft.id)) as GuideDraft;
  assert.deepEqual(
    { ...saved, updatedAt: before.updatedAt },
    {
      ...before,
      recommendations: draft.recommendations.map((slot, index) =>
        index ? slot : { ...slot, editorialDescription: fixedGeneric },
      ),
    },
  );
  assert.ok((await reviews.read(review.id)).issues[1]!.appliedAt);
  assert.equal(
    (
      await post(
        "/editorial-review/apply",
        new URLSearchParams({ reviewId: review.id, issueId: review.issues[0]!.id }),
      )
    ).status,
    400,
  );
  html = await (await fetch(`${base}${path}`)).text();
  assert.match(html, /Informe desactualizado/);
  assert.match(html, /Aplicada/);
  const feedback = await (await fetch(`${base}/editorial-feedback`)).text();
  assert.match(feedback, /Feedback editorial/);
  assert.match(feedback, /meta-process-language: 1/);
  assert.match(feedback, /Correcciones aplicadas<\/dt><dd>1/);
  assert.deepEqual(operations, ["editorial-review"]);
  assert.equal(discoveryCalls, 0);
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(await readdir(join(root, "editorial-data")), ["editorial-reviews"]);
  const productsAfter = new Map(
    await Promise.all(
      (await readdir(join(root, "content/products"))).map(
        async (name) =>
          [name, await readFile(join(root, "content/products", name), "utf8")] as const,
      ),
    ),
  );
  assert.deepEqual(productsAfter, productsBefore);
});

test("editorial review: mock mode is explicit and does not pretend to diagnose quality", async () => {
  const review = await reviewGuideEditorially(fixture(), new MockGuideGenerationProvider());
  assert.equal(review.providerId, "mock");
  assert.equal(review.metrics.totalTokens, null);
  assert.deepEqual(review.issues, []);
});
