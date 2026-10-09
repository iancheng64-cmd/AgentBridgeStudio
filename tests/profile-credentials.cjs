const {test}=require('node:test');const assert=require('node:assert/strict');const {publicProfile,saveCredentialProfile,savedCredentialFor}=require('../dist-main/profile-credentials');
const profile={id:'fixture',name:'friend',host:'fixture.invalid',port:22,username:'friend',authType:'password',savePassword:true};
test('remembered password is encrypted only in main, never returned to renderer, and survives saving empty password',()=>{
 const saved=saveCredentialProfile({...profile,password:'fixture-private'},undefined,value=>'encrypted:'+value,true);assert.equal(saved.encryptedPassword,'encrypted:fixture-private');assert.ok(!('password' in saved));const publicValue=publicProfile(saved);assert.equal(publicValue.hasSavedPassword,true);assert.ok(!('encryptedPassword' in publicValue));assert.ok(!JSON.stringify(publicValue).includes('fixture-private'));
 const resaved=saveCredentialProfile({...publicValue,password:''},saved,()=>{throw Error('must not encrypt empty')},true);assert.equal(resaved.encryptedPassword,saved.encryptedPassword);assert.equal(savedCredentialFor(publicValue,[saved]).encryptedPassword,saved.encryptedPassword);
});
test('changing host/user does not forward an old stored credential, forgetting removes it, encryption failure is explicit',()=>{
 const saved={...profile,encryptedPassword:'encrypted-fixture'};for(const change of [{host:'other.invalid'},{username:'other'},{port:2222},{authType:'key'}]){assert.equal(savedCredentialFor({...profile,...change},[saved]),undefined);assert.ok(!saveCredentialProfile({...profile,...change},saved,()=>'',true).encryptedPassword);}
 assert.ok(!saveCredentialProfile({...profile,savePassword:false},saved,()=>'',true).encryptedPassword);assert.throws(()=>saveCredentialProfile({...profile,password:'fixture'},saved,()=>'',false),/不可用/);assert.ok(!publicProfile({...saved,password:'ignored'}).password);
});
test('each device retains its own platform while switching platform preserves the encrypted credential',()=>{
 const saved={...profile,runtimePlatform:'posix',encryptedPassword:'encrypted-fixture'};
 const updated=saveCredentialProfile({...publicProfile(saved),runtimePlatform:'windows',password:''},saved,()=>{throw Error('must not re-encrypt')},true);
 assert.equal(updated.runtimePlatform,'windows');assert.equal(updated.encryptedPassword,saved.encryptedPassword);
 assert.equal(publicProfile(updated).runtimePlatform,'windows');assert.equal(savedCredentialFor(updated,[saved]),saved);
 assert.equal(saveCredentialProfile(profile,saved,()=>'',true).runtimePlatform,'posix');
 assert.equal(saveCredentialProfile(profile,undefined,()=>'',true).runtimePlatform,'auto');
 assert.equal(saveCredentialProfile({...profile,runtimePlatform:'unexpected'},saved,()=>'',true).runtimePlatform,'auto');
});

test('Claude login configuration directory is saved per device without changing stored credentials',()=>{const saved=saveCredentialProfile({...profile,claudeConfigDir:' C:\\Users\\friend\\.claude ',password:'fixture-private'},undefined,v=>'encrypted:'+v,true);assert.equal(publicProfile(saved).claudeConfigDir,'C:\\Users\\friend\\.claude');const other=saveCredentialProfile({...profile,id:'other',claudeConfigDir:''},undefined,()=>'',true);assert.equal(other.claudeConfigDir,undefined);});
