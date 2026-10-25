// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const excludedSources = new Set(['fixture', 'synthetic', 'diagnostic', 'diagnostics', 'design_example']);
const excludedKinds = new Set(['action', 'wake', 'tool', 'body_accepted', 'execution', 'receipt']);
const sourceKind = record => typeof record.source === 'string' ? record.source : record.source?.kind || record.source?.type;
const sourceLabels = {camera:'本机相机观察', replay:'图片回放 · 非现场观察', user:'你的明确选择', derived:'基于片段形成', perception:'基于观察片段', interaction:'明确互动', explicit_user:'你的明确选择', observed_interaction:'有依据的互动'};
const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '';
const readable = value => typeof value === 'string' ? value : value?.summary || value?.description || value?.reason || '';

/** Continuity never falls back to the legacy execution-memory namespace. */
export function productRecords(records = []) {
  return records.filter(item => item && !excludedSources.has(sourceKind(item)) && !excludedKinds.has(item.kind));
}

export function productRecordWindow(records = [], {expanded = false, limit = 5} = {}) {
  const at = record => record.observedAt ?? record.endAt ?? record.at ?? record.createdAt ?? 0;
  const ordered = productRecords(records).slice().sort((a,b) => at(b)-at(a));
  return {items:expanded?ordered:ordered.slice(0,limit),total:ordered.length};
}

/** Display actual current badge meanings separately from independently stored beliefs. */
export function currentCognition(value, {deskId, at = Date.now()} = {}) {
  const items=Array.isArray(value)?value:value?.items;
  return (Array.isArray(items)?items:[]).filter(item=>item?.state==='visible'
    && (!deskId||item.deskId===deskId)
    && typeof item.meaning==='string'&&item.meaning.trim()
    && (item.expiresAt===null||Number.isFinite(item.expiresAt)&&at<item.expiresAt)
    && Array.isArray(item.evidenceRefs)&&item.evidenceRefs.length>0).slice(0,3);
}

export function recordOverview(record) {
  if(record.episodeType!=='composed')return recordDetails(record);
  const range=[time(record.startAt??record.observedAt),time(record.endAt)].filter(Boolean).join(' — ');
  const state=record.status==='invalidated'?'依据已变化 · 当前不再采用':record.status==='retracted'?'已撤回 · 不再作为当前认识':record.status==='deleted'?'已删除':record.status==='superseded'?'已被新修订替代':'';
  return [state,sourceLabels[sourceKind(record)]||'有来源的观察',range,'由多个片段整理；中间未看见的部分仍留白','可以更正'].filter(Boolean).join(' · ');
}

export function recordDetails(record) {
  const source = sourceKind(record);
  const details = [sourceLabels[source] || (source ? `来源：${source}` : '来源未标明')];
  if (record.deskId) details.push(`桌面：${record.deskId}`);
  const start = record.startAt || record.observedAt || record.at || record.createdAt;
  if (time(start)) details.push(time(start));
  if (record.endAt && record.endAt !== start) details.push(`片段结束 ${time(record.endAt)}`);
  const duration = record.observedDurationSeconds ?? (record.observedDurationMs !== undefined ? record.observedDurationMs / 1000 : record.coverage?.observedDurationSeconds);
  if (duration > 0) details.push(`实际可见 ${duration} 秒（不代表连续活动）`);
  else if (record.frameTimes?.length) details.push(`${record.frameTimes.length} 帧采样 · 不推定连续时长`);
  if (record.frameTimes?.length) details.push(`取样时刻：${record.frameTimes.map(time).join('、')}`);
  if (record.coverage === 'partial' || record.coverage?.partial) details.push('部分可见 · 有遮挡');
  const gaps = record.gaps || record.coverage?.gaps || [];
  for (const gap of gaps) {
    const description = typeof gap === 'string' ? gap : gap && typeof gap === 'object' ? [time(gap.startAt ?? gap.from), time(gap.endAt ?? gap.to)].filter(Boolean).join(' — ') + (gap.reason ? ` · ${gap.reason}` : '') : '';
    if (description) details.push(`观察空档：${description}`);
  }
  for (const uncertainty of record.uncertainties || []) if (readable(uncertainty)) details.push(`尚不确定：${readable(uncertainty)}`);
  if (['tentative','hypothesis'].includes(record.status) || record.kind === 'hypothesis') details.push('待核实 · 可以更正');
  else if (record.status === 'retracted') details.push('已撤回 · 不再作为当前认识');
  else if (record.status === 'invalidated') details.push('依据已变更 · 暂不采用');
  else if (record.status === 'superseded') details.push('已被新修订替代');
  if (record.kind === 'interest') {
    if (record.status === 'resolved') details.push('已了解 · 本次关注结束');
    else if (record.status === 'dismissed') details.push('已放下');
    else if (record.status === 'paused') details.push('已暂停继续了解');
    if (record.nextAt && record.status === 'active') details.push(`下次了解：${time(record.nextAt)}`);
  }
  if (record.evidenceIds?.length) details.push(`依据 ${record.evidenceIds.length} 条片段`);
  if (['camera','replay'].includes(source)) details.push((record.originalRetained || record.rawImagesRetained) ? '原画面按留存设置保留' : '原画面未留存，无法回放核查');
  if (record.revision) details.push(`修订 ${record.revision}`);
  return details.join(' · ');
}

export function reminderView(reminder) {
  const statuses = {scheduled:'等待约定时间',reviewing:'正在核对当下时机',waiting:'已展示 · 等待回应',snoozed:'已选择稍后',acknowledged:'你已看到 · 未确认完成',completed:'你已明确完成本轮',dismissed:'本轮已结束 · 不代表完成',disabled:'此关心已关闭',expired:'已过有效时间 · 本次结束',exhausted:'已达本轮上限 · 不再跟进'};
  const terminal = ['completed','dismissed','expired','disabled'].includes(reminder.status);
  const reasons = {visual_completion_assessed:'依据当前可见动作作出的判断，尚非你的明确确认；来源更正后会撤回',completion_evidence_invalidated:'原来的完成依据已更正，保留未知，不追加补催',completion_evidence_forgotten:'原来的完成依据已删除，保留未知，不追加补催',explicit_demo:'你主动选择了加速演示',user_enabled:'按你设定的时间与次数执行',due_for_review:'到时间了，先核对当下时机',waiting_for_user_response:'圆屏已呈现，尚未确认人的动作',waiting_for_presentation:'提醒已准备，尚无圆屏呈现确认',presentation_confirmed:'圆屏已呈现，尚未确认人的动作',attempt_limit_reached:'本轮尝试次数已用完，不再追加',seen_is_not_completion:'你确认看到了，没有被记为完成',explicit_user_completion:'以你的明确选择作为完成依据',user_dismissed:'你选择这轮不用了，未记为完成',user_declined_current_round:'你选择这轮不用了，未记为完成',user_disabled:'你已关闭此关心，之后不再开启新一轮',user_disabled_goal:'你已关闭此关心，之后不再开启新一轮',user_snoozed:'按你的选择暂缓，已用提示次数保留',window_expired:'有效窗口已过，不补播旧提示',condition_no_longer_valid:'原来的条件不再成立',next_legal_cycle:'按原约定开始下一轮',waiting_for_quiet_moment:'等待合适的空档',vision_unavailable:'视觉能力暂不可用，保留未知',review_recovered:'重启后重新核对，保留已用次数',review_released:'尚未送达，之后重新核对'};
  const roundActions = reminder.status==='acknowledged' ? ['done','dismiss'] : reminder.status==='exhausted' ? ['seen','done','dismiss'] : terminal ? [] : ['seen','snooze','done','dismiss'];
  return {
    title: ({water:'喝水',movement:'起身活动',posture:'留意姿态'})[reminder.kind] || reminder.label || '关心事项',
    status: reminder.status==='completed'&&reminder.outcomeSource==='visual_assessment'?'画面判断本轮已完成 · 可修正':reminder.status==='waiting' ? !reminder.attemptCount ? '等待合适时机 · 尚未尝试' : reminder.presentationStatus==='confirmed' ? '圆屏已呈现 · 等待回应' : '提醒已准备 · 等待呈现确认' : reminder.status==='exhausted' ? '已达本轮尝试上限 · 不再跟进' : statuses[reminder.status] || '等待状态确认',
    source: reminder.source === 'demo' ? '加速演示 · 不属于个人事实' : reminder.source==='agent_inferred'?'机器人根据相处片段主动建立 · 可随时关闭':'你主动开启的关心',
    delivery: reminder.attemptCount ? `本轮已尝试 ${reminder.attemptCount} / ${reminder.maxAttempts ?? 1} 次 · 已确认呈现 ${reminder.confirmedPresentationCount??0} 次` : `尚未尝试 · 本轮最多 ${reminder.maxAttempts ?? 1} 次`,
    next: time(reminder.nextReviewAt ?? (reminder.status==='scheduled' ? reminder.at : null)),
    expires: time(reminder.expiresAt),
    nextCycle: time(reminder.nextCycleAt),
    reason: reasons[reminder.reason] || (reminder.reason && !/^[a-z_]+$/.test(reminder.reason) ? reminder.reason : ''),
    actions: reminder.status==='disabled' ? [] : [...roundActions,...(reminder.recurring ? ['disable'] : [])]
  };
}

export function reminderRequest({kind, mode, intervalMinutes, maxAttempts, minIntervalMinutes}) {
  if (!['water','movement','posture'].includes(kind)) throw new Error('请选择关心事项');
  if (mode === 'demo') return {kind,demo:true};
  if (mode !== 'real') throw new Error('请明确选择日常约定或加速演示');
  const interval = Number(intervalMinutes), attempts = Number(maxAttempts), minimum = Number(minIntervalMinutes);
  if (![interval,minimum].every(value => Number.isFinite(value) && value > 0) || !Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('请输入正数间隔；本轮提示次数为 1–3 次');
  return {kind,demo:false,intervalMs:Math.round(interval*60000),maxAttempts:attempts,minIntervalMs:Math.round(minimum*60000)};
}

export function deviceConnectionView(device={}){
 if(device.connected)return {label:'机器人连接正常 · 每秒检测',pairingDetail:'机器人已连接',needsPairing:false};
 if(device.health?.status==='online')return {label:'机器人在线 · 正在恢复控制连接…',pairingDetail:'机器人已连接，正在恢复控制连接，无需重新配对',needsPairing:false};
 if(device.health?.status==='checking')return {label:'正在核对机器人连接…',pairingDetail:'正在核对机器人连接…',needsPairing:false};
 if(device.health?.reason==='daemon_unavailable')return {label:'无法确认机器人连接 · SDK服务未响应',pairingDetail:'本机SDK服务未响应，请检查Desktop',needsPairing:false};
 return {label:'机器人已断开 · 请重新连接',pairingDetail:'未连接，请输入机器人当前配对码',needsPairing:true};
}

export function companionLaunchView(state={}, {starting=false,step='',error=''}={}){
 const configured=state.device?.configured===true,connected=!configured||state.device.connected===true,video=state.video??{};
 const active=state.enabled&&(!configured||video.sharingActive&&video.status==='streaming');
 const connecting=state.enabled&&video.sharingActive&&video.status!=='streaming'&&video.status!=='error';
 const label=starting?'正在启动…':active?'陪伴中':connecting?'正在连接…':'启动';
 const detail=error||(!connected?'请先到“初始化设置”连接机器人。':starting?({starting:'正在启动陪伴…',camera:'正在开启机器人摄像头…',first_frame:'摄像头已开启，等待画面…',sharing:'正在开始自主观察…',waiting:'等待画面送达…'})[step]??'正在准备…':active?'正在留意你和手边发生的事。':connecting?'正在等待画面；你可以随时停止。':state.enabled?'画面尚未连通，点击启动可重新连接。':'准备好了，点击启动就开始陪伴。');
 return {visible:true,label,detail,disabled:!connected||starting||Boolean(active)||Boolean(connecting),action:state.phase==='paused'?'resume':'start',pauseVisible:false};
}
