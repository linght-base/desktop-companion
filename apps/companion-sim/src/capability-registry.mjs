// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// Generic capability directory: host-reported capabilities with parameters and limits.
// Pure in-memory, zero dependencies, no model/network/device calls. A registration is a
// description, never an execution grant: real calls still go through existing tool
// fresh-evidence/epoch/body gates. Entries hold no handlers, credentials, raw frames,
// or user memory.

const MAX_ENTRIES=64;
const MAX_DEPTH=16;
const MAX_SCHEMA_BYTES=8192;
const MAX_CHANNELS=16;
const MAX_CHANNEL_LENGTH=64;
const MAX_DESCRIPTION_LENGTH=1000;
const MAX_REASON_LENGTH=300;
const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const EXTERNAL_RESOURCE=/^\s*(?:https?|file|data|javascript|ws|wss|ftp):/i;
const POLLUTION_KEYS=new Set(['__proto__','constructor','prototype']);
const FIELDS=['id','description','channels','parameters','limits','available','unavailableReason'];

const isPlainObject=value=>typeof value==='object'&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const boundedText=(value,max,name)=>{
 if(typeof value!=='string')throw new Error('invalid_'+name);
 const text=value.trim();
 if(!text||text.length>max)throw new Error('invalid_'+name);
 return text;
};

/** Structural validation only: nothing here is ever executed, compiled, or dereferenced. */
function pureJson(value,name,depth=0,seen=new Set()) {
 if(depth>MAX_DEPTH)throw new Error(name+'_too_deep');
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('invalid_'+name);return;}
 if(typeof value==='string'){if(EXTERNAL_RESOURCE.test(value))throw new Error(name+'_external_resource');return;}
 if(typeof value!=='object')throw new Error('invalid_'+name); // functions, symbols, bigint, undefined
 if(seen.has(value))throw new Error(name+'_cyclic');
 seen.add(value);
 if(Array.isArray(value)){if(value.length>256)throw new Error(name+'_too_large');for(const item of value)pureJson(item,name,depth+1,seen);seen.delete(value);return;}
 if(!isPlainObject(value))throw new Error('invalid_'+name);
 const keys=Object.keys(value);
 if(keys.length>256)throw new Error(name+'_too_large');
 for(const key of keys){if(POLLUTION_KEYS.has(key))throw new Error(name+'_pollution_key');pureJson(value[key],name,depth+1,seen);}
 seen.delete(value);
}

const boundedJson=(value,name)=>{
 pureJson(value,name);
 if(JSON.stringify(value).length>MAX_SCHEMA_BYTES)throw new Error(name+'_too_large');
 return structuredClone(value);
};

const boundedChannels=value=>{
 if(!Array.isArray(value)||value.length>MAX_CHANNELS)throw new Error('invalid_channels');
 const seen=new Set(),channels=[];
 for(const item of value){
  const channel=boundedText(item,MAX_CHANNEL_LENGTH,'channel');
  if(EXTERNAL_RESOURCE.test(channel))throw new Error('invalid_channels');
  const key=channel.toLowerCase();
  if(!seen.has(key)){seen.add(key);channels.push(channel);}
 }
 return channels;
};

export function createCapabilityRegistry() {
 let revision=0,closed=false;
 const entries=new Map(); // insertion order = stable listing order
 const copy=entry=>({id:entry.id,description:entry.description,channels:[...entry.channels],parameters:structuredClone(entry.parameters),limits:structuredClone(entry.limits),available:entry.available,...(entry.unavailableReason?{unavailableReason:entry.unavailableReason}:{}),rev:entry.rev});
 const assertOpen=()=>{if(closed)throw new Error('registry_closed');};
 return {
  register(input) {
   assertOpen();
   if(!isPlainObject(input))throw new Error('invalid_capability');
   for(const key of Object.keys(input))if(!FIELDS.includes(key))throw new Error('unexpected_capability_field'); // handlers/credentials are never accepted
   const id=boundedText(input.id,64,'capability_id');
   if(!ID_PATTERN.test(id))throw new Error('invalid_capability_id'); // stable ASCII identifier
   const description=boundedText(input.description,MAX_DESCRIPTION_LENGTH,'capability_description');
   const channels=boundedChannels(input.channels);
   if(!isPlainObject(input.parameters)||!isPlainObject(input.limits))throw new Error('capability_schema_object_required');
   const parameters=boundedJson(input.parameters,'capability_parameters'); // JSON-Schema object, stored not executed
   const limits=boundedJson(input.limits,'capability_limits');
   if(typeof input.available!=='boolean')throw new Error('invalid_capability_available');
   const unavailableReason=input.unavailableReason===undefined?null:boundedText(input.unavailableReason,MAX_REASON_LENGTH,'unavailable_reason');
   if(!entries.has(id)&&entries.size>=MAX_ENTRIES)throw new Error('capability_registry_full');
   const existing=entries.get(id);
   const entry={id,description,channels,parameters,limits,available:input.available,unavailableReason,rev:(existing?.rev??0)+1};
   entries.delete(id);entries.set(id,entry); // re-registration moves to the end, keeping order deterministic
   revision++;
   return copy(entry);
  },
  get(id) {
   if(typeof id!=='string')return null;
   const entry=entries.get(id);
   return entry?copy(entry):null;
  },
  list({query,availableOnly=false,channels,limit=32}={}) {
   if(typeof availableOnly!=='boolean')throw new Error('invalid_available_only');
   const tokens=typeof query==='string'?query.toLowerCase().split(/\s+/).filter(Boolean).slice(0,8):[];
   const wanted=channels===undefined?null:new Set(boundedChannels(channels).map(c=>c.toLowerCase()));
   if(!Number.isSafeInteger(limit)||limit<1)throw new Error('invalid_limit');
   const out=[];
   for(const entry of entries.values()){
    if(availableOnly&&!entry.available)continue;
    if(wanted&&![...wanted].every(c=>entry.channels.some(have=>have.toLowerCase()===c)))continue;
    if(tokens.length){
     const haystack=(entry.id+' '+entry.description).toLowerCase();
     if(!tokens.every(token=>haystack.includes(token)))continue;
    }
    out.push(copy(entry));
    if(out.length>=Math.min(limit,MAX_ENTRIES))break;
   }
   return out;
  },
  remove(id) {
   assertOpen();
   if(typeof id!=='string')return false;
   if(!entries.delete(id))return false;
   revision++;return true;
  },
  snapshot(){return {revision,count:entries.size,capabilities:[...entries.values()].map(copy)};},
  get revision(){return revision;},
  close(){closed=true;} // idempotent
 };
}
