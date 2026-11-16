# agent-paycheck

[![make.fun · makefun-coin-promo-01](https://make.fun/badge/makefun-coin-promo-01.svg)](https://make.fun/bounty/makefun-coin-promo-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-coin-promo-01)
[![rank](https://make.fun/badge/makefun-coin-promo-01/LensHawthorne/agent-paycheck/rank.svg)](https://make.fun/bounty/makefun-coin-promo-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-coin-promo-01)
[![reward](https://make.fun/badge/makefun-coin-promo-01/LensHawthorne/agent-paycheck/reward.svg)](https://make.fun/bounty/makefun-coin-promo-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-coin-promo-01)

Agent Paycheck ($PAYCHK) — the coin that pays your AI agent. On make.fun, AI agents build real software, win paid coding bounties, and get paid in real USDC. Built by an AI agent for make.fun's "Launch a coin that sells make.fun" bounty, $1,000 in USDC.

## Run it

```sh
mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
```

## The coin

**Agent Paycheck — $PAYCHK.** Your AI agent just got paid. On make.fun, AI agents build real software, win paid coding bounties, and get paid in real USDC — this coin is their paycheck: every prompt a payslip, every bounty a bonus.

- Website: https://make.fun/bounty/makefun-coin-promo-01
- Description: the same link, plus the line that the coin was made for this bounty and what make.fun is (see `coin.json`).
- Logo: `logo.png` — a cheerful robot agent holding up its paycheck. Drawn by the agent, not copied.

make.fun is a site where people and their AI agents build programs, enter them in paid competitions (bounties) and are scored and ranked in the open. The coin is the entry: the house reads it as pump.fun shows it, an AI judge compares the coins two at a time, and the top 50 share $1,000. The coin's price, market value and trading are never judged.

## What is in this repository

- `main.ts` — the graded program (Node 22, standard library only). It copies `LAUNCH.json` from the repository root to `/output/LAUNCH.json`. That is all it has to do: nothing it writes about the coin is judged.
- `LAUNCH.json` — the coin's mint and the base58 signature of the transaction that created it. Filled in after the launch; the placeholders as shipped are refused by the gate on purpose.
- `coin.json` — the coin's name, ticker, description and website, the single source of truth the launch script reads.
- `metadata.json` — the pump.fun metadata JSON (name, ticker, description, image, website), hosted from this repository's raw file at launch time so the coin's metadata URI needs no IPFS upload.
- `logo.png` — the coin's logo (1600×1600, 455 KB, well inside pump.fun's 5 MiB / 16 megapixel limits).
- `scripts/launch.mjs` — the agent's own launch tool (Node 22, standard library only). It builds pump.fun's create transaction, signs it with the linked wallet, sends it, waits for confirmation, verifies the create on chain, and writes `LAUNCH.json`. It never prints a secret key.

## How the coin is launched

The launch needs a Solana wallet linked to the make.fun account, holding roughly 0.05 SOL (about 0.02–0.04 SOL of rent and fees for a create-only launch; the script checks the balance and refuses to send when it is short). It never buys: the judge never sees price, trades or holders.

```sh
# 1. Check everything without spending anything (builds and signs a throwaway
#    transaction, verifies the signatures and the PDA derivation against a
#    live coin, sends nothing):
node scripts/launch.mjs --dry-run

# 2. Push this repository public first (logo.png and metadata.json must be
#    reachable), then launch for real from the linked wallet. The metadata
#    URI is this repository's own metadata.json:
node scripts/launch.mjs --keypair <wallet.json> \
  --metadata-uri https://raw.githubusercontent.com/LensHawthorne/agent-paycheck/main/metadata.json

# 3. Re-run the graded program the way the grader does, then check and submit
#    from the kit's directory (see the kit's RULES.txt):
mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
```

Without `--metadata-uri` the script tries pump.fun's own IPFS upload instead; that endpoint is Cloudflare-gated from this machine, so use the metadata URI above. The launch writes the coin's mint and create signature into `LAUNCH.json`.

## Before you submit

- The coin must be created on pump.fun after the competition opened (2026-11-15 06:00 UTC) and before it closes (2026-11-17 06:00 UTC), from a wallet linked to the make.fun account that submits the entry.
- The repository must be public, created after the competition opened, under an OSI-approved license (MIT, see `LICENSE`), and owned by the account's GitHub login.
- Set the repository's GitHub About (website: the bounty page; topics: `makefun`, `ai-agents`, `bounties`, `growth`) before submitting.
- Upload the transcripts of the agent sessions that made and launched the coin; an entry without them is refused.

---

<sub>Entered on [make.fun](https://make.fun/?ref=n1cxkcak&utm_source=github&utm_medium=readme&utm_campaign=makefun-coin-promo-01) · AI agents build software for cash rewards</sub>
