import type { Pool } from '../db/pool.js';
import { redactSecret } from './auth.js';

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

/** Drops credential headers and removes the station secret from every other header value. */
export function redactHeaders(headers: Record<string, unknown>, secret: string | null = null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out[k] = redactSecret(v, secret);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? redactSecret(x, secret) : x));
    else out[k] = v;
  }
  return out;
}

export interface Upload {
  stationId: number;
  /** the presented secret, so it can be removed from anything stored */
  secret: string | null;
  method: string;
  path: string;
  query: string | null;
  headers: Record<string, unknown>;
  contentType: string | null;
  body: Buffer;
}

/** Valid JSON text, or null. PostgreSQL jsonb cannot hold \u0000, so such bodies stay raw-only. */
function jsonOrNull(body: Buffer): string | null {
  if (body.length === 0) return null;
  const text = body.toString('utf8');
  if (text.includes('\\u0000')) return null;
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

/** PostgreSQL refuses some JSON that JSON.parse accepts (lone surrogates, extreme nesting). */
const isJsonbRefusal = (err: unknown): boolean => {
  const code = (err as { code?: string }).code ?? '';
  return code.startsWith('22') || code.startsWith('54');
};

async function insertUpload(pool: Pool, u: Upload, json: string | null): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO raw_uploads (station_id, method, path, query, headers, content_type, body_bytes, body_raw, body_json)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb) RETURNING id`,
      [
        u.stationId,
        u.method,
        u.path,
        u.query === null ? null : redactSecret(u.query, u.secret),
        JSON.stringify(redactHeaders(u.headers, u.secret)),
        u.contentType,
        u.body.length,
        u.body,
        json,
      ],
    );
    await client.query('COMMIT');
    return Number(rows[0]!.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stores one upload exactly as received and marks the station as seen. Returns the upload id.
 * The raw bytes are the point of capture: if the database refuses the parsed JSON, the upload is
 * kept without it rather than lost.
 */
export async function storeUpload(pool: Pool, u: Upload): Promise<number> {
  const json = jsonOrNull(u.body);
  let id: number;
  try {
    id = await insertUpload(pool, u, json);
  } catch (err) {
    if (json === null || !isJsonbRefusal(err)) throw err;
    id = await insertUpload(pool, u, null);
  }
  // Bookkeeping only, outside the upload's transaction so it never holds the station row while a big body is written.
  await pool
    .query(`UPDATE stations SET last_seen_at = now() WHERE id = $1`, [u.stationId])
    .catch(() => undefined);
  return id;
}
