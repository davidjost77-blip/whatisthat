"""Bankanbindung über Enable Banking (PSD2-Kontoinformationsdienst), nur Standardbibliothek.

Ablauf:
1. Einmalig: Anwendung im Enable-Banking-Kontrollzentrum anlegen (Produktion, „eigene Konten“
   = eingeschränkter, kostenloser Modus), privaten Schlüssel (.pem) und Application-ID hier hinterlegen.
2. „Konto verbinden“: Die App erzeugt einen Anmelde-Link; du meldest dich direkt bei deiner Bank an.
   Danach landet der Browser auf der eingetragenen Weiterleitungs-Adresse; die Adresse (mit ?code=…)
   fügst du in der App ein – daraus wird eine Sitzung mit Lesezugriff auf die Konten.
3. Abruf: automatisch alle 6 Stunden (PSD2 erlaubt ohne dich 4 Abrufe am Tag) oder per Knopf.
   Neue Buchungen laufen durch dieselben Regeln wie CSV-Importe; Duplikate zu CSV-Importen werden erkannt.

Sicherheit: Deine Banking-Zugangsdaten sieht weder diese App noch Enable Banking (Anmeldung direkt bei der
Bank). Der private Schlüssel liegt nur lokal unter ``data/bank/`` (nicht im Git-Repo).
"""

import base64
import hashlib
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from . import db, importer, rules

log = logging.getLogger("finanzen.bank")

API = "https://api.enablebanking.com"
PROFILE = "Enable Banking"
SYNC_INTERVAL = 6 * 3600          # 4 Abrufe am Tag
DEFAULT_CONSENT_DAYS = 180
FIRST_SYNC_DAYS = 365             # beim ersten Abruf so weit zurück wie die Bank erlaubt …
FALLBACK_SYNC_DAYS = 89           # … sonst die üblichen 90 Tage

SCHEMA = """
CREATE TABLE IF NOT EXISTS bank_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_sessions (
    id          TEXT PRIMARY KEY,
    aspsp       TEXT NOT NULL,
    country     TEXT NOT NULL,
    valid_until TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    accounts    TEXT NOT NULL DEFAULT '[]',
    last_sync   TEXT,
    last_result TEXT,
    status      TEXT NOT NULL DEFAULT 'aktiv'
);
"""


class BankError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- RSA / JWT (RS256 ohne Fremdpakete)
def _der(data, i):
    tag = data[i]
    length = data[i + 1]
    i += 2
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(data[i:i + n], "big")
        i += n
    return tag, data[i:i + length], i + length


def _items(content):
    out, i = [], 0
    while i < len(content):
        tag, value, i = _der(content, i)
        out.append((tag, value))
    return out


def load_private_key(pem):
    """Liest einen RSA-Schlüssel (PKCS#8 „PRIVATE KEY“ oder PKCS#1 „RSA PRIVATE KEY“). Gibt (n, d) zurück."""
    text = pem.decode("utf-8", "replace") if isinstance(pem, bytes) else str(pem)
    if "ENCRYPTED" in text:
        raise BankError("Der Schlüssel ist mit einem Passwort geschützt – bitte den unverschlüsselten .pem-Schlüssel verwenden.")
    lines = [l.strip() for l in text.strip().splitlines()]
    body = "".join(l for l in lines if l and not l.startswith("-----"))
    try:
        der = base64.b64decode(body, validate=False)
        _, seq, _ = _der(der, 0)
        items = _items(seq)
        if len(items) >= 3 and items[1][0] == 0x30:        # PKCS#8 → innerer PKCS#1-Schlüssel
            _, seq, _ = _der(items[2][1], 0)
            items = _items(seq)
        n = int.from_bytes(items[1][1], "big")
        d = int.from_bytes(items[3][1], "big")
    except (ValueError, IndexError, TypeError) as e:
        raise BankError(f"Der private Schlüssel ist kein gültiger RSA-Schlüssel im PEM-Format ({e}).")
    if n.bit_length() < 1024:
        raise BankError("Der Schlüssel ist zu kurz.")
    return n, d


_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def rs256(message, key):
    """RSASSA-PKCS1-v1_5 mit SHA-256."""
    n, d = key
    k = (n.bit_length() + 7) // 8
    t = _SHA256_PREFIX + hashlib.sha256(message).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return pow(int.from_bytes(em, "big"), d, n).to_bytes(k, "big")


def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(app_id, key, now=None, ttl=3600):
    iat = int(now if now is not None else time.time())
    header = {"typ": "JWT", "alg": "RS256", "kid": app_id}
    body = {"iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": iat, "exp": iat + ttl}
    signing_input = f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}.{_b64url(json.dumps(body, separators=(',', ':')).encode())}"
    return f"{signing_input}.{_b64url(rs256(signing_input.encode('ascii'), key))}"


# ---------------------------------------------------------------- HTTP (in Tests austauschbar)
def request_json(method, url, headers, body=None, timeout=40):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={**headers, "Accept": "application/json",
                                                                         **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(detail)
            detail = j.get("message") or j.get("detail") or j.get("error") or detail
        except ValueError:
            pass
        raise BankError(f"Enable Banking antwortet {e.code}: {str(detail)[:300]}", e.code)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise BankError(f"Enable Banking nicht erreichbar: {e}")


# ---------------------------------------------------------------- Einstellungen
def init(conn):
    conn.executescript(SCHEMA)
    conn.commit()


def _get(conn, key, default=None):
    row = conn.execute("SELECT value FROM bank_settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def _set(conn, key, value):
    conn.execute("INSERT INTO bank_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, json.dumps(value)))
    conn.commit()


class Client:
    def __init__(self, conn, key_dir):
        self.conn = conn
        self.key_dir = Path(key_dir)
        self.app_id = _get(conn, "app_id")

    @property
    def key_path(self):
        return self.key_dir / "private.pem"

    def configured(self):
        return bool(self.app_id) and self.key_path.exists()

    def _headers(self):
        if not self.configured():
            raise BankError("Bankanbindung ist noch nicht eingerichtet (Application-ID und Schlüssel fehlen).")
        key = load_private_key(self.key_path.read_bytes())
        return {"Authorization": f"Bearer {make_jwt(self.app_id, key)}"}

    def call(self, method, path, body=None, params=None):
        url = API + path + (f"?{urllib.parse.urlencode(params)}" if params else "")
        return request_json(method, url, self._headers(), body)


def configure(conn, key_dir, app_id, key_pem):
    """Speichert Application-ID und Schlüssel und prüft beides gegen die API."""
    app_id = (app_id or "").strip()
    if not app_id:
        raise BankError("Bitte die Application-ID angeben.")
    key_dir = Path(key_dir)
    key_dir.mkdir(parents=True, exist_ok=True)
    path = key_dir / "private.pem"
    if key_pem:
        load_private_key(key_pem)          # früh und verständlich scheitern
        path.write_text(key_pem if isinstance(key_pem, str) else key_pem.decode("utf-8"), encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    elif not path.exists():
        raise BankError("Bitte den privaten Schlüssel (.pem) auswählen.")
    _set(conn, "app_id", app_id)
    app = Client(conn, key_dir).call("GET", "/application")
    _set(conn, "application", {"name": app.get("name"), "redirect_urls": app.get("redirect_urls") or [],
                               "active": app.get("active"), "environment": app.get("environment")})
    return app


def status(conn, key_dir):
    c = Client(conn, key_dir)
    sessions = []
    for r in conn.execute("SELECT * FROM bank_sessions ORDER BY created_at"):
        s = dict(r)
        s["accounts"] = json.loads(s["accounts"] or "[]")
        s["last_result"] = json.loads(s["last_result"]) if s["last_result"] else None
        if s["valid_until"] and s["status"] == "aktiv" and s["valid_until"][:10] < date.today().isoformat():
            s["status"] = "abgelaufen"
        sessions.append(s)
    return {
        "configured": c.configured(),
        "app_id": c.app_id,
        "application": _get(conn, "application"),
        "auto": _get(conn, "auto", True),
        "interval_hours": SYNC_INTERVAL // 3600,
        "pending": _get(conn, "pending"),
        "sessions": sessions,
        "last_auto_sync": _get(conn, "last_auto_sync"),
    }


def aspsps(conn, key_dir, country="DE"):
    data = Client(conn, key_dir).call("GET", "/aspsps", params={"country": country, "psu_type": "personal"})
    out = []
    for a in data.get("aspsps", []):
        out.append({"name": a.get("name"), "country": a.get("country", country), "logo": a.get("logo"),
                    "max_days": int(a["maximum_consent_validity"]) // 86400 if a.get("maximum_consent_validity") else None})
    return sorted(out, key=lambda a: (a["name"] or "").lower())


def start_auth(conn, key_dir, aspsp, country="DE", max_days=None):
    """Erzeugt den Anmelde-Link zur Bank."""
    client = Client(conn, key_dir)
    app = _get(conn, "application") or {}
    redirects = app.get("redirect_urls") or []
    if not redirects:
        raise BankError("In der Enable-Banking-Anwendung ist keine Weiterleitungs-Adresse (Redirect URL) eingetragen.")
    days = min(DEFAULT_CONSENT_DAYS, max_days or DEFAULT_CONSENT_DAYS)
    state = str(uuid.uuid4())
    body = {
        "access": {"valid_until": (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()},
        "aspsp": {"name": aspsp, "country": country},
        "state": state,
        "redirect_url": redirects[0],
        "psu_type": "personal",
    }
    try:
        res = client.call("POST", "/auth", body)
    except BankError as e:
        if e.status in (400, 422) and days > 90:   # manche Banken erlauben nur 90 Tage
            body["access"]["valid_until"] = (datetime.now(timezone.utc) + timedelta(days=90)).isoformat()
            res = client.call("POST", "/auth", body)
        else:
            raise
    _set(conn, "pending", {"state": state, "aspsp": aspsp, "country": country, "created": datetime.now().isoformat(timespec="seconds")})
    return {"url": res["url"], "redirect_url": redirects[0]}


def _code_from(url_or_code):
    text = (url_or_code or "").strip()
    if "code=" in text:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(text).query)
        if q.get("error"):
            raise BankError(f"Die Bank hat die Freigabe abgelehnt: {q.get('error_description', q['error'])[0]}")
        return q.get("code", [""])[0], (q.get("state") or [None])[0]
    if "error=" in text:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(text).query)
        raise BankError(f"Die Bank hat die Freigabe abgelehnt: {q.get('error_description', q.get('error', ['?']))[0]}")
    return text, None


def finish_auth(conn, key_dir, url_or_code):
    """Tauscht den Code aus der Weiterleitung gegen eine Sitzung und merkt sich die Konten."""
    code, state = _code_from(url_or_code)
    if not code:
        raise BankError("In der eingefügten Adresse steckt kein Code (…?code=…). Bitte die komplette Adresse kopieren.")
    pending = _get(conn, "pending") or {}
    if state and pending.get("state") and state != pending["state"]:
        raise BankError("Diese Adresse gehört zu einer älteren Anmeldung. Bitte „Konto verbinden“ neu starten.")
    res = Client(conn, key_dir).call("POST", "/sessions", {"code": code})
    accounts = []
    for a in res.get("accounts", []):
        acc_id = a.get("account_id") or {}
        accounts.append({"uid": a.get("uid"), "iban": acc_id.get("iban") or "", "name": a.get("name") or a.get("product") or "",
                         "currency": a.get("currency") or "EUR"})
    aspsp = res.get("aspsp") or {}
    valid = (res.get("access") or {}).get("valid_until")
    conn.execute("INSERT OR REPLACE INTO bank_sessions (id, aspsp, country, valid_until, accounts, status) VALUES (?, ?, ?, ?, ?, 'aktiv')",
                 (res["session_id"], aspsp.get("name") or pending.get("aspsp") or "Bank", aspsp.get("country") or pending.get("country") or "DE",
                  valid, json.dumps(accounts)))
    conn.execute("DELETE FROM bank_settings WHERE key = 'pending'")
    conn.commit()
    return {"session_id": res["session_id"], "accounts": accounts, "valid_until": valid}


def disconnect(conn, key_dir, session_id):
    try:
        Client(conn, key_dir).call("DELETE", f"/sessions/{urllib.parse.quote(session_id)}")
    except BankError as e:
        log.info("Sitzung %s bei Enable Banking nicht gelöscht: %s", session_id, e)
    conn.execute("DELETE FROM bank_sessions WHERE id = ?", (session_id,))
    conn.commit()


# ---------------------------------------------------------------- Buchungen übernehmen
def _party(obj):
    return ((obj or {}).get("name") or "").strip()


def map_transaction(t, account_label):
    """Enable-Banking-Buchung → Zeile für ``transactions`` (ohne Hash). None für vorgemerkte Umsätze."""
    if str(t.get("status") or "BOOK").upper() in ("PDNG", "PNDG", "PENDING"):
        return None
    amt = t.get("transaction_amount") or {}
    try:
        cents = int((Decimal(str(amt.get("amount"))) * 100).quantize(Decimal(1)))
    except (InvalidOperation, TypeError, ValueError):
        return None
    ind = (t.get("credit_debit_indicator") or "").upper()
    if ind == "DBIT":
        cents = -abs(cents)
    elif ind == "CRDT":
        cents = abs(cents)
    d = t.get("booking_date") or t.get("value_date") or t.get("transaction_date")
    if not d:
        return None
    if cents < 0:
        counterparty, iban = _party(t.get("creditor")), (t.get("creditor_account") or {}).get("iban") or ""
    else:
        counterparty, iban = _party(t.get("debtor")), (t.get("debtor_account") or {}).get("iban") or ""
    purpose = " ".join(x for x in (t.get("remittance_information") or []) if x).strip()
    btc = t.get("bank_transaction_code") or {}
    booking_text = (btc.get("description") or t.get("note") or "").strip()
    provider = next((p for p in importer.PAYMENT_PROVIDERS if p in counterparty.lower()), None)
    if provider:
        m = importer.MERCHANT_RE.search(purpose)
        if m:
            counterparty = m.group(1).strip()
            booking_text = f"{booking_text} · {importer.PAYMENT_PROVIDERS[provider]}".strip(" ·")
    if not counterparty:
        counterparty = purpose[:80]
    return {
        "date": str(d)[:10], "amount": cents, "currency": amt.get("currency") or "EUR",
        "counterparty": counterparty, "purpose": purpose, "booking_text": booking_text,
        "iban": iban.replace(" ", ""), "account": account_label,
        "ref": t.get("entry_reference") or t.get("transaction_id") or "",
    }


def _hash(uid, tx, ordinal):
    if tx["ref"]:
        return hashlib.sha1(f"eb|{uid}|{tx['ref']}".encode("utf-8")).hexdigest()
    key = "|".join(str(tx[k]) for k in ("date", "amount", "counterparty", "purpose")).lower()
    return hashlib.sha1(f"eb|{uid}|{key}|{ordinal}".encode("utf-8")).hexdigest()


def _csv_twin(conn, tx, used):
    """Gibt es die Buchung schon aus einem CSV-Import? (gleicher Betrag, ±1 Tag, gleiches Konto oder Empfänger)."""
    d = date.fromisoformat(tx["date"])
    rows = conn.execute(
        """SELECT t.id, t.account, t.counterparty FROM transactions t LEFT JOIN imports i ON i.id = t.import_id
           WHERE t.amount = ? AND t.date BETWEEN ? AND ? AND COALESCE(i.profile, '') != ?""",
        (tx["amount"], (d - timedelta(days=1)).isoformat(), (d + timedelta(days=1)).isoformat(), PROFILE),
    ).fetchall()
    mine = set(importer._tokens(tx["counterparty"]))
    norm = lambda s: (s or "").replace(" ", "").lower()
    for r in rows:
        if r["id"] in used:
            continue
        if norm(r["account"]) == norm(tx["account"]) or (mine & set(importer._tokens(r["counterparty"]))):
            used.add(r["id"])
            return True
    return False


def store(conn, session, account, raw):
    """Schreibt abgerufene Buchungen eines Kontos. Gibt (neu, doppelt) zurück."""
    label = account.get("iban") or account.get("name") or account["uid"]
    compiled = rules.load_rules(conn)
    cur = conn.execute("INSERT INTO imports (filename, profile, account) VALUES (?, ?, ?)",
                       (f"Bankabruf {session['aspsp']} · {account.get('name') or label}", PROFILE, label))
    import_id = cur.lastrowid
    new = dup = total = 0
    seen, used = {}, set()
    for t in raw:
        tx = map_transaction(t, label)
        if not tx:
            continue
        total += 1
        k = (tx["date"], tx["amount"], tx["counterparty"], tx["purpose"])
        seen[k] = seen.get(k, 0) + 1
        tx["hash"] = _hash(account["uid"], tx, seen[k])
        if conn.execute("SELECT 1 FROM transactions WHERE hash = ?", (tx["hash"],)).fetchone() or _csv_twin(conn, tx, used):
            dup += 1
            continue
        tx["category_id"] = rules.categorize(tx, compiled)
        conn.execute(
            """INSERT OR IGNORE INTO transactions
               (hash, date, amount, currency, counterparty, purpose, booking_text, iban, account, category_id, import_id)
               VALUES (:hash, :date, :amount, :currency, :counterparty, :purpose, :booking_text, :iban, :account, :category_id, :import_id)""",
            {**tx, "import_id": import_id},
        )
        new += 1
    conn.execute("UPDATE imports SET rows_total = ?, rows_new = ?, rows_skipped = 0 WHERE id = ?", (total, new, import_id))
    if not new:
        conn.execute("DELETE FROM imports WHERE id = ?", (import_id,))   # leere Abrufe nicht im Verlauf zeigen
    conn.commit()
    return new, dup


def fetch_transactions(client, uid, date_from):
    out, params = [], {"date_from": date_from}
    for _ in range(200):                                   # Sicherung gegen Endlosschleifen
        res = client.call("GET", f"/accounts/{urllib.parse.quote(uid)}/transactions", params=params)
        out.extend(res.get("transactions") or [])
        key = res.get("continuation_key")
        if not key:
            break
        params = {"date_from": date_from, "continuation_key": key}
    return out


def sync(conn, key_dir, session_id=None, today=None):
    """Ruft neue Buchungen aller (oder einer) aktiven Sitzung ab."""
    client = Client(conn, key_dir)
    today = today or date.today()
    results = []
    q = "SELECT * FROM bank_sessions WHERE status = 'aktiv'" + (" AND id = ?" if session_id else "")
    for s in conn.execute(q, (session_id,) if session_id else ()).fetchall():
        s = dict(s)
        res = {"session_id": s["id"], "aspsp": s["aspsp"], "new": 0, "duplicate": 0, "accounts": [], "error": None}
        try:
            for acc in json.loads(s["accounts"] or "[]"):
                label = acc.get("iban") or acc.get("name") or acc["uid"]
                last = conn.execute("SELECT MAX(date) FROM transactions WHERE account = ?", (label,)).fetchone()[0]
                start = (date.fromisoformat(last) - timedelta(days=7)) if last else today - timedelta(days=FIRST_SYNC_DAYS)
                try:
                    raw = fetch_transactions(client, acc["uid"], start.isoformat())
                except BankError as e:
                    if e.status in (400, 422) and (today - start).days > FALLBACK_SYNC_DAYS:
                        raw = fetch_transactions(client, acc["uid"], (today - timedelta(days=FALLBACK_SYNC_DAYS)).isoformat())
                    else:
                        raise
                new, dup = store(conn, s, acc, raw)
                res["new"] += new
                res["duplicate"] += dup
                res["accounts"].append({"name": acc.get("name") or label, "new": new})
        except BankError as e:
            res["error"] = str(e)
            if e.status in (401, 403):
                conn.execute("UPDATE bank_sessions SET status = 'abgelaufen' WHERE id = ?", (s["id"],))
        conn.execute("UPDATE bank_sessions SET last_sync = ?, last_result = ? WHERE id = ?",
                     (datetime.now().isoformat(timespec="seconds"), json.dumps(res), s["id"]))
        conn.commit()
        results.append(res)
    return results


class BankSyncer(threading.Thread):
    """Ruft im Hintergrund alle 6 Stunden neue Buchungen ab (nur wenn eingerichtet und „automatisch“ an)."""

    def __init__(self, db_path, key_dir, interval=SYNC_INTERVAL):
        super().__init__(daemon=True, name="bank-sync")
        self.db_path, self.key_dir, self.interval = db_path, key_dir, interval
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    def due(self, conn):
        last = _get(conn, "last_auto_sync")
        return not last or (datetime.now() - datetime.fromisoformat(last)).total_seconds() >= self.interval

    def run_once(self):
        conn = db.connect(self.db_path)
        try:
            init(conn)
            if not Client(conn, self.key_dir).configured() or not _get(conn, "auto", True) or not self.due(conn):
                return None
            _set(conn, "last_auto_sync", datetime.now().isoformat(timespec="seconds"))
            results = sync(conn, self.key_dir)
            for r in results:
                log.info("Bankabruf %s: %s neu, %s doppelt%s", r["aspsp"], r["new"], r["duplicate"], f" – {r['error']}" if r["error"] else "")
            return results
        finally:
            conn.close()

    def run(self):
        self._stop_event.wait(20)                         # Server erst in Ruhe starten lassen
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:
                log.exception("Fehler beim automatischen Bankabruf")
            self._stop_event.wait(300)                     # alle 5 min prüfen, ob ein Abruf fällig ist
