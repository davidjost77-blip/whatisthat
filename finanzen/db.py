"""SQLite-Datenbank: Schema, Verbindung und Standard-Kategorien."""

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    parent_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income', 'transfer')),
    color       TEXT,
    budget      INTEGER,            -- Monatsbudget in Cent (optional)
    sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    field       TEXT NOT NULL DEFAULT 'any' CHECK (field IN ('any', 'counterparty', 'purpose', 'booking_text', 'iban', 'account')),
    op          TEXT NOT NULL DEFAULT 'contains' CHECK (op IN ('contains', 'equals', 'startswith', 'regex')),
    pattern     TEXT NOT NULL,
    direction   TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'in', 'out')),
    min_amount  INTEGER,            -- Cent, Betrag (absolut)
    max_amount  INTEGER,
    priority    INTEGER NOT NULL DEFAULT 100,
    enabled     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS imports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL,
    profile     TEXT,
    account     TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    rows_total  INTEGER NOT NULL DEFAULT 0,
    rows_new    INTEGER NOT NULL DEFAULT 0,
    rows_skipped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    hash         TEXT NOT NULL UNIQUE,
    date         TEXT NOT NULL,     -- ISO yyyy-mm-dd
    amount       INTEGER NOT NULL,  -- Cent, negativ = Ausgabe
    currency     TEXT NOT NULL DEFAULT 'EUR',
    counterparty TEXT NOT NULL DEFAULT '',
    purpose      TEXT NOT NULL DEFAULT '',
    booking_text TEXT NOT NULL DEFAULT '',
    iban         TEXT NOT NULL DEFAULT '',
    account      TEXT NOT NULL DEFAULT '',
    category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    manual       INTEGER NOT NULL DEFAULT 0,  -- 1 = Kategorie von Hand gesetzt, Regeln überschreiben nicht
    note         TEXT NOT NULL DEFAULT '',
    import_id    INTEGER REFERENCES imports(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account);
"""

# Validierte, farbenblind-sichere Reihenfolge (siehe static/app.css --series-*)
PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
NEUTRAL = "#898781"  # Umbuchungen / "Sonstige" in Diagrammen

# (Name, Art, [Unterkategorien], [(Unterkategorie|None, Feld, Muster, Richtung)])
DEFAULT_CATEGORIES = [
    ("Einkommen", "income", ["Gehalt", "Erstattungen", "Sonstige Einnahmen"], [
        ("Gehalt", "any", r"gehalt|lohn|bezüge|bezuege", "in"),
        ("Sonstige Einnahmen", "any", r"zinsen|dividende|ausschüttung", "in"),
        ("Erstattungen", "any", r"erstattung|rückzahlung|rueckzahlung|gutschrift", "in"),
    ]),
    ("Wohnen", "expense", ["Miete", "Energie", "Internet & Telefon"], [
        ("Miete", "purpose", r"miete|hausgeld", "out"),
        ("Energie", "any", r"stadtwerke|vattenfall|e\.on|eon energie|enbw|strom|\bgas\b", "out"),
        ("Internet & Telefon", "any", r"telekom|vodafone|\bo2\b|telefonica|1&1|congstar", "out"),
    ]),
    ("Lebensmittel", "expense", ["Supermarkt", "Bäcker"], [
        ("Supermarkt", "counterparty", r"rewe|edeka|lidl|aldi|netto|penny|kaufland|denns|alnatura|tegut", "out"),
        ("Bäcker", "counterparty", r"bäcker|baecker|backhaus|backwerk", "out"),
    ]),
    ("Mobilität", "expense", ["Tanken", "ÖPNV & Bahn", "Auto"], [
        ("Tanken", "counterparty", r"shell|aral|esso|totalenergies|jet tankstelle|tankstelle", "out"),
        ("ÖPNV & Bahn", "any", r"db vertrieb|deutsche bahn|bvg|mvg|hvv|vgn|deutschlandticket|flixbus", "out"),
        ("Auto", "any", r"kfz|werkstatt|\batu\b|parkhaus|parken", "out"),
    ]),
    ("Freizeit", "expense", ["Restaurants & Cafés", "Abos & Streaming", "Sport", "Reisen"], [
        ("Restaurants & Cafés", "counterparty", r"restaurant|pizzeria|café|cafe|lieferando|starbucks|mcdonalds|burger", "out"),
        ("Abos & Streaming", "counterparty", r"netflix|spotify|disney|dazn|apple\.com|audible|youtube", "out"),
        ("Sport", "counterparty", r"fitness|urban sports|mcfit|sportverein", "out"),
        ("Reisen", "counterparty", r"booking\.com|airbnb|lufthansa|ryanair|eurowings|hotel", "out"),
    ]),
    ("Shopping", "expense", ["Online", "Kleidung", "Drogerie"], [
        ("Online", "counterparty", r"amazon|ebay|\botto\b|paypal", "out"),
        ("Kleidung", "counterparty", r"zalando|h&m|zara|c&a|about you", "out"),
        ("Drogerie", "counterparty", r"dm-drogerie|dm drogerie|rossmann", "out"),
    ]),
    ("Gesundheit & Versicherungen", "expense", ["Gesundheit", "Versicherungen"], [
        ("Gesundheit", "counterparty", r"apotheke|arzt|zahnarzt|praxis", "out"),
        ("Versicherungen", "any", r"versicherung|allianz|\bhuk\b|\bergo\b|\baxa\b|debeka|signal iduna", "out"),
    ]),
    ("Sonstiges", "expense", ["Bargeld", "Gebühren", "Spenden"], [
        ("Bargeld", "any", r"bargeld|geldautomat|\batm\b|auszahlung", "out"),
        ("Gebühren", "any", r"entgelt|gebühr|gebuehr|kontoführung|kontofuehrung", "out"),
        ("Spenden", "any", r"spende", "out"),
    ]),
    ("Sparen & Umbuchungen", "transfer", ["Sparen", "Eigene Konten"], [
        ("Sparen", "any", r"sparplan|depot|tagesgeld|trade republic|scalable", "out"),
        ("Eigene Konten", "any", r"umbuchung|übertrag|uebertrag", "any"),
    ]),
]


def connect(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(path, seed=True):
    conn = connect(path)
    conn.executescript(SCHEMA)
    if seed and conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
        seed_defaults(conn)
    conn.commit()
    conn.close()


DEFAULT_BUDGETS = {"Lebensmittel": 550, "Freizeit": 450, "Shopping": 300, "Mobilität": 300}


def seed_defaults(conn):
    color_slot = 0
    for sort, (name, kind, children, rules) in enumerate(DEFAULT_CATEGORIES):
        if kind == "transfer":
            color = NEUTRAL
        else:
            color = PALETTE[color_slot % len(PALETTE)]
            color_slot += 1
        parent_id = conn.execute(
            "INSERT INTO categories (name, kind, color, budget, sort) VALUES (?, ?, ?, ?, ?)",
            (name, kind, color, DEFAULT_BUDGETS[name] * 100 if name in DEFAULT_BUDGETS else None, sort),
        ).lastrowid
        ids = {}
        for child_sort, child in enumerate(children):
            ids[child] = conn.execute(
                "INSERT INTO categories (name, parent_id, kind, color, sort) VALUES (?, ?, ?, ?, ?)",
                (child, parent_id, kind, color, child_sort),
            ).lastrowid
        for child, field, pattern, direction in rules:
            conn.execute(
                "INSERT INTO rules (category_id, field, op, pattern, direction) VALUES (?, ?, 'regex', ?, ?)",
                (ids.get(child, parent_id), field, pattern, direction),
            )
