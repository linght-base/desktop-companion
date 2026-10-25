// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const escape = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const clamp = (value,min,max,fallback=0) => Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;
function lines(value,width=22) {
  const result=[];
  for(const paragraph of String(value??'').split('\n')) {
    const chars=Array.from(paragraph);if(!chars.length)result.push('');
    for(let i=0;i<chars.length;i+=width)result.push(chars.slice(i,i+width).join(''));
  }
  return result;
}
const textBlock=(values,x,y,className='body',lineHeight=20)=>`<text x="${x}" y="${y}" class="${className}">${values.map((line,i)=>`<tspan x="${x}" dy="${i?lineHeight:0}">${escape(line)}</tspan>`).join('')}</text>`;
function metadata(panel) {
  const source=panel.source==='replay'?'回放来源 replay':panel.source==='camera'?'摄像头采样 camera':['user','explicit_user'].includes(panel.source)?'用户明确输入':panel.source==='observed_interaction'?'交互记录':'来源未知';
  const coverage=panel.coverage==='visible'?'采样时可见':panel.coverage==='partial'?'仅局部可见':'可见范围未知';
  return [`来源 ${source} · 修订 ${Number.isSafeInteger(panel.revision)?panel.revision:'未知'}`,
    `引用 ${String(panel.basisId??'未知')}`,`采样时间 ${Number.isFinite(panel.observedAt) && Math.abs(panel.observedAt)<=8640000000000000 ? new Date(panel.observedAt).toISOString() : '未知'}`,coverage,
    ...(Array.isArray(panel.uncertainties)?panel.uncertainties.filter(x=>typeof x==='string').map(x=>`未知 / 不确定：${x}`):[]),
    panel.evidenceAvailability??'原画面未留存，无法回放核查'];
}
function robot(expression={}) {
  const gazeX=clamp(expression.gazeX,-1,1)*5,gazeY=clamp(expression.gazeY,-1,1)*4;
  const openness=clamp(expression.openness,0,1,0.85),tilt=clamp(expression.tilt,-30,30);
  return `<g transform="translate(23 109) rotate(${tilt} 40 40)" aria-label="机器人叙述者"><path d="M22 76 L14 101 L66 101 L58 76" fill="#e5cba5" stroke="#3b4544" stroke-width="2.5"/><rect x="0" y="0" width="80" height="76" rx="23" fill="#f7e6cb" stroke="#3b4544" stroke-width="2.5"/><rect x="9" y="15" width="62" height="43" rx="14" fill="#3b4544"/><ellipse cx="${26+gazeX}" cy="${36+gazeY}" rx="5" ry="${Math.max(1,8*openness)}" fill="#a9cfc3"/><ellipse cx="${54+gazeX}" cy="${36+gazeY}" rx="5" ry="${Math.max(1,8*openness)}" fill="#a9cfc3"/><path d="M33 65 L47 65" stroke="#3b4544" stroke-width="2" stroke-linecap="round"/></g>`;
}
function scene(panel) {
  const entities=new Map((Array.isArray(panel.entities)?panel.entities:[]).filter(e=>typeof e?.id==='string'&&typeof e?.label==='string').map(e=>[e.id,e]));
  const objects=[];
  for(const o of (Array.isArray(panel.objects)?panel.objects:[]).slice(0,16)) {
    if(!o||!entities.has(o.entityId)||!['rect','ellipse'].includes(o.shape)||![o.x,o.y,o.width,o.height].every(Number.isFinite)||o.x<0||o.y<0||o.width<=0||o.height<=0||o.x+o.width>1||o.y+o.height>1)continue;
    const x=120+o.x*235,y=20+o.y*142,w=o.width*235,h=o.height*142;
    const geometry=o.shape==='ellipse'?`<ellipse cx="${x+w/2}" cy="${y+h/2}" rx="${w/2}" ry="${h/2}"`:`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"`;
    objects.push(`<g transform="rotate(${clamp(o.rotation,-180,180)} ${x+w/2} ${y+h/2})">${geometry} fill="#a9cfc3" fill-opacity=".66" stroke="#3b4544" stroke-width="2"/></g><text x="${x+w/2}" y="${Math.min(183,y+h+16)}" text-anchor="middle" class="object-label">${escape(Array.from(entities.get(o.entityId).label).slice(0,20).join(''))}</text>`);
  }
  return `<rect x="0" y="0" width="376" height="214" rx="12" fill="#f3f0e8"/><path d="M111 191 H361" stroke="#d1c9b8" stroke-width="2"/>${objects.join('')}${robot(panel.robot)}<text x="14" y="205" class="note">机器人叙述 · 图形化简，不是原机位重建</text>`;
}
/** Pure SVG renderer: only fixed graphical primitives and escaped current-source text. */
export function renderComicSvg(book={}) {
  const panels=(Array.isArray(book?.panels)?book.panels:[]).slice(0,6);
  const columns=panels.length>1?2:1,width=columns===2?880:460;
  const prepared=panels.map(panel=>({panel,summary:lines(panel.summary),meta:metadata(panel).flatMap(line=>lines(line,34))}));
  const groups=[];let cursorY=100;
  for(let i=0;i<prepared.length;i+=columns) {
    const row=prepared.slice(i,i+columns);const rowHeight=Math.max(...row.map(p=>310+p.summary.length*22+p.meta.length*18));
    row.forEach(({panel,summary,meta},column)=>{
      const x=22+column*428;
      groups.push(`<g transform="translate(${x} ${cursorY})"><rect width="408" height="${rowHeight}" rx="18" fill="#fffdf7" stroke="#3b4544" stroke-width="2"/><text x="16" y="29" class="panel-title">${i+column+1} · ${escape(panel.source==='replay'?'回放片段':'事实片段')}</text><g transform="translate(16 45)">${scene(panel)}</g>${textBlock(summary,16,289,'body',22)}${textBlock(meta,16,309+summary.length*22,'note',18)}</g>`);
    });
    cursorY+=rowHeight+22;
  }
  if(!panels.length){groups.push(`<g transform="translate(22 100)"><rect width="${width-44}" height="190" rx="18" fill="#fffdf7" stroke="#b4b4a4" stroke-dasharray="7 7"/><text x="22" y="65" class="panel-title">暂无可用事实，保留空白</text><text x="22" y="103" class="body">未观察到的时间和活动仍然未知。</text><text x="22" y="138" class="note">草稿等待有依据的片段，不推断工作结束。</text></g>`);cursorY=312;}
  const gaps=(Array.isArray(book?.gaps)?book.gaps:[]).slice(0,100);
  const gapLines=gaps.length?['观察空档：',...gaps.flatMap(g=>lines(`${g.reason??'未连续观察，不推断期间的活动'}${Number.isFinite(g.startAt)&&Number.isFinite(g.endAt)?` [${g.startAt}–${g.endAt}]`:''}`,columns===2?70:34))]:['覆盖范围：未记录的时间仍然未知。'];
  groups.push(textBlock(gapLines,24,cursorY+7,'note',19));
  const height=cursorY+gapLines.length*19+32;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(`${book?.day??''} 每日事实漫画`)}"><title>${escape(book?.day??'')} 每日事实漫画</title><style>text{font-family:system-ui,"PingFang SC","Noto Sans SC",sans-serif;fill:#3b4544}.title{font-size:25px;font-weight:650}.panel-title{font-size:16px;font-weight:650}.body{font-size:16px}.note{font-size:11px;fill:#676e66}.object-label{font-size:11px}</style><rect width="${width}" height="${height}" fill="#eee9dd"/><text x="24" y="38" class="title">${escape(book?.day??'')} · 每日事实漫画</text><text x="24" y="65" class="note">${escape(book?.status==='published'?'待查看的事实画册':'事实草稿')} · 只呈现记录，不推断身份或情绪</text>${groups.join('')}</svg>`;
}
