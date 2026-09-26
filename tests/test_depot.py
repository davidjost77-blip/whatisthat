"""Tests für Depot, Sparplan und Kursabruf: python -m unittest discover -s tests"""

import json
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlite3  # noqa: E402
import time  # noqa: E402
from datetime import date  # noqa: E402

from finanzen import analytics, db, depot  # noqa: E402
from finanzen.server import App, serve  # noqa: E402

STATIC = Path(__file__).resolve().parent.parent / "finanzen" / "static"


def fake_chart(symbol="VWCE.DE", closes=(100.0, 101.0, None, 103.5), price=104.2):
    start = 1780000000
    return {"chart": {"result": [{
        "meta": {"symbol": symbol, "currency": "EUR", "regularMarketPrice": price, "chartPreviousClose": 103.5,
                 "regularMarketTime": start + 4 * 86400, "gmtoffset": 7200, "exchangeName": "GER"},
        "timestamp": [start + i * 86400 for i in range(len(closes))],
        "indicators": {"quote": [{"close": list(closes)}], "adjclose": [{"adjclose": list(closes)}]},
    }]}}


class DepotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = str(Path(self.tmp.name) / "t.db")
        db.init_db(path)
        self.conn = db.connect(path)
        depot.init(self.conn)
        self.orig_fetch = depot.fetch_json

    def tearDown(self):
        depot.fetch_json = self.orig_fetch
        self.conn.close()
        self.tmp.cleanup()

    def test_seed(self):
        rows = self.conn.execute("SELECT SUM(shares), SUM(amount) FROM depot_tx").fetchone()
        self.assertAlmostEqual(rows[0], 6.96)  # inkl. erstem Kauf am 25.06.2026
        self.assertEqual(rows[1], 116669)
        settings = depot.get_settings(self.conn)
        self.assertEqual(settings["cash"], 3331)
        self.assertEqual(settings["plan"]["rate"], 250)
        depot.init(self.conn)  # zweiter Start legt nichts doppelt an
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM depot_tx").fetchone()[0], 5)
        self.assertEqual(self.conn.execute("SELECT estimated FROM depot_tx WHERE date = '2026-06-25'").fetchone()[0], 1)

    def test_settings(self):
        saved = depot.save_settings(self.conn, {"extras": [{"symbol": "EUNL.DE"}]})
        self.assertEqual(saved["extras"][0]["symbol"], "EUNL.DE")
        with self.assertRaises(ValueError):
            depot.save_settings(self.conn, {"unbekannt": 1})

    def test_parse_chart(self):
        data = depot.parse_chart(fake_chart(), "VWCE.DE")
        self.assertEqual(data["price"], 104.2)
        self.assertEqual(len(data["points"]), 3)  # None-Werte fallen weg
        with self.assertRaises(depot.QuoteError):
            depot.parse_chart({"chart": {"result": None, "error": {"description": "No data found"}}}, "X")

    def test_cache_and_stale_fallback(self):
        calls = []
        depot.fetch_json = lambda url: calls.append(url) or fake_chart()
        first = depot.chart(self.conn, "vwce.de", "5d", "1d")
        self.assertFalse(first["stale"])
        depot.chart(self.conn, "VWCE.DE", "5d", "1d")
        self.assertEqual(len(calls), 1)  # aus dem Zwischenspeicher

        def offline(url):
            raise OSError("offline")
        depot.fetch_json = offline
        stale = depot.chart(self.conn, "VWCE.DE", "5d", "1d", force=True)
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["price"], 104.2)
        with self.assertRaises(depot.QuoteError):
            depot.chart(self.conn, "EUNL.DE", "5d", "1d")
        with self.assertRaises(depot.QuoteError):
            depot.chart(self.conn, "VWCE.DE", "7x", "1d")

    def test_stats(self):
        points = [[f"{2020 + i // 12}-{i % 12 + 1:02d}-28", 100 * 1.01 ** i] for i in range(25)]
        st = depot.stats(points)
        self.assertAlmostEqual(st["cagr"], (1.01 ** 12 - 1) * 100, places=1)
        self.assertAlmostEqual(st["vol"], 0, places=3)
        self.assertIsNone(depot.stats(points[:5]))


def daily_chart(start, days, price=100.0, weekends=False):
    """Kursverlauf mit Handelstagen ab ``start`` (ISO), Kurs steigt je Tag um 1 €."""
    from datetime import date as _d, timedelta
    d0 = _d.fromisoformat(start)
    stamps, closes = [], []
    for i in range(days):
        d = d0 + timedelta(days=i)
        if not weekends and d.weekday() >= 5:
            continue
        stamps.append(int(time.mktime((d.year, d.month, d.day, 12, 0, 0, 0, 0, 0))) - 7200)
        closes.append(price + i)
    return {"chart": {"result": [{"meta": {"symbol": "VWCE.DE", "currency": "EUR", "regularMarketPrice": closes[-1],
                                           "gmtoffset": 7200}, "timestamp": stamps,
                                  "indicators": {"adjclose": [{"adjclose": closes}]}}]}}


class AutoPlanTests(unittest.TestCase):
    """Automatische Sparplan-Buchung ohne Import."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = str(Path(self.tmp.name) / "t.db")
        db.init_db(path)
        self.conn = db.connect(path)
        depot.init(self.conn)
        self.orig_fetch = depot.fetch_json

    def tearDown(self):
        depot.fetch_json = self.orig_fetch
        self.conn.close()
        self.tmp.cleanup()

    def plan_tx(self):
        return [dict(r) for r in self.conn.execute("SELECT * FROM depot_tx WHERE note = 'Sparplan (automatisch)' ORDER BY date")]

    def test_books_due_months_on_next_trading_day(self):
        depot.fetch_json = lambda url: daily_chart("2026-09-20", 110)
        created = depot.auto_execute(self.conn, today=date(2026, 12, 1))
        self.assertEqual([c["date"] for c in created], ["2026-10-26", "2026-11-25"])  # 25.10.2026 ist ein Sonntag
        tx = self.plan_tx()
        self.assertEqual([t["amount"] for t in tx], [25000, 25000])
        self.assertTrue(all(t["estimated"] == 1 for t in tx))
        self.assertAlmostEqual(tx[0]["shares"], round(250 / (100 + 36), 4))
        # zweiter Aufruf bucht nichts doppelt
        self.assertEqual(depot.auto_execute(self.conn, today=date(2026, 12, 1)), [])
        self.assertEqual(depot.get_settings(self.conn)["plan"]["last_executed"], "2026-11")

    def test_one_off_and_manual_rate(self):
        depot.fetch_json = lambda url: daily_chart("2026-09-20", 110)
        depot.auto_execute(self.conn, today=date(2026, 9, 26))  # erster Start der App: merkt sich September
        # Einmalkauf im Oktober verhindert die Oktober-Rate nicht, eine von Hand eingetragene November-Rate schon
        self.conn.execute("INSERT INTO depot_tx (date, symbol, shares, amount) VALUES ('2026-10-10', 'VWCE.DE', 3, 50000)")
        self.conn.execute("INSERT INTO depot_tx (date, symbol, shares, amount) VALUES ('2026-11-25', 'VWCE.DE', 1.6, 25000)")
        created = depot.auto_execute(self.conn, today=date(2026, 12, 1))
        self.assertEqual([c["date"] for c in created], ["2026-10-26"])

    def test_paused_plan_and_offline(self):
        depot.save_settings(self.conn, {"plan": {**depot.get_settings(self.conn)["plan"], "active": False}})
        self.assertEqual(depot.auto_execute(self.conn, today=date(2026, 12, 1)), [])
        depot.save_settings(self.conn, {"plan": {**depot.get_settings(self.conn)["plan"], "active": True}})

        def offline(url):
            raise OSError("offline")
        depot.fetch_json = offline
        created = depot.auto_execute(self.conn, today=date(2026, 10, 30))
        self.assertEqual(len(created), 1)
        self.assertAlmostEqual(created[0]["price"], round(250 / 1.46, 2))  # letzter Kaufkurs

    def test_rate_change_applies_to_future_months(self):
        depot.fetch_json = lambda url: daily_chart("2026-09-20", 110)
        depot.save_settings(self.conn, {"plan": {**depot.get_settings(self.conn)["plan"], "rate": 300}})
        created = depot.auto_execute(self.conn, today=date(2026, 10, 30))
        self.assertEqual(created[0]["amount"], 30000)


class FixTests(unittest.TestCase):
    def test_existing_database_gets_first_purchase_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn = db.connect(str(Path(tmp) / "alt.db"))
            conn.executescript("""CREATE TABLE depot_tx (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, symbol TEXT NOT NULL,
                shares REAL NOT NULL, amount INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
                CREATE TABLE depot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);""")
            conn.execute("INSERT INTO depot_settings VALUES ('cash', '3331')")
            conn.executemany("INSERT INTO depot_tx (date, symbol, shares, amount, note) VALUES (?, ?, ?, ?, ?)", depot.SEED_TX[1:])
            conn.commit()
            depot.init(conn)
            depot.init(conn)
            june = conn.execute("SELECT shares, amount, estimated FROM depot_tx WHERE date = '2026-06-25'").fetchall()
            self.assertEqual([tuple(r) for r in june], [(1.49, 25000, 1)])
            conn.close()


class MeasuresTests(unittest.TestCase):
    """Soll-Maßstäbe und Grundlage der Alltagsäquivalente."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "t.db")
        db.init_db(self.path)
        self.conn = db.connect(self.path)
        cid = {r["name"]: r["id"] for r in self.conn.execute("SELECT id, name FROM categories")}
        rows = []
        for month in ("2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"):
            rows += [(f"{month}-01", -100000, cid["Miete"], "Miete"), (f"{month}-05", -50000, cid["Supermarkt"], "Rewe"),
                     (f"{month}-02", 300000, cid["Gehalt"], "Gehalt")]
        self.conn.executemany(
            "INSERT INTO transactions (hash, date, amount, category_id, counterparty) VALUES (?, ?, ?, ?, ?)",
            [(f"h{i}", *r) for i, r in enumerate(rows)])
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_defaults_fixed(self):
        fixed = {r["name"] for r in self.conn.execute("SELECT name FROM categories WHERE fixed = 1")}
        self.assertEqual(fixed, db.DEFAULT_FIXED)

    def test_measures_from_transactions(self):
        m = analytics.measures(self.conn, {"savings_rate": 20}, today="2026-09-20")
        self.assertEqual(m["ref"], "2026-09-05")  # letzte Buchung vor heute
        self.assertEqual(m["months"], ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"])
        self.assertEqual(m["avg_expense"], 150000)
        self.assertEqual(m["avg_fixed"], 100000)  # Miete erbt Fixkosten von „Wohnen“
        self.assertEqual(m["soll"]["daily"], round(150000 / 30.4))
        own = analytics.measures(self.conn, {"monthly_expense": 200000, "fixed": 120000}, today="2026-09-20")
        self.assertEqual((own["soll"]["monthly_expense"], own["soll"]["fixed"]), (200000, 120000))
        self.assertEqual(own["soll"]["fixed_source"], "eigener Wert")

    def test_flow_and_composition(self):
        d = analytics.dashboard(self.conn, "2026-09-01", "2026-09-30")
        self.assertEqual([x["name"] for x in d["flow"]["sources"]], ["Gehalt"])
        self.assertEqual(d["flow"]["sources"][0]["amount"], 300000)
        wohnen = next(c for c in d["categories"] if c["name"] == "Wohnen")
        comp = analytics.category_flow(self.conn, wohnen["id"], "2026-09-01", "2026-09-30")
        self.assertEqual(comp["amount"], 100000)
        self.assertEqual(comp["children"][0]["name"], "Miete")
        self.assertEqual(comp["children"][0]["partners"][0], {"name": "Miete", "amount": 100000})
        with self.assertRaises(KeyError):
            analytics.category_flow(self.conn, 9999)

    def test_empty_database(self):
        self.conn.execute("DELETE FROM transactions")
        m = analytics.measures(self.conn, {"savings_rate": 20})
        self.assertIsNone(m["avg_expense"])
        self.assertIsNone(m["soll"]["daily"])

    def test_migration_adds_fixed(self):
        old = str(Path(self.tmp.name) / "alt.db")
        conn = sqlite3.connect(old)
        conn.execute("CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, kind TEXT, "
                     "color TEXT, budget INTEGER, sort INTEGER NOT NULL DEFAULT 0)")
        conn.execute("INSERT INTO categories (name, kind) VALUES ('Wohnen', 'expense'), ('Freizeit', 'expense')")
        conn.commit()
        conn.close()
        db.init_db(old)
        conn = db.connect(old)
        self.assertEqual({r[0]: r[1] for r in conn.execute("SELECT name, fixed FROM categories")},
                         {"Wohnen": 1, "Freizeit": 0})
        conn.close()


class DepotApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.app = App(str(Path(cls.tmp.name) / "t.db"))
        cls.httpd = serve(cls.app, "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.orig_fetch = depot.fetch_json
        depot.fetch_json = lambda url: fake_chart()

    @classmethod
    def tearDownClass(cls):
        depot.fetch_json = cls.orig_fetch
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"X-Finanzen": "1"})
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_depot_flow(self):
        status, d = self.call("GET", "/api/depot")
        self.assertEqual(status, 200)
        self.assertEqual(len(d["transactions"]), 5)
        self.assertTrue(any(c["symbol"] == "VWCE.DE" for c in d["catalog"]))
        status, tx = self.call("POST", "/api/depot/tx", {"date": "2026-10-27", "symbol": "vwce.de", "shares": "1,45", "amount": "250"})
        self.assertEqual((status, tx["symbol"], tx["shares"], tx["amount"]), (200, "VWCE.DE", 1.45, 25000))
        status, tx = self.call("PUT", f"/api/depot/tx/{tx['id']}", {"shares": 1.44})
        self.assertEqual((status, tx["shares"], tx["amount"]), (200, 1.44, 25000))
        status, _ = self.call("POST", "/api/depot/tx", {"date": "27.10.2026", "symbol": "X", "shares": 1, "amount": 1})
        self.assertEqual(status, 400)
        self.call("DELETE", f"/api/depot/tx/{tx['id']}")
        status, s = self.call("PUT", "/api/depot/settings", {"scenario": {"years": 30, "rate": 300}})
        self.assertEqual((status, s["scenario"]["years"]), (200, 30))
        status, q = self.call("GET", "/api/quotes/chart?symbol=VWCE.DE&range=1y&interval=1d&stats=1")
        self.assertEqual((status, q["price"]), (200, 104.2))
        self.assertIn("stats", q)

    def test_measures_and_fixed_flag(self):
        status, m = self.call("GET", "/api/measures")
        self.assertEqual(status, 200)
        self.assertEqual(m["soll"]["savings_rate"], 20)
        status, cat = self.call("POST", "/api/categories", {"name": "Fitness", "kind": "expense", "color": "#898781", "fixed": True})
        self.assertEqual((status, cat["fixed"]), (200, 1))
        status, cat = self.call("PUT", f"/api/categories/{cat['id']}", {"fixed": False})
        self.assertEqual(cat["fixed"], 0)
        status, s = self.call("PUT", "/api/depot/settings", {"targets": {"savings_rate": 25, "goal": 5000000, "goal_year": 2040}})
        _, m = self.call("GET", "/api/measures")
        self.assertEqual(m["soll"]["savings_rate"], 25)

    def test_sparplan_page(self):
        with urllib.request.urlopen(self.base + "/sparplan.html") as res:
            html = res.read()
        self.assertIn(b"tpl-play", html)
        self.assertIn(b"ui-core.js", html)
        self.assertNotIn(b"scene.js", html)


@unittest.skipUnless(shutil.which("node"), "Node.js nicht installiert")
class ModelTests(unittest.TestCase):
    """Rechenmodell (sparplan-model.js) über Node prüfen."""

    def run_js(self, code):
        script = f"const M = require({json.dumps(str(STATIC / 'sparplan-model.js'))});\n{code}"
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_holding_and_history(self):
        res = self.run_js("""
          const tx = [{date:"2026-07-10",symbol:"VWCE.DE",shares:1,amount:16669},{date:"2026-07-27",symbol:"VWCE.DE",shares:1.51,amount:25000}];
          const h = M.depotHistory(tx, [["2026-07-20", 170]], "VWCE.DE", "2026-07-28");
          console.log(JSON.stringify({hold: M.holding(tx, "VWCE.DE"), first: h[0], mid: h.find(x => x.date === "2026-07-20"), last: h.at(-1)}));""")
        self.assertEqual(res["hold"]["shares"], 2.51)
        self.assertAlmostEqual(res["hold"]["invested"], 416.69)
        self.assertAlmostEqual(res["first"]["value"], 166.69)
        self.assertAlmostEqual(res["mid"]["value"], 170)
        self.assertTrue(res["last"]["value"] > 400)

    def test_projection(self):
        res = self.run_js("""
          const flat = M.project([{start: 1000, rate: 100, ret: 0, vol: 0, ter: 0}], {months: 12, paths: 50});
          const grow = M.project([{start: 0, rate: 0, ret: 10, vol: 0, ter: 0, lump: 1000}], {months: 12, paths: 0});
          const real = M.project([{start: 1000, rate: 0, ret: 2, vol: 0, ter: 0}], {months: 12, inflation: 2, real: true, paths: 0});
          const mc = M.project([{start: 1000, rate: 100, ret: 7, vol: 15, ter: 0}], {months: 120, paths: 400});
          const e = mc.months;
          console.log(JSON.stringify({flat: flat.total[12], flatInv: flat.invested[12], p50: flat.bands.p50[12], grow: grow.total[12],
            real: real.total[12], ordered: mc.bands.p10[e] < mc.bands.p50[e] && mc.bands.p50[e] < mc.bands.p90[e],
            tax: M.taxOnSale(10000, 5000)}));""")
        self.assertAlmostEqual(res["flat"], 2200)
        self.assertAlmostEqual(res["flatInv"], 2200)
        self.assertAlmostEqual(res["p50"], 2200)
        self.assertAlmostEqual(res["grow"], 1100, places=6)  # Einzahlung im ersten Monat wächst zwölf Monate
        self.assertAlmostEqual(res["real"], 1000, places=6)
        self.assertTrue(res["ordered"])
        self.assertAlmostEqual(res["tax"], (5000 * 0.7 - 1000) * 0.26375)


    def test_goal(self):
        res = self.run_js("""
          const pos = [{start: 0, rate: 100, ret: 0, vol: 0, ter: 0}];
          const need = M.requiredRate(pos, {}, 10, 2000);
          const r = M.project([{start: 1000, rate: 0, ret: 0, vol: 10, ter: 0}], {months: 12, paths: 400, probe: {month: 12, threshold: 0}});
          const none = M.project([{start: 1000, rate: 0, ret: 0, vol: 10, ter: 0}], {months: 12, paths: 400, probe: {month: 12, threshold: 1e9}});
          console.log(JSON.stringify({need, all: r.bands.prob, none: none.bands.prob}));""")
        self.assertAlmostEqual(res["need"], 200, places=3)
        self.assertEqual((res["all"], res["none"]), (1, 0))


if __name__ == "__main__":
    unittest.main()
