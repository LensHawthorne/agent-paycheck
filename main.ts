// Agent Paycheck — entry for make.fun's "Launch a coin that sells make.fun" bounty.
// Node 22, standard library only.
//
// The coin itself is the entry: the house reads it as pump.fun shows it (its logo,
// name, ticker, description and links) and an AI judge compares the coins two at a
// time. This program does the one thing the grader asks of it: it hands the house
// LAUNCH.json, the file at the repository root that names the coin's mint and the
// signature of the transaction that created it.
//
// It copies LAUNCH.json byte for byte from the repository to /output, so two runs
// write the same bytes. It uses no network, no wall clock, and no file outside the
// repository. It prints nothing on success and exits non-zero on failure.
//
// Run it the way the grader does:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? "/bot";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const source = join(BOT_DIR, "LAUNCH.json");
const target = join(OUTPUT_DIR, "LAUNCH.json");

try {
  const bytes = readFileSync(source);
  // The file must at least be JSON naming a mint and a create signature.
  // Placeholders are fine here: the gate refuses them, but the program still
  // runs, so a build can be checked before the coin is launched.
  const launch = JSON.parse(bytes.toString("utf8"));
  if (typeof launch !== "object" || launch === null || !("mint" in launch) || !("create_signature" in launch)) {
    throw new Error("LAUNCH.json must be a JSON object with mint and create_signature");
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(target, bytes);
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`main.ts: could not copy ${source} to ${target}: ${reason}`);
  process.exit(1);
}
