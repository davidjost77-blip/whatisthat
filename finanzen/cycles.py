"""Gehaltsmonate: Ein „Monat“ reicht von einer Gehaltsüberweisung bis unmittelbar vor die nächste.

- Gehaltsbuchungen = Einnahmen in der Kategorie „Gehalt“. Kleinere Sonderzahlungen (Weihnachtsgeld, Bonus unter
  der Hälfte des üblichen Gehalts) oder Zahlungen kurz nach dem letzten Gehalt (< 24 Tage) starten keinen neuen Monat.
- Jeder Gehaltsmonat bekommt den Namen des Kalendermonats, in dem die meisten seiner Tage liegen (Gehalt am 28.09.
  → „Oktober“). So bleiben alle Monatsansichten, Vergleiche und Budgets gleich lesbar.
- Der laufende Monat endet am Tag vor dem erwarteten nächsten Gehalt (letztes Gehalt + übliche Spanne).
- Ohne erkennbares Gehalt (noch keine Daten, anderes Einkommen) gelten Kalendermonate.
"""

import bisect
from datetime import date, timedelta
from statistics import median

MIN_GAP = 24          # Tage: kürzere Abstände sind Sonderzahlungen, kein neuer Monat
MIN_SHARE = 0.5       # Zahlungen unter der Hälfte des üblichen Gehalts starten keinen Monat


def _d(s):
    return date.fromisoformat(s[:10])


def _ym(d):
    return f"{d.year:04d}-{d.month:02d}"


def _add_month(ym, n):
    y, m = int(ym[:4]), int(ym[5:7]) - 1 + n
    return f"{y + m // 12:04d}-{m % 12 + 1:02d}"


def _calendar(ym):
    y, m = int(ym[:4]), int(ym[5:7])
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
    return date(y, m, 1), last


def _next_month_same_day(d):
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    last = _calendar(f"{y:04d}-{m:02d}")[1].day
    return date(y, m, min(d.day, last))


def _majority_month(start, end):
    counts = {}
    d = start
    while d <= end:
        counts[_ym(d)] = counts.get(_ym(d), 0) + 1
        d += timedelta(days=1)
    return max(counts, key=lambda k: (counts[k], k))


def salary_starts(conn):
    rows = conn.execute(
        """SELECT t.date, t.amount FROM transactions t JOIN categories c ON c.id = t.category_id
           WHERE t.amount > 0 AND lower(c.name) = 'gehalt' ORDER BY t.date, t.id"""
    ).fetchall()
    if not rows:
        return []
    base = median(r["amount"] for r in rows)
    cands = [(_d(r["date"]), r["amount"]) for r in rows if r["amount"] >= base * MIN_SHARE]
    typical = median(a for _, a in cands)                  # übliches Gehalt (ohne Kleinbeträge)
    starts = []                                            # [(Datum, Betrag)]
    for d, a in cands:
        if starts and (d - starts[-1][0]).days < MIN_GAP:
            # zwei Zahlungen dicht beieinander: die dem üblichen Gehalt nähere beginnt den Monat
            if abs(a - typical) < abs(starts[-1][1] - typical):
                starts[-1] = (d, a)
            continue
        starts.append((d, a))
    return [d for d, _ in starts]


class Cycles:
    """Zuordnung Datum → Monatsschlüssel (YYYY-MM) und Schlüssel → Datumsbereich."""

    def __init__(self, starts, today=None):
        self.today = today or date.today()
        self.cycles = []                  # [{key, from, to, salary, open}]
        if not starts:
            return
        prev_key = None
        for i, s in enumerate(starts):
            if i + 1 < len(starts):
                end, is_open = starts[i + 1] - timedelta(days=1), False
            else:
                end, is_open = _next_month_same_day(s) - timedelta(days=1), True   # erwartetes nächstes Gehalt
            key = _majority_month(s, end)
            if prev_key and key <= prev_key:
                key = _add_month(prev_key, 1)
            self.cycles.append({"key": key, "from": s.isoformat(), "to": end.isoformat(), "open": is_open})
            prev_key = key
        self._starts = [c["from"] for c in self.cycles]
        self._by_key = {c["key"]: c for c in self.cycles}

    @property
    def active(self):
        return bool(self.cycles)

    def key_of(self, iso):
        """Monatsschlüssel eines Datums."""
        if not self.cycles:
            return iso[:7]
        i = bisect.bisect_right(self._starts, iso[:10]) - 1
        if i < 0:                                            # vor dem ersten Gehalt: Kalendermonat, aber davor einsortiert
            k = iso[:7]
            first = self.cycles[0]["key"]
            return k if k < first else _add_month(first, -1)
        c = self.cycles[i]
        if iso[:10] <= c["to"]:
            return c["key"]
        # nach dem erwarteten Ende ohne neues Gehalt: Kalendermonate, hinter dem letzten Gehaltsmonat
        k = iso[:7]
        return k if k > c["key"] else _add_month(c["key"], 1)

    def range_of(self, key):
        """(von, bis) als ISO-Datum."""
        c = self._by_key.get(key) if self.cycles else None
        if c:
            return c["from"], c["to"]
        a, b = _calendar(key)
        if self.cycles:                                      # Kalender-Ersatz nicht in Gehaltsmonate hineinragen lassen
            first, last = self.cycles[0], self.cycles[-1]
            if key < first["key"]:
                b = min(b, _d(first["from"]) - timedelta(days=1))
            elif key > last["key"]:
                a = max(a, _d(last["to"]) + timedelta(days=1))
        return a.isoformat(), b.isoformat()

    def keys_between(self, date_from, date_to):
        """Alle Monatsschlüssel, die den Zeitraum berühren (in Reihenfolge, lückenlos)."""
        a, b = self.key_of(date_from), self.key_of(date_to)
        out, k = [], a
        while k <= b:
            out.append(k)
            k = _add_month(k, 1)
        return out

    def as_list(self, date_from=None, date_to=None):
        if not self.cycles:
            return []
        keys = self.keys_between(date_from or self.cycles[0]["from"], max(date_to or "", self.cycles[-1]["to"]))
        return [{"key": k, "from": self.range_of(k)[0], "to": self.range_of(k)[1], "salary": k in self._by_key} for k in keys]


def load(conn, today=None):
    return Cycles(salary_starts(conn), today)
