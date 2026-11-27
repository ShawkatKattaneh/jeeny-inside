# Jeeny INSIDE: technical reference

The detailed reference moved here from the README (unchanged, apart from the "Updated in the final build" notes). Sections marked with a phase describe the behaviour as it was built in that phase; "Final build additions" lists what the final build added on top. The README covers what the product is and how to run it.

## Swap the campus

The map, locations and paths come from one config file. The default is `campus/fictional-campus.json` (Wadi Cedar University, fictional, 15 locations).

```bash
npm start -- --campus=campus/demo-valley.json     # a second, tiny fictional campus
npm run dev -- --campus=campus/demo-valley.json
```

`CAMPUS_FILE=path/to/campus.json` works too. A real campus is a new JSON file with the same shape (`shared/schemas.ts`, `CampusConfig`); no code changes. The server refuses to start on an invalid file or one with locations no cart can reach, and says why.

## Saved ride state (SQLite, Phase 5)

Rides, carts, trips, Tap-In records, the simulated clock and the realtime revision are saved in a SQLite file, so they survive a server restart. Each campus has its own file by default: `data/<campus id>.sqlite` (for example `data/wadi-cedar.sqlite`). The `data/` folder and SQLite's side files are git-ignored.

```bash
npm start -- --db=data/rehearsal.sqlite     # use another database file
DB_FILE=data/rehearsal.sqlite npm start      # the same, as an environment variable
```

- **First start on a new file:** the schema is created and the carts are copied from the fleet file (`campus/fleets/<campus id>.json`, or `--fleet=` / `FLEET_FILE`), in one step. Requests and trips start empty.
- **Every later start:** the saved state is loaded and checked with every engine rule. The fleet file is not read again, so editing it changes nothing for an existing database.
- **Starting fresh** (for example before a demo): start with a new `--db=` file, or stop the server and move the old file away yourself. The server never deletes, resets or re-seeds an existing database.
- **The server refuses to start, and says why,** if the file is in use by another running server, belongs to another campus, was created from a campus file that has since changed, has a newer schema than this code, is not a Jeeny INSIDE database, or holds rows that break a ride rule. The file is left as it was.
- Every change is written to disk before the API answers. If a write fails, the API returns the generic 500, nothing is published to sockets, and the server keeps the last saved state.
- Stop the server with Ctrl+C: it stops serving and closes the database cleanly.
- Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" at startup. That is Node's notice about its built-in module, not an error.

Schema changes are versioned migrations in `server/migrations.ts` (see the comment there for how to add one).

## Campus analytics (Phase 5)

`GET /api/analytics` (no query parameters) returns descriptive figures computed from the committed ride state (`engine/analytics.ts`; shape and rules in `shared/analytics.ts`). The Operations Center shows them in the "Campus analytics" card, refreshed on every new revision. It is read-only: no write, no revision, no socket update.

- Units are kept apart and named: ride requests, cart trips, rider entries on trips, carts, seats.
- All times use the simulated clock (simulated seconds since the database was created). History is every record in this database.
- Measured: demand by status and mode, pickup and destination activity (separately), request to Tap-In (arrival, not boarding), current elapsed wait, request to drop-off, carts by status, seat occupancy now, trips per cart, cancelled share of finished requests, and plain factual observations.
- Not available, with the reason shown and never displayed as 0: calendar windows (today, 7 or 30 days: records have no wall-clock time), demand over time, request to boarding (boarding time is not saved), dispatch-eligible carts (eligibility depends on the request), utilization over time, and the step at which rides were cancelled.

## Final build additions

| Method | Path | Result |
|---|---|---|
| POST | `/api/trips/:tripId/arrive` | The driver confirms arriving at the trip's current stop. Only while the cart is stopped there; 409 `NOT_AT_STOP`, 409 `ALREADY_ARRIVED`, 404 `UNKNOWN_TRIP`. Records `arrivedAtMs` on the stop (saved, one revision, operation `trip.arrived`). It boards and drops off nobody: those stay separate driver actions, and the Driver app offers boarding and drop-off only after arrival is confirmed. |
| GET | `/api/ride-requests/:id/eta` | The engine's ETA (pickup and destination seconds, simulated driving) and the share of the current leg driven. Read-only. |
| GET/POST | `/api/simulation/auto` | Server-driven simulated movement: body `{ running, speed? }` with speed 1, 2, 5 or 10. While running, the server advances the clock once a second through the same engine `advance`, only while a trip is driving, and publishes each step as a normal revision. Not saved: a restarted server starts paused. Carts still stop at each stop for the driver. |
| POST | `/api/mission/run` | Mission Mode: optional `{ seed, requests, sharedShare }`. Runs the same seeded demand twice on a private copy of the campus and fleet, pooling on (the live engine) and off (all solo), and returns what happened. Never writes. |

- **Loyalty** is now applied by the server: after 5 completed paid rides, the next request is created free (`freeLoyaltyRide: true`, fare 0). Cancelled and free rides do not count; a cancelled free ride leaves the next request free.
- **Positions** are simulated by the server, not GPS; every client draws the same server position. Battery values are the simulated fleet's.
- **Campus Copilot** (Student → Quick) is rule-based: it answers from the campus file, the live ride state and the approved rules, offers only real actions, and uses no AI model.
- **Battery Rescue** and **Campus Flow Shield** (Operations) are rule-based recommendations on the live state (the 15% reserve and simple, stated queue rules), not predictions; nothing is sent to a cart automatically.

## Starting fleet

The server starts with the carts in `campus/fleets/<campus id>.json` (sample data: CART-01 and CART-02, simulated, idle at the depot). Each campus has its own fleet file, so swapping the campus swaps the fleet. `--fleet=path/to/fleet.json` or `FLEET_FILE=...` picks another file. The server refuses to start on a missing file, a fleet for another campus, or any invalid cart, and says why.

## Ride-request API (Phase 2)

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

**Simulated time** moves only when `/api/simulation/advance` is called: a manual demo control, with no timers or real-time movement. Advancing never boards or drops anyone off. The ride state, including the clock, is saved in SQLite and survives restarts (see "Saved ride state").

> **Updated in the final build:** Operations can also start server-driven simulated movement (`/api/simulation/auto`), which calls the same engine `advance` once a second. See "Final build additions" above.

## Realtime updates (Socket.IO)

Socket.IO runs on the same HTTP server and port as the REST API (`server/realtime.ts`, attached in `buildApp` to Fastify's own server). There is no second server. In development, Vite proxies `/socket.io` to the API server, WebSocket included. Closing the app (`app.close()`) first stops publishing, disconnects every socket and closes Socket.IO's engine, then Fastify closes the HTTP server. Each app instance has its own sockets, revision and state.

Sockets only listen. REST is the only way to change anything, and the server handles a single client event: a request for a fresh snapshot.

| Event | Direction | Payload |
|---|---|---|
| `state:snapshot` | server to client, first thing after every connection | `StateSnapshot`: `{ revision, campusId, clockSeconds, requests, trips, carts }`, the whole ride state at that revision |
| `state:update` | server to every connected client, once per committed operation | `StateUpdate`: `{ revision, operation, clockSeconds, requests, trips, carts }`, listing every request, trip and cart the operation changed, each in full as it is after the commit |
| `state:snapshot:request` | client to server, with an acknowledgement callback | The acknowledgement carries a fresh `StateSnapshot` |

Schemas are in `shared/schemas.ts`; event names and `classifyRevision` are in `shared/realtime.ts`. `operation` is one of `ride_request.created`, `ride.dispatched`, `ride.started`, `ride.boarded`, `ride.dropped_off`, `ride.cancelled` or `simulation.advanced`. A cancelled ride's mid-path cleanup finishes inside a `simulation.advanced` update, which shows the trip `cancelled` and the cart `idle`.

**Revision.** The server keeps a counter, saved with the ride state: 0 for a new database, +1 for each committed operation, and after a restart it continues from the saved value. Each successful REST call that changes state is one operation and sends one update; a multi-cart advance is still one revision. Rejected or failed calls change nothing, send nothing and do not use up a number. An advance with nothing moving still moves the clock, so it counts as an operation. Updates leave the server in revision order. A snapshot's revision is exactly the state it shows, and the first snapshot can't race an update: commits and the connection handler both run on Node's single thread, so every later change reaches the client after its snapshot.

**Client rule.** Hold the revision of the last snapshot or update you applied. For each update, `classifyRevision(held, update.revision)` says:
- `apply`: it is the next revision.
- `stale`: ignore it, you already have it.
- `gap`: something was missed. Don't apply it; ask for a fresh snapshot with `state:snapshot:request` or `GET /api/snapshot`.

After a reconnect the server sends a fresh snapshot anyway.

**Delivery is best effort.** Socket.IO does not store or replay events, so a client that was disconnected misses them and must resync from a snapshot. A committed change is never rolled back because a client didn't receive it. The REST snapshot is always the authority; socket updates are notifications.

**Not included yet:** no authentication or roles (anyone who can reach the port can listen, and there are no CORS options because the demo serves the app and the socket from one origin), and no Ops passcode yet (the Student App, Driver Mode and the Operations Center all use the socket, see below).

## Student App (Phase 3)

Pick a student persona (Lina, Omar or Sara) on the start screen. The Student App lives at `/student` (home: book or follow your ride), `/student/rides` (your rides) and `/student/rides/<request id>` (ride details).

- **Booking:** pickup and destination are chosen from the campus file's stop locations (`canStop`). The app refuses an empty or identical pair, ignores repeated taps while a request is in flight, and re-checks the live state when you tap (no second active ride, same campus as the server). It sends `POST /api/ride-requests` with only `studentId`, `pickupId` and `destinationId`; ids, status, fare and timestamps come from the server. A new request stays `requested` until something dispatches it: nothing in the Student App dispatches, starts, boards or drops off. Dispatch happens in the Operations Center, and the trip steps in Driver Mode.
- **Live tracking:** one Socket.IO connection for the Student area (`client/src/lib/realtimeStore.ts`), following the client rule above with `classifyRevision`; on a gap it asks for a snapshot over the socket and falls back to `GET /api/snapshot`. REST responses are never written into the live state, so a slow booking response cannot overwrite a newer update.
- **Statuses shown:** Requested, Cart assigned, Cart on the way, Cart at pickup (status `arriving` and the cart is at the pickup), On board, Arrived (status `on_board` and the cart is at the destination), Completed, Cancelled. A student can cancel before boarding (`POST /api/ride-requests/:id/cancel`).
- **Ownership:** rides are filtered by the request's `studentId`. This is presentation only, not security: there is no login, the server does not check `studentId`, and every socket receives the whole state.
- **Fares:** the fare shown on a ride is the server's `fareJod` (0.25 JOD, simulated, no payment). Loyalty (6th ride free) is explained but not tracked: the server always sets `freeLoyaltyRide: false`, so the app never claims a free ride.
  > **Updated in the final build:** loyalty is now applied by the server (the ride after 5 completed paid rides is free), and the app shows the student's progress.
- **Map:** the campus file's schematic map, not GPS. It shows the selected stops, and for an active ride only its own cart at the server's position and the leg the server planned. No ETAs are shown (no API exposes them yet).
  > **Updated in the final build:** the ride card shows the engine's ETA (`GET /api/ride-requests/:id/eta`).
- History is saved with the ride state and survives a server restart.

## Driver Mode (Phase 3)

Pick a driver persona (Yazan or Rana) on the start screen to open `/driver`.

- **Your cart:** the cart whose `driverId` (from the fleet file, part of every snapshot) is the driver persona's id. The persona's own `cartId` is only compared, and a mismatch is shown as a warning; Driver Mode follows the live fleet. Battery, range, status, passengers and position are the server's values.
- **Trips:** there is no driver-level ride assignment in the data. Trips name a cart, so Driver Mode shows the open trips (planned, active, cancelling) assigned to your cart, labelled that way. Finished trips are not listed (a cart's `driverId` is its current driver, not who drove earlier trips). The engine allows one open trip per cart; if several ever appear, the driver must pick one.
- **Steps:** Start trip (`POST /api/ride-requests/:id/start`), Confirm boarding (`/board`, once the cart is at the pickup) and Confirm drop-off (`/drop-off`, once it is at the destination), each for the trip's own request id. The button is offered only when the server's own preconditions hold, re-checked just before sending; one step at a time, no retries, and success is shown only after the server answers. The screen itself moves only on Socket.IO updates or snapshots, never from the REST answer.
  > **Updated in the final build:** at each stop the driver first confirms arrival (`POST /api/trips/:tripId/arrive`); boarding and drop-off are offered only after that.
- **Not in Driver Mode:** dispatching rides and advancing the simulation. Both are explicit buttons in the Operations Center (below). The cart does not move between advances.
- Same single realtime connection pattern as the Student App. Filtering by driver is presentation only, not security.

## Operations Center (Phase 3)

Pick the operator persona (Hadi) on the start screen to open `/ops`. It is a demo operator interface: there is no sign-in or passcode, so anyone who can open the app can open it.

- **Live counts** from the current snapshot only, kept separate: carts by cart status, ride requests by request status (plus "awaiting dispatch" = `requested`, and "active" = requested, assigned, arriving or on board), trips by trip status, and passengers on board over total seats. No wait times, utilization, revenue, trends or charts.
- **Fleet, requests and trips tables** with each entity's own status, the cart's driver (`driverId`, plus the persona name on an exact match), battery, range, passengers and position. Selecting a row opens its details and highlights it on the map.
- **Dispatch:** each `requested` ride has its own "Dispatch REQ-…" button that sends `POST /api/ride-requests/:id/dispatch`. The dashboard never decides which carts are usable (an idle cart may still be below the battery reserve or have no route); it shows the server's answer, including its explanation of every cart, or its refusal (for example `NO_CART_AVAILABLE` with each cart's reason). One dispatch at a time, no retries, nothing automatic.
- **Simulation:** "Advance N s" sends `POST /api/simulation/advance` with `0 < N ≤ 600`, checked with the same shared schema as the server. One advance at a time. The clock shown is the server's simulation clock (from the live state), not wall-clock time; the success note quotes the clock the server returned. If the socket update has not arrived, the dashboard asks for a snapshot; it never sends a second advance.
- **Map:** every cart at its simulated position, and for the selected ride its pickup, destination and current leg.
- Same single realtime connection pattern as the Student App and Driver Mode; REST answers are never written into the live state.

## Tap-In with NFC and QR (Phase 4)

A student checks in at their assigned pickup point by tapping an NFC tag or scanning a QR code. Both hold the **same plain URL**:

```
http://<public host>:<port>/tap/<campus id>/<location id>      e.g. http://<public host>:3000/tap/wadi-cedar/library
```

The phone's own NFC reader or camera opens it in the browser, on the `/tap` confirmation screen. The student confirms explicitly, and the server records the Tap-In (`POST /api/ride-requests/:requestId/tap-in`, body exactly `{ studentId, campusId, pointId }`). The student app also has an "I'm at my pickup" button on a waiting ride, which opens the same screen.

**What a Tap-In is:** a write-once check-in record (`tappedIn { locationId, atMs }`, server simulation time) on the rider. It is **not boarding**: the driver still boards the rider with their own button, and a Tap-In never changes the ride, the cart, the stops, fares or loyalty. It proves nothing about physical presence or identity: the URLs are public, the student is a demo persona, and there is no login. The driver sees "Tapped in · not boarded"; Operations sees "Tap-In recorded <time> (not verified)".

**Rules (enforced by the server, in this order):** the request exists (404 `UNKNOWN_REQUEST`); the campus is this campus and the point is one of its locations (400 `UNKNOWN_POINT`); the point is a stop (400 `POINT_NOT_SUPPORTED`); `studentId` matches the ride (409 `NOT_YOUR_RIDE`, a consistency check, not authentication); then, if a record already exists, the same point returns the original record with `alreadyRecorded: true` (in any state, even after boarding, drop-off or cancellation) and another point is 409 `PICKUP_MISMATCH`; otherwise the ride must be dispatched and the rider waiting (409 `TAP_IN_NOT_ALLOWED`) and the point must be the assigned pickup (409 `PICKUP_MISMATCH`). A bad body is 400 `INVALID_REQUEST`. Only the first successful Tap-In creates a revision (`ride.tapped_in`); replays and refusals create none.

**Set the public host.** Tap URLs contain the laptop's address, so the server must be told which one to use. Nothing is guessed and no address is built into the code:

```bash
npm start -- --public-host=<the "On phones" address>     # for example the hotspot address, without http:// or a port
PUBLIC_HOST=<address> npm start                            # the same, as an environment variable
```

When the app is hosted at an https address (for example on Replit), set the whole address instead: `PUBLIC_URL=https://<your-app-address>` (or `--public-url=`). It takes precedence over the public host and gives links without a port.

The value must be a bare hostname or IPv4 address; the server refuses to start on anything else. Operations → **Tap Points** lists every pickup point (every location where carts can stop) with its URL, a Copy button and a QR code. Without a public host it shows no URLs.

**Changing the host means rewriting every NFC tag and reprinting every QR code**, because the old address is stored in them. Pick an address that stays the same for the demo (for example the laptop's own hotspot address) before writing tags.

**Preparing tags and codes.** Write each URL to an NFC sticker (for example NTAG213/215) as a plain URL record with any NFC writing app, and print the same URL's QR code from Tap Points next to it.

**Stable location ids.** A materially changed physical pickup point must receive a new `locationId`. An existing id must never be silently reassigned to a materially different physical location, because tags, printed codes and recorded Tap-Ins refer to it. This is a convention for whoever edits campus files; the code does not enforce it.

**Limits of this demo.** The demo runs over plain HTTP on the hotspot. Browser-based NFC reading (Web NFC, Chrome on Android only) and in-app camera scanning both need HTTPS, so neither is used: the phone's own NFC reader and camera open the URL instead. Reading tags with the phone's NFC (Android with NFC on and the screen unlocked; iPhone XS or later) and scanning the printed codes must be tested on the team's phones before the demo. Every socket still receives the whole ride state, including Tap-In records.

## Structure

One repository, one package, four folders with fixed boundaries (Plan section 5):

```
campus/      Campus config files (fictional until the university is chosen) and fleets/ starting carts per campus
shared/      Zod schemas and types used by every side, approved settings, demo personas
engine/      Pure TypeScript logic (no network, database or timers): campus graph, shortest route, ETA
server/      Fastify: REST endpoints, Socket.IO updates, campus and fleet loading, the one ride state (saved in SQLite), serves the built app in demo mode
client/      React + Vite + Tailwind web app
  src/ui/      Design tokens v0 components: brand lockup, pill and icon buttons, badges, campus map
  src/routes/  Persona picker, /student (Student App area and its routes), /driver (Driver Mode), /ops (Operations Center)
  src/student/ Student App screens: home and booking, ride status, your rides, ride details, fares
  src/driver/  Driver Mode screens: your cart, the trip assigned to it, start / board / drop-off
  src/ops/     Operations Center: live counts, fleet / requests / trips, dispatch and simulation controls, details, map
  src/lib/     API clients (validated with the shared schemas), realtime store, booking rules, student ride view, persona storage, map geometry
scripts/     dev.mjs: starts the API and the Vite dev server with one command
```

Boundary rules: `engine` imports only from `shared`; `server` wires the engine to the network and holds no business rules; `client` displays what the server sends and never computes a dispatch decision or metric.

## Approved settings

In `shared/settings.ts`: simulated fare 0.25 JOD per ride (shared rides the same), 5 completed paid rides earn the 6th free, 15% battery reserve, 4 minutes maximum added delay for shared rides. Later phases read these; nothing hard-codes them.
