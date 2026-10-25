// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createVideoIngress} from './video-ingress.mjs';
import {fields,number} from './contracts.mjs';
const helper=fileURLToPath(new URL('../../../scripts/companion_robot_webrtc.py',import.meta.url));
const python=fileURLToPath(new URL('../../../.runtime/companion-webrtc-venv/bin/python',import.meta.url));
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const senderFailures={robot_webrtc_input_overflow:'ipc',robot_webrtc_invalid_message:'ipc',robot_webrtc_invalid_init:'ipc',robot_webrtc_parent_closed:'ipc',robot_webrtc_sender_pipe_failed:'ipc',robot_webrtc_sender_stdout_failed:'ipc',robot_webrtc_message_overflow:'ipc',robot_webrtc_message_invalid:'ipc',robot_webrtc_frame_decode_failed:'media',robot_webrtc_negotiation_failed:'webrtc',robot_webrtc_peer_failed:'webrtc',robot_webrtc_disconnected_timeout:'webrtc',robot_webrtc_setup_timeout:'webrtc',robot_webrtc_runtime_unavailable:'runtime',robot_webrtc_sender_unavailable:'runtime',robot_webrtc_sender_closed:'process',robot_webrtc_sender_failed:'process'};
const safeExit=code=>Number.isInteger(code)&&code>=-255&&code<=255?code:null;
const safeSignal=signal=>['SIGTERM','SIGKILL','SIGSEGV','SIGABRT','SIGINT','SIGHUP','SIGPIPE'].includes(signal)?signal:null;
export function createRobotVideoIngress({controller,bridge,clock=Date.now,onChange=()=>{},pythonPath=python,spawnSender=spawn,videoIngressFactory=createVideoIngress}){
 let preview=null,latest=null,sender=null,closed=false,pendingFrame=null,sharing=null;
 let senderOwner=null,senderDiagnostic={state:'idle',category:null,reason:null,connectionState:null,exitCode:null,signal:null,receiverReason:null};
 const inner=videoIngressFactory({controller,clock,onChange:()=>onChange(snapshot())});
 const snapshot=()=>({...inner.snapshot(),source:'robot-sdk',previewActive:Boolean(preview),previewId:preview?.id??null,previewFrames:preview?.count??0,lastPreviewAt:latest?.at??null,sharingActive:Boolean(sharing&&sender),deviceTransport:'sdk_inference_preview',maskCount:sharing?.masks.length??0,sender:{...senderDiagnostic}});
 const changed=()=>{try{onChange(snapshot());}catch{}};
 function write(value){if(sender&&!sender.stdin.destroyed)try{sender.stdin.write(JSON.stringify(value)+'\n');}catch{sharing?.fail?.('robot_webrtc_sender_pipe_failed');}}
 const accept=frame=>{
  if(!preview||closed||!bridge.snapshot().connected)return;
  if(!frame||typeof frame.data!=='string'||frame.data.length>400000||!Number.isSafeInteger(frame.at)||frame.at<preview.startedAt||clock()-frame.at>2000)return;
  const bytes=Buffer.from(frame.data,'base64');if(bytes.length>300000||bytes[0]!==255||bytes[1]!==216)return;
  if(!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<1||frame.height<1||frame.width>4096||frame.height>4096)return;
  latest={...frame,bytes};preview.count++;
  if(sender&&sharing&&sharing.epoch===controller.epoch&&controller.enabled&&frame.at>=sharing.startedAt){
   const message={type:'frame',at:frame.at,data:frame.data};
   if(sender.stdin.writableNeedDrain)pendingFrame=message;else write(message);
  }
  if(preview.count===1||preview.count%8===0)changed();
 };
 async function startPreview({epoch}={}){
  if(closed||!controller.enabled||epoch!==controller.epoch)throw fail('robot_preview_inactive');
  if(!bridge.snapshot().connected)throw fail('robot_disconnected');
  if(preview)throw fail('robot_preview_in_use');
  const current={id:randomUUID(),epoch,startedAt:clock(),count:0};preview=current;latest=null;
  try{await bridge.request('camera_start',{}, {timeoutMs:12000});if(preview!==current||controller.epoch!==epoch){await bridge.request('camera_stop').catch(()=>{});throw fail('robot_preview_cancelled');}changed();return {previewId:current.id};}
  catch(error){if(preview===current){preview=null;latest=null;}throw error;}
 }
 function frame(previewId){if(!preview||preview.id!==previewId||!latest||clock()-latest.at>2000)throw fail('robot_preview_frame_unavailable',404);return {bytes:latest.bytes,at:latest.at,sequence:latest.sequence};}
 function stopSharing(reason='user_stop'){
  const old=sender;sender=null;sharing=null;pendingFrame=null;
  if(senderDiagnostic.state!=='error')senderDiagnostic={...senderDiagnostic,state:'stopped'};
  if(old){old.stdin.destroy();old.kill('SIGTERM');const t=setTimeout(()=>old.kill('SIGKILL'),1000);t.unref();old.once('exit',()=>clearTimeout(t));}
  inner.stop(reason);changed();
 }
 async function share(input){
  fields(input,['epoch','previewId','masks'],'robot_share');
  if(!preview||preview.id!==input.previewId||!controller.enabled||input.epoch!==controller.epoch||!latest)throw fail('robot_preview_inactive');
  if(!Array.isArray(input.masks)||input.masks.length>16)throw fail('invalid_privacy_masks',400);
  for(const mask of input.masks){fields(mask,['x','y','width','height'],'mask');for(const key of ['x','y','width','height'])number(mask[key],0,1,key);if(mask.width<=0||mask.height<=0||mask.x+mask.width>1||mask.y+mask.height>1)throw fail('invalid_privacy_masks',400);}
  stopSharing('sharing_replaced');
  if(input.masks.length){controller.stopAttention('privacy_mask_lock');controller.body.stopHead();controller.publish();}
  const scale=Math.min(1,640/latest.width,480/latest.height),width=Math.max(1,Math.round(latest.width*scale)),height=Math.max(1,Math.round(latest.height*scale));
  const current={epoch:input.epoch,startedAt:clock(),masks:structuredClone(input.masks)};sharing=current;
  const child=spawnSender(pythonPath,['-u',helper],{stdio:['pipe','pipe','pipe']});sender=child;child.stderr.resume();let buffer='';
  senderOwner=child;senderDiagnostic={state:'starting',category:null,reason:null,connectionState:null,exitCode:null,signal:null,receiverReason:null};
  child.stdin.on('error',()=>current.fail?.('robot_webrtc_sender_pipe_failed'));child.stdin.on('drain',()=>{if(sender===child&&pendingFrame){const next=pendingFrame;pendingFrame=null;write(next);}});
  const answer=await new Promise((resolve,reject)=>{
   const senderFailed=reason=>{
    if(sender!==child||sharing!==current)return;
    const code=typeof reason==='string'&&Object.hasOwn(senderFailures,reason)?reason:'robot_webrtc_sender_failed',receiverReason=inner.snapshot().reason;
    senderDiagnostic={...senderDiagnostic,state:'error',reason:code,category:senderFailures[code],receiverReason:typeof receiverReason==='string'&&/^[a-z_]{1,80}$/.test(receiverReason)?receiverReason:null};
    clearTimeout(timer);reject(fail(code));stopSharing(code);
   };
   const timer=setTimeout(()=>senderFailed('robot_webrtc_setup_timeout'),12000);timer.unref();current.fail=senderFailed;
   child.on('error',()=>senderFailed('robot_webrtc_sender_unavailable'));
   child.on('exit',(code,signal)=>{if(senderOwner===child){senderDiagnostic={...senderDiagnostic,exitCode:safeExit(code),signal:safeSignal(signal)};changed();}});
   // close follows stdout draining, so the helper's typed final error wins over
   // a generic process exit and diagnostics never publish stderr or SDP.
   child.on('close',(code,signal)=>{if(senderOwner===child)senderDiagnostic={...senderDiagnostic,exitCode:safeExit(code),signal:safeSignal(signal)};senderFailed('robot_webrtc_sender_closed');});
   child.stdout.on('error',()=>senderFailed('robot_webrtc_sender_stdout_failed'));
   child.stdout.on('data',data=>{
    if(sender!==child||sharing!==current)return;
    buffer+=data.toString('utf8');if(buffer.length>200000){senderFailed('robot_webrtc_message_overflow');return;}
    let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let value;try{value=JSON.parse(line);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();}catch{senderFailed('robot_webrtc_message_invalid');return;}
     if(sender!==child||sharing!==current)return;
     if(value.type==='offer')inner.negotiate({type:'offer',sdp:value.sdp,epoch:current.epoch,startedAt:current.startedAt,width,height,frameRate:8},{admittedEpoch:current.epoch}).then(result=>{if(sender!==child||sharing!==current)return;write({type:'answer',sdp:result.sdp});if(sender!==child)return;clearTimeout(timer);resolve(result);}).catch(()=>senderFailed('robot_webrtc_negotiation_failed'));
     else if(value.type==='error')senderFailed(value.reason);
     else if(value.type==='closed')senderFailed('robot_webrtc_sender_closed');
     else if(value.type==='state'&&['new','connecting','connected','disconnected','failed','closed'].includes(value.state)){senderDiagnostic={...senderDiagnostic,connectionState:value.state,state:value.state==='connected'?'active':'starting'};changed();}
     else senderFailed('robot_webrtc_message_invalid');
    }
   });
   write({type:'init',width,height,startedAt:current.startedAt,masks:current.masks});
  }).catch(error=>{if(sharing===current)stopSharing('robot_webrtc_failed');throw error;});
  changed();return answer;
 }
 function stop(reason='stopped'){stopSharing(reason);preview=null;latest=null;if(!closed)bridge.request('camera_stop',{}, {timeoutMs:4000}).catch(()=>{});changed();}
 return {snapshot,setPresenceDetection:enabled=>inner.setPresenceDetection(enabled),physicalMotionAllowed:()=>!sharing?.masks.length,acceptFrame:accept,startPreview,frame,share,stop,stopPreview(id){if(preview?.id!==id)return false;stop('user_stop');return true;},stopStream(id,reason){if(!sender||inner.snapshot().streamId!==id)return false;stopSharing(reason);return true;},negotiate(){throw fail('robot_camera_uses_native_webrtc');},async close(){if(closed)return;stop('closed');closed=true;await inner.close();}};
}
