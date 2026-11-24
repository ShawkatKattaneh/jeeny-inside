# Jeeny INSIDE

Campus mobility for university students on electric golf carts: a Student app, Driver Mode and an Operations Center in one responsive web app.

> Jeeny INSIDE is an independent hackathon concept inspired by Jeeny. It is not an official Jeeny product and uses no Jeeny logos or assets. The campus, personas and ride history are sample data; the fleet, demand and fares will be simulated.

**Status: Phase 0 (Foundation).** The baseline is the approved Foundation Plan (Revision 2). Changes to architecture or scope are proposed before they are built.

## Run it

You need Node.js 20 or newer.

```bash
npm install
npm run dev        # development: hot reload, open http://localhost:5173
npm start          # demo build: builds, then serves everything on http://localhost:3000
npm test           # all tests
npm run check      # type check + tests + production build
```

Both `dev` and `start` print the addresses phones can open, for example `http://192.168.43.12:5173`.

### Phones over the laptop's hotspot

1. Turn on the laptop's hotspot (or put the laptop and phones on the same Wi-Fi).
2. Run `npm start` (or `npm run dev`).
3. On each phone, open the "On phones" address the server printed.
4. If the phone cannot connect, allow Node.js through the laptop's firewall for private networks (Windows asks the first time; on macOS check System Settings → Network → Firewall).

### Swap the campus

The map, locations and paths come from one config file. The default is `campus/fictional-campus.json` (Wadi Cedar University, fictional, 15 locations).

```bash
npm start -- --campus=campus/demo-valley.json     # a second, tiny fictional campus
npm run dev -- --campus=campus/demo-valley.json
```

`CAMPUS_FILE=path/to/campus.json` works too. A real campus is a new JSON file with the same shape (`shared/schemas.ts`, `CampusConfig`); no code changes. The server refuses to start on an invalid file or one with locations no cart can reach, and says why.

### Starting fleet

The server starts with the carts in `campus/fleets/<campus id>.json` (sample data: CART-01 and CART-02, simulated, idle at the depot). Each campus has its own fleet file, so swapping the campus swaps the fleet. `--fleet=path/to/fleet.json` or `FLEET_FILE=...` picks another file. The server refuses to start on a missing file, a fleet for another campus, or any invalid cart, and says why.

### Ride-request API (Phase 2)

| Method | Path | Result |
|---|---|---|
| GET | `/api/campus` | Campus config, including its locations |
| GET | `/api/carts` | Every cart with its status, position, battery and passengers |
| GET | `/api/carts/:cartId` | One cart, or 404 |
| POST | `/api/ride-requests` | Body `{ studentId, pickupId, destinationId }` only. 201 with the new request; any other field is refused with 400 |
| GET | `/api/ride-requests/:requestId` | The request, or 404 |
| GET | `/api/ride-requests/:requestId/trip` | `{ trip }`, which is `null` until a cart is assigned; 404 for an unknown request |

Errors are `{ error, code }` (plus `issues` for an invalid body): 400 invalid input, 404 unknown resource, 409 not allowed in the current ride state, 500 internal (no details). Creating a request does not assign a cart; dispatch comes in a later phase. Sending the same body twice creates two requests (no idempotency yet).

## Structure

One repository, one package, four folders with fixed boundaries (Plan section 5):

```
campus/      Campus config files (fictional until the university is chosen) and fleets/ starting carts per campus
shared/      Zod schemas and types used by every side, approved settings, demo personas
engine/      Pure TypeScript logic (no network, database or timers): campus graph, shortest route, ETA
server/      Fastify: REST endpoints, campus and fleet loading, the one in-memory ride state, serves the built app in demo mode
client/      React + Vite + Tailwind web app
  src/ui/      Design tokens v0 components: brand lockup, pill and icon buttons, badges, campus map
  src/routes/  Persona picker, /student, /driver, /ops
  src/lib/     API client (validated with the shared schemas), persona storage, map geometry
scripts/     dev.mjs: starts the API and the Vite dev server with one command
```

Boundary rules: `engine` imports only from `shared`; `server` wires the engine to the network and holds no business rules; `client` displays what the server sends and never computes a dispatch decision or metric.

## Approved settings

In `shared/settings.ts`: simulated fare 0.25 JOD per ride (shared rides the same), 5 completed paid rides earn the 6th free, 15% battery reserve, 4 minutes maximum added delay for shared rides. Later phases read these; nothing hard-codes them.
