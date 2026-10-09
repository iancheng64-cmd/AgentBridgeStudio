'use strict';
/* Regression: export full conversation as Markdown.
 * Loads the pure serializer from App.tsx via the vite/oxc pipeline so it runs under plain Node. */
const path = require('path');
const fs = require('fs');
const { chatToMarkdown, sanitizeFilename } = (() => {
  try {
    return require(path.join(__dirname, '..', 'src', 'renderer', 'export-markdown.ts'));
  } catch (error) {
    // ponytail: when .ts require fails (no ts hook registered), transpile with the same oxc the build uses
    const vite = require('vite');
    const file = path.join(__dirname, '..', 'src', 'renderer', 'export-markdown.ts');
    const code = fs.readFileSync(file, 'utf8');
    const out = vite.transformWithOxc(code, file, {});
    const tmp = path.join(__dirname, '.export-markdown.compiled.cjs');
    fs.writeFileSync(tmp, out.code);
    return require(tmp);
  }
})();

function assert(label, cond) {
  if (!cond) throw new Error('FAIL ' + label);
}

function testExportMarkdown() {
  const chat = {
    title: '修 cancel 死鎖',
    agent: 'claude',
    messages: [
      { role: 'user', text: '幫我修 cancel 死鎖', attachments: [{ name: 'log.txt' }], status: 'completed' },
      { role: 'assistant', text: '已修好。', tools: [{ title: '讀取檔案', status: 'completed', durationMs: 1234 }], status: 'completed' },
      { role: 'user', text: '', status: 'cancelled' },
    ],
    updatedAt: 1000,
  };
  const md = chatToMarkdown(chat);

  assert('title heading', md.startsWith('# 修 cancel 死鎖'));
  assert('agent label', md.includes('Agent：Claude Code'));
  assert('message count', md.includes('3 則訊息'));
  assert('user heading', md.includes('## 使用者'));
  assert('assistant heading', md.includes('## Agent'));
  assert('user text', md.includes('幫我修 cancel 死鎖'));
  assert('attachment listed', md.includes('**附件：** log.txt'));
  assert('tool listed', md.includes('讀取檔案（完成 · 1.2 秒）'));
  assert('cancelled status', md.includes('已停止'));
  assert('empty text produces no stray heading gap', !/## 使用者\n\*[^*]*\*\n\n##/.test(md));

  const codex = chatToMarkdown({ title: '測試', agent: 'codex', messages: [{ role: 'assistant', text: 'ok' }] });
  assert('codex agent label', codex.includes('Agent：Codex'));

  assert('filename sanitiser', sanitizeFilename('A/B:C*D?E"F<G>H') === 'A-B-C-D-E-F-G-H');
  assert('filename fallback for empty title', sanitizeFilename('') === '對話');
  assert('filename capped at 60', sanitizeFilename('x'.repeat(80)).length === 60);

  console.log('ok - exportMarkdown produces full conversation markdown');
}

testExportMarkdown();
