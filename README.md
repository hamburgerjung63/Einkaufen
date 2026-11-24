# Einkaufsvergleich Nord auf GitHub Pages

Die App enthält die Filialen und Bedienung der veröffentlichten Version. Im ZIP liegen nur App-Dateien und öffentlich abrufbare Angebotsdaten. Deine Einkaufsliste, Favoriten und eigenen Preise werden im Browser gespeichert und sind an die jeweilige Webadresse gebunden. Unter einer neuen GitHub-Adresse nutzt du daher einen eigenen Datenbestand.

## Auf dem iPad einrichten

1. Lade das ZIP in die Dateien-App. Tippe auf das ZIP, um es zu entpacken.
2. Öffne dein Repository auf GitHub. Mit einem neuen Repository namens `einkaufsvergleich-nord` und dem Standardbranch `main` passen die folgenden Schritte direkt.
3. Gehe zu **Code → Add file → Upload files**. Lade aus dem entpackten Ordner `index.html`, `angebote.json`, `angebote-aktualisieren.mjs`, `github-pages.yml` und `README.md` hoch. Bestätige mit **Commit changes**.
4. Öffne im Repository die Datei `github-pages.yml` in der **Raw**-Ansicht und kopiere ihren gesamten Text. Wähle **Add file → Create new file** und gib als Namen genau `.github/workflows/pages.yml` ein. Füge den Text in den Editor ein und bestätige mit **Commit changes**. Beim Übertragen des vollständigen Ordners per Git ist der Workflow schon am richtigen Ort.
5. Wähle im Repository **Settings → Pages** und unter **Build and deployment → Source** die Option **GitHub Actions**.
6. Öffne **Actions → Einkaufsvergleich veröffentlichen → Run workflow** und starte den Lauf für `main`. Die fertige Webadresse findest du anschließend unter **Settings → Pages**.
7. Öffne diese Adresse in Safari. Für ein Symbol auf dem iPad-Home-Bildschirm wählst du im Teilen-Menü **Zum Home-Bildschirm**.

## Aktualisierung der Angebote

- Der Workflow ruft die Anbieter beim Veröffentlichen und anschließend täglich ab. Du kannst ihn zusätzlich über **Run workflow** starten. **Aktualisieren** innerhalb der App lädt den zuletzt veröffentlichten Datenstand.
- Die mitgelieferten Angebotsdaten stammen vom **24. November 2026**. Lidl-Artikel aus allgemeinen Prospekten behalten den Hinweis **Filialpreis ungeprüft**.
- Wenn ein Händler Anfragen von GitHub blockiert, nutzt die App noch gültige gespeicherte Daten. Nach Ablauf verschwinden diese aus der Angebotsansicht. Bereits gespeicherte Artikel bleiben auf der Einkaufsliste. Ob REWE und EDEKA künftige Angebotswochen für GitHub freigeben, ist offen.
- GitHub kann geplante Läufe eines öffentlichen Repositorys nach 60 Tagen ohne Aktivität deaktivieren. Dann findest du unter **Actions** die Option, den Workflow wieder zu aktivieren.

## Sofort mit dem mitgelieferten Angebotsstand testen

Lade `index.html` und `angebote.json` in die oberste Ebene des Repositorys. Wähle unter **Settings → Pages → Source** die Option **Deploy from a branch**, dann **main** und **/ (root)**. Diese Variante zeigt die mitgelieferten Daten. Für den täglichen Abruf kannst du anschließend auf **GitHub Actions** umstellen.

## Lokal starten

Mit Python kannst du den entpackten Ordner über `python3 -m http.server 8000` bereitstellen. Öffne danach `http://localhost:8000/`. Mit Node.js 22 oder neuer kannst du `node angebote-aktualisieren.mjs` ausführen. Das erzeugt die veröffentlichbaren Dateien in `dist`.
