const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectionSelection}=require('../dist-main/connection-selection');
test('failed selection does not loop, but selecting the agent again permits retry',()=>{
  const selection=new ConnectionSelection();selection.select('claude-target');
  assert.equal(selection.canAutoConnect(),true);selection.begin();
  selection.select('claude-target');assert.equal(selection.canAutoConnect(),false);
  selection.select('codex-target');selection.select('claude-target');
  assert.equal(selection.canAutoConnect(),true);
});
test('in-flight result is invalid after switching away, including a switch back',()=>{
  const selection=new ConnectionSelection();selection.select('first');const old=selection.begin();
  selection.select('second');assert.equal(selection.isCurrent(old),false);
  selection.select('first');assert.equal(selection.isCurrent(old),false);
  const retry=selection.begin();assert.equal(selection.isCurrent(retry),true);
  selection.select('first-with-new-node-or-password');assert.equal(selection.isCurrent(retry),false);
  assert.equal(selection.canAutoConnect(),true);
});
