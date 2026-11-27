import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { loadCampus } from "./campus.js";
import { defaultDatabaseFile } from "./database.js";
import { defaultFleetFile, loadFleet } from "./fleet.js";
import { lanAddresses, parsePublicHost, parsePublicUrl, tapBaseUrlFor } from "./network.js";
import { openAppStore } from "./state.js";

// Plain CLI flags instead of env-var prefixes so the same commands work on Windows, macOS and Linux.
const args = process.argv.slice(2);
const isProd = args.includes("--demo") || process.env.NODE_ENV === "production";
const campusArg = args.find((a) => a.startsWith("--campus="))?.slice("--campus=".length);
const fleetArg = args.find((a) => a.startsWith("--fleet="))?.slice("--fleet=".length);
const dbArg = args.find((a) => a.startsWith("--db="))?.slice("--db=".length);
const PORT = Number(process.env.PORT ?? (isProd ? 3000 : 3001));
// 0.0.0.0 so phones on the laptop's hotspot can connect, not just localhost.
const HOST = process.env.HOST ?? "0.0.0.0";

// Phase 4 Tap-In: the address NFC tags and QR codes will open. Never guessed: set it to the "On phones"
// address. Changing it later means rewriting every tag and reprinting every QR code.
const publicHostArg = args.find((a) => a.startsWith("--public-host="))?.slice("--public-host=".length);
const publicHost = parsePublicHost(publicHostArg ?? process.env.PUBLIC_HOST);
if (!publicHost.ok) {
  console.error(`\n  Invalid public host for Tap-In links: ${publicHost.message}.\n  Use --public-host=<address> or PUBLIC_HOST=<address>, for example the "On phones" address without http:// or a port.\n`);
  process.exit(1);
}

// Hosted deployments (Replit): the public https address, with no port. Takes precedence over the host above.
const publicUrlArg = args.find((a) => a.startsWith("--public-url="))?.slice("--public-url=".length);
const publicUrl = parsePublicUrl(publicUrlArg ?? process.env.PUBLIC_URL);
if (!publicUrl.ok) {
  console.error(`\n  Invalid public URL for Tap-In links: ${publicUrl.message}.\n  Use --public-url=<https://your-app-address> or PUBLIC_URL=<https://your-app-address>.\n`);
  process.exit(1);
}

const campus = loadCampus(campusArg);

// Phase 5: the ride state is saved in SQLite. Startup order: open the file, apply its settings, upgrade
// the schema, check it, load and validate the saved state; only a brand-new empty database is seeded,
// from the fleet file (which is read only then). The server listens only after all of that succeeded.
const dbFile = resolve(process.cwd(), dbArg ?? process.env.DB_FILE ?? defaultDatabaseFile(campus.id));
const fleetFile = fleetArg ?? process.env.FLEET_FILE ?? defaultFleetFile(campus.id);
let opened: ReturnType<typeof openAppStore>;
try {
  opened = openAppStore({ campus, databaseFile: dbFile, loadSeedFleet: () => loadFleet(campus, fleetArg), seededFrom: fleetFile });
} catch (err) {
  console.error(`\n  The server did not start: ${(err as Error).message}\n  Database: ${dbFile} (choose another with --db=<file> or DB_FILE=<file>)\n`);
  process.exit(1);
}
const { store } = opened;

const webPort = isProd ? PORT : Number(process.env.CLIENT_PORT ?? 5173);
const tapBaseUrl = publicUrl.url ?? tapBaseUrlFor(publicHost.host, webPort);
// The one app, and so the one authoritative ride state, for this server process.
const app = await buildApp({ store, clientDir: isProd ? "dist" : undefined, logger: false, tapBaseUrl });
await app.listen({ port: PORT, host: HOST });

// Graceful stop (Ctrl+C, or a dev-mode restart): stop serving, then close the database. Every commit is
// already on disk before it was answered, so this only releases the file cleanly.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
  } finally {
    store.close();
    console.log(`\n  Jeeny INSIDE server stopped (${signal}); database closed.`);
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`\n  Jeeny INSIDE server ready (${isProd ? "demo build" : "dev API"})`);
console.log(`  Campus: ${campus.name}${campus.fictional ? " (fictional)" : ""}, ${campus.locations.length} locations`);
const cartCount = store.read((s) => s.fleet.carts.size);
console.log(`  Fleet: ${cartCount} simulated cart${cartCount === 1 ? "" : "s"}`);
console.log(opened.created
  ? `  Database: ${dbFile} (new, seeded from ${fleetFile})`
  : `  Database: ${dbFile} (restored at revision ${opened.revision})`);
if (isProd) {
  console.log(`  On this laptop:  http://localhost:${webPort}`);
  for (const ip of lanAddresses()) console.log(`  On phones:       http://${ip}:${webPort}`);
  console.log("");
}
console.log(tapBaseUrl
  ? `  Tap-In links:    ${tapBaseUrl}/tap/${campus.id}/<point> (changing this host means rewriting NFC tags and reprinting QR codes)\n`
  : "  Tap-In links:    no public address set. Use --public-host=<On phones address>, or PUBLIC_URL=<https address> when hosted, to show tap URLs in Operations.\n");
