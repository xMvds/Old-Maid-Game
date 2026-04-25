# Old Maid V2.0

Single-table (1 lobby) multiplayer prototype.

## Spelen (lokaal)
1. Install:
   ```bash
   npm install
   ```
2. Start server:
   ```bash
   npm start
   ```
3. Open player scherm:
   - `http://localhost:3000/room.html`
   - Open meerdere tabbladen → elk tabblad is een nieuwe speler.
   - Vul per tab een **unieke naam** in (de server maakt automatisch `"Naam 2"`, `"Naam 3"` als je dubbel zit).

## Host (dev)
Open in een aparte tab:
- `http://localhost:3000/host`

Op het host-scherm kun je:
- Spel starten / nieuwe ronde starten
- Auto-pick aan/uit (dev)
- **Dev step**: laat de huidige speler automatisch een random kaart pakken (handig om snel te testen)

Tip: op het player scherm kun je het debug-paneel openen door **D** 3× snel te drukken. Daar zit ook een knop om het host scherm te openen.

## Belangrijke regels / gedrag
- **Geen room code**: er is altijd 1 lobby.
- In de **lobby** (spel nog niet gestart): als je refresht, log je uit en moet je je naam opnieuw invullen.
- Tijdens een **lopende game**: je mag terugkomen (refresh/reconnect) zolang je **niet offline bent wanneer je aan de beurt bent**.
- Als je probeert te joinen terwijl het spel al bezig is en je bent geen reconnect: je komt binnen als **spectator** (meekijken).
- Joker kwijt = **direct af** → kaarten worden automatisch herverdeeld.
- Leave seat = **af** → kaarten worden automatisch herverdeeld.

## UI notities
- Player-perspective: **alle andere spelers staan gegroepeerd tegenover jou** (bovenkant van de tafel) voor meer overzicht.

## Opmerking (start handen)
- Start-deal discards (setjes) worden **niet** automatisch direct bij het starten weggegooid, zodat iedereen met een **gelijke** start-hand begint.
- Setjes worden weggedaan na acties (zoals trekken / herverdelen).
## Deploy (Render)
Maak een **New Web Service** (geen Static Site).

Vul deze waarden in:
- **Language:** Node
- **Build Command:** `npm ci`
- **Start Command:** `npm start`
- **Root Directory:** leeg (tenzij je `package.json` in een submap hebt)

Open daarna:
- Player: `/room.html`
- Host/dev: `/host`

Belangrijk: de server luistert op `process.env.PORT` (Render zet dit automatisch).



## Deploy (Render)

- Build Command: `npm ci`
- Start Command: `npm start`
- Open: `/room.html` (player) and `/host` (dev)

This project pins Node to LTS via `engines` and `.node-version`.


## Deployen op Render (Web Service)

> Kies **New Web Service (Node)**, niet Static Site.

**Invullen op Render (Create Web Service):**
- **Root Directory:** *(leeg)*
- **Build Command:** `bash render-build.sh`
- **Start Command:** `node server.js`
- **Instance Type:** Free (of hoger)

**URL's na deploy:**
- Player: `/room.html`
- Host/Dev: `/host`

### Waarom niet npm ci?
Soms crasht npm op Render met `Exit handler never called!`. Deze build gebruikt daarom **Yarn via Corepack** in `render-build.sh`.

