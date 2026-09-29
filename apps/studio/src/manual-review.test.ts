import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MockGuideGenerationProvider,
  type GuideGenerationProvider,
  type StructuredGenerationRequest,
} from "./ai-provider.ts";
import { DraftStore } from "./draft-store.ts";
import { EditorialReviewStore } from "./editorial-review.ts";
import { reopenGuideDraft } from "./guide-editor.ts";
import { prepareIdeaRecommendationPrompt } from "./idea-prompt.ts";
import { localPublicAsset, localPublicPage } from "./local-site.ts";
import { ProductCatalog } from "./product-catalog.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";
import {
  ManualReviewStore,
  applyIdeaReview,
  applyCopyReview,
  decideCopyReview,
  ideaReviewRecord,
  manualFeedbackHints,
  proposeCopyReview,
  proposeIdeaReview,
  rejectIdeaReview,
  replaceIdeaInDraft,
} from "./manual-review.ts";
import { REPOSITORY_ROOT, readEditorialContent, readPublicContent } from "./repository.ts";
import { STUDIO_HOST, createStudioServer } from "./server.ts";

function sampleDraft() {
  const content = readPublicContent();
  const guide = content.guides.find((item) => item.id === "guide_nurse-practical")!;
  return reopenGuideDraft(guide, content);
}

test("replacing an idea clears stale product, copy, and illustration identity", () => {
  const draft = sampleDraft();
  const old = draft.recommendations[0]!;
  const replaced = replaceIdeaInDraft(draft, old.id, "A hand-thrown tea cup");
  const next = replaced.draft.recommendations[0]!;
  assert.notEqual(next.id, old.id);
  assert.equal(next.id, replaced.newId);
  assert.equal(next.position, old.position);
  assert.equal(next.heading, "A hand-thrown tea cup");
  assert.equal(next.productId, undefined);
  assert.equal(next.editorialDescription, undefined);
  assert.equal(next.whyItFits, undefined);
  assert.equal(next.editorialStatus, "needs-generation");
  assert.deepEqual(replaced.draft.recommendations.slice(1), draft.recommendations.slice(1));
});

test("targeted copy proposal uses one field and needs approval", async () => {
  const draft = sampleDraft();
  let observedInput: unknown;
  const provider: GuideGenerationProvider = {
    providerId: "test",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      observedInput = request.input;
      return request.schema.parse({ replacementText: "A clearer, specific sentence." });
    },
  };
  const original = draft.recommendations[0]!;
  const selectedQuote = original.editorialDescription!.split(" ").slice(0, 2).join(" ");
  const proposal = await proposeCopyReview(
    draft,
    "editorialDescription",
    original.id,
    selectedQuote,
    "This sounds generic.",
    provider,
  );
  assert.equal(proposal.status, "proposed");
  assert.equal(draft.recommendations[0]!.editorialDescription, original.editorialDescription);
  assert.deepEqual(
    Object.keys(observedInput as object).sort(),
    ["currentText", "editorComment", "field", "guideTitle", "idea", "selectedQuote"].sort(),
  );
  const applied = applyCopyReview(draft, proposal);
  assert.equal(applied.recommendations[0]!.editorialDescription, "A clearer, specific sentence.");
  assert.equal(
    applied.recommendations[1]!.editorialDescription,
    draft.recommendations[1]!.editorialDescription,
  );
  assert.equal(decideCopyReview(proposal, "rejected").status, "rejected");
  assert.throws(
    () => applyCopyReview({ ...draft, recommendations: applied.recommendations }, proposal),
    /cambió/,
  );
});

test("generated idea replacement stays pending until an explicit decision", async () => {
  const draft = sampleDraft();
  const original = draft.recommendations[0]!;
  let observedRequest: StructuredGenerationRequest<unknown> | undefined;
  const provider: GuideGenerationProvider = {
    providerId: "test",
    modelId: "test-model",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      observedRequest = request as StructuredGenerationRequest<unknown>;
      return request.schema.parse({ concept: "A framed custom night-sky print" });
    },
  };
  const proposal = await proposeIdeaReview(
    draft,
    original.id,
    "The current idea feels too ordinary.",
    ["Rating profile: raise the quality bar."],
    ["A ceramic serving bowl"],
    provider,
  );
  assert.equal(observedRequest?.operation, "manual-idea-replacement");
  assert.equal(observedRequest?.reasoningEffort, "low");
  assert.deepEqual((observedRequest?.input as { roundIdeasToAvoid?: unknown }).roundIdeasToAvoid, [
    "A ceramic serving bowl",
  ]);
  assert.match(observedRequest?.prompt ?? "", /purchasable physical product class/);
  assert.match(observedRequest?.prompt ?? "", /Never propose an experience/);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.promptVersion, "idea-replacement-v4");
  assert.equal(proposal.proposedText, "A framed custom night-sky print");
  assert.equal(draft.recommendations[0]!.id, original.id);

  const applied = applyIdeaReview(draft, proposal);
  const replacement = applied.draft.recommendations[0]!;
  assert.notEqual(replacement.id, original.id);
  assert.equal(replacement.heading, "A framed custom night-sky print");
  assert.equal(replacement.editorialStatus, "needs-generation");
  assert.equal(applied.record.status, "accepted");
  assert.equal(applied.record.replacementRecommendationId, replacement.id);
  assert.equal(rejectIdeaReview(proposal).status, "rejected");
});

test("idea replacement rejects experiences even when the provider ignores the prompt", async () => {
  const draft = sampleDraft();
  const provider: GuideGenerationProvider = {
    providerId: "test",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      return request.schema.parse({ concept: "A flexible hands-on creative workshop" });
    },
  };
  await assert.rejects(
    proposeIdeaReview(draft, draft.recommendations[0]!.id, "Too ordinary.", [], [], provider),
    /physical product/,
  );
});

test("idea replacement rejects an exact duplicate from the current round", async () => {
  const draft = sampleDraft();
  const provider: GuideGenerationProvider = {
    providerId: "test",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      return request.schema.parse({ concept: "A ceramic serving bowl" });
    },
  };
  await assert.rejects(
    proposeIdeaReview(
      draft,
      draft.recommendations[0]!.id,
      "Too ordinary.",
      [],
      ["A ceramic serving bowl"],
      provider,
    ),
    /ronda actual/,
  );
});

test("idea replacement retries a renamed product from the same family once", async () => {
  const draft = sampleDraft();
  let calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "test",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      calls += 1;
      return request.schema.parse({
        concept:
          calls === 1 ? "A personalized leather-bound recipe journal" : "A birthstone pendant",
      });
    },
  };
  const proposal = await proposeIdeaReview(
    draft,
    draft.recommendations[0]!.id,
    "Too ordinary.",
    [],
    ["A personalized recipe journal"],
    provider,
  );
  assert.equal(calls, 2);
  assert.equal(proposal.proposedText, "A birthstone pendant");
});

test("retired reserve ideas are rejected even beyond the twelve-item round limit", async () => {
  const draft = sampleDraft();
  let calls = 0;
  const provider: GuideGenerationProvider = {
    providerId: "test",
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      calls++;
      return request.schema.parse({ concept: "A supportive calf recovery brace" });
    },
  };
  await assert.rejects(
    proposeIdeaReview(
      draft,
      draft.recommendations[0]!.id,
      "Find a useful gift.",
      [],
      Array.from({ length: 12 }, (_, i) => `Other idea ${i}`),
      provider,
      new Date(),
      ["A supportive calf recovery brace"],
    ),
    /repite/,
  );
  assert.equal(calls, 2);
});

test("review history persists and contributes only short accepted hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "tgp-manual-review-"));
  try {
    const draft = sampleDraft();
    const item = draft.recommendations[0]!;
    const replaced = replaceIdeaInDraft(draft, item.id, "A hand-thrown tea cup");
    const record = ideaReviewRecord(
      draft,
      item.id,
      replaced.newId,
      "A hand-thrown tea cup",
      "The old idea felt too familiar.",
    );
    const store = new ManualReviewStore(root);
    await store.save(record);
    assert.deepEqual(await store.read(record.id), record);
    assert.equal((await store.list(draft.id)).length, 1);
    assert.match(manualFeedbackHints(await store.list(), "idea")[0]!, /too familiar/);
    assert.doesNotMatch(manualFeedbackHints(await store.list(), "idea")[0]!, /hand-thrown/);
    assert.deepEqual(manualFeedbackHints(await store.list(), "copy"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted feedback appears as bounded examples in future prompts", () => {
  const draft = sampleDraft();
  const changed = replaceIdeaInDraft(draft, draft.recommendations[0]!.id, "A hand-thrown tea cup");
  const ideaHints = ["Editor replaced a repeated mug with a hand-thrown tea cup."];
  const copyHints = ["Editor prefers concrete, contemporary copy."];
  assert.match(
    prepareOutlinePrompt(draft, readEditorialContent(), ideaHints).prompt,
    /hand-thrown tea cup/,
  );
  assert.match(
    prepareIdeaRecommendationPrompt(changed.draft, changed.newId, copyHints).prompt,
    /contemporary copy/,
  );
  assert.doesNotMatch(
    prepareIdeaRecommendationPrompt(changed.draft, changed.newId).prompt,
    /contemporary copy/,
  );
});

test("local page keeps generated site styling and blocks traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "tgp-local-site-"));
  try {
    const dist = join(root, "apps", "site", "dist");
    await mkdir(join(dist, "nurse-gifts", "practical"), { recursive: true });
    await mkdir(join(dist, "_astro"), { recursive: true });
    await writeFile(
      join(dist, "nurse-gifts", "practical", "index.html"),
      '<html><head><link rel="stylesheet" href="/_astro/site.css"></head><body><a href="/nurse-gifts/">Nurse Gifts</a><img src="/images/gift.webp"></body></html>',
    );
    await writeFile(join(dist, "_astro", "site.css"), "body{color:red}");
    const page = await localPublicPage(root, "/local/nurse-gifts/practical/");
    assert.match(page, /href="\/local-assets\/_astro\/site\.css"/);
    assert.match(page, /href="\/local\/nurse-gifts\/"/);
    assert.match(page, /src="\/local-assets\/images\/gift\.webp"/);
    assert.match(page, /name="robots" content="noindex,nofollow"/);
    assert.match(page, /local-review\.js/);
    const content = readPublicContent();
    const guide = content.guides.find((item) => item.id === "guide_nurse-practical")!;
    const withDraft = await localPublicPage(
      root,
      "/local/nurse-gifts/practical/",
      guide,
      reopenGuideDraft(guide, content),
    );
    assert.match(withDraft, /"draftType":"gift-guide"/);
    assert.match(withDraft, /"originalRecommendations":\[/);
    assert.equal(
      (await localPublicAsset(root, "/local-assets/_astro/site.css")).body.toString(),
      "body{color:red}",
    );
    await assert.rejects(
      localPublicAsset(root, "/local-assets/images/../secret"),
      /Ruta local no válida/,
    );
    assert.equal(await readFile(join(dist, "_astro", "site.css"), "utf8"), "body{color:red}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local review generates one idea, then requires human approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "tgp-local-flow-"));
  let server: ReturnType<typeof createStudioServer> | undefined;
  try {
    await cp(join(REPOSITORY_ROOT, "content"), join(root, "content"), { recursive: true });
    const store = new DraftStore(join(root, "drafts"), root);
    const old = sampleDraft();
    const changed = replaceIdeaInDraft(old, old.recommendations[0]!.id, "A hand-thrown tea cup");
    const saved = await store.save(changed.draft);
    const acceptedChange = ideaReviewRecord(
      old,
      old.recommendations[0]!.id,
      changed.newId,
      "A hand-thrown tea cup",
      "The previous idea felt too ordinary.",
    );
    await new ManualReviewStore(root).save(acceptedChange);
    server = createStudioServer(store, new ProductCatalog(root), new MockGuideGenerationProvider());
    server.listen(0, STUDIO_HOST);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const origin = `http://${STUDIO_HOST}:${address.port}`;
    const base = {
      guideId: saved.id,
      recommendationId: changed.newId,
      revision: String(saved.revision),
    };
    const generated = await fetch(`${origin}/local/review/generate-idea-copy`, {
      method: "POST",
      body: new URLSearchParams(base),
      redirect: "manual",
    });
    assert.equal(generated.status, 303);
    const proposed = await store.read(saved.id);
    if (proposed.draftType !== "gift-guide") throw new Error("Expected guide draft");
    const idea = proposed.recommendations[0]!;
    assert.equal(idea.editorialStatus, "needs-review");
    assert.ok(idea.editorialDescription);
    assert.ok(idea.whyItFits);
    assert.equal(idea.productId, undefined);
    const approved = await fetch(`${origin}/local/review/approve-idea-copy`, {
      method: "POST",
      body: new URLSearchParams({ ...base, revision: String(proposed.revision) }),
      redirect: "manual",
    });
    assert.equal(approved.status, 303);
    const final = await store.read(saved.id);
    if (final.draftType !== "gift-guide") throw new Error("Expected guide draft");
    assert.equal(final.recommendations[0]!.editorialStatus, "ready");
    const automaticReviews = await new EditorialReviewStore(root).list();
    assert.equal(automaticReviews.length, 1);
    assert.equal(automaticReviews[0]!.trigger?.manualReviewId, acceptedChange.id);
    assert.equal(automaticReviews[0]!.trigger?.replacementRecommendationId, changed.newId);
    const crossOrigin = await fetch(`${origin}/local/review/approve-idea-copy`, {
      method: "POST",
      headers: { origin: "https://outside.example" },
      body: new URLSearchParams({ ...base, revision: String(final.revision) }),
    });
    assert.equal(crossOrigin.status, 400);
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(root, { recursive: true, force: true });
  }
});
