// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const clip=(value,max=200)=>typeof value==='string'?value.slice(0,max):value;
function pick(value,keys,max=200){
  if(!value||typeof value!=='object')return null;
  const result={};
  for(const key of keys){const item=value[key];if(typeof item==='string')result[key]=clip(item,max);else if(typeof item==='boolean'||item===null||typeof item==='number'&&Number.isFinite(item))result[key]=item;}
  return result;
}
const refs=value=>Array.isArray(value)?value.slice(0,6).map(ref=>pick(ref,['id','revision'])):[];
const ids=value=>Array.isArray(value)?value.filter(id=>typeof id==='string').slice(0,6).map(id=>clip(id,200)):[];
const observationHistoryMeta=value=>{
  if(!value||typeof value!=='object'||!['ready','clock_fault','closed'].includes(value.status))return null;
  const meta=pick(value,['status','count','bytes','oldestAt','newestAt','maxAgeMs','omittedAge','omittedCapacity']);
  for(const key of ['count','bytes','oldestAt','newestAt','maxAgeMs','omittedAge','omittedCapacity']){
    const item=value[key];
    if(item===null){meta[key]=null;continue;}
    if(typeof item!=='number'||!Number.isFinite(item)||item<0)return null;
    meta[key]=item;
  }
  return meta;
};

/** Pack references and summaries as complete JSON. Explicit settings and accepted
 * commitments have priority; optional memory cannot truncate a commitment. */
export function packSubjectContext(snapshot={}, {maxBytes=24000}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<16000||maxBytes>48000)throw new Error('invalid_context_budget');
  const context={personaVersion:pick(snapshot.personaMeta,['id','legacyVersion','sourceId','activatedAt']),profile:pick(snapshot.profile,['deskId','quietMode','curiosity','version','expressionLearning','learningVersion']),subject:pick(snapshot.subject,['confirmed','identity','targetId']),reminders:[],visualExchange:null,pendingThoughts:[],recentMessages:[],attention:null,personOrientation:pick(snapshot.personOrientation,['status','searchUntil','until','armed','facing','facingAt','suppressFeedback','attentionReturnedAt','nextGlanceAt','centerX','centerY','errorX','errorY']),characterContext:[],cognition:[],plans:[],episodes:[],expressionDemands:[],interests:[],activities:[],methods:[],omitted:{}};
  const bytes=()=>Buffer.byteLength(JSON.stringify(context));
  function add(key,value){if(!value)return;context[key].push(value);if(bytes()>maxBytes-512){context[key].pop();context.omitted[key]=(context.omitted[key]??0)+1;}}
  if(snapshot.visualExchange){context.visualExchange=pick(snapshot.visualExchange,['active','since','lastVisibleAt','lastTowardAt','turn','facing','semanticStatus','userAttention']);context.visualExchange.opportunity=pick(snapshot.visualExchange.opportunity,['reason','at','since','turn']);}
  for(const item of (snapshot.pendingThoughts??[]).slice(-5))add('pendingThoughts',{...pick(item,['id','message','inference','uncertainty','createdAt','expiresAt','status','presentationStatus'],300),evidenceRefs:refs(item.evidenceRefs)});
  for(const item of (snapshot.recentMessages??[]).slice(-5))add('recentMessages',pick(item,['id','message','createdAt','expiresAt','status','presentationStatus','facingAtRequest'],100));
  for(const item of (snapshot.characterContext??[]).slice(0,6))add('characterContext',{...pick(item,['characterId','appearance','lastVisibleAppearance','lastClothing','observedAt','source','identityStatus'],180),previous:pick(item.previous,['recordId','revision','subjectKey']),anchor:pick(item.anchor,['recordId','revision','subjectKey'])});
  const reminders=Array.isArray(snapshot.reminders)?snapshot.reminders:[];
  for(const goal of reminders.slice(0,20))add('reminders',pick(goal,['id','kind','label','status','source','deskId','acceptedBy','roundId','at','expiresAt','nextReviewAt','nextCycleAt','pausedUntil','intervalMs','minIntervalMs','windowMs','attemptCount','maxAttempts','recurring','lastPresentedAt','presentationStatus','confirmedPresentationCount','lastConfirmedAt','lastOutcome','outcomeSource','lastUserAction','reason','inferenceReason','semanticStatus'],160));
  if(reminders.length>20)context.omitted.reminders=(context.omitted.reminders??0)+reminders.length-20;
  const attention=pick(snapshot.attention,['status','streamId','observedAt','searchUntil','reason']);
  if(attention){attention.targets=(snapshot.attention.targets??[]).slice(0,8).map(target=>({...pick(target,['id','kind','identity','confidence']),box:pick(target.box,['x','y','width','height']),faceOrientation:pick(target.faceOrientation,['direction','confidence','source'])}));attention.focus=pick(snapshot.attention.focus,['targetId','until']);context.attention=attention;}
  const observationHistory=observationHistoryMeta(snapshot.observationHistory);
  if(observationHistory)context.observationHistory=observationHistory;
  if(snapshot.capabilities){const rig=snapshot.capabilities;context.capabilities={profile:clip(rig.profile),camera:{...pick(rig.camera,['kind','motion']),capabilities:pick(rig.camera?.capabilities,['panTilt']),pose:pick(rig.camera?.pose,['yaw','pitch','source','completedAt'])},presentation:pick(rig.presentation,['kind','mode','headControlsCamera'])};}
  for(const item of (Array.isArray(snapshot.cognition)?snapshot.cognition:snapshot.cognition?.items??[]).slice(0,3))add('cognition',{...pick(item,['id','meaning','icon','kind','state','tentative','semanticStatus','createdAt','at','expiresAt'],300),evidenceRefs:refs(item.evidenceRefs)});
  for(const plan of (snapshot.plans??[]).slice(0,8))add('plans',{...pick(plan,['id','revision','status','goal','nextAt','deskId'],300),evidenceRefs:refs(plan.evidenceRefs),steps:(plan.steps??[]).filter(step=>step.status!=='completed').slice(0,2).map(step=>pick(step,['id','aim','status'],200))});
  for(const episode of (snapshot.episodes??[]).slice(0,6))add('episodes',{...pick(episode,['id','revision','summary','activity','semanticStatus','status','source','startAt','endAt','continuousDurationKnown','actorStatus'],300),evidenceRefs:refs((episode.evidenceIds??[]).map(id=>({id,revision:episode.evidenceRevisions?.[id]})))});
  for(const demand of (snapshot.expressionDemands??[]).slice(0,4))add('expressionDemands',pick(demand,['id','revision','meaning','status','nextAt','candidateId'],240));
  for(const interest of (snapshot.interests??[]).slice(0,12))add('interests',{...pick(interest,['id','question','status','revision','nextAt','deskId'],240),evidenceIds:ids(interest.evidenceIds)});
  for(const entry of (snapshot.activities??[]).slice(-6))add('activities',{...pick(entry,['id','activity','summary','observedAt','source','actor','observedDurationMs'],240),evidenceRefs:refs(entry.evidenceRefs),frameTimes:(entry.frameTimes??[]).filter(Number.isFinite).slice(-4),hasUnobservedGaps:Boolean(entry.gaps?.length)});
  for(const method of (snapshot.methods?.methods??[]).filter(method=>method.status==='candidate').slice(0,12))add('methods',pick(method,['id','meaning','status','semanticStatus'],200));
  if(bytes()>maxBytes)throw new Error('required_context_exceeds_budget');
  return context;
}
