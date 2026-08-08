import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";

import {
  MockGuideGenerationProvider,
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
import { Publisher, clusterDraftToPublic, guideDraftToPublic } from "./publication.ts";
import { REPOSITORY_ROOT, readPublicContent } from "./repository.ts";
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

test("acepta sólo URLs HTTP(S) absolutas", () => {
  assert.equal(validateProductUrl(undefined), true);
  assert.equal(validateProductUrl("https://example.com/product"), true);
  assert.equal(validateProductUrl("http://example.com/product"), true);
  assert.equal(validateProductUrl("ftp://example.com/product"), false);
  assert.equal(validateProductUrl("/relative"), false);
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
  assert.match(await previewResponse.text(), /Ruta canónica: <code>\/nurse-gifts\/<\/code>/);
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
  assert.doesNotThrow(() => readPublicContent(repository));

  await execFileAsync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "astro.mjs"), "build"], {
    cwd: join(REPOSITORY_ROOT, "apps", "site"),
    env: { ...process.env, CONTENT_REPOSITORY_ROOT: repository },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const output = join(REPOSITORY_ROOT, "apps", "site", "dist");
  const hubHtml = await readFile(join(output, cluster.slug, "index.html"), "utf8");
  const guideHtml = await readFile(
    join(output, cluster.slug, publishedGuide.slug, "index.html"),
    "utf8",
  );
  assert.equal(guideResult.route, `/${cluster.slug}/${publishedGuide.slug}/`);
  assert.match(hubHtml, new RegExp(`/${cluster.slug}/${publishedGuide.slug}/`));
  assert.match(guideHtml, new RegExp(`href=["']/${cluster.slug}/["']`));
});
