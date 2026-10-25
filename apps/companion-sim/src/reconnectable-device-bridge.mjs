// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {createDeviceBridge} from './device-bridge.mjs';

/** An explicit user reconnect swaps a terminal transport; no automatic restart or command replay. */
export function createReconnectableDeviceBridge({factory=createDeviceBridge,...options}={}){
 let generation=0,closed=false,reconnecting=null,unavailableReason=null;
 const make=()=>{const ticket=++generation;return factory({...options,onChange:value=>{if(ticket===generation&&!closed)options.onChange?.(value);},onFrame:value=>{if(ticket===generation&&!closed)options.onFrame?.(value);}});};
 let current=make();
 return {
  start:()=>current.start(),snapshot:()=>({...current.snapshot(),...(unavailableReason?{connected:false,state:'disconnected',error:unavailableReason}:{})}),request:(...args)=>unavailableReason?Promise.reject(new Error('robot_disconnected')):current.request(...args),
  invalidate(reason='robot_offline'){if(closed||unavailableReason)return;unavailableReason=reason;generation++;current.close().catch(()=>{});},stop:(...args)=>current.stop(...args),
  reconnect(){
   if(closed)return Promise.reject(new Error('bridge_closed'));
   if(!unavailableReason&&current.snapshot().connected)return Promise.resolve(current.snapshot());
   if(reconnecting)return reconnecting;
   reconnecting=(async()=>{await current.close();if(closed)throw new Error('bridge_closed');unavailableReason=null;current=make();await current.start();return current.snapshot();})().finally(()=>{reconnecting=null;});
   return reconnecting;
  },
  async close(){closed=true;generation++;await current.close();}
 };
}
