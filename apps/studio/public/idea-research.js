const ratingForms = [...document.querySelectorAll("form[data-idea-rating]")];
const feedback = document.querySelector("[data-rating-feedback]");
let saving = false;

for (const form of ratingForms) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const changed = ratingForms.filter((candidate) => {
      const select = candidate.elements.score;
      const reason = candidate.elements.reason;
      return (
        select.value &&
        (select.value !== select.dataset.savedScore ||
          reason.value.trim() !== reason.dataset.savedReason)
      );
    });
    if (!changed.length) {
      feedback.textContent =
        form.elements.reason.value.trim() && !form.elements.score.value
          ? "Elegí un puntaje para guardar el motivo."
          : "No hay puntajes ni motivos nuevos para guardar.";
      return;
    }

    const body = new URLSearchParams({ clusterId: form.elements.clusterId.value });
    for (const candidate of changed) {
      body.append("ideaKey", candidate.elements.ideaKey.value);
      body.append("score", candidate.elements.score.value);
      body.append("reason", candidate.elements.reason.value.trim());
    }
    saving = true;
    for (const candidate of ratingForms) candidate.querySelector("button").disabled = true;
    feedback.textContent = `Guardando ${changed.length} puntaje${changed.length === 1 ? "" : "s"}…`;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "No se pudieron guardar los puntajes.");
      for (const candidate of changed) {
        const rating = result.ratings.find(
          (rating) => rating.ideaKey === candidate.elements.ideaKey.value,
        );
        if (!rating) continue;
        const row = candidate.closest("tr");
        row.querySelector("[data-current-rating]").textContent = `${rating.score}/10`;
        row.querySelector("[data-current-reason]").textContent = rating.reason || "";
        candidate.elements.score.dataset.savedScore = String(rating.score);
        candidate.elements.reason.dataset.savedReason = rating.reason || "";
      }
      feedback.textContent = `Se guardaron ${changed.length} puntaje${changed.length === 1 ? "" : "s"}.`;
    } catch (error) {
      feedback.textContent = error.message || "No se pudieron guardar los puntajes.";
    } finally {
      for (const candidate of ratingForms) candidate.querySelector("button").disabled = false;
      saving = false;
    }
  });
}
