"""HTTP-Server: JSON-API und Auslieferung der Web-Oberfläche (nur Standardbibliothek)."""

import csv
import io
import json
import logging
import mimetypes
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import analytics, db, depot, importer, ingest, rules

log = logging.getLogger("finanzen.server")
STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD = 20 * 1024 * 1024
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class ApiError(Exception):
    def __init__(self, message, status=HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def euro_to_cents(value):
    if value in (None, ""):
        return None
    try:
        return int(round(float(str(value).replace(",", ".")) * 100))
    except ValueError:
        raise ApiError(f"Ungültiger Betrag: {value}")


class App:
    """Hält Konfiguration und implementiert die API-Routen."""

    def __init__(self, db_path, inbox=None, profiles_path=None):
        self.db_path = db_path
        self.inbox = inbox
        self.profiles_path = profiles_path
        self.watcher = None
        db.init_db(db_path)
        conn = db.connect(db_path)
        depot.init(conn)
        conn.close()
        self.routes = [
            ("GET", r"/api/status", self.status),
            ("GET", r"/api/dashboard", self.dashboard),
            ("GET", r"/api/transactions", self.list_transactions),
            ("GET", r"/api/suggestions", self.suggestions),
            ("PATCH", r"/api/transactions/(\d+)", self.update_transaction),
            ("POST", r"/api/transactions/categorize", self.bulk_categorize),
            ("GET", r"/api/categories", self.list_categories),
            ("POST", r"/api/categories", self.create_category),
            ("PUT", r"/api/categories/(\d+)", self.update_category),
            ("DELETE", r"/api/categories/(\d+)", self.delete_category),
            ("GET", r"/api/rules", self.list_rules),
            ("POST", r"/api/rules", self.create_rule),
            ("PUT", r"/api/rules/(\d+)", self.update_rule),
            ("DELETE", r"/api/rules/(\d+)", self.delete_rule),
            ("POST", r"/api/rules/preview", self.preview_rule),
            ("POST", r"/api/rules/apply", self.apply_rules),
            ("POST", r"/api/import", self.import_file),
            ("GET", r"/api/imports", self.list_imports),
            ("DELETE", r"/api/imports/(\d+)", self.delete_import),
            ("GET", r"/api/export\.csv", self.export_csv),
            ("GET", r"/api/measures", self.measures),
            ("GET", r"/api/depot", self.get_depot),
            ("PUT", r"/api/depot/settings", self.update_depot_settings),
            ("POST", r"/api/depot/tx", self.create_depot_tx),
            ("PUT", r"/api/depot/tx/(\d+)", self.update_depot_tx),
            ("DELETE", r"/api/depot/tx/(\d+)", self.delete_depot_tx),
            ("GET", r"/api/quotes/chart", self.quote_chart),
            ("GET", r"/api/quotes/search", self.quote_search),
        ]

    # ------------------------------------------------------------------ Status
    def status(self, conn, req):
        bounds = conn.execute("SELECT MIN(date), MAX(date), COUNT(*) FROM transactions").fetchone()
        accounts = [
            {"account": r["account"], "count": r["n"], "last": r["last"]}
            for r in conn.execute(
                "SELECT account, COUNT(*) AS n, MAX(date) AS last FROM transactions GROUP BY account ORDER BY account"
            )
        ]
        last_import = conn.execute("SELECT imported_at FROM imports ORDER BY id DESC LIMIT 1").fetchone()
        return {
            "min": bounds[0],
            "max": bounds[1],
            "count": bounds[2],
            "accounts": accounts,
            "inbox": str(Path(self.inbox).resolve()) if self.inbox else None,
            "inbox_results": self.watcher.last_results if self.watcher else [],
            "last_import": last_import[0] if last_import else None,
        }

    def dashboard(self, conn, req):
        q = req.query
        return analytics.dashboard(conn, q.get("from", [None])[0], q.get("to", [None])[0], q.get("account"))

    def measures(self, conn, req):
        return analytics.measures(conn, depot.get_settings(conn)["targets"])

    def suggestions(self, conn, req):
        return analytics.uncategorized_groups(conn, int(req.query.get("limit", [30])[0]))

    # ------------------------------------------------------------ Buchungen
    def list_transactions(self, conn, req):
        q = {k: v[0] for k, v in req.query.items()}
        where, params = analytics.where_clause(q.get("from"), q.get("to"), req.query.get("account"))
        where = [where]
        if "category" in q:
            cid = int(q["category"])
            if cid == 0:
                where.append("category_id IS NULL")
            else:
                where.append("(category_id = ? OR category_id IN (SELECT id FROM categories WHERE parent_id = ?))")
                params += [cid, cid]
        if q.get("q"):
            where.append("(counterparty LIKE ? OR purpose LIKE ? OR booking_text LIKE ? OR note LIKE ?)")
            params += [f"%{q['q']}%"] * 4
        if q.get("direction") == "in":
            where.append("amount > 0")
        elif q.get("direction") == "out":
            where.append("amount < 0")
        sort = {"date": "date DESC, id DESC", "amount": "amount ASC", "-amount": "amount DESC",
                "counterparty": "counterparty COLLATE NOCASE"}.get(q.get("sort", "date"), "date DESC")
        limit = min(int(q.get("limit", 200)), 5000)
        offset = int(q.get("offset", 0))
        clause = " AND ".join(where)
        total = conn.execute(
            f"SELECT COUNT(*), COALESCE(SUM(amount), 0) FROM transactions WHERE {clause}", params
        ).fetchone()
        rows = conn.execute(
            f"SELECT * FROM transactions WHERE {clause} ORDER BY {sort} LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()
        return {"total": total[0], "sum": total[1], "items": [dict(r) for r in rows]}

    def _check_category(self, conn, cid):
        if cid is not None and not conn.execute("SELECT 1 FROM categories WHERE id = ?", (cid,)).fetchone():
            raise ApiError("Kategorie existiert nicht.")

    def update_transaction(self, conn, req, tx_id):
        body = req.json()
        tx = conn.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,)).fetchone()
        if not tx:
            raise ApiError("Buchung nicht gefunden.", HTTPStatus.NOT_FOUND)
        if "category_id" in body:
            cid = body["category_id"] or None
            self._check_category(conn, cid)
            # Kategorie entfernen = wieder den Regeln überlassen
            conn.execute("UPDATE transactions SET category_id = ?, manual = ? WHERE id = ?",
                         (cid, 1 if cid else 0, tx_id))
            if cid is None:
                rules.apply_rules(conn, only_uncategorized=True)
        if "note" in body:
            conn.execute("UPDATE transactions SET note = ? WHERE id = ?", (str(body["note"])[:500], tx_id))
        conn.commit()
        return dict(conn.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,)).fetchone())

    def bulk_categorize(self, conn, req):
        body = req.json()
        ids = [int(i) for i in body.get("ids", [])]
        cid = body.get("category_id") or None
        self._check_category(conn, cid)
        conn.executemany("UPDATE transactions SET category_id = ?, manual = ? WHERE id = ?",
                         [(cid, 1 if cid else 0, i) for i in ids])
        conn.commit()
        if cid is None:
            rules.apply_rules(conn, only_uncategorized=True)
        return {"updated": len(ids)}

    # ------------------------------------------------------------ Kategorien
    def list_categories(self, conn, req):
        rows = conn.execute(
            """SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS tx_count,
                      (SELECT COUNT(*) FROM rules r WHERE r.category_id = c.id) AS rule_count
               FROM categories c ORDER BY c.sort, c.name"""
        ).fetchall()
        return [dict(r) for r in rows]

    def _category_values(self, conn, body, current=None):
        current = current or {}
        name = str(body.get("name", current.get("name", ""))).strip()
        if not name:
            raise ApiError("Bitte einen Namen angeben.")
        parent_id = body.get("parent_id", current.get("parent_id")) or None
        if parent_id:
            parent = conn.execute("SELECT * FROM categories WHERE id = ?", (parent_id,)).fetchone()
            if not parent or parent["parent_id"]:
                raise ApiError("Unterkategorien sind nur eine Ebene tief möglich.")
            if current.get("id") == parent_id:
                raise ApiError("Eine Kategorie kann nicht ihre eigene Oberkategorie sein.")
            if current.get("id") and conn.execute(
                "SELECT 1 FROM categories WHERE parent_id = ?", (current["id"],)
            ).fetchone():
                raise ApiError("Diese Kategorie hat selbst Unterkategorien und kann nicht untergeordnet werden.")
        kind = body.get("kind", current.get("kind", "expense"))
        if parent_id:
            kind = conn.execute("SELECT kind FROM categories WHERE id = ?", (parent_id,)).fetchone()[0]
        if kind not in ("expense", "income", "transfer"):
            raise ApiError("Ungültige Art.")
        color = body.get("color", current.get("color")) or db.NEUTRAL
        if not HEX_COLOR.match(color):
            raise ApiError("Farbe bitte als #rrggbb angeben.")
        budget = euro_to_cents(body["budget"]) if "budget" in body else current.get("budget")
        sort = int(body.get("sort", current.get("sort", 0)) or 0)
        fixed = 1 if body.get("fixed", current.get("fixed", 0)) else 0
        return name, parent_id, kind, color, budget, sort, fixed

    def create_category(self, conn, req):
        values = self._category_values(conn, req.json())
        cid = conn.execute(
            "INSERT INTO categories (name, parent_id, kind, color, budget, sort, fixed) VALUES (?, ?, ?, ?, ?, ?, ?)", values
        ).lastrowid
        conn.commit()
        return dict(conn.execute("SELECT * FROM categories WHERE id = ?", (cid,)).fetchone())

    def update_category(self, conn, req, cid):
        current = conn.execute("SELECT * FROM categories WHERE id = ?", (cid,)).fetchone()
        if not current:
            raise ApiError("Kategorie nicht gefunden.", HTTPStatus.NOT_FOUND)
        values = self._category_values(conn, req.json(), dict(current))
        conn.execute(
            "UPDATE categories SET name = ?, parent_id = ?, kind = ?, color = ?, budget = ?, sort = ?, fixed = ? WHERE id = ?",
            values + (cid,),
        )
        # Unterkategorien übernehmen Art der Oberkategorie
        conn.execute("UPDATE categories SET kind = ? WHERE parent_id = ?", (values[2], cid))
        conn.commit()
        return dict(conn.execute("SELECT * FROM categories WHERE id = ?", (cid,)).fetchone())

    def delete_category(self, conn, req, cid):
        ids = [cid] + [r[0] for r in conn.execute("SELECT id FROM categories WHERE parent_id = ?", (cid,))]
        marks = ",".join("?" * len(ids))
        # Buchungen fallen an die Regeln zurück
        conn.execute(f"UPDATE transactions SET category_id = NULL, manual = 0 WHERE category_id IN ({marks})", ids)
        conn.execute("DELETE FROM categories WHERE id = ?", (cid,))
        conn.commit()
        rules.apply_rules(conn, only_uncategorized=True)
        return {"deleted": cid}

    # ------------------------------------------------------------ Regeln
    def list_rules(self, conn, req):
        return [dict(r) for r in conn.execute("SELECT * FROM rules ORDER BY priority, id")]

    def _rule_values(self, conn, body, current=None):
        current = current or {}
        merged = {**current, **body}
        self._check_category(conn, merged.get("category_id"))
        if not merged.get("category_id"):
            raise ApiError("Bitte eine Kategorie wählen.")
        field = merged.get("field", "any")
        op = merged.get("op", "contains")
        direction = merged.get("direction", "any")
        if field not in ("any",) + rules.FIELDS or op not in ("contains", "equals", "startswith", "regex") \
                or direction not in ("any", "in", "out"):
            raise ApiError("Ungültige Regel-Einstellung.")
        pattern = str(merged.get("pattern", "")).strip()
        error = rules.validate_pattern(op, pattern)
        if error:
            raise ApiError(error)
        min_amount = euro_to_cents(body["min_amount"]) if "min_amount" in body else current.get("min_amount")
        max_amount = euro_to_cents(body["max_amount"]) if "max_amount" in body else current.get("max_amount")
        return (int(merged["category_id"]), field, op, pattern, direction, min_amount, max_amount,
                int(merged.get("priority", 100) or 100), 1 if merged.get("enabled", 1) else 0)

    def create_rule(self, conn, req):
        body = req.json()
        values = self._rule_values(conn, body)
        rid = conn.execute(
            """INSERT INTO rules (category_id, field, op, pattern, direction, min_amount, max_amount, priority, enabled)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", values
        ).lastrowid
        conn.commit()
        changed = rules.apply_rules(conn) if body.get("apply", True) else 0
        return {**dict(conn.execute("SELECT * FROM rules WHERE id = ?", (rid,)).fetchone()), "changed": changed}

    def update_rule(self, conn, req, rid):
        current = conn.execute("SELECT * FROM rules WHERE id = ?", (rid,)).fetchone()
        if not current:
            raise ApiError("Regel nicht gefunden.", HTTPStatus.NOT_FOUND)
        values = self._rule_values(conn, req.json(), dict(current))
        conn.execute(
            """UPDATE rules SET category_id = ?, field = ?, op = ?, pattern = ?, direction = ?, min_amount = ?,
               max_amount = ?, priority = ?, enabled = ? WHERE id = ?""", values + (rid,)
        )
        conn.commit()
        return {**dict(conn.execute("SELECT * FROM rules WHERE id = ?", (rid,)).fetchone()),
                "changed": rules.apply_rules(conn)}

    def delete_rule(self, conn, req, rid):
        conn.execute("DELETE FROM rules WHERE id = ?", (rid,))
        conn.commit()
        return {"deleted": rid, "changed": rules.apply_rules(conn)}

    def preview_rule(self, conn, req):
        body = req.json()
        body.setdefault("category_id", 0)
        error = rules.validate_pattern(body.get("op", "contains"), body.get("pattern", ""))
        if error:
            return {"error": error, "count": 0, "sum": 0, "items": []}
        rule = rules.CompiledRule({
            "id": 0, "category_id": body["category_id"], "field": body.get("field", "any"),
            "op": body.get("op", "contains"), "pattern": body["pattern"], "direction": body.get("direction", "any"),
            "min_amount": euro_to_cents(body.get("min_amount")), "max_amount": euro_to_cents(body.get("max_amount")),
        })
        matches = [dict(tx) for tx in conn.execute("SELECT * FROM transactions ORDER BY date DESC")
                   if rule.matches(tx)]
        return {"count": len(matches), "sum": sum(tx["amount"] for tx in matches), "items": matches[:15]}

    def apply_rules(self, conn, req):
        body = req.json()
        return {"changed": rules.apply_rules(conn, only_uncategorized=bool(body.get("only_uncategorized")))}

    # ------------------------------------------------------------ Import
    def import_file(self, conn, req):
        data = req.body()
        if not data:
            raise ApiError("Keine Datei empfangen.")
        filename = unquote(req.headers.get("X-Filename", "upload.csv"))
        account = unquote(req.headers.get("X-Account", "")) or None
        try:
            return ingest.import_bytes(conn, data, filename, importer.load_profiles(self.profiles_path), account)
        except importer.ImportError_ as e:
            raise ApiError(f"{filename}: {e}")

    def list_imports(self, conn, req):
        return [dict(r) for r in conn.execute("SELECT * FROM imports ORDER BY id DESC LIMIT 100")]

    def delete_import(self, conn, req, import_id):
        n = conn.execute("DELETE FROM transactions WHERE import_id = ?", (import_id,)).rowcount
        conn.execute("DELETE FROM imports WHERE id = ?", (import_id,))
        conn.commit()
        return {"deleted_transactions": n}

    def export_csv(self, conn, req):
        out = io.StringIO()
        writer = csv.writer(out, delimiter=";")
        writer.writerow(["Datum", "Betrag", "Währung", "Gegenpartei", "Verwendungszweck", "Buchungstext", "IBAN",
                         "Konto", "Oberkategorie", "Kategorie", "Notiz"])
        rows = conn.execute(
            """SELECT t.*, c.name AS cat, p.name AS parent FROM transactions t
               LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories p ON p.id = c.parent_id
               ORDER BY t.date"""
        )
        for r in rows:
            writer.writerow([r["date"], f"{r['amount'] / 100:.2f}".replace(".", ","), r["currency"],
                             r["counterparty"], r["purpose"], r["booking_text"], r["iban"], r["account"],
                             r["parent"] or r["cat"] or "", r["cat"] if r["parent"] else "", r["note"]])
        return RawResponse(out.getvalue().encode("utf-8-sig"), "text/csv; charset=utf-8",
                           {"Content-Disposition": 'attachment; filename="finanzen-export.csv"'})


    # ------------------------------------------------------------ Depot & Sparplan
    def get_depot(self, conn, req):
        return {
            "transactions": [dict(r) for r in conn.execute("SELECT * FROM depot_tx ORDER BY date, id")],
            "settings": depot.get_settings(conn),
            "catalog": depot.CATALOG,
        }

    def update_depot_settings(self, conn, req):
        try:
            return depot.save_settings(conn, req.json())
        except ValueError as e:
            raise ApiError(str(e))

    def _depot_tx_values(self, body, current=None):
        merged = {**(current or {}), **body}
        date = str(merged.get("date", ""))
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise ApiError("Datum bitte als JJJJ-MM-TT angeben.")
        symbol = str(merged.get("symbol", "")).strip().upper()
        if not symbol:
            raise ApiError("Bitte ein Kürzel angeben.")
        shares = float(str(merged.get("shares", 0)).replace(",", "."))
        if shares <= 0:
            raise ApiError("Stückzahl muss größer als 0 sein.")
        amount = euro_to_cents(body["amount"]) if "amount" in body else (current or {}).get("amount")
        if not amount or amount <= 0:
            raise ApiError("Bitte einen Betrag angeben.")
        return date, symbol, shares, amount, str(merged.get("note", ""))[:200]

    def create_depot_tx(self, conn, req):
        tid = conn.execute("INSERT INTO depot_tx (date, symbol, shares, amount, note) VALUES (?, ?, ?, ?, ?)",
                           self._depot_tx_values(req.json())).lastrowid
        conn.commit()
        return dict(conn.execute("SELECT * FROM depot_tx WHERE id = ?", (tid,)).fetchone())

    def update_depot_tx(self, conn, req, tid):
        current = conn.execute("SELECT * FROM depot_tx WHERE id = ?", (tid,)).fetchone()
        if not current:
            raise ApiError("Kauf nicht gefunden.", HTTPStatus.NOT_FOUND)
        conn.execute("UPDATE depot_tx SET date = ?, symbol = ?, shares = ?, amount = ?, note = ? WHERE id = ?",
                     self._depot_tx_values(req.json(), dict(current)) + (tid,))
        conn.commit()
        return dict(conn.execute("SELECT * FROM depot_tx WHERE id = ?", (tid,)).fetchone())

    def delete_depot_tx(self, conn, req, tid):
        conn.execute("DELETE FROM depot_tx WHERE id = ?", (tid,))
        conn.commit()
        return {"deleted": tid}

    def quote_chart(self, conn, req):
        q = {k: v[0] for k, v in req.query.items()}
        try:
            data = depot.chart(conn, q.get("symbol", ""), q.get("range", "1y"), q.get("interval", "1d"),
                               force=q.get("force") == "1")
        except depot.QuoteError as e:
            raise ApiError(str(e), HTTPStatus.BAD_GATEWAY)
        if q.get("stats") == "1":
            data["stats"] = depot.stats(data["points"])
        return data

    def quote_search(self, conn, req):
        query = req.query.get("q", [""])[0].strip()
        if len(query) < 2:
            return []
        try:
            return depot.search(query)
        except depot.QuoteError as e:
            raise ApiError(str(e), HTTPStatus.BAD_GATEWAY)


class RawResponse:
    def __init__(self, body, content_type, headers=None):
        self.body, self.content_type, self.headers = body, content_type, headers or {}


def make_handler(app, allowed_hosts):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Finanzen/1.0"

        def log_message(self, fmt, *args):
            log.debug("%s %s", self.address_string(), fmt % args)

        @property
        def query(self):
            return parse_qs(urlparse(self.path).query)

        def body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_UPLOAD:
                raise ApiError("Datei ist zu groß (max. 20 MB).", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return self.rfile.read(length) if length else b""

        def json(self):
            raw = self.body()
            if not raw:
                return {}
            try:
                data = json.loads(raw)
            except ValueError:
                raise ApiError("Ungültiges JSON.")
            if not isinstance(data, dict):
                raise ApiError("JSON-Objekt erwartet.")
            return data

        def send(self, status, body, content_type, headers=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def send_json(self, status, data):
            self.send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def handle_any(self):
            path = urlparse(self.path).path
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
            if allowed_hosts and host not in allowed_hosts:
                # Schutz gegen DNS-Rebinding: nur Zugriffe über localhost zulassen
                return self.send_json(HTTPStatus.FORBIDDEN, {"error": "Unerlaubter Host."})
            if path.startswith("/api/"):
                return self.handle_api(path)
            if self.command not in ("GET", "HEAD"):
                return self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "Nicht erlaubt."})
            return self.serve_static(path)

        def handle_api(self, path):
            # Schutz gegen CSRF: schreibende Aufrufe brauchen einen eigenen Header, den fremde
            # Webseiten ohne CORS-Freigabe nicht setzen dürfen.
            if self.command not in ("GET", "HEAD") and self.headers.get("X-Finanzen") != "1":
                return self.send_json(HTTPStatus.FORBIDDEN, {"error": "Header X-Finanzen: 1 fehlt."})
            for method, pattern, fn in app.routes:
                m = re.fullmatch(pattern, path)
                if m and method == self.command:
                    conn = db.connect(app.db_path)
                    try:
                        result = fn(conn, self, *[int(g) for g in m.groups()])
                    except ApiError as e:
                        return self.send_json(e.status, {"error": str(e)})
                    except (ValueError, KeyError, TypeError) as e:
                        return self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"Ungültige Anfrage: {e}"})
                    except Exception as e:
                        log.exception("Fehler in %s %s", self.command, path)
                        return self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Interner Fehler: {e}"})
                    finally:
                        conn.close()
                    if isinstance(result, RawResponse):
                        return self.send(HTTPStatus.OK, result.body, result.content_type, result.headers)
                    return self.send_json(HTTPStatus.OK, result)
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Unbekannter Endpunkt."})

        def serve_static(self, path):
            rel = "index.html" if path in ("/", "") else unquote(path.lstrip("/"))
            file = (STATIC_DIR / rel).resolve()
            if STATIC_DIR.resolve() not in file.parents or not file.is_file():
                return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Nicht gefunden."})
            ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self.send(HTTPStatus.OK, file.read_bytes(), ctype)

        do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any

    return Handler


def serve(app, host="127.0.0.1", port=8765):
    local = host in ("127.0.0.1", "localhost", "::1")
    allowed = {"127.0.0.1", "localhost", "::1"} if local else None
    httpd = ThreadingHTTPServer((host, port), make_handler(app, allowed))
    return httpd
