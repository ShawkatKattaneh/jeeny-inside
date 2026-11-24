import { buildApp } from "./app.js";
import { loadCampus } from "./campus.js";
import { loadFleet } from "./fleet.js";
import { lanAddresses } from "./network.js";

// Plain CLI flags instead of env-var prefixes so the same commands work on Windows, macOS and Linux.
const args = process.argv.slice(2);
const isProd = args.includes("--demo") || process.env.NODE_ENV === "production";
const campusArg = args.find((a) => a.startsWith("--campus="))?.slice("--campus=".length);
const fleetArg = args.find((a) => a.startsWith("--fleet="))?.slice("--fleet=".length);
const PORT = Number(process.env.PORT ?? (isProd ? 3000 : 3001));
// 0.0.0.0 so phones on the laptop's hotspot can connect, not just localhost.
const HOST = process.env.HOST ?? "0.0.0.0";

const campus = loadCampus(campusArg);
const fleet = loadFleet(campus, fleetArg);
// The one app, and so the one authoritative ride state, for this server process.
const app = await buildApp({ campus, fleet, clientDir: isProd ? "dist" : undefined, logger: false });
await app.listen({ port: PORT, host: HOST });

const webPort = isProd ? PORT : Number(process.env.CLIENT_PORT ?? 5173);
console.log(`\n  Jeeny INSIDE server ready (${isProd ? "demo build" : "dev API"})`);
console.log(`  Campus: ${campus.name}${campus.fictional ? " (fictional)" : ""}, ${campus.locations.length} locations`);
console.log(`  Fleet: ${fleet.carts.size} simulated cart${fleet.carts.size === 1 ? "" : "s"}`);
if (isProd) {
  console.log(`  On this laptop:  http://localhost:${webPort}`);
  for (const ip of lanAddresses()) console.log(`  On phones:       http://${ip}:${webPort}`);
  console.log("");
}
