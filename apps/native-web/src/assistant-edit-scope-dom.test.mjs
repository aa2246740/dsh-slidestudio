import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {ensureRunLedger,recordPageRevision,currentPageRevision} from '../../../packages/presentation-run/dist/index.js';
import {loadProject} from '../../../packages/pptd-v2/dist/index.js';
import {launchPinnedChromium} from '../../../scripts/lib/pinned-playwright.mjs';
const ROOT=path.resolve(fileURLToPath(new URL('.',import.meta.url)),'../../..');

test('model scope survives to the actual lock and turn; edit feedback stays in one conversation',async()=>{
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'slides-edit-scope-'));
 const project=path.join(scratch,'project');fs.mkdirSync(path.join(project,'pages'),{recursive:true});
 const pagePaths=['pages/1_cover.page','pages/2_tips.page','pages/3_keep.page'];
 fs.writeFileSync(path.join(project,'deck.pptd'),JSON.stringify({version:'v2',title:'Multi-page scope QA',size:[960,540],theme:{},pages:pagePaths}));
 for(const [i,p] of pagePaths.entries())fs.writeFileSync(path.join(project,p),JSON.stringify({pageType:'content',background:{type:'solid',color:'#F7F4EC'},elements:[{elementId:'title',elementType:'text',bounds:[80,80,800,60],content:{text:`Test page ${i+1}`,fontSize:32,color:'#14355C'}}]}));
 ensureRunLedger(project,{manifestSha256:'a'.repeat(64),requirementsId:'b'.repeat(64),requirements:[]});
 const recordPages=()=>{for(const entry of loadProject(project).pages)recordPageRevision(project,{contextEpochId:'scope-test'},path.basename(entry.path,'.page'),entry.page);};
 recordPages();
 const originals=pagePaths.map(p=>fs.readFileSync(path.join(project,p),'utf8'));
 const port=await new Promise(resolve=>{const p=net.createServer();p.listen(0,'127.0.0.1',()=>{const n=p.address().port;p.close(()=>resolve(n));});});
 const base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['apps/native-web/src/server.mjs'],{cwd:ROOT,env:{...process.env,PORT:String(port),OPEN_SLIDESTUDIO_PROJECT:project,SLIDESTUDIO_RETENTION_DAYS:'0'},stdio:'ignore'});
 const out=process.env.SLIDESTUDIO_QA_OUTPUT_DIR || path.join(ROOT,'output/conversation-stability-acceptance-2026-09-20');fs.mkdirSync(out,{recursive:true});
 let browser, page;
 try{
  for(let i=0;i<80;i++){try{if((await fetch(`${base}/api/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await launchPinnedChromium({headless:true});
  page=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:900}});
  const errors=[],turns=[],locks=[];page.on('pageerror',e=>errors.push(e.message));
  let busy=false,finished=false,failTurn=false,invalidPlan=false,deckPlan=false,turnGate=null,stateOutageUntil=0,transientFailures=0,stops=0;
  const state=()=>({agentStatus:busy?'busy':'idle',phase:{kind:finished&&failTurn?'failed':'page-ready',error:{detail:'测试模型暂时不可用'}},inspection:{pages:pagePaths.map((p,i)=>({pageId:path.basename(p,'.page'),...currentPageRevision(project,path.basename(p,'.page'))}))}});
  const activity={ok:true,sessionId:'scope-test',brief:'测试两页修改',phase:'edited',agentStatus:'idle',provider:{providerId:'test',modelId:'cheap'},project:{path:project,title:'Multi-page scope QA',pageCount:3,pagePaths},stages:[],events:[{id:'old-reply',kind:'message',at:'2026-09-20T00:00:00Z',detail:'文稿已准备好。',status:'complete'}],conversation:{version:1,mode:'edit',messages:[]}};
  await page.route('**/api/generation-activity**',async route=>{const data=await (await route.fetch()).json();await route.fulfill({json:{...activity,...state(),assistantArtifacts:data.assistantArtifacts,phase:busy?'reviewing':finished&&failTurn?'failed':'edited'}});});
  await page.route('**/slides/providers',route=>route.fulfill({json:{providers:[{id:'test',name:'Test',ready:true,models:['cheap']}]}}));
  await page.route('**/slides/state/scope-test',route=>{if(Date.now()<stateOutageUntil){transientFailures++;return route.fulfill({status:502,json:{error:'temporary connection reset'}});}return route.fulfill({json:state()});});
  await page.route('**/slides/sessions/scope-test/events',route=>route.abort());
  await page.route('**/slides/assistant-intent',route=>route.fulfill({json:{ok:true,intent:'edit',scope:deckPlan?'deck':'pages',pages:deckPlan?[]:invalidPlan?[4]:[1,2]}}));
  await page.route('**/api/reviews/ai-lock?**',async route=>{const body=route.request().postDataJSON();if(body?.workspaceEdit)locks.push(body);const response=await route.fetch();await route.fulfill({response});});
  await page.route('**/slides/sessions/scope-test/stop',route=>{stops++;busy=false;return route.fulfill({json:{ok:true,stopped:true}});});
  await page.route('**/slides/sessions/scope-test/turn',async route=>{
   const body=route.request().postDataJSON();turns.push(body);if(turnGate)await turnGate;
   const userMessage={id:`u${turns.length}`,at:new Date().toISOString(),text:body.userText,mode:'edit',clientRequestId:body.clientRequestId};
   activity.conversation.messages.push(userMessage);fs.mkdirSync(path.join(project,'_agent'),{recursive:true});fs.writeFileSync(path.join(project,'_agent/assistant-conversation.v1.json'),JSON.stringify(activity.conversation));busy=true;finished=false;if(deckPlan)stateOutageUntil=Date.now()+3000;
   await route.fulfill({json:{ok:true,userMessage}});
  });
  await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&workspace=1`,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'第 3 页',exact:true}).click();
  const input=page.getByLabel('与 AI 协作',{exact:true});
  const request='1、2两页都把背景色改成白色';
  let accept;turnGate=new Promise(resolve=>{accept=resolve;});
  await input.fill(request);await input.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#editor-generation-event-list').textContent.includes('1、2两页'));
  for(let i=0;i<100&&turns.length===0;i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(turns.length,1);
  assert.deepEqual(locks[0].workspaceEdit.targetPages.map(p=>p.pageId),['1_cover','2_tips']);
  assert.equal(locks[0].workspaceEdit.kind,'pages');
  assert.deepEqual(turns[0].editorEdit.pages.map(p=>p.pageId),['1_cover','2_tips']);
  assert.equal(await input.inputValue(),'','send clears before Host acknowledgement');
  await input.fill('执行期间的新草稿');accept();turnGate=null;
  await page.waitForFunction(()=>document.querySelector('#editor-generation-event-list').textContent.includes('1、2两页'));
  assert.equal(await input.inputValue(),'执行期间的新草稿');
  pagePaths.forEach((p,i)=>{originals[i]=fs.readFileSync(path.join(project,p),'utf8');});
  // Simulated model writer, with real project files, lock, snapshot and verifier.
  for(const p of pagePaths.slice(0,2)){const content=YAML.parse(fs.readFileSync(path.join(project,p),'utf8'));content.background.color='#FFFFFF';fs.writeFileSync(path.join(project,p),JSON.stringify(content));}
  recordPages();
  activity.events.push({id:'reply-1',kind:'message',at:new Date(Date.now()+10).toISOString(),detail:'第 1、2 页背景已改成白色，其余内容保持不变。',status:'complete'});finished=true;busy=false;
  await page.waitForFunction(()=>!Object.keys(localStorage).some(key=>key.startsWith('slides.pending-edit:')));
  await page.getByRole('button',{name:'查看修改前',exact:true}).waitFor();
  assert.equal(await input.inputValue(),'执行期间的新草稿');
  assert.equal(await page.locator('#work-thread .agent-turn').count(),0);
  assert.equal(await page.locator('.refine-card').count(),0);
  assert.equal(await page.locator('.generation-turn-end').count(),0,'final response needs no second completion notice');
  assert.equal(await page.locator('.generation-message-card').filter({hasText:'第 1、2 页背景已改成白色'}).getByRole('button',{name:'查看修改前'}).count(),1);
  assert.equal(fs.readFileSync(path.join(project,pagePaths[2]),'utf8'),originals[2],'third page unchanged');
  const metrics=[];
  for(const width of [1440,877,390]){
   await page.setViewportSize({width,height:900});
   const m=await page.evaluate(()=>{const list=document.getElementById('editor-generation-event-list'),input=document.getElementById('work-brief'),r=input.getBoundingClientRect();return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,replyOverflow:list.scrollWidth-list.clientWidth,inputHit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id,workThread:getComputedStyle(document.getElementById('work-thread')).display,progressInChat:list.contains(document.getElementById('generation-think-status'))};});
   assert.ok(m.scrollWidth<=width+1,JSON.stringify(m));assert.ok(m.replyOverflow<=1);assert.equal(m.inputHit,'work-brief');assert.equal(m.workThread,'none');assert.equal(m.progressInChat,true);metrics.push(m);
   await page.screenshot({path:path.join(out,`unified-chat-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:'查看修改前',exact:true}).click();await page.locator('#history-bar').waitFor({state:'visible'});
  await page.getByRole('button',{name:'回到最新',exact:true}).click();
  const snapshotBefore=await page.getByRole('button',{name:'查看修改前',exact:true}).getAttribute('data-snapshot-id');
  await input.fill('');await page.reload({waitUntil:'domcontentloaded'});
  const restoredAction=page.locator('.generation-message-card').filter({hasText:'第 1、2 页背景已改成白色'}).getByRole('button',{name:'查看修改前'});
  await restoredAction.waitFor();assert.equal(await restoredAction.getAttribute('data-snapshot-id'),snapshotBefore,'refresh preserves the exact same before-version');
  await restoredAction.click();await page.locator('#history-bar').waitFor({state:'visible'});await page.getByRole('button',{name:'回到最新',exact:true}).click();
  // Explicit invalid model output fails closed; it cannot edit whichever page is open.
  invalidPlan=true;await input.fill('修改不存在的第4页');await input.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#editor-generation-event-list')?.textContent.includes('页码'));
  assert.equal(turns.length,1);assert.equal(locks.length,1);assert.equal(await input.inputValue(),'');
  invalidPlan=false;failTurn=true;finished=false;
  await input.fill('第1、2页背景改成蓝色');await input.press('Enter');
  for(let i=0;i<100&&turns.length<2;i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(turns.length,2);await input.fill('失败也要保留的新草稿');finished=true;busy=false;
  await page.locator('.assistant-reply-actions').filter({hasText:'测试模型暂时不可用'}).getByRole('button',{name:'重试',exact:true}).waitFor();
  assert.equal(await input.inputValue(),'失败也要保留的新草稿');
  assert.equal(await page.locator('.generation-turn-end').count(),0,'failed edit has one inline error, not a second status section');
  failTurn=false;
  await page.locator('.assistant-reply-actions').getByRole('button',{name:'重试',exact:true}).last().click();
  assert.equal(await input.inputValue(),'失败也要保留的新草稿','retry never overwrites another draft');
  assert.equal(await page.locator('#work-thread .agent-turn').count(),0);
  // The retry resends the failed request in place, keeping its clientRequestId.
  for(let i=0;i<100&&turns.length<3;i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(turns.length,3,'the retry resends the failed request');
  assert.deepEqual(turns.at(-1).editorEdit.pages.map(p=>p.pageId),['1_cover','2_tips']);
  assert.equal(turns.at(-1).clientRequestId,turns.at(-2).clientRequestId,'resend keeps the original request identity');
  for(const p of pagePaths.slice(0,2)){const content=YAML.parse(fs.readFileSync(path.join(project,p),'utf8'));content.background.color='#CCE0F5';fs.writeFileSync(path.join(project,p),JSON.stringify(content));}
  recordPages();
  activity.events.push({id:'reply-retry',kind:'message',at:new Date(Date.now()+15).toISOString(),detail:'第 1、2 页背景已改成浅蓝色。',status:'complete'});finished=true;busy=false;
  await page.waitForFunction(()=>!Object.keys(localStorage).some(key=>key.startsWith('slides.pending-edit:')));
  await page.waitForFunction(()=>document.querySelectorAll('.assistant-reply-actions [data-snapshot-id]').length>=2,undefined,{timeout:15000});
  // A clear whole-deck edit is authorized by sending it; no confirmation modal.
  finished=false;deckPlan=true;const stopsBeforeRecovery=stops;
  await input.fill('整份文稿用深蓝背景和亮色文字');await input.press('Enter');
  for(let i=0;i<100&&turns.length<4;i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(turns.length,4);assert.equal(await page.locator('dialog[open]').count(),0);
  assert.equal(await input.inputValue(),'');assert.equal(locks.at(-1).workspaceEdit.kind,'deck');
  assert.deepEqual(turns.at(-1).editorEdit.pages.map(p=>p.pageId),['1_cover','2_tips','3_keep']);
  for(const p of pagePaths){const content=YAML.parse(fs.readFileSync(path.join(project,p),'utf8'));content.background.color='#101827';content.elements[0].content.color='#F1F5F9';fs.writeFileSync(path.join(project,p),JSON.stringify(content));}
  recordPages();activity.events.push({id:'reply-deck',kind:'message',at:new Date(Date.now()+20).toISOString(),detail:'整份文稿已换成深蓝背景和亮色文字。',status:'complete'});finished=true;busy=false;
  await page.waitForFunction(()=>!Object.keys(localStorage).some(key=>key.startsWith('slides.pending-edit:')));
  await page.locator('.generation-message-card').filter({hasText:'整份文稿已换成深蓝背景和亮色文字。'}).getByRole('button',{name:'查看修改前'}).waitFor();
  assert.ok(transientFailures>0);assert.equal(stops,stopsBeforeRecovery,"a temporary state outage must not cancel the edit");
  // Refresh while a real lock/snapshot is active: reclaim that turn, never resend.
  deckPlan=false;finished=false;failTurn=false;
  await input.fill('第1、2页背景改成浅蓝色');await input.press('Enter');
  for(let i=0;i<100&&turns.length<5;i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(turns.length,5);
  await page.waitForFunction(()=>Object.keys(localStorage).some(key=>key.startsWith('slides.pending-edit:')));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'停止生成',exact:true}).waitFor();
  for(const p of pagePaths.slice(0,2)){const content=YAML.parse(fs.readFileSync(path.join(project,p),'utf8'));content.background.color='#DDEEFF';fs.writeFileSync(path.join(project,p),JSON.stringify(content));}
  recordPages();activity.events.push({id:'reply-refreshed',kind:'message',at:new Date().toISOString(),detail:'两页已改成浅蓝色，刷新后继续完成。',status:'complete'});finished=true;busy=false;
  await page.waitForFunction(()=>!Object.keys(localStorage).some(key=>key.startsWith('slides.pending-edit:')));
  assert.equal(turns.length,5,'refresh must not submit another Agent turn');
  assert.equal(fs.existsSync(path.join(project,'_agent/ai-review-lock.v1.json')),false,'recovered turn releases its guard');
  const manifest=JSON.parse(fs.readFileSync(path.join(project,'.versions/manifest.json')));
  assert.equal(manifest.at(-1).assistantOutcome,'applied','recovered turn verifies and records its actual outcome');
  const refreshedAction=page.locator('.generation-message-card').filter({hasText:'两页已改成浅蓝色'}).getByRole('button',{name:'查看修改前'});
  await refreshedAction.waitFor();const recoveredVersion=await refreshedAction.getAttribute('data-snapshot-id');
  await page.reload({waitUntil:'domcontentloaded'});await refreshedAction.waitFor();
  assert.equal(await refreshedAction.getAttribute('data-snapshot-id'),recoveredVersion);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'scope-dom-proof.json'),JSON.stringify({request,lockPages:locks[0].workspaceEdit.targetPages.map(p=>p.pageId),turnPages:turns[0].editorEdit.pages.map(p=>p.pageId),thirdPageUnchanged:true,metrics,checks:['exact model scope to real lock','current page 3 does not override explicit pages','one reply and inline recovery','acknowledgement owns draft','new draft preserved','version preview','invalid pages fail closed','error stays in chat','retry preserves new draft'],errors},null,2));
 }finally{await page?.unrouteAll({behavior:'wait'});await browser?.close();if(server.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await done;}fs.rmSync(scratch,{recursive:true,force:true});}
});
