// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {createDeviceLiveness} from './device-liveness.mjs';
import {createDevicePairing} from './device-pairing.mjs';
import {characterContext} from './comic-characters.mjs';
import {createModelSettings} from './model-settings.mjs';
import {createModelSettingsHost} from './model-settings-host.mjs';
import http from 'node:http';
import {readFileSync, mkdirSync, chmodSync,existsSync} from 'node:fs';
import {dirname,join,resolve,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createController} from './controller.mjs';
import {createPiRuntime} from './agent.mjs';
import {createPiContextStore} from './pi-context-store.mjs';
import {createCognition} from './cognition.mjs';
import {createPresenceRest} from './presence-rest.mjs';
import {createMomentComics} from './moment-comics.mjs';
import {createMomentComicHost} from './moment-comic-host.mjs';
import {createComicImageProvider} from './comic-image-provider.mjs';
import {workdayFor} from './day-window.mjs';
import {createStore} from './store.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {createReminderManager} from './reminders.mjs';
import {createComicStore} from './comic-store.mjs';
import {createExpressionLibrary} from './expression-library/index.mjs';
import {createExpressionPlayback} from './expression-library/playback.mjs';
import {createAutonomyHostAdapter} from './autonomy/host-adapter.mjs';
import {createViewGuidance} from './view-guidance.mjs';
import {createActivityJournal} from './activity-journal.mjs';
import {createCapabilityRegistry} from './capability-registry.mjs';
import {createActionArbiter} from './action-arbiter.mjs';
import {createIntentLedger} from './intent-ledger.mjs';
import {createInferenceCadence} from './inference-cadence.mjs';
import {createBehaviorMethods} from './behavior-methods.mjs';
import {createPersonaRegistry} from './persona-registry.mjs';
import {createMemoryRetrieval} from './memory-retrieval.mjs';
import {createAgentEventQueue,createPlanHostAdapter} from './subject-runtime/index.mjs';
import {createExpressionDemandStore} from './expression-demands.mjs';
import {createStateStreamHub} from './state-stream.mjs';
import {projectStateForStream} from './state-projection.mjs';
import {renderComicSvg} from './comic-renderer.mjs';
import {createVideoIngress} from './video-ingress.mjs';
import {createRobotVideoIngress} from './robot-video-ingress.mjs';
import {createRigManager} from './rig.mjs';
import {REQUEST_LIMIT,fields} from './contracts.mjs';

const appRoot=fileURLToPath(new URL('../',import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4'};
const STATIC=new Set(['robot.html','robot-inspector-page.js','index.html','user-feedback.js','app.js','styles.css','tokens.css','camera.js','device-camera.js','interaction-feedback.js','agent-inspector.js','moment-comics-ui.js','moment-gallery.js','moment-gallery.css','cognitive-icons.js','video-stream.js','robot.js','body-presentation.js','presentation-reporter.js','pet.html','pet.js','rig-ui.js','companion-ui.js','comic-ui.js','subject-ui.js','round-screen-input.js','round-screen-input.css','view-guidance.js','view-guidance.css','round-comic-reader.js','round-comic-reader.css']);
function failure(code,status=400){return Object.assign(new Error(code),{status});}
STATIC.add('model-settings-ui.js');
STATIC.add('introduction.mp4');
STATIC.add('introduction-cover.jpg');
async function readJson(req){
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw failure('json_required',415);
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>REQUEST_LIMIT){req.resume();throw failure('request_too_large',413);}chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('invalid_json');}
}
export function createSimulationServer({statePath,mode='fixture',modelConfig={},runtimeFactory=createPiRuntime,clock=Date.now,rigManager=createRigManager({clock}),petAtlasPath=process.env.COMPANION_PET_ATLAS,videoIngressFactory=createVideoIngress,evidenceUse='unknown',deviceBridge=null,deviceOutputFactory=null,experienceProfile='default',imageConfig={},imageProvider=null,pairingFetch=globalThis.fetch,deviceHealthFetch=null}={}){
  if(!['default','competition'].includes(experienceProfile))throw new Error('invalid_experience_profile');
  const competition=experienceProfile==='competition',autonomyPolicy=competition?{invitationWindowMs:60000,invitationLimit:8,restrictedInvitationLimit:1,noResponseCooldownMs:4000,reviewMinIntervalMs:4000,reviewRetryDelayMs:6000}:{};
  modelConfig={...modelConfig,experienceProfile,momentComicInstructions:readFileSync(join(appRoot,'config/moment-comic.md'),'utf8'),...(competition?{experienceInstructions:readFileSync(join(appRoot,'config/competition.md'),'utf8')}:{})};
  if(!['fixture','cloud'].includes(mode))throw new Error('invalid_model_mode');
  let videoIngress=null,deviceOutput=null,pairing=null,deviceHealth=null;
  if(deviceBridge)rigManager=createRigManager({profile:'integrated-device',clock,deviceState:()=>({...deviceBridge.snapshot(),output:deviceOutput?.snapshot()})});
  const deviceStatus=()=>({...deviceBridge.snapshot(),...(deviceHealth?{connected:deviceHealth.snapshot().connected,health:deviceHealth.snapshot()}:{}),connection:pairing?.snapshot()??null,output:deviceOutput?.snapshot()??null});
  if(!['unknown','test','holdout'].includes(evidenceUse))throw new Error('invalid_evidence_use');
  const path=statePath??join(appRoot,'../../.runtime/companion-sim/state.sqlite');
  const modelSettings=createModelSettings({path:process.env.COMPANION_DATA_DIR?join(process.env.COMPANION_DATA_DIR,'settings.json'):path===':memory:'?null:join(dirname(path),'model-settings.json'),initial:modelConfig});
  modelConfig={...modelConfig,...modelSettings.runtimeConfig()};
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const store=createStore({path,clock});if(path!==':memory:')chmodSync(path,0o600);
  const continuity=createContinuityStore({path,clock});
  const piContextStore=createPiContextStore({path});
  const cognition=createCognition({path,clock,resolveEvidence:(id,options)=>continuity.resolveMemory(id,options)});
  if(competition&&(continuity.getProfile().quietMode||continuity.getProfile().curiosity!=='exploratory'))continuity.setProfile({quietMode:false,curiosity:'exploratory'});
  const memoryRetrieval=createMemoryRetrieval({search:query=>continuity.recall(query),readCurrent:(id,options)=>continuity.resolveMemory(id,options)});
  const reminders=createReminderManager({path,clock});
  reminders.reconcileEvidence({resolveEvidence:(id,options)=>continuity.getEvidence(id,options)});
  const comic=createComicStore({path,clock,readDiary:options=>continuity.diary(options),readEvidence:(id,options)=>continuity.getEvidence(id,options)});
  const expressionLibrary=createExpressionLibrary({path,clock,resolveEvidence:id=>continuity.describeEvidence(id)});
  const expressionDemands=createExpressionDemandStore({path,clock,resolveEvidence:id=>continuity.describeEvidence(id),resolveCandidate:id=>expressionLibrary.getCandidate(id)});
  expressionDemands.reconcileEvidence();
  const expressionPlayback=createExpressionPlayback({library:expressionLibrary,clock});
  const autonomy=createAutonomyHostAdapter({path,clock,policy:{maxInterests:128,...autonomyPolicy},resolveEvidence:(id,options)=>continuity.getEvidence(id,options)});
  const viewGuidance=createViewGuidance({clock});
  const activityJournal=createActivityJournal({clock,readDiary:options=>continuity.diary(options),readEvidence:(id,options)=>continuity.getEvidence(id,options)});
  const capabilityRegistry=createCapabilityRegistry();
  const actionArbiter=createActionArbiter({clock});
  const intentLedger=createIntentLedger({path,clock,resolveEvidence:(id,options)=>continuity.getEvidence(id,options)});
  intentLedger.reconcileEvidence();
  const planHost=createPlanHostAdapter({ledger:intentLedger,clock,resolveEvidence:(id,options)=>continuity.getEvidence(id,options)});
  const eventQueue=createAgentEventQueue({clock,maxPending:40,maxBytes:8000000});
  const inferenceCadence=createInferenceCadence({clock,minIntervalMs:750,stableReviewMs:competition?2000:5000});
  const behaviorMethods=createBehaviorMethods({path,clock,resolveEvidence:(id,options)=>continuity.getEvidence(id,options)});
  behaviorMethods.reconcileEvidence();
  expressionLibrary.reconcileEvidence();
  const personaRegistry=createPersonaRegistry({path,clock});
  const configuredPersona=readFileSync(join(appRoot,'config/persona.md'),'utf8');
  const personaVersion=personaRegistry.register({text:configuredPersona,sourceId:'desktop-companion-base'});personaRegistry.activate({id:personaVersion.id});
  const persona=personaRegistry.getActive().text;
  const controller=createController({presenceRest:createPresenceRest({clock}),cognition,piContextStore,experienceProfile,autonomyPolicy,deviceStatus:deviceBridge?deviceStatus:null,store,runtimeFactory,mode,modelConfig,persona,clock,rigManager,continuity,reminders,comic,evidenceUse,expressionLibrary,expressionPlayback,autonomy,viewGuidance,activityJournal,capabilityRegistry,actionArbiter,intentLedger,inferenceCadence,behaviorMethods,personaRegistry,memoryRetrieval,planHost,eventQueue,expressionDemands});
  if(deviceBridge?.reconnect)pairing=createDevicePairing({bridge:deviceBridge,fetch:pairingFetch,isPaused:()=>!controller.enabled,onChange:()=>controller.publish()});
  const momentComicStore=createMomentComics({path,clock,readEvidence:(id,options)=>continuity.getEvidence(id,options),readEntries:options=>continuity.listPerceptions({...options,limit:24})});
  const buildComicProvider=config=>imageProvider??createComicImageProvider({apiKey:process.env.COMPANION_IMAGE_API_KEY??(config.provider==='minimax'&&config.baseUrl===(process.env.COMPANION_IMAGE_BASE_URL??'https://api.minimax.cn/v1')?config.apiKey||undefined:undefined),baseUrl:process.env.COMPANION_IMAGE_BASE_URL??'https://api.minimax.cn/v1',model:process.env.COMPANION_IMAGE_MODEL??'image-01',...imageConfig});
  let currentComicProvider=buildComicProvider(modelConfig);
  const comicImageProvider={status:()=>currentComicProvider.status(),generate:input=>currentComicProvider.generate(input)};
  const modelSettingsHost=createModelSettingsHost({store:modelSettings,controller,baseConfig:modelConfig,onApplied:config=>{modelConfig={...modelConfig,...config};currentComicProvider=buildComicProvider(modelConfig);}});
  controller.momentComicsHost=createMomentComicHost({store:momentComicStore,provider:comicImageProvider,controller,clock});
  videoIngress=deviceBridge?createRobotVideoIngress({controller,bridge:deviceBridge,clock,onChange:()=>controller.publish()}):videoIngressFactory({controller,clock,onChange:()=>controller.publish()});
  if(deviceBridge&&deviceOutputFactory){let queued=false,previous='';const feedbackSignatures=new Map();deviceOutput=deviceOutputFactory({bridge:deviceBridge,clock,onChange:value=>{const next=JSON.stringify(value);if(next===previous)return;previous=next;for(const channel of ['head','expression']){const output=value?.[channel];if(output&&output.commandId!=='host-presence'&&['device_acknowledged','job_completed','error','unconfirmed'].includes(output.status)){const signature=JSON.stringify([output.commandId,output.status,output.at]);if(feedbackSignatures.get(channel)!==signature){feedbackSignatures.set(channel,signature);controller.record('device_feedback',{channel,...output});}}}if(queued)return;queued=true;queueMicrotask(()=>{queued=false;controller.publish();});}});}
  controller.videoIngress=videoIngress;
  if(deviceBridge)controller.prepareUserMessage=text=>deviceBridge.request('prepare_message',{text},{timeoutMs:3000});
  const streams=createStateStreamHub();
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const emit=state=>{deviceOutput?.accept(state);streams.publish(projectStateForStream(state));};
  controller.on('state',emit);
  const timer=setInterval(()=>controller.tick(),50);timer.unref();
  if(deviceBridge&&deviceHealthFetch){
    deviceHealth=createDeviceLiveness({bridge:deviceBridge,fetch:deviceHealthFetch,clock,canRecover:()=>!controller.enabled&&pairing?.snapshot().status!=='pairing',onDisconnect:health=>{
      if(['offline','unavailable'].includes(health.status))deviceBridge.invalidate?.(health.reason);
      controller.control('pause');controller.record('device_disconnected',{reason:health.reason});
    },onChange:health=>{if(['offline','unavailable'].includes(health.status))deviceBridge.invalidate?.(health.reason);if(!deviceStatus().connected&&(controller.enabled||videoIngress.snapshot().previewActive))controller.control('pause');else controller.publish();}});
    deviceHealth.start();
  }
  const server=http.createServer(async(req,res)=>{
    const port=server.address()?.port;
    const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(self), microphone=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    try{
      if(!hosts.includes(req.headers.host))throw failure('local_host_required',403);
      if(req.headers.origin&&!hosts.some(h=>req.headers.origin===`http://${h}`))throw failure('same_origin_required',403);
      const url=new URL(req.url,`http://${req.headers.host}`);
      if(req.method==='GET'){
        if(url.pathname==='/api/presentation')return json(res,200,{mode:deviceBridge?'sdk-hardware':'browser-preview',nativeConnected:deviceBridge?.snapshot().connected??false,atlasAvailable:Boolean(petAtlasPath&&existsSync(petAtlasPath)),gestures:['idle','wave','jump','waiting','review']});
        if(url.pathname==='/assets/pet-atlas.png'){
          if(!petAtlasPath)throw failure('pet_atlas_not_configured',404);
          let bytes;try{bytes=readFileSync(petAtlasPath);}catch{throw failure('pet_atlas_unavailable',404);}
          if(bytes.length>10000000)throw failure('pet_atlas_too_large',413);
          res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'private, max-age=3600'});res.end(bytes);return;
        }
        if(url.pathname==='/api/state')return json(res,200,controller.snapshot());
        if(url.pathname==='/api/model/settings')return json(res,200,modelSettingsHost.snapshot());
        if(url.pathname==='/api/comic-characters')return json(res,200,{items:characterContext(continuity.snapshot().perceptions,{readEvidence:(id,options)=>continuity.getEvidence(id,options),deskId:continuity.getProfile().deskId})});
        if(url.pathname==='/api/agent/context')return json(res,200,{...(controller.runtime.inspectContext?.()??{status:'not_started',systemPrompt:null}),configuredBehaviorPrompt:modelConfig.experienceInstructions??null,configuredMomentPrompt:modelConfig.momentComicInstructions});
        if(url.pathname==='/api/moment-comics')return json(res,200,controller.momentComicsHost.snapshot());
        if(url.pathname.startsWith('/api/moment-comics/images/')){
          const id=decodeURIComponent(url.pathname.slice('/api/moment-comics/images/'.length));if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw failure('invalid_comic_id');
          const file=controller.momentComicsHost.readImage(id);if(!file)throw failure('comic_image_unavailable',404);
          res.writeHead(200,{'Content-Type':file.mimeType,'Cache-Control':'no-store'});res.end(file.bytes);return;
        }
        if(url.pathname==='/api/development'){
          const groups=[['continuity-20261025',['head-policy','cognition','native-cognition','absence-rest']],['comic-20261025',['distinct-icons','moment-store','moment-gallery','image-provider']]];
          const tasks=groups.flatMap(([round,names])=>{const base=resolve(appRoot,'../../.runtime/parallel',round);return names.map(name=>{try{const s=JSON.parse(readFileSync(join(base,name,'status.json'),'utf8'));let alive=false;if(s.status==='running')try{process.kill(s.pid,0);alive=true;}catch{}return {round,name,status:s.status==='running'&&!alive?'process_exited':s.status,pid:s.pid,exitCode:s.exitCode??null,updatedAt:s.updatedAt,integrated:existsSync(join(base,name,'integrated.json'))};}catch{return {round,name,status:'not_started',integrated:false};}});});
          return json(res,200,{tasks});
        }
        if(url.pathname==='/api/device'&&deviceBridge)return json(res,200,deviceStatus());
        if(url.pathname==='/api/device/health'&&deviceBridge)return json(res,200,deviceStatus());
        if(url.pathname==='/api/device/vision'&&deviceBridge)return json(res,200,await deviceBridge.request('camera_status',{}, {timeoutMs:4000}));
        if(url.pathname==='/api/device/frame'&&deviceBridge){const image=videoIngress.frame(url.searchParams.get('previewId'));res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Frame-At':String(image.at),'X-Frame-Sequence':String(image.sequence)});res.end(image.bytes);return;}
        if(url.pathname==='/api/events'){
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive'});
          const unsubscribe=streams.subscribe(res,projectStateForStream(controller.snapshot()));req.on('close',unsubscribe);return;
        }
        if(url.pathname==='/api/memory')return json(res,200,store.snapshot());
        if(url.pathname==='/api/continuity')return json(res,200,continuity.snapshot());
        if(url.pathname==='/api/profile')return json(res,200,continuity.getProfile());
        if(url.pathname==='/api/retrieval')return json(res,200,memoryRetrieval.snapshot());
        if(url.pathname==='/api/persona')return json(res,200,personaRegistry.snapshot());
        if(url.pathname==='/api/methods')return json(res,200,controller.methodSnapshot());
        if(url.pathname==='/api/expression-demands')return json(res,200,{...expressionDemands.snapshot(controller.planContext()),demands:expressionDemands.list({limit:30},controller.planContext())});
        if(url.pathname==='/api/experiences')return json(res,200,{episodes:continuity.listEpisodes({deskId:continuity.getProfile().deskId,limit:50})});
        if(url.pathname==='/api/plans')return json(res,200,{plans:controller.listPlans()});
        if(url.pathname==='/api/capabilities')return json(res,200,capabilityRegistry.snapshot());
        if(url.pathname==='/api/activity')return json(res,200,controller.readActivity({...(url.searchParams.has('day')?{day:url.searchParams.get('day')}:{}) ,...(url.searchParams.has('timeZone')?{timeZone:url.searchParams.get('timeZone')}:{})}));
        if(url.pathname==='/api/diary')return json(res,200,controller.readDiary({... (url.searchParams.has('day')?{day:url.searchParams.get('day')}:{})}));
        if(url.pathname==='/api/comic'||url.pathname==='/api/comic.svg'){
          const state=controller.comicSnapshot({...(url.searchParams.has('day')?{day:url.searchParams.get('day')}:{})});
          if(url.pathname==='/api/comic')return json(res,200,state);
          res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store'});res.end(renderComicSvg(state.book));return;
        }
        if(url.pathname==='/api/rig'&&rigManager)return json(res,200,rigManager.snapshot());
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
        if(!STATIC.has(name))throw failure('not_found',404);
        let content;try{content=readFileSync(join(appRoot,'web',name));}catch{throw failure('not_found',404);}
        if(extname(name)==='.mp4'){
          res.setHeader('Accept-Ranges','bytes');
          if(req.headers.range){
            const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            const suffix=match&&!match[1],start=match?(suffix?Math.max(0,content.length-Number(match[2])):Number(match[1])):NaN;
            const end=match?(suffix||!match[2]?content.length-1:Math.min(content.length-1,Number(match[2]))):NaN;
            if(!match||(!match[1]&&!match[2])||(suffix&&Number(match[2])===0)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=content.length){res.writeHead(416,{'Content-Range':`bytes */${content.length}`});res.end();return;}
            res.writeHead(206,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${content.length}`,'Cache-Control':'no-store'});res.end(content.subarray(start,end+1));return;
          }
          res.setHeader('Content-Length',content.length);
        }
        res.writeHead(200,{'Content-Type':MIME[extname(name)]??'application/octet-stream','Cache-Control':'no-store'});res.end(content);return;
      }
      if(req.method!=='POST')throw failure('method_not_allowed',405);
      if(!req.headers.origin||!hosts.some(h=>req.headers.origin===`http://${h}`))throw failure('same_origin_required',403);
      const admittedEpoch=controller.epoch;
      const input=await readJson(req);
      if(url.pathname==='/api/model/settings')return json(res,200,await modelSettingsHost.save(input));
      if(url.pathname==='/api/control'&&['start','resume'].includes(input.action)&&modelSettingsHost.busy())throw failure('model_settings_busy',409);
      if(url.pathname==='/api/control'&&['start','resume'].includes(input.action)&&controller.mode==='cloud'&&!modelSettingsHost.snapshot().configured)throw failure('model_not_configured',409);
      if(url.pathname==='/api/moment-comics/generate'){fields(input,[],'moment_generate');return json(res,200,controller.momentComicsHost.requestNow());}
      if(url.pathname==='/api/moment-comics/input'){fields(input,['action','imageId'],'gallery_input');return json(res,200,controller.momentComicsHost.input(input));}
      if(url.pathname==='/api/control'){fields(input,['action'],'control');if(deviceBridge&&['start','resume'].includes(input.action)&&!deviceStatus().connected)throw failure('robot_disconnected',409);return json(res,200,controller.control(input.action));}
      if(url.pathname.startsWith('/api/device/')&&deviceBridge){
        if(admittedEpoch!==controller.epoch)throw failure('control_epoch_changed',409);
        if(url.pathname==='/api/device/pair'){fields(input,['code'],'device_pair');if(!pairing)throw failure('pairing_unavailable',409);return json(res,202,pairing.start(input));}
        if(url.pathname==='/api/device/vision/recover'){fields(input,[],'device_recovery');return json(res,200,await deviceBridge.request('camera_recover',{}, {timeoutMs:10000}));}
        if(url.pathname==='/api/device/preview'){fields(input,['epoch'],'device_preview');return json(res,200,await videoIngress.startPreview(input));}
        if(url.pathname==='/api/device/preview/stop'){fields(input,['previewId'],'device_preview_stop');const stopped=videoIngress.stopPreview(input.previewId);if(stopped)controller.control('pause');return json(res,200,{stopped});}
        if(url.pathname==='/api/device/share')return json(res,200,await videoIngress.share(input));
      }
      if(url.pathname==='/api/comic/generate')return json(res,200,controller.requestComic(input));
      if(url.pathname==='/api/comic/settings'){const result=comic.configure(input);controller.publish();return json(res,200,result);}
      if(url.pathname==='/api/attention/focus')return json(res,200,controller.focusAttention(input));
      if(url.pathname==='/api/subject/select')return json(res,200,controller.selectSubject(input));
      if(url.pathname==='/api/video/offer'){
        const answer=await videoIngress.negotiate(input,{admittedEpoch});
        if(res.destroyed){videoIngress.stopStream(answer.streamId,'signaling_closed');return;}
        return json(res,200,answer);
      }
      if(url.pathname==='/api/video/stop'){
        fields(input,['streamId'],'video_stop');
        if(typeof input.streamId!=='string'||!input.streamId.length||input.streamId.length>128)throw failure('invalid_stream_id');
        const stopped=videoIngress.stopStream(input.streamId,'user_stop');if(stopped&&deviceBridge)controller.control('pause');return json(res,200,{stopped});
      }
      if(url.pathname==='/api/observations'){
        if(deviceBridge)throw failure('hardware_input_requires_robot_video');
        if(input&&typeof input==='object'&&Object.hasOwn(input,'stream'))throw failure('trusted_video_ingress_required');
        return json(res,200,controller.observe(input,{admittedEpoch}));
      }
      if(url.pathname==='/api/input')return json(res,200,controller.input(input));
      if(url.pathname==='/api/profile'){
        fields(input,['deskId','quietMode','curiosity','expressionLearning'],'profile');
        const profile=continuity.setProfile(input);expressionLibrary.reconcileEvidence();expressionDemands.reconcileEvidence();controller.control('pause');
        continuity.recordInteraction({kind:'explicit_feedback',summary:`已明确设置相处方式：${profile.quietMode?'安静陪伴':'正常互动'}，探索程度 ${profile.curiosity}。`,deskId:profile.deskId});
        controller.record('profile_updated',{version:profile.version,deskId:profile.deskId});controller.publish();return json(res,200,profile);
      }
      if(url.pathname==='/api/methods/revoke'){fields(input,['id'],'method_revoke');const result=behaviorMethods.revoke(input,controller.planContext());controller.publish();return json(res,200,result);}
      if(url.pathname==='/api/continuity/revise'){
        return json(res,200,controller.reviseContinuity(input));
      }
      if(url.pathname==='/api/reminders'){
        const result=reminders.create({...input,deskId:continuity.getProfile().deskId});
        if(result.source!=='demo'&&!result.duplicate)continuity.recordInteraction({kind:'accepted',summary:`已明确开启${result.label}，每轮间隔${Math.round(result.intervalMs/60000)}分钟，最多跟进${result.maxAttempts}次。`,deskId:result.deskId});
        controller.record('reminder_created',{id:result.id,source:result.source});controller.publish();return json(res,200,result);
      }
      if(url.pathname==='/api/reminders/respond'){
        fields(input,['id','action','roundId','receiptId','epoch'],'reminder_response');const result=controller.respondToReminder(input);
        return json(res,200,result);
      }
      if(url.pathname==='/api/presentation/ack'&&deviceBridge)throw failure('hardware_screen_ack_requires_device',409);
      if(url.pathname==='/api/presentation/ack')return json(res,200,controller.confirmPresentation(input));
      if(url.pathname==='/api/reminders/pause-today')return json(res,200,controller.pauseReminderToday(input));
      if(url.pathname==='/api/memory/revise'){
        fields(input,['id','summary','status','reason'],'revision');const {id,...patch}=input;
        const result=store.revise(id,patch);controller.record('memory_revised',{id:result.id,revision:result.revision});controller.publish();return json(res,200,result);
      }
      if(url.pathname==='/api/rig'&&rigManager){fields(input,['profile'],'rig');if(deviceBridge&&input.profile!=='integrated-device')throw failure('hardware_profile_fixed');controller.control('pause');rigManager.select(input.profile);controller.record('rig_selected',{profile:input.profile});controller.publish();return json(res,200,rigManager.snapshot());}
      if(url.pathname==='/api/rig/preview'){
        if(deviceBridge&&!deviceStatus().connected)throw failure('robot_disconnected',409);
        if(admittedEpoch!==controller.epoch)throw failure('control_epoch_changed',409);
        const receipt=controller.previewHead(input);return json(res,200,{receipt,state:controller.snapshot()});
      }
      if(url.pathname==='/api/camera/move'&&rigManager){return json(res,200,await controller.moveCamera(input));}
      throw failure('not_found',404);
    }catch(error){
      if(res.headersSent){res.end();return;}
      const message=error.status?error.message:typeof error.message==='string'&&/^[a-z_]{1,70}$/.test(error.message)?error.message:'invalid_request';
      json(res,error.status??400,{error:message});
    }
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;
  let closePromise=null;
  return {server,controller,store,continuity,reminders,comic,expressionLibrary,expressionPlayback,expressionDemands,videoIngress,deviceOutput,close(){
    if(!closePromise)closePromise=(async()=>{clearInterval(timer);controller.control('stop');controller.removeListener('state',emit);streams.close();await deviceHealth?.close();await pairing?.close();await videoIngress.close();deviceOutput?.close();await deviceBridge?.close();await controller.close();
      if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});})();
    return closePromise;
  }};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);const value=(flag,fallback)=>{const i=args.indexOf(flag);return i<0?fallback:args[i+1];};
  const port=Number(value('--port',process.env.COMPANION_SIM_PORT??8794));
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_port');
  const options={experienceProfile:value('--experience-profile',process.env.COMPANION_EXPERIENCE_PROFILE??'default'),mode:value('--model',process.env.COMPANION_MODEL_MODE??'fixture'),statePath:value('--state-path',undefined),evidenceUse:value('--evidence-use',process.env.COMPANION_EVIDENCE_USE??'unknown')};
  // Rig is a separate adapter boundary and is loaded only by the executable entry.
  const {createRigManager}=await import('./rig.mjs');options.rigManager=createRigManager();
  let bridge=null,app;
  if(args.includes('--hardware')){
    const {createReconnectableDeviceBridge}=await import('./reconnectable-device-bridge.mjs');const {createDeviceOutput}=await import('./device-output.mjs');
    bridge=createReconnectableDeviceBridge({pythonPath:fileURLToPath(new URL('../../../.venv/bin/python',import.meta.url)),scriptPath:fileURLToPath(new URL('../../../scripts/companion_device.py',import.meta.url)),onFrame:frame=>app?.videoIngress.acceptFrame(frame),onChange:()=>app?.controller.publish()});
    options.deviceBridge=bridge;options.deviceOutputFactory=createDeviceOutput;options.deviceHealthFetch=globalThis.fetch;
  }
  app=createSimulationServer(options);
  if(bridge)bridge.start().then(()=>{app.controller.publish();if(args.includes('--autostart')&&!args.includes('--no-autostart'))app.controller.control('start');}).catch(()=>{app.controller.control('pause');console.error('Robot SDK bridge unavailable; no hardware output enabled.');});
  app.server.on('error',error=>{console.error(`companion-sim: ${error.code??'server_error'}`);process.exitCode=1;});
  app.server.listen(port,'127.0.0.1',()=>console.log(`Companion ${bridge?"hardware":"simulation"}: http://127.0.0.1:${port}/ (Pi ${options.mode}; ${bridge?"official SDK bridge":"physical hardware disconnected"})`));
  let closing=false;const shutdown=async()=>{if(closing)return;closing=true;await app.close();};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
