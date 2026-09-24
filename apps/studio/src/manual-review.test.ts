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
import { reopenGuideDraft } from "./guide-editor.ts";
import { prepareIdeaRecommendationPrompt } from "./idea-prompt.ts";
import { localPublicAsset, localPublicPage } from "./local-site.ts";
import { ProductCatalog } from "./product-catalog.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";
import {
  ManualReviewStore,
  applyCopyReview,
  decideCopyReview,
  ideaReviewRecord,
  manualFeedbackHints,
  proposeCopyReview,
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
  const proposal = await proposeCopyReview(
    draft,
    "editorialDescription",
    original.id,
    "thoughtful choice",
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
