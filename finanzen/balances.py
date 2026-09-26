"""Kontostände: je Konto ein bekannter Stand an einem Tag („Anker“); jeder andere Tag ergibt sich aus den Buchungen.

Anker kommen aus der Bankanbindung (bei jedem Abruf), aus CSV-Exporten („Kontostand vom 26.09.2026: …“) oder
werden einmal von Hand eingetragen. Formel: Stand(Tag) = Anker + Summe(Buchungen bis Tag) − Summe(Buchungen bis Ankertag).
Später importierte Buchungen vor dem Ankertag verschieben beide Summen gleich – der Anker bleibt richtig.

Kreditkarten brauchen keinen Anker und zählen nicht zum Kontostand: Sie werden über die Abrechnung vom Girokonto
auf null gestellt – der Kontostand ist, was die Bank für das Konto zeigt. (Früher wurde der „offene Betrag“ aus allen
Kartenumsätzen addiert; fehlten im Kartenexport Abrechnungszeilen, lief das über Monate ins Minus.)
"""

import re
from datetime import date

from . import cycles

SCHEMA = """
CREATE TABLE IF NOT EXISTS balances (
    id          INTEGER PRIMARY KEY,
    account     TEXT NOT NULL,
    date        TEXT NOT NULL,           -- Stand am Ende dieses Tages
    amount      INTEGER NOT NULL,        -- Cent
    source      TEXT NOT NULL DEFAULT 'manuell',   -- manuell | bank | csv
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_balances_account ON balances(account, date);
"""


def init(conn):
    conn.executescript(SCHEMA)
    conn.commit()


def set_anchor(conn, account, day, amount, source="manuell"):
    conn.execute("DELETE FROM balances WHERE account = ? AND date = ? AND source = ?", (account, day, source))
    conn.execute("INSERT INTO balances (account, date, amount, source) VALUES (?, ?, ?, ?)", (account, day, amount, source))
    conn.commit()


def anchors(conn):
    """Neuester Anker je Konto (späteres Datum gewinnt, bei gleichem Tag der zuletzt eingetragene)."""
    out = {}
    for r in conn.execute("SELECT * FROM balances ORDER BY date, id"):
        out[r["account"]] = dict(r)
    return out


PAN = re.compile(r"\d{4}\s*[•*·xX.]{2,}[\s•*·xX.\d]*\d{4}")      # maskierte Kartennummer, z. B. 4930 •••• 3767


def is_card(account):
    """Kreditkartenkonto? (Name wie „Visa Kreditkarte ···3767“ oder maskierte Kartennummer)"""
    from .transfers import CARD_ACCOUNT
    return bool(account and (CARD_ACCOUNT.search(account) or PAN.search(account)))


_is_card = is_card


def _sum_until(conn, account, day):
    return conn.execute("SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account = ? AND date <= ?",
                        (account, day)).fetchone()[0]


def balance_at(conn, day, accounts=None):
    """Stand aller Konten am Ende von `day` (Cent). known/missing: Konten mit bzw. ohne bekannten Stand."""
    anc = anchors(conn)
    names = [r[0] for r in conn.execute("SELECT DISTINCT account FROM transactions WHERE account IS NOT NULL")]
    if accounts:
        names = [a for a in names if a in accounts]
    res = {"value": 0, "known": [], "cards": [], "missing": []}
    for acc in names:
        a = anc.get(acc)
        if _is_card(acc):
            # Kreditkarte zählt nie zum Kontostand – auch nicht mit „Saldo vom …“ aus dem Kartenexport
            # (das sind offene Kartenschulden, die über die Abrechnung vom Girokonto beglichen werden)
            res["cards"].append(acc)
        elif a:
            between = _sum_until(conn, acc, day) - _sum_until(conn, acc, a["date"])
            v = a["amount"] + between
            n = conn.execute("SELECT COUNT(*) FROM transactions WHERE account = ? AND date > ? AND date <= ?",
                             (acc, min(day, a["date"]), max(day, a["date"]))).fetchone()[0]
            # Rechenweg: Stand am Ankertag ± Buchungen dazwischen
            res["known"].append({"account": acc, "value": v, "anchor": a["amount"], "anchor_date": a["date"],
                                 "source": a["source"], "between": between, "bookings": n})
            res["value"] += v
        else:
            res["missing"].append(acc)
    return res


def overview(conn):
    """Für die Oberfläche: je Konto Anker und heutiger Stand."""
    anc = anchors(conn)
    today = date.today().isoformat()
    rows = conn.execute(
        "SELECT account, MAX(date) AS last, COUNT(*) AS n FROM transactions WHERE account IS NOT NULL GROUP BY account ORDER BY account")
    out = []
    for r in rows:
        acc = r["account"]
        a = anc.get(acc)
        day = max(today, r["last"])
        cur = (a["amount"] + _sum_until(conn, acc, day) - _sum_until(conn, acc, a["date"])) if a else None
        history = []
        if a and not _is_card(acc):                                                # zurückgerechnet: Stand am Ende der letzten Gehaltsmonate
            cy = cycles.load(conn)
            first = conn.execute("SELECT MIN(date) FROM transactions WHERE account = ?", (acc,)).fetchone()[0]
            k = cy.key_of(r["last"])
            for _ in range(6):
                k = cycles._add_month(k, -1)
                end = cy.range_of(k)[1]
                if end < first:
                    break
                history.append({"month": k, "date": end,
                                "value": a["amount"] + _sum_until(conn, acc, end) - _sum_until(conn, acc, a["date"])})
        out.append({"account": acc, "card": _is_card(acc), "anchor": a, "current": cur, "history": history,
                    "last_booking": r["last"], "count": r["n"]})
    return out
