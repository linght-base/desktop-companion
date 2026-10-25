// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// Bounded SSE latest-state hub: encodes each state once and offers every
// subscriber only the newest payload it can accept, never replaying history.
function encode(state){
  const message=`event: state\ndata: ${JSON.stringify(state)}\n\n`;
  return {message,bytes:Buffer.byteLength(message,'utf8')};
}
export function createStateStreamHub({stallMs=500,maxEventBytes=4000000}={}){
  if(!Number.isInteger(stallMs)||stallMs<50||stallMs>10000)throw new RangeError('invalid_stall_ms');
  if(!Number.isInteger(maxEventBytes)||maxEventBytes<1024||maxEventBytes>16000000)throw new RangeError('invalid_max_event_bytes');
  const clients=new Map();
  let closed=false;
  const assertOpen=()=>{if(closed)throw new Error('state_stream_closed');};
  function cleanup(client){
    if(clients.get(client.response)!==client)return;
    clients.delete(client.response);
    if(client.stallTimer){clearTimeout(client.stallTimer);client.stallTimer=null;}
    client.response.removeListener('drain',client.onDrain);
    client.response.removeListener('close',client.onEnd);
    client.response.removeListener('error',client.onEnd);
    client.pending=null;client.waitingDrain=false;
  }
  function write(client,message){
    if(clients.get(client.response)!==client)return;
    if(client.response.writableEnded||client.response.destroyed){cleanup(client);return;}
    let ok;
    try{ok=client.response.write(message);}catch{cleanup(client);return;}
    if(clients.get(client.response)!==client)return;
    if(ok===false){
      client.waitingDrain=true;client.pending=null;
      if(client.stallTimer)clearTimeout(client.stallTimer);
      client.stallTimer=setTimeout(()=>{
        client.stallTimer=null;
        if(clients.get(client.response)!==client)return;
        try{if(typeof client.response.destroy==='function')client.response.destroy();}catch{}
        cleanup(client);
      },stallMs);
      if(typeof client.stallTimer.unref==='function')client.stallTimer.unref();
    }
  }
  function onDrain(client){
    if(clients.get(client.response)!==client||!client.waitingDrain)return;
    client.waitingDrain=false;
    if(client.stallTimer){clearTimeout(client.stallTimer);client.stallTimer=null;}
    const pending=client.pending;client.pending=null;
    if(pending!==null)write(client,pending);
  }
  function subscribe(response,initialState){
    assertOpen();
    if(!response||typeof response.write!=='function'||typeof response.on!=='function'||typeof response.removeListener!=='function')throw new TypeError('invalid_response');
    if(clients.has(response))throw new Error('duplicate_subscription');
    const {message,bytes}=encode(initialState);
    if(bytes>maxEventBytes)throw new RangeError('state_event_too_large');
    const client={response,pending:null,waitingDrain:false,stallTimer:null};
    client.onDrain=()=>onDrain(client);
    client.onEnd=()=>cleanup(client);
    clients.set(response,client);
    response.on('drain',client.onDrain);
    response.on('close',client.onEnd);
    response.on('error',client.onEnd);
    write(client,message);
    return ()=>cleanup(client);
  }
  function publish(state){
    assertOpen();
    const {message,bytes}=encode(state);
    if(bytes>maxEventBytes)throw new RangeError('state_event_too_large');
    for(const client of [...clients.values()]){
      if(clients.get(client.response)!==client)continue;
      if(client.waitingDrain)client.pending=message;
      else write(client,message);
    }
  }
  function close(){
    if(closed)return;
    closed=true;
    for(const client of [...clients.values()]){
      const response=client.response;
      cleanup(client);
      try{if(!response.writableEnded&&!response.destroyed&&typeof response.end==='function')response.end();}catch{}
    }
  }
  return {subscribe,publish,close};
}
