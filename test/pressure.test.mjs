import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePressure, describePressure } from '../public/pressure.js';
const now=Date.parse('2026-10-28T16:00:00Z'), hour=3600000;
const account=(remaining,hours,extra={})=>({id:1,platform:'openai',status:'available',schedulable:true,quotaState:'known',updatedAt:new Date(now).toISOString(),windows:[{key:'five_hour',remainingPercent:remaining,resetAt:new Date(now+hours*hour).toISOString()},{key:'seven_day',remainingPercent:80,resetAt:new Date(now+48*hour).toISOString()}],...extra});
const snapshot=accounts=>({group:'chatgpt',updatedAt:new Date(now).toISOString(),quotaUpdatedAt:new Date(now).toISOString(),accounts});
const calc=accounts=>calculatePressure(snapshot(accounts),now);
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.001,`${actual} != ${expected}`);
test('approved abundant/normal/tight scenarios match the preview scores',()=>{
 near(calc([account(100,1)]).score,20/3);
 near(calc([account(40,2)]).score,0);
 near(calc([account(10,4)]).score,-70/9);
});
test('staggered resets aggregate remaining quota and time instead of averaging ratios',()=>near(calc([account(100,.1),account(0,4.9,{id:2})]).score,0));
test('account IDs are unique and disabled or error accounts cannot inflate capacity',()=>{
 const a=account(40,2);const r=calc([a,a,account(100,1,{id:2,status:'disabled'}),account(100,1,{id:3,status:'error'}),account(100,1,{id:4,schedulable:false})]);
 near(r.score,0);assert.equal(r.included,1);assert.equal(r.excluded,3);assert.equal(r.total,4);
});
test('weekly exhaustion counts as zero available five-hour quota',()=>{
 const a=account(100,1);a.windows[1].remainingPercent=0;
 near(calc([a]).score,-10);assert.equal(calc([a]).weeklyBlocked,1);
});
test('missing, stale and expired quota is excluded with explicit coverage',()=>{
 const missing=account(null,2),expired=account(100,0,{id:2}),stale=account(100,1,{id:3,quotaState:'stale'}),noWeek=account(100,1,{id:4});noWeek.windows.pop();
 const r=calc([missing,expired,stale,noWeek,account(40,2,{id:5})]);
 near(r.score,0);assert.equal(r.missing,4);assert.equal(r.included,1);assert.equal(r.eligible,5);
});
test('all missing or disabled accounts do not receive a score',()=>{
 assert.equal(calc([account(null,1)]).score,null);
 assert.equal(calc([account(100,1,{status:'disabled'})]).score,null);
 assert.equal(calc([]).score,null);
});
test('expired weekly window and impossible five-hour samples are excluded',()=>{
 const a=account(100,1);a.windows[1].resetAt=new Date(now).toISOString();
 for(const item of [a,account(100,6),account(101,1),account(-1,1)])assert.equal(calc([item]).score,null);
});
test('other groups and providers do not use the GPT five-hour baseline',()=>{
 assert.equal(calculatePressure({...snapshot([account(100,1)]),group:'gemini'},now).score,null);
 assert.equal(calc([account(100,1,{platform:'anthropic'})]).score,null);
});
test('old snapshots cannot announce current abundance',()=>assert.equal(calculatePressure({...snapshot([account(100,1)]),updatedAt:new Date(now-180001).toISOString()},now).score,null));
test('elapsed time changes the score locally and reset expiry never invents new quota',()=>{
 const s=snapshot([account(40,2)]);
 near(calculatePressure(s,now).score,0);
 // A freshly read snapshot with the same cached quota and one hour remaining.
 near(calculatePressure({...s,updatedAt:new Date(now+hour).toISOString(),accounts:s.accounts.map(a=>({...a,updatedAt:new Date(now+hour).toISOString()}))},now+hour).score,10/3);
 assert.equal(calculatePressure({...s,updatedAt:new Date(now+2*hour).toISOString()},now+2*hour).score,null);
});
test('zero is normal green and negative sufficiency moves through yellow to red',()=>{
 assert.equal(describePressure(6.7).level,'abundant');
 assert.equal(describePressure(0).level,'normal');
 assert.equal(describePressure(-5).level,'warning');
 assert.equal(describePressure(-7.8).level,'tight');
 assert.equal(describePressure(-9).level,'critical');
 assert.equal(describePressure(null).label,'加载中');
});

test('old quota samples never gain freshness from a new snapshot',()=>{
 const s=snapshot([account(100,1,{updatedAt:new Date(now-hour).toISOString()})]);
 assert.equal(calculatePressure(s,now).score,null);
});
test('missing sample timestamps use the successful quota read time, not snapshot creation',()=>{
 const s=snapshot([account(100,1,{updatedAt:null})]);
 near(calculatePressure(s,now).score,20/3);
 s.quotaUpdatedAt=new Date(now-hour).toISOString();
 assert.equal(calculatePressure(s,now).score,null);
});
test('whole-snapshot quota read failures load instead of showing an old score',()=>{
 const s={...snapshot([account(100,1)]),stale:true,quotaReadFailed:true};
 assert.equal(calculatePressure(s,now).score,null);
});
test('one loading account does not erase the score of freshly sampled accounts',()=>{
 const s={...snapshot([account(40,2),account(100,1,{id:2,quotaState:'stale'})]),stale:true};
 near(calculatePressure(s,now).score,0);
 assert.equal(calculatePressure(s,now).missing,1);
});

const agAccount=(geminiRemaining,geminiHours,claudeRemaining,claudeHours,extra={})=>({
 id:1,platform:'antigravity',status:'available',schedulable:true,quotaState:'known',updatedAt:new Date(now).toISOString(),
 windows:[
  {key:'antigravity_gemini_7d',group:'gemini',remainingPercent:geminiRemaining,resetAt:new Date(now+geminiHours*hour).toISOString()},
  {key:'antigravity_claude_gpt',group:'antigravity_claude_gpt',remainingPercent:claudeRemaining,resetAt:new Date(now+claudeHours*hour).toISOString()},
  // Generic FiveHour is a compatibility window that can come from Claude.
  {key:'antigravity_gemini_5h',remainingPercent:0,resetAt:new Date(now+5*hour).toISOString()},
 ],...extra,
});
const agSnapshot=accounts=>({...snapshot(accounts),group:'antigravity'});
const agCalc=(accounts,family)=>calculatePressure(agSnapshot(accounts),now,family);
test('Antigravity Gemini and Claude/GPT score independently from their own model quotas',()=>{
 const a=agAccount(100,1,10,4);
 near(agCalc([a],'antigravity_gemini').score,20/3);
 near(agCalc([a],'antigravity_claude_gpt').score,-70/9);
});
test('Antigravity Gemini never uses the generic FiveHour compatibility quota as its own data',()=>{
 const a=agAccount(40,2,0,4);
 near(agCalc([a],'antigravity_gemini').score,0);
 near(agCalc([a],'antigravity_claude_gpt').score,-10);
});
test('missing or expired Gemini quota leaves Claude/GPT score available',()=>{
 for(const a of [agAccount(null,2,40,2),agAccount(100,0,40,2,{quotaState:'stale',error:null})]) {
  assert.equal(agCalc([a],'antigravity_gemini').score,null);
  near(agCalc([a],'antigravity_claude_gpt').score,0);
 }
});
test('missing Claude/GPT does not block Gemini and no model family substitutes for another',()=>{
 const a=agAccount(40,2,100,2);a.windows=a.windows.filter(w=>w.key!=='antigravity_claude_gpt');
 near(agCalc([a],'antigravity_gemini').score,0);
 assert.equal(agCalc([a],'antigravity_claude_gpt').score,null);
 a.windows=a.windows.filter(w=>w.key!=='antigravity_gemini_7d');
 assert.equal(agCalc([a],'antigravity_gemini').score,null);
});
test('Antigravity staggered reset aggregation follows the same planned pace',()=>{
 const list=[agAccount(100,.1,40,2),agAccount(0,4.9,40,2,{id:2})];
 near(agCalc(list,'antigravity_gemini').score,0);
 near(agCalc(list,'antigravity_claude_gpt').score,0);
});
test('Antigravity disabled, failed-fetch and unsampled accounts cannot imply extra capacity',()=>{
 const list=[agAccount(40,2,40,2),agAccount(100,1,100,1,{id:2,status:'disabled'}),agAccount(100,1,100,1,{id:3,quotaState:'stale',error:'额度更新失败'}),agAccount(100,1,100,1,{id:4,updatedAt:new Date(now-hour).toISOString()})];
 for(const family of ['antigravity_gemini','antigravity_claude_gpt']) {
  const r=agCalc(list,family);near(r.score,0);assert.equal(r.excluded,1);assert.equal(r.missing,2);assert.equal(r.included,1);
 }
});
test('multi-day quota cooldown is scored against the explicit five-hour baseline',()=>{
 const a=agAccount(0,120,10,24);
 near(agCalc([a],'antigravity_gemini').score,-10);
 near(agCalc([a],'antigravity_claude_gpt').score,10*(10-480)/(10+480));
});
test('Antigravity configurations cannot calculate quotas from another group or provider',()=>{
 assert.equal(calculatePressure(snapshot([account(100,1)]),now,'antigravity_gemini').score,null);
 assert.equal(calculatePressure(agSnapshot([account(100,1)]),now,'antigravity_claude_gpt').score,null);
 assert.equal(calculatePressure(agSnapshot([agAccount(100,1,100,1)]),now,'unexpected').score,null);
});

test('signed sufficiency is bounded and increases with quota relative to time',()=>{
 const values=[0,10,40,80,100].map(remaining=>calc([account(remaining,2)]).score);
 assert.equal(values[0],-10);
 for(let i=1;i<values.length;i++){ assert.ok(values[i]>values[i-1]);assert.ok(values[i]<=10); }
 near(calc([account(100,.0001)]).score,9.999600008);
});
