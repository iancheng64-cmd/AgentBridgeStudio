const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

test('managed attachment lookup, pasted image integrity and path substitution rejection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-attachments-'));
  const handlers = new Map(); const originalLoad = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'electron') return {
      app: { getPath: () => path.join(root, 'data') },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({width:2,height:2}), toDataURL: () => 'data:image/png;base64,cHJldmlldw==' }) }
    };
    return originalLoad.call(this, name, ...args);
  };
  let backend;
  try { backend = require('../dist-main/desktop-backend.js'); } finally { Module._load = originalLoad; }
  backend.registerDesktopBackend({ session: () => undefined, window: () => null, emit() {}, upload: async () => {} });
  const call = (name, ...args) => handlers.get(name)({}, ...args);
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=', 'base64');
    const [image] = await call('library:addImage', { dataUrl: 'data:image/png;base64,' + png.toString('base64') });
    assert.deepEqual(fs.readFileSync(image.localPath), png);
    const [resolved] = await backend.resolveLibraryEntries([image.id]);
    assert.equal(resolved.mimeType, 'image/png');
    assert.equal(resolved.path, fs.realpathSync(image.localPath));
    assert.equal((await call('library:preview', image.id)).startsWith('data:image/'), true);
    await assert.rejects(call('library:addImage', { dataUrl: 'data:image/png;base64,' + Buffer.from('not an image').toString('base64') }), /辨識/);
    await assert.rejects(backend.resolveLibraryEntries(['../../private']), /有效附件/);
    await assert.rejects(backend.resolveLibraryEntries(Array(21).fill(image.id)), /20/);
    const index = path.join(backend.libraryRoot(), 'index.json');
    const items = JSON.parse(fs.readFileSync(index));
    const secret = path.join(root, 'outside.txt'); fs.writeFileSync(secret, 'fixture only');
    fs.writeFileSync(index, JSON.stringify(items.map(item => ({ ...item, localPath: secret }))));
    await assert.rejects(backend.resolveLibraryEntries([image.id]), /受管理/);
    fs.writeFileSync(index, JSON.stringify(items));
    fs.unlinkSync(image.localPath); fs.symlinkSync(secret, image.localPath);
    await assert.rejects(backend.resolveLibraryEntries([image.id]), /受管理/);
    fs.unlinkSync(image.localPath); fs.writeFileSync(image.localPath, png);
    assert.deepEqual(call('library:remove', image.id), []);
    await assert.rejects(backend.resolveLibraryEntries([image.id]), /移除/);
    assert.equal(fs.existsSync(secret), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
