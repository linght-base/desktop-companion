// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {characterContext} from './comic-characters.mjs';
import {projectInteractionFeedback} from '../web/interaction-feedback.js';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {SimulatedBody} from './body.mjs';
import {createAttentionController} from './attention.mjs';
import {createVisualExchange} from './visual-exchange.mjs';
import {createPersonOrientation} from './person-orientation.mjs';
import {workdayBounds,workdayFor} from './day-window.mjs';
import {createProviderAvailability} from './provider-availability.mjs';
import {createObservationHistory} from './observation-history.mjs';
import {validateObservation, validateVideoObservation, validateFaceOrientation, fields, identifier, number, OBSERVATION_MAX_AGE, OBSERVATION_HISTORY_MAX_AGE} from './contracts.mjs';

function diagnostic(value, depth=0) {
  if(depth>3)return '[bounded]';
  if(typeof value==='string')return value.slice(0,300);
  if(value===null||typeof value==='number'||typeof value==='boolean')return value;
  if(Array.isArray(value))return value.slice(0,12).map(x=>diagnostic(x,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['data','frames','apiKey','key','token','authorization','messages'].includes(k)).slice(0,25).map(([k,v])=>[k,diagnostic(v,depth+1)]));
  return null;
}
const idleVideo=()=>({status:'idle',transport:'webrtc',streamId:null,receivedFrames:0,decodedFrames:0,droppedFrames:0,bufferedFrames:0,lastFrameAt:null,reason:null});
const backgroundEvent=event=>event?.kind==='diary'||event?.kind==='expression';
const defaultExpressionCapabilities=Object.freeze({version:'round-screen-v1',eyes:true,icons:['none','question','sparkle','clock','check','water','movement','posture'],gestures:['idle','wave','jump','waiting','review'],maxDurationMs:5000,maxKeyframes:32});
export function createController(options) {return new Controller(options);}
class Controller extends EventEmitter {
  #visualSignatures = new Map();
  constructor({store,runtimeFactory,mode='fixture',modelConfig={},persona='',clock=Date.now,minRunIntervalMs=300,rigManager=null,continuity=null,reminders=null,comic=null,evidenceUse='unknown',expressionLibrary=null,expressionPlayback=null,expressionCapabilities=defaultExpressionCapabilities,autonomy=null,autonomyPolicy={},viewGuidance=null,activityJournal=null,capabilityRegistry=null,actionArbiter=null,intentLedger=null,inferenceCadence=null,behaviorMethods=null,personaRegistry=null,memoryRetrieval=null,planHost=null,eventQueue=null,expressionDemands=null,providerAvailability=null,observationHistory=null,deviceStatus=null,experienceProfile='default',piContextStore=null,cognition=null,presenceRest=null}={}) {
    if(!['unknown','test','holdout'].includes(evidenceUse))throw new Error('invalid_evidence_use');
    super();this.piContextStore=piContextStore;this.cognition=cognition;this.presenceRest=presenceRest;this.continuityOutcomes=[];this.store=store;this.clock=clock;this.mode=mode;this.persona=persona;this.evidenceUse=evidenceUse;this.minRunIntervalMs=minRunIntervalMs;this.rigManager=rigManager;this.continuity=continuity;this.reminders=reminders;this.comic=comic;this.lastComicSweep=-Infinity;this.videoIngress=null;
    this.expressionLibrary=expressionLibrary;this.expressionPlayback=expressionPlayback;this.expressionCapabilities=expressionCapabilities;this.expressionSession=null;this.playbackEvidence=null;
    this.expressionDemands=expressionDemands;this.lastExpressionDemandSweep=-Infinity;
    this.autonomy=autonomy;this.autonomyPolicy={invitationWindowMs:3600000,invitationLimit:3,restrictedInvitationLimit:1,...autonomyPolicy};this.autonomyReason=null;
    this.viewGuidance=viewGuidance;
    this.activityJournal=activityJournal;this.intentLedger=intentLedger;this.inferenceCadence=inferenceCadence;this.cadenceBasis=null;this.cadenceFingerprint=null;this.behaviorMethods=behaviorMethods;this.methodSession=null;this.personaRegistry=personaRegistry;this.memoryRetrieval=memoryRetrieval;this.planHost=planHost;this.lastAutonomyPollAt=-Infinity;this.eventQueue=eventQueue;this.queueMetadata=new Map();this.deferredObservation=null;
    this.capabilityRegistry=capabilityRegistry;this.actionArbiter=actionArbiter;this.bodyLeases=new Map();
    this.personaVersion=createHash('sha256').update(String(persona)).digest().readUInt32BE(0)%1_000_000_000+1;
    this.enabled=false;this.phase='stopped';this.epoch=0;this.revision=0;this.events=[];this.error=null;
    this.experienceProfile=experienceProfile;this.visualExchange=createVisualExchange({clock});this.pendingThoughts=[];this.preparedReply=null;this.currentInteraction=null;this.userFeedback=null;this.userFeedbackAuthority=null;this.userFeedbackHistory=[];this.semanticThoughtPresence=new Map();this.deviceStatus=deviceStatus;this.lastPresencePublishedAt=0;
    this.providerAvailability=providerAvailability??createProviderAvailability({clock});
    this.observationHistory=observationHistory??createObservationHistory({clock});
    this.observationHistory.reset({epoch:this.epoch,deskId:this.profile().deskId});
    this.observation=null;this.pending=null;this.inbox=[];this.preferObservation=false;this.activatedAt=Infinity;this.issued=new Map();this.busy=false;this.token=null;this.closed=false;this.lastStarted=-Infinity;this.retryTimer=null;
    this.body=new SimulatedBody({clock});this.attention=createAttentionController({clock});this.personOrientation=createPersonOrientation({clock});this.personOrientationLease=null;this.personOrientationReceiptId=null;this.localSight=null;this.attentionOwnsHead=false;this.attentionGeneration=0;
    this.subject=null;this.attentionLease=null;this.expressionBasis=null;
    this.rigManager?.attachBody?.(this.body);
    if(!runtimeFactory)throw new Error('runtime_factory_required');
    this.runtime=runtimeFactory({mode,modelConfig,capabilityRegistry,continuityStore:piContextStore,tools:{
      ...(capabilityRegistry?{listCapabilities:async request=>this.active()?capabilityRegistry.list(request):this.rejected('run_cancelled')}:{}),
      observe:async()=>{
        if(!this.active())return null;
        const observation=this.freshObservation();
        if(observation){this.token.evidence=observation;this.retainObservation(this.token,observation);}
        this.retainTargets(this.token);
        return observation?{...structuredClone(observation),localSight:this.attention.snapshot(),subject:{confirmed:this.subjectCurrent(observation),identity:'unknown',targetId:this.subject?.targetId??null}}:null;
      },
      inspectObservation:async query=>{
        const rejected=this.runAuthority();if(rejected)return rejected;
        if(backgroundEvent(this.token.event))return this.rejected('background_observation_forbidden');
        fields(query,['id','cursor','limit'],'observation_history_query');
        const scope={enabled:this.enabled,epoch:this.epoch,deskId:this.profile().deskId};
        if(query.id===undefined)return this.observationHistory.list(query,scope);
        identifier(query.id,'observation_id');if(Object.keys(query).length!==1)return this.rejected('invalid_observation_history_query');
        if(!this.token.observations.has(query.id)&&this.token.observations.size>=25)return this.rejected('historical_observation_budget');
        const result=this.observationHistory.get(query.id,scope);if(!result.accepted)return result;
        // Reissue exactly the captured host grant. This is never the current body basis.
        this.issue(result.observation.id,result.reference);this.token.learningGrants?.delete(result.observation.id);this.retainObservation(this.token,result.observation);
        return {...result.observation,readOnlyHistorical:true};
      },
      express:async intent=>this.express(intent,this.token),
      encourage:async request=>this.encourage(request),
      ...(continuity?{shareThought:async request=>this.shareThought(request)}:{}),
      composeMoment:async request=>this.composeMoment(request),
      ...(cognition?{updateCognition:async request=>{
        const token=this.token,rejected=this.semanticAuthority();if(rejected)return rejected;
        const result=this.cognition.update(request,{deskId:token.deskId,enabled:this.enabled,mode:this.mode,epoch:this.epoch,isCurrent:()=>this.token===token&&!this.runAuthority()});
        this.record('cognition_updated',{status:result.status,reason:result.reason});this.publish();return result;
      }}:{}),
      trackTarget:async request=>this.trackTarget(request),
      ...(comic?{composeComic:async request=>this.composeComic(request)}:{}),
      ...(expressionDemands?{
        requestExpression:async request=>{const rejected=this.semanticAuthority();if(rejected)return rejected;if(!this.profile().expressionLearning)return this.rejected('learning_disabled');const result=this.expressionDemands.propose(request,this.planContext());this.publish();return result;},
        finishExpressionDemand:async request=>this.finishExpressionDemand(request),
      }:{}),
      ...(behaviorMethods?{
        proposeMethod:async request=>{const rejected=this.semanticAuthority();if(rejected)return rejected;fields(request,['requestId','meaning','method','evidenceRefs'],'method_proposal');const result=this.behaviorMethods.propose(request,this.planContext());this.publish();return result;},
        recallMethods:async request=>{const rejected=this.runAuthority();if(rejected)return rejected;fields(request,['meaning','limit'],'method_query');return this.methodSession?this.behaviorMethods.query({...request,sessionId:this.methodSession,deskId:this.profile().deskId}):[];},
      }:{}),
      ...(intentLedger?{
        proposePlan:async request=>{const rejected=this.semanticAuthority();if(rejected)return rejected;const result=(this.planHost??this.intentLedger).propose(request,this.planContext());this.publish();return result;},
        advancePlan:async request=>{const rejected=this.semanticAuthority();if(rejected)return rejected;const result=(this.planHost??this.intentLedger).advance(request,this.planContext());this.publish();return result;},
        listPlans:async request=>{const rejected=this.runAuthority();if(rejected)return rejected;return this.listPlans(request);},
      }:{}),
      ...(activityJournal?{readActivity:async request=>{const rejected=this.runAuthority();if(rejected)return rejected;fields(request,['day','timeZone'],'activity_query');return this.readActivity(request);}}:{}),
      ...(viewGuidance?{assessView:async request=>{const rejected=this.writeAuthority(request);if(rejected)return rejected;const result=this.viewGuidance.assess(request,this.viewContext());this.publish();return result;}}:{}),
      ...(expressionLibrary&&expressionPlayback?{
        proposeExpression:async request=>this.proposeExpression(request),
        recallExpressions:async request=>this.recallExpressions(request),
        expressRecipe:async request=>this.expressRecipe(request),
      }:{}),
      remember:async candidate=>{
        const rejected=this.writeAuthority();if(rejected)return rejected;
        const entry={...candidate};
        const ids=Array.isArray(entry.evidenceIds)?entry.evidenceIds:[];
        const facts=new Set(this.store.query({limit:50}).filter(m=>m.kind==='fact').map(m=>m.id));
        const grounded=ids.length>0&&ids.every(id=>{const ref=this.issued.get(id);return ref?.type==='observation'&&ref.epoch===this.epoch&&['camera','replay'].includes(ref.source)||facts.has(id);});
        if(['action','preference'].includes(entry.kind)||(entry.kind==='fact'&&(mode==='fixture'||!grounded)))entry.kind='hypothesis';
        const result=this.store.append(entry);this.record('memory_recorded',{id:result.id,kind:result.kind});this.publish();return result;
      },
      ...(continuity?{
        ...(typeof continuity.composeEpisode==='function'?{
          composeEpisode:async request=>{const rejected=this.semanticAuthority();if(rejected)return rejected;const result=this.continuity.composeEpisode(request,{deskId:this.profile().deskId});this.record('experience_composed',{id:result?.id,revision:result?.revision,status:result?.status});this.publish();return result;},
          listEpisodes:async request=>{const rejected=this.runAuthority();if(rejected)return rejected;fields(request,['limit','status'],'episode_query');return this.continuity.listEpisodes({...request,deskId:this.profile().deskId});},
        }:{}),
        recordPerception:async candidate=>this.recordPerception(candidate),
        recallMemory:async query=>{const token=this.token;if(!this.active())return this.rejected('run_cancelled');fields(query,['query','queryVariants','entityIds','limit','deskId'],'memory_query');const {deskId,...input}=query;const result=this.memoryRetrieval?await this.memoryRetrieval.recall(input,{deskId:this.profile().deskId}):this.continuity.recall({...input,deskId:this.profile().deskId});return this.token===token&&!this.runAuthority()?result:this.rejected('run_cancelled');},
        rememberBelief:async candidate=>{const rejected=this.semanticAuthority();if(rejected)return rejected;const result=this.continuity.rememberBelief(candidate);this.record('belief_recorded',{id:result?.id,status:result?.status,reason:result?.reason});this.publish();return result;},
        followInterest:async candidate=>{const rejected=this.semanticAuthority();if(rejected)return rejected;const result=this.continuity.upsertInterest(candidate);this.record('interest_recorded',{id:result?.id,status:result?.status,reason:result?.reason});this.publish();return result;},
      }:{}),
      ...(reminders?{
        startReminder:async request=>{const token=this.token;const rejected=this.semanticAuthority();if(rejected)return rejected;const result=this.reminders.createInferred(request,{enabled:this.enabled,mode:this.mode,autonomousReminders:this.experienceProfile==='competition',deskId:token.deskId,isCurrent:()=>this.token===token&&!this.runAuthority(),resolveEvidence:(id,options)=>this.continuity?.getEvidence(id,options)});this.record('autonomous_reminder',{id:result.reminderId,status:result.status,reason:result.reason});this.publish();return result;},
        listReminders:async()=>this.active()?this.reminders.snapshot().filter(r=>!r.deskId||r.deskId===this.profile().deskId):this.rejected('run_cancelled'),
        assessReminderCompletion:async request=>{
          const token=this.token;const rejected=this.writeAuthority(request);if(rejected)return rejected;
          const receipt=this.reminders.assessVisualCompletion(request,{enabled:this.enabled,epoch:token.epoch,mode:this.mode,deskId:token.deskId,observation:structuredClone(token.evidence),isCurrent:()=>this.token===token&&this.evidenceCurrent(token.evidence),subjectConfirmed:this.subjectCurrent(token.evidence),resolveEvidence:(id,options)=>this.continuity?.getEvidence(id,options)});
          if(receipt.status==='accepted'&&request.outcome==='completed'&&!receipt.duplicate){
            if(this.reminderDisplay?.reminderId===request.id)this.retractReminder('visually_assessed_completed');
            this.record('visual_outcome_accepted',{id:request.id,evidenceIds:request.evidenceRefs.map(r=>r.id),source:'visual_assessment'});
          }
          this.publish();return receipt;
        },
        respondReminder:async request=>{
          const token=this.token;const rejected=this.writeAuthority(request);if(rejected)return rejected;
          token.reminderIds??=new Set();token.reminderIds.add(request.id);
          const receipt=await this.reminders.decide(request,{enabled:this.enabled,epoch:token.epoch,mode:this.mode,deskId:this.profile().deskId,observation:structuredClone(token.evidence),isCurrent:()=>this.token===token&&this.evidenceCurrent(token.evidence),express:intent=>this.express(intent,token,{reminderId:request.id})});
          this.record('reminder_decision',{id:request.id,...receipt});this.publish();return receipt;
        },
      }:{}),
      ...(rigManager?{moveCamera:async request=>{const rejected=this.interactionAuthority();return rejected??this.moveCamera(request,this.token);}}:{}),
      wake:async request=>{
        const rejected=this.writeAuthority();if(rejected)return rejected;
        if(!Number.isFinite(request.at)||request.at<this.clock()+500||request.at>this.clock()+7*86400000)throw new Error('invalid_wake_time');
        if(this.store.snapshot().wakes.filter(w=>w.status!=='consumed'&&w.status!=='cancelled').length>=20)throw new Error('wake_budget');
        const result=this.store.scheduleWake(request);this.record('wake_scheduled',{id:result.id,at:result.at});this.publish();return result;
      }
    },context:()=>({visualExchange:this.visualExchange.snapshot(),pendingThoughts:this.pendingThoughtSnapshot(),recentMessages:this.userFeedbackHistory.slice(-5),characterContext:characterContext(this.continuity?.snapshot().perceptions??[],{readEvidence:(id,options)=>this.continuity.getEvidence(id,options),deskId:this.profile().deskId}),continuityOutcomes:this.continuityOutcomes.slice(-40),cognition:this.cognition?.snapshot({deskId:this.profile().deskId})??[],observationHistory:this.observationHistory.snapshot(),persona:this.persona,personaMeta:this.personaRegistry?.snapshot().active??{legacyVersion:this.personaVersion},profile:this.profile(),subject:{confirmed:this.subjectCurrent(this.freshObservation()),identity:'unknown',targetId:this.subject?.targetId??null},plans:this.contextPlans(),episodes:this.continuity?.listEpisodes?.({deskId:this.profile().deskId,limit:6})??[],expressionDemands:this.expressionDemands?.list({limit:4},this.planContext())??[],methods:this.methodSnapshot(),activities:this.readActivity()?.entries.slice(-6)??[],interests:(this.continuity?.snapshot().interests??[]).filter(i=>i.status==='active'&&(!i.deskId||i.deskId===this.profile().deskId)).slice(0,12),reminders:(this.reminders?.snapshot()??[]).filter(r=>r.status!=='disabled'&&(r.recurring||!['acknowledged','completed','dismissed','expired','exhausted'].includes(r.status))&&(!r.deskId||r.deskId===this.profile().deskId)).slice(0,20),attention:this.attention.snapshot(),personOrientation:this.personOrientation.snapshot(),...(this.rigManager?{capabilities:this.rigManager.snapshot()}:{})}),onEvent:event=>{
      this.record(event.type,event.detail);this.publish();
    }});
  }
  comicSnapshot(input={}){return {...(this.comic?.snapshot({...input,deskId:this.profile().deskId})??{book:null,jobs:[],settings:null}),scope:this.diaryScope(input)};}
  requestComic(input){
    fields(input,['day'],'comic_generate');if(!this.comic)throw new Error('comic_unavailable');
    const job=this.comic.request({...input,deskId:this.profile().deskId,reason:'manual'});this.lastComicSweep=-Infinity;this.publish();return job;
  }
  reviseContinuity(input){
    fields(input,['id','summary','status','reason'],'continuity_revision');
    if(!this.continuity)throw new Error('continuity_unavailable');
    const {id,...patch}=input;
    const affectedIds=this.continuity.affectedEvidenceIds(id);
    const result=this.continuity.revise(id,patch);
    if(patch.status==='deleted')for(const evidenceId of affectedIds){this.expressionLibrary?.forgetEvidence(evidenceId);this.expressionDemands?.forgetEvidence(evidenceId);this.intentLedger?.forgetEvidence(evidenceId);this.behaviorMethods?.forgetEvidence(evidenceId);this.reminders?.forgetEvidence?.(evidenceId);this.momentComicsHost?.forgetEvidence(evidenceId);}
    this.intentLedger?.reconcileEvidence();this.behaviorMethods?.reconcileEvidence();this.reminders?.reconcileEvidence?.({resolveEvidence:(evidenceId,options)=>this.continuity.getEvidence(evidenceId,options)});
    this.momentComicsHost?.reconcile();
    this.expressionLibrary?.reconcileEvidence();
    this.expressionDemands?.reconcileEvidence();
    const affected=this.comic?.invalidateEvidence(id);
    for(const scope of affected?.invalidatedScopes??[])this.comic.request({...scope,reason:'manual'});
    this.control('pause');this.record('continuity_revised',{id:result.id,revision:result.revision});this.publish();return result;
  }
  composeComic(input){
    const rejected=this.runAuthority();if(rejected)return rejected;
    if(this.token.event.kind!=='diary'||!this.token.event.claim)return this.rejected('comic_job_not_issued');
    fields(input,['panels'],'compose_comic');const claim=this.token.event.claim;
    const book=this.comic.publish({jobId:claim.id,claimToken:claim.claimToken,panels:input.panels},{epoch:this.token.epoch,deskId:this.token.deskId});
    this.publish();return {accepted:true,status:'published',jobId:book.jobId,panelCount:book.panels.length};
  }
  composeMoment(input){
    const rejected=this.runAuthority();if(rejected)return rejected;
    const event=this.token.event,claim=event?.claim;
    if(!this.momentComicsHost||event.kind!=='diary'||event.payload?.kind!=='moment'||claim?.type!=='moment_comic')return this.rejected('moment_job_not_issued');
    if(!this.enabled||this.token.deskId!==this.profile().deskId)return this.rejected('moment_scope_changed');
    return this.momentComicsHost.select({...input,jobId:claim.id,claimToken:claim.claimToken},{enabled:this.enabled,epoch:this.token.epoch,deskId:this.token.deskId});
  }
  preemptComic(reason){
    if(this.token?.event.kind!=='diary'||this.token.cancelled)return;
    this.token.cancelled=true;this.settleToken(this.token);this.runtime.abort();if(this.enabled)this.phase='resting';this.record('comic_interrupted',{reason});
  }
  preemptExpressionProduction(reason){
    if(this.token?.event.kind!=='expression'||this.token.cancelled)return;
    this.token.cancelled=true;this.settleToken(this.token);this.runtime.abort();
    if(this.enabled)this.phase='resting';this.record('expression_production_interrupted',{reason});
  }
  significantChange(previous,current){
    if(!previous)return false;
    const a=this.#visualSignatures.get(previous.id),b=this.#visualSignatures.get(current.id);
    if(a&&b){let sum=0,changed=0;for(let i=0;i<a.pixels.length;i++){const difference=Math.abs(a.pixels[i]-b.pixels[i]);sum+=difference;if(difference>12)changed++;}return sum/a.pixels.length>6||changed/a.pixels.length>.01;}
    return previous.frames.at(-1)?.data!==current.frames.at(-1)?.data;
  }
  retainTargets(token){
    if(!token||token.attentionGeneration!==this.attentionGeneration)return;token.targets??=new Map();const sight=this.attention.snapshot();
    for(const target of sight.targets??[])token.targets.set(target.id,{streamId:sight.streamId,epoch:this.epoch});
  }
  ingestSight(input,{admittedEpoch}={}){
    if(admittedEpoch!==this.epoch||!this.enabled||this.closed)throw new Error('sight_epoch_changed');
    fields(input,['at','streamId','status','detector','targets','processingMs'],'sight');
    if(!Number.isSafeInteger(input.at)||this.clock()-input.at>1000||input.at>this.clock()+1000||typeof input.streamId!=='string'||input.streamId.length>128||!['ready','unavailable','error'].includes(input.status)||input.detector!=='yunet-2023mar'||!Array.isArray(input.targets)||input.targets.length>8||!Number.isFinite(input.processingMs)||input.processingMs<0||input.processingMs>10000)throw new Error('invalid_sight');
    for(const t of input.targets){
      fields(t,['id','kind','identity','box','confidence','faceOrientation'],'target');if(t.faceOrientation!==undefined)validateFaceOrientation(t.faceOrientation);fields(t.box,['x','y','width','height'],'box');
      if(typeof t.id!=='string'||!t.id.length||t.id.length>128||t.kind!=='face'||t.identity!=='unknown'||!Number.isFinite(t.confidence)||t.confidence<0||t.confidence>1||Object.values(t.box).some(v=>!Number.isFinite(v)||v<0||v>1)||t.box.width<=0||t.box.height<=0||t.box.x+t.box.width>1.000001||t.box.y+t.box.height>1.000001)throw new Error('invalid_sight_target');
    }
    this.localSight={...structuredClone(input),basisId:`sight:${randomUUID()}`};
    const admitted=this.attention.ingest(this.localSight,{enabled:this.enabled,epoch:this.epoch});
    if(!admitted.accepted)return admitted;
    this.presenceRest?.ingest(input,{enabled:this.enabled,epoch:this.epoch});this.updatePresenceRest();if(this.presenceRest?.snapshot().resting)return {accepted:true};
    // Low-priority geometric orientation, not a semantic desk-scene rule.
    const rig=this.rigManager?.snapshot(),attention=this.attention.snapshot(),clearTargets=attention.targets.filter(t=>t.confidence>=.90);
    if(rig?.profile==='integrated-device'&&clearTargets.length&&this.attentionOwnsHead){
      const lease=this.bodyLeases.get(this.attentionLease);
      if(!lease||lease.receiptId===this.body.headCommandId){this.body.stopHead();this.attentionOwnsHead=false;if(lease)lease.receiptId=null;}
    }
    if(this.subject&&(this.subject.streamId!==input.streamId||input.targets.length!==1||input.targets[0].id!==this.subject.targetId))this.subject=null;
    this.publish();return {accepted:true};
  }
  stopAttention(reason='stopped'){
    if(reason!=='provider_wait')this.personOrientation.reset();this.stopPersonOrientation(reason);
    if(this.attentionLease){this.actionArbiter?.release({leaseId:this.attentionLease,reason});this.endBodyLease(this.attentionLease,reason);this.attentionLease=null;}
    this.attentionGeneration++;this.attention.reset(reason);if(reason!=='provider_wait')this.localSight=null;this.subject=null;if(this.attentionOwnsHead)this.body.stopHead();this.body.stopGaze();this.attentionOwnsHead=false;
  }
  stopPersonOrientation(reason='orientation_finished'){
    if(this.personOrientationReceiptId&&this.personOrientationReceiptId===this.body.headCommandId)this.body.stopHead();
    this.personOrientationReceiptId=null;this.personOrientation.cancelPending();
    if(this.personOrientationLease){this.actionArbiter?.release({leaseId:this.personOrientationLease,reason});this.endBodyLease(this.personOrientationLease,reason);this.personOrientationLease=null;}
  }
  applyPersonOrientation(proposal){
    if(!proposal)return;
    if(!proposal.head){this.stopPersonOrientation(proposal.kind);return;}
    if(proposal.kind==='return'){this.stopPersonOrientation('visual_attention_return');this.publish();}
    const now=this.clock();if(proposal.until-now<100)return;
    const check=id=>id&&this.actionArbiter?.check({leaseId:id,epoch:this.epoch,deskId:this.profile().deskId});
    let leaseId=this.bodyLeases.get(this.attentionLease)?.owner!=='input'&&check(this.attentionLease)?.usable&&check(this.attentionLease).expiresAt>=proposal.until?this.attentionLease:check(this.personOrientationLease)?.usable&&check(this.personOrientationLease).expiresAt>=proposal.until?this.personOrientationLease:null;
    if(this.actionArbiter&&!leaseId){
      const grant=this.claimHead('person-orientation',10,proposal.until-now,{preserveSight:true});
      if(!grant.accepted)return;leaseId=grant.lease.leaseId;this.personOrientationLease=leaseId;this.bodyLeases.set(leaseId,{receiptId:null,channels:['head']});
    }
    const lease=leaseId?this.actionArbiter.check({leaseId,epoch:this.epoch,deskId:this.profile().deskId}):null;
    const until=Math.min(proposal.until,lease?.expiresAt??Infinity);
    if(until-now<100)return;
    const receipt=this.body.moveHead({basisObservationId:proposal.basisId,head:proposal.head,durationMs:proposal.durationMs},{epoch:this.epoch,observationId:proposal.basisId,observedAt:proposal.observedAt,leaseUntil:until});
    if(receipt.status==='accepted'){
      this.personOrientationReceiptId=receipt.id;this.personOrientation.accepted(receipt.id,proposal);const tracked=this.bodyLeases.get(leaseId);if(tracked)tracked.receiptId=receipt.id;
      this.record('person_orientation',{kind:proposal.kind,head:proposal.head,expiresAt:until});
    }
  }
  selectSubject(input){
    fields(input,['targetId'],'subject_selection');
    if(input.targetId===null){this.subject=null;this.publish();return {accepted:true,confirmed:false};}
    const sight=this.attention.snapshot();
    if(!this.enabled||sight.targets.length!==1||sight.targets[0].id!==input.targetId||this.clock()-sight.observedAt>=500)return this.rejected('subject_not_unambiguous');
    this.subject={targetId:input.targetId,streamId:sight.streamId,confirmedAt:this.clock(),deskId:this.profile().deskId,epoch:this.epoch};this.publish();return {accepted:true,confirmed:true,identity:'unknown'};
  }
  subjectCurrent(observation){
    const subject=this.subject,sight=this.attention.snapshot();
    return Boolean(subject&&this.enabled&&subject.epoch===this.epoch&&subject.deskId===this.profile().deskId&&observation?.source==='camera'&&observation.stream?.id===subject.streamId&&observation.at>=subject.confirmedAt&&sight.streamId===subject.streamId&&sight.targets.length===1&&sight.targets[0].id===subject.targetId&&this.clock()-sight.observedAt<500&&Math.abs(observation.at-sight.observedAt)<500);
  }
  focusAttention(request){
    fields(request,['targetId','durationMs'],'attention_focus');
    if(request.targetId===null&&request.durationMs===0){this.stopAttention('user_stop');this.publish();return {accepted:true,status:'accepted'};}
    if(!this.enabled||this.closed)return this.rejected('body_stopped');
    const result=this.beginAttention(request,'input',90);if(result.accepted)this.attentionGeneration++;this.publish();return {...result,status:result.accepted?'accepted':'rejected'};
  }
  trackTarget(request){
    fields(request,['targetId','durationMs','basisObservationId'],'track_target');
    const rejected=this.interactionAuthority();if(rejected)return rejected;
    if(backgroundEvent(this.token.event))return this.rejected('background_body_forbidden');
    if(this.token.attentionGeneration!==this.attentionGeneration)return this.rejected('attention_superseded');
    const ref=this.token.targets?.get(request.targetId),sight=this.attention.snapshot();
    if(!this.token.observations.has(request.basisObservationId)||!ref||ref.epoch!==this.epoch||ref.streamId!==sight.streamId||!sight.targets.some(t=>t.id===request.targetId)||this.clock()-sight.observedAt>=500)return this.rejected('target_not_current');
    const result=this.beginAttention({targetId:request.targetId,durationMs:request.durationMs},'pi',30);this.publish();return {...result,status:result.accepted?'accepted':'rejected'};
  }
  claimHead(owner,priority,durationMs,{preserveSight=false}={}){
    if(!this.actionArbiter)return {accepted:true,lease:null};
    const grant=this.actionArbiter.claim({requestId:randomUUID(),owner,priority,durationMs,channels:['head']},{enabled:this.enabled&&!this.closed,epoch:this.epoch,deskId:this.profile().deskId});
    if(grant.accepted)this.applySupersession(grant,{preserveSight});
    return grant;
  }
  beginAttention(request,owner,priority){
    if(this.rigManager?.snapshot().profile==='integrated-device'&&this.videoIngress?.physicalMotionAllowed?.()===false)return this.rejected('privacy_mask_locks_camera_motion');
    const sight=this.attention.snapshot();
    if(!Number.isFinite(request.durationMs)||request.durationMs<100||request.durationMs>15000||!sight.targets.some(t=>t.id===request.targetId)||this.clock()-sight.observedAt>=500)return this.rejected('target_not_current');
    const grant=this.claimHead(owner,priority,request.durationMs,{preserveSight:true});if(!grant.accepted)return this.rejected(grant.reason);
    const result=this.attention.focus(request,{enabled:this.enabled,epoch:this.epoch});
    if(grant.lease){
      if(result.accepted){this.attentionLease=grant.lease.leaseId;this.bodyLeases.set(this.attentionLease,{receiptId:null,channels:['head'],attention:true,owner});}
      else this.actionArbiter.release({leaseId:grant.lease.leaseId,reason:'focus_rejected'});
    }
    return result;
  }
  profile(){return this.continuity?.getProfile()??{deskId:'desk-default',quietMode:true,curiosity:'gentle',version:1};}
  methodSnapshot(){return this.behaviorMethods?.snapshot(this.planContext())??null;}
  planContext(){return {deskId:this.profile().deskId,personaVersion:this.personaVersion};}
  listPlans(query={}){fields(query,['status','limit'],'plan_query');return this.planHost?this.planHost.list(query,this.planContext()):this.intentLedger?.list({...query,...this.planContext()})??[];}
  contextPlans(){return ['planned','active','waiting'].flatMap(status=>this.listPlans({status,limit:8})).sort((a,b)=>(a.nextAt??Infinity)-(b.nextAt??Infinity)||b.updatedAt-a.updatedAt).slice(0,8);}
  diaryScope({day,timeZone}={}){
    const config={dayStart:'00:00',timeZone:'Asia/Shanghai',closeTime:'21:00',...this.comic?.settings?.(),...(timeZone===undefined?{}:{timeZone})};
    return {...workdayBounds(day??workdayFor(this.clock(),config),config),deskId:this.profile().deskId};
  }
  readDiary(input={}){const {day,timeZone,deskId,startAt,endAt}=this.diaryScope(input);return this.continuity?.diary({day,timeZone,deskId,startAt,endAt})??{day,startAt,endAt,panels:[],gaps:[]};}
  readActivity(input={}){const {day,timeZone,deskId,startAt,endAt}=this.diaryScope(input);return this.activityJournal?.forDay({day,timeZone,deskId,startAt,endAt})??null;}
  viewContext(){const evidence=this.freshObservation();return {enabled:this.enabled&&!this.closed,epoch:this.epoch,deskId:this.profile().deskId,observation:evidence,isCurrent:()=>this.enabled&&!this.closed&&this.matchesEvidence(evidence)};}
  proposeExpression(request){
    fields(request,['requestId','meaning','evidenceRefs','recipe'],'expression_proposal');
    const rejected=this.token?.event.kind==='expression'?this.expressionWorkAuthority():this.semanticAuthority();if(rejected)return rejected;
    if(!this.profile().expressionLearning)return this.rejected('learning_disabled');
    if(this.token.event.kind==='expression'){
      const expected=this.token.event.payload.evidenceRefs??[];
      if(!Array.isArray(request.evidenceRefs)||request.evidenceRefs.length!==expected.length||request.evidenceRefs.some(ref=>!expected.some(basis=>basis.id===ref.id&&basis.revision===ref.revision)))return this.rejected('expression_demand_basis_mismatch');
    }
    const candidate=this.expressionLibrary.propose({...request,deskId:this.profile().deskId,personaVersion:this.personaVersion});
    const checked=this.expressionLibrary.validateCandidate(candidate.id);this.publish();return checked;
  }
  recallExpressions(request){
    fields(request,['meaning','limit'],'expression_query');
    const rejected=this.runAuthority();if(rejected)return rejected;
    if(!this.profile().expressionLearning||!this.expressionSession)return [];
    return this.expressionLibrary.query({...request,deskId:this.profile().deskId,sessionId:this.expressionSession});
  }
  expressionWorkAuthority(){
    const rejected=this.runAuthority();if(rejected)return rejected;
    if(this.token.event.kind!=='expression'||!this.token.event.claim)return this.rejected('expression_job_not_issued');
    if(this.mode!=='cloud')return this.rejected('not_supported');
    if(!this.profile().expressionLearning)return this.rejected('learning_disabled');
    if(this.clock()>=this.token.event.claim.leaseUntil)return this.rejected('expression_job_expired');
    const claim=this.token.event.claim;
    const authorization=this.expressionDemands.authorizeClaim({id:claim.id,claimToken:claim.claimToken},{...this.planContext(),epoch:this.token.epoch,enabled:this.enabled});
    if(authorization.accepted!==true)return authorization;
    return null;
  }
  finishExpressionDemand(request){
    fields(request,['outcome','candidateId'],'expression_job_result');
    const rejected=this.expressionWorkAuthority();if(rejected)return rejected;
    const claim=this.token.event.claim;
    const result=this.expressionDemands.complete({...request,id:claim.id,claimToken:claim.claimToken},{...this.planContext(),enabled:this.enabled,epoch:this.token.epoch});
    if(result.accepted===true)this.token.expressionDemandSettled=true;
    this.publish();return result;
  }
  releaseExpressionWork(event,reason){
    if(event?.kind!=='expression'||!event.claim||!this.expressionDemands)return;
    const claim=event.claim;
    this.expressionDemands.release({id:claim.id,claimToken:claim.claimToken,reason},{enabled:this.enabled,epoch:claim.epoch,deskId:claim.deskId,personaVersion:claim.personaVersion});
  }
  expressRecipe(request){
    fields(request,['recipeId','basisObservationId','responseWindowMs'],'expression_play');
    const rejected=this.writeAuthority(request);if(rejected)return rejected;
    if(!this.profile().expressionLearning||!this.expressionSession)return this.rejected('learning_disabled');
    if(this.reminderDisplay&&this.body.expressionCommandId===this.reminderDisplay.receiptId&&this.body.expressionUntil>this.clock())return this.rejected('reminder_owns_expression');
    const epoch=this.epoch,deskId=this.profile().deskId,evidence=structuredClone(this.token.evidence),sessionId=this.expressionSession;
    const isCurrent=()=>!this.closed&&this.enabled&&this.epoch===epoch&&this.profile().deskId===deskId&&this.expressionSession===sessionId&&this.matchesEvidence(evidence);
    const {responseWindowMs,...recipeRequest}=request;
    const prepared=this.expressionPlayback.prepare({...recipeRequest,sessionId},{epoch,deskId,isCurrent});
    if(!prepared.accepted)return this.rejected(prepared.reason);
    const receipt=this.express({...prepared.intent,...(responseWindowMs===undefined?{}:{responseWindowMs})},this.token);
    const committed=this.expressionPlayback.commit({proposalId:prepared.proposalId,receipt});
    if(committed.accepted)this.playbackEvidence={epoch,evidence,receiptId:receipt.id};
    else if(receipt.status==='accepted')this.body.stopExpression(receipt.id,committed.reason);
    this.publish();return receipt.status==='accepted'&&!committed.accepted?this.rejected(committed.reason):receipt;
  }
  stopExpressionPlayback(reason){
    const event=this.expressionPlayback?.stop(reason);if(event){this.releaseReceipt(event.receiptId,event.reason);this.body.stopExpression(event.receiptId,event.reason);}this.playbackEvidence=null;
  }
  expressionSnapshot(){
    const profile=this.profile();const library=this.expressionLibrary;
    const available=library&&this.expressionSession&&profile.expressionLearning?library.query({deskId:profile.deskId,sessionId:this.expressionSession,limit:20}):[];
    const ids=new Set(available.map(r=>r.id));const playback=this.expressionPlayback?.snapshot().active;
    return {production:this.expressionDemands?.snapshot(this.planContext())??null,demands:this.expressionDemands?.list({limit:8},this.planContext())??[],learningEnabled:profile.expressionLearning===true,semanticPolicy:'structural_check_only',nextWakeRequired:true,availableCount:available.length,
      resources:(library?.snapshot().candidates??[]).filter(r=>r.deskId===profile.deskId).map(r=>({id:r.id,meaning:r.meaning,status:r.status,semanticStatus:'unverified',activated:ids.has(r.id),evidenceCount:r.evidenceRefs.length,createdAt:r.createdAt,...(r.structuralCheck.status==='failed'?{reason:'structural_check_failed'}:{})})),
      ...(playback?{activePlayback:{id:playback.playbackId,startedAt:playback.startedAt,expiresAt:playback.deadlineAt}}:{})};
  }
  tickExpressionPlayback(){
    if(!this.expressionPlayback)return;
    const event=this.expressionPlayback.tick({enabled:this.enabled,epoch:this.epoch,deskId:this.profile().deskId,expressionCommandId:this.body.expressionCommandId});
    if(event?.kind==='stop'){this.releaseReceipt(event.receiptId,event.reason);this.body.stopExpression(event.receiptId,event.reason);this.playbackEvidence=null;}
    else if(event?.kind==='frame'){
      const authority=this.playbackEvidence;
      const receipt=this.body.updateExpression(event.frame,{epoch:authority?.epoch??-1,commandId:event.receiptId,observationId:authority?.evidence.id,observedAt:authority?.evidence.at});
      if(receipt.status!=='accepted')this.stopExpressionPlayback(receipt.reason);
    }
  }
  rejected(reason){return {accepted:false,status:'rejected',reason};}
  runAuthority(){
    if(!this.active())return this.rejected('run_cancelled');
    if(this.token.deskId!==this.profile().deskId)return this.rejected('desk_changed');
    if(this.token.runExpiresAt!==undefined&&this.clock()>=this.token.runExpiresAt)return this.rejected('processing_window_expired');
    return null;
  }
  interactionAuthority(token=this.token){
    const rejected=this.runAuthority();if(rejected)return rejected;
    if(token!==this.token)return this.rejected('run_cancelled');
    if(token.event.expiresAt!==undefined&&this.clock()>=token.event.expiresAt)return this.rejected('interaction_window_expired');
    return null;
  }
  retainObservation(token,observation){
    const reference=this.issued.get(observation?.id);
    if(!observation||reference?.type!=='observation'||reference.epoch!==token.epoch||reference.deskId!==token.deskId)return;
    if(!token.observations.has(observation.id)&&token.observations.size>=25)return;
    token.observations.set(observation.id,structuredClone(observation));
    token.learningGrants??=new Map();
    if(!token.learningGrants.has(observation.id))token.learningGrants.set(observation.id,{learningUse:reference.learningUse??'unknown',...(reference.learningVersion===undefined?{}:{learningVersion:reference.learningVersion})});
  }
  historicalAuthority(request){
    const rejected=this.runAuthority();if(rejected)return rejected;
    if(backgroundEvent(this.token.event))return this.rejected('background_write_forbidden');
    const evidence=this.token.observations.get(request?.basisObservationId);
    if(!evidence)return this.rejected('observation_not_issued');
    const age=this.clock()-evidence.at;
    if(!Number.isFinite(age)||age< -1000||age>OBSERVATION_HISTORY_MAX_AGE)return this.rejected('historical_evidence_expired');
    if(this.mode!=='cloud'||!['camera','replay'].includes(evidence.source))return this.rejected('not_supported');
    return null;
  }
  semanticAuthority(){
    const rejected=this.runAuthority();if(rejected)return rejected;
    if(backgroundEvent(this.token.event))return this.rejected('background_write_forbidden');
    return this.mode==='cloud'?null:this.rejected('not_supported');
  }
  writeAuthority(request=null){
    const rejected=this.interactionAuthority();if(rejected)return rejected;
    if(backgroundEvent(this.token.event))return this.rejected('background_write_forbidden');
    const evidence=this.token.evidence;
    const age=this.clock()-(evidence?.at??NaN);
    if(!this.evidenceCurrent(evidence)||!Number.isFinite(age)||age>OBSERVATION_MAX_AGE||age< -1000)return this.rejected('evidence_changed');
    if(request?.basisObservationId&&request.basisObservationId!==evidence.id)return this.rejected('observation_not_issued');
    return null;
  }
  thoughtSourcesCurrent(feedback){
    return feedback.evidenceRefs.every(ref=>{const record=this.continuity?.getEvidence(ref.id,{deskId:feedback.deskId});return record?.id===ref.id&&record.kind==='perception'&&record.status==='active'&&['camera','replay'].includes(record.source)&&record.deskId===feedback.deskId&&record.revision===ref.revision;});
  }
  thoughtVisible(authority){
    if(this.presenceRest?.snapshot().resting||this.deviceStatus?.()?.connected===false)return false;
    if(authority.target)return this.supportTargetCurrent(authority.target);
    const presence=authority.presenceGrants?.get(authority.basis.id),record=presence&&this.continuity?.getEvidence(presence.id,{deskId:authority.deskId});
    if(presence?.value!=='present'||record?.kind!=='perception'||record.status!=='active'||record.revision!==presence.revision||record.basisObservationId!==authority.basis.id||!['visible','partial'].includes(authority.basis.coverage))return false;
    const stream=authority.basis.stream;
    if(authority.basis.source!=='camera'||stream?.transport!=='webrtc')return this.matchesEvidence(authority.basis);
    // A short sentence describes a sustained, tentative understanding. New
    // pixels alone do not retract it or extend the original presence grant.
    if(this.clock()>=authority.presenceUntil)return false;
    const latest=this.semanticThoughtPresence.get(JSON.stringify([stream.id,stream.startedAt]));
    if(latest?.value==='absent'&&latest.at>=authority.basis.at)return false;
    const current=this.freshObservation(),grant=current&&this.issued.get(current.id);
    if(current?.source!=='camera'||current.stream?.id!==stream.id||current.stream.startedAt!==stream.startedAt||!['visible','partial'].includes(current.coverage)||grant?.epoch!==this.epoch||grant.deskId!==authority.deskId)return false;
    const video=this.videoIngress?.snapshot();
    if(video&&(video.status!=='streaming'||video.streamId!==stream.id||video.sharingActive===false))return false;
    const frameAt=video?.lastFrameAt??current.frames.at(-1)?.at,age=this.clock()-frameAt;
    return Number.isFinite(age)&&age>=-1000&&age<=2000;
  }
  userFeedbackSnapshot(){
    this.userFeedbackHistory=this.userFeedbackHistory.filter(item=>item.epoch===this.epoch&&item.deskId===this.profile().deskId&&this.thoughtSourcesCurrent(item));
    for(const item of this.userFeedbackHistory)if(item.status==='requested'&&item.expiresAt<=this.clock())item.status='expired';
    const feedback=this.userFeedback,authority=this.userFeedbackAuthority;
    if(feedback&&(!this.enabled||this.closed||feedback.epoch!==this.epoch||feedback.deskId!==this.profile().deskId||feedback.expiresAt<=this.clock()||!this.thoughtSourcesCurrent(feedback)||!authority||!this.thoughtVisible(authority))){
      const historical=this.userFeedbackHistory.find(item=>item.id===feedback.id);if(historical&&historical.status==='requested')historical.status=feedback.expiresAt<=this.clock()?'expired':'retracted';
      this.userFeedback=null;this.userFeedbackAuthority=null;
    }
    return this.userFeedback?structuredClone(this.userFeedback):null;
  }
  async recordPerception(candidate){
    const token=this.token;const rejected=this.historicalAuthority(candidate);if(rejected)return rejected;
    const grant=token.learningGrants?.get(candidate.basisObservationId)??{learningUse:'unknown'};
    const {personPresence,...perception}=candidate;
    const result=this.continuity.recordPerception(perception,{observation:structuredClone(token.observations.get(candidate.basisObservationId)),mode:this.mode,deskId:token.deskId,...grant});
    if(result?.id&&result.accepted!==false&&result.status!=='rejected'&&personPresence!==undefined){token.personPresence??=new Map();token.personPresence.set(candidate.basisObservationId,{value:personPresence,id:result.id,revision:result.revision});}
    if(result?.id&&result.accepted!==false&&result.status!=='rejected'&&personPresence!==undefined){
      const o=token.observations.get(candidate.basisObservationId);
      if(o?.source==='camera'&&o.stream?.transport==='webrtc'){
        const key=JSON.stringify([o.stream.id,o.stream.startedAt]),previous=this.semanticThoughtPresence.get(key);
        if(!previous||previous.at<=o.at)this.semanticThoughtPresence.set(key,{value:personPresence==='unknown'&&previous?.value==='absent'?'absent':personPresence,at:o.at});
        while(this.semanticThoughtPresence.size>16)this.semanticThoughtPresence.delete(this.semanticThoughtPresence.keys().next().value);
      }
    }
    if(result?.id&&personPresence==='present'){const o=token.observations.get(candidate.basisObservationId);if(o?.source==='camera'){this.semanticPersonUntil=o.at+15000;this.semanticPersonStream=o.stream?.id;}}
    if(result?.id&&result.accepted!==false&&result.status!=='rejected')this.issue(result.id,{type:'perception',at:this.clock(),epoch:token.epoch});
    this.record('perception_recorded',{id:result?.id,status:result?.status,reason:result?.reason});this.publish();return result;
  }
  pendingThoughtSnapshot(){
    this.pendingThoughts=this.pendingThoughts.filter(item=>item.epoch===this.epoch&&item.deskId===this.profile().deskId&&item.expiresAt>this.clock()&&this.thoughtSourcesCurrent(item));
    return structuredClone(this.pendingThoughts);
  }
  deferThought(feedback,displaying){
    this.pendingThoughtSnapshot();
    let held=this.pendingThoughts.find(item=>item.message===feedback.message);
    if(!held){held={...structuredClone(feedback),expiresAt:this.clock()+30*60000,status:'pending_reconsideration',presentationStatus:'not_requested'};this.pendingThoughts.push(held);this.pendingThoughts=this.pendingThoughts.slice(-5);this.record('thought_deferred',{id:held.id,message:held.message,inference:held.inference,evidenceRefs:held.evidenceRefs,reason:'screen_occupied',presentationStatus:'not_requested'});}
    return {accepted:false,status:'deferred',reason:'message_still_displaying',id:displaying.id,pendingThoughtId:held.id,presentationStatus:'not_requested',hint:'Saved only for later reconsideration. Use a fresh current basis, recheck relevance and cite pendingThoughtId to consume; never auto-replay.',userFeedback:displaying};
  }
  presentPreparedThought(){
    const candidate=this.preparedReply;
    if(!candidate)return false;
    const {feedback,authority,validUntil}=candidate;
    if(validUntil<=this.clock()||feedback.epoch!==this.epoch||feedback.deskId!==this.profile().deskId||!this.thoughtSourcesCurrent(feedback)){this.preparedReply=null;return false;}
    if(!this.enabled||!this.visualExchange.snapshot().active||this.userFeedbackSnapshot()||this.reminderDisplay||this.personOrientation.snapshot().suppressFeedback||!this.thoughtVisible(authority)||!this.matchesEvidence(authority.basis))return false;
    this.preparedReply=null;
    const now=this.clock(),shown={...feedback,createdAt:now,expiresAt:Math.min(now+3500,validUntil),facingAtRequest:this.visualExchange.snapshot().facing==='toward'?'toward_proxy':'face_visible'};
    if(shown.expiresAt-now<3000)return false;
    this.userFeedback=shown;this.userFeedbackAuthority=authority;this.userFeedbackHistory.push({...structuredClone(shown),status:'requested'});this.userFeedbackHistory=this.userFeedbackHistory.slice(-5);
    this.record('user_feedback_requested',{id:shown.id,message:shown.message,inference:shown.inference,evidenceRefs:shown.evidenceRefs,presentationStatus:'requested',delivery:'pi_prepared_visual_opening',userAttention:'unknown'});this.publish();return true;
  }
  async shareThought(request){
    const rejected=this.semanticAuthority();if(rejected)return rejected;
    const token=this.token;
    try{
      fields(request,['basisObservationId','evidenceRefs','inference','uncertainty','message','alternatives','durationMs','pendingThoughtId','delivery','perception'],'shared_thought');identifier(request.basisObservationId,'observation_id');
      const bounded=(value,max)=>typeof value==='string'&&value.trim()&&Array.from(value.trim()).length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
      if(!bounded(request.inference,300)||request.uncertainty!==undefined&&!bounded(request.uncertainty,200)||!bounded(request.message,16)||!/[\p{Script=Han}]/u.test(request.message))return this.rejected('invalid_thought_text');
      if(request.alternatives!==undefined&&(!Array.isArray(request.alternatives)||request.alternatives.length>3||request.alternatives.some(value=>!bounded(value,16)||!/[\p{Script=Han}]/u.test(value))))return this.rejected('invalid_thought_text');
      if(request.pendingThoughtId!==undefined&&!this.pendingThoughtSnapshot().some(item=>item.id===request.pendingThoughtId))return this.rejected('pending_thought_not_current');
      if(request.delivery!==undefined&&!['now','next_visual_opening'].includes(request.delivery))return this.rejected('invalid_thought_delivery');
      const prepare=request.delivery==='next_visual_opening';
      const durationMs=request.durationMs??(this.visualExchange.snapshot().active?3500:7000);number(durationMs,3000,15000,'thought_duration');
      const basis=token.observations.get(request.basisObservationId),age=this.clock()-basis?.at,maxBasisAge=basis?.source==='camera'&&basis.stream?.transport==='webrtc'?20000:10000;
      if(!basis||!['camera','replay'].includes(basis.source)||!['visible','partial'].includes(basis.coverage)||!Number.isFinite(age)||age< -1000||age>maxBasisAge)return this.rejected('thought_basis_not_current');
      let evidenceRefs=request.evidenceRefs;
      if(request.perception!==undefined){
        if(evidenceRefs!==undefined)return this.rejected('ambiguous_thought_evidence');
        fields(request.perception,['description','personPresence','visualSubjects'],'inline_perception');
        if(!bounded(request.perception.description,500)||request.perception.personPresence!=='present')return this.rejected('invalid_inline_perception');
        const perception=await this.recordPerception({basisObservationId:request.basisObservationId,...request.perception});
        if(this.token!==token||this.semanticAuthority())return this.rejected('run_cancelled');
        if(!perception?.id||perception.status==='rejected')return this.rejected('invalid_thought_evidence');
        evidenceRefs=[{id:perception.id,revision:perception.revision}];
      }
      if(!Array.isArray(evidenceRefs)||evidenceRefs.length<1||evidenceRefs.length>4)return this.rejected('invalid_thought_evidence');
      const refs=evidenceRefs.map(ref=>{fields(ref,['id','revision'],'thought_evidence');identifier(ref.id,'evidence_id');if(!Number.isSafeInteger(ref.revision)||ref.revision<1)throw new Error('invalid_revision');return {id:ref.id,revision:ref.revision};});
      if(new Set(refs.map(ref=>ref.id)).size!==refs.length)return this.rejected('invalid_thought_evidence');
      const createdAt=this.clock(),expiresAt=Math.min(createdAt+durationMs,basis.at+30000);
      if(expiresAt-createdAt<3000)return this.rejected('thought_display_window_expired');
      const feedback={id:randomUUID(),inference:request.inference.trim(),...(request.uncertainty===undefined?{}:{uncertainty:request.uncertainty.trim()}),message:request.message.trim(),evidenceRefs:refs,createdAt,expiresAt,deskId:token.deskId,epoch:token.epoch,presentationStatus:'requested',semanticStatus:'model_inferred'};
      if(!this.thoughtSourcesCurrent(feedback))return this.rejected('invalid_thought_evidence');
      const target=[...(token.targets?.entries()??[])].map(([targetId,ref])=>({targetId,streamId:ref.streamId,epoch:token.epoch})).find(ref=>basis.source==='camera'&&basis.stream?.id===ref.streamId&&this.supportTargetCurrent(ref));
      const authority={basis:structuredClone(basis),target:target??null,presenceGrants:token.personPresence,deskId:token.deskId,presenceUntil:basis.at+30000};
      if(!this.thoughtVisible(authority))return this.rejected('thought_recipient_not_current');
      if(this.token!==token||this.runAuthority())return this.rejected('run_cancelled');
      const displaying=this.userFeedbackSnapshot();if(displaying&&!prepare)return this.deferThought(feedback,displaying);
      if(typeof this.prepareUserMessage==='function'){
        let prepared;
        for(const message of [...new Set([request.message,...(request.alternatives??[])].map(value=>value.trim()))]){
          prepared=await this.prepareUserMessage(message);
          if(this.token!==token||this.semanticAuthority())return this.rejected('run_cancelled');
          if(prepared?.fits===true){feedback.message=message;break;}
        }
        // Preparation only measures a static screen layout. It never retains
        // authority across the await or proves that anything was presented.
        if(this.token!==token||this.semanticAuthority())return this.rejected('run_cancelled');
        if(!this.thoughtSourcesCurrent(feedback))return this.rejected('invalid_thought_evidence');
        const currentAge=this.clock()-basis.at;
        if(!Number.isFinite(currentAge)||currentAge< -1000||currentAge>maxBasisAge)return this.rejected('thought_basis_not_current');
        if(!this.thoughtVisible(authority))return this.rejected('thought_recipient_not_current');
        const currentMessage=this.userFeedbackSnapshot();
        if(currentMessage&&!prepare)return this.deferThought(feedback,currentMessage);
        if(prepared?.fits!==true)return {...this.rejected('message_not_fit'),hint:'请保留原意和语气，浓缩为更短的完整短句，优先3–6字，并提供2–3个同义完整alternatives供排版选择；保留味道，不改成状态词，不截字或分页。'};
        feedback.createdAt=this.clock();feedback.expiresAt=Math.min(feedback.createdAt+durationMs,basis.at+30000);
        if(feedback.expiresAt-feedback.createdAt<3000)return this.rejected('thought_display_window_expired');
      }
      if(prepare){
        const validUntil=Math.min(this.clock()+20000,basis.at+30000);
        if(validUntil-this.clock()<3000)return this.rejected('prepared_reply_window_expired');
        this.preparedReply={feedback,authority,validUntil};
        this.record('thought_prepared',{id:feedback.id,message:feedback.message,evidenceRefs:refs,validUntil,presentationStatus:'not_requested'});
        return {accepted:true,status:'prepared',id:feedback.id,validUntil,presentationStatus:'not_requested',hint:'One Pi-authored reply reserved for a brief frontal encounter, only while current evidence remains compatible. Not displayed yet.'};
      }
      const hypothesis=this.continuity.rememberBelief({summary:feedback.inference+(feedback.uncertainty?`\n不确定：${feedback.uncertainty}`:''),evidenceIds:refs.map(ref=>ref.id),kind:'hypothesis'});
      if(request.pendingThoughtId)this.pendingThoughts=this.pendingThoughts.filter(item=>item.id!==request.pendingThoughtId);
      feedback.facingAtRequest=this.visualExchange.snapshot().facing==='toward'?'toward_proxy':this.visualExchange.snapshot().active?'face_visible':'unknown';
      this.userFeedback=feedback;this.userFeedbackAuthority=authority;this.userFeedbackHistory.push({...structuredClone(feedback),status:'requested'});this.userFeedbackHistory=this.userFeedbackHistory.slice(-5);
      this.record('user_feedback_requested',{id:feedback.id,message:feedback.message,inference:feedback.inference,uncertainty:feedback.uncertainty??null,evidenceRefs:refs,hypothesisId:hypothesis.id,presentationStatus:'requested',userAttention:'unknown',userCompletion:'unknown'});
      this.publish();return {accepted:true,status:'accepted',presentationStatus:'requested',hypothesisId:hypothesis.id,userFeedback:structuredClone(feedback)};
    }catch{return this.rejected('invalid_thought_request');}
  }
  encourage(request){
    fields(request,['basisObservationId','targetId','style','durationMs','responseWindowMs'],'encouragement');
    identifier(request.basisObservationId,'observation_id');
    const variants={bright:{openness:.98,tilt:-5,roundness:1},warm:{openness:.72,tilt:6,roundness:1},playful:{openness:.86,tilt:-9,roundness:.9}};
    if(!Object.hasOwn(variants,request.style))return this.rejected('invalid_encouragement_style');
    number(request.durationMs,500,3500,'duration');
    const token=this.token,original=token?.observations?.get(request.basisObservationId);let supportEvidence=null,supportTarget=null;
    if(request.targetId!==undefined){
      identifier(request.targetId,'target_id');const ref=token?.targets?.get(request.targetId);
      if(this.runAuthority()||!original||original.source!=='camera'||!Number.isFinite(original.at)||this.clock()-original.at>10000||!ref||ref.epoch!==this.epoch)return this.rejected('support_target_not_current');
      supportTarget={targetId:request.targetId,streamId:ref.streamId,epoch:this.epoch};
      if(!this.supportTargetCurrent(supportTarget))return this.rejected('support_target_not_current');
      supportEvidence=this.freshObservation();
    }
    const receipt=this.express({basisObservationId:request.basisObservationId,durationMs:request.durationMs,responseWindowMs:request.responseWindowMs??10000,eyes:{...variants[request.style],color:'#BFF478'},icon:'sparkle',gesture:'idle'},token,{supportEvidence,supportTarget,supportOriginalAt:original?.at});
    if(receipt.status==='accepted'){this.currentInteraction={type:'encouragement',receiptId:receipt.id,expiresAt:this.body.expressionUntil};this.record('interaction_started',{type:'encouragement',receiptId:receipt.id});this.publish();}
    return receipt;
  }
  supportTargetCurrent(ref){
    if(!ref||!this.enabled||this.closed||ref.epoch!==this.epoch)return false;const sight=this.attention.snapshot(),observation=this.freshObservation();
    return sight.streamId===ref.streamId&&this.clock()-sight.observedAt<500&&sight.targets.some(t=>t.id===ref.targetId&&t.confidence>=.90)&&observation?.source==='camera'&&observation.stream?.id===ref.streamId;
  }
  express(intent,token,{reminderId=null,supportEvidence=null,supportTarget=null,supportOriginalAt=null}={}){
    if(backgroundEvent(token?.event))return this.rejected('background_body_forbidden');
    if(this.inputFeedbackUntil>this.clock())return this.rejected('explicit_feedback_active');
    if(intent.responseWindowMs!==undefined){number(intent.responseWindowMs,100,10000,'response_window');const remaining=(supportEvidence?supportOriginalAt:(token?.evidence?.at??-Infinity))+intent.responseWindowMs-this.clock();if(remaining<100)return this.rejected('response_window_expired');intent={...intent,durationMs:Math.min(intent.durationMs,remaining)};}
    if(token?.event.expiresAt!==undefined){const remaining=token.event.expiresAt-this.clock();if(remaining<100)return this.rejected('interaction_window_expired');intent={...intent,durationMs:Math.min(intent.durationMs,remaining)};}
    const actionEvidence=supportEvidence??token?.evidence;
    const current=this.token===token&&(supportEvidence?this.supportTargetCurrent(supportTarget):this.evidenceCurrent(token?.evidence));
    if(supportEvidence)intent={...intent,basisObservationId:supportEvidence.id};
    if(!reminderId&&this.reminderDisplay&&this.body.expressionCommandId===this.reminderDisplay.receiptId&&this.body.expressionUntil>this.clock())return this.rejected('reminder_owns_expression');
    let lease=null;
    if(current&&this.autonomy&&!reminderId&&token.event.kind!=='input'){
      lease=this.autonomy.reserveInvitation({requestId:randomUUID(),deskId:token.deskId,epoch:token.epoch,durationMs:intent.durationMs,...(token.event.kind==='interest'?{interestId:token.event.payload.interestId}:{})},{enabled:this.enabled,profile:this.profile()});
      if(!lease.accepted)return this.rejected(lease.reason);
    }
    const r=current?this.applyBodyIntent(intent,{epoch:token.epoch,evidence:actionEvidence,owner:reminderId?`reminder:${reminderId}`:token.event.kind==='input'?'input':'pi',priority:reminderId?60:token.event.kind==='input'?90:30}):this.body.receipt('rejected',this.active()?'evidence_changed':'run_cancelled',intent.basisObservationId);
    if(lease){
      const settled=this.autonomy.settleInvitation({leaseId:lease.leaseId,epoch:token.epoch,outcome:r.status==='accepted'?'delivered':'rejected',...(r.status==='accepted'?{receipt:r}:{})});
      if(r.status==='accepted'&&!settled.accepted){this.body.stopExpression(r.id,'invitation_not_delivered');if(this.body.headCommandId===r.id)this.body.stopHead();return this.rejected(settled.status);}
      if(r.status==='accepted')this.lastInvitation={leaseId:lease.leaseId,receiptId:r.id,epoch:token.epoch};
    }
    if(r.status==='accepted'){this.expressionBasis={receiptId:r.id,evidence:structuredClone(actionEvidence),epoch:token.epoch,...(supportTarget?{supportTarget:{...supportTarget}}:{})};if(intent.head){this.attentionGeneration++;this.attention.reset('explicit_head');this.localSight=null;this.attentionOwnsHead=false;this.body.stopGaze();}this.issue(r.id,{type:'receipt',at:r.at,status:r.status,epoch:token.epoch});this.reminderDisplay=reminderId?{reminderId,receiptId:r.id,evidence:token.evidence}:null;}
    this.record(r.status==='accepted'?'body_accepted':'body_rejected',r);
    if(r.status==='accepted')this.store.append({kind:'action',summary:'身体适配器已接受一次有限的头姿／圆屏表达；实际执行需设备回执，不代表已识别人的工作动作。',evidenceIds:[r.id],subject:'simulation'});
    this.publish();return r;
  }
  reconcileExpressionBasis(){
    const basis=this.expressionBasis;if(!basis)return;
    if(this.body.expressionCommandId!==basis.receiptId){this.expressionBasis=null;return;}
    if(basis.epoch===this.epoch&&(basis.supportTarget?this.supportTargetCurrent(basis.supportTarget):this.matchesEvidence(basis.evidence)))return;
    this.stopExpressionPlayback('evidence_changed');this.releaseReceipt(basis.receiptId,'evidence_changed');this.body.stopExpression(basis.receiptId,'evidence_changed');
    if(this.body.headCommandId===basis.receiptId)this.body.stopHead();
    this.expressionBasis=null;
  }
  applyBodyIntent(intent,{epoch,evidence,owner,priority}){
    if(this.rigManager?.snapshot().profile==='integrated-device'&&intent.head){
      if(Math.abs(intent.head.pitch??0)>15)return this.rejected('hardware_head_limit');
      if(this.videoIngress?.physicalMotionAllowed?.()===false)return this.rejected('privacy_mask_locks_camera_motion');
    }
    const validation=this.body.authorize(intent,{epoch,observationId:evidence?.id,observedAt:evidence?.at});if(validation.error)return validation.error;
    let grant=null;
    if(this.actionArbiter){
      grant=this.actionArbiter.claim({requestId:randomUUID(),owner,channels:intent.head?['screen','head']:['screen'],durationMs:intent.durationMs,priority},{enabled:this.enabled&&!this.closed,epoch,deskId:this.profile().deskId});
      if(!grant.accepted)return this.body.receipt('rejected',grant.reason,intent.basisObservationId);
      this.applySupersession(grant);
    }
    const receipt=this.body.apply(intent,{epoch,observationId:evidence?.id,observedAt:evidence?.at,...(grant?.lease?{leaseUntil:grant.lease.expiresAt}:{})});
    if(grant){if(receipt.status==='accepted')this.bodyLeases.set(grant.lease.leaseId,{receiptId:receipt.id,channels:grant.lease.channels});else this.actionArbiter.release({leaseId:grant.lease.leaseId,reason:'body_rejected'});}
    return receipt;
  }
  applySupersession(grant,{preserveSight=false}={}){
    if(!grant.supersededChannels){for(const id of grant.superseded??[])this.endBodyLease(id,'superseded');return;}
    for(const change of grant.supersededChannels){
      const lease=this.bodyLeases.get(change.leaseId);if(!lease)continue;
      if(change.channels.includes('screen'))this.body.stopExpression(lease.receiptId,'superseded');
      if(change.channels.includes('head')){
        if(lease.attention&&this.attentionLease===change.leaseId){this.attentionLease=null;if(!preserveSight)this.attention.reset('superseded');this.attentionGeneration++;this.body.stopGaze();this.attentionOwnsHead=false;}
        if(lease.rig)this.rigManager?.stop('superseded');
        if(this.body.headCommandId===lease.receiptId)this.body.stopHead();
      }
      lease.channels=lease.channels.filter(channel=>!change.channels.includes(channel));if(!lease.channels.length)this.bodyLeases.delete(change.leaseId);
    }
  }
  endBodyLease(id,reason){
    const lease=this.bodyLeases.get(id);if(!lease)return;
    if(lease.attention&&this.attentionLease===id){this.attentionLease=null;this.attention.reset(reason);this.attentionGeneration++;this.body.stopGaze();this.attentionOwnsHead=false;}
    if(lease.rig)this.rigManager?.stop(reason);
    if(lease.channels.includes('screen'))this.body.stopExpression(lease.receiptId,reason);
    if(lease.channels.includes('head')&&this.body.headCommandId===lease.receiptId)this.body.stopHead();
    this.bodyLeases.delete(id);
  }
  releaseReceipt(receiptId,reason){
    for(const [id,lease] of this.bodyLeases)if(lease.receiptId===receiptId){this.actionArbiter?.release({leaseId:id,reason});this.endBodyLease(id,reason);}
  }
  companionSnapshot(){
    const continuity=this.continuity?.snapshot()??{perceptions:[],episodes:[],beliefs:[],interests:[],profile:this.profile(),learning:[]};
    const hasPerception=this.mode!=='fixture'&&(continuity.perceptions??[]).some(r=>r.status!=='retracted'&&['camera','replay'].includes(r.source));
    return {...continuity,observationHistory:this.observationHistory.snapshot(),diary:this.readDiary(),reminders:this.reminders?.snapshot()??[],subject:{confirmed:this.subjectCurrent(this.freshObservation()),identity:'unknown',targetId:this.subject?.targetId??null},perceptionStatus:{mode:this.mode,hasPerception,description:this.mode==='fixture'?'离线仿真未进行视觉理解；示例提醒仅验证机制。':hasPerception?'已有带来源的感知片段；当前情况仍需新证据核验。':'尚无已记录的感知片段；模型未配置或证据不足时不生成事实。'}};
  }
  respondToReminder(input){
    if(!this.reminders)throw new Error('reminders_unavailable');
    fields(input,['id','action','roundId','receiptId','epoch'],'reminder_response');
    if(input.epoch!==undefined&&input.epoch!==this.epoch)throw new Error('interaction_epoch_changed');
    const previous=this.reminders.snapshot().find(r=>r.id===input?.id);
    if(previous?.deskId&&previous.deskId!==this.profile().deskId)throw new Error('reminder_desk_changed');
    const {epoch,...response}=input;const goal=this.reminders.respond(response);
    const changed=previous?.lastUserAction!==goal.lastUserAction||previous?.lastUserRound!==goal.lastUserRound||previous?.lastUserAttempt!==goal.lastUserAttempt;
    if(changed)this.cancelReminderWork(goal.id,'explicit_reminder_response');
    if(previous?.lastReceiptId&&this.body.expressionCommandId===previous.lastReceiptId){
      this.releaseReceipt(previous.lastReceiptId,'reminder_response');this.body.stopExpression(previous.lastReceiptId,'reminder_response');if(this.body.headCommandId===previous.lastReceiptId)this.body.stopHead();this.reminderDisplay=null;
      const evidence=this.freshObservation();
      if(this.enabled&&evidence){this.stopExpressionPlayback('explicit_input');this.applyBodyIntent({basisObservationId:evidence.id,durationMs:700,icon:input.action==='done'?'check':input.action==='snooze'?'clock':'none',eyes:{openness:input.action==='done'?.9:.55}},{epoch:this.epoch,evidence,owner:'input',priority:100});this.inputFeedbackUntil=this.clock()+700;}
    }
    if(changed&&goal.source!=='demo'&&this.continuity){
      const outcomes={seen:'明确选择已看到，未确认完成',snooze:'明确选择稍后再提醒',done:'明确确认本轮已完成',dismiss:'明确选择拒绝本轮提醒',disable:'明确选择永久关闭此关心'};
      this.continuity.recordInteraction({kind:'reminder_response',summary:`用户对「${goal.label}」${outcomes[input.action]}。`,deskId:goal.deskId});
    }
    this.record('reminder_response',{id:goal.id,action:input.action,status:goal.status,source:goal.source});this.publish();return goal;
  }
  confirmPresentation(input){
    fields(input,['id','roundId','receiptId','epoch'],'presentation_receipt');
    if(!this.reminders?.confirmPresentation)return this.rejected('presentation_unavailable');
    const display=this.reminderDisplay;
    const current=()=>Boolean(!this.closed&&this.enabled&&input.epoch===this.epoch&&display===this.reminderDisplay&&display?.reminderId===input.id&&display?.receiptId===input.receiptId&&this.body.expressionCommandId===input.receiptId&&this.body.expressionUntil>this.clock()&&this.matchesEvidence(display.evidence));
    if(!current())return this.rejected('presentation_stale');
    const {epoch,...receipt}=input;
    const result=this.reminders.confirmPresentation(receipt,{enabled:this.enabled,epoch,deskId:this.profile().deskId,isCurrent:current});
    if(result.status==='accepted'&&!result.duplicate){this.record('presentation_confirmed',{id:input.id,receiptId:input.receiptId,source:'browser_presentation'});this.publish();}
    return result;
  }
  retractReminder(reason){
    const display=this.reminderDisplay;
    if(!display)return;
    // A newer unrelated expression owns the face and must not be cancelled.
    if(this.body.expressionCommandId===display.receiptId){this.releaseReceipt(display.receiptId,reason);this.body.stopExpression(display.receiptId,reason);if(this.body.headCommandId===display.receiptId)this.body.stopHead();this.record('reminder_retracted',{id:display.reminderId,reason});}
    this.reminderDisplay=null;
  }
  cancelReminderWork(id,reason){
    this.cancelQueuedWhere(event=>event.kind==='reminder'&&event.payload.id===id);
    this.inbox=this.inbox.filter(event=>event.kind!=='reminder'||event.payload.id!==id);
    const token=this.token;
    if(!token||token.cancelled||!(token.event.kind==='reminder'&&token.event.payload.id===id||token.reminderIds?.has(id)))return;
    token.cancelled=true;this.settleToken(token);this.runtime.abort();
    if(this.enabled)this.phase='resting';
    this.record('reminder_work_cancelled',{id,reason});
  }
  pauseReminderToday(input){
    if(!this.reminders)throw new Error('reminders_unavailable');
    const previous=this.reminders.snapshot().find(r=>r.id===input?.id);if(previous?.deskId&&previous.deskId!==this.profile().deskId)throw new Error('reminder_desk_changed');
    const goal=this.reminders.pauseToday(input);
    if(this.reminderDisplay?.reminderId===goal.id)this.retractReminder('user_paused_today');
    this.cancelReminderWork(goal.id,'user_paused_today');
    this.continuity?.recordInteraction({kind:'explicit_feedback',summary:`用户明确暂停「${goal.label}」至今天结束；未取消长期关心。`,deskId:goal.deskId});this.publish();return goal;
  }
  active(){return Boolean(!this.closed&&this.enabled&&this.token&&!this.token.cancelled&&this.token.epoch===this.epoch);}
  subjectInterests(){
    const deskId=this.profile().deskId;
    const questions=(this.continuity?.snapshot().interests??[]).filter(record=>record.status==='active'&&record.deskId===deskId);
    const plans=this.planHost?.interests(this.planContext())??[];
    return [...questions,...plans];
  }
  freshInterestEvent(event){
    const plan=this.planHost?.resolveEvent(event,this.planContext());
    if(plan)return {...event,payload:{...event.payload,plan,question:plan.goal,evidenceIds:plan.evidenceRefs.map(ref=>ref.id)}};
    const interest=this.continuity?.snapshot().interests.find(record=>record.id===event.payload.interestId&&record.status==='active'&&record.deskId===this.profile().deskId&&record.revision===event.payload.interestRevision);
    return interest?{...event,payload:{...event.payload,question:interest.question,evidenceIds:interest.evidenceIds}}:null;
  }
  pollAutonomy(force=false){
    if(!this.autonomy||this.closed||!this.providerCanStart())return;
    const now=this.clock();if(!force&&now>=this.lastAutonomyPollAt&&now-this.lastAutonomyPollAt<250)return;this.lastAutonomyPollAt=now;
    const result=this.autonomy.poll({enabled:this.enabled,epoch:this.epoch,deskId:this.profile().deskId,mode:this.mode,profile:this.profile(),observation:this.freshObservation(),interests:this.subjectInterests(),inferenceBusy:this.busy,allowReplay:false});
    this.autonomyReason=result.reason;
    if(result.reason==='claim_invalidated'&&this.token?.event.kind==='interest'&&!this.token.cancelled){this.token.cancelled=true;this.runtime.abort();}
    for(const event of result.events){
      if(this.queuedCount()>=40){this.autonomy.settle({id:event.id,outcome:'aborted'});continue;}
      const current=this.freshInterestEvent(event);if(current)this.queue(current);else this.autonomy.settle({id:event.id,outcome:'aborted'});
    }
  }
  autonomySnapshot(){
    const profile=this.profile(),state=this.autonomy?.snapshot(),policy=this.autonomyPolicy;
    const delivered=state?.deliveredByDesk?.find(r=>r.deskId===profile.deskId)?.count??0;
    const cooldownUntil=state?.cooldowns?.find(r=>r.deskId===profile.deskId)?.until;
    const interests=this.subjectInterests().filter(record=>Number.isFinite(record.nextAt));
    return {status:!this.autonomy?'unavailable':!this.enabled?'paused':state?.inFlight?'reviewing':cooldownUntil?'cooldown':'waiting',ordinaryInvitations:{delivered,limit:profile.quietMode||profile.curiosity==='minimal'?policy.restrictedInvitationLimit:policy.invitationLimit,windowMs:policy.invitationWindowMs,...(cooldownUntil?{cooldownUntil}:{})},...(interests.length?{nextReviewAt:Math.min(...interests.map(r=>r.nextAt))}:{}),lastOutcome:this.autonomyReason};
  }
  requireActive(){if(!this.active())throw new Error('run_cancelled');}
  freshObservation(){return this.observation&&this.clock()-this.observation.at<=OBSERVATION_MAX_AGE&&this.observation.at<=this.clock()+1000?this.observation:null;}
  providerCanStart(){return this.providerAvailability.canStart(this.freshObservation()?.frames.at(-1)?.at);}
  issue(id,reference){this.issued.set(id,reference);if(this.issued.size>512)this.issued.delete(this.issued.keys().next().value);}
  fingerprint(o){return createHash('sha256').update(JSON.stringify({source:o.source,coverage:o.coverage,view:o.view,frames:o.frames.map(({mimeType,data,width,height})=>({mimeType,data,width,height}))})).digest('hex');}
  #rememberVisualSignature(o,signature){
    // Receiver-only sidechannel; never attach pixels to observations/model context.
    for(const [id,value] of this.#visualSignatures)if(this.clock()-value.frameAt>OBSERVATION_MAX_AGE)this.#visualSignatures.delete(id);
    if(!signature||signature.frameAt!==o.at||signature.frameAt!==o.frames.at(-1).at||typeof signature.pixels!=='string'||signature.pixels.length!==3072||!/^[A-Za-z0-9+/]{3072}$/.test(signature.pixels))return;
    const pixels=Buffer.from(signature.pixels,'base64');
    if(pixels.length!==2304||pixels.toString('base64')!==signature.pixels)return;
    this.#visualSignatures.set(o.id,{frameAt:signature.frameAt,pixels});
    while(this.#visualSignatures.size>64)this.#visualSignatures.delete(this.#visualSignatures.keys().next().value);
  }
  matchesEvidence(evidence){
    const current=this.freshObservation();
    if(!evidence||!current||this.clock()-evidence.at>OBSERVATION_MAX_AGE||evidence.at>this.clock()+1000)return false;
    if([evidence,current].some(o=>this.issued.get(o.id)?.epoch!==this.epoch))return false;
    const scope=o=>JSON.stringify({source:o.source,coverage:o.coverage,view:o.view,streamId:o.stream?.id,startedAt:o.stream?.startedAt,gaps:o.stream?.gaps});
    if(scope(current)!==scope(evidence))return false;
    if(this.fingerprint(current)===this.fingerprint(evidence))return true;
    if(!evidence.stream||!current.stream)return false; // Public HTTP stays byte-exact.
    const a=this.#visualSignatures.get(evidence.id),b=this.#visualSignatures.get(current.id);
    if(!a||!b||a.frameAt!==evidence.frames.at(-1).at||b.frameAt!==current.frames.at(-1).at)return false;
    const dimensions=o=>JSON.stringify(o.frames.at(-1)&&[o.frames.at(-1).mimeType,o.frames.at(-1).width,o.frames.at(-1).height]);
    if(dimensions(evidence)!==dimensions(current))return false;
    for(let i=0;i<a.pixels.length;i++)if(Math.abs(a.pixels[i]-b.pixels[i])>2)return false;
    return true;
  }
  evidenceCurrent(evidence){return !this.runAuthority()&&this.matchesEvidence(evidence);}
  settleWake(event,completed){if(this.closed)return;if(event?.kind==='expression'){this.releaseExpressionWork(event,completed?'finished_without_candidate':'interrupted');return;}if(event?.kind==='diary'){if(event.claim?.type==='moment_comic'){this.momentComicsHost?.release(event.claim,completed?'selection_finished':'selection_interrupted');return;}if(event.claim){try{this.comic.release(event.claim.id,{claimToken:event.claim.claimToken,reason:completed?'finished_without_publication':'interrupted'});}catch{/* Published or revoked claims have no pending lease. */}}return;}if(event?.kind==='reminder'){if(this.reminders?.snapshot().find(r=>r.id===event.payload.id)?.status==='reviewing')this.reminders.release(event.payload.id,{reason:completed?'review_finished_without_delivery':'run_interrupted'});return;}if(event?.kind!=='wake')return;if(completed)this.store.acknowledgeWake?.(event.payload.id);else this.store.releaseWake?.(event.payload.id);}
  settleToken(token){if(!token||token.settled)return;token.settled=true;if(token.queueLeaseId)this.eventQueue?.settle({leaseId:token.queueLeaseId,outcome:token.completed&&!token.cancelled&&token.epoch===this.epoch?'completed':'aborted'});if(token.event.kind==='interest')this.autonomy?.settle({id:token.event.id,outcome:token.completed&&token.epoch===this.epoch&&!token.cancelled?'completed':'aborted'});this.settleWake(token.event,token.completed&&token.epoch===this.epoch);}
  clearInbox(){if(this.eventQueue){this.consumeQueueChanges(this.eventQueue.interrupt({epoch:this.epoch,minimumPriority:101,reason:'scope_cancelled'}));this.deferredObservation=null;}for(const event of this.inbox){if(event.kind==='interest')this.autonomy?.settle({id:event.id,outcome:'aborted'});this.settleWake(event,false);}this.inbox=[];this.pending=null;}
  record(type,detail={}) {const event={id:randomUUID(),type:String(type).slice(0,60),at:this.clock(),detail:diagnostic(detail)};this.events.push(event);if(this.events.length>100)this.events.shift();if(['body_accepted','body_rejected','body_completed','interaction_started','reminder_response','input','presentation_confirmed','reminder_retracted','control','autonomous_reminder','continuity_revised','device_feedback','cognition_updated','presence_rest','presence_returned','person_orientation','visual_attention_returned','visual_exchange','thought_deferred','thought_prepared','moment_comic_result','gallery_input','user_feedback_requested'].includes(type)){this.continuityOutcomes.push({...event,deskId:this.profile().deskId,personaVersion:this.personaRegistry?.snapshot().active?.id??this.personaVersion});if(this.continuityOutcomes.length>80)this.continuityOutcomes.shift();this.runtime?.noteHostOutcome?.({...event,deskId:this.profile().deskId,personaVersion:this.personaRegistry?.snapshot().active?.id??this.personaVersion});}}
  publish(){if(this.closed)return;this.revision++;const state=this.snapshot();this.lastUserFeedbackPublishedId=state.userFeedback?.id??null;this.emit('state',state);}
  snapshot(){
    const o=this.observation;
    const userFeedback=this.userFeedbackSnapshot();
    const state={visualExchange:this.visualExchange.snapshot(),pendingThoughts:this.pendingThoughtSnapshot(),userFeedback,userFeedbackHistory:structuredClone(this.userFeedbackHistory),momentComics:this.momentComicsHost?.snapshot()??null,cognition:this.cognition?.snapshot({deskId:this.profile().deskId})??[],presence:this.presenceRest?.snapshot()??null,piContext:this.runtime.contextStatus?.()??null,experienceProfile:this.experienceProfile,interaction:this.currentInteraction?.receiptId===this.body.expressionCommandId&&this.currentInteraction.expiresAt>this.clock()?{...this.currentInteraction}:null,...(this.deviceStatus?{device:this.deviceStatus()}:{}),version:1,revision:this.revision,at:this.clock(),mode:this.mode,enabled:this.enabled,phase:this.phase,epoch:this.epoch,manualHeadPreview:Boolean(!this.enabled&&this.body.headUntil>this.clock()),body:{...this.body.snapshot(),...(this.rigManager?.snapshot().profile==='integrated-device'?{source:'hardware_intent',head:this.body.headUntil>this.clock()?this.body.snapshot().head:{yaw:this.rigManager.snapshot().camera.pose.yaw,pitch:this.rigManager.snapshot().camera.pose.pitch}}:{}),headCommandId:this.body.headCommandId,gazeCommandId:this.body.gazeCommandId,expressionCommandId:this.body.expressionCommandId,leaseEnds:{head:this.body.headUntil,expression:this.body.expressionUntil,gaze:this.body.gazeUntil},gazeBase:this.body.gazeBase?{...this.body.gazeBase}:null},persona:this.personaRegistry?.snapshot().active??{legacyVersion:this.personaVersion},work:this.eventQueue?.snapshot()??null,guidance:this.viewGuidance?.snapshot(this.viewContext())??null,attention:this.attention.snapshot(),personOrientation:{...this.personOrientation.snapshot(),commandId:this.personOrientationReceiptId},observation:o?{id:o.id,at:o.at,source:o.source,coverage:o.coverage,frameCount:o.frames.length,...(o.stream?{stream:structuredClone(o.stream)}:{})}:null,video:this.videoIngress?.snapshot()??idleVideo(),agent:{runtime:'pi-agent-core',...this.runtime.status(),availability:this.providerAvailability.snapshot()},companion:this.companionSnapshot(),comic:this.comicSnapshot(),autonomy:this.autonomySnapshot(),expressions:this.expressionSnapshot(),memory:this.store.snapshot(),events:this.events.map(e=>({...e})),error:this.error,...(this.rigManager?{rig:this.rigManager.snapshot()}:{})};
    return {...state,feedback:projectInteractionFeedback(state)};
  }
  control(action){
    if(!['start','pause','resume','stop','quiet'].includes(action))throw new Error('invalid_action');
    this.epoch++;this.presenceRest?.reset();this.wasPresenceResting=false;this.semanticPersonUntil=0;this.semanticPersonStream=null;this.observationHistory.reset({epoch:this.epoch,deskId:this.profile().deskId});this.settleToken(this.token);this.clearInbox();clearTimeout(this.retryTimer);this.retryTimer=null;
    this.autonomy?.cancel({epoch:this.epoch,reason:action});this.actionArbiter?.cancel({epoch:Math.max(0,this.epoch-1),reason:action});this.bodyLeases.clear();this.lastInvitation=null;
    this.visualExchange.reset();this.pendingThoughts=[];this.preparedReply=null;this.inputFeedbackUntil=0;this.expressionBasis=null;this.currentInteraction=null;this.userFeedback=null;this.userFeedbackAuthority=null;this.userFeedbackHistory=[];this.semanticThoughtPresence.clear();
    this.inferenceCadence?.reset({epoch:this.epoch,deskId:this.profile().deskId,reason:action});this.cadenceBasis=null;this.cadenceFingerprint=null;
    if(this.methodSession)this.behaviorMethods?.stopSession(this.methodSession);this.methodSession=null;
    this.viewGuidance?.stop(action);
    this.stopExpressionPlayback(action);if(this.expressionSession)this.expressionLibrary?.stopSession(this.expressionSession);this.expressionSession=null;
    this.reminderDisplay=null;this.stopAttention(action);this.body.stop(action);this.rigManager?.stop(action);this.videoIngress?.stop(action);this.runtime.abort();this.error=null;
    // A start/resume always needs fresh input; old frames cannot re-authorize an action.
    this.observation=null;this.#visualSignatures.clear();
    if(action==='start'||action==='resume'){
      this.enabled=true;this.activatedAt=this.clock();this.phase='observing';this.body.arm(this.epoch);
      this.undetailedTurnFailures=0;
      if(this.behaviorMethods){this.methodSession=`wake-${randomUUID()}`;this.behaviorMethods.activateForSession({sessionId:this.methodSession,...this.planContext(),enabled:true});}
      if(this.expressionLibrary){this.expressionSession=`wake-${randomUUID()}`;this.expressionLibrary.activateForSession({sessionId:this.expressionSession,deskId:this.profile().deskId,personaVersion:this.personaVersion,enabled:true,capabilities:this.expressionCapabilities});}
    }else {this.enabled=false;this.phase=action==='stop'?'stopped':'paused';}
    this.momentComicsHost?.tick();
    this.record('control',{action,epoch:this.epoch});this.publish();return this.snapshot();
  }
  observe(input,authority={}){return this.admitObservation(input,authority,false);}
  ingestObservation(input,authority={}){return this.observe(input,authority);}
  ingestVideoObservation(input,{admittedEpoch,visualSignature}={}){
    if(admittedEpoch!==this.epoch)throw Object.assign(new Error('observation_epoch_changed'),{status:409});
    if(!this.enabled||this.closed)throw Object.assign(new Error('video_ingress_inactive'),{status:409});
    return this.admitObservation(input,{admittedEpoch,visualSignature},true);
  }
  admitObservation(input,{admittedEpoch=this.epoch,visualSignature}={},video=false){
    if(admittedEpoch!==this.epoch)throw Object.assign(new Error('observation_epoch_changed'),{status:409});
    const o=video?validateVideoObservation(input):validateObservation(input);
    const age=this.clock()-o.at;
    if(this.enabled&&(o.at<this.activatedAt||o.frames.some(f=>f.at<this.activatedAt)))throw new Error('observation_predates_activation');
    if(age>OBSERVATION_MAX_AGE||age< -1000)throw new Error('stale_observation');
    if(o.frames.some(f=>f.at>this.clock()+1000||this.clock()-f.at>OBSERVATION_MAX_AGE))throw new Error('stale_frame');
    if(this.observation && o.at<this.observation.at)throw new Error('out_of_order_observation');
    if(this.issued.has(o.id))throw new Error('duplicate_observation_id');
    const profile=this.profile();
    const grant=this.evidenceUse==='test'||this.evidenceUse==='holdout'?{learningUse:this.evidenceUse}
      :this.mode==='cloud'&&o.source==='camera'&&profile.expressionLearning===true&&Number.isSafeInteger(profile.learningVersion)&&Number.isFinite(profile.learningSince)&&o.at>=profile.learningSince&&o.frames.every(f=>f.at>=profile.learningSince)
        ?{learningUse:'allowed',learningVersion:profile.learningVersion}:{learningUse:'unknown'};
    if(this.enabled&&['camera','replay'].includes(o.source)){
      const retained=this.observationHistory.capture(o,{enabled:true,epoch:this.epoch,deskId:profile.deskId,...grant});
      if(retained.duplicate||retained.reason==='conflict')throw new Error('duplicate_observation_id');
    }
    this.issue(o.id,{type:'observation',at:o.at,source:o.source,epoch:this.epoch,deskId:profile.deskId,...grant});
    if(video)this.#rememberVisualSignature(o,visualSignature);
    if(this.token?.event.kind==='expression'&&(!this.observation||this.significantChange(this.observation,o)))this.preemptExpressionProduction('current_view_changed');
    // Historical diary work yields to explicit input/commitments, not every changing video sample.
    this.observation=o;this.reconcileExpressionBasis();
    if(this.reminderDisplay&&!this.matchesEvidence(this.reminderDisplay.evidence))this.retractReminder('evidence_changed');
    this.record('observation',{id:o.id,source:o.source,frameCount:o.frames.length,coverage:o.coverage});
    this.publish();if(this.enabled&&!this.presenceRest?.snapshot().resting)this.queue({kind:'observation',at:this.clock(),payload:o});
    return {accepted:true,observationId:o.id,revision:this.revision};
  }
  input(value){
    fields(value,['kind','targetId'],'input');
    if(!['ack','snooze','dismiss','pause'].includes(value.kind))throw new Error('invalid_input');
    if(value.kind==='pause')return this.control('pause');
    if(value.targetId){
      if(typeof value.targetId!=='string'||value.targetId.length>100)throw new Error('invalid_target');
      if(value.kind==='dismiss'||value.kind==='ack')this.store.cancelWake(value.targetId);
      if(value.kind==='snooze'){
        const wake=this.store.snapshot().wakes.find(w=>w.id===value.targetId);
        if(!wake)throw new Error('unknown_wake');
        this.store.cancelWake(value.targetId);this.store.scheduleWake({at:this.clock()+5*60000,reason:wake.reason,attentionId:wake.attentionId});
      }
    }
    if(value.targetId){
      this.cancelQueuedWhere(event=>event.kind==='wake'&&event.payload.id===value.targetId);
      this.inbox=this.inbox.filter(e=>e.kind!=='wake'||e.payload.id!==value.targetId);
      if(this.token?.event.kind==='wake'&&this.token.event.payload.id===value.targetId){
        this.epoch++;this.presenceRest?.reset();this.wasPresenceResting=false;this.semanticPersonUntil=0;this.semanticPersonStream=null;this.observationHistory.reset({epoch:this.epoch,deskId:this.profile().deskId});this.autonomy?.cancel({epoch:this.epoch,reason:'wake_cancelled'});this.actionArbiter?.cancel({epoch:this.epoch-1,reason:'wake_cancelled'});this.bodyLeases.clear();this.stopAttention('wake_cancelled');this.stopExpressionPlayback('wake_cancelled');this.body.stop('wake_cancelled');this.rigManager?.stop('wake_cancelled');this.runtime.abort();this.observation=null;this.#visualSignatures.clear();this.pending=null;
        if(this.enabled){this.body.arm(this.epoch);this.activatedAt=this.clock();this.phase='observing';}
      }
    }
    this.record('input',{kind:value.kind,targetId:value.targetId??null});this.publish();
    if(this.enabled)this.queue({kind:'input',at:this.clock(),expiresAt:this.clock()+2000,payload:value});return this.snapshot();
  }
  previewHead(input){
    try{fields(input,['yaw','pitch','durationMs','epoch'],'head_preview');number(input.yaw,-45,45,'yaw');number(input.pitch,-20,20,'pitch');number(input.durationMs,100,5000,'duration');if(!Number.isSafeInteger(input.epoch)||input.epoch!==this.epoch)throw new Error('control_epoch_changed');}
    catch(error){return this.body.receipt('rejected',error.message);}
    if(this.closed)return this.rejected('controller_closed');
    const rig=this.rigManager?.snapshot();
    if(!['integrated-sim','integrated-device'].includes(rig?.profile)||!rig.presentation.headControlsCamera||!rig.camera.capabilities.panTilt)return this.rejected('integrated_simulation_required');
    if(rig.profile==='integrated-device'&&Math.abs(input.pitch)>15)return this.rejected('hardware_head_limit');
    this.control('pause');
    const {yaw,pitch,durationMs}=input;
    const receipt=this.body.previewHead({yaw,pitch,durationMs});
    this.record('manual_head_preview',receipt);this.publish();return receipt;
  }
  async moveCamera(input,token=null){
    try{fields(input,['yaw','pitch','durationMs','basisObservationId'],'camera_move');identifier(input.basisObservationId,'observation_id');number(input.yaw,-45,45,'yaw');number(input.pitch,-20,20,'pitch');number(input.durationMs,100,5000,'duration');}catch(error){return this.body.receipt('rejected',error.message,input?.basisObservationId);}
    if(backgroundEvent(token?.event))return this.rejected('background_body_forbidden');
    if(token){const rejected=this.interactionAuthority(token);if(rejected)return rejected;}
    if(!token)this.preemptComic('manual_head');
    if(!this.rigManager)throw new Error('camera_unavailable');
    if(this.rigManager.snapshot().profile==='integrated-device'&&this.videoIngress?.physicalMotionAllowed?.()===false)return this.rejected('privacy_mask_locks_camera_motion');
    const epoch=token?.epoch??this.epoch;
    const evidence=token?.evidence??this.freshObservation();
    if(token&&!this.evidenceCurrent(evidence))return this.body.receipt('rejected','evidence_changed',input.basisObservationId);
    const grant=this.claimHead(token?'pi':'input',token?30:90,input.durationMs);if(!grant.accepted)return this.rejected(grant.reason);
    if(grant.lease)this.bodyLeases.set(grant.lease.leaseId,{receiptId:null,channels:['head'],rig:true});
    const receipt=await this.rigManager.moveCamera(input,{...(grant.lease?{leaseUntil:grant.lease.expiresAt}:{}),enabled:this.enabled&&!this.closed,epoch,observationId:evidence?.id,observedAt:evidence?.at,isCurrent:()=>!this.closed&&this.enabled&&epoch===this.epoch&&(!token||!this.interactionAuthority(token))&&this.matchesEvidence(evidence)&&(!grant.lease||this.actionArbiter.check({leaseId:grant.lease.leaseId,epoch,deskId:this.profile().deskId}).usable)});
    if(grant.lease){const live=this.bodyLeases.get(grant.lease.leaseId);if(live)live.receiptId=receipt.id;if(receipt.status!=='accepted'&&receipt.status!=='completed'){this.actionArbiter.release({leaseId:grant.lease.leaseId,reason:'camera_rejected'});this.endBodyLease(grant.lease.leaseId,'camera_rejected');}}
    if(receipt.status==='accepted'){this.attentionGeneration++;this.attention.reset('manual_head');this.localSight=null;this.attentionOwnsHead=false;this.body.stopGaze();}
    this.record('camera_receipt',receipt);this.publish();return receipt;
  }
  queuedCount(){return this.eventQueue?this.eventQueue.snapshot().pendingCount??0:this.inbox.length;}
  hasQueuedKind(kind){return this.eventQueue?[...this.queueMetadata.values()].some(meta=>meta.event.kind===kind&&!meta.cancelled):this.inbox.some(event=>event.kind===kind);}
  releaseQueuedResource(meta){
    if(!meta||meta.released)return;meta.released=true;
    if(meta.event.kind==='interest')this.autonomy?.settle({id:meta.event.id,outcome:'aborted'});
    this.settleWake(meta.event,false);
  }
  consumeQueueChanges(receipt){
    const ended=[...(receipt?.released??[]),...(receipt?.queued??[]),...(receipt?.status==='interrupted'&&receipt.active?[receipt.active]:[]),...(receipt?.replaced?[receipt.replaced]:[])];
    for(const entry of ended){
      if(this.token?.queueId===entry.id&&!this.token.settled){this.token.cancelled=true;this.settleToken(this.token);if(this.enabled&&this.phase==='reasoning')this.phase='resting';this.runtime.abort();this.publish();}
      const meta=this.queueMetadata.get(entry.id);if(meta){this.releaseQueuedResource(meta);this.queueMetadata.delete(entry.id);}
    }
  }
  cancelQueuedWhere(predicate){
    if(!this.eventQueue)return;
    for(const meta of this.queueMetadata.values())if(!meta.cancelled&&predicate(meta.event)){meta.cancelled=true;this.releaseQueuedResource(meta);}
  }
  enqueueSubjectEvent(event){
    const id=randomUUID(),priority={input:90,reminder:60,wake:40,interest:30,observation:20,diary:25,expression:24}[event.kind]??10;
    if(event.kind==='input'||event.kind==='reminder')this.consumeQueueChanges(this.eventQueue.interrupt({epoch:this.epoch,minimumPriority:priority,reason:'priority_preempted'}));
    const expiresAt=event.expiresAt??(event.kind==='observation'?event.payload.at+OBSERVATION_MAX_AGE:backgroundEvent(event)?event.claim.leaseUntil:this.clock()+10000);
    // Already-started understanding may finish historical records; it cannot
    // renew admission or the original interaction window. Historical age is inclusive.
    const runExpiresAt=event.kind==='observation'?event.payload.at+OBSERVATION_HISTORY_MAX_AGE+1:expiresAt;
    const original={id:event.id??id,kind:event.kind,at:event.at,payload:{id:event.payload?.id},...(event.claim?{claim:event.claim}:{}),expiresAt};
    const meta={event:original,expiresAt,runExpiresAt};
    const result=this.eventQueue.enqueue({id,kind:event.kind,at:event.at,payload:event.payload},{epoch:this.epoch,priority,expiresAt,runExpiresAt,interruptible:true,...(event.kind==='observation'?{coalesceKey:'latest-observation'}:{})});
    this.consumeQueueChanges(result);
    if(result.accepted&&result.status!=='duplicate')this.queueMetadata.set(id,meta);else this.releaseQueuedResource(meta);
    this.drain();return result;
  }
  queue(event){
    if(!this.enabled||this.closed)return;
    if(this.eventQueue)return this.enqueueSubjectEvent(event);
    if(event.kind==='input'||event.kind==='reminder')this.preemptComic(event.kind);
    if(event.kind==='observation')this.pending=event;
    else {if(this.queuedCount()>=40)throw new Error('event_queue_full');this.inbox.push(event);}
    this.drain();
  }
  drain(){
    if(this.busy||(!this.eventQueue&&!this.pending&&!this.inbox.length)||!this.enabled||this.closed)return;
    if(!this.providerCanStart()){
      const availability=this.providerAvailability.snapshot();
      if(availability.status==='clock_fault'){this.failRun();this.publish();return;}
      if(availability.status==='waiting'&&!this.retryTimer){
        this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.drain();},Math.max(1,availability.nextEligibleAt-this.clock()));this.retryTimer.unref?.();
      }
      return;
    }
    const delay=this.lastStarted+this.minRunIntervalMs-this.clock();
    if(delay>0){if(!this.retryTimer){this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.drain();},delay);this.retryTimer.unref?.();}return;}
    let event,queueLeaseId=null,queueId=null,runExpiresAt;
    if(this.eventQueue){
      const taken=this.eventQueue.take({enabled:this.enabled,epoch:this.epoch});this.consumeQueueChanges(taken);if(!taken.taken)return;
      queueLeaseId=taken.leaseId;queueId=taken.event.id;
      const meta=this.queueMetadata.get(queueId);this.queueMetadata.delete(queueId);
      if(!meta||meta.cancelled){this.eventQueue.settle({leaseId:queueLeaseId,outcome:'aborted'});this.releaseQueuedResource(meta);this.drain();return;}
      event={...taken.event,id:meta.event.id,expiresAt:meta.expiresAt,...(meta.event.claim?{claim:meta.event.claim}:{})};
      runExpiresAt=meta.runExpiresAt;
      if(event.kind==='reminder'){const goal=this.reminders?.snapshot().find(goal=>goal.id===event.payload.id);if(!goal||goal.status!=='reviewing'||goal.roundId!==event.payload.roundId||goal.pausedUntil>this.clock()){this.eventQueue.settle({leaseId:queueLeaseId,outcome:'aborted'});this.releaseQueuedResource(meta);this.drain();return;}}
    }else{
      let inputIndex=this.inbox.findIndex(item=>item.kind==='input');if(inputIndex<0)inputIndex=this.inbox.findIndex(item=>item.kind==='reminder');
      if(inputIndex>=0)event=this.inbox.splice(inputIndex,1)[0];else if(this.pending&&(this.preferObservation||!this.inbox.length)){event=this.pending;this.pending=null;}else event=this.inbox.shift();
    }
    if(event.kind==='interest'){const current=this.freshInterestEvent(event);if(!current){if(queueLeaseId)this.eventQueue.settle({leaseId:queueLeaseId,outcome:'aborted'});this.autonomy?.settle({id:event.id,outcome:'aborted'});this.drain();return;}event=current;}
    if(event.kind==='observation'&&this.inferenceCadence){
      const observation=this.freshObservation();if(!observation){if(queueLeaseId)this.eventQueue.settle({leaseId:queueLeaseId,outcome:'aborted'});this.drain();return;}
      const changed=!this.cadenceBasis||!this.matchesEvidence(this.cadenceBasis);
      const fingerprint=!changed&&this.cadenceFingerprint?this.cadenceFingerprint:this.fingerprint(observation);
      const admission=this.inferenceCadence.consider({id:createHash('sha256').update(observation.id).digest('hex'),at:observation.at,fingerprint,changed},{enabled:this.enabled,epoch:this.epoch,deskId:this.profile().deskId});
      if(!admission.admitted){
        if(queueLeaseId)this.eventQueue.settle({leaseId:queueLeaseId,outcome:'aborted'});
        this.preferObservation=false;
        if(Number.isFinite(admission.nextEligibleAt)){
          if(this.eventQueue)this.deferredObservation={...event,payload:observation};else this.pending={...event,payload:observation};
          if(!this.retryTimer){this.retryTimer=setTimeout(()=>{this.retryTimer=null;const deferred=this.deferredObservation;this.deferredObservation=null;if(deferred&&this.enabled&&this.freshObservation())this.queue({...deferred,at:this.clock(),expiresAt:this.freshObservation().at+OBSERVATION_MAX_AGE,payload:this.freshObservation()});else this.drain();},Math.max(10,Math.min(5000,admission.nextEligibleAt-this.clock())));this.retryTimer.unref?.();}
        }
        if(this.queuedCount())this.drain();return;
      }
      const committed=this.inferenceCadence.commit({ticket:admission.ticket});if(!committed.accepted){if(queueLeaseId)this.eventQueue.settle({leaseId:queueLeaseId,outcome:'aborted'});return;}
      this.cadenceBasis=structuredClone(observation);this.cadenceFingerprint=fingerprint;
    }
    clearTimeout(this.retryTimer);this.retryTimer=null;
    this.preferObservation=event.kind!=='observation';this.busy=true;this.lastStarted=this.clock();
    // Fixed at run creation: observe may refresh evidence, never superseded body authority.
    const token={epoch:this.epoch,attentionGeneration:this.attentionGeneration,deskId:this.profile().deskId,evidence:this.freshObservation(),observations:new Map(),event,runExpiresAt,completed:false,queueLeaseId,queueId};
    if(event.kind==='observation')this.retainObservation(token,event.payload?.observation??event.payload);
    if(token.evidence)this.retainObservation(token,token.evidence);
    this.retainTargets(token);this.token=token;this.phase='reasoning';this.publish();
    Promise.resolve().then(()=>token.cancelled||token.epoch!==this.epoch?{status:'aborted'}:this.runtime.run(event)).then(result=>{
      if(token.epoch!==this.epoch||token.cancelled)return;
      token.completed=result.status==='completed';
      this.record('run_finished',result);
      if(result.status==='failed'&&result.failure?.retryable===true&&this.providerAvailability.failed(result.failure).recoverable)this.waitForProvider();
      else if(result.status==='failed'&&!result.failure&&result.toolCalls>0&&(this.undetailedTurnFailures??0)<2){
        this.undetailedTurnFailures=(this.undetailedTurnFailures??0)+1;
        this.record('decision_turn_recovery',{attempt:this.undetailedTurnFailures,nativeFault:result.nativeFault??null});
        this.providerAvailability.failed({kind:'unavailable',retryable:true,retryAfterMs:3000});this.waitForProvider();
      }
      else if(result.status==='failed'&&(!backgroundEvent(event)||result.failure))this.failRun();
      else this.phase=this.enabled?'resting':this.phase;
      if(result.status==='completed'){this.undetailedTurnFailures=0;this.providerAvailability.success();}
    }).catch(()=>{
      if(token.epoch===this.epoch&&!token.cancelled){if(!backgroundEvent(event))this.failRun();else this.phase='resting';this.record('run_failed',{reason:'runtime_error'});}
    }).finally(()=>{
      this.settleToken(token);
      this.busy=false;if(this.token===token)this.token=null;this.pollAutonomy(true);this.publish();this.drain();
    });
  }
  tick(){
    this.momentComicsHost?.tick();
    this.updatePresenceRest();
    if(this.closed)return;
    if((this.userFeedbackSnapshot()?.id??null)!==(this.lastUserFeedbackPublishedId??null))this.publish();
    if(this.deviceStatus&&this.clock()-this.lastPresencePublishedAt>=750){this.lastPresencePublishedAt=this.clock();this.publish();}
    this.observationHistory.sweep();
    if(this.eventQueue)this.consumeQueueChanges(this.eventQueue.sweep());
    for(const [id,value] of this.#visualSignatures)if(this.clock()-value.frameAt>OBSERVATION_MAX_AGE)this.#visualSignatures.delete(id);
    if(this.reminderDisplay&&!this.matchesEvidence(this.reminderDisplay.evidence))this.retractReminder('evidence_changed');
    this.reconcileExpressionBasis();
    const previousBody=JSON.stringify(this.body.snapshot());
    for(const ended of this.actionArbiter?.tick()??[])this.endBodyLease(ended.leaseId,ended.reason);
    this.tickExpressionPlayback();
    const r=this.body.tick();
    const physical=this.rigManager?.snapshot().profile==='integrated-device',pose=physical?this.rigManager.snapshot().camera.pose:this.body.snapshot().head;
    const orientationEnabled=physical&&this.enabled&&!this.closed&&!this.presenceRest?.snapshot().resting&&this.videoIngress?.snapshot().status==='streaming'&&this.videoIngress?.physicalMotionAllowed?.()!==false;
    const orientation=this.personOrientation.step({enabled:orientationEnabled,epoch:this.epoch,head:pose,sight:this.localSight,targetId:this.attention.snapshot().focus?.targetId,requireCompletion:Boolean(this.deviceStatus),referenceReady:Number.isFinite(pose.completedAt),motion:this.deviceStatus?.().output?.head,allowPeripheral:this.bodyLeases.get(this.attentionLease)?.owner!=='input',displayBusy:Boolean(this.reminderDisplay)||(this.userFeedbackSnapshot()?.createdAt??0)>this.clock()-1500});
    // Visible-face opportunities are independent of head reference acquisition/motor failures.
    // They admit the same Pi observation loop, never synthesize user input or a canned sentence.
    const currentFeedback=this.userFeedbackSnapshot(),exchangeObservation=this.freshObservation();
    const exchange=this.visualExchange.step({enabled:this.enabled&&!this.closed&&!this.presenceRest?.snapshot().resting&&this.videoIngress?.snapshot().status==='streaming',epoch:this.epoch,sight:this.localSight,busy:this.busy,suppressed:!exchangeObservation||this.personOrientation.snapshot().suppressFeedback||Boolean(this.reminderDisplay)||this.bodyLeases.get(this.attentionLease)?.owner==='input',displayUntil:currentFeedback?.expiresAt});
    if(exchange){
      this.record('visual_exchange',{...exchange,source:'visible_face',facing:this.visualExchange.snapshot().facing,semanticStatus:'visible_face_opportunity',userAttention:'unknown'});
      const observation=this.freshObservation();
      if(exchange.reason==='opening'&&this.body.expressionUntil<=this.clock()&&!currentFeedback){
        const receipt=this.body.apply({basisObservationId:observation.id,durationMs:650,eyes:{gazeX:0,gazeY:0,openness:.9,tilt:3,roundness:.9}},{epoch:this.epoch,observationId:observation.id,observedAt:observation.at});
        this.record('body_accepted',{id:receipt.id,reason:'visual_opening_reflex',status:receipt.status});
      }
      if(exchange.reason==='opening')this.presentPreparedThought();
      if(exchange.reflexOnly)this.runtime.offerVisualOpportunity?.({at:exchange.at,reason:'opening',semanticStatus:'visible_face_opportunity'});
      if(!exchange.reflexOnly){this.inferenceCadence?.reset({epoch:this.epoch,deskId:this.profile().deskId,reason:'visual_exchange'});this.cadenceBasis=null;this.cadenceFingerprint=null;this.queue({kind:'observation',at:this.clock(),payload:observation});}
    }
    const proposal=this.attention.step({enabled:this.enabled&&!this.closed,epoch:this.epoch,head:pose,physicalCameraMoves:physical,continuousGaze:physical,expressionActive:this.body.expressionUntil>this.clock()});
    if(proposal){
      const focus=this.attention.snapshot();
      const deadline=focus.focus?Math.min(focus.focus.until,focus.searchUntil??Infinity,...(physical&&proposal.kind==='track'?[proposal.observedAt+800]:[])):physical?proposal.observedAt+800:undefined;
      const basisObservationId=proposal.basisId,ctx={epoch:this.epoch,observationId:basisObservationId,observedAt:proposal.observedAt,...(deadline===undefined?{}:{leaseUntil:deadline})};
      if(proposal.kind==='release'){if(this.attentionLease){this.actionArbiter?.release({leaseId:this.attentionLease,reason:'focus_finished'});this.endBodyLease(this.attentionLease,'focus_finished');}if(this.attentionOwnsHead)this.body.stopHead();this.body.stopGaze();this.attentionOwnsHead=false;}
      else{
        if(proposal.head&&!physical&&(!this.actionArbiter||this.attentionLease&&this.actionArbiter.check({leaseId:this.attentionLease,epoch:this.epoch,deskId:this.profile().deskId}).usable)){const receipt=this.body.moveHead({basisObservationId,durationMs:proposal.durationMs,head:proposal.head},ctx);this.attentionOwnsHead=receipt.status==='accepted';const lease=this.bodyLeases.get(this.attentionLease);if(lease&&receipt.status==='accepted')lease.receiptId=receipt.id;}
        if(proposal.gaze&&this.body.expressionUntil<=this.clock())this.body.moveGaze({basisObservationId,durationMs:proposal.durationMs,eyes:proposal.gaze},ctx);
      }
    }
    if(!orientationEnabled)this.stopPersonOrientation('orientation_disabled');else this.applyPersonOrientation(orientation);
    if(r)this.record('body_completed',r);
    const nextRig=this.rigManager?JSON.stringify(this.rigManager.snapshot()):null;
    if(r || nextRig!==this.lastRig || previousBody!==JSON.stringify(this.body.snapshot())){this.lastRig=nextRig;this.publish();}
    const reminderState=this.reminders?JSON.stringify(this.reminders.snapshot()):null;
    if(reminderState!==this.lastReminderState){this.lastReminderState=reminderState;if(this.reminders)this.publish();}
    if(!this.enabled||this.presenceRest?.snapshot().resting)return;
    if(!this.providerCanStart())return;
    this.pollAutonomy();
    // Reminder goals have a durable lease separate from coalesced frame input.
    // Claim only with fresh evidence; release excess claims instead of losing them.
    if(this.reminders&&this.freshObservation()){
      const goals=this.reminders.claimDue({enabled:this.enabled,observation:this.freshObservation(),deskId:this.profile().deskId,mode:this.mode});
      for(const goal of goals){
        if(this.queuedCount()>=40){this.reminders.release(goal.id,{reason:'queue_full'});continue;}
        this.record('reminder_due',{id:goal.id,kind:goal.kind});this.queue({kind:'reminder',at:this.clock(),expiresAt:goal.expiresAt,payload:goal});this.publish();
      }
    }
    if(this.comic&&this.clock()-this.lastComicSweep>=1000&&!this.hasQueuedKind('diary')&&this.token?.event.kind!=='diary'){
      this.lastComicSweep=this.clock();
      const claim=this.comic.claimDue({enabled:this.enabled,epoch:this.epoch,deskId:this.profile().deskId});
      if(claim){
        if(this.queuedCount()>=40){this.comic.release(claim.id,{claimToken:claim.claimToken,reason:'queue_full'});}
        else{const candidates=this.comic.candidates(claim.id);this.queue({kind:'diary',at:this.clock(),payload:candidates,claim});}
      }
    }
    const capacity=40-this.queuedCount();
    const due=capacity>0?(this.store.claimDueWakes?this.store.claimDueWakes(this.clock(),Math.min(20,capacity)):this.store.takeDueWakes(this.clock()).slice(0,capacity)):[];
    for(const wake of due){
      this.record('wake_due',{id:wake.id,reason:wake.reason});
      this.queue({kind:'wake',at:this.clock(),payload:wake});this.publish();
    }
    if(!this.busy&&this.queuedCount()===0&&this.expressionDemands&&this.mode==='cloud'&&this.profile().expressionLearning&&this.clock()-this.lastExpressionDemandSweep>=1000&&!this.hasQueuedKind('expression')&&this.token?.event.kind!=='expression'){
      this.lastExpressionDemandSweep=this.clock();
      const scope=this.planContext();
      const taken=this.expressionDemands.claimDue({...scope,enabled:this.enabled,epoch:this.epoch,allowBackground:true});
      if(taken?.accepted===true){
        const claim={...taken,...scope,epoch:this.epoch};
        if(this.queuedCount()>=40)this.releaseExpressionWork({kind:'expression',claim},'queue_full');
        else this.queue({kind:'expression',at:this.clock(),expiresAt:Math.min(claim.leaseUntil,this.clock()+10000),claim,payload:{...claim.demand,evidence:(claim.demand.evidenceRefs??[]).map(ref=>this.continuity?.getEvidence(ref.id,{deskId:scope.deskId})).filter(Boolean)}});
      }
    }

  }
  waitForProvider(){
    // A transport failure revokes this run and its invitations, not camera consent.
    // Keep the stream epoch: the still-authorized peer must deliver newer frames.
    if(this.token){this.token.cancelled=true;this.settleToken(this.token);}
    this.clearInbox();clearTimeout(this.retryTimer);this.retryTimer=null;
    this.stopExpressionPlayback('provider_wait');this.stopAttention('provider_wait');
    for(const lease of this.actionArbiter?.snapshot().activeLeases??[]){this.actionArbiter.release({leaseId:lease.leaseId,reason:'provider_wait'});this.endBodyLease(lease.leaseId,'provider_wait');}
    this.bodyLeases.clear();this.body.stop('provider_wait');this.rigManager?.stop('provider_wait');this.body.arm(this.epoch);
    this.viewGuidance?.stop('provider_wait');this.expressionBasis=null;this.reminderDisplay=null;
    this.observation=null;this.issued.clear();this.#visualSignatures.clear();this.cadenceBasis=null;this.cadenceFingerprint=null;
    this.phase='resting';this.error=null;this.record('provider_wait',this.providerAvailability.snapshot());
  }
  failRun(){this.epoch++;this.presenceRest?.reset();this.wasPresenceResting=false;this.semanticPersonUntil=0;this.semanticPersonStream=null;this.observationHistory.reset({epoch:this.epoch,deskId:this.profile().deskId});this.enabled=false;this.phase='error';this.error='agent_run_failed';if(this.methodSession)this.behaviorMethods?.stopSession(this.methodSession);this.methodSession=null;this.autonomy?.cancel({epoch:this.epoch,reason:'agent_error'});this.actionArbiter?.cancel({epoch:this.epoch-1,reason:'agent_error'});this.bodyLeases.clear();this.stopExpressionPlayback('agent_error');this.stopAttention('agent_error');this.body.stop('agent_error');this.rigManager?.stop('agent_error');this.videoIngress?.stop('agent_error');this.settleToken(this.token);this.clearInbox();this.observation=null;this.#visualSignatures.clear();}
  updatePresenceRest(){
    if(!this.presenceRest)return;
    this.presenceRest.tick({enabled:this.enabled&&!this.closed,epoch:this.epoch,streaming:this.videoIngress?.snapshot().status==='streaming',personVisibleUntil:this.semanticPersonStream===this.localSight?.streamId?this.semanticPersonUntil:0});
    const presence=this.presenceRest.snapshot();
    this.videoIngress?.setPresenceDetection?.(presence.shouldDetect!==false);
    if(presence.resting&&!this.wasPresenceResting){
      this.wasPresenceResting=true;
      if(this.token){this.token.cancelled=true;this.settleToken(this.token);this.runtime.abort();}
      this.clearInbox();clearTimeout(this.retryTimer);this.retryTimer=null;
      this.stopExpressionPlayback('presence_rest');this.stopAttention('presence_rest');
      this.actionArbiter?.cancel({epoch:this.epoch,reason:'presence_rest'});this.bodyLeases.clear();
      this.body.stop('presence_rest');this.body.arm(this.epoch);this.currentInteraction=null;this.expressionBasis=null;this.reminderDisplay=null;
      this.phase='resting';this.record('presence_rest',{reason:presence.reason,nextProbeAt:presence.nextProbeAt});this.publish();
    }else if(!presence.resting&&this.wasPresenceResting){
      this.wasPresenceResting=false;this.inferenceCadence?.reset({epoch:this.epoch,deskId:this.profile().deskId,reason:'person_returned'});this.cadenceBasis=null;this.cadenceFingerprint=null;
      this.phase='observing';this.record('presence_returned',{reason:'clear_person_detected'});this.publish();
    }
  }
  async close(){
    if(this.closed)return;
    this.control('stop');this.closed=true;await this.momentComicsHost?.close();await this.runtime.close?.();this.observationHistory.close();this.providerAvailability.close();this.eventQueue?.close();clearTimeout(this.retryTimer);this.actionArbiter?.close();this.capabilityRegistry?.close();this.activityJournal?.close();this.planHost?.close();this.intentLedger?.close();this.inferenceCadence?.close();this.behaviorMethods?.close();this.expressionDemands?.close();this.personaRegistry?.close();this.memoryRetrieval?.close();this.viewGuidance?.close();this.autonomy?.close();this.expressionPlayback?.close();this.expressionLibrary?.close();this.piContextStore?.close();this.cognition?.close();this.store.close();this.comic?.close?.();this.continuity?.close?.();this.reminders?.close?.();this.removeAllListeners();
  }
}
