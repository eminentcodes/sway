// lib/db.ts — tiny file-backed JSON store for the leaderboard (decision D3).
//
// Chosen over SQLite deliberately: no native build step (better-sqlite3 needs a
// C++ toolchain we don't want as a dependency), trivial to deploy, and more than
// enough for hackathon scale. Same exported interface either way, so API routes
// and the smoke test are unaffected.
//
// Concurrency note: Next dev/serverless may run multiple workers. We keep an
// in-memory cache, reload-before-write, and write atomically (tmp + rename) to
// keep the file consistent for a demo. Identity = wallet address (lowercased).
//
// Server-only. Never import from client UI.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { LeaderboardEntry, ResultReport } from "./types";

const DB_PATH = process.env.SWAY_DB_PATH || "data/sway.json";

interface PlayerRow {
  wallet: string;
  handle?: string;
  wins: number;
  losses: number;
  streak: number;
  bestStreak: number;
  pnl: number;
  updatedAt: number;
}
interface DBShape {
  players: Record<string, PlayerRow>;
  // recorded result ids ("wallet:marketId") for idempotency
  results: Record<string, true>;
}

function emptyDB(): DBShape {
  return { players: {}, results: {} };
}

function load(): DBShape {
  try {
    if (!existsSync(DB_PATH)) return emptyDB();
    const raw = readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { players: parsed.players || {}, results: parsed.results || {} };
  } catch {
    return emptyDB();
  }
}

function save(db: DBShape): void {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH); // atomic replace
}

function newPlayer(wallet: string): PlayerRow {
  return { wallet, wins: 0, losses: 0, streak: 0, bestStreak: 0, pnl: 0, updatedAt: 0 };
}

/**
 * Record a settled bet and update the player's aggregates.
 * Idempotent on (wallet, marketId). Returns true if newly recorded, false if dup.
 */
export function recordResult(r: ResultReport): boolean {
  const wallet = r.wallet.toLowerCase();
  const id = `${wallet}:${r.marketId}`;
  const db = load(); // reload-before-write to reduce lost updates across workers

  if (db.results[id]) return false; // duplicate — don't double-count
  db.results[id] = true;

  const p = db.players[wallet] || newPlayer(wallet);
  p.wins += r.won ? 1 : 0;
  p.losses += r.won ? 0 : 1;
  p.streak = r.won ? p.streak + 1 : 0;
  p.bestStreak = Math.max(p.bestStreak, p.streak);
  p.pnl += r.won ? (r.payout ?? 0) - r.stake : -r.stake;
  p.updatedAt = Math.floor(Date.now() / 1000);
  db.players[wallet] = p;

  save(db);
  return true;
}

/** Set a display handle for a wallet. */
export function setHandle(wallet: string, handle: string): void {
  const w = wallet.toLowerCase();
  const db = load();
  const p = db.players[w] || newPlayer(w);
  p.handle = handle.slice(0, 24);
  p.updatedAt = Math.floor(Date.now() / 1000);
  db.players[w] = p;
  save(db);
}

/** Ranked leaderboard: most wins, then best streak, then PnL. */
export function getLeaderboard(limit = 50): LeaderboardEntry[] {
  const db = load();
  return Object.values(db.players)
    .filter((p) => p.wins + p.losses > 0)
    .sort((a, b) => b.wins - a.wins || b.bestStreak - a.bestStreak || b.pnl - a.pnl)
    .slice(0, limit)
    .map((p, i) => ({
      wallet: p.wallet,
      handle: p.handle || undefined,
      wins: p.wins,
      losses: p.losses,
      streak: p.streak,
      bestStreak: p.bestStreak,
      pnl: Math.round(p.pnl * 100) / 100,
      rank: i + 1,
    }));
}

/** One player's standing (for "your rank"), or null if unseen. */
export function getPlayer(wallet: string): LeaderboardEntry | null {
  return getLeaderboard(10_000).find((e) => e.wallet === wallet.toLowerCase()) || null;
}
