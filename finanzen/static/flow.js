/* Animierter Geldfluss (Sankey) als SVG: Spalten von Knoten, Bänder proportional zum Betrag,
   darauf ruhig fließende Lichtpunkte (mehr Geld = dichterer Strom). Keine Abhängigkeiten. */
"use strict";
(function (root) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let uid = 0;

  /**
   * data = { nodes: [{id, name, value, col, cls?, sub?, click?}], links: [{from, to, value, cls?}] }
   * opts = { height?, format(value) → text, detail(node|link) → HTML für den Tooltip, onClick(node) }
   */
  function render(container, data, opts = {}) {
    const id = `fl${++uid}`;
    const W = Math.max(640, container.clientWidth || 1000);
    const cols = Math.max(...data.nodes.map((n) => n.col)) + 1;
    const narrow = W < 820;
    const padL = narrow ? 118 : 190, padR = narrow ? 150 : 230, nodeW = 14, gap = 14, padY = 16;
    const byCol = Array.from({ length: cols }, (_, c) => data.nodes.filter((n) => n.col === c));
    const maxCount = Math.max(...byCol.map((l) => l.length));
    const H = opts.height || clamp(maxCount * 46 + 60, 320, 640);
    const colTotal = byCol.map((l) => l.reduce((s, n) => s + n.value, 0));
    const k = Math.min(...byCol.map((l, c) => (H - 2 * padY - gap * (l.length - 1)) / (colTotal[c] || 1)));
    const xOf = (c) => padL + ((W - padL - padR - nodeW) * c) / Math.max(1, cols - 1);
    const pos = new Map();
    byCol.forEach((list, c) => {
      const total = list.reduce((s, n) => s + Math.max(n.value * k, 3), 0) + gap * (list.length - 1);
      let y = (H - total) / 2;
      for (const n of list) {
        const h = Math.max(n.value * k, 3);
        pos.set(n.id, { x: xOf(c), y, h, out: y, in: y, node: n });
        y += h + gap;
      }
    });
    // Bänder: ab- und zufließend nach Lage des Gegenübers gestapelt, damit sich nichts kreuzt
    const links = data.links.filter((l) => pos.has(l.from) && pos.has(l.to) && l.value > 0)
      .map((l) => ({ ...l, w: Math.max(l.value * k, 1.5) }));
    [...links].sort((a, b) => pos.get(a.to).y - pos.get(b.to).y).forEach((l) => { const s = pos.get(l.from); l.y0 = s.out + l.w / 2; s.out += l.w; });
    [...links].sort((a, b) => pos.get(a.from).y - pos.get(b.from).y).forEach((l) => { const t = pos.get(l.to); l.y1 = t.in + l.w / 2; t.in += l.w; });
    const maxLink = Math.max(...links.map((l) => l.value), 1);

    const parts = [`<svg class="flow-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opts.label || "Geldfluss")}">
      <defs><clipPath id="${id}clip"><rect class="flow-reveal" x="0" y="0" width="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#${id}clip)">`];
    links.forEach((l, i) => {
      const s = pos.get(l.from), t = pos.get(l.to);
      const x0 = s.x + nodeW, x1 = t.x, mx = (x0 + x1) / 2;
      const center = `M${x0},${l.y0} C${mx},${l.y0} ${mx},${l.y1} ${x1},${l.y1}`;
      const top0 = l.y0 - l.w / 2, top1 = l.y1 - l.w / 2, bot0 = l.y0 + l.w / 2, bot1 = l.y1 + l.w / 2;
      const band = `M${x0},${top0} C${mx},${top0} ${mx},${top1} ${x1},${top1} L${x1},${bot1} C${mx},${bot1} ${mx},${bot0} ${x0},${bot0} Z`;
      // Dichte: große Ströme dichter gepunktet; Geschwindigkeit überall gleich ruhig
      const share = l.value / maxLink;
      const spacing = clamp(34 - share * 24, 9, 34);
      const dot = clamp(l.w * 0.28, 1.6, 6);
      const period = spacing + 0.1;
      parts.push(`<g class="flow-link ${l.cls || ""}" data-i="${i}" data-from="${esc(l.from)}" data-to="${esc(l.to)}">
        <path class="flow-band" d="${band}"/>
        <path class="flow-dots" d="${center}" style="stroke-width:${dot.toFixed(1)}px;stroke-dasharray:0.1 ${spacing.toFixed(1)};--p:${(period * 8).toFixed(1)};animation-duration:${(period * 8 / 38).toFixed(2)}s"/>
      </g>`);
    });
    parts.push("</g>");
    const fmt = opts.format || ((v) => String(Math.round(v)));
    // Beschriftungen der Randspalten entzerren: mindestens 34 px Abstand, notfalls mit Führungslinie
    const LABEL_GAP = 34, TOP = 18, BOTTOM = H - 22;
    const side = (c) => byCol[c].length > 1 || c === 0 || c === cols - 1; // Einzelknoten in der Mitte: Beschriftung oben
    for (let c = 0; c < cols; c++) {
      if (!side(c)) continue;
      const list = byCol[c].map((n) => pos.get(n.id)).sort((a, b) => a.y - b.y);
      list.forEach((p, i) => { p.ly = Math.max(TOP, p.y + p.h / 2); if (i && p.ly < list[i - 1].ly + LABEL_GAP) p.ly = list[i - 1].ly + LABEL_GAP; });
      if (list.length && list[list.length - 1].ly > BOTTOM) for (let i = list.length - 1; i >= 0; i--) {
        const limit = i === list.length - 1 ? BOTTOM : list[i + 1].ly - LABEL_GAP;
        list[i].ly = Math.min(list[i].ly, limit);
      }
    }
    const maxChars = (c) => (c === 0 ? Math.floor(padL / 7.4) : c === cols - 1 ? Math.floor(padR / 7.4) : 22);
    const short = (name, c) => (name.length > maxChars(c) ? `${name.slice(0, maxChars(c) - 1)}…` : name);
    for (const [nid, p] of pos) {
      const n = p.node;
      const c = n.col, last = c === cols - 1, first = c === 0;
      const beside = side(c);
      const lx = first ? p.x - 10 : beside ? p.x + nodeW + 10 : p.x + nodeW / 2;
      const anchor = first ? "end" : beside ? "start" : "middle";
      const ly = beside ? p.ly : p.y - 10;
      const mid = p.y + p.h / 2;
      if (beside && Math.abs(ly - mid) > 4) {
        const x0 = first ? p.x - 2 : p.x + nodeW + 2, x1 = first ? p.x - 8 : p.x + nodeW + 8;
        parts.push(`<path class="flow-leader" d="M${x0},${mid} L${x1},${ly - 4}"/>`);
      }
      const text = `<text x="${lx}" y="${ly - (beside ? 3 : 14)}" text-anchor="${anchor}" class="flow-name"><title>${esc(n.name)}</title>${esc(short(n.name, c))}</text>
        <text x="${lx}" y="${ly + (beside ? 14 : 2)}" text-anchor="${anchor}" class="flow-value">${esc(fmt(n.value))}${n.sub ? ` <tspan class="flow-sub">${esc(n.sub)}</tspan>` : ""}</text>`;
      parts.push(`<g class="flow-node ${n.cls || ""} ${n.click ? "clickable" : ""}" data-id="${esc(nid)}" ${n.click ? `tabindex="0" role="button" aria-label="${esc(n.name)} ${esc(fmt(n.value))} – Details öffnen"` : ""}>
        <rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${p.h}" rx="4"/>
        ${n.click ? `<rect class="flow-hit" x="${first ? p.x - padL + 8 : p.x}" y="${p.y - 4}" width="${first ? padL - 4 : last ? padR : nodeW}" height="${p.h + 8}"/>` : ""}
        ${text}</g>`);
    }
    parts.push("</svg>");
    container.innerHTML = `<div class="flow-scroll">${parts.join("")}</div><div class="flow-tip" hidden></div>`;
    container.classList.remove("flow-in");
    void container.offsetWidth; // Eintritt neu starten
    container.classList.add("flow-in");

    // Hervorheben und Tooltip
    const svg = container.querySelector("svg");
    const tip = container.querySelector(".flow-tip");
    const related = (nid) => links.filter((l) => l.from === nid || l.to === nid);
    const highlight = (set) => {
      svg.classList.toggle("focusing", !!set);
      container.querySelectorAll(".flow-link").forEach((g) => g.classList.toggle("hi", !!set && set.has(+g.dataset.i)));
    };
    const showTip = (html, e) => {
      if (!html) { tip.hidden = true; return; }
      tip.innerHTML = html;
      tip.hidden = false;
      const r = container.getBoundingClientRect();
      const x = clamp(e.clientX - r.left + 14, 8, r.width - tip.offsetWidth - 8);
      const y = clamp(e.clientY - r.top + 14, 8, r.height - tip.offsetHeight - 8);
      tip.style.transform = `translate(${x}px, ${y}px)`;
    };
    svg.addEventListener("pointermove", (e) => {
      const node = e.target.closest(".flow-node"), link = e.target.closest(".flow-link");
      if (node) {
        const n = pos.get(node.dataset.id).node;
        highlight(new Set(related(n.id).map((l) => links.indexOf(l))));
        showTip(opts.detail ? opts.detail(n, "node") : `<b>${esc(n.name)}</b><br>${esc(fmt(n.value))}`, e);
      } else if (link) {
        const l = links[+link.dataset.i];
        highlight(new Set([+link.dataset.i]));
        showTip(opts.detail ? opts.detail(l, "link", pos.get(l.from).node, pos.get(l.to).node) : `${esc(fmt(l.value))}`, e);
      } else { highlight(null); showTip(null); }
    });
    svg.addEventListener("pointerleave", () => { highlight(null); showTip(null); });
    const open = (el) => { const n = pos.get(el.dataset.id)?.node; if (n?.click && opts.onClick) opts.onClick(n, el); };
    svg.addEventListener("click", (e) => { const el = e.target.closest(".flow-node.clickable"); if (el) open(el); else {
      const link = e.target.closest(".flow-link"); if (link) { const n = pos.get(links[+link.dataset.i].to).node; if (n.click && opts.onClick) opts.onClick(n, link); } } });
    svg.addEventListener("keydown", (e) => { const el = e.target.closest(".flow-node.clickable"); if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(el); } });
  }

  root.Flow = { render };
})(window);
