"""Kreditkartenabrechnungen und Überträge zwischen eigenen Konten automatisch prüfen.

Problem: Wer Girokonto *und* Kreditkarte importiert, sieht jeden Kartenkauf zweimal – einmal als Kartenumsatz,
einmal in der monatlichen Abrechnung, die vom Girokonto abgebucht wird. Umgekehrt ist die Abrechnung die einzige
Spur der Käufe, wenn die Karte *nicht* importiert ist; dann darf sie nicht als Umbuchung verschwinden.

reconcile() läuft nach jedem Import, Bankabruf und Neu-Anwenden der Regeln:
1. **Paare**: Eine Abbuchung auf einem Konto und eine gleich hohe Gutschrift auf einem anderen eigenen Konto
   innerhalb weniger Tage, von denen mindestens eine nach Karte/Übertrag aussieht → beide „Eigene Konten“.
2. **Abrechnung ohne Gegenbuchung**: Sieht eine Abbuchung nach Kreditkartenabrechnung aus und gibt es ein
   importiertes Kartenkonto mit Umsätzen im Abrechnungszeitraum → Umbuchung (die Käufe sind schon gezählt).
   Gibt es keins → sie zählt als Ausgabe (nächste passende Nicht-Umbuchungs-Regel, sonst „ohne Kategorie“
   zum Zuordnen), damit die Käufe nicht verschwinden.
Von Hand gesetzte Kategorien bleiben immer unangetastet.
"""

import re
from datetime import date

# sieht nach einer Kreditkarten-*Abrechnung* aus (nicht nach einem einzelnen Kauf mit Debitkarte – „VISA Debit“,
# „Kartenzahlung“ usw. zählen bewusst nicht, sonst würden Käufe mit der Girocard/Visa Debit verschwinden)
SETTLEMENT = re.compile(
    r"kreditkartenabrechnung|kreditkarte.{0,20}abrechnung|kartenabrechnung|umsatzabrechnung|abrechnung.{0,20}(visa|master|kreditkarte)|"
    r"(visa|mastercard).{0,20}abrechnung|ausgleich kreditkarte|ausgleich.{0,10}karte|american express|\bamex\b|barclaycard|"
    r"barclays bank|advanzia|hanseatic bank|genialcard|awa7|tf bank|kartenkonto", re.I)
NOT_SETTLEMENT = re.compile(r"debit|kartenzahlung|girocard|\bec\b|kaufumsatz", re.I)
# sieht nach Übertrag zwischen eigenen Konten aus (für Paare genügt auch das)
MOVE_HINT = re.compile(r"umbuchung|übertrag|uebertrag|eigenes konto|eigene konten|ausgleich|überweisung an mich", re.I)
# Kontoname eines Kartenkontos (so benennt der Import z. B. „Visa Kreditkarte ···3767“)
CARD_ACCOUNT = re.compile(r"kredit|visa|master|card|karte|amex", re.I)

PAIR_DAYS = 10          # Abbuchung und Gutschrift dürfen so weit auseinanderliegen
STATEMENT_DAYS = 45     # Kartenumsätze, die eine Abrechnung abdecken kann


def _text(tx):
    return " ".join(str(tx[k] or "") for k in ("counterparty", "purpose", "booking_text"))


def is_settlement(tx):
    t = _text(tx)
    return bool(SETTLEMENT.search(t)) and not NOT_SETTLEMENT.search(t)


def _looks_like_move(tx):
    return is_settlement(tx) or bool(MOVE_HINT.search(_text(tx)))


def _days(a, b):
    return abs((date.fromisoformat(a[:10]) - date.fromisoformat(b[:10])).days)


def own_accounts_category(conn):
    row = conn.execute(
        """SELECT c.id FROM categories c JOIN categories p ON p.id = c.parent_id
           WHERE lower(c.name) = 'eigene konten' AND p.kind = 'transfer'""").fetchone()
    return row[0] if row else None


def reconcile(conn):
    """Prüft alle nicht manuell kategorisierten Buchungen. Gibt einen Bericht zurück (auch für die Oberfläche)."""
    from . import rules as rules_mod                      # erst hier: rules ruft reconcile() auf

    own = own_accounts_category(conn)
    report = {"pairs": 0, "settled": 0, "unmatched": [], "changed": 0}
    if own is None:
        return report
    kinds = {r["id"]: r["kind"] for r in conn.execute(
        "SELECT c.id, COALESCE(p.kind, c.kind) AS kind FROM categories c LEFT JOIN categories p ON p.id = c.parent_id")}
    txs = [dict(r) for r in conn.execute("SELECT * FROM transactions ORDER BY date, id")]
    accounts = {tx["account"] for tx in txs}
    card_accounts = {a for a in accounts if a and CARD_ACCOUNT.search(a)}
    target = {}                                            # id -> neue Kategorie

    # 1. Paare zwischen zwei eigenen Konten
    by_amount = {}
    for tx in txs:
        if tx["amount"] > 0:
            by_amount.setdefault(tx["amount"], []).append(tx)
    used = set()
    for tx in txs:
        if tx["amount"] >= 0 or tx["id"] in used:
            continue
        hint = _looks_like_move(tx)
        best = None
        for p in by_amount.get(-tx["amount"], ()):
            if p["id"] in used or p["account"] == tx["account"] or _days(p["date"], tx["date"]) > PAIR_DAYS:
                continue
            if not (hint or _looks_like_move(p)):
                continue
            if best is None or _days(p["date"], tx["date"]) < _days(best["date"], tx["date"]):
                best = p
        if best:
            used.update((tx["id"], best["id"]))
            target[tx["id"]] = target[best["id"]] = own
            report["pairs"] += 1

    # 2. Kreditkartenabrechnungen ohne Gegenbuchung
    compiled = [r for r in rules_mod.load_rules(conn) if kinds.get(r.category_id) != "transfer"]
    card_dates = sorted(date.fromisoformat(o["date"][:10]) for o in txs if o["account"] in card_accounts)
    for tx in txs:
        # Abrechnungen werden vom Girokonto abgebucht; auf dem Kartenkonto selbst ist nichts zu prüfen
        if tx["amount"] >= 0 or tx["id"] in used or tx["account"] in card_accounts or not is_settlement(tx):
            continue
        d = date.fromisoformat(tx["date"][:10])
        covered = any(-3 <= (d - o).days <= STATEMENT_DAYS for o in card_dates)
        if covered:
            target[tx["id"]] = own
            report["settled"] += 1
        else:
            # Karte nicht importiert: die Abrechnung ist die einzige Spur der Käufe → als Ausgabe zählen
            target[tx["id"]] = rules_mod.categorize(tx, compiled)
            report["unmatched"].append({"id": tx["id"], "date": tx["date"], "amount": tx["amount"],
                                        "counterparty": tx["counterparty"], "account": tx["account"]})

    for tx in txs:
        if tx["id"] in target and not tx["manual"] and tx["category_id"] != target[tx["id"]]:
            conn.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (target[tx["id"]], tx["id"]))
            report["changed"] += 1
    conn.commit()
    return report
