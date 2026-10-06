#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build/third-party-notices');
fs.mkdirSync(output, {recursive:true});
const entries = [];
function visit(directory) {
  for (const item of fs.readdirSync(directory, {withFileTypes:true})) {
    if (!item.isDirectory() || item.isSymbolicLink() || item.name.startsWith('.')) continue;
    const dir = path.join(directory, item.name);
    if (item.name.startsWith('@')) {visit(dir); continue;}
    const pkgFile = path.join(dir, 'package.json');
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const licenses = fs.readdirSync(dir).filter(name => /^(license|licence|notice|copying)(\.|$)/i.test(name) && fs.statSync(path.join(dir,name)).isFile());
      entries.push(`## ${pkg.name} ${pkg.version}\nLicense metadata: ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license||'see upstream')}\n` + licenses.map(name => `### ${name}\n\n${fs.readFileSync(path.join(dir,name),'utf8')}`).join('\n\n'));
    }
    if (fs.existsSync(path.join(dir,'node_modules'))) visit(path.join(dir,'node_modules'));
  }
}
visit(path.join(root,'node_modules'));
fs.writeFileSync(path.join(output, 'NODE_DEPENDENCIES.md'), entries.sort().join('\n\n---\n\n') + '\n');
for (const [source,target] of [['LICENSE','APP-LICENSE.txt'],['vendor/open-codex-computer-use/LICENSE','COMPUTER-USE-LICENSE.txt'],['vendor/codex/LICENSE','CODEX-LICENSE.txt'],['node_modules/electron/dist/LICENSE','ELECTRON-LICENSE.txt'],['node_modules/electron/dist/LICENSES.chromium.html','ELECTRON-CHROMIUM-NOTICES.html']]) fs.copyFileSync(path.join(root,source),path.join(output,target));
fs.copyFileSync(path.join(root,'THIRD_PARTY_NOTICES.md'),path.join(output,'README.md'));
console.log(`Prepared ${entries.length} dependency notice entries.`);
