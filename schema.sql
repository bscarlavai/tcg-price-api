-- D1 history store (DESIGN.md D11). Apply once: wrangler d1 execute tcg-price-history --file schema.sql
CREATE TABLE IF NOT EXISTS price_history (
  game TEXT NOT NULL,
  set_code TEXT NOT NULL,
  number TEXT NOT NULL,
  finish TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',   -- yugioh rarity printing; '' elsewhere
  date TEXT NOT NULL,            -- YYYY-MM-DD
  market_cents INTEGER NOT NULL,
  low_cents INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY (game, set_code, number, finish, variant, date)
);
CREATE INDEX IF NOT EXISTS idx_history_date ON price_history (game, date);
-- NB: /v1/history forces `INDEXED BY sqlite_autoindex_price_history_1` (the PK's autoindex) so it
-- seeks by (game, set_code, number) instead of scanning idx_history_date over the whole window — a
-- 180d Magic lookup is ~80ms vs ~7.5s. A dedicated composite index would be tidier, but D1 OOMs
-- building one over a table this size, and the PK autoindex already covers the equality prefix.
