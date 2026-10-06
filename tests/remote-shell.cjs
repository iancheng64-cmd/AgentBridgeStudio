const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {resolveRemotePlatform,captureRemote,remoteLaunchError}=require('../dist-main/remote-shell');
const {profileRuntimePlatform,connectionPlatformIdentity}=require('../dist-main/host-platform');
function fixture(replies){const commands=[];return{commands,exec(command,options,callback){commands.push(command);const response=replies.shift();const channel=new EventEmitter();channel.stderr=new EventEmitter();channel.close=()=>channel.emit('close');channel.end=()=>queueMicrotask(()=>{for(const chunk of response?.chunks||[])channel.emit('data',chunk);if(response?.error)channel.stderr.emit('data',Buffer.from(response.error));channel.emit('close',response?.code??0);});callback(null,channel);}};}
test('auto detects POSIX and Windows using read-only probes, explicit platform executes no probe',async()=>{
 const posix=fixture([{chunks:[Buffer.from('Linux\n')]}]);assert.equal(await resolveRemotePlatform(posix,'auto'),'posix');assert.deepEqual(posix.commands,['uname -s']);
 const windows=fixture([{code:1,error:'unknown command'},{chunks:[Buffer.from('AGENTBRIDGE_WINDOWS\r\n')]}]);assert.equal(await resolveRemotePlatform(windows,'auto'),'windows');assert.match(windows.commands[1],/^powershell.exe .* -EncodedCommand /);
 const explicit=fixture([]);assert.equal(await resolveRemotePlatform(explicit,'windows'),'windows');assert.equal(await resolveRemotePlatform(explicit,'posix'),'posix');assert.equal(explicit.commands.length,0);
});
test('detection failure never guesses or launches a runtime; unrelated output is not accepted',async()=>{
 const unknown=fixture([{chunks:[Buffer.from('banner')]},{chunks:[Buffer.from('Linux')]}]);await assert.rejects(resolveRemotePlatform(unknown,'auto'),/無法自動辨識/);assert.equal(unknown.commands.length,2);
 assert.equal(profileRuntimePlatform({}),'auto');assert.equal(profileRuntimePlatform({runtimePlatform:'windows'}),'windows');assert.equal(profileRuntimePlatform({runtimePlatform:'posix'}),'posix');
});
test('SSH capture preserves fragmented Chinese UTF-8; shell mismatch and invalid encoding have actionable diagnostics',async()=>{
 const bytes=Buffer.from('繁體中文');const channel=fixture([{chunks:[bytes.subarray(0,1),bytes.subarray(1,5),bytes.subarray(5)]}]);assert.equal(await captureRemote(channel,'fixture'),'繁體中文');
 assert.match(remoteLaunchError('posix',"'bash' \uFFFD\uFFFD").message,/主機無法執行 bash/);assert.match(remoteLaunchError('windows','\uFFFD').message,/文字編碼/);assert.equal(remoteLaunchError('windows','codex executable missing').message,'codex executable missing');
});
test('automatic and explicit connections share the same existing chat and usage identity',()=>{
 for(const reported of ['windows','win32','Windows'])assert.equal(connectionPlatformIdentity('auto',reported),connectionPlatformIdentity('windows',reported));
 for(const reported of ['posix','darwin','linux','macOS'])assert.equal(connectionPlatformIdentity('auto',reported),connectionPlatformIdentity('posix',reported));
 assert.equal(connectionPlatformIdentity('posix','windows'),'posix');
 assert.throws(()=>connectionPlatformIdentity('auto','unknown'),/未回報/);
});
