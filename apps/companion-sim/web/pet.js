// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const canvas=document.getElementById('pet-canvas');const ctx=canvas.getContext('2d');
const embedded=new URLSearchParams(location.search).has('embedded');if(embedded)document.body.classList.add('embedded');
const rows={idle:[0,6,220],wave:[3,4,180],jump:[4,5,120],waiting:[6,6,220],review:[8,6,220]};
let state=null,connected=false,atlasReady=false,lastCommand=null,start=performance.now();
const image=new Image();image.src='/assets/pet-atlas.png';image.onload=()=>{atlasReady=image.naturalWidth===1536&&[1872,2288].includes(image.naturalHeight);};image.onerror=()=>{atlasReady=false;};
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
function draw(at){
  ctx.clearRect(0,0,384,416);
  const active=connected&&state?.enabled&&state?.body?.leaseUntil>Date.now()&&!['paused','stopped','error'].includes(state.phase);
  const body=active?state.body:null;
  if(body?.activeCommandId!==lastCommand){lastCommand=body?.activeCommandId;start=at;}
  const gesture=active&&rows[body.gesture]?body.gesture:'idle';canvas.dataset.gesture=gesture;canvas.dataset.connected=String(connected);canvas.dataset.atlas=String(atlasReady);
  if(atlasReady){
    const [row,count,interval]=rows[gesture];let column=reduce||!active?0:Math.floor((at-start)/interval)%count;
    if(gesture==='jump')column=Math.min(count-1,Math.floor((at-start)/interval));
    ctx.drawImage(image,column*192,row*208,192,208,0,0,384,416);
  }else{
    ctx.fillStyle='#0a1711';ctx.beginPath();ctx.arc(192,208,145,0,Math.PI*2);ctx.fill();
    const eyes=body?.eyes??{gazeX:0,gazeY:0,openness:.55,color:'#A9DDE9'};ctx.fillStyle=/^#[\da-f]{6}$/i.test(eyes.color)?eyes.color:'#A9DDE9';
    const open=Math.max(.05,eyes.openness)*(reduce?1:active&&at%4700<120?.15:1);
    for(const x of [139,245]){ctx.beginPath();ctx.roundRect(x-12+eyes.gazeX*20,208-open*48+eyes.gazeY*25,24,open*96,10);ctx.fill();}
  }
  requestAnimationFrame(draw);
}
const events=new EventSource('/api/events');events.addEventListener('state',event=>{
  try{state=JSON.parse(event.data);connected=true;document.getElementById('pet-status').textContent=`${state.mode==='fixture'?'离线软件链路':'云模式'} · ${state.phase} · ${atlasReady?'苔苔素材展示':'圆屏表达适配'} · ${state.body.gesture??'idle'}`;}catch{connected=false;}
});events.onerror=()=>{connected=false;document.getElementById('pet-status').textContent='表达流断开 · 已退回静默';};
async function input(kind){await fetch('/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind})});}
document.getElementById('pet-ack').onclick=()=>input('ack');document.getElementById('pet-pause').onclick=()=>input('pause');
canvas.onclick=()=>input('ack');window.addEventListener('keydown',e=>{if(e.key==='Escape')input('pause');});
window.addEventListener('pagehide',()=>events.close());requestAnimationFrame(draw);
