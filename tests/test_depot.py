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

from finanzen import db, depot  # noqa: E402
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
        self.assertAlmostEqual(rows[0], 5.47)
        self.assertEqual(rows[1], 91669)
        settings = depot.get_settings(self.conn)
        self.assertEqual(settings["cash"], 3331)
        self.assertEqual(settings["plan"]["rate"], 250)
        depot.init(self.conn)  # zweiter Start legt nichts doppelt an
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM depot_tx").fetchone()[0], 4)

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
        self.assertEqual(len(d["transactions"]), 4)
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

    def test_sparplan_page(self):
        with urllib.request.urlopen(self.base + "/sparplan.html") as res:
            self.assertIn(b"Zukunft gestalten", res.read())


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


if __name__ == "__main__":
    unittest.main()
