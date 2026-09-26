"""Startpunkt: ``python -m finanzen`` (Optionen: ``python -m finanzen --help``)."""

import argparse
import logging
import os
import sys
import webbrowser
from pathlib import Path

from . import bank, db, importer, ingest
from .server import App, serve

ROOT = Path(__file__).resolve().parent.parent


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
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    log_options = {}
    if sys.stderr is None:  # pythonw.exe (Autostart ohne Konsole): in Datei protokollieren
        log_file = Path(args.db).with_name("finanzen.log")
        log_file.parent.mkdir(parents=True, exist_ok=True)
        log_options["filename"] = str(log_file)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%Y-%m-%d %H:%M:%S", **log_options)

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
    httpd = serve(app, args.host, args.port)
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}/"
    logging.info("Finanzen läuft auf %s  (Beenden mit Strg+C)", url)
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
