"""Startpunkt: ``python -m finanzen`` (Optionen: ``python -m finanzen --help``)."""

import argparse
import errno
import json
import signal
import socket
import subprocess
import time
import urllib.request
import logging
import os
import sys
import webbrowser
from pathlib import Path

from . import bank, db, importer, ingest
from .server import App, serve

ROOT = Path(__file__).resolve().parent.parent


def _stop_old_instance(host, port):
    """Läuft auf dem Port schon eine (ältere) Finanzen-App? Dann beenden, damit die neue Version übernimmt.
    Sonst sähe der Browser nach einem Update weiter den alten Stand. Andere Programme werden nie angefasst."""
    base = f"http://127.0.0.1:{port}"
    try:
        with urllib.request.urlopen(f"{base}/api/status", timeout=3) as r:
            old = json.loads(r.read())
    except Exception:
        return False                                    # kein Finanzen-Server – Port gehört einem anderen Programm
    logging.info("Auf Port %s läuft noch eine Finanzen-App (Version %s) – wird beendet …", port, old.get("app_version", "alt"))
    try:                                                 # neuere Versionen beenden sich selbst
        req = urllib.request.Request(f"{base}/api/shutdown", data=b"{}", method="POST",
                                     headers={"X-Finanzen": "1", "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:                                    # ältere: Prozess suchen und beenden (nur wenn es „finanzen“ ist)
        try:
            pids = subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"], capture_output=True, text=True, timeout=5).stdout.split()
            for pid in pids:
                cmd = subprocess.run(["ps", "-o", "command=", "-p", pid], capture_output=True, text=True, timeout=5).stdout
                if "finanzen" in cmd.lower():
                    os.kill(int(pid), signal.SIGTERM)
        except Exception:
            return False
    for _ in range(25):
        time.sleep(0.2)
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                pass
        except OSError:
            return True                                  # Port ist frei
    return False


def check_balances(db_path):
    """Diagnose für den Kontostand – zeigt, woraus die App ihn berechnet."""
    from . import balances, cycles, duplicates
    from .server import app_version
    db.init_db(db_path)
    conn = db.connect(db_path)
    eur = lambda c: f"{c / 100:>12,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")
    print(f"Finanzen Version {app_version()} · Datenbank {db_path}\n")
    anc = balances.anchors(conn)
    print("Konten:")
    for r in conn.execute("SELECT account, COUNT(*) n, MIN(date) a, MAX(date) b, SUM(amount) s FROM transactions GROUP BY account"):
        kind = "Kreditkarte – zählt nicht" if balances.is_card(r["account"]) else ("zählt zum Kontostand" if r["account"] in anc else "OHNE Kontostand – zählt nicht")
        print(f"  {r['account']}: {r['n']} Buchungen {r['a']} – {r['b']} · {kind}")
    print("\nEingetragene Kontostände (Anker):")
    for r in conn.execute("SELECT * FROM balances ORDER BY account, date, id"):
        used = "  ← wird benutzt" if anc.get(r["account"], {}).get("id") == r["id"] else ""
        print(f"  {r['account']}: {eur(r['amount'])} am {r['date']} ({r['source']}){used}")
    if not anc:
        print("  keiner – bitte unter Import › Kontostände oder direkt im Geldfluss eintragen")
    cy = cycles.load(conn)
    last = conn.execute("SELECT MAX(date) FROM transactions").fetchone()[0]
    if last and anc:
        print("\nZurückgerechnet (Stand am Monatsende):")
        k = cy.key_of(last)
        for _ in range(4):
            a, b = cy.range_of(k)
            res = balances.balance_at(conn, b)
            print(f"  {k} ({a} – {b}): {eur(res['value'])}")
            for x in res["known"]:
                print(f"      {x['account']}: {eur(x['anchor'])} am {x['anchor_date']} {'−' if b < x['anchor_date'] else '+'} Saldo "
                      f"{x['bookings']} Buchungen dazwischen ({eur(abs(x['between']))}) = {eur(x['value'])}")
            k = cycles._add_month(k, -1)
    d = duplicates.summary(conn)
    print(f"\nDoppelte Buchungen: {d['count']}" + (f" ({eur(d['sum']).strip()}) – unter Import › Doppelte Buchungen entfernen" if d["count"] else ""))
    conn.close()
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="finanzen", description="Lokales Finanz-Dashboard")
    parser.add_argument("--host", default=os.environ.get("FINANZEN_HOST", "127.0.0.1"),
                        help="Adresse (Standard: 127.0.0.1 – nur dieser Rechner)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("FINANZEN_PORT", 8765)))
    parser.add_argument("--db", default=os.environ.get("FINANZEN_DB", str(ROOT / "data" / "finanzen.db")),
                        help="Pfad zur SQLite-Datenbank")
    parser.add_argument("--inbox", default=os.environ.get("FINANZEN_INBOX", str(ROOT / "inbox")),
                        help="Ordner, der auf neue Bank-Exporte überwacht wird")
    parser.add_argument("--profiles", default=os.environ.get("FINANZEN_PROFILES", str(ROOT / "profiles.json")),
                        help="Optionale eigene Import-Profile (JSON)")
    parser.add_argument("--interval", type=int, default=10, help="Prüfintervall der Inbox in Sekunden")
    parser.add_argument("--no-watch", action="store_true", help="Inbox nicht überwachen")
    parser.add_argument("--open", action="store_true", help="Browser automatisch öffnen")
    parser.add_argument("--import", dest="import_files", nargs="+", metavar="DATEI",
                        help="Dateien einmalig importieren und beenden")
    parser.add_argument("--pruefen", action="store_true",
                        help="Kontostand prüfen: Konten, Anker, Rechenweg der letzten Monate, Doppelte – und beenden")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    log_options = {}
    if sys.stderr is None:  # pythonw.exe (Autostart ohne Konsole): in Datei protokollieren
        log_file = Path(args.db).with_name("finanzen.log")
        log_file.parent.mkdir(parents=True, exist_ok=True)
        log_options["filename"] = str(log_file)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%Y-%m-%d %H:%M:%S", **log_options)

    if args.pruefen:
        return check_balances(args.db)

    if args.import_files:
        db.init_db(args.db)
        conn = db.connect(args.db)
        profiles = importer.load_profiles(args.profiles)
        failed = False
        for name in args.import_files:
            try:
                r = ingest.import_bytes(conn, Path(name).read_bytes(), Path(name).name, profiles)
                print(f"{name}: {r['rows_new']} neu, {r['rows_duplicate']} Duplikate "
                      f"({r['date_from']} – {r['date_to']}, Konto {r['account']})")
            except Exception as e:
                failed = True
                print(f"{name}: FEHLER – {e}", file=sys.stderr)
        conn.close()
        return 1 if failed else 0

    app = App(args.db, args.inbox, args.profiles)
    if not args.no_watch:
        app.watcher = ingest.InboxWatcher(args.db, args.inbox, args.profiles, args.interval)
        app.watcher.start()
        app.bank_syncer = bank.BankSyncer(args.db, app.bank_dir)   # Bankabruf alle 6 h, falls eingerichtet
        app.bank_syncer.start()
    try:
        httpd = serve(app, args.host, args.port)
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, 48, 98) or not _stop_old_instance(args.host, args.port):
            logging.error("Port %s ist belegt. Läuft die App schon in einem anderen Terminalfenster? Dort mit Strg+C beenden "
                          "oder im Terminal: lsof -ti tcp:%s | xargs kill", args.port, args.port)
            return 1
        httpd = serve(app, args.host, args.port)
        logging.info("Alte Version beendet – jetzt läuft Version %s.", app.app_version)
    app.httpd = httpd
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}/"
    logging.info("Finanzen (Version %s) läuft auf %s  (Beenden mit Strg+C)", app.app_version, url)
    if args.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logging.info("Beendet.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
