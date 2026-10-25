// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
const time = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '';
const statuses = {paused:'已暂停继续了解',waiting:'等待合适时机',reviewing:'正在了解当前关注',cooldown:'留些空档，稍后再了解',unavailable:'继续了解暂不可用'};

export function autonomyView(autonomy = {}) {
  const status = Object.hasOwn(statuses, autonomy?.status) ? statuses[autonomy.status] : '关注状态等待确认';
  const invitations = autonomy?.ordinaryInvitations;
  const delivered = count(invitations?.delivered), limit = count(invitations?.limit);
  const hours = Number.isFinite(invitations?.windowMs) && invitations.windowMs > 0 ? invitations.windowMs / 3600000 : null;
  const budget = delivered === null || limit === null ? '普通邀请次数待确认' : `普通邀请已送达 ${delivered} / ${limit} 次${hours ? ` · 每 ${Number(hours.toFixed(2))} 小时` : ''}`;
  const next = time(autonomy?.nextReviewAt);
  const cooldown = time(invitations?.cooldownUntil);
  return {status, budget, detail:[next ? `下次了解：${next}` : '', cooldown ? `留出空档至：${cooldown}` : ''].filter(Boolean).join(' · ')};
}

const reasons = {
  unsupported_gesture:'当前身体暂不支持这种表达', unsupported_icon:'当前屏幕暂不支持这种图形',
  unsupported_capability:'当前身体暂不支持这种表达', capability_mismatch:'当前身体能力不匹配',
  evidence_revoked:'相关依据已撤回', evidence_invalidated:'相关依据已变更', evidence_not_allowed:'相关材料未获表达积累授权',
  learning_disabled:'表达积累已关闭', learning_version_mismatch:'授权范围已变化', desk_changed:'桌面已更换',
  persona_version_mismatch:'人设版本已变化', session_mismatch:'等待下一次明确苏醒',
  invalid_structure:'编排需要调整', structural_check_failed:'编排需要调整'
};

/** Text values only: callers must render resource meanings with textContent. */
export function expressionsView(expressions) {
  if (!expressions || typeof expressions !== 'object') return {status:'表达积累状态等待确认',resources:[]};
  const enabled = expressions.learningEnabled === true;
  const checkedPolicy = expressions.semanticPolicy === 'structural_check_only';
  return {
    status:enabled ? '表达积累已开启 · 意思仍待验' : expressions.learningEnabled === false ? '表达积累已关闭 · 当前不使用个人表达' : '表达积累授权等待确认',
    demands:(Array.isArray(expressions.demands)?expressions.demands:[]).slice(0,8).map(item=>({
      meaning:typeof item?.meaning==='string'&&item.meaning.trim()?item.meaning:'这次表达尝试',
      status:!enabled?'表达积累已暂停':Object.hasOwn({pending:1,reviewing:1,ready:1,failed:1,invalidated:1,abandoned:1},item?.status)?({pending:'想在以后用上的表达 · 眼前仍用基础表达',reviewing:'正在准备 · 不打断你',ready:'新的表达已准备 · 是否合适仍待确认',failed:'这次暂时没有准备好',invalidated:'依据已变化 · 已停止准备',abandoned:'已放下这次表达尝试'})[item.status]:'准备状态等待确认',
    })),
    resources:(Array.isArray(expressions.resources) ? expressions.resources : []).filter(item=>item && typeof item === 'object').map(item=>{
      let status = '表达状态待确认·意思仍待验';
      if (item.status === 'revoked') status = '已撤回';
      else if (checkedPolicy && item.semanticStatus === 'unverified') {
        if (item.status === 'candidate') status = '编排待检查';
        else if (item.status === 'rejected') status = '结构检查未通过';
        else if (item.status === 'ready') status = enabled && item.activated === true ? '本次可用·意思仍待验' : '结构已检查·下次苏醒可用';
      }
      return {meaning:typeof item.meaning === 'string' && item.meaning.trim() ? item.meaning : '未提供表达含义',status,reason:Object.hasOwn(reasons, item.reason) ? reasons[item.reason] : item.reason ? '尚未满足使用条件' : '',evidence:count(item.evidenceCount) === null ? '依据数量待确认' : `依据 ${item.evidenceCount} 条`};
    })
  };
}
