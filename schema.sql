-- D1 history store (DESIGN.md D11). Apply once: wrangler d1 execute tcg-price-history --file schema.sql
CREATE TABLE IF NOT EXISTS price_history (
  game TEXT NOT NULL,
  set_code TEXT NOT NULL,
  number TEXT NOT NULL,
  finish TEXT NOT NULL,
  date TEXT NOT NULL,            -- YYYY-MM-DD
  market_cents INTEGER NOT NULL,
  low_cents INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY (game, set_code, number, finish, date)
);
CREATE INDEX IF NOT EXISTS idx_history_date ON price_history (game, date);
