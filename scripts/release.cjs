#!/usr/bin/env node
const {build, Platform, Arch} = require('electron-builder');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
async function main() {
  const signed = process.env.AGENTBRIDGE_SIGNED_RELEASE === '1';
  if (signed && !(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD && process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)) {
    throw new Error('Signed release requires a Developer ID certificate and App Store Connect notarization API credentials. Do not commit these secrets.');
  }
  await build({targets:Platform.MAC.createTarget('dir', Arch.arm64), config:{
    mac:{identity:signed ? undefined : null, hardenedRuntime:signed, notarize:signed},
    forceCodeSigning:signed
  }});
  // Native macOS packaging avoids downloading an extra DMG-builder runtime.
  const root = path.resolve(__dirname,'..');
  const version = require('../package.json').version;
  const output = path.join(root,`dist/AgentBridge-Studio-${version}-arm64.dmg`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(),'agentbridge-dmg-'));
  try {
    execFileSync('/usr/bin/ditto',[path.join(root,'dist/mac-arm64/AgentBridge Studio.app'),path.join(staging,'AgentBridge Studio.app')]);
    fs.symlinkSync('/Applications',path.join(staging,'Applications'));
    fs.copyFileSync(path.join(root,'docs/INSTALLATION.md'),path.join(staging,'開始使用.md'));
    execFileSync('/usr/bin/hdiutil',['create','-ov','-volname','AgentBridge Studio','-fs','HFS+','-format','UDZO','-srcfolder',staging,output],{stdio:'inherit'});
    execFileSync('/usr/bin/hdiutil',['verify',output],{stdio:'inherit'});
    if(signed){
      const {spawnSync} = require('node:child_process');
      const details = spawnSync('/usr/bin/codesign',['-d','--verbose=2',path.join(root,'dist/mac-arm64/AgentBridge Studio.app')],{encoding:'utf8'});
      const identity = /^Authority=(Developer ID Application:.+)$/m.exec(details.stderr)?.[1];
      if(!identity)throw new Error('Cannot sign DMG without the App Developer ID identity');
      execFileSync('/usr/bin/codesign',['--force','--sign',identity,'--timestamp',output],{stdio:'inherit'});
      await require('@electron/notarize').notarize({appPath:output,appleApiKey:process.env.APPLE_API_KEY,
        appleApiKeyId:process.env.APPLE_API_KEY_ID,appleApiIssuer:process.env.APPLE_API_ISSUER});
      execFileSync('/usr/bin/xcrun',['stapler','staple',output],{stdio:'inherit'});
      execFileSync('/usr/bin/xcrun',['stapler','validate',output],{stdio:'inherit'});
    }
    console.log('Release DMG:',output);
  }finally{fs.rmSync(staging,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
main().catch(error => {console.error(error.message); process.exitCode=1;});
