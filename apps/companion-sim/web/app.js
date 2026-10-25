// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {currentUserFeedback,renderUserFeedback,feedbackConversations,feedbackForRecord,renderFeedbackConversations} from './user-feedback.js';
import {mountModelSettings} from './model-settings-ui.js';
import './robot-inspector-page.js';
import {mountMomentComicsUI} from './moment-comics-ui.js';
import {projectInteractionFeedback,projectFaceFeedback} from './interaction-feedback.js';
import {createDeviceCamera,startRobotObservation} from './device-camera.js';
import {companionLaunchView,deviceConnectionView} from './companion-ui.js';
import {mountRigControls} from './rig-ui.js';
import {mountRobot} from './robot.js';
import {mountComicUI} from './comic-ui.js';
import {productRecords, productRecordWindow, currentCognition, recordDetails, recordOverview, reminderView, reminderRequest} from './companion-ui.js';
import {COGNITIVE_PATHS} from './cognitive-icons.js';
import {autonomyView, expressionsView} from './subject-ui.js';
import {mountRoundScreenInput} from './round-screen-input.js';
import {mountPresentationReporter} from './presentation-reporter.js';
import {mountViewGuidance} from './view-guidance.js';

const $ = id => document.getElementById(id);
const modelSettingsUI=mountModelSettings({request,onSaved:()=>request('/api/state').then(renderState).catch(showError)});
modelSettingsUI.load();
const text = (id, value) => { $(id).textContent = String(value ?? '—'); };
const phaseNames = {stopped: '已停止', observing: '观察中', reasoning: 'Pi 思考中', resting: '安静停留', paused: '已暂停', error: '运行错误'};
let snapshot = null;
let launchSequence=null,launchStep='',launchError='';
let lastFrame = null;
let masks = [];
let localSafetyLatch = false;
let controlSequence = 0;
let memorySignature = '';
let companionSignature = '';
let subjectSignature = '';
let profileDirty = false;
let profileVersion = '';
let productRecordIndex = [];
const expandedRecordLists=new Set();
let recordListDesk=null;
let integratedSwitch = null;
let cameraVideoState = 'stopped';
let videoEpoch = null;
const canvas = $('observation-preview');
const previewContext = canvas.getContext('2d', {willReadFrequently: true});
const robot = mountRobot({head: $('robot-head'), leftEye: $('eye-left'), rightEye: $('eye-right'), icon: $('face-icon'), stage: $('robot-stage')});
const roundScreen=mountRoundScreenInput({root:$('robot-face'),send:body=>request('/api/reminders/respond',{method:'POST',body}),onError:showError});
const presentationReporter=mountPresentationReporter({root:$('robot-face'),send:body=>request('/api/presentation/ack',{method:'POST',body})});
const viewGuidance=mountViewGuidance({root:$('robot-face')});

function showError(error) {
  const message = (error?.message || String(error)).replace(/webrtc/gi, '实时画面');
  text('error-banner', message);
  $('error-banner').hidden = false;
}

async function request(path, {method = 'GET', body, signal} = {}) {
  const response = await fetch(path, {method, signal, headers: body === undefined ? {} : {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || `请求失败 (${response.status})`);
  return result;
}

$('device-pair-form').addEventListener('submit',async event=>{
 event.preventDefault();const field=$('device-pair-code'),code=field.value.trim();field.value='';
 if(!/^\d{6}$/.test(code)){text('device-pair-result','请输入完整的 6 位数字配对码');return;}
 $('device-pair-submit').disabled=true;text('device-pair-result','正在连接机器人…');
 try{await request('/api/device/pair',{method:'POST',body:{code}});await request('/api/state').then(renderState);}
 catch(error){text('device-pair-result',({stop_before_pairing:'请先停止陪伴，再输入配对码',pairing_in_progress:'正在配对，请稍候',pairing_unavailable:'当前版本尚未启用配对接口'})[error.message]??'连接未成功，请确认配对码与同一网络后重试');$('device-pair-submit').disabled=false;}
});
let backendOnline=true,healthTimer=null,healthBusy=false;
function clearDisconnectedView(label){
 deviceCamera.discard();robot.settle();rigControls.cancel();lastFrame=null;
 previewContext.clearRect(0,0,canvas.width,canvas.height);previewContext.fillStyle='#e7ecdd';previewContext.fillRect(0,0,canvas.width,canvas.height);
 text('camera-status','连接中断');text('video-connection-status','实时视频不可用');$('video-connection-status').dataset.tone='warning';
 text('preview-label',label);text('freshness-value','无实时画面');text('coverage-value','未观察');
 roundScreen.update({enabled:false});presentationReporter.update({enabled:false});viewGuidance.update({enabled:false});
 renderUserFeedback($('user-feedback-panel'),{...snapshot,enabled:false,userFeedback:null});
 renderFeedbackConversations($('understanding-dialogue'),{...snapshot,enabled:false,userFeedback:null},{latestOnly:true});
 renderFeedbackConversations($('history-dialogue'),{...snapshot,enabled:false,userFeedback:null});
 $('camera-start').disabled=true;$('camera-stop').disabled=true;$('camera-share').disabled=true;$('camera-share').checked=false;
 $('start-button').disabled=true;$('resume-button').disabled=true;
}
async function pollDeviceHealth(){
 if(healthBusy)return;healthBusy=true;
 try{
  if(!snapshot?.device?.configured)return;
  const device=await request('/api/device/health',{signal:AbortSignal.timeout(1800)});
  const changed=!backendOnline||snapshot.device.connected!==device.connected||snapshot.device.health?.status!==device.health?.status;
  backendOnline=true;
  const label=deviceConnectionView(device).label;
  text('device-health-status',label);
  if(!device.connected)clearDisconnectedView(deviceConnectionView(device).label);
  if(changed)await request('/api/state').then(renderState);
 }catch{
  backendOnline=false;text('connection-status','控制台连接中断');text('device-health-status','本机服务未响应 · 暂时无法确认机器人状态');
  clearDisconnectedView('控制台连接中断 · 无法确认实时画面');$('device-pair-submit').disabled=true;$('device-pair-code').disabled=true;
 }finally{healthBusy=false;}
}
const isHardware=()=>snapshot?.device?.configured===true;
const deviceCamera=createDeviceCamera({canvas,request,getEpoch:()=>snapshot?.epoch,getMasks:()=>structuredClone(masks),onStatus:({state,error})=>{
  cameraVideoState=state==='active'?'stopped':state;text('camera-status',state==='active'?'机器人本地预览 · 无音频':state==='connecting'?'正在连接机器人视频':state==='error'?'机器人相机错误':'相机已停止');$('camera-start').disabled=state==='active'||state==='connecting';$('camera-stop').disabled=state==='stopped'||state==='error';if(error)showError(error);updateCameraSharing();
},onFrame:frame=>{lastFrame=frame;text('preview-label',deviceCamera.sharing?'机器人实时画面已分享':'机器人本地预览 · 未上传');text('coverage-value',frame.coverage==='partial'?'部分可见 · 有遮挡':'本地预览');}});
function updateCameraSharing() {
  $('camera-share').disabled = !(isHardware()&&deviceCamera.active) || !snapshot?.enabled || ['paused','stopped','error'].includes(snapshot?.phase);
}
function renderVideoState(video = {}) {
  if(isHardware()&&snapshot?.device?.connected&&!video.previewActive)text('preview-label','机器人摄像头未启用 · 开始陪伴后开启');
  if(isHardware()){const sharing=video.sharingActive,preview=video.previewActive;$('camera-start').disabled=preview;$('camera-stop').disabled=!preview;text('camera-status',sharing?'自主观察已开启 · 无音频':preview?'机器人本地预览 · 未分享':'相机已停止');text('video-connection-status',sharing?(video.status==='streaming'?'机器人视频已连接':'机器人视频连接中'):preview?'仅本地预览':'未启用视频');$('video-connection-status').dataset.tone=sharing&&video.status==='streaming'?'success':'';text('video-sent-value',`${Number(video.previewFrames)||0} 帧 · SDK接收`);}
  const decoded=Number(video.decodedFrames) || 0;
  const elapsed=video.startedAt ? Math.max(0,(Date.now()-video.startedAt)/1000) : 0;
  text('video-decode-value',`${decoded} 帧${decoded && elapsed ? ` · ${(decoded/elapsed).toFixed(1)} fps 均值` : ''}`);
  text('video-sample-value',`${Number(video.sampledObservations) || 0} 个候选短窗`);
  text('video-drops-value',`${Number(video.droppedFrames) || 0} 帧`);
  text('video-receiver-status', ({idle:'本机尚未接收视频',connecting:'本机接收连接中',streaming:'本机正在解码视频',stopped:'本机视频接收已停止',error:'本机视频接收异常'})[video.status] || '等待本机报告接收状态');
  if(video.transport && video.transport!=='webrtc')text('video-receiver-status','当前服务暂不支持实时画面分享，请检查连接后重试');
}

function stopLocalInput() {
  $('camera-share').checked = false;
  deviceCamera.stop();
}

function renderLaunch(state){
 const view=companionLaunchView(state,{starting:launchSequence!==null,step:launchStep,error:launchError});
 $('companion-launch').hidden=!view.visible;text('companion-launch-title','陪伴状态');text('companion-launch-status',view.detail);
 text('start-button',view.label);$('start-button').disabled=view.disabled||!backendOnline;$('start-button').dataset.action=view.action;
 $('launch-pause-button').hidden=true;
}
async function control(action) {
 const launching=['start','resume'].includes(action);
 if(launching&&launchSequence!==null)return;
 const sequence=++controlSequence;launchSequence=launching?sequence:null;launchStep=launching?'starting':'';launchError='';renderLaunch(snapshot??{});
 rigControls.cancel();
 if(['pause','quiet','stop'].includes(action)){
  localSafetyLatch=true;roundScreen.update({enabled:false});presentationReporter.update({enabled:false});viewGuidance.update({enabled:false});stopLocalInput();robot.settle();
 }
 try{
  const state=await request('/api/control',{method:'POST',body:{action}});
  if(sequence!==controlSequence)return;
  localSafetyLatch=false;$('error-banner').hidden=true;renderState(state);
  if(launching&&state.device?.configured){
   await startRobotObservation({camera:deviceCamera,isCurrent:()=>sequence===controlSequence&&snapshot?.enabled&&snapshot?.device?.connected&&backendOnline,onStep:step=>{launchStep=step;renderLaunch(snapshot);}});
   if(sequence===controlSequence)await request('/api/state').then(renderState);
  }
 }catch(error){if(sequence===controlSequence){launchError=launching?'启动未完成，请重试；也可以到初始化设置检查连接。':'';showError(error);}}
 finally{if(launchSequence===sequence){launchSequence=null;renderLaunch(snapshot??{});}}
}

document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => control(button.dataset.action)));
window.addEventListener('keydown', event => {if (event.key === 'Escape'&&!event.defaultPrevented) {event.preventDefault(); control('stop');}});
window.addEventListener('pagehide', () => {rigControls.cancel();if(isHardware()&&(deviceCamera.sharing||snapshot?.video?.sharingActive))deviceCamera.suspend();else stopLocalInput(); events.close(); robot.dispose(); comicUI.dispose();});
document.addEventListener('visibilitychange', () => {if (document.hidden) {rigControls.cancel();if(isHardware()&&(deviceCamera.sharing||snapshot?.video?.sharingActive))deviceCamera.suspend();else stopLocalInput();}else {if(isHardware()&&deviceCamera.sharing)deviceCamera.resume();request('/api/state').then(renderState).catch(showError);}});

async function startCamera() {
  try {
    $('error-banner').hidden = true;
    if(!isHardware()||!snapshot?.device?.connected)throw new Error('请先连接机器人，再打开机器人摄像头');
    await deviceCamera.start();
  } catch (error) {showError(error);}
}
$('camera-start').addEventListener('click', startCamera);
$('camera-stop').addEventListener('click', stopLocalInput);
$('camera-share').addEventListener('change', async () => {
  if (!$('camera-share').checked) {deviceCamera.stopSharing();return;}
  if (!isHardware()||!deviceCamera.active||!snapshot?.enabled||['paused','stopped','error'].includes(snapshot.phase)) {$('camera-share').checked=false;showError('请先开始陪伴并打开机器人预览，再明确分享视频');return;}
  videoEpoch=snapshot.epoch;
  try {await deviceCamera.share();}
  catch(error) {$('camera-share').checked=false;showError(error);}
});

let dragStart = null;
function point(event) {const rect = canvas.getBoundingClientRect(); return {x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))};}
function maskBetween(a, b) {return {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)};}
function applyMasks() {
  if(isHardware()&&deviceCamera.sharing){deviceCamera.stopSharing();$('camera-share').checked=false;}
  text('mask-count', `${masks.length} 个区域`);
  previewContext.fillStyle = '#000000'; for (const mask of masks) {const x = Math.floor(mask.x * canvas.width), y = Math.floor(mask.y * canvas.height); previewContext.fillRect(x, y, Math.ceil((mask.x + mask.width) * canvas.width) - x, Math.ceil((mask.y + mask.height) * canvas.height) - y);}
}
$('mask-enabled').addEventListener('change', () => $('preview-wrap').classList.toggle('masking', $('mask-enabled').checked));
canvas.addEventListener('pointerdown', event => {if (!$('mask-enabled').checked) return; dragStart = point(event); canvas.setPointerCapture(event.pointerId); event.preventDefault();});
canvas.addEventListener('pointermove', event => {if (!dragStart) return; const mask = maskBetween(dragStart, point(event)); const draft = $('mask-draft'); draft.hidden = false; Object.assign(draft.style, {left: `${mask.x * 100}%`, top: `${mask.y * 100}%`, width: `${mask.width * 100}%`, height: `${mask.height * 100}%`});});
canvas.addEventListener('pointerup', event => {if (!dragStart) return; const mask = maskBetween(dragStart, point(event)); dragStart = null; $('mask-draft').hidden = true; if (mask.width > 0.005 && mask.height > 0.005) {masks.push(mask); applyMasks();}});
canvas.addEventListener('pointercancel', () => {dragStart = null; $('mask-draft').hidden = true;});
$('clear-masks').addEventListener('click', () => {masks = []; applyMasks();});

function recordList(id, records, emptyMessage, format) {
  const container = $(id);
  container.replaceChildren();
  if (!records?.length) {const p = document.createElement('p'); p.className = 'empty'; p.textContent = emptyMessage; container.append(p); return;}
  records.forEach(record => {
    const item = document.createElement('div'); item.className = 'record';
    const summary = document.createElement('div'); summary.textContent = record.summary || record.question || record.reason || '无摘要'; item.append(summary);
    const detail = document.createElement('small'); detail.textContent = format(record); item.append(detail);
    container.append(item);
  });
}
const evidenceText = item => `依据：${item.evidenceIds?.length ? item.evidenceIds.join(' · ') : '无证据引用'}`;
function renderMemory(memory = {}) {
  const memories = memory.memories || [];
  recordList('memory-list', memories, '尚无记忆；不会把测试画面当作已理解的事实。', item => `${item.kind || '记录'} · ${item.status || 'active'} · 修订 ${item.revision ?? 1} · ${evidenceText(item)}`);
  const selected = $('memory-select').value;
  $('memory-select').replaceChildren(new Option('选择记录', ''), ...memories.map(item => new Option(`${item.kind || '记录'} · ${(item.summary || item.id).slice(0, 70)}`, item.id)));
  if (memories.some(item => item.id === selected)) $('memory-select').value = selected;
  recordList('attention-list', memory.attention, '没有待继续核验的关注。', item => `${item.status || 'active'}${item.nextAt ? ` · 下次 ${new Date(item.nextAt).toLocaleString()}` : ''}`);
  recordList('learning-list', memory.learning, '没有成长候选；缺少证据时保持原样。', item => `${item.status || 'candidate'} · ${item.scope || '未标明范围'} · ${evidenceText(item)}`);
  recordList('wake-list', memory.wakes, '没有已安排的复查。', item => `${item.status || 'scheduled'} · ${new Date(item.at).toLocaleString()}`);
  const children = $('wake-list').querySelectorAll('.record');
  (memory.wakes || []).forEach((item, index) => {
    if (item.status && !['scheduled', 'claimed'].includes(item.status)) return;
    const actions = document.createElement('div'); actions.className = 'record-actions';
    [['ack', '知道了'], ['snooze', '稍后'], ['dismiss', '不用了']].forEach(([kind, label]) => {
      const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', async () => {try {renderState(await request('/api/input', {method: 'POST', body: {kind, targetId: item.id}}));} catch (error) {showError(error);}}); actions.append(button);
    });
    children[index]?.append(actions);
  });
}
$('memory-select').addEventListener('change', () => {const memory = snapshot?.memory?.memories?.find(item => item.id === $('memory-select').value); if (memory) $('memory-summary').value = memory.summary || '';});
$('memory-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await request('/api/memory/revise', {method: 'POST', body: {id: $('memory-select').value, summary: $('memory-summary').value, reason: $('memory-reason').value}});
    text('memory-result', '更正已保存');
    await refreshMemory(); await refreshDiary();
  } catch (error) {showError(error);}
});
async function refreshMemory() {try {const memory = await request('/api/memory'); if (snapshot) snapshot.memory = memory; renderMemory(memory);} catch (error) {showError(error);}}
$('refresh-memory').addEventListener('click', refreshMemory);
$('diary-day').value = ''; // The host's configured workday selects the initial date.
const comicUI = mountComicUI({document,request,showError});
async function refreshDiary() {
  if($('daily-comic')?.hidden)return;
  try {await comicUI.refresh();} catch (error) {showError(error);}
}

function productList(id, records, emptyMessage) {
  const container = $(id);
  container.replaceChildren();
  const toggle=$(id+'-toggle');
  const window=toggle?productRecordWindow(records,{expanded:expandedRecordLists.has(id)}):null;
  const visible = window?.items??productRecords(records);
  if(toggle){
    toggle.hidden=window.total<=5;
    toggle.setAttribute('aria-expanded',String(expandedRecordLists.has(id)));
    toggle.textContent=expandedRecordLists.has(id)?'收起至最近 5 条':`展开当前全部 ${window.total} 条`;
    text(id+'-count',window.total?`显示最近 ${visible.length} 条 · 当前已载入 ${window.total} 条`:'暂无记录');
  }
  if (!visible.length) {if (emptyMessage) {const p = document.createElement('p'); p.className = 'empty'; p.textContent = emptyMessage; container.append(p);} return;}
  const conversations=feedbackConversations(snapshot??{});
  visible.forEach(record => {
    const article = document.createElement('article'); article.className = 'record product-record'; article.dataset.recordId = record.id || '';
    const summary = document.createElement('p'); summary.textContent = record.summary || record.question || '没有可展示的描述';if(window)summary.className='record-compact-summary';
    const detail = document.createElement('small'); detail.textContent = window?[new Date(record.observedAt??record.at).toLocaleString('zh-CN',{hour12:false}),record.kind==='hypothesis'||record.status==='tentative'?'待核实':({active:'有来源的记录',retracted:'已撤回',invalidated:'依据已变化',superseded:'已有新修订'})[record.status]??'待确认',`修订 ${record.revision??1}`].join(' · '):recordOverview(record);
    article.append(summary, detail);
    const reply=feedbackForRecord(snapshot??{},record,conversations)[0];
    if(reply){
      const response=document.createElement('aside');response.className='record-feedback-response';
      const label=document.createElement('small');label.textContent='桌面伙伴 · 想对你说';
      const quote=document.createElement('blockquote');quote.textContent=reply.message;
      response.append(label,quote);article.prepend(response);
    }
    if (record.evidenceIds?.length) {const evidence = document.createElement('details'); evidence.className = 'record-evidence'; const heading = document.createElement('summary'); heading.textContent = '查看观察依据'; const refs = document.createElement('p'); refs.textContent = record.evidenceIds.join(' · ');if(window||record.episodeType==='composed'){const coverage=document.createElement('p');coverage.textContent=recordDetails(record);evidence.append(heading,coverage,refs);}else evidence.append(heading,refs);article.append(evidence);}
    container.append(article);
  });
}

for(const id of ['perception-list','episode-list','belief-list'])$(id+'-toggle').addEventListener('click',()=>{
  if(expandedRecordLists.has(id))expandedRecordLists.delete(id);else expandedRecordLists.add(id);
  renderCompanion(snapshot?.companion);
});

function renderCognitiveUnderstandings(items){
  const container=$('cognition-understanding-list');container.replaceChildren();
  $('cognition-understanding-section').hidden=!items.length;
  const kinds={environment:'环境认识',activity:'近期活动',hypothesis:'待核实的推测'};
  const evidenceKinds={perception:'观察片段',episode:'整理的经历',understanding:'已有认识',hypothesis:'已有推测',belief:'已有认识'};
  for(const item of items){
    const article=document.createElement('article');article.className='record product-record cognitive-understanding';
    const heading=document.createElement('div');heading.className='cognitive-understanding-heading';
    if(COGNITIVE_PATHS[item.icon]){const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 30 30');icon.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',COGNITIVE_PATHS[item.icon]);icon.append(path);heading.append(icon);}
    const type=document.createElement('small');type.textContent=`当前认知图标 · ${kinds[item.kind]??'暂定认识'} · 待核实`;heading.append(type);
    const meaning=document.createElement('p');meaning.textContent=item.meaning;
    const detail=document.createElement('small');detail.textContent=`状态：当前有效${Number.isFinite(item.expiresAt)?` · 有效至 ${new Date(item.expiresAt).toLocaleString('zh-CN',{hour12:false})}`:' · 环境认识持续保留，新的证据可以改变它'}`;
    const evidence=document.createElement('details');evidence.className='record-evidence';const summary=document.createElement('summary');summary.textContent='查看认识依据';evidence.append(summary);
    for(const ref of item.evidenceRefs){const line=document.createElement('p');line.textContent=`${evidenceKinds[ref.kind]??'有来源的记录'} · ${ref.id} · 修订 ${ref.revision}`;evidence.append(line);}
    article.append(heading,meaning,detail,evidence);container.append(article);
  }
}


function renderReminders(reminders = []) {
  const container = $('reminder-list'); container.replaceChildren();
  if (!reminders.length) {const p = document.createElement('p');p.className = 'empty';p.textContent = snapshot?.experienceProfile==='competition'?'还没有持续关心。Pi 可根据连续片段主动建立，也可以由你开启。':'关心提醒默认关闭；由你选择开启。';container.append(p);return;}
  reminders.forEach(reminder => {
    const view = reminderView(reminder);
    const card = document.createElement('article');card.className = 'reminder-item';card.dataset.reminderId = reminder.id;card.dataset.status = reminder.status;
    const heading = document.createElement('div');heading.className = 'reminder-heading';
    const symbol = document.createElement('span');symbol.className = 'reminder-symbol';symbol.setAttribute('aria-hidden','true');
    const symbolSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');symbolSvg.setAttribute('viewBox','0 0 48 48');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',({water:'M24 6C21 12 12 22 12 29a12 12 0 0 0 24 0C36 22 27 12 24 6ZM18 30a6 6 0 0 0 6 6',movement:'M28 6a4 4 0 1 0 0 8a4 4 0 0 0 0-8ZM20 42l5-14 8 7 3 7M13 26l8-9 8 3 7 6M25 18l-3 11-10 9',posture:'M25 5a4 4 0 1 0 0 8a4 4 0 0 0 0-8ZM25 17v13h12v12M13 17v18h15M10 42v-7h18'})[reminder.kind] || 'M12 24h24');symbolSvg.append(path);symbol.append(symbolSvg);
    const title = document.createElement('strong');title.textContent = view.title;
    const status = document.createElement('span');status.className = 'reminder-status';status.textContent = view.status;heading.append(symbol,title,status);
    const source = document.createElement('p');source.className = 'reminder-origin';source.textContent = view.source;
    const detail = document.createElement('p');detail.className = 'reminder-detail';detail.textContent = `${view.delivery}${view.next && view.actions.length ? ` · 下次核对 ${view.next}` : ''}${view.expires ? ` · 有效至 ${view.expires}` : ''}`;
    card.append(heading,source,detail);
    if(reminder.inferenceReason){const reason=document.createElement('p');reason.className='reminder-detail';reason.textContent=`为什么惦记这件事：${reminder.inferenceReason}`;card.append(reason);}
    if (view.reason) {const reason=document.createElement('p');reason.className='reminder-detail';reason.textContent=`本轮说明：${view.reason}`;card.append(reason);}
    if(view.nextCycle){const next=document.createElement('p');next.className='reminder-detail';next.textContent=`下一轮约定时间：${view.nextCycle} · 仍需重新核对当下，不补催旧事`;card.append(next);}
    if (reminder.source !== 'demo' && reminder.status!=='disabled' && snapshot?.mode !== 'cloud') {const note=document.createElement('p');note.className='reminder-availability';note.textContent='当前未配置真实视觉模型：约定已保存，暂不能自主判断并展示；不会用离线演示冒充。';card.append(note);}
    const actions = document.createElement('div');actions.className = 'record-actions';
    const labels = {seen:'我看到了',snooze:'稍后提醒',done:'我已完成',dismiss:'这轮不用了',disable:'关闭此关心'};
    view.actions.forEach(action => {
      const button=document.createElement('button');button.type='button';button.textContent=labels[action];button.dataset.reminderAction=action;if(action==='disable')button.className='danger';
      button.addEventListener('click',async()=>{
        const buttons=[...actions.querySelectorAll('button')];buttons.forEach(item=>item.disabled=true);
        text('reminder-result','正在保存你的选择…');
        try {await request('/api/reminders/respond',{method:'POST',body:{id:reminder.id,action,roundId:reminder.roundId}});await refreshCompanion();text('reminder-result',({seen:'已记录你看到了，未记为完成。',snooze:'已选择稍后；本轮已用次数保留。',done:'已按你的明确选择结束本轮。',dismiss:'这轮已结束，未记为完成；后续仍按原约定。',disable:'此关心已关闭，之后不再开启新一轮。'})[action]);}
        catch(error){showError(error);buttons.forEach(item=>item.disabled=false);text('reminder-result','选择未保存，请重试。');}
      });actions.append(button);
    });
    if(reminder.source!=='demo'&&reminder.status!=='disabled'){
      const pause=document.createElement('button');pause.type='button';pause.textContent=reminder.pausedUntil>Date.now()?'今天已暂停':'暂停今天';pause.disabled=reminder.pausedUntil>Date.now();
      pause.addEventListener('click',async()=>{pause.disabled=true;try{await request('/api/reminders/pause-today',{method:'POST',body:{id:reminder.id}});await refreshCompanion();}catch(error){pause.disabled=false;showError(error);}});actions.append(pause);
    }
    card.append(actions);container.append(card);
  });
}

function renderCompanion(companion = {}) {
  const status=companion.perceptionStatus;
  const realMode=snapshot?.mode === 'cloud';
  text('perception-status', !realMode ? '尚未配置真实视觉理解' : status?.hasPerception ? '已形成有来源的观察片段' : '视觉模型已配置 · 等待有依据的观察');
  text('perception-explanation', !realMode ? '当前离线 fixture 只验证软件链路，不理解画面。摄像头不会自动开启，本轮不会新增个人感知记录。' : status?.description || '只有有依据的片段才进入记录；相机与回放会分别标注。');
  const deskId=companion.profile?.deskId;
  if(recordListDesk!==deskId){expandedRecordLists.clear();$('episode-archive').open=false;recordListDesk=deskId;}
  const scoped=records=>(records || []).filter(record=>!deskId || !record.deskId || record.deskId===deskId);
  productList('perception-list',scoped(companion.perceptions),realMode ? '还没有有依据的观察片段。' : '尚无真实感知记录。离线测试画面不会写成你的经历。');
  productList('episode-list',scoped(companion.episodes),'还没有整理成经历的片段。');
  const cognition=currentCognition(snapshot?.cognition,{deskId,at:snapshot?.at??Date.now()}),beliefs=productRecords(scoped(companion.beliefs));
  renderCognitiveUnderstandings(cognition);
  const noBeliefs=cognition.length?'模型尚未另存独立认识；上方显示的是当前认知图标对应的认识。':productRecords(scoped(companion.perceptions)).length?'已有实际观察片段，但模型尚未写入有依据的认识。片段本身不等于稳定认识。':realMode?'还没有可用于形成认识的实际观察片段。':'当前离线链路不会新增个人认识；等待有依据的真实观察。';
  productList('belief-list',beliefs,noBeliefs);
  productList('interest-list',scoped(companion.interests),'暂时没有需要继续了解的事。');
  productList('adaptation-list',scoped(companion.learning),'还没有经过核验的调整；稳定人设保持原样。');
  renderReminders(scoped(companion.reminders));
  productRecordIndex=productRecords(scoped([...(companion.perceptions || []),...(companion.episodes || []),...(companion.beliefs || []),...(companion.interests || [])]));
  const selected=$('continuity-select').value;
  $('continuity-select').replaceChildren(new Option('选择记录',''),...productRecordIndex.map(record=>new Option((record.summary || record.question || record.id).slice(0,80),record.id)));
  if(productRecordIndex.some(record=>record.id===selected))$('continuity-select').value=selected;
  const profile=companion.profile;
  if(profile){
    text('profile-version',`已保存 · 第 ${profile.version ?? 1} 版`);
    const version=`${profile.deskId}:${profile.version}`;
    if(!profileDirty && profileVersion!==version){$('profile-desk').value=profile.deskId || 'desk-default';$('profile-quiet').checked=profile.quietMode ?? true;$('profile-curiosity').value=profile.curiosity || 'gentle';$('profile-expression-learning').checked=profile.expressionLearning === true;profileVersion=version;}
  }
}
async function refreshCompanion(){const state=await request('/api/state');renderState(state);return state;}
$('refresh-continuity').addEventListener('click',()=>refreshCompanion().then(refreshDiary).catch(showError));
$('continuity-select').addEventListener('change',()=>{const record=productRecordIndex.find(item=>item.id===$('continuity-select').value);$('continuity-summary').value=record?.summary || record?.question || '';});
$('continuity-revision').addEventListener('change',()=>{const retract=$('continuity-revision').value==='retract';$('continuity-summary').required=!retract;$('continuity-summary-label').hidden=retract;});
$('continuity-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;text('continuity-result','正在保存修订…');
  try{const retract=$('continuity-revision').value==='retract';await request('/api/continuity/revise',{method:'POST',body:{id:$('continuity-select').value,...(retract?{status:'retracted'}:{summary:$('continuity-summary').value}),reason:$('continuity-reason').value}});await refreshCompanion();await refreshDiary();text('continuity-result','修订已保存；依赖旧内容的认识将重新核验。');}
  catch(error){showError(error);text('continuity-result','修订未保存。');}finally{button.disabled=false;}
});
$('profile-form').addEventListener('input',()=>profileDirty=true);
$('profile-form').addEventListener('change',()=>profileDirty=true);
$('profile-desk').addEventListener('input',()=>{$('profile-expression-learning').checked=false;});
$('profile-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;text('profile-result','正在保存…');
  try{await request('/api/profile',{method:'POST',body:{deskId:$('profile-desk').value.trim(),quietMode:$('profile-quiet').checked,curiosity:$('profile-curiosity').value,expressionLearning:$('profile-expression-learning').checked}});profileDirty=false;profileVersion='';await refreshCompanion();text('profile-result','已保存，陪伴已暂停；选择「继续」后按新设置相处。');}
  catch(error){showError(error);text('profile-result','尚未保存，请重试。');}finally{button.disabled=false;}
});
function reminderMode(){
  const demo=document.querySelector('input[name="reminder-mode"]:checked').value==='demo';
  $('reminder-real-settings').hidden=demo;
  for(const input of $('reminder-real-settings').querySelectorAll('input,select'))input.disabled=demo;
  text('reminder-mode-note',demo?'明确加速演示：约 5 秒后到时，仍需开始陪伴并有新鲜画面；不生成个人感知或完成事实。':'间隔由你约定，不是健康建议。每轮按约定次数提示；喝水与活动按此间隔续轮，姿态提醒只处理当下。不会累计补催。');
  text('reminder-submit',demo?'创建一次加速演示':'开启这轮关心');
}
document.querySelectorAll('input[name="reminder-mode"]').forEach(input=>input.addEventListener('change',reminderMode));
$('reminder-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;text('reminder-result','正在保存约定…');
  try{const body=reminderRequest({kind:$('reminder-kind').value,mode:document.querySelector('input[name="reminder-mode"]:checked').value,intervalMinutes:$('reminder-interval').value,maxAttempts:$('reminder-attempts').value,minIntervalMinutes:$('reminder-min-interval').value});await request('/api/reminders',{method:'POST',body});await refreshCompanion();text('reminder-result',body.demo?'加速演示已创建；它不会进入个人感知事实。':'这轮关心已保存；到时先核对有效条件。');}
  catch(error){showError(error);text('reminder-result','约定未保存，请检查设置。');}finally{button.disabled=false;}
});

const rigControls = mountRigControls({request, onState: state => renderState(state), stopLocalInput, showError,canPreview:()=>!localSafetyLatch&&!document.hidden});

function renderSubject(autonomy, expressions) {
  const attention = autonomyView(autonomy);
  text('autonomy-status', attention.status);
  text('autonomy-detail', [attention.budget, attention.detail].filter(Boolean).join(' · '));
  const growth = expressionsView(expressions);
  text('expression-status', growth.status);
  const container = $('expression-resources');
  container.replaceChildren();
  for(const demand of growth.demands??[]){
    const row=document.createElement('div');row.className='record product-record';
    const meaning=document.createElement('p');meaning.textContent=demand.meaning;
    const detail=document.createElement('small');detail.textContent=demand.status;
    row.append(meaning,detail);container.append(row);
  }
  if (!growth.resources.length&&!growth.demands?.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '尚无当前来源的表达资源。'; container.append(empty);
  }
  for (const resource of growth.resources) {
    const row = document.createElement('div'); row.className = 'record product-record';
    const meaning = document.createElement('p'); meaning.textContent = resource.meaning;
    const detail = document.createElement('small'); detail.textContent = [resource.status, resource.evidence, resource.reason].filter(Boolean).join(' · ');
    row.append(meaning, detail); container.append(row);
  }
}

function renderFacePresentation(state){
  if(!state)return;
  const enabled=state.enabled&&!localSafetyLatch;
  const presentationState={epoch:state.epoch,enabled,body:state.body,reminder:(state.companion?.reminders??[]).find(r=>r.lastReceiptId===state.body.expressionCommandId)??null};
  roundScreen.update(presentationState);presentationReporter.update({...presentationState,enabled:enabled&&!isHardware()});
  viewGuidance.update({enabled,guidance:state.guidance,expressionActive:Boolean(state.body.expressionCommandId)});
}
const momentComicsUI=mountMomentComicsUI({root:$('daily-moments'),request,onError:showError});
function renderState(state) {
  if (snapshot && state.revision < snapshot.revision && state.at <= snapshot.at) return;
  const wasConnected=snapshot?.device?.connected;
  snapshot = state;backendOnline=true;
  const pairing=state.device?.connection,connected=state.device?.connected===true,pairingBusy=pairing?.status==='pairing';
  $('device-pairing').hidden=!state.device?.configured;
  $('device-pair-submit').disabled=connected||pairingBusy||state.enabled||state.device?.health?.status==='checking'||state.device?.health?.status==='online';
  $('device-pair-code').disabled=$('device-pair-submit').disabled;
  text('device-pair-result',connected?'机器人已连接':pairingBusy?'正在寻找并连接机器人…':state.enabled?'请先停止陪伴，再配置连接':state.device?.health?.status==='online'?deviceConnectionView(state.device).pairingDetail:pairing?.reason==='pairing_not_found'?'未找到机器人，请核对当前配对码与同一网络':pairing?.status==='error'?'连接失败，请确认配对码后重试':'未连接，请输入机器人当前配对码');
  renderUserFeedback($('user-feedback-panel'),state);
  renderFeedbackConversations($('understanding-dialogue'),state,{latestOnly:true});
  renderFeedbackConversations($('history-dialogue'),state);
  momentComicsUI.render(state.momentComics??{},state.enabled&&!localSafetyLatch);
  const feedback=state.feedback??projectInteractionFeedback(state);text('interaction-feedback-label',feedback.label);text('interaction-feedback-detail',feedback.detail);$('interaction-feedback-panel').dataset.state=feedback.code;$('interaction-feedback-panel').hidden=!['paused','resting'].includes(feedback.code);for(const [name,active] of Object.entries(feedback.stages))$('feedback-stage-'+name).dataset.active=String(active);
  // The primary product is always the integrated robot. Legacy adapters stay diagnostic-only.
  if(state.rig?.profile && !['integrated-sim','integrated-device'].includes(state.rig.profile)) {
    if(!integratedSwitch)integratedSwitch=request('/api/rig',{method:'POST',body:{profile:'integrated-sim'}}).then(refreshCompanion).catch(showError).finally(()=>integratedSwitch=null);
  } else rigControls.render(state);
  if(state.device?.configured){
    text('workspace-nav-label','陪伴');text('body-explanation','圆屏通过官方SDK显示眼神与图形；网页显示目标姿态。圆屏点击在此页属于管理输入，真机触控事件尚未接入。');text('camera-motion-explanation','机器人摄像头随头部实际转动；姿态为发送目标，没有编码器反馈。分享期间如设置画面遮挡，将锁定自主头部运动。');text('workspace-footer','L-ROBOT · 真机陪伴 · 真实理解与完整体验仍待验收');text('device-status',state.device.connected?`真机在线 · ${state.enabled?'眨眼待机 · '+(state.attention?.status==='tracking'?'正在看向你':state.video?.sharingActive?'留意画面中的人':'等待开启观察'):'已暂停'} · SDK ${state.device.sdkVersion??''}`:deviceConnectionView(state.device).label);
    text('device-explanation','当前运行同一Pi主体；头姿显示目标值，执行结果见设备回执。机器人分享视频会持续至明确暂停/停止。');
    text('manual-head-note','手动试转会暂停自主陪伴；真机保持目标姿态，指令到期停止运动，可随时按 Esc 停止。');text('camera-share-label','将遮挡后机器人视频分享给当前模型；持续至暂停或停止，关闭网页仍继续');text('workspace-kind','机器人 / L-ROBOT 真机陪伴');text('source-badge','机器人摄像头');
    if(state.video?.sharingActive){deviceCamera.adopt({previewId:state.video.previewId,streamId:state.video.streamId});$('camera-share').checked=true;videoEpoch=state.epoch;cameraVideoState=state.video.status==='streaming'?'streaming':'connecting';}else if(state.video?.previewActive){deviceCamera.adopt({previewId:state.video.previewId});$('camera-share').checked=false;cameraVideoState='stopped';}
    const consent=document.querySelector('label:has(#camera-share)');if(consent)consent.title='将遮挡后的机器人画面分享给当前模型，持续至暂停或停止；关闭网页不会停止真机陪伴。';
  }
  $('connection-status').dataset.tone = 'success'; text('connection-status', '本机已连接');
  text('phase-badge', phaseNames[state.phase] || state.phase);
  $('phase-badge').dataset.tone = state.phase === 'error' ? 'danger' : state.phase === 'paused' ? 'warning' : 'success';
  text('mode-badge','主动陪伴');
  text('mode-explanation', state.mode === 'fixture' ? '离线 fixture 只控制模型返回；观察 → Pi → 工具 → 模拟身体回执是真实软件链路。它不证明识别了画面。' : '云模式由服务显式配置。这里只显示实际模型与工具证据；不会凭虚拟头姿推断摄像机视野。');
  if (localSafetyLatch) robot.settle(); else robot.render(state.body, {phase: state.phase, feedback:projectFaceFeedback(feedback),cognition:state.cognition,userFeedback:currentUserFeedback(state),bookReady: false});
  text('yaw-value', `${Number(state.body.head.yaw).toFixed(1)}°`); text('pitch-value', `${Number(state.body.head.pitch).toFixed(1)}°`);
  text('basis-value', !state.enabled&&state.body.leaseEnds?.head>state.at?'手动试转':state.observation?.id || '等待观察');
  $('start-button').disabled = (state.device?.configured&&!connected)||state.enabled;
  $('pause-button').disabled = !state.enabled || state.phase === 'paused';
  $('pause-button').hidden = state.phase === 'paused'; $('resume-button').hidden = state.phase !== 'paused';
  $('quiet-button').disabled = !state.enabled || state.phase === 'paused';
  if (['stopped', 'paused', 'error'].includes(state.phase) || deviceCamera.sharing && videoEpoch !== null && videoEpoch !== state.epoch) stopLocalInput();
  updateCameraSharing();
  renderVideoState(state.video);
  if(state.device?.configured){
   $('start-button').disabled=state.enabled||!connected;$('resume-button').disabled=!connected;
   text('device-health-status',deviceConnectionView(state.device).label);
   if(!connected){clearDisconnectedView(deviceConnectionView(state.device).label);if(!pairingBusy&&deviceConnectionView(state.device).needsPairing)$('device-pairing').open=true;}
  }
  comicUI.renderAttention(state.attention);
  comicUI.renderSnapshot(state.comic);
  renderFacePresentation(state);
  renderLaunch(state);
  if(wasConnected===false&&connected&&['#companionship','#workspace'].includes(location.hash))$('companion-launch').scrollIntoView({behavior:'smooth',block:'nearest'});
  text('runtime-value', state.agent?.runtime || 'pi-agent-core');
  text('observation-value', state.observation ? `${state.observation.source} / ${state.observation.frameCount} 帧` : '等待图像');
  text('calls-value', `${state.agent?.requests ?? state.agent?.lastRun?.requests ?? 0} / ${state.agent?.toolCalls ?? state.agent?.lastRun?.toolCalls ?? 0}`);
  text('revision-value', `r${state.revision} · e${state.epoch}`);
  if (state.error) showError(state.error);
  const events = (state.events || []).slice(-35).reverse();
  const container = $('event-list'); container.replaceChildren();
  if (!events.length) {const p = document.createElement('p'); p.className = 'empty'; p.textContent = '还没有运行事件。开始陪伴后，发送一张观察画面。'; container.append(p);}
  events.forEach(event => {
    const row = document.createElement('div'); row.className = 'event-row';
    const at = document.createElement('time'); at.textContent = new Date(event.at).toLocaleTimeString();
    const type = document.createElement('strong'); type.textContent = event.type;
    const detail = document.createElement('span'); detail.textContent = (typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail)).replace(/webrtc/gi, '实时画面');
    row.append(at, type, detail); container.append(row);
  });
  const signature = JSON.stringify(state.memory);
  if (signature !== memorySignature) {memorySignature = signature; renderMemory(state.memory);}
  const productSignature=JSON.stringify([state.mode,state.companion,state.cognition?.items??state.cognition,state.userFeedbackHistory,state.userFeedback?.id,(state.events??[]).filter(event=>event.type==='user_feedback_requested')]);
  if(productSignature!==companionSignature){companionSignature=productSignature;renderCompanion(state.companion);}
  const nextSubjectSignature=JSON.stringify([state.autonomy,state.expressions]);
  if(nextSubjectSignature!==subjectSignature){subjectSignature=nextSubjectSignature;renderSubject(state.autonomy,state.expressions);}
}

const events = new EventSource('/api/events');
events.addEventListener('state', event => {try {renderState(JSON.parse(event.data));} catch (error) {showError(error);}});
events.onerror = () => {backendOnline=false;clearDisconnectedView('控制台连接中断 · 无法确认实时画面');text('device-health-status','控制台连接中断 · 暂时无法确认真机状态');rigControls.cancel();text('connection-status', '连接中断 · 重连中'); $('connection-status').dataset.tone = 'warning'; if(isHardware()&&(deviceCamera.sharing||snapshot?.video?.sharingActive))deviceCamera.suspend();else stopLocalInput(); robot.settle();roundScreen.update({enabled:false});presentationReporter.update({enabled:false});viewGuidance.update({enabled:false});};
window.addEventListener('pagehide',()=>{roundScreen.destroy();presentationReporter.destroy();viewGuidance.destroy();});
request('/api/state').then(renderState).then(refreshDiary).catch(showError);
healthTimer=setInterval(pollDeviceHealth,1000);window.addEventListener('pagehide',()=>clearInterval(healthTimer),{once:true});
previewContext.fillStyle = '#e7ecdd'; previewContext.fillRect(0, 0, canvas.width, canvas.height); text('preview-label','机器人摄像头未启用 · 先打开机器人预览');
setInterval(() => {if (lastFrame) text('freshness-value', `${Math.max(0, (Date.now() - lastFrame.at) / 1000).toFixed(1)} 秒前`);}, 500);

/* Product introduction view. */
(() => {
  const video = document.getElementById('intro-video');
  if (!video) return;
  const pages = ['introduction','setup','companionship','daily-moments','understanding','continuity'];
  const labels = ['介绍视频','初始化设置','陪伴','值得回忆','如何理解你','相处记录'];
  const tabs = [...document.querySelectorAll('.console-tab')];
  const syncConsolePage = () => {
    let page = location.hash.slice(1);
    if (page === 'workspace') page = 'companionship';
    if (page === 'robot') page = 'understanding';
    if (!pages.includes(page)) page = 'introduction';
    document.body.dataset.consolePage = page;
    document.querySelectorAll('[data-console-panel]').forEach(panel => {panel.hidden = panel.dataset.consolePanel !== page;});
    tabs.forEach(tab => {
      const active = tab.getAttribute('href') === '#' + page;
      tab.classList.toggle('selected', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    document.title = labels[pages.indexOf(page)] + ' · 桌面伙伴';
    if (page === 'introduction') {
      if (!video.getAttribute('src') && video.dataset.source.startsWith('data:video/mp4;base64,')) {
        const bytes = Uint8Array.from(atob(video.dataset.source.split(',')[1]), char => char.charCodeAt(0));
        video.src = URL.createObjectURL(new Blob([bytes], {type: 'video/mp4'}));
      } else if (!video.getAttribute('src') && video.dataset.source.startsWith('/')) {
        video.src = video.dataset.source;
      }
    } else video.pause();
    window.scrollTo(0, 0);
  };
  tabs.forEach((tab,index) => tab.addEventListener('keydown',event => {
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();location.hash = tabs[next].getAttribute('href');tabs[next].focus();
  }));
  document.getElementById('intro-play').addEventListener('click', () => {
    if (video.paused) { if (video.ended) video.currentTime = 0; video.play().catch(() => {}); }
    else video.pause();
  });
  window.addEventListener('hashchange', syncConsolePage);
  syncConsolePage();
})();
/* End product introduction. */
