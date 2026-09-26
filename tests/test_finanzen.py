"""Tests: python -m unittest discover -s tests"""

import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finanzen import analytics, db, importer, ingest, rules  # noqa: E402
from finanzen.server import App, serve  # noqa: E402

BANK_SAMPLES = {
    "dkb": (
        '"Girokonto";"DE02120300000000202051"\n""\n'
        '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";'
        '"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n'
        '"15.03.24";"15.03.24";"Gebucht";"Max Mustermann";"REWE Markt GmbH";"Einkauf";"Ausgang";"DE1";"-1.234,56";"";"";""\n'
        '"14.03.24";"14.03.24";"Gebucht";"ACME GmbH";"Max Mustermann";"Gehalt März";"Eingang";"DE2";"3.000,00";"";"";""\n'
        '"16.03.24";"16.03.24";"Vorgemerkt";"Max Mustermann";"Shell";"Tanken";"Ausgang";"DE3";"-50,00";"";"";""\n'
    ).encode("utf-8-sig"),
    "ing": (
        "Umsatzanzeige;Datei erstellt am: 20.03.2024\n\nIBAN;DE89 5001 0517 0648 4898 90\nKontoname;Girokonto\n\n"
        "Buchung;Wertstellungsdatum;Auftraggeber/Empfänger;Buchungstext;Verwendungszweck;Saldo;Währung;Betrag;Währung\n"
        "15.03.2024;15.03.2024;EDEKA;Lastschrift;Einkauf;1.000,00;EUR;-23,45;EUR\n"
    ).encode("cp1252"),
    "sparkasse": (
        '"Auftragskonto";"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";"Glaeubiger ID";"Mandatsreferenz";'
        '"Kundenreferenz (End-to-End)";"Sammlerreferenz";"Lastschrift Ursprungsbetrag";"Auslagenersatz Ruecklastschrift";'
        '"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"BIC (SWIFT-Code)";"Betrag";"Waehrung";"Info"\n'
        '"DE11500500000012345678";"15.03.24";"15.03.24";"FOLGELASTSCHRIFT";"Netflix Abo";"";"";"";"";"";"";'
        '"Netflix International";"NL00";"ABC";"-17,99";"EUR";"Umsatz gebucht"\n'
        '"DE11500500000012345678";"16.03.24";"16.03.24";"KARTENZAHLUNG";"Kaffee";"";"";"";"";"";"";'
        '"Café X";"";"";"-3,50";"EUR";"Umsatz vorgemerkt"\n'
    ).encode("cp1252"),
    "n26": (
        '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name",'
        '"Amount (EUR)","Original Amount","Original Currency","Exchange Rate"\n'
        '2024-03-15,2024-03-15,"Lieferando",,"Presentment","Essen","Main Account",-25.9,,,\n'
        '2024-03-16,2024-03-16,"Arbeitgeber",DE00,"Credit Transfer","Gehalt","Main Account",2500.00,,,\n'
    ).encode("utf-8"),
    "revolut": (
        "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n"
        "CARD_PAYMENT,Current,2024-03-15 10:11:12,2024-03-16 08:00:00,Amazon,-1234.50,0.00,EUR,COMPLETED,100.00\n"
        "CARD_PAYMENT,Current,2024-03-17 10:11:12,,Spotify,-9.99,0.00,EUR,PENDING,90.00\n"
    ).encode("utf-8"),
    "dkb_kreditkarte": (
        '"Karte";"Visa Kreditkarte";"4930 •••• •••• 1234"\n""\n"Saldo vom 23.09.2026:";"-0 EUR"\n""\n'
        '"Belegdatum";"Wertstellung";"Status";"Beschreibung";"Umsatztyp";"Betrag (€)";"Fremdwährungsbetrag"\n'
        '"22.09.26";"23.09.26";"Gebucht";"Ausgleich Kreditkarte gem";"Lastschrift";"77,23";""\n'
        '"22.09.26";"22.09.26";"Gebucht";"Kartenpreis";"Entgelt";"-2,49";""\n'
        '"17.09.26";"18.09.26";"Gebucht";"UBER   *EATS";"Onlinezahlung";"-24,36";""\n'
        '"16.09.26";"17.09.26";"Gebucht";"UBER* TRIP";"Onlinezahlung";"-8,91";"-189,91 MX$"\n'
    ).encode("utf-8-sig"),
    "dkb_paypal": (
        '"Girokonto";"DE02120300000000202051"\n\n'
        '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";'
        '"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n'
        '"22.09.26";"22.09.26";"Gebucht";"Max Mustermann";"PayPal Europe S.a.r.l. et Cie S.C.A";'
        '"1053196823531/. Wolt, Ihr Einkauf bei Wolt";"Ausgang";"LU89";"-16,24";"";"";""\n'
    ).encode("utf-8-sig"),
    "soll_haben": (
        "Datum;Empfänger;Verwendungszweck;Soll;Haben\n"
        "15.03.2024;Vermieter;Miete;800,00;\n"
        "16.03.2024;Chef;Lohn;;2.000,00\n"
    ).encode("utf-8"),
}


class ParsingTests(unittest.TestCase):
    def test_amounts(self):
        cases = [("1.234,56", ",", 123456), ("-12,5", ",", -1250), ("1,234.56", ".", 123456), ("(3.00)", ".", -300),
                 ("12,00-", ",", -1200), ("+5,00 €", ",", 500), ("1.234", ",", 123400), ("-0,99 EUR", ",", -99)]
        for raw, dec, cents in cases:
            self.assertEqual(importer.parse_amount(raw, dec), cents, raw)
        self.assertIsNone(importer.parse_amount("abc"))

    def test_dates(self):
        self.assertEqual(importer.parse_date("15.03.24"), "2024-03-15")
        self.assertEqual(importer.parse_date("15.03.2024"), "2024-03-15")
        self.assertEqual(importer.parse_date("2024-03-15 10:11:12"), "2024-03-15")
        self.assertIsNone(importer.parse_date("offen"))

    def test_dkb(self):
        txs, info = importer.parse_file(BANK_SAMPLES["dkb"], "dkb.csv")
        self.assertEqual(len(txs), 2)  # vorgemerkte Buchung übersprungen
        self.assertEqual(info["account"], "DE02120300000000202051")
        self.assertEqual(txs[0]["amount"], -123456)
        self.assertEqual(txs[0]["counterparty"], "REWE Markt GmbH")  # Empfänger bei Ausgabe
        self.assertEqual(txs[1]["counterparty"], "ACME GmbH")  # Zahlungspflichtiger bei Einnahme

    def test_ing_cp1252_and_preamble(self):
        txs, info = importer.parse_file(BANK_SAMPLES["ing"], "ing.csv")
        self.assertEqual(info["account"], "DE89500105170648489890")
        self.assertEqual(txs[0]["counterparty"], "EDEKA")
        self.assertEqual(txs[0]["amount"], -2345)

    def test_sparkasse(self):
        txs, _ = importer.parse_file(BANK_SAMPLES["sparkasse"], "spk.csv")
        self.assertEqual(len(txs), 1)
        self.assertEqual(txs[0]["account"], "DE11500500000012345678")
        self.assertEqual(txs[0]["counterparty"], "Netflix International")

    def test_n26_dot_decimal(self):
        txs, info = importer.parse_file(BANK_SAMPLES["n26"], "n26.csv")
        self.assertEqual(info["decimal"], ".")
        self.assertEqual([t["amount"] for t in txs], [-2590, 250000])

    def test_revolut(self):
        txs, _ = importer.parse_file(BANK_SAMPLES["revolut"], "revolut.csv")
        self.assertEqual(len(txs), 1)
        self.assertEqual(txs[0]["date"], "2024-03-16")
        self.assertEqual(txs[0]["amount"], -123450)

    def test_dkb_credit_card(self):
        txs, info = importer.parse_file(BANK_SAMPLES["dkb_kreditkarte"], "b428df79-23-09-2026_Umsatzliste_Visa.csv")
        # Konto aus der Kopfzeile, nicht aus dem (täglich wechselnden) Dateinamen
        self.assertEqual(info["account"], "Visa Kreditkarte ···1234")
        self.assertEqual([t["counterparty"] for t in txs][:2], ["Ausgleich Kreditkarte gem", "Kartenpreis"])
        again, _ = importer.parse_file(BANK_SAMPLES["dkb_kreditkarte"], "24-09-2026_Umsatzliste_Visa.csv")
        self.assertEqual([t["hash"] for t in txs], [t["hash"] for t in again])

    def test_paypal_merchant(self):
        txs, _ = importer.parse_file(BANK_SAMPLES["dkb_paypal"], "giro.csv")
        self.assertEqual(txs[0]["counterparty"], "Wolt")
        self.assertIn("PayPal", txs[0]["booking_text"])

    def test_account_from_filename(self):
        self.assertEqual(importer.account_from_filename("faa05d10-23-09-2026_Umsatzliste_Visa_Karte_3767.csv"),
                         "Visa Karte 3767")

    def test_debit_credit_columns(self):
        txs, _ = importer.parse_file(BANK_SAMPLES["soll_haben"], "konto.csv")
        self.assertEqual([t["amount"] for t in txs], [-80000, 200000])

    def test_custom_profile(self):
        data = "Tag|Wer|Wieviel\n01/02/2024|Bäcker|-2.50\n".encode()
        profiles = [{"name": "Meine Bank", "columns": {"date": "Tag", "counterparty": "Wer", "amount": "Wieviel"},
                     "date_format": "%d/%m/%Y", "decimal": ".", "account": "Hausbank"}]
        txs, info = importer.parse_file(data, "x.csv", profiles)
        self.assertEqual(info["profile"], "Meine Bank")
        self.assertEqual(txs[0], {**txs[0], "date": "2024-02-01", "amount": -250, "account": "Hausbank"})

    def test_rejects_unknown(self):
        with self.assertRaises(importer.ImportError_):
            importer.parse_file(b"a;b\n1;2\n", "x.csv")

    def test_identical_rows_are_kept(self):
        data = ("Datum;Empfänger;Betrag\n01.03.2024;Bäcker;-3,20\n01.03.2024;Bäcker;-3,20\n").encode()
        txs, _ = importer.parse_file(data, "x.csv")
        self.assertEqual(len({t["hash"] for t in txs}), 2)


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "t.db")
        db.init_db(self.path)
        self.conn = db.connect(self.path)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def cat(self, name):
        return self.conn.execute("SELECT id FROM categories WHERE name = ?", (name,)).fetchone()[0]

    def test_import_dedupes_and_categorizes(self):
        r1 = ingest.import_bytes(self.conn, BANK_SAMPLES["dkb"], "a.csv")
        r2 = ingest.import_bytes(self.conn, BANK_SAMPLES["dkb"], "b.csv")
        self.assertEqual((r1["rows_new"], r2["rows_new"], r2["rows_duplicate"]), (2, 0, 2))
        rows = {r["counterparty"]: r["category_id"] for r in self.conn.execute("SELECT * FROM transactions")}
        self.assertEqual(rows["REWE Markt GmbH"], self.cat("Supermarkt"))
        self.assertEqual(rows["ACME GmbH"], self.cat("Gehalt"))

    def test_default_rules_for_cards(self):
        ingest.import_bytes(self.conn, BANK_SAMPLES["dkb_kreditkarte"], "k.csv")
        ingest.import_bytes(self.conn, BANK_SAMPLES["dkb_paypal"], "g.csv")
        got = {r["counterparty"]: r["category_id"] for r in self.conn.execute("SELECT * FROM transactions")}
        self.assertEqual(got["Ausgleich Kreditkarte gem"], self.cat("Eigene Konten"))  # Umbuchung, keine Einnahme
        self.assertEqual(got["Kartenpreis"], self.cat("Gebühren"))
        self.assertEqual(got["UBER *EATS"], self.cat("Lieferdienste"))
        self.assertEqual(got["UBER* TRIP"], self.cat("Taxi & Sharing"))
        self.assertEqual(got["Wolt"], self.cat("Lieferdienste"))

    def test_own_account_and_salary(self):
        data = ('"Girokonto";"DE02120300000000202051"\n\n'
                '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";'
                '"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)"\n'
                '"01.09.26";"01.09.26";"Gebucht";"Max Mustermann    Hauptstr 1";"Erika Muster";"Geschenk";"Ausgang";"";"-20"\n'
                '"02.09.26";"02.09.26";"Gebucht";"Max Mustermann";"Max Peter Mustermann";"";"Ausgang";"";"-200"\n'
                '"03.09.26";"03.09.26";"Gebucht";"ISSUER";"REWE";"Karte";"Ausgang";"";"-5"\n'
                '"04.09.26";"04.09.26";"Gebucht";"Max Mustermann";"Vermieter";"Kaution";"Ausgang";"";"-9"\n'
                '"25.09.26";"25.09.26";"Gebucht";"ACME Inc";"Max Mustermann";"SALARY ACME NET PAY";"Eingang";"";"3000"\n'
                ).encode("utf-8")
        ingest.import_bytes(self.conn, data, "g.csv")
        got = {r["counterparty"]: r["category_id"] for r in self.conn.execute("SELECT * FROM transactions")}
        self.assertEqual(got["Max Peter Mustermann"], self.cat("Eigene Konten"))
        self.assertIsNone(got["Erika Muster"])
        self.assertEqual(got["ACME Inc"], self.cat("Gehalt"))

    def test_uncategorized_groups(self):
        data = ("Datum;Empfänger;Betrag\n01.03.2024;Karl August GmbH;-10,00\n"
                "02.03.2024;Karl.August.GmbH/Nuernberg;-5,00\n03.03.2024;Kiosk;-1,00\n").encode()
        ingest.import_bytes(self.conn, data, "x.csv")
        groups = analytics.uncategorized_groups(self.conn)["groups"]
        karl = next(g for g in groups if g["name"].startswith("Karl"))
        self.assertEqual(karl["count"], 2)
        rule = rules.CompiledRule({"id": 0, "category_id": 1, "field": "counterparty", "op": karl["op"],
                                   "pattern": karl["pattern"], "direction": "any", "min_amount": None,
                                   "max_amount": None})
        self.assertTrue(all(rule.matches({"amount": -1, "counterparty": v, "purpose": "", "booking_text": ""})
                            for v in karl["variants"]))

    def test_manual_category_survives_rules(self):
        ingest.import_bytes(self.conn, BANK_SAMPLES["dkb"], "a.csv")
        self.conn.execute("UPDATE transactions SET category_id = ?, manual = 1 WHERE counterparty = 'REWE Markt GmbH'",
                          (self.cat("Bäcker"),))
        rules.apply_rules(self.conn)
        cid = self.conn.execute("SELECT category_id FROM transactions WHERE counterparty = 'REWE Markt GmbH'").fetchone()[0]
        self.assertEqual(cid, self.cat("Bäcker"))

    def test_rule_filters(self):
        rule = rules.CompiledRule({"id": 1, "category_id": 1, "field": "counterparty", "op": "contains",
                                   "pattern": "rewe", "direction": "out", "min_amount": 1000, "max_amount": None})
        tx = {"amount": -1500, "counterparty": "REWE Markt", "purpose": "", "booking_text": ""}
        self.assertTrue(rule.matches(tx))
        self.assertFalse(rule.matches({**tx, "amount": -500}))
        self.assertFalse(rule.matches({**tx, "amount": 1500}))

    def test_dashboard_math(self):
        ingest.import_bytes(self.conn, BANK_SAMPLES["dkb"], "a.csv")
        # Rückerstattung in einer Ausgabenkategorie senkt die Ausgaben, Umbuchung zählt nicht
        data = ("Datum;Empfänger;Verwendungszweck;Betrag\n"
                "20.03.2024;REWE Markt GmbH;Erstattung;34,56\n"
                "21.03.2024;Trade Republic;Sparplan;-500,00\n").encode()
        ingest.import_bytes(self.conn, data, "b.csv", account="DE02120300000000202051")
        # von Hand der Ausgabenkategorie zugeordnet (Regel hätte "Erstattungen" gewählt)
        self.conn.execute("UPDATE transactions SET category_id = ?, manual = 1 WHERE amount = 3456",
                          (self.cat("Supermarkt"),))
        d = analytics.dashboard(self.conn, "2024-03-01", "2024-03-31")
        self.assertEqual(d["kpis"]["income"], 300000)
        self.assertEqual(d["kpis"]["expense"], 123456 - 3456)
        self.assertEqual(d["kpis"]["transfer"], -50000)
        self.assertEqual(d["categories"][0]["name"], "Lebensmittel")
        flow_in = sum(l["value"] for l in d["sankey"]["links"] if l["target"] == "Verfügbar")
        flow_out = sum(l["value"] for l in d["sankey"]["links"] if l["source"] == "Verfügbar")
        self.assertEqual(flow_in, flow_out)
        self.assertEqual(d["balance"][-1][1], 300000 - 123456 + 3456 - 50000)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.app = App(str(Path(cls.tmp.name) / "t.db"))
        cls.httpd = serve(cls.app, "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None, headers=None, raw=None):
        h = {"X-Finanzen": "1", **(headers or {})}
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_flow(self):
        status, res = self.call("POST", "/api/import", raw=BANK_SAMPLES["ing"], headers={"X-Filename": "ing.csv"})
        self.assertEqual((status, res["rows_new"]), (200, 1))
        status, res = self.call("POST", "/api/categories", {"name": "Haustier", "kind": "expense", "color": "#2a78d6"})
        self.assertEqual(status, 200)
        pet = res["id"]
        status, res = self.call("POST", "/api/rules", {"category_id": pet, "field": "counterparty", "op": "equals",
                                                       "pattern": "edeka", "priority": 1})
        self.assertEqual((status, res["changed"]), (200, 1))
        _, txs = self.call("GET", f"/api/transactions?category={pet}")
        self.assertEqual(txs["total"], 1)
        _, dash = self.call("GET", "/api/dashboard")
        self.assertEqual(dash["categories"][0]["name"], "Haustier")
        status, _ = self.call("POST", "/api/rules", {"category_id": pet, "op": "regex", "pattern": "("})
        self.assertEqual(status, 400)

    def test_new_bookings_since_last_visit(self):
        _, st = self.call("GET", "/api/status")
        seen = st["max_id"]
        self.call("POST", "/api/import", raw=BANK_SAMPLES["n26"], headers={"X-Filename": "n26.csv"})
        _, st = self.call("GET", "/api/status")
        self.assertGreater(st["max_id"], seen)
        _, txs = self.call("GET", f"/api/transactions?since={seen}")
        self.assertEqual(txs["total"], 2)
        self.assertTrue(all(t["id"] > seen for t in txs["items"]))

    def test_csrf_header_required(self):
        req = urllib.request.Request(self.base + "/api/rules/apply", data=b"{}", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 403)

    def test_bad_upload(self):
        status, res = self.call("POST", "/api/import", raw=b"hallo", headers={"X-Filename": "x.csv"})
        self.assertEqual(status, 400)
        self.assertIn("Kopfzeile", res["error"])

    def test_static_no_traversal(self):
        with urllib.request.urlopen(self.base + "/") as res:
            self.assertIn(b"Finanzen", res.read())
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(self.base + "/..%2f..%2fdb.py")


if __name__ == "__main__":
    unittest.main()
