import fs from 'node:fs';
import path from 'node:path';

/** Public packages carry a version-matched browser; never download on first launch. */
export function browserExecutable(root: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'browser-runtime.json'), 'utf8'));
  const relative = manifest.executable;
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error('內建瀏覽器資訊無效，請重新下載完整的 AgentBridge 安裝檔。');
  }
  const file = path.resolve(root, relative);
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(file);
  if (!realFile.startsWith(realRoot + path.sep)) throw new Error('內建瀏覽器路徑超出安裝範圍。');
  fs.accessSync(file, fs.constants.X_OK);
  if (!fs.statSync(file).isFile()) throw new Error('內建瀏覽器執行檔遺失，請重新下載完整安裝檔。');
  return file;
}

export function browserRuntimeArgs(root: string): string[] {
  return ['--browser', 'chrome', '--executable-path', browserExecutable(root)];
}
