// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const dateText = (value,timeZone) => {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {hour12:false,...(timeZone?{timeZone}:{})});
};
const sourceText = source => ({camera:'本机摄像头',replay:'图片回放 · 非当前现场',user:'明确记录'})[source] || '来源未注明';
const noteText = value => typeof value === 'string' ? value : value?.reason || '';

/** Project only the currently resolved comic, never populate missing panels from logs. */
export function comicView(data = {}, day) {
  const book = data.book?.day === day ? data.book : null;
  const invalid = book?.status === 'invalidated';
  const panels = !invalid && Array.isArray(book?.panels) ? book.panels : [];
  const timeZone=book?.timeZone??data.scope?.timeZone;
  const period=book?.startAt!==undefined?book:data.scope;
  const ready = book?.status === 'published' && panels.length > 0;
  const jobs = (data.jobs || []).filter(job => !job.day || job.day === day);
  const pending = jobs.some(job => ['pending','claimed'].includes(job.status));
  const failed = jobs.some(job => job.status === 'failed');
  return {
    imageUrl: ready ? `/api/comic.svg?day=${encodeURIComponent(day)}&v=${encodeURIComponent(book.updatedAt ?? book.id ?? '')}` : null,
    status: invalid ? '来源已修订 · 旧分镜已失效' : ready ? `可查看草稿 · ${panels.length} 格` : pending ? '正在整理有依据的片段 · 尚未成稿' : failed ? '整理未完成 · 这一页先留白' : '空白草稿 · 这一页先留白',
    pending,
    period:period?.startAt!==undefined&&period?.endAt!==undefined?`日记范围：${dateText(period.startAt,timeZone)}—${dateText(period.endAt,timeZone)}${timeZone?` · ${timeZone}`:''}`:'',
    sources: ready ? panels.map((panel,index) => ({summary:panel.summary || '来源未提供事实摘要',detail:[`第 ${index+1} 格`,sourceText(panel.source),panel.basisId ? `引用 ${panel.basisId}` : '无来源引用',`修订 ${panel.revision ?? 1}`,dateText(panel.observedAt,timeZone),...(panel.uncertainties || []).map(noteText)].filter(Boolean).join(' · ')})) : [],
    gaps: (book?.gaps || []).map(gap => typeof gap === 'string' ? gap : [dateText(gap.startAt,timeZone),dateText(gap.endAt,timeZone),noteText(gap)].filter(Boolean).join(' — ')),
    signature: JSON.stringify([book,jobs])
  };
}

/** The browser also expires stale target choices between server events. */
export function attentionView(attention = {}, now = Date.now()) {
  const status = attention.status || 'idle';
  const unavailable = ['paused','unavailable','error','idle'].includes(status);
  const fresh = !unavailable && Number.isFinite(attention.observedAt) && now - attention.observedAt <= 500 && now >= attention.observedAt;
  const focus = fresh && attention.focus?.until > now ? attention.focus : null;
  const targets = fresh ? (attention.targets || []).map((target,index) => ({id:target.id,label:`未知身份 · 目标 ${index+1}`,following:focus?.targetId === target.id})) : [];
  const names = {idle:'等待本地位置检测',visible:'发现短期目标 · 尚未跟随',tracking:'正在跟随所选目标',searching:'目标已失效 · 有限搜索后收回',unavailable:'本地位置检测不可用',error:'本地位置检测异常',paused:'已暂停 · 不跟随'};
  return {targets,status:!fresh && ['visible','tracking'].includes(status) ? '目标位置已失效 · 等待新检测' : status === 'tracking' && !focus ? '跟随租期已到 · 等待新选择' : names[status] || names.idle,reason:attention.reason || '',canStop:!!attention.focus || status === 'searching',until:focus ? dateText(focus.until) : ''};
}

export function focusRequest(attention, targetId, now = Date.now()) {
  if (targetId === null) return {targetId:null,durationMs:0};
  if (!attentionView(attention,now).targets.some(target => target.id === targetId)) throw new Error('目标位置已失效，请等待新检测后再选择');
  return {targetId,durationMs:5000};
}

export function comicSettingsRequest({enabled,closeTime,timeZone,dayStart}) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime)) throw new Error('请选择有效的本地整理时间');
  const zone = String(timeZone || '').trim();
  try {new Intl.DateTimeFormat('zh-CN',{timeZone:zone}).format();} catch {throw new Error('请输入有效时区，例如 Asia/Shanghai');}
  if(dayStart!==undefined&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(dayStart))throw new Error('请选择有效的日期切换时间');
  return {enabled:!!enabled,closeTime,timeZone:zone,...(dayStart===undefined?{}:{dayStart})};
}

export function comicBadgeVisible(comic, body, phase) {
  return !['stopped','paused','error'].includes(phase) && !body?.expressionCommandId && (!body?.icon || body.icon === 'none') && comic?.book?.status === 'published' && comic.book.panels?.length > 0;
}

export function mountComicUI({document,request,showError}) {
  const $ = id => document.getElementById(id);
  const dailyHidden=()=>$('daily-comic')?.hidden===true;
  let lastData = {}, attention = {}, settingsDirty = false, signature = '', requestVersion = 0;
  let lastAttentionSignature = '', attentionBusy = false;
  let imageFailed = false, imageAttempt = 0;
  let followCurrent=!$('diary-day').value;
  let snapshotDay = null, snapshotSignature = '', nextHistoricalRefresh = 0, backgroundRead = null, disposed = false;
  const element = (tag,text,className) => {const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;};
  function render(data = {}, {retryImage = false} = {}) {
    if(dailyHidden())return;
    lastData = data;
    const view = comicView(data,$('diary-day').value);
    $('comic-status').textContent = view.status;
    if($('comic-period'))$('comic-period').textContent=view.period;
    $('comic-generate').disabled = view.pending;
    if (view.signature !== signature || retryImage && imageFailed) {
      const retry = retryImage && imageFailed && view.signature === signature;
      imageAttempt = retry ? imageAttempt + 1 : 0;
      imageFailed = false;
      signature = view.signature;
      const image = $('comic-image');
      image.hidden = !view.imageUrl;
      $('comic-empty').hidden = !!view.imageUrl;
      if (view.imageUrl) {image.src=view.imageUrl+(imageAttempt ? `&retry=${imageAttempt}` : '');image.alt=`${$('diary-day').value} 的事实漫画草稿，${view.sources.length} 格；原文来源列在下方`;}
      else image.removeAttribute('src');
      $('comic-empty').textContent = view.status.includes('失效') ? '引用的内容已变化，旧画面已移除。重新整理后再查看。' : '没有足够片段时，可以少画几格，也可以留白。';
      $('comic-sources').replaceChildren(...view.sources.map(source => {const article=element('article','','comic-source');article.append(element('p',source.summary),element('small',source.detail));return article;}));
      $('comic-source-details').hidden = !view.sources.length;
      $('diary-gaps').replaceChildren(...view.gaps.map(gap=>element('p',`观察留白：${gap}`,'gap-note')));
    }
    if (!settingsDirty && data.settings) {
      $('comic-enabled').checked=!!data.settings.enabled;
      $('comic-close-time').value=data.settings.closeTime || '21:00';
      if($('comic-day-start'))$('comic-day-start').value=data.settings.dayStart || '00:00';
      $('comic-time-zone').value=data.settings.timeZone || 'Asia/Shanghai';
    }
  }
  async function refresh() {
    if(dailyHidden())return;
    const version=++requestVersion;
    nextHistoricalRefresh=Date.now()+2000;
    const day=$('diary-day').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const data=await request(`/api/comic?day=${encodeURIComponent(day)}`);
    if (!disposed && version === requestVersion && day === $('diary-day').value) render(data,{retryImage:true});
  }
  function refreshHistorical() {
    if (disposed || !snapshotDay || snapshotDay === $('diary-day').value || backgroundRead || Date.now() < nextHistoricalRefresh) return;
    backgroundRead=refresh().catch(showError).finally(()=>{backgroundRead=null;});
    return backgroundRead;
  }
  $('diary-day').addEventListener('change',()=>{followCurrent=false;signature='';render({settings:lastData.settings});refresh().catch(showError);});
  $('comic-refresh').addEventListener('click',()=>refresh().catch(showError));
  $('comic-generate').addEventListener('click',async()=>{
    if(dailyHidden())return;
    $('comic-generate').disabled=true;$('comic-result').textContent='正在请求整理…';
    try {await request('/api/comic/generate',{method:'POST',body:{day:$('diary-day').value}});await refresh();$('comic-result').textContent='整理请求已保存；待看草稿会显示在这里。';}
    catch(error){showError(error);$('comic-result').textContent='整理请求未保存。';}
    finally{$('comic-generate').disabled=comicView(lastData,$('diary-day').value).pending;}
  });
  $('comic-settings-form').addEventListener('input',()=>settingsDirty=true);
  $('comic-settings-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try {const body=comicSettingsRequest({enabled:$('comic-enabled').checked,closeTime:$('comic-close-time').value,timeZone:$('comic-time-zone').value,...($('comic-day-start')?{dayStart:$('comic-day-start').value}:{})});await request('/api/comic/settings',{method:'POST',body});settingsDirty=false;await refresh();$('comic-settings-result').textContent='整理设置已保存。';}
    catch(error){showError(error);$('comic-settings-result').textContent='设置未保存，请检查输入。';}finally{button.disabled=false;}
  });
  $('comic-image').addEventListener('error',()=>{if (!comicView(lastData,$('diary-day').value).imageUrl) return;imageFailed=true;$('comic-image').hidden=true;$('comic-empty').hidden=false;$('comic-empty').textContent='漫画画面暂未载入，请刷新重试。来源原文仍可核对。';});
  function renderAttention(value = attention) {
    attention=value;
    const view=attentionView(value);
    const nextSignature=JSON.stringify([view,attentionBusy]);
    if(nextSignature===lastAttentionSignature)return;
    lastAttentionSignature=nextSignature;
    $('local-attention-status').textContent=view.status;
    $('local-attention-detail').textContent=[view.until ? `跟随选择最长至 ${view.until}` : '',view.reason ? `当前说明：${view.reason}` : ''].filter(Boolean).join(' · ');
    $('attention-stop').disabled=!view.canStop || attentionBusy;
    $('local-target-list').replaceChildren(...view.targets.map(target=>{
      const row=element('div','','local-target');const label=element('span',target.label);
      const button=element('button',target.following ? '正在跟随' : '跟随 5 秒');button.type='button';button.disabled=target.following || attentionBusy;button.dataset.targetId=target.id;
      button.addEventListener('click',()=>focus(target.id));row.append(label,button);
      if(view.targets.length===1){
        const subject=element('button','选择为本次提醒对象');subject.type='button';subject.disabled=attentionBusy;
        subject.addEventListener('click',async()=>{subject.disabled=true;try{const result=await request('/api/subject/select',{method:'POST',body:{targetId:target.id}});$('attention-result').textContent=result.accepted?'已选择当前人物；离开视野、多人或重连后需要重新确认，不代表识别身份。':'当前人物位置不明确，请重新选择。';}catch(error){showError(error);}finally{subject.disabled=false;}});row.append(subject);
      }
      return row;
    }));
  }
  async function focus(targetId) {
    try {const body=focusRequest(attention,targetId);attentionBusy=true;renderAttention();await request('/api/attention/focus',{method:'POST',body});$('attention-result').textContent=targetId===null?'已请求停止跟随。':'已请求短期跟随；以本机状态为准。';}
    catch(error){showError(error);$('attention-result').textContent='选择未保存。';}finally{attentionBusy=false;renderAttention();}
  }
  $('attention-stop').addEventListener('click',()=>focus(null));
  const timer=setInterval(()=>{renderAttention();refreshHistorical();},200);
  return {render,refresh,renderAttention,renderSnapshot(data = {}) {
    if(dailyHidden())return;
    const zone=data.settings?.timeZone || 'Asia/Shanghai';
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const part=type=>parts.find(value=>value.type===type)?.value;
    const currentDay=`${part('year')}-${part('month')}-${part('day')}`;
    snapshotDay=data.scope?.day || data.book?.day || currentDay;
    if(followCurrent&&$('diary-day').value!==snapshotDay){$('diary-day').value=snapshotDay;signature='';}
    if ($('diary-day').value === snapshotDay) {
      // Changed authoritative comic data supersedes earlier reads. Identical
      // video/body snapshots must not starve a user-requested image retry.
      const nextSnapshotSignature=JSON.stringify([snapshotDay,data]);
      if (nextSnapshotSignature !== snapshotSignature) requestVersion++;
      snapshotSignature=nextSnapshotSignature;
      render(data);
    } else return refreshHistorical();
  },dispose(){disposed=true;requestVersion++;clearInterval(timer);}};
}
