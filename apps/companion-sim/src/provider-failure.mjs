// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const transient=new Set(['rate_limited','unavailable','network','timeout']);
const kinds=new Set([...transient,'authentication','account','request','unknown']);
const accountCodes=new Set(['1113','1308','1309','1310','1311','1313','1314','1315','1316','1317','1318','1319','1320','1321']);
const maxWait=3600000;
const numericCode=value=>typeof value==='string'&&/^\d{1,8}$/.test(value)?value:undefined;

/** Only host-owned transport metadata crosses the Pi boundary. Never retain errors. */
export function sanitizeProviderFailure(value){
 const kind=kinds.has(value?.kind)?value.kind:'unknown';
 const result={kind,retryable:value?.retryable===true&&transient.has(kind)};
 if(Number.isInteger(value?.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)result.httpStatus=value.httpStatus;
 const code=numericCode(value?.businessCode);if(code)result.businessCode=code;
 if(value?.retryAfterMs!==undefined){
  if(Number.isSafeInteger(value.retryAfterMs)&&value.retryAfterMs>=0&&value.retryAfterMs<=maxWait)result.retryAfterMs=value.retryAfterMs;
  else result.retryable=false;
 }
 return result;
}
export function classifyProviderFailure({httpStatus,businessCode,retryAfterMs}={}){
 const code=numericCode(String(businessCode??''));let kind='unknown',retryable=false;
 if(httpStatus===401||httpStatus===403)kind='authentication';
 else if(accountCodes.has(code))kind='account';
 else if(httpStatus===429){
  if(code==='1305'){kind='unavailable';retryable=true;}
  else if(!code||code==='1302'){kind='rate_limited';retryable=true;}
 }else if(httpStatus===408){kind='timeout';retryable=true;}
 else if(Number.isInteger(httpStatus)&&httpStatus>=500&&httpStatus<=599){kind='unavailable';retryable=true;}
 else if(Number.isInteger(httpStatus)&&httpStatus>=400&&httpStatus<=499)kind='request';
 return sanitizeProviderFailure({kind,retryable,httpStatus,businessCode:code,retryAfterMs});
}
export function classifyProviderNetworkFailure(error,{aborted=false}={}){
 if(aborted)return null;
 const code=error?.cause?.code??error?.code;
 if(error?.name==='AbortError'||error?.name==='TimeoutError'||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code))return {kind:'timeout',retryable:true};
 if(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','EPIPE','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET'].includes(code))return {kind:'network',retryable:true};
 return {kind:'unknown',retryable:false};
}
function retryAfter(response){
 const text=response.headers.get('retry-after');if(!text||text.length>128)return undefined;
 const ms=/^\d+$/.test(text)?Number(text)*1000:Date.parse(text)-Date.now();
 return Number.isFinite(ms)&&ms>=0?Math.ceil(ms):undefined;
}
async function readBusinessCode(response){
 // An error response may be hostile or stalled. Bound this error-only inspection;
 // cancellation of a clone must not await consumption of the SDK's original branch.
 let reader,timer;
 try{
  reader=response.clone().body?.getReader();if(!reader)return undefined;
  const read=async()=>{
   const chunks=[];let length=0;
   while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>8192)return undefined;chunks.push(part.value);}
   const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   return numericCode(String(value?.error?.code??value?.base_resp?.status_code??''));
  };
  return await Promise.race([read(),new Promise(resolve=>{timer=setTimeout(()=>resolve(undefined),200);})]);
 }catch{return undefined;}
 finally{clearTimeout(timer);reader?.cancel().catch(()=>{});}
}

/** Per-request SDK fetch hook; no global mutation, hidden retry, or alternate route. */
export function reportingFetch(fetchFn,{signal,onFailure}={}){
 const report=failure=>{if(!failure||signal?.aborted)return;try{onFailure?.(sanitizeProviderFailure(failure));}catch{/* Transport outcome is independent of telemetry. */}};
 return async(input,init)=>{
  let response;
  try{response=await fetchFn(input,init);}catch(error){report(classifyProviderNetworkFailure(error,{aborted:signal?.aborted}));throw error;}
  if(!response.ok){report(classifyProviderFailure({httpStatus:response.status,businessCode:await readBusinessCode(response),retryAfterMs:retryAfter(response)}));return response;}
  if(!response.body)return response;
  const reader=response.body.getReader();
  const body=new ReadableStream({
   async pull(controller){try{const {done,value}=await reader.read();if(done)controller.close();else controller.enqueue(value);}catch(error){report(classifyProviderNetworkFailure(error,{aborted:signal?.aborted}));controller.error(error);}},
   cancel:reason=>reader.cancel(reason),
  });
  const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
  return new Response(body,{status:response.status,statusText:response.statusText,headers});
 };
}
