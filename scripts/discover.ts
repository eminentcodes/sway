// scripts/discover.ts — list current rounds via the real core (lib/somnia).
// Read-only, no funds needed. Run: npm run discover
import { config } from "dotenv";
// Env precedence (dotenv won't override an already-set var): repo-root .env.local
// → .env, then _template/.env as a fallback so a fresh clone and the local dev
// setup both work.
for (const p of [".env.local", ".env", "_template/.env"]) config({ path: new URL(`../${p}`, import.meta.url) });

import { getRounds } from "../lib/somnia/rounds.ts";

const rounds = await getRounds();
console.log(`\n${rounds.length} round(s) live:\n`);
for (const r of rounds) {
  const mins = Math.round(r.secondsToExpiry / 60);
  const up = r.upProbability == null ? "—" : `${Math.round(r.upProbability * 100)}%`;
  const pay = r.upPayout == null ? "—" : `${r.upPayout}x/${r.downPayout}x`;
  console.log(
    `${r.asset.padEnd(4)} [${r.phase.padEnd(7)}] up=${up.padStart(4)} payout(up/dn)=${pay.padEnd(12)} ` +
      `expires in ${mins}min  ${r.marketId.slice(0, 12)}…`
  );
}
process.exit(0);
