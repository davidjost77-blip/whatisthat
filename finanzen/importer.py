"""CSV-Import für Kontoauszüge aus Banking-Apps.

Erkennt automatisch Zeichensatz, Trennzeichen, Kopfzeile, Datums- und
Zahlenformat. Die Spalten werden über Aliase zugeordnet, womit u. a. DKB, ING,
Sparkasse, Volksbank, comdirect, Commerzbank, Postbank, N26 und Revolut ohne
weitere Konfiguration funktionieren. Für exotische Formate können eigene
Profile in ``profiles.json`` hinterlegt werden (siehe README).
"""

import csv
import hashlib
import io
import json
import re
from datetime import date, datetime
from pathlib import Path

# Kanonisches Feld -> mögliche Spaltennamen (klein geschrieben, ohne Anführungszeichen).
# Die Reihenfolge bestimmt die Priorität, falls mehrere Spalten passen.
ALIASES = {
    "date": ["buchungsdatum", "buchungstag", "buchung", "booking date", "datum", "date", "completed date",
             "started date", "transaktionsdatum", "belegdatum", "valutadatum", "wertstellung"],
    "amount": ["betrag (€)", "betrag (eur)", "betrag in eur", "umsatz in eur", "betrag", "amount (eur)",
               "amount", "umsatz", "betrag eur", "wert"],
    "debit": ["soll", "soll (eur)", "ausgang", "belastung", "debit"],
    "credit": ["haben", "haben (eur)", "eingang", "gutschrift", "credit"],
    "sign": ["soll/haben", "s/h", "soll-haben-kennzeichen"],
    "currency": ["währung", "waehrung", "currency", "whrg"],
    "payee": ["zahlungsempfänger*in", "zahlungsempfänger", "zahlungsempfaenger", "empfänger", "empfaenger"],
    "payer": ["zahlungspflichtige*r", "zahlungspflichtiger", "auftraggeber"],
    "counterparty": ["name zahlungsbeteiligter", "beguenstigter/zahlungspflichtiger", "begünstigter/zahlungspflichtiger",
                     "auftraggeber/empfänger", "auftraggeber / begünstigter", "auftraggeber/begünstigter",
                     "empfänger/auftraggeber", "partner name", "payee", "name", "description", "gegenkonto name",
                     "zahlungsbeteiligter"],
    "purpose": ["verwendungszweck", "payment reference", "vorgang/verwendungszweck", "buchungsdetails",
                "reference", "beschreibung", "text"],
    "booking_text": ["buchungstext", "umsatztyp", "umsatzart", "transaction type", "type", "vorgang", "buchungsart"],
    "iban": ["iban zahlungsbeteiligter", "kontonummer/iban", "iban", "partner iban", "gegenkonto iban",
             "account number", "gegen-iban"],
    "account": ["iban auftragskonto", "auftragskonto", "bezeichnung auftragskonto", "account name", "product"],
    "status": ["status", "state", "info"],
}

SKIP_STATUS = {"vorgemerkt", "umsatz vorgemerkt", "pending", "reverted", "declined", "failed", "storniert",
               "abgelehnt"}

DATE_FORMATS = ["%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%m/%d/%Y"]

IBAN_RE = re.compile(r"\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?)\b")


class ImportError_(Exception):
    """Fehler beim Einlesen einer Datei (deutsche Meldung für die Oberfläche)."""


def _norm(header):
    return re.sub(r"\s+", " ", (header or "").strip().strip('"').strip("﻿").lower())


def decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ImportError_("Zeichensatz der Datei konnte nicht erkannt werden.")


def detect_delimiter(lines):
    sample = [line for line in lines[:40] if line.strip()]
    best, best_score = ";", -1
    for delim in (";", ",", "\t", "|"):
        counts = [len(next(csv.reader([line], delimiter=delim))) for line in sample]
        # Bevorzugt: viele Zeilen mit gleicher (großer) Spaltenzahl
        if not counts:
            continue
        common = max(set(counts), key=counts.count)
        score = counts.count(common) * common if common > 1 else 0
        if score > best_score:
            best, best_score = delim, score
    return best


def map_columns(header, profile_columns=None):
    """Ordnet kanonische Felder den Spaltenindizes zu."""
    normed = [_norm(h) for h in header]
    mapping = {}
    if profile_columns:
        for field, column in profile_columns.items():
            if _norm(column) in normed:
                mapping[field] = normed.index(_norm(column))
        return mapping
    used = set()
    for field, aliases in ALIASES.items():
        for alias in aliases:
            if alias in normed:
                idx = normed.index(alias)
                if idx not in used:
                    mapping[field] = idx
                    used.add(idx)
                    break
    return mapping


def _has_amount(mapping):
    return "amount" in mapping or ("debit" in mapping and "credit" in mapping)


def find_header(rows, profiles):
    """Sucht die Kopfzeile in den ersten Zeilen (Banken schreiben oft Metadaten davor)."""
    for i, row in enumerate(rows[:40]):
        for profile in profiles:
            mapping = map_columns(row, profile["columns"])
            if len(mapping) == len(profile["columns"]):
                return i, mapping, profile
        mapping = map_columns(row)
        if "date" in mapping and _has_amount(mapping):
            return i, mapping, None
    raise ImportError_(
        "Keine passende Kopfzeile gefunden. Die Datei braucht mindestens eine Datums- und eine Betragsspalte "
        "– oder ein eigenes Profil in profiles.json."
    )


def detect_decimal(values):
    """',' oder '.' als Dezimaltrennzeichen – anhand aller Beträge der Datei."""
    comma = dot = 0
    for v in values:
        v = v.strip()
        m = re.search(r"[.,](\d{1,2})\s*(?:€|eur)?$", v, re.I)
        if m:
            if v[m.start()] == ",":
                comma += 1
            else:
                dot += 1
    return "." if dot > comma else ","


def parse_amount(value, decimal=","):
    """Wandelt '1.234,56 €', '-12,5', '(3.00)', '1,234.56' in Cent um."""
    v = (value or "").strip()
    if not v:
        return None
    negative = False
    if v.startswith("(") and v.endswith(")"):
        negative, v = True, v[1:-1]
    v = re.sub(r"(?i)eur|€|\s| |'", "", v)
    if v.endswith("-"):
        negative, v = True, v[:-1]
    if v.startswith("+"):
        v = v[1:]
    if v.startswith("-"):
        negative, v = not negative, v[1:]
    thousands = "." if decimal == "," else ","
    v = v.replace(thousands, "").replace(decimal, ".")
    if not re.fullmatch(r"\d+(\.\d+)?", v):
        return None
    cents = int(round(float(v) * 100))
    return -cents if negative else cents


def parse_date(value, fmt=None):
    v = (value or "").strip()
    if not v:
        return None
    v = v.split(" ")[0].split("T")[0]  # Uhrzeit abschneiden (Revolut, N26)
    for f in [fmt] if fmt else DATE_FORMATS:
        try:
            d = datetime.strptime(v, f).date()
        except ValueError:
            continue
        if date(1990, 1, 1) <= d <= date(2100, 1, 1):
            return d.isoformat()
    return None


def _cell(row, mapping, field):
    idx = mapping.get(field)
    if idx is None or idx >= len(row):
        return ""
    return re.sub(r"\s+", " ", row[idx]).strip()


def load_profiles(path):
    if not path or not Path(path).exists():
        return []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get("profiles", [])


def parse_file(data: bytes, filename="upload.csv", profiles=(), account=None):
    """Liest eine Export-Datei und liefert (transaktionen, info)."""
    text = decode(data)
    lines = text.splitlines()
    if not lines:
        raise ImportError_("Die Datei ist leer.")
    delimiter = detect_delimiter(lines)
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    header_idx, mapping, profile = find_header(rows, profiles)

    # Konto aus Metadaten oberhalb der Kopfzeile (z. B. DKB/ING: "IBAN";"DE12 ...")
    preamble_account = None
    for row in rows[:header_idx]:
        m = IBAN_RE.search(" ".join(row))
        if m:
            preamble_account = m.group(1).replace(" ", "")
            break
    default_account = account or (profile or {}).get("account") or preamble_account or Path(filename).stem

    data_rows = [r for r in rows[header_idx + 1:] if any(c.strip() for c in r)]
    amount_cells = [_cell(r, mapping, f) for r in data_rows for f in ("amount", "debit", "credit")]
    decimal = (profile or {}).get("decimal") or detect_decimal([c for c in amount_cells if c])
    date_format = (profile or {}).get("date_format")

    transactions, skipped = [], 0
    for row in data_rows:
        status = _cell(row, mapping, "status").lower()
        if status in SKIP_STATUS:
            skipped += 1
            continue
        d = parse_date(_cell(row, mapping, "date"), date_format)
        if "amount" in mapping:
            amount = parse_amount(_cell(row, mapping, "amount"), decimal)
        else:
            credit = parse_amount(_cell(row, mapping, "credit"), decimal) or 0
            debit = parse_amount(_cell(row, mapping, "debit"), decimal) or 0
            amount = credit - abs(debit) if (credit or debit) else None
        if d is None or amount is None:
            skipped += 1  # Summenzeilen, Fußnoten, "Alter Kontostand" …
            continue
        sign = _cell(row, mapping, "sign").upper()
        if sign in ("S", "SOLL", "D") and amount > 0:
            amount = -amount

        counterparty = _cell(row, mapping, "counterparty")
        if not counterparty:
            # DKB: Empfänger bei Ausgaben, Zahlungspflichtiger bei Einnahmen
            payee, payer = _cell(row, mapping, "payee"), _cell(row, mapping, "payer")
            counterparty = (payee or payer) if amount < 0 else (payer or payee)

        transactions.append({
            "date": d,
            "amount": amount,
            "currency": _cell(row, mapping, "currency") or "EUR",
            "counterparty": counterparty,
            "purpose": _cell(row, mapping, "purpose"),
            "booking_text": _cell(row, mapping, "booking_text"),
            "iban": _cell(row, mapping, "iban").replace(" ", ""),
            "account": _cell(row, mapping, "account") or default_account,
        })

    if not transactions:
        raise ImportError_("Kopfzeile erkannt, aber keine gültigen Buchungen gefunden.")

    # Stabile Hashes zur Duplikaterkennung. Identische Buchungen in derselben Datei
    # (z. B. zweimal 3,20 € beim selben Bäcker) werden durchnummeriert, damit sie
    # erhalten bleiben – überlappende Exporte erzeugen trotzdem keine Duplikate.
    seen = {}
    for tx in transactions:
        key = "|".join(str(tx[k]) for k in ("account", "date", "amount", "counterparty", "purpose")).lower()
        seen[key] = seen.get(key, 0) + 1
        tx["hash"] = hashlib.sha1(f"{key}|{seen[key]}".encode("utf-8")).hexdigest()

    info = {
        "profile": (profile or {}).get("name") or "automatisch erkannt",
        "delimiter": delimiter,
        "decimal": decimal,
        "columns": {field: rows[header_idx][idx] for field, idx in mapping.items()},
        "account": default_account,
        "skipped": skipped,
    }
    return transactions, info
