// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Closed product feedback vocabulary, projected only from actual host state. */
export const FEEDBACK_LABELS=Object.freeze({observing:'观察',thinking:'思考',tracking:'注视',searching:'寻找',curious:'好奇',recorded:'记下',recalling:'回想',reminder:'提醒',paused:'暂停',resting:'休息',camera_off:'待启',connecting:'连接',waiting:'稍候',unavailable:'异常',manual:'手动',interrupted:'断流',cheering:'加油'});
const paths={observing:['M186 318Q206 298 226 318Q206 338 186 318Z','M206 311V325'],thinking:['M194 314L198 314','M204 314L208 314','M214 314L218 314'],tracking:['M188 308V300H196','M216 300H224V308','M224 328V336H216','M196 336H188V328'],searching:['M197 303A12 12 0 1 0 197 327A12 12 0 1 0 197 303','M207 324L220 337'],curious:['M198 306Q198 296 209 298Q220 302 209 312L207 318','M207 328V330'],recorded:['M190 303H218V333H190Z','M197 318L203 324L215 310'],recalling:['M218 310A15 15 0 1 0 219 325','M218 299V311H206'],reminder:['M192 326H220L216 319V309Q216 297 206 297Q196 297 196 309V319Z','M202 332H210'],paused:['M198 301V332','M214 301V332'],resting:['M213 298Q193 298 193 317Q193 335 214 335Q203 325 213 298Z'],camera_off:['M188 304H219V330H188Z','M184 295L227 338'],connecting:['M191 320Q206 295 221 320','M198 325Q206 311 214 325','M205 330H207'],waiting:['M206 298A18 18 0 1 0 206 334A18 18 0 1 0 206 298','M206 305V317L215 322'],unavailable:['M206 298L225 332H187Z','M206 309V320','M206 326V328'],manual:['M191 324L221 305','M190 311L220 330']};
paths.interrupted=paths.camera_off;paths.cheering=paths.curious;
export const FEEDBACK_PATHS=Object.freeze(paths);
export function projectInteractionFeedback(state={}){
 const at=Number.isFinite(state.at)?state.at:Date.now(),body=state.body??{},video=state.video??{},attention=state.attention??{},agent=state.agent??{};
 const result=(code,detail)=>({code,label:FEEDBACK_LABELS[code],detail,source:'host-state',at,stages:{observation:Boolean(video.sharingActive||video.status==='streaming'),understanding:Boolean(agent.running),expression:body.leaseEnds?.expression>at||body.leaseEnds?.gaze>at}});
 if(state.device?.configured&&state.device.connected===false)return result('unavailable','机器人连接尚未就绪；现在不能确认设备上的显示。');
 if(state.phase==='error')return result('unavailable','本轮处理未成功；请在工作台查看并恢复。');
 if(state.manualHeadPreview)return result('manual','正在手动试转；自主陪伴已暂停。');
 if(state.phase==='paused')return result('paused','自主观察和跟随已暂停；选择继续后重新观察。');
 if(state.phase==='stopped'||state.enabled===false)return result('resting','现在休息；选择开始陪伴后才会继续。');
 if(video.status==='error')return result('interrupted','实时画面已中断；无法判断人是否仍在画面内。');
 if(video.previewActive&&!video.sharingActive&&video.reason&&!['user_stop','pause','stop','start','resume','sharing_replaced'].includes(video.reason))return result('interrupted','实时画面暂未送达；请恢复观察，当前无法判断人是否仍在画面内。');
 if(state.presence?.resting)return result('resting',state.presence.status==='probing'?'正在短暂检测是否有人回来；没有启动模型互动。':'画面内持续未检测到人，正在休息；会定时检测，有人回来再恢复。');
 const active=body.leaseEnds?.expression>at;
 if(active&&['water','movement','posture','clock'].includes(body.icon))return result('reminder','正在展示本轮提醒；这不代表你已完成。');
 if(active&&state.interaction?.type==='encouragement'&&state.interaction.receiptId===body.expressionCommandId)return result('cheering','送你一点鼓励；不据此判断任务成绩或完成情况。');
 if(attention.status==='searching')return result('searching','刚才的目标暂时看不清；只短暂寻找，随后安静收回。');
 if(active&&body.icon==='question')return result('curious','这一刻有值得继续了解的线索；尚未形成结论。');
 const recorded=(state.events??[]).findLast(e=>e.type==='perception_recorded'&&e.detail?.id&&e.detail.status!=='rejected'&&e.at<=at&&at-e.at<1200);
 if(recorded)return result('recorded','刚保存了一条有来源的可见片段；不代表连续时长。');
 if(agent.availability?.status==='waiting')return result('waiting','理解服务暂时忙碌；基础注视继续，旧动作不会补播。');
 const lastTool=(state.events??[]).findLast(e=>['tool_execution_start','tool_execution_end'].includes(e.type));
 if(agent.running&&lastTool?.type==='tool_execution_start'&&['recall_memory','inspect_observation','list_episodes'].includes(lastTool.detail?.toolName))return result('recalling','正在查阅已有片段，仍需与当前画面对照。');
 if(agent.running)return result('thinking','正在理解当前线索；这个提示不代表已经理解或完成。');
 if(attention.status==='tracking')return result('tracking',attention.reason==='holding_person'?'已找到画面中的人，保持合适的头部位置；身份仍然未知。':'正在留意清晰目标；身份仍然未知。');
 if(video.status==='connecting'||video.sharingActive&&video.status!=='streaming')return result('connecting','画面连接尚在建立；还没有确认实时送达。');
 if(video.status==='streaming')return result('observing',attention.targets?.length?'正在留意可见目标，等待合适时机。':'正在观察；目前没有足够清晰的跟随目标。');
 return result('camera_off','还未开启实时观察；可先打开本地预览，再明确分享。');
}

/** Only user-facing hard states belong on the face; operational diagnostics stay in the console. */
export function projectFaceFeedback(feedback={}){
 return ['paused','resting'].includes(feedback.code)?feedback:{...feedback,code:'',label:'',detail:''};
}
