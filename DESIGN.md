# TCG Price API — Design Doc

> **Status:** DECIDED, not yet built. All open questions resolved 2026-07-03.
> **Recurring cost budget:** $5/mo Cloudflare Workers Paid (already paying). **No paid APIs, ever, as part of the plan.**

A shared, self-hosted pricing service serving live-ish card prices to every Lavai Labs
TCG app (`poke-rip`, `ygo-rip`, `mtg-rip`, `one-rip`, `lor-rip`, `fab-rip`) **plus
riplist (the scanner)**. One backend, one contract, many clients. ~7–8k active users
across the rip apps today.

**Prime directive:** if any data source becomes unreliable, we swap it for another and
**callers never know**. The API contract contains zero source vocabulary; all source
knowledge lives behind per-game adapters in the ingest layer.

---

## 1. Why this exists

Each app today gets prices from a different per-game third-party middleman
(pokemontcg.io, YGOPRODeck, Scryfall, optcgapi, Lorcast; fab-rip has none), each with
its own coverage gaps and ingest lag. Observed failures: pokemontcg.io weeks stale on
new Pokémon sets (ME03/ME04 blank prices); YGOPRODeck `set_price:"0"` on modern sets.
The data we want — TCGPlayer market price — exists on day one; our middlemen relay it
slowly. We keep patching per-app, per-source.

**Instead:** one service pulls TCGPlayer-derived data, normalizes across games, serves
all apps on a cadence we control, and keeps its own history so no source can ever hold
our data hostage.

### Non-goals
- Real-time / sub-daily pricing (TCGPlayer market price recomputes ~daily; daily is correct).
- Scraping tcgplayer.com from devices (ToS + Cloudflare + App Review risk — rejected).
- Public/3rd-party product. Internal infra.
- Paid data sources. Free sources only; paid APIs are not a fallback tier.

---

## 2. Decisions (all resolved)

| # | Decision |
|---|---|
| D1 | **Cloudflare Workers** for the read API. Workers Paid ($5/mo flat — already paid; usage far inside included quotas). |
| D2 | **TCGCSV as primary source** (free, no key, daily ~20:00 UTC, all TCGPlayer categories). Verified it has the data pokemontcg.io lacked (Spinarak ME03 = $0.08 market). |
| D3 | **Daily freshness.** The bug was weeks stale, not hours. |
| D4 | **Storage = KV (current prices, hot path) + D1 (history) + R2 (raw archive copies).** |
| D5 | **Apps keep bundled prices as offline fallback**, sourced from *this* API at build time (single source of truth). |
| D6 | **Ingest runs in GitHub Actions, not a Worker.** TCGCSV's daily archive is 7z/PPMd (un-decompressable in a Worker); free-plan subrequest (50/req) and KV write (1k/day vs ~1,200 set keys) limits rule out Worker ingest anyway. Actions: free, no limits, one archive download/day (good citizen), same muscle as existing app pipelines. Pushes to KV/D1 via Cloudflare API. Worker never ingests. |
| D7 | **Source strategy: multi-source capable day 1, single source ACTIVE per game** + one shadow adapter. See §6. No price blending. |
| D8 | **Identity: apps send native `(game, setCode, number)`; backend owns all mapping.** Mapping tables are per-source. This is the choice that makes swaps invisible. |
| D9 | **Canonical finish enum** (`normal, reverseHolo, holo, firstEdition, foil, …`) in the contract; adapters map source subtype names into it. Raw TCGPlayer subtype strings never reach clients. Aligns with riplist's `CardFinish`. |
| D10 | **USD-only v1, but `currency:"USD"` field in responses now** (EUR later is additive, not breaking). |
| D11 | **History in D1**: `price_history(game, set, number, finish, date, market_cents, low_cents, source)`, PK (game,set,number,finish,date). Mapped sets only. 180-day hot retention. **Backfill at launch by replaying TCGCSV archives (available since 2024-02-08)** — movers/sparklines ship with real history on day one. |
| D12 | **Auth: none.** Open endpoint + Cloudflare rate limits + edge cache (24h). Non-secret `X-App` header for telemetry only. Revisit only if abused. |
| D13 | **Domain: `prices.lavailabs.com` from day one.** Never ship a `workers.dev` URL in a client (URL changes cost App Store review cycles × 7 apps). workers.dev is dev-only. |
| D14 | **Free-tier math (7–8k active users):** reads fit easily (worst case ~40k req/day vs 100k free; 24h client cache per set). Writes are what need the paid plan (KV 1k writes/day free vs ~1,200 set keys; D1 snapshot volume). Paid plan already in place — stop optimizing for free limits. |

### Rejected
- **Direct TCGPlayer API** — closed to new developers (~2024, eBay-owned).
- **Device-side scraping** — ToS/Cloudflare/App Review; fragile across 7 apps.
- **Per-card KV keys** — 100k+ writes/day. Per-set blobs instead.
- **Worker cron ingest** — see D6.
- **Paid APIs (JustTCG, Scrydex) as fallback tier** — no recurring API costs. They exist
  (JustTCG covers 13+ games incl. Lorcana/OnePiece/FaB) and the adapter interface could
  take one someday, but they are a conscious future decision, not the plan.
- **N live sources blended day 1** — see §6 for why.

---

## 3. Architecture

```
 GitHub Actions (daily cron, ~21:00 UTC — after TCGCSV's 20:00 refresh)
 ┌─────────────────────────────────────────────────────────────┐
 │ ingest pipeline (Node/Python, real libs, no platform limits) │
 │  1. download tcgcsv archive (one .ppmd.7z) ── copy → R2      │
 │  2. extract; run ACTIVE adapter per game → canonical rows    │
 │  3. apply per-source mapping (in-repo, versioned)            │
 │  4. coverage audit — RATCHET: refuse to promote if coverage  │
 │     drops vs previous run; golden-card contract tests        │
 │  5. diff vs KV → write changed set blobs; append D1 rows     │
 │  6. compute movers leaderboards → KV                         │
 │  7. shadow adapters (if any) → diff report only, never KV    │
 └─────────────────────────────────────────────────────────────┘
                    │ Cloudflare API
                    ▼
 ┌──────────── Cloudflare ────────────┐        ┌─ clients (24h cache) ─┐
 │ KV: {game}:{set} blobs, movers:*   │  read  │ poke/ygo/mtg/one/lor/ │
 │ D1: price_history                  │◀───────│ fab -rip + riplist    │
 │ R2: raw daily archives (insurance) │ Worker │ (scanner)             │
 │ Worker: GET /v1/* (read-only)      │        └───────────────────────┘
 └────────────────────────────────────┘
```

- **Staleness alarm:** the Worker exposes `updatedAt`; a check (in the ingest job and/or
  a tiny scheduled Worker) alerts when data age exceeds ~36h (Actions crons can slip).
- **Graceful staleness is the failure model:** a dead source is NOT an outage. We own
  KV/D1/R2 copies; prices freeze at last-known while a fallback adapter is stood up.
  Contrast with today, where a dead middleman = blank prices immediately.

---

## 4. Data model

### KV — current prices, one blob per set. Key `{game}:{setCode}` (app-native codes)
```jsonc
// key: "pokemon:me3"
{
  "game": "pokemon",
  "set": "me3",
  "sourceRefs": { "tcgcsv": 24587 },        // internal; NEVER in API responses
  "updatedAt": "2026-07-03T00:00:00Z",
  "currency": "USD",
  "cards": {
    "1": { "market": 0.08, "low": 0.01,
           "finishes": { "reverseHolo": { "market": 0.15, "low": 0.01 } } },
    "13": { "market": 4.12, "low": 2.50 }
    // keyed by collector number (string); top-level market/low = the game's
    // default finish (per-game config, e.g. pokemon → normal)
  }
}
```

### D1 — history (mapped sets only; prices in cents)
```sql
CREATE TABLE price_history (
  game TEXT, set_code TEXT, number TEXT, finish TEXT,
  date TEXT,                -- YYYY-MM-DD
  market_cents INTEGER, low_cents INTEGER,
  source TEXT,              -- provenance; lets movers exclude cross-source windows
  PRIMARY KEY (game, set_code, number, finish, date)
);
```
Retention: 180 days hot (covers 7d/30d/90d windows + slack). Older → optional R2 dump.

### Mapping — in-repo, per-source, compiled to KV on deploy
```jsonc
// (game, appSetCode) → per-source refs. Adding a source = adding a column.
{ "pokemon": { "me3": { "tcgcsv": 24587 }, "me4": { "tcgcsv": 24588 } },
  "yugioh":  { "PHNI": { "tcgcsv": 23999 } } }
```
Built by auto-matcher (set name + release date fuzzy match) + manual override file;
every newly-seen group is flagged for review. The coverage audit must pass before an
ingest promotes (ratchet: coverage may never silently drop).

---

## 5. API contract (v1)

```
GET /v1/prices?game=pokemon&set=me3
  → 200 { game, set, updatedAt, currency, cards: { "1": {market, low, finishes?}, ... } }
  → 404 unknown/unmapped set

GET /v1/price?game=pokemon&set=me3&number=1
  → 200 { game, set, number, market, low, finishes?, currency, updatedAt }

GET /v1/movers?game=pokemon|all&window=7d|30d&dir=gainers|losers   (v1.1)
  → 200 [ { game, set, number, name, market, pctChange, absChange }, ... ]

GET /v1/history?game=&set=&number=&window=90d                      (v1.1)
  → 200 { points: [ {date, market}, ... ] }   // sparklines, collection backfill
```

Card entry extensions (all game vocabulary, never source vocabulary):
- **`variants`** — same collector number, different printing, as separate upstream
  products: yugioh rarity reprints keyed by Konami's rarity name ("Quarter Century
  Secret Rare"), one piece parallel arts keyed by descriptor ("Parallel", "Alternate
  Art"). Headline market/low always comes from the base printing.
- **`byName`** — pre-2002 Magic sets have no collector numbers upstream; those cards are
  keyed by normalized name, and `/v1/price` accepts `&name=` as fallback. Same-name art
  variants (Alpha basic lands) resolve to the cheapest.
- **Absent ≠ missing set**: a card absent from a 200 response is *known but unpriced*
  (TCGPlayer has no market aggregate — e.g. Alpha Black Lotus). 404 means the set is
  unmapped. Clients render unpriced cards; a missing price never hides a card.
- **No per-user batch endpoint**: whole-set blobs are the batch primitive, and they are
  edge-cacheable across ALL users; per-user id-list batches are cache-poison and would
  invite productId (source vocabulary) into the contract. A collection refresh is one
  cached GET per owned set.

Contract rules (these are what guarantee swap invisibility):
1. **No source vocabulary in any response** — no source names, IDs, or subtype strings.
2. **Finish keys are the canonical enum** (D9).
3. **`currency` always present** (D10).
4. `Cache-Control: max-age=86400`; clients also cache 24h and fall back to bundled
   prices on any failure (mirrors existing `refreshPriceIfStale`).
5. `game` values: `pokemon | yugioh | magic | onepiece | lorcana | fab`.
6. Semantics: `market` = the source's market-average concept; adapters must approximate
   it honestly and document deviations per source.

Per-app client is ~1 function: `fetchSetPrices(game, setCode) -> [number: Price]`,
cached 24h, bundled fallback. Identical across all 7 apps.

---

## 6. Source strategy (the swap-out guarantee)

**Decision (D7): multi-source *capable* day 1; exactly ONE active source per game; one
shadow adapter running early; never blend prices.**

Why not N live sources from day 1:
- **Mapping is the biggest risk and it multiplies per source.** Every source needs its
  own set/card mapping for every game. N sources day 1 = N× the hardest work, before
  the service has proven anything.
- **Blending creates a reconciliation problem with no user value.** Sources define
  "market" differently; showing max/min/avg across them is a semantics swamp, and
  movers would be poisoned by source-disagreement noise.
- **The failure model doesn't need hot standby.** Failure = staleness, not outage
  (§3). Daily cadence + owned copies = days of runway to flip a config flag. Hot
  redundancy solves a minutes-matter problem we don't have.

What we DO build day 1 (the capability):
- **Adapter interface:** `listSets(game)` + `fetchSetPrices(sourceRef)` → canonical
  rows `(game, setCode, number, finish, currency, market_cents, low_cents)`.
- **Per-game active-source config:** `game → ordered source list`. Active source
  writes; others are standby/shadow. A swap (global or one lagging game) is a config
  change + mapping column, zero app changes.
- **Golden contract tests:** ~20 known cards per game with expected price ranges
  (Spinarak ME03 ≈ $0.08 is golden card #1). Any adapter must pass to ship.
- **Shadow mode:** run a candidate adapter through ingest into a coverage/price-delta
  diff report (never KV). Cutover requires N consecutive clean daily reports.

**Build ONE second adapter early** (e.g. Scryfall for MTG or pokemontcg.io for Pokémon)
and leave it in shadow. An abstraction with one implementation is usually wrong; the
second implementation is what proves the interface, and its daily diff report doubles
as free cross-source sanity checking on the primary.

Fallback bench (all free): per-game — Scryfall (MTG), pokemontcg.io (Pokémon),
YGOPRODeck (Yu-Gi-Oh), Lorcast (Lorcana), optcgapi (One Piece). These are the middlemen
the apps are migrating off — weak as sole direct dependencies, fine as emergency
adapters behind our normalization, history, and coverage ratchet.

Failover runbook: staleness alarm fires → check TCGCSV Discord/status → if dead: point
game(s) at bench adapter in shadow → 1–2 clean diff days (or judgment call) → flip
active → apps never notice. D1 `source` column marks the seam; movers exclude windows
that span a source change.

---

## 7. Rollout

1. Repo scaffold: Worker (read API) + Actions ingest + mapping/ + golden tests.
2. **Pokémon only.** Validate: ME03/ME04/Ascended Heroes; Spinarak returns $0.08.
3. D1 backfill from TCGCSV historical archives (2024-02 →) for mapped Pokémon sets.
4. Point **poke-rip** at it (on-device refresh + build-time bundle fill from this API).
5. Add remaining games; drop the uniform client into ygo/mtg/one/lor/fab-rip.
6. **riplist (scanner)** consumes the same endpoints — needs per-finish prices (D9)
   and whole-set blobs for scan-session pricing; both already in the shape.
7. v1.1: movers + history endpoints.

---

## 8. Features on top (approved)

### 8a. Movers (server-side, v1.1)
Precomputed daily in the ingest job → `movers:{game}:{window}` in KV. Guardrails:
- Price floor: **ending** market ≥ $2 (kills penny-card % noise).
- Rank by blend of %-change AND absolute-$ change.
- Require snapshots at **both** window endpoints; exclude cards without full-window
  history (kills new-set "+100% from nothing" artifacts).
- Windows: 7d / 30d. `game=all` cross-game view is the differentiator no single-game
  app can offer.

### 8b. Collection value over time (on-device)
**Hard privacy rule:** backend serves only public market data. No accounts, no user
holdings server-side, no PII/GDPR surface. Value is computed in-app.
- Instant chart on first open: counterfactual backfill (current holdings × `/v1/history`),
  labeled honestly; real local daily snapshots going forward.
- Same endpoint gives Card Inspect sparklines; restores ygo-rip's dropped "Low".
- **riplist note:** the local value-history series is user data → it must be included
  in the `.riplist` backup archive (see riplist `docs/data-safety-design.md`, Layer 3:
  every new user-data field appears in the archive or the round-trip test fails).

---

## 8c. Upstream sharp edges (from riplist's catalog work — docs/riplist-catalog-learnings.md)

Adopted into the ingest layer:
- Trailing parens carry BOTH number disambiguators and variant descriptors
  ("Charlotte Katakuri (067) (Alternate Art)") — number-only parens are stripped before
  descriptor detection.
- Same number appears across product contexts (tokens vs cards, event/demo groups) —
  magic tokens are denylisted; mapping targets exactly the main group per set, with
  multi-group refs (arrays) for folded subsets (Radiant Collection / Shiny Vault style).
- Denylist for stamped same-number reprints ([Winner]/[Staff]), jumbos, and World
  Championship decks — they explode rows without being collectable.
- Group abbreviations are a matching *hint*, never parsed for identity.
- Set-name vocabulary differs per source — the mapping stays an explicit reviewed table.

Deliberately NOT adopted: batch-by-productId endpoint (see §5 — cacheability + source
vocabulary would break the swap guarantee), request-time fuzzy matching (mapping is a
build-time concern).

## 9. Risks

| Risk | Mitigation |
|---|---|
| TCGCSV is one person's free service | Adapter machinery (§6); R2 raw-archive copies (history never hostage); graceful staleness; be a good citizen (one archive pull/day); optional Patreon tip. |
| Set/card mapping errors (biggest) | In-repo versioned mapping + auto-matcher + override file; coverage ratchet gates every ingest; golden-card tests; per-game audit à la ygo rarity audit. |
| GH Actions cron slips | Staleness alarm at 36h; data is daily anyway — hours of slip are invisible. |
| Cloudflare limits | Paid plan ($5/mo, already paid) — quotas are far above our volume; reads fit even free tier. |
| Movers artifacts on source swap | `source` column in D1; exclude cross-source windows. |

## 10. Test plan
- Golden contract tests per adapter (known cards, expected ranges).
- Coverage ratchet: ingest fails closed if mapped-set or matched-card coverage drops.
- Mapping auto-matcher unit tests + review queue for new sets.
- End-to-end: ingest fixture archive → KV/D1 → API responses match expected shapes.
- Shadow diff report format test (coverage %, price-delta distribution).
