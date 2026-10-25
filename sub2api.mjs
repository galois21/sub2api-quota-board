import { createActivitySource } from './activity.mjs';

const GROUPS = ['chatgpt', 'antigravity', 'gemini'];
const groupOf = account => ['antigravity', 'gemini'].includes(account.platform) ? account.platform : 'chatgpt';
const WINDOWS = {
  five_hour: '5 小时', seven_day: '7 天', thirty_day: '30 天', seven_day_sonnet: 'Sonnet 7 天', seven_day_fable: 'Fable 7 天',
  gemini_shared_daily: '共享日额度', gemini_pro_daily: 'Pro 日额度', gemini_flash_daily: 'Flash 日额度',
  gemini_shared_minute: '共享分钟额度', gemini_pro_minute: 'Pro 分钟额度', gemini_flash_minute: 'Flash 分钟额度',
};
const PLATFORMS = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', antigravity: 'Antigravity', grok: 'Grok' };
const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const integer = value => { const n = number(value); return n !== null && n >= 0 && Number.isInteger(n) ? n : null; };
const timestamp = value => { if (typeof value !== 'string' || !value.trim()) return null; const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
export function serviceError(code, message, status = 502) { return Object.assign(new Error(message), { code, status }); }

export function normalizeAccount(account, usage, { now = Date.now(), stale = false } = {}) {
  const extra = account.extra && typeof account.extra === 'object' ? account.extra : {};
  const windows = [];
  const add = (key, label, raw, reset, group = null, groupLabel = null) => {
    const used = number(raw); if (used === null || used < 0) return;
    windows.push({ key, label, group, groupLabel, usedPercent: Math.round(used * 10) / 10, remainingPercent: Math.round(Math.max(0, 100 - used) * 10) / 10, resetAt: timestamp(reset) });
  };
  if (account.platform !== 'antigravity') {
    for (const [key, label] of Object.entries(WINDOWS)) {
      const progress = usage?.[key];
      const fallbackPrefix = key === 'five_hour' ? 'codex_5h' : key === 'seven_day' ? 'codex_7d' : null;
      if (progress && (timestamp(progress.resets_at) || number(progress.utilization) > 0)) {
        add(key, label, progress.utilization, progress.resets_at);
      } else if (fallbackPrefix) add(key, label, extra[`${fallbackPrefix}_used_percent`], extra[`${fallbackPrefix}_reset_at`]);
      if (!windows.some(w => w.key === key) && account.platform === 'anthropic') {
        const prefix = key === 'five_hour' ? 'passive_usage_5h' : key === 'seven_day' ? 'passive_usage_7d' : null;
        if (prefix && number(extra[`${prefix}_utilization`]) !== null) {
          const reset = number(extra[`${prefix}_reset`]);
          add(key, label, number(extra[`${prefix}_utilization`]) * 100, reset && new Date(reset * 1000).toISOString());
        }
      }
    }
  } else {
    const quotaEntries = Object.entries(usage?.antigravity_quota || {});
    const representative = (key, groupLabel, windowLabel, pattern) => {
      const candidates = quotaEntries
        .filter(([model]) => pattern.test(model))
        .map(([model, quota]) => ({ model, utilization: number(quota?.utilization), resetAt: timestamp(quota?.reset_time) }))
        .filter(item => item.utilization !== null && item.utilization >= 0)
        .sort((a, b) => (b.utilization - a.utilization) || ((Date.parse(a.resetAt || '9999-12-31') || Infinity) - (Date.parse(b.resetAt || '9999-12-31') || Infinity)));
      if (candidates[0]) add(key, windowLabel, candidates[0].utilization, candidates[0].resetAt, key, groupLabel);
    };
    representative('antigravity_claude_gpt', 'Claude / GPT', '7 天', /(claude|gpt|chat_)/i);
    const gemini = quotaEntries
      .filter(([model]) => /gemini/i.test(model))
      .map(([model, quota]) => ({ model, utilization: number(quota?.utilization), resetAt: timestamp(quota?.reset_time) }))
      .filter(item => item.utilization !== null && item.utilization >= 0)
      .sort((a, b) => (b.utilization - a.utilization) || ((Date.parse(a.resetAt || '9999-12-31') || Infinity) - (Date.parse(b.resetAt || '9999-12-31') || Infinity)));
    if (gemini[0]) {
      add('antigravity_gemini_7d', '7 天', gemini[0].utilization, gemini[0].resetAt, 'gemini', 'Gemini');
      const fiveHour = usage?.five_hour;
      if (fiveHour && (timestamp(fiveHour.resets_at) || number(fiveHour.utilization) > 0)) {
        add('antigravity_gemini_5h', '5 小时', fiveHour.utilization, fiveHour.resets_at, 'gemini', 'Gemini');
      }
    }
  }
  const expired = windows.some(w => w.resetAt && Date.parse(w.resetAt) <= now);
  const quotaState = windows.length ? (stale || expired ? 'stale' : 'known') : 'unknown';
  const rateLimitResetAt = timestamp(account.rate_limit_reset_at);
  let status = 'unknown';
  if (account.status === 'error') status = 'error';
  else if (account.status !== 'active' || account.schedulable === false) status = 'disabled';
  else if (account.platform === 'antigravity') {
    const bothLimited = !stale && ['antigravity_gemini_5h', 'antigravity_claude_gpt'].every(key => {
      const window = windows.find(entry => entry.key === key);
      return window && window.remainingPercent <= 0 && (!window.resetAt || Date.parse(window.resetAt) > now);
    });
    status = bothLimited ? 'limited' : 'available';
  }
  else if (rateLimitResetAt && Date.parse(rateLimitResetAt) > now) status = 'limited';
  else if (quotaState === 'known') status = windows.some(w => w.remainingPercent <= 0) ? 'limited' : 'available';
  const hidden = status === 'disabled';
  return {
    id: Number(account.id), name: `${PLATFORMS[account.platform] || '账号'} #${Number(account.id)}`,
    platform: typeof account.platform === 'string' ? account.platform : 'unknown', status,
    schedulable: account.status === 'active' && account.schedulable !== false,
    currentConcurrency: integer(account.current_concurrency), maxConcurrency: integer(account.concurrency),
    quotaState: hidden ? 'hidden' : quotaState, updatedAt: hidden ? null : timestamp(usage?.updated_at) || timestamp(extra.codex_usage_updated_at) || timestamp(extra.passive_usage_sampled_at),
    rateLimitResetAt: hidden ? null : rateLimitResetAt, error: !hidden && stale ? '额度更新失败，显示上次数据' : null, windows: hidden ? [] : windows,
  };
}

export function summarize(accounts) {
  const unique = [...new Map(accounts.map(a => [a.id, a])).values()];
  return {
    total: unique.length, available: unique.filter(a => a.status === 'available').length,
    limited: unique.filter(a => a.status === 'limited').length,
    disabled: unique.filter(a => a.status === 'disabled').length,
    currentConcurrency: unique.reduce((sum, a) => sum + (a.currentConcurrency ?? 0), 0),
    maxConcurrency: unique.reduce((sum, a) => sum + (a.maxConcurrency ?? 0), 0),
  };
}

export function createQuotaSource({ baseUrl, adminKey, now = Date.now, listTtlMs = 15_000, quotaTtlMs = 60_000, timeoutMs = 10_000 }) {
  const root = String(baseUrl).replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  let listCache = null, listPending = null, batchSupported = true;
  const groups = new Map(GROUPS.map(group => [group, { quotaReadAt: null, quotaUpdatedAt: null, pending: null, lastGood: null }]));
  const quotaCache = new Map();
  const validUsage = data => data && typeof data === 'object' && !Array.isArray(data) && !data.error && !data.error_code;
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(root + path, { ...options, headers: { Accept: 'application/json', 'x-api-key': adminKey, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw serviceError('UPSTREAM_UNAVAILABLE', '暂时无法连接额度数据源'); }
    if (!response.ok) throw serviceError(response.status === 401 || response.status === 403 ? 'ADMIN_KEY_REJECTED' : 'UPSTREAM_UNAVAILABLE', response.status === 401 || response.status === 403 ? '额度服务配置需要管理员检查' : '额度数据暂时无法更新', response.status);
    let envelope; try { envelope = await response.json(); } catch { throw serviceError('UPSTREAM_UNAVAILABLE', '额度数据格式暂不可用'); }
    if (envelope.code !== 0 || envelope.data === undefined) throw serviceError('UPSTREAM_UNAVAILABLE', '额度数据格式暂不可用');
    return envelope.data;
  }
  async function loadAccounts(force) {
    if (listPending) return listPending;
    if (!force && listCache && now() - listCache.at < listTtlMs) return listCache.items;
    listPending = readAccounts().finally(() => { listPending = null; });
    return listPending;
  }
  async function readAccounts() {
    const items = [];
    for (let page = 1; page <= 200; page++) {
      const data = await request(`/api/v1/admin/accounts?page=${page}&page_size=100`);
      if (!Array.isArray(data.items)) throw serviceError('UPSTREAM_UNAVAILABLE', '账号列表格式暂不可用');
      items.push(...data.items);
      const pages = integer(data.pages) || integer(data.total_pages) || (integer(data.total) !== null ? Math.ceil(data.total / 100) : null);
      if (pages !== null ? page >= Math.max(1, pages) : data.items.length < 100) break;
      if (page === 200) throw serviceError('UPSTREAM_UNAVAILABLE', '账号列表过大，请联系管理员');
    }
    const unique = [...new Map(items.filter(a => Number.isInteger(Number(a.id)) && Number(a.id) > 0).map(a => [Number(a.id), a])).values()];
    listCache = { items: unique, at: now() }; return unique;
  }
  const activitySource = createActivitySource({ request, now });
  async function individual(items, groupState) {
    let cursor = 0, success = false;
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (cursor < items.length) {
        const account = items[cursor++];
        try {
          const mode = account.platform === 'anthropic' && ['oauth', 'setup-token', 'setup_token'].includes(account.type) ? '?source=passive' : '';
          const data = await request(`/api/v1/admin/accounts/${Number(account.id)}/usage${mode}`);
          if (!validUsage(data)) throw serviceError('UPSTREAM_UNAVAILABLE', '额度数据暂时无法更新');
          quotaCache.set(Number(account.id), { data, stale: false });
          success = true;
        } catch (error) {
          if (error.code === 'ADMIN_KEY_REJECTED') throw error;
          const previous = quotaCache.get(Number(account.id));
          quotaCache.set(Number(account.id), { data: previous?.data || null, stale: true });
        }
      }
    }));
    if (success) groupState.quotaUpdatedAt = now();
  }
  async function loadQuotas(items, force, groupState) {
    if (!force && groupState.quotaReadAt !== null && now() - groupState.quotaReadAt < quotaTtlMs) return;
    groupState.quotaReadAt = now();
    if (!batchSupported) { await individual(items, groupState); return; }
    for (let index = 0; index < items.length; index += 50) {
      const chunk = items.slice(index, index + 50);
      try {
        const result = await request('/api/v1/admin/accounts/usage/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_ids: chunk.map(a => Number(a.id)), force: false }) });
        let success = false;
        for (const account of chunk) {
          const id = Number(account.id), data = result.usage?.[id];
          const previous = quotaCache.get(id);
          const valid = validUsage(data) && !result.errors?.[id];
          quotaCache.set(id, { data: valid ? data : previous?.data || null, stale: !valid });
          if (valid) success = true;
        }
        if (success) groupState.quotaUpdatedAt = now();
      } catch (error) {
        if (error.code === 'ADMIN_KEY_REJECTED') throw error;
        if (error.status === 404 || error.status === 405) { batchSupported = false; await individual(items.slice(index), groupState); return; }
        for (const account of chunk) { const id = Number(account.id), previous = quotaCache.get(id); quotaCache.set(id, { data: previous?.data || null, stale: true }); }
      }
    }
  }
  async function collect(force, group, groupState) {
    try {
      const allItems = await loadAccounts(force);
      const items = allItems.filter(account => groupOf(account) === group);
      const queryable = items.filter(account => account.status === 'active' && account.schedulable !== false);
      const [, activity] = await Promise.all([loadQuotas(queryable, force, groupState), activitySource.getActivity(allItems)]);
      const accounts = items.map(account => { const entry = quotaCache.get(Number(account.id)); return normalizeAccount(account, entry?.data, { now: now(), stale: entry?.stale }); });
      const stale = accounts.some(a => a.quotaState === 'stale' || a.error);
      groupState.lastGood = { group, groupCounts: Object.fromEntries(GROUPS.map(key => [key, allItems.filter(account => groupOf(account) === key).length])), updatedAt: new Date(now()).toISOString(), quotaUpdatedAt: groupState.quotaUpdatedAt === null ? null : new Date(groupState.quotaUpdatedAt).toISOString(), stale, warning: stale ? '部分额度数据未更新，请留意各账号的数据时间' : null, summary: { ...summarize(accounts), activeUsersFiveMinutes: activity.counts[group] }, activity: { updatedAt: activity.updatedAt, stale: activity.stale }, accounts };
      return { ...groupState.lastGood, refreshCooldownSeconds: 0 };
    } catch (error) {
      if (error.code === 'ADMIN_KEY_REJECTED') throw error;
      if (!groupState.lastGood) throw error;
      return { ...groupState.lastGood, stale: true, warning: '暂时无法更新，当前显示上次成功数据', activity: { ...groupState.lastGood.activity, stale: true }, refreshCooldownSeconds: 0 };
    }
  }
  return {
    configured: Boolean(adminKey),
    async getSnapshot({ refresh = false, group = 'chatgpt' } = {}) {
      if (!adminKey) throw serviceError('NOT_CONFIGURED', '额度服务尚未配置，请联系管理员', 503);
      const groupState = groups.get(group);
      if (!groupState) throw serviceError('INVALID_GROUP', '请选择有效的账号分组', 400);
      if (groupState.pending) return groupState.pending;
      const force = refresh;
      groupState.pending = collect(force, group, groupState).finally(() => { groupState.pending = null; });
      return groupState.pending;
    },
  };
}
