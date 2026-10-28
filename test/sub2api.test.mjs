import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { normalizeAccount, summarize, createQuotaSource } from '../sub2api.mjs';

const now = Date.parse('2026-10-25T00:00:00Z');
const account = { id: 7, name: 'private@example.com', platform: 'openai', type: 'oauth', status: 'active', schedulable: true, current_concurrency: 2, concurrency: 5, extra: {}, credentials: { access_token: 'do-not-expose-token' } };

test('missing and null quota stay unknown instead of becoming 100% remaining', () => {
  for (const extra of [{}, { codex_5h_used_percent: null }, { codex_5h_used_percent: '' }]) {
    const result = normalizeAccount({ ...account, extra }, null, { now });
    assert.equal(result.windows.length, 0);
    assert.equal(result.quotaState, 'unknown');
    assert.equal(result.status, 'unknown');
  }
});
test('a genuine zero sample is preserved and safe public fields are selected', () => {
  const result = normalizeAccount({ ...account, extra: { codex_5h_used_percent: 0, codex_5h_reset_at: '2026-10-25T04:00:00Z' } }, null, { now });
  assert.equal(result.windows[0].remainingPercent, 100);
  assert.equal(result.currentConcurrency, 2);
  assert.equal(result.maxConcurrency, 5);
  assert.equal(result.status, 'available');
  assert.equal(result.name, 'OpenAI #7');
  const text = JSON.stringify(result);
  for (const secret of ['private@example.com', 'do-not-expose-token', 'credentials', 'extra']) assert.ok(!text.includes(secret));
});
test('all applicable windows constrain availability and overage stays exhausted', () => {
  const result = normalizeAccount(account, { five_hour: { utilization: 12, resets_at: '2026-10-25T02:00:00Z' }, seven_day: { utilization: 105, resets_at: '2026-10-26T02:00:00Z' } }, { now });
  assert.equal(result.status, 'limited');
  assert.equal(result.windows[1].remainingPercent, 0);
  assert.equal(result.windows[1].usedPercent, 105);
});
test('disabled state overrides quota and missing concurrency is not zero', () => {
  const result = normalizeAccount({ ...account, schedulable: false, current_concurrency: null }, { five_hour: { utilization: 0, resets_at: '2026-10-25T02:00:00Z' } }, { now });
  assert.equal(result.status, 'disabled');
  assert.equal(result.currentConcurrency, null);
});
test('disabled account quotas are redacted from the public payload for every provider', () => {
  const usage = { updated_at: '2026-10-25T00:00:00Z', five_hour: { utilization: 12, resets_at: '2026-10-25T02:00:00Z' }, antigravity_quota: { 'gemini-pro': { utilization: 12, reset_time: '2026-10-26T02:00:00Z' } } };
  for (const platform of ['openai', 'antigravity', 'gemini']) {
    for (const disabled of [{ schedulable: false }, { status: 'disabled' }]) {
      const result = normalizeAccount({ ...account, platform, ...disabled, extra: { codex_7d_used_percent: 23, codex_7d_reset_at: '2026-10-26T02:00:00Z' } }, usage, { now, stale: true });
      assert.equal(result.status, 'disabled');
      assert.equal(result.quotaState, 'hidden');
      assert.deepEqual(result.windows, []);
      assert.equal(result.updatedAt, null);
      assert.equal(result.error, null);
      assert.equal(summarize([result]).disabled, 1);
      assert.ok(!JSON.stringify(result).includes('usedPercent'));
    }
  }
});
test('unsampled zero windows and expired samples do not imply fresh capacity', () => {
  assert.equal(normalizeAccount(account, { five_hour: { utilization: 0, window_stats: { cost: 0 } } }, { now }).windows.length, 0);
  const expired = normalizeAccount(account, { five_hour: { utilization: 100, resets_at: '2026-10-24T02:00:00Z' } }, { now });
  assert.equal(expired.quotaState, 'stale');
  assert.equal(expired.status, 'unknown');
});
test('provider-specific windows and quota failures are explicit', () => {
  const result = normalizeAccount({ ...account, platform: 'gemini' }, { gemini_pro_daily: { utilization: 40, resets_at: '2026-10-26T00:00:00Z' } }, { now, stale: true });
  assert.equal(result.windows[0].label, 'Pro 日额度');
  assert.equal(result.quotaState, 'stale');
});
test('summary counts unique accounts rather than adding quota percentages', () => {
  const a = normalizeAccount(account, { five_hour: { utilization: 25, resets_at: '2026-10-26T00:00:00Z' } }, { now });
  const result = summarize([a, a]);
  assert.equal(result.total, 1);
  assert.equal(result.currentConcurrency, 2);
  assert.equal(result.maxConcurrency, 5);
  assert.ok(!('remainingPercent' in result));
});

test('summary reports two disabled accounts alongside six available and two limited accounts', () => {
  const accounts = Array.from({ length: 10 }, (_, index) => normalizeAccount({
    ...account, id: index + 1, schedulable: index < 8,
  }, { five_hour: { utilization: index < 6 ? 25 : 100, resets_at: '2026-10-26T00:00:00Z' } }, { now }));
  const result = summarize([...accounts, accounts[8]]);
  assert.equal(result.total, 10);
  assert.equal(result.available, 6);
  assert.equal(result.limited, 2);
  assert.equal(result.disabled, 2);
});

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function reply(res, data) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, data })); }

test('quota queries skip disabled accounts while public snapshots retain their gray account entries', async t => {
  const batches = [];
  const baseUrl = await fixture(t, async (req, res) => {
    if (req.url.startsWith('/api/v1/admin/accounts?')) reply(res, { items: [account, { ...account, id: 8, schedulable: false }, { ...account, id: 9, status: 'disabled' }], total: 3 });
    else if (req.url === '/api/v1/admin/accounts/usage/batch') {
      let body = ''; for await (const chunk of req) body += chunk;
      batches.push(JSON.parse(body).account_ids);
      reply(res, { usage: { 7: { five_hour: { utilization: 25, resets_at: '2026-10-26T00:00:00Z' } } }, errors: {} });
    } else if (req.url.startsWith('/api/v1/admin/usage?')) reply(res, { items: [] });
    else { res.statusCode = 404; res.end(); }
  });
  const result = await createQuotaSource({ baseUrl, adminKey: 'key', now: () => now }).getSnapshot();
  assert.deepEqual(batches, [[7]]);
  assert.equal(result.accounts.length, 3);
  assert.ok(result.accounts[0].windows.length > 0);
  for (const entry of result.accounts.slice(1)) { assert.equal(entry.status, 'disabled'); assert.deepEqual(entry.windows, []); }
});

test('source paginates, coalesces visitors, and safely caches snapshots', async t => {
  let lists = 0, usageCalls = 0;
  const baseUrl = await fixture(t, async (req, res) => {
    assert.equal(req.headers['x-api-key'], 'fixture-admin-key');
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/api/v1/admin/accounts') {
      lists++;
      const page = Number(url.searchParams.get('page'));
      reply(res, { items: [{ ...account, id: page }], total: 2, pages: 2 });
    } else if (url.pathname === '/api/v1/admin/accounts/usage/batch') {
      usageCalls++;
      reply(res, { usage: { 1: { five_hour: { utilization: 25, resets_at: '2026-10-26T00:00:00Z' } }, 2: { five_hour: { utilization: 75, resets_at: '2026-10-26T00:00:00Z' } } }, errors: {} });
    } else { res.statusCode = 404; res.end(); }
  });
  const source = createQuotaSource({ baseUrl, adminKey: 'fixture-admin-key', now: () => now });
  const snapshots = await Promise.all(Array.from({ length: 6 }, () => source.getSnapshot()));
  assert.equal(lists, 2); assert.equal(usageCalls, 1);
  assert.equal(snapshots[0].accounts.length, 2);
  await source.getSnapshot(); assert.equal(lists, 2); assert.equal(usageCalls, 1);
  assert.ok(!JSON.stringify(snapshots).includes('fixture-admin-key'));
});

test('batch 404 falls back to per-account read without losing the account', async t => {
  const baseUrl = await fixture(t, (req, res) => {
    if (req.url.startsWith('/api/v1/admin/accounts?')) reply(res, { items: [account], total: 1 });
    else if (req.url === '/api/v1/admin/accounts/usage/batch') { res.statusCode = 404; res.end(); }
    else if (req.url.startsWith('/api/v1/admin/accounts/7/usage')) reply(res, { five_hour: { utilization: 35, resets_at: '2026-10-26T00:00:00Z' } });
    else { res.statusCode = 404; res.end(); }
  });
  const result = await createQuotaSource({ baseUrl, adminKey: 'key', now: () => now }).getSnapshot();
  assert.equal(result.accounts[0].windows[0].remainingPercent, 65);
});

test('failed refresh retains successful snapshot without disabling manual retry', async t => {
  let clock = now, fail = false;
  const baseUrl = await fixture(t, (req, res) => {
    if (fail) { res.statusCode = 503; res.end(); return; }
    if (req.url.startsWith('/api/v1/admin/accounts?')) reply(res, { items: [account], total: 1 });
    else reply(res, { usage: { 7: { five_hour: { utilization: 35, resets_at: '2026-10-26T00:00:00Z' } } }, errors: {} });
  });
  const source = createQuotaSource({ baseUrl, adminKey: 'key', now: () => clock });
  await source.getSnapshot(); fail = true; clock += 61_000;
  const result = await source.getSnapshot({ refresh: true });
  assert.equal(result.stale, true);
  assert.equal(result.quotaReadFailed, true);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.refreshCooldownSeconds, 0);
});

test('missing administrator key is a clear configuration error', async () => {
  await assert.rejects(createQuotaSource({ baseUrl: 'http://127.0.0.1:1', adminKey: '' }).getSnapshot(), e => e.code === 'NOT_CONFIGURED');
});

test('empty passive windows never imply 100% remaining merely because source exists', () => {
  const result = normalizeAccount({ ...account, platform: 'anthropic' }, { source: 'passive', five_hour: { utilization: 0, resets_at: null } }, { now });
  assert.equal(result.windows.length, 0); assert.equal(result.quotaState, 'unknown'); assert.equal(result.status, 'unknown');
});
test('minute quota can constrain Gemini availability even with daily allowance left', () => {
  const result = normalizeAccount({ ...account, platform: 'gemini' }, { gemini_pro_daily: { utilization: 20, resets_at: '2026-10-26T00:00:00Z' }, gemini_pro_minute: { utilization: 100, resets_at: '2026-10-25T00:01:00Z' } }, { now });
  assert.equal(result.windows.length, 2); assert.equal(result.status, 'limited');
});
test('HTTP 200 provider errors retain the last quota and do not advance its successful time', async t => {
  let clock = now, fail = false;
  const baseUrl = await fixture(t, (req, res) => {
    if (req.url.startsWith('/api/v1/admin/accounts?')) reply(res, { items: [{ ...account, platform: 'antigravity' }], total: 1 });
    else reply(res, { usage: { 7: fail ? { error_code: 'network_error', error: 'sensitive provider details' } : { antigravity_quota: { 'gpt-model-a': { utilization: 35, reset_time: '2026-10-26T00:00:00Z' } } } }, errors: {} });
  });
  const source = createQuotaSource({ baseUrl, adminKey: 'key', now: () => clock });
  const first = await source.getSnapshot({ group: 'antigravity' }); fail = true; clock += 61_000;
  const result = await source.getSnapshot({ group: 'antigravity' });
  assert.equal(result.accounts[0].windows[0].remainingPercent, 65);
  assert.equal(result.stale, true); assert.equal(result.accounts[0].quotaState, 'stale');
  assert.equal(result.quotaUpdatedAt, first.quotaUpdatedAt);
  assert.ok(!JSON.stringify(result).includes('sensitive provider details'));
});

test('individual provider errors preserve quota time and failed first reads remain visible', async t => {
  let clock = now, fail = false;
  const baseUrl = await fixture(t, (req, res) => {
    if (req.url.startsWith('/api/v1/admin/accounts?')) reply(res, { items: [account], total: 1 });
    else if (req.url === '/api/v1/admin/accounts/usage/batch') { res.statusCode = 404; res.end(); }
    else reply(res, fail ? { error_code: 'network_error', error: 'private provider details' } : { five_hour: { utilization: 35, resets_at: '2026-10-26T00:00:00Z' } });
  });
  const source = createQuotaSource({ baseUrl, adminKey: 'key', now: () => clock });
  const first = await source.getSnapshot(); fail = true; clock += 61_000;
  const result = await source.getSnapshot();
  assert.equal(result.quotaUpdatedAt, first.quotaUpdatedAt);
  assert.equal(result.accounts[0].windows[0].remainingPercent, 65);
  assert.equal(result.stale, true);
  const fresh = await createQuotaSource({ baseUrl, adminKey: 'key', now: () => clock }).getSnapshot();
  assert.equal(fresh.accounts[0].quotaState, 'unknown');
  assert.equal(fresh.stale, true);
  assert.ok(fresh.warning); assert.ok(fresh.accounts[0].error);
  assert.equal(fresh.quotaUpdatedAt, null);
  assert.ok(!JSON.stringify(fresh).includes('private provider details'));
});

test('Grok monthly exhaustion constrains availability alongside weekly quota', () => {
  const result = normalizeAccount({ ...account, platform: 'grok' }, { seven_day: { utilization: 20, resets_at: '2026-10-26T00:00:00Z' }, thirty_day: { utilization: 100, resets_at: '2026-10-27T00:00:00Z' } }, { now });
  assert.equal(result.windows.length, 2); assert.equal(result.status, 'limited');
});

test('administrator permission failures are surfaced instead of returning stale quota', async t => {
  let forbidden = false;
  const baseUrl = await fixture(t, (req, res) => {
    if (req.url.startsWith('/api/v1/admin/accounts?')) return reply(res, { items: [account], total: 1 });
    if (forbidden) { res.statusCode = 403; return res.end('{}'); }
    return reply(res, { usage: { 7: { five_hour: { utilization: 25, resets_at: '2026-10-26T00:00:00Z' } } }, errors: {} });
  });
  const source = createQuotaSource({ baseUrl, adminKey: 'key', now: () => now, quotaTtlMs: 0 });
  const first = await source.getSnapshot();
  assert.equal(first.accounts[0].windows[0].remainingPercent, 75);
  forbidden = true;
  await assert.rejects(source.getSnapshot({ refresh: true }), error => error.code === 'ADMIN_KEY_REJECTED');
});

test('Antigravity quota collapses duplicate model windows into Claude/GPT and Gemini representatives', () => {
  const result = normalizeAccount({ ...account, platform: 'antigravity' }, {
    five_hour: { utilization: 0, resets_at: '2026-10-25T04:00:00Z' },
    antigravity_quota: {
      'claude-opus': { utilization: 60, reset_time: '2026-10-27T00:00:00Z' },
      'claude-sonnet': { utilization: 60, reset_time: '2026-10-26T00:00:00Z' },
      'gpt-oss': { utilization: 100, reset_time: '2026-10-26T00:00:00Z' },
      'gemini-pro': { utilization: 80, reset_time: '2026-10-25T02:00:00Z' },
      'gemini-flash': { utilization: 80, reset_time: '2026-10-25T03:00:00Z' },
    },
  }, { now });
  assert.deepEqual(result.windows.map(window => window.key), ['antigravity_claude_gpt', 'antigravity_gemini_7d', 'antigravity_gemini_5h']);
  assert.equal(result.windows[0].usedPercent, 100);
  assert.equal(result.windows[0].resetAt, '2026-10-26T00:00:00.000Z');
  assert.equal(result.windows[0].groupLabel, 'Claude / GPT');
  assert.equal(result.windows[1].remainingPercent, 20);
  assert.equal(result.windows[1].groupLabel, 'Gemini');
  assert.equal(result.windows[2].label, '5 小时');
  assert.equal(result.status, 'available');
});

test('Antigravity is limited only when Gemini five-hour and Claude/GPT quotas are both exhausted', async t => {
  for (const [geminiFiveHour, claudeGpt, expected] of [
    [20, 30, 'available'], [100, 30, 'available'], [20, 100, 'available'], [100, 100, 'limited'],
  ]) {
    await t.test(`Gemini 5h ${geminiFiveHour}%, Claude/GPT ${claudeGpt}% => ${expected}`, () => {
      const result = normalizeAccount({ ...account, platform: 'antigravity' }, {
        five_hour: { utilization: geminiFiveHour, resets_at: '2026-10-25T04:00:00Z' },
        antigravity_quota: {
          'claude-sonnet': { utilization: claudeGpt, reset_time: '2026-10-26T00:00:00Z' },
          'gemini-pro': { utilization: 40, reset_time: '2026-10-26T00:00:00Z' },
        },
      }, { now });
      assert.equal(result.status, expected);
      assert.equal(summarize([result])[expected], 1);
    });
  }
});

test('Antigravity Gemini weekly quota and account rate limit cannot mark an otherwise available account limited', () => {
  const result = normalizeAccount({ ...account, platform: 'antigravity', rate_limit_reset_at: '2026-10-25T04:00:00Z' }, {
    five_hour: { utilization: 20, resets_at: '2026-10-25T04:00:00Z' },
    antigravity_quota: {
      'claude-sonnet': { utilization: 100, reset_time: '2026-10-26T00:00:00Z' },
      'gemini-pro': { utilization: 100, reset_time: '2026-10-26T00:00:00Z' },
    },
  }, { now });
  assert.equal(result.status, 'available');
});

test('Antigravity requires current samples of both quota families before marking the account limited', () => {
  const usage = {
    five_hour: { utilization: 100, resets_at: '2026-10-25T04:00:00Z' },
    antigravity_quota: {
      'claude-sonnet': { utilization: 100, reset_time: '2026-10-26T00:00:00Z' },
      'gemini-pro': { utilization: 100, reset_time: '2026-10-26T00:00:00Z' },
    },
  };
  const gravity = { ...account, platform: 'antigravity' };
  assert.equal(normalizeAccount(gravity, null, { now }).status, 'available');
  assert.equal(normalizeAccount(gravity, { ...usage, five_hour: null }, { now }).status, 'available');
  assert.equal(normalizeAccount(gravity, usage, { now, stale: true }).status, 'available');
  assert.equal(normalizeAccount(gravity, { ...usage, five_hour: { ...usage.five_hour, resets_at: '2026-10-24T00:00:00Z' } }, { now }).status, 'available');
  assert.equal(normalizeAccount(gravity, { ...usage, antigravity_quota: { ...usage.antigravity_quota, 'gemini-pro': { utilization: 100, reset_time: '2026-10-24T00:00:00Z' } } }, { now }).status, 'limited');
  assert.equal(normalizeAccount({ ...gravity, schedulable: false }, usage, { now }).status, 'disabled');
});

test('default GPT read and refresh never request unselected provider quotas', async t => {
  const batches = [];
  const all = [account, { ...account, id: 8, platform: 'antigravity' }, { ...account, id: 9, platform: 'gemini' }];
  const baseUrl = await fixture(t, async (req, res) => {
    if (req.url.startsWith('/api/v1/admin/accounts?')) return reply(res, { items: all, total: 3 });
    if (req.url.startsWith('/api/v1/admin/usage?')) return reply(res, { items: [] });
    let body = ''; for await (const chunk of req) body += chunk;
    const ids = JSON.parse(body).account_ids; batches.push(ids);
    reply(res, { usage: Object.fromEntries(ids.map(id => [id, { five_hour: { utilization: 30, resets_at: '2026-10-26T00:00:00Z' } }])), errors: {} });
  });
  const source = createQuotaSource({ baseUrl, adminKey: 'key', now: () => now });
  const first = await source.getSnapshot();
  assert.deepEqual(first.accounts.map(a => a.id), [7]);
  assert.deepEqual(first.groupCounts, { chatgpt: 1, antigravity: 1, gemini: 1 });
  assert.deepEqual(batches, [[7]]);
  const gravity = await source.getSnapshot({ group: 'antigravity' });
  assert.deepEqual(gravity.accounts.map(a => a.id), [8]);
  await source.getSnapshot({ group: 'gemini' });
  await source.getSnapshot({ group: 'chatgpt' });
  assert.deepEqual(batches, [[7], [8], [9]]);
  await source.getSnapshot({ group: 'antigravity', refresh: true });
  assert.deepEqual(batches, [[7], [8], [9], [8]]);
  await source.getSnapshot({ group: 'antigravity', refresh: true });
  assert.deepEqual(batches, [[7], [8], [9], [8], [8]]);
  assert.equal(first.summary.activeUsersFiveMinutes, 0);
});

test('simultaneous provider reads do not return another providers in-flight snapshot', async t => {
  const all = [account, { ...account, id: 9, platform: 'gemini' }];
  const baseUrl = await fixture(t, async (req, res) => {
    if (req.url.startsWith('/api/v1/admin/accounts?')) return reply(res, { items: all, total: 2 });
    if (req.url.startsWith('/api/v1/admin/usage?')) return reply(res, { items: [] });
    let body = ''; for await (const chunk of req) body += chunk;
    const ids = JSON.parse(body).account_ids;
    reply(res, { usage: Object.fromEntries(ids.map(id => [id, {}])), errors: {} });
  });
  const source = createQuotaSource({ baseUrl, adminKey: 'key', now: () => now });
  const [gpt, gemini] = await Promise.all([source.getSnapshot({ group: 'chatgpt' }), source.getSnapshot({ group: 'gemini' })]);
  assert.deepEqual(gpt.accounts.map(a => a.id), [7]);
  assert.deepEqual(gemini.accounts.map(a => a.id), [9]);
  await assert.rejects(source.getSnapshot({ group: 'arbitrary' }), e => e.status === 400);
});
