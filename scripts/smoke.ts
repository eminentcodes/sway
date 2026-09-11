// scripts/smoke.ts — verify the read-only core against live Shannon testnet.
// No funds required. Exercises: discovery → rounds → crowd → leaderboard db.
// Run: npm run smoke
import { config } from "dotenv";
// Env precedence (dotenv won't override an already-set var): repo-root .env.local
// → .env, then _template/.env as a fallback so a fresh clone and the local dev
// setup both work.
for (const p of [".env.local", ".env", "_template/.env"]) config({ path: new URL(`../${p}`, import.meta.url) });

import { discoverMarkets } from "../lib/somnia/markets.ts";
import { getRounds } from "../lib/somnia/rounds.ts";
import { getCrowd } from "../lib/somnia/crowd.ts";
import { recordResult, getLeaderboard } from "../lib/db.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

// 1. Discovery hits the chain and returns markets.
const markets = await discoverMarkets();
check("discoverMarkets returns markets", markets.length > 0, `${markets.length} found`);
check("markets have asset + pool", markets.every((m) => m.asset && m.pool));

// 2. Rounds layer classifies + computes payouts.
const rounds = await getRounds();
check("getRounds returns rounds", rounds.length > 0, `${rounds.length}`);
const withPrice = rounds.find((r) => r.upProbability != null);
if (withPrice) {
  check("payout = 1/price", Math.abs(withPrice.upPayout! - 1 / withPrice.upProbability!) < 0.02);
} else {
  console.log("INFO  no round has a book price yet (empty order book) — payout check skipped");
}
check(
  "phases are valid",
  rounds.every((r) => ["NEXT", "LIVE", "EXPIRED"].includes(r.phase))
);

// 3. Crowd meter math: upPct + downPct = 100.
const c = getCrowd({ upProbability: 0.68 });
check("crowd meter splits to 100", c.upPct + c.downPct === 100, `${c.upPct}/${c.downPct}`);
const c2 = getCrowd({ upProbability: null });
check("crowd meter null → 50/50", c2.upPct === 50 && c2.downPct === 50);

// 4. Leaderboard db: record + rank + idempotency.
const w = "0x1111111111111111111111111111111111111111";
const mkt = "0xsmoke" + Date.now();
recordResult({ wallet: w, marketId: mkt, side: "UP", stake: 10, won: true, payout: 25 });
const dup = recordResult({ wallet: w, marketId: mkt, side: "UP", stake: 10, won: true, payout: 25 });
check("duplicate result is ignored", dup === false);
const board = getLeaderboard(10);
const me = board.find((e) => e.wallet === w);
check("player appears on leaderboard", !!me);
check("pnl computed (+15)", !!me && Math.abs(me.pnl - 15) < 0.001, me ? `pnl=${me.pnl}` : "");

console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
