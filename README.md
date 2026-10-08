# GPX-Tourenverwaltung – Web-App

Lokale Web-App zur Verwaltung von GPX-Dateien aus **APE@MAP**-Exporten.
Umgesetzt nach `../gpx-tourenverwaltung-plan.md` (Web-App-Variante).

**Kein Build, keine Installation.** Reines HTML + JavaScript (ES-Module). Einzige
Bibliothek: Leaflet – liegt mitgeliefert in `vendor/`.

## Starten

Die App muss über einen **lokalen Server** laufen. Ein Öffnen per Doppelklick
(`file://`) funktioniert **nicht** – der Browser blockiert dann die JavaScript-Module
und das Ladefenster bleibt stehen. Sie öffnet in **Chrome oder Microsoft Edge**
(beide Chromium – für den dauerhaften Ordnerzugriff nötig).

### macOS

`start-webapp.command` im Finder **doppelklicken** (nutzt das vorinstallierte
`python3`). Oder manuell: `cd webapp && python3 -m http.server 8000`.

### Windows

`start-webapp.bat` im Explorer **doppelklicken**. Das Skript sucht Python
(`py` / `python`); ist keines da, nutzt es automatisch den mitgelieferten
PowerShell-Server `serve.ps1` (PowerShell ist in Windows enthalten – keine
Installation nötig). Manuell alternativ:

```bat
cd webapp
py -m http.server 8000
```

Dann in **Chrome oder Edge** öffnen: <http://localhost:8000>

## iPhone / iPad (als App, ohne Kompilieren)

Die App ist eine **PWA** (Progressive Web App): auf GitHub Pages gehostet, in
Safari über **Teilen → Zum Home-Bildschirm** installiert, danach startet sie wie
eine App – auch offline. Kein Xcode, kein App Store, kein Developer-Account.
Hochgeladen wird nur der App-Code; deine GPX-Dateien bleiben auf dem iPhone.

**Einmalig veröffentlichen** (Repo = dieser Ordner `webapp/`):

1. Auf github.com ein neues **öffentliches** Repo anlegen, z. B. `gpx-touren`
   (leer, ohne README).
2. Im Terminal:
   ```bash
   cd webapp
   # einmalig, falls Git noch keine Identität hat (Werte einsetzen!):
   #   git config --global user.name  "<GitHub-Nutzername>"
   #   git config --global user.email "<ID>+<nutzername>@users.noreply.github.com"
   git commit -m "GPX-Tourenverwaltung als PWA"
   git remote add origin https://github.com/<NAME>/gpx-touren.git
   git push -u origin main
   ```
3. Repo → **Settings → Pages** → Source „Deploy from a branch", Branch `main`,
   Ordner `/ (root)` → Save. Nach ~1 Minute läuft die App unter
   `https://<NAME>.github.io/gpx-touren/`.
4. Updates: `git commit -am "…" && git push` – das iPhone holt die neue Version
   beim nächsten Start (online) automatisch.

`.gitignore` verhindert, dass eigene `.gpx`-Dateien im Repo landen (nur
`SampleData/` ist erlaubt).

**Auf dem iPhone:**

1. URL in **Safari** öffnen → Teilen → **Zum Home-Bildschirm** → vom Home-Bildschirm
   starten. *Erst dann importieren* – Safari-Tab und installierte App haben
   getrennte Speicher, und nur die installierte App ist vor der automatischen
   Datenlöschung von iOS geschützt.
2. **Dateien auswählen** → Durchsuchen → iCloud Drive → GPX-Ordner → *Auswählen* →
   *Alle auswählen* → Öffnen. Die App legt eine eigene Kopie an und indexiert sie.
3. Neue APE@MAP-Exporte später über das **＋** (oben rechts in „Touren") holen –
   einfach wieder alle auswählen, bereits vorhandene Dateien werden übersprungen,
   geänderte ersetzt (Bewertung, Titel, Notizen bleiben erhalten).

Unterschiede zum Desktop-Ordnermodus („lokale Bibliothek"):

- **Keine automatische Ordner-Synchronisation** – iOS erlaubt Web-Apps keinen
  dauerhaften Ordnerzugriff. Import ist **additiv**: Was du nicht erneut
  auswählst, bleibt. Löschen nur ausdrücklich: Detailansicht → **Tour löschen**
  oder Einstellungen → **Bibliothek leeren**.
- Die Daten (Kopien, Bewertungen, Notizen) liegen nur im App-Speicher des
  iPhones, **nicht in iCloud gesichert**. Das Entfernen der App vom
  Home-Bildschirm löscht sie.
- Am Desktop lässt sich dieser Modus mit `http://localhost:8000/?local` testen.

### Handy-Ansicht

Auf schmalen Touch-Bildschirmen (Hochformat ≤ 720 px, oder Querformat mit
wenig Höhe) bekommt die App eine eigene, aufs Daumen-Bedienen ausgelegte
Oberfläche. Am Computer ändert sich nichts.

- **Tab-Leiste unten**: Touren · Karte · Einstellungen. Den aktiven Tab nochmals
  antippen springt nach oben; jeder Tab merkt sich seine Scrollposition.
- **Touren**: Suchfeld + Schnellfilter-Chips (Rad, Wandern, Planungen, 4★ +,
  12 Monate), daneben **Filter** (alle Kriterien als Sheet, der Knopf zeigt live
  „N Touren anzeigen") und **Sortierung**. Nach Datum sortiert ist die Liste nach
  Jahren gruppiert, mit Summen (Touren · km). Ganz oben die Summe der gezeigten
  Touren (Anzahl · km · Höhenmeter).
- **Karte** (Vollbild): Ortssuche, Filter, Kartenstil, **Mein Standort**. Das
  Sheet unten zeigt immer, welche Touren **im sichtbaren Ausschnitt** liegen
  (antippen klappt die Liste auf). **Tippen auf eine Route** wählt sie aus – liegen
  dort mehrere Tracks übereinander, werden alle angeboten. „Alle zeigen" holt
  sämtliche (gefilterten) Touren ins Bild. Der Knopf **Kartenstil** öffnet
  Basiskarte, Zusatzebenen, Linienfarben und „Ausschnitt offline speichern".
- **Tour** (Vollbild-Seite): Karte oben fest, darunter scrollen Name, Sterne
  (direkt antippbar), drei Kennzahlen, **GPX teilen** (iOS-Teilen-Menü, z. B. an
  APE@MAP oder AirDrop; sonst Download) und **Karte offline** (speichert die Karte
  rund um die Tour). Höhenprofil: antippen oder wischen zeigt die Stelle auf der
  Karte – die Ablesung bleibt nach dem Loslassen stehen. Bearbeiten (Name,
  Kategorie, Planung, Ausblenden, Notizen, Orte neu ermitteln, Löschen) als
  gruppierte Liste. Zurück über **‹** oder die Zurück-Geste/-Taste.
- Bewusst weggelassen (bleiben am Computer): Umkreissuche mit Fadenkreuz,
  Mehrfachauswahl auf der Karte, Augen-Symbol in der Liste (Ausblenden steht in
  der Tour), Zoom-Knöpfe (Zwei-Finger-Zoom).
- **Abschaltbar**: Einstellungen → Darstellung → **Handy-Ansicht** aus = die
  klassische Oberfläche auch auf dem Handy.

## Als ZIP weitergeben

Den Ordner `webapp/` packen und weitergeben – läuft auf jedem Windows- oder
Mac-Rechner ohne Installation (Python bzw. PowerShell reichen). Zwei Punkte,
die beim ersten Start nach dem Entpacken auffallen können:

- **ZIP erstellen (macOS):** Finder-„Komprimieren" oder `zip -r gpx-webapp.zip
  webapp` verwenden – beides erhält die Ausführungsrechte von
  `start-webapp.command`. Eine auf Windows erstellte ZIP-Datei (Explorer
  „Senden an → ZIP-komprimierter Ordner") **verliert dieses Recht**; nach dem
  Entpacken auf einem Mac dann einmal im Terminal `chmod +x
  start-webapp.command` ausführen, sonst öffnet ein Doppelklick nur den
  Quelltext.
- **Sicherheitswarnung beim ersten Start:** Da die Dateien aus einer
  heruntergeladenen/entpackten ZIP stammen, markiert das Betriebssystem sie als
  „aus dem Internet". macOS zeigt dann ggf. „kann nicht geöffnet werden, da...
  nicht verifizieren" → Rechtsklick auf `start-webapp.command` → **Öffnen**
  wählen (nur beim ersten Mal nötig). Windows zeigt ggf. „Windows hat den PC
  geschützt" (SmartScreen) → **Weitere Informationen → Trotzdem ausführen**.
  Das betrifft nur den ersten Start, da Doppelklick-Start naturgemäß ein
  unsigniertes Skript ausführt – Rechner-Installation ist trotzdem keine
  nötig.

## Bedienung

1. **Ordner auswählen** → den Ordner mit den GPX-Dateien wählen. iCloud Drive liegt
   unter macOS in `~/Library/Mobile Documents/com~apple~CloudDocs` (im Dialog `⌘⇧G`),
   unter Windows meist in `C:\Users\<Name>\iCloudDrive` (Pfad ins Adressfeld
   eingeben). Der passende Hinweis wird beim ersten Start angezeigt.
2. Die App indexiert den Ordner einmal (Fortschritt oben rechts) und merkt sich
   den Ordner. Nach einem Neuladen einmal die Freigabe bestätigen.
3. **Liste** – Suche über Titel/Ort/**Land**; Filter für Land, Kategorie,
   **Planung** (einschließen / nur / ohne), **Bewertung (≥ N Sterne)**,
   **Schnellfilter Zeitraum** (letzte 3 / 12 Monate, 3 / 5 Jahre) sowie manuelle
   Datums-, Distanz- und Höhenmeter-Grenzen; Sortierung inkl. Bewertung. Kategorie
   als farbiger Text-Chip, Planungen mit einem **violetten „Planung“-Abzeichen**
   (kein Emoji). Zeile anklicken → Detailansicht.
4. **Kartensuche** – füllt zunächst den ganzen Bildschirm und ist auf die
   **dichteste Tour-Region** zentriert. Farbcode (alles durchgezogen, keine
   Striche): aufgezeichnete Touren, Planungen und die ausgewählte Tour (mit Halo)
   in je einer eigenen Farbe – **wählbares Farbschema** in den Einstellungen
   („Kräftig" / „Kontrast" / „Neon"), unter jeder Linie ein heller bzw. dunkler
   Rand, damit sie sich auch auf Relief- und Satellitenkarte klar abhebt; kleine
   Legende unten links. Ein Klick wählt Touren aus (mehrere
   möglich) und teilt die Ansicht: Karte oben, Auswahlliste unten; ein Klick
   daneben (nicht auf eine Route) hebt die Auswahl wieder auf. „Touren im
   Umkreis wählen“ nutzt Mittelpunkt + Slider; „Auswahl aufheben“ macht wieder
   Vollbild; „Umkreissuche“ blendet Fadenkreuz + Suchkreis (und die zugehörige
   Bedienung) komplett aus, wenn nicht gebraucht. Derselbe **Filter** wie in der
   Liste (Land, Kategorie, Planung, Bewertung, Zeitraum, Distanz, Höhenmeter,
   ausgeblendete Touren) lässt sich auch hier über den „Filter“-Knopf öffnen –
   er blendet Routen nur für Darstellung/Suche ein oder aus und ist unabhängig
   vom dauerhaften Ausblenden über das Augen-Symbol. Über das **Ebenen-Symbol**
   oben rechts:
   - **Basiskarte:** OpenStreetMap · OpenTopoMap (Relief) · Satellit (Esri-Luftbild)
   - **Overlays** (kombinierbar): **Öffentliche GPS-Tracks (OSM)** – die aus allen
     bei OpenStreetMap hochgeladenen Tracks gerenderten Linien, zur Fehlersuche
     bei abweichenden Aufzeichnungen; **Wanderwege** und **Radrouten** (Waymarked
     Trails) – die beschilderten Wege- bzw. Radroutennetze.

   Die Wahl gilt auch für die Detailkarte und bleibt gespeichert. (CyclOSM und
   4UMaps wurden getestet, aber verworfen: CyclOSM-Server offline, 4UMaps sperrt
   fremde Einbindung. Satellit + Waymarked-Trails-Overlays decken den Zweck ab.)

   **Offline-Karte** (Knopf in der Bedienleiste): speichert die **Kacheln des
   aktuellen Kartenausschnitts** (nur die gewählte Basiskarte) in IndexedDB, für
   die Nutzung ohne Internet. Der Dialog zeigt vorab die geschätzte Kachelzahl +
   Größe; über den Regler „Detailtiefe“ wählst du, bis zu welcher Zoomstufe
   gespeichert wird (gedeckelt bei Zoom 16). Große Gebiete werden gewarnt bzw. ab
   ~20 000 Kacheln abgelehnt, der Download läuft gedrosselt (2 Verbindungen).
   Verwalten und **Löschen** der gespeicherten Ausschnitte: Einstellungen →
   **Offline-Karten** (einzeln oder alle). Hinweis: OSM, OpenTopoMap und Esri
   sehen Massen-Downloads nicht vor – nur kleine, selbst genutzte Gebiete.
5. **Detail** – editierbarer **Name**, volle Route, **interaktives Höhenprofil**,
   Kennzahlen, Kategorie, **Planung**-Checkbox, **5-Sterne-Bewertung**, Notizen,
   **„Track ausblenden“**, „Original-GPX herunterladen“, „Orte online ermitteln“
   (viele/kleine Orte + Land; asiatische Namen latinisiert).

   Layout: auf breiten Fenstern **zweispaltig** – links die große Karte (füllt die
   volle Höhe), rechts die Details, die für sich scrollen; auf schmalen Fenstern
   gestapelt (hohe Karte oben, alles andere darunter). Fixe Sheet-Höhe (94 vh),
   nur die Detailspalte scrollt.

   Das **Höhenprofil**: Distanz auf der unteren Achse, Höhe links; hat der Track
   Zeitstempel, zeigt eine **zweite Achse oben die verstrichene Zeit** (Marken an
   der Distanz, an der die jeweilige Zeit erreicht war – Pausen sind als
   „stehende“ Kurve unter einer Zeitmarke erkennbar). Der Zeiger wirkt **in beide
   Richtungen**: über das Profil fahren (auch per Touch) blendet Fadenkreuz +
   Ablesung (Distanz · Höhe · Zeit) ein und setzt einen Marker auf die Karte;
   **über die Route auf der Karte fahren** setzt umgekehrt Fadenkreuz + Ablesung
   im Profil. Ohne Zeitstempel (z. B. Planungsrouten) entfällt nur die Zeitachse.

Orte + Land werden **standardmäßig automatisch** ermittelt – im Hintergrund, eine
Tour nach der anderen, **so lange bis alle erledigt sind** (die Statuszeile zeigt
„Orte werden ermittelt… (N offen)"). Der Lauf setzt sich bei App-Start und wenn
die Verbindung zurückkommt von selbst fort; man muss dafür **nichts anklicken**.
Da OpenStreetMap/Nominatim auf ~1 Anfrage/Sekunde gedrosselt ist, dauert die
erste große Bibliothek eine Weile – die App bleibt derweil normal nutzbar. In den
Einstellungen abschaltbar; „Orte neu ermitteln" in der Detailansicht erzwingt den
Neu-Lauf für eine einzelne Tour.

### Tracks ausblenden

Über das **Augen-Symbol** rechts an jeder Listenzeile oder den Button in der
Detailansicht lässt sich ein Track **dauerhaft ausblenden** – er verschwindet aus
Liste, Karte und Kartensuche (das Flag `hidden` liegt in IndexedDB). Wieder
einblenden: Filter „ausgeblendete Touren anzeigen“ + Augen-Symbol, oder
„Einstellungen → Ausgeblendete Tracks → Alle wieder einblenden“. Die GPX-Datei
bleibt unberührt und wird weiter indexiert.

### Kategorie & Planung (automatisch, überschreibbar)

- **Kategorie** = **Rad** oder **Wandern**: entscheidet die **Ø-Geschwindigkeit**,
  sobald der Track Zeitstempel hat (≥ 11 km/h ⇒ Rad). Ohne Zeitstempel
  (geplante Routen) entscheidet die Länge (ab 25 km ⇒ Rad).
- **Planung** ist eine eigenständige Markierung (nicht selbst aufgezeichnet, z. B.
  aus dem Netz oder einem Tourenplaner). Automatisch erkannt an: `<rte>` statt
  `<trk>`, **fehlenden Zeitstempeln** und **weit auseinander liegenden Wegpunkten**
  (großer Punktabstand / wenige Punkte pro km).

### Routennamen

Statt des Dateinamens wird ein sprechender Name aus den Orten entlang der Strecke
gebaut, z. B. `Rundtour: München-Baldham-Grasbrunn (36,4 km)` oder
`Burghausen-Chieming-Sachrang-Kufstein (100 km)`.

Für den Namen werden die **größten Orte** entlang der Strecke gewählt (Stadt/Ort vor
Dorf vor Weiler): je ein Anker nahe Start und Ziel plus bis zu drei möglichst große,
gut verteilte Orte dazwischen (**insgesamt 3–4 Namen**); kleine Weiler zwischen zwei
Städten fallen weg. Loops werden als „Rundtour“ erkannt (Start ≈ Ziel).

Steckt im **Dateinamen** (oder GPX-`<name>`) eine eigene Bezeichnung wie
`Wendelsteinrundfahrt`, wird sie übernommen – entweder als Prefix
(`Wendelsteinrundfahrt: Bayrischzell-Osterhofen-Birkenstein (32 km)`) oder, wenn sie
schon wie ein vollständiger Titel wirkt, allein. Führende Gattungswörter
(„Bergtour-“, „Radtour “, „Planung-“ …) und Datums-/App-Präfixe werden entfernt.

**Nichtssagende Namen** werden erkannt und **ignoriert**: kryptische Blobs
(`30 17#7km55#737m#4h17`, `20240715_083215`) **und App-Namen** wie
„My Phone My Guide“, „OsmAnd“, „Komoot“, „Strava“ … Stattdessen greift der
Ortsname bzw. offline `Rundtour (X km · Y hm)`.

**Touren abseits jeder Ortschaft** (Wald, Grat, Almgebiet) liefern beim
Reverse-Geocoding keinen Ort und hießen früher nur „Tour“. Jetzt wird per Overpass
die **nächstgelegene nennenswerte Gemeinde** gesucht (größere Orte schlagen knapp
nähere) und als Verortung genutzt:
`Rundtour bei Bayrischzell (7,6 km)`, `Wendelsteinrundfahrt bei Bayrischzell (32 km)`.
Findet auch das nichts, dient die **Region** als letzter Anker:
`Rundtour im Landkreis Miesbach (7,6 km)`.

**Bergtouren** (viel Aufstieg, klarer Gipfelpunkt in der Tourmitte, zu Fuß) tragen
den **Gipfel** im Namen, z. B. `Kufstein – Pendling (6,8 km)`. Der Gipfelname kommt
aus einem `<wpt>` nahe dem höchsten Punkt (offline) oder per Overpass
(`natural=peak`, nur online).

Die vollständige Ortsliste bleibt in der Detailansicht sichtbar (dort auch
„Gipfel: … (Höhe)“). Der Name entsteht nach dem Geocoding; bis dahin gilt der
GPX-`<name>` bzw. `Tour (X km)`. In der Detailansicht frei überschreibbar.

## Änderungserkennung

- Chrome ≥ 129: automatisch über `FileSystemObserver`.
- Sonst: erneuter Scan bei Fensterwechsel + Button **⟳ Aktualisieren**.
- Nutzereingaben (ausgeblendet, Planung, Bewertung, Name, Notizen) und die
  ermittelten Orte **bleiben über Neustarts erhalten** – ein Re-Scan übernimmt sie
  auf den neu geparsten Stand. Löschen aus dem Index passiert nur, wenn der Ordner
  auch wirklich vollständig gelesen wurde (ein noch synchronisierendes iCloud
  Drive räumt nichts ab). Ist der Ordner absichtlich leer: „Einstellungen → Index
  zurücksetzen".

## Grenzen

- **Chromium-Browser nötig** (Chrome oder Edge) für dauerhaften Ordnerzugriff. In
  Safari (iPhone/iPad/Mac) und Firefox arbeitet die App stattdessen mit einer
  **lokalen Bibliothek** aus importierten Kopien (siehe „iPhone / iPad").
- **Kartenkacheln und Ortssuche brauchen Internet** – *sofern* der Ausschnitt
  nicht vorab über „Offline-Karte“ gespeichert wurde (dann bedient die Karte sich
  aus dem lokalen Kachel-Cache). Der lokale Server (`python3 -m http.server`)
  läuft auch ohne Internet, die App startet also offline. Liste, Filter, räumliche
  Suche und Detailkennzahlen laufen ohnehin offline; ohne gespeicherte Kacheln
  fällt die Karte auf eine SVG-Streckenskizze zurück.
- **Offline-Kacheln:** nur die Basiskarte wird gespeichert (keine Overlays),
  Zoom bis 16. Überlappende gespeicherte Bereiche teilen sich Kacheln – beim
  Löschen bleiben Kacheln erhalten, die ein anderer Bereich noch abdeckt. Der
  Massen-Download öffentlicher Kachel-Server ist laut deren Nutzungsbedingungen
  nicht vorgesehen; die Funktion ist bewusst auf kleine, selbst genutzte Gebiete
  begrenzt und gedrosselt.
- Keine Pulsdaten (wie im Plan).

## Plattformen

Die App selbst ist reines Chromium-Web und läuft unter **macOS, Windows und Linux**
gleich. Betriebssystem-abhängig sind nur die Starthilfen:

| | macOS | Windows |
|---|---|---|
| Launcher | `start-webapp.command` | `start-webapp.bat` |
| Server | `python3` (vorinstalliert) | `py`/`python`, sonst `serve.ps1` (PowerShell, in Windows enthalten) |
| iCloud-Pfad | `~/Library/Mobile Documents/com~apple~CloudDocs` | `C:\Users\<Name>\iCloudDrive` |
| Neu laden | `⌘⇧R` | `Strg+Shift+R` |

Hinweis: iCloud für Windows nutzt „Dateien nach Bedarf“ – beim ersten Einlesen
werden GPX-Dateien ggf. heruntergeladen; danach reicht der Metadaten-Vergleich
(unveränderte Dateien werden nicht erneut geladen).

## Projektaufbau

```
webapp/
├─ index.html, styles.css
├─ vendor/                 Leaflet (js/css/marker-icons), mitgeliefert
├─ js/
│  ├─ gpx.js               GPX-Reader ohne DOM (worker-fähig)
│  ├─ geo.js               Haversine, Bounding-Box, Douglas-Peucker
│  ├─ analyzer.js          Datei-Text → „Tour-Draft“ (Metriken, Polyline, Kategorie)
│  ├─ parseWorker.js       Web Worker um analyzer.js
│  ├─ db.js                IndexedDB (Stores: tours, meta, tiles, tileRegions, files)
│  ├─ folderAccess.js      showDirectoryPicker + Handle-Persistenz; Datei-Picker
│  │                       für die lokale Bibliothek
│  ├─ localFolder.js       lokale Bibliothek (iPhone): importierte GPX-Kopien im
│  │                       Store `files`, als Ordner-Handle-Attrappe für indexer/detail
│  ├─ indexer.js           inkrementeller Ordner-Abgleich + FileSystemObserver
│  ├─ filter.js            Filter + Sortierung
│  ├─ spatial.js           Umkreis-/Rechteck-Suche
│  ├─ chart.js             interaktives Höhenprofil auf <canvas> (Distanz +
│  │                       Zeitachse + Hover-Ablesung) · toProfileSamples()
│  ├─ minimap.js           SVG-Streckenvorschau
│  ├─ geocode.js           Nominatim (Ortssuche / Orte entlang der Strecke)
│  ├─ mapLayers.js         wählbare OSM-Kartenebenen + GPS-Track-Overlay
│  ├─ trackColors.js       Farbschemata der Routenlinien + Casing (Rand)
│  ├─ offlineTiles.js      Offline-Kachel-Cache (IndexedDB): Download-Bereich,
│  │                       Leaflet-Layer mit Cache-Vorrang, Löschen pro Bereich
│  ├─ format.js, dom.js    Hilfen
│  ├─ icons.js             SVG-Icons der Handy-Ansicht
│  └─ views/               folderSetup, list, mapSearch, detail, settings,
│                          offlineDialog · Handy-Ansicht: mobileList, mobileMap,
│                          filterSheet, layerSheet, ui (Sheet/Toast/Schalter)
├─ manifest.webmanifest, sw.js, icons/   PWA: Installierbarkeit + Offline-Start
├─ tools/make-icons.mjs    erzeugt die Icons einmalig (kein Build-Schritt)
├─ SampleData/             Beispiel-GPX (Wandern / Rad / Planung / Bergtour)
├─ start-webapp.command    Launcher macOS  (Finder-Doppelklick)
├─ start-webapp.bat        Launcher Windows (Explorer-Doppelklick)
├─ serve.ps1               PowerShell-Server (Windows, kein Python nötig)
└─ test/                   gpx.test.mjs (Kern) · localFolder.test.mjs (lokale
                           Bibliothek, mit fakeDb.mjs statt IndexedDB)
```

## Test

```bash
node test/gpx.test.mjs          # prüft Parser/Geometrie/Kategorie gegen SampleData
node test/localFolder.test.mjs  # Import → Scan → Re-Import → Löschen (iPhone-Modus)
```

Node ist auf diesem Rechner vorhanden, für die App selbst aber nicht nötig.

## Daten / Zurücksetzen

Der Index liegt in **IndexedDB** (`gpxtouren`). „Einstellungen → Index
zurücksetzen“ leert ihn; die GPX-Dateien bleiben unangetastet. Beim Wechsel des
Ordners wird das gespeicherte Handle verworfen.
