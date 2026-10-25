// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {FEEDBACK_PATHS} from './interaction-feedback.js';
import {COGNITIVE_PATHS,COGNITIVE_STROKE_WIDTH,cognitiveItems} from './cognitive-icons.js';
import {projectBodyPresentation} from './body-presentation.js';
const NS = 'http://www.w3.org/2000/svg';
const neutral = {gazeX: 0, gazeY: 0, openness: 0.55, tilt: 0, roundness: 1, color: '#BFF478'};
const segments = [[-66.5, -30, 10, 60], [-42.5, -58, 12, 116], [-18.5, -72, 12, 50], [-18.5, 24, 12, 48], [7.5, -72, 10, 50], [7.5, 22, 10, 50], [31.5, -58, 10, 116], [55.5, -30, 12, 60]];
const icons = {
  question: ['M194 103C194 84 222 83 222 101C222 114 207 113 207 128', 'M207 143L207 144'],
  sparkle: ['M206 76L213 96L232 103L213 110L206 130L199 110L180 103L199 96Z'],
  clock: ['M229 108A23 23 0 1 1 183 108A23 23 0 1 1 229 108', 'M206 94V109L217 114'],
  check: ['M187 105L201 119L227 91'],
  water: ['M206 77C201 88 186 103 186 115A20 20 0 0 0 226 115C226 103 211 88 206 77Z', 'M196 116C196 123 201 127 206 127'],
  movement: ['M215 78A6 6 0 1 0 215 90A6 6 0 1 0 215 78', 'M194 116L204 98L216 102L229 112', 'M209 101L203 117L191 133', 'M203 117L218 125L223 138'],
  book: ['M185 298Q195 294 206 301Q217 294 227 298V321Q217 317 206 324Q195 317 185 321Z', 'M206 301V324'],
  posture: ['M208 76A6 6 0 1 0 208 88A6 6 0 1 0 208 76', 'M207 95V116H226V138', 'M187 95V126H212', 'M182 138V126H212']
};

/** A graphic simulator, with no speech or text rendered on the face. */
export function mountRobot({head, leftEye, rightEye, icon, stage}) {
  const pan = stage.querySelector('#robot-pan');
  const depth = head.querySelector('.head-depth');
  for(let z=-34;z<=32;z+=3) {
    const rim=document.createElement('div');rim.className='head-rim';
    rim.style.transform=`translateZ(${z}px)`;depth.append(rim);
  }
  const feedbackGroup=document.createElementNS(NS,'g');feedbackGroup.id='face-feedback';feedbackGroup.style.pointerEvents='none';stage.querySelector('#robot-face > g').append(feedbackGroup);
  let eyes = {...neutral};
  let blinking = false;
  let frame;
  let lastDraw = -Infinity;
  let latestBody=null,latestOptions={},expiryTimer=null;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const eyeRects = [leftEye, rightEye].map(group => segments.map(() => {
    const rect = document.createElementNS(NS, 'rect');
    group.append(rect);
    return rect;
  }));

  function draw(blink = 1) {
    const openness = eyes.openness * blink * (latestOptions.feedback?.code?.length ? .82 : 1);
    [leftEye, rightEye].forEach((group, side) => {
      group.setAttribute('fill', neutral.color);
      group.setAttribute('transform', `translate(${(side ? 280.8 : 131.2) + eyes.gazeX * 23} ${latestOptions.feedback?.code?.length ? 190+eyes.gazeY*24 : 206+eyes.gazeY*32}) rotate(${eyes.tilt * (side ? -1 : 1)})`);
      segments.forEach(([x, y, width, height], index) => {
        const rect = eyeRects[side][index];
        rect.setAttribute('x', x);
        rect.setAttribute('y', y * openness);
        rect.setAttribute('width', width);
        rect.setAttribute('height', Math.max(2, height * openness));
        rect.setAttribute('rx', Math.min(width / 2, height * openness / 2) * eyes.roundness);
      });
    });
  }

  function present() {
    if(!latestBody)return;
    const {body,nextExpiryAt}=projectBodyPresentation(latestBody,Date.now());
    const {phase='stopped',bookReady=false,feedback=null,cognition=[]}=latestOptions;
    feedbackGroup.replaceChildren();
    const userMessage=latestOptions.userFeedback?.expiresAt>Date.now()?latestOptions.userFeedback:null;
    if(userMessage){
      const chars=Array.from(userMessage.message),lines=chars.length>8?[chars.slice(0,8).join(''),chars.slice(8).join('')]:[chars.join('')];

      lines.forEach((line,i)=>{const text=document.createElementNS(NS,'text');for(const[k,v]of Object.entries({x:206,y:lines.length===1?325:307+i*29,'text-anchor':'middle','font-size':25,fill:'#BFF478','font-family':"'PingFang SC','Microsoft YaHei',sans-serif"}))text.setAttribute(k,v);text.textContent=line;feedbackGroup.append(text);});
    }
    if(feedback?.label&&!userMessage){
      const text=document.createElementNS(NS,'text');for(const[k,v]of Object.entries({x:206,y:327,'text-anchor':'middle','font-size':24,fill:'#BFF478','font-family':"'PingFang SC','Microsoft YaHei',sans-serif"}))text.setAttribute(k,v);text.textContent=feedback.label;feedbackGroup.append(text);
    }
    eyes = {...neutral, ...body.eyes};
    if(['paused','resting','manual','unavailable'].includes(feedback?.code))eyes.openness=.18;
    else if(body.source==='hardware_intent'&&!body.expressionCommandId&&!body.gazeCommandId)eyes.openness=.72;
    // CSS +X tilts the lens upward; yaw rotates the entire neck/head assembly.
    pan.style.transform = `rotateY(${body.head.yaw}deg)`;
    head.style.transform = `rotateX(${body.head.pitch}deg)`;
    head.dataset.yaw = String(body.head.yaw);
    head.dataset.pitch = String(body.head.pitch);
    stage.setAttribute('aria-label', `${body.source==='hardware_intent'?'真机目标姿态':'模拟机器人'}，头部水平 ${body.head.yaw} 度，俯仰 ${body.head.pitch} 度；${phase}`);
    icon.replaceChildren();
    const showBook = bookReady && (!body.icon || body.icon === 'none');
    icon.setAttribute('opacity', showBook ? '0.32' : '1');
    for (const data of []) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', data);
      icon.append(path);
    }
    blinking = !['stopped', 'paused', 'error'].includes(phase);
    draw();
    const expiry=userMessage?Math.min(nextExpiryAt??Infinity,userMessage.expiresAt):nextExpiryAt;
    if(expiry!==null)expiryTimer=setTimeout(()=>{expiryTimer=null;present();},Math.max(1,expiry-Date.now()));
  }

  function render(body, options = {}) {
    if(!body)return;
    clearTimeout(expiryTimer);expiryTimer=null;
    latestBody=structuredClone(body);latestOptions={...options};
    present();
  }

  function animate(at) {
    if (at - lastDraw > 32 && blinking && !reducedMotion) {
      const position = at % 4700;
      const blink = position < 180 ? Math.max(0.07, Math.abs(position - 90) / 90) : 1;
      draw(blink);
      lastDraw = at;
    }
    frame = requestAnimationFrame(animate);
  }
  draw();
  frame = requestAnimationFrame(animate);
  return {render, settle() {clearTimeout(expiryTimer);expiryTimer=null;latestBody=null;blinking = false; head.style.transition = 'none'; pan.style.transition = 'none'; pan.style.transform = 'rotateY(0deg)'; head.style.transform = 'rotateX(0deg)'; head.dataset.yaw='0';head.dataset.pitch='0';eyes = {...neutral}; draw(); icon.replaceChildren(); requestAnimationFrame(() => {head.style.transition = ''; pan.style.transition = '';});}, dispose() {clearTimeout(expiryTimer);latestBody=null;cancelAnimationFrame(frame);}};
}
