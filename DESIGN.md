# DESIGN.md – Gestaltungsregeln

Dieses Dokument ist **verbindlich** für jede Oberfläche in diesem Repo (Finanz-Dashboard, Sparplan und alles, was
dazukommt). Neue Ansichten und Änderungen werden gegen die Checkliste am Ende geprüft. Weicht etwas ab, wird die
Oberfläche angepasst, nicht die Regel.

---

## Design-Prinzipien (verbindlich)

### Nutzerprofil
- Kann Kontext schlecht im Kopf halten → Navigation muss Kontext sichtbar halten (Breadcrumb, räumlicher Zoom)
- Arbeitet im Hyperfokus → Fokusmodus blendet alles außer dem gewählten Element aus
- Braucht klare Soll/Ist-Maßstäbe, keine nackten Zahlen

### Drei Zoomstufen
1. Blick: Metapher, max. 4 Elemente, 5-Sekunden-Test
2. Fokus: ein Element bildschirmfüllend, Trend + Vergleich
3. Tiefe: exakte Daten, Tabellen

### Visuelle Regeln (Stand 4, siehe Änderungen am Ende)
- **Ein Farbton** („Papier & Bronze“) plus warme Graustufen; Rot ist reserviert für Abweichung/Handlungsbedarf und kommt immer mit Symbol + Text
- Schrift **Inter** (lokal mitgeliefert), Zahlen mit gleich breiten Ziffern
- Keine Tachos, keine Kreisdiagramme, keine blinkenden oder flackernden Elemente
- Bewegung in allen Teilen, wo sie etwas erzählt (Eintritt, Füllen, Hochzählen, Zoom); abschaltbar
- Zoom-Übergänge räumlich animiert (framer-motion bzw. Motion), federnd, höchstens 450 ms
- Zurück-Navigation per Esc
- Beträge immer auch als Alltagsäquivalent (Tage Budget, Monate Fixkosten)

---

## Umsetzung

### 1. Zoomstufen

| Stufe | Inhalt | Regeln |
|---|---|---|
| **Blick** | genau 4 Kacheln, jede mit Metapher, Ist, Soll, Alltagsäquivalent und einem Satz Urteil („120 € unter Plan“) | Keine Achsen, keine Legenden, keine Tabellen. Eine Kachel muss in 5 Sekunden verstanden sein: *Wo stehe ich, gemessen woran, muss ich etwas tun?* |
| **Fokus** | genau ein Element, bildschirmfüllend | Immer **Trend** (Verlauf über Zeit) **und Vergleich** (Soll, Vorzeitraum oder Durchschnitt). Alles andere ist ausgeblendet, auch Kopfzeile und Reiter. Sichtbar bleibt nur der Breadcrumb. |
| **Tiefe** | exakte Zahlen des Elements als Tabelle, dazu die Einstellungen der Maßstäbe | Cent-genau, sortierbar lesbar, keine Deko. Werkzeuge (Umsätze, Kategorien, Import, Käufe) gehören auf diese Stufe. |

- Die Kachel im Blick **wird** beim Zoomen zum Fokus: Der Fokus wächst räumlich aus der Kachel heraus und schrumpft
  beim Zurückgehen wieder in sie hinein. Dasselbe gilt für Fokus → Tiefe.
- Jede Stufe ist über die URL erreichbar (`#blick`, `#fokus/ausgaben`, `#tiefe/ausgaben`), damit Neuladen den Kontext behält.

### 2. Kontext sichtbar halten
- **Breadcrumb** auf jeder Stufe, oben links, zum Beispiel `Finanzen › Übersicht › Ausgaben › Tabelle`. Jedes Glied ist klickbar.
- **Esc** geht genau eine Stufe zurück (Tiefe → Fokus → Blick). Ein offener Dialog schließt zuerst sich selbst.
- Neben dem Breadcrumb steht, worauf sich die Zahlen beziehen („Stand 26.09.2026 · September“).
- Im Fokus stehen die Soll-Werte im Diagramm selbst (Linie oder Marke), nicht in einer Legende daneben.

### 3. Soll/Ist statt nackter Zahlen
Jede Zahl erscheint zusammen mit ihrem Maßstab. Die Maßstäbe:

| Größe | Ist | Soll (Standard, in der Tiefe änderbar) |
|---|---|---|
| Ausgaben Monat | bisher ausgegeben | Monats-Soll anteilig zum Monatsfortschritt. Monats-Soll = eigener Wert, sonst Ø der letzten 6 vollen Monate |
| Sparquote | Überschuss / Einnahmen, letzte 12 Monate | 20 % |
| Kategorie | Ausgaben im Monat | Monatsbudget, sonst Ø der letzten 6 vollen Monate |
| Depot | aktueller Wert | Summe der Einzahlungen |
| Sparplan-Takt | erfasste Käufe | eine Rate pro Monat seit Start, Abgleich mit Kontoauszug |
| Ziel | Median der Projektion im Zieljahr | Zielbetrag (Standard 100.000 € in 20 Jahren) |

### 4. Alltagsäquivalente
Jeder Betrag bekommt ein Äquivalent, das man fühlen kann:

- **Tage Budget** = Betrag ÷ (Monats-Soll der Ausgaben ÷ 30,4). Für Beträge unter einer Monatsmiete Fixkosten.
- **Monate Fixkosten** = Betrag ÷ Fixkosten pro Monat. Ab einem Monat Fixkosten, ab 24 Monaten in Jahren.
- Fixkosten = Ø der letzten 6 vollen Monate in Kategorien mit Merkmal *Fixkosten* (Standard: Wohnen, Versicherungen,
  Abos & Streaming, Kredite & Raten). Beides lässt sich in der Tiefe fest eintragen.
- Schreibweise: `1.192 € · ≈ 1,4 Monate Fixkosten`. Äquivalente immer mit „≈“, auf eine Nachkommastelle.
- Fehlen Umsätze und eigene Werte, steht an der Stelle ein Hinweis, wie man sie bekommt, und nie ein leerer Platz.

### 5. Farbe – „Papier & Bronze“
**Ein einziger Farbton.** Bronze trägt alles, was zur App gehört (Hauptlinie, Balken, aktiver Reiter, Knopf,
Überschriften-Akzent). Alles andere ist warmes Grau. Rot ist die einzige zweite Farbe und bedeutet immer
Handlungsbedarf.

| Token | Hell | Dunkel | Verwendung |
|---|---|---|---|
| `--page` | `#faf8f4` | `#12100d` | Seitenhintergrund (Papier) |
| `--surface-1` | `#fffdf9` | `#1a1714` | Karten, Kacheln |
| `--bronze` | `#8a5a24` | `#d1a067` | Hauptreihe, Balken, Knopf, Spuren |
| `--bronze-ink` | `#71481a` | `#e3bd8e` | Text im Farbton, positive Aussagen mit ✓ |
| `--bronze-soft` | `#f4ebdd` | `#3a2c1c` | Flächen im Farbton (aktiver Reiter, Symbolhintergrund) |
| `--ink-1` … `--ink-4` | warme Graustufen | | Soll-Linie (`ink-1`, gestrichelt), Vergleich (`ink-2`/`ink-3`), Raster (`ink-4`) |
| `--signal-bad` | `#c8323a` | `#ff6b70` | **nur** negative Abweichung, immer mit ⚠ und Text |

- Im Diagramm: **Hauptreihe** in Bronze (Linie + Verlaufsfläche bzw. Balken), **Vergleiche** grau, **Soll** gestrichelt
  in `ink-1`, **Abweichungen** rot.
- Mehrere Reihen (z. B. ETF-Baukasten): Helligkeitsstufen von Bronze plus direkte Beschriftung, keine zweite Farbe.
- Positive Aussagen („Ziel erreicht“) erscheinen in `--bronze-ink` mit ✓, nicht in Grün.
- Darstellung **Hell / Dunkel / System** per Umschalter in der Kopfzeile (gespeichert pro Browser).

### 6. Verbotene Formen
- Keine **Tachos** und Halbkreis-Anzeigen, keine **Kreis- und Ringdiagramme**, keine Sankey-Diagramme.
  Anteile werden als Balken mit Soll-Marke gezeigt.
- Nichts **blinkt, flackert oder pulsiert im Takt**; keine Bewegung schneller als ein Zyklus pro 3 Sekunden.
- Keine Zahl ohne Maßstab: Einzelzahlen ohne Soll, Vorzeitraum oder Äquivalent sind nicht erlaubt.

### 7. Bewegung
Bewegung erzählt, sie lenkt nicht ab. Sie steckt in jedem Dashboard-Teil, läuft aber nur einmal ab und kommt dann zur Ruhe.

| Wo | Was sich bewegt | Dauer |
|---|---|---|
| **Blick** | Kacheln schweben nacheinander herein; Metapher-Spuren füllen sich von links, der Soll-Strich erscheint danach; Zahlen zählen hoch; Kachel hebt sich beim Überfahren | 0,7–1,2 s, gestaffelt 80 ms |
| **Zoom** | Kachel wächst räumlich zum Fokus, Fokus zur Tiefe; zurück schrumpft es in den Auslöser | ≤ 450 ms, federnd |
| **Fokus** | Karten und Vergleichszeilen schweben herein; Überschrift und Werte zählen hoch; Balken wachsen nacheinander, Linien zeichnen sich; bei Reglern gleiten Diagramme in den neuen Zustand | 0,35–0,9 s |
| **Tiefe** | Tabellenzeilen erscheinen nacheinander | 22 ms je Zeile |
| **Sparplan** | Monatsperlen und Meilensteine ploppen gestaffelt auf, neue ETF-Karten schweben herein, Ergebniszahlen laufen beim Ziehen mit, der Kurs-Chip leuchtet bei einem neuen Kurs einmal sanft auf | 0,5–0,9 s |
| **Navigation** | Markierung gleitet unter den aktiven Reiter und folgt dem Mauszeiger; Breadcrumb-Glied gleitet herein; Dialoge und Toasts federn herein | 0,3–0,45 s |
| **Hintergrund** | sehr langsamer Farbverlauf | 40 s pro Zyklus |

- Umsetzung mit **Motion** (`motion`, die Vanilla-JavaScript-Ausgabe von framer-motion vom selben Hersteller),
  lokal unter `finanzen/static/vendor/motion.js`, ergänzt um CSS-Keyframes und die Animationen von ECharts.
  Kommt später React dazu, wird `framer-motion` mit `layoutId` verwendet.
- Schalter **„Bewegung“** in der Kopfzeile schaltet alles außer den Zoom-Übergängen ab (gespeichert pro Browser).
  `prefers-reduced-motion` schaltet ebenfalls ab; Zoom-Übergänge laufen dann sofort.
- Nichts läuft in Schleife außer dem Hintergrund und dem Farbverlauf der Überschrift (≥ 9 s pro Zyklus).

### 7a. Schrift
- **Inter** (variabel, SIL Open Font License) unter `finanzen/static/vendor/`, Fallback Systemschrift.
- Zahlen mit `tnum` (gleich breite Ziffern), damit hochzählende Werte und Tabellen nicht springen.
- Überschriften 700–780, Laufweite −0,03 em; Fließtext 14,5 px / 1,5.

### 8. Blick-Metaphern
Eine kleine Metapher pro Kachel, in Bronze, mit genau einer Soll-Marke:

| Kachel | Metapher | Rot, wenn … |
|---|---|---|
| Ausgaben | **Monatsweg**: Balken = ausgegeben, Strich = wo du heute laut Soll stehen dürftest | ausgegeben > Soll bis heute |
| Sparquote | **Polster**: Füllung bis zur Soll-Linie | Quote < Soll |
| Kategorien | **Ausreißer**: bis zu 3 Balken relativ zu ihrem Soll (100-%-Strich) | eine Kategorie > Soll |
| Depot | **Wasserlinie**: Wert gegen die Einzahlungslinie | Wert < Einzahlungen |
| Sparplan-Takt | **Monatsperlen**: eine Perle pro Monat, gefüllt = Kauf erfasst | Kauf fehlt / Abgleich passt nicht |
| Ziel | **Weg zur Fahne**: mittlerer Verlauf im Zieljahr gegen den Zielbetrag | Median verfehlt das Ziel |
| Was wäre wenn | **Stellschrauben**: die drei wichtigsten Annahmen als Chips | nie |

### 9. Checkliste für jede neue Ansicht
- [ ] Welche Zoomstufe ist das? Hält sie deren Regeln ein (max. 4 / bildschirmfüllend / Tabelle)?
- [ ] Breadcrumb sichtbar, Esc geht eine Stufe zurück, URL enthält die Stufe
- [ ] Jede Zahl hat Soll oder Vergleich **und** ein Alltagsäquivalent
- [ ] Nur Bronze und warme Graustufen; Rot nur für Handlungsbedarf, immer mit Symbol + Text
- [ ] Kein Tacho, kein Kreis, nichts blinkt oder flackert
- [ ] Eintritt/Übergang vorhanden, räumlich, ≤ 450 ms beim Zoom; Bewegungs-Schalter und reduzierte Bewegung respektiert
- [ ] Hell- und Dunkelmodus geprüft, Handybreite ohne horizontales Scrollen

---

## Änderungen

- **Stand 4** (nach Auswahl aus fünf Vorschlägen): ein einziger Farbton „Papier & Bronze“ statt vier Elementfarben,
  Rot nur für Warnungen, Positives im Bronzeton. Umschalter Hell/Dunkel/System. Bewegung und Schrift wie Stand 3.
- **Stand 3** (auf Wunsch): Das animierte Metapher-Bild ist wieder entfernt, der Blick besteht aus vier Kacheln.
  Neu: Schrift Inter, stimmigere Palette gleicher Sättigung, Bewegung in allen Dashboard-Teilen (§7).
- **Stand 2** (auf Wunsch): Statt „Graustufen default, Farbe nur für Abweichung“ gilt „Identitätsfarbe je Element,
  Rot/Grün nur für Bewertung“. Ruhige Umgebungsbewegung ist erlaubt (abschaltbar), Zoom-Übergänge dürfen federn
  (≤ 450 ms statt ≤ 300 ms). Der Blick ist zusätzlich ein animiertes Metapher-Bild. Unverändert: drei Zoomstufen,
  Breadcrumb, Esc, Soll/Ist, Alltagsäquivalente, keine Tachos/Kreise/Blinker.
- **Stand 1**: Erstfassung.
