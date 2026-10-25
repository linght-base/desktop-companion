// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** v1 wire types. Runtime validation is owned by contracts.mjs. All timestamps in Unix milliseconds. */
export type Source = 'camera'|'replay'|'synthetic';
export interface Frame {at:number;mimeType:'image/jpeg'|'image/png';data:string;width:number;height:number}
export interface StreamGap {startAt:number;endAt:number;reason?:string}
export interface VideoStreamEvidence {id:string;transport:'webrtc';startedAt:number;windowStartAt:number;windowEndAt:number;receivedFrames:number;decodedFrames:number;droppedFrames:number;gaps:StreamGap[];timing:'rtp_pts'|'estimated';timingUncertaintyMs?:number}
export interface VideoObservation extends Observation {stream:VideoStreamEvidence}
export interface VideoSnapshot {status:'idle'|'connecting'|'streaming'|'error'|'stopped';transport:'webrtc';streamId:string|null;receivedFrames:number;decodedFrames:number;droppedFrames:number;bufferedFrames:number;lastFrameAt:number|null;reason:string|null;frameRate?:number}
export interface Observation {id:string;at:number;source:Source;frames:Frame[];coverage:'visible'|'partial'|'unknown';view:{yaw:number;pitch:number;physicalCameraMoves:false}}
export interface Eyes {gazeX:number;gazeY:number;openness:number;tilt:number;roundness:number;color:string}
export interface ExpressionIntent {basisObservationId:string;durationMs:number;responseWindowMs?:number;head?:{yaw?:number;pitch?:number};eyes?:Partial<Eyes>;gesture?:'idle'|'wave'|'jump'|'waiting'|'review';icon?:'none'|'question'|'sparkle'|'clock'|'check'|'water'|'movement'|'posture'}
export interface Receipt {id:string;status:'accepted'|'rejected'|'completed'|'cancelled';at:number;reason:string;basisObservationId?:string}
export interface BodyState {source:'simulation';head:{yaw:number;pitch:number};eyes:Eyes;icon:string;gesture:string;activeCommandId:string|null;leaseUntil:number}
export interface MemoryRecord {id:string;at:number;kind:'fact'|'hypothesis'|'action'|'preference';summary:string;subject?:string;evidenceIds:string[];confidence?:number;status:string;revision:number}
export interface WakeRecord {id:string;at:number;reason:string;attentionId?:string;[key:string]:unknown}
export interface RuntimeEvent {kind:'observation'|'wake'|'input'|'reminder'|'interest'|'diary'|'expression';at:number;payload:unknown}

export interface EvidenceReference {id:string;revision:number}
export interface ComposeEpisodeInput {requestId:string;summary:string;activity?:string;evidenceRefs:EvidenceReference[];id?:string;revision?:number}
export interface ExpressionDemandInput {requestId:string;meaning:string;reason?:string;evidenceRefs:EvidenceReference[];nextAt?:number}
export interface ExpressionDemandResult {outcome:'ready'|'unnecessary';candidateId?:string}
export interface RunResult {runId:string;status:'completed'|'aborted'|'failed';requests:number;toolCalls:number;error?:string}
export interface MemorySnapshot {memories:MemoryRecord[];attention:unknown[];wakes:WakeRecord[];learning:unknown[]}
export interface Snapshot {version:1;revision:number;at:number;mode:'fixture'|'cloud';enabled:boolean;phase:'stopped'|'observing'|'reasoning'|'resting'|'paused'|'error';epoch:number;body:BodyState;observation:Pick<Observation,'id'|'at'|'source'|'coverage'>&{frameCount:number;stream?:VideoStreamEvidence}|null;video:VideoSnapshot;agent:{runtime:'pi-agent-core';[key:string]:unknown};memory:MemorySnapshot;events:Array<{id:string;type:string;at:number;detail:unknown}>;error:string|null;rig?:RigSnapshot}

export interface RigSnapshot {profile:'integrated-sim'|'fixed-pet'|'ptz-sim-pet'|'pocket-uvc-pet'|'external-ptz-pet';generation:number;camera:{id:string;kind:string;videoInput:'browser';motion:'simulated'|'unsupported'|'driver';physicalCameraMoves:boolean;pose:{yaw:number;pitch:number;source:'simulated'|'reported'|'unknown'};capabilities:{panTilt:boolean;poseFeedback:boolean;stop:boolean}};presentation:{kind:'robot'|'lpet';mode:'browser-preview';headControlsCamera:boolean};lastError:string|null}

export function validateObservation(value:unknown):Observation;
export function validateVideoObservation(value:unknown):VideoObservation;
export function validateVideoStream(value:unknown,context?:{frames?:Frame[];at?:number}):VideoStreamEvidence;
