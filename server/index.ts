import { buildApp } from "./app.js";
import { loadCampus } from "./campus.js";
import { loadFleet } from "./fleet.js";
import { lanAddresses, parsePublicHost, tapBaseUrlFor } from "./network.js";

// Plain CLI flags instead of env-var prefixes so the same commands work on Windows, macOS and Linux.
const args = process.argv.slice(2);
const isProd = args.includes("--demo") || process.env.NODE_ENV === "production";
const campusArg = args.find((a) => a.startsWith("--campus="))?.slice("--campus=".length);
const fleetArg = args.find((a) => a.startsWith("--fleet="))?.slice("--fleet=".length);
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

const campus = loadCampus(campusArg);
const fleet = loadFleet(campus, fleetArg);
const webPort = isProd ? PORT : Number(process.env.CLIENT_PORT ?? 5173);
const tapBaseUrl = tapBaseUrlFor(publicHost.host, webPort);
// The one app, and so the one authoritative ride state, for this server process.
const app = await buildApp({ campus, fleet, clientDir: isProd ? "dist" : undefined, logger: false, tapBaseUrl });
await app.listen({ port: PORT, host: HOST });

console.log(`\n  Jeeny INSIDE server ready (${isProd ? "demo build" : "dev API"})`);
console.log(`  Campus: ${campus.name}${campus.fictional ? " (fictional)" : ""}, ${campus.locations.length} locations`);
console.log(`  Fleet: ${fleet.carts.size} simulated cart${fleet.carts.size === 1 ? "" : "s"}`);
if (isProd) {
  console.log(`  On this laptop:  http://localhost:${webPort}`);
  for (const ip of lanAddresses()) console.log(`  On phones:       http://${ip}:${webPort}`);
  console.log("");
}
console.log(tapBaseUrl
  ? `  Tap-In links:    ${tapBaseUrl}/tap/${campus.id}/<point> (changing this host means rewriting NFC tags and reprinting QR codes)\n`
  : "  Tap-In links:    no public host set. Start with --public-host=<On phones address> to show tap URLs in Operations.\n");
