# One-time setup

## 1. Cloudflare resources
```sh
npx wrangler login
npx wrangler kv namespace create PRICES        # → paste id into wrangler.toml
npx wrangler d1 create tcg-price-history       # → paste database_id into wrangler.toml
npx wrangler d1 execute tcg-price-history --remote --file schema.sql
npx wrangler deploy
```

## 2. API token for ingest (GitHub Actions)
Cloudflare dashboard → My Profile → API Tokens → Create Token:
- Account · Workers KV Storage · Edit
- Account · D1 · Edit

## 3. GitHub repo secrets
`CF_ACCOUNT_ID`, `CF_API_TOKEN`, `KV_NAMESPACE_ID`, `D1_DATABASE_ID`

## 4. First ingest + smoke test
```sh
node ingest/run.js --game pokemon --push
curl 'https://tcg-price-api.<subdomain>.workers.dev/v1/price?game=pokemon&set=me3&number=1'
# expect market ≈ 0.08 (Spinarak — the acceptance test)
npm run golden
```

## 5. At launch
The `routes` entry in wrangler.toml attaches `rip-prices.lavailabs.com`
(the only URL that ever ships inside an app), then `npx wrangler deploy`.
