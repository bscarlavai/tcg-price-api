// Thin Cloudflare REST client for the ingest job (runs in GitHub Actions — no wrangler
// dependency). Needs CF_ACCOUNT_ID + CF_API_TOKEN (KV Storage:Edit, D1:Edit) and the
// resource ids from env. All calls are idempotent upserts.

const API = 'https://api.cloudflare.com/client/v4';

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}/accounts/${env('CF_ACCOUNT_ID')}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env('CF_API_TOKEN')}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`cloudflare ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function kvGet(key) {
  const res = await fetch(
    `${API}/accounts/${env('CF_ACCOUNT_ID')}/storage/kv/namespaces/${env('KV_NAMESPACE_ID')}/values/${encodeURIComponent(key)}`,
    { headers: { authorization: `Bearer ${env('CF_API_TOKEN')}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`kv get ${res.status}`);
  return res.json();
}

// Bulk write: up to 10k pairs per call.
export async function kvPutMany(pairs) {
  for (let i = 0; i < pairs.length; i += 10000) {
    await cf(`/storage/kv/namespaces/${env('KV_NAMESPACE_ID')}/bulk`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pairs.slice(i, i + 10000).map(([key, value]) => ({ key, value: JSON.stringify(value) }))),
    });
  }
}

export async function d1Query(sql, params = []) {
  return cf(`/d1/database/${env('D1_DATABASE_ID')}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
}

// History rows with inline (escaped) values rather than bound params: D1 caps params at
// 100/statement but statements at 100KB, so inlining gets ~500 rows per REST call —
// the difference between minutes and hours at five-game scale.
const sqlVal = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

export async function d1InsertHistory(rows) {
  const cols = ['game', 'set_code', 'number', 'finish', 'variant', 'date', 'market_cents', 'low_cents', 'source'];
  for (let i = 0; i < rows.length; i += 500) {
    const values = rows.slice(i, i + 500)
      .map((r) => `(${cols.map((c) => sqlVal(r[c])).join(',')})`).join(',');
    await d1Query(`INSERT OR REPLACE INTO price_history (${cols.join(',')}) VALUES ${values}`);
  }
}
