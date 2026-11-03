# SLOTH

The fastest chain. The slowest wallet.

SLOTH is a savings vault on Solana. Every withdrawal needs two of three keys and then waits 24 hours, 3 days or 7 days on-chain, so one stolen key can't empty it.

- Site: https://slothvault.xyz
- App: https://slothvault.xyz/app/
- Docs: https://slothvault.xyz/docs/

## How it works

A vault is a [Squads v4](https://github.com/Squads-Protocol/v4) multisig (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`):

| Setting | Value |
|---|---|
| Threshold | 2 of 3 |
| Main, backup | all permissions |
| Guardian | vote only |
| Time lock | 86,400 s, 259,200 s or 604,800 s |
| Config authority | none |
| Rent collector | the vault |

SLOTH has no program and no key of its own. The site builds transactions, your wallet signs them, and the Squads program enforces the rules. If the site goes away, any Squads v4 tool opens the vault with the same keys.

## Layout

```
vault/   core logic (sloth.mjs), browser UI (app.js), tests
site/    static site: landing, /app/, /docs/
worker/  Cloudflare Worker: serves site/ and an /rpc allowlist proxy
brand/   logo and social images
```

## Run

```
cd vault
npm install
node test.mjs      # offline tests
node build.mjs     # bundles app.js into site/app/app.js
```

`live-check.mjs` runs the full flow on mainnet with throwaway keys and a 60-second wait. It spends real SOL: read it before running.

The worker needs one secret, `SOL_RPC_URL`. `/rpc` accepts single POST calls to a short list of read and send methods.

```
cd worker
npm install
npx wrangler secret put SOL_RPC_URL
npx wrangler deploy
```

## Limits

Two stolen keys can approve a move, and the third can't cancel alone. Two lost keys lock the funds. Nothing here is audited except Squads v4 itself. Start small.

## License

MIT
