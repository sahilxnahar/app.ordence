// ⚠️ WORKAROUND — drizzle-kit hits "TypeError: Do not know how to
// serialize a BigInt" when pulling the live schema because several
// tables carry bigint columns and drizzle-kit JSON-encodes metadata.
// The fix is a one-line toJSON override, applied BEFORE the CLI loads.
BigInt.prototype.toJSON = function () {
  return Number(this);
};

import { execFileSync } from "node:child_process";

execFileSync(process.execPath, ["node_modules/drizzle-kit/bin.cjs", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: import.meta.dirname + "/..",
});
