const fs = require('node:fs');
const path = require('node:path');
module.exports = async context => {
  const resources = path.join(context.appOutDir, 'AgentBridge Studio.app/Contents/Resources');
  for (const relative of ['app.asar', 'computer-use/claudex-computer-use', 'computer-use/claudex-computer-use-cli', 'computer-use/claudex-computer-use-overlay-helper', 'codex/bin/codex', 'codex/bin/codex-code-mode-host', 'browser/browser-runtime.json', 'third-party-notices/README.md']) {
    if (!fs.existsSync(path.join(resources, relative))) throw new Error('Incomplete release payload: ' + relative);
  }
  const {browserExecutable} = require('../dist-main/browser-runtime');
  browserExecutable(path.join(resources, 'browser'));
};
