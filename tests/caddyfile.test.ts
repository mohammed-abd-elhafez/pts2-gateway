import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const caddyfile = readFileSync('deploy/caddy/Caddyfile', 'utf8');

/** The pattern and replacement of the `request>uri regexp` log filter, as Caddy reads them (Go regexp, close enough to JS for this). */
function uriFilter(): (uri: string) => string {
  const line = caddyfile.split('\n').find((l) => /request>uri\s+regexp\s/.test(l));
  if (!line) throw new Error('no request>uri regexp filter in the Caddyfile');
  const m = /request>uri\s+regexp\s+("([^"]+)"|(\S+))\s+(\S+)\s*$/.exec(line.trim());
  if (!m) throw new Error(`cannot read the filter: ${line}`);
  const pattern = (m[2] ?? m[3]!).replace(/^\(\?i\)/, '');
  const flags = /^\(\?i\)/.test(m[2] ?? m[3]!) ? 'gi' : 'g';
  const re = new RegExp(pattern, flags);
  return (uri) => uri.replace(re, m[4]!);
}

const SECRET = 'S3cr3tValue_abc-123';

describe('the access log hides a station secret in the path', () => {
  const filter = uriFilter();
  it.each([
    ['the normal address', `/pts/${SECRET}/upload`],
    ['no further path', `/pts/${SECRET}`],
    ['a doubled slash before', `//pts/${SECRET}/upload`],
    ['a doubled slash after', `/pts//${SECRET}/upload`],
    ['another case', `/PTS/${SECRET}/upload`],
    ['a prefix', `/api/pts/${SECRET}/upload`],
    ['a query string', `/pts/${SECRET}/upload?a=1`],
  ])('%s', (_name, uri) => {
    const shown = filter(uri);
    expect(shown).not.toContain(SECRET);
    expect(shown).toContain('***');
  });

  it('leaves the client API paths alone', () => {
    expect(filter('/v1/stations/OP-1/readings/batches/next')).toBe('/v1/stations/OP-1/readings/batches/next');
    expect(filter('/healthz')).toBe('/healthz');
  });

  it('still drops the credential headers', () => {
    expect(caddyfile).toMatch(/request>headers>Authorization\s+delete/);
    expect(caddyfile).toMatch(/request>headers>Cookie\s+delete/);
  });
});
