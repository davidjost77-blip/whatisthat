"""Tests der Enable-Banking-Anbindung – ohne Netz (API wird simuliert)."""

import base64
import json
import shutil
import subprocess
import tempfile
import unittest
from datetime import date
from pathlib import Path

from finanzen import bank, db, ingest

OPENSSL = shutil.which("openssl")


def _b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class FakeApi:
    """Minimaler Nachbau der Enable-Banking-API."""

    def __init__(self):
        self.calls = []
        self.transactions = {"acc-1": [
            {"entry_reference": "r1", "transaction_amount": {"amount": "12.50", "currency": "EUR"}, "credit_debit_indicator": "DBIT",
             "booking_date": "2026-09-20", "creditor": {"name": "REWE Markt GmbH"}, "remittance_information": ["Einkauf"], "status": "BOOK"},
            {"entry_reference": "r2", "transaction_amount": {"amount": "3100.00", "currency": "EUR"}, "credit_debit_indicator": "CRDT",
             "booking_date": "2026-09-25", "debtor": {"name": "Arbeitgeber GmbH"}, "remittance_information": ["Gehalt September"], "status": "BOOK"},
            {"entry_reference": "r3", "transaction_amount": {"amount": "7.00", "currency": "EUR"}, "credit_debit_indicator": "DBIT",
             "booking_date": "2026-09-26", "creditor": {"name": "Bäckerei"}, "status": "PDNG"},
            {"entry_reference": "r4", "transaction_amount": {"amount": "42.00", "currency": "EUR"}, "credit_debit_indicator": "DBIT",
             "booking_date": "2026-09-18", "creditor": {"name": "PayPal Europe"}, "remittance_information": ["Ihr Einkauf bei Zalando SE"], "status": "BOOK"},
        ]}

    def __call__(self, method, url, headers, body=None, timeout=40):
        self.calls.append((method, url, headers, body))
        path = url.split("api.enablebanking.com", 1)[1]
        if path.startswith("/application"):
            return {"name": "Finanzen", "redirect_urls": ["https://localhost:8765/bank/callback"], "active": True}
        if path.startswith("/aspsps"):
            return {"aspsps": [{"name": "DKB", "country": "DE", "maximum_consent_validity": 15552000}, {"name": "ING", "country": "DE"}]}
        if path == "/auth":
            return {"url": "https://tilisy.enablebanking.com/welcome?sessionid=abc"}
        if path == "/sessions":
            assert body == {"code": "CODE123"}
            return {"session_id": "sess-1", "aspsp": {"name": "DKB", "country": "DE"}, "access": {"valid_until": "2027-03-20T00:00:00+00:00"},
                    "accounts": [{"uid": "acc-1", "account_id": {"iban": "DE02120300000000202051"}, "name": "Girokonto", "currency": "EUR"}]}
        if path.startswith("/accounts/acc-1/transactions"):
            if "continuation_key=page2" in path:
                return {"transactions": self.transactions["acc-1"][2:]}
            return {"transactions": self.transactions["acc-1"][:2], "continuation_key": "page2"}
        if path == "/accounts/acc-1/balances":
            return {"balances": [{"balance_amount": {"amount": "1234.56", "currency": "EUR"}, "balance_type": "ITAV"},
                                 {"balance_amount": {"amount": "1200.00", "currency": "EUR"}, "balance_type": "CLBD",
                                  "reference_date": "2026-09-25"}]}
        if path.startswith("/sessions/"):
            return {}
        raise AssertionError(f"unerwarteter Aufruf {method} {path}")


@unittest.skipUnless(OPENSSL, "openssl nicht installiert")
class SigningTests(unittest.TestCase):
    def test_rs256_verifies_with_openssl(self):
        with tempfile.TemporaryDirectory() as tmp:
            key = Path(tmp) / "k.pem"
            subprocess.run([OPENSSL, "genrsa", "-out", str(key), "2048"], check=True, capture_output=True)
            pem = key.read_text()
            # PKCS#8 und PKCS#1 müssen beide lesbar sein
            pkcs1 = subprocess.run([OPENSSL, "rsa", "-in", str(key), "-traditional"], capture_output=True, text=True).stdout
            self.assertEqual(bank.load_private_key(pem), bank.load_private_key(pkcs1 or pem))
            token = bank.make_jwt("app-123", bank.load_private_key(pem), now=1_800_000_000)
            h, b, s = token.split(".")
            self.assertEqual(json.loads(_b64d(h)), {"typ": "JWT", "alg": "RS256", "kid": "app-123"})
            body = json.loads(_b64d(b))
            self.assertEqual((body["iss"], body["aud"], body["exp"] - body["iat"]), ("enablebanking.com", "api.enablebanking.com", 3600))
            (Path(tmp) / "msg").write_bytes(f"{h}.{b}".encode())
            (Path(tmp) / "sig").write_bytes(_b64d(s))
            subprocess.run([OPENSSL, "rsa", "-in", str(key), "-pubout", "-out", str(Path(tmp) / "pub.pem")], check=True, capture_output=True)
            r = subprocess.run([OPENSSL, "dgst", "-sha256", "-verify", str(Path(tmp) / "pub.pem"), "-signature", str(Path(tmp) / "sig"),
                                str(Path(tmp) / "msg")], capture_output=True, text=True)
            self.assertIn("Verified OK", r.stdout)

    def test_rejects_garbage_and_encrypted(self):
        with self.assertRaises(bank.BankError):
            bank.load_private_key("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")
        with self.assertRaises(bank.BankError):
            bank.load_private_key("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----")


@unittest.skipUnless(OPENSSL, "openssl nicht installiert")
class FlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.db_path = self.dir / "f.db"
        db.init_db(self.db_path)
        self.conn = db.connect(self.db_path)
        bank.init(self.conn)
        subprocess.run([OPENSSL, "genrsa", "-out", str(self.dir / "k.pem"), "2048"], check=True, capture_output=True)
        self.api = FakeApi()
        self._orig = bank.request_json
        bank.request_json = self.api

    def tearDown(self):
        bank.request_json = self._orig
        self.conn.close()
        self.tmp.cleanup()

    def connect(self):
        key_dir = self.dir / "bank"
        bank.configure(self.conn, key_dir, "app-123", (self.dir / "k.pem").read_text())
        self.assertTrue((key_dir / "private.pem").exists())
        auth = bank.start_auth(self.conn, key_dir, "DKB", "DE", max_days=180)
        self.assertIn("tilisy", auth["url"])
        state = bank._get(self.conn, "pending")["state"]
        return key_dir, f"https://localhost:8765/bank/callback?state={state}&code=CODE123"

    def test_full_flow_and_dedupe(self):
        key_dir, redirect = self.connect()
        self.assertTrue(self.api.calls[-1][2]["Authorization"].startswith("Bearer "))
        res = bank.finish_auth(self.conn, key_dir, redirect)
        self.assertEqual(res["accounts"][0]["iban"], "DE02120300000000202051")
        results = bank.sync(self.conn, key_dir, today=date(2026, 9, 26))
        self.assertEqual(results[0]["new"], 3)                  # vorgemerkte Buchung bleibt draußen
        rows = {r["counterparty"]: r for r in self.conn.execute("SELECT * FROM transactions")}
        self.assertEqual(rows["REWE Markt GmbH"]["amount"], -1250)
        self.assertEqual(rows["Arbeitgeber GmbH"]["amount"], 310000)
        self.assertIn("Zalando SE", rows)                        # PayPal → eigentlicher Händler
        self.assertIsNotNone(rows["REWE Markt GmbH"]["category_id"])   # Regeln greifen
        anchor = self.conn.execute("SELECT account, date, amount, source FROM balances").fetchone()   # gebuchter Stand bevorzugt
        self.assertEqual(tuple(anchor), ("DE02120300000000202051", "2026-09-25", 120000, "bank"))
        again = bank.sync(self.conn, key_dir, today=date(2026, 9, 26))
        self.assertEqual((again[0]["new"], again[0]["duplicate"]), (0, 3))
        st = bank.status(self.conn, key_dir)
        self.assertTrue(st["configured"])
        self.assertEqual(st["sessions"][0]["aspsp"], "DKB")
        bank.disconnect(self.conn, key_dir, "sess-1")
        self.assertEqual(bank.status(self.conn, key_dir)["sessions"], [])

    def test_csv_twin_is_not_imported_twice(self):
        csv = ("Buchungsdatum;Empfänger;Verwendungszweck;Betrag\n20.09.2026;REWE Markt GmbH;Einkauf;-12,50\n").encode("utf-8")
        ingest.import_bytes(self.conn, csv, "DE02120300000000202051.csv")
        key_dir, redirect = self.connect()
        bank.finish_auth(self.conn, key_dir, redirect)
        res = bank.sync(self.conn, key_dir, today=date(2026, 9, 26))
        self.assertEqual(res[0]["duplicate"], 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM transactions WHERE amount = -1250").fetchone()[0], 1)

    def test_wrong_state_and_bank_error(self):
        key_dir, _ = self.connect()
        with self.assertRaises(bank.BankError):
            bank.finish_auth(self.conn, key_dir, "https://localhost/cb?state=other&code=CODE123")
        with self.assertRaises(bank.BankError):
            bank.finish_auth(self.conn, key_dir, "https://localhost/cb?error=access_denied&error_description=abgebrochen")


if __name__ == "__main__":
    unittest.main()
