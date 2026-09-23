# Finanzen – dein persönliches Finanz-Dashboard

Lokale Web-App, die deine Kontoumsätze aus CSV-Exporten der Banking-App einliest, sie über **frei definierbare
Kategorien und Regeln** automatisch zuordnet und alles in **Dashboards** darstellt. Neue Exporte werden
**kontinuierlich und automatisch** übernommen, auf Wunsch über ein PowerShell-Skript, das deinen Download-Ordner überwacht.

![Dashboard](docs/dashboard.png)

**Datenschutz:** Alles läuft auf deinem Rechner. Der Server lauscht nur auf `127.0.0.1`, die Daten liegen in einer
SQLite-Datei unter `data/`, und es gibt keine Cloud und kein Tracking. Die Diagrammbibliothek (ECharts) ist mitgeliefert,
die App funktioniert also auch offline.

## Schnellstart (Windows)

1. **Python 3.9+** installieren, falls noch nicht vorhanden: `winget install Python.Python.3.12`
   Es werden keine weiteren Pakete benötigt, die App nutzt nur die Python-Standardbibliothek.
2. Doppelklick auf **`Finanzen starten.cmd`**. Das Dashboard öffnet sich unter <http://localhost:8765/>.
3. Einen CSV-Export deiner Bank unter **Import** per Drag & Drop hineinziehen.

Zum Ausprobieren mit Demo-Daten (ein Jahr fiktiver Umsätze im DKB- und ING-Format):

```powershell
python scripts\demo_daten.py inbox     # legt die Dateien in die Inbox, die App importiert sie automatisch
```

macOS/Linux: `python3 -m finanzen --open`

## Kontinuierlicher Import

Es gibt drei Wege, die du beliebig kombinieren kannst:

| Weg | Wie | Wofür |
|---|---|---|
| **Inbox-Ordner** | Datei in `inbox/` legen | Die App prüft den Ordner alle 10 s, importiert neue Dateien und verschiebt sie nach `inbox/verarbeitet/` (bzw. `inbox/fehler/`). |
| **PowerShell-Watcher** | `scripts\Watch-BankExports.ps1` | Überwacht z. B. `Downloads` auf neue Bank-Exporte und schickt sie per HTTP an die App. Wenn die App gerade nicht läuft, legt er die Datei in die Inbox. |
| **Web-Oberfläche** | Drag & Drop unter *Import* | Für den einzelnen Export zwischendurch |

### Watcher einrichten

```powershell
# einmalig testen (läuft im Vordergrund, Strg+C beendet)
.\scripts\Watch-BankExports.ps1 -Folder "$HOME\Downloads"

# dauerhaft: App + Watcher starten bei jeder Anmeldung unsichtbar im Hintergrund
.\scripts\Install-AutoStart.ps1                      # Standard: Downloads-Ordner
.\scripts\Install-AutoStart.ps1 -Folder "D:\Bank"    # anderer Ordner
.\scripts\Install-AutoStart.ps1 -Uninstall           # wieder entfernen
```

Wichtige Parameter von `Watch-BankExports.ps1`:

- `-Pattern`: regulärer Ausdruck für Dateinamen. Der Standard erkennt typische Namen wie `…Umsatzliste…` (DKB),
  `Umsatzanzeige…` (ING), `…umsatz.CSV` (Sparkasse), `n26-csv-transactions…`, `account-statement…` (Revolut)
  und `…Kontoauszug…`. Mit `-Pattern '\.csv$'` wird jede CSV-Datei importiert.
- `-AfterImport Keep|Move|Delete`: was nach dem Import mit der Datei passiert. Standard ist `Move` in den Unterordner `importiert\`.
- `-Once`: einmal prüfen und beenden, z. B. für eine eigene geplante Aufgabe.

Falls PowerShell die Skripte blockiert: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Überlappende Exporte sind kein Problem.** Jede Buchung bekommt einen Fingerabdruck aus Konto, Datum, Betrag,
Gegenpartei und Verwendungszweck, und Duplikate werden übersprungen. Du kannst also z. B. jede Woche „die letzten 90 Tage“
exportieren. Vorgemerkte Buchungen (Status *vorgemerkt/pending*) werden ignoriert und erst übernommen, wenn sie gebucht sind.

## Unterstützte Formate

Spalten, Trennzeichen (`;` `,` Tab), Zeichensatz (UTF-8/Windows-1252), Datums- und Zahlenformat (`1.234,56` / `1,234.56`)
sowie Metadatenzeilen über der Kopfzeile werden automatisch erkannt. Mit Beispieldateien getestet sind
**DKB (Girokonto und Visa-Kreditkarte), ING, Sparkasse (CAMT-CSV), N26, Revolut** und Dateien mit getrennten **Soll/Haben-Spalten**.
PayPal- und Klarna-Zahlungen werden dem eigentlichen Händler zugeordnet („Ihr Einkauf bei Wolt“ → *Wolt*), und der
Kreditkartenausgleich zählt als Umbuchung statt als Einnahme. Volksbank, comdirect,
Commerzbank, Postbank u. a. werden über dieselben Spaltennamen erkannt, sind aber nicht mit echten Exporten getestet.

Wird deine Bank nicht erkannt, lege ein eigenes Profil an: `profiles.example.json` nach `profiles.json` kopieren und
die Spaltennamen deiner Datei eintragen. Verfügbare Felder: `date`, `amount` (oder `debit` + `credit`), `counterparty`
(oder `payee`/`payer`), `purpose`, `booking_text`, `iban`, `currency`, `status`, `account`.

## Kategorien & Regeln

- **Kategorien** sind frei definierbar, mit einer Ebene Unterkategorien, einer Farbe und einem optionalen **Monatsbudget**.
  Jede Oberkategorie hat eine Art:
  - *Ausgabe* oder *Einnahme*
  - *Umbuchung*: zählt weder als Einnahme noch als Ausgabe, z. B. Sparplan, Tagesgeld oder Überweisung aufs eigene Konto
- **Regeln** ordnen Buchungen automatisch zu: *wenn Empfänger/Zweck/Buchungstext/IBAN enthält … (oder Regex), nur Ausgaben,
  Betrag zwischen …, dann Kategorie X*. Die erste passende Regel (nach Priorität) gewinnt. Im Regel-Dialog siehst du live,
  welche Buchungen passen würden.
- **Schnell zuordnen** (oben unter *Umsätze*): Unkategorisierte Buchungen werden nach Empfänger gruppiert, auch
  über Schreibvarianten hinweg („Karl August GmbH“ ≈ „Karl.August.GmbH/Nuernberg“). Eine Auswahl ordnet die ganze
  Gruppe zu und legt dafür eine Regel an, die auch für alle künftigen Importe gilt.
- Überweisungen auf eigene Konten werden am Namen des Kontoinhabers erkannt und zählen als Umbuchung.
- Unter **Umsätze** kannst du jede Buchung von Hand umkategorisieren, auch mehrere auf einmal. Danach bietet die App an,
  daraus direkt eine Regel zu machen. Von Hand gesetzte Kategorien werden von Regeln nie überschrieben.
- Rückerstattungen in einer Ausgabenkategorie (z. B. Amazon-Retoure) verringern die Ausgaben dieser Kategorie.

Beim ersten Start wird ein Satz typischer deutscher Kategorien samt Regeln angelegt (Supermärkte, Tankstellen,
Streaming, Versicherungen …) und für vier Kategorien ein Beispiel-Budget gesetzt. Alles davon kannst du ändern oder löschen.

## Dashboards

Alle Diagramme reagieren auf die gemeinsame Filterzeile (Zeitraum, Konto). Ein Klick auf Balken, Monate oder Tage
springt zu den passenden Umsätzen. Jede Karte hat eine **Tabellenansicht**, außerdem gibt es einen Dunkelmodus
(folgt der Systemeinstellung).

- **Kennzahlen**: Einnahmen, Ausgaben, Überschuss, Sparquote, jeweils mit Verlauf und Vergleich zum gleich langen Vorzeitraum
- **Einnahmen & Ausgaben** pro Monat mit Überschuss-Linie
- **Ausgaben nach Kategorie** mit Anteil und Unterkategorien im Tooltip
- **Geldfluss** (Sankey): Einnahmequellen → verfügbares Geld → Kategorien und Überschuss
- **Kategorien im Zeitverlauf**: gestapelt, die sieben größten Kategorien plus „Übrige“
- **Budgets** mit Warnstufen (ab 85 % und bei Überschreitung)
- **Kontostand-Verlauf**: kumulierte Buchungen. Er beginnt bei 0 mit dem ersten Import und zeigt daher die Entwicklung, nicht den absoluten Kontostand.
- **Top-Empfänger**, **Ausgaben-Kalender** (Heatmap pro Tag) und **größte Einzelausgaben**

![Dunkelmodus](docs/dashboard-dunkel.png)

## Weitere Optionen

```text
python -m finanzen --help
  --port 8765            Port
  --db data\finanzen.db  Datenbankdatei (z. B. in einen verschlüsselten Ordner legen)
  --inbox inbox          überwachter Ordner
  --no-watch             Inbox nicht überwachen
  --import DATEI …       Dateien einmalig importieren und beenden
```

Unter *Import* lassen sich alle Buchungen als CSV für Excel exportieren und einzelne Importe rückgängig machen.
Für eine **Sicherung** genügt es, `data\finanzen.db` zu kopieren.

## Entwicklung

```text
finanzen/
  importer.py   CSV-Erkennung und Parsing (Bankformate, Zahlen, Datumsangaben)
  ingest.py     Import in die DB und Überwachung des Inbox-Ordners
  rules.py      Regel-Engine
  analytics.py  Aggregationen für die Dashboards
  server.py     JSON-API und Auslieferung der Oberfläche
  static/       Web-Oberfläche (HTML/CSS/JS, ECharts)
scripts/        PowerShell-Watcher, Autostart, Demo-Daten
tests/          python -m unittest discover -s tests
```
