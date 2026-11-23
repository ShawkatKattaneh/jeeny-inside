// One command for development: starts the API server and the Vite dev server together.
// No extra dependency: just two child processes that stop together.
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

// Pass extra flags through, e.g. `npm run dev -- --campus=campus/demo-valley.json`.
const extra = process.argv.slice(2);
const procs = [
  spawn("npx", ["tsx", "watch", "server/index.ts", ...extra], { stdio: "inherit", shell: process.platform === "win32" }),
  spawn("npx", ["vite"], { stdio: "inherit", shell: process.platform === "win32" }),
];

const ips = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
setTimeout(() => {
  console.log("\n  Open on this laptop: http://localhost:5173");
  for (const ip of ips) console.log(`  Open on phones:      http://${ip}:5173`);
  console.log("");
}, 1500);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill("SIGTERM");
  process.exit(code);
}
for (const p of procs) p.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
