# ProductId-keyed sets (Secret Lair / The List)

Scope for pricing the Magic sets our number-keyed ingest can't cover: **Secret Lair Drop (SLD),
The List (PLST)**, and their smaller siblings (SLC, SLP, SLU, ULST). ~7,700 cards, currently 0%
priced by our API.

## The problem, precisely

Two sources organize these sets differently:

| Source | Role | Groups Secret Lair as… |
|--------|------|------------------------|
| **Scryfall** | card identity (app catalog) | ONE set per official code — `sld`, `plst`, … (canonical) |
| **TCGplayer / TCGCSV** | prices | MANY commerce groups (`Secret Lair Drop Series`, `Secret Lair Series`, `Secret Lair Showdown`, one per Commander drop, …) |

For 270 normal Magic sets the two line up and we join by `(set, collectorNumber)`. Secret Lair breaks
that two ways:
1. **One app set spans many TCGCSV groups** — the mapping already supports an array of groupIds, so
   this alone is fine.
2. **Collector numbers collide across those groups** — every Secret Lair drop renumbers from 1, so
   merging their rows into one `cards[number]` map collapses many distinct cards onto number "1".
   This is the real blocker: `buildSetBlob` keys by `number`.

The app catalog is NOT wrong — it faithfully mirrors Scryfall/WOTC set identity. We just need a join
key that survives the fragmentation.

## The key we already have: `productId`

Every one of these cards carries a `tcgplayer_id` (SLD 98%, PLST 99%) — the exact `productId`
TCGplayer prices by. So we join identity → price **by productId**, regardless of how TCGplayer chops
the groups. Three enablers are already in place:

- Ingest fans out over **multiple groupIds per set** (`run.js` `refs[SOURCE]` → `groupIds.flat()`).
- The row source already works in productId (`tcgcsv.js` `numberById` is keyed by `p.productId`;
  `joinPrices` iterates `pr.productId`) — it just doesn't *emit* the id.
- The app's `Card` model already stores `tcgplayerId: Int?`.

## Design

### Blob format (additive, backward-compatible)

A set flagged `keyBy: "productId"` gets a `byProductId` map instead of relying on `cards[number]`:

```json
{
  "game": "magic", "set": "SLD", "updatedAt": "…", "currency": "USD",
  "byProductId": {
    "265087": { "market": 3.10, "low": 1.50, "finishes": { "foil": { "market": 3.10, "low": 1.50 } } },
    "…": { … }
  }
}
```

Existing clients ignore `byProductId`; updated clients use it for flagged sets. `cards` may be omitted
for these sets (its number-keying is meaningless here).

### Backend (`tcg-price-api`)

1. **`sources/tcgcsv.js` — emit the id.** Add `productId: pr.productId` to the object `joinPrices`
   pushes. (~1 line; the id is already in scope.)
2. **`lib/normalize.js` — `buildSetBlob`.** When `keyBy === "productId"`, build `byProductId`
   (`productId → { market, low, finishes }`, same `pickFinishes` logic as today) instead of the
   number map. Otherwise unchanged.
3. **Group discovery — auto-include new drops.** Fetch `/{category}/groups` (already available),
   filter Magic groups whose name matches the Secret Lair / List families, and route each to its app
   set (SLD / SLC / SLP / SLU / PLST / ULST) by name. This survives future drops with no mapping
   edits. Static list of current groupIds is the simpler fallback if we'd rather defer discovery.
4. **Mapping schema.** Extend the per-set ref, e.g.
   `"SLD": { "tcgcsv": [2576, 2632, 22970, …], "keyBy": "productId", "name": "Secret Lair Drop" }`
   (or a `"discover": "secret-lair"` rule that resolves to the groupIds at ingest time).
5. **History (D1).** `historyRows` is number-keyed. Either (a) key these sets' history by productId
   too, or (b) ship prices now and defer history for SL/List (charts show "no history yet" until we
   backfill). Recommend (b) first — prices are the value; history is additive.
6. **Coverage audit.** These sets now count as covered; the ratchet should rise, not trip.

### Client (`riplist`)

7. **`data-pipeline/apply_api_prices.py`.** For a `keyBy: "productId"` blob, resolve each manifest row
   via `blob["byProductId"][str(card["tcgplayer_id"])]` instead of the number path.
8. **App `PriceService` / `MagicProfile`.** For these sets, resolve the live lookup by
   `card.tcgplayerId` against `byProductId` rather than `priceNumberKey`. Cleanest as a profile hook
   (e.g. `priceProductKey(for:)` returning the tcgplayerId for productId-keyed sets, nil otherwise) so
   `PriceService` stays game-agnostic. History query follows the same key.

## Rollout

1. Backend: add productId emit + `byProductId` + discovery + mapping. `node ingest/run.js --game magic
   --sets SLD,PLST` (local) → inspect `out/kv/magic~SLD.json` coverage vs the 2,511/5,041 app cards.
2. Push ingest (GitHub workflow) once local coverage looks right (expect ~95%+ by productId).
3. Client: apply_api_prices productId path + app PriceService/MagicProfile hook.
4. Then the full 5-game pricing rollout (Magic now clean) — `apply_api_prices.py --game all` →
   `publish_pack.py all`.

## Open decisions

- **Discovery vs static list** for the Secret Lair groups (auto-future-proof vs simpler now).
- **History now or later** for these sets (recommend later).
- **`cards` fallback**: omit entirely for productId sets, or keep a best-effort number map for any
  client that never learns `byProductId`. Recommend omit — a wrong number-collision price is worse
  than none.

## Effort

Small-to-moderate, and low-risk (additive blob field, per-set flag — normal sets untouched):
- Backend: ~3 focused changes (emit id, byProductId branch, discovery/mapping) + verify.
- Client: 2 changes (apply_api_prices, one profile hook + PriceService branch).
- No app data-model change — the set model stays exactly as Scryfall defines it.
