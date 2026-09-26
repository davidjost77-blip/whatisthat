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
    violet: css("--c-violet"), teal: css("--c-teal"), sky: css("--c-sky"), gold: css("--c-gold"),
    surface: css("--surface-1"), surface2: css("--surface-2"), text: css("--text-primary"), text2: css("--text-secondary"),
    muted: css("--axis-muted"), grid: css("--grid"), baseline: css("--baseline"), font: css("--font"),
  });
  UI.reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body?.classList.contains("no-motion");
  UI.chartBase = (t) => ({
    backgroundColor: "transparent",
    textStyle: { fontFamily: t.font, color: t.text2 },
    animationDuration: UI.reducedMotion() ? 0 : 900,
    animationEasing: "cubicOut",
    animationDurationUpdate: UI.reducedMotion() ? 0 : 350,
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

  /** Elementfarbe als Hex, z. B. UI.tone("violet"). */
  UI.tone = (name) => css(`--c-${name}`) || css("--ink-1");
  /** Transparente Variante einer Hex-Farbe (ECharts kennt kein color-mix). */
  UI.alpha = (hex, a) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  /** Balkenfüllung: oben satt, unten weicher (bzw. links → rechts bei liegenden Balken). */
  UI.barFill = (hex, horizontal = false) => new echarts.graphic.LinearGradient(0, 0, horizontal ? 1 : 0, horizontal ? 0 : 1,
    [{ offset: 0, color: horizontal ? UI.alpha(hex, 0.55) : hex }, { offset: 1, color: horizontal ? hex : UI.alpha(hex, 0.55) }]);
  /** Verlaufsfläche unter einer Linie in Elementfarbe. */
  UI.areaFill = (hex, top = 0.35) => new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: UI.alpha(hex, top) }, { offset: 1, color: UI.alpha(hex, 0) }]);

  // ------------------------------------------------------------------ Symbole je Element
  const ICONS = {
    tank: '<rect x="5" y="3" width="14" height="18" rx="4"/><path d="M5 13c2.5-1.5 4.5 1.5 7 0s4.5 1.5 7 0"/>',
    plant: '<path d="M12 21v-9"/><path d="M12 12c0-4 3-6 7-6 0 4-3 6-7 6z"/><path d="M12 14c0-3-2.5-5-6-5 0 3 2.5 5 6 5z"/><path d="M8 21h8"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z"/>',
    boat: '<path d="M3 16h18l-3 4H6z"/><path d="M12 3v12"/><path d="M12 4l6 10h-6"/>',
    balloon: '<path d="M12 3a6 6 0 0 0-6 6c0 4 4 7 6 8 2-1 6-4 6-8a6 6 0 0 0-6-6z"/><path d="M10 17l1 3h2l1-3"/>',
    stones: '<ellipse cx="6" cy="16" rx="3.5" ry="2"/><ellipse cx="13" cy="13" rx="3.5" ry="2"/><ellipse cx="19" cy="17" rx="3" ry="2"/>',
    mountain: '<path d="M3 20l6-11 4 6 3-4 5 9z"/><path d="M15 5v5"/><path d="M15 5l4 1.5-4 1.5"/>',
    signpost: '<path d="M12 3v18"/><path d="M12 6h7l2 2-2 2h-7"/><path d="M12 12H5l-2 2 2 2h7"/>',
  };
  UI.icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  // ------------------------------------------------------------------ Bewegung an/aus
  /** Umschalter Hell / Dunkel / System (gespeichert pro Browser). */
  const THEMES = [["system", "◐ System"], ["light", "☀ Hell"], ["dark", "☾ Dunkel"]];
  UI.initTheme = function () {
    let mode = "system";
    try { mode = localStorage.getItem("theme") || "system"; } catch { /* privater Modus */ }
    const apply = () => {
      if (mode === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = mode;
    };
    apply();
    const bar = document.querySelector(".topbar");
    if (!bar || document.querySelector(".theme-toggle")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost theme-toggle";
    const sync = () => {
      const [, label] = THEMES.find(([k]) => k === mode);
      b.textContent = label;
      b.title = "Darstellung wechseln: System → Hell → Dunkel";
    };
    b.onclick = () => {
      mode = THEMES[(THEMES.findIndex(([k]) => k === mode) + 1) % THEMES.length][0];
      try { localStorage.setItem("theme", mode); } catch { /* egal */ }
      apply();
      sync();
    };
    sync();
    bar.append(b);
  };

  UI.initMotion = function () {
    UI.initTabs();
    UI.initTheme();
    let off = false;
    try { off = localStorage.getItem("motion") === "off"; } catch { /* privater Modus */ }
    document.body.classList.toggle("no-motion", off);
    const slot = document.querySelector(".topbar"); // nicht in .topbar-status: dessen Text wird neu gesetzt
    if (!slot || document.querySelector(".motion-toggle")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost motion-toggle";
    const sync = () => {
      const on = !document.body.classList.contains("no-motion");
      b.setAttribute("aria-pressed", String(on));
      b.innerHTML = `${on ? "◉" : "○"} Bewegung ${on ? "an" : "aus"}`;
      b.title = on ? "Umgebungsbewegung und Eintrittsanimationen ausschalten" : "Bewegung wieder einschalten";
    };
    b.onclick = () => {
      document.body.classList.toggle("no-motion");
      try { localStorage.setItem("motion", document.body.classList.contains("no-motion") ? "off" : "on"); } catch { /* egal */ }
      sync();
    };
    sync();
    slot.append(b);
  };

  /** Gestaffelter Eintritt (Kacheln schweben nacheinander herein). */
  UI.enter = function (elements, { y = 26, stagger = 0.08 } = {}) {
    if (UI.reducedMotion() || !root.Motion?.animate) return;
    [...elements].forEach((el, i) => {
      root.Motion.animate(el, { opacity: [0, 1], transform: [`translateY(${y}px) scale(.98)`, "translateY(0) scale(1)"] },
        { duration: 0.7, delay: i * stagger, ease: [0.2, 0.9, 0.2, 1] });
    });
  };

  /** Metapher-Spuren füllen sich von links, Soll-Striche erscheinen danach. */
  UI.fillTracks = function (root) {
    if (!root || UI.reducedMotion() || !window.Motion?.animate) return;
    root.querySelectorAll(".track-m").forEach((t, i) => {
      const fill = t.querySelector(".fill"), soll = t.querySelector(".soll");
      if (fill) window.Motion.animate(fill, { transform: ["scaleX(0)", "scaleX(1)"] }, { duration: 1, delay: 0.25 + i * 0.08, ease: [0.2, 0.9, 0.2, 1] });
      if (soll) window.Motion.animate(soll, { opacity: [0, 1], transform: ["scaleY(0.2)", "scaleY(1)"] }, { duration: 0.5, delay: 0.9 + i * 0.08 });
    });
  };

  /** Zahlen im Text hochzählen lassen (erste Zahl je Textknoten, Format bleibt erhalten). */
  const NUM_RE = /([−+-]?)(\d{1,3}(?:\.\d{3})+|\d+)(,\d+)?/;
  UI.countUp = function (root, selector, dur = 900) {
    if (!root || UI.reducedMotion()) return;
    root.querySelectorAll(selector).forEach((el) => {
      [...el.childNodes].filter((n) => n.nodeType === 3 && NUM_RE.test(n.textContent)).forEach((n) => {
        const text = n.textContent, m = text.match(NUM_RE);
        if (/^(19|20)\d\d$/.test(m[2]) && !m[3]) return; // Jahreszahlen bleiben stehen
        const decimals = m[3] ? m[3].length - 1 : 0;
        const target = parseFloat(m[2].replace(/\./g, "") + (m[3] ? `.${m[3].slice(1)}` : ""));
        if (!isFinite(target) || target === 0) return;
        const fmt = new Intl.NumberFormat("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: m[2].includes(".") || target >= 10000 });
        const pre = text.slice(0, m.index) + m[1], post = text.slice(m.index + m[0].length);
        const start = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
          n.textContent = pre + fmt.format(target * e) + post;
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    });
  };

  /** Tabellenzeilen erscheinen nacheinander (CSS .rows-in). */
  UI.rowsIn = function (root) {
    root?.querySelectorAll("table.depth-table").forEach((t) => {
      t.classList.add("rows-in");
      [...(t.tBodies[0]?.rows || [])].forEach((r, i) => r.style.setProperty("--i", Math.min(i, 30)));
    });
  };

  /** Fokus-Inhalt: Karten und Vergleichszeilen schweben herein, Zahlen zählen hoch. */
  UI.animateLayer = function (body, level) {
    UI.enter(body.querySelectorAll(":scope > .focus-head, .focus-grid > *, .depth-grid > *, :scope > section, .compare .row, .play .controls, .outcome .tile, .scenario, .etf, .etf-new"), { y: 18, stagger: 0.045 });
    UI.countUp(body, ".focus-head h1, .compare .v");
    UI.fillTracks(body);
    if (level === 3) UI.rowsIn(body);
  };

  /** Gleitende Markierung unter dem aktiven Reiter; beim Überfahren gleitet sie mit. */
  UI.initTabs = function () {
    const tabs = document.querySelector(".tabs");
    if (!tabs || tabs.querySelector(".tab-ink")) return;
    const ink = document.createElement("span");
    ink.className = "tab-ink";
    tabs.prepend(ink);
    tabs.classList.add("has-ink");
    const moveTo = (a) => {
      if (!a) { ink.style.opacity = "0"; return; }
      ink.style.opacity = "1";
      ink.style.width = `${a.offsetWidth}px`;
      ink.style.height = `${a.offsetHeight}px`;
      ink.style.transform = `translate(${a.offsetLeft}px, ${a.offsetTop}px)`;
    };
    const active = () => tabs.querySelector('[aria-selected="true"], [aria-current="page"]');
    const place = () => moveTo(active());
    new MutationObserver(place).observe(tabs, { attributes: true, subtree: true, attributeFilter: ["aria-selected", "aria-current"] });
    tabs.addEventListener("mouseover", (e) => { const a = e.target.closest("button, a.tab"); if (a) moveTo(a); });
    tabs.addEventListener("mouseleave", place);
    window.addEventListener("resize", place);
    document.fonts?.ready.then(place);
    place();
  };

  /** Einheitlicher Eintritt für Balkendiagramme: Balken wachsen nacheinander. */
  UI.barAnim = () => ({ animationDelay: (i) => i * 45, animationDuration: 850, animationEasing: "cubicOut", animationDelayUpdate: (i) => i * 15 });

  // ------------------------------------------------------------------ Bewegung
  const EASE = [0.2, 0.9, 0.25, 1];
  const DURATION = 0.4; // Sekunden, DESIGN.md: federnd, höchstens 450 ms
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
        if (item.tone) layer.dataset.tone = item.tone; else delete layer.dataset.tone;
        this.body(lvl).innerHTML = "";
        this.level = lvl;
        this.renderCrumbs();
        this.setInert();
        await render(this.body(lvl), this);
        this.body(lvl).scrollTop = 0;
        UI.animateLayer(this.body(lvl), lvl);
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
      if (this.level >= 3) { this.body(3).innerHTML = ""; await this.items[this.key].depth(this.body(3), this); UI.rowsIn(this.body(3)); }
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
