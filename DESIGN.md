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

### Visuelle Regeln
- Graustufen default, Farbe NUR für Abweichung/Handlungsbedarf
- Keine Tachos, keine Kreisdiagramme, keine blinkenden Elemente
- Zoom-Übergänge räumlich animiert (framer-motion), max. 300 ms
- Zurück-Navigation per Esc
- Beträge immer auch als Alltagsäquivalent (Tage Budget, Monate Fixkosten)

---

## Umsetzung

### 1. Zoomstufen

| Stufe | Inhalt | Regeln |
|---|---|---|
| **Blick** | höchstens 4 Kacheln, jede mit Metapher, Ist, Soll, Alltagsäquivalent und einem Satz Urteil („120 € unter Plan“) | Keine Achsen, keine Legenden, keine Tabellen. Eine Kachel muss in 5 Sekunden verstanden sein: *Wo stehe ich, gemessen woran, muss ich etwas tun?* |
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
**Graustufen sind der Normalfall.** Farbe trägt ausschließlich eine Botschaft: *hier weicht etwas ab*.

| Token | Hell | Dunkel | Verwendung |
|---|---|---|---|
| `--ink-1` | `#1f1f1d` | `#f2f2ef` | Hauptlinie, Ist-Wert, Primärschaltfläche |
| `--ink-2` | `#6b6a65` | `#a9a8a0` | Vergleichslinie, Beschriftung |
| `--ink-3` | `#b9b8b1` | `#55544f` | Soll-Linie (gestrichelt), Einzahlungen, Nebenbalken |
| `--ink-4` | `#e4e3dd` | `#2e2e2b` | Flächen, Bänder, Spuren von Balken |
| `--signal-bad` | `#c2410c` | `#f0703a` | **Handlungsbedarf / negative Abweichung** (über Soll, unter Ziel, fehlender Kauf) |
| `--signal-good` | `#2e7d4f` | `#4fbf7f` | positive Abweichung, nur dort, wo sie eine Aussage trägt (Ziel erreicht) |

- Keine Kategorie- oder Seriefarben. Mehrere Reihen unterscheiden sich über Helligkeit (`ink-1` bis `ink-4`),
  Strichart und **direkte Beschriftung**.
- Signalfarbe nie allein: immer zusammen mit Symbol (▲ ▼ ⚠ ✓) und Text („80 € über Soll“).
- Innerhalb einer Ansicht höchstens ein oder zwei farbige Stellen. Ist alles rot, ist nichts wichtig. Dann zeigt der
  Blick nur die größte Abweichung farbig.
- Schaltflächen und Links sind grau bzw. schwarz. Blau als „Akzent“ gibt es nicht.

### 6. Verbotene Formen
- Keine **Tachos** und Halbkreis-Anzeigen, keine **Kreis- und Ringdiagramme**, keine Sankey-Diagramme.
  Anteile werden als Balken mit Soll-Marke gezeigt.
- Keine **blinkenden oder pulsierenden** Elemente, keine Endlos-Animationen, kein Lauftext.
- Keine Zahl ohne Maßstab: Einzelzahlen ohne Soll, Vorzeitraum oder Äquivalent sind nicht erlaubt.

### 7. Bewegung
- Zoom-Übergänge sind **räumlich**: Das Ziel wächst aus dem Rechteck des Auslösers (FLIP-Prinzip), der Rückweg
  schrumpft dorthin zurück.
- Umsetzung mit **Motion** (`motion`, die Vanilla-JavaScript-Ausgabe von framer-motion vom selben Hersteller,
  gleiche API-Idee `animate()`), lokal unter `finanzen/static/vendor/motion.js`. Die App hat bewusst kein React
  und keine Build-Tools. Kommt später React dazu, wird `framer-motion` mit `layoutId` verwendet.
- Dauer **höchstens 300 ms** (Standard 260 ms), Kurve `easeOut` `[0.2, 0, 0, 1]`.
- `prefers-reduced-motion`: Übergänge sofort ohne Animation.
- Zahlen dürfen beim Ändern von Reglern kurz (≤ 300 ms) auf den neuen Wert laufen, sonst bewegt sich nichts von selbst.

### 8. Blick-Metaphern
Eine Metapher pro Kachel, grau, mit genau einer Soll-Marke:

| Kachel | Metapher | Farbig, wenn … |
|---|---|---|
| Ausgaben | **Monatsweg**: Balken = ausgegeben, Strich = wo du heute laut Soll stehen dürftest | ausgegeben > Soll bis heute |
| Sparquote | **Polster**: Füllhöhe bis zur Soll-Linie | Quote < Soll |
| Kategorien | **Ausreißer**: bis zu 4 Balken relativ zu ihrem Soll (100 %-Linie) | eine Kategorie > Soll |
| Depot | **Wasserlinie**: Wert über oder unter der Einzahlungslinie | Wert < Einzahlungen |
| Sparplan-Takt | **Monatsperlen**: eine Perle pro Monat, gefüllt = Kauf erfasst | Kauf fehlt / Abgleich passt nicht |
| Ziel | **Weg zur Fahne**: Position des Medians auf dem Weg zum Zielbetrag | Median verfehlt das Ziel |
| Spielwiese | **Stellschrauben**: die drei wichtigsten Annahmen als Satz | nie |

### 9. Checkliste für jede neue Ansicht
- [ ] Welche Zoomstufe ist das? Hält sie deren Regeln ein (max. 4 / bildschirmfüllend / Tabelle)?
- [ ] Breadcrumb sichtbar, Esc geht eine Stufe zurück, URL enthält die Stufe
- [ ] Jede Zahl hat Soll oder Vergleich **und** ein Alltagsäquivalent
- [ ] Graustufen; Farbe nur bei Abweichung, immer mit Symbol + Text
- [ ] Kein Tacho, kein Kreis, nichts blinkt
- [ ] Übergang räumlich, ≤ 300 ms, reduzierte Bewegung respektiert
- [ ] Hell- und Dunkelmodus geprüft, Handybreite ohne horizontales Scrollen
