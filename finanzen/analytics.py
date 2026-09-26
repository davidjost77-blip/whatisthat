"""Aggregationen für die Dashboards.

Buchungslogik:
* Die Art der (Ober-)Kategorie bestimmt, ob eine Buchung Einnahme, Ausgabe
  oder Umbuchung ist. Umbuchungen (z. B. aufs Tagesgeld) zählen weder als
  Einnahme noch als Ausgabe.
* Gutschriften in einer Ausgabenkategorie (z. B. Amazon-Rückerstattung)
  verringern die Ausgaben dieser Kategorie, statt als Einnahme zu zählen.
* Unkategorisierte Buchungen werden nach Vorzeichen zugeordnet.
"""

import re
from collections import defaultdict
from datetime import date, timedelta

from . import cycles as cycles_mod
from .db import NEUTRAL

UNCAT_OUT = {"id": 0, "name": "Nicht kategorisiert", "color": NEUTRAL}
UNCAT_IN = {"id": 0, "name": "Nicht kategorisierte Eingänge", "color": NEUTRAL}
OTHER = {"id": -1, "name": "Übrige", "color": NEUTRAL}
GOOD = "#0ca30c"
MAX_SERIES = 7  # + "Übrige" = höchstens 8 Farben, alles Weitere wird zusammengefasst


def month_list(start, end):
    y, m = int(start[:4]), int(start[5:7])
    ey, em = int(end[:4]), int(end[5:7])
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def load_categories(conn):
    cats = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM categories ORDER BY sort, name")}
    for cat in cats.values():
        cat["top_id"] = cat["parent_id"] or cat["id"]
    return cats


def where_clause(date_from=None, date_to=None, accounts=None):
    sql, params = ["1=1"], []
    if date_from:
        sql.append("date >= ?")
        params.append(date_from)
    if date_to:
        sql.append("date <= ?")
        params.append(date_to)
    if accounts:
        sql.append(f"account IN ({','.join('?' * len(accounts))})")
        params.extend(accounts)
    return " AND ".join(sql), params


class Classifier:
    def __init__(self, cats):
        self.cats = cats

    def top(self, tx):
        cat = self.cats.get(tx["category_id"])
        return self.cats[cat["top_id"]] if cat else None

    def kind(self, tx):
        cat = self.top(tx)
        if cat:
            return cat["kind"]
        return "income" if tx["amount"] > 0 else "expense"

    def totals(self, txs):
        income = expense = transfer = 0
        for tx in txs:
            k = self.kind(tx)
            if k == "transfer":
                transfer += tx["amount"]
            elif k == "income":
                income += tx["amount"]
            else:
                expense -= tx["amount"]
        return income, expense, transfer


def _fetch(conn, date_from, date_to, accounts):
    where, params = where_clause(date_from, date_to, accounts)
    return [dict(r) for r in conn.execute(f"SELECT * FROM transactions WHERE {where} ORDER BY date, id", params)]


def dashboard(conn, date_from=None, date_to=None, accounts=None):
    bounds = conn.execute("SELECT MIN(date), MAX(date) FROM transactions").fetchone()
    if bounds[0] is None:
        return {"empty": True}
    date_from = date_from or bounds[0]
    date_to = date_to or bounds[1]
    cats = load_categories(conn)
    cl = Classifier(cats)
    txs = _fetch(conn, date_from, date_to, accounts)
    cy = cycles_mod.load(conn)
    months = cy.keys_between(date_from, date_to)      # Gehaltsmonate (ohne Gehalt: Kalendermonate)

    # --- Kennzahlen inkl. Vergleich mit dem gleich langen Vorzeitraum ---
    d0, d1 = date.fromisoformat(date_from), date.fromisoformat(date_to)
    span = (d1 - d0).days + 1
    prev_from, prev_to = d0 - timedelta(days=span), d0 - timedelta(days=1)
    if len(months) == 1 and cy.range_of(months[0]) == (date_from, date_to):
        # genau ein (Gehalts-)Monat: mit dem vorigen Gehaltsmonat vergleichen
        a, b = cy.range_of(cycles_mod._add_month(months[0], -1))
        prev_from, prev_to = date.fromisoformat(a), date.fromisoformat(b)
    income, expense, transfer = cl.totals(txs)
    prev = None
    if prev_from.isoformat() >= bounds[0]:
        p_income, p_expense, _ = cl.totals(_fetch(conn, prev_from.isoformat(), prev_to.isoformat(), accounts))
        prev = {"income": p_income, "expense": p_expense, "net": p_income - p_expense,
                "from": prev_from.isoformat(), "to": prev_to.isoformat()}

    # --- Einzelaggregationen ---
    monthly = {m: {"month": m, "income": 0, "expense": 0} for m in months}
    cat_month = defaultdict(lambda: defaultdict(int))
    expense_top = defaultdict(int)
    expense_cat = defaultdict(int)
    income_top = defaultdict(int)
    daily = defaultdict(int)
    partners = defaultdict(lambda: {"amount": 0, "count": 0})
    income_cat = defaultdict(int)
    saving = defaultdict(int)  # Umbuchungen zum Sparen (ohne „Eigene Konten“), netto abgeflossen
    for tx in txs:
        k = cl.kind(tx)
        if k == "transfer":
            cat = cats.get(tx["category_id"])
            if cat and "eigene konten" not in cat["name"].lower():
                saving[cat["name"]] -= tx["amount"]
            continue
        m = cy.key_of(tx["date"])
        cat = cl.top(tx)
        cid = cat["id"] if cat else 0
        if k == "income":
            monthly[m]["income"] += tx["amount"]
            income_top[cid] += tx["amount"]
            income_cat[tx["category_id"] or 0] += tx["amount"]
            continue
        value = -tx["amount"]
        monthly[m]["expense"] += value
        cat_month[cid][m] += value
        expense_top[cid] += value
        expense_cat[tx["category_id"] or 0] += value
        daily[tx["date"]] += value
        name = tx["counterparty"] or tx["purpose"][:40] or "Unbekannt"
        partners[name]["amount"] += value
        partners[name]["count"] += 1
    for row in monthly.values():
        row["net"] = row["income"] - row["expense"]

    def info(cid, uncategorized=UNCAT_OUT):
        return dict(uncategorized) if cid == 0 else {k: cats[cid][k] for k in ("id", "name", "color")}

    # --- Ausgaben je Oberkategorie, mit Unterkategorien ---
    categories = []
    for cid, total in sorted(expense_top.items(), key=lambda kv: -kv[1]):
        if total <= 0:
            continue
        children = [
            {"id": sub, "name": cats[sub]["name"] if sub else "–", "amount": value}
            for sub, value in sorted(expense_cat.items(), key=lambda kv: -kv[1])
            if value > 0 and (cats[sub]["top_id"] if sub else 0) == cid
        ]
        categories.append({**info(cid), "amount": total, "share": round(total / expense * 100, 1) if expense else 0,
                           "children": children})

    # --- Gestapelter Monatsverlauf ---
    ranked = [c["id"] for c in categories]
    shown, rest = ranked[:MAX_SERIES], ranked[MAX_SERIES:]
    stacked = [{**info(cid), "values": [max(cat_month[cid].get(m, 0), 0) for m in months]} for cid in shown]
    if rest:
        stacked.append({**OTHER, "values": [max(sum(cat_month[c].get(m, 0) for c in rest), 0) for m in months]})

    # --- Geldfluss (Sankey) ---
    nodes, links = [], []
    for cid, value in sorted(income_top.items(), key=lambda kv: -kv[1]):
        if value <= 0:
            continue
        i = info(cid, UNCAT_IN)
        nodes.append({"name": i["name"], "color": i["color"]})
        links.append({"source": i["name"], "target": "Verfügbar", "value": value})
    if income < expense:
        nodes.append({"name": "Aus Rücklagen", "color": NEUTRAL})
        links.append({"source": "Aus Rücklagen", "target": "Verfügbar", "value": expense - income})
    nodes.append({"name": "Verfügbar", "color": NEUTRAL})
    for cat in categories:
        nodes.append({"name": cat["name"], "color": cat["color"]})
        links.append({"source": "Verfügbar", "target": cat["name"], "value": cat["amount"]})
    if income > expense:
        nodes.append({"name": "Überschuss", "color": GOOD})
        links.append({"source": "Verfügbar", "target": "Überschuss", "value": income - expense})

    # --- Kumulierter Kontostand: alle Buchungen (inkl. Umbuchungen) seit Beginn ---
    where, params = where_clause(None, date_to, accounts)
    balance, running = [], 0
    for row in conn.execute(
        f"SELECT date, SUM(amount) AS s FROM transactions WHERE {where} GROUP BY date ORDER BY date", params
    ):
        running += row["s"]
        if row["date"] >= date_from:
            balance.append([row["date"], running])

    # --- Budgets (Monatsbudget × Anzahl Monate im Zeitraum) ---
    budgets = []
    for cid, cat in cats.items():
        if not cat["budget"]:
            continue
        spent = expense_cat.get(cid, 0) if cat["parent_id"] else expense_top.get(cid, 0)
        budgets.append({"id": cid, "name": cat["name"], "color": cat["color"], "budget": cat["budget"] * len(months),
                        "monthly_budget": cat["budget"], "spent": max(spent, 0)})
    budgets.sort(key=lambda b: -b["spent"] / b["budget"])

    top_partners = sorted(({"name": k, **v} for k, v in partners.items() if v["amount"] > 0),
                          key=lambda x: -x["amount"])[:10]
    largest = sorted((tx for tx in txs if cl.kind(tx) == "expense" and tx["amount"] < 0),
                     key=lambda tx: tx["amount"])[:6]

    return {
        "empty": False,
        "range": {"from": date_from, "to": date_to, "months": months, "min": bounds[0], "max": bounds[1],
                  "month_ranges": {k: cy.range_of(k) for k in months}, "salary_months": cy.active},
        "kpis": {
            "income": income,
            "expense": expense,
            "net": income - expense,
            # Unter -100 % ist die Quote nicht aussagekräftig (meist fehlen die Einnahmen im Export)
            "savings_rate": round((income - expense) / income * 100, 1)
            if income > 0 and income - expense >= -income else None,
            "transfer": transfer,
            "avg_monthly_expense": round(expense / len(months)),
            "count": len(txs),
            "uncategorized": sum(1 for tx in txs if tx["category_id"] is None),
            "prev": prev,
        },
        "monthly": list(monthly.values()),
        "categories": categories,
        "stacked": stacked,
        # Geldfluss: links Einnahmequellen, rechts Ausgaben-Kategorien, Sparen und Rest
        "flow": {
            "sources": [{**info(cid, UNCAT_IN), "amount": v} for cid, v in sorted(income_cat.items(), key=lambda kv: -kv[1]) if v > 0],
            "saving": sum(v for v in saving.values() if v > 0),
            "saving_parts": [{"name": n, "amount": v} for n, v in sorted(saving.items(), key=lambda kv: -kv[1]) if v > 0],
        },
        "category_months": {str(cid): [max(vals.get(m, 0), 0) for m in months] for cid, vals in cat_month.items()},
        "sankey": {"nodes": nodes, "links": links},
        "balance": balance,
        "daily": sorted(daily.items()),
        "budgets": budgets,
        "top_partners": top_partners,
        "largest": [{k: tx[k] for k in ("id", "date", "amount", "counterparty", "purpose", "category_id")}
                    for tx in largest],
    }


def _group_key(name):
    """Grobe Gruppierung von Empfängernamen: "RAPID7 - GERMANY - EUR- 1008" ~ "RAPID7 GERMANY GMBH"."""
    words = [w for w in re.split(r"[^a-zäöüß]+", name.lower()) if len(w) >= 2]
    return " ".join(words[:2])


def _words(name):
    return re.findall(r"[a-z0-9äöüß&]+", name.lower())


def suggest_rule(names):
    """Suchmuster für eine Regel, das alle Namensvarianten trifft: (op, pattern)."""
    collapsed = [re.sub(r"\s+", " ", n.lower()).strip() for n in names]
    if len(collapsed) == 1:
        return "contains", collapsed[0]
    common = _words(names[0])
    for n in names[1:]:
        w = _words(n)
        i = 0
        while i < min(len(common), len(w)) and common[i] == w[i]:
            i += 1
        common = common[:i]
    if not common or len(" ".join(common)) < 3:
        return "contains", collapsed[0]
    plain = " ".join(common)
    if all(plain in n for n in collapsed):
        return "contains", plain
    # z. B. "Karl August GmbH" und "Karl.August.GmbH/Nuernberg"
    return "regex", r"[\W_]*".join(re.escape(w) for w in common)


def uncategorized_groups(conn, limit=30):
    """Unkategorisierte Buchungen, gruppiert nach Empfänger – Grundlage für "Schnell zuordnen"."""
    groups = {}
    for row in conn.execute(
        "SELECT counterparty, amount, date FROM transactions WHERE category_id IS NULL AND counterparty != ''"
    ):
        key = _group_key(row["counterparty"])
        if not key:
            continue
        g = groups.setdefault(key, {"names": {}, "count": 0, "sum": 0, "in": 0, "last": ""})
        g["names"][row["counterparty"]] = g["names"].get(row["counterparty"], 0) + 1
        g["count"] += 1
        g["sum"] += row["amount"]
        g["in"] += row["amount"] > 0
        g["last"] = max(g["last"], row["date"])
    out = []
    for g in groups.values():
        names = sorted(g["names"], key=lambda n: -g["names"][n])
        direction = "in" if g["in"] == g["count"] else "out" if g["in"] == 0 else "any"
        op, pattern = suggest_rule(names)
        out.append({"name": names[0], "variants": names[:5], "op": op, "pattern": pattern, "count": g["count"],
                    "sum": g["sum"], "direction": direction, "last": g["last"]})
    # Wichtigste zuerst: häufig und/oder teuer
    out.sort(key=lambda g: -(abs(g["sum"]) / 100 + g["count"] * 20))
    return {"total": sum(g["count"] for g in out), "groups": out[:limit]}


def previous_months(ref, n):
    """Die n vollen Monate vor dem Monat von ``ref`` (ISO-Datum), älteste zuerst."""
    y, m = int(ref[:4]), int(ref[5:7])
    out = []
    for _ in range(n):
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
        out.append(f"{y:04d}-{m:02d}")
    return out[::-1]


def measures(conn, targets, today=None, window=6):
    """Soll-Maßstäbe und Grundlage der Alltagsäquivalente (Beträge in Cent).

    Bezugstag ist heute oder – bei älteren Exporten – die letzte Buchung. Der Durchschnitt stammt aus den
    ``window`` vollen Monaten davor; eigene Werte aus ``targets`` haben Vorrang.
    """
    today = today or date.today().isoformat()
    last = conn.execute("SELECT MAX(date) FROM transactions").fetchone()[0]
    ref = min(today, last) if last else today
    first = conn.execute("SELECT MIN(date) FROM transactions").fetchone()[0]
    cy = cycles_mod.load(conn, date.fromisoformat(today[:10]))
    ref_key = cy.key_of(ref)
    months = [m for m in (cycles_mod._add_month(ref_key, -i) for i in range(window, 0, -1)) if first and m >= cy.key_of(first)]
    cats = load_categories(conn)
    cl = Classifier(cats)
    expense = fixed = 0
    by_cat = defaultdict(int)
    if months:
        txs = _fetch(conn, cy.range_of(months[0])[0], cy.range_of(months[-1])[1], None)
        for tx in txs:
            if cl.kind(tx) != "expense":
                continue
            value = -tx["amount"]
            expense += value
            cat = cats.get(tx["category_id"])
            if cat:
                by_cat[cat["top_id"]] += value
                if cat["fixed"] or cats[cat["top_id"]]["fixed"]:
                    fixed += value
    n = len(months) or 1
    avg_expense = round(expense / n) if months else None
    avg_fixed = round(fixed / n) if months and fixed > 0 else None
    monthly = targets.get("monthly_expense") or avg_expense
    return {
        "ref": ref,
        "ref_month": ref_key,                          # laufender (Gehalts-)Monat
        "month_range": cy.range_of(ref_key),
        "salary_months": cy.active,
        "months": months,
        "avg_expense": avg_expense,
        "avg_fixed": avg_fixed,
        "category_avg": {str(cid): round(v / n) for cid, v in by_cat.items()} if months else {},
        "soll": {
            "monthly_expense": monthly,
            "monthly_expense_source": "eigener Wert" if targets.get("monthly_expense") else
            (f"Ø {len(months)} Monate" if months else None),
            "daily": round(monthly / 30.4) if monthly else None,
            "fixed": targets.get("fixed") or avg_fixed,
            "fixed_source": "eigener Wert" if targets.get("fixed") else (f"Ø {len(months)} Monate" if avg_fixed else None),
            "savings_rate": targets.get("savings_rate", 20),
        },
        "targets": targets,
    }


def category_flow(conn, cid, date_from=None, date_to=None, accounts=None, top=4):
    """Zusammensetzung einer Ausgaben-Oberkategorie: Unterkategorien und ihre größten Empfänger (Cent)."""
    cats = load_categories(conn)
    if cid not in cats and cid != 0:
        raise KeyError("Kategorie nicht gefunden")
    cl = Classifier(cats)
    groups = defaultdict(lambda: defaultdict(int))
    for tx in _fetch(conn, date_from, date_to, accounts):
        if cl.kind(tx) != "expense":
            continue
        cat = cats.get(tx["category_id"])
        top_id = cat["top_id"] if cat else 0
        if top_id != cid:
            continue
        sub = cat["name"] if cat and cat["parent_id"] else "Allgemein" if cat else "Nicht kategorisiert"
        name = tx["counterparty"] or tx["purpose"][:40] or "Unbekannt"
        groups[sub][name] -= tx["amount"]
    children = []
    for sub, partners in groups.items():
        items = sorted(((n, v) for n, v in partners.items() if v > 0), key=lambda kv: -kv[1])
        total = sum(v for _, v in items)
        if total <= 0:
            continue
        shown = [{"name": n, "amount": v} for n, v in items[:top]]
        rest = sum(v for _, v in items[top:])
        if rest > 0:
            shown.append({"name": f"{len(items) - top} weitere", "amount": rest, "rest": True})
        children.append({"name": sub, "amount": total, "partners": shown})
    children.sort(key=lambda c: -c["amount"])
    name = cats[cid]["name"] if cid else "Nicht kategorisiert"
    return {"id": cid, "name": name, "amount": sum(c["amount"] for c in children), "children": children}
