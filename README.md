# tcg-price-api

Self-hosted card-pricing service for the Lavai Labs TCG apps (poke-rip, ygo-rip,
mtg-rip, one-rip, lor-rip, fab-rip) and riplist (the scanner). One backend, one
contract, many clients.

- **Read API:** Cloudflare Worker → `prices.lavailabs.com` (KV-backed, edge-cached 24h)
- **Ingest:** daily GitHub Actions cron → TCGCSV → KV (current) + D1 (history); R2 raw copies come with the archive backfill
- **Prime directive:** sources are swappable behind per-game adapters; the API contract
  contains zero source vocabulary, so callers never notice a swap.

**Status:** LIVE at `https://prices.lavailabs.com` with five games (~107k cards):
pokemon, yugioh, magic, onepiece, lorcana. Daily ingest 21:37 UTC via GitHub Actions.

- **[docs/API.md](docs/API.md)** — endpoint reference: params, valid values, shapes, semantics
- **[DESIGN.md](DESIGN.md)** — architecture + every resolved decision
- **[SETUP.md](SETUP.md)** — one-time Cloudflare/GitHub provisioning (done)
- **[docs/riplist-catalog-learnings.md](docs/riplist-catalog-learnings.md)** — upstream sharp edges, adopted in §8c of the design
