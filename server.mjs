import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createQuotaSource, serviceError } from './sub2api.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([['', ['index.html', 'text/html; charset=utf-8']], ['index.html', ['index.html', 'text/html; charset=utf-8']], ['app.js', ['app.js', 'text/javascript; charset=utf-8']], ['pressure.js', ['pressure.js', 'text/javascript; charset=utf-8']], ['style.css', ['style.css', 'text/css; charset=utf-8']]]);
const SESSION_NAME = 'sub2api_quota_sid';
const PUBLIC_ERROR_CODES = new Set(['AUTH_UNAVAILABLE', 'LOGIN_REQUIRED', 'ORIGIN_REJECTED', 'TOO_MANY_REQUESTS', 'INVALID_GROUP', 'NOT_CONFIGURED', 'ADMIN_KEY_REJECTED', 'UPSTREAM_UNAVAILABLE']);

export function createQuotaServer({ source, baseUrl, publicOrigin, allowedFrameOrigins = [], basePath = '/quota', now = Date.now }) {
  const origin = new URL(publicOrigin).origin;
  const frameAncestors = [...new Set([origin, ...allowedFrameOrigins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Allowed frame origins must be HTTP(S) origins without credentials');
    return url.origin;
  })])].join(' ');
  const upstream = String(baseUrl).replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  const prefix = '/' + basePath.replace(/^\/+|\/+$/g, '') + '/';
  const sessions = new Map(), attempts = new Map();
  async function identity(token) {
    let response;
    try { response = await fetch(upstream + '/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(8_000) }); }
    catch { throw serviceError('AUTH_UNAVAILABLE', '暂时无法验证登录，请稍后再试', 503); }
    if (response.status === 401 || response.status === 403) throw serviceError('LOGIN_REQUIRED', '请从 sub2api 的「上游额度」菜单打开', 401);
    if (!response.ok) throw serviceError('AUTH_UNAVAILABLE', '暂时无法验证登录，请稍后再试', 503);
    let body; try { body = await response.json(); } catch { throw serviceError('AUTH_UNAVAILABLE', '暂时无法验证登录，请稍后再试', 503); }
    if (body.code !== 0 || !body.data?.id || (body.data.status && body.data.status !== 'active')) throw serviceError('LOGIN_REQUIRED', '请重新登录 sub2api 后打开额度页面', 401);
  }
  function cookie(res, id) {
    res.setHeader('Set-Cookie', `${SESSION_NAME}=${id}; Path=${prefix}; HttpOnly; SameSite=Lax; Max-Age=1800${origin.startsWith('https:') ? '; Secure' : ''}`);
  }
  async function authorize(req, res) {
    const raw = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_NAME + '='));
    const sid = raw?.slice(SESSION_NAME.length + 1), session = sessions.get(sid);
    if (!session || session.expiresAt <= now()) { if (sid) sessions.delete(sid); throw serviceError('LOGIN_REQUIRED', '请从 sub2api 的「上游额度」菜单打开', 401); }
    if (now() - session.checkedAt >= 60_000) {
      try { await identity(session.token); session.checkedAt = now(); }
      catch (error) { if (error.status === 401) sessions.delete(sid); throw error; }
    }
    session.expiresAt = now() + 1_800_000; cookie(res, sid);
  }
  function sameOrigin(req) {
    if (req.headers.origin && req.headers.origin !== origin) throw serviceError('ORIGIN_REJECTED', '请从本站打开额度页面', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw serviceError('ORIGIN_REJECTED', '请从本站打开额度页面', 403);
  }
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    req.resume();
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}`);
    try {
      const requestUrl = new URL(req.url, origin);
      const pathname = requestUrl.pathname;
      if (pathname === prefix.slice(0, -1)) { res.writeHead(308, { Location: prefix }); res.end(); return; }
      if (!pathname.startsWith(prefix)) { json(res, 404, { code: 'NOT_FOUND', message: '页面不存在' }); return; }
      const route = pathname.slice(prefix.length);
      if (route === 'healthz' && req.method === 'GET') { json(res, 200, { status: 'ok', configured: source.configured }); return; }
      if (route === 'api/session' && req.method === 'POST') {
        sameOrigin(req);
        const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
        const current = attempts.get(ip);
        const attempt = !current || current.until <= now() ? { count: 0, until: now() + 60_000 } : current;
        if (++attempt.count > 30) throw serviceError('TOO_MANY_REQUESTS', '打开过于频繁，请稍后再试', 429);
        attempts.set(ip, attempt);
        const match = /^Bearer\s+(\S{1,8192})$/i.exec(String(req.headers.authorization || ''));
        if (!match) throw serviceError('LOGIN_REQUIRED', '请从 sub2api 的「上游额度」菜单打开', 401);
        await identity(match[1]);
        if (sessions.size >= 2000) sessions.delete(sessions.keys().next().value);
        const sid = randomBytes(32).toString('base64url');
        sessions.set(sid, { token: match[1], checkedAt: now(), expiresAt: now() + 1_800_000 }); cookie(res, sid);
        json(res, 200, { ok: true }); return;
      }
      if ((route === 'api/snapshot' && req.method === 'GET') || (route === 'api/refresh' && req.method === 'POST')) {
        if (req.method === 'POST') sameOrigin(req);
        await authorize(req, res);
        const group = requestUrl.searchParams.get('group') || 'chatgpt';
        if (!['chatgpt', 'antigravity', 'gemini'].includes(group)) throw serviceError('INVALID_GROUP', '请选择有效的账号分组', 400);
        json(res, 200, await source.getSnapshot({ group, refresh: req.method === 'POST' })); return;
      }
      if (ASSETS.has(route) && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = ASSETS.get(route), content = await readFile(path.join(directory, 'public', file));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length }); res.end(req.method === 'HEAD' ? undefined : content); return;
      }
      json(res, 404, { code: 'NOT_FOUND', message: '页面不存在' });
    } catch (error) {
      const known = PUBLIC_ERROR_CODES.has(error?.code);
      const status = known ? (error.code === 'ADMIN_KEY_REJECTED' ? 503 : Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500) : 500;
      json(res, status, { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '暂时无法加载额度，请稍后再试' });
    }
  });
  const cleanup = setInterval(() => {
    for (const [key, value] of sessions) if (value.expiresAt <= now()) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
  }, 60_000).unref();
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseUrl = process.env.SUB2API_BASE_URL || 'http://127.0.0.1:8080';
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  if (!publicOrigin) throw new Error('PUBLIC_ORIGIN is required');
  const source = createQuotaSource({ baseUrl, adminKey: process.env.SUB2API_ADMIN_KEY || '' });
  const allowedFrameOrigins = (process.env.ALLOWED_FRAME_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const server = createQuotaServer({ source, baseUrl, publicOrigin, allowedFrameOrigins, basePath: process.env.BASE_PATH || '/quota' });
  const port = Number(process.env.PORT || 18081);
  server.listen(port, '127.0.0.1', () => console.log(`Quota page listening on 127.0.0.1:${port}; administrator key ${source.configured ? 'configured' : 'not configured'}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); });
}
