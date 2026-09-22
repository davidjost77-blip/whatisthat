"""Aggregationen für die Dashboards.

Buchungslogik:
* Die Art der (Ober-)Kategorie bestimmt, ob eine Buchung Einnahme, Ausgabe
  oder Umbuchung ist. Umbuchungen (z. B. aufs Tagesgeld) zählen weder als
  Einnahme noch als Ausgabe.
* Gutschriften in einer Ausgabenkategorie (z. B. Amazon-Rückerstattung)
  verringern die Ausgaben dieser Kategorie, statt als Einnahme zu zählen.
* Unkategorisierte Buchungen werden nach Vorzeichen zugeordnet.
"""

from collections import defaultdict
from datetime import date, timedelta

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
    months = month_list(date_from, date_to)

    # --- Kennzahlen inkl. Vergleich mit dem gleich langen Vorzeitraum ---
    d0, d1 = date.fromisoformat(date_from), date.fromisoformat(date_to)
    span = (d1 - d0).days + 1
    prev_from, prev_to = d0 - timedelta(days=span), d0 - timedelta(days=1)
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
    for tx in txs:
        k = cl.kind(tx)
        if k == "transfer":
            continue
        m = tx["date"][:7]
        cat = cl.top(tx)
        cid = cat["id"] if cat else 0
        if k == "income":
            monthly[m]["income"] += tx["amount"]
            income_top[cid] += tx["amount"]
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
        "range": {"from": date_from, "to": date_to, "months": months, "min": bounds[0], "max": bounds[1]},
        "kpis": {
            "income": income,
            "expense": expense,
            "net": income - expense,
            "savings_rate": round((income - expense) / income * 100, 1) if income > 0 else None,
            "transfer": transfer,
            "avg_monthly_expense": round(expense / len(months)),
            "count": len(txs),
            "uncategorized": sum(1 for tx in txs if tx["category_id"] is None),
            "prev": prev,
        },
        "monthly": list(monthly.values()),
        "categories": categories,
        "stacked": stacked,
        "sankey": {"nodes": nodes, "links": links},
        "balance": balance,
        "daily": sorted(daily.items()),
        "budgets": budgets,
        "top_partners": top_partners,
        "largest": [{k: tx[k] for k in ("id", "date", "amount", "counterparty", "purpose", "category_id")}
                    for tx in largest],
    }
