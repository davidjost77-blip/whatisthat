"""Kreditkarten-Check: Abrechnungen nicht doppelt zählen, aber auch nicht verschwinden lassen."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finanzen import analytics, db, ingest, transfers  # noqa: E402

HEAD = "Buchungsdatum;Empfänger;Verwendungszweck;Betrag\n"
GIRO = HEAD + ("01.09.2026;Arbeitgeber GmbH;Gehalt 09/2026;3000,00\n"
               "22.09.2026;DKB AG;Kreditkartenabrechnung VISA 4930;-123,45\n"
               "10.09.2026;REWE Markt;VISA Debitkartenumsatz;-40,00\n")
CARD = HEAD + ("05.09.2026;Restaurant Seoul;Kartenzahlung;-80,00\n"
               "12.09.2026;Amazon;Onlinezahlung;-43,45\n"
               "23.09.2026;DKB AG;Ausgleich Kreditkarte gem. Abrechnung;123,45\n")


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "f.db"
        db.init_db(path)
        self.conn = db.connect(path)
        self.own = transfers.own_accounts_category(self.conn)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def cat(self, text):
        return self.conn.execute("SELECT category_id FROM transactions WHERE purpose LIKE ?", (f"%{text}%",)).fetchone()[0]

    def test_statement_and_card_payment_are_paired(self):
        ingest.import_bytes(self.conn, GIRO.encode(), "girokonto.csv")
        ingest.import_bytes(self.conn, CARD.encode(), "visa-kreditkarte.csv")
        self.assertEqual(self.cat("Kreditkartenabrechnung"), self.own)
        self.assertEqual(self.cat("Ausgleich Kreditkarte"), self.own)
        # Käufe zählen genau einmal: 40 (Debitkarte) + 80 + 43,45 (Kreditkarte)
        kpis = analytics.dashboard(self.conn, "2026-09-01", "2026-09-30")["kpis"]
        self.assertEqual(kpis["expense"], 4000 + 8000 + 4345)

    def test_debit_card_purchase_is_not_a_statement(self):
        ingest.import_bytes(self.conn, GIRO.encode(), "girokonto.csv")
        ingest.import_bytes(self.conn, CARD.encode(), "visa-kreditkarte.csv")
        self.assertNotEqual(self.cat("Debitkartenumsatz"), self.own)

    def test_statement_counts_as_expense_without_card_import(self):
        ingest.import_bytes(self.conn, GIRO.encode(), "girokonto.csv")
        self.assertNotEqual(self.cat("Kreditkartenabrechnung"), self.own)
        report = transfers.reconcile(self.conn)
        self.assertEqual([u["amount"] for u in report["unmatched"]], [-12345])
        kpis = analytics.dashboard(self.conn, "2026-09-01", "2026-09-30")["kpis"]
        self.assertEqual(kpis["expense"], 4000 + 12345)

    def test_manual_choice_is_kept(self):
        ingest.import_bytes(self.conn, GIRO.encode(), "girokonto.csv")
        other = self.conn.execute("SELECT id FROM categories WHERE name = 'Sonstiges'").fetchone()[0]
        self.conn.execute("UPDATE transactions SET category_id = ?, manual = 1 WHERE purpose LIKE '%Kreditkartenabrechnung%'", (other,))
        ingest.import_bytes(self.conn, CARD.encode(), "visa-kreditkarte.csv")
        self.assertEqual(self.cat("Kreditkartenabrechnung"), other)


if __name__ == "__main__":
    unittest.main()
