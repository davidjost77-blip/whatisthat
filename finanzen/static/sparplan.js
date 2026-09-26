/* Sparplan nach DESIGN.md: Blick (Depot, Takt, Ziel, Was wäre wenn) → Fokus → Tiefe.
   Rechenkern: sparplan-model.js · Zoom, Breadcrumb, Esc, Äquivalente: ui-core.js */
"use strict";

const M = window.SparplanModel;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = UI.esc;
const num = (d = 2) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const pctFmt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const money = UI.money, money0 = UI.money0, moneyShort = UI.moneyShort;
const signed = (x, fmt = money) => UI.signed(x, fmt);
const signedPct = (x) => `${x >= 0 ? "+" : "−"}${pctFmt.format(Math.abs(x))} %`;
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const dateDe = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

async function api(method, path, body) {
  const opts = { method, headers: { "X-Finanzen": "1" } };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, { error = false } = {}) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}

// ------------------------------------------------------------------ Zustand
const state = {
  tx: [], settings: null, catalog: [],
  quotes: new Map(),      // Kürzel → {price, prev_close, time, stale, currency}
  history: new Map(),     // "Kürzel|range|interval" → points
  stats: new Map(),       // Kürzel → {cagr, vol, years, from}
  histRange: "depot",
  projView: "fan",
  result: null,
};
const PLAN = () => state.settings.plan.symbol;
const scen = () => state.settings.scenario;
const targets = () => state.settings.targets || {};
const catalogOf = (symbol) => state.catalog.find((c) => c.symbol === symbol);
const TOLERANCE = 0.02; // Abgleich: unter 2 % Differenz gilt als passend

// Zeitachse: Monat 0 = heute, Monat 1 = nächste Sparplan-Ausführung
const TODAY = new Date();
function firstPlanDate() {
  const day = state.settings.plan.day || 25;
  const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), day);
  if (TODAY.getDate() >= day) d.setMonth(d.getMonth() + 1);
  return d;
}
const monthDate = (m) => { const d = firstPlanDate(); d.setMonth(d.getMonth() + m - 1); return d; };
const monthOf = (yyyyMm) => {
  if (!yyyyMm) return 1;
  const f = firstPlanDate();
  const [y, mo] = yyyyMm.split("-").map(Number);
  return Math.max(1, (y - f.getFullYear()) * 12 + (mo - 1 - f.getMonth()) + 1);
};
const monthLabel = (m) => (m === 0 ? "heute" : `${MONTHS[monthDate(m).getMonth()]} ${monthDate(m).getFullYear()}`);
const durationText = (m) => {
  const y = Math.floor(m / 12), r = m % 12;
  return [y ? `${y} J.` : "", r ? `${r} M.` : ""].filter(Boolean).join(" ") || "sofort";
};
const goalYear = () => targets().goal_year || TODAY.getFullYear() + 20;
const goalAmount = () => (targets().goal || 10000000) / 100;
const goalMonth = () => monthOf(`${goalYear()}-12`);

// ------------------------------------------------------------------ Graustufen für Reihen
// Reihen unterscheiden sich über Helligkeit + direkte Beschriftung, nicht über Farbe (DESIGN.md §5).
function shade(slot) {
  const t = UI.theme();
  // ein Farbton: Plan-ETF in vollem Bronze, weitere ETFs in helleren Stufen desselben Tons
  return [1, 0.72, 0.5, 0.34, 0.24, 0.62, 0.42, 0.28].map((o) => UI.alpha(t.gold, o))[slot] || t.ink3;
}
const alpha = (color, a) => {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return color;
};

const layerCharts = { 2: [], 3: [] };
function mkChart(el, level) {
  const c = echarts.init(el, null, { renderer: "svg" });
  layerCharts[level].push(c);
  return c;
}
function disposeCharts(level) { layerCharts[level].forEach((c) => c.dispose()); layerCharts[level] = []; }
window.addEventListener("resize", () => [2, 3].forEach((l) => layerCharts[l].forEach((c) => c.resize())));

function sparkSvg(values, color) {
  if (!values || values.length < 2) return "";
  const w = 300, h = 44, pad = 3;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(1)},${(h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1)}`).join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// ------------------------------------------------------------------ Kurse
async function loadQuote(symbol) {
  try {
    state.quotes.set(symbol, await api("GET", `/api/quotes/chart?symbol=${encodeURIComponent(symbol)}&range=5d&interval=1d`));
  } catch (e) {
    if (!state.quotes.has(symbol)) state.quotes.set(symbol, { error: e.message });
  }
  return state.quotes.get(symbol);
}
async function loadHistory(symbol, range, interval = "1d") {
  const key = `${symbol}|${range}|${interval}`;
  if (state.history.has(key)) return state.history.get(key);
  try {
    const q = await api("GET", `/api/quotes/chart?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}${interval === "1mo" ? "&stats=1" : ""}`);
    state.history.set(key, q.points);
    if (q.stats) state.stats.set(symbol, q.stats);
    if (!state.quotes.get(symbol)?.price) state.quotes.set(symbol, q);
    return q.points;
  } catch {
    return null;
  }
}
const lastBuyPrice = (symbol) => {
  const t = [...state.tx].reverse().find((x) => x.symbol === symbol);
  return t ? t.amount / 100 / t.shares : null;
};
const priceOf = (symbol) => state.quotes.get(symbol)?.price ?? lastBuyPrice(symbol);
function depotRange() {
  const first = state.tx.filter((t) => t.symbol === PLAN()).map((t) => t.date).sort()[0];
  if (!first) return "6mo";
  const days = (TODAY - new Date(first)) / 864e5;
  return days < 170 ? "6mo" : days < 350 ? "1y" : days < 700 ? "2y" : days < 1800 ? "5y" : "max";
}

function renderLiveChip() {
  const q = state.quotes.get(PLAN());
  const chip = $("#live-chip");
  const name = catalogOf(PLAN())?.short || PLAN();
  if (!q || q.error || !q.price) {
    chip.className = "live err";
    chip.querySelector("span").innerHTML = `${esc(name)}: kein Live-Kurs – gerechnet mit letztem Kaufkurs`;
    chip.title = q?.error || "";
    return;
  }
  const change = q.prev_close ? (q.price / q.prev_close - 1) * 100 : null;
  const t = q.time ? new Date(q.time * 1000) : null;
  chip.className = `live ${q.stale ? "" : "on"}`;
  chip.title = q.stale ? `Letzter gespeicherter Stand – Quelle gerade nicht erreichbar (${q.error || ""})` : `${q.exchange || ""} · verzögert`;
  chip.querySelector("span").innerHTML = `${esc(name)} <b>${money(q.price)}</b>` +
    (change !== null ? ` <span class="${change >= 0 ? "up" : "down"}">${change >= 0 ? "▲" : "▼"} ${pctFmt.format(Math.abs(change))} %</span>` : "") +
    (t ? ` · ${q.stale ? "gespeichert " : ""}${t.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "");
}

// ------------------------------------------------------------------ Kennzahlen
function depotNow() {
  const h = M.holding(state.tx, PLAN());
  const price = priceOf(PLAN()) || 0;
  const others = [...new Set(state.tx.map((t) => t.symbol))].filter((s) => s !== PLAN())
    .map((s) => { const x = M.holding(state.tx, s); return { symbol: s, ...x, value: x.shares * (priceOf(s) || x.avg) }; });
  const planValue = h.shares * price;
  return { ...h, price, planValue, value: planValue + others.reduce((s, x) => s + x.value, 0),
    invested: h.invested + others.reduce((s, x) => s + x.invested, 0), cash: (state.settings.cash || 0) / 100 };
}

/** Abgleich mit dem Kontoauszug: fehlt ein Kauf? */
function reconcile() {
  const snap = state.settings.snapshot;
  if (!snap?.portfolio) return null;
  const points = state.history.get(`${PLAN()}|${depotRange()}|1d`) || [];
  const hist = M.depotHistory(state.tx, points, PLAN(), snap.date);
  const calc = hist.length ? hist[hist.length - 1] : { value: 0, price: priceOf(PLAN()) };
  const reported = snap.portfolio / 100;
  const diff = reported - calc.value;
  const rel = reported ? Math.abs(diff) / reported : 0;
  return { date: snap.date, reported, calc: calc.value, diff, ok: rel <= TOLERANCE, shares: calc.price ? diff / calc.price : 0 };
}

/** Takt: ein Kauf pro Monat seit dem ersten Kauf des Plan-ETFs. */
function rhythm() {
  const txs = state.tx.filter((t) => t.symbol === PLAN()).sort((a, b) => a.date.localeCompare(b.date));
  if (!txs.length) return { months: [], done: 0, due: 0, missing: [] };
  const day = state.settings.plan.day || 25;
  const have = new Set(txs.map((t) => t.date.slice(0, 7)));
  const months = [];
  const d = new Date(+txs[0].date.slice(0, 4), +txs[0].date.slice(5, 7) - 1, 1);
  const end = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
  while (d <= end) {
    const key = ym(d);
    const dueDate = new Date(d.getFullYear(), d.getMonth(), day + 3); // drei Tage Puffer für die Ausführung
    months.push({ ym: key, done: have.has(key), due: dueDate <= TODAY || have.has(key) });
    d.setMonth(d.getMonth() + 1);
  }
  const missing = months.filter((m) => m.due && !m.done);
  const invested = months.map((m) => txs.filter((t) => t.date.startsWith(m.ym)).reduce((s, t) => s + t.amount / 100, 0));
  return { months, invested, done: months.filter((m) => m.done).length, due: months.filter((m) => m.due).length, missing };
}

// ------------------------------------------------------------------ Projektion
function positions() {
  const s = scen();
  const list = [{ id: "plan", name: catalogOf(PLAN())?.short || PLAN(), slot: 0, start: depotNow().value, rate: s.rate, ret: s.ret, vol: s.vol, ter: s.ter, from: 1 }];
  for (const x of state.settings.extras) {
    if (!x.enabled) continue;
    list.push({ id: x.id, name: x.short || x.name, slot: x.slot, start: 0, rate: +x.rate || 0, ret: +x.ret, vol: +x.vol, ter: +x.ter || 0,
      from: monthOf(x.start), lump: +x.lump || 0 });
  }
  return list;
}
const PRESETS = [
  { name: "Vorsichtig", ret: 4, text: "Lange Seitwärtsphasen, wie Welt-Aktien 2000–2012" },
  { name: "Historisch", ret: 7, text: "Etwa der langfristige Schnitt globaler Aktien" },
  { name: "Rückenwind", ret: 9, text: "Starke Jahrzehnte wie die 1990er oder 2010er" },
];
function projOpts(months) {
  const s = scen();
  return { months, dynamic: s.dynamic, inflation: s.inflation, real: s.real, paths: 600, seed: 11, rho: 0.8,
    investedStart: depotNow().invested, lumps: (s.lumps || []).map((l) => ({ month: monthOf(l.date), amount: +l.amount || 0 })) };
}
function runProjection() {
  const s = scen();
  const pos = positions();
  const opts = projOpts(s.years * 12);
  state.result = { pos, opts, r: M.project(pos, opts) };
  state.result.scenarios = PRESETS.map((p) => ({ ...p, r: M.project(pos, { ...opts, paths: 0, retShift: p.ret - s.ret }) }));
}
/** Ziel-Rechnung: Median, Wahrscheinlichkeit und nötige Rate bis Ende des Zieljahres. */
function goalCalc() {
  const pos = positions();
  const month = Math.max(1, goalMonth());
  const opts = projOpts(month);
  const r = M.project(pos, { ...opts, probe: { month, threshold: goalAmount() } });
  const median = r.bands.p50[month];
  const need = M.requiredRate(pos, opts, month, goalAmount());
  return { month, r, median, prob: r.bands.prob ?? 0, need, reached: r.total[month] >= goalAmount() };
}

// ------------------------------------------------------------------ Blick
const TONES = { depot: ["gold", "balloon", "Depot heute"], takt: ["sky", "stones", "Sparplan-Takt"], ziel: ["violet", "mountain", "Ziel"], spiel: ["teal", "signpost", "Was wäre wenn"] };
function tile(key, { q, verdict, cls = "", metaphor, facts }) {
  const [tone, icon] = TONES[key];
  return `<div class="blick-tile" role="button" tabindex="0" data-key="${key}" data-tone="${tone}" aria-label="${esc(q)}: ${esc(verdict.replace(/<[^>]+>/g, ""))}. Öffnen">
    <span class="q">${UI.icon(icon)}${esc(q)}</span><span class="more-hint" aria-hidden="true">Fokus ↗</span>
    <span class="verdict ${cls}">${verdict}</span>
    <div class="metaphor">${metaphor}</div>
    <div class="facts">${facts.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join("")}</div>
  </div>`;
}
const context = () => {
  if (!state.settings) return "";
  const q = state.quotes.get(PLAN());
  return `Stand ${dateDe(isoDate(TODAY))}${q?.price ? ` · Kurs ${money(q.price)}${q.stale ? " (gespeichert)" : ""}` : " · ohne Live-Kurs"}`;
};

function pearlsHtml(r, max = 12) {
  const list = r.months.slice(-max);
  return `<div class="pearls" aria-hidden="true">${list.map((m, i) => `<span style="--i:${i}" class="pearl ${m.done ? "done" : m.due ? "missing" : "next"}" title="${MONTHS_LONG[+m.ym.slice(5) - 1]} ${m.ym.slice(0, 4)}: ${m.done ? "Kauf erfasst" : m.due ? "kein Kauf erfasst" : "steht noch aus"}"></span>`).join("")}</div>`;
}

function renderBlick() {
  if (!state.settings) return;
  $("#context").textContent = context();
  const d = depotNow();
  const tiles = [];

  // 1 · Depot heute: Wasserlinie
  const diff = d.value - d.invested;
  const q = state.quotes.get(PLAN());
  const day = q?.prev_close && q.price ? d.shares * (q.price - q.prev_close) : null;
  tiles.push(tile("depot", {
    q: "Depot heute",
    verdict: diff >= 0 ? `${signed(diff, money0)} über Einzahlungen` : `⚠ ${money0(-diff)} unter Einzahlungen`,
    cls: diff < 0 ? "bad" : "",
    metaphor: UI.track({ value: d.value, soll: d.invested, max: Math.max(d.value, d.invested) * 1.1 || 1, bad: diff < 0, sollLabel: "eingezahlt" }) + `<span style="height:14px"></span>`,
    facts: [["Depotwert", UI.amount(d.value)], ["Eingezahlt", money0(d.invested)], ["Heute", day != null ? signed(day) : "–"]],
  }));

  // 2 · Takt: Monatsperlen + Abgleich
  const r = rhythm();
  const rec = reconcile();
  const takBad = r.missing.length > 0 || (rec && !rec.ok);
  tiles.push(tile("takt", {
    q: "Sparplan-Takt",
    verdict: r.missing.length ? `⚠ ${r.missing.length} ${r.missing.length === 1 ? "Rate fehlt" : "Raten fehlen"}`
      : rec && !rec.ok ? `⚠ Abgleich: ${money0(Math.abs(rec.diff))} ${rec.diff > 0 ? "fehlen" : "zu viel"}` : `Im Takt: ${r.done} von ${r.due || r.done} Raten`,
    cls: takBad ? "bad" : "",
    metaphor: pearlsHtml(r) + `<span class="pearls-legend">● erfasst · ○ offen${r.missing.length ? " · ◌ fehlt" : ""}</span>`,
    facts: [["Soll", `${money0(state.settings.plan.rate)} am ${state.settings.plan.day}.${state.settings.plan.active === false ? " · pausiert" : " · bucht automatisch"}`],
      ["Abgleich", rec ? (rec.ok ? "passt zum Kontoauszug" : `≈ ${num(2).format(Math.abs(rec.shares))} Anteile Differenz`) : "kein Kontoauszug erfasst"],
      ["Nächste Rate", dateDe(isoDate(firstPlanDate()))]],
  }));

  // 3 · Ziel: Weg zur Fahne
  const g = goalCalc();
  tiles.push(tile("ziel", {
    q: `Ziel ${goalYear()}`,
    verdict: g.reached ? `${moneyShort(goalAmount())} erreichbar` : `⚠ Ziel verfehlt: ${moneyShort(g.median)}`,
    cls: g.reached ? "" : "bad",
    metaphor: UI.track({ value: g.r.total[g.month], soll: goalAmount(), max: Math.max(g.r.total[g.month], goalAmount()) * 1.1, bad: !g.reached, sollLabel: `Ziel ${moneyShort(goalAmount())}` }) + `<span style="height:14px"></span>`,
    facts: [["Ziel", UI.amount(goalAmount(), moneyShort)], ["Chance", `${Math.round(g.prob * 10)} von 10 Verläufen`],
      [g.reached ? "Mindestrate" : "Nötige Rate", `${money0(g.need)} / Monat`]],
  }));

  // 4 · Was wäre wenn: Stellschrauben
  runProjection();
  const res = state.result.r;
  const s = scen();
  tiles.push(tile("spiel", {
    q: "Was wäre wenn",
    verdict: `${moneyShort(res.total[res.months])} in ${s.years} Jahren`,
    metaphor: `<div class="knobs"><span class="knob">${money0(s.rate)} / Monat</span><span class="knob">${pctFmt.format(s.ret)} % p. a.</span><span class="knob">${s.years} Jahre</span>${state.settings.extras.filter((x) => x.enabled).length ? `<span class="knob">+${state.settings.extras.filter((x) => x.enabled).length} ETF</span>` : ""}</div>`,
    facts: [["Mittlerer Verlauf", UI.amount(res.total[res.months], moneyShort)], ["Eingezahlt", moneyShort(res.invested[res.months])],
      ["Bandbreite", `${moneyShort(res.bands.p10[res.months])} – ${moneyShort(res.bands.p90[res.months])}`]],
  }));
  const firstTiles = !$("#blick").children.length;
  $("#blick").innerHTML = tiles.join("");
  enterTiles(firstTiles);
}

/** Kacheln beim ersten Zeichnen gestaffelt hereinschweben lassen. */
function enterTiles(first) {
  if (!first) return;
  UI.enter($$("#blick .blick-tile"));
  UI.fillTracks($("#blick"));
  UI.countUp($("#blick"), ".verdict, .facts b");
}

// ------------------------------------------------------------------ Fokus-Bausteine
const focusHead = (title, sub, bad, key = zoom.key) => {
  const [, icon, name] = TONES[key] || [];
  return `<div class="focus-head"><div>${icon ? `<div class="tone-chip">${UI.icon(icon)}${name}</div>` : ""}<h1 class="${bad ? "bad" : ""}">${title}</h1><p>${sub}</p></div></div>`;
};
const cmpRow = (k, v, s = "", bad = false) => `<div class="row"><span class="k">${k}</span><span class="v ${bad ? "sig-bad" : ""}">${v}</span>${s ? `<span class="s">${s}</span>` : ""}</div>`;
const depthButton = `<div class="to-depth"><button type="button" class="primary" data-depth>Exakte Zahlen (Tiefe) ↘</button></div>`;
function wireDepth(body, key) {
  $$("[data-depth]", body).forEach((b) => (b.onclick = () => zoom.open(key, 3, b)));
}

// ---------- Depot
async function focusDepot(body) {
  disposeCharts(2);
  const d = depotNow();
  const diff = d.value - d.invested;
  const q = state.quotes.get(PLAN());
  const dayChange = q?.prev_close && q.price ? d.shares * (q.price - q.prev_close) : null;
  body.innerHTML = focusHead(diff >= 0 ? `${signed(diff, money0)} über Einzahlungen` : `⚠ ${money0(-diff)} unter Einzahlungen`,
    `${num(2).format(d.shares)} Anteile ${esc(catalogOf(PLAN())?.name || PLAN())}. Depotwert ${UI.amount(d.value)}, eingezahlt ${money0(d.invested)}.`, diff < 0) +
    `<div class="focus-grid"><section class="focus-card">
        <div class="card-head"><div><h2>Trend</h2><p class="muted" id="history-caption"></p></div>
          <div class="seg small" id="hist-range" role="group" aria-label="Zeitraum">
            <button data-range="depot">Seit Start</button><button data-range="1y">1 Jahr</button><button data-range="5y">5 Jahre</button><button data-range="max">Seit Auflage</button></div></div>
        <div class="chart" id="chart-history" style="height:min(56vh,480px)"></div>
        <div class="legend-inline" id="history-legend"></div></section>
      <aside class="focus-card compare">
        ${cmpRow("Depotwert", money(d.value), UI.equiv(d.value))}
        ${cmpRow("Eingezahlt (Soll)", money(d.invested), "Summe aller Käufe")}
        ${cmpRow(diff >= 0 ? "Gewinn" : "Verlust", `${signed(diff)} · ${signedPct(d.invested ? (diff / d.invested) * 100 : 0)}`, UI.equiv(diff), diff < 0)}
        ${cmpRow("Kurs heute", d.price ? money(d.price) : "–", `Ø Kaufkurs ${money(d.avg)} · ${signedPct(d.avg ? (d.price / d.avg - 1) * 100 : 0)}`)}
        ${dayChange != null ? cmpRow("Seit gestern", signed(dayChange), UI.equiv(dayChange), dayChange < 0 && Math.abs(dayChange) > d.value * 0.02) : ""}
        ${cmpRow("Guthaben", money(d.cash), `Gesamt inkl. Guthaben ${money(d.value + d.cash)}`)}
        ${depthButton}</aside></div>`;
  wireDepth(body, "depot");
  $$("#hist-range button", body).forEach((b) => {
    b.classList.toggle("active", b.dataset.range === state.histRange);
    b.onclick = () => { state.histRange = b.dataset.range; $$("#hist-range button", body).forEach((x) => x.classList.toggle("active", x === b)); renderHistory(body); };
  });
  await renderHistory(body);
}

async function renderHistory(body) {
  const t = UI.theme();
  const el = $("#chart-history", body);
  const c = echarts.getInstanceByDom(el) || mkChart(el, 2);
  const plan = PLAN();
  const cap = $("#history-caption", body);
  const legend = $("#history-legend", body);
  const base = UI.chartBase(t);
  const timeAxis = { type: "time", splitNumber: 6, axisLabel: { color: t.muted, fontSize: 11.5, hideOverlap: true }, axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false }, splitLine: { show: false } };
  if (state.histRange === "depot") {
    const points = await loadHistory(plan, depotRange());
    const hist = M.depotHistory(state.tx, points || [], plan, isoDate(TODAY));
    const buys = hist.filter((h) => h.buy);
    cap.textContent = points ? "Depotwert pro Handelstag gegen die Einzahlungen · Punkte = Käufe" : "Ohne Kursverlauf: Werte zwischen den Käufen mit dem jeweiligen Kaufkurs";
    const below = hist.some((h) => h.value < h.invested);
    c.setOption({
      ...base,
      xAxis: { ...timeAxis, minInterval: 7 * 864e5, axisLabel: { ...timeAxis.axisLabel, formatter: "{dd}.{MM}." } },
      yAxis: { ...UI.valueAxis(t), scale: true },
      tooltip: { ...base.tooltip, formatter: (ps) => {
        const h = hist[ps[0].dataIndex];
        if (!h) return "";
        return `<b>${dateDe(h.date)}</b>${h.buy ? " · Kauf" : ""}` + UI.tipRow(UI.mark(h.value < h.invested ? t.bad : t.gold), "Depotwert", money(h.value)) +
          UI.tipRow(UI.mark(t.ink2, true), "Eingezahlt", money(h.invested)) + UI.tipRow("", "Kurs", money(h.price)) + `<div style="color:${t.muted}">${UI.equiv(h.value)}</div>`;
      } },
      // Linie ist grau; nur Abschnitte unter der Einzahlungslinie werden farbig (visualMap auf die Differenz)
      series: [
        { name: "Eingezahlt", type: "line", step: "end", data: hist.map((h) => [h.date, h.invested]), showSymbol: false, lineStyle: { width: 1.5, type: "dashed", color: t.ink2 }, itemStyle: { color: t.ink2 } },
        { name: "Depotwert", type: "line", data: hist.map((h) => [h.date, h.value]), showSymbol: false, lineStyle: { width: 3, color: t.gold }, itemStyle: { color: t.gold }, areaStyle: { color: UI.areaFill(t.gold, 0.4) } },
        { name: "Unter Einzahlung", type: "scatter", data: hist.filter((h) => h.value < h.invested).map((h) => [h.date, h.value]), symbolSize: 4, itemStyle: { color: t.bad }, tooltip: { show: false } },
        { name: "Käufe", type: "scatter", data: buys.map((h) => [h.date, h.value]), symbolSize: 9, z: 5, tooltip: { show: false }, itemStyle: { color: t.gold, borderColor: t.surface, borderWidth: 2 } },
      ],
    }, true);
    legend.innerHTML = `<span><i class="line"></i>Depotwert</span><span><i class="dash"></i>Eingezahlt (Soll)</span>${below ? `<span><i class="bad"></i>unter Einzahlungen</span>` : ""}`;
    return;
  }
  const points = await loadHistory(plan, state.histRange, state.histRange === "1y" ? "1d" : "1wk");
  const avg = M.holding(state.tx, plan).avg;
  if (!points) { c.clear(); cap.textContent = "Kursverlauf gerade nicht abrufbar."; legend.innerHTML = ""; return; }
  const change = (points[points.length - 1][1] / points[0][1] - 1) * 100;
  cap.textContent = `Kurs ${catalogOf(plan)?.short || plan} · ${signedPct(change)} im Zeitraum · gestrichelt: dein Ø Kaufkurs`;
  c.setOption({
    ...base,
    xAxis: timeAxis,
    yAxis: { ...UI.valueAxis(t, (v) => money0(v)), scale: true },
    tooltip: { ...base.tooltip, formatter: (ps) => `<b>${dateDe(ps[0].value[0])}</b>` + UI.tipRow(UI.mark(t.gold), "Kurs", money(ps[0].value[1])) + (avg ? UI.tipRow(UI.mark(t.ink2, true), "Ø Kaufkurs", money(avg)) : "") },
    series: [{
      name: "Kurs", type: "line", data: points, showSymbol: false, lineStyle: { width: 2.5, color: t.gold }, itemStyle: { color: t.gold }, areaStyle: { color: UI.areaFill(t.gold, 0.35) },
      markLine: avg ? { symbol: "none", silent: true, data: [{ yAxis: avg }], lineStyle: { color: t.ink2, type: "dashed", width: 1.5 },
        label: { formatter: `Ø ${money(avg)}`, color: t.text2, position: "insideEndTop", fontSize: 11 } } : undefined,
    }],
  }, true);
  legend.innerHTML = `<span><i class="line"></i>Kurs</span><span><i class="dash"></i>Ø Kaufkurs (Vergleich)</span>`;
}

// ---------- Takt
function focusTakt(body) {
  disposeCharts(2);
  const t = UI.theme();
  const r = rhythm();
  const rec = reconcile();
  const bad = r.missing.length > 0 || (rec && !rec.ok);
  const rate = state.settings.plan.rate;
  body.innerHTML = focusHead(
    r.missing.length ? `⚠ ${r.missing.length} ${r.missing.length === 1 ? "Rate fehlt" : "Raten fehlen"}` : rec && !rec.ok ? `⚠ Abgleich passt nicht: ${money0(Math.abs(rec.diff))} Differenz` : "Sparplan im Takt",
    `Soll: ${money0(rate)} am ${state.settings.plan.day}. jedes Monats in ${esc(catalogOf(PLAN())?.short || PLAN())}. ${r.done} von ${r.due || r.done} fälligen Raten erfasst.`, bad) +
    `<div class="focus-grid"><div style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <section class="focus-card"><h2>Trend: Einzahlungen pro Monat</h2><p>Balken = erfasste Käufe, gestrichelt die Soll-Rate. Farbig: fällige Monate ohne Kauf.</p>
        <div class="chart" id="f-rhythm" style="height:min(40vh,340px)"></div></section>
      <section class="focus-card"><h2>Monatsperlen</h2><p>Eine Perle pro Monat seit dem ersten Kauf</p>${pearlsHtml(r, 60)}</section>
    </div><aside class="focus-card compare">
      ${cmpRow("Raten erfasst", `${r.done} von ${r.due || r.done}`, r.missing.length ? `fehlt: ${r.missing.map((m) => `${MONTHS[+m.ym.slice(5) - 1]} ${m.ym.slice(0, 4)}`).join(", ")}` : "alle fälligen Monate haben einen Kauf", r.missing.length > 0)}
      ${rec ? cmpRow("Kontoauszug " + dateDe(rec.date), money(rec.reported), `berechnet aus Käufen: ${money(rec.calc)}`) : cmpRow("Kontoauszug", "–", "in der Tiefe eintragen für den Abgleich")}
      ${rec ? cmpRow("Differenz", signed(rec.diff), rec.ok ? "passt (unter 2 %)" : `≈ ${num(2).format(Math.abs(rec.shares))} Anteile · ${UI.equiv(rec.diff)} – fehlt ein Kauf?`, !rec.ok) : ""}
      ${cmpRow("Nächste Rate", dateDe(isoDate(firstPlanDate())), `${money0(rate)} · ${UI.equiv(rate)}`)}
      ${depthButton}</aside></div>`;
  wireDepth(body, "takt");
  const labels = r.months.map((m) => `${MONTHS[+m.ym.slice(5) - 1]} ${m.ym.slice(2, 4)}`);
  const chart = mkChart($("#f-rhythm", body), 2);
  chart.setOption({
    ...UI.chartBase(t),
    xAxis: { type: "category", data: labels, axisLabel: { color: t.muted, fontSize: 11.5 }, axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false } },
    yAxis: UI.valueAxis(t),
    tooltip: { ...UI.chartBase(t).tooltip, axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.4 } }, formatter: (ps) => {
      const i = ps[0].dataIndex, m = r.months[i];
      return `<b>${MONTHS_LONG[+m.ym.slice(5) - 1]} ${m.ym.slice(0, 4)}</b>` + UI.tipRow(UI.mark(t.sky), "Eingezahlt", money(r.invested[i])) +
        UI.tipRow(UI.mark(t.ink1, true), "Soll", money(rate)) + `<div style="color:${t.muted}">${m.done ? "Kauf erfasst" : m.due ? "kein Kauf erfasst" : "noch nicht fällig"}</div>`;
    } },
    series: [{ type: "bar", ...UI.barAnim(), barMaxWidth: 34,
      // fehlende Monate als flache farbige Markierung, damit sie sichtbar sind
      data: r.months.map((m, i) => ({ value: m.due && !m.done ? rate * 0.06 : r.invested[i],
        itemStyle: { borderRadius: [4, 4, 0, 0], color: m.due && !m.done ? t.bad : m.done ? UI.barFill(t.sky) : UI.alpha(t.sky, 0.25) } })),
      markLine: { symbol: "none", silent: true, data: [{ yAxis: rate }], lineStyle: { color: t.ink1, type: "dashed", width: 1.5 },
        label: { formatter: `Soll ${money0(rate)}`, color: t.text, position: "insideEndTop", fontSize: 11.5 } } }],
  });
}

// ---------- Tiefe: Käufe & Abgleich (für Depot und Takt)
function depthLedger(body) {
  disposeCharts(3);
  body.innerHTML = focusHead("Käufe & Abgleich – exakte Zahlen", "Alle erfassten Käufe mit Kaufkurs und heutigem Wert. Rechts Guthaben und Kontoauszug für den Abgleich.") +
    $("#tpl-ledger").innerHTML;
  renderLedger(body);
  wireLedger(body);
}

function renderLedger(root) {
  const rows = [...state.tx].sort((a, b) => b.date.localeCompare(a.date));
  $("#depot-tx", root).innerHTML = rows.map((t) => {
    const price = t.amount / 100 / t.shares;
    const now = priceOf(t.symbol);
    const today = now ? t.shares * now : null;
    const diff = today !== null ? today - t.amount / 100 : null;
    return `<tr data-id="${t.id}"><td>${dateDe(t.date)}</td>
      <td>${esc(catalogOf(t.symbol)?.short || t.symbol)}${t.note ? ` <small class="equiv">${esc(t.note)}</small>` : ""}${t.estimated ? ` <span class="est-tag" title="Stückzahl geschätzt – mit der Abrechnung vergleichen und per Klick bestätigen">geschätzt</span>` : ""}</td>
      <td class="num">${num(t.shares % 1 ? 2 : 0).format(t.shares)}</td><td class="num">${money(t.amount / 100)}</td><td class="num">${money(price)}</td>
      <td class="num">${today !== null ? `${money(today)} <small class="${diff < 0 ? "sig-bad" : "equiv"}">${signed(diff)}</small>` : "–"}</td>
      <td class="num equiv">${UI.equiv(t.amount / 100)}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">Noch keine Käufe erfasst.</td></tr>`;
  const f = $("#account-form", root);
  const plan = state.settings.plan;
  f.plan_rate.value = plan.rate;
  f.plan_day.value = plan.day;
  f.plan_active.checked = plan.active !== false;
  f.cash.value = ((state.settings.cash || 0) / 100).toFixed(2);
  f.snap_date.value = state.settings.snapshot?.date || "";
  f.snap_portfolio.value = state.settings.snapshot?.portfolio ? (state.settings.snapshot.portfolio / 100).toFixed(2) : "";
  const rec = reconcile();
  $("#reconcile", root).innerHTML = rec ? `<table>
      <tr><td>Depotwert laut Kontoauszug (${dateDe(rec.date)})</td><td>${money(rec.reported)}</td></tr>
      <tr><td>Aus den erfassten Käufen berechnet</td><td>${money(rec.calc)}</td></tr>
      <tr><td>Differenz</td><td class="${rec.ok ? "" : "sig-bad"}">${signed(rec.diff)}${rec.ok ? "" : ` · ≈ ${num(2).format(rec.shares)} Stück`}</td></tr></table>
    <p class="${rec.ok ? "muted" : "sig-bad"}">${rec.ok ? "Passt – die erfassten Käufe erklären den Depotwert." : "⚠ Die erfassten Käufe erklären den Depotwert nicht. Vermutlich fehlt ein Kauf oder eine Stückzahl ist gerundet."}</p>` : "";
}

function wireLedger(root) {
  $("#tx-add", root).onclick = (e) => openTxDialog(null, e.currentTarget);
  $("#depot-tx", root).onclick = (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openTxDialog(state.tx.find((t) => t.id === +tr.dataset.id));
  };
  $("#account-form", root).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const cents = (v) => (v === "" ? null : Math.round(parseFloat(v) * 100));
    state.settings.cash = cents(f.cash.value) || 0;
    const portfolio = cents(f.snap_portfolio.value);
    state.settings.snapshot = { date: f.snap_date.value, portfolio, total: portfolio !== null ? portfolio + state.settings.cash : null };
    state.settings.plan = { ...state.settings.plan, rate: +f.plan_rate.value || 0, day: Math.min(28, Math.max(1, +f.plan_day.value || 25)), active: f.plan_active.checked };
    try {
      await api("PUT", "/api/depot/settings", { cash: state.settings.cash, snapshot: state.settings.snapshot, plan: state.settings.plan });
      renderLedger(root);
      renderBlick();
      toast("Gespeichert");
    } catch (err) { toast(err.message, { error: true }); }
  };
}

let editingTx = null;
function openTxDialog(tx) {
  editingTx = tx;
  const f = $("#tx-form");
  $("#tx-dialog-title").textContent = tx ? "Kauf bearbeiten" : "Kauf erfassen";
  const lastPlan = [...state.tx].reverse().find((t) => t.symbol === PLAN());
  f.date.value = tx?.date || isoDate(TODAY);
  f.symbol.value = tx?.symbol || PLAN();
  f.shares.value = tx?.shares ?? "";
  f.amount.value = tx ? (tx.amount / 100).toFixed(2) : (lastPlan ? (lastPlan.amount / 100).toFixed(2) : "");
  f.note.value = tx?.note ?? "Sparplan";
  $("#tx-delete").hidden = !tx;
  $("#tx-error").textContent = "";
  $("#symbol-list").innerHTML = state.catalog.map((c) => `<option value="${esc(c.symbol)}">${esc(c.short)}</option>`).join("");
  $("#tx-dialog").showModal();
}

// ---------- Ziel
function focusZiel(body) {
  disposeCharts(2);
  const t = UI.theme();
  const g = goalCalc();
  const goal = goalAmount();
  const r = g.r;
  const s = scen();
  body.innerHTML = focusHead(g.reached ? `Ziel ${moneyShort(goal)} bis ${goalYear()} erreichbar` : `⚠ Ziel ${moneyShort(goal)} bis ${goalYear()} verfehlt`,
    `Mit ${money0(s.rate)} im Monat und ${pctFmt.format(s.ret)} % p. a. erreicht der mittlere Verlauf ${UI.amount(r.total[g.month], moneyShort)}. ${g.reached ? "" : `Nötig wären ${money0(g.need)} im Monat.`}`, !g.reached) +
    `<div class="focus-grid"><div style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <section class="focus-card"><h2>Trend: Weg zum Ziel</h2><p>Mittlerer Verlauf und Bandbreite aus 600 simulierten Börsenverläufen; waagerecht das Ziel (Soll)</p>
        <div class="chart" id="f-goal" style="height:min(50vh,440px)"></div>
        <div class="legend-inline"><span><i class="line" style="background:${t.violet}"></i>Mittlerer Verlauf</span><span><i style="background:${UI.alpha(t.violet, 0.35)}"></i>5 von 10 Verläufen</span><span><i style="background:${UI.alpha(t.violet, 0.15)}"></i>8 von 10</span><span><i class="dash"></i>Eingezahlt</span><span><i class="line" style="background:${g.reached ? t.good : t.bad}"></i>Ziel</span></div></section>
      <section class="focus-card"><h2>Meilensteine</h2><p>Wann der mittlere Verlauf welche Summe erreicht, in Klammern die Bandbreite</p><ol class="milestones" id="milestones"></ol></section>
    </div><aside class="focus-card compare">
      ${cmpRow("Ziel (Soll)", moneyShort(goal), UI.equiv(goal))}
      ${cmpRow("Mittlerer Verlauf " + goalYear(), moneyShort(r.total[g.month]), `${g.reached ? "+" : "−"}${moneyShort(Math.abs(r.total[g.month] - goal))} gegenüber dem Ziel`, !g.reached)}
      ${cmpRow("Chance", `${Math.round(g.prob * 100)} %`, `in ${Math.round(g.prob * 10)} von 10 Verläufen erreicht`)}
      ${cmpRow(g.reached ? "Mindestrate fürs Ziel" : "Nötige Rate", `${money0(g.need)} / Monat`, `heute ${money0(s.rate)} · ${signed(g.need - s.rate, money0)}`, !g.reached)}
      ${cmpRow("Monatliche Entnahme danach", money0((r.total[g.month] * 0.04) / 12), `4-%-Regel · ${UI.basis().fixed ? `deckt ${Math.round(((r.total[g.month] * 0.04) / 12 / UI.basis().fixed) * 100)} % deiner heutigen Fixkosten` : ""}`)}
      <form class="goal-form" id="goal-form">
        <label>Zielbetrag in € <input name="goal" type="number" min="1000" step="1000" value="${goal}"></label>
        <label>Zieljahr <input name="year" type="number" min="${TODAY.getFullYear() + 1}" max="${TODAY.getFullYear() + 60}" value="${goalYear()}"></label>
        <button class="primary">Ziel setzen</button>
      </form>
      ${depthButton}</aside></div>`;
  wireDepth(body, "ziel");
  $("#goal-form", body).onsubmit = async (e) => {
    e.preventDefault();
    state.settings.targets = { ...targets(), goal: Math.round(+e.target.goal.value * 100), goal_year: +e.target.year.value };
    await api("PUT", "/api/depot/settings", { targets: state.settings.targets });
    renderBlick();
    zoom.refresh();
  };
  const b = r.bands;
  const labels = Array.from({ length: g.month + 1 }, (_, m) => m);
  const diff = (hi, lo) => hi.map((v, i) => v - lo[i]);
  const goalColor = g.reached ? t.good : t.bad;
  const chart = mkChart($("#f-goal", body), 2);
  const base = UI.chartBase(t);
  chart.setOption({
    ...base,
    xAxis: { type: "category", data: labels, boundaryGap: false, axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11.5, interval: (i) => i > 0 && monthDate(i).getMonth() === 0 && monthDate(i).getFullYear() % (g.month > 240 ? 5 : g.month > 96 ? 2 : 1) === 0, formatter: (m) => String(monthDate(+m).getFullYear()) } },
    yAxis: UI.valueAxis(t),
    tooltip: { ...base.tooltip, formatter: (ps) => {
      const m = ps[0].dataIndex;
      return `<b>${monthLabel(m)}</b>` + UI.tipRow(UI.mark(t.violet), "Mittlerer Verlauf", money0(r.total[m])) +
        UI.tipRow(UI.mark(UI.alpha(t.violet, 0.35)), "5 von 10", `${moneyShort(b.p25[m])} – ${moneyShort(b.p75[m])}`) + UI.tipRow(UI.mark(UI.alpha(t.violet, 0.15)), "8 von 10", `${moneyShort(b.p10[m])} – ${moneyShort(b.p90[m])}`) +
        UI.tipRow(UI.mark(t.ink2, true), "Eingezahlt", money0(r.invested[m])) + `<div style="color:${t.muted}">${UI.equiv(r.total[m])}</div>`;
    } },
    series: [
      { type: "line", data: b.p10, stack: "o", showSymbol: false, lineStyle: { opacity: 0 }, silent: true },
      { type: "line", data: diff(b.p90, b.p10), stack: "o", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: UI.alpha(t.violet, 0.13) }, silent: true },
      { type: "line", data: b.p25, stack: "i", showSymbol: false, lineStyle: { opacity: 0 }, silent: true },
      { type: "line", data: diff(b.p75, b.p25), stack: "i", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: UI.alpha(t.violet, 0.22) }, silent: true },
      { type: "line", data: r.invested, showSymbol: false, lineStyle: { width: 1.5, type: "dashed", color: t.ink2 } },
      { type: "line", data: r.total, showSymbol: false, z: 5, lineStyle: { width: 3, color: t.violet },
        endLabel: { show: true, formatter: (p) => moneyShort(p.value), color: t.text, fontWeight: 600 },
        markLine: { symbol: "none", silent: true, data: [{ yAxis: goal }], lineStyle: { color: goalColor, width: 2, type: "solid" },
          label: { formatter: `${g.reached ? "✓ " : "⚠ "}Ziel ${moneyShort(goal)}`, color: goalColor, position: "insideStartTop", fontWeight: 600 } } },
    ],
    grid: { ...base.grid, right: 96 },
  });
  renderMilestones($("#milestones", body), r);
}

function renderMilestones(el, r) {
  const now = r.total[0];
  const goals = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2000000].filter((x) => x > now);
  const shown = goals.filter((x) => M.reachMonth(r.bands.p90, x) !== null).slice(0, 6);
  if (goals[shown.length]) shown.push(goals[shown.length]);
  el.innerHTML = shown.map((x) => {
    const mid = M.reachMonth(r.bands.p50, x), early = M.reachMonth(r.bands.p90, x), late = M.reachMonth(r.bands.p10, x);
    if (early === null) return `<li class="never" style="--i:${shown.indexOf(x)}"><div class="goal">${moneyShort(x)}</div><div class="when">nicht bis ${monthDate(r.months).getFullYear()}</div><span class="range">${UI.equiv(x)}</span></li>`;
    return `<li style="--i:${shown.indexOf(x)}"><div class="goal">${moneyShort(x)}</div><div class="when">${mid !== null ? `${MONTHS[monthDate(mid).getMonth()]} ${monthDate(mid).getFullYear()} · in ${durationText(mid)}` : "nur in guten Verläufen"}</div>
      <span class="range">(${monthDate(early).getFullYear()} – ${late !== null ? monthDate(late).getFullYear() : "später"}) · ${UI.equiv(x)}</span></li>`;
  }).join("");
}

function depthZiel(body) {
  disposeCharts(3);
  const g = goalCalc();
  const r = g.r;
  const goal = goalAmount();
  const rows = [];
  for (let m = 0; m <= g.month; m += 12) {
    const i = Math.min(m, g.month);
    rows.push(`<tr><td>${m === 0 ? "heute" : monthDate(i).getFullYear()}</td><td class="num">${money0(r.invested[i])}</td><td class="num">${money0(r.bands.p10[i])}</td>
      <td class="num"><b>${money0(r.total[i])}</b></td><td class="num">${money0(r.bands.p90[i])}</td><td class="num">${Math.round((r.total[i] / goal) * 100)} %</td><td class="num equiv">${UI.equiv(r.total[i])}</td></tr>`);
  }
  if (g.month % 12) rows.push(`<tr class="sum"><td>Ende ${goalYear()}</td><td class="num">${money0(r.invested[g.month])}</td><td class="num">${money0(r.bands.p10[g.month])}</td><td class="num">${money0(r.total[g.month])}</td><td class="num">${money0(r.bands.p90[g.month])}</td><td class="num">${Math.round((r.total[g.month] / goal) * 100)} %</td><td class="num equiv">${UI.equiv(r.total[g.month])}</td></tr>`);
  body.innerHTML = focusHead("Ziel – exakte Zahlen", `Jahreswerte bis ${goalYear()} · Ziel ${money0(goal)} · Annahmen aus „Was wäre wenn“.`) +
    `<section class="focus-card scroll-x"><table class="depth-table"><thead><tr><th>Jahr</th><th class="num">Eingezahlt</th><th class="num">Schwach (1 von 10)</th><th class="num">Mittlerer Verlauf</th><th class="num">Stark (1 von 10)</th><th class="num">vom Ziel</th><th class="num">Alltagsäquivalent</th></tr></thead><tbody>${rows.join("")}</tbody></table></section>`;
}

// ---------- Was wäre wenn (Spielwiese)
function focusSpiel(body) {
  disposeCharts(2);
  body.innerHTML = focusHead("Was wäre wenn", "Dreh an den Reglern – die Projektion rechnet sofort mit 600 simulierten Börsenverläufen. Die Annahmen gelten auch für Ziel und Blick.") + $("#tpl-play").innerHTML;
  wirePlay(body);
  syncControls();
  renderEtfs();
  update({ save: false });
}

const CONTROLS = {
  rate: { fmt: (v) => `${money0(v)} / Monat` },
  years: { fmt: (v) => `${v} Jahre · bis ${TODAY.getFullYear() + +v}` },
  dynamic: { fmt: (v) => (+v ? `${pctFmt.format(v)} %` : "keine") },
  ret: { fmt: (v) => `${pctFmt.format(v)} %` },
  vol: { fmt: (v) => `${pctFmt.format(v)} %` },
  ter: { fmt: (v) => `${pctFmt.format(v)} %` },
  inflation: { fmt: (v) => `${pctFmt.format(v)} %` },
};
const fillRange = (input) => input.style.setProperty("--fill", `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
const playRoot = () => (zoom.key === "spiel" ? zoom.body(2) : null);

function syncControls() {
  const root = playRoot();
  if (!root) return;
  const s = scen();
  for (const [key, c] of Object.entries(CONTROLS)) {
    const input = $(`#in-${key}`, root);
    input.value = s[key];
    $(`#out-${key}`, root).textContent = c.fmt(s[key]);
    fillRange(input);
  }
  $("#in-real", root).checked = !!s.real;
  $("#in-tax", root).checked = !!s.tax;
  $$("#scenario-presets button", root).forEach((b) => b.classList.toggle("active", Math.abs(+b.dataset.ret - s.ret) < 0.01));
  const st = state.stats.get(PLAN());
  $("#hint-ret", root).innerHTML = st
    ? `Historisch ${pctFmt.format(st.cagr)} % p. a. seit ${st.from.slice(0, 4)} (${pctFmt.format(st.years)} Jahre). Über Jahrzehnte lagen Welt-Aktien bei etwa 7 %.`
    : "Welt-Aktien brachten über Jahrzehnte im Schnitt etwa 7 % p. a. – mit großen Schwankungen.";
  renderLumps();
}

function renderLumps() {
  const root = playRoot();
  if (!root) return;
  const lumps = scen().lumps || [];
  $("#lumps-count", root).textContent = lumps.length ? `(${lumps.length})` : "";
  $("#lumps", root).innerHTML = lumps.map((l, i) => `<div class="lump" data-i="${i}">
      <input type="month" value="${esc(l.date)}" data-f="date" aria-label="Monat">
      <input type="number" value="${esc(l.amount)}" min="0" step="100" data-f="amount" aria-label="Betrag in €">
      <button class="ghost" type="button" data-del="${i}" aria-label="Entfernen">✕</button></div>`).join("") +
    (lumps.length ? "" : `<p class="hint" style="margin:0;font-size:12px;color:var(--text-muted)">Z. B. Weihnachtsgeld oder Bonus – fließt in den FTSE All-World.</p>`);
}

let saveTimer;
function saveSettings(keys = ["scenario", "extras"]) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api("PUT", "/api/depot/settings", Object.fromEntries(keys.map((k) => [k, state.settings[k]])));
    } catch (e) { toast(`Speichern fehlgeschlagen: ${e.message}`, { error: true }); }
  }, 600);
}

let frame, blickTimer;
function update({ save = true } = {}) {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    runProjection();
    if (playRoot()) {
      renderOutcome();
      renderProjection();
      renderScenarios();
      renderEtfFooters();
    }
    // Der Blick liegt verdeckt unter dem Fokus: erst nach dem Ziehen neu rechnen
    clearTimeout(blickTimer);
    blickTimer = setTimeout(renderBlick, zoom.level > 1 ? 400 : 0);
  });
  if (save) saveSettings();
}

function renderOutcome() {
  const root = playRoot();
  const { r } = state.result;
  const s = scen();
  const end = r.months;
  const invested = r.invested[end];
  const tax = s.tax ? M.taxOnSale(r.total[end], invested) : 0;
  const value = r.total[end] - tax;
  const gain = value - invested;
  const endDate = monthDate(end);
  const el = $("#outcome", root);
  if (!el.children.length) {
    el.innerHTML = `
      <div class="tile main"><div class="label" data-k="l0"></div><div class="value" data-k="v0"></div><div class="sub" data-k="s0"></div></div>
      <div class="tile"><div class="label">Selbst eingezahlt</div><div class="value" data-k="v1"></div><div class="sub" data-k="s1"></div></div>
      <div class="tile"><div class="label">Davon Zinseszins</div><div class="value" data-k="v2"></div><div class="sub" data-k="s2"></div><div class="split-bar" data-k="bar"></div></div>
      <div class="tile"><div class="label">Monatliche Entnahme</div><div class="value" data-k="v3"></div><div class="sub" data-k="s3"></div></div>`;
  }
  const k = (n) => $(`[data-k="${n}"]`, el);
  const kk = s.real ? " · in heutiger Kaufkraft" : "";
  k("l0").textContent = `Depot ${MONTHS_LONG[endDate.getMonth()]} ${endDate.getFullYear()}${s.tax ? " nach Steuern" : ""}`;
  UI.animateNumber(k("v0"), value, money0);
  k("s0").textContent = `${UI.equiv(value)} · 8 von 10 Verläufen: ${moneyShort(r.bands.p10[end])} – ${moneyShort(r.bands.p90[end])}${kk}`;
  UI.animateNumber(k("v1"), invested, money0);
  k("s1").textContent = `${s.years} Jahre · ${money0(s.rate + state.result.pos.slice(1).reduce((a, p) => a + p.rate, 0))} pro Monat zu Beginn`;
  UI.animateNumber(k("v2"), Math.max(0, gain), money0);
  k("s2").textContent = invested > 0 ? `${pctFmt.format(Math.round((value / invested) * 10) / 10)}-fache deiner Einzahlungen` : "";
  const share = value > 0 ? Math.max(0, Math.min(1, invested / value)) : 1;
  const t = UI.theme();
  k("bar").innerHTML = `<span style="width:${share * 100}%;background:${t.ink3}"></span><span style="width:${(1 - share) * 100}%;background:${t.teal}"></span>`;
  const withdraw = (value * 0.04) / 12;
  UI.animateNumber(k("v3"), withdraw, money0);
  const fixed = UI.basis().fixed;
  k("s3").textContent = `4-%-Regel${fixed ? ` · deckt ${Math.round((withdraw / fixed) * 100)} % der heutigen Fixkosten` : ""}`;
}

function renderProjection() {
  const root = playRoot();
  const { r, pos } = state.result;
  const s = scen();
  const t = UI.theme();
  const el = $("#chart-projection", root);
  const c = echarts.getInstanceByDom(el) || mkChart(el, 2);
  const labels = Array.from({ length: r.months + 1 }, (_, m) => m);
  const kk = s.real ? " · in heutiger Kaufkraft" : "";
  const base = UI.chartBase(t);
  const xAxis = {
    type: "category", data: labels, boundaryGap: false,
    axisLabel: { color: t.muted, fontSize: 11.5, interval: (i) => i > 0 && monthDate(i).getMonth() === firstPlanDate().getMonth() && ((i / 12) % (s.years > 20 ? 5 : s.years > 8 ? 2 : 1) === 0),
      formatter: (m) => String(monthDate(+m).getFullYear()) },
    axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false },
  };
  const goal = goalAmount();
  const goalInRange = goalMonth() <= r.months;
  const goalLine = goalInRange ? { symbol: "none", silent: true, data: [{ yAxis: goal }], lineStyle: { color: t.ink2, width: 1, type: "dotted" },
    label: { formatter: `Ziel ${moneyShort(goal)}`, color: t.text2, position: "insideStartTop", fontSize: 11 } } : undefined;
  const invested = { name: "Eingezahlt", type: "line", data: r.invested, showSymbol: false, z: 4, lineStyle: { width: 1.5, type: "dashed", color: t.ink2 }, itemStyle: { color: t.ink2 } };
  const legend = $("#proj-legend", root);
  if (state.projView === "fan") {
    $("#proj-sub", root).textContent = `Mittlerer Verlauf bei ${pctFmt.format(s.ret)} % p. a. und Bandbreite aus 600 Simulationen${kk}`;
    const b = r.bands;
    const diff = (hi, lo) => hi.map((v, i) => v - lo[i]);
    c.setOption({
      ...base, xAxis, yAxis: UI.valueAxis(t),
      tooltip: { ...base.tooltip, formatter: (ps) => {
        const m = ps[0].dataIndex;
        return `<b>${monthLabel(m)}</b>${m ? ` <span style="color:${t.muted}">· in ${durationText(m)}</span>` : ""}` +
          UI.tipRow(UI.mark(t.teal), "Mittlerer Verlauf", money0(r.total[m])) + UI.tipRow(UI.mark(UI.alpha(t.teal, 0.35)), "5 von 10 Verläufen", `${moneyShort(b.p25[m])} – ${moneyShort(b.p75[m])}`) +
          UI.tipRow(UI.mark(UI.alpha(t.teal, 0.15)), "8 von 10 Verläufen", `${moneyShort(b.p10[m])} – ${moneyShort(b.p90[m])}`) + UI.tipRow(UI.mark(t.ink2, true), "Eingezahlt", money0(r.invested[m])) +
          `<div style="color:${t.muted}">${UI.equiv(r.total[m])}</div>`;
      } },
      series: [
        { type: "line", data: b.p10, stack: "outer", showSymbol: false, lineStyle: { opacity: 0 }, silent: true },
        { type: "line", data: diff(b.p90, b.p10), stack: "outer", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: UI.alpha(t.teal, 0.13) }, silent: true },
        { type: "line", data: b.p25, stack: "inner", showSymbol: false, lineStyle: { opacity: 0 }, silent: true },
        { type: "line", data: diff(b.p75, b.p25), stack: "inner", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: UI.alpha(t.teal, 0.24) }, silent: true },
        invested,
        { name: "Mittlerer Verlauf", type: "line", data: r.total, showSymbol: false, z: 5, lineStyle: { width: 3, color: t.teal }, itemStyle: { color: t.teal },
          endLabel: { show: true, formatter: (p) => moneyShort(p.value), color: t.text, fontWeight: 600, fontSize: 12, distance: 6 }, markLine: goalLine },
      ],
      grid: { ...base.grid, right: 84 },
    }, true);
    legend.innerHTML = `<span><i class="line" style="background:${t.teal}"></i>Mittlerer Verlauf</span><span><i style="background:${UI.alpha(t.teal, 0.35)}"></i>5 von 10 Verläufen</span><span><i style="background:${UI.alpha(t.teal, 0.15)}"></i>8 von 10 Verläufen</span><span><i class="dash"></i>Eingezahlt</span>`;
  } else if (state.projView === "split") {
    $("#proj-sub", root).textContent = `Was du einzahlst und was der Zinseszins daraus macht${kk}`;
    const gain = r.total.map((v, i) => Math.max(0, v - r.invested[i]));
    c.setOption({
      ...base, xAxis, yAxis: UI.valueAxis(t),
      tooltip: { ...base.tooltip, formatter: (ps) => {
        const m = ps[0].dataIndex;
        return `<b>${monthLabel(m)}</b>` + UI.tipRow(UI.mark(t.teal), "Erträge", `${money0(gain[m])} · ${Math.round(r.total[m] ? (gain[m] / r.total[m]) * 100 : 0)} %`) +
          UI.tipRow(UI.mark(t.ink3), "Eingezahlt", money0(r.invested[m])) + UI.tipRow("", "Summe", money0(r.total[m]));
      } },
      series: [
        { name: "Eingezahlt", type: "line", stack: "s", data: r.invested, showSymbol: false, lineStyle: { width: 2, color: t.surface }, areaStyle: { color: t.ink3, opacity: 0.8 },
          endLabel: { show: true, formatter: "eingezahlt", color: t.text2, fontSize: 11.5 } },
        { name: "Erträge", type: "line", stack: "s", data: gain, showSymbol: false, lineStyle: { width: 2, color: t.surface }, areaStyle: { color: t.teal, opacity: 0.85 },
          endLabel: { show: true, formatter: () => moneyShort(r.total[r.months]), color: t.text, fontWeight: 600, fontSize: 12, distance: 6 } },
      ],
      grid: { ...base.grid, right: 84 },
    }, true);
    const cross = r.total.findIndex((v, i) => i > 0 && v - r.invested[i] > r.invested[i]);
    legend.innerHTML = `<span><i style="background:${t.ink3}"></i>Eingezahlt</span><span><i style="background:${t.teal}"></i>Erträge (Zinseszins)</span>` +
      (cross > 0 ? `<span>Ab ${monthLabel(cross)} arbeitet dein Geld mehr als du einzahlst.</span>` : "");
  } else {
    $("#proj-sub", root).textContent = `Beitrag jedes ETFs zum mittleren Verlauf${kk}`;
    const shades = pos.map((p) => shade(p.slot));
    c.setOption({
      ...base, xAxis, yAxis: UI.valueAxis(t),
      tooltip: { ...base.tooltip, formatter: (ps) => {
        const m = ps[0].dataIndex;
        return `<b>${monthLabel(m)}</b>` + [...pos].reverse().map((p) => UI.tipRow(UI.mark(shades[pos.indexOf(p)]), p.name, money0(r.perPos[pos.indexOf(p)][m]))).join("") + UI.tipRow("", "Summe", money0(r.total[m]));
      } },
      series: [
        ...pos.map((p, i) => ({ name: p.name, type: "line", stack: "e", data: r.perPos[i], showSymbol: false,
          lineStyle: { width: 2, color: t.surface }, areaStyle: { color: shades[i], opacity: 0.85 },
          // direkte Beschriftung statt Farblegende
          endLabel: { show: true, formatter: `${p.name}`, color: t.text2, fontSize: 11.5 } })),
        invested,
      ],
      grid: { ...base.grid, right: 140 },
    }, true);
    legend.innerHTML = pos.map((p, i) => `<span><i style="background:${shades[i]}"></i>${esc(p.name)}</span>`).join("") + `<span><i class="dash"></i>Eingezahlt</span>` +
      (pos.length === 1 ? `<span>Füge unten im ETF-Baukasten weitere ETFs hinzu.</span>` : "");
  }
}

function renderScenarios() {
  const root = playRoot();
  const { scenarios } = state.result;
  const s = scen();
  const t = UI.theme();
  const max = Math.max(...scenarios.map((x) => Math.max(...x.r.total)));
  $("#scenarios", root).innerHTML = scenarios.map((x) => {
    const endRaw = x.r.total[x.r.months];
    const end = endRaw - (s.tax ? M.taxOnSale(endRaw, x.r.invested[x.r.months]) : 0);
    const inv = x.r.invested[x.r.months];
    return `<button type="button" class="scenario ${Math.abs(s.ret - x.ret) < 0.01 ? "active" : ""}" data-ret="${x.ret}">
      <div class="name"><span>${x.name}</span><span>${pctFmt.format(x.ret)} % p. a.</span></div>
      <div class="value">${money0(end)}</div>
      <div class="sub">${UI.equiv(end)} · ${pctFmt.format(Math.round((end / inv) * 10) / 10)}-fach</div>
      ${scenarioLine(x.r.total, max, t)}
    </button>`;
  }).join("");
}
// gemeinsame Skala (0 … größter Endwert), damit die Höhen vergleichbar sind
function scenarioLine(values, max, t) {
  const w = 300, h = 40;
  const step = Math.max(1, Math.floor(values.length / 90));
  const pts = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${w},${h}L0,${h}Z" fill="${UI.alpha(t.teal, 0.16)}"/>
    <path d="${d}" fill="none" stroke="${t.teal}" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------- ETF-Baukasten
const usedSlots = () => new Set(state.settings.extras.map((x) => x.slot));
function nextSlot() { for (let i = 1; i < 8; i++) if (!usedSlots().has(i)) return i; return null; }

function etfCard(x, real) {
  const color = shade(x.slot);
  const q = state.quotes.get(x.symbol);
  const pts = state.history.get(`${x.symbol}|1y|1d`);
  const perf = pts && pts.length > 1 ? (pts[pts.length - 1][1] / pts[0][1] - 1) * 100 : null;
  const st = state.stats.get(x.symbol);
  const cat = catalogOf(x.symbol);
  const cur = q?.currency && q.currency !== "EUR" ? `<span class="down" title="Projektion in €, Wechselkurs bleibt unberücksichtigt">⚠ Kurs in ${esc(q.currency)}</span>` : "";
  const fields = real ? `<div class="hist">Sparrate, Rendite und Schwankung stellst du links mit den Reglern ein.</div>` : `
    <div class="fields">
      <label>€ / Monat<input type="number" min="0" step="25" value="${esc(x.rate)}" data-f="rate"></label>
      <label>Rendite % p. a.<input type="number" min="-5" max="20" step="0.25" value="${esc(x.ret)}" data-f="ret"></label>
      <label>Schwankung %<input type="number" min="0" max="60" step="0.5" value="${esc(x.vol)}" data-f="vol"></label>
      <label>Start<input type="month" value="${esc(x.start || "")}" data-f="start"></label>
      <label>Einmalbetrag €<input type="number" min="0" step="100" value="${esc(x.lump || 0)}" data-f="lump"></label>
      <label>TER %<input type="number" min="0" max="3" step="0.01" value="${esc(x.ter ?? 0.2)}" data-f="ter"></label>
    </div>`;
  return `<article class="etf ${!real && !x.enabled ? "off" : ""}" style="--c:${color}" data-id="${esc(x.id)}">
    <div class="etf-head">
      <div><h3>${esc(x.short || x.name)}</h3><div class="meta">${esc(x.name)} · ${esc(x.symbol)}${cat?.isin ? ` · ${cat.isin}` : ""}</div></div>
      ${real ? `<span class="etf-tag">Im Depot</span>` : `<label class="switch" title="In Projektion einbeziehen"><input type="checkbox" data-f="enabled" ${x.enabled ? "checked" : ""}><span></span></label>`}
    </div>
    <div class="etf-price">${q?.price ? `<b>${money(q.price)}</b>` : `<b class="muted">–</b>`}
      ${perf !== null ? `<span>${signedPct(perf)} in 12 Monaten</span>` : `<span>${q?.error ? "Kurs nicht abrufbar" : "lädt …"}</span>`} ${cur}</div>
    ${pts ? sparkSvg(pts.map((p) => p[1]), UI.theme().ink2) : `<svg class="spark" viewBox="0 0 300 44"></svg>`}
    ${fields}
    ${st ? `<div class="hist">Historisch ${pctFmt.format(st.cagr)} % p. a. · Schwankung ${pctFmt.format(st.vol)} % · seit ${st.from.slice(0, 4)}
      <button class="ghost" type="button" data-apply="${esc(x.symbol)}">übernehmen</button></div>` : ""}
    <div class="foot"><span data-share></span>${real ? "" : `<button class="ghost" type="button" data-remove>Entfernen</button>`}</div>
  </article>`;
}

function renderEtfs() {
  const root = playRoot();
  if (!root) return;
  const s = scen();
  const plan = catalogOf(PLAN()) || { symbol: PLAN(), name: PLAN() };
  $("#etf-grid", root).innerHTML = etfCard({ ...plan, id: "plan", slot: 0, rate: s.rate }, true) + state.settings.extras.map((x) => etfCard(x, false)).join("") +
    (nextSlot() !== null ? `<button class="etf-new" type="button"><span>+</span>ETF ausprobieren<small>Welt, Regionen, Faktoren, Gold, Geldmarkt – oder frei suchen</small></button>` : "");
  renderEtfFooters();
}
function renderEtfFooters() {
  const root = playRoot();
  if (!root || !state.result) return;
  const { r, pos } = state.result;
  const total = r.total[r.months];
  $$("#etf-grid .etf", root).forEach((el) => {
    const i = pos.findIndex((p) => p.id === el.dataset.id);
    const span = $("[data-share]", el);
    if (i < 0) { span.textContent = "nicht in der Projektion"; return; }
    const v = r.perPos[i][r.months];
    span.innerHTML = `In ${scen().years} Jahren <b>${money0(v)}</b>${pos.length > 1 ? ` · ${Math.round((v / total) * 100)} %` : ""}`;
  });
}

async function loadEtfData(symbol) {
  await Promise.all([loadQuote(symbol), loadHistory(symbol, "1y", "1d"), loadHistory(symbol, "max", "1mo")]);
}

function addExtra(item) {
  const slot = nextSlot();
  if (slot === null) return toast("Maximal sieben zusätzliche ETFs – entferne einen, um Platz zu schaffen.", { error: true });
  const cat = catalogOf(item.symbol) || {};
  state.settings.extras.push({
    id: `x${Date.now().toString(36)}`, symbol: item.symbol, name: cat.name || item.name, short: cat.short || item.name,
    slot, enabled: true, rate: 50, ret: cat.ret ?? 7, vol: cat.vol ?? 16, ter: cat.ter ?? 0.2, start: ym(monthDate(1)), lump: 0,
  });
  $("#etf-dialog").close();
  renderEtfs();
  update();
  UI.enter([...$$("#etf-grid .etf", playRoot() || document)].slice(-1), { y: 24 });
  loadEtfData(item.symbol).then(() => { renderEtfs(); syncControls(); });
  toast(`${cat.short || item.name} hinzugefügt – 50 € im Monat als Startwert`);
}

function openEtfDialog() {
  const have = new Set([PLAN(), ...state.settings.extras.map((x) => x.symbol)]);
  $("#catalog").innerHTML = state.catalog.map((c) => `<button type="button" data-symbol="${esc(c.symbol)}" ${have.has(c.symbol) ? "disabled" : ""}>
      <span>${esc(c.short)}</span><small>${esc(c.name)} · ${pctFmt.format(c.ret)} % Annahme</small></button>`).join("");
  $("#etf-search").value = "";
  $("#search-results").innerHTML = "";
  $("#etf-dialog").showModal();
}

function wirePlay(root) {
  for (const key of Object.keys(CONTROLS)) {
    const input = $(`#in-${key}`, root);
    input.addEventListener("input", () => {
      scen()[key] = +input.value;
      $(`#out-${key}`, root).textContent = CONTROLS[key].fmt(input.value);
      fillRange(input);
      if (key === "ret") $$("#scenario-presets button", root).forEach((b) => b.classList.toggle("active", Math.abs(+b.dataset.ret - scen().ret) < 0.01));
      update();
    });
  }
  $("#in-real", root).onchange = (e) => { scen().real = e.target.checked; update(); };
  $("#in-tax", root).onchange = (e) => { scen().tax = e.target.checked; update(); };
  $$("#scenario-presets button", root).forEach((b) => (b.onclick = () => { scen().ret = +b.dataset.ret; syncControls(); update(); }));
  $("#scenarios", root).addEventListener("click", (e) => {
    const b = e.target.closest(".scenario");
    if (b) { scen().ret = +b.dataset.ret; syncControls(); update(); }
  });
  $$("#proj-view button", root).forEach((b) => (b.onclick = () => {
    state.projView = b.dataset.view;
    $$("#proj-view button", root).forEach((x) => x.classList.toggle("active", x === b));
    renderProjection();
  }));
  $$("#proj-view button", root).forEach((x) => x.classList.toggle("active", x.dataset.view === state.projView));
  $("#lump-add", root).onclick = () => {
    const d = new Date(TODAY.getFullYear(), 10, 1); // nächster November (Weihnachtsgeld)
    if (d <= TODAY) d.setFullYear(d.getFullYear() + 1);
    (scen().lumps ||= []).push({ date: ym(d), amount: 1000 });
    renderLumps();
    update();
  };
  $("#lumps", root).addEventListener("input", (e) => {
    const row = e.target.closest(".lump");
    if (!row || !e.target.dataset.f) return;
    scen().lumps[+row.dataset.i][e.target.dataset.f] = e.target.dataset.f === "amount" ? +e.target.value : e.target.value;
    update();
  });
  $("#lumps", root).addEventListener("click", (e) => {
    if (e.target.dataset.del === undefined) return;
    scen().lumps.splice(+e.target.dataset.del, 1);
    renderLumps();
    update();
  });
  $("#etf-add", root).onclick = openEtfDialog;
  $("#etf-grid", root).addEventListener("input", (e) => {
    const card = e.target.closest(".etf");
    const f = e.target.dataset.f;
    if (!card || !f || card.dataset.id === "plan") return;
    const x = state.settings.extras.find((y) => y.id === card.dataset.id);
    x[f] = f === "enabled" ? e.target.checked : f === "start" ? e.target.value : +e.target.value;
    if (f === "enabled") card.classList.toggle("off", !x.enabled);
    update();
  });
  $("#etf-grid", root).addEventListener("click", (e) => {
    if (e.target.closest(".etf-new")) return openEtfDialog();
    const card = e.target.closest(".etf");
    if (!card) return;
    if (e.target.dataset.remove !== undefined) {
      state.settings.extras = state.settings.extras.filter((y) => y.id !== card.dataset.id);
      renderEtfs();
      update();
    } else if (e.target.dataset.apply) {
      const st = state.stats.get(e.target.dataset.apply);
      const ret = Math.round(st.cagr * 4) / 4, vol = Math.round(st.vol * 2) / 2;
      if (card.dataset.id === "plan") { Object.assign(scen(), { ret, vol }); syncControls(); }
      else { Object.assign(state.settings.extras.find((y) => y.id === card.dataset.id), { ret, vol }); renderEtfs(); }
      update();
      toast(`Historische Werte übernommen: ${pctFmt.format(ret)} % Rendite, ${pctFmt.format(vol)} % Schwankung`);
    }
  });
  wireDepth(root, "spiel");
}

function depthSpiel(body) {
  disposeCharts(3);
  runProjection();
  const { r, pos } = state.result;
  const head = `<tr><th>Jahr</th><th class="num">Eingezahlt</th>${pos.map((p) => `<th class="num">${esc(p.name)}</th>`).join("")}<th class="num">Mittlerer Verlauf</th><th class="num">Schwach (1 von 10)</th><th class="num">Stark (1 von 10)</th><th class="num">Alltagsäquivalent</th></tr>`;
  const rows = [];
  for (let m = 0; m <= r.months; m += 12) {
    rows.push(`<tr><td>${m === 0 ? "heute" : monthDate(m).getFullYear()}</td><td class="num">${money0(r.invested[m])}</td>${pos.map((_, i) => `<td class="num">${money0(r.perPos[i][m])}</td>`).join("")}
      <td class="num"><b>${money0(r.total[m])}</b></td><td class="num">${money0(r.bands.p10[m])}</td><td class="num">${money0(r.bands.p90[m])}</td><td class="num equiv">${UI.equiv(r.total[m])}</td></tr>`);
  }
  const s = scen();
  body.innerHTML = focusHead("Was wäre wenn – exakte Zahlen", `Jahreswerte · ${money0(s.rate)} / Monat · ${pctFmt.format(s.ret)} % p. a. · Schwankung ${pctFmt.format(s.vol)} % · Kosten ${pctFmt.format(s.ter)} %${s.real ? " · in heutiger Kaufkraft" : ""}`) +
    `<section class="focus-card scroll-x"><table class="depth-table"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table></section>`;
}

// ------------------------------------------------------------------ Zoom
const zoom = new UI.Zoom({
  crumbs: [{ label: "Finanzen", href: "./#dashboard" }],
  overview: "Sparplan",
  context: () => context(),
  items: {
    depot: { label: "Depot heute", tone: "gold", focus: focusDepot, depth: depthLedger, depthLabel: "Käufe" },
    takt: { label: "Sparplan-Takt", tone: "sky", focus: focusTakt, depth: depthLedger, depthLabel: "Käufe" },
    ziel: { label: "Ziel", tone: "violet", focus: focusZiel, depth: depthZiel, depthLabel: "Tabelle" },
    spiel: { label: "Was wäre wenn", tone: "teal", focus: focusSpiel, depth: depthSpiel, depthLabel: "Tabelle" },
  },
  // Esc im Blick führt zurück zur Übersicht der Finanzen
  onEscapeTop: () => UI.zoomTo("./#dashboard", null),
});

// ------------------------------------------------------------------ Verdrahtung
async function reloadDepot() {
  const d = await api("GET", "/api/depot");
  for (const t of d.auto_created || []) {
    toast(`Sparplan-Rate vom ${dateDe(t.date)} automatisch gebucht: ${num(4).format(t.shares)} Stück zu ${money(t.price)} (geschätzt)`);
  }
  state.tx = d.transactions;
  state.settings = d.settings;
  state.catalog = d.catalog;
}

function wire() {
  const openTile = (el) => zoom.open(el.dataset.key, 2, el);
  $("#blick").addEventListener("click", (e) => { const el = e.target.closest(".blick-tile"); if (el) openTile(el); });
  $("#blick").addEventListener("keydown", (e) => {
    const el = e.target.closest(".blick-tile");
    if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openTile(el); }
  });
  $("#catalog").addEventListener("click", (e) => { const b = e.target.closest("button[data-symbol]"); if (b) addExtra({ symbol: b.dataset.symbol }); });
  let searchTimer;
  $("#etf-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      if (q.length < 2) { $("#search-results").innerHTML = ""; return; }
      $("#search-results").innerHTML = `<p class="muted">Suche …</p>`;
      try {
        const res = await api("GET", `/api/quotes/search?q=${encodeURIComponent(q)}`);
        $("#search-results").innerHTML = res.map((r) => `<button type="button" data-symbol="${esc(r.symbol)}" data-name="${esc(r.name)}">
            <span>${esc(r.name)}</span><small>${esc(r.symbol)} · ${esc(r.exchange)} · ${esc(r.type)}</small></button>`).join("") ||
          `<p class="muted">Nichts gefunden. Tipp: Xetra-Kürzel mit „.DE“, z. B. EUNL.DE</p>`;
      } catch (err) {
        $("#search-results").innerHTML = `<p class="muted">${esc(err.message)} Du kannst ein Kürzel direkt eingeben:</p>
          <button type="button" data-symbol="${esc(q.toUpperCase())}" data-name="${esc(q.toUpperCase())}"><span>${esc(q.toUpperCase())} übernehmen</span><small>Annahmen: 7 % Rendite, 16 % Schwankung</small></button>`;
      }
    }, 350);
  });
  $("#search-results").addEventListener("click", (e) => { const b = e.target.closest("button[data-symbol]"); if (b) addExtra({ symbol: b.dataset.symbol, name: b.dataset.name }); });

  $("#tx-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    const f = e.target;
    const body = { date: f.date.value, symbol: f.symbol.value, shares: f.shares.value, amount: f.amount.value, note: f.note.value };
    try {
      await api(editingTx ? "PUT" : "POST", editingTx ? `/api/depot/tx/${editingTx.id}` : "/api/depot/tx", body);
      $("#tx-dialog").close();
      await reloadDepot();
      if (!state.quotes.has(body.symbol.toUpperCase())) await loadQuote(body.symbol.toUpperCase());
      renderBlick();
      await zoom.refresh();
      toast("Kauf gespeichert");
    } catch (err) { $("#tx-error").textContent = err.message; }
  });
  $("#tx-delete").onclick = async () => {
    if (!editingTx || !confirm("Diesen Kauf löschen?")) return;
    await api("DELETE", `/api/depot/tx/${editingTx.id}`);
    $("#tx-dialog").close();
    await reloadDepot();
    renderBlick();
    await zoom.refresh();
  };

  const retheme = () => { renderBlick(); if (zoom.level > 1) zoom.refresh(); };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

async function pollQuote() {
  const before = state.quotes.get(PLAN())?.price;
  await loadQuote(PLAN());
  renderLiveChip();
  if (state.quotes.get(PLAN())?.price !== before) {
    // einmaliges sanftes Aufleuchten des Kurs-Chips, kein Blinken
    const chip = $("#live-chip");
    chip.classList.add("tick");
    setTimeout(() => chip.classList.remove("tick"), 900);
    renderBlick();
    if (zoom.level > 1 && zoom.key !== "spiel") zoom.refresh();
  }
}

async function init() {
  try {
    await Promise.all([reloadDepot(), UI.loadMeasures().catch(() => null)]);
  } catch (e) {
    toast(`Server nicht erreichbar: ${e.message}`, { error: true });
    return;
  }
  UI.initMotion();
  wire();
  await loadQuote(PLAN());
  renderLiveChip();
  await loadHistory(PLAN(), depotRange()); // für den Abgleich
  renderBlick();
  zoom.renderCrumbs();
  zoom.fromHash(false);
  // Kursverläufe und Statistiken im Hintergrund nachladen
  await Promise.all([PLAN(), ...state.settings.extras.map((x) => x.symbol)].map(loadEtfData));
  renderBlick();
  if (zoom.key === "spiel") { renderEtfs(); syncControls(); }
  setInterval(pollQuote, 60000);
}

init();
