"""Kontostand: Anker + Buchungen ergeben jeden Stichtag; Kreditkarte ohne Anker zählt nur offene Käufe."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finanzen import balances, db, importer, ingest  # noqa: E402

HEAD = "Buchungsdatum;Empfänger;Verwendungszweck;Betrag\n"
GIRO = HEAD + ("25.08.2026;Arbeitgeber GmbH;Gehalt 08/2026;3000,00\n"
               "01.09.2026;Vermieter;Miete;-1000,00\n"
               "25.09.2026;Arbeitgeber GmbH;Gehalt 09/2026;3000,00\n")
CARD = HEAD + ("05.09.2026;Restaurant;Kartenzahlung;-80,00\n"
               "20.09.2026;Amazon;Onlinezahlung;-20,00\n")


class BalanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "f.db"
        db.init_db(path)
        self.conn = db.connect(path)
        ingest.import_bytes(self.conn, GIRO.encode(), "girokonto.csv")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_anchor_gives_every_day(self):
        balances.set_anchor(self.conn, "girokonto", "2026-09-26", 424835)
        self.assertEqual(balances.balance_at(self.conn, "2026-09-26")["value"], 424835)
        self.assertEqual(balances.balance_at(self.conn, "2026-09-24")["value"], 424835 - 300000)
        self.assertEqual(balances.balance_at(self.conn, "2026-08-24")["value"], 424835 - 300000 + 100000 - 300000)

    def test_late_import_before_anchor_keeps_anchor_right(self):
        balances.set_anchor(self.conn, "girokonto", "2026-09-26", 424835)
        ingest.import_bytes(self.conn, (HEAD + "10.09.2026;Bäcker;Brot;-5,00\n").encode(), "girokonto.csv")
        self.assertEqual(balances.balance_at(self.conn, "2026-09-26")["value"], 424835)
        self.assertEqual(balances.balance_at(self.conn, "2026-09-09")["value"], 424835 - 300000 + 500)

    def test_card_without_anchor_counts_open_purchases(self):
        balances.set_anchor(self.conn, "girokonto", "2026-09-26", 424835)
        ingest.import_bytes(self.conn, CARD.encode(), "visa-kreditkarte.csv")
        res = balances.balance_at(self.conn, "2026-09-26")
        self.assertEqual(res["value"], 424835 - 10000)
        self.assertEqual([c["account"] for c in res["cards"]], ["visa kreditkarte"])
        self.assertEqual(res["missing"], [])

    def test_balance_from_csv_preamble(self):
        rows = [['"Kontostand vom 26.09.2026:"', "4.248,35 €"]]
        rows = [[c.strip('"') for c in r] for r in rows]
        self.assertEqual(importer.balance_from_preamble(rows), {"date": "2026-09-26", "amount": 424835})


if __name__ == "__main__":
    unittest.main()
