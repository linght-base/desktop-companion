// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Model-authored feedback is a revisable interpretation, never a host status or a human fact. */
export function currentUserFeedback(state={},at=state.at??Date.now()){
 const item=state.userFeedback;
 if(state.personOrientation?.suppressFeedback===true||!state.enabled||['paused','stopped','error'].includes(state.phase)||state.presence?.resting||!item||item.deskId!==state.companion?.profile?.deskId||item.epoch!==state.epoch)return null;
 if(typeof item.message!=='string'||!item.message.trim()||Array.from(item.message).length>16||!Number.isFinite(item.expiresAt)||item.expiresAt<=at)return null;
 return item;
}
export function renderUserFeedback(root,state){
 const current=currentUserFeedback(state),pending=state.enabled&&state.personOrientation?.suppressFeedback===true&&state.userFeedback,history=state.userFeedbackHistory??[],latest=current??pending??[...history].reverse().find(item=>item.deskId===state.companion?.profile?.deskId&&!['invalidated','deleted'].includes(item.status));
 root.dataset.active=String(Boolean(current));
 root.querySelector('[data-user-message]').textContent=latest?.message??'还没有面向你的反馈';
 root.querySelector('[data-user-inference]').textContent=latest?.inference?`它的理解：${latest.inference}`:'看到片段后，由 Pi 判断你在做什么，再选择一句适合的话。';
 root.querySelector('[data-user-uncertainty]').textContent=latest?.uncertainty?`还没看清：${latest.uncertainty}`:'';
 root.querySelector('[data-user-message-status]').textContent=pending?'回正后对你说':current?'这一刻想对你说':latest?'刚才想对你说':'先让我看清这一刻';
}

const withdrawn = new Set(['invalidated','deleted','retracted','superseded']);
const feedbackTime = item => Number.isFinite(item.createdAt) ? item.createdAt : 0;
const feedbackKey = item => item.id || `${item.epoch}:${feedbackTime(item)}:${item.message}`;

/** Only actual model messages; observations are context, never an invented human utterance. */
export function feedbackConversations(state={}){
 const deskId=state.companion?.profile?.deskId;
 if(!deskId)return [];
 const records=[...(state.companion?.perceptions??[]),...(state.companion?.episodes??[]),...(state.companion?.beliefs??[])];
 const index=new Map(records.filter(r=>r.deskId===deskId).map(r=>[r.id,r]));
 const history=state.userFeedbackHistory??[],blocked=new Set(history.filter(item=>withdrawn.has(item.status)).map(feedbackKey));
 const generated=[];
 for(const event of state.events??[]){
  if(event.type!=='user_feedback_requested')continue;
  const item=event.detail,belief=index.get(item?.hypothesisId);
  // Old runtime events have no desk field: their exact stored hypothesis must establish scope.
  if(!belief||item?.deskId&&item.deskId!==deskId||withdrawn.has(belief.status)||!['hypothesis','understanding'].includes(belief.kind)||!Array.isArray(item?.evidenceRefs)||!item.evidenceRefs.length||!item.evidenceRefs.every(ref=>belief.evidenceIds?.includes(ref.id)))continue;
  generated.push({...item,deskId,createdAt:event.at,status:'generated'});
 }
 const unique=new Map();
 for(const item of [...generated,...history,...(state.userFeedback?[state.userFeedback]:[])]){
  if(!item||item.deskId!==deskId||typeof item.message!=='string'||!item.message.trim()||Array.from(item.message).length>16||withdrawn.has(item.status)||['deferred','pending_reconsideration'].includes(item.status)||item.presentationStatus==='not_requested'||blocked.has(feedbackKey(item)))continue;
  const refs=item.evidenceRefs??[];
  if(refs.some(ref=>{const record=index.get(ref.id);return record&&(withdrawn.has(record.status)||Number.isFinite(ref.revision)&&record.revision!==ref.revision);}))continue;
  const source=refs.map(ref=>index.get(ref.id)).find(record=>record&&['perception','episode'].includes(record.kind));
  const current=currentUserFeedback(state);
  unique.set(feedbackKey(item),{...item,isCurrent:Boolean(current&&feedbackKey(current)===feedbackKey(item)),sourceSummary:source?.summary??''});
 }
 return [...unique.values()].sort((a,b)=>feedbackTime(b)-feedbackTime(a));
}

export function feedbackForRecord(state,record,items=feedbackConversations(state)){
 if(!record||record.deskId!==state.companion?.profile?.deskId||withdrawn.has(record.status))return [];
 return items.filter(item=>{
  if(item.evidenceRefs?.some(ref=>ref.id===record.id&&ref.revision===record.revision))return true;
  if(!['hypothesis','understanding'].includes(record.kind))return false;
  if(item.hypothesisId===record.id)return true;
  const summary=item.inference+(item.uncertainty?`\n不确定：${item.uncertainty}`:'');
  const ids=(item.evidenceRefs??[]).map(ref=>ref.id);
  return record.summary===summary&&ids.length>0&&ids.length===record.evidenceIds?.length&&ids.every(id=>record.evidenceIds.includes(id));
 });
}

const renderedConversations=new WeakMap();
export function renderFeedbackConversations(root,state,{latestOnly=false}={}){
 if(!root)return;
 const items=feedbackConversations(state).slice(0,latestOnly?1:5);
 const signature=JSON.stringify(items);
 if(renderedConversations.get(root)===signature)return;
 renderedConversations.set(root,signature);
 const list=root.querySelector('[data-conversation-list]');list.replaceChildren();
 root.querySelector('[data-conversation-count]').textContent=items.length?(latestOnly?'最新一句':`最近 ${items.length} 句`):'等一句回应';
 if(!items.length){
  const empty=document.createElement('p');empty.className='conversation-empty';empty.textContent='还没有生成面向你的反馈。开始陪伴后，它想对你说的话会出现在这里。';list.append(empty);return;
 }
 for(const item of items){
  const card=document.createElement('article');card.className='conversation-item';card.dataset.feedbackId=item.id??'';
  const heading=document.createElement('div');heading.className='conversation-speaker';
  const icon=document.createElement('span');icon.className='conversation-avatar';icon.setAttribute('aria-hidden','true');icon.textContent='◉';
  const name=document.createElement('strong');name.textContent='桌面伙伴';
  const when=document.createElement('span');when.className='conversation-when';when.textContent=item.isCurrent?'此刻想对你说':'此前生成的反馈';
  const at=document.createElement('time');at.textContent=feedbackTime(item)?new Date(item.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';
  heading.append(icon,name,when,at);
  const speech=document.createElement('blockquote');speech.className='feedback-speech';speech.textContent=item.message;
  card.append(heading,speech);
  if(item.inference){const why=document.createElement('p');why.className='conversation-inference';const label=document.createElement('strong');label.textContent='它的理解：';why.append(label,document.createTextNode(item.inference));card.append(why);}
  if(item.sourceSummary||item.uncertainty){
   const details=document.createElement('details');details.className='conversation-context';const summary=document.createElement('summary');summary.textContent='看看当时的片段与不确定之处';details.append(summary);
   for(const [label,value] of [['当时看见',item.sourceSummary],['还没看清',item.uncertainty]])if(value){const line=document.createElement('p');line.textContent=label+'：'+value;details.append(line);}
   card.append(details);
  }
  list.append(card);
 }
}
