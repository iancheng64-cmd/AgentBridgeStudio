const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
module.exports = async context => {
  const bundle = path.join(context.appOutDir, 'AgentBridge Studio.app');
  if (process.env.AGENTBRIDGE_SIGNED_RELEASE !== '1') {
    execFileSync('python3', [path.join(__dirname, 'sign-mac-app.py'), bundle], {stdio:'inherit'});
  } else {
    // A signed build must never be overwritten with an ad-hoc signature.
    const info = spawnSync('/usr/bin/codesign', ['-d', '--verbose=2', bundle], {encoding:'utf8'});
    if (info.status!==0 || !info.stderr.includes('Authority=Developer ID Application:')) throw new Error('Signed release lacks a Developer ID signature');
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {stdio:'inherit'});
  }
};
