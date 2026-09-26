/* Finanzen – Web-Oberfläche. Keine Build-Tools nötig: reines JavaScript + ECharts. */
"use strict";

// ------------------------------------------------------------------ Hilfen
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const eur0 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const money = (cents) => eur.format(cents / 100);
const money0 = (cents) => eur0.format(Math.round(cents / 100));
const moneyAxis = (euros) => eur0.format(euros);
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const monthLabel = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;
const monthLong = (ym) => new Date(`${ym}-01T00:00`).toLocaleDateString("de-DE", { month: "long", year: "numeric" });
const dateDe = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const KIND_LABEL = { expense: "Ausgabe", income: "Einnahme", transfer: "Umbuchung" };
const FIELD_LABEL = { any: "Empfänger/Zweck/Text", counterparty: "Empfänger", purpose: "Verwendungszweck", booking_text: "Buchungstext", iban: "IBAN", account: "Konto" };
const OP_LABEL = { contains: "enthält", equals: "ist genau", startswith: "beginnt mit", regex: "passt auf" };

async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { "X-Finanzen": "1", ...headers } };
  if (body instanceof ArrayBuffer || body instanceof Blob) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, { error = false, action, timeout = 5000 } = {}) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.run(); };
    el.append(b);
  }
  $("#toasts").append(el);
  setTimeout(() => el.remove(), action ? timeout * 2 : timeout);
}

// ------------------------------------------------------------------ Theme
// Graustufen als Normalfall (DESIGN.md); Farben für Abweichungen liefert UI.theme().
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ------------------------------------------------------------------ Zustand
const state = {
  view: "dashboard",
  period: "month",
  from: null,
  to: null,
  account: "",
  status: null,
  categories: [],
  cats: new Map(),
  returnTo: null, // Zoomstufe, aus der in eine Werkzeug-Ansicht gesprungen wurde (Esc führt zurück)
  tx: { items: [], total: 0, offset: 0, selected: new Set() },
};

function computePeriod(period) {
  const max = state.status?.max ? new Date(`${state.status.max}T00:00`) : new Date();
  const today = new Date();
  const ref = max < today ? max : today; // "jetzt" = letzte Buchung, damit ältere Exporte sinnvoll aussehen
  const y = ref.getFullYear(), m = ref.getMonth();
  const cur = monthOf(iso(ref));                     // laufender Gehaltsmonat
  const span = (back) => [monthRange(shiftMonth(cur, -back))[0], monthRange(cur)[1]];
  switch (period) {
    case "month": return monthRange(cur);
    case "lastmonth": return monthRange(shiftMonth(cur, -1));
    case "3m": return span(2);
    case "12m": return span(11);
    case "ytd": return [iso(new Date(y, 0, 1)), iso(new Date(y, 11, 31))];
    case "lastyear": return [iso(new Date(y - 1, 0, 1)), iso(new Date(y - 1, 11, 31))];
    default: return [state.status?.min || iso(new Date(y, 0, 1)), state.status?.max || iso(ref)];
  }
}

function setPeriod(period, from, to) {
  state.period = period;
  [state.from, state.to] = period === "custom" ? [from, to] : computePeriod(period);
  $("#date-from").value = state.from;
  $("#date-to").value = state.to;
  $$("#period-presets button").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
  updateMonthStep();
  saveUrl();
  refreshCurrent();
}

/** Einen (Gehalts-)Monat zurück bzw. vor. Aus einem längeren Zeitraum geht es vom letzten Monat darin aus. */
function stepMonth(dir) {
  const cur = monthOf(computePeriod("month")[0]);
  const target = shiftMonth(monthOf(state.to || computePeriod("month")[1]), dir);
  if (target > cur || (state.status?.min && monthRange(target)[1] < state.status.min)) return;
  if (target === cur) return setPeriod("month");
  if (target === shiftMonth(cur, -1)) return setPeriod("lastmonth");
  const [from, to] = monthRange(target);
  setPeriod("custom", from, to);
}
function updateMonthStep() {
  if (!state.to) return;
  const cur = monthOf(computePeriod("month")[0]), base = monthOf(state.to);
  $("#month-next").disabled = shiftMonth(base, 1) > cur;
  $("#month-prev").disabled = !!state.status?.min && monthRange(shiftMonth(base, -1))[1] < state.status.min;
}

function filterQuery(extra = {}) {
  const p = new URLSearchParams();
  if (state.from) p.set("from", state.from);
  if (state.to) p.set("to", state.to);
  if (state.account) p.set("account", state.account);
  for (const [k, v] of Object.entries(extra)) if (v !== "" && v != null) p.set(k, v);
  return p.toString();
}

function saveUrl() {
  const p = new URLSearchParams({ period: state.period });
  if (state.period === "custom") { p.set("from", state.from); p.set("to", state.to); }
  if (state.account) p.set("account", state.account);
  const hash = state.view === "dashboard" && zoom.level > 1 ? zoom.hash() : state.view;
  history.replaceState(null, "", `?${p}#${hash}`);
}

// ------------------------------------------------------------------ Navigation
function showView(view) {
  state.view = view;
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $("#filterbar").hidden = !["dashboard", "transactions"].includes(view);
  if (view === "dashboard") state.returnTo = null;
  saveUrl();
  renderAppCrumbs();
  refreshCurrent();
}

function refreshCurrent() {
  if (state.view === "dashboard") loadDashboard();
  else if (state.view === "transactions") loadTransactions();
  else if (state.view === "categories") renderCategoriesView();
  else if (state.view === "import") loadImportView();
}

async function loadStatus() {
  state.status = await api("GET", "/api/status");
  const sel = $("#account-filter");
  const current = state.account;
  sel.innerHTML = `<option value="">Alle Konten</option>` + state.status.accounts
    .map((a) => `<option value="${esc(a.account)}">${esc(a.account)} (${a.count})</option>`).join("");
  sel.value = current;
  $("#sync-status").textContent = state.status.last_import
    ? `Letzter Import: ${new Date(state.status.last_import.replace(" ", "T")).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })}`
    : "";
}

async function loadCategories() {
  state.categories = await api("GET", "/api/categories");
  state.cats = new Map(state.categories.map((c) => [c.id, c]));
  const opts = categoryOptions();
  $("#tx-category").innerHTML = `<option value="">Alle Kategorien</option><option value="0">Nicht kategorisiert</option>${opts}`;
  $("#bulk-category").innerHTML = `<option value="">– keine (Regeln entscheiden) –</option>${opts}`;
}

function categoryOptions(selected) {
  const parents = state.categories.filter((c) => !c.parent_id);
  return parents.map((p) => {
    const kids = state.categories.filter((c) => c.parent_id === p.id);
    const opt = (c, label) => `<option value="${c.id}"${c.id === selected ? " selected" : ""}>${esc(label)}</option>`;
    return `<optgroup label="${esc(p.name)}">${opt(p, `${p.name} (allgemein)`)}${kids.map((k) => opt(k, k.name)).join("")}</optgroup>`;
  }).join("");
}
const catName = (id) => {
  const c = state.cats.get(id);
  if (!c) return "Nicht kategorisiert";
  const p = c.parent_id ? state.cats.get(c.parent_id) : null;
  return p ? `${p.name} › ${c.name}` : c.name;
};

// ------------------------------------------------------------------ Dashboard: drei Zoomstufen (DESIGN.md)
// Blick = vier Kacheln mit Metapher und Soll/Ist · Fokus = ein Element mit Trend und Vergleich · Tiefe = Tabellen.
const dash = { m: null, cur: null, year: null, depot: null, ym: null, ref: null, selectedCat: null };
const eurOf = (cents) => (cents || 0) / 100;
const daysIn = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
const shiftMonth = (ym, n) => {
  const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
// Gehaltsmonate: Ein „Monat“ reicht vom Gehalt bis unmittelbar vor das nächste Gehalt (Schlüssel YYYY-MM wie
// ein Kalendermonat benannt). Ohne erkennbares Gehalt gelten Kalendermonate.
const monthRange = (ym) => {
  const c = state.status?.months?.find((x) => x.key === ym);
  return c ? [c.from, c.to] : [`${ym}-01`, iso(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0))];
};
const monthOf = (isoDate) => state.status?.months?.find((x) => x.from <= isoDate && isoDate <= x.to)?.key || isoDate.slice(0, 7);
const dayDiff = (a, b) => Math.round((new Date(`${b}T00:00`) - new Date(`${a}T00:00`)) / 864e5);
const monthDays = (ym) => { const [a, b] = monthRange(ym); return dayDiff(a, b) + 1; };
const dayInMonth = (ym, isoDate) => Math.max(1, Math.min(monthDays(ym), dayDiff(monthRange(ym)[0], isoDate) + 1));
const plusDays = (isoDate, n) => { const d = new Date(`${isoDate}T00:00`); d.setDate(d.getDate() + n); return iso(d); };
const monthSpan = (ym) => { const [a, b] = monthRange(ym); return `${dateDe(a).slice(0, 6)} – ${dateDe(b).slice(0, 6)}`; };

const TOLERANCE = 0.05; // Abweichungen unter 5 % bleiben grau – sonst ist alles rot und nichts wichtig

async function loadDepotSummary() {
  try {
    const d = await api("GET", "/api/depot");
    const plan = d.settings.plan;
    let quote = null;
    try { quote = await api("GET", `/api/quotes/chart?symbol=${encodeURIComponent(plan.symbol)}&range=5d&interval=1d`); } catch { /* offline */ }
    let shares = 0, invested = 0, value = 0;
    const bySymbol = {};
    for (const t of d.transactions) {
      const s = (bySymbol[t.symbol] ||= { shares: 0, last: 0 });
      s.shares += t.shares;
      s.last = t.amount / 100 / t.shares;
      shares += t.shares;
      invested += t.amount / 100;
    }
    for (const [sym, s] of Object.entries(bySymbol)) value += s.shares * (sym === plan.symbol && quote?.price ? quote.price : s.last);
    return { invested, value, rate: plan.rate, live: !!quote?.price && !quote.stale, count: d.transactions.length };
  } catch {
    return null;
  }
}

async function loadDashboard() {
  try {
    const m = await UI.loadMeasures();
    const ym = m.ref_month || monthOf(m.ref);
    const [curFrom, curTo] = monthRange(ym);
    const [period, cur, year, depot] = await Promise.all([
      api("GET", `/api/dashboard?${filterQuery()}`),
      api("GET", `/api/dashboard?from=${curFrom}&to=${curTo}`),
      api("GET", `/api/dashboard?from=${monthRange(shiftMonth(ym, -12))[0]}&to=${curTo}`),
      loadDepotSummary(),
    ]);
    Object.assign(dash, { m, period, cur, year, depot, ym, ref: m.ref });
    renderStart();
    window.Review?.refreshBar();
    if (zoom.level > 1) await zoom.refresh();
  } catch (e) {
    toast(`Übersicht konnte nicht geladen werden: ${e.message}`, { error: true });
  }
}

/** Alle Soll/Ist-Größen der Übersicht an einer Stelle. */
function calc() {
  const { m, cur, year, ym, ref } = dash;
  const empty = !cur || cur.empty;
  const days = monthDays(ym), day = dayInMonth(ym, ref);
  const progress = day / days;
  const sollMonth = m.soll.monthly_expense ? eurOf(m.soll.monthly_expense) : null;
  const fixedPart = sollMonth ? Math.min(eurOf(m.avg_fixed), sollMonth) : 0;
  // Fixkosten fallen am Monatsanfang an, der Rest verteilt sich gleichmäßig
  const sollToDate = sollMonth != null ? fixedPart + (sollMonth - fixedPart) * progress : null;
  const ist = empty ? 0 : eurOf(cur.kpis.expense);
  const forecast = sollMonth != null ? ist + (sollMonth - fixedPart) * (1 - progress) : null;

  const full = empty ? [] : year.monthly.filter((x) => x.month < ym);
  const income = full.reduce((s, x) => s + eurOf(x.income), 0);
  const expense = full.reduce((s, x) => s + eurOf(x.expense), 0);
  const rate = income > 0 ? ((income - expense) / income) * 100 : null;
  const sollRate = m.soll.savings_rate ?? 20;

  const cats = [];
  if (!empty) {
    const seen = new Set();
    const add = (id, name, istCents) => {
      const c = state.cats.get(id);
      const sollCents = c?.budget || m.category_avg[String(id)] || null;
      const soll = sollCents ? eurOf(sollCents) : null;
      const fixed = !!c?.fixed;
      const toDate = soll != null ? (fixed ? soll : soll * progress) : null;
      const i = eurOf(istCents);
      cats.push({ id, name, ist: i, soll, toDate, fixed, source: c?.budget ? "Budget" : soll != null ? "Ø 6 Monate" : "–",
        dev: toDate != null ? i - toDate : null, over: toDate != null && i > toDate * (1 + TOLERANCE) && i - toDate >= 5,
        children: cur.categories.find((x) => x.id === id)?.children || [] });
      seen.add(id);
    };
    for (const c of cur.categories) add(c.id, c.name, c.amount);
    for (const c of state.categories) {
      if (c.parent_id || c.kind !== "expense" || seen.has(c.id)) continue;
      if (c.budget || m.category_avg[String(c.id)]) add(c.id, c.name, 0);
    }
    cats.sort((a, b) => (b.dev ?? -Infinity) - (a.dev ?? -Infinity));
  }
  return { empty, days, day, progress, sollMonth, fixedPart, sollToDate, ist, forecast, full, income, expense, rate, sollRate, cats };
}

// Vollbild-Ansichten Ausgaben/Sparquote/Kategorien beziehen sich auf den laufenden Monat, die Zusammensetzung auf den Zeitraum
const context = (key) => (key === "zusammensetzung" ? periodLabel() : dash.ref
  ? `Stand ${dateDe(dash.ref)} · ${monthLong(dash.ym)}${state.status?.salary_months ? ` (Gehaltsmonat ${monthSpan(dash.ym)})` : ""}` : "");

// ---------- Diagramme in den Zoom-Ebenen
const layerCharts = { 2: [], 3: [] };
function mkChart(el, level) {
  const chart = echarts.init(el, null, { renderer: "svg" });
  layerCharts[level].push(chart);
  return chart;
}
function disposeCharts(level) {
  layerCharts[level].forEach((c) => c.dispose());
  layerCharts[level] = [];
}
window.addEventListener("resize", () => [2, 3].forEach((l) => layerCharts[l].forEach((c) => c.resize())));

const TONES = { ausgaben: ["violet", "tank", "Ausgaben"], sparquote: ["teal", "plant", "Sparquote"], kategorien: ["sky", "cloud", "Kategorien"], depot: ["gold", "boat", "Depot & Sparplan"] };
const focusHead = (title, sub, bad, key = zoom.key) => {
  const [, icon, name] = TONES[key] || [];
  return `<div class="focus-head"><div>${icon ? `<div class="tone-chip">${UI.icon(icon)}${name}</div>` : ""}<h1 class="${bad ? "bad" : ""}">${title}</h1><p>${sub}</p></div></div>`;
};
const cmpRow = (k, v, s = "", bad = false) => `<div class="row"><span class="k">${k}</span><span class="v ${bad ? "sig-bad" : ""}">${v}</span>${s ? `<span class="s">${s}</span>` : ""}</div>`;
const depthButton = `<div class="to-depth"><button type="button" class="primary" data-depth>Exakte Zahlen (Tiefe) ↘</button></div>`;
function wireDepth(body, key) {
  const b = body.querySelector("[data-depth]");
  if (b) b.onclick = () => zoom.open(key, 3, b);
}
const monthAxis = (t, months, extra = {}) => ({
  type: "category", data: months.map(monthLabel), axisLabel: { color: t.muted, fontSize: 11.5 },
  axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false }, ...extra,
});

// ---------- Ausgaben
function focusAusgaben(body) {
  disposeCharts(2);
  const c = calc();
  const t = UI.theme();
  if (c.empty) { body.innerHTML = focusHead("Ausgaben", "Noch keine Umsätze importiert."); return; }
  const diff = c.sollToDate != null ? c.ist - c.sollToDate : null;
  const bad = diff != null && diff > c.sollToDate * TOLERANCE;
  body.innerHTML = focusHead(
    diff == null ? `${UI.money0(c.ist)} ausgegeben` : bad ? `⚠ ${UI.money0(diff)} über Plan` : `${UI.money0(Math.abs(diff))} ${diff > 0 ? "über" : "unter"} Plan`,
    `${monthLong(dash.ym)}, Tag ${c.day} von ${c.days}. ${UI.amount(c.ist)} ausgegeben, Soll bis heute ${c.sollToDate != null ? UI.money0(c.sollToDate) : "–"}. Fixkosten zählen ab Monatsanfang voll, der Rest gleichmäßig.`, bad) +
    `<div class="focus-grid">
      <div class="compare-stack" style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <section class="focus-card"><h2>Vergleich: dieser Monat Tag für Tag</h2><p>Kumulierte Ausgaben gegen den Soll-Pfad und den Vormonat</p>
          <div class="chart" id="f-cum" style="height:min(46vh,420px)"></div>
          <div class="legend-inline"><span><i class="line" style="background:${t.violet}"></i>${monthLong(dash.ym)}</span><span><i class="dash"></i>Soll-Pfad</span><span><i style="background:${t.ink3};height:2px"></i>Vormonat</span></div></section>
        <section class="focus-card"><h2>Trend: 12 Monate</h2><p>Ausgaben pro Monat, gestrichelt das Monats-Soll. Farbig nur Monate deutlich über Soll.</p>
          <div class="chart" id="f-trend" style="height:280px"></div></section>
      </div>
      <aside class="focus-card compare">
        ${cmpRow("Bis heute", UI.money0(c.ist), `Soll ${c.sollToDate != null ? UI.money0(c.sollToDate) : "–"} · ${UI.equiv(c.ist)}`, bad)}
        ${diff != null ? cmpRow(diff > 0 ? "Über Plan" : "Unter Plan", UI.money0(Math.abs(diff)), UI.equiv(diff), bad) : ""}
        ${c.forecast != null ? cmpRow("Hochrechnung Monatsende", UI.money0(c.forecast), `wenn der Rest nach Plan läuft · Monats-Soll ${UI.money0(c.sollMonth)}`, c.forecast > c.sollMonth * (1 + TOLERANCE)) : ""}
        ${cmpRow("Vormonat bis Tag " + c.day, UI.money0(eurOf(prevMonthToDay(c.day))), "gleicher Zeitraum im Vormonat")}
        ${cmpRow("Ø letzte 6 Monate", dash.m.avg_expense ? UI.money0(eurOf(dash.m.avg_expense)) : "–", dash.m.avg_expense ? UI.equiv(eurOf(dash.m.avg_expense)) : "")}
        ${depthButton}
      </aside>
    </div>`;
  wireDepth(body, "ausgaben");

  // Vergleich: kumuliert
  const daily = new Map(dash.year.daily);
  const cum = (ym, upTo) => {
    let s = 0;
    const start = monthRange(ym)[0];
    return Array.from({ length: upTo }, (_, i) => { s += eurOf(daily.get(plusDays(start, i)) || 0); return Math.round(s * 100) / 100; });
  };
  const cur = cum(dash.ym, c.day);
  const prevYm = shiftMonth(dash.ym, -1);
  const prev = cum(prevYm, monthDays(prevYm)).slice(0, c.days);
  const path = c.sollMonth != null ? Array.from({ length: c.days }, (_, i) => c.fixedPart + (c.sollMonth - c.fixedPart) * ((i + 1) / c.days)) : [];
  const days = Array.from({ length: c.days }, (_, i) => i + 1);
  const chart = mkChart($("#f-cum", body), 2);
  chart.setOption({
    ...UI.chartBase(t),
    xAxis: { type: "category", data: days, boundaryGap: false, axisLabel: { color: t.muted, fontSize: 11.5, formatter: (d) => `${d}.` }, axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false } },
    yAxis: UI.valueAxis(t),
    tooltip: { ...UI.chartBase(t).tooltip, formatter: (ps) => {
      const i = ps[0].dataIndex;
      return `<b>${i + 1}. ${monthLong(dash.ym).split(" ")[0]}</b>` +
        (cur[i] != null ? UI.tipRow(UI.mark(t.violet), "Dieser Monat", money0(cur[i] * 100)) : "") +
        (path[i] != null ? UI.tipRow(UI.mark(t.ink2, true), "Soll-Pfad", money0(path[i] * 100)) : "") +
        (prev[i] != null ? UI.tipRow(UI.mark(t.ink3), "Vormonat", money0(prev[i] * 100)) : "");
    } },
    series: [
      { name: "Vormonat", type: "line", data: prev, showSymbol: false, lineStyle: { width: 2, color: t.ink3 }, itemStyle: { color: t.ink3 } },
      { name: "Soll-Pfad", type: "line", data: path, showSymbol: false, lineStyle: { width: 1.5, type: "dashed", color: t.ink2 }, itemStyle: { color: t.ink2 } },
      { name: "Dieser Monat", type: "line", data: cur, showSymbol: false, z: 5, smooth: 0.25, lineStyle: { width: 3, color: bad ? t.bad : t.violet }, itemStyle: { color: bad ? t.bad : t.violet },
        areaStyle: { color: UI.areaFill(bad ? t.bad : t.violet) },
        endLabel: { show: true, formatter: (p) => `${UI.moneyShort(p.value)}`, color: bad ? t.bad : t.text, fontWeight: 600 } },
    ],
    grid: { ...UI.chartBase(t).grid, right: 70 },
  });

  // Trend: 12 Monate
  const months = dash.year.monthly.map((x) => x.month);
  const values = dash.year.monthly.map((x) => eurOf(x.expense));
  const trend = mkChart($("#f-trend", body), 2);
  trend.setOption({
    ...UI.chartBase(t),
    xAxis: monthAxis(t, months),
    yAxis: UI.valueAxis(t),
    tooltip: { ...UI.chartBase(t).tooltip, axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.4 } }, formatter: (ps) => {
      const i = ps[0].dataIndex, v = values[i];
      return `<b>${monthLong(months[i])}</b>${months[i] === dash.ym ? " · läuft" : ""}` + UI.tipRow(UI.mark(t.violet), "Ausgaben", money0(v * 100)) +
        (c.sollMonth ? UI.tipRow(UI.mark(t.ink1, true), "Soll", money0(c.sollMonth * 100)) + UI.tipRow("", "Abweichung", UI.signed(v - c.sollMonth)) : "") +
        `<div style="color:${t.muted}">${UI.equiv(v)}</div>`;
    } },
    series: [{
      type: "bar", ...UI.barAnim(), barMaxWidth: 26,
      data: values.map((v, i) => ({ value: v, itemStyle: { borderRadius: [4, 4, 0, 0],
        color: months[i] === dash.ym ? UI.alpha(t.violet, 0.35) : c.sollMonth && v > c.sollMonth * (1 + TOLERANCE) ? t.bad : UI.barFill(t.violet),
        borderColor: months[i] === dash.ym ? t.violet : "transparent", borderType: "dashed" } })),
      markLine: c.sollMonth ? { symbol: "none", silent: true, data: [{ yAxis: c.sollMonth }], lineStyle: { color: t.ink1, type: "dashed", width: 1.5 },
        label: { formatter: `Soll ${UI.moneyShort(c.sollMonth)}`, color: t.text, position: "insideEndTop", fontSize: 11.5 } } : undefined,
    }],
  });
  trend.on("click", (p) => openTransactions({ month: months[p.dataIndex], direction: "out" }));
}

function prevMonthToDay(day) {
  const prevYm = shiftMonth(dash.ym, -1);
  let s = 0;
  for (const [d, v] of dash.year.daily) if (d.startsWith(prevYm) && +d.slice(8, 10) <= day) s += v;
  return s;
}

function depthAusgaben(body) {
  disposeCharts(3);
  const c = calc();
  const rows = dash.year.monthly.map((x) => {
    const v = eurOf(x.expense);
    const dev = c.sollMonth != null ? v - c.sollMonth : null;
    const over = dev != null && dev > c.sollMonth * TOLERANCE && x.month !== dash.ym;
    return `<tr class="${over ? "bad" : ""}" data-month="${x.month}" style="cursor:pointer"><td>${monthLong(x.month)}${x.month === dash.ym ? " (läuft)" : ""}</td>
      <td class="num">${money(x.expense)}</td><td class="num">${c.sollMonth != null ? money(c.sollMonth * 100) : "–"}</td>
      <td class="num dev">${dev != null ? UI.signed(dev, UI.money) : "–"}</td><td class="num equiv">${UI.equiv(v)}</td></tr>`;
  }).join("");
  const cur = dash.cur;
  body.innerHTML = focusHead("Ausgaben – exakte Zahlen", `Monatswerte der letzten 13 Monate, größte Ausgaben und Empfänger im ${monthLong(dash.ym)}. Zeile anklicken öffnet die Umsätze.`) +
    `<div class="depth-grid"><div style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <section class="focus-card scroll-x"><h2>Monate</h2><table class="depth-table" id="d-months"><thead><tr><th>Monat</th><th class="num">Ausgaben</th><th class="num">Soll</th><th class="num">Abweichung</th><th class="num">Alltagsäquivalent</th></tr></thead><tbody>${rows}</tbody></table></section>
      <section class="focus-card scroll-x"><h2>Größte Ausgaben ${monthLong(dash.ym)}</h2><table class="depth-table"><thead><tr><th>Datum</th><th>Empfänger</th><th>Kategorie</th><th class="num">Betrag</th><th class="num">Alltagsäquivalent</th></tr></thead><tbody>
        ${(cur.largest || []).map((x) => `<tr><td>${dateDe(x.date)}</td><td>${esc(x.counterparty || x.purpose || "–")}</td><td>${esc(catName(x.category_id))}</td><td class="num">${money(x.amount)}</td><td class="num equiv">${UI.equiv(eurOf(x.amount))}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Keine Ausgaben.</td></tr>`}</tbody></table></section>
      <section class="focus-card scroll-x"><h2>Empfänger ${monthLong(dash.ym)}</h2><table class="depth-table"><thead><tr><th>Empfänger</th><th class="num">Buchungen</th><th class="num">Betrag</th><th class="num">Alltagsäquivalent</th></tr></thead><tbody>
        ${(cur.top_partners || []).map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.count}</td><td class="num">${money(x.amount)}</td><td class="num equiv">${UI.equiv(eurOf(x.amount))}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">–</td></tr>`}</tbody></table></section>
    </div>
    <aside class="focus-card">${measuresForm()}
      <div class="to-depth"><button type="button" id="d-tx">Alle Umsätze ${monthLong(dash.ym)} →</button></div></aside></div>`;
  $("#d-months", body).onclick = (e) => { const tr = e.target.closest("tr[data-month]"); if (tr) openTransactions({ month: tr.dataset.month, direction: "out" }); };
  $("#d-tx", body).onclick = () => openTransactions({ month: dash.ym, direction: "out" });
  wireMeasuresForm(body);
}

/** Formular für die Maßstäbe (Soll-Werte und Grundlage der Äquivalente). */
function measuresForm() {
  const tg = dash.m.targets || {};
  const v = (cents) => (cents ? (cents / 100).toFixed(0) : "");
  return `<form class="form-grid" id="measures-form"><h2 style="font-size:14px;margin:0">Maßstäbe</h2>
    <label>Monats-Soll Ausgaben in € <input name="monthly_expense" type="number" min="0" step="10" value="${v(tg.monthly_expense)}" placeholder="${dash.m.avg_expense ? `leer = Ø ${UI.money0(eurOf(dash.m.avg_expense))}` : "z. B. 2000"}"></label>
    <label>Fixkosten pro Monat in € <input name="fixed" type="number" min="0" step="10" value="${v(tg.fixed)}" placeholder="${dash.m.avg_fixed ? `leer = Ø ${UI.money0(eurOf(dash.m.avg_fixed))}` : "z. B. 1200"}"></label>
    <p class="hint">Grundlage für „Monate Fixkosten“. Welche Kategorien Fixkosten sind, legst du unter Kategorien fest.</p>
    <label>Sparquote-Soll in % <input name="savings_rate" type="number" min="0" max="90" step="1" value="${tg.savings_rate ?? 20}"></label>
    <button class="primary">Speichern</button></form>`;
}
function wireMeasuresForm(root) {
  const f = $("#measures-form", root);
  if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const cents = (x) => (x.value === "" ? null : Math.round(parseFloat(x.value) * 100));
    const targets = { ...dash.m.targets, monthly_expense: cents(f.monthly_expense), fixed: cents(f.fixed), savings_rate: f.savings_rate.value === "" ? 20 : +f.savings_rate.value };
    try {
      await api("PUT", "/api/depot/settings", { targets });
      toast("Maßstäbe gespeichert");
      await loadDashboard();
    } catch (err) { toast(err.message, { error: true }); }
  };
}

// ---------- Sparquote
function focusSparquote(body) {
  disposeCharts(2);
  const c = calc();
  const t = UI.theme();
  if (c.rate == null) { body.innerHTML = focusHead("Sparquote", "Im Zeitraum sind keine Einnahmen erfasst – meist fehlt der Gehaltseingang im Export."); return; }
  const bad = c.rate < c.sollRate;
  const surplus = c.income - c.expense;
  const sollSurplus = (c.income * c.sollRate) / 100;
  const gap = surplus - sollSurplus;
  const n = c.full.length || 1;
  body.innerHTML = focusHead(bad ? `⚠ Sparquote ${UI.pct(c.rate)} statt ${UI.pct(c.sollRate)}` : `Sparquote ${UI.pct(c.rate)} – Soll erreicht`,
    `Letzte ${c.full.length} vollen Monate. ${bad ? `Pro Monat fehlen ${UI.amount(-gap / n)} zum Soll.` : `Pro Monat ${UI.amount(gap / n)} mehr als das Soll.`}`, bad) +
    `<div class="focus-grid"><div style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <section class="focus-card"><h2>Trend: Sparquote pro Monat</h2><p>Gestrichelt das Soll, farbig die Monate darunter</p><div class="chart" id="f-rate" style="height:min(42vh,380px)"></div></section>
      <section class="focus-card"><h2>Vergleich: Überschuss aufsummiert</h2><p>Was du zurückgelegt hast gegen das, was das Soll vorsieht</p><div class="chart" id="f-cumsurplus" style="height:280px"></div>
        <div class="legend-inline"><span><i class="line" style="background:${t.teal}"></i>Überschuss</span><span><i class="dash"></i>Soll-Überschuss</span></div></section>
    </div><aside class="focus-card compare">
      ${cmpRow("Sparquote", UI.pct(c.rate), `Soll ${UI.pct(c.sollRate)}`, bad)}
      ${cmpRow("Überschuss", UI.money0(surplus), UI.equiv(surplus))}
      ${cmpRow("Soll-Überschuss", UI.money0(sollSurplus), UI.equiv(sollSurplus))}
      ${cmpRow(gap >= 0 ? "Mehr als Soll" : "Fehlt zum Soll", UI.money0(Math.abs(gap)), UI.equiv(gap), gap < 0)}
      ${cmpRow("Ø Einnahmen / Monat", UI.money0(c.income / n))}
      ${cmpRow("Ø Ausgaben / Monat", UI.money0(c.expense / n), UI.equiv(c.expense / n))}
      ${depthButton}</aside></div>`;
  wireDepth(body, "sparquote");
  const months = c.full.map((x) => x.month);
  const rates = c.full.map((x) => (x.income > 0 ? Math.max(-100, ((x.income - x.expense) / x.income) * 100) : null));
  const chart = mkChart($("#f-rate", body), 2);
  chart.setOption({
    ...UI.chartBase(t),
    xAxis: monthAxis(t, months),
    yAxis: UI.valueAxis(t, (v) => `${v} %`),
    tooltip: { ...UI.chartBase(t).tooltip, axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.4 } }, formatter: (ps) => {
      const i = ps[0].dataIndex, x = c.full[i];
      return `<b>${monthLong(months[i])}</b>` + UI.tipRow(UI.mark(t.teal), "Sparquote", rates[i] == null ? "–" : UI.pct(rates[i])) +
        UI.tipRow("", "Überschuss", money0(x.net)) + UI.tipRow(UI.mark(t.ink1, true), "Soll", UI.pct(c.sollRate));
    } },
    series: [{ type: "bar", ...UI.barAnim(), barMaxWidth: 26,
      data: rates.map((v) => ({ value: v, itemStyle: { color: v != null && v < c.sollRate ? t.bad : UI.barFill(t.teal), borderRadius: v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
      markLine: { symbol: "none", silent: true, data: [{ yAxis: c.sollRate }], lineStyle: { color: t.ink1, type: "dashed", width: 1.5 },
        label: { formatter: `Soll ${UI.pct(c.sollRate)}`, color: t.text, position: "insideEndTop", fontSize: 11.5 } } }],
  });
  let s = 0, ss = 0;
  const cumS = c.full.map((x) => (s += eurOf(x.net)));
  const cumSoll = c.full.map((x) => (ss += (eurOf(x.income) * c.sollRate) / 100));
  const cmp = mkChart($("#f-cumsurplus", body), 2);
  cmp.setOption({
    ...UI.chartBase(t),
    xAxis: monthAxis(t, months, { boundaryGap: false }),
    yAxis: UI.valueAxis(t),
    tooltip: { ...UI.chartBase(t).tooltip, formatter: (ps) => {
      const i = ps[0].dataIndex;
      return `<b>bis ${monthLong(months[i])}</b>` + UI.tipRow(UI.mark(t.teal), "Überschuss", money0(cumS[i] * 100)) +
        UI.tipRow(UI.mark(t.ink2, true), "Soll", money0(cumSoll[i] * 100)) + `<div style="color:${t.muted}">${UI.equiv(cumS[i])}</div>`;
    } },
    series: [
      { type: "line", data: cumSoll, showSymbol: false, lineStyle: { width: 1.5, type: "dashed", color: t.ink2 } },
      { type: "line", data: cumS, showSymbol: false, smooth: 0.25, lineStyle: { width: 3, color: bad ? t.bad : t.teal }, areaStyle: { color: UI.areaFill(bad ? t.bad : t.teal) },
        endLabel: { show: true, formatter: (p) => UI.moneyShort(p.value), color: t.text, fontWeight: 600 } },
    ],
    grid: { ...UI.chartBase(t).grid, right: 70 },
  });
}

function depthSparquote(body) {
  disposeCharts(3);
  const c = calc();
  const rows = c.full.map((x) => {
    const rate = x.income > 0 ? (x.net / x.income) * 100 : null;
    const soll = (eurOf(x.income) * c.sollRate) / 100;
    const dev = eurOf(x.net) - soll;
    return `<tr class="${dev < 0 ? "bad" : ""}"><td>${monthLong(x.month)}</td><td class="num">${money(x.income)}</td><td class="num">${money(x.expense)}</td>
      <td class="num">${money(x.net)}</td><td class="num">${rate == null ? "–" : UI.pct(rate)}</td><td class="num">${UI.money(soll)}</td>
      <td class="num dev">${UI.signed(dev, UI.money)}</td><td class="num equiv">${UI.equiv(dev)}</td></tr>`;
  }).join("");
  const surplus = c.income - c.expense;
  body.innerHTML = focusHead("Sparquote – exakte Zahlen", `Einnahmen, Ausgaben und Überschuss je Monat gegen das Soll von ${UI.pct(c.sollRate)} der Einnahmen.`) +
    `<div class="depth-grid"><section class="focus-card scroll-x"><table class="depth-table"><thead><tr><th>Monat</th><th class="num">Einnahmen</th><th class="num">Ausgaben</th><th class="num">Überschuss</th><th class="num">Quote</th><th class="num">Soll-Überschuss</th><th class="num">Abweichung</th><th class="num">Alltagsäquivalent</th></tr></thead>
      <tbody>${rows}<tr class="sum"><td>Summe</td><td class="num">${UI.money(c.income)}</td><td class="num">${UI.money(c.expense)}</td><td class="num">${UI.money(surplus)}</td><td class="num">${c.rate == null ? "–" : UI.pct(c.rate)}</td><td class="num">${UI.money((c.income * c.sollRate) / 100)}</td><td class="num">${UI.signed(surplus - (c.income * c.sollRate) / 100, UI.money)}</td><td></td></tr></tbody></table></section>
      <aside class="focus-card">${measuresForm()}</aside></div>`;
  wireMeasuresForm(body);
}

// ---------- Kategorien
function focusKategorien(body) {
  disposeCharts(2);
  const c = calc();
  const t = UI.theme();
  if (c.empty) { body.innerHTML = focusHead("Kategorien", "Noch keine Umsätze importiert."); return; }
  const withSoll = c.cats.filter((x) => x.toDate != null || x.ist > 0);
  const over = c.cats.filter((x) => x.over);
  if (!dash.selectedCat || !c.cats.some((x) => x.id === dash.selectedCat)) dash.selectedCat = (over[0] || c.cats.slice().sort((a, b) => b.ist - a.ist)[0])?.id;
  body.innerHTML = focusHead(over.length ? `⚠ ${over.length} ${over.length === 1 ? "Kategorie" : "Kategorien"} über Soll` : "Alle Kategorien im Rahmen",
    `${monthLong(dash.ym)} bis Tag ${c.day}. Soll = Monatsbudget, sonst Ø der letzten 6 Monate; variable Kategorien anteilig zum Monatsfortschritt, Fixkosten voll.`, over.length > 0) +
    `<div class="focus-grid"><div style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <section class="focus-card"><h2>Vergleich: Ist gegen Soll bis heute</h2><p>Balken = ausgegeben, Strich = Soll bis heute. Klick zeigt den Verlauf der Kategorie.</p>
        <div class="chart" id="f-cats" style="height:${Math.max(220, withSoll.length * 34 + 30)}px"></div></section>
      <section class="focus-card"><h2 id="f-cat-title">Trend</h2><p>Monatliche Ausgaben, gestrichelt das Monats-Soll</p><div class="chart" id="f-cat-trend" style="height:260px"></div></section>
    </div><aside class="focus-card compare">
      ${over.length ? over.slice(0, 5).map((x) => cmpRow(esc(x.name), `+${UI.money0(x.dev)}`, `${UI.money0(x.ist)} statt ${UI.money0(x.toDate)} · ${UI.equiv(x.dev)}`, true)).join("")
        : cmpRow("Im Rahmen", `${c.cats.filter((x) => x.soll != null).length} Kategorien`, "keine liegt mehr als 5 % über ihrem Soll")}
      ${cmpRow("Unter Soll gesamt", UI.money0(-c.cats.filter((x) => x.dev < 0).reduce((s, x) => s + x.dev, 0)), "Spielraum in den übrigen Kategorien")}
      ${depthButton}</aside></div>`;
  wireDepth(body, "kategorien");
  const list = [...withSoll].reverse();
  const chart = mkChart($("#f-cats", body), 2);
  const maxV = Math.max(...list.map((x) => Math.max(x.ist, x.toDate || 0)), 1);
  chart.setOption({
    ...UI.chartBase(t),
    grid: { left: 150, right: 130, top: 4, bottom: 4 },
    tooltip: { ...UI.chartBase(t).tooltip, trigger: "item", formatter: (p) => {
      const x = list[p.dataIndex];
      return `<b>${esc(x.name)}</b>${x.fixed ? " · Fixkosten" : ""}` + UI.tipRow(UI.mark(x.over ? t.bad : t.sky), "Ist", money0(x.ist * 100)) +
        (x.toDate != null ? UI.tipRow(UI.mark(t.ink1), "Soll bis heute", money0(x.toDate * 100)) + UI.tipRow("", `Monats-Soll (${x.source})`, money0(x.soll * 100)) : "") +
        `<div style="color:${t.muted}">${UI.equiv(x.ist)}</div>`;
    } },
    xAxis: { type: "value", show: false, max: maxV * 1.05 },
    // rechte Achse als Wertespalte, damit Beschriftungen nie mit dem Soll-Strich kollidieren
    yAxis: [
      { type: "category", data: list.map((x) => x.name), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.text2, fontSize: 12.5, width: 140, overflow: "truncate" } },
      { type: "category", position: "right", data: list.map((x) => (x.toDate != null ? `${UI.moneyShort(x.ist)} / ${UI.moneyShort(x.toDate)}` : UI.moneyShort(x.ist))),
        axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.text2, fontSize: 12, fontWeight: 500 } },
    ],
    series: [
      { type: "bar", ...UI.barAnim(), barMaxWidth: 16, cursor: "pointer",
        data: list.map((x) => ({ value: x.ist, itemStyle: { color: x.over ? t.bad : x.id === dash.selectedCat ? UI.barFill(t.sky, true) : UI.alpha(t.sky, 0.45), borderRadius: [0, 6, 6, 0] } })) },
      { type: "scatter", symbol: "rect", symbolSize: [3, 24], z: 5, silent: true, itemStyle: { color: t.ink1 },
        data: list.map((x) => (x.toDate != null ? x.toDate : null)) },
    ],
  });
  chart.on("click", (p) => { dash.selectedCat = list[p.dataIndex].id; renderCatTrend(body); });
  renderCatTrend(body);
}

function renderCatTrend(body) {
  const t = UI.theme();
  const c = calc();
  const x = c.cats.find((k) => k.id === dash.selectedCat);
  if (!x) return;
  $("#f-cat-title", body).textContent = `Trend: ${x.name}`;
  const months = dash.year.monthly.map((m) => m.month);
  const values = (dash.year.category_months[String(x.id)] || months.map(() => 0)).map(eurOf);
  const el = $("#f-cat-trend", body);
  const old = echarts.getInstanceByDom(el);
  const chart = old || mkChart(el, 2);
  chart.setOption({
    ...UI.chartBase(t),
    xAxis: monthAxis(t, months),
    yAxis: UI.valueAxis(t),
    tooltip: { ...UI.chartBase(t).tooltip, axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.4 } },
      formatter: (ps) => `<b>${monthLong(months[ps[0].dataIndex])}</b>` + UI.tipRow(UI.mark(t.sky), x.name, money0(values[ps[0].dataIndex] * 100)) +
        (x.soll ? UI.tipRow(UI.mark(t.ink1, true), "Soll", money0(x.soll * 100)) : "") },
    series: [{ type: "bar", ...UI.barAnim(), barMaxWidth: 24,
      data: values.map((v, i) => ({ value: v, itemStyle: { borderRadius: [4, 4, 0, 0], color: months[i] === dash.ym ? UI.alpha(t.sky, 0.35) : x.soll && v > x.soll * (1 + TOLERANCE) ? t.bad : UI.barFill(t.sky) } })),
      markLine: x.soll ? { symbol: "none", silent: true, data: [{ yAxis: x.soll }], lineStyle: { color: t.ink1, type: "dashed", width: 1.5 },
        label: { formatter: `Soll ${UI.moneyShort(x.soll)}`, color: t.text, position: "insideEndTop", fontSize: 11.5 } } : undefined }],
  }, true);
  chart.off("click");
  chart.on("click", (p) => openTransactions({ month: months[p.dataIndex], category: x.id, direction: "out" }));
}

function depthKategorien(body) {
  disposeCharts(3);
  const c = calc();
  const rows = c.cats.map((x) => `<tr class="${x.over ? "bad" : ""}" data-cat="${x.id}" style="cursor:pointer"><td>${esc(x.name)}${x.fixed ? ' <small class="equiv">Fixkosten</small>' : ""}</td>
      <td class="num">${UI.money(x.ist)}</td><td class="num">${x.soll != null ? UI.money(x.soll) : "–"}</td><td>${esc(x.source)}</td>
      <td class="num">${x.toDate != null ? UI.money(x.toDate) : "–"}</td><td class="num dev">${x.dev != null ? UI.signed(x.dev, UI.money) : "–"}</td>
      <td class="num">${dash.m.category_avg[String(x.id)] ? money(dash.m.category_avg[String(x.id)]) : "–"}</td><td class="num equiv">${UI.equiv(x.ist)}</td></tr>` +
    x.children.filter((k) => k.id && k.id !== x.id).map((k) => `<tr class="child" data-cat="${k.id}" style="cursor:pointer"><td>${esc(k.name)}</td><td class="num">${money(k.amount)}</td><td colspan="5"></td><td class="num equiv">${UI.equiv(eurOf(k.amount))}</td></tr>`).join("")).join("");
  body.innerHTML = focusHead("Kategorien – exakte Zahlen", `${monthLong(dash.ym)} bis Tag ${c.day}. Zeile anklicken öffnet die Umsätze der Kategorie.`) +
    `<div class="depth-grid"><section class="focus-card scroll-x"><table class="depth-table" id="d-cats"><thead><tr><th>Kategorie</th><th class="num">Ist</th><th class="num">Monats-Soll</th><th>Quelle</th><th class="num">Soll bis heute</th><th class="num">Abweichung</th><th class="num">Ø 6 Monate</th><th class="num">Alltagsäquivalent</th></tr></thead><tbody>${rows}</tbody></table></section>
    <aside class="focus-card form-grid"><h2 style="font-size:14px;margin:0">Maßstäbe je Kategorie</h2>
      <p class="muted" style="margin:0;font-size:13px">Monatsbudgets und das Merkmal <b>Fixkosten</b> stellst du je Kategorie ein. Ohne Budget gilt der Durchschnitt der letzten 6 Monate.</p>
      <button type="button" id="d-to-cats">Kategorien &amp; Budgets bearbeiten →</button></aside></div>`;
  $("#d-cats", body).onclick = (e) => { const tr = e.target.closest("tr[data-cat]"); if (tr) openTransactions({ month: dash.ym, category: +tr.dataset.cat, direction: "" }); };
  $("#d-to-cats", body).onclick = () => { state.returnTo = { key: "kategorien", level: 3 }; zoom.go(1, false).then(() => showView("categories")); };
}

// ---------- Startseite: alles auf einer Seite, nach Wichtigkeit geordnet; Zoom per ⤢ als Extra
const pageCharts = new Map();
function pageChart(el) {
  let c = pageCharts.get(el.id);
  if (!c || c.isDisposed() || c.getDom() !== el) {
    c = echarts.init(el, null, { renderer: "svg" });
    pageCharts.set(el.id, c);
    new ResizeObserver(() => c.resize()).observe(el);
  }
  return c;
}
const periodMonths = () => dash.period?.range?.months?.length || 1;
const periodLabel = () => {
  const r = dash.period?.range;
  if (!r) return "";
  if (r.months.length === 1) return state.status?.salary_months ? `${monthLong(r.months[0])} · ${monthSpan(r.months[0])}` : monthLong(r.months[0]);
  return `${dateDe(r.from)} – ${dateDe(r.to)} · ${r.months.length} Monate`;
};
/** Soll einer Oberkategorie im gewählten Zeitraum (Monatsbudget, sonst Ø der letzten 6 Monate) in €. */
function catSoll(id) {
  const c = state.cats.get(id);
  const cents = c?.budget || dash.m?.category_avg?.[String(id)];
  return cents ? eurOf(cents) * periodMonths() : null;
}

function sparkline(values) {
  if (!values || values.length < 2) return "";
  const w = 200, h = 34, pad = 3;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i * (w - 2 * pad)) / (values.length - 1), h - pad - ((v - min) / span) * (h - 2 * pad)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}L${w - pad},${h}L${pad},${h}Z" fill="${UI.alpha(UI.tone("gold"), 0.12)}"/>
    <path d="${d}" fill="none" stroke="${UI.tone("gold")}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="${UI.tone("gold")}" stroke="${css("--surface-1")}" stroke-width="2"/></svg>`;
}
function deltaText(current, previous, upIsGood) {
  if (previous == null || previous === 0) return `<span class="muted">kein Vergleichszeitraum</span>`;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(change) < 0.5) return `<span class="muted">≈ wie im Vorzeitraum</span>`;
  const up = change > 0;
  const bad = up !== upIsGood;
  // Riesige Prozente (Vorzeitraum fast leer) sagen nichts aus
  const text = Math.abs(change) > 300 ? (up ? "deutlich mehr" : "deutlich weniger") : UI.pct(Math.abs(change));
  return `<span class="${bad ? "sig-bad" : "sig-good"}">${up ? "▲" : "▼"} ${text}</span> <span class="muted">ggü. Vorzeitraum</span>`;
}

function renderStart() {
  const d = dash.period;
  $("#context").textContent = periodLabel();
  const empty = !d || d.empty;
  $("#dash-empty").hidden = !empty;
  $("#dash-content").hidden = empty;
  if (empty) return;
  const first = !$("#kpis").children.length;
  renderKpis(d);
  renderFlow(d);
  renderBudgets(d);
  renderDepotCard();
  renderMonthly(d);
  renderLargest(d);
  renderPartners(d);
  if (first) {
    UI.enter($$("#kpis .kpi, #dash-content .card"), { y: 20, stagger: 0.05 });
    UI.countUp($("#kpis"), ".value");
  }
  UI.fillTracks($("#budgets"));
  const badge = $("#uncat-badge");
  badge.hidden = !d.kpis.uncategorized;
  badge.textContent = d.kpis.uncategorized;
  badge.title = `${d.kpis.uncategorized} Buchungen ohne Kategorie`;
}

// ---------- Anzeige-Einstellungen: Rücklagen (Übertrag) und Farbpaar, je Browser gespeichert
const PREFS = {
  get carry() { try { return localStorage.getItem("carry") !== "0"; } catch { return true; } },
  set carry(on) { try { localStorage.setItem("carry", on ? "1" : "0"); } catch { /* privater Modus */ } },
  get pair() { try { return localStorage.getItem("pair") || "blau"; } catch { return "blau"; } },
  set pair(v) {
    try { localStorage.setItem("pair", v); } catch { /* privater Modus */ }
    if (v === "blau") delete document.documentElement.dataset.pair; else document.documentElement.dataset.pair = v;
  },
};
/** Kategorien unter diesem Betrag (in €) erscheinen nie als Warnung (DESIGN.md §6). */
const WARN_MIN = 100;
const isOver = (v, soll) => soll != null && v >= WARN_MIN && v > soll * (1 + TOLERANCE) && v - soll >= 5;

/** Übertrag aus dem Vergleichszeitraum (Rücklagen): Betrag in € und Herkunft, sonst null. */
function carryInfo(d) {
  const p = d.kpis.prev;
  if (!p || p.carry == null) return null;
  const months = d.range.months;
  const from = p.label === "Vormonat" && months.length === 1 ? monthLong(shiftMonth(months[0], -1))
    : p.label === "Vorzeitraum" ? "dem Vorzeitraum" : p.label;
  return { value: eurOf(p.carry), from, complete: p.complete };
}
/** Erwartetes Ergebnis zum Ende des Zeitraums: jetziger Stand minus was laut Plan noch abfließt
 *  (Restbudgets, noch nicht ausgeführte Sparplan-Raten). Abgeschlossene Zeiträume: der Stand selbst. */
function expectedNet(d, net, saving, plan = planStatus(d)) {
  if (plan.progress >= 1) return net;
  const rate = dash.depot?.rate || 0;
  const saveLeft = Math.max(0, rate * d.range.months.length - saving);
  return net - plan.remaining - saveLeft;
}
/** „429 € unter Plan“ / „37 € über Plan“ – Vorzeichen sind hier missverständlich. */
const planWord = (v) => `${UI.money0(Math.abs(v))} ${v >= 0 ? "unter" : "über"} Plan`;
/** Rücklagen an + Kontostand bekannt: See und Kennzahl zeigen den echten Kontostand statt nur das Monatsergebnis. */
const balanceOf = (d) => (PREFS.carry && d.account_balance ? {
  start: eurOf(d.account_balance.start), end: eurOf(d.account_balance.end),
  startDate: d.account_balance.start_date, endDate: d.account_balance.end_date, missing: d.account_balance.missing,
} : null);
// Rücklagen ohne bekannten Kontostand: nur das Plus aus dem Vergleichszeitraum fließt links zu
const carryOf = (d) => { const c = carryInfo(d); return PREFS.carry && !d.account_balance && c?.complete && c.value > 0 ? c : null; };

/** Anteiliger Plan im Zeitraum: Fixkosten zählen ab Monatsbeginn voll, der Rest gleichmäßig über die Tage. */
function planStatus(d) {
  const r = d.range, ref = dash.ref || r.to;
  const total = dayDiff(r.from, r.to) + 1;
  const progress = ref >= r.to ? 1 : ref < r.from ? 0 : (dayDiff(r.from, ref) + 1) / total;
  const started = r.months.filter((ym) => monthRange(ym)[0] <= ref).length;
  const actual = new Map(d.categories.map((c) => [c.id, eurOf(c.amount)]));
  const soll = new Map();
  let expected = 0, spent = 0, remaining = 0;
  for (const c of state.categories) {
    if (c.parent_id || c.kind !== "expense") continue;
    const cents = c.budget || dash.m?.category_avg?.[String(c.id)];
    if (!cents) continue;
    const s = eurOf(cents) * (c.fixed ? started : r.months.length * progress);
    soll.set(c.id, s);
    expected += s;
    spent += actual.get(c.id) || 0;
    // was bis zum Ende des Zeitraums noch abfließt: Fixkosten, soweit noch nicht bezahlt;
    // übrige Kategorien im Plan-Tempo für die restlichen Tage
    if (progress < 1) remaining += c.fixed ? Math.max(0, eurOf(cents) * r.months.length - (actual.get(c.id) || 0))
      : eurOf(cents) * r.months.length * (1 - progress);
  }
  return { progress, soll, expected, remaining, vsPlan: soll.size ? expected - spent : null };
}

// 1 · Kennzahlen mit Maßstab
function renderKpis(d) {
  const k = d.kpis, prev = k.prev || {}, m = d.monthly;
  const f = d.flow;
  const expense = eurOf(k.expense), income = eurOf(k.income);
  const saving = eurOf(f.saving) || eurOf(f.depot);
  const sollRate = dash.m?.soll?.savings_rate ?? 20;
  const plan = planStatus(d);
  const share = income > 0 ? (expense / income) * 100 : null;
  const overShare = share != null && share > 100 - sollRate;
  const diff = income - expense - saving;
  const bal = balanceOf(d);
  const carry = carryOf(d);
  const net = diff + (carry?.value || 0);
  const lowRate = k.savings_rate != null && k.savings_rate < sollRate;
  const planText = plan.vsPlan == null ? "" : `<span class="${plan.vsPlan < 0 ? "sig-bad" : "sig-good"}">${planWord(plan.vsPlan)} (anteilig)</span>`;
  const tiles = [
    { label: "Neues Einkommen", value: UI.money0(income), sub: deltaText(k.income, prev.income, true), spark: m.map((x) => x.income) },
    { label: "Ausgaben", key: "ausgaben", value: UI.money0(expense), bad: plan.vsPlan != null && plan.vsPlan < -5,
      sub: `${share == null ? "" : `<span class="${overShare ? "sig-bad" : ""}">${UI.pct(share, 0)} vom neuen Einkommen</span> · `}${planText || deltaText(k.expense, prev.expense, false)}`,
      bar: share == null ? "" : `<div class="spent-bar" title="Anteil des neuen Einkommens, der ausgegeben wurde; Strich = Plan höchstens ${100 - sollRate} %"><i style="width:${Math.min(100, share)}%"></i><b style="left:${100 - sollRate}%"></b></div>`,
      spark: m.map((x) => x.expense) },
    bal ? { label: `Kontostand am ${dateDe(bal.endDate).slice(0, 6)}`, value: UI.money0(bal.end), tone: bal.end >= 0 ? "in-tone" : "out-tone", bad: bal.end < 0,
      sub: `Monat ${UI.signed(diff)} · am ${dateDe(bal.startDate).slice(0, 6)}: ${UI.money0(bal.start)}` +
        (plan.progress < 1 ? ` · <span class="${bal.end + expectedNet(d, 0, saving, plan) < 0 ? "sig-bad" : ""}">erwartet zum Ende ${UI.money0(bal.end + expectedNet(d, 0, saving, plan))}</span>` : ""),
      spark: m.map((x) => x.net) } :
    { label: carry ? "Differenz inkl. Übertrag" : "Differenz", value: UI.signed(net), tone: net >= 0 ? "in-tone" : "out-tone",
      sub: (plan.progress < 1 ? `<span class="${expectedNet(d, net, saving, plan) < 0 ? "sig-bad" : ""}">erwartet zum Ende ${UI.signed(expectedNet(d, net, saving, plan))}</span> · ` : "") +
        (carry ? `${UI.signed(diff)} aus diesem Zeitraum · ${UI.signed(carry.value)} Übertrag aus ${esc(carry.from)}`
          : `Einkommen − Ausgaben${saving ? " − Sparen" : ""} · ${deltaText(k.net, prev.net, true)}`),
      spark: m.map((x) => x.net) },
    { label: "Sparquote", key: "sparquote", value: k.savings_rate == null ? "–" : UI.pct(k.savings_rate), bad: lowRate,
      sub: k.savings_rate == null ? `<span class="muted">zu wenig Einnahmen im Zeitraum</span>` : `<span class="${lowRate ? "sig-bad" : "sig-good"}">${lowRate ? "⚠" : "✓"} Ziel ${UI.pct(sollRate)}</span>`,
      spark: m.map((x) => (x.income ? Math.max((x.net / x.income) * 100, -100) : 0)) },
  ];
  $("#kpis").innerHTML = tiles.map((x) => `
    <div class="kpi${x.bad ? " is-bad" : ""}">
      <div class="label">${x.label}${x.key ? `<button class="zoom-btn" type="button" data-zoom="${x.key}" title="Im Vollbild öffnen" aria-label="${x.label} im Vollbild öffnen">⤢</button>` : ""}</div>
      <div class="value${x.bad ? " sig-bad" : ""}${x.tone ? ` ${x.tone}` : ""}">${x.value}</div>
      <div class="delta">${x.sub}</div>
      ${x.bar || sparkline(x.spark)}
    </div>`).join("");
}

// 2 · Geldfluss im Zentrum: links Zuflüsse (neues Einkommen, Plus aus dem Vorzeitraum), rechts Abflüsse
const MAX_TARGETS = 8;
function renderFlow(d) {
  const f = d.flow;
  const income = f.sources.reduce((s, x) => s + eurOf(x.amount), 0);
  const cats = d.categories.filter((c) => c.amount > 0);
  const shown = cats.slice(0, MAX_TARGETS), rest = cats.slice(MAX_TARGETS);
  const saving = eurOf(f.saving) || eurOf(f.depot);
  const savingLabel = f.saving ? (f.saving_parts.length === 1 ? `${f.saving_parts[0].name} & Depot` : "Sparen & Depot") : "Sparplan (Depot)";
  const expense = cats.reduce((s, c) => s + eurOf(c.amount), 0);
  const carryAll = carryInfo(d);
  const bal = balanceOf(d);
  const carry = carryOf(d);
  const plus = carry ? carry.value : 0;
  const inflow = income + plus, outflow = expense + saving;
  const net = inflow - outflow;
  const plan = planStatus(d);
  const base = income || outflow || 1;
  const nodes = [];
  f.sources.forEach((s, i) => nodes.push({ id: `in${i}`, name: s.name, value: eurOf(s.amount), col: 0, click: true, cat: s.id,
    ...(s.id === 0 ? { kind: "review", cls: "review", sub: "⚑ zuordnen" } : { kind: "income" }) }));
  if (plus) nodes.push({ id: "carry", name: `Übertrag aus ${carry.from}`, value: plus, col: 0, cls: "carry-pos", kind: "carry", sub: "Plus" });
  // Rücklagen an: Was fehlt, kommt aus dem Ersparten und gleicht links aus – mit bekanntem Kontostand nur so weit,
  // wie Geld da war; der Rest ist echtes Minus auf dem Konto. Rücklagen aus: der See zeigt das Minus offen.
  if (net < 0 && PREFS.carry) {
    const saved = bal ? Math.min(-net, Math.max(0, bal.start)) : -net;
    if (saved > 0) nodes.push({ id: "gap", name: "Aus Erspartem", value: saved, col: 0, cls: "rest", kind: "gap", sub: bal ? `von ${UI.money0(bal.start)}` : "vom Kontostand" });
    if (-net - saved > 0) nodes.push({ id: "overdraft", name: "Konto im Minus", value: -net - saved, col: 0, cls: "carry-neg", kind: "gap", sub: "Dispo" });
  }
  nodes.push({ id: "hub", name: "See", value: Math.max(inflow, outflow), col: 1 });
  for (const c of shown) {
    const soll = plan.soll.get(c.id) ?? null;
    const v = eurOf(c.amount);
    const bad = c.id !== 0 && isOver(v, soll);
    const disc = !!state.cats.get(c.id)?.disc;
    nodes.push({ id: `c${c.id}`, name: c.name, value: v, col: 2, disc, cls: c.id === 0 ? "review" : bad ? "bad" : "", click: true, cat: c.id,
      kind: c.id === 0 ? "review" : "expense", soll,
      sub: c.id === 0 ? "⚑ zuordnen" : bad ? `⚠ +${UI.money0(v - soll)} über Plan` : UI.pct((v / base) * 100, 0) });
  }
  if (rest.length) nodes.push({ id: "other", name: `${rest.length} weitere`, value: rest.reduce((s, c) => s + eurOf(c.amount), 0), col: 2, cls: "rest" });
  if (saving > 0) nodes.push({ id: "save", name: savingLabel, value: saving, col: 2, cls: "save", click: true, kind: "save", sub: UI.pct((saving / base) * 100, 0) });
  if (net > 0) nodes.push({ id: "left", name: "Übrig", value: net, col: 2, cls: "rest", sub: UI.equiv(net) });

  // Seefarbe nach dem erwarteten Ergebnis zum Ende des Zeitraums (inkl. Übertrag, wenn eingeschaltet):
  // deutlich im Plus = Einnahmenfarbe; je näher an null, desto mehr Ausgabenfarbe; im Minus klar Ausgabenfarbe.
  const expNet = expectedNet(d, net, saving, plan);
  // mit bekanntem Kontostand: rot nur, wenn das Konto (erwartet) wirklich gegen null oder darunter geht
  const expEnd = bal ? bal.end + expectedNet(d, 0, saving, plan) : null;
  const score = Math.max(-1, Math.min(1, (bal ? expEnd : expNet) / (base * 0.15)));
  const lake = {
    left: "color-mix(in srgb, var(--flow-in) 45%, var(--mix-base))",
    right: "color-mix(in srgb, var(--flow-out) 45%, var(--mix-base))",
    center: (bal ? expEnd : expNet) >= 0
      ? `color-mix(in srgb, color-mix(in oklab, var(--flow-out) ${Math.round(65 * (1 - score) ** 1.6)}%, var(--flow-in)) 88%, var(--lake-base))`
      : `color-mix(in srgb, var(--flow-out) ${Math.round(78 + 22 * -score)}%, var(--lake-base))`,
    mid: (0.5 - 0.3 * score).toFixed(2),
  };
  const carryNote = !PREFS.carry ? " · Rücklagen ausgeblendet"
    : bal ? ` · Kontostand ${dateDe(bal.startDate).slice(0, 6)} ${UI.money0(bal.start)} → ${dateDe(bal.endDate).slice(0, 6)} ${UI.money0(bal.end)}${bal.missing.length ? ` (ohne ${bal.missing.join(", ")})` : ""}`
    : !d.account_balance && PREFS.carry && net < 0 ? " · Kontostand unbekannt – unter Import › Kontostände eintragen"
    : carry ? ` · Übertrag aus ${carry.from} ${UI.signed(carry.value)}`
    : carryAll?.complete && carryAll.value <= 0 ? ` · kein Übertrag (${carryAll.from} ohne Plus)`
    : carryAll && !carryAll.complete ? " · kein Übertrag: Vergleichszeitraum nicht vollständig in den Daten" : "";
  $("#flow-sub").textContent = `${periodLabel()}${carryNote}. Kategorie anklicken für Details und Vergleich.`;
  $("#flow-legend").innerHTML = `<span><i style="background:var(--flow-in)"></i>Einnahmen</span>
    <span><i style="background:color-mix(in srgb, var(--flow-out) 60%, var(--mix-base))"></i>Ausgaben</span>
    <span><i style="background:var(--flow-out)"></i>steuerbar</span>
    ${carry ? `<span><i style="background:var(--carry-pos)"></i>Übertrag</span>` : ""}
    <span class="muted">${bal ? `See: ${plan.progress < 1 ? "erwarteter " : ""}Kontostand zum Ende – Einnahmenfarbe, solange genug drauf ist; je näher an null desto röter; Ausgabenfarbe = Konto im Minus`
      : `See: ${plan.progress < 1 ? "erwartetes Ergebnis zum Ende" : "Ergebnis"}${carry ? " inkl. Übertrag" : ""} – Einnahmenfarbe = im Plus, je näher an null desto röter, Ausgabenfarbe = im Minus`}</span>`;
  const lakeCtl = Flow.lake($("#flow"), { nodes }, {
    label: "Geldfluss: Einnahmen links münden in den See, Ausgaben und Sparen fließen rechts ab",
    format: (v) => UI.money0(v),
    lake,
    hubLines: [
      ...(bal ? [
        { cls: "lf-k", text: `Kontostand am ${dateDe(bal.endDate).slice(0, 6)}` },
        { cls: "lf-v", text: UI.money0(bal.end) },
        { cls: "lf-s", text: `Monat ${UI.signed(net)} · ${UI.money0(inflow)} rein · ${UI.money0(outflow)} raus` },
        ...(plan.progress < 1 ? [{ cls: "lf-s", text: `erwartet zum Ende: ${UI.money0(expEnd)}` }] : []),
      ] : [
        { cls: "lf-k", text: carry ? "Differenz inkl. Übertrag" : "Differenz" },
        { cls: "lf-v", text: UI.signed(net) },
        { cls: "lf-s", text: `${UI.money0(inflow)} rein · ${UI.money0(outflow)} raus` },
        ...(plan.progress < 1 ? [{ cls: "lf-s", text: `erwartet zum Ende: ${UI.signed(expNet)}` }] : []),
      ]),
      { cls: "lf-s", text: plan.vsPlan == null ? periodLabel() : `${planWord(plan.vsPlan)} (anteilig)` },
    ],
    detail: (x) => {
      if (x.col === 1) return `<b>${net >= 0 ? "Im Plus" : "Im Minus"}</b> ${UI.signed(net)}${plan.vsPlan != null ? `<br>${planWord(plan.vsPlan)} (anteilig)<br><span class="muted">Plan bis heute ${UI.money0(plan.expected)} (${UI.pct(plan.progress * 100, 0)} des Zeitraums)</span>` : ""}`;
      if (x.kind === "gap") return `<b>Aus Erspartem</b> · ${UI.money0(x.value)}<br><span class="muted">In diesem Zeitraum ging mehr raus als reinkam; die Differenz wurde vom vorhandenen Kontostand bezahlt. Ausblenden über „Rücklagen“.</span>`;
      if (x.kind === "carry") return `<b>${esc(x.name)}</b> · ${UI.money0(x.value)}<br><span class="muted">Was im Vergleichszeitraum nach Ausgaben und Sparen übrig blieb. Ausblenden über „Rücklagen“.</span>`;
      const soll = x.soll != null ? `<br>Plan bis heute ${UI.money0(x.soll)}${x.value > x.soll ? ` · <span class="${/\bbad\b/.test(x.cls) ? "sig-bad" : "muted"}">${UI.money0(x.value - x.soll)} drüber</span>` : ""}` : "";
      return `<b>${esc(x.name)}</b> · ${UI.money0(x.value)}${x.disc ? ` <span class="tag-disc">steuerbar</span>` : ""}<br><span class="muted">${UI.equiv(x.value)}</span>${soll}${x.click ? `<br><span class="muted">Klick: ${x.kind === "save" ? "zum Sparplan" : x.kind === "review" ? "jetzt zuordnen" : x.kind === "income" ? "Umsätze zeigen" : "Details & Vergleich"}</span>` : ""}`;
    },
    onClick: (n, el) => {
      if (n.kind === "review") return window.Review?.open();
      if (n.kind === "save") return UI.zoomTo("sparplan.html", el);
      if (n.kind === "income") return goToTransactions({ from: dash.period.range.from, to: dash.period.range.to, category: n.cat || "", direction: "in" });
      dash.flowCat = n.cat;
      zoom.open("zusammensetzung", 2, el);
    },
  });
  kickNewBookings(lakeCtl, nodes, f);
}

/** Neue Buchungen seit dem letzten Blick (Bank-Sync, Import) stoßen den See dort an, wo ihr Fluss mündet. */
let lakeSeenMem = null;
async function kickNewBookings(ctl, nodes, f) {
  const max = state.status?.max_id;
  if (!ctl || !max) return;
  let seen = lakeSeenMem;
  try { seen = +localStorage.getItem("lakeSeen") || seen; localStorage.setItem("lakeSeen", String(max)); } catch { /* privater Modus */ }
  lakeSeenMem = max;
  if (!seen || seen >= max) return;                  // erster Besuch oder nichts Neues
  const r = dash.period.range;
  let res;
  try { res = await api("GET", `/api/transactions?${filterQuery({ since: seen, from: r.from, to: r.to, limit: 50 })}`); } catch { return; }
  const ids = new Set(nodes.map((n) => n.id));
  const sums = new Map();
  for (const tx of res.items) {
    const cat = state.cats.get(tx.category_id);
    const top = cat ? cat.parent_id || cat.id : 0;
    let id;
    if (cat?.kind === "transfer") id = "save";
    else if (tx.amount > 0) { const i = f.sources.findIndex((x) => x.id === top); id = i >= 0 ? `in${i}` : null; }
    else id = ids.has(`c${top}`) ? `c${top}` : "other";
    if (id && ids.has(id)) sums.set(id, (sums.get(id) || 0) + Math.abs(eurOf(tx.amount)));
  }
  [...sums].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .forEach(([id, v], i) => setTimeout(() => ctl.kick(id, v), 700 + i * 420));
}

// 3 · Budgets & Soll je Kategorie
function renderBudgets(d) {
  const rows = d.categories.filter((c) => c.amount > 0 && c.id).map((c) => {
    const soll = catSoll(c.id);
    const v = eurOf(c.amount);
    return { c, v, soll, bad: isOver(v, soll) };
  }).filter((r) => r.soll != null).sort((a, b) => (b.v / b.soll) - (a.v / a.soll)).slice(0, 7);
  const over = rows.filter((r) => r.bad);
  $("#budget-sub").innerHTML = over.length ? `<span class="sig-bad">⚠ ${over.length} über Soll</span> · Soll = Budget bzw. Ø 6 Monate × ${periodMonths()}` : `✓ alle im Rahmen · Soll = Budget bzw. Ø 6 Monate × ${periodMonths()}`;
  const max = Math.max(1.25, ...rows.map((r) => r.v / r.soll));
  $("#budgets").innerHTML = rows.map((r) => `<div class="budget-row" data-cat="${r.c.id}" role="button" tabindex="0" title="Zusammensetzung öffnen">
      <div class="row"><span class="name">${esc(r.c.name)}</span><span class="nums ${r.bad ? "sig-bad" : ""}">${r.bad ? "⚠ " : ""}${UI.money0(r.v)} <small>/ ${UI.money0(r.soll)}</small></span></div>
      ${UI.track({ value: r.v / r.soll, soll: 1, max, bad: r.bad, height: 9 })}
      <div class="state">${r.bad ? `${UI.money0(r.v - r.soll)} drüber · ${UI.equiv(r.v - r.soll)}` : `noch ${UI.money0(r.soll - r.v)} Spielraum`}</div></div>`).join("")
    || `<p class="empty-note">Noch kein Maßstab – nach einigen Monaten mit Umsätzen erscheint hier das Soll.</p>`;
}

// 4 · Depot-Kurzblick
function renderDepotCard() {
  const d = dash.depot;
  const el = $("#depot-mini");
  if (!d || !d.count) { el.innerHTML = `<p class="empty-note">Noch kein Sparplan erfasst. <a href="sparplan.html">Zum Sparplan</a></p>`; return; }
  const diff = d.value - d.invested;
  el.innerHTML = `<div class="depot-value ${diff < 0 ? "sig-bad" : ""}">${UI.money0(d.value)}</div>
    <div class="depot-diff ${diff < 0 ? "sig-bad" : "sig-good"}">${diff < 0 ? "⚠ " : ""}${UI.signed(diff)} ggü. Einzahlungen</div>
    ${UI.track({ value: d.value, soll: d.invested, max: Math.max(d.value, d.invested) * 1.1, bad: diff < 0, height: 9, sollLabel: "eingezahlt" })}
    <dl class="depot-facts"><dt>Eingezahlt</dt><dd>${UI.money0(d.invested)}</dd><dt>Sparplan</dt><dd>${UI.money0(d.rate)} / Monat</dd>
      <dt>Wert</dt><dd><small class="equiv">${UI.equiv(d.value)}</small></dd></dl>
    <a class="button primary-link" href="sparplan.html" id="to-plan">Zum Sparplan →</a>`;
  UI.fillTracks(el);
}

// 5 · Monatsverlauf
function renderMonthly(d) {
  const t = UI.theme();
  const months = d.range.months;
  const n = periodMonths();
  const sollMonth = dash.m?.soll?.monthly_expense ? eurOf(dash.m.soll.monthly_expense) : null;
  const inc = d.monthly.map((x) => eurOf(x.income)), exp = d.monthly.map((x) => eurOf(x.expense));
  $("#monthly-sub").textContent = n === 1 ? "Ein Monat im Zeitraum – für den Verlauf einen längeren Zeitraum wählen" : "Einnahmen (grau) und Ausgaben (Bronze) je Monat, gestrichelt das Monats-Soll. Klick auf einen Monat zeigt die Umsätze.";
  const c = pageChart($("#chart-monthly"));
  c.setOption({
    ...UI.chartBase(t),
    grid: { left: 8, right: 16, top: 28, bottom: 4, containLabel: true },
    xAxis: { type: "category", data: months.map(monthLabel), axisLabel: { color: t.muted, fontSize: 11.5 }, axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false } },
    yAxis: UI.valueAxis(t),
    tooltip: { ...UI.chartBase(t).tooltip, axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.4 } }, formatter: (ps) => {
      const i = ps[0].dataIndex;
      return `<b>${monthLong(months[i])}</b>` + UI.tipRow(UI.mark(t.ink3), "Einnahmen", UI.money0(inc[i])) + UI.tipRow(UI.mark(t.gold), "Ausgaben", UI.money0(exp[i])) +
        UI.tipRow("", "Überschuss", UI.signed(inc[i] - exp[i])) + (sollMonth ? UI.tipRow(UI.mark(t.ink1, true), "Soll Ausgaben", UI.money0(sollMonth)) : "");
    } },
    series: [
      { name: "Einnahmen", type: "bar", ...UI.barAnim(), barMaxWidth: 20, barGap: "15%", data: inc, itemStyle: { color: t.ink3, borderRadius: [4, 4, 0, 0] } },
      { name: "Ausgaben", type: "bar", ...UI.barAnim(), barMaxWidth: 20, data: exp.map((v) => ({ value: v, itemStyle: { color: sollMonth && v > sollMonth * (1 + TOLERANCE) ? t.bad : UI.barFill(t.gold), borderRadius: [4, 4, 0, 0] } })),
        markLine: sollMonth ? { symbol: "none", silent: true, data: [{ yAxis: sollMonth }], lineStyle: { color: t.ink1, type: "dashed", width: 1.5 },
          label: { formatter: `Soll ${UI.moneyShort(sollMonth)}`, color: t.text, position: "insideEndTop", fontSize: 11 } } : undefined },
    ],
  }, true);
  c.off("click");
  c.on("click", (p) => {
    const ym = months[p.dataIndex];
    const [from, to] = monthRange(ym);
    goToTransactions({ from, to, direction: p.seriesName === "Einnahmen" ? "in" : "out" });
  });
}

// 6 · Details
function renderLargest(d) {
  const box = $("#largest");
  box.innerHTML = d.largest.map((x) => `<div class="item" data-q="${esc(x.counterparty)}" data-date="${x.date}">
      <div style="min-width:0"><div class="who">${esc(x.counterparty || x.purpose || "Unbekannt")}</div>
      <div class="meta">${esc(catName(x.category_id))} · ${dateDe(x.date)}</div></div>
      <div class="amt">${money(x.amount)}<small class="equiv">${UI.equiv(eurOf(x.amount))}</small></div></div>`).join("")
    || `<p class="empty-note">Keine Ausgaben im Zeitraum.</p>`;
  $$(".item", box).forEach((el) => (el.onclick = () => goToTransactions({ q: el.dataset.q, from: el.dataset.date, to: el.dataset.date })));
}
function renderPartners(d) {
  const list = d.top_partners.slice(0, 8);
  const max = Math.max(...list.map((x) => x.amount), 1);
  $("#partners").innerHTML = list.map((x) => `<div class="partner" data-q="${esc(x.name)}" role="button" tabindex="0">
      <span class="name">${esc(x.name)}</span><span class="bar"><i style="width:${(x.amount / max) * 100}%"></i></span>
      <span class="amt">${money0(x.amount)} <small>${x.count}×</small></span></div>`).join("") || `<p class="empty-note">Keine Ausgaben im Zeitraum.</p>`;
  $$("#partners .partner").forEach((el) => (el.onclick = () => goToTransactions({ q: el.dataset.q, from: dash.period.range.from, to: dash.period.range.to, direction: "out" })));
}

// ---------- Vollbild „Zusammensetzung“: Unterdashboard einer Kategorie – Unterkategorien gegen den Vergleichszeitraum
/** Bezeichnung des Vergleichszeitraums („August 2026“, „01.01.–26.09.2025“, „Vorzeitraum“). */
function prevLabelOf(pr) {
  if (!pr) return "Vorzeitraum";
  return pr.label === "Vormonat" ? monthLong(monthOf(pr.from)) : pr.label;
}
async function focusComposition(body) {
  disposeCharts(2);
  const id = dash.flowCat ?? dash.period?.categories?.[0]?.id ?? 0;
  const r = dash.period.range;
  const data = await api("GET", `/api/category_flow?${filterQuery({ id, from: r.from, to: r.to })}`);
  dash.composition = data;
  const total = eurOf(data.amount), prev = data.prev != null ? eurOf(data.prev) : null;
  const plan = planStatus(dash.period);
  const soll = plan.soll.get(id) ?? null;
  const bad = id !== 0 && isOver(total, soll);
  const disc = !!state.cats.get(id)?.disc;
  const pl = prevLabelOf(data.prev_range);
  const cur = r.months.length === 1 ? monthLong(r.months[0]) : "Zeitraum";
  const diff = prev != null ? total - prev : null;
  const chips = dash.period.categories.filter((c) => c.amount > 0)
    .map((c) => `<button type="button" data-cat="${c.id}" class="${c.id === id ? "on" : ""}">${esc(c.name)}</button>`).join("");
  body.innerHTML = focusHead(`${esc(data.name)}: ${UI.money0(total)}`,
    `${periodLabel()} gegen ${esc(pl)}${diff != null ? ` · <b class="${diff > 0 ? "out-tone" : "in-tone"}">${UI.signed(diff)}</b>` : ""}${soll != null ? ` · Plan bis heute ${UI.money0(soll)}${bad ? ` – <span class="sig-bad">⚠ ${UI.money0(total - soll)} drüber</span>` : " – im Rahmen"}` : ""}${disc ? ` <span class="tag-disc">steuerbar</span>` : ""}`, bad, "kategorien") +
    `<div class="chips comp-chips" role="group" aria-label="Kategorie wählen">${chips}</div>
    <div class="focus-grid"><section class="focus-card"><h2>Unterkategorien</h2><p>Fadenbreite = Betrag, gestrichelt = Breite in ${esc(pl)}</p>
      <div class="flow" id="comp-flow"></div>
      <div class="scroll-x"><table class="depth-table comp-table"><thead><tr><th>Unterkategorie</th><th class="num">${esc(cur)}</th><th class="num">${esc(pl)}</th><th class="num">Differenz</th><th class="num">Anteil</th></tr></thead><tbody>
      ${data.children.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${money0(c.amount)}</td><td class="num">${money0(c.prev)}</td>
        <td class="num ${c.amount > c.prev ? "out-tone" : c.amount < c.prev ? "in-tone" : ""}">${UI.signed(eurOf(c.amount - c.prev))}</td><td class="num">${UI.pct((c.amount / (data.amount || 1)) * 100, 0)}</td></tr>`).join("")}</tbody></table></div></section>
      <aside class="focus-card compare">
        ${cmpRow(esc(cur), UI.money0(total), UI.equiv(total), bad)}
        ${prev != null ? cmpRow(esc(pl), UI.money0(prev), diff != null ? `${UI.signed(diff)} · ${prev ? UI.signed((diff / prev) * 100, (x) => UI.pct(x, 0)) : "neu"}` : "") : ""}
        ${soll != null ? cmpRow("Plan bis heute", UI.money0(soll), `${UI.pct(plan.progress * 100, 0)} des Zeitraums${state.cats.get(id)?.fixed ? " · Fixkosten voll" : ""}`) : ""}
        ${data.children.filter((c) => c.partners.length).slice(0, 3).map((c) => cmpRow(`Größte bei ${esc(c.name)}`, esc(c.partners[0].name.length > 26 ? `${c.partners[0].name.slice(0, 25)}…` : c.partners[0].name), money0(c.partners[0].amount))).join("")}
        ${depthButton}</aside></div>`;
  wireDepth(body, "zusammensetzung");
  $$(".comp-chips button", body).forEach((b) => (b.onclick = () => { dash.flowCat = +b.dataset.cat; focusComposition(body); }));
  if (data.children.length) {
    Flow.branch($("#comp-flow", body), {
      source: { name: data.name, value: total, prev },
      children: data.children.map((c) => ({ name: c.name, value: eurOf(c.amount), prev: data.prev != null ? eurOf(c.prev) : null, disc })),
    }, { format: (v) => UI.money0(v), prevLabel: pl, label: `${data.name}: Unterkategorien gegen ${pl}` });
  } else {
    $("#comp-flow", body).innerHTML = `<p class="empty-note">Keine Ausgaben in diesem oder dem Vergleichszeitraum.</p>`;
  }
}
function depthComposition(body) {
  disposeCharts(3);
  const data = dash.composition;
  const pl = prevLabelOf(data.prev_range);
  const rows = data.children.flatMap((c) => [`<tr><td><b>${esc(c.name)}</b></td><td class="num"><b>${money(c.amount)}</b></td><td class="num">${money(c.prev)}</td><td class="num">${UI.signed(eurOf(c.amount - c.prev), (v) => money(v * 100))}</td><td class="num">${UI.pct((c.amount / (data.amount || 1)) * 100)}</td><td class="num equiv">${UI.equiv(eurOf(c.amount))}</td></tr>`,
    ...c.partners.map((p) => `<tr class="child"><td>${esc(p.name)}</td><td class="num">${money(p.amount)}</td><td></td><td></td><td class="num">${UI.pct((p.amount / (data.amount || 1)) * 100)}</td><td class="num equiv">${UI.equiv(eurOf(p.amount))}</td></tr>`)]);
  body.innerHTML = focusHead(`${esc(data.name)} – exakte Zahlen`, `${periodLabel()} gegen ${esc(pl)}`, false, "kategorien") +
    `<div class="depth-grid"><section class="focus-card scroll-x"><table class="depth-table"><thead><tr><th>Unterkategorie / Empfänger</th><th class="num">Betrag</th><th class="num">${esc(pl)}</th><th class="num">Differenz</th><th class="num">Anteil</th><th class="num">Alltagsäquivalent</th></tr></thead><tbody>${rows.join("")}</tbody></table></section>
     <aside class="focus-card form-grid"><button type="button" id="comp-tx">Alle Umsätze dieser Kategorie →</button></aside></div>`;
  $("#comp-tx", body).onclick = () => {
    state.returnTo = { key: "zusammensetzung", level: 3 };
    zoom.go(1, false).then(() => goToTransactions({ from: dash.period.range.from, to: dash.period.range.to, category: data.id, direction: "" }));
  };
}

/** Aus einer Zoomstufe in die Umsätze springen; Esc führt dorthin zurück. */
function openTransactions({ month, category = "", direction = "" }) {
  state.returnTo = zoom.level > 1 ? { key: zoom.key, level: zoom.level } : null;
  const [from, to] = monthRange(month);
  zoom.go(1, false).then(() => goToTransactions({ from, to, category, direction }));
}

const zoom = new UI.Zoom({
  crumbs: [{ label: "Finanzen", href: "./#dashboard" }],
  overview: "Übersicht",
  prefix: "dashboard/",
  context,
  items: {
    ausgaben: { label: "Ausgaben", tone: "violet", focus: focusAusgaben, depth: depthAusgaben, depthLabel: "Tabelle" },
    sparquote: { label: "Sparquote", tone: "teal", focus: focusSparquote, depth: depthSparquote, depthLabel: "Tabelle" },
    kategorien: { label: "Kategorien", tone: "sky", focus: focusKategorien, depth: depthKategorien, depthLabel: "Tabelle" },
    zusammensetzung: { label: "Zusammensetzung", tone: "sky", focus: focusComposition, depth: depthComposition, depthLabel: "Tabelle" },
  },
  onEscapeTop: () => {
    if (state.view === "dashboard") return;
    const back = state.returnTo;
    state.returnTo = null;
    showView("dashboard");
    if (back) zoom.open(back.key, back.level, null, false);
  },
});

function renderAppCrumbs() {
  if (state.view === "dashboard") { zoom.crumbTarget = "#crumbs"; zoom.renderCrumbs(); $("#context").textContent = context(); return; }
  zoom.crumbTarget = null;
  const label = { transactions: "Umsätze", categories: "Kategorien & Regeln", import: "Import" }[state.view];
  const back = state.returnTo;
  const via = back ? `<span class="sep">›</span><a href="#" data-return="2">${esc(zoom.items[back.key].label)}</a>${back.level === 3 ? `<span class="sep">›</span><a href="#" data-return="3">Tabelle</a>` : ""}` : "";
  $("#crumbs").innerHTML = `<a href="./#dashboard" data-home>Finanzen</a><span class="sep">›</span><a href="#" data-home>Übersicht</a>${via}<span class="sep">›</span><span aria-current="page">${label}</span>`;
  $("#context").innerHTML = `<kbd>Esc</kbd> zurück${back ? " zur Tabelle" : " zur Übersicht"}`;
}

// ------------------------------------------------------------------ Umsätze
function goToTransactions({ from, to, category = "", direction = "", q = "" }) {
  if (from && to) {
    state.period = "custom";
    state.from = from;
    state.to = to;
    $("#date-from").value = from;
    $("#date-to").value = to;
    $$("#period-presets button").forEach((b) => b.classList.remove("active"));
    updateMonthStep();
  }
  $("#tx-category").value = String(category);
  $("#tx-direction").value = direction;
  $("#tx-search").value = q;
  showView("transactions");
}

let txSeq = 0;
async function loadTransactions(append = false) {
  if (!append) loadQuick();
  const seq = ++txSeq;
  const tx = state.tx;
  if (!append) { tx.offset = 0; tx.selected.clear(); }
  const query = filterQuery({
    q: $("#tx-search").value.trim(), category: $("#tx-category").value, direction: $("#tx-direction").value,
    sort: $("#tx-sort").value, limit: 200, offset: tx.offset,
  });
  try {
    const data = await api("GET", `/api/transactions?${query}`);
    if (seq !== txSeq) return;
    tx.items = append ? tx.items.concat(data.items) : data.items;
    tx.total = data.total;
    tx.offset = tx.items.length;
    $("#tx-summary").textContent = `${data.total.toLocaleString("de-DE")} Buchungen · Summe ${money(data.sum)}` +
      (state.from ? ` · ${dateDe(state.from)} – ${dateDe(state.to)}` : "");
    renderTransactions();
  } catch (e) {
    toast(e.message, { error: true });
  }
}

function renderTransactions() {
  const { items, total, selected } = state.tx;
  $("#tx-body").innerHTML = items.length ? items.map((x) => `
    <tr data-id="${x.id}" class="${selected.has(x.id) ? "selected" : ""}">
      <td class="check"><input type="checkbox" ${selected.has(x.id) ? "checked" : ""} aria-label="Auswählen"></td>
      <td class="date">${dateDe(x.date)}</td>
      <td><div class="who">${esc(x.counterparty || "–")}</div>
        <div class="why" title="${esc(x.purpose)}">${[x.purpose, x.booking_text].filter(Boolean).map(esc).join(" · ")}</div>
        ${x.note ? `<div class="why"><i>Notiz:</i> ${esc(x.note)}</div>` : ""}</td>
      <td class="acct">${esc(x.account)}</td>
      <td><select class="${x.category_id ? "" : "uncat"}" aria-label="Kategorie">
        <option value="">– Nicht kategorisiert –</option>${categoryOptions(x.category_id)}</select>
        ${x.manual ? `<span class="manual" title="Von Hand gesetzt – Regeln ändern diese Buchung nicht">✎</span>` : ""}
        <button class="note-btn" title="Notiz hinzufügen">Notiz</button></td>
      <td class="num ${x.amount > 0 ? "pos" : ""}">${money(x.amount)}</td>
    </tr>`).join("") : `<tr><td colspan="6" class="empty-note">Keine Buchungen für diese Filter.</td></tr>`;
  $("#tx-more").hidden = items.length >= total;
  updateBulkbar();
}

function updateBulkbar() {
  const n = state.tx.selected.size;
  $("#bulkbar").hidden = n === 0;
  $("#bulk-count").textContent = `${n} ausgewählt`;
  $("#tx-all").checked = n > 0 && n === state.tx.items.length;
}

async function setTxCategory(id, categoryId) {
  const tx = state.tx.items.find((x) => x.id === id);
  const updated = await api("PATCH", `/api/transactions/${id}`, { category_id: categoryId });
  Object.assign(tx, updated);
  renderTransactions();
  if (categoryId && tx.counterparty) {
    toast(`Kategorie gesetzt: ${catName(categoryId)}`, {
      action: { label: `Regel für „${tx.counterparty.slice(0, 24)}“`, run: () => openRuleDialog(null, { field: "counterparty", op: "contains", pattern: tx.counterparty, category_id: categoryId, direction: tx.amount < 0 ? "out" : "in" }) },
    });
  }
}

// ------------------------------------------------------------------ Schnell zuordnen
let quickLimit = 15;
let quickGroups = [];
async function loadQuick() {
  const data = await api("GET", `/api/suggestions?limit=${quickLimit}`).catch(() => null);
  if (!data) return;
  quickGroups = data.groups;
  $("#quick").hidden = !data.total;
  $("#quick-title").textContent = `Schnell zuordnen · ${data.total.toLocaleString("de-DE")} Buchungen ohne Kategorie`;
  $("#quick-more").hidden = data.groups.length < quickLimit;
  $("#quick-body").innerHTML = data.groups.map((g, i) => `
    <tr data-i="${i}">
      <td><b>${esc(g.name)}</b>${g.variants.length > 1 ? `<div class="variants">auch: ${esc(g.variants.slice(1).join(" · "))}</div>` : ""}</td>
      <td class="num">${g.count}</td>
      <td class="num ${g.sum > 0 ? "pos" : ""}">${money(g.sum)}</td>
      <td><select aria-label="Kategorie für ${esc(g.name)}"><option value="">– wählen –</option>${categoryOptions()}</select></td>
      <td><button class="ghost" data-show="${i}">Ansehen</button></td>
    </tr>`).join("");
}

async function assignGroup(i, categoryId) {
  const g = quickGroups[i];
  const res = await api("POST", "/api/rules", {
    category_id: categoryId, field: "counterparty", op: g.op, pattern: g.pattern, direction: g.direction, priority: 90,
  });
  toast(`Regel angelegt: „${g.name}“ → ${catName(categoryId)} · ${res.changed} Buchungen zugeordnet`);
  await loadTransactions();
}

// ------------------------------------------------------------------ Kategorien & Regeln
let rulesCache = [];
async function renderCategoriesView() {
  await loadCategories();
  rulesCache = await api("GET", "/api/rules");
  loadPlan();
  const parents = state.categories.filter((c) => !c.parent_id);
  const row = (c, child) => `
    <div class="cat-row${child ? " child" : ""}" data-id="${c.id}">
      <span class="name">${esc(c.name)}</span>
      ${c.fixed ? `<span class="kind-tag">Fixkosten</span>` : ""}
      ${c.disc && !child ? `<span class="tag-disc">steuerbar</span>` : ""}
      ${!child ? `<span class="kind-tag">${KIND_LABEL[c.kind]}</span>` : ""}
      ${c.budget ? `<span class="meta">Budget ${money0(c.budget)}</span>` : ""}
      <span class="meta">${c.tx_count} Buchungen · ${c.rule_count} Regeln</span>
    </div>`;
  $("#cat-list").innerHTML = parents.map((p) => `<div class="cat-group">${row(p)}${state.categories.filter((c) => c.parent_id === p.id).map((c) => row(c, true)).join("")}</div>`).join("")
    || `<p class="empty-note">Noch keine Kategorien.</p>`;
  $$("#cat-list .cat-row").forEach((el) => (el.onclick = () => openCategoryDialog(state.cats.get(+el.dataset.id))));

  $("#rule-list").innerHTML = rulesCache.map((r) => {
    const c = state.cats.get(r.category_id);
    const amount = [r.min_amount != null ? `ab ${money(r.min_amount)}` : "", r.max_amount != null ? `bis ${money(r.max_amount)}` : ""].filter(Boolean).join(" ");
    return `<div class="rule${r.enabled ? "" : " disabled"}" data-id="${r.id}">
      <div class="cond">${FIELD_LABEL[r.field]} ${OP_LABEL[r.op]} <code>${esc(r.pattern)}</code></div>
      <div class="target">→ ${esc(catName(r.category_id))}</div>
      <div class="meta">${r.direction === "out" ? "nur Ausgaben" : r.direction === "in" ? "nur Einnahmen" : "Ein- & Ausgänge"}${amount ? ` · ${amount}` : ""} · Priorität ${r.priority}${r.enabled ? "" : " · deaktiviert"}</div>
    </div>`;
  }).join("") || `<p class="empty-note">Noch keine Regeln.</p>`;
  $$("#rule-list .rule").forEach((el) => (el.onclick = () => openRuleDialog(rulesCache.find((r) => r.id === +el.dataset.id))));
}

// ------------------------------------------------------------------ Monatsplan: Sparziel und Budgets
// Ein Gesamtziel (Sparquote); Ausgabenrahmen = Ø Einkommen × (1 − Ziel). Nicht gesperrte Budgets bewegen sich im Verhältnis.
const plan = { m: null, inc: 0, goal: 20, budgets: new Map(), dirty: new Set(), goalDirty: false, timer: null };
const planCats = () => state.categories.filter((c) => !c.parent_id && c.kind === "expense");
const planFrame = (goal = plan.goal) => plan.inc * (1 - goal / 100);
const planSum = (ids) => ids.reduce((s, id) => s + (plan.budgets.get(id) || 0), 0);

async function loadPlan() {
  plan.m = await UI.loadMeasures();
  plan.inc = eurOf(plan.m?.avg_income);
  plan.goal = plan.m?.targets?.savings_rate ?? 20;
  plan.budgets = new Map(planCats().map((c) => [c.id, eurOf(c.budget || plan.m?.category_avg?.[String(c.id)])]));
  plan.dirty.clear();
  plan.goalDirty = false;
  renderPlan();
}

function renderPlan() {
  const cats = planCats().sort((a, b) => (plan.budgets.get(b.id) || 0) - (plan.budgets.get(a.id) || 0));
  const frame = planFrame();
  const sum = planSum(cats.map((c) => c.id));
  const goalAmt = plan.inc * (plan.goal / 100);
  $("#plan-goal").value = plan.goal;
  $("#plan-goal-v").textContent = plan.inc ? `${plan.goal} % = ${UI.money0(goalAmt)}` : `${plan.goal} %`;
  $("#plan-frame").textContent = plan.inc ? UI.money0(frame) : "–";
  const gap = frame - sum;
  $("#plan-frame-s").innerHTML = !plan.inc ? "Noch kein Einkommen in den letzten Monaten erkannt."
    : `Ø Einkommen ${UI.money0(plan.inc)} · verteilt ${UI.money0(sum)}${Math.abs(gap) >= 5 ? ` · <span class="${gap < 0 ? "sig-bad" : ""}">${gap < 0 ? `${UI.money0(-gap)} über dem Rahmen` : `${UI.money0(gap)} frei`}</span> <button type="button" id="plan-fit">Auf Rahmen verteilen</button>` : " ✓"}`;
  const max = Math.max(50, Math.ceil(Math.max(frame, ...cats.map((c) => (plan.budgets.get(c.id) || 0) * 1.5)) / 50) * 50);
  $("#plan-table").innerHTML = `<thead><tr><th>Kategorie</th><th>Budget pro Monat</th><th class="num">€</th><th class="num">Ø 6 Monate</th><th class="num">Anteil</th><th title="Gesperrte Budgets bleiben beim Verschieben stehen">gesperrt</th><th title="Ausgaben, die du direkt beeinflussen kannst">steuerbar</th></tr></thead><tbody>
    ${cats.map((c) => {
      const b = plan.budgets.get(c.id) || 0;
      const avg = plan.m?.category_avg?.[String(c.id)];
      return `<tr><td>${esc(c.name)}${c.fixed ? ` <span class="kind-tag">Fixkosten</span>` : ""}${!c.budget && !plan.dirty.has(c.id) ? ` <span class="muted" title="Noch kein Budget gesetzt – Startwert ist der Durchschnitt">(Ø)</span>` : ""}</td>
      <td><input type="range" data-budget="${c.id}" min="0" max="${max}" step="5" value="${Math.round(b)}" ${c.locked ? "disabled" : ""} aria-label="Budget ${esc(c.name)}"></td>
      <td class="num">${UI.money0(b)}</td><td class="num muted">${avg ? money0(avg) : "–"}</td>
      <td class="num">${frame > 0 ? UI.pct((b / frame) * 100, 0) : "–"}</td>
      <td><input type="checkbox" data-lock="${c.id}" ${c.locked ? "checked" : ""} aria-label="${esc(c.name)} sperren"></td>
      <td><input type="checkbox" data-disc="${c.id}" ${c.disc ? "checked" : ""} aria-label="${esc(c.name)} steuerbar"></td></tr>`;
    }).join("") || `<tr><td colspan="7" class="empty-note">Noch keine Ausgaben-Kategorien.</td></tr>`}</tbody>`;
  $$("#plan-table [data-budget]").forEach((r) => {
    r.oninput = () => { r.closest("tr").children[2].textContent = UI.money0(+r.value); };
    r.onchange = () => setPlanBudget(+r.dataset.budget, +r.value);
  });
  $$("#plan-table [data-lock]").forEach((x) => (x.onchange = () => saveCategoryFlag(+x.dataset.lock, { locked: x.checked })));
  $$("#plan-table [data-disc]").forEach((x) => (x.onchange = () => saveCategoryFlag(+x.dataset.disc, { disc: x.checked })));
  const fit = $("#plan-fit");
  if (fit) fit.onclick = () => {
    const free = planCats().filter((c) => !c.locked).map((c) => c.id);
    scalePlan(free, (planFrame() - planSum(planCats().filter((c) => c.locked).map((c) => c.id))) / Math.max(1, planSum(free)));
  };
}

function scalePlan(ids, f) {
  for (const id of ids) { plan.budgets.set(id, Math.max(0, (plan.budgets.get(id) || 0) * f)); plan.dirty.add(id); }
  renderPlan();
  queuePlanSave();
}
/** Sparziel verschieben: nicht gesperrte Budgets skalieren so, dass der Abstand zum Rahmen im Verhältnis bleibt. */
function setPlanGoal(pct) {
  const cats = planCats(), free = cats.filter((c) => !c.locked).map((c) => c.id);
  const lockedSum = planSum(cats.filter((c) => c.locked).map((c) => c.id));
  const f = (planFrame(pct) - lockedSum) / Math.max(1, planFrame() - lockedSum);
  plan.goal = pct;
  plan.goalDirty = true;
  scalePlan(free, Math.max(0, f));
}
/** Ein Budget verschieben: die übrigen nicht gesperrten gleichen es im Verhältnis aus. */
function setPlanBudget(id, value) {
  const free = planCats().filter((c) => c.id !== id && !c.locked).map((c) => c.id);
  const pool = planSum(free), delta = value - (plan.budgets.get(id) || 0);
  plan.budgets.set(id, value);
  plan.dirty.add(id);
  if (pool > 0) for (const k of free) { plan.budgets.set(k, Math.max(0, plan.budgets.get(k) - (delta * plan.budgets.get(k)) / pool)); plan.dirty.add(k); }
  renderPlan();
  queuePlanSave();
}
function queuePlanSave() {
  clearTimeout(plan.timer);
  $("#plan-saved").textContent = "…";
  plan.timer = setTimeout(savePlan, 700);
}
async function savePlan() {
  try {
    const ids = [...plan.dirty];
    plan.dirty.clear();
    await Promise.all(ids.map((id) => api("PUT", `/api/categories/${id}`, { budget: Math.round(plan.budgets.get(id) || 0) })));
    if (plan.goalDirty) {
      plan.goalDirty = false;
      await api("PUT", "/api/depot/settings", { targets: { ...(plan.m?.targets || {}), savings_rate: plan.goal } });
    }
    await loadCategories();
    $("#plan-saved").textContent = "✓ gespeichert";
  } catch (e) {
    $("#plan-saved").textContent = "";
    toast(`Monatsplan nicht gespeichert: ${e.message}`, { error: true });
  }
}
async function saveCategoryFlag(id, body) {
  try {
    await api("PUT", `/api/categories/${id}`, body);
    await loadCategories();
    renderPlan();
    $("#plan-saved").textContent = "✓ gespeichert";
  } catch (e) {
    toast(`Nicht gespeichert: ${e.message}`, { error: true });
  }
}

let editingCategory = null;
function openCategoryDialog(cat) {
  editingCategory = cat || null;
  const f = $("#cat-form");
  $("#cat-dialog-title").textContent = cat ? "Kategorie bearbeiten" : "Neue Kategorie";
  $("#cat-error").textContent = "";
  f.name.value = cat?.name || "";
  f.parent_id.innerHTML = `<option value="">– keine (Oberkategorie) –</option>` +
    state.categories.filter((c) => !c.parent_id && c.id !== cat?.id).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  f.parent_id.value = cat?.parent_id || "";
  f.kind.value = cat?.kind || "expense";
  f.budget.value = cat?.budget ? cat.budget / 100 : "";
  f.fixed.checked = !!cat?.fixed;
  const color = cat?.color || "#898781"; // Farbe wird nicht mehr angezeigt (Graustufen), bleibt aber gespeichert
  const syncKind = () => { f.kind.disabled = !!f.parent_id.value; };
  f.parent_id.onchange = syncKind;
  syncKind();
  $("#cat-delete").hidden = !cat;
  $("#cat-delete").onclick = async () => {
    const kids = state.categories.filter((c) => c.parent_id === cat.id).length;
    if ($("#cat-delete").dataset.confirm !== "1") {
      $("#cat-delete").dataset.confirm = "1";
      $("#cat-delete").textContent = kids ? `Wirklich löschen (inkl. ${kids} Unterkategorien)?` : "Wirklich löschen?";
      return;
    }
    await api("DELETE", `/api/categories/${cat.id}`);
    $("#cat-dialog").close();
    toast(`„${cat.name}“ gelöscht. Betroffene Buchungen wurden neu kategorisiert.`);
    renderCategoriesView();
  };
  $("#cat-delete").dataset.confirm = "";
  $("#cat-delete").textContent = "Löschen";
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    const body = { name: f.name.value, parent_id: f.parent_id.value ? +f.parent_id.value : null, kind: f.kind.value, color, budget: f.budget.value, fixed: f.fixed.checked };
    try {
      await api(cat ? "PUT" : "POST", cat ? `/api/categories/${cat.id}` : "/api/categories", body);
      $("#cat-dialog").close();
      if (state.view === "categories") renderCategoriesView();
      else { await loadCategories(); refreshCurrent(); }
    } catch (err) {
      $("#cat-error").textContent = err.message;
    }
  };
  $("#cat-dialog").showModal();
}

let previewTimer;
function openRuleDialog(rule, preset = {}) {
  const f = $("#rule-form");
  const r = { field: "any", op: "contains", pattern: "", direction: "any", priority: 100, enabled: 1, ...(rule || preset) };
  $("#rule-dialog-title").textContent = rule ? "Regel bearbeiten" : "Neue Regel";
  $("#rule-error").textContent = "";
  f.category_id.innerHTML = `<option value="">– wählen –</option>${categoryOptions(r.category_id)}`;
  for (const k of ["field", "op", "pattern", "direction", "priority"]) f[k].value = r[k];
  f.min_amount.value = r.min_amount != null ? r.min_amount / 100 : "";
  f.max_amount.value = r.max_amount != null ? r.max_amount / 100 : "";
  f.enabled.checked = !!r.enabled;
  f.category_id.value = r.category_id || "";
  const values = () => ({
    field: f.field.value, op: f.op.value, pattern: f.pattern.value, direction: f.direction.value,
    min_amount: f.min_amount.value, max_amount: f.max_amount.value, category_id: f.category_id.value ? +f.category_id.value : null,
    priority: +f.priority.value || 100, enabled: f.enabled.checked ? 1 : 0,
  });
  const preview = async () => {
    const v = values();
    if (!v.pattern.trim()) { $("#rule-preview").innerHTML = `<span class="muted">Muster eingeben, um passende Buchungen zu sehen.</span>`; return; }
    const res = await api("POST", "/api/rules/preview", v).catch((e) => ({ error: e.message }));
    $("#rule-preview").innerHTML = res.error ? `<span style="color:var(--bad-text)">${esc(res.error)}</span>`
      : `<b>${res.count}</b> passende Buchungen (Summe ${money(res.sum)})<ul>${res.items.map((x) => `<li>${dateDe(x.date)} · ${esc(x.counterparty || x.purpose)} · ${money(x.amount)} <span class="muted">(${esc(catName(x.category_id))})</span></li>`).join("")}</ul>`;
  };
  f.oninput = () => { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 250); };
  preview();
  $("#rule-delete").hidden = !rule;
  $("#rule-delete").onclick = async () => {
    const res = await api("DELETE", `/api/rules/${rule.id}`);
    $("#rule-dialog").close();
    toast(`Regel gelöscht · ${res.changed} Buchungen neu kategorisiert`);
    renderCategoriesView();
  };
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    try {
      const res = await api(rule ? "PUT" : "POST", rule ? `/api/rules/${rule.id}` : "/api/rules", values());
      $("#rule-dialog").close();
      toast(`Regel gespeichert · ${res.changed} Buchungen neu kategorisiert`);
      if (state.view === "categories") renderCategoriesView();
      else refreshCurrent();
    } catch (err) {
      $("#rule-error").textContent = err.message;
    }
  };
  $("#rule-dialog").showModal();
}

// ------------------------------------------------------------------ Import
async function uploadFiles(files) {
  const box = $("#import-results");
  for (const file of files) {
    try {
      const res = await api("POST", "/api/import", await file.arrayBuffer(), { "X-Filename": encodeURIComponent(file.name), "Content-Type": "text/csv" });
      box.insertAdjacentHTML("afterbegin", `<div class="result ok"><b>${esc(file.name)}</b>: ${res.rows_new} neue Buchungen, ${res.rows_duplicate} bereits vorhanden
        <div class="muted">${dateDe(res.date_from)} – ${dateDe(res.date_to)} · Konto ${esc(res.account)} · Spalten: ${esc(Object.values(res.columns).join(", "))}</div></div>`);
    } catch (e) {
      box.insertAdjacentHTML("afterbegin", `<div class="result err">${esc(e.message)}</div>`);
    }
  }
  await Promise.all([loadStatus(), loadImportView()]);
  if (state.period !== "custom") [state.from, state.to] = computePeriod(state.period);
}

async function loadImportView() {
  window.BankUI?.render();
  renderBalances();
  renderTransferCheck();
  $("#inbox-path").textContent = state.status?.inbox || "(Überwachung deaktiviert)";
  const rows = await api("GET", "/api/imports");
  $("#import-history").innerHTML = rows.map((r) => `
    <div class="history-row"><div><b>${esc(r.filename)}</b>
      <div class="meta">${esc(r.imported_at)} · ${esc(r.account || "")} · ${r.rows_new} neu / ${r.rows_total} gesamt${r.rows_skipped ? ` · ${r.rows_skipped} übersprungen` : ""}</div></div>
      ${r.rows_new ? `<button class="ghost" data-undo="${r.id}">Rückgängig</button>` : ""}</div>`).join("")
    || `<p class="empty-note">Noch keine Importe.</p>`;
  $$("[data-undo]").forEach((b) => (b.onclick = async () => {
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Buchungen wirklich löschen?"; return; }
    const res = await api("DELETE", `/api/imports/${b.dataset.undo}`);
    toast(`${res.deleted_transactions} Buchungen entfernt`);
    await loadStatus();
    loadImportView();
  }));
}

/** Kontostände je Konto: bekannt (Bank, CSV, von Hand) oder eintragen. Kreditkarten brauchen keinen Eintrag. */
async function renderBalances() {
  const box = $("#balances");
  let rows;
  try { rows = await api("GET", "/api/balances"); } catch { box.innerHTML = ""; return; }
  const SRC = { manuell: "von dir eingetragen", bank: "von der Bank", csv: "aus dem Export" };
  box.innerHTML = rows.map((r) => r.card && !r.anchor
    ? `<div class="bal-row"><div><b>${esc(r.account)}</b><div class="meta">Kreditkarte – setzt sich über die Abrechnung auf null, kein Eintrag nötig${r.open ? ` · offen: ${money(r.open)}` : ""}</div></div></div>`
    : `<form class="bal-row" data-account="${esc(r.account)}"><div><b>${esc(r.account)}</b>
        <div class="meta">${r.anchor ? `heute: <b>${money(r.current)}</b> · ${SRC[r.anchor.source] || r.anchor.source} am ${dateDe(r.anchor.date)}` : `<b>Kontostand unbekannt</b> – einmal eintragen, den Rest rechnet die App aus den Buchungen`}</div></div>
        <label class="bal-input">Stand heute <input type="text" inputmode="decimal" name="amount" placeholder="z. B. 4248,35" aria-label="Kontostand heute für ${esc(r.account)}"></label>
        <button type="submit">Speichern</button></form>`).join("") || `<p class="empty-note">Noch keine Konten importiert.</p>`;
  $$("#balances form").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const amount = f.amount.value.trim().replace(/\./g, "").replace(",", ".");
    if (!amount || isNaN(+amount)) { toast("Bitte einen Betrag eingeben, z. B. 4248,35", { error: true }); return; }
    await api("PUT", "/api/balances", { account: f.dataset.account, amount: +amount, date: iso(new Date()) });
    toast(`Kontostand für ${f.dataset.account} gespeichert`);
    renderBalances();
  }));
}

/** Kreditkarten-Check: Ergebnis des automatischen Abgleichs, mit Sprung zu den betroffenen Buchungen. */
async function renderTransferCheck() {
  const box = $("#transfer-check");
  let r;
  try { r = await api("GET", "/api/transfers"); } catch { box.innerHTML = ""; return; }
  const cards = r.card_accounts.length ? r.card_accounts.map(esc).join(", ") : null;
  box.innerHTML = `<ul class="check-list">
      <li>${cards ? `✓ Kartenkonto importiert: <b>${cards}</b>` : `<span class="muted">Kein Kreditkartenkonto importiert.</span>`}</li>
      <li>${r.pairs + r.settled ? `✓ <b>${r.pairs + r.settled}</b> Abrechnung${r.pairs + r.settled === 1 ? "" : "en"} mit Kartenumsätzen abgeglichen – zählen als Umbuchung, nicht doppelt` : `Keine Kreditkartenabrechnung zum Abgleichen gefunden.`}</li>
      ${r.unmatched.length ? `<li class="warn">⚠ <b>${r.unmatched.length}</b> Abrechnung${r.unmatched.length === 1 ? "" : "en"} ohne passende Kartenumsätze (Karte nicht importiert oder Zeitraum fehlt) – zählen als Ausgabe, damit die Käufe nicht fehlen.
        Importierst du die Kartenumsätze dieses Zeitraums, werden sie automatisch zur Umbuchung.
        <div class="check-rows">${r.unmatched.slice(-5).reverse().map((u) => `<button type="button" class="ghost" data-q="${esc(u.counterparty || "")}" data-date="${u.date}">${dateDe(u.date)} · ${esc(u.counterparty || "–")} · ${money(u.amount)}</button>`).join("")}</div></li>` : ""}
    </ul>`;
  $$("#transfer-check [data-q]").forEach((b) => (b.onclick = () => goToTransactions({ q: b.dataset.q, from: b.dataset.date, to: b.dataset.date })));
}

// ------------------------------------------------------------------ Verdrahtung
function wire() {
  $$(".tabs button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  window.addEventListener("hashchange", () => {
    const v = location.hash.slice(1).split("/")[0];
    if (["dashboard", "transactions", "categories", "import"].includes(v) && v !== state.view) showView(v);
  });
  // ⤢ öffnet die Vollbild-Ansicht einer Karte; Budget-Zeile öffnet die Zusammensetzung der Kategorie
  $("#view-dashboard").addEventListener("click", (e) => {
    const z = e.target.closest("[data-zoom]");
    if (z) return zoom.open(z.dataset.zoom, 2, z.closest(".card, .kpi") || z);
    const row = e.target.closest(".budget-row");
    if (row) { dash.flowCat = +row.dataset.cat; zoom.open("zusammensetzung", 2, row); }
  });
  $("#view-dashboard").addEventListener("keydown", (e) => {
    const row = e.target.closest(".budget-row");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); dash.flowCat = +row.dataset.cat; zoom.open("zusammensetzung", 2, row); }
  });
  $("#crumbs").addEventListener("click", (e) => {
    const a = e.target.closest("[data-home], [data-return]");
    if (!a || state.view === "dashboard") return;
    e.preventDefault();
    const back = a.dataset.return ? { ...state.returnTo, level: +a.dataset.return } : null;
    showView("dashboard");
    if (back) zoom.open(back.key, back.level, null, false);
  });
  $$("#period-presets button").forEach((b) => (b.onclick = () => setPeriod(b.dataset.period)));
  $("#month-prev").onclick = () => stepMonth(-1);
  $("#month-next").onclick = () => stepMonth(1);
  const customRange = () => {
    if ($("#date-from").value && $("#date-to").value) setPeriod("custom", $("#date-from").value, $("#date-to").value);
  };
  $("#date-from").onchange = customRange;
  $("#date-to").onchange = customRange;
  $("#account-filter").onchange = (e) => { state.account = e.target.value; saveUrl(); refreshCurrent(); };

  let searchTimer;
  $("#tx-search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadTransactions(), 250); };
  ["#tx-category", "#tx-direction", "#tx-sort"].forEach((s) => ($(s).onchange = () => loadTransactions()));
  $("#tx-more").onclick = () => loadTransactions(true);
  $("#tx-body").addEventListener("change", async (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const id = +tr.dataset.id;
    if (e.target.type === "checkbox") {
      e.target.checked ? state.tx.selected.add(id) : state.tx.selected.delete(id);
      tr.classList.toggle("selected", e.target.checked);
      updateBulkbar();
    } else if (e.target.tagName === "SELECT") {
      try { await setTxCategory(id, e.target.value ? +e.target.value : null); } catch (err) { toast(err.message, { error: true }); }
    }
  });
  $("#tx-body").addEventListener("click", async (e) => {
    if (!e.target.classList.contains("note-btn")) return;
    const id = +e.target.closest("tr").dataset.id;
    const tx = state.tx.items.find((x) => x.id === id);
    const td = e.target.closest("td");
    const input = document.createElement("input");
    input.value = tx.note || "";
    input.placeholder = "Notiz … (Enter speichert)";
    input.style.cssText = "display:block;margin-top:4px;width:100%";
    td.append(input);
    input.focus();
    input.onkeydown = async (ev) => {
      if (ev.key === "Escape") return input.remove();
      if (ev.key !== "Enter") return;
      Object.assign(tx, await api("PATCH", `/api/transactions/${id}`, { note: input.value }));
      renderTransactions();
    };
  });
  $("#quick-body").addEventListener("change", async (e) => {
    if (e.target.tagName !== "SELECT" || !e.target.value) return;
    const tr = e.target.closest("tr");
    tr.classList.add("done");
    try { await assignGroup(+tr.dataset.i, +e.target.value); } catch (err) { tr.classList.remove("done"); toast(err.message, { error: true }); }
  });
  $("#quick-body").addEventListener("click", (e) => {
    const i = e.target.dataset.show;
    if (i === undefined) return;
    $("#tx-category").value = "0";
    $("#tx-search").value = quickGroups[+i].variants[0];
    loadTransactions();
  });
  $("#quick-more").onclick = () => { quickLimit += 30; loadQuick(); };
  $("#quick-newcat").onclick = () => openCategoryDialog(null);
  $("#tx-all").onchange = (e) => {
    state.tx.selected = new Set(e.target.checked ? state.tx.items.map((x) => x.id) : []);
    renderTransactions();
  };
  $("#bulk-clear").onclick = () => { state.tx.selected.clear(); renderTransactions(); };
  $("#bulk-apply").onclick = async () => {
    const v = $("#bulk-category").value;
    const res = await api("POST", "/api/transactions/categorize", { ids: [...state.tx.selected], category_id: v ? +v : null });
    toast(`${res.updated} Buchungen aktualisiert`);
    loadTransactions();
  };

  $("#cat-new").onclick = () => openCategoryDialog(null);
  $("#rule-new").onclick = () => openRuleDialog(null);
  $("#rules-apply").onclick = async () => {
    const res = await api("POST", "/api/rules/apply", {});
    toast(`${res.changed} Buchungen neu kategorisiert`);
    renderCategoriesView();
  };

  const dz = $("#dropzone");
  $("#file-input").onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ""; };
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); uploadFiles([...e.dataTransfer.files]); });

  // Theme-Wechsel: Diagramme mit den Farben des neuen Modus neu zeichnen
  const retheme = () => { if (dash.m) { renderStart(); if (zoom.level > 1) zoom.refresh(); } };
  $("#carry-toggle").checked = PREFS.carry;
  $("#carry-toggle").onchange = (e) => { PREFS.carry = e.target.checked; retheme(); };
  $("#pair-select").value = PREFS.pair;
  $("#pair-select").onchange = (e) => { PREFS.pair = e.target.value; };   // Farben kommen aus CSS-Variablen
  $("#plan-goal").oninput = (e) => setPlanGoal(+e.target.value);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-scheme"] });
}

// Neue Dateien aus der Inbox (automatischer Import) erkennen und die Ansicht auffrischen
async function poll() {
  if (document.hidden) return;                     // Tab im Hintergrund: nichts abfragen
  try {
    const before = state.status?.count;
    const version = state.status?.version;
    await loadStatus();
    if (version !== undefined && state.status.version !== version) {
      const added = state.status.count - before;
      if (added > 0) toast(`${added} neue Buchung${added === 1 ? "" : "en"} eingegangen – Übersicht aktualisiert`);
      if (state.period !== "custom") [state.from, state.to] = computePeriod(state.period);
      // Live: Übersicht, Umsätze und Import zeichnen sich neu (im Vollbild bleibt die Ansicht stehen)
      if (["dashboard", "transactions", "import"].includes(state.view) && !(state.view === "dashboard" && zoom.level > 1)) refreshCurrent();
    }
  } catch { /* Server kurz weg – beim nächsten Mal wieder */ }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

async function init() {
  UI.initMotion();
  wire();
  const params = new URLSearchParams(location.search);
  state.account = params.get("account") || "";
  try {
    await Promise.all([loadStatus(), loadCategories()]);
  } catch (e) {
    toast(`Server nicht erreichbar: ${e.message}`, { error: true });
    return;
  }
  const view = location.hash.slice(1).split("/")[0];
  state.view = ["dashboard", "transactions", "categories", "import"].includes(view) ? view : "dashboard";
  const zoomHash = location.hash.slice(1);
  const period = params.get("period") || "month";   // Startseite = laufender (Gehalts-)Monat
  state.period = period;
  [state.from, state.to] = period === "custom" ? [params.get("from"), params.get("to")] : computePeriod(period);
  $("#date-from").value = state.from || "";
  $("#date-to").value = state.to || "";
  $$("#period-presets button").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
  updateMonthStep();
  showView(state.view);
  if (state.view === "dashboard" && zoomHash.includes("/")) {
    history.replaceState(null, "", `${location.pathname}${location.search}#${zoomHash}`);
    await loadDashboard();
    zoom.fromHash(false);
  }
  setInterval(poll, 15000);
}

init();
