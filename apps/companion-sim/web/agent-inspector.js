// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Local developer view: actual prompt and bounded text context, never credentials or frames. */
export function mountAgentInspector({request}){
 const root=document.getElementById('agent-brain');if(!root)return;
 const status=root.querySelector('[data-context-status]'),prompt=root.querySelector('[data-prompt]'),behavior=root.querySelector('[data-behavior]'),context=root.querySelector('[data-context]'),tasks=root.querySelector('[data-tasks]');
 let busy=false;
 async function refresh(){
  if(busy)return;busy=true;
  try{
   const [brain,development]=await Promise.all([request('/api/agent/context'),request('/api/development')]);
   prompt.textContent=brain.systemPrompt??brain.effectiveSystemPrompt??'Pi 尚未开始一轮观察；开始后显示这一轮实际加载的完整系统提示词。';
   const loaded=brain.systemPrompt??'',marker='Current user competition instruction (overrides ordinary quiet-frequency defaults, not safety or explicit controls):\n',from=loaded.indexOf(marker),to=loaded.indexOf('\nMode:',from);
   behavior.textContent=from>=0?loaded.slice(from+marker.length,to<0?undefined:to):brain.configuredBehaviorPrompt?'当前配置（尚未进入模型回合）：\n'+brain.configuredBehaviorPrompt:'当前未加载陪伴行为提示词；可展开完整系统提示词查看实际规则。';
   root.querySelector('[data-moment-prompt]').textContent=brain.momentSystemPrompt??('当前配置（尚未执行本轮漫画任务）：\n'+(brain.configuredMomentPrompt??'漫画提示词尚未加载'));
   context.textContent=JSON.stringify(brain,null,2);
   tasks.replaceChildren();
   const labels={'distinct-icons':'鲜明认知图标','moment-store':'半小时漫画记录','moment-gallery':'漫画浏览代码（圆屏交互暂缓）','image-provider':'漫画图片生成','head-policy':'找到人后保持','cognition':'认知图标与存储','native-cognition':'原生屏幕图标','absence-rest':'无人休息与定时检测'},states={running:'运行中',completed:'已交付，待集成',failed:'执行失败',process_exited:'进程已退出，待核验',not_started:'未启动',integrated:'已集成'};
   for(const task of development.tasks??[]){const row=document.createElement('p');row.textContent=`Kimi · ${labels[task.name]??task.name}：${states[task.integrated?'integrated':task.status]??task.status}${task.pid?' · PID '+task.pid:''}${task.exitCode!==null&&task.exitCode!==undefined?' · 退出码 '+task.exitCode:''}`;tasks.append(row);}
  }catch{prompt.textContent='暂时无法读取实际提示词，请刷新后重试。';}finally{busy=false;}
 }
 root.querySelector('button').addEventListener('click',refresh);
 const timer=setInterval(()=>{if(!document.hidden)refresh();},10000);
 window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});refresh();
 return {render(value){status.textContent=value?`历史 ${value.estimatedTokens??0} / ${value.maxTokens??12000} 估算 Token · ${value.messageCount??0} 条消息 · 压缩 ${value.compressions??0} 次\n到 ${value.triggerTokens??9000} 时压缩，目标 ${value.targetTokens??4000} · ${value.persistence==='saved'?'已保存到本机':value.persistence==='loaded'?'已恢复本机会话':'存储状态：'+value.persistence} · 原图仅在内存`: '等待 Pi 首轮上下文';}};
}
