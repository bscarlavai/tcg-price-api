# TCG Price API — Design Doc

> **Status:** DRAFT / designing together. Nothing built yet.
> **Working name:** `tcg-price-api` (see [Open Q9](#q9-naming--ownership)).
> **Last updated:** 2026-07-03

A shared, self-hosted pricing service that serves live-ish card prices to every
Lavai Labs TCG app (`poke-rip`, `ygo-rip`, `mtg-rip`, `one-rip`, `lor-rip`,
`fab-rip`) **plus the card-scanning app**. One backend, one contract, many
clients.

---

## 0. Decisions needed from you (checklist)

> **You are the decision-maker.** The rest of this doc is context. Everything in
> §2 is already locked; below is what's still open. For each, there's a
> recommended default ("lean") in the linked section — if you agree, just say
> "accept leans" and we proceed. Call out only the ones you'd change.

**Architecture / contract**
- [ ] **D1 history schema** — confirm D1 (SQLite) as the history store and the `price_history(game,set,number,date,market,low)` shape. *(Newly required by §9 features; see [D4](#2-decisions-locked-so-far) / [Q8](#q8-history).)*
- [ ] **Q1 — Auth/abuse:** open endpoint + rate-limits (lean) vs static app key. → [Q1](#q1-auth)
- [ ] **Q2 — Identity ownership:** apps send native `(game,set,number)`, backend owns mapping (lean) vs canonical scheme in apps. → [Q2](#q2-identity)
- [ ] **Q9 — Name + domain:** `tcg-price-api` / `prices.lavailabs.com`? → [q9](#q9-naming--ownership)

**The hard part**
- [ ] **Q3 — Set/card mapping** ⚠️ *biggest risk*: auto-matcher + in-repo overrides + coverage audit (lean). Confirm approach. → [Q3](#q3-mapping)

**Data shape**
- [ ] **Q6 — Variants + currency:** store all TCGPlayer subtypes, USD-only for v1 (lean). Need Cardmarket EUR? → [Q6](#q6-variants)
- [ ] **Q8 — History store:** D1 vs R2, retention window (lean: D1, ≥90 days). → [Q8](#q8-history)

**Ops / scale**
- [ ] **Q7 — Ingest vs Worker limits:** TCGCSV daily archive vs staggered per-game crons (lean: try archive first). → [Q7](#q7-ingest-scale)
- [ ] **Q5 — Free-tier read ceiling:** confirm we model expected reads once install counts are known. → [Q5](#q5-freetier)
- [ ] **Q4 — Bundled prices:** keep offline fallback sourced from our API (lean) vs thin bundle. → [Q4](#q4-bundle)

**Features (approve scope for v1)**
- [ ] **§9a — Movers** in v1? Confirm the quality guardrails (price floor, %+$ blend, exclude new sets). → [§9a](#9a-market--trending-cards--movers--server-side)
- [ ] **§9b — Collection value over time:** real-snapshots vs counterfactual-backfill (lean: backfill + real going forward). Confirm on-device/no-accounts principle. → [§9b](#9b-collection-value-tracking--on-device)

---

## 1. Why this exists (the problem)

Each app currently gets prices from a **per-game third-party API** baked into its
own pipeline + on-device refresh:

| App | Price source today | Failure mode observed |
|---|---|---|
| poke-rip | pokemontcg.io | New sets (Mega Evolution ME03/ME04/Ascended Heroes) load with **blank prices** — pokemontcg.io hadn't ingested TCGPlayer prices for weeks after release. |
| ygo-rip | YGOPRODeck | Modern/Sevens-era sets returned `set_price:"0"`; fixed with a `card_prices` fallback, but still a single-source dependency. |
| mtg-rip | Scryfall | OK today (Scryfall is comprehensive) but same structural single-source risk. |
| one-rip / lor-rip | optcgapi / Lorcast | Best-effort, small sources, freshness unknown for new sets. |
| fab-rip | (no prices) | Source carries none. |

**Root problem:** every app depends on a different upstream middleman, each with
its own coverage gaps and ingest lag. The data we actually want —
**TCGPlayer market price** — exists on day one, but our middlemen are slow to
relay it. We keep patching this per-app, per-source.

**What we want instead:** one place that pulls the real TCGPlayer-derived data,
normalizes it across games, and serves it to all apps on a cadence *we* control.

### Non-goals (explicitly out of scope for v1)
- Real-time / sub-daily pricing. TCGPlayer "Market Price" is a rolling average
  recomputed ~daily; daily freshness is the correct target, not live.
- Scraping tcgplayer.com from devices. ToS violation + Cloudflare bot protection
  + App Review risk. Rejected — see decision log.
- ~~Price **history** / time-series~~ — **PROMOTED TO IN-SCOPE.** Two proposed
  features (Market/Movers + Collection-value-over-time, see §9) both require
  historical prices. This changes the storage model (KV-only → KV + D1). See
  [Open Q8](#q8-history) and §9.
- Being a public/3rd-party product. This is internal infra for our apps.

---

## 2. Decisions locked so far

| # | Decision | Rationale |
|---|---|---|
| D1 | **Cloudflare Workers + KV** for the backend | Cheap/free at our scale, global edge cache, trivial deploy, Cron Triggers for ingest. |
| D2 | **TCGCSV as the data source** (free, no key, daily) | Public JSON mirror of TCGPlayer's own API (categories/groups/products/prices). Covers *every* TCGPlayer game in one source. Verified it has the exact data pokemontcg.io lacks (Spinarak ME03 = $0.08 market / $0.01 low, matching the TCGPlayer site). |
| D3 | **Daily freshness is sufficient** | Matches how often TCGPlayer market price actually moves. The bug was *weeks* stale, not hours. |
| D4 | **Storage = KV (current) + D1 (history)** | **KV**: one blob per set = current prices, hot read path (~1,200 keys, O(1) reads, whole-set fetch for pack-open/scanning). **D1**: `price_history(game,set,number,date,market,low)` daily snapshots — powers Movers, per-card sparklines, collection-value backfill (§9). *(Revised from KV-only once §9 features landed.)* |
| D5 | **Apps keep bundled prices as offline fallback** | Offline-first is a core property (esp. ygo-rip). Backend is for *freshness*, not a hard runtime dependency. |
| D6 | **Ingest layer is source-abstracted** | Start on TCGCSV; swapping/adding a licensed source (Scrydex/JustTCG) later must be a backend config change, not an app change. |

### Decision log (things we considered and rejected)
- **Direct TCGPlayer API** — closed to new developers since ~late 2024 (eBay-owned). Can't get a key.
- **Scraping tcgplayer.com from the apps** — ToS + Cloudflare + App Review risk + fragile SPA/internal-API cat-and-mouse across 7 apps. Rejected.
- **Per-card KV keys** — would be 100k+ writes/day, blows the free KV write limit. Per-set blobs instead (D4).

---

## 3. Architecture

```
   ┌─────────────────────────── tcg-price-api (Cloudflare) ───────────────────────────┐
   │                                                                                    │
   │   Cron Trigger (daily)              KV namespace              Fetch Worker         │
   │   ┌──────────────────┐         ┌──────────────────┐      ┌────────────────────┐   │
   │   │ ingest job       │  write  │  {game}:{set}     │ read │ GET /v1/prices     │   │
   │   │  - pull TCGCSV    │────────▶│   → { number:     │◀─────│  ?game=&set=       │   │
   │   │  - normalize      │ (only   │      {market,low} │      │ GET /v1/price      │   │
   │   │  - join set+num   │ changed │      ... }        │      │  ?game=&set=&number│   │
   │   │  - diff & upsert  │  sets)  │  meta:mapping     │      │  → {market,low,ts} │   │
   │   └──────────────────┘         └──────────────────┘      └────────────────────┘   │
   └────────────────────────────────────────────────────────────────────────────────────┘
        ▲                                                              ▲
        │ TCGCSV bulk (all categories)                                 │ HTTPS (24h client cache)
   ┌────┴─────┐                                        ┌───────────────┼───────────────┐
   │ tcgcsv.com│                                       ▼        ▼      ▼      ▼     ▼    ▼
   └──────────┘                                    poke-rip ygo-rip mtg-rip one lor fab + scanner
```

Two Workers (or one Worker with a scheduled handler + fetch handler):
1. **Ingest** — runs on a daily Cron Trigger. Pulls TCGCSV, normalizes, diffs
   against current KV, writes only changed sets.
2. **Read API** — handles app requests. Pure KV reads + edge cache. No upstream
   calls on the hot path.

---

## 4. Data model

### KV value (one per set), key = `{game}:{setCode}`
```jsonc
// key: "pokemon:me3"
{
  "game": "pokemon",
  "set": "me3",
  "tcgcsvGroupId": 24587,
  "updatedAt": "2026-07-03T00:00:00Z",
  "cards": {
    "1":  { "market": 0.08, "low": 0.01, "variants": { "reverseHolo": { "market": 0.15, "low": 0.01 } } },
    "2":  { "market": 0.06, "low": 0.01 },
    "13": { "market": 4.12, "low": 2.50 }
    // keyed by collector number (string)
  }
}
```

### The set-mapping table (stored in KV under `meta:mapping` or in-repo config)
```jsonc
// (game, appSetCode) -> TCGCSV groupId
{ "pokemon": { "me3": 24587, "me4": 24588, ... }, "yugioh": { "PHNI": ..., ... } }
```

**Open:** where the mapping lives + how it's built — see [Open Q3](#q3-mapping).

---

## 5. API contract (v1)

```
GET /v1/prices?game=pokemon&set=me3
  → 200 { game, set, updatedAt, cards: { "1": {market,low,variants?}, ... } }
  → 404 if set unknown/unmapped

GET /v1/price?game=pokemon&set=me3&number=1
  → 200 { game, set, number, market, low, variants?, updatedAt }
  → 404 if card not found (unmatched or set has no price row)
```
- `game` values: `pokemon | yugioh | magic | onepiece | lorcana | fab` (canonical, TBD).
- Prices are USD (TCGPlayer). Cardmarket EUR is available in TCGCSV too — [Open Q6](#q6-variants).
- Response includes `Cache-Control: max-age=86400` so edge + client cache for a day.

**Client behavior:** app has a bundled price as fallback; calls `/v1/prices` for
a set when its cached copy is >24h old (mirrors today's `refreshPriceIfStale`).

---

## 6. Ingest pipeline (daily)

1. `GET tcgcsv.com/tcgplayer/categories` → resolve category IDs per game.
2. For each game's category: `GET .../{cat}/groups` → sets.
3. For each mapped group: `GET .../{cat}/{group}/products` + `.../prices`.
4. Join products↔prices by `productId`; extract collector number from
   `product.extendedData` (name "Number", e.g. "001/088" → "1").
5. Normalize to the KV value shape; **diff against current KV**; write only
   changed sets (keeps us under the free KV write ceiling).
6. Update `meta:mapping` for any newly-seen groups (fuzzy-matched, flagged for
   review — see [Open Q3](#q3-mapping)).

**Scale note:** iterating every group is hundreds of subrequests × 6 games.
Cloudflare Worker subrequest limits + a daily job may need chunking (per-game
cron, or Cloudflare Queues, or TCGCSV's daily archive tarball). See [Open Q7](#q7-ingest-scale).

---

## 7. Consumers & rollout

**Rollout order**
1. Worker (ingest + read), **Pokémon only**.
2. Validate against ME03 / ME04 / Ascended Heroes — Spinarak must return $0.08.
3. Point **poke-rip** at it (on-device refresh + build-time bundle fill).
4. Add remaining TCGCSV categories; drop the same tiny client into
   ygo/mtg/one/lor/fab.
5. Scanner consumes the same endpoint.

**Per-app client** is ~1 function: `fetchSetPrices(game, setCode) -> [number: Price]`,
cached 24h, falls back to bundled price on failure. Uniform across apps.

---

## 8. Open questions — LET'S DECIDE THESE TOGETHER

<a name="q1-auth"></a>
### Q1. Auth / abuse protection on the read endpoint
The Worker will be a public URL. Options:
- **(a)** Wide open, rely on Cloudflare rate-limiting + edge cache. Simplest. Risk: someone else uses our free endpoint.
- **(b)** Shared static API key baked into the apps (trivial to extract, but filters casual abuse).
- **(c)** Cloudflare rate-limit rules per IP + no key.
- **My lean:** (c) for v1 — no key, lean on caching + rate limits. Revisit if abused.

<a name="q2-identity"></a>
### Q2. Canonical game/set/card identity
Each app uses its own set codes (poke `me3`, ygo `PHNI`) and number formats.
- Do apps send **their native codes** and the backend owns all mapping? (simpler apps, fatter backend)
- Or define a **canonical scheme** every app converts to? (thinner backend, more app work)
- **My lean:** apps send native `(game, setCode, number)`; backend owns the mapping. Keeps client code trivial and lets us fix matching server-side without app updates.

<a name="q3-mapping"></a>
### Q3. The set-mapping table — where it lives & how it's built  ⚠️ *biggest risk*
Matching our set codes → TCGCSV groups, and our card numbers → TCGCSV products,
is the fiddly heart of this. Questions:
- Auto-build by fuzzy-matching (set name + release date), like ygo's `featuredCardID` heuristic? With a manual-override file for edge cases?
- Store the mapping in-repo (versioned, reviewable) or in KV (editable live)?
- How do we **validate coverage** — a `price-coverage-audit` script per game (à la ygo's rarity audit) that flags unmapped sets / unmatched cards / cards that fell through?
- **My lean:** in-repo JSON overrides + auto-matcher; a coverage audit that must pass before ingest promotes. This is where most of the real work is.

<a name="q6-variants"></a>
### Q6. Variants / finishes / currency
TCGPlayer has subtypes: Normal, Reverse Holofoil, Holofoil, 1st Edition, etc.
Pokémon reverse-holo matters; the scanner may care about specific finishes.
- Store **all subtypes** per card and let the client pick a default? (I lean yes — cheap, and the scanner needs it.)
- Do any apps need **Cardmarket EUR** (TCGCSV carries it), or USD-only for v1?
- Which subtype is the headline `market` when an app shows one number?

<a name="q7-ingest-scale"></a>
### Q7. Ingest scale vs Cloudflare limits
Hundreds of TCGCSV fetches × 6 games in one daily job may exceed Worker
subrequest/CPU limits. Options: per-game cron staggering, Cloudflare Queues, or
pulling TCGCSV's **daily archive** (one download vs thousands of calls).
- **My lean:** investigate the archive endpoint first; fall back to per-game staggered crons.

<a name="q8-history"></a>
### Q8. Price history — NOW IN SCOPE (see §9)
Both §9 features need it. Decision is no longer *whether* but *how*:
- **D1** (SQLite) `price_history` table — queryable, powers movers + sparklines + backfill. My lean.
- **R2** dated daily object dumps — cheapest archival, but you compute movers by diffing two objects rather than querying. Good complement for cold archive.
- Retention: keep ≥ 90 daily snapshots in D1 for 30d/90d windows; optionally cold-store older in R2.
- **Action for downstream model:** confirm D1 as the history store and the schema.

<a name="q4-bundle"></a>
### Q4. Do app bundles still ship prices?
- Keep baking a price into each app's bundle (offline fallback) — bundle build pulls from **our** endpoint so there's one source of truth?
- Or thin the bundle and rely on first-launch fetch?
- **My lean:** keep bundled fallback, but the bundle pipeline sources from our API (single source of truth), so offline users still see *a* price and online users get fresh.

<a name="q5-freetier"></a>
### Q5. Free-tier read ceiling
Cloudflare free: 100k Worker req/day, 100k KV reads/day. With N apps × M users
× 24h client cache, do we fit? Need a rough usage model. Workers Paid is $5/mo
(10M req) if we outgrow it. **Action:** model expected daily reads once we know install counts.

<a name="q9-naming--ownership"></a>
### Q9. Naming / ownership
- Repo/service name: `tcg-price-api`? `lavai-prices`? something else?
- Deploy domain: `prices.lavailabs.com`? a `*.workers.dev` subdomain to start?

---

## 9. Feature ideas built on this infra

These are *why* the daily cross-game pull is worth it. Both depend on the D1
history store (D4/Q8).

### 9a. "Market" — trending cards / movers  (server-side)
Precomputed **once per day during ingest**, served as a leaderboard. Never
computed per-device.

```
GET /v1/movers?game=pokemon&window=7d&dir=gainers  → [ {set,number,name,market,pctChange,absChange}, ... ]
GET /v1/movers?game=all&window=7d                    → cross-game meta-view
```
Quality guardrails (these make or break it):
- **Price floor** (e.g. market ≥ $2) — kills penny-card %-noise ($0.01→$0.03 = +200%).
- **Rank by blend of %-change AND absolute-$** — so a $0.50 move on a $200 card ranks.
- **Exclude cards with no prior snapshot** in the window — avoids new-set "from nothing" = +100% artifacts.
- **Windows: 7d / 30d** (1d too jumpy for daily data; 30d needs ≥30 snapshots).
- **Cross-game view** (`game=all`) is a genuinely novel hook no single-game app could offer — strong differentiator + retention.
- Recompute in the daily job; cache the leaderboard in KV (`movers:{game}:{window}`).

### 9b. Collection value tracking  (on-device)
**Privacy principle (hard rule):** the backend serves only *public market data* —
never user holdings. No accounts, no server-side collection storage, no PII/GDPR
surface. Collection value is computed *in the app* from prices pulled from us.

- **Current value**: apps already do this (Stats = Σ market × count); backend just makes it fresh.
- **Value over time** — two flavors:
  - *Real snapshots*: app appends `{date, value}` to a local SwiftData series once/day. Honest, offline, but empty on day one.
  - *Counterfactual backfill*: current holdings × historical prices from D1 sparkline endpoint → instant 30/90d chart on first open (assumes you always owned them).
  - **My lean:** backfill for an instant chart + real snapshots going forward, labeled honestly.
- **Bonus:** the same D1 per-card history endpoint gives **Card Inspect sparklines** for free (`GET /v1/history?game=&set=&number=&window=90d`), and can restore ygo-rip's dropped "Low".

### Strategic note
10a turns every app from "pack sim" → "pack sim + market tracker" (return-visit
driver). 10b deepens the collector loop. Both are near-free incrementally once
we're already pulling daily. Neither requires user accounts.

---

## 10. Parking lot / notes
- TCGCSV is one person's free service → longevity risk. Source abstraction (D6)
  means we can swap to Scrydex/JustTCG without app changes. Be a good citizen:
  daily pull, cache, don't hammer.
- The scanner's image→card identification is a *separate* concern; once it knows
  `(game, set, number)` it's just another `/v1/price` caller.
- ygo-rip's dropped "Low" price could come back — TCGCSV provides real low/mid/
  market/high per printing.
