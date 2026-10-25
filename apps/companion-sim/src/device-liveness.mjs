// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Read the official daemon continuously; SDK-process readiness alone is not robot liveness. */
export function createDeviceLiveness({bridge,fetch:fetchFn=globalThis.fetch,clock=Date.now,onChange=()=>{},onDisconnect=()=>{},canRecover=()=>true,intervalMs=1000,timeoutMs=1200,maxAgeMs=3000}={}){
 let status='checking',reason=null,checkedAt=null,lastOnlineAt=null,closed=false,flight=null,timer=null,abort=null,wasConnected=false,signature='';
 let recovery=null,recoveryFailures=0,retryAt=0;
 const snapshot=()=>{
  const fresh=checkedAt!==null&&clock()-checkedAt>=0&&clock()-checkedAt<=maxAgeMs;
  const transport=bridge.snapshot().connected===true;
  const connected=!closed&&status==='online'&&fresh&&transport;
  return {status:closed?'closed':!fresh&&checkedAt!==null?'unavailable':status,connected,reason:closed?'closed':!fresh&&checkedAt!==null?'health_expired':status==='online'&&!transport?recovery?'bridge_reconnecting':'bridge_disconnected':reason,checkedAt,lastOnlineAt,intervalMs,timeoutMs,maxAgeMs};
 };
 function notify(){
  if(closed)return;
  const health=snapshot(),next=JSON.stringify([health.status,health.connected,health.reason]);
  if(wasConnected&&!health.connected)onDisconnect(health);
  wasConnected=health.connected;
  if(next!==signature){signature=next;onChange(health);}
 }
 function recover(){
  const transport=bridge.snapshot();
  // Restore transport only. The host remains paused; no intent or camera grant replays.
  if(closed||status!=='online'||recovery||clock()<retryAt||!canRecover()||transport.connected||transport.state==='starting'||typeof bridge.reconnect!=='function')return;
  recovery=Promise.resolve().then(()=>{
   if(closed||snapshot().status!=='online'||!canRecover())return;
   return bridge.reconnect();
  }).then(()=>{recoveryFailures=0;retryAt=0;},()=>{retryAt=clock()+Math.min(30000,1000*2**Math.min(recoveryFailures++,5));}).finally(()=>{recovery=null;notify();});
  notify();
 }
 function check(){
  if(closed)return Promise.resolve(snapshot());if(flight)return flight;
  abort=new AbortController();
  flight=(async()=>{
   try{
    const response=await fetchFn('http://127.0.0.1:8767/daemon/devices',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(timeoutMs)]),cache:'no-store'});
    if(!response.ok)throw new Error('daemon_unavailable');
    const result=await response.json();if(typeof result.device?.online!=='boolean')throw new Error('daemon_unavailable');
    if(closed)return snapshot();checkedAt=clock();status=result.device.online?'online':'offline';reason=result.device.online?null:'robot_offline';if(result.device.online)lastOnlineAt=checkedAt;
   }catch{if(closed)return snapshot();checkedAt=clock();status='unavailable';reason='daemon_unavailable';}
   notify();recover();return snapshot();
  })().finally(()=>{flight=null;abort=null;});return flight;
 }
 async function tick(){await check();if(!closed){timer=setTimeout(tick,intervalMs);timer.unref?.();}}
 return {snapshot,check,start(){if(!timer&&!flight&&!closed)tick();},async close(){closed=true;clearTimeout(timer);abort?.abort();if(flight)await flight;}};
}
