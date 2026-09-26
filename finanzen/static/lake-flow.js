/* Geldfluss als See (DESIGN.md §6): Zuflüsse links münden in einen See in der Mitte,
   Abflüsse verlassen ihn nach rechts. Jeder Fluss ist ein Bündel feiner, parallel fließender
   Fäden; kurz vor dem Ufer laufen die Fäden weich aus, der See greift als Trichter in den
   Fluss hinein. Das Ufer ist weich gezeichnet, atmet langsam und schwingt wie ein Wassertropfen, wo es gestört wird. Keine Abhängigkeiten. */
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

  // ---------- Tropfen-Physik: Das Ufer schwingt wie ein Wassertropfen (Stand 9, als Simulation abgestimmt).
  // Auslenkung = Summe von Moden n = 2…NMAX (n = 0 fehlt → Volumen bleibt gleich, n = 1 fehlt → der See bleibt am Platz).
  // Frequenz nach Rayleigh (ω² ∝ n(n−1)(n+2)), Dämpfung nach Lamb (∝ (n−1)(2n+1)): feine Dellen verschwinden sofort,
  // übrig bleibt ein ruhiges Wabbeln. Der Zustand überdauert das Neuzeichnen (Live-Aktualisierung).
  const NMAX = 12;
  const DROP = { period: 1.8, visc: 0.2, limit: 22 };
  const dA = new Float64Array(NMAX + 1), dB = new Float64Array(NMAX + 1), vA = new Float64Array(NMAX + 1), vB = new Float64Array(NMAX + 1);
  const omega = (n) => (2 * Math.PI / DROP.period) * Math.sqrt((n * (n - 1) * (n + 2)) / 8);
  const gamma = (n) => DROP.visc * ((n - 1) * (2 * n + 1)) / 5;
  /** Örtlicher Stoß am Winkel th (Bogenmaß): Gauß-förmige Ufergeschwindigkeit mit Spitze v px/s und Breite sig. */
  function kickAt(th, v, sig = 0.28) {
    let peak = 0;
    const c = [];
    for (let n = 2; n <= NMAX; n++) { c[n] = Math.exp(-((n * sig) ** 2) / 2); peak += c[n]; }
    for (let n = 2; n <= NMAX; n++) { vA[n] += (v * c[n] / peak) * Math.cos(n * th); vB[n] += (v * c[n] / peak) * Math.sin(n * th); }
  }
  function stepDrop(dt) {
    const sub = Math.max(1, Math.ceil(dt * 480)), h = dt / sub;
    for (let k = 0; k < sub; k++) {
      for (let n = 2; n <= NMAX; n++) {
        const w2 = omega(n) ** 2, g2 = 2 * gamma(n);
        vA[n] += (-w2 * dA[n] - g2 * vA[n]) * h; dA[n] += vA[n] * h;
        vB[n] += (-w2 * dB[n] - g2 * vB[n]) * h; dB[n] += vB[n] * h;
      }
    }
  }
  function dropAt(th) {
    let s = 0;
    for (let n = 2; n <= NMAX; n++) s += dA[n] * Math.cos(n * th) + dB[n] * Math.sin(n * th);
    return DROP.limit * Math.tanh(s / DROP.limit);                     // weich begrenzt: der See zerreißt nie
  }
  const dropEnergy = () => { let e = 0; for (let n = 2; n <= NMAX; n++) e += vA[n] ** 2 + vB[n] ** 2 + omega(n) ** 2 * (dA[n] ** 2 + dB[n] ** 2); return e; };
  const motionOff = () => root.UI?.reducedMotion?.() ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
  let active = null, raf = 0, last = 0, t0 = 0, frameNo = 0, nextBreath = 0;
  function loop(now) {
    raf = 0;
    if (!active || !active.svg.isConnected || document.hidden) return;   // neu gestartet durch lake() bzw. Sichtbarkeit
    if (motionOff()) { active.draw(null, 0); setTimeout(startLoop, 1500); return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // lebendig: alle paar Sekunden ein kaum sichtbarer Hauch an zufälliger Stelle
    if (now > nextBreath) { kickAt(Math.random() * 2 * Math.PI, (Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 9), 0.5); nextBreath = now + 3500 + Math.random() * 5000; }
    stepDrop(dt);
    frameNo++;
    // ruhiger See: seltener zeichnen (das Atmen ist langsam), bewegter See: jedes Bild
    if (dropEnergy() > 40 || frameNo % 4 === 0) active.draw(dropAt, ((now - t0) / 13000) % 1);
    raf = requestAnimationFrame(loop);
  }
  function startLoop() { if (!raf && active) { last = performance.now(); t0 ||= last; raf = requestAnimationFrame(loop); } }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) startLoop(); });

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
    const lk = Object.assign({ left: "var(--lk-shallow)", center: "var(--lk-mid)", right: "var(--lk-shallow)", mid: 0.5 }, opts.lake || {});
    const reduced = root.UI?.reducedMotion?.() ?? matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---------- Ufer: organisch, etwas runder als ein Ei, Ausbuchtung zu den Mündungen
    function shore(grow = 0, ph = 0, n = 96, disp = null) {
      const lobe = (a, c, sig, amp) => { const d = Math.atan2(Math.sin(a - rad(c)), Math.cos(a - rad(c))); return amp * Math.exp(-((d / sig) ** 2)); };
      const P = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const k = 1 + 0.4 * (0.03 * Math.sin(3 * a + 0.8) + 0.02 * Math.sin(5 * a + 2.1))
          + 0.011 * Math.sin(4 * a + ph * 2 * Math.PI) + 0.007 * Math.sin(7 * a - ph * 2 * Math.PI);
        const bump = 0.45 * s * (lobe(a, 185, 0.32, 20) + lobe(a, 0, 0.55, 16));
        const dd = disp ? disp(a) : 0;
        P.push([CX + ((RX + grow) * k + bump + dd) * Math.cos(a), CY + ((RY + grow) * k + bump * 0.6 + dd * (RY / RX)) * Math.sin(a)]);
      }
      let d = `M${f1(P[0][0])},${f1(P[0][1])}`;
      for (let i = 0; i < n; i++) {
        const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
        d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)},${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)},${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])},${f1(p2[1])}`;
      }
      return d + " Z";
    }
    const phys = opts.physics !== false;
    const breathe = (grow, dur) => reduced || phys ? "" :
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
    const dstY = relax(dsts.map((_, i) => CY + (i - (dsts.length - 1) / 2) * step), dsts.map((n) => (/\bbad\b/.test(n.cls || "") ? 58 : 44)), 36, H - 40);
    const srcY = srcs.length === 1 ? [CY - 20 * s]
      : relax(srcs.map((_, i) => H * 0.36 + (i * H * 0.36) / Math.max(1, srcs.length - 1)), srcs.map(() => 48), 40, H - 40);

    const inAng = gates(srcs, 180, 4).reverse();   // oberster Zufluss mündet oben
    const outAng = gates(dsts, 0, 3);              // oberster Abfluss verlässt oben

    const rivers = [];
    srcs.forEach((n, i) => {
      const g = river([xL, srcY[i]], rim(inAng[i]), width(n.value), i + 1, { mouthEnd: true, taperStart: true, amp: AMP * (i === 0 ? 9 : 12) * s });
      rivers.push({ n, g, dir: "in", y: srcY[i], ang: inAng[i] });
    });
    dsts.forEach((n, i) => {
      const g = river(rim(outAng[i]), [xR, dstY[i]], width(n.value), i + 3, { mouthStart: true, amp: AMP * (6 + (i % 3) * 5) * s });
      rivers.push({ n, g, dir: "out", y: dstY[i], ang: outAng[i] });
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

    const cls = (r) => `${r.dir} ${r.n.cls || ""} ${r.n.disc ? "disc" : ""}`;
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
      const bad = /\bbad\b/.test(n.cls || "");
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
      <linearGradient id="${id}gin" gradientUnits="userSpaceOnUse" x1="${xL}" y1="0" x2="${f1(CX - RX * 0.4)}" y2="0"><stop offset="0" class="i-far"/><stop offset=".7" class="i-mid"/><stop offset="1" class="i-near"/></linearGradient>
      <linearGradient id="${id}gout" gradientUnits="userSpaceOnUse" x1="${f1(CX + RX * 0.4)}" y1="0" x2="${xR}" y2="0"><stop offset="0" class="o-near"/><stop offset=".3" class="o-mid"/><stop offset="1" class="o-far"/></linearGradient>
      <linearGradient id="${id}lr" gradientUnits="userSpaceOnUse" x1="${f1(CX - RX * 1.05)}" y1="0" x2="${f1(CX + RX * 1.05)}" y2="0">
        <stop offset="0" style="stop-color:${lk.left}"/><stop offset="${lk.mid}" style="stop-color:${lk.center}"/><stop offset="1" style="stop-color:${lk.right}"/></linearGradient>
      <radialGradient id="${id}depth" cx="${CX}" cy="${CY}" r="${f1(RX * 1.08)}" gradientUnits="userSpaceOnUse" gradientTransform="translate(${CX} ${CY}) scale(1 ${(RY / RX).toFixed(3)}) translate(${-CX} ${-CY})">
        <stop offset="0" style="stop-color:${lk.center};stop-opacity:.95"/><stop offset=".55" style="stop-color:${lk.center};stop-opacity:.55"/><stop offset="1" style="stop-color:${lk.center};stop-opacity:0"/></radialGradient>
      <radialGradient id="${id}lake" cx="${CX}" cy="${CY}" r="${f1(RX * 1.08)}" gradientUnits="userSpaceOnUse" gradientTransform="translate(${CX} ${CY}) scale(1 ${(RY / RX).toFixed(3)}) translate(${-CX} ${-CY})">
        <stop offset="0" class="lk-deep"/><stop offset=".55" class="lk-mid"/><stop offset=".95" class="lk-shallow"/></radialGradient>
      <filter id="${id}bf" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="3.2"/></filter>
      <filter id="${id}bh" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
      <filter id="${id}b1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>
      <filter id="${id}b2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="24"/></filter>
      <filter id="${id}b3" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2"/></filter>
      <filter id="${id}gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>
      <mask id="${id}stop" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><path d="${shore(STOP)}" fill="#000" filter="url(#${id}b1)"/></mask>
      <mask id="${id}est" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${shore(REACH)}" fill="#fff" filter="url(#${id}b2)"/></mask>
    </defs>`;
    const lakeSvg = `<g class="lf-lake" data-id="__hub">
      <path class="lf-halo" d="${shore(8)}" filter="url(#${id}bh)" style="fill:${lk.center}">${breathe(8, 17)}</path>
      <path class="lf-water" d="${shore(0)}" fill="url(#${id}lr)" filter="url(#${id}bf)">${breathe(0, 13)}</path>
      <path class="lf-depth" d="${shore(-6)}" fill="url(#${id}depth)" filter="url(#${id}bf)">${breathe(-6, 13)}</path>
      ${phys ? `<ellipse class="lf-gloss" filter="url(#${id}gl)" cx="${f1(CX - RX * 0.42)}" cy="${f1(CY - RY * 0.5)}" rx="${f1(RX * 0.28)}" ry="${f1(RY * 0.11)}" transform="rotate(-28 ${f1(CX - RX * 0.42)} ${f1(CY - RY * 0.5)})"/>` : ""}
      ${(opts.hubLines || [{ cls: "lf-k", text: hub.name }, { cls: "lf-v", text: fmt(hub.value) }, ...(opts.hubSub ? [{ cls: "lf-s", text: opts.hubSub }] : [])])
        .map((l, i, all) => `<text x="${CX}" y="${f1(CY + (i - (all.length - 1) / 2) * 21 + (l.cls === "lf-v" ? 8 : 4))}" class="${l.cls}" text-anchor="middle">${esc(l.text)}</text>`).join("")}</g>`;

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

    // ---------- Tropfen: Ufer pro Bild aus der Physik zeichnen; Maus und Klick stören es dort, wo sie es treffen
    const angOf = new Map(rivers.map((r) => [String(r.n.id), { th: rad(r.ang), dir: r.dir }]));
    const ctl = {
      /** Neue Buchung: stößt das Ufer an der Mündung ihres Flusses an – Zufluss nach außen, Abfluss nach innen. */
      kick(nodeId, amount) {
        const r = angOf.get(String(nodeId));
        if (!r || !phys) return;
        const rel = Math.sqrt(clamp(Math.abs(amount) / Math.max(1, hub.value), 0, 1));
        kickAt(r.th, (r.dir === "in" ? 1 : -1) * (50 + 170 * rel), 0.22 + 0.1 * rel);
        svg.querySelectorAll(`.lf-bundle[data-id="${CSS.escape(String(nodeId))}"]`).forEach((el) => { el.classList.add("pulse"); setTimeout(() => el.classList.remove("pulse"), 900); });
        startLoop();
      },
    };
    if (!phys) return ctl;
    const halo = svg.querySelector(".lf-halo"), water = svg.querySelector(".lf-water"), depth = svg.querySelector(".lf-depth"), gloss = svg.querySelector(".lf-gloss");
    const gx = CX - RX * 0.42, gy = CY - RY * 0.5;
    active = {
      svg,
      draw(disp, ph) {
        halo.setAttribute("d", shore(8, ph, 72, disp));
        water.setAttribute("d", shore(0, ph, 96, disp));
        depth.setAttribute("d", shore(-6, ph, 72, disp));
        if (disp) { gloss.setAttribute("cx", f1(gx + dA[2] * 0.4)); gloss.setAttribute("cy", f1(gy + dB[2] * 0.3)); gloss.setAttribute("rx", f1(RX * 0.28 + dA[2] * 0.2)); }
      },
    };
    const local = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
    const polar = (p) => { const dx = p.x - CX, dy = (p.y - CY) * (RX / RY); return { th: Math.atan2(dy, dx), rho: Math.hypot(dx, dy) }; };
    let prev = null;
    svg.addEventListener("pointermove", (e) => {
      const p = polar(local(e)), now = performance.now();
      if (prev && !motionOff()) {
        const dt = Math.max(0.008, (now - prev.t) / 1000);
        const near = Math.exp(-(((p.rho - (RX * 1.03 + dropAt(p.th))) / 26) ** 2));    // wirkt nur am Ufer
        let dth = p.th - prev.p.th; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
        const push = (p.rho - prev.p.rho) / dt * 0.5 + Math.abs(dth * p.rho / dt) * 0.06;  // quer zum Ufer schieben, entlang leicht mitziehen
        if (near > 0.05) { kickAt(p.th, near * push * Math.min(dt * 12, 1), 0.2); startLoop(); }
      }
      prev = { p, t: now };
    });
    svg.addEventListener("pointerleave", () => (prev = null));
    svg.addEventListener("click", (e) => {
      if (!e.target.closest(".lf-lake") || motionOff()) return;
      const p = polar(local(e));
      kickAt(p.th, 90 * (0.4 + 0.6 * Math.min(1, p.rho / RX)), 0.45);             // Tropfen fällt hinein, die Welle erreicht das Ufer
      startLoop();
    });
    startLoop();
    return ctl;
  }

  /**
   * Unterdashboard: eine Kategorie verzweigt in ihre Unterkategorien – dieselben Fäden, ohne See.
   * data = { source: {name, value, prev}, children: [{id, name, value, prev, disc?}] }
   * Der frühere Zeitraum erscheint als gestrichelter „Schatten“-Lauf in seiner damaligen Breite.
   */
  function branch(container, data, opts = {}) {
    const id = `lb${++uid}`;
    const fmt = opts.format || ((v) => String(Math.round(v)));
    const kids = data.children.filter((c) => c.value > 0 || c.prev > 0);
    const W = Math.max(720, container.clientWidth || 1000);
    const H = clamp(kids.length * 64 + 60, 260, 640);
    const xL = 200, xR = W - 250;
    const total = Math.max(1, data.source.value, data.source.prev || 0);
    const k = Math.min(70, H * 0.3) / total;              // ehrlich: Breite ∝ Betrag
    const wOf = (v) => Math.max(v > 0 ? 2 : 0, v * k);
    const step = kids.length > 1 ? Math.min(66, (H - 70) / (kids.length - 1)) : 0;
    const ty = kids.map((_, i) => H / 2 + (i - (kids.length - 1) / 2) * step);
    let y = H / 2 - kids.reduce((a, c) => a + wOf(c.value), 0) / 2;
    const parts = [], labels = [];
    kids.forEach((c, i) => {
      const w = wOf(c.value), wp = wOf(c.prev || 0);
      const y0 = y + w / 2; y += w;
      if (wp > 0) {                                           // Schatten: Vorzeitraum
        const g = river([xL, y0], [xR, ty[i]], wp, i + 5, { amp: 5 });
        parts.push(`<path class="lb-ghost" d="${outline(g, 0)}"/>`);
      }
      if (w > 0) {
        const g = river([xL, y0], [xR, ty[i]], w, i + 5, { amp: 5 });
        const cnt = Math.max(1, Math.floor(w / SPACING));
        const rnd = rng(hash(c.name));
        const lines = [];
        for (let j = 0; j < cnt; j++) {
          const u = (cnt === 1 ? 0 : (j / (cnt - 1)) * 2 - 1) * 0.9;
          const d = line(g.pts.map((p, q) => [p[0] + g.N[q][0] * (g.ws[q] / 2) * u, p[1] + g.N[q][1] * (g.ws[q] / 2) * u]));
          const dur = (SPEED * 5.5) / (1 - 0.55 * u * u) * (0.9 + 0.2 * rnd());
          lines.push(`<path class="lf-strand" d="${d}" stroke-width="${STROKE}"/><path class="lf-thread" d="${d}" stroke-width="${STROKE}" style="stroke-dasharray:${PATTERNS[Math.floor(rnd() * PATTERNS.length)]};animation-duration:${dur.toFixed(2)}s;animation-delay:-${(rnd() * dur).toFixed(2)}s"/>`);
        }
        parts.push(`<path class="lf-veil out" d="${outline(g)}"/><g class="lf-bundle out ${c.disc ? "disc" : ""} ${c.cls || ""}">${lines.join("")}</g>`);
      }
      const d = (c.value || 0) - (c.prev || 0);
      const up = d > 0;
      const delta = c.prev == null ? "" : Math.abs(d) < 1 ? "wie zuvor" : `${up ? "+" : "−"}${fmt(Math.abs(d))}`;
      labels.push(`<g class="lb-label"><circle class="lf-mouth ${c.cls || ""}" cx="${xR + 6}" cy="${f1(ty[i])}" r="3.6"/>
        <text x="${xR + 20}" y="${f1(ty[i] - 3)}" class="flow-name">${esc(c.name)}</text>
        <text x="${xR + 20}" y="${f1(ty[i] + 14)}" class="flow-value">${esc(fmt(c.value))}${c.prev != null ? ` <tspan class="flow-sub">· zuvor ${esc(fmt(c.prev))}</tspan> <tspan class="lb-delta ${up ? "up" : "down"}">${esc(delta)}</tspan>` : ""}</text></g>`);
    });
    const sd = data.source.prev != null ? data.source.value - data.source.prev : null;
    const src = `<g class="lb-label"><text x="${xL - 14}" y="${f1(H / 2 - 3)}" text-anchor="end" class="flow-name">${esc(data.source.name)}</text>
      <text x="${xL - 14}" y="${f1(H / 2 + 14)}" text-anchor="end" class="flow-value">${esc(fmt(data.source.value))}</text>
      ${sd != null ? `<text x="${xL - 14}" y="${f1(H / 2 + 31)}" text-anchor="end" class="lb-delta ${sd > 0 ? "up" : "down"}">${sd > 0 ? "+" : "−"}${esc(fmt(Math.abs(sd)))} ggü. ${esc(opts.prevLabel || "Vorzeitraum")}</text>` : ""}</g>`;
    container.innerHTML = `<div class="flow-scroll"><svg class="flow-svg lf lb" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opts.label || data.source.name)}">
      <g class="lb-ghosts">${parts.filter((p) => p.includes("lb-ghost")).join("")}</g>${parts.filter((p) => !p.includes("lb-ghost")).join("")}${src}${labels.join("")}</svg></div>`;
  }

  root.Flow = Object.assign(root.Flow || {}, { lake, branch });
})(window);
