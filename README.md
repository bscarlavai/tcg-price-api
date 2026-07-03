# tcg-price-api

Self-hosted card-pricing service for the Lavai Labs TCG apps (poke-rip, ygo-rip,
mtg-rip, one-rip, lor-rip, fab-rip) and riplist (the scanner). One backend, one
contract, many clients.

- **Read API:** Cloudflare Worker → `prices.lavailabs.com` (KV-backed, edge-cached 24h)
- **Ingest:** daily GitHub Actions cron → TCGCSV archive → KV (current) + D1 (history) + R2 (raw copies)
- **Prime directive:** sources are swappable behind per-game adapters; the API contract
  contains zero source vocabulary, so callers never notice a swap.

**Status:** design complete, nothing built yet. Read [DESIGN.md](DESIGN.md) —
all decisions are resolved there, including rollout order (Pokémon first, validated
against ME03's Spinarak = $0.08).
