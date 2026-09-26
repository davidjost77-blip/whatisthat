"""Doppelte Buchungen finden, die schon in der Datenbank stecken (aus überlappenden Exporten früherer Versionen).

Zwei Arten:
1. **Gleiches Konto, anderer Export, andere Schreibweise**: gleicher Tag und Betrag, aus verschiedenen Importen,
   Empfänger/Zweck unterschiedlich geschrieben, aber verwandt (gemeinsames Wort oder einer leer). Identische Texte
   aus verschiedenen Importen gelten als echte Wiederholung (z. B. zweimal Kaffee am selben Tag) und bleiben.
2. **Dasselbe Konto unter zwei Namen** (z. B. einmal Dateiname, einmal IBAN): Decken sich die Buchungen eines Kontos
   im gemeinsamen Zeitraum größtenteils mit einem anderen, sind die deckungsgleichen Doppelte.
Behalten wird jeweils die früher importierte Buchung; eine von Hand gesetzte Kategorie wird übernommen.
"""

from collections import Counter, defaultdict

from .importer import _tokens

MIN_SHARE = 0.6        # Anteil deckungsgleicher Buchungen, ab dem zwei Konten als dasselbe gelten
MIN_HITS = 3


def _norm(s):
    return " ".join((s or "").lower().split())


# Allerweltswörter verbinden nichts (zwei verschiedene Kartenzahlungen sind nicht dieselbe Buchung)
GENERIC = {"kartenzahlung", "lastschrift", "überweisung", "ueberweisung", "einkauf", "zahlung", "gmbh", "sepa", "visa",
           "debit", "debitkarte", "onlinezahlung", "folgelastschrift", "gutschrift", "dauerauftrag", "und", "der", "die", "das"}


def _words(s):
    return set(_tokens(s or "")) - GENERIC


def _related(a, b):
    """Verwandte Schreibweise: gemeinsames Wort im Empfänger (ohne Empfänger: im Verwendungszweck)."""
    ca, cb = _words(a["counterparty"]), _words(b["counterparty"])
    if ca and cb:
        return bool(ca & cb)
    pa, pb = ca | _words(a["purpose"]), cb | _words(b["purpose"])
    return not pa or not pb or bool(pa & pb)


def find(conn):
    rows = [dict(r) for r in conn.execute("SELECT * FROM transactions ORDER BY import_id, id")]
    pairs, dropped = [], set()

    # 1. gleiches Konto, verschiedene Importe, abweichende Schreibweise
    groups = defaultdict(list)
    for r in rows:
        groups[(r["account"], r["date"], r["amount"])].append(r)
    for g in groups.values():
        if len(g) < 2 or len({r["import_id"] for r in g}) < 2:
            continue
        for i, a in enumerate(g):
            if a["id"] in dropped:
                continue
            for b in g[i + 1:]:
                if b["id"] in dropped or b["import_id"] == a["import_id"]:
                    continue
                same_text = (_norm(a["counterparty"]), _norm(a["purpose"])) == (_norm(b["counterparty"]), _norm(b["purpose"]))
                if not same_text and _related(a, b):
                    pairs.append({"keep": a, "drop": b, "why": "gleicher Tag und Betrag, anders geschrieben"})
                    dropped.add(b["id"])
                    break

    # 2. dasselbe Konto unter zwei Namen
    by_acc = defaultdict(list)
    for r in rows:
        if r["id"] not in dropped:
            by_acc[r["account"]].append(r)
    accs = sorted(by_acc, key=lambda a: (min(r["import_id"] or 0 for r in by_acc[a]), a))   # ältestes Konto behalten
    for i, keep_acc in enumerate(accs):
        for drop_acc in accs[i + 1:]:
            A, B = by_acc[keep_acc], by_acc[drop_acc]
            lo, hi = max(min(r["date"] for r in A), min(r["date"] for r in B)), min(max(r["date"] for r in A), max(r["date"] for r in B))
            inside = [b for b in B if lo <= b["date"] <= hi and b["id"] not in dropped]
            if len(inside) < MIN_HITS:
                continue
            pool = defaultdict(list)
            for a in A:
                if lo <= a["date"] <= hi:
                    pool[(a["date"], a["amount"])].append(a)
            matched = []
            for b in inside:
                cand = pool.get((b["date"], b["amount"]))
                if cand:
                    matched.append((cand.pop(0), b))
            if len(matched) >= MIN_HITS and len(matched) >= MIN_SHARE * len(inside):
                for a, b in matched:
                    pairs.append({"keep": a, "drop": b, "why": f"Konto „{drop_acc}“ ist dasselbe wie „{keep_acc}“"})
                    dropped.add(b["id"])
    return pairs


def summary(conn):
    pairs = find(conn)
    return {"count": len(pairs), "sum": sum(abs(p["drop"]["amount"]) for p in pairs),
            "reasons": Counter(p["why"] for p in pairs),
            "items": [{"keep": {k: p["keep"][k] for k in ("id", "date", "amount", "counterparty", "purpose", "account")},
                       "drop": {k: p["drop"][k] for k in ("id", "date", "amount", "counterparty", "purpose", "account")},
                       "why": p["why"]} for p in pairs[:50]]}


def remove(conn):
    """Entfernt alle gefundenen Doppelten. Gibt die gelöschten Zeilen zurück (zum Wiederherstellen)."""
    pairs = find(conn)
    deleted = []
    for p in pairs:
        keep, drop = p["keep"], p["drop"]
        if drop["manual"] and not keep["manual"]:                  # deine Entscheidung geht nicht verloren
            conn.execute("UPDATE transactions SET category_id = ?, manual = 1, note = CASE WHEN note = '' THEN ? ELSE note END WHERE id = ?",
                         (drop["category_id"], drop.get("note") or "", keep["id"]))
        conn.execute("DELETE FROM transactions WHERE id = ?", (drop["id"],))
        deleted.append(drop)
    conn.commit()
    if deleted:
        from . import transfers
        transfers.reconcile(conn)
    return {"removed": len(deleted), "undo": deleted}


def restore(conn, rows):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(transactions)")]
    for r in rows:
        values = {c: r.get(c) for c in cols}
        conn.execute(f"INSERT OR IGNORE INTO transactions ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                     [values[c] for c in cols])
    conn.commit()
    return {"restored": len(rows)}
