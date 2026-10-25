import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMenu } from '../scripts/configure-menu.mjs';
test('menu sync preserves existing entries and is idempotent', () => {
 const original = [{ id: 'help', label: '帮助', url: 'https://example.com/help', visibility: 'user' }];
 const merged = mergeMenu(original, 'https://sub.example');
 assert.deepEqual(merged[0], original[0]); assert.equal(merged.length, 2);
 assert.equal(merged[1].url, 'https://sub.example/quota/');
 assert.deepEqual(mergeMenu(merged, 'https://sub.example'), merged);
 assert.equal(merged[1].visibility, 'user');
});
