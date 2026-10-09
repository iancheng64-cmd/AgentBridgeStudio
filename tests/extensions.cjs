const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { localExtensions, remoteExtensionScript } = require('../dist-main/extensions.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-extensions-'));
const oldHome = process.env.HOME, oldCodex = process.env.CODEX_HOME;
process.env.HOME = root;
process.env.CODEX_HOME = path.join(root, '.codex');
function write(file, text) { const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text); }
write('.codex/config.toml', '[mcp_servers.example]\nurl = "https://secret.invalid/private"\nbearer_token_env_var = "PRIVATE_TOKEN"\n');
write('.codex/skills/local-example/SKILL.md', 'skill');
write('.codex/plugins/cache/old-plugin/1.0/.codex-plugin/plugin.json', '{}');
write('.codex/plugins/cache/old-plugin/1.0/skills/cached-skill/SKILL.md', 'cached');
write('.claude/settings.json', JSON.stringify({enabledPlugins:{'enabled-plugin':true,'disabled-plugin':false},mcpServers:{bridge:{env:{SECRET_TOKEN:'do-not-return-me'}}}}));
(async()=>{
  const local = await localExtensions();
  const remote = JSON.parse(execFileSync('python3',['-c',remoteExtensionScript],{encoding:'utf8',env:{...process.env,HOME:root}}));
  for(const result of [local,remote]){
    const items=result.items;
    assert.equal(items.find(x=>x.name==='local-example').status,'installed');
    assert.equal(items.find(x=>x.name==='cached-skill').status,'discovered');
    assert.equal(items.find(x=>x.name==='1.0').status,'discovered');
    assert.equal(items.find(x=>x.name==='enabled-plugin').status,'configured');
    assert(!items.some(x=>x.name==='disabled-plugin'));
    assert.equal(items.find(x=>x.name==='example').status,'configured');
    assert(!JSON.stringify(result).includes('do-not-return-me'));
    assert(!JSON.stringify(result).includes('secret.invalid'));
    assert(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
  }
  console.log('PASS: local/remote metadata-only discovery, cache vs configured state, manifest fallback, and credential/URL exclusion.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
  if(oldCodex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
  fs.rmSync(root,{recursive:true,force:true});
});
