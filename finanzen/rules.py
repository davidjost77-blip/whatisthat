"""Regelbasierte Kategorisierung."""

import re

FIELDS = ("counterparty", "purpose", "booking_text", "iban", "account")


class CompiledRule:
    def __init__(self, row):
        self.id = row["id"]
        self.category_id = row["category_id"]
        self.field = row["field"]
        self.op = row["op"]
        self.direction = row["direction"]
        self.min_amount = row["min_amount"]
        self.max_amount = row["max_amount"]
        pattern = row["pattern"]
        if self.op == "regex":
            self.regex = re.compile(pattern, re.IGNORECASE)
        else:
            self.needle = pattern.strip().lower()

    def _text_matches(self, text):
        text = (text or "").lower()
        if self.op == "regex":
            return bool(self.regex.search(text))
        if self.op == "equals":
            return text.strip() == self.needle
        if self.op == "startswith":
            return text.strip().startswith(self.needle)
        return self.needle in text

    def matches(self, tx):
        amount = tx["amount"]
        if self.direction == "in" and amount <= 0:
            return False
        if self.direction == "out" and amount >= 0:
            return False
        if self.min_amount is not None and abs(amount) < self.min_amount:
            return False
        if self.max_amount is not None and abs(amount) > self.max_amount:
            return False
        fields = FIELDS[:3] if self.field == "any" else (self.field,)
        return any(self._text_matches(tx[f]) for f in fields)


def validate_pattern(op, pattern):
    """Gibt eine Fehlermeldung zurück oder None."""
    if not (pattern or "").strip():
        return "Das Suchmuster darf nicht leer sein."
    if op == "regex":
        try:
            re.compile(pattern)
        except re.error as e:
            return f"Ungültiger regulärer Ausdruck: {e}"
    return None


def load_rules(conn):
    rows = conn.execute(
        "SELECT * FROM rules WHERE enabled = 1 ORDER BY priority, id"
    ).fetchall()
    compiled = []
    for row in rows:
        try:
            compiled.append(CompiledRule(row))
        except re.error:
            continue  # defekte Regel ignorieren statt den Import zu blockieren
    return compiled


def categorize(tx, rules):
    for rule in rules:
        if rule.matches(tx):
            return rule.category_id
    return None


def apply_rules(conn, only_uncategorized=False):
    """Kategorisiert alle nicht manuell gesetzten Buchungen neu. Gibt Anzahl Änderungen zurück."""
    rules = load_rules(conn)
    sql = "SELECT * FROM transactions WHERE manual = 0"
    if only_uncategorized:
        sql += " AND category_id IS NULL"
    changed = 0
    for tx in conn.execute(sql).fetchall():
        new = categorize(tx, rules)
        if new != tx["category_id"]:
            conn.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (new, tx["id"]))
            changed += 1
    conn.commit()
    return changed
