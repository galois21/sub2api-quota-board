(() => {
  'use strict';

  // The menu token is consumed once and never persisted in browser storage.
  const entryUrl = new URL(window.location.href);
  let entryToken = entryUrl.searchParams.get('token');
  const suppliedTheme = entryUrl.searchParams.get('theme');
  const privateParameters = ['token', 'user_id', 'src_url'];
  if (privateParameters.some((key) => entryUrl.searchParams.has(key))) {
    privateParameters.forEach((key) => entryUrl.searchParams.delete(key));
    window.history.replaceState(null, '', entryUrl.pathname + entryUrl.search + entryUrl.hash);
  }

  const apiRoot = new URL('./api/', window.location.href);
  const byId = (id) => document.getElementById(id);
  const ui = {
    refresh: byId('refresh-button'), refreshLabel: byId('refresh-label'),
    connection: byId('connection-status'), connectionLabel: byId('connection-label'),
    snapshotTime: byId('snapshot-time'), quotaTime: byId('quota-time'),
    activeUsers: byId('summary-active-users'), activeUsersHint: byId('summary-active-users-hint'),
    activeUsersMetric: document.querySelector('.summary-active-users'), groupPanel: byId('group-panel'),
    requestNotice: byId('request-notice'), requestTitle: byId('request-title'),
    requestMessage: byId('request-message'), dashboardLink: byId('dashboard-link'),
    dataNotice: byId('data-notice'), dataTitle: byId('data-notice-title'),
    dataMessage: byId('data-notice-message'), panel: byId('accounts-panel'),
    groupTabs: [...document.querySelectorAll('.group-tab')],
    count: byId('account-count'), rows: byId('account-rows'), wrap: byId('table-wrap'),
    tableState: byId('table-state'), stateIcon: byId('state-icon'),
    stateTitle: byId('state-title'), stateDescription: byId('state-description'),
    retry: byId('retry-button'), live: byId('live-status'),
  };
  const statusLabels = {
    available: '可用', limited: '已限流', disabled: '已停用', error: '异常', unknown: '未知',
  };
  const statusOrder = { available: 0, limited: 1, disabled: 2, error: 3, unknown: 4 };
  const groupKeys = ['chatgpt', 'antigravity', 'gemini'];
  const state = {
    groups: Object.fromEntries(groupKeys.map(key => [key, {
      snapshot: null, problem: null, configurationBlocked: false, expandedQuotaAccounts: new Set(),
    }])),
    controller: null, requestKind: null, sessionPending: true,
    authBlocked: false, fallbackAttempted: false, activeGroup: 'chatgpt', groupCounts: null,
    pollTimer: null, countdownTimer: null, paused: false,
  };
  const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  const compactTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const exactTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  function currentGroup() {
    return state.groups[state.activeGroup];
  }

  function text(node, value) {
    const next = String(value);
    if (node.textContent !== next) node.textContent = next;
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) text(node, value);
    return node;
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function count(value) {
    return isNumber(value) ? numberFormat.format(value) : '—';
  }

  function timestamp(value) {
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatTime(value, exact = false) {
    const parsed = timestamp(value);
    return parsed === null ? '—' : (exact ? exactTime : compactTime).format(parsed);
  }

  function setTime(node, value, fallback = '—') {
    if (timestamp(value) === null) {
      text(node, fallback);
      node.removeAttribute('datetime');
      node.removeAttribute('title');
      return;
    }
    text(node, formatTime(value));
    node.dateTime = value;
    node.title = formatTime(value, true) + '（北京时间）';
  }

  function initialiseTheme() {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    // No main-site theme storage key is confirmed in this source. Never write its preferences.
    const preference = suppliedTheme === 'dark' || suppliedTheme === 'light' ? suppliedTheme : null;
    function applyTheme() {
      const theme = preference || (systemTheme.matches ? 'dark' : 'light');
      document.documentElement.dataset.theme = theme;
    }
    systemTheme.addEventListener('change', () => { if (!preference) applyTheme(); });
    applyTheme();
  }

  class ApiError extends Error {
    constructor(status, code) {
      super(code || 'REQUEST_FAILED');
      this.status = status;
      this.code = code;
    }
  }

  async function apiRequest(path, { method = 'GET', token, signal } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(new URL(path, apiRoot), {
      method, headers, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {
      if (response.ok && path !== 'session') throw new ApiError(response.status, 'INVALID_RESPONSE');
    }
    if (!response.ok) {
      throw new ApiError(response.status, isRecord(payload) ? payload.code : null);
    }
    return payload;
  }

  function validSnapshot(value, group) {
    return isRecord(value) && value.group === group && isRecord(value.summary) && Array.isArray(value.accounts)
      && value.accounts.every(isRecord) && timestamp(value.updatedAt) !== null;
  }

  function platformName(account) {
    return typeof account.platform === 'string' && account.platform.trim()
      ? account.platform.trim() : '未标注平台';
  }

  function accountStatus(account) {
    return Object.prototype.hasOwnProperty.call(statusLabels, account.status) ? account.status : 'unknown';
  }

  function visibleAccounts() {
    const snapshot = currentGroup().snapshot;
    return snapshot ? [...snapshot.accounts].sort((a, b) => statusOrder[accountStatus(a)] - statusOrder[accountStatus(b)]) : [];
  }

  function updateGroupTabs() {
    ui.groupTabs.forEach(tab => {
      const key = tab.dataset.group;
      const selected = key === state.activeGroup;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const countNode = tab.querySelector('.group-tab-count');
      const cached = state.groups[key].snapshot;
      const total = state.groupCounts && state.groupCounts[key];
      if (countNode) text(countNode, count(isNumber(total) ? total : cached && cached.summary.total));
    });
    ui.groupPanel.setAttribute('aria-labelledby', 'tab-' + state.activeGroup);
  }

  function concurrency(current, maximum) {
    const node = element('div', 'concurrency-number');
    node.append(element('span', '', count(current)), element('span', 'number-divider', '/'),
      element('span', 'number-max', count(maximum)));
    node.setAttribute('aria-label', '当前并发 ' + count(current) + '，上限 ' + count(maximum));
    return node;
  }

  function resetLabel(value, now) {
    const resetAt = timestamp(value);
    if (resetAt === null) return '重置时间未知';
    const seconds = Math.ceil((resetAt - now) / 1000);
    if (seconds <= 0) return '已到重置时间，等待更新';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (days > 0) return days + '天 ' + hours + '小时后重置';
    if (hours > 0) return hours + '小时 ' + minutes + '分后重置';
    if (minutes > 0) return minutes + '分 ' + remainder + '秒后重置';
    return remainder + '秒后重置';
  }

  function resetNode(value, className) {
    const node = element('span', className, resetLabel(value, Date.now()));
    if (timestamp(value) !== null) {
      node.dataset.resetAt = value;
      node.title = '重置时间：' + formatTime(value, true) + '（北京时间）';
    }
    return node;
  }

  function knownQuotaWindow(windowValue, account) {
    return isRecord(windowValue) && account.quotaState !== 'unknown'
      && isNumber(windowValue.usedPercent) && isNumber(windowValue.remainingPercent)
      && windowValue.remainingPercent <= 100;
  }

  function quotaWindow(windowData, index, account, stale) {
    const windowValue = windowData || {};
    const label = typeof windowValue.label === 'string' && windowValue.label.trim()
      ? windowValue.label : (index === 0 ? '短周期' : index === 1 ? '长周期' : '额度窗口 ' + (index + 1));
    const known = knownQuotaWindow(windowValue, account);
    const node = element('div', 'quota-window');
    node.dataset.state = known ? (stale ? 'stale' : 'known') : 'unknown';
    const header = element('div', 'window-header');
    const title = element('span', 'window-title');
    const reset = element('span', 'window-reset');
    reset.append('（', resetNode(windowValue.resetAt, 'countdown'), '）');
    title.append(element('span', 'window-label', label), reset);
    header.append(title);
    const amount = element('span', 'window-amount');
    const used = known ? numberFormat.format(windowValue.usedPercent) + '%' : null;
    const remaining = known ? numberFormat.format(windowValue.remainingPercent) + '%' : null;
    amount.append(element('span', 'window-used', known ? '已用 ' + used : '暂不可用'));
    if (known) amount.append(element('span', 'window-remaining', '剩余 ' + remaining));
    header.append(amount);
    const bar = element('div', 'quota-bar');
    if (known) {
      const barPercent = Math.min(windowValue.usedPercent, 100);
      node.dataset.level = windowValue.usedPercent >= 90 ? 'full' : windowValue.usedPercent >= 75 ? 'warning' : 'normal';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', label + (stale ? '（旧数据）' : '') + '已用额度');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', String(barPercent));
      bar.setAttribute('aria-valuetext', '已用 ' + used + '，剩余 ' + remaining);
      const fill = element('div', 'quota-fill');
      fill.style.width = barPercent + '%';
      bar.append(fill);
    } else {
      bar.setAttribute('aria-hidden', 'true');
    }
    node.append(header, bar);
    return node;
  }

  function accountRow(account) {
    const row = element('tr');
    const disabled = accountStatus(account) === 'disabled';
    row.dataset.status = accountStatus(account);
    const accountCell = element('td', 'account-cell');
    const fallbackName = account.id === undefined || account.id === null ? '未命名账号' : '账号 ' + String(account.id);
    const name = typeof account.name === 'string' && account.name.trim() ? account.name : fallbackName;
    const nameNode = element('div', 'account-name', name);
    const stale = currentGroup().snapshot.stale === true || account.quotaState === 'stale';
    const updated = element('p', 'account-updated' + (stale ? ' is-stale' : ''));
    const hasTime = timestamp(account.updatedAt) !== null;
    text(updated, disabled ? '额度不可用' : (stale ? '旧数据 · ' : '') + (hasTime ? '更新于 ' + formatTime(account.updatedAt) : '尚无额度更新时间'));
    if (hasTime) updated.title = formatTime(account.updatedAt, true) + '（北京时间）';
    accountCell.append(nameNode, element('span', 'account-platform', platformName(account)), updated);
    if (typeof account.error === 'string' && account.error.trim()) {
      accountCell.append(element('p', 'account-error', account.error));
    }
    const quotaCell = element('td', 'quota-cell');
    const windowOrder = windowValue => {
      const key = String(windowValue.key || '');
      if (/five_hour|_5h$|minute/.test(key)) return 0;
      if (/seven_day|_7d$|daily/.test(key)) return 1;
      return 2;
    };
    const groupOrder = windowValue => account.platform === 'antigravity'
      ? windowValue.group === 'gemini' ? 0 : windowValue.group === 'antigravity_claude_gpt' ? 1 : 2 : 0;
    const rawWindows = (Array.isArray(account.windows) ? account.windows.filter(isRecord) : [])
      .map((windowValue, index) => ({ windowValue, index }))
      .sort((a, b) => groupOrder(a.windowValue) - groupOrder(b.windowValue)
        || windowOrder(a.windowValue) - windowOrder(b.windowValue) || a.index - b.index);
    if (disabled) {
      const placeholder = element('div', 'quota-disabled');
      placeholder.setAttribute('role', 'img');
      placeholder.setAttribute('aria-label', '已停用，额度不可用');
      placeholder.append(element('div', 'quota-bar'), element('div', 'quota-bar'));
      quotaCell.append(placeholder);
    } else if (account.platform === 'antigravity') {
      const groups = new Map();
      rawWindows.forEach(({ windowValue, index }) => {
        const key = windowValue.group || windowValue.key;
        const group = groups.get(key) || { label: windowValue.groupLabel || windowValue.label || '额度', windows: [] };
        group.windows.push({ windowValue, index });
        groups.set(key, group);
      });
      groups.forEach(group => {
        const groupNode = element('section', 'quota-group');
        groupNode.append(element('h4', 'quota-group-title', group.label));
        const pair = element('div', 'quota-pair');
        group.windows.forEach(({ windowValue, index }) => pair.append(quotaWindow(windowValue, index, account, stale)));
        groupNode.append(pair);
        quotaCell.append(groupNode);
      });
    } else {
      const pair = element('div', 'quota-pair');
      const windows = rawWindows;
      // Missing windows remain explicitly unavailable; no values are inferred.
      while (windows.length < 2) windows.push({ windowValue: null, index: windows.length });
      windows.slice(0, 2).forEach(({ windowValue, index }) => pair.append(quotaWindow(windowValue, index, account, stale)));
      quotaCell.append(pair);
      if (windows.length > 2) {
        const disclosure = element('details', 'quota-details');
        const accountKey = account.id !== undefined && account.id !== null
          ? String(account.id) : JSON.stringify([platformName(account), name]);
        const expanded = currentGroup().expandedQuotaAccounts;
        disclosure.open = expanded.has(accountKey);
        const summary = element('summary', '', '展开其余 ' + (windows.length - 2) + ' 个额度窗口');
        const rest = element('div', 'quota-pair quota-rest');
        windows.slice(2).forEach(({ windowValue, index }) => rest.append(quotaWindow(windowValue, index, account, stale)));
        disclosure.append(summary, rest);
        disclosure.addEventListener('toggle', () => {
          if (disclosure.open) expanded.add(accountKey);
          else expanded.delete(accountKey);
        });
        quotaCell.append(disclosure);
      }
    }
    const concurrencyCell = element('td', 'concurrency-cell');
    concurrencyCell.append(concurrency(account.currentConcurrency, account.maxConcurrency),
      element('div', 'concurrency-caption', '当前 / 上限'));
    const statusCell = element('td', 'status-cell');
    const status = accountStatus(account);
    const badge = element('span', 'status-badge', statusLabels[status]);
    badge.dataset.status = status;
    statusCell.append(badge);
    if (account.schedulable === false && status !== 'disabled') {
      statusCell.append(element('span', 'status-note', '暂不参与调度'));
    }
    if (status === 'limited' && timestamp(account.rateLimitResetAt) !== null) {
      statusCell.append(resetNode(account.rateLimitResetAt, 'status-note countdown'));
    }
    row.append(accountCell, quotaCell, concurrencyCell, statusCell);
    return row;
  }

  function showTableState(kind, title, description, { retry = false } = {}) {
    ui.wrap.hidden = true;
    ui.tableState.hidden = false;
    ui.tableState.dataset.kind = kind;
    text(ui.stateIcon, kind === 'loading' ? '· · ·' : kind === 'error' ? '!' : '—');
    text(ui.stateTitle, title);
    text(ui.stateDescription, description);
    ui.retry.hidden = !retry;
  }

  function renderAccounts() {
    const group = currentGroup();
    updateGroupTabs();
    if (!group.snapshot) {
      ui.rows.replaceChildren();
      text(ui.count, '暂无数据');
      if (group.problem) {
        showTableState('error', group.problem.title, group.problem.message, {
          retry: !state.authBlocked,
        });
      } else {
        text(ui.count, '等待数据');
        showTableState('loading', '正在读取上游额度', '正在获取账号额度与当前并发，请稍候。');
      }
      return;
    }
    const accounts = visibleAccounts();
    text(ui.count, accounts.length + ' 个账号');
    if (!accounts.length) {
      ui.rows.replaceChildren();
      showTableState('empty', '暂无此分组账号', '当前分组暂时没有可展示的上游账号。');
    } else {
      const fragment = document.createDocumentFragment();
      accounts.forEach((account) => fragment.append(accountRow(account)));
      ui.rows.replaceChildren(fragment);
      ui.wrap.hidden = false;
      ui.tableState.hidden = true;
    }
  }

  function renderSummary() {
    const snapshot = currentGroup().snapshot;
    const summary = snapshot ? snapshot.summary : {};
    ['total', 'available', 'limited', 'disabled'].forEach((key) => text(byId('summary-' + key), count(summary[key])));
    text(byId('summary-current'), count(summary.currentConcurrency));
    text(byId('summary-max'), count(summary.maxConcurrency));
    text(ui.activeUsers, count(summary.activeUsersFiveMinutes));
    const activity = snapshot && isRecord(snapshot.activity) ? snapshot.activity : {};
    text(ui.activeUsersHint, '当前分组 · 用户去重' + (activity.stale === true ? ' · 旧数据' : ''));
    ui.activeUsersMetric.dataset.stale = String(activity.stale === true);
    if (timestamp(activity.updatedAt) !== null) {
      ui.activeUsersMetric.title = '数据时间：' + formatTime(activity.updatedAt, true) + '（北京时间）';
    } else {
      ui.activeUsersMetric.removeAttribute('title');
    }
    setTime(ui.snapshotTime, snapshot && snapshot.updatedAt);
    setTime(ui.quotaTime, snapshot && snapshot.quotaUpdatedAt, snapshot ? '暂无记录' : '—');
  }

  function renderNotices() {
    const { problem, snapshot } = currentGroup();
    ui.requestNotice.hidden = !problem;
    if (problem) {
      ui.requestNotice.className = 'notice ' + (problem.warning ? 'notice-warning' : 'notice-error');
      text(ui.requestTitle, problem.title);
      text(ui.requestMessage, problem.message);
      ui.dashboardLink.hidden = !problem.back;
    }
    const staleAccounts = snapshot && snapshot.accounts.some((account) => account.quotaState === 'stale');
    const warning = snapshot && typeof snapshot.warning === 'string' ? snapshot.warning.trim() : '';
    ui.dataNotice.hidden = !snapshot || (!snapshot.stale && !staleAccounts && !warning);
    if (!ui.dataNotice.hidden) {
      text(ui.dataTitle, snapshot.stale ? '正在显示较早的额度数据' : staleAccounts ? '部分账号额度已过期' : '额度查询提示');
      const messages = [];
      if (snapshot.stale || staleAccounts) {
        messages.push(timestamp(snapshot.quotaUpdatedAt) !== null
          ? '最近额度更新：' + formatTime(snapshot.quotaUpdatedAt, true) + '（北京时间）。'
          : '暂未获取到新的额度，请稍后再更新。');
      }
      if (warning) messages.push(warning);
      text(ui.dataMessage, messages.join('\n'));
    }
  }

  function renderControls() {
    const group = currentGroup();
    const busy = state.controller !== null || state.sessionPending;
    ui.panel.setAttribute('aria-busy', String(busy));
    ui.retry.disabled = busy;
    ui.refresh.disabled = busy || !group.snapshot || state.authBlocked || group.configurationBlocked;
    ui.refresh.dataset.busy = String(state.requestKind === 'refresh');
    text(ui.refreshLabel, state.requestKind === 'refresh' ? '正在更新' : '立即更新');
    let label = '每60秒更新当前分组，其他分组切换时读取';
    let tone = 'ready';
    if (busy) {
      label = state.requestKind === 'refresh' ? '正在更新额度' : group.snapshot ? '正在检查更新' : '正在连接';
      tone = 'loading';
    } else if (group.problem) {
      label = group.snapshot ? (group.problem.warning ? '等待下次检查' : '更新失败 · 保留上次数据') : '暂时无法读取';
      tone = group.snapshot || group.problem.warning ? 'warning' : 'error';
    } else if (group.snapshot && group.snapshot.stale) {
      label = '显示缓存 · 等待更新';
      tone = 'warning';
    }
    text(ui.connectionLabel, label);
    ui.connection.dataset.state = tone;
  }

  function render() {
    renderSummary();
    renderNotices();
    renderAccounts();
    renderControls();
  }

  function handleFailure(error, kind) {
    const group = currentGroup();
    if (error.status === 401 || error.status === 403) {
      state.authBlocked = true;
      state.groupCounts = null;
      Object.values(state.groups).forEach(cached => {
        cached.snapshot = null;
        cached.problem = {
          title: error.status === 401 ? '需要有效的访问会话' : '当前会话无法查看额度',
          message: '请从 sub2api 的「上游额度」菜单打开', back: true,
        };
      });
    } else if (error.status === 503 && error.code === 'NOT_CONFIGURED') {
      group.snapshot = null;
      group.configurationBlocked = true;
      group.problem = { title: '额度页面暂未配置', message: '请联系管理员完成配置后再试。' };
    } else if (error.status === 429) {
      group.problem = {
        title: '请求过于频繁', warning: true,
        message: '暂时无法更新当前分组，请稍后重试。',
      };
    } else if (error.code === 'INVALID_RESPONSE') {
      group.problem = { title: '暂时无法读取额度', message: '返回的数据暂时无法显示，请稍后重新加载。' };
    } else if (error.code === 'TIMEOUT') {
      group.problem = { title: kind === 'refresh' ? '更新等待超时' : '读取等待超时', message: '本次请求用时较长，请稍后重试。' };
    } else {
      group.problem = {
        title: kind === 'refresh' ? '额度更新失败' : '暂时无法读取额度',
        message: error.status >= 500 ? '额度服务暂时不可用，请稍后重试。' : '请检查网络连接后重试，页面会定时检查更新。',
      };
    }
    render();
  }

  async function loadSnapshot(refresh = false) {
    if (state.paused || state.sessionPending || state.authBlocked) return;
    if (document.hidden || state.controller) return;
    const groupKey = state.activeGroup;
    const group = state.groups[groupKey];
    if (refresh && (!group.snapshot || group.configurationBlocked)) return;
    const controller = new AbortController();
    state.controller = controller;
    const kind = refresh ? 'refresh' : 'snapshot';
    state.requestKind = kind;
    let timedOut = false;
    let authenticationError = null;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    renderControls();
    try {
      const snapshot = await apiRequest(kind + '?group=' + encodeURIComponent(groupKey), {
        method: refresh ? 'POST' : 'GET', signal: controller.signal,
      });
      if (state.controller !== controller || controller.signal.aborted) return;
      if (!validSnapshot(snapshot, groupKey)) throw new ApiError(200, 'INVALID_RESPONSE');
      group.snapshot = snapshot;
      group.problem = null;
      group.configurationBlocked = false;
      if (isRecord(snapshot.groupCounts)) state.groupCounts = snapshot.groupCounts;
      render();
      if (refresh) text(ui.live, '当前分组额度已更新。');
    } catch (error) {
      if (state.controller !== controller || (controller.signal.aborted && !timedOut)) return;
      if (!timedOut && error.status === 401) authenticationError = error;
      else handleFailure(timedOut ? new ApiError(0, 'TIMEOUT') : error, kind);
    } finally {
      window.clearTimeout(timeout);
      if (state.controller === controller) {
        state.controller = null;
        state.requestKind = null;
        renderControls();
      }
    }
    if (authenticationError && !state.paused) {
      const recovered = await restoreStoredSession();
      if (state.paused) return;
      if (recovered.ok) await loadSnapshot();
      else handleFailure(recovered.error || authenticationError, 'session');
    }
  }

  async function exchangeSession(token) {
    state.sessionPending = true;
    const controller = new AbortController();
    state.controller = controller;
    state.requestKind = 'session';
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    renderControls();
    try {
      await apiRequest('session', { method: 'POST', token, signal: controller.signal });
    } catch (error) {
      throw timedOut ? new ApiError(0, 'TIMEOUT') : error;
    } finally {
      window.clearTimeout(timeout);
      if (state.controller === controller) {
        state.controller = null;
        state.requestKind = null;
      }
      state.sessionPending = false;
      renderControls();
    }
  }

  async function restoreStoredSession() {
    // Prefer the viewer cookie. Read only the main site's normal user-token key,
    // and only after a 401. A page visit gets at most one fallback attempt.
    if (state.fallbackAttempted || state.paused) return { ok: false, error: null };
    state.fallbackAttempted = true;
    let token = null;
    try { token = window.localStorage.getItem('auth_token'); } catch (_) { /* No fallback available. */ }
    if (typeof token !== 'string' || !token.trim()) return { ok: false, error: null };
    try {
      await exchangeSession(token);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error };
    } finally {
      token = null;
    }
  }

  async function bootstrap() {
    let token = entryToken;
    entryToken = null;
    if (token) {
      try {
        await exchangeSession(token);
      } catch (error) {
        token = null;
        if (state.paused) return;
        if (error.status === 401) {
          const recovered = await restoreStoredSession();
          if (!recovered.ok) {
            if (!state.paused) handleFailure(recovered.error || error, 'session');
            return;
          }
        } else {
          handleFailure(error, 'session');
          return;
        }
      } finally {
        token = null;
      }
    } else {
      state.sessionPending = false;
    }
    await loadSnapshot();
  }

  function tick() {
    if (document.hidden || state.paused) return;
    const now = Date.now();
    // Only countdown text changes here, preserving the table and scroll position.
    document.querySelectorAll('[data-reset-at]').forEach((node) => text(node, resetLabel(node.dataset.resetAt, now)));
    renderControls();
  }

  function startTimers() {
    window.clearInterval(state.pollTimer);
    window.clearInterval(state.countdownTimer);
    if (document.hidden || state.paused) return;
    state.pollTimer = window.setInterval(() => { void loadSnapshot(); }, 60000);
    state.countdownTimer = window.setInterval(tick, 1000);
  }

  function cancelGroupRequest() {
    if (!state.controller || state.requestKind === 'session') return;
    state.controller.abort();
    state.controller = null;
    state.requestKind = null;
  }

  function selectGroup(key) {
    if (!groupKeys.includes(key) || key === state.activeGroup) return;
    // Detach the old request before rendering: even a late response cannot change the new tab.
    cancelGroupRequest();
    state.activeGroup = key;
    render();
    if (!currentGroup().snapshot) void loadSnapshot();
  }

  ui.refresh.addEventListener('click', () => { void loadSnapshot(true); });
  ui.retry.addEventListener('click', () => { void loadSnapshot(); });
  ui.groupTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { selectGroup(tab.dataset.group); });
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % ui.groupTabs.length;
      else if (event.key === 'ArrowLeft') next = (index + ui.groupTabs.length - 1) % ui.groupTabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = ui.groupTabs.length - 1;
      else return;
      event.preventDefault();
      ui.groupTabs[next].focus();
      selectGroup(ui.groupTabs[next].dataset.group);
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.clearInterval(state.pollTimer);
      window.clearInterval(state.countdownTimer);
      if (state.requestKind === 'snapshot') cancelGroupRequest();
    } else {
      startTimers();
      tick();
    }
  });
  window.addEventListener('pagehide', () => {
    state.paused = true;
    if (state.controller) state.controller.abort();
    window.clearInterval(state.pollTimer);
    window.clearInterval(state.countdownTimer);
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      state.paused = false;
      startTimers();
      tick();
    }
  });

  initialiseTheme();
  render();
  startTimers();
  void bootstrap();
})();
