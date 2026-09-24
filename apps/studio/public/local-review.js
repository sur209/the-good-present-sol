(() => {
  const root = document.getElementById("local-review-root");
  const data = JSON.parse(document.getElementById("local-review-data").textContent);
  const draft = data.draft;
  const records = data.records || [];
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const revision = draft ? `<input type="hidden" name="revision" value="${draft.revision}">` : "";
  const guideId = data.guideId;
  const hiddenGuide = `<input type="hidden" name="guideId" value="${esc(guideId)}">`;

  root.innerHTML = `<div class="lr-bar"><strong>Revisión local</strong><span>No cambia el sitio publicado</span>${
    draft
      ? '<button type="button" data-action="comment">Comentar selección</button><button type="button" data-action="pending">Propuestas</button><button type="button" data-action="history">Historial</button>'
      : guideId
        ? `<form method="post" action="/local/review/start">${hiddenGuide}<button type="submit">Empezar a revisar esta guía</button></form>`
        : "<span>Abrí una guía para revisarla.</span>"
  }<a href="/">Studio</a></div><aside class="lr-panel" hidden aria-label="Revisión editorial"><button type="button" class="lr-close">Cerrar</button><div class="lr-panel-content"></div></aside>`;
  const panel = root.querySelector(".lr-panel");
  const panelContent = root.querySelector(".lr-panel-content");
  const show = (html) => {
    panelContent.innerHTML = html;
    panel.hidden = false;
  };
  root.querySelector(".lr-close").addEventListener("click", () => {
    panel.hidden = true;
  });
  if (!draft) return;

  const field = (element, name, recommendationId) => {
    if (!element) return;
    element.dataset.reviewField = name;
    if (recommendationId) element.dataset.reviewRecommendation = recommendationId;
  };
  const setText = (element, text, name, recommendationId) => {
    if (!element) return;
    element.textContent = text || "[Text pending]";
    field(element, name, recommendationId);
  };
  setText(document.querySelector(".guide-hero h1"), draft.title, "title");
  setText(document.querySelector(".guide-hero .lede"), draft.excerpt, "excerpt");
  setText(document.querySelector(".guide-intro > p"), draft.introduction, "introduction");
  setText(
    document.querySelector(".guide-conclusion > p:last-child"),
    draft.conclusion,
    "conclusion",
  );
  for (const item of draft.recommendations) {
    const card = document.getElementById(`pick-${item.position}`);
    if (!card) continue;
    const body = card.querySelector(".recommendation__body");
    const heading = body.querySelector("h2");
    setText(heading, item.heading || item.slotLabel, "heading", item.id);
    setText(
      body.querySelector(".why-box").previousElementSibling,
      item.editorialDescription,
      "editorialDescription",
      item.id,
    );
    setText(body.querySelector(".why-box p"), item.whyItFits, "whyItFits", item.id);
    const index = document.querySelector(`.pick-index a[href="#pick-${item.position}"]`);
    if (index) index.textContent = item.heading || item.slotLabel;
    const detailNames = {
      "Best for": "bestFor",
      "How to choose": "selectionGuidance",
      "Before you buy": "considerations",
      "What to consider": "considerations",
    };
    for (const detail of body.querySelectorAll(".recommendation__details > div")) {
      const key = detailNames[detail.querySelector("dt").textContent];
      if (key) setText(detail.querySelector("dd"), item[key], key, item.id);
    }
    const original = (data.originalRecommendations || []).find(
      (rec) => rec.position === item.position,
    );
    if (original && original.id !== item.id) {
      const visual = card.querySelector(".recommendation__visual");
      visual.querySelector("img, span")?.remove();
      const initials = document.createElement("span");
      initials.textContent = (item.heading || item.slotLabel)
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word[0])
        .join("");
      visual.insertBefore(initials, visual.querySelector("small"));
      visual.classList.remove("recommendation__visual--illustrated");
      visual.setAttribute("aria-hidden", "true");
      body.querySelector(".recommendation__details")?.remove();
    }
    if (
      !original ||
      original.productId !== item.productId ||
      original.directAffiliateUrl !== item.directAffiliateUrl
    ) {
      body.querySelector(".recommendation__product")?.remove();
      body.querySelector(".recommendation__commerce")?.remove();
      const availability =
        body.querySelector(".recommendation__availability") || document.createElement("p");
      availability.className = "recommendation__availability";
      availability.textContent =
        item.productId || item.directAffiliateUrl
          ? "Merchant link changed in draft. Check Studio preview."
          : "No merchant link available.";
      body.append(availability);
    }
    const actions = document.createElement("div");
    actions.className = "lr-card-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lr-idea";
    button.textContent = "Cambiar idea";
    button.addEventListener("click", () =>
      show(
        `<h2>Cambiar idea ${item.position}</h2><p>La imagen y el enlace de la idea anterior se quitarán del borrador. La nueva idea necesitará texto e imagen revisados.</p><form method="post" action="/local/review/idea">${revision}${hiddenGuide}<input type="hidden" name="recommendationId" value="${esc(item.id)}"><label>Nueva idea<input name="concept" maxlength="120" required></label><label>¿Por qué cambiás esta idea?<textarea name="comment" maxlength="1000" required></textarea></label><button type="submit">Guardar nueva idea</button></form>`,
      ),
    );
    actions.append(button);
    if (item.editorialStatus === "needs-generation" || item.editorialStatus === "needs-review") {
      const generate = document.createElement("form");
      generate.method = "post";
      generate.action = "/local/review/generate-idea-copy";
      generate.innerHTML = `${revision}${hiddenGuide}<input type="hidden" name="recommendationId" value="${esc(item.id)}"><button type="submit">${item.editorialStatus === "needs-review" ? "Regenerar texto" : "Generar texto"}</button>`;
      actions.append(generate);
    }
    if (item.editorialStatus === "needs-review") {
      const approve = document.createElement("form");
      approve.method = "post";
      approve.action = "/local/review/approve-idea-copy";
      approve.innerHTML = `${revision}${hiddenGuide}<input type="hidden" name="recommendationId" value="${esc(item.id)}"><button type="submit">Aprobar texto</button>`;
      actions.append(approve);
    }
    body.append(actions);
  }
  if (!draft.recommendations.some((item) => item.productId || item.directAffiliateUrl)) {
    document.querySelector(".demo-notice")?.remove();
    document.querySelector(".guide-disclosure")?.remove();
  }

  let selection = null;
  const capture = () => {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed) return;
    const start = selected.anchorNode?.parentElement?.closest("[data-review-field]");
    const end = selected.focusNode?.parentElement?.closest("[data-review-field]");
    if (start && start === end) selection = { element: start, quote: selected.toString().trim() };
  };
  document.addEventListener("mouseup", capture);
  document.addEventListener("keyup", capture);
  document.addEventListener("selectionchange", capture);
  const commentForm = (element, quote = "") => {
    if (!element) {
      show(
        "<h2>Seleccioná texto</h2><p>Marcá una frase de la guía y volvé a pulsar «Comentar selección». También podés hacer doble clic sobre un párrafo.</p>",
      );
      return;
    }
    const name = element.dataset.reviewField;
    const recId = element.dataset.reviewRecommendation;
    show(
      `<h2>Comentar texto</h2><p>Se enviará al modelo solo este campo y tu comentario. El resultado quedará como propuesta hasta que lo aceptes.</p><small>${esc(name)}</small><blockquote>${esc(element.textContent)}</blockquote>${quote ? `<p>Selección: “${esc(quote)}”</p>` : ""}<form method="post" action="/local/review/copy-propose">${revision}${hiddenGuide}<input type="hidden" name="field" value="${esc(name)}"><input type="hidden" name="recommendationId" value="${esc(recId || "")}"><input type="hidden" name="selectedQuote" value="${esc(quote)}"><label>¿Qué cambiarías?<textarea name="comment" maxlength="1000" required autofocus></textarea></label><button type="submit">Proponer nueva redacción</button></form>`,
    );
  };
  root
    .querySelector('[data-action="comment"]')
    .addEventListener("click", () => commentForm(selection?.element, selection?.quote));
  document.addEventListener("dblclick", (event) => {
    const target = event.target.closest?.("[data-review-field]");
    if (target) commentForm(target, "");
  });

  const pending = records.filter(
    (record) => record.kind === "copy" && record.status === "proposed",
  );
  root.querySelector('[data-action="pending"]').addEventListener("click", () => {
    show(
      `<h2>Propuestas pendientes (${pending.length})</h2>${pending.length ? pending.map((record) => `<article><small>${esc(record.field)} · ${esc(record.comment)}</small><h3>Antes</h3><blockquote>${esc(record.previousText)}</blockquote><h3>Propuesta</h3><blockquote>${esc(record.proposedText)}</blockquote><form method="post" action="/local/review/decide">${revision}${hiddenGuide}<input type="hidden" name="reviewId" value="${esc(record.id)}"><button name="decision" value="accepted" type="submit">Aceptar</button><button name="decision" value="rejected" type="submit">Rechazar</button></form></article>`).join("") : "<p>No hay propuestas pendientes.</p>"}`,
    );
  });
  root.querySelector('[data-action="history"]').addEventListener("click", () => {
    show(
      `<h2>Historial de decisiones</h2>${records.length ? records.map((record) => `<article><small>${esc(record.kind === "idea" ? "Idea" : "Texto")} · ${esc(record.status)} · ${esc(record.createdAt.slice(0, 10))}</small><p>${esc(record.comment)}</p><blockquote>${esc(record.previousText)}</blockquote><p>→</p><blockquote>${esc(record.proposedText)}</blockquote></article>`).join("") : "<p>Todavía no hay decisiones.</p>"}`,
    );
  });
  if (pending.length)
    root.querySelector('[data-action="pending"]').textContent = `Propuestas (${pending.length})`;
})();
