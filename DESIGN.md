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

### Aufbau (Stand 6)
1. **Startseite**: alles Wichtige auf einer Seite, von oben nach unten nach Wichtigkeit geordnet; im Zentrum der Finanzen steht der bewegte **Geldfluss**
   – Standardzeitraum ist der **laufende Monat**; ein Monat reicht vom Gehaltseingang bis vor den nächsten (Gehaltsmonat)
2. **Vollbild** (Extra, per ⤢): ein Element bildschirmfüllend, Trend + Vergleich
3. **Tiefe** (Extra): exakte Daten, Tabellen

### Visuelle Regeln (Stand 6, siehe Änderungen am Ende)
- **Ein Akzentton je Farbschema** (Standard „Papier & Bronze“; wählbar Tinte, Graphit, Salbei) plus passende Graustufen; Rot ist reserviert für Abweichung/Handlungsbedarf und kommt immer mit Symbol + Text
- Schrift **Inter** (lokal mitgeliefert), Zahlen mit gleich breiten Ziffern
- Keine Tachos, keine Kreisdiagramme, keine blinkenden oder flackernden Elemente
- Bewegung in allen Teilen, wo sie etwas erzählt (Eintritt, Füllen, Hochzählen, Zoom); abschaltbar
- Zoom-Übergänge räumlich animiert (framer-motion bzw. Motion), federnd, höchstens 450 ms
- Zurück-Navigation per Esc
- Beträge immer auch als Alltagsäquivalent (Tage Budget, Monate Fixkosten)

---

## Umsetzung

### 1. Startseiten und Vollbild

**Finanzen** (Zeitraum über die Filterleiste), Reihenfolge = Wichtigkeit:

1. **Kennzahlen**: Einnahmen, Ausgaben, Überschuss, Sparquote – jeweils mit Soll bzw. Vorzeitraum, Äquivalent und Verlauf
2. **Geldfluss** (Mitte, volle Breite): links Einnahmequellen, Mitte „Verfügbar“, rechts Ausgaben-Kategorien,
   „Sparen & Depot“ und „Übrig“. Klick auf eine Kategorie öffnet ihre **Zusammensetzung** (Kategorie → Unterkategorien → Empfänger)
3. **Kategorien gegen Soll** und **Depot & Sparplan**
4. **Einnahmen & Ausgaben pro Monat**
5. **Details**: größte Ausgaben, Top-Empfänger

**Sparplan** (eine durchgehende Seite): Depot heute → Sparplan-Takt → Was wäre wenn → Ziel → Käufe & Abgleich.

**Vollbild und Tiefe** sind ein Extra: ⤢ an einer Karte oder einem Abschnitt lässt ihn räumlich zum Vollbild wachsen
(Trend + Vergleich, alles andere ausgeblendet, nur Breadcrumb sichtbar), „Exakte Zahlen“ führt weiter in die Tiefe.
Jede Stufe hat eine Adresse (`#dashboard/fokus/ausgaben`, `sparplan.html#tiefe/depot`), Neuladen behält den Kontext.

### 2. Kontext sichtbar halten
- **Breadcrumb** auf jeder Stufe, oben links, zum Beispiel `Finanzen › Übersicht › Ausgaben › Tabelle`. Jedes Glied ist klickbar.
- **Esc** geht genau eine Stufe zurück (Tiefe → Vollbild → Startseite). Ein offener Dialog schließt zuerst sich selbst.
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
- **Farbschema** per Auswahl in der Kopfzeile, unabhängig von Hell/Dunkel (gespeichert pro Browser, `<html data-scheme>`).
  Jedes Schema tauscht nur Papier-, Grau- und Akzent-Tokens aus; die Namen bleiben (`--bronze` = Akzent des Schemas).
  Rot bleibt in allen Schemata den Warnungen vorbehalten.

| Schema | Akzent hell / dunkel | Papier hell / dunkel | Charakter |
|---|---|---|---|
| Papier & Bronze (Standard) | `#8a5a24` / `#d1a067` | `#faf8f4` / `#12100d` | warm, papieren |
| Tinte | `#2f5d8f` / `#7fa9dc` | `#f5f7fa` / `#0e1117` | kühl, sachlich |
| Graphit | `#4b4b52` / `#c9c9cf` | `#f6f6f5` / `#0f0f10` | reine Graustufen |
| Salbei | `#4f7351` / `#8fbf8c` | `#f5f7f3` / `#0f120f` | ruhig, natürlich |

### 6. Verbotene Formen
- Keine **Tachos** und Halbkreis-Anzeigen, keine **Kreis- und Ringdiagramme**, keine Sankey-Diagramme –
  Ausnahme ist der Geldfluss (§8), auf ausdrücklichen Wunsch.
  Anteile werden als Balken mit Soll-Marke gezeigt.
- Nichts **blinkt, flackert oder pulsiert im Takt**; keine Bewegung schneller als ein Zyklus pro 3 Sekunden.
- Keine Zahl ohne Maßstab: Einzelzahlen ohne Soll, Vorzeitraum oder Äquivalent sind nicht erlaubt.

### 7. Bewegung
Bewegung erzählt, sie lenkt nicht ab. Sie steckt in jedem Dashboard-Teil, läuft aber nur einmal ab und kommt dann zur Ruhe.

| Wo | Was sich bewegt | Dauer |
|---|---|---|
| **Startseite** | Karten schweben nacheinander herein; Spuren füllen sich von links, der Soll-Strich erscheint danach; Zahlen zählen hoch; der Geldfluss läuft voll und fließt dann dauerhaft ruhig weiter | 0,7–1,4 s, gestaffelt |
| **Zoom** | Karte/Abschnitt wächst räumlich zum Vollbild, Vollbild zur Tiefe; zurück schrumpft es in den Auslöser | ≤ 450 ms, federnd |
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
- In Schleife laufen nur der Geldfluss (ruhig, gleichmäßig), der Hintergrund und der Farbverlauf der Überschrift.

### 7a. Schrift
- **Inter** (variabel, SIL Open Font License) unter `finanzen/static/vendor/`, Fallback Systemschrift.
- Zahlen mit `tnum` (gleich breite Ziffern), damit hochzählende Werte und Tabellen nicht springen.
- Überschriften 700–780, Laufweite −0,03 em; Fließtext 14,5 px / 1,5.

### 8. Geldfluss – „Fäden münden in einen See“ (`lake-flow.js`)
Entworfen und abgestimmt im Claude-Design-Canvas (Variante „Final“).
- **See in der Mitte** mit dem verfügbaren Betrag: organisch, etwas runder als ein Ei, weich gezeichnetes Ufer, das
  sehr langsam „atmet“ (13–17 s je Zyklus). Hell: tief in der Mitte, flach am Rand; dunkel umgekehrt.
- **Flüsse** aus der Vogelperspektive, ruhig geschwungen: links die Einnahmen, rechts Ausgaben, Sparen und Übrig.
  Breite wächst mit dem Betrag (gestaucht, damit kleine Posten sichtbar bleiben).
- Jeder Fluss ist ein **Bündel feiner Fäden** (0,4 px), auf denen ruhig Lichtstriche fließen; die Mitte fließt
  schneller als der Rand. Zuflüsse entspringen schmal.
- **Mündung**: Die Fäden laufen über ~100 px weich aus und sind am Ufer kaum noch zu sehen; das Seewasser greift als
  flacher Trichter in jeden Fluss hinein. Keine harte Kante, kein Faden ragt in den See.
- **Keine Überschneidungen**: Jeder Fluss bekommt einen eigenen Ufer-Abschnitt; der oberste Zufluss mündet oben,
  der oberste Abfluss verlässt den See oben.
- **Zwei Seiten, zwei Farben** (Stand 8): Zuflüsse in der Einnahmenfarbe, Abflüsse in der Ausgabenfarbe. Farbpaar
  wählbar im Geldfluss: Blau/Rot (Standard), Petrol/Koralle, Salbei/Terrakotta – je hell und dunkel. *Steuerbare*
  Kategorien (Standard Freizeit, Shopping; änderbar im Monatsplan) im tiefen, vollen Ton, übrige Ausgaben blasser.
  „Sparen & Depot“ in der Einnahmenfarbe mit dunklerem Ton, „Übrig“ grau.
- **Der See zeigt rein, raus und die Differenz** und färbt sich nach dem **erwarteten Ergebnis zum Ende des
  Zeitraums** (inkl. Übertrag, wenn eingeschaltet): jetziger Stand minus noch offene Fixkosten, übrige Budgets im
  Plan-Tempo für die restlichen Tage und noch nicht ausgeführte Sparplan-Raten. Deutlich im Plus = Einnahmenfarbe;
  je näher an null, desto mehr nähert sich die Mitte der Ausgabenfarbe; im Minus klar Ausgabenfarbe (volle Stärke bei
  15 % des Einkommens). Die überwiegende Seite nimmt mehr vom See ein. Der Abstand zum anteiligen Plan steht als Text.
- **Tropfen-Physik** (Stand 10): Das Ufer schwingt wie ein Wassertropfen – als Summe von Schwingungsmoden 2–12
  (Frequenz nach Rayleigh, Dämpfung nach Lamb; Grundschwingung 2,2 s). Alle Stöße sind **sehr leicht** (höchstens
  8 px Auslenkung); das Volumen bleibt gleich, der See bleibt am Platz. Gestört wird er nur durch die **Maus** (am Ufer
  quer schieben; Klick in den See = Tropfen) und **neue Buchungen** seit dem letzten Blick (Bank-Sync, Import): Sie
  stoßen das Ufer an der Mündung ihres Flusses an – Zufluss nach außen, Abfluss nach innen, stärker je größer der
  Betrag – und der Fluss leuchtet kurz auf. Sonst langsames Atmen und alle paar Sekunden ein kaum sichtbarer Hauch.
- **Feine Uferlinie**: eine scharfe, blasse Linie (0,6 px) am Ufer reagiert auf jeden einzelnen Faden – wo er ankommt,
  wölbt sie sich um ~0,5 px, im eigenen Takt des Fadens. Ohne Hineinzoomen kaum zu sehen. Kein Glanzlicht.
  Bei „Bewegung aus“ bzw. reduzierter Bewegung steht der See still.
- **Rücklagen (Übertrag)** schaltbar: Was im Vergleichszeitraum nach Ausgaben und Sparen übrig blieb, fließt als
  blauer Strom zu („Übertrag aus August“); ein Minus fließt als roter Strom ab („Ausgleich Minus aus August“) – immer
  blau/rot, unabhängig vom Farbpaar. Ohne vollständige Daten im Vergleichszeitraum kein Übertrag (mit Hinweis).
- **Warnung** (rot, ⚠ mit Betrag) nur, wenn eine Kategorie über ihrem anteiligen Plan liegt **und** mindestens 100 €
  ausmacht; kleinere Posten werden nie rot.
- Überfahren hebt den Fluss hervor und zeigt Betrag, Äquivalent und Plan. Klick: Kategorie → Unterdashboard,
  Einnahme → Umsätze, Sparen → Sparplan. Mit „Bewegung aus“ stehen Fäden und Ufer still.
- **Unterdashboard einer Kategorie** (`Flow.branch`, ohne See): dieselben feinen Fäden von der Kategorie zu ihren
  Unterkategorien; gestrichelt die Breite im Vergleichszeitraum, dazu Differenz je Unterkategorie (mehr = Ausgaben-,
  weniger = Einnahmenfarbe), Tabelle und Kategorie-Wechsel per Chips.
- **Vergleichszeitraum**: Gehaltsmonat → Vormonat; laufendes Jahr → gleicher Zeitraum im Vorjahr (01.01. bis heute);
  sonst der gleich lange Zeitraum davor.

### 8a. Metaphern in Karten
Kleine Metaphern bleiben dort, wo sie schneller sind als eine Zahl: **Spur mit Soll-Strich** (Kategorien, Depot),
**Monatsperlen** (Sparplan-Takt), **Weg zur Fahne** (Ziel).

### 9. Checkliste für jede neue Ansicht
- [ ] Steht das Element auf der Startseite an der Stelle, die seiner Wichtigkeit entspricht? Vollbild per ⤢ vorhanden, wo es hilft?
- [ ] Breadcrumb sichtbar, Esc geht eine Stufe zurück, URL enthält die Stufe
- [ ] Jede Zahl hat Soll oder Vergleich **und** ein Alltagsäquivalent
- [ ] Akzent des Farbschemas und warme Graustufen (im Geldfluss das Farbpaar); Rot-Warnung nur für Handlungsbedarf, immer mit Symbol + Text
- [ ] Kein Tacho, kein Kreis, nichts blinkt oder flackert
- [ ] Eintritt/Übergang vorhanden, räumlich, ≤ 450 ms beim Zoom; Bewegungs-Schalter und reduzierte Bewegung respektiert
- [ ] Hell- und Dunkelmodus geprüft, Handybreite ohne horizontales Scrollen

---

## Änderungen

- **Stand 10** (nach Simulation 2/3): Wabbeln sehr leicht, kein Glanzlicht, feine Uferlinie reagiert auf die Fäden.
- **Stand 9** (nach Simulation, auf Wunsch): Der See hat die Physik eines Wassertropfens; Maus und neue Buchungen
  bringen ihn dort zum Wabbeln, wo sie ihn treffen (§8).
- **Stand 8** (nach Entwurf, abgenommen): Geldfluss mit Einnahmen-/Ausgabenfarbe (Farbpaar wählbar), See gefärbt
  nach dem erwarteten Ergebnis zum Ende (inkl. Übertrag), Rücklagen-Schalter (Übertrag aus dem Vergleichszeitraum), steuerbare Kategorien im tiefen
  Ton, Warnungen erst ab 100 €, Unterdashboard je Kategorie mit Vergleich, Jahresvergleich mit gleichem Zeitraum im
  Vorjahr. Monatsplan: ein Sparziel, Budgets passen sich im Verhältnis an (§8).
- **Stand 7** (auf Wunsch): Startseite zeigt den laufenden Monat statt 12 Monate. Monate sind Gehaltsmonate
  (vom Gehalt bis vor das nächste Gehalt). Neu: Zuordnen-Panel für Buchungen ohne Kategorie und unsichere Zuordnungen.
- **Stand 6** (nach Auswahl im Claude-Design-Canvas): Der Geldfluss ist ein See, in den Flüsse aus feinen Fäden
  münden (§8). Farbschema wählbar: Papier & Bronze (Standard), Tinte, Graphit, Salbei – je hell und dunkel (§5).
- **Stand 5** (auf Wunsch): Zurück zu klassischen Startseiten, auf denen alles direkt zugänglich ist; im Zentrum der
  Finanzen ein dauerhaft fließender Geldfluss mit Zusammensetzung je Kategorie. Filterleiste für den Zeitraum ist zurück.
  Der Sparplan ist wieder eine durchgehende Seite. Vollbild und Tiefe bleiben als Extra (⤢, Esc).
- **Stand 4** (nach Auswahl aus fünf Vorschlägen): ein einziger Farbton „Papier & Bronze“ statt vier Elementfarben,
  Rot nur für Warnungen, Positives im Bronzeton. Umschalter Hell/Dunkel/System. Bewegung und Schrift wie Stand 3.
- **Stand 3** (auf Wunsch): Das animierte Metapher-Bild ist wieder entfernt, der Blick besteht aus vier Kacheln.
  Neu: Schrift Inter, stimmigere Palette gleicher Sättigung, Bewegung in allen Dashboard-Teilen (§7).
- **Stand 2** (auf Wunsch): Statt „Graustufen default, Farbe nur für Abweichung“ gilt „Identitätsfarbe je Element,
  Rot/Grün nur für Bewertung“. Ruhige Umgebungsbewegung ist erlaubt (abschaltbar), Zoom-Übergänge dürfen federn
  (≤ 450 ms statt ≤ 300 ms). Der Blick ist zusätzlich ein animiertes Metapher-Bild. Unverändert: drei Zoomstufen,
  Breadcrumb, Esc, Soll/Ist, Alltagsäquivalente, keine Tachos/Kreise/Blinker.
- **Stand 1**: Erstfassung.
