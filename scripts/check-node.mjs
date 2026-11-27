// Startup check for hosted runs (Replit and others): the server saves rides with Node's built-in SQLite
// module, which needs Node.js 22.13+ (22.x) or 23.4+. Prints a clear message instead of a stack trace.
const [major, minor] = process.versions.node.split(".").map(Number);
const ok = (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24;
if (!ok) {
  console.error(`\n  Jeeny INSIDE needs Node.js 22.13 or newer (found ${process.versions.node}).\n  On Replit, keep modules = ["nodejs-22"] in .replit (or choose a newer Node.js module) and run again.\n`);
  process.exit(1);
}
try {
  await import("node:sqlite");
} catch {
  console.error(`\n  This Node.js (${process.versions.node}) has no built-in SQLite module (node:sqlite). Use Node.js 22.13 or newer.\n`);
  process.exit(1);
}
