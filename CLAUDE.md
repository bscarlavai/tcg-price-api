# tcg-price-api — repo conventions & maintenance

Shared pricing backend for the -rip / Riplist TCG apps. Cloudflare Worker (`worker/index.js`) reads
current prices from KV + movers, D1 for per-card history; daily ingest (`ingest/run.js`) pulls TCGCSV
→ normalizes → writes set blobs to KV + history to D1. Live at `rip-prices.lavailabs.com/v1/*`.
Design in `DESIGN.md`.

## Price coverage — CHECK ON OCCASION (new sets + gaps)

The ingest only prices a set if it's in `mapping/<game>.json` (app set-code → TCGCSV group-id). New
sets and promo/side products otherwise ship **price-less** until mapped. Riplist's pack price snapshot
(`riplist/data-pipeline/apply_api_prices.py`) is sourced from THIS API, so an unmapped set is
price-less in the app too. Run this check when a new set releases (before its pack is built) and
periodically (≈monthly) to catch promos/late-added groups:

1. **Find gaps:** `node tools/coverage.js <game>` — the group-centric view (reads riplist's CURRENT
   catalog at `../riplist/Riplist/Resources/CardData`). Lists (a) TCGCSV groups with price data we
   DON'T ingest, each with a best-guess catalog set-code, and (b) catalog sets with no mapping. Writes
   `mapping/<game>.coverage.json`.
   - This is the reliable "what's missing" view. `tools/build-mapping.js` is the older app-set→group
     matcher; it reads sibling `*-rip` apps' `sets.json` which can be STALE (Lorcana's `lor-rip`
     source lagged at 12 sets), and being app-set-driven it can't see groups no app-set pointed at.
2. **Map the clean ones:** for a real gap that matches a single group, add
   `"<setCode>": { "tcgcsv": <groupId>, "name": "<name>" }` to BOTH `mapping/<game>.overrides.json`
   (durable — build-mapping merges overrides and never overwrites them) AND `mapping/<game>.json`
   (what the ingest reads right now). Set-code = the app-native code (One Piece keeps `OP13`, no dash).
   - **DON'T force messy sets.** Promos/reprint sets whose numbering doesn't align 1:1 with a TCGplayer
     group — Lorcana P1/P2/P3, Magic Secret Lair (`SLD`) & The List (`PLST`) — are many-to-many and
     need per-card productId matching (gapfill-style), NOT set→group mapping. Leave them unmapped.
   - Skip empty/future groups (0 products) and groups whose set isn't in the catalog yet (that's a
     riplist catalog gap — add the set there first).
3. **Verify + publish:** `node ingest/run.js --game <game> --sets <codes>` (local → `out/kv/`) to
   confirm cards price, then `node ingest/run.js --game <game> --push` (needs `CF_*` env) to write
   KV/D1.
4. **Refresh the pack snapshot:** in riplist, `python3 data-pipeline/apply_api_prices.py --game <game>`
   then publish the pack. See `riplist/docs/game-packs-design.md` → "Pricing model".

Ground-truth a suspected gap fast: `curl -s -o /dev/null -w '%{http_code}' \
"https://rip-prices.lavailabs.com/v1/prices?game=<g>&set=<code>"` — 404 = genuinely unmapped, 200 =
already priced (coverage false positive, usually a set-code spelling mismatch).

### Known remaining gaps (as of 2026-07-10 coverage pass)

A verified auto-map pass (name match + ≥60% catalog-number alignment) added: **Lorcana** set 13, Q1,
Q2, DLPC; **Magic** +81 (Commander/Duel Decks/From the Vault/Planechase/Masterpiece/etc.); **Pokémon**
+7 (trainer kits, Battle Stadium, TCG Classic, First Partner Pack). **One Piece** was already complete.

Left UNMAPPED on purpose — the "messy" category that name-matching + set→group can't do correctly;
they need **per-card productId matching** (gapfill-style) or a manual per-set decision, not a mapping
entry. Revisit deliberately, don't auto-map:
- **Yu-Gi-Oh (~106 catalog sets):** Duelist League participation cards (DL11–DL23…), Shonen Jump
  subscription promos (JUMP), 2-player starter decks/sets (YS15, STAX), War of the Giants
  Reinforcements (WGRT), and the "Special/Deluxe/Super Edition" reprint products (their base set code
  is already mapped; the SE is a distinct promo product with its own numbering).
- **Magic:** Secret Lair (`SLD`), The List (`PLST`) — rotating/composite numbering across many groups.
- **Lorcana:** promo waves P1/P2/P3, D23, Disney100 — TCGplayer groups by event, catalog by wave, so
  many-to-many with non-aligned numbers.
- Per-game `mapping/<game>.coverage.json` (written by coverage.js) has the full current list.

## Conventions

- **Immutable-ish:** never overwrite a published set blob's meaning silently; the ingest diffs and
  only writes changed sets. `mapping/<game>.overrides.json` always wins and is never auto-overwritten.
- **Finishes** (`ingest/lib/finishes.js`) are API contract vocabulary — may only grow, never change;
  unknown TCGCSV subtypes are collected by the audit, never guessed.
- **Coverage ratchet:** an ingest refuses to promote if coverage drops (DESIGN.md §4). Don't defeat it.
- Match helpers shared by the mapping tools live in `tools/lib/match.js` (used by both
  `build-mapping.js` and `coverage.js`) — don't re-inline them.
