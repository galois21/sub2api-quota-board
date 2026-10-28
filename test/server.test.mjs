import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createQuotaServer } from '../server.mjs';

async function listen(t, server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve))); return `http://127.0.0.1:${server.address().port}`; }
const snapshot = { summary: { total: 1 }, accounts: [{ id: 1, name: 'Claude #1', windows: [] }] };
async function setup(t, { configured = true, sourceError = null, allowedFrameOrigins = [] } = {}) {
  let clock = Date.now(), active = true, reads = 0;
  const requests = [];
  const upstream = await listen(t, createServer((req, res) => {
    if (req.url !== '/api/v1/auth/me' || req.headers.authorization !== 'Bearer viewer-test-token' || !active) { res.statusCode = 401; res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, data: { id: 1, status: 'active' } }));
  }));
  const source = { configured, async getSnapshot(options) { reads++; requests.push(options); if (sourceError) throw sourceError; if (!configured) throw Object.assign(new Error('额度服务尚未配置，请联系管理员'), { code: 'NOT_CONFIGURED', status: 503 }); return snapshot; } };
  const url = await listen(t, createQuotaServer({ source, baseUrl: upstream, publicOrigin: 'https://viewer.example', allowedFrameOrigins, now: () => clock }));
  const request = (path, options = {}) => fetch(url + '/quota/' + path, { ...options, redirect: 'manual' });
  const login = () => request('api/session', { method: 'POST', headers: { Authorization: 'Bearer viewer-test-token', Origin: 'https://viewer.example' } });
  return { request, login, clock: () => { clock += 61_000; }, deactivate: () => { active = false; }, reads: () => reads, requests };
}

test('snapshot and manual refresh forward only the selected provider and reject invalid groups', async t => {
  const app = await setup(t); const login = await app.login();
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: 'https://viewer.example' };
  assert.equal((await app.request('api/snapshot', { headers })).status, 200);
  assert.equal((await app.request('api/snapshot?group=antigravity', { headers })).status, 200);
  assert.equal((await app.request('api/refresh?group=gemini', { method: 'POST', headers })).status, 200);
  assert.deepEqual(app.requests, [
    { group: 'chatgpt', refresh: false }, { group: 'antigravity', refresh: false }, { group: 'gemini', refresh: true },
  ]);
  for (const route of ['api/snapshot', 'api/refresh']) {
    const response = await app.request(route + '?group=arbitrary', { headers, method: route.endsWith('refresh') ? 'POST' : 'GET' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_GROUP');
  }
  assert.equal(app.reads(), 3);
});

test('public shell loads but snapshot and arbitrary admin paths are protected', async t => {
  const app = await setup(t);
  assert.equal((await app.request('')).status, 200);
  const denied = await app.request('api/snapshot'); assert.equal(denied.status, 401);
  assert.equal(app.reads(), 0);
  assert.equal((await app.request('api/admin/accounts')).status, 404);
  assert.equal((await app.request('.env')).status, 404);
});
test('unexpected coded errors never expose server paths or raw details to viewers', async t => {
  const app = await setup(t, { sourceError: Object.assign(new Error('EACCES: /etc/private-example.env contains private details'), { code: 'EACCES' }) });
  const login = await app.login();
  const response = await app.request('api/snapshot', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { code: 'INTERNAL_ERROR', message: '暂时无法加载额度，请稍后再试' });
});

test('only allowlisted assets are public and query tokens do not authorize snapshots', async t => {
  const app = await setup(t);
  for (const route of ['.env.example', '.git/config', '.git/HEAD', 'server.mjs', 'package.json', 'deploy/nginx.conf']) {
    assert.equal((await app.request(route)).status, 404, route);
  }
  assert.equal((await app.request('api/snapshot?token=viewer-test-token')).status, 401);
  assert.equal(app.reads(), 0);
});

test('existing user token creates an opaque safe cookie and can read the snapshot', async t => {
  const app = await setup(t); const login = await app.login();
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Path=\/quota\//);
  assert.ok(!cookie.includes('viewer-test-token'));
  const response = await app.request('api/snapshot', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), snapshot);
  assert.ok(!JSON.stringify([...response.headers]).includes('viewer-test-token'));
});
test('cross-origin login and refresh are blocked', async t => {
  const app = await setup(t);
  assert.equal((await app.request('api/session', { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: 'Bearer viewer-test-token' } })).status, 403);
  const login = await app.login(); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.request('api/refresh', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await app.request('api/refresh', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://viewer.example' } })).status, 200);
});
test('a revoked upstream user loses access after identity cache expiry', async t => {
  const app = await setup(t); const login = await app.login(); const cookie = login.headers.get('set-cookie').split(';')[0];
  app.deactivate(); app.clock();
  assert.equal((await app.request('api/snapshot', { headers: { Cookie: cookie } })).status, 401);
});
test('missing admin key is configuration failure and never a request for viewer model keys', async t => {
  const app = await setup(t, { configured: false }); const login = await app.login();
  const response = await app.request('api/snapshot', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'NOT_CONFIGURED');
});
test('frame policy allows only the main site and health discloses no credentials', async t => {
  const app = await setup(t); const shell = await app.request('');
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors https:\/\/viewer\.example/);
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
  const health = await app.request('healthz'); assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', configured: true });
});

test('additional embedding sites do not gain cross-origin API permissions', async t => {
  const app = await setup(t, { allowedFrameOrigins: ['https://legacy.example', 'https://viewer.example'] });
  const shell = await app.request('');
  const policy = shell.headers.get('content-security-policy');
  const directive = policy.split(';').map(value => value.trim()).find(value => value.startsWith('frame-ancestors '));
  assert.deepEqual(directive.split(/\s+/).slice(1), ['https://viewer.example', 'https://legacy.example']);
  const denied = await app.request('api/session', { method: 'POST', headers: { Origin: 'https://legacy.example', Authorization: 'Bearer viewer-test-token' } });
  assert.equal(denied.status, 403);
  const login = await app.login();
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.request('api/snapshot', { headers: { Cookie: cookie } })).status, 200);
});

test('embedding allowlist rejects wildcards, non-web schemes, and credentials', () => {
  for (const value of ['*', 'javascript:alert(1)', 'data:text/html,test', 'https://user:pass@legacy.example']) {
    assert.throws(() => createQuotaServer({ source: { configured: true }, baseUrl: 'http://127.0.0.1:8080', publicOrigin: 'https://viewer.example', allowedFrameOrigins: [value] }));
  }
});

test('the quota pace module is a public static asset without administrator data', async t => {
  const app = await setup(t);
  const response = await app.request('pressure.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /export function calculatePressure/);
  assert.equal(app.reads(), 0);
});
