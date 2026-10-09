const {test,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {prepareClaudeAuth,isolateOfficialSettings}=require('../dist-main/claude-auth-mode');
let root;after(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});});
test('official mode removes provider credentials/aliases while preserving native hooks and permissions',()=>{
 const values=[{env:{ANTHROPIC_AUTH_TOKEN:'fixture-secret',ANTHROPIC_DEFAULT_SONNET_MODEL:'custom',NATIVE_HELPER:'keep'},model:'custom',apiKeyHelper:'provider helper',enabledPlugins:{native:true},hooks:{PostToolUse:[]},permissions:{allow:['Read']}}];
 const result=isolateOfficialSettings(values,{ANTHROPIC_BASE_URL:'https://fixture.invalid',CLAUDE_CODE_OAUTH_TOKEN:'native-oauth-fixture',PATH:'/bin'});
 assert.deepEqual(result.settings.enabledPlugins,{native:true});assert.deepEqual(result.settings.hooks,{PostToolUse:[]});assert.equal(result.env.NATIVE_HELPER,'keep');assert.equal(result.env.PATH,'/bin');
 assert.equal(result.env.CLAUDE_CODE_OAUTH_TOKEN,'native-oauth-fixture');assert.ok(!JSON.stringify(result.settings).includes('native-oauth-fixture'));assert.ok(!JSON.stringify(result).includes('fixture-secret'));assert.ok(!result.settings.model);assert.ok(!result.settings.apiKeyHelper);assert.ok(!result.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
});
test('explicit API overrides cannot be overwritten by existing native settings, secrets remain in memory and original files unchanged',async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'ab-claude-auth-test-'));const home=path.join(root,'config'),cwd=path.join(root,'project');await fs.mkdir(home);await fs.mkdir(cwd);
 const original=JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:'old-fixture-secret',ANTHROPIC_BASE_URL:'https://old.invalid'},apiKeyHelper:'old-helper',model:'old-model',permissions:{deny:['Danger']}});await fs.writeFile(path.join(home,'settings.json'),original);
 await fs.mkdir(path.join(home,'skills','native'),{recursive:true});await fs.writeFile(path.join(home,'skills','native','SKILL.md'),'native fixture');
 const launch=await prepareClaudeAuth('api',cwd,{apiKey:'new-fixture-secret',baseUrl:'https://new.invalid',model:'new-model'},{CLAUDE_CONFIG_DIR:home});
 try{assert.equal(launch.env.ANTHROPIC_API_KEY,'new-fixture-secret');assert.equal(launch.env.ANTHROPIC_BASE_URL,'https://new.invalid');assert.equal(launch.env.ANTHROPIC_MODEL,'new-model');assert.ok(!launch.env.ANTHROPIC_AUTH_TOKEN);
 const settings=JSON.parse(await fs.readFile(launch.args[3],'utf8'));assert.ok(!JSON.stringify(settings).includes('fixture-secret'));assert.ok(!settings.model);assert.ok(!settings.apiKeyHelper);assert.deepEqual(settings.permissions,{deny:['Danger']});assert.equal((await fs.stat(launch.args[3])).mode&0o777,0o600);assert.ok(launch.args.includes('--plugin-dir'));assert.equal(await fs.readFile(path.join(home,'settings.json'),'utf8'),original);
 }finally{await launch.cleanup();}await assert.rejects(fs.stat(launch.args[3]),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(home,'skills/native/SKILL.md'),'utf8'),'native fixture');
 const inherited=await prepareClaudeAuth('api',cwd,undefined,{CLAUDE_CONFIG_DIR:home,ANTHROPIC_AUTH_TOKEN:'fixture'});assert.deepEqual(inherited.args,[]);assert.equal(inherited.env.ANTHROPIC_AUTH_TOKEN,'fixture');
 for(const baseUrl of ['http://remote.invalid','https://user:secret@fixture.invalid','https://fixture.invalid?secret=bad'])await assert.rejects(prepareClaudeAuth('api',cwd,{baseUrl},{CLAUDE_CONFIG_DIR:home}),/端點/);
});
test('official isolation preserves native subscription setup-token authentication in memory only',()=>{
 const result=isolateOfficialSettings([{env:{CLAUDE_CODE_OAUTH_TOKEN:'native-oauth-fixture',ANTHROPIC_API_KEY:'provider-secret'}}],{});
 assert.equal(result.env.CLAUDE_CODE_OAUTH_TOKEN,'native-oauth-fixture');
 assert.equal(result.env.ANTHROPIC_API_KEY,undefined);
 assert.ok(!JSON.stringify(result.settings).includes('native-oauth-fixture'));
});
