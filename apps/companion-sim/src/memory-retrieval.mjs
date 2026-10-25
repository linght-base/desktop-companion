// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const QUERY_MAX=500,VARIANTS_MAX=4,ENTITY_MAX=12,ID_MAX=200,LIMIT_DEFAULT=6,LIMIT_MAX=20,PER_SEARCH_LIMIT=20,RRF_K=60,REASON_MAX=480;
const ALLOWED_KINDS=new Set(['perception','episode','interaction','understanding','hypothesis']);
const ALLOWED_STATUSES=new Set(['active','tentative']);
const INPUT_KEYS=['query','queryVariants','entityIds','limit'];
const CONTEXT_KEYS=['deskId'];
const MODES=['pi_query_variants','pi_query_single','desk_entity_scope','desk_current_scope'];
const length=value=>[...value].length;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
function keysOf(value,allowed,name){
 for(const key of Object.keys(value))if(!allowed.includes(key))throw new TypeError(`Invalid ${name}: unsupported field ${key}`);
}
function queryText(value,name){
 if(typeof value!=='string')throw new TypeError(`Invalid ${name}`);
 const trimmed=value.trim();
 if(!trimmed||length(trimmed)>QUERY_MAX||trimmed.includes('\0'))throw new TypeError(`Invalid ${name}`);
 return trimmed;
}
function candidate(raw){
 if(!plain(raw))throw new TypeError('Invalid search result record');
 if(typeof raw.id!=='string'||!raw.id.trim()||length(raw.id)>ID_MAX)throw new TypeError('Invalid search result id');
 if(!Number.isSafeInteger(raw.revision)||raw.revision<1)throw new TypeError('Invalid search result revision');
 return raw;
}

/** Bounded multi-query memory retrieval for one Pi tool call. The host injects
 *  search (continuity.recall) and readCurrent (current-record read); deskId is
 *  host-owned context, never model input. Rank fusion (RRF) over query variants,
 *  then per-candidate current-record verification (same desk, allowed live
 *  kind/status, exact revision) — revised/retracted/deleted candidates are
 *  dropped, never silently swapped or covered by stale summaries. Not embedding;
 *  no semantic guarantee. No scene/action dictionaries, no images, no model
 *  calls, no retained memory copies, no persistence. */
export function createMemoryRetrieval({search,readCurrent,maxQueries=5,maxCandidates=100}={}){
 if(typeof search!=='function')throw new TypeError('Invalid search');
 if(typeof readCurrent!=='function')throw new TypeError('Invalid readCurrent');
 if(!Number.isSafeInteger(maxQueries)||maxQueries<1||maxQueries>5)throw new TypeError('Invalid maxQueries');
 if(!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>100)throw new TypeError('Invalid maxCandidates');
 let closed=false;
 const stats={recalls:0,searches:0,verifications:0,candidates:0,dropped:0,returned:0,failures:0,byMode:Object.fromEntries(MODES.map(mode=>[mode,0]))};
 function deskOf(context){
  if(!plain(context))throw new TypeError('Invalid context');
  keysOf(context,CONTEXT_KEYS,'context');
  if(typeof context.deskId!=='string'||!context.deskId.trim()||length(context.deskId.trim())>ID_MAX)throw new TypeError('Invalid context deskId');
  return context.deskId.trim();
 }
 function parseInput(input){
  if(!plain(input))throw new TypeError('Invalid input');
  keysOf(input,INPUT_KEYS,'input'); // strict: unknown keys (incl. model-supplied deskId) fail, never silently swallowed
  const queries=[];
  if(input.query!==undefined)queries.push({kind:'查询',text:queryText(input.query,'query')});
  if(input.queryVariants!==undefined){
   if(!Array.isArray(input.queryVariants)||input.queryVariants.length>VARIANTS_MAX)throw new TypeError('Invalid queryVariants');
   const seen=new Set(queries.map(q=>q.text));
   for(const raw of input.queryVariants){
    if(typeof raw!=='string')throw new TypeError('Invalid queryVariants');
    const trimmed=raw.trim();
    if(!trimmed)continue; // blank entries dropped after strict type/length checks
    if(length(trimmed)>QUERY_MAX||trimmed.includes('\0'))throw new TypeError('Invalid queryVariants');
    if(seen.has(trimmed))continue; // duplicates (incl. the query itself) dropped
    seen.add(trimmed);queries.push({kind:'改写',text:trimmed});
   }
  }
  let entities=[];
  if(input.entityIds!==undefined){
   if(!Array.isArray(input.entityIds)||input.entityIds.length>ENTITY_MAX)throw new TypeError('Invalid entityIds');
   entities=[...new Set(input.entityIds.map(id=>{
    if(typeof id!=='string'||!id.trim()||length(id.trim())>ID_MAX)throw new TypeError('Invalid entityIds');
    return id.trim();
   }))];
  }
  let limit=LIMIT_DEFAULT;
  if(input.limit!==undefined){
   if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>LIMIT_MAX)throw new TypeError('Invalid limit');
   limit=input.limit;
  }
  return {queries:queries.slice(0,maxQueries),entities,limit};
 }
 async function runSearch(params){
  let result;
  try{result=await search(params);}catch(error){throw new TypeError('Memory retrieval search failed',{cause:error});}
  if(!Array.isArray(result))throw new TypeError('Memory retrieval search returned invalid result');
  if(result.length>PER_SEARCH_LIMIT)throw new TypeError('Memory retrieval search returned too many results');
  return result.map(candidate);
 }
 async function runReadCurrent(id,deskId){
  let record;
  try{record=await readCurrent(id,{deskId});}catch(error){throw new TypeError('Memory retrieval readCurrent failed',{cause:error});}
  if(record===null||record===undefined)return null;
  if(!plain(record))throw new TypeError('Memory retrieval readCurrent returned invalid result');
  return record;
 }
 // Same desk, currently retrievable kind/status, exact candidate revision.
 // Stale revisions are dropped; the newer version is never substituted without re-ranking.
 function verify(current,hit,deskId){
  return current!==null&&current.id===hit.id&&current.revision===hit.revision
   &&current.deskId===deskId&&ALLOWED_KINDS.has(current.kind)&&ALLOWED_STATUSES.has(current.status);
 }
 function fusedReason(entry){
  const parts=entry.sources.slice(0,4).map(s=>{
   const text=s.text.length>40?`${s.text.slice(0,40)}…`:s.text;
   return `${s.kind}${s.queryIndex}「${text}」第${s.rank}名`;
  });
  let reason=`多查询RRF融合：${parts.join('；')}`;
  if(typeof entry.best.matchReason==='string'&&entry.best.matchReason.trim())reason+=`；原相关：${entry.best.matchReason.trim()}`;
  return reason.length>REASON_MAX?reason.slice(0,REASON_MAX):reason;
 }
 async function collect(ranked,limit,deskId,mode,reasonFor){
  const results=[];
  for(const entry of ranked){
   if(results.length>=limit)break;
   stats.verifications++;
   const current=await runReadCurrent(entry.id,deskId);
   if(!verify(current,entry.best,deskId)){stats.dropped++;continue;}
   results.push({...current,matchReason:reasonFor(entry,current),retrievalMode:mode});
  }
  return results;
 }
 async function recall(input,context){
  if(closed)throw new TypeError('Memory retrieval closed');
  const deskId=deskOf(context);
  const {queries,entities,limit}=parseInput(input);
  stats.recalls++;
  try{
   let mode,ranked,reasonFor;
   if(!queries.length){
    // No query/variants: keep entity / current-desk scope behaviour (one bounded search).
    mode=entities.length?'desk_entity_scope':'desk_current_scope';
    stats.searches++;
    const hits=await runSearch({deskId,entityIds:entities,limit});
    ranked=hits.map(hit=>({id:hit.id,revision:hit.revision,best:hit,bestRank:1,firstQuery:0,sources:[]}));
    reasonFor=entry=>typeof entry.best.matchReason==='string'&&entry.best.matchReason.trim()
     ?entry.best.matchReason.trim()
     :(mode==='desk_entity_scope'?'同桌面的实体引用':'当前桌面的有效记录');
   }else{
    mode=queries.length>1?'pi_query_variants':'pi_query_single';
    const fused=new Map();
    for(let qi=0;qi<queries.length;qi++){
     stats.searches++;
     const hits=await runSearch({query:queries[qi].text,deskId,entityIds:entities,limit:PER_SEARCH_LIMIT});
     hits.forEach((hit,index)=>{
      const rank=index+1,key=`${hit.id} ${hit.revision}`;
      const source={kind:queries[qi].kind,queryIndex:qi+1,text:queries[qi].text,rank};
      const entry=fused.get(key);
      if(entry){
       entry.score+=1/(RRF_K+rank);entry.sources.push(source);
       if(rank<entry.bestRank){entry.bestRank=rank;entry.best=hit;}
      }else if(fused.size<maxCandidates){
       fused.set(key,{id:hit.id,revision:hit.revision,score:1/(RRF_K+rank),bestRank:rank,firstQuery:qi+1,best:hit,sources:[source]});
      }
     });
    }
    ranked=[...fused.values()].sort((a,b)=>b.score-a.score||a.bestRank-b.bestRank||a.firstQuery-b.firstQuery
     ||(a.id<b.id?-1:a.id>b.id?1:0)||a.revision-b.revision);
    reasonFor=fusedReason;
   }
   stats.candidates+=ranked.length;
   const results=await collect(ranked,limit,deskId,mode,reasonFor);
   stats.byMode[mode]++;stats.returned+=results.length;
   return results; // no candidates → empty array; never falls back to unrelated recent records
  }catch(error){
   stats.failures++;
   throw error;
  }
 }
 function snapshot(){
  return {closed,...stats,byMode:{...stats.byMode},capacity:{maxQueries,maxCandidates,perSearchLimit:PER_SEARCH_LIMIT,limitMax:LIMIT_MAX,variantsMax:VARIANTS_MAX,entityMax:ENTITY_MAX}};
 }
 function close(){
  if(closed)return {accepted:true,alreadyClosed:true};
  closed=true;return {accepted:true};
 }
 return {recall,snapshot,close};
}
