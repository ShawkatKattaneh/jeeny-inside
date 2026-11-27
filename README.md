# Jeeny INSIDE

**Campus mobility on electric golf carts.** Students book a cart, Operations dispatches it with an explainable engine, and the driver runs the trip, all live, on one server.

> Jeeny INSIDE is an independent hackathon concept inspired by Jeeny. It is not an official Jeeny product and uses no Jeeny logos or assets. The campus, personas and ride history are sample data; the fleet, cart positions and fares are simulated.

## What it does

Three connected apps share one backend, one SQLite database and one live (Socket.IO) state, so every action appears on every screen within a second.

| Role | Highlights |
|---|---|
| **Student** | Map-first booking (pickup, destination, Solo or Shared), live ride status with ETA and progress, ride history and details, cancellation, NFC Tap-In with QR fallback (check-in only), loyalty progress (5 paid rides, the next one free), Campus Pulse, Campus Impact, Priority/SOS information, rule-based Campus Copilot, light/dark/system theme. |
| **Driver** | The trip assigned to your cart, passengers and stops, explicit steps (Start trip, Arrived at pickup, Confirm boarding, Arrived at destination, Confirm drop-off), per-passenger actions on shared trips, cart and battery status. |
| **Operations** | Live overview, request queue with one-tap dispatch and the engine's reasons for every cart, fleet and trip tables with details, campus map, server-driven simulated movement, Ghost Ride (shared trips) monitoring, Battery Rescue, Campus Flow Shield, Mission Mode (pooling on vs off on the same seeded demand), campus analytics, NFC/QR Tap Points. |

The **three-phone live demo** at `/demo` shows the real Student, Driver and Operations apps side by side.

## Tech stack

React 19 + Vite + TypeScript + Tailwind CSS · Node.js + Fastify + Socket.IO · SQLite (Node's built-in `node:sqlite`) · Zod for every contract · Vitest. One package, one process in production: the server serves the built app, the REST API and Socket.IO on the same port.

## Quick start

You need **Node.js 22.13 or newer** (22.x), or 23.4+.

```bash
npm install
npm run dev        # development with hot reload: http://localhost:5173
npm start          # production build, then the server: http://localhost:3000
npm run check      # typecheck + tests + production build
```

Open `http://localhost:3000/demo` (or `:5173/demo` in development) for the three-phone view, or `/` to choose one role. Both commands print the addresses phones on the same Wi-Fi or hotspot can open.

Useful options: `--db=data/demo.sqlite` (a fresh file gives a clean demo), `--public-host=<laptop address>` (shows NFC/QR Tap-In URLs), `--campus=campus/demo-valley.json` (a second campus). Environment variables `PORT`, `DB_FILE`, `PUBLIC_URL`, `CAMPUS_FILE` and `FLEET_FILE` do the same.

### Phones over the laptop's hotspot

1. Turn on the laptop's hotspot (or put the laptop and phones on the same Wi-Fi).
2. Run `npm start` (or `npm run dev`).
3. On each phone, open the "On phones" address the server printed.
4. If the phone cannot connect, allow Node.js through the laptop's firewall for private networks (Windows asks the first time; on macOS check System Settings → Network → Firewall).

## Hackathon demo in five minutes

1. Start with a fresh database: `npm start -- --db=data/demo.sqlite`, then open `/demo`.
2. **Student:** choose a pickup and a destination, tap *Request a ride*.
3. **Operations:** the request appears live; tap *Dispatch REQ-…* (open *Why this cart* for the engine's reasoning). Under *Simulation*, choose a speed and tap *Start movement*.
4. **Driver:** the trip appears live. Tap *Start trip*; the cart drives its route on all three phones. At the pickup tap *Arrived at pickup*, then *Confirm boarding*; at the destination *Arrived at destination*, then *Confirm drop-off*.
5. **Student:** sees *Ride completed* with the simulated fare (0.25 JOD) and loyalty progress; Operations shows the completed trip.
6. Extras: a Shared ride (two students, same pickup), NFC Tap-In from *Quick*, Mission Mode and Flow Shield in Operations, Campus Copilot in *Quick*.

## Run on Replit

The repository is ready to import: `.replit` holds the run, build and port settings, so no code changes are needed on Replit. One Node.js process serves the React app, the REST API and Socket.IO on one port, with SQLite in a file.

**When you receive the account:**

1. On Replit choose **Create App → Import from GitHub**, pick `ShawkatKattaneh/jeeny-inside` and the `main` branch (the stable presentation branch). Replit reads `.replit` and uses the Node.js 22 module.
2. Press **Run**. It runs `npm run replit:build` (install and production build), then `npm run replit:start` (Node version check, then the server on `$PORT`, default 3000, at `0.0.0.0`). The Preview opens the app; add `/demo` to the address for the three-phone presentation view.
3. Click **Publish** and choose **Reserved VM** as the deployment type (not Autoscale), with the smallest machine. The build and run commands come from `.replit` (`npm run replit:build`, `npm run replit:start`; port 3000 to 80). Publish.
4. Open `https://<your-app>.replit.app/demo`. Every page, including `/demo`, `/student`, `/driver`, `/ops` and Tap-In links, works with direct navigation and refresh.
5. Optional, for NFC/QR Tap-In links: in the deployment's settings add the environment variable or Secret `PUBLIC_URL` = your published address (for example `https://<your-app>.replit.app`, no path), then publish again. Operations → Tap Points then shows the URLs and QR codes.

**Settings (all optional):**

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port the server listens on (Replit's port 3000 is mapped to the public port 80 in `.replit`). |
| `DB_FILE` | `data/<campus id>.sqlite` | The SQLite file. Created and seeded from the fleet file on first start; restored on every later start. |
| `PUBLIC_URL` | none | Public https address used in Tap-In NFC/QR links. Without it, Tap Points shows no URLs. |
| `CAMPUS_FILE`, `FLEET_FILE` | the fictional campus and its fleet | Swap the campus, as on a laptop. |

No secrets or API keys are required.

**Why Reserved VM:** the live ride state and every Socket.IO connection live in one server process. Autoscale can run several instances (each with its own state) and scales to zero when idle, which would break live updates and reset rides.

**Persistent storage (read before the demo):** Replit's published apps do not keep their file system: it "resets every time you publish". So on the published app the SQLite file starts fresh (seeded from the fleet file) after each publish, and should be treated as temporary across restarts of the deployment. Rides and history are kept while that deployment is running. In the Replit workspace (the Run button) the `data/` folder is kept between runs. For a clean demo, simply publish again; nothing else needs configuring. Keeping ride history permanently across publishes would need an external database (for example Replit's PostgreSQL), which this version does not use and would be a separate change.

## Simulated data and honesty

- **Simulated, labelled as such:** the fleet, cart positions (not GPS), battery values, the simulation clock and fares (0.25 JOD, no payment taken).
- **Rule-based, not AI:** dispatch (a deterministic, tested engine with an explanation per cart), Battery Rescue, Campus Flow Shield and Campus Copilot. No language model is used anywhere.
- **Not available in this build:** Priority Mobility dispatch, emergency (SOS) dispatch and a Campus Impact Score; the app says so where they would appear.
- **Demo access:** roles are chosen on the start screen; there is no sign-in, and anyone who can open the app can use every role.

## Repository workflow

| Branch | Purpose |
|---|---|
| `main` | Stable presentation and release branch (the default branch). Updated from `develop` by pull request. |
| `develop` | Integration and testing branch. Feature work is merged here by pull request. |
| `feature/<name>`, `fix/<name>`, `docs/<name>` | Short-lived branches from `develop`. |

Every pull request runs CI (`npm ci` and `npm run check` on Node.js 22). See [CONTRIBUTING.md](CONTRIBUTING.md) for the full process, the protected business rules and what must never be committed.

> The repository is private on a free GitHub plan, where branch protection and rulesets are not available. Until they are, `main` and `develop` are protected by the pull request workflow and CI checks described in CONTRIBUTING.md.

## Documentation

- [docs/TECHNICAL.md](docs/TECHNICAL.md): API endpoints, realtime events and the revision rule, persistence (SQLite), analytics, Tap-In rules, project structure and approved settings.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute.

## License

No license has been chosen yet, so all rights are reserved by default.
