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

### Visuelle Regeln (Stand 2, siehe Änderungen am Ende)
- Farbenfroh: jedes Element hat eine eigene Identitätsfarbe; Rot und Grün sind reserviert für Abweichung/Handlungsbedarf und kommen immer mit Symbol + Text
- Blick als **animiertes Metapher-Bild** (Kacheln als gleichwertige Alternative)
- Keine Tachos, keine Kreisdiagramme, keine blinkenden oder flackernden Elemente
- Ruhige, fließende Bewegung ist erwünscht; sie lässt sich jederzeit ausschalten
- Zoom-Übergänge räumlich animiert (framer-motion bzw. Motion), federnd, höchstens 450 ms
- Zurück-Navigation per Esc
- Beträge immer auch als Alltagsäquivalent (Tage Budget, Monate Fixkosten)

---

## Umsetzung

### 1. Zoomstufen

| Stufe | Inhalt | Regeln |
|---|---|---|
| **Blick** | ein Bild mit genau 4 Elementen (oder 4 Kacheln), jedes mit Metapher, Ist, Soll, Alltagsäquivalent und einem Satz Urteil („120 € unter Plan“) | Keine Achsen, keine Legenden, keine Tabellen. Eine Kachel muss in 5 Sekunden verstanden sein: *Wo stehe ich, gemessen woran, muss ich etwas tun?* |
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

### 5. Farbe
**Farbe trägt Identität, Rot und Grün tragen Bewertung.** Jedes Element behält seine Farbe auf allen drei Stufen:
im Bild, in der Kachel, im Fokus-Diagramm und in der Tabelle (Akzentstreifen). So erkennt man beim Zoomen sofort,
wo man ist.

| Token | Hell | Dunkel | Element |
|---|---|---|---|
| `--c-violet` | `#7c5cff` | `#a08bff` | Ausgaben · Ziel |
| `--c-teal` | `#0ea5a0` | `#2dd4bf` | Sparquote · Was wäre wenn |
| `--c-sky` | `#2f8ff0` | `#60a5fa` | Kategorien · Sparplan-Takt |
| `--c-gold` | `#eb9b0c` | `#fbbf24` | Depot |
| `--signal-bad` | `#dc3545` | `#ff6369` | **nur** negative Abweichung / Handlungsbedarf, immer mit ⚠ und Text |
| `--signal-good` | `#18794e` | `#3dd68c` | **nur** positive Aussage (Ziel erreicht, Soll erfüllt), immer mit ✓ und Text |
| `--ink-1` … `--ink-4` | Graustufen | | Vergleichslinien, Soll-Linien, Einzahlungen, Achsen |

- Im Diagramm ist die **Hauptreihe** in der Elementfarbe (Linie + Verlaufsfläche), **Vergleiche** sind grau,
  das **Soll** ist eine gestrichelte dunkle Linie, **Abweichungen** sind rot.
- Keine Identitätsfarbe ist rot oder grün, damit Bewertung und Identität nie verwechselt werden.
- Mehr als vier Reihen in einem Diagramm (z. B. ETF-Baukasten): Abstufungen der Elementfarbe plus direkte Beschriftung.
- Hintergrund: sanfter Farbverlauf aus den Identitätsfarben, sehr hell (hell) bzw. sehr dunkel (dunkel), Text bleibt
  auf ruhigen Flächen.

### 6. Verbotene Formen
- Keine **Tachos** und Halbkreis-Anzeigen, keine **Kreis- und Ringdiagramme**, keine Sankey-Diagramme.
  Anteile werden als Balken mit Soll-Marke gezeigt.
- Nichts **blinkt, flackert oder pulsiert im Takt**; keine Bewegung schneller als ein Zyklus pro 3 Sekunden.
- Keine Zahl ohne Maßstab: Einzelzahlen ohne Soll, Vorzeitraum oder Äquivalent sind nicht erlaubt.

### 7. Bewegung
Bewegung erzählt, sie lenkt nicht ab.

| Art | Beispiel | Regel |
|---|---|---|
| **Eintritt** | Kacheln schweben nacheinander herein, Wasser steigt auf seinen Stand, Pflanze wächst, Zahlen zählen hoch | einmalig beim Laden, 500–1200 ms, gestaffelt |
| **Zoom** | Kachel/Bildelement wächst zum Fokus, schrumpft beim Zurückgehen | räumlich (FLIP), federnd, ≤ 450 ms |
| **Umgebung** | Wellen im Tank, Wolken ziehen, Boot schaukelt, Hintergrund fließt | langsam (≥ 3 s pro Zyklus), kleine Amplitude, bedeutungsvoll: sie zeigt, dass die Daten „leben“ |
| **Rückmeldung** | Kachel hebt sich beim Überfahren, Regler ziehen Diagramme mit | ≤ 250 ms |

- Umsetzung mit **Motion** (`motion`, die Vanilla-JavaScript-Ausgabe von framer-motion vom selben Hersteller),
  lokal unter `finanzen/static/vendor/motion.js`, für Umgebung CSS-Keyframes. Kommt später React dazu, wird
  `framer-motion` mit `layoutId` verwendet.
- Schalter **„Bewegung“** in der Kopfzeile schaltet Umgebung und Eintritt ab (gespeichert pro Browser).
  `prefers-reduced-motion` schaltet sie ebenfalls ab. Zoom-Übergänge werden dann sofort ausgeführt.

### 8. Blick-Metaphern
Der Blick ist ein **Bild**: eine kleine Landschaft mit genau vier Elementen. Jedes Element ist anklickbar und
wächst zu seinem Fokus. Die Maße im Bild sind echte Daten, keine Dekoration.

**Finanzen – „Landschaft“**

| Element | Metapher | Daten | Abweichung |
|---|---|---|---|
| Ausgaben | **Wassertank**: Wasserstand = Monatsbudget, das noch übrig ist; Markierung = so viel sollte heute noch übrig sein | Monats-Soll − Ausgaben | Wasser unter der Markierung → rot, ⚠ |
| Sparquote | **Pflanze**: Höhe = Sparquote, Fähnchen = Soll | Überschuss / Einnahmen | unter Soll → welk, ⚠ |
| Kategorien | **Wetter**: Sonne = alles im Rahmen, je Kategorie über Soll eine Regenwolke mit Namen und Betrag | Ist vs. Soll bis heute | Wolken |
| Depot | **Boot auf der Wasserlinie**: Wasserlinie = Einzahlungen, Höhe über Wasser = Gewinn | Depotwert vs. Einzahlungen | Boot sinkt unter die Linie, ⚠ |

**Sparplan – „Bergtour“**

| Element | Metapher | Daten | Abweichung |
|---|---|---|---|
| Depot | **Heißluftballon** über einem See, Wasserlinie = Einzahlungen | Depotwert vs. Einzahlungen | Ballon im Wasser, ⚠ |
| Sparplan-Takt | **Trittsteine** über den Fluss, ein Stein pro Monat | erfasste Käufe | fehlender Stein, ⚠ |
| Ziel | **Berg**: Der Grat ist der mittlere Verlauf der Projektion, der Nebel die Bandbreite, die Fahne das Ziel | Projektion bis zum Zieljahr | Grat endet unter der Fahne, ⚠ |
| Was wäre wenn | **Wegweiser** mit drei Schildern (Vorsichtig/Historisch/Rückenwind), Länge = Endwert | Szenarien | nie |

Die Kacheln zeigen dieselben vier Elemente mit Urteil, Soll, Ist und Äquivalent und bleiben als Umschalter „Kacheln“
verfügbar.

### 9. Checkliste für jede neue Ansicht
- [ ] Welche Zoomstufe ist das? Hält sie deren Regeln ein (max. 4 / bildschirmfüllend / Tabelle)?
- [ ] Breadcrumb sichtbar, Esc geht eine Stufe zurück, URL enthält die Stufe
- [ ] Jede Zahl hat Soll oder Vergleich **und** ein Alltagsäquivalent
- [ ] Elementfarbe konsequent auf allen Stufen; Rot/Grün nur für Bewertung, immer mit Symbol + Text
- [ ] Kein Tacho, kein Kreis, nichts blinkt oder flackert
- [ ] Übergang räumlich, federnd, ≤ 450 ms; Bewegungs-Schalter und reduzierte Bewegung respektiert
- [ ] Hell- und Dunkelmodus geprüft, Handybreite ohne horizontales Scrollen

---

## Änderungen

- **Stand 2** (auf Wunsch): Statt „Graustufen default, Farbe nur für Abweichung“ gilt „Identitätsfarbe je Element,
  Rot/Grün nur für Bewertung“. Ruhige Umgebungsbewegung ist erlaubt (abschaltbar), Zoom-Übergänge dürfen federn
  (≤ 450 ms statt ≤ 300 ms). Der Blick ist zusätzlich ein animiertes Metapher-Bild. Unverändert: drei Zoomstufen,
  Breadcrumb, Esc, Soll/Ist, Alltagsäquivalente, keine Tachos/Kreise/Blinker.
- **Stand 1**: Erstfassung.
