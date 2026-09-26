"""Zuordnen: Buchungen ohne Kategorie und unsichere automatische Zuordnungen.

„Ohne Kategorie“ wird nach Empfänger gruppiert, damit eine Entscheidung gleich für alle ähnlichen gilt.
„Unsicher“ sind automatisch (per Regel) zugeordnete Buchungen, bei denen die Zuordnung wackelt:
- mehrere Regeln verschiedener Kategorien passen (Konflikt),
- erkannt nur am Verwendungszweck, nicht am Empfänger,
- Betrag weit über dem Üblichen dieses Empfängers.
Eine Entscheidung legt eine Regel an und wendet sie auf alle ähnlichen Buchungen an; sie lässt sich
vollständig rückgängig machen.
"""

from collections import Counter, defaultdict
from datetime import date, timedelta
from statistics import median

from . import analytics, rules

UNCERTAIN_DAYS = 365
OUTLIER_FACTOR = 3
OUTLIER_MIN = 3000            # mindestens 30 € über dem Üblichen
LEARNED_PRIORITY = 90         # Regeln aus „Zuordnen“ (am Empfänger) gelten als sicher


def _cat_names(conn):
    cats = {r["id"]: dict(r) for r in conn.execute("SELECT id, name, parent_id, kind FROM categories")}
    def label(cid):
        c = cats.get(cid)
        if not c:
            return "Nicht kategorisiert"
        p = cats.get(c["parent_id"])
        return f"{p['name']} › {c['name']}" if p else c["name"]
    return cats, label


def _key(tx):
    return analytics._group_key(tx["counterparty"] or "") or f"#{tx['id']}"


def _history(conn):
    """Welche Kategorie hatten ähnliche Empfänger bisher? key → Counter(category_id), Wort → Counter."""
    by_key, by_word = defaultdict(Counter), defaultdict(Counter)
    for r in conn.execute("SELECT counterparty, category_id, manual FROM transactions WHERE category_id IS NOT NULL"):
        w = 3 if r["manual"] else 1                     # eigene Entscheidungen zählen mehr
        by_key[analytics._group_key(r["counterparty"] or "")][r["category_id"]] += w
        for word in analytics._words(r["counterparty"] or ""):
            if len(word) >= 4:
                by_word[word][r["category_id"]] += w
    return by_key, by_word


def _suggest(names, by_key, by_word, cats, direction):
    def ok(cid):
        kind = (cats.get(cid) or {}).get("kind")
        return kind == "transfer" or (kind == "income") == (direction == "in")
    for n in names:
        for cid, _ in by_key.get(analytics._group_key(n), Counter()).most_common():
            if ok(cid):
                return cid, "wie bisher bei diesem Empfänger"
    votes = Counter()
    for n in names:
        for word in analytics._words(n):
            if len(word) >= 4:
                votes.update(by_word.get(word, Counter()))
    for cid, _ in votes.most_common():
        if ok(cid):
            return cid, "ähnlicher Empfänger"
    return None, None


def top_categories(conn, direction, n=8):
    """Die am häufigsten genutzten Unterkategorien der letzten Zeit – als Schnellwahl."""
    sign = ">" if direction == "in" else "<"
    rows = conn.execute(
        f"""SELECT t.category_id, COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id
            WHERE t.amount {sign} 0 AND c.kind != 'transfer' GROUP BY t.category_id ORDER BY n DESC LIMIT ?""", (n,)
    ).fetchall()
    return [r["category_id"] for r in rows]


def review(conn, today=None, limit=60):
    cats, label = _cat_names(conn)
    by_key, by_word = _history(conn)

    # ---------- ohne Kategorie, gruppiert
    groups = {}
    for r in conn.execute("SELECT id, date, amount, counterparty, purpose, booking_text, account FROM transactions "
                          "WHERE category_id IS NULL ORDER BY date DESC"):
        g = groups.setdefault(_key(r), {"key": _key(r), "names": Counter(), "ids": [], "sum": 0, "in": 0, "samples": [],
                                        "first": r["date"], "last": r["date"]})
        g["names"][r["counterparty"] or ""] += 1
        g["ids"].append(r["id"])
        g["sum"] += r["amount"]
        g["abs"] = g.get("abs", 0) + abs(r["amount"])
        g["in"] += r["amount"] > 0
        g["first"] = min(g["first"], r["date"])
        if len(g["samples"]) < 4:
            g["samples"].append({k: r[k] for k in ("id", "date", "amount", "purpose", "account")})
    unassigned = []
    for g in groups.values():
        names = [n for n, _ in g["names"].most_common() if n]
        count = len(g["ids"])
        direction = "in" if g["in"] == count else "out" if g["in"] == 0 else "any"
        op, pattern = analytics.suggest_rule(names) if names else (None, None)
        cid, why = _suggest(names, by_key, by_word, cats, direction)
        unassigned.append({
            "kind": "unassigned", "key": g["key"], "name": names[0] if names else (g["samples"][0]["purpose"][:60] or "Ohne Empfänger"),
            "variants": names[:5], "ids": g["ids"], "count": count, "sum": g["sum"], "direction": direction,
            "first": g["first"], "last": g["last"], "samples": g["samples"],
            "rule": {"op": op, "pattern": pattern} if pattern else None,
            "suggestion": {"category_id": cid, "label": label(cid), "why": why} if cid else None,
        })
    unassigned.sort(key=lambda g: -(abs(g["sum"]) + g["count"] * 500))

    # ---------- unsichere automatische Zuordnungen
    today = today or date.today()
    since = (today - timedelta(days=UNCERTAIN_DAYS)).isoformat()
    compiled = rules.load_rules(conn)
    txs = conn.execute("SELECT * FROM transactions WHERE category_id IS NOT NULL AND manual = 0 AND date >= ?", (since,)).fetchall()
    usual = defaultdict(list)
    for t in conn.execute("SELECT counterparty, amount FROM transactions WHERE amount < 0"):
        usual[analytics._group_key(t["counterparty"] or "")].append(-t["amount"])
    ugroups = {}
    for t in txs:
        matching = [r for r in compiled if r.matches(t)]
        if not matching or matching[0].category_id != t["category_id"]:
            continue
        win = matching[0]
        reasons = []
        # eigene, am Empfänger gelernte Regeln gelten als sicher
        taught = win.field == "counterparty" and win.priority <= LEARNED_PRIORITY
        others = [r.category_id for r in matching if r.category_id != win.category_id]
        if others and not taught:
            reasons.append(f"passt auch zu {label(others[0])}")
        if win.field in ("any", "purpose", "booking_text") and not win._text_matches(t["counterparty"]):
            reasons.append("nur am Verwendungszweck erkannt")
        amounts = usual.get(analytics._group_key(t["counterparty"] or ""), [])
        if t["amount"] < 0 and len(amounts) >= 4:
            m = median(amounts)
            if -t["amount"] > OUTLIER_FACTOR * m and -t["amount"] - m >= OUTLIER_MIN:
                reasons.append(f"ungewöhnlich hoch für diesen Empfänger (sonst um {m / 100:.0f} €)".replace(".", ","))
        if not reasons:
            continue
        outlier = any(r.startswith("ungewöhnlich") for r in reasons)
        k = (_key(t), t["category_id"], t["id"] if outlier else None)   # Ausreißer einzeln, sonst je Empfänger
        g = ugroups.setdefault(k, {"t": t, "ids": [], "sum": 0, "samples": [], "reasons": reasons, "others": others,
                                   "names": Counter(), "first": t["date"], "last": t["date"], "in": 0})
        g["ids"].append(t["id"])
        g["sum"] += t["amount"]
        g["in"] += t["amount"] > 0
        g["names"][t["counterparty"] or ""] += 1
        g["first"], g["last"] = min(g["first"], t["date"]), max(g["last"], t["date"])
        if len(g["samples"]) < 4:
            g["samples"].append({k2: t[k2] for k2 in ("id", "date", "amount", "purpose", "account")})
    uncertain = []
    for (key, cid, _), g in ugroups.items():
        names = [n for n, _ in g["names"].most_common() if n]
        count = len(g["ids"])
        op, pattern = analytics.suggest_rule(names) if names else (None, None)
        alt = g["others"][0] if g["others"] else None
        uncertain.append({
            "kind": "uncertain", "key": f"u{key}|{cid}|{g['ids'][0]}", "name": names[0] if names else g["t"]["purpose"][:60],
            "variants": names[:5], "ids": g["ids"], "count": count, "sum": g["sum"],
            "direction": "in" if g["in"] == count else "out" if g["in"] == 0 else "any",
            "first": g["first"], "last": g["last"], "samples": g["samples"],
            "current": {"category_id": cid, "label": label(cid)}, "reasons": g["reasons"],
            "rule": {"op": op, "pattern": pattern} if pattern else None,
            "suggestion": {"category_id": alt, "label": label(alt), "why": "andere passende Regel"} if alt else None,
        })
    uncertain.sort(key=lambda u: -(abs(u["sum"]) + u["count"] * 500))

    return {
        "unassigned": {"count": sum(g["count"] for g in unassigned), "sum": sum(g["sum"] for g in unassigned),
                       "volume": sum(g["abs"] for g in groups.values()),
                       "groups": unassigned[:limit]},
        "uncertain": {"count": sum(u["count"] for u in uncertain), "items": uncertain[:limit]},
        "top": {"out": top_categories(conn, "out"), "in": top_categories(conn, "in")},
    }


def assign(conn, ids, category_id, rule=None, direction="any", learn=True, priority=LEARNED_PRIORITY):
    """Ordnet zu und merkt es sich für alle ähnlichen (Regel). Gibt Daten zum Rückgängigmachen zurück."""
    before = {r["id"]: (r["category_id"], r["manual"]) for r in conn.execute("SELECT id, category_id, manual FROM transactions")}
    rule_id = None
    if learn and rule and rule.get("pattern"):
        rule_id = conn.execute(
            "INSERT INTO rules (category_id, field, op, pattern, direction, priority, enabled) VALUES (?, 'counterparty', ?, ?, ?, ?, 1)",
            (category_id, rule.get("op") or "contains", rule["pattern"], direction if direction in ("in", "out") else "any", priority),
        ).lastrowid
        conn.commit()
        rules.apply_rules(conn)
    # die gezeigten Buchungen in jedem Fall (auch ohne Empfänger, auch falls die Regel sie nicht trifft)
    for i in ids:
        row = conn.execute("SELECT category_id FROM transactions WHERE id = ?", (i,)).fetchone()
        if row and row["category_id"] != category_id:
            conn.execute("UPDATE transactions SET category_id = ?, manual = 1 WHERE id = ?", (category_id, i))
    conn.commit()
    after = {r["id"]: (r["category_id"], r["manual"]) for r in conn.execute("SELECT id, category_id, manual FROM transactions")}
    changes = [[i, b[0], b[1]] for i, b in before.items() if after.get(i) != b]
    return {"rule_id": rule_id, "changed": len(changes), "undo": {"rule_id": rule_id, "changes": changes}}


def confirm(conn, ids, category_id=None, rule=None, direction="any"):
    """„Passt so“: bestätigt die Zuordnung. Mit Empfänger wird sie als Regel gelernt (kommt nicht wieder),
    ohne Empfänger werden die Buchungen als von Hand bestätigt markiert."""
    if category_id and rule and rule.get("pattern"):
        return assign(conn, [], category_id, rule, direction)
    marks = ",".join("?" * len(ids))
    before = [[r["id"], r["category_id"], r["manual"]] for r in
              conn.execute(f"SELECT id, category_id, manual FROM transactions WHERE id IN ({marks})", ids)]
    conn.executemany("UPDATE transactions SET manual = 1 WHERE id = ?", [(i,) for i in ids])
    conn.commit()
    return {"rule_id": None, "changed": len(before), "undo": {"rule_id": None, "changes": before}}


def undo(conn, data):
    if data.get("rule_id"):
        conn.execute("DELETE FROM rules WHERE id = ?", (int(data["rule_id"]),))
    conn.executemany("UPDATE transactions SET category_id = ?, manual = ? WHERE id = ?",
                     [(c, m, int(i)) for i, c, m in data.get("changes", [])])
    conn.commit()
    return {"restored": len(data.get("changes", []))}
