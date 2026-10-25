// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
export function mountMomentComicsUI({root,request,onError=()=>{}}){
 const status=root.querySelector('[data-moment-status]'),list=root.querySelector('[data-moment-list]'),next=root.querySelector('[data-moment-next]'),button=root.querySelector('[data-moment-generate]');
 let enabled=false,active=false,itemSignature='';
 const failureText=state=>({authentication:'图片服务的凭据不可用，需要更新配置。',account:'图片服务账户或额度暂不可用，记录仍保留。',rate_limit:'图片服务正忙，稍后会有限重试。',unavailable:'图片服务暂不可用，稍后会有限重试。',network:'暂时连接不到图片服务，记录仍保留。'}[state.imageProvider?.failure?.kind]??'这一张暂时没有画出来，记录仍保留。');
 const dateFormat=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'});
 const itemTime=item=>item.createdAt??item.publishedAt??item.endAt;
 button.addEventListener('click',async()=>{
  if(!enabled||active)return;button.disabled=true;
  try{const result=await request('/api/moment-comics/generate',{method:'POST',body:{}});status.textContent=result.accepted?'Pi 正在从最近半小时选一个真实瞬间…':'没有新的可选片段，或已有任务正在处理。';}
  catch(error){onError(error);status.textContent='这一张暂时没有开始；真实记录仍保留。';}finally{button.disabled=!enabled||active;}
 });
 return {render(state={},isEnabled=false){
  enabled=isEnabled;const jobs=state.jobs??[];active=jobs.some(job=>['pending','claimed','render'].includes(job.status));button.disabled=!enabled||active;
  const items=(state.items??[]).slice(0,5);status.textContent=!enabled?'陪伴已暂停；自动生成随陪伴一起恢复。':!state.imageProvider?.configured?'图片服务尚未配置；真实片段仍在记录。':state.rendering||jobs.some(j=>j.status==='render')?'正在把这一刻画成漫画…':jobs.some(j=>j.status==='claimed')?'Pi 正在选择代表瞬间、写一句鼓励…':jobs.some(j=>j.status==='failed')&&!items.length?failureText(state):items.length?`已留下 ${items.length} 个瞬间`:'每半小时，从真实记录中留住一个代表瞬间。';
  next.textContent=state.nextAt?`下一次约 ${new Date(state.nextAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · 最近最多 5 张`:'开始陪伴后计时 · 最近最多 5 张';
  const signature=JSON.stringify(items.map(item=>[item.id,item.imageUrl,item.title,item.encouragement,itemTime(item)]));if(signature===itemSignature)return;itemSignature=signature;
  list.replaceChildren();
  if(!items.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='这里会出现真正生成的漫画。没有可靠片段时留白。';list.append(empty);}
  for(const item of items){const card=document.createElement('article');card.className='moment-card';const image=document.createElement('img');image.src=item.imageUrl;image.alt=item.title??'根据记录漫画化重绘的一个瞬间';image.loading='lazy';const title=document.createElement('strong');title.textContent=item.title??'一个值得留下的瞬间';const support=document.createElement('p');support.textContent=item.encouragement??'';const date=document.createElement('time');const at=itemTime(item);if(Number.isFinite(at)&&Math.abs(at)<=8640000000000000){date.dateTime=new Date(at).toISOString();date.textContent=dateFormat.format(at);}else date.hidden=true;card.append(image,title,date,support);list.append(card);}
 }};
}
