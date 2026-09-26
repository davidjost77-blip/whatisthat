/* Zuordnen: Buchungen ohne Kategorie und unsichere Zuordnungen schnell einordnen.
   Hinweisleiste über den Kennzahlen + kompaktes Seitenpanel (eine Karte nach der anderen, größter Betrag zuerst).
   Jede Entscheidung gilt für alle ähnlichen Buchungen (Regel) und lässt sich rückgängig machen.
   Tastatur: 1–8 Kategorie · Enter Vorschlag / passt so · S oder → überspringen · ← zurück · Esc schließen.
   Nutzt api(), toast(), esc(), state, loadCategories(), refreshCurrent() aus app.js. */
"use strict";
(function () {
  let data = null, queue = [], pos = 0, done = 0, panel = null, refreshTimer = null, skipped = [];
  const money = (c) => UI.money0(Math.abs(c) / 100);
  const signed = (c) => `${c < 0 ? "−" : "+"}${UI.money(Math.abs(c) / 100)}`;
  const dateDe = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
  const cat = (id) => state.cats?.get(id);
  const label = (id) => {
    const c = cat(id);
    if (!c) return "–";
    const p = c.parent_id ? cat(c.parent_id) : null;
    return p ? `${p.name} › ${c.name}` : c.name;
  };

  async function load() {
    data = await api("GET", "/api/review");
    return data;
  }

  // ---------------------------------------------------------------- Hinweisleiste im Dashboard
  async function refreshBar() {
    const bar = document.getElementById("review-bar");
    if (!bar) return;
    try { await load(); } catch { return; }
    const u = data.unassigned, q = data.uncertain;
    bar.hidden = !u.count && !q.count;
    bar.innerHTML = [
      u.count ? `<button type="button" class="review-chip bad" data-start="unassigned">⚠ ${u.count} Buchung${u.count === 1 ? "" : "en"} ohne Kategorie · ${money(u.volume ?? u.sum)}
        <b>Jetzt zuordnen →</b></button>` : "",
      q.count ? `<button type="button" class="review-chip" data-start="uncertain">? ${q.count} unsichere Zuordnung${q.count === 1 ? "" : "en"}
        <b>Prüfen →</b></button>` : "",
    ].join("");
    bar.querySelectorAll("[data-start]").forEach((b) => (b.onclick = () => open(b.dataset.start)));
  }

  // ---------------------------------------------------------------- Panel
  async function open(start) {
    if (!state.categories?.length) await loadCategories();
    await load();
    done = 0;
    skipped = start === "uncertain" ? data.unassigned.groups.map((g) => g.key) : [];
    rebuild();
    if (!panel) build();
    panel.hidden = false;
    document.body.classList.add("review-open");
    requestAnimationFrame(() => panel.classList.add("in"));
    render();
  }

  /** Warteschlange aus dem aktuellen Stand: Übersprungene zuerst (hinter der Position), dann Offenes. */
  function rebuild() {
    const all = [...data.unassigned.groups, ...data.uncertain.items];
    const byKey = new Map(all.map((x) => [x.key, x]));
    skipped = skipped.filter((k) => byKey.has(k));
    queue = [...skipped.map((k) => byKey.get(k)), ...all.filter((x) => !skipped.includes(x.key))];
    pos = skipped.length;
  }
  const skip = () => { if (queue[pos]) { skipped.push(queue[pos].key); pos++; render(); } };
  const back = () => { if (pos) { skipped.pop(); pos--; render(); } };

  function close() {
    if (!panel) return;
    panel.classList.remove("in");
    document.body.classList.remove("review-open");
    setTimeout(() => { panel.hidden = true; }, 260);
    refreshSoon(0);
  }

  function build() {
    panel = document.createElement("div");
    panel.className = "review";
    panel.hidden = true;
    panel.innerHTML = `<div class="review-backdrop"></div>
      <aside class="review-panel" role="dialog" aria-label="Buchungen zuordnen">
        <header><div><h2>Zuordnen</h2><p class="muted" id="rv-sub"></p></div><button class="ghost rv-close" title="Schließen (Esc)">✕</button></header>
        <div class="rv-progress"><span id="rv-bar"></span></div>
        <div id="rv-body"></div>
        <footer class="rv-keys muted">1–8 Kategorie · Enter Vorschlag · S überspringen · ← zurück · Esc schließen</footer>
      </aside>`;
    document.body.append(panel);
    panel.querySelector(".review-backdrop").onclick = close;
    panel.querySelector(".rv-close").onclick = close;
    window.addEventListener("keydown", onKey, true);   // vor dem Zoom-Esc
  }

  function chips(item) {
    const pool = item.direction === "in" ? data.top.in : data.top.out;
    const ids = [...new Set([item.suggestion?.category_id, ...pool].filter((id) => id && cat(id) && id !== item.current?.category_id))].slice(0, 8);
    return ids;
  }

  function render() {
    const body = panel.querySelector("#rv-body");
    const total = queue.length;
    const left = queue.length - pos;
    panel.querySelector("#rv-sub").textContent = total
      ? `${data.unassigned.count} ohne Kategorie · ${data.uncertain.count} unsicher${done ? ` · ${done} erledigt` : ""}`
      : "Nichts offen";
    panel.querySelector("#rv-bar").style.width = `${total + done ? ((done + pos) / (total + done)) * 100 : 100}%`;
    if (pos >= queue.length) {
      body.innerHTML = `<div class="rv-done"><div class="rv-check">✓</div><h3>${total ? "Alles durchgesehen" : "Alles zugeordnet"}</h3>
        <p class="muted">${done ? `${done} Entscheidung${done === 1 ? "" : "en"} – gilt ab jetzt auch für künftige Buchungen.` : "Es gibt gerade nichts zu tun."}</p>
        ${pos > 0 && left <= 0 && queue.length ? `<button class="ghost" id="rv-restart">Übersprungene noch einmal zeigen</button>` : ""}
        <button class="primary" id="rv-finish">Fertig</button></div>`;
      body.querySelector("#rv-finish").onclick = close;
      body.querySelector("#rv-restart")?.addEventListener("click", () => { skipped = []; rebuild(); render(); });
      return;
    }
    const it = queue[pos];
    const isU = it.kind === "uncertain";
    const ids = chips(it);
    const sug = it.suggestion?.category_id && cat(it.suggestion.category_id) ? it.suggestion : null;
    const range = it.first === it.last ? dateDe(it.last) : `${dateDe(it.first)} – ${dateDe(it.last)}`;
    body.innerHTML = `<div class="rv-card ${isU ? "uncertain" : "unassigned"}">
      <div class="rv-kind">${isU ? "? Unsicher – bitte prüfen" : "⚠ Ohne Kategorie"} <span class="muted">· ${pos + 1} von ${queue.length}</span></div>
      <h3 class="rv-name" title="${esc(it.variants?.join(" · ") || it.name)}">${esc(it.name)}</h3>
      <div class="rv-meta">${it.count} Buchung${it.count === 1 ? "" : "en"} · <b>${signed(it.sum)}</b> · ${range}</div>
      ${isU ? `<div class="rv-current">Aktuell: <b>${esc(label(it.current.category_id))}</b>
        <ul>${it.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
      <ul class="rv-samples">${it.samples.map((s) => `<li><span>${dateDe(s.date)}</span><span class="p" title="${esc(s.purpose)}">${esc(s.purpose || "–")}</span><span class="a">${signed(s.amount)}</span></li>`).join("")}
        ${it.count > it.samples.length ? `<li class="muted">… und ${it.count - it.samples.length} weitere</li>` : ""}</ul>
      <div class="rv-actions">
        ${isU ? `<button class="primary rv-main" data-confirm>↵ Passt so: ${esc(label(it.current.category_id))}</button>`
          : sug ? `<button class="primary rv-main" data-cat="${sug.category_id}">↵ ${esc(label(sug.category_id))}<small>${esc(sug.why || "Vorschlag")}</small></button>` : ""}
        <div class="rv-chips">${ids.map((id, i) => `<button data-cat="${id}" class="${sug && id === sug.category_id ? "sug" : ""}"><kbd>${i + 1}</kbd>${esc(cat(id).name)}${cat(id).parent_id ? `<small>${esc(cat(cat(id).parent_id)?.name || "")}</small>` : ""}</button>`).join("")}</div>
        <div class="rv-search"><input id="rv-find" list="rv-cats" placeholder="Andere Kategorie suchen …" autocomplete="off">
          <datalist id="rv-cats">${state.categories.map((c) => `<option value="${esc(label(c.id))}"></option>`).join("")}</datalist>
          <button class="ghost" id="rv-new" title="Neue Kategorie anlegen">+ Neu</button></div>
      </div>
      <div class="rv-foot">
        <label class="inline" title="Legt eine Regel für diesen Empfänger an – gilt auch für künftige Buchungen">
          <input type="checkbox" id="rv-learn" ${it.rule ? "checked" : "disabled"}> Für alle ähnlichen merken</label>
        <span><button class="ghost" id="rv-back" ${pos ? "" : "disabled"}>← Zurück</button><button class="ghost" id="rv-skip">Überspringen →</button></span>
      </div></div>`;
    body.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => decide(+b.dataset.cat)));
    body.querySelector("[data-confirm]")?.addEventListener("click", () => confirmIt());
    body.querySelector("#rv-skip").onclick = skip;
    body.querySelector("#rv-back").onclick = back;
    const find = body.querySelector("#rv-find");
    find.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      const hit = state.categories.find((c) => label(c.id).toLowerCase() === find.value.trim().toLowerCase())
        || state.categories.find((c) => label(c.id).toLowerCase().includes(find.value.trim().toLowerCase()));
      if (hit && find.value.trim()) decide(hit.id);
    };
    body.querySelector("#rv-new").onclick = () => {
      const dlg = document.getElementById("cat-dialog");
      dlg?.addEventListener("close", async () => { await loadCategories(); render(); }, { once: true });
      if (typeof openCategoryDialog === "function") openCategoryDialog(null);
    };
    const card = body.querySelector(".rv-card");
    if (!UI.reducedMotion() && window.Motion?.animate) Motion.animate(card, { opacity: [0, 1], x: [24, 0] }, { duration: 0.28, easing: [0.2, 0.8, 0.2, 1] });
  }

  async function decide(categoryId) {
    const it = queue[pos];
    if (!it) return;
    const learn = panel.querySelector("#rv-learn")?.checked;
    try {
      const res = await api("POST", "/api/review/assign", { ids: it.ids, category_id: categoryId, rule: it.rule, direction: it.direction, learn });
      finish(it, `„${it.name}“ → ${label(categoryId)}${res.changed > it.count ? ` · ${res.changed} Buchungen` : ""}${res.rule_id ? " · gemerkt" : ""}`, res.undo);
    } catch (e) { toast(e.message, { error: true }); }
  }

  async function confirmIt() {
    const it = queue[pos];
    const learn = panel.querySelector("#rv-learn")?.checked;
    try {
      const res = await api("POST", "/api/review/confirm", { ids: it.ids, category_id: learn ? it.current.category_id : null, rule: learn ? it.rule : null, direction: it.direction });
      finish(it, `„${it.name}“ bestätigt: ${label(it.current.category_id)}`, res.undo);
    } catch (e) { toast(e.message, { error: true }); }
  }

  async function finish(it, message, undoData) {
    done++;
    toast(message, { action: { label: "Rückgängig", run: async () => {
      await api("POST", "/api/review/undo", { undo: undoData });
      done = Math.max(0, done - 1);
      if (panel && !panel.hidden) { await load(); rebuild(); render(); }
      toast("Rückgängig gemacht");
      refreshSoon();
    } } });
    // frisch laden: eine Regel erledigt oft gleich weitere Karten desselben Empfängers mit
    try { await load(); } catch { /* nächstes Mal */ }
    rebuild();
    render();
    refreshSoon();
  }

  // Dashboard im Hintergrund live nachziehen (gebündelt)
  function refreshSoon(ms = 700) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try { await loadStatus(); } catch { /* egal */ }
      refreshCurrent();
      refreshBar();
    }, ms);
  }

  function onKey(e) {
    if (!panel || panel.hidden) return;
    const typing = e.target.closest?.("input, select, textarea");
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (typing && e.target.value) { e.target.value = ""; return; } close(); return; }
    if (typing) return;
    const it = queue[pos];
    if (/^[1-8]$/.test(e.key) && it) {
      const b = panel.querySelectorAll(".rv-chips [data-cat]")[+e.key - 1];
      if (b) { e.preventDefault(); decide(+b.dataset.cat); }
    } else if (e.key === "Enter" && it) {
      const main = panel.querySelector(".rv-main");
      if (main) { e.preventDefault(); main.click(); }
    } else if ((e.key === "s" || e.key === "S" || e.key === "ArrowRight") && it) {
      e.preventDefault(); skip();
    } else if (e.key === "ArrowLeft" && pos) {
      e.preventDefault(); back();
    }
  }

  window.Review = { open, close, refreshBar };
})();
