// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { OBSERVATION_MAX_AGE, fields, identifier, number } from './contracts.mjs';

const PROFILES = {
  'integrated-sim': {kind:'simulated',motion:'simulated',presentation:'robot'},
  'integrated-device': {kind:'robot-camera',motion:'hardware',presentation:'robot'},
  'fixed-pet': {kind:'fixed',motion:'unsupported',presentation:'lpet'},
  'ptz-sim-pet': {kind:'simulated-ptz',motion:'simulated',presentation:'lpet'},
  'pocket-uvc-pet': {kind:'pocket-uvc',motion:'unsupported',presentation:'lpet'},
  'external-ptz-pet': {kind:'external-ptz',motion:'driver',presentation:'lpet'}
};

function validateProfile(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES,profile)) throw new Error('invalid_profile');
}

function validateMove(input) {
  fields(input,['yaw','pitch','durationMs','basisObservationId'],'camera_move');
  identifier(input.basisObservationId,'observation_id');
  number(input.yaw,-45,45,'yaw');
  number(input.pitch,-20,20,'pitch');
  number(input.durationMs,100,5000,'duration');
  return {...input};
}

function validateReported(result) {
  if (result?.status !== 'completed' || result?.source !== 'reported') throw new Error('invalid_driver_feedback');
  number(result.pose?.yaw,-45,45,'yaw');
  number(result.pose?.pitch,-20,20,'pitch');
  return {yaw:result.pose.yaw,pitch:result.pose.pitch,source:'reported'};
}

/** Integrated virtual camera shares the head joint; separate PTZ stays independent. */
export function createRigManager({profile='integrated-sim',clock=Date.now,ptzDriver=null,deviceState=()=>({})} = {}) {
  validateProfile(profile);
  let generation=0;
  let commandRevision=0;
  let latestEpoch=-1;
  let active=null;
  let lastError=null;
  let camera;
  let headBody=null;
  const coupled=()=>['integrated-sim','integrated-device'].includes(profile) && headBody!==null;

  function configureCamera() {
    const definition=PROFILES[profile];
    let motion=definition.motion;
    if (motion==='driver') {
      let verified=false;
      try {
        const capabilities=ptzDriver?.capabilities();
        verified=capabilities?.verified===true && capabilities.panTilt===true &&
          capabilities.poseFeedback===true && capabilities.stop===true &&
          typeof ptzDriver.move==='function' && typeof ptzDriver.stop==='function';
      } catch { /* Unknown capabilities never grant physical motion. */ }
      if (!verified) {motion='unsupported';lastError='ptz_driver_unavailable';}
    }
    const supported=motion!=='unsupported';
    camera={
      id:`browser-${profile}`,kind:definition.kind,videoInput:'browser',motion,
      physicalCameraMoves:motion==='driver',
      pose:{yaw:0,pitch:0,source:motion==='simulated'?'simulated':'unknown'},
      capabilities:{panTilt:supported,poseFeedback:supported,stop:supported}
    };
  }

  function receipt(status,reason,basisObservationId,id=randomUUID()) {
    return {id,status,at:clock(),reason,...(basisObservationId?{basisObservationId}:{})};
  }

  function requestDriverStop() {
    const stopGeneration=generation;
    const stopRevision=commandRevision;
    const stopCamera=camera;
    const failed=()=>{
      if(generation===stopGeneration && commandRevision===stopRevision && camera===stopCamera) lastError='ptz_stop_failed';
    };
    try {Promise.resolve(ptzDriver.stop()).catch(failed);} catch {failed();}
  }

  function clearOperation(operation) {
    clearTimeout(operation.timer);
    if (active===operation) active=null;
  }

  function cancelActive(reason) {
    const operation=active;
    if (!operation) return false;
    clearOperation(operation);
    operation.abort.abort();
    if(operation.motion==='driver') {
      requestDriverStop();
      operation.resolve(receipt('cancelled',reason,operation.input.basisObservationId,operation.id));
    } else camera.pose={yaw:0,pitch:0,source:'simulated'};
    return operation.motion==='driver';
  }

  function expire() {
    if(active && clock()>=active.until) cancelActive('camera_lease_expired');
  }

  function currentContext(context) {
    if(context?.enabled!==true || !Number.isSafeInteger(context.epoch) || context.epoch<0) return false;
    if(context.epoch<latestEpoch) return false;
    if(context.isCurrent!==undefined) {
      if(typeof context.isCurrent!=='function') return false;
      try {if(context.isCurrent()!==true) return false;} catch {return false;}
    }
    const age=clock()-context.observedAt;
    return typeof context.observedAt==='number' && context.observedAt>=0 && Number.isFinite(age) && age>=-1000 && age<=OBSERVATION_MAX_AGE;
  }

  function snapshot() {
    expire();
    if(profile==='integrated-device'){
      const live=deviceState();camera.capabilities={panTilt:live.connected===true&&live.capabilities?.includes('motion'),poseFeedback:false,stop:live.connected===true};
      camera.physicalCameraMoves=true;camera.limits={yaw:[-45,45],pitch:[-15,15]};
    }
    if(coupled()){if(profile==='integrated-device'){const output=deviceState().output?.head;camera.pose=output?.confirmedTarget?{...output.confirmedTarget,source:'commanded',completedAt:output.confirmedAt}:{yaw:0,pitch:0,source:'unknown'};}else camera.pose={...headBody.snapshot().head,source:'simulated'};}
    return structuredClone({
      profile,generation,camera,
      presentation:{kind:PROFILES[profile].presentation,mode:profile==='integrated-device'?'sdk-hardware':'browser-preview',headControlsCamera:coupled()},lastError
    });
  }

  function stop(reason='stopped') {
    // This is software cancellation; it does not assert a physical stop acknowledgement.
    generation++;
    if(coupled()) headBody.stopHead();
    const requestedStop=cancelActive('camera_stopped');
    if(camera.motion==='driver' && !requestedStop) requestDriverStop();
    if(camera.motion==='simulated') camera.pose={yaw:0,pitch:0,source:'simulated'};
  }

  function select(nextProfile) {
    validateProfile(nextProfile);
    stop('profile_changed');
    profile=nextProfile;
    lastError=null;
    configureCamera();
    return snapshot();
  }

  function moveCamera(input,context) {
    let intent;
    try {intent=validateMove(input);} catch(error) {
      return Promise.resolve(receipt('rejected',error.message));
    }
    const reject=reason=>Promise.resolve(receipt('rejected',reason,intent.basisObservationId));
    expire();
    if(profile==='integrated-device'&&(!deviceState().connected||Math.abs(intent.pitch)>15))return reject('hardware_unavailable_or_out_of_range');
    if(camera.motion==='unsupported') return reject('camera_motion_unsupported');
    if(!currentContext(context)) return reject('camera_context_stale_or_disabled');
    if(intent.basisObservationId!==context.observationId) return reject('observation_mismatch');
    latestEpoch=context.epoch;
    if(coupled()) {
      const result=headBody.moveHead({basisObservationId:intent.basisObservationId,durationMs:intent.durationMs,head:{yaw:intent.yaw,pitch:intent.pitch}},context);
      return Promise.resolve({...result,reason:result.status==='accepted'?profile==='integrated-device'?'host_head_intent_accepted':'simulated_shared_head_applied':result.reason});
    }
    cancelActive('camera_superseded');
    commandRevision++;
    const id=randomUUID();
    const operation={id,input:intent,motion:camera.motion,generation,abort:new AbortController(),until:clock()+intent.durationMs};
    active=operation;
    operation.timer=setTimeout(()=>{
      if(active===operation) cancelActive('camera_lease_expired');
    },intent.durationMs);
    lastError=null;

    if(camera.motion==='simulated') {
      camera.pose={yaw:intent.yaw,pitch:intent.pitch,source:'simulated'};
      operation.timer.unref?.();
      return Promise.resolve(receipt('accepted','simulated_camera_applied',intent.basisObservationId,id));
    }

    return new Promise(resolve=>{
      operation.resolve=resolve;
      const finish=(result,failed=false)=>{
        if(active!==operation || operation.generation!==generation || operation.abort.signal.aborted) return;
        if(clock()>=operation.until || !currentContext(context)) {
          cancelActive('camera_context_expired');
          return;
        }
        let pose;
        try {if(failed) throw new Error('driver_failed');pose=validateReported(result);} catch {
          clearOperation(operation);
          operation.abort.abort();
          requestDriverStop();
          lastError='ptz_driver_failed';
          resolve(receipt('rejected','ptz_driver_failed',intent.basisObservationId,id));
          return;
        }
        clearOperation(operation);
        camera.pose=pose;
        lastError=null;
        resolve(receipt('completed','camera_pose_reported',intent.basisObservationId,id));
      };
      try {
        const output=ptzDriver.move({yaw:intent.yaw,pitch:intent.pitch,durationMs:intent.durationMs},{signal:operation.abort.signal});
        Promise.resolve(output).then(result=>finish(result),()=>finish(null,true));
      } catch {finish(null,true);}
    });
  }

  configureCamera();
  return {snapshot,select,moveCamera,stop,attachBody(body){headBody=body;}};
}
