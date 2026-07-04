# Client Migration — Replacing In-App Pricing with tcg-price-api

> **Audience:** every Lavai Labs rip app (`poke-rip`, `ygo-rip`, `mtg-rip`, `one-rip`,
> `lor-rip`, `fab-rip`) **and riplist**. This is the "uniform client" from DESIGN.md §7.4–7.5.
> **Reference implementation:** `poke-rip` (the file-by-file appendix at the bottom is
> Pokémon-specific; the principles above it are game-agnostic).
> **Prime directive for the client:** *the API being down, slow, or stale must never blank
> or wrong a price.* Bundled/cached prices are the floor; live prices only ever improve on them.

---

## 0. The one-paragraph version

Your app already stores a price on each card record and reads it everywhere it shows money.
**Don't touch the display or aggregation code.** Swap only the *source* of that stored number:
delete the per-card third-party fetches (pokemontcg.io / YGOPRODeck / Scryfall / …) and
replace them with **per-set batch fetches** to `GET /v1/prices?game=<game>&set=<set>`, writing
the results back onto your card records **and persisting them to disk**. The bundle becomes a
fresh-install seed + offline fallback only; after the first successful refresh of a set, users
see live, disk-persisted prices and never the bundle again.

---

## 1. The persistence model (read this twice)

Three layers, in priority order at render time:

| Layer | Where | Role | Lifetime |
|---|---|---|---|
| **A. Live price** | on the card record (your local DB), persisted to disk | **authoritative** display value | overwritten on each successful refresh |
| **B. Set-blob cache** *(optional)* | on disk, keyed by `set` + blob `updatedAt` | avoids re-hitting the API within 24h across launches | 24h |
| **C. Bundled price** | shipped in the app binary | fresh-install seed + offline fallback | permanent, but only *seen* until layer A first fills |

**The rule that makes this correct:** when a fetch succeeds, write the price onto the card
record **and commit it to the on-disk store immediately** (`modelContext.save()` / your ORM's
equivalent). The card record — not an in-memory cache — is the source of truth. That is why
users never see bundled prices after the first refresh: the live value is durable on disk and
re-renders on every subsequent launch without a network call.

**Fresh-install sequence (what the user actually experiences):**
1. Cards for a set get seeded with **bundled** prices on first sync (seed only — see §5).
2. The moment that set is touched (browse / open a pack / inspect a card), the client fetches
   `/v1/prices` for it and overwrites the card records on disk.
3. Every launch after: the disk-persisted live prices render instantly; a set is only refetched
   when its cards are >24h stale.

**Honest caveat:** on a brand-new install, a card opened in the ~200ms before its first fetch
returns shows the bundled price for that instant, then updates. That is intended
graceful-degradation (show something, never blank), not a bug. After a set's first successful
refresh, its bundled prices are never shown again.

**Never do:** hold live prices only in memory, or gate the disk write on the app staying open.
A price fetched but not saved means the user drops back to the bundle on next launch — the exact
thing this migration removes.

### 1a. Temporarily-unpriced vs permanently-unpriceable (don't let a seed rot)

The bundle is a **seed**, valid only because a live price soon replaces it. That assumption breaks
for cards the API can *never* price — an unmapped set (`404`) or a card the source doesn't carry
(absent from a `200`). Their seed will never be refreshed, so it only gets staler; a frozen 2026
price shown in 2029 looks authoritative and is silently wrong. **That is worse than showing nothing.**

So branch on *why* a price is missing:

- **Definitive no-price signal** (`404` on the set, or card absent from a `200`): this is
  deterministic (a mapped set never un-maps; a transient failure is a 5xx/network error, not a
  `404`). **Clear any seeded price to `nil` and stamp the "resolved" timestamp** → the card renders
  the terminal **"No market price"** state (§8). Do *not* keep showing a stale seed you can never refresh.
- **Transient failure** (`429` / 5xx / offline / not-yet-fetched): keep the last-known value (seed
  or last live). Never clear on a transient — that's the "never blank" rule.

This also keeps aggregate collection value honest: unpriceable cards contribute `$0` rather than a
decaying estimate (sum only cards with a real `market > 0`).

---

## 2. The contract you're integrating against

Full reference: [`docs/API.md`](./API.md). What the client needs:

- **Base URL:** `https://prices.lavailabs.com` — the *only* URL that ships in a binary. Never a
  `workers.dev` URL (D13: changing it costs an App Store review cycle × every app).
- **Batch primitive:** `GET /v1/prices?game=<game>&set=<set>` → whole set, one request, edge-cached
  24h. **Always prefer this over per-card `/v1/price`.** One call prices every card the user could
  see in that set.
- **Shape:**
  ```jsonc
  { "game":"pokemon", "set":"me3", "updatedAt":"2026-07-03T23:30:00Z", "currency":"USD",
    "cards": {
      "1":   { "market":0.08, "low":0.01,
               "finishes": { "normal":{"market":0.08,"low":0.01},
                             "reverseHolo":{"market":0.17,"low":0.01} } },
      "121": { "market":152.02, "low":147.48 }
    } }
  ```
- **Headline `market`/`low`** on each card is already the game's default finish — a single-price
  client needs zero finish logic; just read `card.market` / `card.low`.
- **`currency` is always `"USD"`.** Prices are dollars, floats, 2dp.
- **Rate limit:** 200 req / 60s per IP → `429`. With per-set batching + 24h cache you'll never
  approach it; still, treat `429` as "keep cached/bundled," same as any other failure.

### Status codes the client must distinguish
| Code | Meaning | Client action |
|---|---|---|
| `200`, card **present** | priced | write live price to disk |
| `200`, card **absent from `cards`** | known but **unpriced upstream** (no market aggregate, e.g. Alpha Black Lotus) | **definitive**: clear any stale seed → `nil`, stamp resolved, render "No market price" (§1a, §8). **Never hide the card itself** — only its price is unknown. |
| `404` | **unmapped set** — no source carries it | **definitive**: same as above for every card in the set. Don't keep serving an unrefreshable seed; log the set for the API team in case it becomes mappable. |
| `400` | bad params (client bug) | fix the request; never ship |
| `429` / 5xx / network | transient | keep cached/bundled, retry later |

---

## 3. Identifier matching — the part that bites

You send **your app-native `set` and `number` verbatim** — the API maps them. Two rules that
cause silent misses if ignored:

### 3a. Number normalization
The API keys card numbers with **leading zeros stripped after any letter prefix** and any
`/total` suffix removed:

```
001/088 → 1     DP01 → DP1     TG01 → TG1     157/204 → 157
```

If your bundle stores the **padded** form (poke-rip stores `DP01`, `TG01`), a raw lookup of
`blob.cards["DP01"]` misses (the key is `DP1`). Two facts settle this:

- **`/v1/price` (single card) normalizes the incoming number server-side** — send `DP01`, `DP1`,
  `SWSH001`, `TG01`, or `017` and it resolves. No client work needed.
- **`/v1/prices` (batch) is a raw key join against a bundle, so the client normalizes before
  matching.** Use the *canonical documented line* from [`docs/API.md`](./API.md) — the single source
  of truth, keep it byte-identical to avoid drift:

  ```
  n.toUpperCase().replace(/^([^0-9]*)0+(?=[0-9])/, '$1')   // DP01→DP1, SWSH001→SWSH1, 017→17, 121→121
  ```
  ```swift
  // Swift port of the canonical line (poke-rip stores no "/total" suffix; add a split if yours does).
  func normalizedNumber(_ raw: String) -> String {
      let s = raw.uppercased()
      guard let m = s.firstMatch(of: /^([^0-9]*)0+(?=[0-9])/) else { return s }
      return String(m.1) + s[m.range.upperBound...]
  }
  ```
Match by `blob.cards[normalizedNumber(card.number)]`. Games whose numbers are already the app-native
key verbatim (yugioh `PHNI-EN059`, magic `6`, one-piece `OP01-001`) pass through unchanged. Once an
app *sources its bundle from this API* (§5), bundle and blob keys are identical and the question
disappears entirely.

### 3b. Promo / subset sets need a verification pass
The normalization line (§3a) resolves the *bulk* of promo/subset cards, but a small tail can still
miss because TCGPlayer sometimes numbered individual promos on a different scheme than the app's
bundle — not just padding. **Worked example (poke-rip `dpp`, 2026-07):** 51/56 cards resolve after
normalization; 5 (`DP05 DP25 DP48 DP54 DP55`) don't, because TCGPlayer carries them under plain
numbers (`42 48 49 53`). Those 5 keep their bundled price. This is expected, not a defect.

**Client behavior when a card doesn't resolve: keep its bundled/nil price. Never blank it.** A
whole-set `404` (see below) means keep bundled prices for the entire set. Genuine per-card scheme
mismatches are a data-mapping concern owned by `tcg-price-api` (`mapping/<game>.overrides.json`,
`.review.json`) — worth reporting if a set's miss rate is high, but not something to block a ship on.

**Permanently-unmapped sets are a real, terminal state — not "waiting on the API team."** If
TCGPlayer never carried a set, no source can price it. Example: Pokémon `fut20` (Futsal Collection,
UK GAME-store exclusive) `404`s **by design**. Treat it as §1a definitive: render "No market price,"
don't poll it, don't treat the `404` as an outage — **and don't keep showing a stale bundled price
you can never refresh.** (Your app may currently ship a frozen pokemontcg.io price for such a set;
the migration deliberately drops it — see §8. A number that never updates is worse than none.)

### 3c. Per-game key formats (send verbatim; API normalizes)
| game | `set` example | `number` example |
|---|---|---|
| pokemon | `me3`, `base1`, `svp`, `dpp` | `1`, `121`, `TG1` |
| yugioh | `PHNI`, `LOB` | `PHNI-EN059` |
| magic | `EMN`, `LEA` | `6` (pre-2002: none → `name` fallback via `byName`) |
| onepiece | `OP12`/`OP-12`, `ST05`, `PRB02` | `OP01-001` |
| lorcana | `1` … `12` | `42` |

---

## 4. Fetch strategy & triggers

Replace **every** per-card refresh path with the per-set batch. Concretely, wire `fetchSetPrices`
to these moments:

1. **Set browse / open** — refresh that one set (warms the cache for inspect & pull).
2. **Pack open → summary** — all N pulled cards share one set → **one** request covers the pack.
3. **Card inspect** — the card's set (usually already cached from step 1).
4. **Owned-collection backfill** — iterate the **distinct set IDs among owned cards** and fetch each
   set's blob once. (This turns the old "N per-card calls" backfill into "handful of set calls.")

**Staleness gate:** only fetch when the set's cards are >24h old (reuse your existing per-card
`priceLastUpdated`, or track a per-set "last fetched" timestamp). Polling more than daily gains
nothing — ingest runs once daily (~21:45 UTC). Health heuristic: if a blob's `updatedAt` is >~36h
old, ingest is stale; keep serving what you have.

**Client surface area is ~one function**, identical across all apps:
```
fetchSetPrices(game, set) -> [normalizedNumber: (market, low[, finishes])]
  → on 200: write to card records + save to disk
  → on ANY failure (404/429/5xx/offline/decode): return nothing, leave existing prices untouched
```

---

## 5. Bundled prices (offline fallback) — build-time, from THIS API

D5: the bundle is sourced from **this API at build time**, so bundle and live share one source of
truth (not a third-party's differently-shaped data).

- **Seed only:** seed a card's bundled price on first insert; **do not** re-overwrite an
  already-seeded (possibly live-refreshed) card with the bundle on later syncs.
- **Generation:** a build script pulls the API's KV blobs (`out/kv/<game>~<set>.json`, or hit
  `/v1/prices` per set at build time) and writes a compact `market`/`low` (+ `finishes` if you use
  them) snapshot into the app's bundle. Drop everything you don't render: `mid`/`high`/`directLow`,
  foreign-currency objects, etc. — smaller binary, one schema.
- **Keep non-price fields you still need.** The price API does **not** serve product/buy URLs. If
  your app has a "Buy on TCGPlayer" / affiliate button, keep sourcing that URL from your existing
  bundle (or construct a search URL). **Pricing and buy-links are decoupled** — this migration
  swaps the *numbers* only.

---

## 6. Finish fidelity — headline now, per-finish later

The blob carries per-finish prices (`normal`, `reverseHolo`, `holo`, `firstEdition`, …). Two levels:

- **Level 1 (recommended first ship):** use the headline `market`/`low`. Matches how most apps
  already collapse to one price per card. Reverse-holo copies show the base price, exactly as today.
  **No schema change.**
- **Level 2 (enhancement the API uniquely enables):** persist the finish on each *pulled copy*
  (most apps already know `isReverseHolo` transiently at pull time — make it durable), store the
  `finishes` map on the card, and value a reverse-holo copy at its `reverseHolo` price. More
  accurate collection value. **This adds a persisted field → a DB/schema migration** — sequence it
  per your app's migration runbook, not as a drive-by.

---

## 7. Rollout checklist (per app)

- [ ] Add `PriceService` (base `https://prices.lavailabs.com`, `game=<yours>`) + `fetchSetPrices`.
- [ ] Add `normalizedNumber` (§3a) and match blob cards by it.
- [ ] Rewire set-open / pack-summary / inspect / owned-backfill to the **batch** path.
- [ ] Delete the old per-card third-party price fetch + variant-selection code.
- [ ] On success: write prices to card records **and save to disk**.
- [ ] On a **transient** failure (429/5xx/offline): leave existing prices untouched (never blank).
- [ ] On a **definitive** no-price signal (404 set / card absent in 200): clear the seed → `nil`,
      stamp resolved, render "No market price" (§1a, §8).
- [ ] Confirm every render path still reads the same stored price field (no display changes).
- [ ] Keep the buy/affiliate URL source intact.
- [ ] (Optional) Add a shared currency formatter if `$%.2f` is duplicated across sites.
- [ ] (Phase 2) Regenerate the bundled price snapshot from this API; strip unused price fields.
- [ ] Verify promo/subset sets resolve or fall back cleanly (§3b); report gaps to `tcg-price-api`.
- [ ] Sanity-check a known card end-to-end (e.g. pokemon `me3`/`121` ≈ headline market).

---

## 8. Unpriced-card UX (tri-state)

Distinguish three states on the card-detail price line — **using only the existing
`price` + `resolvedAt` fields**, no schema change:

| stored price | resolved timestamp | render |
|---|---|---|
| present (live or seed) | — | `$X.XX` |
| `nil` | **set** (a fetch confirmed no price) | **"No market price"** — terminal, honest |
| `nil` | `nil` (never fetched) | loading spinner / `——` |

The middle row is reached only via a **definitive** signal (§1a): the price service stamps the
timestamp — and clears any stale seed — on a `404` or card-absent-in-200. Two implementation notes:

- **Seeding a bundle-priceless card must leave the timestamp `nil`**, so it reads as "not yet
  resolved" and we still try the live API before declaring it unavailable (don't let a bundle gap
  masquerade as a confirmed no-price).
- **Copy:** frame it as a property of the card, not an app fault — "No market price" or "Not tracked
  by TCGPlayer" (optionally an info tap-target). Avoid "pricing unavailable / not working."
- **Never hide the card** from checklists/collection because it's unpriced — only the price line changes.

---

## Appendix A — Reference implementation: poke-rip (`game=pokemon`)

Concrete map of the poke-rip changes. Other apps mirror the *shape*, not the file names.

**Storage (unchanged fields — reuse them):** `CardModel.priceMarket: Double?`,
`priceLow: Double?`, `priceLastUpdated: Date?` (`Models/CardModel.swift`). No `@Model` change →
**no SwiftData migration** for Level 1. Keep `tcgPlayerURL` for the Buy button.

**Delete (pokemontcg.io price path):** `Services/PokemonTCGService.swift` — `APITCGPlayer`,
`APIPriceData`, `selectMarketPrice`, `priceVariantPriority` (the variant-collapse funnel).

**Rewire the four refresh sites to one set-batch call:**
- `Services/PriceBackfillService.swift` — change from per-owned-card `fetchCard(id:)` chunks to
  fetching the **distinct owned set IDs** via `fetchSetPrices`.
- `Views/PackOpening/PackOpeningView.swift::refreshPricesForPulledCards` — one `fetchSetPrices`
  for the pack's set instead of 10 per-card calls.
- `Views/CardInspect/CardInspectView.swift::refreshPriceIfStale` — fetch the card's set blob.
- `Services/SetSyncService.swift` — keep bundled prices as the first-insert **seed** only.

**Seed / bundle:** `Resources/Bundled/cards/*.json` currently embed a full `tcgplayer` object;
Phase 2 replaces the `prices` sub-object with an API-sourced `market`/`low` snapshot and drops
`mid`/`high`/`directLow` + the unused EUR `cardmarket`. Keep `tcgplayer.url`.

**Untouched (display & aggregation — the whole point):**
- `Views/CardInspect/CardInspectView.swift` (market/low labels)
- `Views/Collection/CollectionView.swift` (per-card row price)
- `Views/Stats/StatsView.swift::rebuildStats` (Collection Value = `Σ priceMarket × count`; luckiest pulls)
- `Views/Stats/ShareStatsCard.swift` (share value)
- `Services/CollectionStats.swift::priceRefreshTick` (bump it after a batch write so StatsView recomputes)

**Coverage note (2026-07):** the API prices **172 / 173** poke-rip bundled sets. The one exception,
`fut20` (Futsal Collection), is **permanently** unmapped — TCGPlayer never carried this UK-only set,
so no source can price it; it `404`s by design. poke-rip currently ships a frozen pokemontcg.io
price for its 5 cards; the migration **deliberately drops that** (§1a/§8) and renders "No market
price," because an unrefreshable seed only rots. The genuinely-priceless tail inside mapped promo
sets gets the same treatment (§3b `dpp`: 51/56 resolve; `DP05 DP25 DP48 DP54 DP55` → "No market
price"). Both are expected steady state, not gaps to wait on.

**Level 2 (later, migration-gated):** `PullRecord` gains a persisted finish (the transient
`isReverseHolo` on `PulledCard`/`PackPrefetcher` already exists — make it durable); store the
blob's `finishes` on `CardModel`; value reverse-holo pulls at `reverseHolo`. Sequence via
`docs/data-safety-and-migration.md`.

---

## Appendix B — Enhancements this migration unlocks (not required to ship)

- **Price history sparkline** on the card detail — `GET /v1/history?game=&set=&number=[&window=]`.
- **"Market Movers"** board (gainers/losers, incl. cross-game `game=all`) — `GET /v1/movers`.
- **Collection value over time** (DESIGN §8b) — computed on-device from `/v1/history` × holdings;
  **no user holdings ever leave the device** (hard privacy rule).
