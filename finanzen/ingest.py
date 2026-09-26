"""Import in die Datenbank und Überwachung des Inbox-Ordners."""

import logging
from collections import Counter, defaultdict
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

from . import balances, db, importer, rules, transfers

log = logging.getLogger("finanzen.ingest")

SUPPORTED_SUFFIXES = {".csv", ".txt", ".tsv"}


def _same_account(conn, transactions, name):
    """Heißt das Konto im Export anders als bisher (z. B. Dateiname statt IBAN), aber die Buchungen decken sich
    größtenteils mit einem vorhandenen Konto, ist es dasselbe Konto."""
    if conn.execute("SELECT 1 FROM transactions WHERE account = ? LIMIT 1", (name,)).fetchone():
        return name
    best, best_hits = None, 0
    for (acc, first, last) in conn.execute("SELECT account, MIN(date), MAX(date) FROM transactions GROUP BY account"):
        inside = [t for t in transactions if first <= t["date"] <= last]
        if len(inside) < 3:
            continue
        have = Counter((r[0], r[1]) for r in conn.execute(
            "SELECT date, amount FROM transactions WHERE account = ? AND date BETWEEN ? AND ?", (acc, first, last)))
        hits = sum(min(n, have[k]) for k, n in Counter((t["date"], t["amount"]) for t in inside).items())
        if hits >= 3 and hits >= 0.6 * len(inside) and hits > best_hits:
            best, best_hits = acc, hits
    return best or name


def only_new(conn, transactions):
    """Nur der Teil eines Exports, der noch nicht in der Datenbank ist.

    Je Konto, Tag und Betrag zählt, wie viele Buchungen schon da sind; aus der Datei kommen nur die überzähligen
    dazu. So entstehen keine Doppelten, auch wenn sich Schreibweisen zwischen zwei Exporten ändern (neues
    Exportformat, gekürzter Verwendungszweck …) – und zwei echte gleiche Käufe am selben Tag bleiben erhalten.
    Bevorzugt übernommen werden die Zeilen, deren Fingerabdruck und Empfänger noch nicht vorkommen.
    """
    groups = defaultdict(list)
    for tx in transactions:
        groups[(tx["account"], tx["date"], tx["amount"])].append(tx)
    fresh = []
    for (acc, day, amount), rows in groups.items():
        have = [dict(r) for r in conn.execute(
            "SELECT hash, counterparty FROM transactions WHERE account = ? AND date = ? AND amount = ?", (acc, day, amount))]
        n_new = len(rows) - len(have)
        if n_new <= 0:
            continue
        hashes = {h["hash"] for h in have}
        words = {w for h in have for w in importer._tokens(h["counterparty"] or "")}
        rows.sort(key=lambda t: (t["hash"] in hashes, len(words & set(importer._tokens(t["counterparty"])))))
        fresh.extend(rows[:n_new])
    return fresh


def import_bytes(conn, data, filename, profiles=(), account=None):
    """Parst eine Datei, speichert nur die noch nicht vorhandenen Buchungen und kategorisiert sie."""
    transactions, info = importer.parse_file(data, filename, profiles, account)
    mapped = _same_account(conn, transactions, info["account"]) if not account else info["account"]
    if mapped != info["account"]:
        for tx in transactions:
            if tx["account"] == info["account"]:
                tx["account"] = mapped
        info["account_renamed_from"], info["account"] = info["account"], mapped
    fresh = {id(t) for t in only_new(conn, transactions)}
    compiled = rules.load_rules(conn)
    cur = conn.execute(
        "INSERT INTO imports (filename, profile, account) VALUES (?, ?, ?)",
        (filename, info["profile"], info["account"]),
    )
    import_id = cur.lastrowid
    new = 0
    for tx in transactions:
        if id(tx) not in fresh:
            continue
        tx["category_id"] = rules.categorize(tx, compiled)
        cur = conn.execute(
            """INSERT OR IGNORE INTO transactions
               (hash, date, amount, currency, counterparty, purpose, booking_text, iban, account, category_id, import_id)
               VALUES (:hash, :date, :amount, :currency, :counterparty, :purpose, :booking_text, :iban, :account,
                       :category_id, :import_id)""",
            {**tx, "import_id": import_id},
        )
        new += cur.rowcount
    conn.execute(
        "UPDATE imports SET rows_total = ?, rows_new = ?, rows_skipped = ? WHERE id = ?",
        (len(transactions), new, info["skipped"], import_id),
    )
    conn.commit()
    check = transfers.reconcile(conn) if new else None      # Kreditkartenabrechnungen gegen Kartenumsätze prüfen
    if info.get("balance"):                                  # Kontostand aus dem Export → Anker
        balances.set_anchor(conn, info["account"], info["balance"]["date"], info["balance"]["amount"], "csv")
    dates = sorted(tx["date"] for tx in transactions)
    return {
        **info,
        "import_id": import_id,
        "filename": filename,
        "rows_total": len(transactions),
        "rows_new": new,
        "rows_duplicate": len(transactions) - new,
        "date_from": dates[0],
        "date_to": dates[-1],
        "transfers": check,
    }


class InboxWatcher(threading.Thread):
    """Importiert neue Dateien aus dem Inbox-Ordner und verschiebt sie danach.

    Das ist der Andockpunkt für den kontinuierlichen Export: Die Banking-App
    (oder das PowerShell-Skript scripts/Watch-BankExports.ps1) legt CSV-Dateien
    einfach in diesen Ordner.
    """

    def __init__(self, db_path, inbox, profiles_path=None, interval=10):
        super().__init__(daemon=True, name="inbox-watcher")
        self.db_path = db_path
        self.inbox = Path(inbox)
        self.profiles_path = profiles_path
        self.interval = interval
        self.last_results = []
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    def run(self):
        self.inbox.mkdir(parents=True, exist_ok=True)
        log.info("Überwache Inbox-Ordner %s", self.inbox.resolve())
        while not self._stop_event.is_set():
            try:
                self.scan_once()
            except Exception:  # der Watcher darf nie sterben
                log.exception("Fehler beim Scannen der Inbox")
            self._stop_event.wait(self.interval)

    def scan_once(self):
        results = []
        for path in sorted(self.inbox.iterdir()):
            if not path.is_file() or path.suffix.lower() not in SUPPORTED_SUFFIXES:
                continue
            # Datei noch im Schreibvorgang? Kurz warten, bis die Größe stabil ist.
            size = path.stat().st_size
            time.sleep(0.5)
            if path.stat().st_size != size or size == 0:
                continue
            results.append(self._import_path(path))
        if results:
            self.last_results = (results + self.last_results)[:20]
        return results

    def _import_path(self, path):
        conn = db.connect(self.db_path)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        try:
            profiles = importer.load_profiles(self.profiles_path)
            result = import_bytes(conn, path.read_bytes(), path.name, profiles)
            target = self.inbox / "verarbeitet"
            log.info("Import %s: %s neu, %s Duplikate", path.name, result["rows_new"], result["rows_duplicate"])
            result["ok"] = True
        except Exception as e:
            target = self.inbox / "fehler"
            log.warning("Import von %s fehlgeschlagen: %s", path.name, e)
            result = {"ok": False, "filename": path.name, "error": str(e)}
        finally:
            conn.close()
        target.mkdir(exist_ok=True)
        shutil.move(str(path), str(target / f"{stamp}_{path.name}"))
        return result
