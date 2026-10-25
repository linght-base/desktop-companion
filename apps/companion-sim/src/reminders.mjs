// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {fields,identifier,number,OBSERVATION_MAX_AGE,validateIntent} from './contracts.mjs';

const LABELS={water:'喝水关心',movement:'活动一下',posture:'当下姿态轻提示'};
const ICONS={water:'water',movement:'movement',posture:'posture'};
const TERMINAL=new Set(['acknowledged','completed','dismissed','expired','exhausted','disabled']);
const boundedText=value=>typeof value==='string'?value.trim().slice(0,500):'';
const validTime=(value,name)=>number(value,0,8e15,name);
const deskIdentifier=value=>{if(typeof value!=='string'||!value.trim()||value.length>200||value.includes('\0'))throw new Error('invalid_desk_id');return value.trim();};
const evidenceIdentifier=value=>{if(typeof value!=='string'||!value.trim()||value.length>200||value.includes('\0'))throw new Error('invalid_evidence_id');return value.trim();};

function nextLocalMidnight(now,timeZone) {
 if(typeof timeZone!=='string'||!timeZone.trim()||timeZone.length>100)throw new Error('invalid_time_zone');
 let format;try{format=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{throw new Error('invalid_time_zone');}
 const day=at=>format.formatToParts(at).filter(p=>['year','month','day'].includes(p.type)).map(p=>`${p.type}:${p.value}`).join('|');
 const current=day(now);let lo=now+1,hi=now+3*86400000;
 // Search an actual timezone boundary, rather than assuming that a local day has 24 hours.
 while(lo<hi){const mid=Math.floor((lo+hi)/2);if(day(mid)===current)lo=mid+1;else hi=mid;}
 return lo;
}

/** Persistent accepted goals. A wake/run/display is never evidence the person completed a goal. */
export function createReminderManager({path,clock=Date.now}) {
 const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=DELETE;PRAGMA busy_timeout=1000;PRAGMA secure_delete=ON;
 CREATE TABLE IF NOT EXISTS companion_reminders(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS companion_reminder_events(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL);`);
 const get=id=>{const row=db.prepare('SELECT payload FROM companion_reminders WHERE id=?').get(id);return row?JSON.parse(row.payload):null;};
 const all=()=>db.prepare('SELECT payload FROM companion_reminders ORDER BY rowid DESC').all().map(row=>JSON.parse(row.payload));
 const put=goal=>{db.prepare('INSERT INTO companion_reminders(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(goal.id,JSON.stringify(goal));return structuredClone(goal);};
 const event=(goal,type,detail={})=>db.prepare('INSERT INTO companion_reminder_events(id,goal_id,at,payload) VALUES(?,?,?,?)').run(randomUUID(),goal.id,clock(),JSON.stringify({type,roundId:goal.roundId,...detail}));
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 const receipt=(status,reason,id)=>({id:randomUUID(),status,reason,at:clock(),...(id?{reminderId:id}:{})});
 function finish(goal,status,outcome,reason) {
  goal.status=status;goal.lastOutcome=outcome;goal.reason=reason;goal.nextReviewAt=null;
  goal.nextCycleAt=goal.recurring?goal.at+goal.intervalMs:null;
  return goal;
 }
 function sweep() {
  const now=clock();
  for(const g of all()) {
   if(g.pausedUntil>now)continue;
   if(g.pausedUntil!==undefined&&g.pausedUntil!==null){
    g.pausedUntil=null;g.pauseReason=null;g.pauseEndedAt=now;
    if(!TERMINAL.has(g.status)&&now>=g.expiresAt){
     // A pause does not move the agreed cycle or create missed-invitation debt.
     g.status='expired';g.lastOutcome='unconfirmed';g.reason='paused_window_expired';g.nextReviewAt=null;
     g.nextCycleAt=g.recurring?g.at+g.intervalMs:null;event(g,'expired');
    }
    put(g);
   }
   if(g.status==='disabled'||g.status==='dismissed'&&!g.recurring)continue;
   if(TERMINAL.has(g.status) && g.recurring && g.nextCycleAt!==null && now>=g.nextCycleAt) {
    let due=g.nextCycleAt;
    // Skip elapsed windows; restarting cannot accumulate a backlog of missed rounds.
    if(now>=due+g.windowMs){due+=Math.floor((now-due)/g.intervalMs)*g.intervalMs;if(now>=due+g.windowMs)due+=g.intervalMs;}
    Object.assign(g,{at:due,expiresAt:due+g.windowMs,nextReviewAt:due,roundId:randomUUID(),roundStartedAt:now,attemptCount:0,status:'scheduled',lastOutcome:null,outcomeSource:null,visualAssessment:null,reason:'next_legal_cycle',nextCycleAt:null,lastPresentedAt:null,presentationStatus:'not_requested',confirmedPresentationCount:0,confirmedReceiptIds:[],lastConfirmedAt:null,lastRequestedAt:null,lastRequestEpoch:null});put(g);
   } else if(!TERMINAL.has(g.status) && now>=g.expiresAt) {
    finish(g,'expired','unconfirmed','window_expired');event(g,'expired');put(g);
   }
  }
 }
 // A process claim is not delivery. Recover without resetting counts or time windows.
 for(const goal of all())if(goal.status==='reviewing'){goal.status='scheduled';goal.nextReviewAt=Math.max(goal.at,goal.lastPresentedAt===null?goal.at:goal.lastPresentedAt+goal.minIntervalMs);goal.reason='review_recovered';put(goal);}
 // Legacy goals predate presentation confirmation: host-accepted is not evidence the person saw anything.
 for(const goal of all())if(goal.presentationStatus===undefined){
  goal.presentationStatus=goal.lastReceiptId?'unverified_legacy':'not_requested';
  goal.confirmedPresentationCount=0;goal.confirmedReceiptIds=[];goal.lastConfirmedAt=null;goal.lastRequestEpoch=null;
  goal.lastRequestedAt=goal.lastPresentedAt??null;
  if(goal.lastOutcome==='displayed_not_completed')goal.lastOutcome='display_requested_not_confirmed';
  put(goal);
 }
 function fresh(context) {
  const o=context?.observation,age=clock()-o?.at;
  if(context?.enabled!==true || !Number.isSafeInteger(context.epoch) || context.epoch<0 || !o || !Number.isFinite(age) || age< -1000 || age>OBSERVATION_MAX_AGE)return false;
  try{return typeof context.isCurrent==='function' && context.isCurrent()===true;}catch{return false;}
 }
 function visualEvidence(input,context) {
  if(typeof context.resolveEvidence!=='function')throw new Error('evidence_resolver_unavailable');
  const visiting=new Set(),verified=new Set();let count=0;
  function visit(id,revision,depth=0) {
   if(depth>16||++count>64||visiting.has(id))throw new Error('invalid_evidence_chain');
   const key=JSON.stringify([id,revision]);if(verified.has(key))return;
   const record=context.resolveEvidence(id,{deskId:context.deskId});
   if(!record||record.id!==id||record.revision!==revision||record.status!=='active'||record.deskId!==context.deskId||record.source!==context.observation.source||!['camera','replay'].includes(record.source)||!['perception','episode'].includes(record.kind))throw new Error('invalid_visual_evidence');
   visiting.add(id);
   if(record.kind==='perception'){
    if(record.basisObservationId!==input.basisObservationId||record.observedAt!==context.observation.at||!['visible','partial'].includes(record.coverage))throw new Error('evidence_observation_mismatch');
    if(input.outcome==='completed'&&(context.observation.coverage==='unknown'||(record.coverage!=='visible'||context.observation.coverage!=='visible')&&input.visibility!=='clear'))throw new Error('visual_coverage_insufficient');
    if(!Array.isArray(record.evidenceIds)||record.evidenceIds.length!==1||record.evidenceIds[0]!==input.basisObservationId)throw new Error('invalid_perception_provenance');
   }else{
    if(!Array.isArray(record.evidenceIds)||!record.evidenceIds.length||record.evidenceIds.length>32||!record.evidenceRevisions)throw new Error('invalid_evidence_chain');
    for(const parent of record.evidenceIds){evidenceIdentifier(parent);const expected=record.evidenceRevisions[parent];if(!Number.isSafeInteger(expected)||expected<1)throw new Error('invalid_evidence_revision');visit(parent,expected,depth+1);}
   }
   visiting.delete(id);verified.add(key);
  }
  for(const ref of input.evidenceRefs)visit(ref.id,ref.revision);
 }
 return {
  createInferred(input,context) {
   try {
    fields(input,['kind','intervalMs','maxAttempts','minIntervalMs','windowMs','reason','evidenceRefs'],'inferred_reminder');
    if(!['water','movement'].includes(input.kind))throw new Error('persistent_kind_not_supported');
    if(context?.enabled!==true||context?.mode!=='cloud'||context?.autonomousReminders!==true||context?.isCurrent?.()!==true)throw new Error('autonomous_reminder_not_authorized');
    const deskId=deskIdentifier(context.deskId);
    if(!boundedText(input.reason))throw new Error('reminder_reason_required');
    if(!Array.isArray(input.evidenceRefs)||!input.evidenceRefs.length||input.evidenceRefs.length>12)throw new Error('reminder_evidence_required');
    const seen=new Set(),times=[];
    for(const ref of input.evidenceRefs){
     fields(ref,['id','revision'],'reminder_evidence');evidenceIdentifier(ref.id);
     const r=context.resolveEvidence?.(ref.id,{deskId});
     if(!r||r.deskId!==deskId||r.status!=='active'||r.revision!==ref.revision||!['perception','episode'].includes(r.kind)||!['camera','replay'].includes(r.source)||seen.has(ref.id))throw new Error('invalid_reminder_evidence');
     seen.add(ref.id);times.push(r.observedAt??r.startAt??r.at);
    }
    // Multiple samples establish a continued context, never continuous activity duration.
    if(times.length<2||!times.every(Number.isFinite)||Math.max(...times)-Math.min(...times)<10000)throw new Error('need_continued_context');
    if(clock()-Math.max(...times)>120000||Math.max(...times)>clock()+1000)throw new Error('reminder_context_too_old');
    const previous=all().find(g=>g.deskId===deskId&&g.kind===input.kind&&g.source!=='demo'&&(g.recurring||g.status==='disabled'));
    if(previous)return previous.status==='disabled'?receipt('rejected','user_disabled_goal',previous.id):{...receipt('accepted','existing_goal_preserved',previous.id),goal:previous,duplicate:true};
    const goal=this.create({kind:input.kind,intervalMs:input.intervalMs??(input.kind==='water'?2700000:3600000),maxAttempts:input.maxAttempts??3,minIntervalMs:input.minIntervalMs??180000,windowMs:input.windowMs??900000,deskId});
    goal.source='agent_inferred';goal.acceptedBy='user_authorized_autonomy';goal.reason=boundedText(input.reason);goal.inferenceReason=goal.reason;goal.semanticStatus='model_inferred';goal.evidenceRefs=structuredClone(input.evidenceRefs);
    return transaction(()=>{event(goal,'autonomous_goal_started',{evidenceRefs:goal.evidenceRefs});put(goal);return {...receipt('accepted','autonomous_goal_started',goal.id),goal};});
   }catch(error){return receipt('rejected',error.message);}
  },
  create(input) {
   fields(input,['kind','intervalMs','maxAttempts','minIntervalMs','windowMs','demo','deskId'],'reminder');
   if(!Object.hasOwn(LABELS,input.kind))throw new Error('invalid_reminder_kind');
   if(input.demo!==undefined && typeof input.demo!=='boolean')throw new Error('invalid_reminder_demo');
   const demo=input.demo===true;
   const intervalMs=input.intervalMs??(demo?5000:input.kind==='movement'?3600000:2700000);
   number(intervalMs,demo?500:60000,7*86400000,'reminder_interval');
   const maxAttempts=input.maxAttempts??1;number(maxAttempts,1,5,'reminder_attempts');if(!Number.isInteger(maxAttempts))throw new Error('invalid_reminder_attempts');
   const minIntervalMs=input.minIntervalMs??(demo?5000:60000);number(minIntervalMs,demo?500:60000,86400000,'reminder_min_interval');
   const windowMs=input.windowMs??(input.kind==='posture'?5000:demo?30000:Math.min(intervalMs,900000));number(windowMs,500,86400000,'reminder_window');
   const deskId=deskIdentifier(input.deskId??'desk-default');
   const now=clock();validTime(now,'clock');
   const active=all().find(g=>g.kind===input.kind&&g.deskId===deskId&&g.source===(demo?'demo':'user')&&(g.recurring&&g.status!=='disabled'||!TERMINAL.has(g.status)));
   if(active)return {...active,duplicate:true};
   const goal={id:randomUUID(),kind:input.kind,label:LABELS[input.kind],source:demo?'demo':'user',acceptedBy:'explicit_user_choice',deskId,status:'scheduled',createdAt:now,roundStartedAt:now,intervalMs,minIntervalMs,windowMs,maxAttempts,attemptCount:0,at:now+intervalMs,nextReviewAt:now+intervalMs,expiresAt:now+intervalMs+windowMs,roundId:randomUUID(),recurring:!demo&&input.kind!=='posture',nextCycleAt:null,lastPresentedAt:null,lastOutcome:null,reason:demo?'explicit_demo':'user_enabled',presentationStatus:'not_requested',confirmedPresentationCount:0,confirmedReceiptIds:[],lastConfirmedAt:null,lastRequestedAt:null,lastRequestEpoch:null};
   return transaction(()=>{event(goal,'created');return put(goal);});
  },
  snapshot(){sweep();return all();},
  claimDue({enabled,observation,deskId,mode='cloud'}={}) {
   sweep();const age=clock()-observation?.at;
   if(enabled!==true||!observation||!Number.isFinite(age)||age< -1000||age>OBSERVATION_MAX_AGE)return [];
   if(mode!=='cloud')for(const g of all())if(g.source!=='demo'&&!TERMINAL.has(g.status)){g.reason='vision_unavailable';put(g);}
   return transaction(()=>all().filter(g=>(g.source==='demo'||mode==='cloud')&&(!deskId||g.deskId===deskId)&&!(g.pausedUntil>clock())&&!TERMINAL.has(g.status)&&g.status!=='reviewing'&&g.nextReviewAt!==null&&clock()>=g.nextReviewAt&&clock()>=g.at&&clock()<g.expiresAt&&g.attemptCount<g.maxAttempts).slice(0,3).map(g=>{g.status='reviewing';g.reason='due_for_review';event(g,'claimed');return put(g);}));
  },
  release(id,{reason='review_released'}={}) {
   identifier(id);sweep();const g=get(id);if(!g||TERMINAL.has(g.status))return false;
   g.status=g.attemptCount?'waiting':'scheduled';g.reason=boundedText(reason);g.nextReviewAt=Math.min(g.expiresAt,Math.max(clock()+(g.source==='demo'?1000:15000),(g.lastPresentedAt??0)+g.minIntervalMs));put(g);return true;
  },
  decide(input,context) {
   try{fields(input,['id','decision','basisObservationId','reason','expression'],'reminder_decision');identifier(input.id);identifier(input.basisObservationId);if(!['show','defer','expire'].includes(input.decision))throw new Error('invalid_reminder_decision');if(input.expression!==undefined){validateIntent(input.expression);if(input.expression.basisObservationId!==input.basisObservationId)throw new Error('expression_basis_mismatch');}}catch(error){return receipt('rejected',error.message);}
   sweep();const g=get(input.id),reject=reason=>receipt('rejected',reason,input.id);
   if(!g)return reject('unknown_reminder');
   if(g.pausedUntil>clock())return reject('reminder_paused_today');
   if(TERMINAL.has(g.status))return reject('reminder_round_ended');
   if(!fresh(context))return reject('reminder_context_stale_or_disabled');
   if(input.basisObservationId!==context.observation.id)return reject('observation_mismatch');
   if(context.deskId && context.deskId!==g.deskId)return reject('reminder_scope_mismatch');
   if(clock()<g.at || clock()>=g.expiresAt)return reject('reminder_not_due');
   if(g.source!=='demo'&&(context.mode!=='cloud'||!['camera','replay'].includes(context.observation.source)))return reject('vision_unavailable');
   if(input.decision==='expire'){finish(g,'expired','unconfirmed',boundedText(input.reason)||'condition_no_longer_valid');event(g,'expired');put(g);return receipt('accepted','reminder_expired',g.id);}
   if(input.decision==='defer'){g.status='waiting';g.nextReviewAt=Math.min(g.expiresAt,Math.max(clock()+(g.source==='demo'?1000:15000),(g.lastPresentedAt??0)+g.minIntervalMs));g.reason=boundedText(input.reason)||'waiting_for_quiet_moment';put(g);return receipt('accepted','reminder_deferred',g.id);}
   if(g.nextReviewAt!==null&&clock()<g.nextReviewAt)return reject('reminder_too_soon');
   if(g.lastPresentedAt!==null&&clock()-g.lastPresentedAt<g.minIntervalMs)return reject('reminder_too_soon');
   if(g.attemptCount>=g.maxAttempts)return reject('reminder_attempt_limit');
   if(typeof context.express!=='function')return reject('body_unavailable');
   const chosen=input.expression??{basisObservationId:input.basisObservationId,durationMs:3000,icon:ICONS[g.kind],eyes:{openness:.8},gesture:'waiting'};
   let output;try{output=context.express({...chosen,durationMs:Math.min(chosen.durationMs,g.expiresAt-clock())});}catch{return reject('body_request_failed');}
   if(!output||output.status!=='accepted')return reject('body_rejected');
   // This adapter is synchronous: no stale authority is held across an awaited model/device call.
   return transaction(()=>{
    const presentedAt=clock();
    // A body accepting the request is only a request; it is never recorded as actually presented.
    g.attemptCount++;g.lastPresentedAt=presentedAt;g.lastRequestedAt=presentedAt;g.lastRequestEpoch=context.epoch;g.presentationStatus='requested';
    g.lastOutcome='display_requested_not_confirmed';g.reason='waiting_for_presentation';g.lastReceiptId=output.id;
    if(g.attemptCount>=g.maxAttempts)finish(g,'exhausted','display_requested_not_confirmed','attempt_limit_reached');
    else{g.status='waiting';g.nextReviewAt=Math.min(g.expiresAt,presentedAt+g.minIntervalMs);}
    event(g,'presentation_requested',{receiptId:output.id,attempt:g.attemptCount,epoch:context.epoch});put(g);return {...receipt('accepted','reminder_display_requested',g.id),bodyReceipt:output};
   });
  },
  confirmPresentation(input,context) {
   try{fields(input,['id','roundId','receiptId'],'presentation_confirmation');identifier(input.id);identifier(input.roundId);identifier(input.receiptId);}catch(error){return receipt('rejected',error.message);}
   sweep();const g=get(input.id),reject=reason=>receipt('rejected',reason,input.id);
   if(!g)return reject('unknown_reminder');
   if(g.pausedUntil>clock())return reject('reminder_paused_today');
   if(input.roundId!==g.roundId)return reject('reminder_round_changed');
   if(!g.lastReceiptId||input.receiptId!==g.lastReceiptId)return reject('presentation_receipt_mismatch');
   if(context?.enabled!==true||!Number.isSafeInteger(context.epoch)||context.epoch<0)return reject('reminder_context_stale_or_disabled');
   if(context.deskId!==g.deskId)return reject('reminder_scope_mismatch');
   let current;try{current=typeof context.isCurrent==='function'&&context.isCurrent()===true;}catch{current=false;}
   if(!current)return reject('reminder_context_stale_or_disabled');
   if(context.epoch!==g.lastRequestEpoch)return reject('presentation_epoch_mismatch');
   if(clock()<g.lastRequestedAt)return reject('presentation_clock_rollback');
   if(g.presentationStatus!=='requested'){
    // Re-confirming the latest request is idempotent only while the round still allows it; it never rewrites a user outcome.
    if(g.presentationStatus==='confirmed'&&(g.confirmedReceiptIds??[]).includes(input.receiptId)&&['waiting','exhausted'].includes(g.status))return {...receipt('accepted','presentation_already_confirmed',g.id),duplicate:true,goal:structuredClone(g)};
    return reject(g.presentationStatus==='confirmed'?'reminder_round_ended':'presentation_not_requested');
   }
   if(!['waiting','exhausted'].includes(g.status))return reject('reminder_round_ended');
   // Re-verify goal and host authority just before mutating; a confirmation is not a user response.
   try{if(context.isCurrent()!==true)return reject('reminder_context_stale_or_disabled');}catch{return reject('reminder_context_stale_or_disabled');}
   sweep();if(JSON.stringify(get(g.id))!==JSON.stringify(g))return reject('reminder_round_changed');
   return transaction(()=>{
    const confirmedAt=clock();
    g.confirmedPresentationCount++;g.lastConfirmedAt=confirmedAt;g.presentationStatus='confirmed';
    g.confirmedReceiptIds=[...(g.confirmedReceiptIds??[]),input.receiptId].slice(-5);
    // Confirmed presentation is still neither seen nor completed.
    g.lastOutcome='displayed_not_completed';g.reason='presentation_confirmed';
    if(g.status==='waiting'&&g.nextReviewAt!==null)g.nextReviewAt=Math.min(g.expiresAt,Math.max(g.nextReviewAt,confirmedAt+g.minIntervalMs));
    event(g,'presentation_confirmed',{receiptId:input.receiptId,confirmedAt});put(g);
    return {...receipt('accepted','presentation_confirmed',g.id),goal:structuredClone(g)};
   });
  },
  pauseToday(input) {
   fields(input,['id','timeZone'],'reminder_pause');identifier(input.id);const timeZone=input.timeZone??'Asia/Shanghai';
   const until=nextLocalMidnight(clock(),timeZone);sweep();const g=get(input.id);if(!g)throw new Error('unknown_reminder');
   if(g.pausedUntil>clock()||g.status==='disabled')return g;
   Object.assign(g,{pausedUntil:until,pauseReason:'user_paused_today',pauseTimeZone:timeZone,pausedAt:clock()});
   return transaction(()=>{event(g,'user_pause_today',{pausedUntil:until,timeZone});return put(g);});
  },
  assessVisualCompletion(input,context) {
   try{
    fields(input,['id','basisObservationId','evidenceRefs','outcome','reason','visibility'],'visual_completion');identifier(input.id);identifier(input.basisObservationId);
    if(!['completed','uncertain'].includes(input.outcome))throw new Error('invalid_visual_outcome');
    if(input.visibility!==undefined&&!['clear','uncertain'].includes(input.visibility))throw new Error('invalid_completion_visibility');
    if(input.outcome==='completed'&&input.visibility==='uncertain')throw new Error('visual_coverage_insufficient');
    if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500||input.reason.includes('\0'))throw new Error('invalid_visual_reason');
    if(!Array.isArray(input.evidenceRefs)||!input.evidenceRefs.length||input.evidenceRefs.length>16)throw new Error('invalid_evidence_refs');
    const ids=new Set();for(const ref of input.evidenceRefs){fields(ref,['id','revision'],'evidence_ref');evidenceIdentifier(ref.id);if(ids.has(ref.id)||!Number.isSafeInteger(ref.revision)||ref.revision<1)throw new Error('invalid_evidence_revision');ids.add(ref.id);}
   }catch(error){return receipt('rejected',error.message);}
   sweep();const g=get(input.id),reject=reason=>receipt('rejected',reason,input.id);
   if(!g)return reject('unknown_reminder');
   if(g.pausedUntil>clock())return reject('reminder_paused_today');
   if(!fresh(context))return reject('reminder_context_stale_or_disabled');
   if(context.subjectConfirmed!==true)return reject('reminder_subject_unconfirmed');
   if(context.mode!=='cloud'||!['camera','replay'].includes(context.observation.source))return reject('vision_unavailable');
   if(context.deskId!==g.deskId)return reject('reminder_scope_mismatch');
   if(context.observation.id!==input.basisObservationId)return reject('observation_mismatch');
   if(context.observation.at<(g.roundStartedAt??g.createdAt)||clock()>=g.expiresAt)return reject('reminder_round_ended');
   try{visualEvidence(input,context);}catch(error){return reject(error.message);}
   // The host resolver is synchronous but can still revoke authority; never overwrite an intervening action.
   if(!fresh(context))return reject('reminder_context_stale_or_disabled');
   sweep();if(JSON.stringify(get(g.id))!==JSON.stringify(g))return reject('reminder_round_changed');
   const refs=input.evidenceRefs.map(ref=>({id:ref.id,revision:ref.revision})).sort((a,b)=>a.id.localeCompare(b.id));
   const key=JSON.stringify([g.roundId,input.basisObservationId,refs,input.outcome]);
   if(g.visualAssessment?.key===key&&(g.status==='completed'&&g.outcomeSource==='visual_assessment'||g.status==='exhausted'||!TERMINAL.has(g.status)))return {...receipt('accepted','visual_assessment_unchanged',g.id),duplicate:true,goal:structuredClone(g)};
   // Exhaustion stops invitations, not the ability to observe completion before this window ends.
   if(TERMINAL.has(g.status)&&g.status!=='exhausted')return reject('reminder_round_ended');
   g.visualAssessment={key,outcome:input.outcome,basisObservationId:input.basisObservationId,evidenceRefs:refs,observedAt:context.observation.at,observationSource:context.observation.source,assessedAt:clock(),reason:input.reason.trim(),roundId:g.roundId,source:'visual_assessment',semanticStatus:'model_assessed',completionVisibility:input.visibility??'clear'};
   g.outcomeSource='visual_assessment';
   if(input.outcome==='completed')finish(g,'completed','visually_assessed_completed','visual_completion_assessed');
   else{g.lastOutcome='unknown';g.reason='visual_completion_uncertain';}
   return transaction(()=>{event(g,'visual_assessment',{outcome:input.outcome,basisObservationId:input.basisObservationId,evidenceRefs:refs,observedAt:context.observation.at});put(g);return {...receipt('accepted',input.outcome==='completed'?'visual_completion_assessed':'visual_completion_uncertain',g.id),goal:structuredClone(g)};});
  },
  reconcileEvidence({resolveEvidence}={}) {
   if(typeof resolveEvidence!=='function')throw new Error('invalid_evidence_resolver');
   return transaction(()=>{
    const invalidated=[];
    for(const g of all()){
     if(g.source==='agent_inferred'&&g.evidenceRefs?.some(ref=>{const r=resolveEvidence(ref.id,{deskId:g.deskId});return !r||r.status!=='active'||r.revision!==ref.revision;})){
      g.recurring=false;finish(g,'disabled','unknown','goal_evidence_invalidated');put(g);invalidated.push(g.id);
     }
     const assessment=g.visualAssessment;if(!assessment)continue;
     const current=(assessment.evidenceRefs??[]).every(ref=>{let record;try{record=resolveEvidence(ref.id,{deskId:g.deskId});}catch{return false;}return record?.id===ref.id&&record.status==='active'&&record.revision===ref.revision&&record.deskId===g.deskId;});
     if(current)continue;
     g.visualAssessment=null;
     if(g.outcomeSource==='visual_assessment'){g.outcomeSource=null;g.lastOutcome='unknown';g.reason='completion_evidence_invalidated';if(g.status==='completed')g.status='expired';}
     put(g);invalidated.push(g.id);
    }
    return {invalidated};
   });
  },
  forgetEvidence(id) {
   evidenceIdentifier(id);
   return transaction(()=>{
    const affected=[];
    for(const g of all()){
     if(g.source==='agent_inferred'&&g.evidenceRefs?.some(ref=>ref.id===id)){
      g.evidenceRefs=[];g.inferenceReason=null;g.reason='goal_evidence_forgotten';g.recurring=false;finish(g,'disabled','unknown','goal_evidence_forgotten');put(g);affected.push(g.id);
     }
     if(!g.visualAssessment?.evidenceRefs?.some(ref=>ref.id===id))continue;
     g.visualAssessment=null;
     if(g.outcomeSource==='visual_assessment'){g.outcomeSource=null;g.lastOutcome='unknown';g.reason='completion_evidence_forgotten';if(g.status==='completed')g.status='expired';}
     put(g);affected.push(g.id);
    }
    for(const row of db.prepare('SELECT id,payload FROM companion_reminder_events').all()){
     const entry=JSON.parse(row.payload);if(entry.evidenceRefs?.some(ref=>ref.id===id))db.prepare('DELETE FROM companion_reminder_events WHERE id=?').run(row.id);
    }
    return {evidenceId:id,affected};
   });
  },
  respond(input) {
   fields(input,['id','action','roundId','receiptId'],'reminder_response');identifier(input.id);if(input.roundId!==undefined)identifier(input.roundId);if(input.receiptId!==undefined)identifier(input.receiptId);
   if(!['seen','snooze','done','dismiss','disable'].includes(input.action))throw new Error('invalid_reminder_response');
   sweep();const g=get(input.id);if(!g)throw new Error('unknown_reminder');
   if(input.roundId!==undefined&&input.roundId!==g.roundId)throw new Error('reminder_round_changed');
   if(input.receiptId!==undefined&&input.receiptId!==g.lastReceiptId)throw new Error('reminder_display_changed');
   if(g.status==='disabled'||g.status==='dismissed'&&input.action!=='disable'||g.lastUserAction===input.action&&g.lastUserRound===g.roundId&&g.lastUserAttempt===g.attemptCount||g.status==='completed'&&!['dismiss','disable'].includes(input.action)||g.status==='acknowledged'&&['seen','snooze'].includes(input.action))return g;
   if(g.status==='exhausted'&&input.action==='snooze')throw new Error('reminder_attempt_limit');
   g.lastUserAction=input.action;g.lastUserRound=g.roundId;g.lastUserAttempt=g.attemptCount;
   g.outcomeSource='explicit_user';
   if(input.action==='disable'){g.recurring=false;finish(g,'disabled','user_disabled','user_disabled_goal');}
   else if(input.action==='dismiss')finish(g,'dismissed','user_declined','user_declined_current_round');
   else if(input.action==='done')finish(g,'completed','user_confirmed','explicit_user_completion');
   else if(input.action==='seen')finish(g,'acknowledged','seen','seen_is_not_completion');
   else if(!TERMINAL.has(g.status)){g.status='snoozed';g.reason='user_snoozed';g.nextReviewAt=Math.min(g.expiresAt,Math.max(clock()+(g.source==='demo'?1000:300000),(g.lastPresentedAt??0)+g.minIntervalMs));}
   return transaction(()=>{event(g,'user_'+input.action);return put(g);});
  },
  close(){db.close();}
 };
}
