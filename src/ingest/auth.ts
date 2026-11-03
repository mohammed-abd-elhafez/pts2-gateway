import { createHash } from 'node:crypto';
import type { Pool } from '../db/pool.js';

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * The station secret arrives either as the password of an HTTP Basic header
 * or as the first path segment after /pts/. Which one a controller uses
 * depends on its Server tab, so both are accepted. A path with an empty segment
 * ("/pts//x") is never a valid upload URL and carries no secret.
 */
export function extractSecret(headers: Record<string, unknown>, rawUrl: string): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const password = colon === -1 ? '' : decoded.slice(colon + 1);
    if (password) return password;
  }
  const path = pathOf(rawUrl);
  if (path.includes('//')) return null;
  const m = /^\/pts\/([^/]+)(?:\/|$)/.exec(path);
  return m ? m[1]! : null;
}

function pathOf(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

/** Replaces a path-carried secret, however many slashes precede it, so it never reaches logs or storage. */
export function redactUrl(rawUrl: string): string {
  return rawUrl.replace(/^(\/pts\/+)[^/?]+/, '$1***');
}

/**
 * The path as it may appear in a log. Only the routes we serve are shown; any other path might be an upload URL
 * with a typo (a doubled slash, another case, a prefix) and so might carry a secret, so it is not shown at all.
 */
export function loggablePath(rawUrl: string): string {
  const path = pathOf(rawUrl);
  if (path === '/healthz' || path === '/readyz') return path;
  if (path.startsWith('/v1/stations/')) return path;
  if (path === '/pts' || path.startsWith('/pts/')) return redactUrl(path);
  return '[unrouted]';
}

/** Removes a known secret from any text: a stored header, query string or log field. */
export function redactSecret(text: string, secret: string | null): string {
  return secret ? text.split(secret).join('***') : text;
}

export interface AuthedStation {
  id: number;
  operatorStationCode: string;
}

export async function findStationBySecret(pool: Pool, secret: string): Promise<AuthedStation | null> {
  const { rows } = await pool.query<{ id: string; operator_station_code: string }>(
    `SELECT id, operator_station_code FROM stations WHERE secret_hash = $1`,
    [hashSecret(secret)],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), operatorStationCode: row.operator_station_code } : null;
}
