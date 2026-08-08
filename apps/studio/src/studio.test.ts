import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";

import { z } from "zod";

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
