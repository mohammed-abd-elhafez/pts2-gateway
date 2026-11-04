import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB = resolve('deploy/lib.sh');

/** Runs a shell snippet with deploy/lib.sh loaded, in a scratch project whose .env is given, with a recording stand-in for curl. */
function run(env: string, snippet: string): { calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pts2-ops-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), `#!/bin/bash\n{ echo "ARGS: $*"; [ -t 0 ] || cat; echo "---"; } >> "${dir}/calls"\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  writeFileSync(join(dir, '.env'), `BACKUP_DIR=${dir}/backups\nSTATE_DIR=${dir}/state\n${env}\n`);
  execFileSync('bash', ['-c', `. "${LIB}"; ${snippet}`], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe' });
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
  return { calls };
}

describe('alert()', () => {
  it('sends to Telegram, with the token kept off the command line', () => {
    const { calls } = run('TELEGRAM_BOT_TOKEN=123:abcDEF\nTELEGRAM_CHAT_ID=-100555', 'alert "disk is 91% full"');
    expect(calls).toContain('https://api.telegram.org/bot123:abcDEF/sendMessage');
    expect(calls).toContain('chat_id=-100555');
    expect(calls).toMatch(/text=pts2-gateway \(.+\): disk is 91% full/);
    expect(calls.split('\n').find((l) => l.startsWith('ARGS:'))).not.toContain('abcDEF');
  });

  it('sends to the webhook as before', () => {
    const { calls } = run('ALERT_WEBHOOK_URL=https://hooks.example/x', 'alert "backup failed"');
    expect(calls).toContain('https://hooks.example/x');
    expect(calls).toContain('backup failed');
  });

  it('does nothing outside the log when no channel is configured', () => {
    expect(run('', 'alert "nobody listens"').calls).toBe('');
  });

  it('sends to both channels when both are configured', () => {
    const { calls } = run('TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=2\nALERT_WEBHOOK_URL=https://hooks.example/x', 'alert "x"');
    expect(calls).toContain('api.telegram.org');
    expect(calls).toContain('hooks.example');
  });
});

describe('compose()', () => {
  it('uses the files named by COMPOSE_FILE in .env, in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pts2-ops-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/bin/bash\necho "$@" > "${dir}/docker-args"\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(join(dir, '.env'), `BACKUP_DIR=${dir}/b\nSTATE_DIR=${dir}/s\nCOMPOSE_FILE=a.yml:b.yml:c.yml\n`);
    execFileSync('bash', ['-c', `. "${LIB}"; compose ps -q app`], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(readFileSync(join(dir, 'docker-args'), 'utf8').trim()).toBe('compose -f a.yml -f b.yml -f c.yml ps -q app');
  });

  it('defaults to the production pair', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pts2-ops-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/bin/bash\necho "$@" > "${dir}/docker-args"\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(join(dir, '.env'), `BACKUP_DIR=${dir}/b\nSTATE_DIR=${dir}/s\n`);
    execFileSync('bash', ['-c', `. "${LIB}"; compose up -d`], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(readFileSync(join(dir, 'docker-args'), 'utf8').trim()).toBe('compose -f docker-compose.yml -f deploy/compose.prod.yaml up -d');
  });
});

/** Runs a snippet and returns what it printed. */
function out(env: string, snippet: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pts2-ops-'));
  writeFileSync(join(dir, '.env'), `BACKUP_DIR=${dir}/backups\nSTATE_DIR=${dir}/state\n${env}\n`);
  mkdirSync(join(dir, 'state'), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'state', name), content);
  return execFileSync('bash', ['-c', `. "${LIB}"; ${snippet}`], { cwd: dir, encoding: 'utf8' });
}
const hoursAgo = (h: number): string => String(Math.floor(Date.now() / 1000) - h * 3600);

describe('offsite_check()', () => {
  it('warns when backups are only on this server', () => {
    expect(out('', 'offsite_check')).toMatch(/^WARN\|.*only on this server.*RCLONE_REMOTE/m);
  });
  it('is silent when the last copy off the server is recent', () => {
    expect(out('RCLONE_REMOTE=crypt:pts2', 'offsite_check', { 'last-offsite': hoursAgo(3) })).toBe('');
  });
  it('is critical when the copy off the server is stale or has never happened', () => {
    expect(out('RCLONE_REMOTE=crypt:pts2', 'offsite_check', { 'last-offsite': hoursAgo(40) })).toMatch(/^CRIT\|.*off-site/m);
    expect(out('RCLONE_REMOTE=crypt:pts2', 'offsite_check')).toMatch(/^CRIT\|.*never/m);
  });
});

describe('alerts_check()', () => {
  it('warns when alerts have nowhere to go', () => {
    expect(out('', 'alerts_check')).toMatch(/^WARN\|.*no alert channel/m);
  });
  it('is silent with Telegram or a webhook configured', () => {
    expect(out('TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=2', 'alerts_check')).toBe('');
    expect(out('ALERT_WEBHOOK_URL=https://x', 'alerts_check')).toBe('');
  });
  it('warns about a Telegram token without a chat id', () => {
    expect(out('TELEGRAM_BOT_TOKEN=1:a', 'alerts_check')).toMatch(/^WARN\|.*TELEGRAM_CHAT_ID/m);
  });
});
