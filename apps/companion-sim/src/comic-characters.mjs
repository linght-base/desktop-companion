// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {randomUUID} from 'node:crypto';

const clean=(value,name,max=180)=>{
 if(typeof value!=='string'||!value.trim()||Array.from(value).length>max||value.includes('\0'))throw new TypeError(`Invalid character ${name}`);
 return value.trim();
};
const refFor=(record,key)=>({recordId:record.id,revision:record.revision,subjectKey:key});
const live=(record,deskId,source)=>record?.kind==='perception'&&record.status==='active'&&record.deskId===deskId&&record.source===source;
function resolve(ref,{readEvidence,deskId,source,before=Infinity}){
 const record=readEvidence(ref.recordId,{deskId});
 if(!live(record,deskId,source)||record.revision!==ref.revision||(record.observedAt??record.at)>before)throw new TypeError('Character reference revision or scope changed');
 const subject=record.visualSubjects?.find(s=>s.key===ref.subjectKey);
 if(!subject)throw new TypeError('Character subject unavailable');
 return {record,subject};
}
/** Model describes appearances; host assigns a drawing key, never a human identity. */
export function recordVisualSubjects(input=[],{readEvidence,deskId,source,observedAt}){
 if(!Array.isArray(input)||input.length>3)throw new TypeError('Invalid character subjects');
 const keys=new Set(),linked=new Set();
 return input.map(item=>{
  if(!item||Object.keys(item).some(k=>!['key','appearance','clothing','previous'].includes(k)))throw new TypeError('Invalid character fields');
  const key=clean(item.key,'key',80);if(keys.has(key))throw new TypeError('Duplicate character key');keys.add(key);
  const appearance=clean(item.appearance,'appearance'),clothing=clean(item.clothing,'clothing');
  let characterId=randomUUID(),anchor;
  if(item.previous!==undefined){
   const p=item.previous;
   if(!p||Object.keys(p).some(k=>!['recordId','revision','subjectKey'].includes(k))||!Number.isSafeInteger(p.revision)||p.revision<1)throw new TypeError('Invalid character reference');
   const previous={recordId:clean(p.recordId,'recordId',200),revision:p.revision,subjectKey:clean(p.subjectKey,'subjectKey',80)};
   const prior=resolve(previous,{readEvidence,deskId,source,before:observedAt});
   characterId=prior.subject.characterId;anchor=prior.subject.anchor??previous;
   const base=resolve(anchor,{readEvidence,deskId,source,before:observedAt});
   if(!characterId||base.subject.characterId!==characterId||linked.has(characterId))throw new TypeError('Ambiguous character link');
   linked.add(characterId);
   return {key,characterId,appearance,clothing,anchor,previous,identityStatus:'unconfirmed',continuityStatus:'model_associated'};
  }
  return {key,characterId,appearance,clothing,identityStatus:'unconfirmed',continuityStatus:'new_drawing_character'};
 });
}

/** Only current source revisions are supplied; clothing is never inherited. */
export function characterContext(records=[],{readEvidence,deskId,limit=6}={}){
 const result=[],seen=new Set();
 for(const record of [...records].sort((a,b)=>(b.observedAt??b.at)-(a.observedAt??a.at))){
  if(!live(record,deskId,record.source)||!['camera','replay'].includes(record.source))continue;
  for(const subject of record.visualSubjects??[]){
   if(seen.has(subject.characterId))continue;
   try{
    const anchor=subject.anchor??refFor(record,subject.key),base=resolve(anchor,{readEvidence,deskId,source:record.source,before:record.observedAt??record.at});
    if(base.subject.characterId!==subject.characterId)continue;
    result.push({characterId:subject.characterId,appearance:base.subject.appearance,lastVisibleAppearance:subject.appearance,lastClothing:subject.clothing,observedAt:record.observedAt??record.at,previous:refFor(record,subject.key),anchor,source:record.source,identityStatus:'unconfirmed'});
    seen.add(subject.characterId);
   }catch{/* Revised, withdrawn, or cross-scope anchors supply no character authority. */}
   if(result.length>=limit)return result;
  }
 }
 return result;
}

/** Pin all reused appearance sources with selected facts before generating. */
export function momentCharacters(records,{readEvidence,deskId}){
 const result=[],seen=new Set();
 for(const record of records.slice(0,1)){
  for(const subject of record.visualSubjects??[]){
   if(seen.has(subject.characterId))continue;
   const anchor=subject.anchor??subject.previous??refFor(record,subject.key);
   const base=resolve(anchor,{readEvidence,deskId,source:record.source,before:record.observedAt??record.at});
   if(base.subject.characterId!==subject.characterId)throw new TypeError('Character anchor mismatch');
   const evidenceRefs=[{id:record.id,revision:record.revision},{id:base.record.id,revision:base.record.revision}].filter((r,i,a)=>a.findIndex(s=>s.id===r.id)===i);
   result.push({characterId:subject.characterId,appearance:base.subject.appearance,clothing:subject.clothing,observedAt:record.observedAt??record.at,evidenceRefs,identityStatus:'unconfirmed'});seen.add(subject.characterId);
  }
 }
 return result.slice(0,3);
}
