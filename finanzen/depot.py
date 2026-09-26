"""ETF-Depot und Sparplan: Käufe, Einstellungen, Live-Kurse (Yahoo Finance) mit Zwischenspeicher."""

import calendar
import json
import logging
import time
from datetime import date
import urllib.parse
import urllib.request

log = logging.getLogger("finanzen.depot")

SCHEMA = """
CREATE TABLE IF NOT EXISTS depot_tx (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    date    TEXT NOT NULL,              -- ISO yyyy-mm-dd
    symbol  TEXT NOT NULL,              -- Kürzel bei Yahoo Finance, z. B. VWCE.DE
    shares  REAL NOT NULL,              -- Stück (Bruchteile möglich)
    amount  INTEGER NOT NULL,           -- Kaufbetrag in Cent inkl. Gebühren
    note    TEXT NOT NULL DEFAULT '',
    estimated INTEGER NOT NULL DEFAULT 0  -- 1 = Stückzahl geschätzt (automatisch gebucht), bitte prüfen
);

CREATE TABLE IF NOT EXISTS depot_settings (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL               -- JSON
);

CREATE TABLE IF NOT EXISTS quote_cache (
    key        TEXT PRIMARY KEY,        -- symbol|range|interval
    fetched_at REAL NOT NULL,
    data       TEXT NOT NULL            -- JSON
);
"""

# Kürzel sind Xetra-Notierungen in EUR bei Yahoo Finance. Rendite/Schwankung sind langfristige
# Annahmen (nominal, p. a.) als Startwert für die Projektion und lassen sich in der App ändern.
CATALOG = [
    {"symbol": "VWCE.DE", "isin": "IE00BK5BQT80", "name": "Vanguard FTSE All-World (Acc)", "short": "FTSE All-World",
     "ter": 0.19, "ret": 7.0, "vol": 15.0, "group": "Welt"},
    {"symbol": "EUNL.DE", "isin": "IE00B4L5Y983", "name": "iShares Core MSCI World (Acc)", "short": "MSCI World",
     "ter": 0.20, "ret": 7.0, "vol": 15.0, "group": "Welt"},
    {"symbol": "IS3N.DE", "isin": "IE00BKM4GZ66", "name": "iShares Core MSCI EM IMI (Acc)", "short": "Schwellenländer",
     "ter": 0.18, "ret": 6.5, "vol": 19.0, "group": "Region"},
    {"symbol": "SXR8.DE", "isin": "IE00B5BMR087", "name": "iShares Core S&P 500 (Acc)", "short": "S&P 500",
     "ter": 0.07, "ret": 8.0, "vol": 16.0, "group": "Region"},
    {"symbol": "SXRV.DE", "isin": "IE00B53SZB19", "name": "iShares Nasdaq 100 (Acc)", "short": "Nasdaq 100",
     "ter": 0.30, "ret": 9.0, "vol": 22.0, "group": "Region"},
    {"symbol": "ZPRV.DE", "isin": "IE00BSPLC413", "name": "SPDR MSCI USA Small Cap Value Weighted (Acc)",
     "short": "USA Small Cap Value", "ter": 0.30, "ret": 8.0, "vol": 22.0, "group": "Faktor"},
    {"symbol": "ZPRX.DE", "isin": "IE00BSPLC298", "name": "SPDR MSCI Europe Small Cap Value Weighted (Acc)",
     "short": "Europa Small Cap Value", "ter": 0.30, "ret": 7.5, "vol": 19.0, "group": "Faktor"},
    {"symbol": "XDWT.DE", "isin": "IE00BM67HT60", "name": "Xtrackers MSCI World Information Technology (Acc)",
     "short": "Welt-Technologie", "ter": 0.25, "ret": 9.0, "vol": 22.0, "group": "Branche"},
    {"symbol": "4GLD.DE", "isin": "DE000A0S9GB0", "name": "Xetra-Gold (ETC)", "short": "Gold",
     "ter": 0.0, "ret": 4.0, "vol": 15.0, "group": "Sonstige"},
    {"symbol": "XEON.DE", "isin": "LU0290358497", "name": "Xtrackers II EUR Overnight Rate Swap (Acc)",
     "short": "Geldmarkt", "ter": 0.10, "ret": 2.5, "vol": 0.5, "group": "Sonstige"},
]

# Startbestand: laufender Sparplan (250 € monatlich in den FTSE All-World) mit den bisherigen Käufen.
# Die Stückzahl vom 25.06. ist aus dem Kontoauszug vom 26.09. abgeleitet (1.192,45 € Depotwert).
FIRST_PURCHASE = ("2026-06-25", "VWCE.DE", 1.49, 25000, "Sparplan · Stück aus Kontoauszug geschätzt", 1)
SEED_TX = [
    FIRST_PURCHASE[:5],
    ("2026-07-10", "VWCE.DE", 1.0, 16669, "Einmalkauf"),
    ("2026-07-27", "VWCE.DE", 1.51, 25000, "Sparplan"),
    ("2026-08-25", "VWCE.DE", 1.50, 25000, "Sparplan"),
    ("2026-09-25", "VWCE.DE", 1.46, 25000, "Sparplan"),
]
DEFAULT_SETTINGS = {
    "cash": 3331,                                   # Guthaben (Verrechnungskonto) in Cent
    "snapshot": {"date": "2026-09-26", "total": 122576, "portfolio": 119245},  # letzter Kontoauszug
    # Sparplan: wird automatisch jeden Monat am Ausführungstag gebucht (nächster Handelstag), solange aktiv
    "plan": {"symbol": "VWCE.DE", "rate": 250, "day": 25, "active": True},
    "scenario": {
        "years": 25, "rate": 250, "dynamic": 0, "ret": 7.0, "vol": 15.0, "ter": 0.19, "inflation": 2.0,
        "real": False, "tax": False, "lumps": [],
    },
    "extras": [],                                   # hypothetische zusätzliche ETFs
    # Soll-Maßstäbe (None = aus den Umsätzen ableiten), Beträge in Cent
    "targets": {"monthly_expense": None, "fixed": None, "savings_rate": 20, "goal": 10000000, "goal_year": None},
}

TTL = {"1d": 15 * 60, "1wk": 6 * 3600, "1mo": 12 * 3600}
RANGES = {"1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max", "ytd"}
INTERVALS = {"1d", "1wk", "1mo"}
USER_AGENT = "Mozilla/5.0 (Finanzen lokales Dashboard)"


class QuoteError(Exception):
    pass


def init(conn):
    conn.executescript(SCHEMA)
    columns = {r[1] for r in conn.execute("PRAGMA table_info(depot_tx)")}
    if "estimated" not in columns:
        conn.execute("ALTER TABLE depot_tx ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0")
    if conn.execute("SELECT COUNT(*) FROM depot_settings").fetchone()[0] == 0:
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT INTO depot_settings (key, value) VALUES (?, ?)", (key, json.dumps(value)))
        conn.executemany("INSERT INTO depot_tx (date, symbol, shares, amount, note) VALUES (?, ?, ?, ?, ?)", SEED_TX)
        conn.execute("UPDATE depot_tx SET estimated = 1 WHERE date = ? AND note = ?", (FIRST_PURCHASE[0], FIRST_PURCHASE[4]))
        conn.execute("INSERT INTO depot_settings (key, value) VALUES ('applied_fixes', ?)", (json.dumps(["first-purchase-2026-06"]),))
    apply_fixes(conn)
    conn.commit()


def apply_fixes(conn):
    """Einmalige Korrekturen an bestehenden Datenbanken (jede läuft genau einmal)."""
    row = conn.execute("SELECT value FROM depot_settings WHERE key = 'applied_fixes'").fetchone()
    done = set(json.loads(row[0])) if row else set()
    if "first-purchase-2026-06" not in done:
        # Nachtrag: erster Sparplan-Kauf am 25.06.2026 fehlte. Nur in der Datenbank mit dem ursprünglichen
        # Startbestand (Einmalkauf 10.07.2026 über 166,69 €) und nur, wenn im Juni noch nichts gebucht ist.
        seeded = conn.execute("SELECT 1 FROM depot_tx WHERE date = '2026-07-10' AND symbol = 'VWCE.DE' AND amount = 16669").fetchone()
        june = conn.execute("SELECT 1 FROM depot_tx WHERE date LIKE '2026-06-%' AND symbol = 'VWCE.DE'").fetchone()
        if seeded and not june:
            conn.execute("INSERT INTO depot_tx (date, symbol, shares, amount, note, estimated) VALUES (?, ?, ?, ?, ?, ?)", FIRST_PURCHASE)
            log.info("Korrektur: ersten Sparplan-Kauf vom 25.06.2026 nachgetragen")
        done.add("first-purchase-2026-06")
    conn.execute("INSERT OR REPLACE INTO depot_settings (key, value) VALUES ('applied_fixes', ?)", (json.dumps(sorted(done)),))


def get_settings(conn):
    stored = {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT key, value FROM depot_settings")
              if r["key"] in DEFAULT_SETTINGS}
    settings = {**DEFAULT_SETTINGS, **stored}
    settings["plan"] = {**DEFAULT_SETTINGS["plan"], **settings["plan"]}
    return settings


def save_settings(conn, values):
    for key, value in values.items():
        if key not in DEFAULT_SETTINGS:
            raise ValueError(f"Unbekannte Einstellung: {key}")
        conn.execute("INSERT OR REPLACE INTO depot_settings (key, value) VALUES (?, ?)", (key, json.dumps(value)))
    conn.commit()
    return get_settings(conn)


# ------------------------------------------------------------------ Kurse
def _http_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


# Austauschbar für Tests
fetch_json = _http_json


def parse_chart(raw, symbol):
    """Yahoo-Chart-Antwort → {symbol, currency, price, prev_close, time, points: [[yyyy-mm-dd, close], …]}"""
    try:
        result = raw["chart"]["result"][0]
    except (KeyError, IndexError, TypeError):
        err = (raw.get("chart") or {}).get("error") if isinstance(raw, dict) else None
        raise QuoteError((err or {}).get("description") or f"Keine Kursdaten für {symbol}.")
    meta = result.get("meta", {})
    stamps = result.get("timestamp") or []
    closes = ((result.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") \
        or ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    offset = meta.get("gmtoffset") or 0
    points, seen = [], {}
    for ts, close in zip(stamps, closes):
        if close is None:
            continue
        day = time.strftime("%Y-%m-%d", time.gmtime(ts + offset))
        if day in seen:  # gleicher Tag doppelt (z. B. laufender Handelstag) → letzten Wert nehmen
            points[seen[day]][1] = round(close, 4)
        else:
            seen[day] = len(points)
            points.append([day, round(close, 4)])
    price = meta.get("regularMarketPrice") or (points[-1][1] if points else None)
    if price is None:
        raise QuoteError(f"Kein Kurs für {symbol}.")
    return {
        "symbol": meta.get("symbol", symbol),
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "currency": meta.get("currency", "EUR"),
        "exchange": meta.get("exchangeName", ""),
        "price": price,
        "prev_close": meta.get("chartPreviousClose") or meta.get("previousClose"),
        "time": meta.get("regularMarketTime"),
        "points": points,
    }


def chart(conn, symbol, rng="1y", interval="1d", force=False):
    """Kursverlauf mit Zwischenspeicher. Ist die Quelle nicht erreichbar, kommt der letzte Stand (stale=True)."""
    symbol = symbol.strip().upper()
    if not symbol or len(symbol) > 20 or rng not in RANGES or interval not in INTERVALS:
        raise QuoteError("Ungültige Anfrage.")
    key = f"{symbol}|{rng}|{interval}"
    row = conn.execute("SELECT fetched_at, data FROM quote_cache WHERE key = ?", (key,)).fetchone()
    now = time.time()
    ttl = 60 if rng in ("1d", "5d") else TTL[interval]  # aktueller Kurs: höchstens eine Minute alt
    if row and not force and now - row["fetched_at"] < ttl:
        return {**json.loads(row["data"]), "fetched_at": row["fetched_at"], "stale": False}
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
           f"?range={rng}&interval={interval}&includeAdjustedClose=true")
    try:
        data = parse_chart(fetch_json(url), symbol)
    except Exception as e:
        log.info("Kursabruf %s fehlgeschlagen: %s", symbol, e)
        if row:
            return {**json.loads(row["data"]), "fetched_at": row["fetched_at"], "stale": True, "error": str(e)}
        raise QuoteError(f"Kurs für {symbol} nicht abrufbar ({e}).")
    conn.execute("INSERT OR REPLACE INTO quote_cache (key, fetched_at, data) VALUES (?, ?, ?)",
                 (key, now, json.dumps(data)))
    conn.commit()
    return {**data, "fetched_at": now, "stale": False}


def search(query):
    """Wertpapiersuche (Name, ISIN oder Kürzel) – nur ETFs/Fonds/Aktien."""
    url = ("https://query2.finance.yahoo.com/v1/finance/search?"
           + urllib.parse.urlencode({"q": query, "quotesCount": 12, "newsCount": 0, "lang": "de-DE", "region": "DE"}))
    try:
        raw = fetch_json(url)
    except Exception as e:
        raise QuoteError(f"Suche nicht möglich ({e}).")
    return [
        {"symbol": q["symbol"], "name": q.get("longname") or q.get("shortname") or q["symbol"],
         "exchange": q.get("exchDisp", ""), "type": q.get("typeDisp", "")}
        for q in raw.get("quotes", []) if q.get("symbol") and q.get("quoteType") in ("ETF", "MUTUALFUND", "EQUITY")
    ]


def stats(points):
    """Historische Rendite p. a. (CAGR) und Schwankung p. a. aus Monatsschlusskursen."""
    monthly = {}
    for day, close in points:
        monthly[day[:7]] = close
    closes = list(monthly.values())
    if len(closes) < 13:
        return None
    rets = [b / a - 1 for a, b in zip(closes, closes[1:]) if a]
    years = (len(closes) - 1) / 12
    cagr = (closes[-1] / closes[0]) ** (1 / years) - 1
    mean = sum(rets) / len(rets)
    vol = (sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)) ** 0.5 * 12 ** 0.5
    return {"cagr": round(cagr * 100, 2), "vol": round(vol * 100, 2), "years": round(years, 1),
            "from": points[0][0], "to": points[-1][0]}


# ------------------------------------------------------------------ Automatischer Sparplan
def _range_for(days_back):
    return "5d" if days_back < 4 else "1mo" if days_back < 25 else "6mo" if days_back < 170 else "1y" if days_back < 350 \
        else "2y" if days_back < 700 else "5y"


def due_dates(last_ym, day, today):
    """Ausführungstermine (Soll) der Monate nach ``last_ym`` bis heute."""
    y, m = int(last_ym[:4]), int(last_ym[5:7])
    out = []
    while True:
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        due = date(y, m, min(day, calendar.monthrange(y, m)[1]))
        if due > today:
            return out
        out.append(due)


def _last_plan_month(conn, symbol, rate_cents):
    """Monat der letzten Sparplan-Rate: letzter Kauf über genau die Rate, sonst letzter Kauf überhaupt."""
    row = conn.execute("SELECT MAX(date) FROM depot_tx WHERE symbol = ? AND amount = ?", (symbol, rate_cents)).fetchone()
    last = row[0] or conn.execute("SELECT MAX(date) FROM depot_tx WHERE symbol = ?", (symbol,)).fetchone()[0]
    return last[:7] if last else None


def auto_execute(conn, today=None):
    """Bucht fällige Sparplan-Raten automatisch: je Monat eine Rate am Ausführungstag bzw. dem nächsten Handelstag.

    Die Stückzahl ergibt sich aus dem Schlusskurs dieses Tages (ohne Internet: letzter bekannter Kurs) und ist als
    geschätzt markiert, bis sie in der App bestätigt oder korrigiert wird. Einmalkäufe verschieben nichts; eine
    von Hand eingetragene Rate im selben Monat (gleicher Betrag, ab drei Tage vor dem Termin) zählt als ausgeführt.
    Liefert die neu gebuchten Käufe.
    """
    settings = get_settings(conn)
    plan = settings["plan"]
    if not plan.get("active", True) or not plan.get("rate"):
        return []
    today = today or date.today()
    symbol, rate, day = plan["symbol"], float(plan["rate"]), int(plan.get("day") or 25)
    cents = int(round(rate * 100))
    last_ym = plan.get("last_executed") or _last_plan_month(conn, symbol, cents)
    if not last_ym:
        return []
    dues = due_dates(last_ym, day, today)
    if not dues:
        if plan.get("last_executed") != last_ym:
            save_settings(conn, {"plan": {**plan, "last_executed": last_ym}})
        return []
    points, fallback = [], None
    try:
        points = chart(conn, symbol, _range_for((today - dues[0]).days + 5), "1d")["points"]
    except QuoteError as e:
        log.info("Sparplan: kein Kursverlauf (%s), nutze letzten bekannten Kurs", e)
    if not points:
        try:
            fallback = chart(conn, symbol, "5d", "1d")["price"]
        except QuoteError:
            row = conn.execute("SELECT amount, shares FROM depot_tx WHERE symbol = ? ORDER BY date DESC, id DESC LIMIT 1",
                               (symbol,)).fetchone()
            fallback = row[0] / 100 / row[1]
    created = []
    for due in dues:
        iso = due.isoformat()
        month = iso[:7]
        earliest = date.fromordinal(due.toordinal() - 3).isoformat()
        manual = conn.execute("SELECT 1 FROM depot_tx WHERE symbol = ? AND amount = ? AND date >= ? AND date LIKE ?",
                              (symbol, cents, earliest, f"{month}-%")).fetchone()
        if not manual:
            # erster Handelstag ab dem Ausführungstag; liegt noch kein Schlusskurs vor, gilt der letzte bekannte
            hit = next(((d, p) for d, p in points if d >= iso), None)
            when, price = hit if hit else (iso, points[-1][1] if points else fallback)
            shares = round(rate / price, 4)
            cur = conn.execute(
                "INSERT INTO depot_tx (date, symbol, shares, amount, note, estimated) VALUES (?, ?, ?, ?, ?, 1)",
                (when, symbol, shares, cents, "Sparplan (automatisch)"))
            created.append({"id": cur.lastrowid, "date": when, "shares": shares, "amount": cents, "price": round(price, 2)})
        last_ym = month
    save_settings(conn, {"plan": {**plan, "last_executed": last_ym}})
    conn.commit()
    if created:
        log.info("Sparplan: %d Rate(n) automatisch gebucht", len(created))
    return created
