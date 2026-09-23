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
// Kategorie-Farben werden in der hellen Variante gespeichert; im Dunkelmodus
// wird jeder Palettenplatz auf seine eigene, für dunkle Flächen gewählte Stufe gemappt.
const LIGHT_SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const DARK_SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
const catColor = (hex) => {
  const i = LIGHT_SERIES.indexOf((hex || "").toLowerCase());
  return i >= 0 && isDark() ? DARK_SERIES[i] : hex || css("--neutral");
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function theme() {
  return {
    surface: css("--surface-1"), surface2: css("--surface-2"), text: css("--text-primary"), text2: css("--text-secondary"),
    muted: css("--axis-muted"), grid: css("--grid"), baseline: css("--baseline"), good: css("--good"),
    series: Array.from({ length: 8 }, (_, i) => css(`--series-${i + 1}`)), neutral: css("--neutral"),
    seq: css("--seq").split(",").map((s) => s.trim()),
  };
}

function baseOption(t) {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: css("--font"), color: t.text2 },
    animationDuration: 500,
    tooltip: {
      backgroundColor: t.surface, borderColor: t.grid, borderWidth: 1, padding: [8, 12],
      textStyle: { color: t.text, fontSize: 12.5 }, extraCssText: "box-shadow: 0 6px 20px rgba(0,0,0,.14); border-radius: 8px;",
    },
    legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 12, itemHeight: 12, itemGap: 16, textStyle: { color: t.text2, fontSize: 12.5 } },
  };
}
const valueAxis = (t, extra = {}) => ({
  type: "value",
  axisLabel: { color: t.muted, fontSize: 11.5, formatter: moneyAxis },
  splitLine: { lineStyle: { color: t.grid, width: 1, type: "solid" } },
  axisLine: { show: false }, axisTick: { show: false },
  ...extra,
});
const categoryAxis = (t, data, extra = {}) => ({
  type: "category", data,
  axisLabel: { color: t.muted, fontSize: 11.5 },
  axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false },
  ...extra,
});
const swatch = (color) => `<span class="dot" style="background:${color}"></span>`;
const tipRow = (color, label, value) =>
  `<div style="display:flex;gap:10px;justify-content:space-between;align-items:center"><span style="display:flex;gap:6px;align-items:center">${swatch(color)}${esc(label)}</span><b style="font-variant-numeric:tabular-nums">${value}</b></div>`;

// ------------------------------------------------------------------ Zustand
const state = {
  view: "dashboard",
  period: "12m",
  from: null,
  to: null,
  account: "",
  status: null,
  categories: [],
  cats: new Map(),
  dash: null,
  tx: { items: [], total: 0, offset: 0, selected: new Set() },
};

function computePeriod(period) {
  const max = state.status?.max ? new Date(`${state.status.max}T00:00`) : new Date();
  const today = new Date();
  const ref = max < today ? max : today; // "jetzt" = letzte Buchung, damit ältere Exporte sinnvoll aussehen
  const y = ref.getFullYear(), m = ref.getMonth();
  switch (period) {
    case "month": return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case "lastmonth": return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case "3m": return [iso(new Date(y, m - 2, 1)), iso(new Date(y, m + 1, 0))];
    case "12m": return [iso(new Date(y, m - 11, 1)), iso(new Date(y, m + 1, 0))];
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
  saveUrl();
  refreshCurrent();
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
  history.replaceState(null, "", `?${p}#${state.view}`);
}

// ------------------------------------------------------------------ Navigation
function showView(view) {
  state.view = view;
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $("#filterbar").hidden = !["dashboard", "transactions"].includes(view);
  saveUrl();
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

// ------------------------------------------------------------------ Dashboard
const charts = new Map();
function chartFor(card) {
  const el = $(`[data-card="${card}"] .chart`);
  let chart = charts.get(card);
  if (!chart || chart.isDisposed()) {
    chart = echarts.init(el, null, { renderer: "svg" });
    charts.set(card, chart);
    new ResizeObserver(() => chart.resize()).observe(el);
  }
  return chart;
}

// Jede Karte bekommt einen Umschalter Diagramm <-> Tabelle (Werte nie nur per Tooltip erreichbar).
const tables = {};
function setupTableToggles() {
  $$(".card[data-card]").forEach((card) => {
    const name = card.dataset.card;
    if (["budgets", "largest"].includes(name)) return;
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "Tabelle";
    btn.setAttribute("aria-pressed", "false");
    const holder = document.createElement("div");
    holder.className = "data-table";
    holder.hidden = true;
    card.append(holder);
    btn.onclick = () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = on ? "Diagramm" : "Tabelle";
      $(".chart", card).hidden = on;
      holder.hidden = !on;
      if (on) renderTable(name);
      else charts.get(name)?.resize();
    };
    $("header", card).append(btn);
  });
}
function renderTable(name) {
  const holder = $(`[data-card="${name}"] .data-table`);
  if (!holder || holder.hidden || !tables[name]) return;
  const { columns, rows } = tables[name]();
  holder.innerHTML = `<table><thead><tr>${columns.map((c, i) => `<th${i ? ' class="num"' : ""}>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td${i ? ' class="num"' : ""}>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

let dashSeq = 0;
async function loadDashboard() {
  const seq = ++dashSeq;
  $$("#view-dashboard .card").forEach((c) => c.classList.add("loading")); // alte Darstellung halten, kein Flackern
  try {
    const data = await api("GET", `/api/dashboard?${filterQuery()}`);
    if (seq !== dashSeq) return;
    state.dash = data;
    $("#dash-empty").hidden = !data.empty;
    $("#dash-content").hidden = !!data.empty;
    if (data.empty) return;
    renderDashboard(data);
  } catch (e) {
    toast(`Dashboard konnte nicht geladen werden: ${e.message}`, { error: true });
  } finally {
    $$("#view-dashboard .card").forEach((c) => c.classList.remove("loading"));
  }
}

function renderDashboard(d) {
  const t = theme();
  renderKpis(d, t);
  renderMonthly(d, t);
  renderCategoryBars(d, t);
  renderSankey(d, t);
  renderStacked(d, t);
  renderBudgets(d);
  renderBalance(d, t);
  renderPartners(d, t);
  renderCalendar(d, t);
  renderLargest(d);
  Object.keys(tables).forEach(renderTable);
}

function sparkline(values, color) {
  if (values.length < 2) return "";
  const w = 200, h = 34, pad = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i * (w - 2 * pad)) / (values.length - 1), h - pad - ((v - min) / span) * (h - 2 * pad)]);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${path}" fill="none" stroke="${css("--baseline")}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="${color}" stroke="${css("--surface-1")}" stroke-width="2"/></svg>`;
}

function delta(current, previous, upIsGood) {
  if (previous == null || previous === 0) return `<span>kein Vergleichszeitraum</span>`;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(change) < 0.5) return `<span>≈ wie im Vorzeitraum</span>`;
  const up = change > 0;
  const cls = up === upIsGood ? (up ? "up-good" : "down-good") : up ? "up-bad" : "down-bad";
  return `<span class="${cls}">${up ? "▲" : "▼"} ${pct.format(Math.abs(change))} %</span> ggü. Vorzeitraum`;
}

function renderKpis(d, t) {
  const k = d.kpis, prev = k.prev || {};
  const m = d.monthly;
  const tiles = [
    { label: "Einnahmen", value: money0(k.income), delta: delta(k.income, prev.income, true), spark: m.map((x) => x.income), color: t.series[0] },
    { label: "Ausgaben", value: money0(k.expense), delta: delta(k.expense, prev.expense, false), spark: m.map((x) => x.expense), color: t.series[1] },
    { label: "Überschuss", hero: true, value: money0(k.net), delta: delta(k.net, prev.net, true), spark: m.map((x) => x.net), color: k.net >= 0 ? t.good : css("--critical") },
    {
      label: "Sparquote", value: k.savings_rate == null ? "–" : `${pct.format(k.savings_rate)} %`,
      delta: k.savings_rate == null && k.expense > k.income
        ? `<span title="Die Ausgaben übersteigen die Einnahmen um mehr als das Doppelte – meist fehlt der Gehaltseingang im Export.">Zu wenig Einnahmen im Zeitraum</span>`
        : `<span>Ø Ausgaben ${money0(k.avg_monthly_expense)} / Monat</span>`,
      spark: m.map((x) => (x.income ? Math.max((x.net / x.income) * 100, -100) : 0)), color: t.series[2],
    },
  ];
  $("#kpis").innerHTML = tiles.map((x) => `
    <div class="kpi${x.hero ? " hero" : ""}">
      <div class="label">${x.label}</div>
      <div class="value">${x.value}</div>
      <div class="delta">${x.delta}</div>
      ${sparkline(x.spark, x.color)}
    </div>`).join("");
  const badge = $("#uncat-badge");
  badge.hidden = !k.uncategorized;
  badge.textContent = k.uncategorized;
  badge.title = `${k.uncategorized} Buchungen ohne Kategorie`;
}

function renderMonthly(d, t) {
  const months = d.range.months;
  const chart = chartFor("monthly");
  const net = d.monthly.map((x) => x.net / 100);
  chart.setOption({
    ...baseOption(t),
    grid: { left: 8, right: 12, top: 36, bottom: 4, containLabel: true },
    tooltip: {
      ...baseOption(t).tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.35 } },
      formatter: (ps) => `<div style="margin-bottom:4px;font-weight:600">${monthLong(months[ps[0].dataIndex])}</div>` +
        ps.map((p) => tipRow(p.color, p.seriesName, eur.format(p.value))).join(""),
    },
    xAxis: categoryAxis(t, months.map(monthLabel)),
    yAxis: valueAxis(t),
    series: [
      { name: "Einnahmen", type: "bar", data: d.monthly.map((x) => x.income / 100), itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] }, barMaxWidth: 22, barGap: "12%" },
      { name: "Ausgaben", type: "bar", data: d.monthly.map((x) => x.expense / 100), itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] }, barMaxWidth: 22 },
      {
        name: "Überschuss", type: "line", data: net, symbol: "circle", symbolSize: 8, showSymbol: months.length <= 18,
        lineStyle: { width: 2, color: t.text2 }, itemStyle: { color: t.text2, borderColor: t.surface, borderWidth: 2 },
        z: 5,
      },
    ],
  }, true);
  chart.off("click");
  chart.on("click", (p) => {
    const ym = months[p.dataIndex];
    const last = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0);
    goToTransactions({ from: `${ym}-01`, to: iso(last), direction: p.seriesName === "Einnahmen" ? "in" : p.seriesName === "Ausgaben" ? "out" : "" });
  });
  tables.monthly = () => ({
    columns: ["Monat", "Einnahmen", "Ausgaben", "Überschuss"],
    rows: d.monthly.map((x) => [monthLong(x.month), money(x.income), money(x.expense), money(x.net)]),
  });
}

function renderCategoryBars(d, t) {
  const cats = [...d.categories].slice(0, 12).reverse();
  const chart = chartFor("categories");
  $(`[data-card="categories"] .chart`).style.height = `${Math.max(240, cats.length * 34 + 24)}px`;
  chart.resize();
  chart.setOption({
    ...baseOption(t),
    grid: { left: 150, right: 118, top: 4, bottom: 4 },
    tooltip: {
      ...baseOption(t).tooltip, trigger: "item",
      formatter: (p) => {
        const c = cats[p.dataIndex];
        return `<div style="font-weight:600;margin-bottom:4px">${esc(c.name)} · ${money(c.amount)}</div>` +
          c.children.slice(0, 8).map((k) => tipRow(catColor(c.color), k.name, money(k.amount))).join("");
      },
    },
    xAxis: { type: "value", show: false },
    yAxis: categoryAxis(t, cats.map((c) => c.name), { axisLine: { show: false }, axisLabel: { color: t.text2, fontSize: 12.5, width: 140, overflow: "truncate" } }),
    series: [{
      type: "bar", barMaxWidth: 18,
      data: cats.map((c) => ({ value: c.amount / 100, itemStyle: { color: catColor(c.color), borderRadius: [0, 4, 4, 0] } })),
      label: { show: true, position: "right", color: t.text2, fontSize: 12, formatter: (p) => `${moneyAxis(p.value)} · ${pct.format(cats[p.dataIndex].share)} %` },
      cursor: "pointer",
    }],
  }, true);
  chart.off("click");
  chart.on("click", (p) => goToTransactions({ category: cats[p.dataIndex].id, direction: "" }));
  tables.categories = () => ({
    columns: ["Kategorie", "Betrag", "Anteil"],
    rows: d.categories.flatMap((c) => [[c.name, money(c.amount), `${pct.format(c.share)} %`],
      ...c.children.map((k) => [`   › ${k.name}`, money(k.amount), ""])]),
  });
}

function renderSankey(d, t) {
  const chart = chartFor("sankey");
  const { nodes, links } = d.sankey;
  const total = links.filter((l) => l.target === "Verfügbar").reduce((s, l) => s + l.value, 0);
  chart.setOption({
    ...baseOption(t),
    tooltip: {
      ...baseOption(t).tooltip, trigger: "item",
      formatter: (p) => p.dataType === "edge"
        ? `${esc(p.data.source)} → ${esc(p.data.target)}<br><b>${money(p.data.value)}</b> · ${pct.format((p.data.value / total) * 100)} %`
        : `<b>${esc(p.name)}</b><br>${money(p.value)}`,
    },
    series: [{
      type: "sankey", left: 8, right: 230, top: 8, bottom: 8, nodeWidth: 12, nodeGap: 14, draggable: false,
      layoutIterations: 64, emphasis: { focus: "adjacency" },
      data: nodes.map((n) => ({ name: n.name, itemStyle: { color: n.name === "Verfügbar" ? t.muted : catColor(n.color), borderWidth: 0 } })),
      links: links.map((l) => ({ ...l, value: l.value })),
      lineStyle: { color: "target", opacity: 0.22, curveness: 0.5 },
      label: { color: t.text, fontSize: 12.5, formatter: (p) => `${p.name}  {v|${money0(p.value)}}`, rich: { v: { color: t.muted, fontSize: 11.5 } } },
    }],
  }, true);
  tables.sankey = () => ({ columns: ["Von → Nach", "Betrag"], rows: links.map((l) => [`${l.source} → ${l.target}`, money(l.value)]) });
}

function renderStacked(d, t) {
  const months = d.range.months;
  const chart = chartFor("stacked");
  const last = d.stacked.length - 1;
  chart.setOption({
    ...baseOption(t),
    legend: { ...baseOption(t).legend, type: "scroll" },
    grid: { left: 8, right: 12, top: 40, bottom: 4, containLabel: true },
    tooltip: {
      ...baseOption(t).tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.35 } },
      formatter: (ps) => {
        const sum = ps.reduce((s, p) => s + (p.value || 0), 0);
        return `<div style="margin-bottom:4px;font-weight:600">${monthLong(months[ps[0].dataIndex])} · ${eur.format(sum)}</div>` +
          [...ps].reverse().filter((p) => p.value).map((p) => tipRow(p.color, p.seriesName, eur.format(p.value))).join("");
      },
    },
    xAxis: categoryAxis(t, months.map(monthLabel)),
    yAxis: valueAxis(t),
    series: d.stacked.map((s, i) => ({
      name: s.name, type: "bar", stack: "total", barMaxWidth: 24,
      data: s.values.map((v) => v / 100),
      // 1px Rand in Flächenfarbe ergibt die 2px-Lücke zwischen gestapelten Segmenten
      itemStyle: { color: catColor(s.color), borderColor: t.surface, borderWidth: 1, borderRadius: i === last ? [4, 4, 0, 0] : 0 },
      emphasis: { focus: "series" },
    })),
  }, true);
  chart.off("click");
  chart.on("click", (p) => {
    const s = d.stacked[p.seriesIndex];
    if (s.id < 0) return;
    const ym = months[p.dataIndex];
    goToTransactions({ from: `${ym}-01`, to: iso(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0)), category: s.id, direction: "" });
  });
  tables.stacked = () => ({
    columns: ["Monat", ...d.stacked.map((s) => s.name)],
    rows: months.map((m, i) => [monthLong(m), ...d.stacked.map((s) => money(s.values[i]))]),
  });
}

function renderBudgets(d) {
  const box = $(`[data-card="budgets"] .budgets`);
  const n = d.range.months.length;
  $("#budget-sub").textContent = n === 1 ? `Verbrauch ${monthLong(d.range.months[0])}` : `Verbrauch in ${n} Monaten (Monatsbudget × ${n})`;
  if (!d.budgets.length) {
    box.innerHTML = `<p class="empty-note">Noch keine Budgets.<br>Lege unter <a href="#categories">Kategorien</a> ein Monatsbudget fest.</p>`;
    return;
  }
  box.innerHTML = d.budgets.map((b) => {
    const ratio = b.spent / b.budget;
    const cls = ratio > 1 ? "over" : ratio > 0.85 ? "warn" : "";
    const state = ratio > 1 ? `⚠ ${money0(b.spent - b.budget)} über Budget` : ratio > 0.85 ? `! Noch ${money0(b.budget - b.spent)} übrig` : `Noch ${money0(b.budget - b.spent)} übrig`;
    return `<div class="budget ${cls}">
      <div class="row"><span class="name">${swatch(catColor(b.color))}${esc(b.name)}</span>
      <span class="nums">${money0(b.spent)} / ${money0(b.budget)}</span></div>
      <div class="track" role="meter" aria-valuemin="0" aria-valuemax="${b.budget}" aria-valuenow="${b.spent}" aria-label="${esc(b.name)}">
        <div class="fill" style="width:${Math.min(ratio, 1) * 100}%"></div></div>
      <div class="state">${state} · ${pct.format(ratio * 100)} %</div></div>`;
  }).join("");
}

function renderBalance(d, t) {
  const chart = chartFor("balance");
  const data = d.balance.map(([day, v]) => [day, v / 100]);
  chart.setOption({
    ...baseOption(t),
    grid: { left: 8, right: 64, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      ...baseOption(t).tooltip, trigger: "axis", axisPointer: { type: "line", lineStyle: { color: t.baseline } },
      formatter: (ps) => `<div style="font-weight:600;margin-bottom:4px">${dateDe(ps[0].value[0])}</div>${tipRow(t.series[0], "Stand", eur.format(ps[0].value[1]))}`,
    },
    xAxis: { type: "time", axisLabel: { color: t.muted, fontSize: 11.5, formatter: { month: "{MMM}", year: "{yyyy}" } }, axisLine: { lineStyle: { color: t.baseline } }, axisTick: { show: false }, splitLine: { show: false } },
    yAxis: valueAxis(t, { scale: true }),
    series: [{
      type: "line", data, showSymbol: false, symbolSize: 8, lineStyle: { width: 2, color: t.series[0] },
      itemStyle: { color: t.series[0], borderColor: t.surface, borderWidth: 2 },
      areaStyle: { color: t.series[0], opacity: 0.1 },
      endLabel: { show: true, formatter: (p) => moneyAxis(p.value[1]), color: t.text2, fontSize: 11.5 },
    }],
  }, true);
  tables.balance = () => ({ columns: ["Datum", "Stand"], rows: d.balance.map(([day, v]) => [dateDe(day), money(v)]) });
}

function renderPartners(d, t) {
  const chart = chartFor("partners");
  const list = [...d.top_partners].reverse();
  chart.setOption({
    ...baseOption(t),
    grid: { left: 170, right: 80, top: 4, bottom: 4 },
    tooltip: { ...baseOption(t).tooltip, trigger: "item", formatter: (p) => `<b>${esc(list[p.dataIndex].name)}</b><br>${money(list[p.dataIndex].amount)} · ${list[p.dataIndex].count} Buchungen` },
    xAxis: { type: "value", show: false },
    yAxis: categoryAxis(t, list.map((x) => x.name), { axisLine: { show: false }, axisLabel: { color: t.text2, fontSize: 12.5, width: 160, overflow: "truncate" } }),
    series: [{
      type: "bar", barMaxWidth: 16, data: list.map((x) => x.amount / 100),
      itemStyle: { color: t.series[0], borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: "right", color: t.text2, fontSize: 12, formatter: (p) => moneyAxis(p.value) }, cursor: "pointer",
    }],
  }, true);
  chart.off("click");
  chart.on("click", (p) => goToTransactions({ q: list[p.dataIndex].name, direction: "out" }));
  tables.partners = () => ({ columns: ["Empfänger", "Betrag", "Buchungen"], rows: d.top_partners.map((x) => [x.name, money(x.amount), x.count]) });
}

function renderCalendar(d, t) {
  const chart = chartFor("calendar");
  // Höchstens die letzten 12 Monate, damit die Kästchen lesbar bleiben
  let from = d.range.from;
  const to = d.range.to;
  const limit = new Date(`${to}T00:00`);
  limit.setFullYear(limit.getFullYear() - 1);
  limit.setDate(limit.getDate() + 1);
  if (new Date(`${from}T00:00`) < limit) from = iso(limit);
  const data = d.daily.filter(([day]) => day >= from && day <= to).map(([day, v]) => [day, Math.max(v, 0) / 100]);
  const values = data.map((x) => x[1]).sort((a, b) => a - b);
  const p95 = values[Math.floor(values.length * 0.95)] || 1; // Ausreißer (Miete) sollen die Skala nicht plattdrücken
  chart.setOption({
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, formatter: (p) => `<b>${new Date(`${p.value[0]}T00:00`).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}</b><br>Ausgaben: ${eur.format(p.value[1])}` },
    visualMap: {
      min: 0, max: Math.ceil(p95), calculable: false, orient: "horizontal", right: 0, bottom: 0, itemWidth: 10, itemHeight: 120,
      inRange: { color: t.seq }, textStyle: { color: t.muted, fontSize: 11 }, formatter: (v) => moneyAxis(v), text: ["mehr", "weniger"],
    },
    calendar: {
      range: [from, to], top: 24, left: 34, right: 8, bottom: 40, cellSize: ["auto", "auto"],
      dayLabel: { firstDay: 1, nameMap: ["S", "M", "D", "M", "D", "F", "S"], color: t.muted, fontSize: 10.5 },
      monthLabel: { nameMap: MONTHS, color: t.muted, fontSize: 11 },
      yearLabel: { show: false },
      itemStyle: { color: t.surface2, borderColor: t.surface, borderWidth: 2 },
      splitLine: { show: false },
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", data, itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 2 } }],
  }, true);
  chart.off("click");
  chart.on("click", (p) => goToTransactions({ from: p.value[0], to: p.value[0], direction: "out" }));
  tables.calendar = () => ({ columns: ["Tag", "Ausgaben"], rows: d.daily.map(([day, v]) => [dateDe(day), money(v)]) });
}

function renderLargest(d) {
  const box = $(`[data-card="largest"] .largest`);
  if (!d.largest.length) { box.innerHTML = `<p class="empty-note">Keine Ausgaben im Zeitraum.</p>`; return; }
  box.innerHTML = d.largest.map((x) => {
    const c = state.cats.get(x.category_id);
    const color = c ? catColor((c.parent_id ? state.cats.get(c.parent_id) : c).color) : css("--neutral");
    return `<div class="item" data-q="${esc(x.counterparty)}" data-date="${x.date}">
      <div style="min-width:0"><div class="who">${esc(x.counterparty || x.purpose || "Unbekannt")}</div>
      <div class="meta">${swatch(color)}${esc(catName(x.category_id))} · ${dateDe(x.date)}</div></div>
      <div class="amt">${money(x.amount)}</div></div>`;
  }).join("");
  $$(".item", box).forEach((el) => (el.onclick = () => goToTransactions({ q: el.dataset.q, from: el.dataset.date, to: el.dataset.date, direction: "" })));
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
  const parents = state.categories.filter((c) => !c.parent_id);
  const row = (c, child) => `
    <div class="cat-row${child ? " child" : ""}" data-id="${c.id}">
      ${swatch(catColor(c.color))}
      <span class="name">${esc(c.name)}</span>
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
      <div class="target">→ ${swatch(catColor(c?.color))}${esc(catName(r.category_id))}</div>
      <div class="meta">${r.direction === "out" ? "nur Ausgaben" : r.direction === "in" ? "nur Einnahmen" : "Ein- & Ausgänge"}${amount ? ` · ${amount}` : ""} · Priorität ${r.priority}${r.enabled ? "" : " · deaktiviert"}</div>
    </div>`;
  }).join("") || `<p class="empty-note">Noch keine Regeln.</p>`;
  $$("#rule-list .rule").forEach((el) => (el.onclick = () => openRuleDialog(rulesCache.find((r) => r.id === +el.dataset.id))));
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
  const used = new Set(state.categories.filter((c) => !c.parent_id).map((c) => c.color));
  let color = cat?.color || LIGHT_SERIES.find((c) => !used.has(c)) || LIGHT_SERIES[0];
  const renderSwatches = () => {
    $("#swatches").innerHTML = [...LIGHT_SERIES, "#898781"].map((c) =>
      `<button type="button" class="swatch" style="background:${catColor(c)}" data-color="${c}" aria-pressed="${c === color}" aria-label="Farbe ${c}"></button>`).join("") +
      `<input type="color" value="${color}" aria-label="Eigene Farbe" title="Eigene Farbe">`;
    $$("#swatches .swatch").forEach((b) => (b.onclick = () => { color = b.dataset.color; renderSwatches(); }));
    $("#swatches input").oninput = (e) => { color = e.target.value; };
  };
  renderSwatches();
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
    const body = { name: f.name.value, parent_id: f.parent_id.value ? +f.parent_id.value : null, kind: f.kind.value, color, budget: f.budget.value };
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

// ------------------------------------------------------------------ Verdrahtung
function wire() {
  $$(".tabs button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  window.addEventListener("hashchange", () => {
    const v = location.hash.slice(1);
    if (["dashboard", "transactions", "categories", "import"].includes(v) && v !== state.view) showView(v);
  });
  $$("#period-presets button").forEach((b) => (b.onclick = () => setPeriod(b.dataset.period)));
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
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.dash && !state.dash.empty && renderDashboard(state.dash));
  new MutationObserver(() => state.dash && !state.dash.empty && renderDashboard(state.dash))
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

// Neue Dateien aus der Inbox (automatischer Import) erkennen und die Ansicht auffrischen
async function poll() {
  try {
    const before = state.status?.count;
    const beforeImport = state.status?.last_import;
    await loadStatus();
    if (state.status.last_import !== beforeImport && before !== undefined) {
      const added = state.status.count - before;
      if (added > 0) toast(`${added} neue Buchungen automatisch importiert`);
      if (state.period !== "custom") [state.from, state.to] = computePeriod(state.period);
      if (["dashboard", "transactions", "import"].includes(state.view)) refreshCurrent();
    }
  } catch { /* Server kurz weg – beim nächsten Mal wieder */ }
}

async function init() {
  wire();
  setupTableToggles();
  const params = new URLSearchParams(location.search);
  state.account = params.get("account") || "";
  try {
    await Promise.all([loadStatus(), loadCategories()]);
  } catch (e) {
    toast(`Server nicht erreichbar: ${e.message}`, { error: true });
    return;
  }
  const view = location.hash.slice(1);
  state.view = ["dashboard", "transactions", "categories", "import"].includes(view) ? view : "dashboard";
  const period = params.get("period") || "12m";
  state.period = period;
  [state.from, state.to] = period === "custom" ? [params.get("from"), params.get("to")] : computePeriod(period);
  $("#date-from").value = state.from || "";
  $("#date-to").value = state.to || "";
  $$("#period-presets button").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
  showView(state.view);
  setInterval(poll, 15000);
}

init();
