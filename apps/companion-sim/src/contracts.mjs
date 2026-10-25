// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
export const REQUEST_LIMIT = 1_800_000;
export const OBSERVATION_MAX_AGE = 10_000;
export const OBSERVATION_HISTORY_MAX_AGE = 120_000;
export function object(value, name = 'object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${name}`);
  return value;
}
export function fields(value, allowed, name) {
  object(value, name);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`unknown_${name}_field`);
}
export function number(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`invalid_${name}`);
  return value;
}
export function identifier(value, name = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) throw new Error(`invalid_${name}`);
  return value;
}
function integer(value,min,max,name){number(value,min,max,name);if(!Number.isSafeInteger(value))throw new Error(`invalid_${name}`);return value;}
/** Receiver provenance only. Counts describe transport/decode, never interpreted behavior duration. */
export function validateVideoStream(value,{frames,at}={}) {
  fields(value,['id','transport','startedAt','windowStartAt','windowEndAt','receivedFrames','decodedFrames','droppedFrames','gaps','timing','timingUncertaintyMs'],'stream');
  identifier(value.id,'stream_id');
  if(value.transport!=='webrtc')throw new Error('invalid_stream_transport');
  for(const key of ['startedAt','windowStartAt','windowEndAt'])integer(value[key],0,8.64e15,`stream_${key}`);
  if(value.startedAt>value.windowStartAt||value.windowStartAt>value.windowEndAt||value.windowEndAt-value.windowStartAt>OBSERVATION_MAX_AGE)throw new Error('invalid_stream_window');
  for(const key of ['receivedFrames','decodedFrames','droppedFrames'])integer(value[key],0,1e9,`stream_${key}`);
  // Discarded consumer candidates can also have been decoded; do not add these overlapping counters.
  if(value.decodedFrames>value.receivedFrames||value.droppedFrames>value.receivedFrames)throw new Error('invalid_stream_counts');
  if(!['rtp_pts','estimated'].includes(value.timing))throw new Error('invalid_stream_timing');
  if(value.timingUncertaintyMs!==undefined)integer(value.timingUncertaintyMs,0,30000,'stream_timing_uncertainty');
  if(!Array.isArray(value.gaps)||value.gaps.length>128)throw new Error('invalid_stream_gaps');
  let previousEnd=value.startedAt;
  for(const gap of value.gaps){
    fields(gap,['startAt','endAt','reason'],'stream_gap');
    integer(gap.startAt,value.startedAt,value.windowEndAt,'stream_gap_start');integer(gap.endAt,gap.startAt,value.windowEndAt,'stream_gap_end');
    if(gap.endAt<=gap.startAt||gap.startAt<previousEnd)throw new Error('invalid_stream_gap_order');
    if(gap.reason!==undefined&&(typeof gap.reason!=='string'||!gap.reason.trim()||gap.reason.length>300))throw new Error('invalid_stream_gap_reason');
    previousEnd=gap.endAt;
  }
  if(frames!==undefined){
    if(!Array.isArray(frames)||frames.length<1||frames.length>4||frames.length>value.decodedFrames)throw new Error('invalid_stream_frames');
    let previousAt=-Infinity;
    for(const frame of frames){integer(frame.at,value.windowStartAt,value.windowEndAt,'stream_frame_time');if(frame.at<=previousAt)throw new Error('invalid_stream_frame_order');previousAt=frame.at;if(frame.width>640||frame.height>480)throw new Error('invalid_stream_dimensions');}
  }
  if(at!==undefined){integer(at,0,8.64e15,'stream_observation_time');if(at!==value.windowEndAt)throw new Error('invalid_stream_observation_time');}
  return structuredClone(value);
}
export function validateObservation(value){return validateObservationData(value,false);}
export function validateVideoObservation(value){return validateObservationData(value,true);}
function validateObservationData(value,video) {
  fields(value, ['id', 'at', 'source', 'frames', 'coverage', 'view',...(video?['stream']:[])], 'observation');
  identifier(value.id); number(value.at, 0, 9e15, 'timestamp');
  if (!['camera', 'replay', 'synthetic'].includes(value.source)) throw new Error('invalid_source');
  if (!['visible', 'partial', 'unknown'].includes(value.coverage)) throw new Error('invalid_coverage');
  if (!Array.isArray(value.frames) || value.frames.length < 1 || value.frames.length > 4) throw new Error('invalid_frames');
  for (const frame of value.frames) {
    fields(frame, ['at', 'mimeType', 'data', 'width', 'height'], 'frame');
    number(frame.at, 0, 9e15, 'frame_timestamp');
    if (!['image/png', 'image/jpeg'].includes(frame.mimeType)) throw new Error('invalid_image_type');
    if (typeof frame.data !== 'string' || frame.data.length > 400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) throw new Error('invalid_image_data');
    const buffer = Buffer.from(frame.data, 'base64');
    if (!buffer.length || buffer.length > 300_000 || buffer.toString('base64') !== frame.data) throw new Error('invalid_image_data');
    const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    if (!(frame.mimeType === 'image/png' ? png : jpeg)) throw new Error('invalid_image_signature');
    number(frame.width, 1, 4096, 'image_width');number(frame.height, 1, 4096, 'image_height');
    if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width * frame.height > 4_194_304) throw new Error('invalid_image_dimensions');
  }
  fields(value.view, ['yaw', 'pitch', 'physicalCameraMoves', 'poseSource'], 'view');
  if(value.view.poseSource!==undefined&&!['fixed','commanded','reported'].includes(value.view.poseSource))throw new Error('invalid_pose_source');
  number(value.view.yaw, -45, 45, 'view_yaw');number(value.view.pitch, -20, 20, 'view_pitch');
  if (value.view.physicalCameraMoves !== false && !(video && value.view.physicalCameraMoves === true)) throw new Error('fixed_camera_required');
  if(video)validateVideoStream(value.stream,{frames:value.frames,at:value.at});
  return structuredClone(value);
}
export function validateIntent(value) {
  fields(value, ['basisObservationId', 'durationMs', 'responseWindowMs', 'head', 'eyes', 'icon', 'gesture'], 'intent');
  identifier(value.basisObservationId, 'observation_id');number(value.durationMs, 100, 5000, 'duration');
  if(value.responseWindowMs!==undefined)number(value.responseWindowMs,100,10000,'response_window');
  if (!value.head && !value.eyes && value.icon === undefined && value.gesture === undefined) throw new Error('empty_intent');
  if (value.head) {
    fields(value.head, ['yaw', 'pitch'], 'head');
    if (value.head.yaw !== undefined) number(value.head.yaw, -45, 45, 'yaw');
    if (value.head.pitch !== undefined) number(value.head.pitch, -20, 20, 'pitch');
  }
  if (value.eyes) {
    fields(value.eyes, ['gazeX', 'gazeY', 'openness', 'tilt', 'roundness', 'color'], 'eyes');
    const ranges = {gazeX:[-1,1],gazeY:[-1,1],openness:[.05,1.2],tilt:[-30,30],roundness:[0,1]};
    for (const [key, [min,max]] of Object.entries(ranges)) if (value.eyes[key] !== undefined) number(value.eyes[key],min,max,key);
    if (value.eyes.color !== undefined && (typeof value.eyes.color !== 'string' || !/^#[A-Fa-f0-9]{6}$/.test(value.eyes.color))) throw new Error('invalid_color');
  }
  if (value.icon !== undefined && !['none','question','sparkle','clock','check','water','movement','posture'].includes(value.icon)) throw new Error('invalid_icon');
  if (value.gesture !== undefined && !['idle','wave','jump','waiting','review'].includes(value.gesture)) throw new Error('invalid_gesture');
  return structuredClone(value);
}


/** Ephemeral geometric facing estimate; never eye-gaze, attention or identity. */
export function validateFaceOrientation(value){
 fields(value,['direction','confidence','source'],'face_orientation');
 if(!['toward','away','unknown'].includes(value.direction)||value.source!=='landmarks')throw new Error('invalid_face_orientation');
 number(value.confidence,0,1,'face_orientation_confidence');return value;
}
