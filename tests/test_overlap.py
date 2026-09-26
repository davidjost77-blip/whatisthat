"""Überlappende Exporte: nur übernehmen, was noch fehlt – und alte Doppelte finden."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finanzen import db, duplicates, ingest  # noqa: E402

HEAD = "Buchungsdatum;Empfänger;Verwendungszweck;Betrag\n"
A = HEAD + ("01.09.2026;Arbeitgeber GmbH;Gehalt 09/2026;3000,00\n"
            "10.09.2026;REWE Markt GmbH;Einkauf;-40,00\n"
            "15.09.2026;Café Kranz;Kartenzahlung;-3,20\n"
            "16.09.2026;Stadtwerke;Abschlag Strom;-80,00\n")
# neues Exportformat: andere Schreibweise; am 15.09. zwei Kaffee (einer war im alten Export noch nicht drin)
B = HEAD + ("10.09.2026;REWE Markt;EINKAUF 10.09.;-40,00\n"
            "15.09.2026;CAFE KRANZ;Kartenzahlung;-3,20\n"
            "15.09.2026;CAFE KRANZ;Kartenzahlung;-3,20\n"
            "16.09.2026;Stadtwerke Musterstadt;Abschlag Strom 09;-80,00\n"
            "20.09.2026;Bäckerei;Brot;-4,10\n")


class OverlapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "f.db"
        db.init_db(path)
        self.conn = db.connect(path)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def count(self):
        return self.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]

    def test_only_missing_part_is_imported(self):
        ingest.import_bytes(self.conn, A.encode(), "girokonto.csv")
        res = ingest.import_bytes(self.conn, B.encode(), "girokonto.csv")
        self.assertEqual(res["rows_new"], 2)                     # zweiter Kaffee + Bäckerei
        self.assertEqual(self.count(), 6)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM transactions WHERE amount = -320").fetchone()[0], 2)

    def test_same_file_twice(self):
        ingest.import_bytes(self.conn, B.encode(), "girokonto.csv")
        self.assertEqual(ingest.import_bytes(self.conn, B.encode(), "girokonto.csv")["rows_new"], 0)

    def test_renamed_account_is_recognised(self):
        ingest.import_bytes(self.conn, A.encode(), "girokonto.csv")
        res = ingest.import_bytes(self.conn, B.encode(), "umsaetze-neu.csv")
        self.assertEqual((res["account"], res["account_renamed_from"], res["rows_new"]), ("girokonto", "neu", 2))

    def test_old_duplicates_are_found_and_removed(self):
        ingest.import_bytes(self.conn, A.encode(), "girokonto.csv")
        # so sah es mit der alten Duplikaterkennung aus: andere Schreibweise → doppelt übernommen
        imp = self.conn.execute("INSERT INTO imports (filename, profile, account) VALUES ('b.csv', 'x', 'girokonto')").lastrowid
        for i, (d, amt, cp, pur) in enumerate([("2026-09-10", -4000, "REWE Markt", "EINKAUF 10.09."),
                                               ("2026-09-16", -8000, "Stadtwerke Musterstadt", "Abschlag Strom 09"),
                                               ("2026-09-15", -320, "Café Kranz", "Kartenzahlung")]):
            self.conn.execute("INSERT INTO transactions (hash, date, amount, counterparty, purpose, account, import_id) "
                              "VALUES (?, ?, ?, ?, ?, 'girokonto', ?)", (f"old{i}", d, amt, cp, pur, imp))
        self.conn.commit()
        found = duplicates.summary(self.conn)
        self.assertEqual(found["count"], 2)                      # identischer Kaffee-Text = echte Wiederholung, bleibt
        res = duplicates.remove(self.conn)
        self.assertEqual((res["removed"], self.count()), (2, 5))
        duplicates.restore(self.conn, res["undo"])
        self.assertEqual(self.count(), 7)

    def test_different_shops_same_amount_are_not_duplicates(self):
        ingest.import_bytes(self.conn, (HEAD + "05.09.2026;Lidl;Kartenzahlung;-10,00\n").encode(), "girokonto.csv")
        ingest.import_bytes(self.conn, (HEAD + "05.09.2026;Aldi Süd;Kartenzahlung;-10,00\n05.09.2026;Lidl;Kartenzahlung;-10,00\n").encode(), "girokonto.csv")
        self.assertEqual(self.count(), 2)
        self.assertEqual(duplicates.summary(self.conn)["count"], 0)


if __name__ == "__main__":
    unittest.main()
