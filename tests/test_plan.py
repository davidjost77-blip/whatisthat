"""Vergleichszeitraum, Übertrag (Rücklagen), Unterkategorien gegen den Vorzeitraum, steuerbar/gesperrt."""

import sqlite3
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finanzen import analytics, db, ingest  # noqa: E402
from finanzen.cycles import Cycles  # noqa: E402

D = date.fromisoformat

CSV = ("Buchungsdatum;Empfänger;Verwendungszweck;Betrag\n"
       "27.07.2026;Arbeitgeber GmbH;Gehalt 07/2026;3000,00\n"
       "28.07.2026;REWE Markt;Einkauf;-400,00\n"
       "01.08.2026;Pizzeria Roma;Restaurant;-100,00\n"
       "27.08.2026;Arbeitgeber GmbH;Gehalt 08/2026;3000,00\n"
       "28.08.2026;REWE Markt;Einkauf;-300,00\n"
       "02.09.2026;LIDL;Einkauf;-50,00\n")


class CompareRangeTests(unittest.TestCase):
    def setUp(self):
        self.cy = Cycles([D("2025-12-27"), D("2026-07-27"), D("2026-08-27")], today=D("2026-09-10"))

    def test_salary_month_compares_with_previous_salary_month(self):
        self.assertEqual(analytics.compare_range(self.cy, "2026-08-27", "2026-09-26", D("2026-09-10")),
                         ("2026-07-27", "2026-08-26", "Vormonat"))

    def test_running_year_compares_with_same_span_last_year(self):
        self.assertEqual(analytics.compare_range(self.cy, "2026-01-01", "2026-12-31", D("2026-09-10")),
                         ("2025-01-01", "2025-09-10", "01.01.–10.09.2025"))

    def test_other_span_uses_equal_length_before(self):
        self.assertEqual(analytics.compare_range(self.cy, "2026-03-01", "2026-03-10", D("2026-09-10")),
                         ("2026-02-19", "2026-02-28", "Vorzeitraum"))


class CarryAndBreakdownTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "f.db"
        db.init_db(path)
        self.conn = db.connect(path)
        ingest.import_bytes(self.conn, CSV.encode(), "konto.csv")
        self.cid = {r["name"]: r["id"] for r in self.conn.execute("SELECT id, name FROM categories WHERE parent_id IS NULL")}

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_carry_is_what_was_left_in_previous_month(self):
        prev = analytics.dashboard(self.conn, "2026-08-27", "2026-09-26")["kpis"]["prev"]
        self.assertEqual((prev["from"], prev["to"], prev["label"]), ("2026-07-27", "2026-08-26", "Vormonat"))
        self.assertEqual(prev["carry"], 300000 - 50000)
        self.assertTrue(prev["complete"])

    def test_subcategories_carry_previous_values(self):
        food = analytics.category_flow(self.conn, self.cid["Lebensmittel"], "2026-08-27", "2026-09-26")
        self.assertEqual({c["name"]: (c["amount"], c["prev"]) for c in food["children"]}, {"Supermarkt": (35000, 40000)})
        self.assertEqual(food["prev"], 40000)
        self.assertEqual(food["prev_range"]["label"], "Vormonat")
        fun = analytics.category_flow(self.conn, self.cid["Freizeit"], "2026-08-27", "2026-09-26")
        self.assertTrue(fun["disc"])
        # nur im Vormonat vorhanden: erscheint trotzdem, mit 0 im aktuellen Zeitraum
        self.assertEqual([(c["name"], c["amount"], c["prev"]) for c in fun["children"]], [("Restaurants & Cafés", 0, 10000)])


class MigrationTests(unittest.TestCase):
    def test_old_database_gets_disc_and_locked(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "old.db"
            conn = sqlite3.connect(path)
            conn.execute("CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, kind TEXT, color TEXT,"
                         " budget INTEGER, sort INTEGER DEFAULT 0, fixed INTEGER NOT NULL DEFAULT 0)")
            conn.executemany("INSERT INTO categories (name, kind, fixed) VALUES (?, 'expense', ?)",
                             [("Wohnen", 1), ("Freizeit", 0), ("Lebensmittel", 0)])
            db.migrate(conn)
            rows = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT name, disc, locked FROM categories")}
            conn.close()
        self.assertEqual(rows, {"Wohnen": (0, 1), "Freizeit": (1, 0), "Lebensmittel": (0, 0)})


if __name__ == "__main__":
    unittest.main()
