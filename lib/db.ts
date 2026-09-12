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
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = "sway:leaderboard:v1";

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

async function redisCommand(command: unknown[]): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Leaderboard storage failed (${response.status})`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.result;
}

async function loadPersistent(): Promise<DBShape> {
  if (!REDIS_URL || !REDIS_TOKEN) return load();
  const raw = await redisCommand(["GET", REDIS_KEY]);
  if (!raw) return emptyDB();
  const parsed = JSON.parse(raw);
  return { players: parsed.players || {}, results: parsed.results || {} };
}

async function savePersistent(db: DBShape): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return save(db);
  await redisCommand(["SET", REDIS_KEY, JSON.stringify(db)]);
}

function newPlayer(wallet: string): PlayerRow {
  return { wallet, wins: 0, losses: 0, streak: 0, bestStreak: 0, pnl: 0, updatedAt: 0 };
}

/**
 * Record a settled bet and update the player's aggregates.
 * Idempotent on (wallet, marketId). Returns true if newly recorded, false if dup.
 */
export async function recordResult(r: ResultReport): Promise<boolean> {
  const wallet = r.wallet.toLowerCase();
  const id = `${wallet}:${r.marketId}`;
  const db = await loadPersistent();

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

  await savePersistent(db);
  return true;
}

/** Set a display handle for a wallet. */
export async function setHandle(wallet: string, handle: string): Promise<void> {
  const w = wallet.toLowerCase();
  const db = await loadPersistent();
  const p = db.players[w] || newPlayer(w);
  p.handle = handle.slice(0, 24);
  p.updatedAt = Math.floor(Date.now() / 1000);
  db.players[w] = p;
  await savePersistent(db);
}

/** Ranked leaderboard: most wins, then best streak, then PnL. */
export async function getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  const db = await loadPersistent();
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
export async function getPlayer(wallet: string): Promise<LeaderboardEntry | null> {
  return (await getLeaderboard(10_000)).find((e) => e.wallet === wallet.toLowerCase()) || null;
}
