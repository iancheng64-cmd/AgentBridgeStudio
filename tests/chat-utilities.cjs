/* A/B feature unit tests: branchChat + findInConversation (pure helpers, no React).
 * Run: node --test tests/chat-utilities.cjs */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// ponytail: helpers are TS with no deps; the repo's other .cjs tests transpile the
// same way via vite OXC. Dynamic-import vite (ESM-only) so no new build path exists.
async function loadHelpers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat-utilities.ts'), 'utf8');
  const file = path.join(__dirname, '..', 'src', 'renderer', 'chat-utilities.ts');
  // ponytail: same oxc path the export-markdown test uses — no extra transpile API
  const vite = await import('vite');
  const out = await vite.transformWithOxc(source, file, {});
  const tmp = path.join(__dirname, '.chat-utilities.compiled.mjs');
  fs.writeFileSync(tmp, out.code);
  const module_ = await import(tmp);
  const exports_ = module_;
  assert.ok(exports_.branchChat, 'branchChat exported from chat-utilities');
  return exports_;
}

let helpers = null;
async function ready() { if (!helpers) helpers = await loadHelpers(); return helpers; }

const id = () => require('crypto').randomUUID();
const now = 1700000000000;
const chat = () => ({
  id: id(), title: '分段討論', agent: 'codex', createdAt: now, updatedAt: now,
  messages: [
    { id: 'm1', role: 'user', text: '幫我規劃一個 iOS App' },
    { id: 'm2', role: 'assistant', text: '先確認目標用戶與平台範圍。' },
    { id: 'm3', role: 'user', text: '目標是學生族群' },
    { id: 'm4', role: 'assistant', text: '了解，從筆記功能切入。' }
  ]
});

test('branchChat keeps messages up to the anchor and drops everything after', async () => {
  const { branchChat } = await ready();
  const created = branchChat(chat(), 'm2', id, now);
  assert.ok(created, 'branchChat should return a chat');
  assert.equal(created.messages.length, 2, 'branch keeps m1 + m2 only');
  assert.deepEqual(created.messages.map(m => m.id), ['m1', 'm2']);
  assert.notEqual(created.id, chat().id, 'branch gets a fresh id');
  assert.ok(created.title.includes('分支'), `branch title mentions 分支: ${created.title}`);
});

test('branchChat on the last message keeps the whole conversation', async () => {
  const { branchChat } = await ready();
  const created = branchChat(chat(), 'm4', id, now);
  assert.equal(created.messages.length, 4);
});

test('findInConversation matches text across messages, case-insensitive', async () => {
  const { findInConversation } = await ready();
  const hits = findInConversation(chat(), 'IOS');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, 'm1');
  assert.ok(hits[0].excerpt.length > 0, 'hit carries an excerpt');
});

test('findInConversation escapes empty queries', async () => {
  const { findInConversation } = await ready();
  assert.deepEqual(findInConversation(chat(), '   '), []);
});

test('findInConversation clamps result count', async () => {
  const { findInConversation } = await ready();
  const big = { id: id(), title: '長對話', messages: Array.from({ length: 300 }, (_, i) => ({ id: `x${i}`, role: i % 2 ? 'assistant' : 'user', text: `段落 ${i} 語音測試` })) };
  const hits = findInConversation(big, '語音');
  assert.ok(hits.length <= 200, `expected <= 200 hits, got ${hits.length}`);
  assert.ok(hits.length > 0);
});

test('findInConversation searches tool titles', async () => {
  const { findInConversation } = await ready();
  const withTools = { id: id(), title: '工具對話', messages: [{ id: 't1', role: 'assistant', text: '執行完畢', tools: [{ title: '讀取 /Users/ian/Downloads/規格.md' }] }] };
  const hits = findInConversation(withTools, '規格');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].toolTitles, ['讀取 /Users/ian/Downloads/規格.md']);
});

test('EXCERPT_RADIUS keeps excerpts bounded', async () => {
  const { findInConversation, EXCERPT_RADIUS } = await ready();
  const long = { id: id(), title: '長文', messages: [{ id: 'l1', role: 'user', text: '一'.repeat(5000) + '釣魚關鍵字' + '二'.repeat(5000) }] };
  const [hit] = findInConversation(long, '釣魚');
  assert.ok(hit.excerpt.length <= 2 * EXCERPT_RADIUS + 40, `excerpt ${hit.excerpt.length} exceeds radius ${EXCERPT_RADIUS}`);
  assert.ok(hit.excerpt.includes('釣魚'));
});
