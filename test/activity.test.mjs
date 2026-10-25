import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivitySource } from '../activity.mjs';

const time = Date.parse('2026-10-25T00:02:00Z');
const accounts = [{ id: 1, platform: 'openai' }, { id: 2, platform: 'openai' }, { id: 3, platform: 'antigravity' }, { id: 4, platform: 'gemini' }];
const row = (user_id, account_id, delta) => ({ user_id, account_id, created_at: new Date(time + delta).toISOString(), user: { email: 'must-not-expose@example.com' } });

test('five-minute activity deduplicates users per provider and excludes old and future requests', async () => {
  const source = createActivitySource({ now: () => time, request: async path => {
    const params = new URL(path, 'http://test').searchParams;
    assert.equal(params.get('sort_order'), 'desc');
    assert.equal(params.get('timezone'), 'UTC');
    assert.equal(params.get('start_date'), '2026-10-24');
    assert.equal(params.get('end_date'), '2026-10-25');
    return { items: [row(99, 1, 1000), row(10, 1, -1000), row(10, 2, -2000), row(11, 2, -3000), row(10, 3, -4000), row(12, 4, -300000), row(13, 4, -300001)] };
  }});
  const activity = await source.getActivity(accounts);
  assert.deepEqual(activity.counts, { chatgpt: 2, antigravity: 1, gemini: 1 });
  assert.equal(activity.stale, false);
  assert.equal(activity.updatedAt, new Date(time).toISOString());
  assert.ok(!JSON.stringify(activity).includes('must-not-expose'));
});

test('activity paginates past repeated users and shares concurrent and cached reads', async () => {
  let calls = 0;
  const source = createActivitySource({ now: () => time, request: async path => {
    calls++;
    const page = Number(new URL(path, 'http://test').searchParams.get('page'));
    return { items: page === 1 ? Array.from({ length: 100 }, () => row(10, 1, -1000)) : [row(11, 1, -300000), row(12, 1, -300001)] };
  }});
  const results = await Promise.all(Array.from({ length: 6 }, () => source.getActivity(accounts)));
  assert.equal(calls, 2);
  assert.equal(results[0].counts.chatgpt, 2);
  await source.getActivity(accounts);
  assert.equal(calls, 2);
});

test('unavailable activity is unknown and a failed subsequent read preserves its old timestamp', async () => {
  let clock = time, fail = true;
  const source = createActivitySource({ now: () => clock, request: async () => {
    if (fail) throw new Error('private upstream details');
    return { items: [] };
  }});
  assert.deepEqual((await source.getActivity(accounts)).counts, { chatgpt: null, antigravity: null, gemini: null });
  fail = false; clock += 61000;
  const good = await source.getActivity(accounts);
  assert.equal(good.counts.chatgpt, 0);
  fail = true; clock += 61000;
  const old = await source.getActivity(accounts);
  assert.equal(old.stale, true);
  assert.equal(old.updatedAt, good.updatedAt);
  assert.equal(old.counts.chatgpt, 0);
});

test('bounded scans and malformed records never publish an inaccurate zero', async () => {
  for (const items of [null, [{ created_at: 'bad', user_id: 1, account_id: 1 }], Array.from({ length: 100 }, () => row(10, 1, -1000))]) {
    const source = createActivitySource({ now: () => time, maxPages: 2, request: async () => ({ items }) });
    const result = await source.getActivity(accounts);
    assert.equal(result.counts.chatgpt, null);
    assert.equal(result.stale, true);
  }
});
