# Catalog↔TCGplayer mapping learnings from riplist (2026-07-03)

Riplist just rebuilt its One Piece catalog pipeline (Bandai cardlist as source of truth,
tcgcsv for TCGplayer product-id mapping) and ran a full three-game coverage audit against
tcgcsv. These are the findings that matter for this API. Reference implementation:
`riplist/data-pipeline/build_onepiece_index.py` (mapping passes) and
`riplist/data-pipeline/gapfill_tcgplayer.py` (name/number normalisation).

## The join key contract

- Riplist manifests now ship `tcgplayer_id` (TCGplayer productId) per printing:
  **Lorcana 2,860/3,139** (Lorcast provides it natively), **One Piece 4,217/4,571**
  (mapped at build time), **Pokémon only on ~1,010 gap-filled rows** — pokemontcg.io
  does NOT provide product ids, so Pokémon is the mapping gap on the client side.
- The API's primary lookup should be **by productId (batch)**. Name/set/number lookup
  is a catalog-build-time problem; don't reimplement fuzzy matching at request time.
- Distinguish "product unknown" from "product known, no market price". Clients render
  unpriced cards; a missing price must never make a card disappear.

## tcgcsv sharp edges we hit (category 68 = One Piece, 71 = Lorcana, 3 = Pokémon)

1. **The same collector number appears in multiple groups.** A card's own set, its
   release-event group ("OP16 RE"), demo decks ("One Piece Demo Deck Cards"), and
   pre-release groups all list the same number. Deduping by number alone maps prices to
   the wrong product. Disambiguate by group first, then variant descriptor.
2. **Group abbreviations are inconsistent.** "The Azure Sea's Seven" abbreviates `OP14`
   while the analogous next set is `OP15-EB04`. Treat abbreviation as a *prefix* hint,
   never parse identity from it.
3. **Variant descriptors live in the product name's trailing parens** — but so do
   number disambiguators: "Charlotte Katakuri (067) (Alternate Art)" — `(067)` is the
   collector number, not a variant. Strip number-only parens before reading descriptors.
4. **Pokémon product names embed the number**: "Caterpie - 1/12", "Pikachu - SWSH039",
   plus bracket suffixes "[Winner]"/"[Staff]" after the parens. Normalisation must strip
   trailing (…)/[…] chunks repeatedly, then a trailing `- <number>` suffix.
5. **Set-name vocabularies differ per source**: "SV02: Paldea Evolved" vs "Paldea
   Evolved"; "HS—Triumphant" (em dash!) vs "Triumphant"; "McDonald's Promos 2019" vs
   "McDonald's Collection 2019"; "XY Promos" vs "XY Black Star Promos"; Radiant
   Collection is a separate TCGplayer group but folded into its host set by
   pokemontcg.io (RC numbers). And fold diacritics ("Pokémon GO"). If the API keeps a
   group→set mapping, make it an explicit reviewed table, not pure normalisation.
6. **Descriptor vocabulary drift**: "Parallel" ≈ "Alternate Art", "SPR" ≈ "SP",
   optcgapi's "(Reprint)" has no TCGplayer counterpart (premium-booster reprints are
   plain-named products in the PRB groups). Riplist resolved these with a small alias
   map + a "single leftover product ↔ single leftover printing in the same set-scoped
   pool" pairing pass; that combination took OP mapping from 57% → 92% with zero
   duplicate assignments.
7. **Prices come per subTypeName** (Normal / Holofoil / Reverse Holofoil / Foil /
   1st Edition …). Serve them per subtype and let clients interpret per game: Lorcana
   maps Normal/Foil onto one card row; One Piece parallels are separate products with
   one subtype each; Pokémon reverse-holo pricing matters to collectors.

## Coverage facts from the audit (what clients will ask for)

- TCGplayer sells ~830 One Piece products (promos, all 30 starter decks) that optcgapi
  never carried — riplist now has them via Bandai. Everything riplist carries exists on
  TCGplayer (0 orphans), so near-100% price coverage is achievable for OP.
- Lorcana: main sets are ~exact; the genuinely-TCGplayer-only items are the two
  Illumineer's Quest boxes, a handful of letter variants (Dalmatian Puppy 4b–4e), and
  promo partitioning differs (their "Disney Lorcana Promo Cards" vs Lorcast's
  "Promo Set 1/2/3") — match promos per-card by (name, number), not per-group.
- Pokémon: pokemontcg.io is current through the ME era (don't assume it lags), but
  structurally lacks boxed-product groups (Trainer Kits, TCG Classic, Battle Stadium,
  First Partner Pack, ME: 30th Celebration). Riplist gap-fills those from tcgcsv with
  `tcgp<productId>` ids — the API will see requests for those product ids too.
- Worth skipping on ingest (riplist denylists them): World Championship decks
  (non-standard backs), jumbo cards, prize-pack/league stamped same-number reprints —
  they explode row counts without being scannable/collectable in the usual sense.

## One structural suggestion

Riplist recognises cards offline from bundled manifests; prices are the only
network-fresh data it needs. The ideal response shape is a **batch endpoint keyed by
productId returning (market, subtype, updatedAt)** with aggressive cache headers —
riplist can then refresh its visible collection in one round trip. Per-card GET is a
nice-to-have; batch is the workhorse.
