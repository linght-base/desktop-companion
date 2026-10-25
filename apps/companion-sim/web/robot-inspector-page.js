// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {mountAgentInspector} from './agent-inspector.js';
const request=async path=>{const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw new Error('读取失败');return response.json();};
const inspector=mountAgentInspector({request});
let busy=false;
async function refresh(){
 if(busy)return;busy=true;
 try{
  const [state,characters]=await Promise.all([request('/api/state'),request('/api/comic-characters')]);
  inspector.render(state.piContext);
  const root=document.querySelector('[data-character-context]');root.replaceChildren();
  if(!characters.items.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='尚无可延续的人物外观记录；下一次真实观察后由 Pi 提取，不从旧漫画猜测人物。';root.append(empty);}
  for(const [i,item] of characters.items.entries()){
   const card=document.createElement('article');card.className='product-record';
   const title=document.createElement('strong');title.textContent=`角色 ${i+1} · 身份未知`;
   const appearance=document.createElement('p');appearance.textContent='外观锚点：'+item.appearance;
   const clothing=document.createElement('p');clothing.textContent='最近时刻衣着：'+item.lastClothing;
   const time=document.createElement('small');time.textContent=new Date(item.observedAt).toLocaleString('zh-CN')+' · 模型关联，可修订';
   card.append(title,appearance,clothing,time);root.append(card);
  }
 }catch{document.querySelector('[data-character-context]').textContent='暂时无法读取人物上下文，请稍后刷新。';}finally{busy=false;}
}
refresh();const timer=setInterval(()=>{if(!document.hidden)refresh();},10000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
