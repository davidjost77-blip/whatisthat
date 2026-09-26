/* Sparplan – Rechenmodell ohne DOM: Bestand, Depotverlauf und Projektion (deterministisch + Monte Carlo).
   Läuft im Browser (window.SparplanModel) und in Node (require) für Tests. */
"use strict";
(function (root) {
  const round2 = (x) => Math.round(x * 100) / 100;

  /** Bestand eines Kürzels aus den Käufen: Stück, investiert (€), Einstandskurs. */
  function holding(transactions, symbol) {
    let shares = 0, invested = 0;
    for (const t of transactions) {
      if (t.symbol !== symbol) continue;
      shares += t.shares;
      invested += t.amount / 100;
    }
    return { shares: Math.round(shares * 1e6) / 1e6, invested: round2(invested), avg: shares ? invested / shares : 0 };
  }

  /** Tägliche Depotwerte ab dem ersten Kauf: {date, value, invested, shares}. Lücken im Kursverlauf
      werden mit dem letzten bekannten Kurs gefüllt, vor dem ersten Kurs gilt der Kaufkurs. */
  function depotHistory(transactions, points, symbol, today) {
    const txs = transactions.filter((t) => t.symbol === symbol).sort((a, b) => a.date.localeCompare(b.date));
    if (!txs.length) return [];
    const prices = new Map(points || []);
    const out = [];
    let shares = 0, invested = 0, price = txs[0].amount / 100 / txs[0].shares, i = 0;
    const end = today || new Date().toISOString().slice(0, 10);
    for (let d = new Date(`${txs[0].date}T12:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      if (day > end) break;
      while (i < txs.length && txs[i].date <= day) {
        shares += txs[i].shares;
        invested += txs[i].amount / 100;
        if (!prices.has(day)) price = txs[i].amount / 100 / txs[i].shares;
        i++;
      }
      const known = prices.has(day);
      if (known) price = prices.get(day);
      const weekend = [0, 6].includes(d.getUTCDay());
      if (known || !weekend || day === end) out.push({ date: day, value: round2(shares * price), invested: round2(invested), shares, price, buy: txs.some((t) => t.date === day) });
    }
    return out;
  }

  // Reproduzierbarer Zufall, damit die Bänder beim Ziehen der Regler nicht flackern
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussian(rand) {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }
  const quantile = (sorted, q) => {
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };

  /** Monatsrendite aus Rendite p. a. (in %) abzüglich laufender Kosten (TER, in %). */
  const monthlyGrowth = (retPct, terPct = 0) => Math.pow(1 + (retPct - terPct) / 100, 1 / 12) - 1;

  /**
   * Projektion über `months` Monate. Monat 0 = heute (Startwerte), danach je Monat: Einzahlung, dann Wachstum.
   * positions: [{id, start (€), rate (€/Monat), ret (%), vol (%), ter (%), from (Monat, ab dem gespart wird), lump (€ in Monat `from`)}]
   * opts: {months, dynamic (% p. a. Steigerung der Raten), lumps: [{month, amount}] (gehen in Position 0),
   *        inflation (%), real (bool), paths, seed, rho (Korrelation), retShift (Prozentpunkte)}
   */
  function project(positions, opts) {
    const months = Math.max(1, Math.round(opts.months));
    const dyn = (opts.dynamic || 0) / 100;
    const infl = (opts.inflation || 0) / 100;
    const shift = opts.retShift || 0;
    const deflate = (m) => (opts.real ? Math.pow(1 + infl, m / 12) : 1);
    const lumps = new Map();
    for (const l of opts.lumps || []) if (l.month >= 1 && l.month <= months) lumps.set(l.month, (lumps.get(l.month) || 0) + l.amount);

    const contribution = (p, idx, m) => {
      if (m < 1) return 0;
      let c = m >= (p.from || 1) ? p.rate * Math.pow(1 + dyn, Math.floor((m - 1) / 12)) : 0;
      if (m === (p.from || 1) && p.lump) c += p.lump;
      if (idx === 0 && lumps.has(m)) c += lumps.get(m);
      return c;
    };

    // deterministisch
    const n = positions.length;
    const perPos = positions.map(() => new Array(months + 1).fill(0));
    const invested = new Array(months + 1).fill(0);
    const total = new Array(months + 1).fill(0);
    const vals = positions.map((p) => p.start || 0);
    const investedStart = opts.investedStart ?? positions.reduce((s, p) => s + (p.start || 0), 0);
    let inv = investedStart;
    for (let m = 0; m <= months; m++) {
      let sum = 0;
      positions.forEach((p, i) => {
        if (m > 0) {
          const c = contribution(p, i, m);
          inv += c;
          vals[i] = (vals[i] + c) * (1 + monthlyGrowth(p.ret + shift, p.ter));
        }
        perPos[i][m] = vals[i] / deflate(m);
        sum += vals[i];
      });
      total[m] = sum / deflate(m);
      invested[m] = inv / deflate(m);
    }

    // Monte Carlo: Ein-Faktor-Modell, alle Positionen hängen am gemeinsamen Markt (Korrelation rho)
    const paths = opts.paths ?? 600;
    const bands = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    if (paths > 0) {
      const rand = mulberry32(opts.seed ?? 7);
      const rho = opts.rho ?? 0.8;
      const a = Math.sqrt(rho), b = Math.sqrt(1 - rho);
      const mu = positions.map((p) => Math.log(1 + (p.ret + shift - (p.ter || 0)) / 100) / 12);
      const sig = positions.map((p) => (p.vol || 0) / 100 / Math.sqrt(12));
      const state = Array.from({ length: paths }, () => positions.map((p) => p.start || 0));
      const cols = Array.from({ length: months + 1 }, () => new Float64Array(paths));
      for (let k = 0; k < paths; k++) cols[0][k] = total[0];
      const contrib = Array.from({ length: months + 1 }, (_, m) => positions.map((p, i) => contribution(p, i, m)));
      const eps = new Float64Array(n);
      for (let m = 1; m <= months; m++) {
        const d = deflate(m);
        for (let k = 0; k < paths; k++) {
          const f = gaussian(rand);
          const s = state[k];
          let sum = 0;
          for (let i = 0; i < n; i++) {
            eps[i] = a * f + b * gaussian(rand);
            s[i] = (s[i] + contrib[m][i]) * Math.exp(mu[i] + sig[i] * eps[i]);
            sum += s[i];
          }
          cols[m][k] = sum / d;
        }
      }
      for (const col of cols) {
        col.sort();
        bands.p10.push(quantile(col, 0.1)); bands.p25.push(quantile(col, 0.25)); bands.p50.push(quantile(col, 0.5));
        bands.p75.push(quantile(col, 0.75)); bands.p90.push(quantile(col, 0.9));
      }
    }
    return { months, total, invested, perPos, bands };
  }

  /** Erster Monat, in dem eine Reihe eine Schwelle erreicht (oder null). */
  const reachMonth = (series, threshold) => {
    const i = series.findIndex((v) => v >= threshold);
    return i < 0 ? null : i;
  };

  /** Vereinfachte Steuer bei Verkauf am Ende: Abgeltungsteuer + Soli (26,375 %), Teilfreistellung 30 % für
      Aktien-ETFs, Sparerpauschbetrag 1.000 €. Vorabpauschale und Kirchensteuer bleiben unberücksichtigt. */
  function taxOnSale(value, invested, { equity = true, allowance = 1000 } = {}) {
    const gain = Math.max(0, value - invested);
    const taxable = Math.max(0, gain * (equity ? 0.7 : 1) - allowance);
    return taxable * 0.26375;
  }

  const api = { holding, depotHistory, project, reachMonth, taxOnSale, monthlyGrowth, mulberry32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SparplanModel = api;
})(typeof window !== "undefined" ? window : globalThis);
