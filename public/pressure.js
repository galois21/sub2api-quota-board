const HOUR = 3_600_000;
const MAX_SNAPSHOT_AGE = 180_000;
const percent = value => Number.isFinite(value) && value >= 0 && value <= 100;
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

// Percentages are comparable only under the equal-account-capacity assumption.
// This is a pace estimate, not a token count or a prediction of future traffic.
const FAMILIES = {
  gpt: { group: 'chatgpt', platform: 'openai', key: 'five_hour', constraint: 'seven_day', maxHours: 5 },
  // These model-family representatives come directly from AntigravityQuota.
  // Generic FiveHour is only a compatibility field and can represent Claude.
  antigravity_gemini: { group: 'antigravity', platform: 'antigravity', key: 'antigravity_gemini_7d', maxHours: 168 },
  antigravity_claude_gpt: { group: 'antigravity', platform: 'antigravity', key: 'antigravity_claude_gpt', maxHours: 168 },
};

export function calculatePressure(snapshot, now = Date.now(), family = 'gpt') {
  const result = { score: null, ratio: null, total: 0, eligible: 0, included: 0,
    excluded: 0, missing: 0, weeklyBlocked: 0, remaining: 0, hours: 0 };
  const config = FAMILIES[family];
  if (!config || snapshot?.group !== config.group || !Array.isArray(snapshot.accounts)) return result;
  const accounts = [...new Map(snapshot.accounts.filter(a => a && a.platform === config.platform)
    .map(a => [a.id, a])).values()];
  result.total = accounts.length;
  const age = now - time(snapshot.updatedAt);
  const snapshotValid = snapshot.quotaReadFailed !== true && Number.isFinite(age) && age >= -60_000 && age <= MAX_SNAPSHOT_AGE;
  for (const account of accounts) {
    if (['disabled', 'error'].includes(account.status) || account.schedulable === false) {
      result.excluded++;
      continue;
    }
    result.eligible++;
    const windows = Array.isArray(account.windows) ? account.windows : [];
    const short = windows.find(w => w?.key === config.key);
    const weekly = config.constraint ? windows.find(w => w?.key === config.constraint) : null;
    const hours = (time(short?.resetAt) - now) / HOUR;
    // When providers omit sample time, use only the last successful quota read.
    const sampleAge = now - time(account.updatedAt || snapshot.quotaUpdatedAt);
    const sampleValid = Number.isFinite(sampleAge) && sampleAge >= -60_000 && sampleAge <= MAX_SNAPSHOT_AGE;
    // An expired sibling family can make the whole account stale. Its healthy
    // sibling is still usable when the fetch itself succeeded and this window is current.
    const quotaValid = account.quotaState === 'known' || (config.group === 'antigravity'
      && account.quotaState === 'stale' && !account.error);
    const constraintValid = !config.constraint || (percent(weekly?.remainingPercent) && time(weekly?.resetAt) > now);
    if (!snapshotValid || !sampleValid || !quotaValid
      || !percent(short?.remainingPercent) || !Number.isFinite(hours) || hours <= 0 || hours > config.maxHours
      || !constraintValid) {
      result.missing++;
      continue;
    }
    result.included++;
    result.hours += hours;
    if (weekly?.remainingPercent === 0) result.weeklyBlocked++;
    else result.remaining += short.remainingPercent;
  }
  if (result.included) {
    result.ratio = result.remaining / (20 * result.hours);
    // Equivalent to 10 − old pressure / 5: positive means more available quota.
    result.score = 10 * (result.ratio - 1) / (result.ratio + 1);
  }
  return result;
}

export function describePressure(score) {
  if (!Number.isFinite(score)) return { level: 'unknown', label: '加载中', advice: '正在读取最新额度，读取完成后显示评分。' };
  if (score >= 4) return { level: 'abundant', label: '非常充裕', advice: '额度充裕且重置较近，可以更积极地使用。' };
  if (score >= 1) return { level: 'comfortable', label: '充裕', advice: '剩余额度相对充裕，可以适当增加使用。' };
  if (score >= -2) return { level: 'normal', label: '正常', advice: '额度与剩余时间基本匹配，按计划速度使用即可。' };
  if (score > -4) return { level: 'watch', label: '略紧', advice: '相对计划速度，额度略显不足，建议适当控制消耗。' };
  if (score > -6) return { level: 'warning', label: '偏紧', advice: '剩余额度偏少，建议优先安排必要请求。' };
  if (score > -8) return { level: 'tight', label: '紧张', advice: '剩余额度偏少或距重置较久，建议控制消耗。' };
  return { level: 'critical', label: '非常紧张', advice: '可用额度十分有限，建议等待重置或减少非必要请求。' };
}
