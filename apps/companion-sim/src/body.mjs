// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { OBSERVATION_MAX_AGE, validateIntent, fields, number } from './contracts.mjs';
const resting = () => ({source:'simulation',head:{yaw:0,pitch:0},eyes:{gazeX:0,gazeY:0,openness:.55,tilt:0,roundness:.7,color:'#A9DDE9'},icon:'none',gesture:'idle',activeCommandId:null,leaseUntil:0});
export class SimulatedBody {
  constructor({clock = Date.now} = {}) {this.clock=clock;this.armed=false;this.epoch=0;this.state=resting();this.headUntil=0;this.expressionUntil=0;this.gazeUntil=0;this.gazeCommandId=null;this.gazeBase=null;this.headCommandId=null;this.expressionCommandId=null;this.pendingReceipts=[];}
  arm(epoch) {this.epoch=epoch;this.armed=true;}
  /** Explicit host-only simulator input; never arms autonomous motion or invents an observation. */
  previewHead(input) {
    try {fields(input,['yaw','pitch','durationMs'],'head_preview');number(input.yaw,-45,45,'yaw');number(input.pitch,-20,20,'pitch');number(input.durationMs,100,5000,'duration');}
    catch(error){return this.receipt('rejected',error.message);}
    if(this.armed)return this.receipt('rejected','preview_requires_paused_body');
    this.expireChannels();
    const receipt=this.receipt('accepted','manual_simulation_preview');
    this.state.head={yaw:input.yaw,pitch:input.pitch};this.headUntil=this.clock()+input.durationMs;this.headCommandId=receipt.id;this.syncLeaseState();
    return receipt;
  }
  receipt(status,reason,basisObservationId,id=randomUUID()) {return {id,status,at:this.clock(),reason,...(basisObservationId?{basisObservationId}:{})};}
  authorize(input,context) {
    let intent;try {intent=validateIntent(input);} catch(e) {return {error:this.receipt('rejected',e.message)};}
    const fail=reason=>({error:this.receipt('rejected',reason,intent.basisObservationId)});
    if (!this.armed) return fail('body_stopped');
    if (context.epoch!==this.epoch) return fail('stale_epoch');
    if (intent.basisObservationId!==context.observationId) return fail('observation_mismatch');
    const age=this.clock()-context.observedAt;
    if (!Number.isFinite(age)||age< -1000||age>OBSERVATION_MAX_AGE) return fail('stale_observation');
    if(intent.responseWindowMs!==undefined&&this.clock()>=context.observedAt+intent.responseWindowMs)return fail('response_window_expired');
    if(context.leaseUntil!==undefined&&(!Number.isFinite(context.leaseUntil)||context.leaseUntil<=this.clock()))return fail('lease_expired');
    return {intent};
  }
  apply(input, context) {
    const {intent,error}=this.authorize(input,context);if(error)return error;
    this.expireChannels();
    const receipt=this.receipt('accepted','simulation_applied',intent.basisObservationId);
    const until=Math.min(this.clock()+intent.durationMs,context.leaseUntil??Infinity,intent.responseWindowMs===undefined?Infinity:context.observedAt+intent.responseWindowMs);
    if(intent.head){this.headUntil=until;this.headCommandId=receipt.id;}
    this.stopGaze();
    this.expressionUntil=until;this.expressionCommandId=receipt.id;
    this.state={source:'simulation',head:{...this.state.head,...intent.head},eyes:{...this.state.eyes,...intent.eyes},icon:intent.icon??'none',gesture:intent.gesture??'idle',activeCommandId:receipt.id,leaseUntil:Math.max(this.headUntil,this.expressionUntil)};
    this.syncLeaseState();return receipt;
  }
  /** Update a recipe frame in-place: same receipt, same deadline, no joint permission. */
  updateExpression(frame,context){
    try{fields(frame,['eyes','icon','gesture'],'expression_frame');}catch(error){return this.receipt('rejected',error.message);}
    const {intent,error}=this.authorize({...frame,basisObservationId:context.observationId,durationMs:100},context);if(error)return error;
    this.expireChannels();
    if(!context.commandId||context.commandId!==this.expressionCommandId||this.expressionUntil<=this.clock())return this.receipt('rejected','expression_superseded');
    this.stopGaze();
    this.state.eyes={...this.state.eyes,...intent.eyes};
    if(intent.icon!==undefined)this.state.icon=intent.icon;
    if(intent.gesture!==undefined)this.state.gesture=intent.gesture;
    return this.receipt('accepted','expression_frame_applied',intent.basisObservationId,context.commandId);
  }
  stopExpression(commandId,reason='expression_stopped'){
    this.expireChannels();
    if(!commandId||commandId!==this.expressionCommandId)return null;
    this.expressionUntil=0;this.expressionCommandId=null;
    const idle=resting();this.state.eyes=this.gazeUntil?{...idle.eyes,gazeX:this.state.eyes.gazeX,gazeY:this.state.eyes.gazeY}:idle.eyes;
    if(this.gazeBase)this.gazeBase={gazeX:idle.eyes.gazeX,gazeY:idle.eyes.gazeY,until:0};
    this.state.icon=idle.icon;this.state.gesture=idle.gesture;this.syncLeaseState();
    return this.receipt('cancelled',reason,undefined,commandId);
  }
  /** Camera motion owns the shared joint, never the screen's expression lease. */
  moveHead(input,context) {
    const {intent,error}=this.authorize(input,context);if(error)return error;
    this.expireChannels();
    const receipt=this.receipt('accepted','simulation_applied',intent.basisObservationId);
    this.headUntil=Math.min(this.clock()+intent.durationMs,context.leaseUntil??Infinity);this.headCommandId=receipt.id;
    this.state={...this.state,head:{...this.state.head,...intent.head},activeCommandId:receipt.id,leaseUntil:Math.max(this.headUntil,this.expressionUntil)};
    this.syncLeaseState();return receipt;
  }
  /** Local gaze is a separate short lease; it cannot renew a reminder expression. */
  moveGaze(input,context) {
    const {intent,error}=this.authorize(input,context);if(error)return error;
    this.expireChannels();
    const receipt=this.receipt('accepted','simulation_applied',intent.basisObservationId);
    this.gazeBase??={gazeX:this.state.eyes.gazeX,gazeY:this.state.eyes.gazeY,until:this.expressionUntil};
    this.gazeUntil=Math.min(this.clock()+intent.durationMs,context.leaseUntil??Infinity);this.gazeCommandId=receipt.id;
    this.state.eyes={...this.state.eyes,gazeX:intent.eyes?.gazeX??0,gazeY:intent.eyes?.gazeY??0};
    this.syncLeaseState();return receipt;
  }
  stopGaze(){
    this.gazeUntil=0;this.gazeCommandId=null;
    if(this.gazeBase){
      // The underlying expression may expire while its gaze is covered, even before tick.
      const base=this.gazeBase.until&&this.clock()>=this.gazeBase.until?resting().eyes:this.gazeBase;
      this.state.eyes={...this.state.eyes,gazeX:base.gazeX,gazeY:base.gazeY};
    }
    this.gazeBase=null;this.syncLeaseState();
  }
  syncLeaseState() {
    this.state.leaseUntil=Math.max(this.headUntil,this.expressionUntil,this.gazeUntil);
    this.state.activeCommandId=this.headUntil>=this.expressionUntil?(this.headCommandId??this.expressionCommandId):this.expressionCommandId;
  }
  stopHead() {
    const id=this.headCommandId;
    this.headUntil=0;this.headCommandId=null;this.state.head={yaw:0,pitch:0};this.syncLeaseState();
    if(id && id!==this.expressionCommandId)this.pendingReceipts.push(this.receipt('cancelled','head_stopped',undefined,id));
  }
  stop(reason='stopped') {
    const id=this.state.activeCommandId;this.armed=false;this.headUntil=0;this.expressionUntil=0;
    this.headCommandId=null;this.expressionCommandId=null;this.gazeUntil=0;this.gazeCommandId=null;this.gazeBase=null;this.pendingReceipts=[];this.state=resting();
    return this.receipt('cancelled',reason,undefined,id??randomUUID());
  }
  expireChannels() {
    const now=this.clock(),expired=new Set();
    if(this.headUntil && now>=this.headUntil){expired.add(this.headCommandId);this.headCommandId=null;this.headUntil=0;this.state.head={yaw:0,pitch:0};}
    if(this.gazeUntil && now>=this.gazeUntil)this.stopGaze();
    if(this.expressionUntil && now>=this.expressionUntil){
      expired.add(this.expressionCommandId);this.expressionCommandId=null;this.expressionUntil=0;
      const idle=resting();this.state.eyes=this.gazeUntil?{...idle.eyes,gazeX:this.state.eyes.gazeX,gazeY:this.state.eyes.gazeY}:idle.eyes;this.state.icon=idle.icon;this.state.gesture=idle.gesture;
    }
    this.syncLeaseState();
    for(const id of expired)if(id && id!==this.headCommandId && id!==this.expressionCommandId)this.pendingReceipts.push(this.receipt('completed','lease_expired',undefined,id));
  }
  tick() {this.expireChannels();return this.pendingReceipts.shift()??null;}
  snapshot() {return structuredClone(this.state);}
}
