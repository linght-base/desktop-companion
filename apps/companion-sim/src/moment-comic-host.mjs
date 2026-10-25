// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {estimateContextTokens} from './pi-continuity.mjs';

/** Host scheduling and presentation for Pi-selected generated illustrations.
 * This adapter owns no decision loop: selection is a job in the existing Pi. */
export function createMomentComicHost({store,provider,controller,clock=Date.now,showNative=async()=>({status:'unavailable',reason:'native_image_transport_unavailable'}),hideNative=async()=>{},onChange=()=>{}}){
 let closed=false,lastPoll=-Infinity,rendering=null,imageFailure=null,view={mode:'face',imageId:null},native={status:'deferred',reason:'native_gallery_deferred_by_user'},generation=0;
 const scope=()=>({enabled:controller.enabled&&!controller.closed,epoch:controller.epoch,deskId:controller.profile().deskId});
 const current=c=>!closed&&scope().enabled&&scope().epoch===c.epoch&&scope().deskId===c.deskId;
 const changed=()=>{if(!closed){onChange();controller.publish();}};
 const safeReason=error=>typeof error?.code==='string'&&/^[a-z_]{1,70}$/.test(error.code)?error.code:'image_generation_failed';
 function enqueue(claim){
  if(controller.queuedCount()>=40){store.release(claim.id,{claimToken:claim.claimToken,reason:'queue_full'});return false;}
  const all=claim.candidates??[],ordered=[...all].sort((a,b)=>(a.observedAt??0)-(b.observedAt??0)),spaced=ordered.length<=12?ordered:Array.from({length:12},(_,i)=>ordered[Math.round(i*(ordered.length-1)/11)]),candidates=[];
  for(const item of spaced)if(estimateContextTokens([...candidates,item])<12000)candidates.push(item);
  controller.queue({kind:'diary',at:clock(),claim:{...claim,type:'moment_comic'},payload:{kind:'moment',jobId:claim.id,candidates,omittedCandidates:all.length-candidates.length,startAt:claim.startAt,endAt:claim.endAt}});return true;
 }
 function resetView(reason='face'){
  if(view.mode==='face')return;
  generation++;view={mode:'face',imageId:null};native={status:'idle',reason};
  Promise.resolve(hideNative()).catch(()=>{});changed();
 }
 function snapshot(){
  const c=scope(),state=store.snapshot({deskId:c.deskId});
  const items=(state.items??[]).slice(0,5).map(item=>({...item,createdAt:item.createdAt??item.publishedAt??item.endAt,imageUrl:`/api/moment-comics/images/${encodeURIComponent(item.id)}`}));
  if(view.mode==='gallery'&&!items.some(item=>item.id===view.imageId)){
   generation++;view={mode:'face',imageId:null};native={status:'idle',reason:'selection_removed'};Promise.resolve(hideNative()).catch(()=>{});
  }
  return {...state,items,view:{...view,index:items.findIndex(item=>item.id===view.imageId)},native:{...native},imageProvider:{...(provider?.status?.()??{configured:false}),failure:imageFailure},rendering:Boolean(rendering)};
 }
 async function present(){
  const s=snapshot(),item=s.items.find(item=>item.id===view.imageId);if(!item)return;
  const c=scope(),ticket=++generation;
  const image=store.readImage(item.id,{deskId:c.deskId});if(!image)return resetView('image_invalidated');
  native={status:'loading',reason:null};changed();
  try{
   const result=await showNative({...image,imageId:item.id,encouragement:item.encouragement??'',index:s.view.index,total:s.items.length});
   if(ticket!==generation||!current(c)||view.imageId!==item.id)return;
   native={status:result?.status??'unconfirmed',reason:result?.reason??null};changed();
  }catch(error){if(ticket===generation){native={status:'unavailable',reason:safeReason(error)};changed();}}
 }
 async function render(pending,c){
  const work=store.claimRender({id:pending.id,renderToken:pending.renderToken},{deskId:c.deskId});if(!work)return;
  const abort=new AbortController(),token={abort,work,scope:c};rendering=token;changed();
  token.promise=(async()=>{
   try{
    const result=await provider.generate({scenePrompt:work.scenePrompt,encouragement:work.encouragement,characters:work.characters??[],referenceImage:store.referenceImage?.(work,{deskId:c.deskId})??undefined,signal:abort.signal});
    if(closed)return;
    const receipt=store.completeImage({id:work.id,renderToken:work.renderToken,mimeType:result.mimeType,bytes:result.bytes},{deskId:c.deskId,isCurrent:()=>current(c)});imageFailure=null;
    controller.record('moment_comic_result',{id:work.id,status:receipt.status??(receipt.accepted?'accepted':'rejected'),semanticStatus:'unverified_illustration'});
   }catch(error){if(!closed){const reason=abort.signal.aborted?'generation_cancelled':safeReason(error);imageFailure={code:reason,...(error.failure??{})};store.failRender({id:work.id,renderToken:work.renderToken,reason,retryable:abort.signal.aborted?false:error.failure?.retryable},{deskId:c.deskId});controller.record('moment_comic_result',{id:work.id,status:'failed',reason,failure:imageFailure});}}
   finally{if(rendering===token)rendering=null;changed();}
  })();
  return token.promise;
 }
 function tick(){
  if(closed)return;
  const c=scope();
  if(rendering&&!current(rendering.scope))rendering.abort.abort();
  if(!c.enabled){resetView('paused');return;}
  if(clock()-lastPoll<1000)return;lastPoll=clock();
  const claim=store.poll(c);
  if(claim)enqueue(claim);
  if(!rendering&&provider?.status?.().configured){const pending=store.pendingRender({deskId:c.deskId});if(pending?.length)render(pending[0],c).catch(()=>{});}
 }
 return {
  tick,snapshot,
  forgetEvidence(id){return store.forgetEvidence(id);},
  reconcile(){return store.reconcileEvidence();},
  requestNow(){const c=scope();if(!c.enabled)throw new Error('companion_paused');const claim=store.requestNow(c);if(claim)enqueue(claim);lastPoll=-Infinity;tick();changed();return {accepted:Boolean(claim),jobId:claim?.id??null,status:claim?'queued':'no_new_job'};},
  select(request,context){const c=scope();if(!current(context))return {status:'rejected',reason:'moment_scope_changed'};const receipt=store.select(request,c);lastPoll=-Infinity;changed();return receipt;},
  release(claim,reason){if(!closed)try{return store.release(claim.id,{claimToken:claim.claimToken,reason});}catch{return {released:false};}},
  readImage(id){return store.readImage(id,{deskId:scope().deskId});},
  input({action,imageId},{source='browser'}={}){
   if(!scope().enabled)return {accepted:false,reason:'companion_paused'};
   if(!['open','next','previous','select','back'].includes(action))throw new Error('invalid_gallery_action');
   if(action==='back'){resetView('user_returned');controller.record('gallery_input',{action,source});return {accepted:true,view:{...view}};}
   const s=snapshot();if(!s.items.length)return {accepted:false,reason:'no_comics'};
   const index=s.items.findIndex(item=>item.id===view.imageId),selected=action==='select'?s.items.findIndex(item=>item.id===imageId):null;
   if(selected===-1)return {accepted:false,reason:'comic_not_current'};
   const next=selected!==null?selected:view.mode==='face'?0:action==='previous'?(index-1+s.items.length)%s.items.length:action==='next'?(index+1)%s.items.length:Math.max(0,index);
   view={mode:'gallery',imageId:s.items[next].id};
   if(source==='sdk_touch'){controller.stopExpressionPlayback('gallery_open');controller.stopAttention('gallery_open');controller.body.stopExpression();controller.currentInteraction=null;controller.expressionBasis=null;}
   controller.record('gallery_input',{action,source,imageId:view.imageId});changed();present().catch(()=>{});return {accepted:true,view:{...view,index:next}};
  },
  async close(){if(closed)return;resetView('closed');closed=true;rendering?.abort.abort();if(rendering?.promise){let timer;try{await Promise.race([rendering.promise,new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}}store.close();}
 };
}
