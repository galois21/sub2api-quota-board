const GROUPS = ['chatgpt', 'antigravity', 'gemini'];
const emptyCounts = () => Object.fromEntries(GROUPS.map(group => [group, null]));
const groupOf = account => ['antigravity', 'gemini'].includes(account.platform) ? account.platform : 'chatgpt';

// Only aggregate counts survive this read. User identities and request records
// are never included in the public snapshot or persisted to disk.
export function createActivitySource({ request, now = Date.now, ttlMs = 60_000, maxPages = 50 }) {
  let cached = null, readAt = null, pending = null;
  async function collect(accounts) {
    const end = now(), start = end - 300_000;
    const byAccount = new Map(accounts.map(account => [Number(account.id), groupOf(account)]));
    const users = Object.fromEntries(GROUPS.map(group => [group, new Set()]));
    const date = time => new Date(time).toISOString().slice(0, 10);
    try {
      let complete = false;
      for (let page = 1; page <= maxPages; page++) {
        const params = new URLSearchParams({ page: String(page), page_size: '100', exact_total: 'false', sort_by: 'created_at', sort_order: 'desc', timezone: 'UTC', start_date: date(start), end_date: date(end) });
        const data = await request('/api/v1/admin/usage?' + params);
        if (!Array.isArray(data.items)) throw new Error('Invalid activity data');
        let oldest = end;
        for (const record of data.items) {
          const at = typeof record.created_at === 'string' ? Date.parse(record.created_at) : NaN;
          if (!Number.isFinite(at)) throw new Error('Invalid activity timestamp');
          oldest = Math.min(oldest, at);
          if (at < start || at > end) continue;
          const user = Number(record.user_id ?? record.user?.id);
          if (!Number.isInteger(user) || user <= 0) throw new Error('Missing activity identity');
          const group = byAccount.get(Number(record.account_id));
          if (group) users[group].add(user);
        }
        if (data.items.length < 100 || oldest < start) { complete = true; break; }
      }
      if (!complete) throw new Error('Activity scan exceeded its bound');
      cached = { counts: Object.fromEntries(GROUPS.map(group => [group, users[group].size])), updatedAt: new Date(end).toISOString(), stale: false };
    } catch (error) {
      if (error.code === 'ADMIN_KEY_REJECTED') throw error;
      cached = { counts: cached?.counts || emptyCounts(), updatedAt: cached?.updatedAt || null, stale: true };
    }
    return cached;
  }
  return {
    async getActivity(accounts) {
      if (pending) return pending;
      if (cached && readAt !== null && now() - readAt < ttlMs) return cached;
      readAt = now();
      pending = collect(accounts).finally(() => { pending = null; });
      return pending;
    },
  };
}
