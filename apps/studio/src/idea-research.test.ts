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
import { IdeaAuditStore } from "./idea-audits.ts";
import {
  IdeaResearchStore,
  analyzeGiftDiversity,
  approvedResearchHints,
  blockedResearchIdeas,
  checkedResearchUrl,
  extractPageSignals,
  generateProductGroundedGuideIdeas,
  giftConceptFamily,
  inspectResearchPage,
  researchGiftIdeas,
  robotsAllows,
} from "./idea-research.ts";
import type { ProductDiscoverySource } from "./modules/product-sources/discovery.ts";
import { ProductCatalog } from "./product-catalog.ts";
import { IdeaRatingStore, ideaRatingHints, type IdeaRating } from "./idea-ratings.ts";
import { ManualReviewStore } from "./manual-review.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";
import { REPOSITORY_ROOT, readEditorialContent, readPublicContent } from "./repository.ts";
import { STUDIO_HOST, createStudioServer } from "./server.ts";

const article =
  "https://www.goodhousekeeping.com/holidays/gift-ideas/g71229891/gifts-for-nurses-2026/";

test("reserve classification persists independently of approval and gates hint contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "reserve-policy-"));
  try {
    const store = new IdeaResearchStore(root);
    const categories = ["retired", "needs_review", "replacement_variant", "shortlist"] as const;
    for (const [index, category] of categories.entries()) {
      await store.save({
        id: `research_00000000-0000-4000-8000-00000000000${index}`,
        clusterId: "cluster_nurse-gifts",
        guideId: "guide_nurse-practical",
        sourceName: "Test",
        sourceUrl: article,
        pageTitle: "Test evidence",
        giftClass: `Gift option ${category}`,
        evidenceHeading: "Observed physical product",
        fit: "A context-dependent gift",
        status: "accepted",
        createdAt: "2026-09-29T00:00:00.000Z",
        reserveReview: {
          category,
          reason: "Compare rather than duplicate.",
          reviewedAt: "2026-09-29",
          ...(category === "shortlist" ? { suggestedGuideSlug: "practical" } : {}),
        },
      });
    }
    const records = await store.list();
    assert.ok(records.every((r) => r.status === "accepted"));
    assert.equal(blockedResearchIdeas(records).length, 2);
    assert.equal(approvedResearchHints(records).length, 0);
    assert.equal(approvedResearchHints(records, new Set(), { guideSlug: "practical" }).length, 1);
    const hints = approvedResearchHints(records, new Set(), {
      replacement: true,
      guideId: "guide_nurse-practical",
      guideSlug: "practical",
    });
    assert.equal(hints.length, 2);
    assert.match(hints[0]!, /shortlist/);
    assert.ok(hints.every((hint) => !/retired|needs_review/.test(hint)));
    assert.equal(
      approvedResearchHints(records, new Set(records.map((r) => r.id)), {
        replacement: true,
        guideId: "guide_nurse-practical",
        guideSlug: "practical",
      }).length,
      0,
    );
    assert.equal(
      approvedResearchHints(records, new Set(), {
        replacement: true,
        guideId: "guide_other",
        guideSlug: "other",
      }).length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
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

test("positive feedback teaches a quality without repeating the rated object", () => {
  const publicContent = readPublicContent();
  const guide = publicContent.guides.find((item) => item.id === "guide_nurse-practical")!;
  const draft = reopenGuideDraft(guide, publicContent);
  const hints = ideaRatingHints(
    [
      {
        ideaKey: "lunch-warmer",
        clusterId: "cluster_nurse-gifts",
        label: "A compact lunch warmer",
        score: 9,
        reason: "It feels generous and useful beyond work.",
        updatedAt: "2026-09-24T12:00:00.000Z",
        history: [],
      },
    ],
    "cluster_nurse-gifts",
  );
  const prompt = prepareOutlinePrompt(draft, readEditorialContent(), hints).prompt;
  assert.doesNotMatch(prompt, /A compact lunch warmer/);
  assert.match(prompt, /It feels generous and useful beyond work/);
  assert.match(prompt, /different gift class/);
  assert.match(prompt, /Positive entries intentionally omit the rated object/);
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
  assert.equal(hints.filter((hint) => hint.startsWith("Rating profile")).length, 1);
  assert.equal(hints.filter((hint) => hint.startsWith("Positive preference pattern")).length, 2);
  assert.equal(hints.filter((hint) => hint.startsWith("Negative example")).length, 3);
  assert.equal(hints.filter((hint) => hint.startsWith("Conditional preference")).length, 2);
  assert.match(hints[0]!, /18 ratings, average 2\.9\/10/);
  assert.match(hints[0]!, /3 high \(8-10\), 2 workable \(5-7\), 13 weak \(1-4\)/);
  assert.ok(hints.some((hint) => hint.includes("Generic frame")));
  assert.ok(hints.every((hint) => !hint.includes("Desk plant")));
  assert.ok(hints.every((hint) => !hint.includes("Desk organizer")));
  assert.ok(hints.every((hint) => !hint.includes("Other group")));
});

test("concept families distinguish related products and report the third appearance", () => {
  assert.equal(
    giftConceptFamily("A Premium Wireless Charging Dock")?.id,
    "stationary-device-charger",
  );
  assert.equal(giftConceptFamily("A portable power bank")?.id, "portable-power-bank");
  const diversity = analyzeGiftDiversity([
    {
      id: "guide_one",
      title: "Guide one",
      recommendations: [
        { heading: "A Premium Wireless Charging Dock" },
        { heading: "An Insulated Bottle" },
        { heading: "A Water Bottle" },
      ],
    },
    {
      id: "guide_two",
      title: "Guide two",
      recommendations: [{ heading: "A tidy bedside charging station" }],
    },
    {
      id: "guide_three",
      title: "Guide three",
      recommendations: [{ heading: "A Compact Multi-Device Charging Station" }],
    },
  ]);
  assert.deepEqual(
    diversity.crossGuide.map(({ familyId, count }) => ({ familyId, count })),
    [{ familyId: "stationary-device-charger", count: 3 }],
  );
  assert.deepEqual(
    diversity.withinGuide.map(({ familyId, count, guides }) => ({ familyId, count, guides })),
    [{ familyId: "drink-container", count: 2, guides: ["Guide one"] }],
  );
});

test("diversity catches named household families without treating every bag as a tote", () => {
  assert.equal(
    giftConceptFamily("A Magnetic Power Bank With a Folding Stand")?.id,
    "portable-power-bank",
  );
  assert.equal(giftConceptFamily("Initialed Leather Work Tote")?.id, "tote");
  assert.equal(giftConceptFamily("A Ceramic Bakeware Set")?.id, "bakeware");
  assert.equal(giftConceptFamily("An Electric Neck-and-Shoulder Heating Pad")?.id, "heat-wrap");
  assert.equal(giftConceptFamily("A Fragrance-Free Hand Cream Duo")?.id, "hand-cream");
  assert.notEqual(giftConceptFamily("A Compact Crossbody Sling Bag")?.id, "tote");
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
    assert.equal(first[0]!.promptVersion, "research-v4");
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

test("product-first automation fills a complete guide from deduplicated Amazon results", async () => {
  const root = await mkdtemp(join(tmpdir(), "tgp-product-ideas-"));
  try {
    const store = new IdeaResearchStore(root);
    const searches: string[] = [];
    const discoverySource: ProductDiscoverySource = {
      providerId: "serpapi",
      paidUsage: true,
      supportedModes: ["amazon"],
      async search(input) {
        searches.push(input.query);
        assert.equal(input.discoveryMode, "amazon");
        assert.equal(input.candidateLimit, 50);
        const queryNumber = searches.length;
        return Array.from({ length: 3 }, (_, index) => ({
          sourceKind: "serpapi" as const,
          provider: "serpapi",
          discoveryMode: "amazon" as const,
          externalId: `ASIN-${queryNumber}-${index}`,
          sourceUrl: `https://www.amazon.com/dp/example-${queryNumber}-${index}`,
          productUrl: `https://www.amazon.com/dp/example-${queryNumber}-${index}`,
          name: `Observed product ${queryNumber}-${index}`,
          query: input.query,
          observedAt: input.observedAt,
          observedPrice: `$${20 + queryNumber + index}.00`,
          observedRating: 4.5,
          observedReviewCount: 100 + index,
          observedImageUrl: `https://images.example.com/${queryNumber}-${index}.jpg`,
        }));
      },
    };
    let providerCalls = 0;
    const provider: GuideGenerationProvider = {
      providerId: "test",
      async generateStructured(request) {
        providerCalls += 1;
        assert.match(request.prompt, /Structured input:/);
        if (providerCalls === 1) {
          assert.match(request.prompt, /Practical gifts for nurses/);
          return request.schema.parse({
            queries: [
              "premium tea accessories",
              "soft home comfort",
              "portable photo printer",
              "creative art kits",
              "elegant travel organizer",
            ],
          }) as never;
        }
        assert.match(request.prompt, /Observed product 1-0/);
        assert.match(request.prompt, /publishedFamilyCounts/);
        assert.match(request.prompt, /Cargadores fijos y estaciones de carga/);
        return request.schema.parse({
          ideas: [
            {
              candidateId: "candidate_1",
              giftClass: "A premium loose-leaf tea set",
              fit: "A polished everyday pleasure that feels generous.",
            },
            {
              candidateId: "candidate_2",
              giftClass: "A soft weighted lap blanket",
              fit: "Adds comfort at home without being a routine work tool.",
            },
            {
              candidateId: "candidate_3",
              giftClass: "A pocket photo printer",
              fit: "Turns personal memories into a creative keepsake.",
            },
          ],
        }) as never;
      },
    };
    const result = await generateProductGroundedGuideIdeas(
      {
        id: "guide_test",
        clusterId: "cluster_nurse-gifts",
        title: "Practical gifts for nurses",
        primaryIntent: "Useful gifts with enough novelty to feel special",
        recommendations: [{}, {}, {}],
        clusterRecommendations: [
          {
            guideId: "guide_other_one",
            guideTitle: "Other one",
            heading: "A Premium Wireless Charging Dock",
          },
          {
            guideId: "guide_other_two",
            guideTitle: "Other two",
            heading: "A tidy bedside charging station",
          },
        ],
      },
      provider,
      discoverySource,
      store,
      ["Positive preference pattern: feels generous without repeating the object."],
      new Date("2026-09-27T12:00:00.000Z"),
    );
    assert.equal(providerCalls, 2);
    assert.equal(searches.length, 5);
    assert.equal(result.productsFound, 15);
    assert.equal(result.records.length, 3);
    assert.equal(new Set(result.records.map((record) => record.runId)).size, 1);
    assert.ok(result.records.every((record) => record.guideId === "guide_test"));
    assert.ok(result.records.every((record) => record.status === "proposed"));
    assert.ok(result.records.every((record) => record.promptVersion === "product-guide-ideas-v5"));
    assert.ok(result.records.every((record) => record.imageUrl));
    assert.deepEqual(
      result.records.map((record) => record.previousGiftClass),
      ["Idea 1", "Idea 2", "Idea 3"],
    );
    assert.deepEqual(
      new Set((await store.list("cluster_nurse-gifts")).map((record) => record.id)),
      new Set(result.records.map((record) => record.id)),
    );
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
    const content = readPublicContent(root);
    const practicalGuide = content.guides.find((guide) => guide.id === "guide_nurse-practical")!;
    await new IdeaAuditStore(root).replaceCluster("cluster_nurse-gifts", [
      {
        ideaKey: `guide:${practicalGuide.id}:${practicalGuide.recommendations[0]!.id}`,
        clusterId: "cluster_nurse-gifts",
        guideId: practicalGuide.id,
        guideTitle: practicalGuide.title,
        label: practicalGuide.recommendations[0]!.heading!,
        score: 6,
        verdict: "supporting",
        comment: "Useful but more practical than memorable as a gift.",
        confidence: "high",
        promptVersion: "gift-audit-v1",
        providerId: "test",
        modelId: "test-model",
        auditedAt: new Date().toISOString(),
      },
    ]);
    const publishedRecord = await researchStore.save({
      id: "research_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      clusterId: "cluster_nurse-gifts",
      sourceName: "Amazon via SerpAPI",
      sourceUrl: "https://www.amazon.com/dp/B012345678",
      pageTitle: "Amazon product result",
      giftClass: "An editorialized version of the observed product",
      evidenceHeading: "Observed product listing title",
      fit: "A concrete candidate grounded in a real product.",
      status: "proposed",
      guideId: practicalGuide.id,
      publishedRecommendationId: practicalGuide.recommendations[0]!.id,
      publishedHeading: practicalGuide.recommendations[0]!.heading!,
      externalId: "B012345678",
      imageUrl: "https://images.example.com/observed.jpg",
      observedPrice: "$29.99",
      observedRating: 4.6,
      observedReviewCount: 420,
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
        "/guide-improvements",
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
    const publishedPosition = body.indexOf(publishedRecord.giftClass);
    const publishedRow = body.slice(
      body.lastIndexOf("<tr>", publishedPosition),
      body.indexOf("</tr>", publishedPosition),
    );
    assert.match(publishedRow, /Publicada/);
    assert.match(publishedRow, /Ver producto observado/);
    assert.match(publishedRow, /Todavía no es un producto del catálogo/);
    assert.match(publishedRow, /Revisar para catálogo/);
    assert.doesNotMatch(publishedRow, new RegExp(`/idea-research/${publishedRecord.id}/accept`));
    const productSuggestion = await fetch(
      `${origin}/products/intake?researchId=${publishedRecord.id}`,
    );
    assert.equal(productSuggestion.status, 200);
    const productSuggestionBody = await productSuggestion.text();
    assert.match(productSuggestionBody, /Sugerencia precargada/);
    assert.match(productSuggestionBody, /Observed product listing title/);
    assert.match(productSuggestionBody, /no obliga a incorporarla al catálogo/);
    assert.doesNotMatch(productSuggestionBody, /name="image" value="https:\/\/images\.example/);
    assert.match(body, /<img src="\/local-assets\/images\//);
    assert.match(body, /<img src="https:\/\//);
    assert.doesNotMatch(body, /\/local-assetshttps?:/);
    const researchPosition = body.indexOf("A compact lunch warmer");
    const researchRow = body.slice(
      body.lastIndexOf("<tr>", researchPosition),
      body.indexOf("</tr>", researchPosition),
    );
    assert.doesNotMatch(researchRow, /<img\b/);
    const ratedRecommendationId = practicalGuide.recommendations[0]!.id;
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
        item.id === ratedRecommendationId ? { ...item, heading: "A different gift idea" } : item,
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
    assert.match(body, /Generar una guía desde productos reales/);
    assert.match(body, /Auditoría automática/);
    assert.match(body, /6\/10 · Aceptable para completar/);
    assert.match(body, /Useful but more practical than memorable as a gift\./);
    assert.match(body, /Tu puntuación de la idea \(opcional\)/);
    assert.match(body, /Comentario sobre la idea/);
    assert.match(body, /Comentario sobre la auditoría automática/);
    assert.match(body, /Guardar evaluaciones humanas/);
    assert.match(body, /pulsá «Guardar evaluaciones humanas» en cualquier fila/);
    assert.match(body, /data-idea-rating/);
    assert.match(body, /href="\/guide-improvements/);
    assert.match(body, /<script src="\/idea-research\.js" defer><\/script>/);
    assert.match(listing.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.match(
      listing.headers.get("content-security-policy") ?? "",
      /img-src 'self' https: data:/,
    );
    const script = await fetch(`${origin}/idea-research.js`);
    assert.equal(script.status, 200);
    const scriptBody = await script.text();
    assert.match(scriptBody, /fetch\(form\.action/);
    assert.match(scriptBody, /Marcada para reemplazo/);
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
    const highScoreOnly = ideaRatingHints(await ratingStore.list(), "cluster_nurse-gifts");
    assert.equal(highScoreOnly.length, 1);
    assert.match(highScoreOnly[0]!, /average 9\.0\/10/);
    assert.match(highScoreOnly[0]!, /1 high \(8-10\)/);
    assert.doesNotMatch(highScoreOnly[0]!, /A compact lunch warmer/);
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
        ["auditComment", "The audit underestimates how giftable this is."],
        ["ideaKey", `guide:guide_nurse-practical:${ratedRecommendationId}`],
        ["score", "2"],
        ["reason", "Too ordinary to feel like a gift."],
        ["auditComment", ""],
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
          auditComment: "The audit underestimates how giftable this is.",
        },
        {
          ideaKey: `guide:guide_nurse-practical:${ratedRecommendationId}`,
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
    assert.equal(
      savedRatings.find((rating) => rating.ideaKey === `research:${record.id}`)?.auditComment,
      "The audit underestimates how giftable this is.",
    );
    const savedHints = ideaRatingHints(savedRatings, "cluster_nurse-gifts").join(" ");
    assert.match(savedHints, /Useful at home, not a redundant work tool\./);
    assert.doesNotMatch(savedHints, /A compact lunch warmer/);
    assert.match(savedHints, /A different gift idea/);
    assert.match(savedHints, /Too ordinary to feel like a gift\./);
    const markedBody = await (await fetch(`${origin}/idea-research`)).text();
    const markedPosition = markedBody.indexOf("A different gift idea");
    const markedRow = markedBody.slice(
      markedBody.lastIndexOf("<tr>", markedPosition),
      markedBody.indexOf("</tr>", markedPosition),
    );
    assert.match(markedRow, /Marcada para reemplazo/);
    const improvementQueue = await fetch(
      `${origin}/guide-improvements?cluster=cluster_nurse-gifts`,
    );
    assert.equal(improvementQueue.status, 200);
    const improvementBody = await improvementQueue.text();
    assert.match(improvementBody, /Mejora gradual de guías/);
    assert.match(improvementBody, /1 idea en 1 guía/);
    assert.match(improvementBody, /A different gift idea/);
    assert.match(improvementBody, /2\/10/);
    assert.match(improvementBody, /Too ordinary to feel like a gift\./);
    assert.match(improvementBody, /No habrá revisiones por horario/);
    assert.match(improvementBody, /Proponer reemplazo/);
    const proposed = await fetch(`${origin}/guide-improvements/propose`, {
      method: "POST",
      body: new URLSearchParams({
        clusterId: "cluster_nurse-gifts",
        ideaKey: `guide:guide_nurse-practical:${ratedRecommendationId}`,
      }),
      redirect: "manual",
    });
    assert.equal(proposed.status, 303, await proposed.text());
    const manualReviewStore = new ManualReviewStore(root);
    const proposal = (await manualReviewStore.list("guide_nurse-practical")).find(
      (review) => review.kind === "idea" && review.status === "proposed",
    );
    assert.ok(proposal);
    assert.equal(proposal.proposedText, "A framed custom night-sky print");
    assert.equal(proposal.promptVersion, "idea-replacement-v4");
    const proposedBody = await (
      await fetch(`${origin}/guide-improvements?cluster=cluster_nurse-gifts`)
    ).text();
    assert.match(proposedBody, /Comparación pendiente/);
    assert.match(proposedBody, /A framed custom night-sky print/);
    assert.match(proposedBody, /Volver a proponer/);
    const acceptedReplacement = await fetch(`${origin}/guide-improvements/decide`, {
      method: "POST",
      body: new URLSearchParams({
        clusterId: "cluster_nurse-gifts",
        reviewId: proposal.id,
        decision: "accepted",
      }),
      redirect: "manual",
    });
    assert.equal(acceptedReplacement.status, 303, await acceptedReplacement.text());
    const improvedDraft = await draftStore.read("guide_nurse-practical");
    assert.equal(improvedDraft.draftType, "gift-guide");
    assert.equal(
      improvedDraft.recommendations.some((item) => item.id === ratedRecommendationId),
      false,
    );
    assert.equal(
      improvedDraft.recommendations.find(
        (item) => item.heading === "A framed custom night-sky print",
      )?.editorialStatus,
      "needs-generation",
    );
    const acceptedQueueBody = await (
      await fetch(`${origin}/guide-improvements?cluster=cluster_nurse-gifts`)
    ).text();
    assert.match(acceptedQueueBody, /Aplicada al borrador local/);
    assert.match(acceptedQueueBody, /La guía pública todavía conserva la idea anterior/);
    assert.match(acceptedQueueBody, /revisión automática se ejecutará una vez/i);
    const prompts = await fetch(
      `${origin}/idea-research/prompts?cluster=cluster_nurse-gifts&draft=guide_nurse-practical`,
    );
    assert.equal(prompts.status, 200);
    const promptBody = await prompts.text();
    assert.match(promptBody, /Plantilla de instrucciones actual/);
    assert.match(promptBody, /Último prompt guardado/);
    assert.match(promptBody, /Esto no es un historial completo/);
    assert.match(promptBody, /outline-v6/);
    assert.match(promptBody, /research-v4/);
    assert.match(promptBody, /product-guide-ideas-v5/);
    assert.match(promptBody, /Generación desde productos/);
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
        ["ideaKey", `guide:guide_nurse-practical:${ratedRecommendationId}`],
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
