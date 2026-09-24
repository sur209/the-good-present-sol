import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GuideGenerationProvider } from "./ai-provider.ts";
import { MockGuideGenerationProvider } from "./ai-provider.ts";
import { DraftStore } from "./draft-store.ts";
import { reopenGuideDraft } from "./guide-editor.ts";
import {
  IdeaResearchStore,
  approvedResearchHints,
  checkedResearchUrl,
  extractPageSignals,
  inspectResearchPage,
  researchGiftIdeas,
  robotsAllows,
} from "./idea-research.ts";
import { ProductCatalog } from "./product-catalog.ts";
import { IdeaRatingStore, ideaRatingHints, type IdeaRating } from "./idea-ratings.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";
import { REPOSITORY_ROOT, readEditorialContent, readPublicContent } from "./repository.ts";
import { STUDIO_HOST, createStudioServer } from "./server.ts";

const article =
  "https://www.goodhousekeeping.com/holidays/gift-ideas/g71229891/gifts-for-nurses-2026/";
const html = `<html><head><title>Gifts for Nurses &amp; Friends</title></head><body>
  <h1>Gifts for Nurses</h1><h2>A personalized badge reel</h2><h2>A portable lunch warmer</h2>
  <h2>A portable lunch warmer</h2><p>Article prose should not be retained.</p></body></html>`;

test("registered HTTPS source and robots rules gate research", () => {
  assert.equal(checkedResearchUrl(article).sourceName, "Good Housekeeping");
  assert.throws(() => checkedResearchUrl("http://www.goodhousekeeping.com/holidays/gifts"));
  assert.throws(() => checkedResearchUrl("https://localhost/holidays/gifts"));
  assert.throws(() => checkedResearchUrl("https://www.nytimes.com/other/story"));
  assert.throws(() => checkedResearchUrl(`${article}?secret=1`));
  const rules = "User-agent: *\nDisallow: /holidays/\nAllow: /holidays/gift-ideas/\n";
  assert.equal(robotsAllows(rules, "/holidays/gift-ideas/article"), true);
  assert.equal(robotsAllows(rules, "/holidays/other"), false);
  assert.equal(
    robotsAllows(
      "User-agent: TheGoodPresentResearch\nDisallow: /\nUser-agent: *\nAllow: /",
      "/article",
    ),
    false,
  );
});

test("extracts a bounded title and distinct headings, not article paragraphs", () => {
  assert.deepEqual(extractPageSignals(html), {
    title: "Gifts for Nurses & Friends",
    headings: ["Gifts for Nurses", "A personalized badge reel", "A portable lunch warmer"],
  });
});

test("a compact numeric rating is visible to future idea outlines", () => {
  const publicContent = readPublicContent();
  const guide = publicContent.guides.find((item) => item.id === "guide_nurse-practical")!;
  const draft = reopenGuideDraft(guide, publicContent);
  const prompt = prepareOutlinePrompt(draft, readEditorialContent(), [
    "Editor rated “A compact lunch warmer” 9/10.",
  ]).prompt;
  assert.match(prompt, /A compact lunch warmer/);
  assert.match(prompt, /scores 8-10 as positive patterns/);
  assert.match(prompt, /Mere usefulness is not enough/);
  assert.match(prompt, /occupation as context/);
});

test("rating hints keep positive, negative and reasoned middle examples in a small sample", () => {
  const rating = (label: string, score: number, reason?: string): IdeaRating => ({
    ideaKey: label,
    clusterId: "cluster_nurse-gifts",
    label,
    score,
    ...(reason ? { reason } : {}),
    updatedAt: "2026-09-24T12:00:00.000Z",
    history: [],
  });
  const ratings = [
    ...Array.from({ length: 10 }, (_, index) => rating(`Low without context ${index}`, 1)),
    rating("Generic frame", 3, "Too generic for this occasion."),
    rating("Work notebook", 1, "A phone already covers this."),
    rating("Occupational trinket", 2, "More cliché than gift."),
    rating("Desk plant", 8, "Simple and attractive."),
    rating("Kitchen herbs", 8, "Useful for cooking."),
    rating("Snack basket", 8, "Enjoyable to share."),
    rating("Desk organizer", 7, "Useful at home."),
    rating("Hobby kit", 6, "Good for a known interest."),
    { ...rating("Other group", 10), clusterId: "cluster_firefighter-gifts" },
  ];
  const hints = ideaRatingHints(ratings, "cluster_nurse-gifts");
  assert.equal(hints.length, 8);
  assert.equal(hints.filter((hint) => / 8\/10\./.test(hint)).length, 3);
  assert.equal(hints.filter((hint) => / [1-4]\/10\./.test(hint)).length, 3);
  assert.equal(hints.filter((hint) => / [5-7]\/10\./.test(hint)).length, 2);
  assert.ok(hints.every((hint) => hint.includes("Context and reason:")));
  assert.ok(hints.every((hint) => !hint.includes("Other group")));
});

test("blocked pages are not fetched", async () => {
  const seen: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    seen.push(String(input));
    return new Response("User-agent: *\nDisallow: /holidays/", { status: 200 });
  };
  await assert.rejects(inspectResearchPage(article, fetcher), /robots.txt/);
  assert.equal(seen.length, 1);
});

test("research saves only grounded, distinct proposals and needs human approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "tgp-research-"));
  try {
    const store = new IdeaResearchStore(root);
    const fetcher: typeof fetch = async (input) =>
      String(input).endsWith("/robots.txt")
        ? new Response("User-agent: *\nAllow: /", { status: 200 })
        : new Response(html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    const provider: GuideGenerationProvider = {
      providerId: "test",
      async generateStructured(request) {
        assert.match(request.prompt, /A portable lunch warmer/);
        assert.match(request.prompt, /nurse gifts/);
        assert.match(request.prompt, /2\/10/);
        return request.schema.parse({
          proposals: [
            {
              giftClass: "A compact lunch warmer",
              evidenceHeading: "A portable lunch warmer",
              fit: "Helps carry a warm meal.",
            },
            {
              giftClass: "A compact lunch warmer",
              evidenceHeading: "A portable lunch warmer",
              fit: "Duplicate.",
            },
            {
              giftClass: "A magic stethoscope",
              evidenceHeading: "Invented evidence",
              fit: "Not grounded.",
            },
            {
              giftClass: "A shift tote",
              evidenceHeading: "A personalized badge reel",
              fit: "Already in the guide.",
            },
          ],
        }) as never;
      },
    };
    const first = await researchGiftIdeas(
      article,
      "cluster_nurse-gifts",
      ["A shift tote"],
      provider,
      store,
      fetcher,
      ["Editor rated “A dull mug” 2/10."],
    );
    assert.equal(first.length, 1);
    assert.equal(first[0]!.status, "proposed");
    assert.equal(first[0]!.promptVersion, "research-v2");
    assert.equal(first[0]!.sourceUrl, article);
    assert.deepEqual(approvedResearchHints(await store.list("cluster_nurse-gifts")), []);
    const accepted = await store.decide(first[0]!.id, "accepted");
    assert.equal(accepted.status, "accepted");
    assert.deepEqual(approvedResearchHints(await store.list("cluster_nurse-gifts")), [
      "Editor-approved gift class to consider: A compact lunch warmer",
    ]);
    assert.deepEqual(
      approvedResearchHints(await store.list("cluster_nurse-gifts"), new Set([first[0]!.id])),
      [],
    );
    await assert.rejects(store.decide(first[0]!.id, "rejected"), /resuelta/);
    const second = await researchGiftIdeas(
      article,
      "cluster_nurse-gifts",
      ["A shift tote"],
      provider,
      store,
      fetcher,
      ["Editor rated “A dull mug” 2/10."],
    );
    assert.equal(second.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Studio shows pending ideas and records an explicit editor decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "tgp-research-ui-"));
  let server: ReturnType<typeof createStudioServer> | undefined;
  try {
    await cp(join(REPOSITORY_ROOT, "content"), join(root, "content"), { recursive: true });
    const researchStore = new IdeaResearchStore(root);
    const record = await researchStore.save({
      id: "research_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      clusterId: "cluster_nurse-gifts",
      sourceName: "Good Housekeeping",
      sourceUrl: article,
      pageTitle: "Gifts for Nurses",
      giftClass: "A compact lunch warmer",
      evidenceHeading: "A portable lunch warmer",
      fit: "A meal-related gift for a long shift.",
      status: "proposed",
      createdAt: new Date().toISOString(),
    });
    const draftStore = new DraftStore(join(root, "drafts"), root);
    server = createStudioServer(
      draftStore,
      new ProductCatalog(root),
      new MockGuideGenerationProvider(),
    );
    server.listen(0, STUDIO_HOST);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const origin = `http://${STUDIO_HOST}:${address.port}`;
    const listing = await fetch(`${origin}/idea-research`);
    assert.equal(listing.status, 200);
    const body = await listing.text();
    const navigation = body.match(/<nav aria-label="Principal">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    assert.match(navigation, /<summary>Motor de ideas<\/summary>/);
    assert.match(navigation, /<summary>Labs opcionales<\/summary>/);
    assert.match(navigation, /Product Intelligence[\s\S]*?Cobertura[\s\S]*?Sourcing/);
    assert.match(navigation, /Opportunity Lab[\s\S]*?Oportunidades/);
    assert.deepEqual(
      [...navigation.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
      [
        "/",
        "/local/",
        "/drafts/new",
        "/idea-research",
        "/idea-research/prompts",
        "/editorial-feedback",
        "/products",
        "/products/intake",
        "/affiliate-programs",
        "/affiliate-operations",
        "/product-intelligence",
        "/product-sourcing",
        "/opportunities",
      ],
    );
    assert.match(body, /A compact lunch warmer/);
    assert.match(body, /<img src="\/local-assets\/images\/practical\/compression-socks\.webp"/);
    const researchPosition = body.indexOf("A compact lunch warmer");
    const researchRow = body.slice(
      body.lastIndexOf("<tr>", researchPosition),
      body.indexOf("</tr>", researchPosition),
    );
    assert.doesNotMatch(researchRow, /<img\b/);
    const content = readPublicContent(root);
    const practicalGuide = content.guides.find((guide) => guide.id === "guide_nurse-practical")!;
    const reopened = reopenGuideDraft(practicalGuide, content);
    await draftStore.save({
      ...reopened,
      generationMetadata: {
        providerId: "mock",
        generatedAt: new Date().toISOString(),
        promptVersion: "outline-v1",
        prompt: "Previously saved prompt snapshot",
        validation: { success: true },
      },
      recommendations: reopened.recommendations.map((item) =>
        item.id === "practical_compression-socks"
          ? { ...item, heading: "A different gift idea" }
          : item,
      ),
    });
    const editedBody = await (await fetch(`${origin}/idea-research`)).text();
    const editedPosition = editedBody.indexOf("A different gift idea");
    const editedRow = editedBody.slice(
      editedBody.lastIndexOf("<tr>", editedPosition),
      editedBody.indexOf("</tr>", editedPosition),
    );
    assert.doesNotMatch(editedRow, /<img\b/);
    assert.match(body, /Buscar y guardar ideas/);
    assert.match(body, /Asignar puntajes/);
    assert.match(body, /Motivo y contexto \(opcional\)/);
    assert.match(body, /pulsá «Asignar puntajes» en cualquier fila/);
    assert.match(body, /data-idea-rating/);
    assert.match(body, /<script src="\/idea-research\.js" defer><\/script>/);
    assert.match(listing.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    const script = await fetch(`${origin}/idea-research.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /fetch\(form\.action/);
    assert.match(body, /Guía pública/);
    assert.match(body, /Borrador|Sin guía/);
    assert.match(body, new RegExp(`/idea-research/${record.id}/accept`));
    const ratingStore = new IdeaRatingStore(root);
    const rated = await fetch(`${origin}/idea-research/rate`, {
      method: "POST",
      body: new URLSearchParams({
        clusterId: "cluster_nurse-gifts",
        ideaKey: `research:${record.id}`,
        score: "9",
      }),
      redirect: "manual",
    });
    assert.equal(rated.status, 303, await rated.text());
    assert.equal((await ratingStore.list())[0]!.score, 9);
    assert.deepEqual(ideaRatingHints(await ratingStore.list(), "cluster_nurse-gifts"), [
      "Editor rated “A compact lunch warmer” 9/10.",
    ]);
    const updated = await fetch(`${origin}/idea-research/rate`, {
      method: "POST",
      body: new URLSearchParams({
        clusterId: "cluster_nurse-gifts",
        ideaKey: `research:${record.id}`,
        score: "3",
      }),
      redirect: "manual",
    });
    assert.equal(updated.status, 303);
    assert.deepEqual(
      (await ratingStore.list())[0]!.history.map((item) => item.score),
      [9, 3],
    );
    const withoutReload = await fetch(`${origin}/idea-research/rate`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams([
        ["clusterId", "cluster_nurse-gifts"],
        ["ideaKey", `research:${record.id}`],
        ["score", "8"],
        ["reason", "Useful at home, not a redundant work tool."],
        ["ideaKey", "guide:guide_nurse-practical:practical_compression-socks"],
        ["score", "2"],
        ["reason", "Too ordinary to feel like a gift."],
      ]),
      redirect: "manual",
    });
    assert.equal(withoutReload.status, 200);
    assert.deepEqual(await withoutReload.json(), {
      ratings: [
        {
          ideaKey: `research:${record.id}`,
          score: 8,
          reason: "Useful at home, not a redundant work tool.",
        },
        {
          ideaKey: "guide:guide_nurse-practical:practical_compression-socks",
          score: 2,
          reason: "Too ordinary to feel like a gift.",
        },
      ],
    });
    const savedRatings = await ratingStore.list();
    assert.equal(savedRatings.length, 2);
    assert.deepEqual(
      savedRatings
        .find((rating) => rating.ideaKey === `research:${record.id}`)
        ?.history.map((item) => item.score),
      [9, 3, 8],
    );
    assert.equal(
      savedRatings.find((rating) => rating.ideaKey === `research:${record.id}`)?.history[2]?.reason,
      "Useful at home, not a redundant work tool.",
    );
    assert.match(
      ideaRatingHints(savedRatings, "cluster_nurse-gifts").join(" "),
      /Context and reason: Too ordinary to feel like a gift\./,
    );
    const prompts = await fetch(
      `${origin}/idea-research/prompts?cluster=cluster_nurse-gifts&draft=guide_nurse-practical`,
    );
    assert.equal(prompts.status, 200);
    const promptBody = await prompts.text();
    assert.match(promptBody, /Plantilla de instrucciones actual/);
    assert.match(promptBody, /Último prompt guardado/);
    assert.match(promptBody, /Esto no es un historial completo/);
    assert.match(promptBody, /outline-v4/);
    assert.match(promptBody, /research-v2/);
    assert.match(promptBody, /outline-v1/);
    assert.match(promptBody, /Previously saved prompt snapshot/);
    assert.match(promptBody, /Useful at home, not a redundant work tool\./);
    assert.match(promptBody, /Structured input/);
    const invalid = await fetch(`${origin}/idea-research/rate`, {
      method: "POST",
      body: new URLSearchParams({
        clusterId: "cluster_nurse-gifts",
        ideaKey: `research:${record.id}`,
        score: "11",
      }),
    });
    assert.equal(invalid.status, 400);
    const invalidWithoutReload = await fetch(`${origin}/idea-research/rate`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams([
        ["clusterId", "cluster_nurse-gifts"],
        ["ideaKey", `research:${record.id}`],
        ["score", "7"],
        ["ideaKey", "guide:guide_nurse-practical:practical_compression-socks"],
        ["score", "11"],
      ]),
    });
    assert.equal(invalidWithoutReload.status, 400);
    assert.match((await invalidWithoutReload.json()).error, /1 al 10/);
    const longReason = await fetch(`${origin}/idea-research/rate`, {
      method: "POST",
      body: new URLSearchParams({
        clusterId: "cluster_nurse-gifts",
        ideaKey: `research:${record.id}`,
        score: "7",
        reason: "x".repeat(241),
      }),
    });
    assert.equal(longReason.status, 400);
    assert.deepEqual(await ratingStore.list(), savedRatings);
    const legacy = await fetch(`${origin}/idea-research/rate`, {
      method: "POST",
      body: new URLSearchParams({
        clusterId: "cluster_nurse-gifts",
        ideaKey: `research:${record.id}`,
        score: "7",
      }),
      redirect: "manual",
    });
    assert.equal(legacy.status, 303);
    assert.equal(
      (await ratingStore.list()).find((rating) => rating.ideaKey === `research:${record.id}`)
        ?.reason,
      "Useful at home, not a redundant work tool.",
    );
    const cleared = await fetch(`${origin}/idea-research/rate`, {
      method: "POST",
      body: new URLSearchParams({
        clusterId: "cluster_nurse-gifts",
        ideaKey: `research:${record.id}`,
        score: "6",
        reason: "",
      }),
      redirect: "manual",
    });
    assert.equal(cleared.status, 303);
    assert.equal(
      (await ratingStore.list()).find((rating) => rating.ideaKey === `research:${record.id}`)
        ?.reason,
      undefined,
    );
    const crossOrigin = await fetch(`${origin}/idea-research/${record.id}/accept`, {
      method: "POST",
      headers: { origin: "https://outside.example" },
      body: new URLSearchParams(),
    });
    assert.equal(crossOrigin.status, 400);
    const accepted = await fetch(`${origin}/idea-research/${record.id}/accept`, {
      method: "POST",
      body: new URLSearchParams(),
      redirect: "manual",
    });
    assert.equal(accepted.status, 303);
    assert.equal((await researchStore.read(record.id)).status, "accepted");
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(root, { recursive: true, force: true });
  }
});
