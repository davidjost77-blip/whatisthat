"""Gehaltsmonate: vom Gehalt bis unmittelbar vor das nächste Gehalt."""

import unittest
from datetime import date

from finanzen.cycles import Cycles


def d(s):
    return date.fromisoformat(s)


class CycleTests(unittest.TestCase):
    def setUp(self):
        # Gehalt meist am 27., einmal wegen Wochenende am 25., im Dezember früher (22.)
        self.cy = Cycles([d("2026-06-27"), d("2026-07-25"), d("2026-08-27"), d("2026-09-26")], today=d("2026-10-05"))

    def test_month_runs_from_salary_to_day_before_next(self):
        self.assertEqual(self.cy.range_of("2026-08"), ("2026-07-25", "2026-08-26"))
        self.assertEqual(self.cy.key_of("2026-08-26"), "2026-08")
        self.assertEqual(self.cy.key_of("2026-08-27"), "2026-09")      # Gehaltstag gehört schon zum neuen Monat

    def test_named_after_majority_month(self):
        self.assertEqual([c["key"] for c in self.cy.cycles], ["2026-07", "2026-08", "2026-09", "2026-10"])

    def test_open_month_ends_before_expected_salary(self):
        self.assertEqual(self.cy.range_of("2026-10"), ("2026-09-26", "2026-10-25"))

    def test_before_first_salary_calendar_without_overlap(self):
        self.assertEqual(self.cy.key_of("2026-06-10"), "2026-06")
        self.assertEqual(self.cy.range_of("2026-06"), ("2026-06-01", "2026-06-26"))

    def test_keys_between_continuous(self):
        self.assertEqual(self.cy.keys_between("2026-06-01", "2026-10-03"), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"])

    def test_without_salary_calendar_months(self):
        cy = Cycles([])
        self.assertFalse(cy.active)
        self.assertEqual(cy.key_of("2026-02-14"), "2026-02")
        self.assertEqual(cy.range_of("2026-02"), ("2026-02-01", "2026-02-28"))


class SalaryDetectionTests(unittest.TestCase):
    def test_bonus_does_not_start_month(self):
        import tempfile
        from pathlib import Path
        from finanzen import cycles, db, ingest
        csv = ("Buchungsdatum;Empfänger;Verwendungszweck;Betrag\n"
               "27.10.2026;Arbeitgeber GmbH;Gehalt 10/2026;3000,00\n"
               "20.11.2026;Arbeitgeber GmbH;Gehalt Weihnachtsgeld;2500,00\n"
               "27.11.2026;Arbeitgeber GmbH;Gehalt 11/2026;3000,00\n"
               "05.11.2026;Arbeitgeber GmbH;Gehalt Korrektur;150,00\n")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "f.db"
            db.init_db(path)
            conn = db.connect(path)
            ingest.import_bytes(conn, csv.encode(), "konto.csv")
            self.assertEqual(cycles.salary_starts(conn), [d("2026-10-27"), d("2026-11-27")])
            conn.close()


if __name__ == "__main__":
    unittest.main()
