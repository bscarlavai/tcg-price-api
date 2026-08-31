# Account Migration — moving tcg-price-api to the new Cloudflare account

> **Goal:** run the service from the new Cloudflare account on its own domain
> (`tcg-prices.com`), independent of `lavailabs.com` — the API now serves more than the
> `-rip` family (poke-artist is next).
> **Constraint:** zero downtime, including for app binaries already on users' phones.
> **Prime rule of the whole migration:** *stand the new host up and ship the client updates
> BEFORE moving the `lavailabs.com` zone.* Everything below is ordered around that.

**Status (2026-08-01):** **Phase A complete.** `tcg-prices.com` is live in the new account and
serving prices byte-identical to the old host. Seeded 1,107 sets / 252,366 history rows across
all five games, 0 failures. B1 (dual-write fan-out) is implemented and verified. **Next: add
the four `*_NEW` GitHub secrets, then B2 — the client base URLs.**

New-account resources: KV `a7ce2fb4…` (`tcg-price-api-prices`) + `5b084195…`
(`tcg-price-api-report-meta`), D1 `24797de7-7877-43b0-8aa6-c53ca237fba2`, R2
`tcg-scan-reports`, Worker `tcg-price-api`. Bindings (`env.PRICES`, `env.REPORT_META`) kept as
they were — only the dashboard-facing namespace titles gained the service prefix, which
changes no ids and no code.

**Still outstanding from A4: the D1 history export from the old account.** The new D1 holds
only history generated since the seed, so `/v1/history` and `/v1/movers` on `tcg-prices.com`
have a shallow window until the old account's rows are imported. Movers boards need both
window endpoints, so they stay sparse until then — not a blocker for `/v1/prices`, but it must
land before B3 ships clients that draw sparklines.

---

## 0. Why it's simpler than a normal migration

`lavailabs.com` is also moving to the new account. So the old hostname and the new one end
up in the **same** account, and `rip-prices.lavailabs.com` becomes just a second
`custom_domain` route on the same Worker — no proxy, no redirect, no cross-account shim.
Old and new binaries hit the identical Worker, forever.

Two facts make the rest cheap:

- **The Worker is host-agnostic.** `worker/index.js` never reads the `Host` header (it only
  tolerates an optional `/api` path prefix, DESIGN.md D13). Nothing in the code cares what
  it's called.
- **The ingest talks to KV/D1 over the REST API**, not bindings — `ingest/lib/cloudflare.js`
  reads four env vars. Running it against a second account is *just a different env*, which
  is what makes the dual-write overlap in Phase B a non-event.

## 1. The one trap: zone-move sequencing

Cloudflare does not transfer a zone between accounts on non-Enterprise plans. You **delete it
from the old account and re-add it to the new one**: DNS records must be re-created, and the
zone may be issued different nameservers (registrar update + propagation). There is a real
window where `lavailabs.com` DNS is in flux.

That window is harmless **if the apps are already on `tcg-prices.com`** when it happens. Even
for installs that haven't updated, the outage degrades correctly rather than breaking: per
`docs/client-migration.md` §1, the API being down must never blank or wrong a price — clients
fall back to disk-persisted and bundled prices.

Do it in the other order and you take a real outage on the only hostname every shipped binary
knows. **Don't.**

## 2. Resource inventory

| Resource | How it moves | Notes |
|---|---|---|
| Worker `tcg-price-api` | `wrangler deploy` | code is account-agnostic |
| KV `PRICES` | **regenerate**, don't copy | a full ingest `--push` rebuilds every set blob from TCGCSV |
| KV `REPORT_META` | nothing to move | counter keys carry a 48h TTL |
| D1 `tcg-price-history` | `wrangler d1 export` → import | **the only real data risk** — see §4.4 |
| R2 `riplist-scan-reports` | no transfer path | create as `tcg-scan-reports`; rclone the old corpus or leave it |
| Rate limiters | config only | `namespace_id` 1001/1002 are per-account labels, not global ids |
| Secret `REPORT_KEY` | `wrangler secret put` | not in `wrangler.toml`; easy to forget |
| GH Actions secrets | re-add | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `KV_NAMESPACE_ID`, `D1_DATABASE_ID` |

---

## Phase A — stand up the new stack

The old stack keeps serving throughout. Nothing here is visible to any client.

**A1. Register the domain** in Cloudflare Registrar **while logged into the new account**, so
the zone is native there and never needs its own move. ✅ `tcg-prices.com` acquired 2026-08-01.

**A1b. Know which account is which.** They are easy to invert, and the names actively mislead
— the *personal gmail* account is the one running production:

| | Cloudflare account | ID | Holds |
|---|---|---|---|
| **OLD** | `bscarlavai@gmail.com` | `b115c2531b3135de4a87c65e6096cd3c` | the live Worker, KV, D1, R2 |
| **NEW** | `bret@lavailabs.com` | `d42538cebc7d337a0c0769a11f261ea5` | `tcg-prices.com`; everything we create |

**Gotcha:** `.wrangler/cache/wrangler-account.json` (gitignored, per-clone) pins wrangler to a
chosen account and silently outlives a re-login. A stale pin against a token for the *other*
account surfaces as `Authentication error [code: 10000]` on any `kv`/`d1` command — which
reads like a bad token and isn't. Delete the file; it's regenerated.

Hold the OAuth session on the **NEW** account (all the create/deploy work) and use a
read-only API token for the **OLD** account's D1 export in A4 — Account · D1 (Read) +
Account · Workers KV Storage (Read). Env vars beat OAuth, so scope that token to the one
shell that runs the export:

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=b115c2531b3135de4a87c65e6096cd3c \
  npx wrangler d1 export tcg-price-history --remote --output history.sql
```

Never `wrangler login` into the old account to do this — it would drop the new account's
session and re-pin the cache, putting you right back in the `code: 10000` confusion.

**A2. Create the resources** (new account):

```sh
npx wrangler kv namespace create PRICES
npx wrangler kv namespace create REPORT_META
npx wrangler d1 create tcg-price-history
npx wrangler d1 execute tcg-price-history --remote --file schema.sql
npx wrangler r2 bucket create tcg-scan-reports
npx wrangler secret put REPORT_KEY              # same value the apps already send
```

**A3. Update `wrangler.toml`** — the four ids (`PRICES`, `REPORT_META`, D1 `database_id`, R2
`bucket_name`) and the route:

```toml
routes = [{ pattern = "tcg-prices.com", custom_domain = true }]
```

Leave `workers_dev = false`. DESIGN.md D13 stands: a `workers.dev` URL never ships in a client.

**A4. Seed the data.**

*Prices (KV)* — regenerate from source, don't copy:

```sh
export CF_ACCOUNT_ID=… CF_API_TOKEN=… KV_NAMESPACE_ID=… D1_DATABASE_ID=…   # NEW account
for g in pokemon yugioh magic onepiece lorcana; do node ingest/run.js --game "$g" --push; done
node ingest/movers.js
```

*History (D1)* — this is the slow, risky step. `price_history` is large enough that D1 OOMs
building an index over it (see the note in `schema.sql`), so budget real time and verify row
counts on both sides:

```sh
npx wrangler d1 export tcg-price-history --remote --output history.sql   # OLD account
npx wrangler d1 execute tcg-price-history --remote --file history.sql    # NEW account
npx wrangler d1 execute tcg-price-history --remote \
  --command "SELECT COUNT(*), MIN(date), MAX(date) FROM price_history"   # compare both
```

If the export/import fights back, the fallback is that **history is reproducible**: retention
is 180 days hot (D11) and the original series was built by replaying TCGCSV archives — see
`backfill/`. Slower, but it means a failed import is never data loss.

**A5. Deploy and smoke-test:**

```sh
npx wrangler deploy
npm run golden      # local goldens — does not hit the network
curl 'https://tcg-prices.com/v1/price?game=pokemon&set=me3&number=1'   # market ≈ 0.08 (Spinarak)
curl -s -o /dev/null -w '%{http_code}\n' 'https://tcg-prices.com/v1/prices?game=magic&set=lea'
```

Compare a handful of set blobs against the old host before moving on.

## Phase B — overlap: both stacks live, both fed

**B1. Dual-feed the ingest.** ✅ implemented. Both stacks stay fresh for the whole rollout, so
there is no "stale new host" cutover moment and rollback stays free.

The tempting design — run the ingest loop twice, or split download/push into separate Actions
jobs — is wrong for two reasons. `ingest/sources/tcgcsv.js` has no local cache, so a second
run doubles our traffic against a free service we've committed to pulling from once a day
(DESIGN.md risk table). And splitting jobs doesn't help: `rows` never hit disk (`out/kv/` holds
only the KV payload), so a push-only job would have to re-derive history rows from blobs and
risk diverging from what the primary records — while the per-set `kvGet` diff is per-account
work that happens either way.

So the fan-out lives in-process: `targets()` in `ingest/lib/cloudflare.js` returns
`[primary]`, plus `secondary` when the `_2` env quartet is set; every client function takes a
target suffix. `run.js` computes history once (target-independent) and **diffs each target
separately** rather than mirroring the primary's changed-list — so a write that failed against
one account is picked up on the next run instead of leaving that set stale there until its
price happens to move again. `movers.js` mirrors its leaderboards the same way.

Failure semantics: primary throws (the live stack's failure is the run's failure); secondary
logs and sets exit 1 *after* the primary write lands, so a mirror problem is loud but never
rolls back or masks a good primary write. A partially-set `_2` quartet throws before any write.

Add the four repo secrets — `CF_ACCOUNT_ID_NEW`, `CF_API_TOKEN_NEW`, `KV_NAMESPACE_ID_NEW`,
`D1_DATABASE_ID_NEW` — then one `workflow_dispatch` to confirm both targets report `pushed
[primary]` / `pushed [secondary]`. After that the 21:37 UTC cron carries it.

**B2. Update the client base URLs** — 10 call sites:

| File | Line |
|---|---|
| `poke-rip/PokeRip/Services/PriceService.swift` | 18 |
| `one-rip/OneRip/Services/PriceService.swift` | 18 |
| `mtg-rip/MTGRip/Services/PriceService.swift` | 22 |
| `lor-rip/LorRip/Services/PriceService.swift` | 26 |
| `ygo-rip/YGORip/Services/PriceService.swift` | 30 |
| `riplist/Riplist/Services/PriceService.swift` | 571 |
| `riplist/Riplist/Services/ReportService.swift` | 14 |
| `riplist/data-pipeline/apply_api_prices.py` | 43 |
| `riplist/data-pipeline/publish_pack.py` | 118 |
| `riplist/data-pipeline/add_finishes.py` | 23 |

Doc comments in those files (and `riplist/Riplist/Games/GameProfile.swift`,
`riplist/Riplist/Models/Card.swift`) name the old host in prose — sweep those too.
poke-artist ships against `tcg-prices.com` from day one; fix `POKEARTIST-SPEC.md` (lines 149,
421, 545) before its client code exists.

**B3. Ship.** App Store review × 7 apps, then refresh the pack snapshots against the new host
(`python3 data-pipeline/apply_api_prices.py --game <game>`) and republish. The tail of
un-updated installs is the reason Phase C exists.

## Phase C — reclaim the old hostname

**C1.** Export `lavailabs.com`'s DNS as a BIND file from the old account **before** touching
anything.

**C2.** Delete the zone from the old account, add it to the new one, import the BIND file,
update nameservers at the registrar if they changed. Verify the website and any other
`lavailabs.com` records came back.

**C3.** Attach the legacy hostname to the same Worker:

```toml
routes = [
  { pattern = "tcg-prices.com", custom_domain = true },
  { pattern = "rip-prices.lavailabs.com", custom_domain = true },   # legacy: pre-migration binaries
]
```

`npx wrangler deploy`. Old binaries are now served by the new stack and stay working
indefinitely — there is no second cutover and no expiry to track.

**C4.** Delete the old account's Worker, KV namespaces, D1, and R2 bucket once C3 is verified,
and drop the dual-feed from `ingest.yml`.

---

## Rollback

Cheap at every point, because the old stack is untouched until C4:

- **Phase A/B:** revert the client URL constants; the old host never stopped serving.
- **Phase C:** if the zone move goes wrong, `lavailabs.com` DNS is restorable from the BIND
  export. Clients on `tcg-prices.com` are unaffected either way — that's the whole point of
  the ordering.

The point of no return is **C4**, not the zone move.

## Docs to update when it's done

- `wrangler.toml` — the comment block still explains the `rip-prices` naming
- `DESIGN.md` D13 — record the domain change and why (multi-app, not just `-rip`)
- `SETUP.md` §4–5 — new host in the smoke test and the launch note
- `CLAUDE.md` — the header line and the `curl` ground-truth recipe
- `docs/API.md`, `docs/client-migration.md` — base URL
