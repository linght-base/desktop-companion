// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const BASE='http://127.0.0.1:8767';
const REASONS=new Set(['pairing_not_found','device_connect_timeout','device_slot_occupied','invalid_state_transition','pairing_timeout','pairing_cancelled']);
/** Uses the official daemon REST contract. Pair codes exist only in this request's memory. */
export function createDevicePairing({bridge,isPaused,fetch:fetchFn=globalThis.fetch,onChange=()=>{},pollMs=250,timeoutMs=30000}={}){
 let status='idle',reason=null,closed=false,flight=null,abort=null;
 const snapshot=()=>({status:bridge.snapshot().connected?'connected':status==='connected'?'disconnected':status,reason:bridge.snapshot().connected?null:reason});
 const update=(next,code=null)=>{status=next;reason=code;if(!closed)onChange();};
 const json=async(path,init,signal)=>{
  const response=await fetchFn(BASE+path,{...init,signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
  if(!response.ok)throw new Error('pairing_failed');
  return response.json();
 };
 async function pair(code,signal){
  let device=(await json('/daemon/devices',undefined,signal)).device;
  if(!device?.online){
   if(device?.state!=='idle')throw new Error('pairing_in_progress');
   await json('/daemon/devices/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairing_code:code,target_mode:'python_sdk'})},signal);
   code=null;
   const deadline=Date.now()+timeoutMs;
   while(!signal.aborted){
    device=(await json('/daemon/devices',undefined,signal)).device;
    if(device?.online)break;
    if(device?.state==='idle'&&device.last_error)throw new Error(REASONS.has(device.last_error)?device.last_error:'pairing_failed');
    if(Date.now()>=deadline)throw new Error('pairing_timeout');
    await new Promise(resolve=>{const timer=setTimeout(done,pollMs);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
   }
  }
  if(signal.aborted||closed)return;
  if(!isPaused())throw new Error('stop_before_pairing');
  await bridge.reconnect();
  if(!closed&&!signal.aborted)update('connected');
 }
 return {
  snapshot,
  start({code}){
   if(closed)throw new Error('pairing_closed');
   if(typeof code!=='string'||!/^\d{6}$/.test(code))throw new Error('invalid_pairing_code');
   if(!isPaused())throw new Error('stop_before_pairing');
   if(flight)throw new Error('pairing_in_progress');
   if(bridge.snapshot().connected){update('connected');return {accepted:true,...snapshot()};}
   abort=new AbortController();update('pairing');
   flight=pair(code,abort.signal).catch(error=>{if(!closed)update('error',REASONS.has(error.message)||['pairing_in_progress','stop_before_pairing'].includes(error.message)?error.message:'pairing_failed');}).finally(()=>{flight=null;abort=null;});
   return {accepted:true,...snapshot()};
  },
  async close(){closed=true;abort?.abort();if(flight)await flight;}
 };
}
