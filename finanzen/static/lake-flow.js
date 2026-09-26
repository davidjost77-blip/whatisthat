/* Geldfluss als See (DESIGN.md §6): Zuflüsse links münden in einen See in der Mitte,
   Abflüsse verlassen ihn nach rechts. Jeder Fluss ist ein Bündel feiner, parallel fließender
   Fäden; kurz vor dem Ufer laufen die Fäden weich aus, der See greift als Trichter in den
   Fluss hinein. Das Ufer ist weich gezeichnet und „atmet“ sehr langsam. Keine Abhängigkeiten. */
"use strict";
(function (root) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const f1 = (v) => v.toFixed(1);
  const rad = (d) => (d * Math.PI) / 180;
  let uid = 0;

  // Gestaltungsparameter (abgestimmt im Claude-Design-Canvas, Variante „Final“)
  const SPACING = 2.4;   // Abstand der Fäden
  const STROKE = 0.4;    // Fadenstärke
  const SPEED = 1.8;     // > 1 = ruhiger
  const AMP = 0.55;      // Mäander-Stärke
  const FLARE = 1.1;     // Mündungstrichter
  const REACH = 42;      // wie weit das Seewasser in den Fluss greift
  const STOP = 44;       // wo die Fäden auslaufen (Abstand zum Ufer)
  const PATTERNS = ["90 14 40 22 50 24", "60 18 110 52", "130 20 30 60", "44 12 70 30 64 20", "100 40 60 40"]; // je 240 lang

  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  const hash = (str) => [...String(str)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
  };

  /** Mittellinie mit leichtem Mäander und Breitenprofil (Quelle schmal, Mündung als Trichter). */
  function river(p0, p3, w, seed, { mouthEnd = false, mouthStart = false, taperStart = false, amp = 8, n = 90 } = {}) {
    const dx = p3[0] - p0[0];
    const p1 = [p0[0] + dx * 0.45, p0[1]], p2 = [p3[0] - dx * 0.45, p3[1]];
    const k = 2 + (seed % 2);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [x, y] = bez(p0, p1, p2, p3, t);
      const a = bez(p0, p1, p2, p3, Math.max(0, t - 1e-3)), b = bez(p0, p1, p2, p3, Math.min(1, t + 1e-3));
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
      const off = amp * Math.pow(Math.sin(Math.PI * t), 1.2) * Math.sin(Math.PI * k * t + seed * 1.3);
      pts.push([x + nx * off, y + ny * off]);
    }
    const N = [], ws = [];
    for (let i = 0; i <= n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n, i + 1)];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      N.push([-(b[1] - a[1]) / L, (b[0] - a[0]) / L]);
      const t = i / n;
      let f = 1 + 0.1 * Math.sin(2 * Math.PI * (t * 1.6 + seed * 0.37));
      if (mouthEnd) f *= 1 + FLARE * smooth(0.72, 1, t);
      if (mouthStart) f *= 1 + FLARE * smooth(0.28, 0, t);
      if (taperStart) f *= 0.12 + 0.88 * smooth(0, 0.3, t);
      ws.push(w * f);
    }
    return { pts, N, ws };
  }

  const line = (pts) => "M" + pts.map(([x, y]) => `${f1(x)},${f1(y)}`).join(" L");
  function outline({ pts, N, ws }, extra = 1.5) {
    const l = pts.map((p, i) => [p[0] + N[i][0] * (ws[i] / 2 + extra), p[1] + N[i][1] * (ws[i] / 2 + extra)]);
    const r = pts.map((p, i) => [p[0] - N[i][0] * (ws[i] / 2 + extra), p[1] - N[i][1] * (ws[i] / 2 + extra)]);
    return line(l.concat(r.reverse())) + " Z";
  }

  /**
   * data = { nodes: [{id, name, value, col (0 Zufluss | 1 See | 2 Abfluss), cls?, sub?, click?}] }
   * opts = { format(v), detail(node) → HTML, onClick(node, el), label, hubSub }
   */
  function lake(container, data, opts = {}) {
    const id = `lf${++uid}`;
    const fmt = opts.format || ((v) => String(Math.round(v)));
    const srcs = data.nodes.filter((n) => n.col === 0 && n.value > 0);
    const dsts = data.nodes.filter((n) => n.col === 2 && n.value > 0);
    const hub = data.nodes.find((n) => n.col === 1) || { name: "Verfügbar", value: srcs.reduce((s, n) => s + n.value, 0) };
    const W = Math.max(760, container.clientWidth || 1100);
    const narrow = W < 900;
    const H = clamp(dsts.length * 62 + 70, 440, 700);
    const s = clamp(Math.min(W / 1200, H / 600), 0.75, 1.15);       // Maßstab
    const CX = W / 2, CY = H / 2;
    const RX = 132 * s, RY = 122 * s, RIM = 0.7 * RX;
    const xL = narrow ? 150 : 210, xR = W - (narrow ? 170 : 230);
    const vmax = Math.max(1, ...srcs.map((n) => n.value), ...dsts.map((n) => n.value));
    const width = (v) => { const r = v / vmax; return Math.max(2.6, 58 * s * Math.sqrt(r) * (0.55 + 0.45 * Math.sqrt(r))); };
    const reduced = root.UI?.reducedMotion?.() ?? matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---------- Ufer: organisch, etwas runder als ein Ei, Ausbuchtung zu den Mündungen
    function shore(grow = 0, ph = 0, n = 96) {
      const lobe = (a, c, sig, amp) => { const d = Math.atan2(Math.sin(a - rad(c)), Math.cos(a - rad(c))); return amp * Math.exp(-((d / sig) ** 2)); };
      const P = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const k = 1 + 0.4 * (0.03 * Math.sin(3 * a + 0.8) + 0.02 * Math.sin(5 * a + 2.1))
          + 0.011 * Math.sin(4 * a + ph * 2 * Math.PI) + 0.007 * Math.sin(7 * a - ph * 2 * Math.PI);
        const bump = 0.45 * s * (lobe(a, 185, 0.32, 20) + lobe(a, 0, 0.55, 16));
        P.push([CX + ((RX + grow) * k + bump) * Math.cos(a), CY + ((RY + grow) * k + bump * 0.6) * Math.sin(a)]);
      }
      let d = `M${f1(P[0][0])},${f1(P[0][1])}`;
      for (let i = 0; i < n; i++) {
        const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
        d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)},${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)},${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])},${f1(p2[1])}`;
      }
      return d + " Z";
    }
    const breathe = (grow, dur) => reduced ? "" :
      `<animate attributeName="d" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.25;0.5;0.75;1" keySplines="${Array(4).fill("0.45 0 0.55 1").join(";")}" values="${[0, 0.25, 0.5, 0.75, 1].map((p) => shore(grow, p)).join(";")}"/>`;

    // ---------- Tore am Ufer: jeder Fluss bekommt einen eigenen Abschnitt → keine Überschneidungen
    const gates = (list, center, gap) => {
      const R = RX * 1.0;
      const degs = list.map((n) => (width(n.value) * (1 + 0.45 * FLARE)) / R * (180 / Math.PI));
      let a = center - (degs.reduce((x, y) => x + y, 0) + gap * (list.length - 1)) / 2;
      return degs.map((d) => { const m = a + d / 2; a += d + gap; return m; });
    };
    const rim = (deg) => [CX + Math.cos(rad(deg)) * RIM, CY + Math.sin(rad(deg)) * RIM * (RY / RX)];

    // Beschriftungspositionen: rechts gleichmäßig verteilt, dann entzerrt (Warnzeile braucht Platz)
    const relax = (ys, need, lo, hi) => {
      for (let it = 0; it < 60; it++) {
        for (let i = 1; i < ys.length; i++) if (ys[i] < ys[i - 1] + need[i - 1]) { const m = (ys[i] + ys[i - 1]) / 2; ys[i - 1] = m - need[i - 1] / 2; ys[i] = m + need[i - 1] / 2; }
        for (let i = 0; i < ys.length; i++) ys[i] = clamp(ys[i], lo, hi);
      }
      return ys;
    };
    const step = dsts.length > 1 ? Math.min(68, (H - 90) / (dsts.length - 1)) : 0;
    const dstY = relax(dsts.map((_, i) => CY + (i - (dsts.length - 1) / 2) * step), dsts.map((n) => (n.cls === "bad" ? 58 : 44)), 36, H - 40);
    const srcY = srcs.length === 1 ? [CY - 20 * s]
      : relax(srcs.map((_, i) => H * 0.36 + (i * H * 0.36) / Math.max(1, srcs.length - 1)), srcs.map(() => 48), 40, H - 40);

    const inAng = gates(srcs, 180, 4).reverse();   // oberster Zufluss mündet oben
    const outAng = gates(dsts, 0, 3);              // oberster Abfluss verlässt oben

    const rivers = [];
    srcs.forEach((n, i) => {
      const g = river([xL, srcY[i]], rim(inAng[i]), width(n.value), i + 1, { mouthEnd: true, taperStart: true, amp: AMP * (i === 0 ? 9 : 12) * s });
      rivers.push({ n, g, dir: "in", y: srcY[i] });
    });
    dsts.forEach((n, i) => {
      const g = river(rim(outAng[i]), [xR, dstY[i]], width(n.value), i + 3, { mouthStart: true, amp: AMP * (6 + (i % 3) * 5) * s });
      rivers.push({ n, g, dir: "out", y: dstY[i] });
    });

    // ---------- Fäden
    function bundle(r) {
      const { pts, N, ws } = r.g;
      const mid = ws[Math.floor(ws.length / 2)];
      const cnt = Math.max(1, Math.floor(mid / SPACING));
      const rnd = rng(hash(r.n.id + r.n.value));
      const stroke = `url(#${id}${r.dir === "in" ? "gin" : "gout"})`;
      const out = [];
      for (let j = 0; j < cnt; j++) {
        const u = (cnt === 1 ? 0 : (j / (cnt - 1)) * 2 - 1) * 0.9;
        const d = line(pts.map((p, i) => [p[0] + N[i][0] * (ws[i] / 2) * u, p[1] + N[i][1] * (ws[i] / 2) * u]));
        const speed = 1 - 0.55 * u * u;                         // Mitte fließt schneller als der Rand
        const dur = (SPEED * 5.5) / speed * (0.9 + 0.2 * rnd());
        out.push(`<path class="lf-strand" d="${d}" stroke="${stroke}" stroke-width="${STROKE}"/>`);
        out.push(`<path class="lf-thread" d="${d}" stroke="${stroke}" stroke-width="${STROKE}" style="stroke-dasharray:${PATTERNS[Math.floor(rnd() * PATTERNS.length)]};animation-duration:${dur.toFixed(2)}s;animation-delay:-${(rnd() * dur).toFixed(2)}s"/>`);
      }
      return out.join("");
    }

    const cls = (r) => `${r.dir} ${r.n.cls || ""}`;
    const veils = rivers.map((r) => `<path class="lf-veil ${cls(r)}" data-id="${esc(r.n.id)}" d="${outline(r.g)}"/>`).join("");
    const est = rivers.map((r) => `<path class="lf-est" data-id="${esc(r.n.id)}" d="${outline(r.g)}"/>`).join("");
    const bundles = rivers.map((r) => `<g class="lf-bundle ${cls(r)}" data-id="${esc(r.n.id)}">${bundle(r)}</g>`).join("");
    const hits = rivers.map((r) => `<path class="lf-hit" data-id="${esc(r.n.id)}" d="${line(r.g.pts)}" stroke-width="${f1(Math.max(...r.g.ws) + 12)}"/>`).join("");

    // ---------- Beschriftung
    const maxChars = Math.floor((narrow ? 150 : 200) / 7.6);
    const short = (t) => (t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t);
    const labels = rivers.map((r) => {
      const n = r.n, left = r.dir === "in";
      const x = left ? xL - 14 : xR + 20, anchor = left ? "end" : "start";
      const bad = n.cls === "bad";
      const sub = n.sub && !bad ? ` <tspan class="flow-sub">· ${esc(n.sub)}</tspan>` : "";
      const warn = bad && n.sub ? `<text x="${x}" y="${f1(r.y + 30)}" text-anchor="${anchor}" class="lf-warn">${esc(n.sub)}</text>` : "";
      const dot = left ? "" : `<circle class="lf-mouth ${n.cls || ""}" cx="${xR + 6}" cy="${f1(r.y)}" r="3.6"/>`;
      const hitX = left ? 4 : xR, hitW = left ? xL - 4 : W - xR - 4;
      return `<g class="lf-label ${n.click ? "clickable" : ""}" data-id="${esc(n.id)}" ${n.click ? `tabindex="0" role="button" aria-label="${esc(n.name)} ${esc(fmt(n.value))} – Details öffnen"` : ""}>
        <rect class="lf-labelhit" x="${hitX}" y="${f1(r.y - 20)}" width="${hitW}" height="${bad ? 56 : 40}"/>${dot}
        <text x="${x}" y="${f1(r.y - 3)}" text-anchor="${anchor}" class="flow-name"><title>${esc(n.name)}</title>${esc(short(n.name))}</text>
        <text x="${x}" y="${f1(r.y + 14)}" text-anchor="${anchor}" class="flow-value">${esc(fmt(n.value))}${sub}</text>${warn}</g>`;
    }).join("");

    const defs = `<defs>
      <linearGradient id="${id}gin" gradientUnits="userSpaceOnUse" x1="${xL}" y1="0" x2="${f1(CX - RX * 0.4)}" y2="0"><stop offset="0" class="lf-far"/><stop offset=".7" class="lf-mid"/><stop offset="1" class="lf-near"/></linearGradient>
      <linearGradient id="${id}gout" gradientUnits="userSpaceOnUse" x1="${f1(CX + RX * 0.4)}" y1="0" x2="${xR}" y2="0"><stop offset="0" class="lf-near"/><stop offset=".3" class="lf-mid"/><stop offset="1" class="lf-far"/></linearGradient>
      <radialGradient id="${id}lake" cx="${CX}" cy="${CY}" r="${f1(RX * 1.08)}" gradientUnits="userSpaceOnUse" gradientTransform="translate(${CX} ${CY}) scale(1 ${(RY / RX).toFixed(3)}) translate(${-CX} ${-CY})">
        <stop offset="0" class="lk-deep"/><stop offset=".55" class="lk-mid"/><stop offset=".95" class="lk-shallow"/></radialGradient>
      <filter id="${id}bf" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="3.2"/></filter>
      <filter id="${id}bh" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
      <filter id="${id}b1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>
      <filter id="${id}b2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="24"/></filter>
      <filter id="${id}b3" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2"/></filter>
      <mask id="${id}stop" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><path d="${shore(STOP)}" fill="#000" filter="url(#${id}b1)"/></mask>
      <mask id="${id}est" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${shore(REACH)}" fill="#fff" filter="url(#${id}b2)"/></mask>
    </defs>`;
    const lakeSvg = `<g class="lf-lake" data-id="__hub">
      <path class="lf-halo" d="${shore(8)}" filter="url(#${id}bh)">${breathe(8, 17)}</path>
      <path class="lf-water" d="${shore(0)}" fill="url(#${id}lake)" filter="url(#${id}bf)">${breathe(0, 13)}</path>
      <text x="${CX}" y="${f1(CY - 12)}" class="lf-k" text-anchor="middle">${esc(hub.name)}</text>
      <text x="${CX}" y="${f1(CY + 20)}" class="lf-v" text-anchor="middle">${esc(fmt(hub.value))}</text>
      ${opts.hubSub ? `<text x="${CX}" y="${f1(CY + 41)}" class="lf-s" text-anchor="middle">${esc(opts.hubSub)}</text>` : ""}</g>`;

    container.innerHTML = `<div class="flow-scroll"><svg class="flow-svg lf" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opts.label || "Geldfluss")}">
      ${defs}
      <g mask="url(#${id}stop)">${veils}</g>
      <g mask="url(#${id}est)"><g filter="url(#${id}b3)">${est}</g></g>
      ${lakeSvg}
      <g mask="url(#${id}stop)">${bundles}</g>
      <g>${hits}</g>
      ${labels}
    </svg></div><div class="flow-tip" hidden></div>`;

    // ---------- Hervorheben, Tooltip, Klick
    const svg = container.querySelector("svg");
    const tip = container.querySelector(".flow-tip");
    const byId = new Map(rivers.map((r) => [String(r.n.id), r.n]));
    const highlight = (nid) => {
      svg.classList.toggle("focusing", nid != null && nid !== "__hub");
      svg.querySelectorAll("[data-id]").forEach((el) => el.classList.toggle("hi", el.dataset.id === nid));
    };
    const showTip = (html, e) => {
      if (!html) { tip.hidden = true; return; }
      tip.innerHTML = html;
      tip.hidden = false;
      const r = container.getBoundingClientRect();
      tip.style.transform = `translate(${clamp(e.clientX - r.left + 14, 8, r.width - tip.offsetWidth - 8)}px, ${clamp(e.clientY - r.top + 14, 8, r.height - tip.offsetHeight - 8)}px)`;
    };
    const nodeOf = (el) => { const g = el?.closest?.("[data-id]"); if (!g) return null; return g.dataset.id === "__hub" ? hub : byId.get(g.dataset.id); };
    svg.addEventListener("pointermove", (e) => {
      const n = nodeOf(e.target);
      if (!n) { highlight(null); showTip(null); return; }
      highlight(n === hub ? "__hub" : String(n.id));
      showTip(opts.detail ? opts.detail(n, "node") : `<b>${esc(n.name)}</b><br>${esc(fmt(n.value))}`, e);
    });
    svg.addEventListener("pointerleave", () => { highlight(null); showTip(null); });
    const open = (el) => { const n = nodeOf(el); if (n && n !== hub && n.click && opts.onClick) opts.onClick(n, el.closest("[data-id]")); };
    svg.addEventListener("click", (e) => open(e.target));
    svg.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest(".lf-label.clickable")) { e.preventDefault(); open(e.target); } });
    svg.querySelectorAll(".lf-hit, .lf-label").forEach((el) => { const n = nodeOf(el); if (n?.click) el.classList.add("clickable"); });
  }

  root.Flow = Object.assign(root.Flow || {}, { lake });
})(window);
