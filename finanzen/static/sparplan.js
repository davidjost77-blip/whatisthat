/* Sparplan – Depot heute, Projektion mit Szenarien und hypothetischen ETFs. Rechenkern: sparplan-model.js */
"use strict";

const M = window.SparplanModel;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const eur0 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const num = (d = 2) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const pctFmt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const money = (x) => eur.format(x);
const money0 = (x) => eur0.format(Math.round(x));
const moneyShort = (x) => {
  const a = Math.abs(x);
  if (a >= 1e6) return `${num(a >= 1e7 ? 1 : 2).format(x / 1e6)} Mio. €`;
  if (a >= 1e4) return `${Math.round(x / 1000).toLocaleString("de-DE")} Tsd. €`;
  return money0(x);
};
const signed = (x, fmt = money) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x))}`;
const signedPct = (x) => `${x >= 0 ? "+" : "−"}${pctFmt.format(Math.abs(x))} %`;
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const dateDe = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  history: new Map(),     // "Kürzel|range" → points
  stats: new Map(),       // Kürzel → {cagr, vol, years, from}
  histRange: "depot",
  projView: "fan",
  result: null,
};
const PLAN = () => state.settings.plan.symbol;
const scen = () => state.settings.scenario;
const catalogOf = (symbol) => state.catalog.find((c) => c.symbol === symbol);

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

// ------------------------------------------------------------------ Farben & ECharts-Grundlagen
const seriesColor = (slot) => css(`--series-${slot + 1}`);
// ECharts versteht kein color-mix(): Transparenzen aus dem Hex-Wert berechnen
const alpha = (hex, a) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
function theme() {
  return {
    surface: css("--surface-1"), text: css("--text-primary"), text2: css("--text-secondary"), muted: css("--axis-muted"),
    grid: css("--grid"), baseline: css("--baseline"), neutral: css("--neutral"), good: css("--good"),
    bandOuter: alpha(css("--series-1"), 0.16), bandInner: alpha(css("--series-1"), 0.32),
  };
}
function baseOption(t) {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: css("--font"), color: t.text2 },
    animationDuration: reducedMotion ? 0 : 450,
    animationDurationUpdate: reducedMotion ? 0 : 350,
    tooltip: {
      trigger: "axis", backgroundColor: t.surface, borderColor: t.grid, borderWidth: 1, padding: [8, 12],
      textStyle: { color: t.text, fontSize: 12.5 }, extraCssText: "box-shadow: 0 6px 20px rgba(0,0,0,.14); border-radius: 8px;",
      axisPointer: { type: "line", lineStyle: { color: t.baseline, width: 1 } },
    },
    grid: { left: 8, right: 16, top: 16, bottom: 4, containLabel: true },
  };
}
const valueAxis = (t, fmt = moneyShort) => ({
  type: "value", axisLabel: { color: t.muted, fontSize: 11.5, formatter: fmt },
  splitLine: { lineStyle: { color: t.grid } }, axisLine: { show: false }, axisTick: { show: false },
});
const dot = (color, dashed) => dashed
  ? `<span style="display:inline-block;width:12px;border-top:2px dashed ${color};margin-right:6px;vertical-align:middle"></span>`
  : `<span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${color};margin-right:6px"></span>`;
const tipRow = (marker, label, value) =>
  `<div style="display:flex;gap:14px;justify-content:space-between;align-items:center"><span>${marker}${esc(label)}</span><b style="font-variant-numeric:tabular-nums">${value}</b></div>`;

const charts = {};
function chart(id) {
  if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), null, { renderer: "svg" });
  return charts[id];
}

function animateNumber(el, to, fmt) {
  const from = parseFloat(el.dataset.v || "NaN");
  el.dataset.v = to;
  if (reducedMotion || !isFinite(from) || Math.abs(from - to) < 0.005) { el.textContent = fmt(to); return; }
  const start = performance.now(), dur = 700;
  cancelAnimationFrame(el._raf);
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

function sparkSvg(values, color, { area = true } = {}) {
  if (!values || values.length < 2) return "";
  const w = 300, h = 48, pad = 3;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - pad - ((v - min) / span) * (h - 2 * pad)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${area ? `<path d="${d}L${w},${h}L0,${h}Z" fill="url(#${gid})"/>` : ""}
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// ------------------------------------------------------------------ Kurse
async function loadQuote(symbol) {
  try {
    const q = await api("GET", `/api/quotes/chart?symbol=${encodeURIComponent(symbol)}&range=5d&interval=1d`);
    state.quotes.set(symbol, q);
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

// Tage seit dem ersten Kauf → passender Abrufzeitraum
function depotRange() {
  const first = state.tx.filter((t) => t.symbol === PLAN()).map((t) => t.date).sort()[0];
  if (!first) return "6mo";
  const days = (TODAY - new Date(first)) / 864e5;
  return days < 170 ? "6mo" : days < 350 ? "1y" : days < 700 ? "2y" : days < 1800 ? "5y" : "max";
}

function renderLiveChip() {
  const q = state.quotes.get(PLAN());
  const chip = $("#live-chip");
  const cat = catalogOf(PLAN());
  const name = cat?.short || PLAN();
  if (!q || q.error || !q.price) {
    chip.className = "live";
    chip.querySelector("span").innerHTML = `${esc(name)}: kein Live-Kurs – gerechnet mit letztem Kaufkurs`;
    chip.title = q?.error || "";
    return;
  }
  const change = q.prev_close ? (q.price / q.prev_close - 1) * 100 : null;
  const t = q.time ? new Date(q.time * 1000) : null;
  chip.className = `live ${q.stale ? "stale" : "on"}`;
  chip.title = q.stale ? `Letzter gespeicherter Stand – Quelle gerade nicht erreichbar (${q.error || ""})` : `${q.exchange || ""} · verzögert`;
  chip.querySelector("span").innerHTML = `${esc(name)} <b>${money(q.price)}</b>` +
    (change !== null ? ` <span class="${change >= 0 ? "up" : "down"}">${change >= 0 ? "▲" : "▼"} ${pctFmt.format(Math.abs(change))} %</span>` : "") +
    (t ? ` · ${t.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "");
}

// ------------------------------------------------------------------ Heute
function depotNow() {
  const h = M.holding(state.tx, PLAN());
  const price = priceOf(PLAN()) || 0;
  const value = h.shares * price;
  const extrasReal = [...new Set(state.tx.map((t) => t.symbol))].filter((s) => s !== PLAN())
    .map((s) => { const x = M.holding(state.tx, s); return { symbol: s, ...x, value: x.shares * (priceOf(s) || x.avg) }; });
  const otherValue = extrasReal.reduce((s, x) => s + x.value, 0);
  const otherInvested = extrasReal.reduce((s, x) => s + x.invested, 0);
  return { ...h, price, value: value + otherValue, planValue: value, invested: h.invested + otherInvested, cash: (state.settings.cash || 0) / 100, others: extrasReal };
}

function renderHero() {
  const d = depotNow();
  const gain = d.value - d.invested;
  const gainPct = d.invested ? (gain / d.invested) * 100 : 0;
  animateNumber($("#hero-value"), d.value, money);
  const q = state.quotes.get(PLAN());
  const day = q?.prev_close && q.price ? d.shares * (q.price - q.prev_close) : null;
  $("#hero-delta").innerHTML =
    `<span class="pill ${gain >= 0 ? "up" : "down"}">${gain >= 0 ? "▲" : "▼"} ${signed(gain)} · ${signedPct(gainPct)}</span>` +
    `<span class="muted" style="font-weight:500;font-size:13px">seit dem ersten Kauf</span>` +
    (day !== null ? `<span class="pill ${day >= 0 ? "up" : "down"}" title="Veränderung seit dem letzten Schlusskurs">heute ${signed(day)}</span>` : "");
  const next = firstPlanDate();
  $("#hero-facts").innerHTML = [
    ["Anteile", `${num(d.shares % 1 ? 2 : 0).format(d.shares)} Stück`],
    ["Eingezahlt", money(d.invested)],
    ["Ø Kaufkurs", d.avg ? money(d.avg) : "–"],
    ["Guthaben", money(d.cash)],
    ["Gesamt inkl. Guthaben", money(d.value + d.cash)],
    ["Nächste Rate", `${money0(state.settings.plan.rate)} am ${dateDe(isoDate(next))}`],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  renderReconcile(d);
}

// Abgleich mit dem Kontoauszug: fehlt ein Kauf?
function renderReconcile(d) {
  const snap = state.settings.snapshot;
  const note = $("#hero-note");
  if (!snap?.portfolio) { note.hidden = true; $("#reconcile").innerHTML = ""; return; }
  const points = state.history.get(`${PLAN()}|${depotRange()}|1d`) || [];
  const hist = M.depotHistory(state.tx, points, PLAN(), snap.date);
  const calc = hist.length ? hist[hist.length - 1] : { value: 0, price: d.price };
  const reported = snap.portfolio / 100;
  const diff = reported - calc.value;
  const rel = reported ? Math.abs(diff) / reported : 0;
  const missing = calc.price ? diff / calc.price : 0;
  $("#reconcile").innerHTML = `<table>
    <tr><td>Depotwert laut Kontoauszug (${dateDe(snap.date)})</td><td>${money(reported)}</td></tr>
    <tr><td>Aus den erfassten Käufen berechnet</td><td>${money(calc.value)}</td></tr>
    <tr><td>Differenz</td><td>${signed(diff)}${rel > 0.02 ? ` · ≈ ${num(2).format(missing)} Stück` : ""}</td></tr></table>
    <p class="muted">${rel <= 0.02 ? "Passt – die erfassten Käufe erklären den Depotwert." :
      "Die erfassten Käufe erklären den Depotwert nicht vollständig. Vermutlich fehlt ein Kauf oder eine Stückzahl ist gerundet."}</p>`;
  note.hidden = rel <= 0.02;
  if (rel > 0.02) {
    note.innerHTML = `<b>Abgleich:</b> Laut Kontoauszug vom ${dateDe(snap.date)} ist dein Depot ${money(reported)} wert, aus den erfassten
      Käufen ergeben sich ${money(calc.value)}. Die Differenz von ${money(Math.abs(diff))} entspricht ≈ ${num(2).format(Math.abs(missing))} Anteilen –
      fehlt vielleicht ein Kauf? <a href="#ledger-title">Käufe prüfen</a>`;
  }
}

async function renderHistory() {
  const t = theme();
  const c = chart("chart-history");
  const plan = PLAN();
  const cap = $("#history-caption");
  if (state.histRange === "depot") {
    const points = await loadHistory(plan, depotRange());
    const hist = M.depotHistory(state.tx, points || [], plan, isoDate(TODAY));
    const buys = hist.filter((h) => h.buy);
    cap.textContent = points ? "Depotwert pro Handelstag · Punkte = Käufe" : "Ohne Kursverlauf: Werte zwischen den Käufen mit dem jeweiligen Kaufkurs";
    c.setOption({
      ...baseOption(t),
      xAxis: { type: "time", splitNumber: 5, minInterval: 7 * 864e5, axisLabel: { color: t.muted, fontSize: 11.5, formatter: "{dd}.{MM}.", hideOverlap: true }, axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false }, splitLine: { show: false } },
      yAxis: { ...valueAxis(t), scale: true },
      tooltip: { ...baseOption(t).tooltip, formatter: (ps) => {
        const h = hist[ps[0].dataIndex];
        if (!h) return "";
        return `<b>${dateDe(h.date)}</b>${h.buy ? " · Kauf" : ""}` +
          tipRow(dot(seriesColor(0)), "Depotwert", money(h.value)) + tipRow(dot(t.neutral, true), "Eingezahlt", money(h.invested)) +
          tipRow("", "Kurs", money(h.price));
      } },
      series: [
        { name: "Depotwert", type: "line", data: hist.map((h) => [h.date, h.value]), showSymbol: false, smooth: 0.2,
          lineStyle: { width: 2, color: seriesColor(0) }, itemStyle: { color: seriesColor(0) },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: alpha(seriesColor(0), 0.28) }, { offset: 1, color: alpha(seriesColor(0), 0) }]) } },
        { name: "Eingezahlt", type: "line", step: "end", data: hist.map((h) => [h.date, h.invested]), showSymbol: false,
          lineStyle: { width: 1.5, type: "dashed", color: t.neutral }, itemStyle: { color: t.neutral } },
        { name: "Käufe", type: "scatter", data: buys.map((h) => [h.date, h.value]), symbolSize: 9, z: 5, tooltip: { show: false },
          itemStyle: { color: seriesColor(0), borderColor: t.surface, borderWidth: 2 } },
      ],
    }, true);
    return;
  }
  const points = await loadHistory(plan, state.histRange, state.histRange === "1y" ? "1d" : "1wk");
  const avg = M.holding(state.tx, plan).avg;
  if (!points) { c.clear(); cap.textContent = "Kursverlauf gerade nicht abrufbar."; return; }
  const change = (points[points.length - 1][1] / points[0][1] - 1) * 100;
  cap.textContent = `Kurs ${catalogOf(plan)?.short || plan} · ${signedPct(change)} im Zeitraum · gestrichelt: dein Ø Kaufkurs`;
  c.setOption({
    ...baseOption(t),
    xAxis: { type: "time", splitNumber: 6, axisLabel: { color: t.muted, fontSize: 11.5, hideOverlap: true }, axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false }, splitLine: { show: false } },
    yAxis: { ...valueAxis(t, (v) => money0(v)), scale: true },
    tooltip: { ...baseOption(t).tooltip, formatter: (ps) => `<b>${dateDe(ps[0].value[0])}</b>` + tipRow(dot(seriesColor(0)), "Kurs", money(ps[0].value[1])) },
    series: [{
      name: "Kurs", type: "line", data: points, showSymbol: false, lineStyle: { width: 2, color: seriesColor(0) }, itemStyle: { color: seriesColor(0) },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: alpha(seriesColor(0), 0.28) }, { offset: 1, color: alpha(seriesColor(0), 0) }]) },
      markLine: avg ? { symbol: "none", silent: true, data: [{ yAxis: avg }], lineStyle: { color: t.neutral, type: "dashed", width: 1.5 },
        label: { formatter: `Ø ${money(avg)}`, color: t.text2, position: "insideEndTop", fontSize: 11 } } : undefined,
    }],
  }, true);
}

// ------------------------------------------------------------------ Projektion
function positions() {
  const s = scen();
  const d = depotNow();
  const list = [{ id: "plan", name: catalogOf(PLAN())?.short || PLAN(), slot: 0, start: d.value, rate: s.rate, ret: s.ret, vol: s.vol, ter: s.ter, from: 1 }];
  for (const x of state.settings.extras) {
    if (!x.enabled) continue;
    list.push({ id: x.id, name: x.short || x.name, slot: x.slot, start: 0, rate: +x.rate || 0, ret: +x.ret, vol: +x.vol, ter: +x.ter || 0,
      from: monthOf(x.start), lump: +x.lump || 0 });
  }
  return list;
}
const PRESETS = [
  { key: "low", name: "Vorsichtig", ret: 4, text: "Lange Seitwärtsphasen, wie Welt-Aktien 2000–2012" },
  { key: "mid", name: "Historisch", ret: 7, text: "Etwa der langfristige Schnitt globaler Aktien" },
  { key: "high", name: "Rückenwind", ret: 9, text: "Starke Jahrzehnte wie 1990er oder 2010er" },
];

function runProjection() {
  const s = scen();
  const pos = positions();
  const opts = {
    months: s.years * 12, dynamic: s.dynamic, inflation: s.inflation, real: s.real, paths: 600, seed: 11, rho: 0.8,
    investedStart: depotNow().invested, lumps: (s.lumps || []).map((l) => ({ month: monthOf(l.date), amount: +l.amount || 0 })),
  };
  state.result = { pos, opts, r: M.project(pos, opts) };
  state.result.scenarios = PRESETS.map((p) => ({ ...p, r: M.project(pos, { ...opts, paths: 0, retShift: p.ret - s.ret }) }));
}

function renderOutcome() {
  const { r } = state.result;
  const s = scen();
  const end = r.months;
  let value = r.total[end];
  const invested = r.invested[end];
  const tax = s.tax ? M.taxOnSale(value, invested) : 0;
  value -= tax;
  const gain = value - invested;
  const endDate = monthDate(end);
  const kk = s.real ? " in heutiger Kaufkraft" : "";
  const el = $("#outcome");
  if (!el.children.length) {
    el.innerHTML = `
      <div class="tile main"><div class="label" data-k="l0"></div><div class="value" data-k="v0"></div><div class="sub" data-k="s0"></div></div>
      <div class="tile"><div class="label">Selbst eingezahlt</div><div class="value" data-k="v1"></div><div class="sub" data-k="s1"></div></div>
      <div class="tile"><div class="label">Davon Zinseszins</div><div class="value" data-k="v2"></div><div class="sub" data-k="s2"></div><div class="split-bar" data-k="bar"></div></div>
      <div class="tile"><div class="label">Monatliche Entnahme</div><div class="value" data-k="v3"></div><div class="sub">nach der 4-%-Regel, ohne das Depot aufzuzehren</div></div>`;
  }
  const k = (n) => el.querySelector(`[data-k="${n}"]`);
  k("l0").textContent = `Depot ${MONTHS_LONG[endDate.getMonth()]} ${endDate.getFullYear()}${s.tax ? " nach Steuern" : ""}`;
  animateNumber(k("v0"), value, money0);
  k("s0").textContent = `in 8 von 10 Verläufen zwischen ${moneyShort(r.bands.p10[end] - (s.tax ? M.taxOnSale(r.bands.p10[end], invested) : 0))} und ${moneyShort(r.bands.p90[end] - (s.tax ? M.taxOnSale(r.bands.p90[end], invested) : 0))}${kk}`;
  animateNumber(k("v1"), invested, money0);
  k("s1").textContent = `${s.years} Jahre · ${money0(s.rate + positions().slice(1).reduce((a, p) => a + p.rate, 0))} pro Monat zu Beginn`;
  animateNumber(k("v2"), Math.max(0, gain), money0);
  k("s2").textContent = invested > 0 ? `${pctFmt.format(Math.round((value / invested) * 10) / 10)}-fache deiner Einzahlungen` : "";
  const share = value > 0 ? Math.max(0, Math.min(1, invested / value)) : 1;
  k("bar").innerHTML = `<span style="width:${share * 100}%;background:${css("--neutral")}"></span><span style="width:${(1 - share) * 100}%;background:${seriesColor(2)}"></span>`;
  k("bar").title = `${Math.round(share * 100)} % eingezahlt · ${Math.round((1 - share) * 100)} % Erträge`;
  animateNumber(k("v3"), (value * 0.04) / 12, money0);
}

function renderProjection() {
  const { r, pos } = state.result;
  const s = scen();
  const t = theme();
  const c = chart("chart-projection");
  const labels = Array.from({ length: r.months + 1 }, (_, m) => m);
  const kk = s.real ? " · in heutiger Kaufkraft" : "";
  const xAxis = {
    type: "category", data: labels, boundaryGap: false,
    axisLabel: { color: t.muted, fontSize: 11.5, interval: (i) => i > 0 && monthDate(i).getMonth() === firstPlanDate().getMonth() && ((i / 12) % (s.years > 20 ? 5 : s.years > 8 ? 2 : 1) === 0),
      formatter: (m) => String(monthDate(+m).getFullYear()) },
    axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false },
  };
  const base = { ...baseOption(t), xAxis, yAxis: valueAxis(t) };
  const investedSeries = { name: "Eingezahlt", type: "line", data: r.invested, showSymbol: false, z: 4,
    lineStyle: { width: 1.5, type: "dashed", color: t.neutral }, itemStyle: { color: t.neutral } };
  const legend = $("#proj-legend");

  if (state.projView === "fan") {
    $("#proj-sub").textContent = `Mittlerer Verlauf bei ${pctFmt.format(s.ret)} % p. a. und Bandbreite aus 600 Simulationen${kk}`;
    const b = r.bands;
    const diff = (hi, lo) => hi.map((v, i) => v - lo[i]);
    c.setOption({
      ...base,
      tooltip: { ...base.tooltip, formatter: (ps) => {
        const m = ps[0].dataIndex;
        return `<b>${monthLabel(m)}</b>${m ? ` <span style="color:${t.muted}">· in ${durationText(m)}</span>` : ""}` +
          tipRow(dot(seriesColor(0)), "Mittlerer Verlauf", money0(r.total[m])) +
          tipRow(dot(t.bandInner), "5 von 10 Verläufen", `${moneyShort(b.p25[m])} – ${moneyShort(b.p75[m])}`) +
          tipRow(dot(t.bandOuter), "8 von 10 Verläufen", `${moneyShort(b.p10[m])} – ${moneyShort(b.p90[m])}`) +
          tipRow(dot(t.neutral, true), "Eingezahlt", money0(r.invested[m]));
      } },
      series: [
        { name: "p10", type: "line", data: b.p10, stack: "outer", showSymbol: false, lineStyle: { opacity: 0 }, silent: true },
        { name: "8 von 10", type: "line", data: diff(b.p90, b.p10), stack: "outer", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: t.bandOuter }, silent: true },
        { name: "p25", type: "line", data: b.p25, stack: "inner", showSymbol: false, lineStyle: { opacity: 0 }, silent: true },
        { name: "5 von 10", type: "line", data: diff(b.p75, b.p25), stack: "inner", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: t.bandInner }, silent: true },
        investedSeries,
        { name: "Mittlerer Verlauf", type: "line", data: r.total, showSymbol: false, z: 5, lineStyle: { width: 2.5, color: seriesColor(0) }, itemStyle: { color: seriesColor(0) },
          endLabel: { show: true, formatter: (p) => moneyShort(p.value), color: t.text, fontWeight: 600, fontSize: 12, distance: 6 } },
      ],
      grid: { ...base.grid, right: 84 },
    }, true);
    legend.innerHTML = `<span><i class="line" style="background:${seriesColor(0)}"></i>Mittlerer Verlauf</span>
      <span><i style="background:${t.bandInner}"></i>5 von 10 Verläufen</span><span><i style="background:${t.bandOuter}"></i>8 von 10 Verläufen</span>
      <span><i class="dash"></i>Eingezahlt</span>`;
  } else if (state.projView === "split") {
    $("#proj-sub").textContent = `Was du einzahlst und was der Zinseszins daraus macht${kk}`;
    const gain = r.total.map((v, i) => Math.max(0, v - r.invested[i]));
    const green = seriesColor(2);
    c.setOption({
      ...base,
      tooltip: { ...base.tooltip, formatter: (ps) => {
        const m = ps[0].dataIndex;
        const share = r.total[m] ? (gain[m] / r.total[m]) * 100 : 0;
        return `<b>${monthLabel(m)}</b>` + tipRow(dot(green), "Erträge", `${money0(gain[m])} · ${Math.round(share)} %`) +
          tipRow(dot(t.neutral), "Eingezahlt", money0(r.invested[m])) + tipRow("", "Summe", money0(r.total[m]));
      } },
      series: [
        { name: "Eingezahlt", type: "line", stack: "s", data: r.invested, showSymbol: false, lineStyle: { width: 2, color: t.surface }, areaStyle: { color: t.neutral, opacity: 0.55 }, itemStyle: { color: t.neutral } },
        { name: "Erträge", type: "line", stack: "s", data: gain, showSymbol: false, lineStyle: { width: 2, color: t.surface }, areaStyle: { color: green, opacity: 0.85 }, itemStyle: { color: green },
          endLabel: { show: true, formatter: () => moneyShort(r.total[r.months]), color: t.text, fontWeight: 600, fontSize: 12, distance: 6 } },
      ],
      grid: { ...base.grid, right: 84 },
    }, true);
    const cross = r.total.findIndex((v, i) => i > 0 && v - r.invested[i] > r.invested[i]);
    legend.innerHTML = `<span><i style="background:${t.neutral};opacity:.55"></i>Eingezahlt</span><span><i style="background:${green}"></i>Erträge (Zinseszins)</span>` +
      (cross > 0 ? `<span class="muted">Ab ${monthLabel(cross)} arbeitet dein Geld mehr als du einzahlst.</span>` : "");
  } else {
    $("#proj-sub").textContent = `Beitrag jedes ETFs zum mittleren Verlauf${kk}`;
    c.setOption({
      ...base,
      tooltip: { ...base.tooltip, formatter: (ps) => {
        const m = ps[0].dataIndex;
        return `<b>${monthLabel(m)}</b>` + [...pos].reverse().map((p) => tipRow(dot(seriesColor(p.slot)), p.name, money0(r.perPos[pos.indexOf(p)][m]))).join("") +
          tipRow("", "Summe", money0(r.total[m]));
      } },
      series: [
        ...pos.map((p, i) => ({ name: p.name, type: "line", stack: "e", data: r.perPos[i], showSymbol: false,
          lineStyle: { width: 2, color: t.surface }, areaStyle: { color: seriesColor(p.slot), opacity: 0.85 }, itemStyle: { color: seriesColor(p.slot) } })),
        investedSeries,
      ],
    }, true);
    legend.innerHTML = pos.map((p) => `<span><i style="background:${seriesColor(p.slot)}"></i>${esc(p.name)}</span>`).join("") + `<span><i class="dash"></i>Eingezahlt</span>` +
      (pos.length === 1 ? `<span class="muted">Füge unten im ETF-Baukasten weitere ETFs hinzu.</span>` : "");
  }
}

function renderScenarios() {
  const { scenarios } = state.result;
  const s = scen();
  const max = Math.max(...scenarios.map((x) => Math.max(...x.r.total)));
  const t = theme();
  $("#scenarios").innerHTML = scenarios.map((x) => {
    const end = x.r.total[x.r.months] - (s.tax ? M.taxOnSale(x.r.total[x.r.months], x.r.invested[x.r.months]) : 0);
    const inv = x.r.invested[x.r.months];
    return `<button class="scenario ${Math.abs(s.ret - x.ret) < 0.01 ? "active" : ""}" data-ret="${x.ret}">
      <div class="name"><span>${x.name}</span><span>${pctFmt.format(x.ret)} % p. a.</span></div>
      <div class="value">${money0(end)}</div>
      <div class="sub">${esc(x.text)} · ${pctFmt.format(Math.round((end / inv) * 10) / 10)}-fach</div>
      ${sparkLine(x.r.total, max, seriesColor(0), t)}
    </button>`;
  }).join("");
}
// Szenario-Kurven mit gemeinsamer Skala (0 … größter Endwert), damit die Höhen vergleichbar sind
function sparkLine(values, max, color, t) {
  const w = 300, h = 44;
  const step = Math.max(1, Math.floor(values.length / 90));
  const pts = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${w},${h}L0,${h}Z" fill="${alpha(color, 0.14)}"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/><line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="${t.grid}"/></svg>`;
}

function renderMilestones() {
  const { r } = state.result;
  const now = r.total[0];
  const goals = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2000000];
  const upcoming = goals.filter((g) => g > now);
  const reachable = upcoming.filter((g) => M.reachMonth(r.bands.p90, g) !== null);
  const shown = upcoming.slice(0, Math.min(upcoming.length, Math.max(4, reachable.length + 1))).slice(-7);
  const reached = goals.filter((g) => g <= now).slice(-1);
  $("#milestones").innerHTML = [...reached.map((g) => `<li class="reached"><div class="goal">${moneyShort(g)}</div><div class="when">✓ erreicht</div><span class="range">Depot heute ${money0(now)}</span><div class="bar"><span style="width:100%"></span></div></li>`),
    ...shown.map((g) => {
      const mid = M.reachMonth(r.bands.p50, g);
      const early = M.reachMonth(r.bands.p90, g), late = M.reachMonth(r.bands.p10, g);
      if (early === null) return `<li class="never"><div class="goal">${moneyShort(g)}</div><div class="when">nicht in ${scen().years} Jahren</div><span class="range">mit höherer Rate oder längerer Laufzeit erreichbar</span><div class="bar"><span style="width:0"></span></div></li>`;
      const when = mid !== null ? `${MONTHS[monthDate(mid).getMonth()]} ${monthDate(mid).getFullYear()} · in ${durationText(mid)}` : "nur in guten Verläufen";
      const range = `${monthDate(early).getFullYear()} – ${late !== null ? monthDate(late).getFullYear() : "später"}`;
      return `<li><div class="goal">${moneyShort(g)}</div><div class="when">${when}</div><span class="range">Bandbreite ${range}</span>
        <div class="bar"><span style="width:${((mid ?? r.months) / r.months) * 100}%"></span></div></li>`;
    })].join("");
}

// ------------------------------------------------------------------ Regler
const CONTROLS = {
  rate: { fmt: (v) => `${money0(v)} / Monat` },
  years: { fmt: (v) => `${v} Jahre · bis ${TODAY.getFullYear() + +v}` },
  dynamic: { fmt: (v) => (+v ? `${pctFmt.format(v)} %` : "keine") },
  ret: { fmt: (v) => `${pctFmt.format(v)} %` },
  vol: { fmt: (v) => `${pctFmt.format(v)} %` },
  ter: { fmt: (v) => `${pctFmt.format(v)} %` },
  inflation: { fmt: (v) => `${pctFmt.format(v)} %` },
};
function syncControls() {
  const s = scen();
  for (const [key, c] of Object.entries(CONTROLS)) {
    const input = $(`#in-${key}`);
    input.value = s[key];
    $(`#out-${key}`).textContent = c.fmt(s[key]);
    fillRange(input);
  }
  $("#in-real").checked = !!s.real;
  $("#in-tax").checked = !!s.tax;
  $$("#scenario-presets button").forEach((b) => b.classList.toggle("active", Math.abs(+b.dataset.ret - s.ret) < 0.01));
  const st = state.stats.get(PLAN());
  $("#hint-ret").innerHTML = st
    ? `Historisch ${pctFmt.format(st.cagr)} % p. a. seit ${st.from.slice(0, 4)} (${pctFmt.format(st.years)} Jahre, Schwankung ${pctFmt.format(st.vol)} %). Kurze Historie – über Jahrzehnte lagen Welt-Aktien bei etwa 7 %.`
    : "Welt-Aktien brachten über Jahrzehnte im Schnitt etwa 7 % p. a. – mit großen Schwankungen.";
  renderLumps();
}
const fillRange = (input) => input.style.setProperty("--fill", `${((input.value - input.min) / (input.max - input.min)) * 100}%`);

function renderLumps() {
  const lumps = scen().lumps || [];
  $("#lumps-count").textContent = lumps.length ? `(${lumps.length})` : "";
  $("#lumps").innerHTML = lumps.map((l, i) => `<div class="lump" data-i="${i}">
      <input type="month" value="${esc(l.date)}" data-f="date" aria-label="Monat">
      <input type="number" value="${esc(l.amount)}" min="0" step="100" data-f="amount" aria-label="Betrag in €">
      <button class="ghost" data-del="${i}" aria-label="Entfernen">✕</button></div>`).join("") +
    (lumps.length ? "" : `<p class="hint muted" style="margin:0;font-size:12px">Z. B. Weihnachtsgeld, Bonus oder Steuererstattung – fließt in den FTSE All-World.</p>`);
}

let saveTimer;
function saveSettings(keys = ["scenario", "extras"]) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const body = Object.fromEntries(keys.map((k) => [k, state.settings[k]]));
      await api("PUT", "/api/depot/settings", body);
    } catch (e) { toast(`Speichern fehlgeschlagen: ${e.message}`, { error: true }); }
  }, 600);
}

let frame;
function update({ save = true } = {}) {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    runProjection();
    renderOutcome();
    renderProjection();
    renderScenarios();
    renderMilestones();
    renderEtfFooters();
  });
  if (save) saveSettings();
}

// ------------------------------------------------------------------ ETF-Baukasten
const usedSlots = () => new Set(state.settings.extras.map((x) => x.slot));
function nextSlot() {
  for (let i = 1; i < 8; i++) if (!usedSlots().has(i)) return i;
  return null;
}

function etfCard(x, real) {
  const color = seriesColor(x.slot);
  const q = state.quotes.get(x.symbol);
  const pts = state.history.get(`${x.symbol}|1y|1d`);
  const perf = pts && pts.length > 1 ? (pts[pts.length - 1][1] / pts[0][1] - 1) * 100 : null;
  const st = state.stats.get(x.symbol);
  const cat = catalogOf(x.symbol);
  const price = q?.price;
  const cur = q?.currency && q.currency !== "EUR" ? `<span class="down" title="Projektion in €, Wechselkurs bleibt unberücksichtigt">Kurs in ${esc(q.currency)}</span>` : "";
  const fields = real ? `<div class="hist">Sparrate, Rendite und Schwankung stellst du oben in „Zukunft gestalten“ ein.</div>` : `
    <div class="fields">
      <label>€ / Monat<input type="number" min="0" step="25" value="${esc(x.rate)}" data-f="rate"></label>
      <label>Rendite % p. a.<input type="number" min="-5" max="20" step="0.25" value="${esc(x.ret)}" data-f="ret"></label>
      <label>Schwankung %<input type="number" min="0" max="60" step="0.5" value="${esc(x.vol)}" data-f="vol"></label>
      <label>Start<input type="month" value="${esc(x.start || "")}" data-f="start"></label>
      <label>Einmalbetrag €<input type="number" min="0" step="100" value="${esc(x.lump || 0)}" data-f="lump"></label>
      <label>TER %<input type="number" min="0" max="3" step="0.01" value="${esc(x.ter ?? 0.2)}" data-f="ter"></label>
    </div>`;
  const histLine = st
    ? `<div class="hist">Historisch ${pctFmt.format(st.cagr)} % p. a. · Schwankung ${pctFmt.format(st.vol)} % · seit ${st.from.slice(0, 4)}
        <button class="ghost" data-apply="${esc(x.symbol)}">übernehmen</button></div>`
    : "";
  return `<article class="etf ${real ? "real" : ""} ${!real && !x.enabled ? "off" : ""}" style="--c:${color}" data-id="${esc(x.id)}">
    <div class="etf-head">
      <div><h3>${esc(x.short || x.name)}</h3><div class="meta">${esc(x.name)} · ${esc(x.symbol)}${cat?.isin ? ` · ${cat.isin}` : ""}</div></div>
      ${real ? `<span class="etf-tag">Im Depot</span>` : `<label class="switch" title="In Projektion einbeziehen"><input type="checkbox" data-f="enabled" ${x.enabled ? "checked" : ""}><span></span></label>`}
    </div>
    <div class="etf-price">${price ? `<b>${money(price)}</b>` : `<b class="muted">–</b>`}
      ${perf !== null ? `<span class="${perf >= 0 ? "up" : "down"}">${signedPct(perf)} in 12 Monaten</span>` : `<span class="muted">${q?.error ? "Kurs nicht abrufbar" : "lädt …"}</span>`} ${cur}</div>
    ${pts ? sparkSvg(pts.map((p) => p[1]), color) : `<svg class="spark" viewBox="0 0 300 48"></svg>`}
    ${fields}
    ${histLine}
    <div class="foot"><span data-share></span>${real ? "" : `<button class="ghost" data-remove>Entfernen</button>`}</div>
  </article>`;
}

function renderEtfs() {
  const s = scen();
  const plan = catalogOf(PLAN()) || { symbol: PLAN(), name: PLAN() };
  const real = { ...plan, id: "plan", slot: 0, rate: s.rate };
  $("#etf-grid").innerHTML = etfCard(real, true) + state.settings.extras.map((x) => etfCard(x, false)).join("") +
    (nextSlot() !== null ? `<button class="etf-new" type="button"><span>+</span>ETF ausprobieren<small>Welt, Regionen, Faktoren, Gold, Geldmarkt – oder frei suchen</small></button>` : "");
  renderEtfFooters();
}
function renderEtfFooters() {
  if (!state.result) return;
  const { r, pos } = state.result;
  const total = r.total[r.months];
  $$("#etf-grid .etf").forEach((el) => {
    const i = pos.findIndex((p) => p.id === el.dataset.id);
    const span = el.querySelector("[data-share]");
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
  const next = monthDate(1);
  state.settings.extras.push({
    id: `x${Date.now().toString(36)}`, symbol: item.symbol, name: cat.name || item.name, short: cat.short || item.name,
    slot, enabled: true, rate: 50, ret: cat.ret ?? 7, vol: cat.vol ?? 16, ter: cat.ter ?? 0.2, start: ym(next), lump: 0,
  });
  $("#etf-dialog").close();
  renderEtfs();
  update();
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

// ------------------------------------------------------------------ Käufe
function renderLedger() {
  const rows = [...state.tx].sort((a, b) => b.date.localeCompare(a.date));
  $("#depot-tx").innerHTML = rows.map((t) => {
    const price = t.amount / 100 / t.shares;
    const now = priceOf(t.symbol);
    const today = now ? t.shares * now : null;
    const diff = today !== null ? today - t.amount / 100 : null;
    return `<tr data-id="${t.id}"><td class="date">${dateDe(t.date)}</td>
      <td><span class="who">${esc(catalogOf(t.symbol)?.short || t.symbol)}</span>${t.note ? `<div class="why">${esc(t.note)}</div>` : ""}</td>
      <td class="num">${num(t.shares % 1 ? 2 : 0).format(t.shares)}</td><td class="num">${money(t.amount / 100)}</td><td class="num">${money(price)}</td>
      <td class="num">${today !== null ? `${money(today)}<div class="${diff >= 0 ? "up" : "down"}" style="font-size:12px">${signed(diff)}</div>` : "–"}</td>
      <td><button class="ghost" aria-label="Bearbeiten">✎</button></td></tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">Noch keine Käufe erfasst.</td></tr>`;
  const f = $("#account-form");
  f.cash.value = ((state.settings.cash || 0) / 100).toFixed(2);
  f.snap_date.value = state.settings.snapshot?.date || "";
  f.snap_portfolio.value = state.settings.snapshot?.portfolio ? (state.settings.snapshot.portfolio / 100).toFixed(2) : "";
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

async function reloadDepot() {
  const d = await api("GET", "/api/depot");
  state.tx = d.transactions;
  state.settings = d.settings;
  state.catalog = d.catalog;
}

async function refreshAll() {
  renderHero();
  renderLedger();
  renderEtfs();
  update({ save: false });
  renderHistory();
}

// ------------------------------------------------------------------ Verdrahtung
function wire() {
  for (const key of Object.keys(CONTROLS)) {
    const input = $(`#in-${key}`);
    input.addEventListener("input", () => {
      scen()[key] = +input.value;
      $(`#out-${key}`).textContent = CONTROLS[key].fmt(input.value);
      fillRange(input);
      if (key === "ret") $$("#scenario-presets button").forEach((b) => b.classList.toggle("active", Math.abs(+b.dataset.ret - scen().ret) < 0.01));
      if (key === "rate") { state.settings.plan.rate = +input.value; saveSettings(["scenario", "plan"]); }
      update();
    });
  }
  $("#in-real").onchange = (e) => { scen().real = e.target.checked; update(); };
  $("#in-tax").onchange = (e) => { scen().tax = e.target.checked; update(); };
  $$("#scenario-presets button").forEach((b) => (b.onclick = () => { scen().ret = +b.dataset.ret; syncControls(); update(); }));
  $("#scenarios").addEventListener("click", (e) => {
    const b = e.target.closest(".scenario");
    if (b) { scen().ret = +b.dataset.ret; syncControls(); update(); }
  });
  $$("#proj-view button").forEach((b) => (b.onclick = () => {
    state.projView = b.dataset.view;
    $$("#proj-view button").forEach((x) => x.classList.toggle("active", x === b));
    renderProjection();
  }));
  $$("#hist-range button").forEach((b) => (b.onclick = () => {
    state.histRange = b.dataset.range;
    $$("#hist-range button").forEach((x) => x.classList.toggle("active", x === b));
    renderHistory();
  }));

  // Sonderzahlungen
  $("#lump-add").onclick = () => {
    const d = new Date(TODAY.getFullYear(), 10, 1); // nächster November (Weihnachtsgeld)
    if (d <= TODAY) d.setFullYear(d.getFullYear() + 1);
    (scen().lumps ||= []).push({ date: ym(d), amount: 1000 });
    renderLumps();
    update();
  };
  $("#lumps").addEventListener("input", (e) => {
    const row = e.target.closest(".lump");
    if (!row || !e.target.dataset.f) return;
    scen().lumps[+row.dataset.i][e.target.dataset.f] = e.target.dataset.f === "amount" ? +e.target.value : e.target.value;
    $("#lumps-count").textContent = `(${scen().lumps.length})`;
    update();
  });
  $("#lumps").addEventListener("click", (e) => {
    if (e.target.dataset.del === undefined) return;
    scen().lumps.splice(+e.target.dataset.del, 1);
    renderLumps();
    update();
  });

  // ETF-Baukasten
  $("#etf-add").onclick = openEtfDialog;
  $("#catalog").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-symbol]");
    if (b) addExtra({ symbol: b.dataset.symbol });
  });
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
  $("#search-results").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-symbol]");
    if (b) addExtra({ symbol: b.dataset.symbol, name: b.dataset.name });
  });
  $("#etf-grid").addEventListener("input", (e) => {
    const card = e.target.closest(".etf");
    const f = e.target.dataset.f;
    if (!card || !f || card.dataset.id === "plan") return;
    const x = state.settings.extras.find((y) => y.id === card.dataset.id);
    x[f] = f === "enabled" ? e.target.checked : f === "start" ? e.target.value : +e.target.value;
    if (f === "enabled") card.classList.toggle("off", !x.enabled);
    update();
  });
  $("#etf-grid").addEventListener("click", (e) => {
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

  // Käufe
  $("#tx-add").onclick = () => openTxDialog(null);
  $("#depot-tx").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openTxDialog(state.tx.find((t) => t.id === +tr.dataset.id));
  });
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
      refreshAll();
      toast("Kauf gespeichert");
    } catch (err) { $("#tx-error").textContent = err.message; }
  });
  $("#tx-delete").onclick = async () => {
    if (!editingTx || !confirm("Diesen Kauf löschen?")) return;
    await api("DELETE", `/api/depot/tx/${editingTx.id}`);
    $("#tx-dialog").close();
    await reloadDepot();
    refreshAll();
  };
  $("#account-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const cents = (v) => (v === "" ? null : Math.round(parseFloat(v) * 100));
    state.settings.cash = cents(f.cash.value) || 0;
    const portfolio = cents(f.snap_portfolio.value);
    state.settings.snapshot = { date: f.snap_date.value, portfolio, total: portfolio !== null ? portfolio + state.settings.cash : null };
    try {
      await api("PUT", "/api/depot/settings", { cash: state.settings.cash, snapshot: state.settings.snapshot });
      renderHero();
      toast("Gespeichert");
    } catch (err) { toast(err.message, { error: true }); }
  });

  // Größe & Theme
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 120); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderHistory(); renderEtfs(); update({ save: false }); });
}

async function pollQuote() {
  const before = state.quotes.get(PLAN())?.price;
  await loadQuote(PLAN());
  renderLiveChip();
  if (state.quotes.get(PLAN())?.price !== before) {
    renderHero();
    renderLedger();
    update({ save: false });
  }
}

async function init() {
  try {
    await reloadDepot();
  } catch (e) {
    toast(`Server nicht erreichbar: ${e.message}`, { error: true });
    return;
  }
  wire();
  syncControls();
  await loadQuote(PLAN());
  renderLiveChip();
  await refreshAll();
  // Kursverläufe und Statistiken im Hintergrund nachladen
  const symbols = [PLAN(), ...state.settings.extras.map((x) => x.symbol)];
  await Promise.all(symbols.map(loadEtfData));
  renderEtfs();
  syncControls();
  renderHero();
  renderLiveChip();
  setInterval(pollQuote, 60000);
}

init();
