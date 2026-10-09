const {test}=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {appServerCommand}=require('../dist-main/app-server-rpc');
function shell(command){return command.replace(/^bash -lc /,'/bin/bash --noprofile --norc -c ');}
test('Codex default command resolves a desktop bundled CLI when no CLI is on the SSH PATH, and explicit missing paths never fall back',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentbridge-codex-path-'));const file=path.join(root,'Codex.app/Contents/Resources/codex');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'#!/bin/sh\nprintf "codex-cli 0.160.0 fixture\\n"\n',{mode:0o700});
 try{
  // Replace only directory references with the fixture root. No environment or real installation changes.
  const command=shell(appServerCommand('posix','codex',['--version'])).replace('export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";', 'export PATH="/usr/bin:/bin";').replaceAll('/Applications/Codex.app',path.join(root,'Codex.app'));
  assert.match(execFileSync('/bin/sh',['-c',command],{encoding:'utf8',stdio:['ignore','pipe','pipe']}),/codex-cli 0\.160\.0 fixture/);
  assert.throws(()=>execFileSync('/bin/sh',['-c',shell(appServerCommand('posix',path.join(root,'missing'),['--version']))],{stdio:'pipe'}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
