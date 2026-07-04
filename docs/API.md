# API Reference

Base URL: **`https://prices.lavailabs.com`** (the only URL that ships in app binaries).
All endpoints are `GET`, return JSON, and are open (no auth). Per-IP rate limit:
**200 requests / 60s** → `429 {"error":"rate limited"}`.

All prices are **USD dollars** (floats, 2dp); every priced payload carries
`currency: "USD"` and `updatedAt` (ISO timestamp of the ingest that produced it).

## Enums

| Param | Valid values |
|---|---|
| `game` | `pokemon` `yugioh` `magic` `onepiece` `lorcana` (`fab` reserved, not ingested yet; `all` valid only on `/v1/movers`) |
| finish keys | `normal` `holo` `reverseHolo` `firstEdition` `firstEditionHolo` `unlimited` `unlimitedHolo` `limited` `foil` |
| `window` (movers) | `7d` `30d` |
| `window` (history) | `7d` `30d` `90d` `180d` (default `90d`) |
| `dir` (movers) | `gainers` `losers` (omit for both) |

**`set` and `number` are app-native** — send exactly what your bundle uses:

| game | `set` example | `number` example | notes |
|---|---|---|---|
| pokemon | `me3`, `base1`, `svp` | `1`, `121`, `TG1` | leading zeros + `/total` suffix normalized away |
| yugioh | `PHNI`, `LOB` | `PHNI-EN059` | full printed code, verbatim |
| magic | `EMN`, `LEA` | `6` | Scryfall collector number; pre-2002 sets have none → use `name` |
| onepiece | `OP01`, `ST05`, `EB01` | `OP01-001` | dashes kept, verbatim |
| lorcana | `1` … `12` | `42` | `/204`-style suffix normalized away |

## Semantics that matter

- **404 on a set = unmapped set.** **Absent card in a 200 = known but unpriced**
  (TCGPlayer publishes no market aggregate — e.g. Alpha Black Lotus). Never hide a card
  because it has no price.
- **Headline `market`/`low`** on a card = the game's default finish (first present in
  the finish order above, e.g. pokemon prefers `normal`). The same finish also appears
  inside `finishes` when more than one exists, so finish-keyed clients need no
  default-finish logic.
- **`variants`** = same collector number, different printing, keyed by the game's own
  descriptor: yugioh rarity reprints (`"Quarter Century Secret Rare"`), one piece
  parallels (`"Parallel"`, `"Alternate Art"`). Headline always comes from the base
  printing; look up your card's rarity/parallel in `variants`.
- **`byName`** (magic pre-2002 only): cards with no upstream collector number, keyed by
  lowercased name (trailing parenthetical stripped). Same-name art variants resolve to
  the cheapest.

## Endpoints

### `GET /v1/prices?game=&set=` — whole set (the batch primitive)
Cache: 24h edge + client. One request prices an entire set for every user at once —
prefer this over per-card calls.
```jsonc
// /v1/prices?game=pokemon&set=me3
{
  "game": "pokemon", "set": "me3",
  "updatedAt": "2026-07-03T23:30:00Z", "currency": "USD",
  "cards": {
    "1":   { "market": 0.08, "low": 0.01,
             "finishes": { "normal": {"market":0.08,"low":0.01},
                           "reverseHolo": {"market":0.17,"low":0.01} } },
    "121": { "market": 152.02, "low": 147.48 }
  }
  // magic pre-2002 sets additionally: "byName": { "forest": {"market":31.51,"low":21.5} }
}
```
Errors: `400` missing/invalid params · `404` unmapped set.

### `GET /v1/price?game=&set=&number=` — single card
Cache: 24h. `number` optional if `name` given (magic byName fallback:
`/v1/price?game=magic&set=LEA&name=Forest`).
```jsonc
// /v1/price?game=yugioh&set=PHNI&number=PHNI-EN008
{ "game":"yugioh", "set":"PHNI", "number":"PHNI-EN008",
  "market":0.81, "low":0.30,
  "variants": { "Ultra Rare":{"market":0.81,"low":0.30},
                "Quarter Century Secret Rare":{"market":15.30,"low":13.91} },
  "currency":"USD", "updatedAt":"2026-07-03T23:30:00Z" }
```
Errors: `400` · `404` unmapped set OR unpriced/unknown card.

### `GET /v1/movers?game=&window=[&dir=]` — daily gainers/losers leaderboards
Cache: 1h. `game=all` for the cross-game board. Precomputed once daily after ingest;
max 50 per direction. **No `name` field** — resolve names from your bundled catalog.
Boards are strict: empty (`computedAt: null`) until history covers the full window.
Base printings only (no variants) in v1. Guardrails: ending market ≥ $2, both window
endpoints required, ranked by a %-change · log(abs-$) blend.
```jsonc
// /v1/movers?game=all&window=7d&dir=gainers
{ "window":"7d", "computedAt":"2026-07-10",
  "gainers":[ { "game":"pokemon","set":"me3","number":"121","finish":"normal",
                "market":152.02,"pctChange":12.4,"absChange":16.80 } ] }
```
Errors: `400` bad game/window.

### `GET /v1/history?game=&set=&number=[&finish=][&variant=][&window=]` — per-card series
Cache: 1h. One point per ingest day. `finish` defaults to the game's headline finish;
`variant` selects a rarity/parallel printing (default base). For magic byName cards,
pass the byName key as `number`.
```jsonc
// /v1/history?game=pokemon&set=me3&number=1&window=30d
{ "game":"pokemon","set":"me3","number":"1","finish":"normal","window":"30d",
  "points":[ {"date":"2026-07-03","market":0.08}, {"date":"2026-07-04","market":0.08} ] }
```
Errors: `400` · `404` no history rows for that card.

### `GET /v1/health` — ingest freshness/coverage (no cache)
```jsonc
{ "ok":true, "pokemon":{"sets":172,"cards":20214,"unknownSubtypes":[]}, ... ,
  "fab":"no ingest yet" }
```
Alarm heuristic for clients/monitoring: if a set blob's `updatedAt` is older than ~36h,
ingest is stale — keep serving cached/bundled prices.

## Client integration pattern (all apps)

1. Bundle prices at build time (sourced from this API — offline fallback).
2. At runtime: `fetchSetPrices(game, set)` via `/v1/prices` when the local copy is
   >24h old; on ANY failure keep bundled/cached values. The API being down must never
   blank a price.
3. Data refreshes daily ~21:45 UTC; polling more often than daily gains nothing.
