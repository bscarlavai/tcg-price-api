// Thin Cloudflare REST client for the ingest job (runs in GitHub Actions — no wrangler
// dependency). Needs CF_ACCOUNT_ID + CF_API_TOKEN (KV Storage:Edit, D1:Edit) and the
// resource ids from env. All calls are idempotent upserts.
//
// Every call takes a target suffix ('' = primary). Setting the `_2` quartet mirrors writes
// to a second Cloudflare account — the account migration's overlap window, where both the
// old and new stacks must stay fed from ONE TCGCSV pull (tcgcsv.com asks for one pull/day;
// a second full ingest run would double our traffic against a free service). Delete the
// `_2` env vars and the overlap ends — see docs/account-migration.md Phase B/C.

const API = 'https://api.cloudflare.com/client/v4';

function env(name, t = '') {
  const v = process.env[name + t];
  if (!v) throw new Error(`missing env ${name}${t}`);
  return v;
}

// Write targets, primary first. A partially-configured secondary is a config error, not a
// reason to silently write one account — fail loudly before any write happens.
export function targets() {
  const list = [{ t: '', label: 'primary' }];
  const vars = ['CF_ACCOUNT_ID_2', 'CF_API_TOKEN_2', 'KV_NAMESPACE_ID_2', 'D1_DATABASE_ID_2'];
  const set = vars.filter((v) => process.env[v]);
  if (set.length && set.length !== vars.length)
    throw new Error(`incomplete secondary target: missing ${vars.filter((v) => !process.env[v]).join(', ')}`);
  if (set.length) list.push({ t: '_2', label: 'secondary' });
  return list;
}

async function cf(path, init = {}, t = '') {
  const res = await fetch(`${API}/accounts/${env('CF_ACCOUNT_ID', t)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env('CF_API_TOKEN', t)}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`cloudflare ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function kvGet(key, t = '') {
  const res = await fetch(
    `${API}/accounts/${env('CF_ACCOUNT_ID', t)}/storage/kv/namespaces/${env('KV_NAMESPACE_ID', t)}/values/${encodeURIComponent(key)}`,
    { headers: { authorization: `Bearer ${env('CF_API_TOKEN', t)}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`kv get ${res.status}`);
  return res.json();
}

// Bulk write: up to 10k pairs per call.
export async function kvPutMany(pairs, t = '') {
  for (let i = 0; i < pairs.length; i += 10000) {
    await cf(`/storage/kv/namespaces/${env('KV_NAMESPACE_ID', t)}/bulk`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pairs.slice(i, i + 10000).map(([key, value]) => ({ key, value: JSON.stringify(value) }))),
    }, t);
  }
}

export async function d1Query(sql, params = [], t = '') {
  return cf(`/d1/database/${env('D1_DATABASE_ID', t)}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  }, t);
}

// History rows with inline (escaped) values rather than bound params: D1 caps params at
// 100/statement but statements at 100KB, so inlining gets ~500 rows per REST call —
// the difference between minutes and hours at five-game scale.
const sqlVal = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

// Shared by the daily push (REST, statement-at-a-time) and the archive backfill
// (bulk .sql files imported via `wrangler d1 execute --file`).
export function historyInsertStatements(rows, chunk = 500) {
  const cols = ['game', 'set_code', 'number', 'finish', 'variant', 'date', 'market_cents', 'low_cents', 'source'];
  const statements = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const values = rows.slice(i, i + chunk)
      .map((r) => `(${cols.map((c) => sqlVal(r[c])).join(',')})`).join(',');
    statements.push(`INSERT OR REPLACE INTO price_history (${cols.join(',')}) VALUES ${values}`);
  }
  return statements;
}

export async function d1InsertHistory(rows, t = '') {
  for (const sql of historyInsertStatements(rows)) await d1Query(sql, [], t);
}
