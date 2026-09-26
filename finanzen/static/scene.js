/* Animierte Metapher-Bilder für den Blick (DESIGN.md §8).
   Alle Maße sind echte Daten; jedes der vier Elemente ist anklickbar und wächst zu seinem Fokus.
   Umgebungsbewegung per CSS (scene-*-Klassen in app.css), abschaltbar über body.no-motion. */
"use strict";
(function (root) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let uid = 0;
  const id = (p) => `${p}${++uid}`;

  /** Welle als Pfad: zwei Perioden breiter als nötig, damit sie horizontal wandern kann. */
  function wave(x0, width, y, amp = 6, period = 80) {
    let d = `M${x0 - period * 2},${y}`;
    for (let x = x0 - period * 2; x < x0 + width + period * 2; x += period) {
      d += ` q${period / 4},${-amp} ${period / 2},0 t${period / 2},0`;
    }
    return d;
  }

  /** Klickbares Element mit Trefferfläche, Beschriftung für Screenreader. */
  const el = (key, label, hit, inner) =>
    `<g class="scene-el" data-key="${key}" tabindex="0" role="button" aria-label="${esc(label)}">
      <rect class="scene-hit" x="${hit[0]}" y="${hit[1]}" width="${hit[2]}" height="${hit[3]}" rx="24"/>${inner}</g>`;

  const label = (x, y, title, value, sub, { anchor = "middle", bad = false, good = false, sub2 = "", light = false } = {}) =>
    `<g class="scene-label${light ? " on-water" : ""}" text-anchor="${anchor}">
      <text x="${x}" y="${y}" class="sl-title">${esc(title)}</text>
      <text x="${x}" y="${y + 26}" class="sl-value${bad ? " sl-bad" : good ? " sl-good" : ""}">${esc(value)}</text>
      ${sub ? `<text x="${x}" y="${y + 46}" class="sl-sub">${esc(sub)}</text>` : ""}
      ${sub2 ? `<text x="${x}" y="${y + 64}" class="sl-sub">${esc(sub2)}</text>` : ""}
    </g>`;

  // ------------------------------------------------------------------ Finanzen: Landschaft
  /**
   * d = { ausgaben: {soll, ist, sollToDate, remainingText, sub, bad} | null,
   *       sparquote: {rate, soll, text, sub, bad} | null,
   *       kategorien: {over: [{name, dev}], text, sub},
   *       depot: {value, invested, text, sub, bad} | null }
   */
  function finance(d) {
    const g = id("f");
    const parts = [];
    // Himmel, Hügel, Meer
    parts.push(`<defs>
      <linearGradient id="${g}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-sky-top"/><stop offset="1" class="sc-sky-bottom"/></linearGradient>
      <linearGradient id="${g}hill1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-hill1a"/><stop offset="1" class="sc-hill1b"/></linearGradient>
      <linearGradient id="${g}hill2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-hill2a"/><stop offset="1" class="sc-hill2b"/></linearGradient>
      <linearGradient id="${g}sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-sea-a"/><stop offset="1" class="sc-sea-b"/></linearGradient>
      <linearGradient id="${g}water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-water-a"/><stop offset="1" class="sc-water-b"/></linearGradient>
      <linearGradient id="${g}waterBad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-bad-a"/><stop offset="1" class="sc-bad-b"/></linearGradient>
      <linearGradient id="${g}sail" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="sc-gold-a"/><stop offset="1" class="sc-gold-b"/></linearGradient>
      <clipPath id="${g}tank"><rect x="112" y="152" width="166" height="256" rx="22"/></clipPath>
      <clipPath id="${g}seaclip"><path d="M820,560 C840,470 850,420 900,396 L1200,396 L1200,560 Z"/></clipPath>
    </defs>
    <rect width="1200" height="560" fill="url(#${g}sky)"/>
    <path class="sc-far" d="M0,380 C160,330 300,360 420,340 C560,316 700,350 860,330 C920,322 980,340 1040,400 L1040,560 L0,560 Z" fill="url(#${g}hill2)"/>
    <path d="M0,430 C140,400 280,420 400,410 C520,400 640,430 860,420 C900,418 930,430 960,460 L960,560 L0,560 Z" fill="url(#${g}hill1)"/>`);

    // 1 · Wassertank (Ausgaben)
    if (d.ausgaben) {
      const a = d.ausgaben;
      const level = a.soll ? clamp((a.soll - a.ist) / a.soll, 0, 1) : 0;
      const mark = a.soll ? clamp((a.soll - a.sollToDate) / a.soll, 0, 1) : null;
      const top = 152 + 256 * (1 - level);
      const markY = mark != null ? 152 + 256 * (1 - mark) : null;
      parts.push(el("ausgaben", `Ausgaben: ${a.remainingText}. ${a.sub}`, [70, 110, 260, 430], `
        <g class="sc-tank">
          <rect x="180" y="408" width="10" height="28" class="sc-leg"/><rect x="200" y="408" width="10" height="28" class="sc-leg"/>
          <rect x="104" y="144" width="182" height="272" rx="28" class="sc-glass"/>
          <g clip-path="url(#${g}tank)">
            <g class="sc-rise" style="--rise:${256 * level + 20}px">
              <rect x="100" y="${top}" width="200" height="${420 - top}" fill="url(#${a.bad ? `${g}waterBad` : `${g}water`})"/>
              <path style="--p:70px" class="sc-wave sc-wave-a" d="${wave(100, 200, top, 7, 70)} V420 H-100 Z" fill="url(#${a.bad ? `${g}waterBad` : `${g}water`})" opacity=".55"/>
              <path style="--p:90px" class="sc-wave sc-wave-b" d="${wave(100, 200, top + 2, 5, 90)} V420 H-100 Z" fill="url(#${a.bad ? `${g}waterBad` : `${g}water`})"/>
              <circle class="sc-bubble" cx="150" cy="390" r="4"/><circle class="sc-bubble sc-bubble-2" cx="230" cy="395" r="3"/>
            </g>
          </g>
          <rect x="104" y="144" width="182" height="272" rx="28" class="sc-glass-rim"/>
          <path d="M126,170 v140" class="sc-glint"/>
          ${markY != null ? `<g class="sc-mark"><line x1="96" x2="294" y1="${markY}" y2="${markY}"/><text x="300" y="${markY + 4}">Soll heute</text></g>` : ""}
        </g>
        ${label(195, 462, "Monatsbudget", a.remainingText, a.sub, { bad: a.bad, sub2: a.sub2 })}`));
    }

    // 2 · Pflanze (Sparquote)
    if (d.sparquote) {
      const q = d.sparquote;
      const unit = 190; // Höhe des Solls
      const h = clamp(q.rate / (q.soll || 20), 0.08, 1.45) * unit;
      const base = 404, top = base - h;
      const leaves = [];
      for (let y = base - 36, i = 0; y > top + 14; y -= 34, i++) {
        const side = i % 2 ? -1 : 1;
        leaves.push(`<path class="sc-leaf" style="--d:${i * 0.12}s" d="M470,${y} q${side * 34},-22 ${side * 58},-4 q${side * -24},18 ${side * -58},4 Z"/>`);
      }
      parts.push(el("sparquote", `Sparquote: ${q.text}. ${q.sub}`, [370, 150, 210, 390], `
        <g class="sc-plant ${q.bad ? "sc-wilt" : ""}">
          <g class="sc-sway">
            <g class="sc-grow">
              <path class="sc-stem" d="M470,${base} C466,${base - h * 0.4} 476,${base - h * 0.7} 470,${top}"/>
              ${leaves.join("")}
              <circle class="sc-bud" cx="470" cy="${top}" r="9"/>
            </g>
          </g>
          <path class="sc-pot" d="M430,400 h80 l-10,44 h-60 Z"/><rect x="424" y="394" width="92" height="12" rx="4" class="sc-pot-rim"/>
          <g class="sc-soll"><line x1="400" x2="545" y1="${base - unit}" y2="${base - unit}"/>
            <path d="M545,${base - unit} v-26 l22,8 l-22,8" class="sc-flag"/><text x="572" y="${base - unit - 12}">Soll ${esc(q.sollText)}</text></g>
        </g>
        ${label(470, 462, "Sparquote", q.text, q.sub, { bad: q.bad, sub2: q.sub2 })}`));
    }

    // 3 · Wetter (Kategorien)
    const k = d.kategorien;
    const clouds = (k?.over || []).slice(0, 3);
    const cloudPos = [[680, 110], [860, 150], [690, 230]];
    parts.push(el("kategorien", `Kategorien: ${k?.text || ""}`, [580, 20, 330, 300], `
      <g transform="translate(${clouds.length ? 790 : 740},${clouds.length ? 100 : 130})"><g class="sc-sun ${clouds.length ? "sc-sun-dim" : ""}">
        <g class="sc-rays">${Array.from({ length: 12 }, (_, i) => `<rect x="-3" y="-74" width="6" height="18" rx="3" transform="rotate(${i * 30})"/>`).join("")}</g>
        <circle r="46" class="sc-sun-disc"/>
      </g></g>
      ${clouds.map((c, i) => `<g transform="translate(${cloudPos[i][0]},${cloudPos[i][1]})"><g class="sc-cloud" style="--d:${i * 1.3}s">
          <g class="sc-rain">${[-40, -14, 12, 38].map((x) => `<line x1="${x}" y1="34" x2="${x - 6}" y2="58"/>`).join("")}</g>
          <path class="sc-cloud-body" d="M-78,28 a26,26 0 0 1 10,-50 a38,38 0 0 1 72,-8 a30,30 0 0 1 56,20 a22,22 0 0 1 -6,38 Z"/>
          <text y="4" class="sc-cloud-name">${esc(c.name.length > 16 ? `${c.name.slice(0, 15)}…` : c.name)}</text>
          <text y="24" class="sc-cloud-dev">⚠ +${esc(c.devText)}</text>
        </g></g>`).join("")}
      ${label(clouds.length ? 880 : 740, clouds.length ? 250 : 232, "Kategorien", k?.text || "", k?.sub || "", { bad: clouds.length > 0 })}`));

    // 4 · Meer und Boot (Depot)
    parts.push(`<path d="M820,560 C840,470 850,420 900,400 L1200,400 L1200,560 Z" fill="url(#${g}sea)"/>
      <path style="--p:60px" class="sc-wave sc-sea-wave" d="${wave(860, 340, 404, 5, 60)} V560 H700 Z" fill="url(#${g}sea)" opacity=".6" clip-path="url(#${g}seaclip)"/>`);
    if (d.depot) {
      const p = d.depot;
      const gain = p.invested ? (p.value - p.invested) / p.invested : 0;
      const lift = clamp(gain * 420, -34, 110); // 10 % Gewinn ≈ 42 px über der Wasserlinie
      const y = 400 - lift;
      parts.push(el("depot", `Depot: ${p.text}. ${p.sub}`, [870, 150, 320, 390], `
        <g class="sc-boat-wrap" style="--y:${y}px">
          <g class="sc-bob">
            <g transform="translate(1030,${y})">
              <path class="sc-mast" d="M0,0 V-150"/>
              <path d="M4,-146 L4,-14 L86,-14 Z" fill="url(#${g}sail)" class="sc-sail"/>
              <path d="M-4,-128 L-4,-18 L-62,-18 Z" fill="url(#${g}sail)" opacity=".75" class="sc-sail"/>
              <path d="M0,-150 l26,8 l-26,8" class="sc-pennant"/>
              <path class="sc-hull" d="M-86,-8 H96 L70,26 H-62 Z"/>
            </g>
          </g>
        </g>
        <g class="sc-waterline on-water"><line x1="880" x2="1190" y1="400" y2="400"/><text x="1190" y="428" text-anchor="end">Wasserlinie = Einzahlungen ${esc(p.investedText)}</text></g>
        <path style="--p:50px" class="sc-wave sc-sea-front" d="${wave(860, 340, 412, 4, 50)} V560 H700 Z" fill="url(#${g}sea)" opacity=".85" clip-path="url(#${g}seaclip)"/>
        ${label(1040, 462, "Depot", p.text, p.sub, { bad: p.bad, light: true, sub2: p.sub2 })}`));
    }
    return `<svg class="scene-svg" viewBox="0 0 1200 560" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Deine Finanzen als Landschaft">${parts.join("")}</svg>`;
  }

  // ------------------------------------------------------------------ Sparplan: Bergtour
  /**
   * d = { depot: {value, invested, text, sub, investedText, bad},
   *       takt: {months: [{done, due}], text, sub, bad},
   *       ziel: {median: [..], p10: [..], p90: [..], goal, reached, text, sub, goalText, startLabel, endLabel},
   *       spiel: {scenarios: [{name, value, text, active}], text} }
   */
  function plan(d) {
    const g = id("p");
    const parts = [];
    parts.push(`<defs>
      <linearGradient id="${g}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-sky-top"/><stop offset="1" class="sc-sky-bottom"/></linearGradient>
      <linearGradient id="${g}mnt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-mnt-a"/><stop offset="1" class="sc-mnt-b"/></linearGradient>
      <linearGradient id="${g}ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-hill1a"/><stop offset="1" class="sc-hill1b"/></linearGradient>
      <linearGradient id="${g}lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sc-sea-a"/><stop offset="1" class="sc-sea-b"/></linearGradient>
      <radialGradient id="${g}balloon" cx=".35" cy=".3" r=".8"><stop offset="0" class="sc-gold-a"/><stop offset="1" class="sc-gold-b"/></radialGradient>
      <clipPath id="${g}lakeclip"><ellipse cx="180" cy="468" rx="150" ry="40"/></clipPath>
    </defs>
    <rect width="1200" height="560" fill="url(#${g}sky)"/>
    <path class="sc-far" d="M300,440 L420,300 L500,360 L600,250 L700,340 L760,300 L820,440 Z" opacity=".5"/>`);

    // 3 · Berg (Ziel): Grat = mittlerer Verlauf
    const z = d.ziel;
    const x0 = 600, x1 = 1110, base = 440, topY = 70;
    const maxV = Math.max(z.goal, ...z.median, ...(z.p90 || [])) * 1.02;
    const n = z.median.length - 1;
    const px = (i) => x0 + ((x1 - x0) * i) / n;
    const py = (v) => base - (v / maxV) * (base - topY);
    const step = Math.max(1, Math.floor(n / 80));
    const idx = []; for (let i = 0; i <= n; i += step) idx.push(i); if (idx[idx.length - 1] !== n) idx.push(n);
    const ridge = idx.map((i, k) => `${k ? "L" : "M"}${px(i).toFixed(1)},${py(z.median[i]).toFixed(1)}`).join(" ");
    const endY = py(z.median[n]);
    const mist = z.p90 ? idx.map((i, k) => `${k ? "L" : "M"}${px(i).toFixed(1)},${py(z.p90[i]).toFixed(1)}`).join(" ") + " " +
      [...idx].reverse().map((i) => `L${px(i).toFixed(1)},${py(z.p10[i]).toFixed(1)}`).join(" ") + " Z" : "";
    const goalY = py(z.goal);
    parts.push(el("ziel", `Ziel: ${z.text}. ${z.sub}`, [560, 30, 630, 430], `
      ${mist ? `<path class="sc-mist" d="${mist}"/>` : ""}
      <path class="sc-mountain" d="${ridge} L${x1 + 40},${endY + 30} L1180,${base} L${x0 - 20},${base} Z" fill="url(#${g}mnt)"/>
      <path class="sc-snow" d="${ridge}"/>
      <path id="${g}ridge" class="sc-ridge" d="${ridge}"/>
      <circle r="8" class="sc-climber"><animateMotion class="sc-motion" dur="9s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.75;1" calcMode="linear"><mpath href="#${g}ridge"/></animateMotion></circle>
      <g class="sc-goal ${z.reached ? "reached" : "missed"}">
        ${z.reached ? "" : `<line x1="${x1}" x2="${x1}" y1="${endY}" y2="${goalY}" class="sc-gap"/>`}
        <line x1="${x1}" x2="${x1}" y1="${goalY}" y2="${goalY - 56}" class="sc-pole"/>
        <path class="sc-goalflag" d="M${x1},${goalY - 56} l44,12 l-44,12 Z"/>
        <text x="${x1 - 8}" y="${goalY - 64}" text-anchor="end" class="sc-goal-text">${esc(z.goalText)}</text>
      </g>
      <text x="${x0}" y="${base + 22}" class="sc-axis">${esc(z.startLabel)}</text>
      <text x="${x1}" y="${base + 22}" text-anchor="middle" class="sc-axis">${esc(z.endLabel)}</text>
      ${label(760, 110, "Ziel", z.text, z.sub, { anchor: "start", bad: !z.reached, good: z.reached })}`));

    // Boden
    parts.push(`<path d="M0,440 C200,428 400,448 600,440 C800,432 1000,446 1200,438 L1200,560 L0,560 Z" fill="url(#${g}ground)"/>`);

    // 1 · Ballon über dem See (Depot)
    const p = d.depot;
    const gain = p.invested ? (p.value - p.invested) / p.invested : 0;
    const lift = clamp(70 + gain * 900, 0, 250); // Wasserlinie = Einzahlungen; über Wasser = Gewinn
    const by = 430 - lift;
    parts.push(el("depot", `Depot: ${p.text}. ${p.sub}`, [20, 40, 320, 500], `
      <ellipse cx="180" cy="468" rx="150" ry="40" fill="url(#${g}lake)"/>
      <path style="--p:50px" class="sc-wave sc-sea-wave" d="${wave(30, 300, 452, 4, 50)} V540 H-200 Z" fill="url(#${g}lake)" opacity=".5" clip-path="url(#${g}lakeclip)"/>
      <g class="sc-waterline"><line x1="40" x2="320" y1="440" y2="440"/><text x="320" y="432" text-anchor="end">Einzahlungen ${esc(p.investedText)}</text></g>
      <g class="sc-float">
        <g class="sc-balloon-rise" style="--y:${by}px">
          <g transform="translate(180,${by})">
            <path class="sc-rope" d="M-18,-44 L-12,-6 M18,-44 L12,-6"/>
            <rect x="-16" y="-8" width="32" height="22" rx="4" class="sc-basket"/>
            <path d="M0,-160 C-70,-160 -80,-90 -40,-60 L-18,-44 H18 L40,-60 C80,-90 70,-160 0,-160 Z" fill="url(#${g}balloon)" class="sc-envelope"/>
            <path d="M0,-160 C-22,-150 -24,-80 -10,-44 M0,-160 C22,-150 24,-80 10,-44" class="sc-stripe"/>
          </g>
        </g>
      </g>
      ${label(180, 90, "Depot", p.text, p.sub, { bad: p.bad })}`));

    // 4 · Wegweiser (Was wäre wenn)
    const s = d.spiel;
    const maxS = Math.max(...s.scenarios.map((x) => x.value)) || 1;
    parts.push(el("spiel", `Was wäre wenn: ${s.text}`, [340, 190, 240, 260], `
      <rect x="386" y="230" width="10" height="212" rx="4" class="sc-post"/>
      ${s.scenarios.map((x, i) => {
        const w = 70 + (x.value / maxS) * 110;
        const y = 248 + i * 52;
        return `<g class="sc-board ${x.active ? "active" : ""}" style="--d:${i * 0.15}s">
          <path d="M396,${y} h${w} l16,17 l-16,17 h-${w} Z"/>
          <text x="404" y="${y + 15}" class="sb-name">${esc(x.name)}</text>
          <text x="404" y="${y + 29}" class="sb-value">${esc(x.text)}</text></g>`;
      }).join("")}
      <text x="391" y="216" text-anchor="middle" class="sc-post-title">Was wäre wenn</text>`));

    // 2 · Trittsteine (Takt)
    const t = d.takt;
    const months = t.months.slice(-12);
    const gap = Math.min(70, 520 / Math.max(1, months.length));
    parts.push(el("takt", `Sparplan-Takt: ${t.text}. ${t.sub}`, [340, 460, 560, 90], `
      <path class="sc-path" d="M330,500 C500,470 700,520 ${600 + months.length * gap},490"/>
      ${months.map((m, i) => {
        const cx = 360 + i * gap, cy = 498 + (i % 2 ? -6 : 4);
        const cls = m.done ? "done" : m.due ? "missing" : "next";
        return `<g class="sc-stone ${cls}" style="--d:${0.2 + i * 0.08}s"><ellipse cx="${cx}" cy="${cy}" rx="${gap * 0.36}" ry="11"/>${cls === "missing" ? `<text x="${cx}" y="${cy + 4}" text-anchor="middle">⚠</text>` : ""}</g>`;
      }).join("")}
      <text x="${360 + months.length * gap + 10}" y="492" class="sc-takt-title">Sparplan-Takt</text>
      <text x="${360 + months.length * gap + 10}" y="512" class="sc-takt-text ${t.bad ? "sl-bad" : ""}">${esc(t.text)}</text>`));

    return `<svg class="scene-svg" viewBox="0 0 1200 560" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Dein Sparplan als Bergtour">${parts.join("")}</svg>`;
  }

  /** Bild in einen Container setzen und die Elemente mit dem Zoom verbinden. */
  function mount(container, svg, onOpen) {
    container.innerHTML = svg;
    container.onclick = (e) => { const g = e.target.closest(".scene-el"); if (g) onOpen(g.dataset.key, g); };
    container.onkeydown = (e) => {
      const g = e.target.closest(".scene-el");
      if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(g.dataset.key, g); }
    };
    // Eintritt nur beim ersten Zeichnen, danach ruhig aktualisieren
    if (!container.dataset.entered) {
      container.classList.add("scene-enter");
      container.dataset.entered = "1";
      setTimeout(() => container.classList.remove("scene-enter"), 2600);
    }
  }

  root.Scene = { finance, plan, mount };
})(window);
