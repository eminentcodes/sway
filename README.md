# Sway — tap the crowd

**A phone-first prediction game on [Somnia](https://somnia.network) × DreamDEX Event Contracts.**
Pick a live BTC/ETH round, tap **UP** or **DOWN**, and lock your payout the instant you enter —
then watch the crowd sway. Built for the Somnia × DreamDEX Event Contracts Hackathon. Runs on
the Shannon testnet (chain `50312`) — testnet funds only, never real money.

> One card. One tap. One clean outcome. No leverage, no liquidations, no parimutuel dilution.

---

## What it is

Sway turns DreamDEX **Event Contracts** into a fast, social ritual. Each "round" is a short
market window on a real asset ("BTC — next 15 min"):

- **NEXT** — open and enterable. Tap UP or DOWN; a real on-chain **taker order** is placed and
  your payout multiple is **locked at entry** by the order book.
- **LIVE** — the window is running. You can **cash out early** by selling your position back to
  the book (an edge a parimutuel pool structurally can't offer).
- **EXPIRED** — the market resolves on-chain; winners **redeem** their collateral.

Around the core loop sits a light social layer: a **crowd meter** (the order-book price *is* the
crowd's implied probability), a **leaderboard** (wins / streak / PnL), and **shareable result
cards** (`/u/[wallet]`).

### What makes it different

- **Locked-in payout.** The order book sets your multiple when you enter — it doesn't dilute
  later because someone else joins.
- **Cash Out.** Leave a round before it resolves. Sway quotes a live exit price by walking the
  resting bids on your side, and sells the full held size as an IOC taker. Honest about thin
  books: if nobody's bidding your side, it says *"no offers yet"* rather than faking a price.
- **"Sway the line."** The round's implied-probability history, charted as OHLC — because the
  order-book price of the UP token is a money-weighted probability, the line *is* the crowd's
  belief moving in real time.

---

## Architecture

Sway is a Next.js (App Router) app. The **core** — everything that touches the chain — is a set
of small, typed wrappers around the official [`@somnia-chain/markets-sdk`](https://www.npmjs.com/package/@somnia-chain/markets-sdk); the UI only ever calls those wrappers or
the `/api/*` routes, never the SDK directly.

```
app/
  api/**            HTTP routes (server) — rounds, bet, cashout, position, leaderboard, result, share, series
  (ui)/**           the phone-first UI (client)
lib/
  types.ts          the shared contract — every shape the UI and API exchange
  db.ts             file-backed JSON leaderboard store (no native deps)
  somnia/
    config.ts       PUBLIC, client-safe constants (chain, addresses, URLs, fee config)
    client.ts       SERVER-ONLY exchange (holds PRIVATE_KEY) — never imported by the browser
    browser.ts      CLIENT-SAFE: binds the visitor's wallet (viem WalletClient) to sign as them
    markets.ts      discover live markets (scans MarketCreated logs) + tradability
    rounds.ts       round framing (NEXT/LIVE/EXPIRED), payouts, "Sway the line" series
    trade.ts        placeBet / positionValue / sellPosition / redeemWinnings
    crowd.ts        crowd-meter math (pure)
    stream.ts       poll-based live updates for a market
scripts/            discover / smoke (read-only checks) / trade-live (needs a funded key)
```

**Two ways a bet is signed** (both call the same `lib/somnia` functions):

- **Path A — the visitor's own wallet (preferred).** The browser binds a wagmi/viem
  `WalletClient` via `bindWallet()` and signs client-side, so the leaderboard identity is really
  theirs. No private key ever reaches the browser bundle.
- **Path B — server-key fallback.** `POST /api/bet` (and `/api/cashout`) sign with a shared
  server dev key — handy for a no-wallet quick demo.

**Settlement.** There is **no custom Sway contract**. Markets are collateralized and
oracle-resolved by DreamDEX; `redeemWinnings()` simply wraps the SDK's `redeem()`. Winners are
paid from the market's own collateral — Sway never custodies funds.

---

## Getting started

**Prerequisites:** Node 18+ and a Shannon testnet wallet key funded with test **tUSDC**
(collateral) and **STT** (gas), from the SomniaHacks dev group: <https://t.me/+XHq0F0JXMyhmMzM0>
(faucet topic).

```bash
npm install
cp .env.example .env.local        # then fill in PRIVATE_KEY
npm run dev                        # http://localhost:3000
```

### Scripts

| Command | What it does | Needs funds? |
|---|---|---|
| `npm run dev` | Run the app locally | no (reads are keyless-ish; bets need a key) |
| `npm run build` | Production build (also type-checks) | no |
| `npm run typecheck` | `tsc --noEmit` — verify the whole project type-checks | no |
| `npm run discover` | List the live rounds via the real core | no |
| `npm run smoke` | Read-only end-to-end check (discovery → rounds → crowd → leaderboard) | no |
| `npm run trade:live` | Place a real testnet bet end-to-end | **yes** (funded key) |

> Both the Next app and the helper scripts (`discover` / `smoke` / `trade:live`) read
> `.env.local` at the repo root, so a single root `.env.local` holding your `PRIVATE_KEY` is all
> you need. (The scripts additionally fall back to a local `_template/.env` if one exists, without
> overriding anything already set — handy for the in-repo dev setup.)

---

## The market fee (dormant by default)

Sway can take a small cut on each **entry** — routed **on-chain** through the protocol's native
**builder-fee** rail to a treasury address, not a hidden rake. It is **off** until you set a
treasury address, so the demo runs fee-free out of the box.

```bash
# Enable a 1% entry fee to a treasury you control:
NEXT_PUBLIC_SWAY_BUILDER_ADDRESS=0xYourTreasury
NEXT_PUBLIC_SWAY_BUILDER_FEE_BPS_TIMES_1K=100000   # 100000 = 100 bps = 1%
NEXT_PUBLIC_SWAY_BUILDER_FEE_ENABLED=true
```

When on, the fee is clamped to the pool's frozen ceiling, the wallet approves the builder **once
per pool**, and a winning `BetResult` carries `feeRate` + `fee` for honest on-screen disclosure.
Exits (cash-outs) are never charged.

---

## Status

This is a hackathon prototype on **testnet only**.

- **Core (`lib/**`, `app/api/**`, `lib/types.ts`)** — built: discovery, rounds, betting,
  cash-out, redeem, the probability series, the leaderboard store, and both signing paths.
  Verify with `npm run typecheck` and `npm run smoke`.
- **Frontend (`app/(ui)/**`)** — in progress: the marketing/landing screen is wired to live
  round + leaderboard data; the full tabbed in-app experience (bet-confirm, wallet connect,
  positions/redeem, cash-out UI, the chart) is the next sprint. See `AGENT.md` for the interface
  contract and `PROJECT_PLAN.md` / `FRONTEND_PLAN.md` for scope.

## Security

- **No secrets in client code.** The server key lives only in `lib/somnia/client.ts` (server) and
  is never imported by the browser bundle; `lib/somnia/config.ts` / `browser.ts` carry public
  values only. Wallet signing goes through the user's injected wallet.
- **Testnet only.** All addresses, keys, and balances here are Shannon testnet.

## Built on

[Somnia](https://somnia.network) Shannon testnet · DreamDEX Event Contracts ·
[`@somnia-chain/markets-sdk`](https://www.npmjs.com/package/@somnia-chain/markets-sdk) ·
Next.js · viem / wagmi.
