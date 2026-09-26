"""Tests für „Zuordnen“: ohne Kategorie, unsichere Zuordnungen, Regel lernen, Rückgängig."""

import tempfile
import unittest
from datetime import date
from pathlib import Path

from finanzen import db, ingest, review

CSV = """Buchungsdatum;Empfänger;Verwendungszweck;Betrag
02.09.2026;Kiosk Ecke Hauptstr;Kartenzahlung;-4,50
09.09.2026;Kiosk Ecke Hauptstr;Kartenzahlung;-6,20
16.09.2026;KIOSK ECKE HAUPTSTR.;Kartenzahlung;-3,80
01.09.2026;ACME Software GmbH;Gehalt 09/2026;3850,00
01.08.2026;ACME Software GmbH;Gehalt 08/2026;3850,00
05.09.2026;REWE Markt GmbH;Einkauf;-40,00
12.09.2026;REWE Markt GmbH;Einkauf;-35,00
19.09.2026;REWE Markt GmbH;Einkauf;-45,00
20.09.2026;REWE Markt GmbH;Einkauf;-38,00
26.09.2026;REWE Markt GmbH;Einkauf;-420,00
"""


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "f.db"
        db.init_db(path)
        self.conn = db.connect(path)
        ingest.import_bytes(self.conn, CSV.encode("utf-8"), "DE02120300000000202051.csv")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def cat(self, name):
        return self.conn.execute("SELECT id FROM categories WHERE name = ?", (name,)).fetchone()[0]

    def test_unassigned_grouped_by_counterparty(self):
        r = review.review(self.conn, today=date(2026, 9, 30))
        kiosk = [g for g in r["unassigned"]["groups"] if "kiosk" in g["name"].lower()]
        self.assertEqual(len(kiosk), 1)
        self.assertEqual((kiosk[0]["count"], kiosk[0]["sum"], kiosk[0]["direction"]), (3, -1450, "out"))
        self.assertEqual(r["unassigned"]["volume"], 1450)
        self.assertTrue(r["top"]["out"])

    def test_uncertain_flags(self):
        r = review.review(self.conn, today=date(2026, 9, 30))
        reasons = {(u["name"], tuple(u["reasons"])) for u in r["uncertain"]["items"]}
        self.assertTrue(any(n == "ACME Software GmbH" and "nur am Verwendungszweck erkannt" in rs for n, rs in reasons))
        self.assertTrue(any(n == "REWE Markt GmbH" and any(x.startswith("ungewöhnlich hoch") for x in rs) for n, rs in reasons))

    def test_assign_learns_rule_and_undo_restores(self):
        r = review.review(self.conn, today=date(2026, 9, 30))
        g = next(g for g in r["unassigned"]["groups"] if "kiosk" in g["name"].lower())
        res = review.assign(self.conn, g["ids"], self.cat("Supermarkt"), g["rule"], g["direction"])
        self.assertIsNotNone(res["rule_id"])
        self.assertEqual(res["changed"], 3)
        self.assertEqual(review.review(self.conn, today=date(2026, 9, 30))["unassigned"]["count"], 0)
        # künftige Buchung desselben Empfängers wird automatisch erkannt
        ingest.import_bytes(self.conn, "Buchungsdatum;Empfänger;Verwendungszweck;Betrag\n23.09.2026;Kiosk Ecke Hauptstr;Karte;-2,00\n".encode(),
                            "DE02120300000000202051_neu.csv")
        self.assertEqual(self.conn.execute("SELECT category_id FROM transactions WHERE amount = -200").fetchone()[0], self.cat("Supermarkt"))
        review.undo(self.conn, res["undo"])
        self.assertIsNone(self.conn.execute("SELECT id FROM rules WHERE id = ?", (res["rule_id"],)).fetchone())
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM transactions WHERE category_id IS NULL AND counterparty LIKE 'kiosk%'").fetchone()[0], 3)

    def test_confirm_makes_it_certain(self):
        r = review.review(self.conn, today=date(2026, 9, 30))
        u = next(u for u in r["uncertain"]["items"] if u["name"] == "ACME Software GmbH")
        review.confirm(self.conn, u["ids"], u["current"]["category_id"], u["rule"], u["direction"])
        after = review.review(self.conn, today=date(2026, 9, 30))
        self.assertFalse(any(x["name"] == "ACME Software GmbH" for x in after["uncertain"]["items"]))


if __name__ == "__main__":
    unittest.main()


class MixedMerchantTests(unittest.TestCase):
    """Wolt liefert Restaurant-Essen und Supermarkt-Einkäufe: jede Buchung einzeln prüfen, ohne Regel für alle."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "f.db"
        db.init_db(path)
        self.conn = db.connect(path)
        csv = ("Buchungsdatum;Empfänger;Verwendungszweck;Betrag\n"
               "03.09.2026;Wolt;Bestellung Pizza Roma;-23,90\n"
               "10.09.2026;WOLT;Wolt Market Einkauf;-64,15\n"
               "11.01.2025;Wolt;Bestellung Sushi;-31,00\n")
        ingest.import_bytes(self.conn, csv.encode("utf-8"), "girokonto.csv")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_each_wolt_booking_is_flagged_alone(self):
        items = [u for u in review.review(self.conn, today=date(2026, 9, 30))["uncertain"]["items"] if u.get("mixed")]
        self.assertEqual([u["count"] for u in items], [1, 1, 1])            # auch die ältere von 2025
        self.assertTrue(all(u["rule"] is None for u in items))               # keine Regel für „alle ähnlichen“
        self.assertEqual(items[0]["current"]["label"], "Freizeit › Lieferdienste")
        self.assertIn("Supermarkt", items[0]["suggestion"]["label"])

    def test_decision_applies_only_to_that_booking(self):
        items = [u for u in review.review(self.conn, today=date(2026, 9, 30))["uncertain"]["items"] if u.get("mixed")]
        market = next(u for u in items if u["sum"] == -6415)
        review.assign(self.conn, market["ids"], market["suggestion"]["category_id"], rule=None, learn=False)
        left = [u for u in review.review(self.conn, today=date(2026, 9, 30))["uncertain"]["items"] if u.get("mixed")]
        self.assertEqual(len(left), 2)
        rows = dict(self.conn.execute("SELECT purpose, category_id FROM transactions").fetchall())
        self.assertNotEqual(rows["Wolt Market Einkauf"], rows["Bestellung Pizza Roma"])
