import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function mergeMenu(items, publicOrigin, basePath = '/quota') {
  const list = Array.isArray(items) ? items : [];
  const entry = { id: 'upstream-quota', label: '上游额度', url: new URL(basePath.replace(/\/$/, '') + '/', publicOrigin).href, visibility: 'user', sort_order: 100 };
  const existing = list.find(item => item.id === entry.id);
  return [...list.filter(item => item.id !== entry.id), { ...existing, ...entry }];
}
export async function configureMenu({ baseUrl, adminKey, publicOrigin, basePath = '/quota' }) {
  if (!adminKey) { console.log('Menu pending: configure SUB2API_ADMIN_KEY in the service environment'); return false; }
  const root = String(baseUrl).replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  async function request(method, body) {
    const response = await fetch(root + '/api/v1/admin/settings', { method, redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'x-api-key': adminKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Menu configuration returned HTTP ${response.status}; administrator settings permission is required`);
    const envelope = await response.json();
    if (envelope.code !== 0 || !envelope.data) throw new Error('Menu configuration returned an invalid response');
    return envelope.data;
  }
  const settings = await request('GET');
  const items = typeof settings.custom_menu_items === 'string' ? JSON.parse(settings.custom_menu_items) : settings.custom_menu_items;
  const custom_menu_items = mergeMenu(items, publicOrigin, basePath);
  if (JSON.stringify(items) !== JSON.stringify(custom_menu_items)) await request('PUT', { custom_menu_items });
  console.log('User menu configured: 上游额度'); return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureMenu({ baseUrl: process.env.SUB2API_BASE_URL || 'http://127.0.0.1:8080', adminKey: process.env.SUB2API_ADMIN_KEY || '', publicOrigin: process.env.PUBLIC_ORIGIN, basePath: process.env.BASE_PATH || '/quota' }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
