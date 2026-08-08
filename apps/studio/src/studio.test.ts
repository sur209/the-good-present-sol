import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import { MockGuideGenerationProvider, type GuideGenerationProvider } from "./ai-provider.ts";
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
import { generateGuideOutline, normalizeQuestionnaire } from "./guide-editor.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";
import {
  ProductCatalog,
  matchProducts,
  productUsage,
  validateProductUrl,
} from "./product-catalog.ts";
import { REPOSITORY_ROOT } from "./repository.ts";
import { STUDIO_HOST, createStudioServer } from "./server.ts";

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
