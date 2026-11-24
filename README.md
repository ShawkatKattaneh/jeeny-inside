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
| POST | `/api/ride-requests/:requestId/dispatch` | Picks and assigns a cart (policy below). 200 `{ request, trip, cart, selection }`; 409 `NO_CART_AVAILABLE` with `selection` explaining every cart, and the request stays requested |
| POST | `/api/ride-requests/:requestId/start` | Starts the assigned trip: the cart heads for the pickup on the next advance. 200 `{ request, trip, cart }` |
| POST | `/api/ride-requests/:requestId/board` | Boards the passenger; only once the cart is at the pickup |
| POST | `/api/ride-requests/:requestId/drop-off` | Drops the passenger off; only once the cart is at the destination |
| POST | `/api/ride-requests/:requestId/cancel` | Cancels before boarding. A cart caught mid-path finishes that one path first and stays unavailable until then |
| GET | `/api/snapshot` | The whole ride state with its `revision` (same shape as the realtime snapshot below) |
| POST | `/api/simulation/advance` | Body `{ seconds }`, more than 0 and at most 600. Moves every active trip at once. 200 `{ clockSeconds, carts, trips }` |

The ride actions take no body fields (an empty body or `{}`); anything else is refused with 400, so a client can never choose a cart or set a status, position or passenger count.

Errors are `{ error, code }` (plus `issues` for an invalid body): 400 invalid input, 404 unknown resource, 409 not allowed in the current ride state, 500 internal (no details). Creating a request does not assign a cart; dispatch is a separate, explicit call. Sending the same body twice creates two requests (no idempotency yet).

**Dispatch policy** (`engine/dispatch.ts`, deterministic, no AI): a cart is a candidate only if the engine's own `assignCart` accepts it (in service and idle, battery at or above 15%, a free seat, no open trip, parked at a location rather than on a path, routes to the pickup and the destination). Candidates are ranked by the exact, unrounded time to reach the pickup on the route the trip will drive, then by the route's length, then by cart id. One call dispatches one request; nothing is dispatched automatically.

**Simulated time** moves only when `/api/simulation/advance` is called: a manual demo control, with no timers or real-time movement. Advancing never boards or drops anyone off. All ride state lives in memory and starts again from the campus and fleet files when the server restarts.

### Realtime updates (Socket.IO)

Socket.IO runs on the same HTTP server and port as the REST API (`server/realtime.ts`, attached in `buildApp` to Fastify's own server). There is no second server. In development, Vite proxies `/socket.io` to the API server, WebSocket included. Closing the app (`app.close()`) first stops publishing, disconnects every socket and closes Socket.IO's engine, then Fastify closes the HTTP server. Each app instance has its own sockets, revision and state.

Sockets only listen. REST is the only way to change anything, and the server handles a single client event: a request for a fresh snapshot.

| Event | Direction | Payload |
|---|---|---|
| `state:snapshot` | server to client, first thing after every connection | `StateSnapshot`: `{ revision, campusId, clockSeconds, requests, trips, carts }`, the whole ride state at that revision |
| `state:update` | server to every connected client, once per committed operation | `StateUpdate`: `{ revision, operation, clockSeconds, requests, trips, carts }`, listing every request, trip and cart the operation changed, each in full as it is after the commit |
| `state:snapshot:request` | client to server, with an acknowledgement callback | The acknowledgement carries a fresh `StateSnapshot` |

Schemas are in `shared/schemas.ts`; event names and `classifyRevision` are in `shared/realtime.ts`. `operation` is one of `ride_request.created`, `ride.dispatched`, `ride.started`, `ride.boarded`, `ride.dropped_off`, `ride.cancelled` or `simulation.advanced`. A cancelled ride's mid-path cleanup finishes inside a `simulation.advanced` update, which shows the trip `cancelled` and the cart `idle`.

**Revision.** The server keeps a counter per running instance: 0 at startup, +1 for each committed operation. Each successful REST call that changes state is one operation and sends one update; a multi-cart advance is still one revision. Rejected or failed calls change nothing, send nothing and do not use up a number. An advance with nothing moving still moves the clock, so it counts as an operation. Updates leave the server in revision order. A snapshot's revision is exactly the state it shows, and the first snapshot can't race an update: commits and the connection handler both run on Node's single thread, so every later change reaches the client after its snapshot.

**Client rule.** Hold the revision of the last snapshot or update you applied. For each update, `classifyRevision(held, update.revision)` says:
- `apply`: it is the next revision.
- `stale`: ignore it, you already have it.
- `gap`: something was missed. Don't apply it; ask for a fresh snapshot with `state:snapshot:request` or `GET /api/snapshot`.

After a reconnect the server sends a fresh snapshot anyway.

**Delivery is best effort.** Socket.IO does not store or replay events, so a client that was disconnected misses them and must resync from a snapshot. A committed change is never rolled back because a client didn't receive it. The REST snapshot is always the authority; socket updates are notifications.

**Not included yet:** no authentication or roles (anyone who can reach the port can listen, and there are no CORS options because the demo serves the app and the socket from one origin), no persistence (a restart starts again at revision 0 from the campus and fleet files), and the Ops screen does not use the socket yet (the Student App and Driver Mode do, see below).

### Student App (Phase 3)

Pick a student persona (Lina, Omar or Sara) on the start screen. The Student App lives at `/student` (home: book or follow your ride), `/student/rides` (your rides) and `/student/rides/<request id>` (ride details).

- **Booking:** pickup and destination are chosen from the campus file's stop locations (`canStop`). The app refuses an empty or identical pair, ignores repeated taps while a request is in flight, and re-checks the live state when you tap (no second active ride, same campus as the server). It sends `POST /api/ride-requests` with only `studentId`, `pickupId` and `destinationId`; ids, status, fare and timestamps come from the server. A new request stays `requested` until something dispatches it: nothing in the Student App dispatches, starts, boards or drops off. For now these are driven with the REST calls above (Driver Mode and the Operations Center come next).
- **Live tracking:** one Socket.IO connection for the Student area (`client/src/lib/realtimeStore.ts`), following the client rule above with `classifyRevision`; on a gap it asks for a snapshot over the socket and falls back to `GET /api/snapshot`. REST responses are never written into the live state, so a slow booking response cannot overwrite a newer update.
- **Statuses shown:** Requested, Cart assigned, Cart on the way, Cart at pickup (status `arriving` and the cart is at the pickup), On board, Arrived (status `on_board` and the cart is at the destination), Completed, Cancelled. A student can cancel before boarding (`POST /api/ride-requests/:id/cancel`).
- **Ownership:** rides are filtered by the request's `studentId`. This is presentation only, not security: there is no login, the server does not check `studentId`, and every socket receives the whole state.
- **Fares:** the fare shown on a ride is the server's `fareJod` (0.25 JOD, simulated, no payment). Loyalty (6th ride free) is explained but not tracked: the server always sets `freeLoyaltyRide: false`, so the app never claims a free ride.
- **Map:** the campus file's schematic map, not GPS. It shows the selected stops, and for an active ride only its own cart at the server's position and the leg the server planned. No ETAs are shown (no API exposes them yet).
- History lives in the server's memory and is cleared when the server restarts.

### Driver Mode (Phase 3)

Pick a driver persona (Yazan or Rana) on the start screen to open `/driver`.

- **Your cart:** the cart whose `driverId` (from the fleet file, part of every snapshot) is the driver persona's id. The persona's own `cartId` is only compared, and a mismatch is shown as a warning; Driver Mode follows the live fleet. Battery, range, status, passengers and position are the server's values.
- **Trips:** there is no driver-level ride assignment in the data. Trips name a cart, so Driver Mode shows the open trips (planned, active, cancelling) assigned to your cart, labelled that way. Finished trips are not listed (a cart's `driverId` is its current driver, not who drove earlier trips). The engine allows one open trip per cart; if several ever appear, the driver must pick one.
- **Steps:** Start trip (`POST /api/ride-requests/:id/start`), Confirm boarding (`/board`, once the cart is at the pickup) and Confirm drop-off (`/drop-off`, once it is at the destination), each for the trip's own request id. The button is offered only when the server's own preconditions hold, re-checked just before sending; one step at a time, no retries, and success is shown only after the server answers. The screen itself moves only on Socket.IO updates or snapshots, never from the REST answer.
- **Not in Driver Mode:** dispatching rides and advancing the simulation. Until the Operations Center exists, use `POST /api/ride-requests/:id/dispatch` and `POST /api/simulation/advance`. The cart does not move between those calls.
- Same single realtime connection pattern as the Student App. Filtering by driver is presentation only, not security.

## Structure

One repository, one package, four folders with fixed boundaries (Plan section 5):

```
campus/      Campus config files (fictional until the university is chosen) and fleets/ starting carts per campus
shared/      Zod schemas and types used by every side, approved settings, demo personas
engine/      Pure TypeScript logic (no network, database or timers): campus graph, shortest route, ETA
server/      Fastify: REST endpoints, Socket.IO updates, campus and fleet loading, the one in-memory ride state, serves the built app in demo mode
client/      React + Vite + Tailwind web app
  src/ui/      Design tokens v0 components: brand lockup, pill and icon buttons, badges, campus map
  src/routes/  Persona picker, /student (Student App area and its routes), /driver (Driver Mode), /ops
  src/student/ Student App screens: home and booking, ride status, your rides, ride details, fares
  src/driver/  Driver Mode screens: your cart, the trip assigned to it, start / board / drop-off
  src/lib/     API clients (validated with the shared schemas), realtime store, booking rules, student ride view, persona storage, map geometry
scripts/     dev.mjs: starts the API and the Vite dev server with one command
```

Boundary rules: `engine` imports only from `shared`; `server` wires the engine to the network and holds no business rules; `client` displays what the server sends and never computes a dispatch decision or metric.

## Approved settings

In `shared/settings.ts`: simulated fare 0.25 JOD per ride (shared rides the same), 5 completed paid rides earn the 6th free, 15% battery reserve, 4 minutes maximum added delay for shared rides. Later phases read these; nothing hard-codes them.
