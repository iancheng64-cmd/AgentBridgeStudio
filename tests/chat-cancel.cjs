const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { buildChatCommand } = require('../dist-main/chat-protocol.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-cancel-'));
const fake = path.join(root, 'codex');
fs.writeFileSync(fake, '#!/bin/bash\ncat > "$TEST_PROMPT"\nsleep 120 &\nprintf "%s" "$!" > "$TEST_CHILD"\nwait\n', {mode:0o755});
// Use an isolated non-login shell for deterministic PATH; the production wrapper remains intact.
let command=buildChatCommand({sessionId:'fixture',agent:'codex',prompt:'unused'},root).replace(/^bash -lc /, 'bash --noprofile --norc -c ');
// Force the portable launch branch even on Linux test hosts.
command=command.replace(/command -v setsid >\/dev\/null 2>&1/, 'false');
let group, childPid;
const input=path.join(root,'prompt.txt');
const childFile=path.join(root,'child.pid');
const proc=spawn('/bin/bash',['--noprofile','--norc','-c',command],{env:{...process.env,PATH:root+':/bin:/usr/bin',TEST_PROMPT:input,TEST_CHILD:childFile},stdio:['pipe','pipe','pipe']});
let output='',errors='';
proc.stdout.on('data',b=>{output+=b;for(const line of output.split('\n')){try{const event=JSON.parse(line);if(event.type==='bridge.process')group=event.pid;}catch{}}});
proc.stderr.on('data',b=>errors+=b);
proc.stdin.end('中文 prompt $(touch should-not-run)\n');
const closed=new Promise(resolve=>proc.on('close',(code,signal)=>resolve({code,signal})));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  // Concurrent test workers and login/profile processes can delay fixture startup.
  const startupDeadline=Date.now()+10000;
  while(Date.now()<startupDeadline&&(!group||!fs.existsSync(childFile)))await delay(20);
  assert(group, 'portable wrapper must report a process group');
  assert(fs.existsSync(childFile),'fake CLI must receive stdin and create its child: '+errors);
  childPid=Number(fs.readFileSync(childFile,'utf8'));
  assert.equal(fs.readFileSync(input,'utf8'),'中文 prompt $(touch should-not-run)\n');
  const pgid=Number(execFileSync('/bin/ps',['-o','pgid=','-p',String(childPid)],{encoding:'utf8'}).trim());
  assert.equal(pgid,group,'CLI descendants must share the isolated request group');
  execFileSync('/bin/bash',['-c',`kill -TERM -- -${group}`]);
  const end=await Promise.race([closed,delay(2000).then(()=>null)]);
  assert(end,'CLI and wrapper must exit when the request group is cancelled');
  for(let i=0;i<25;i++){try{process.kill(childPid,0);await delay(20);}catch{childPid=undefined;break;}}
  if(childPid){const state=execFileSync('/bin/ps',['-o','stat=','-p',String(childPid)],{encoding:'utf8'}).trim();assert(state.startsWith('Z'),'CLI descendant must not still execute');}
  console.log('PASS: no-setsid launch preserves stdin, isolates CLI descendants, and cancellation terminates the actual process group.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  try{if(group)process.kill(-group,'SIGKILL');}catch{}
  proc.kill('SIGKILL');
  fs.rmSync(root,{recursive:true,force:true});
});
