/* Gemeinsamer UI-Kern nach DESIGN.md: Formatierung, Alltagsäquivalente, Graustufen-Theme,
   drei Zoomstufen mit Breadcrumb, Esc-Navigation und räumlichen Übergängen (Motion, ≤ 300 ms). */
"use strict";
(function (root) {
  const UI = {};
  const $ = (sel, r = document) => r.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  UI.esc = esc;

  // ------------------------------------------------------------------ Zahlen
  const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
  const eur0 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const one = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  UI.money = (x) => eur.format(x);
  UI.money0 = (x) => eur0.format(Math.round(x));
  UI.moneyShort = (x) => {
    const a = Math.abs(x);
    if (a >= 1e6) return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: a >= 1e7 ? 1 : 2 }).format(x / 1e6)} Mio. €`;
    if (a >= 1e4) return `${Math.round(x / 1000).toLocaleString("de-DE")} Tsd. €`;
    return eur0.format(Math.round(x));
  };
  UI.pct = (x, d = 1) => `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: d }).format(x)} %`;
  UI.signed = (x, fmt = UI.money0) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x))}`;

  // ------------------------------------------------------------------ Maßstäbe & Alltagsäquivalente
  UI.measures = null;
  UI.loadMeasures = async function () {
    const res = await fetch("/api/measures");
    if (res.ok) UI.measures = await res.json();
    return UI.measures;
  };
  /** Tagesbudget und Fixkosten pro Monat in € (oder null). */
  UI.basis = () => {
    const s = UI.measures?.soll || {};
    return { daily: s.daily ? s.daily / 100 : null, fixed: s.fixed ? s.fixed / 100 : null };
  };
  /** „≈ 3,2 Tage Budget“ bzw. „≈ 1,4 Monate Fixkosten“ – DESIGN.md §4. */
  UI.equiv = function (euros) {
    const { daily, fixed } = UI.basis();
    const a = Math.abs(euros);
    if (!isFinite(a)) return "";
    if (fixed && a >= fixed) {
      const months = a / fixed;
      return months >= 24 ? `≈ ${one.format(months / 12)} Jahre Fixkosten` : `≈ ${one.format(months)} Monate Fixkosten`;
    }
    if (daily) {
      const days = a / daily;
      return days < 1 ? "< 1 Tag Budget" : `≈ ${one.format(days)} ${Math.round(days * 10) === 10 ? "Tag" : "Tage"} Budget`;
    }
    if (fixed) return `≈ ${one.format(a / fixed)} Monate Fixkosten`;
    return "";
  };
  UI.equivMissing = "Alltagsäquivalent: Umsätze importieren oder Fixkosten in der Tiefe eintragen";
  /** Betrag mit Äquivalent als HTML: „1.192 € <small>≈ 1,4 Monate Fixkosten</small>“ */
  UI.amount = (euros, fmt = UI.money0) => {
    const e = UI.equiv(euros);
    return `${fmt(euros)}${e ? ` <small class="equiv">${e}</small>` : ""}`;
  };

  // ------------------------------------------------------------------ Theme
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  UI.css = css;
  UI.theme = () => ({
    ink1: css("--ink-1"), ink2: css("--ink-2"), ink3: css("--ink-3"), ink4: css("--ink-4"),
    bad: css("--signal-bad"), good: css("--signal-good"),
    surface: css("--surface-1"), surface2: css("--surface-2"), text: css("--text-primary"), text2: css("--text-secondary"),
    muted: css("--axis-muted"), grid: css("--grid"), baseline: css("--baseline"), font: css("--font"),
  });
  UI.reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  UI.chartBase = (t) => ({
    backgroundColor: "transparent",
    textStyle: { fontFamily: t.font, color: t.text2 },
    animationDuration: UI.reducedMotion() ? 0 : 280,
    animationDurationUpdate: UI.reducedMotion() ? 0 : 280,
    tooltip: {
      trigger: "axis", backgroundColor: t.surface, borderColor: t.grid, borderWidth: 1, padding: [8, 12],
      textStyle: { color: t.text, fontSize: 12.5 }, extraCssText: "box-shadow: 0 6px 20px rgba(0,0,0,.14); border-radius: 8px;",
      axisPointer: { type: "line", lineStyle: { color: t.baseline, width: 1 } },
    },
    grid: { left: 8, right: 16, top: 24, bottom: 4, containLabel: true },
  });
  UI.valueAxis = (t, fmt = UI.moneyShort) => ({
    type: "value", axisLabel: { color: t.muted, fontSize: 11.5, formatter: fmt },
    splitLine: { lineStyle: { color: t.grid } }, axisLine: { show: false }, axisTick: { show: false },
  });
  UI.tipRow = (marker, label, value) =>
    `<div style="display:flex;gap:14px;justify-content:space-between;align-items:center"><span>${marker}${esc(label)}</span><b style="font-variant-numeric:tabular-nums">${value}</b></div>`;
  UI.mark = (color, dashed) => dashed
    ? `<span style="display:inline-block;width:12px;border-top:2px dashed ${color};margin-right:6px;vertical-align:middle"></span>`
    : `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};margin-right:6px"></span>`;

  /** Zahl kurz (≤ 300 ms) auf den neuen Wert laufen lassen. */
  UI.animateNumber = function (el, to, fmt) {
    const from = parseFloat(el.dataset.v || "NaN");
    el.dataset.v = to;
    if (UI.reducedMotion() || !isFinite(from) || Math.abs(from - to) < 0.005) { el.textContent = fmt(to); return; }
    const start = performance.now(), dur = 280;
    cancelAnimationFrame(el._raf);
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  };

  /** Horizontale Spur mit Ist-Balken und Soll-Strich (Metapher-Baustein). Werte relativ zu `max`. */
  UI.track = function ({ value, soll, max, bad = false, height = 14, sollLabel = "" }) {
    const w = (v) => `${Math.max(0, Math.min(1, v / (max || 1))) * 100}%`;
    return `<div class="track-m${bad ? " bad" : ""}" style="--h:${height}px">
      <span class="fill" style="width:${w(value)}"></span>
      ${soll != null ? `<span class="soll" style="left:${w(soll)}" title="Soll"></span>${sollLabel ? `<span class="soll-label" style="left:${w(soll)}">${esc(sollLabel)}</span>` : ""}` : ""}
    </div>`;
  };

  // ------------------------------------------------------------------ Bewegung
  const EASE = [0.2, 0, 0, 1];
  const DURATION = 0.26; // Sekunden, DESIGN.md: max. 300 ms
  function play(el, keyframes) {
    if (UI.reducedMotion()) return Promise.resolve();
    if (root.Motion?.animate) {
      const controls = root.Motion.animate(el, keyframes, { duration: DURATION, ease: EASE });
      return controls.finished || Promise.resolve(controls);
    }
    return el.animate(keyframes, { duration: DURATION * 1000, easing: "cubic-bezier(0.2, 0, 0, 1)" }).finished;
  }
  const clipOf = (r) => r
    ? `inset(${Math.max(0, r.top)}px ${Math.max(0, innerWidth - r.right)}px ${Math.max(0, innerHeight - r.bottom)}px ${Math.max(0, r.left)}px round 14px)`
    : "inset(20% 20% 20% 20% round 14px)";
  const FULL = "inset(0px 0px 0px 0px round 0px)";

  // ------------------------------------------------------------------ Zoom (Blick → Fokus → Tiefe)
  /**
   * items: { key: { label, focus(body, api), depth(body, api), depthLabel } }
   * crumbs: [{label, href}] vor der Übersicht, z. B. [{label: "Finanzen", href: "./"}]
   * prefix: Hash-Präfix, z. B. "dashboard/" → #dashboard/fokus/ausgaben
   */
  class Zoom {
    constructor({ items, crumbs = [], overview = "Übersicht", prefix = "", context = () => "", onEscapeTop = null, crumbTarget = "#crumbs" }) {
      Object.assign(this, { items, crumbs, overview, prefix, context, onEscapeTop, crumbTarget });
      this.level = 1;
      this.key = null;
      this.origins = {};
      this.layers = [2, 3].map((level) => {
        const el = document.createElement("section");
        el.className = "zoom-layer";
        el.dataset.level = level;
        el.hidden = true;
        el.setAttribute("role", "region");
        el.innerHTML = `<header class="zoom-head"><nav class="crumbs" aria-label="Pfad"></nav><span class="zoom-context"></span>
          <button type="button" class="zoom-back" title="Eine Stufe zurück (Esc)"><kbd>Esc</kbd> zurück</button></header>
          <div class="zoom-body"></div>`;
        el.querySelector(".zoom-back").onclick = () => this.back();
        document.body.append(el);
        return el;
      });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if (document.querySelector("dialog[open]")) return; // Dialog schließt sich selbst
        if (this.level > 1) { e.preventDefault(); this.back(); }
        else if (this.onEscapeTop) this.onEscapeTop(e);
      });
      window.addEventListener("hashchange", () => this.fromHash(true));
      document.addEventListener("click", (e) => {
        const a = e.target.closest("[data-crumb-level]");
        if (a) { e.preventDefault(); this.go(+a.dataset.crumbLevel); }
      });
      this.renderCrumbs();
    }

    layer(level) { return this.layers[level - 2]; }
    body(level) { return this.layer(level).querySelector(".zoom-body"); }

    crumbList() {
      const list = this.crumbs.map((c) => ({ ...c }));
      list.push({ label: this.overview, level: 1 });
      if (this.level >= 2 && this.key) list.push({ label: this.items[this.key].label, level: 2 });
      if (this.level >= 3 && this.key) list.push({ label: this.items[this.key].depthLabel || "Tabelle", level: 3 });
      return list;
    }
    renderCrumbs() {
      const list = this.crumbList();
      const html = list.map((c, i) => {
        const last = i === list.length - 1;
        const inner = last ? `<span aria-current="page">${esc(c.label)}</span>`
          : c.href ? `<a href="${esc(c.href)}">${esc(c.label)}</a>` : `<a href="#" data-crumb-level="${c.level}">${esc(c.label)}</a>`;
        return `${i ? `<span class="sep" aria-hidden="true">›</span>` : ""}${inner}`;
      }).join("");
      const top = $(this.crumbTarget);
      if (top) top.innerHTML = html;
      this.layers.forEach((l) => { l.querySelector(".crumbs").innerHTML = html; l.querySelector(".zoom-context").textContent = this.context(this.key, this.level); });
    }

    hash() {
      if (this.level === 1) return this.prefix.replace(/\/$/, "");
      return `${this.prefix}${this.level === 2 ? "fokus" : "tiefe"}/${this.key}`;
    }
    syncHash() {
      const h = this.hash();
      if (location.hash.slice(1) !== h) history.replaceState(null, "", `${location.pathname}${location.search}${h ? `#${h}` : ""}`);
    }
    fromHash(animate = false) {
      const h = location.hash.slice(1);
      if (this.prefix && !h.startsWith(this.prefix) && h !== this.prefix.replace(/\/$/, "")) return false;
      const m = h.slice(this.prefix.length).match(/^(fokus|tiefe)\/([\w-]+)$/);
      if (m && this.items[m[2]]) {
        const level = m[1] === "fokus" ? 2 : 3;
        if (level !== this.level || m[2] !== this.key) this.open(m[2], level, null, animate);
        return true;
      }
      if (this.level > 1) this.go(1, animate);
      return false;
    }

    setInert() {
      const base = [...document.body.children].filter((el) => !el.classList.contains("zoom-layer") && el.tagName !== "DIALOG" && !el.classList.contains("toasts") && el.tagName !== "SCRIPT");
      base.forEach((el) => { el.inert = this.level > 1; });
      this.layer(2).inert = this.level > 2;
      document.body.classList.toggle("zoomed", this.level > 1);
    }

    /** Element öffnen: Stufe 2 (Fokus) oder 3 (Tiefe), wachsend aus `origin`. */
    async open(key, level = 2, origin = null, animate = true) {
      const item = this.items[key];
      if (!item) return;
      if (key !== this.key && this.level > 1) this.layers.forEach((l) => { l.hidden = true; delete l.dataset.key; });
      this.key = key;
      if (origin) this.origins[level] = origin;
      const show = async (lvl, render) => {
        const layer = this.layer(lvl);
        // Ebene zuerst auf die Größe des Auslösers zuschneiden, dann befüllen (Diagramme brauchen eine echte Fläche)
        layer.style.clipPath = animate && lvl === level ? clipOf(this.originRect(lvl)) : "none";
        layer.hidden = false;
        layer.dataset.key = key;
        this.body(lvl).innerHTML = "";
        this.level = lvl;
        this.renderCrumbs();
        this.setInert();
        await render(this.body(lvl), this);
        this.body(lvl).scrollTop = 0;
        if (animate && lvl === level) await this.grow(lvl);
        layer.style.clipPath = "none";
      };
      if (this.layer(2).hidden || this.layer(2).dataset.key !== key) await show(2, item.focus);
      if (level === 3) await show(3, item.depth);
      else if (!this.layer(3).hidden) { this.layer(3).hidden = true; this.body(3).innerHTML = ""; }
      this.level = level;
      this.renderCrumbs();
      this.setInert();
      this.syncHash();
      this.layer(level).querySelector(".zoom-back").focus({ preventScroll: true });
      window.dispatchEvent(new Event("resize"));
    }

    originRect(level) {
      const o = this.origins[level];
      return o?.isConnected && o.getClientRects().length ? o.getBoundingClientRect() : null;
    }
    async grow(level) {
      await play(this.layer(level), { clipPath: [clipOf(this.originRect(level)), FULL], opacity: [0.6, 1] });
    }
    async shrink(level) {
      const layer = this.layer(level);
      await play(layer, { clipPath: [FULL, clipOf(this.originRect(level))], opacity: [1, 0.4] });
      layer.style.clipPath = "none";
      layer.style.opacity = "";
    }

    /** Eine Stufe zurück. */
    back() { return this.go(this.level - 1); }

    async go(level, animate = true) {
      level = Math.max(1, level);
      while (this.level > level) {
        const current = this.level;
        this.level = current - 1;
        this.setInert();
        if (animate) await this.shrink(current);
        this.layer(current).hidden = true;
        this.body(current).innerHTML = "";
      }
      if (level === 1) this.key = null;
      this.renderCrumbs();
      this.syncHash();
      const origin = this.origins[level + 1];
      if (origin?.isConnected) origin.focus?.({ preventScroll: true });
    }

    /** Aktuelle Stufe neu zeichnen (z. B. nach Datenänderung). */
    async refresh() {
      if (this.level >= 2) { this.body(2).innerHTML = ""; await this.items[this.key].focus(this.body(2), this); }
      if (this.level >= 3) { this.body(3).innerHTML = ""; await this.items[this.key].depth(this.body(3), this); }
      this.renderCrumbs();
    }
  }
  UI.Zoom = Zoom;

  /** Räumlicher Übergang auf eine andere Seite: Fläche wächst aus `origin`, dann Navigation. */
  UI.zoomTo = async function (href, origin) {
    const veil = document.createElement("div");
    veil.className = "zoom-veil";
    document.body.append(veil);
    await play(veil, { clipPath: [clipOf(origin?.getBoundingClientRect()), FULL] });
    location.href = href;
  };

  root.UI = UI;
})(window);
