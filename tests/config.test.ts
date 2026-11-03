import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://x@localhost/x' };

describe('BATCH_MAX_ITEMS', () => {
  it('is unset by default', () => {
    expect(loadConfig(base).batchMaxItems).toBeUndefined();
  });
  it('is read as a positive integer', () => {
    expect(loadConfig({ ...base, BATCH_MAX_ITEMS: '500' }).batchMaxItems).toBe(500);
  });
  it('refuses zero and text', () => {
    expect(() => loadConfig({ ...base, BATCH_MAX_ITEMS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, BATCH_MAX_ITEMS: 'many' })).toThrow(ConfigError);
  });
});
