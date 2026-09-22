"""Erzeugt realistische Demo-Exporte (DKB- und ING-Format) zum Ausprobieren.

    python scripts/demo_daten.py            # schreibt nach sample_data/
    python scripts/demo_daten.py inbox      # direkt in die Inbox -> automatischer Import
"""

import random
import sys
from datetime import date, timedelta
from pathlib import Path

rng = random.Random(42)
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "sample_data"
END = date.today()
START = date(END.year - 1, END.month, 1)


def de(cents):
    s = f"{abs(cents) / 100:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return ("-" if cents < 0 else "") + s


def month_starts():
    d = START
    while d <= END:
        yield d
        d = date(d.year + (d.month == 12), d.month % 12 + 1, 1)


def giro():
    tx = []  # (datum, betrag_cent, gegenpartei, verwendungszweck, typ)
    for m in month_starts():
        def day(n):
            return m + timedelta(days=min(n, 27))
        tx.append((day(0), 385000, "ACME Software GmbH",
                   f"Gehalt {m:%m/%Y}", "Eingang"))
        tx.append((day(1), -125000, "Hausverwaltung Schmidt", f"Miete {m:%m/%Y} Whg 3.OG", "Dauerauftrag"))
        tx.append((day(2), -9500, "Stadtwerke München", "Abschlag Strom Gas", "Lastschrift"))
        tx.append((day(3), -3999, "Telekom Deutschland GmbH", "Festnetz/Internet", "Lastschrift"))
        tx.append((day(4), -1799, "Netflix International B.V.", "Mitgliedschaft", "Lastschrift"))
        tx.append((day(4), -1099, "Spotify AB", "Premium Family", "Lastschrift"))
        tx.append((day(5), -4990, "HUK-COBURG Versicherung", "Kfz-Haftpflicht", "Lastschrift"))
        tx.append((day(1), -50000, "Trade Republic Bank", "Sparplan ETF", "Dauerauftrag"))
        tx.append((day(6), -2990, "Urban Sports Club", "Mitgliedsbeitrag", "Lastschrift"))
        tx.append((day(14), -5800, "DB Vertrieb GmbH", "Deutschlandticket", "Lastschrift"))
        for _ in range(rng.randint(9, 13)):
            shop = rng.choice(["REWE Markt GmbH", "EDEKA Center", "ALDI SUED", "LIDL sagt Danke", "dm-drogerie markt"])
            tx.append((day(rng.randint(0, 27)), -rng.randint(1200, 9800), shop, "Kartenzahlung girocard",
                       "Kartenzahlung"))
        for _ in range(rng.randint(3, 7)):
            tx.append((day(rng.randint(0, 27)), -rng.randint(250, 900), "Backhaus Müller", "Kartenzahlung",
                       "Kartenzahlung"))
        for _ in range(rng.randint(2, 5)):
            place = rng.choice(["Pizzeria Da Mario", "Café Glockenspiel", "Lieferando.de", "Restaurant Seoul"])
            tx.append((day(rng.randint(0, 27)), -rng.randint(1500, 6500), place, "Kartenzahlung", "Kartenzahlung"))
        for _ in range(rng.randint(1, 4)):
            tx.append((day(rng.randint(0, 27)), -rng.randint(1500, 12000), "AMAZON EU S.A R.L.",
                       f"Bestellung 302-{rng.randint(1000000, 9999999)}", "Lastschrift"))
        for _ in range(rng.randint(1, 3)):
            tx.append((day(rng.randint(0, 27)), -rng.randint(4000, 8500), rng.choice(["ARAL Station", "Shell 1234"]),
                       "Kartenzahlung", "Kartenzahlung"))
        if rng.random() < 0.5:
            tx.append((day(rng.randint(0, 27)), -rng.choice([5000, 10000]), "Geldautomat Sparkasse",
                       "Bargeldauszahlung", "Auszahlung"))
        if rng.random() < 0.35:
            tx.append((day(rng.randint(0, 27)), -rng.randint(1500, 9000), "Apotheke am Markt", "Kartenzahlung",
                       "Kartenzahlung"))
        if rng.random() < 0.3:
            tx.append((day(rng.randint(0, 27)), -rng.randint(3000, 15000), "Zalando SE", "Bestellung",
                       "Lastschrift"))
        if rng.random() < 0.25:
            tx.append((day(rng.randint(0, 27)), rng.randint(1500, 6000), "AMAZON EU S.A R.L.", "Erstattung Retoure",
                       "Gutschrift"))
        if m.month in (7, 8) and rng.random() < 0.8:
            tx.append((day(rng.randint(0, 20)), -rng.randint(40000, 120000), "Booking.com", "Hotel Sommerurlaub",
                       "Kartenzahlung"))
        if m.month == 11:
            tx.append((day(20), 250000, "ACME Software GmbH", "Weihnachtsgeld", "Eingang"))
        if rng.random() < 0.2:
            tx.append((day(rng.randint(0, 27)), -rng.randint(2000, 8000), "Kiosk Ecke Hauptstr",
                       "Kartenzahlung", "Kartenzahlung"))  # bleibt unkategorisiert
    return sorted((t for t in tx if t[0] <= END), key=lambda t: t[0], reverse=True)


def write_dkb(path, txs):
    lines = ['"Girokonto";"DE02120300000000202051"', '""', '"Kontostand vom ' + f'{END:%d.%m.%Y}' + ':";"4.211,37 €"',
             '""',
             '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";'
             '"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"']
    for d, amount, party, purpose, typ in txs:
        payer, payee = (party, "Max Mustermann") if amount > 0 else ("Max Mustermann", party)
        status = "Vorgemerkt" if (END - d).days < 1 else "Gebucht"
        lines.append(f'"{d:%d.%m.%y}";"{d:%d.%m.%y}";"{status}";"{payer}";"{payee}";"{purpose}";"{typ}";'
                     f'"DE{rng.randint(10, 99)}100100100{rng.randint(1000000000, 9999999999)}";"{de(amount)}";"";"";""')
    path.write_text("\n".join(lines) + "\n", encoding="utf-8-sig")


def write_ing(path):
    tx = []
    for m in month_starts():
        for _ in range(rng.randint(1, 3)):
            d = m + timedelta(days=rng.randint(0, 27))
            if d <= END:
                tx.append((d, -rng.randint(1500, 7000), "Eurowings" if rng.random() < 0.1 else "Restaurant Seoul",
                           "Lastschrift", "Kreditkarte"))
        d = m + timedelta(days=15)
        if d <= END:
            tx.append((d, rng.randint(2000, 3000), "Tagesgeld Zinsen", "Gutschrift", "Zinsen 0,75 %"))
    lines = ["Umsatzanzeige;Datei erstellt am: " + f"{END:%d.%m.%Y}", "", "IBAN;DE89 5001 0517 0648 4898 90",
             "Kontoname;Extra-Konto", "Bank;ING", "Kunde;Max Mustermann", "", "Sortierung;Datum absteigend", "",
             "Buchung;Wertstellungsdatum;Auftraggeber/Empfänger;Buchungstext;Verwendungszweck;Saldo;Währung;"
             "Betrag;Währung"]
    for d, amount, party, text, purpose in sorted(tx, key=lambda t: t[0], reverse=True):
        lines.append(f"{d:%d.%m.%Y};{d:%d.%m.%Y};{party};{text};{purpose};1.000,00;EUR;{de(amount)};EUR")
    path.write_text("\n".join(lines) + "\n", encoding="cp1252")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    write_dkb(OUT / "demo_dkb_girokonto.csv", giro())
    write_ing(OUT / "demo_ing_extrakonto.csv")
    print(f"Demo-Dateien geschrieben nach {OUT}")
