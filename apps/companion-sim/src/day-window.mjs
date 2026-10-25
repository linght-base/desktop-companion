// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const DAY_MS=86400000;
const MAX_TIME=8640000000000000;
const formats=new Map();
const times=new Map();
export function validDay(day){
 if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new TypeError('invalid_day');
 const at=Date.parse(`${day}T00:00:00Z`);
 if(!Number.isFinite(at)||new Date(at).toISOString().slice(0,10)!==day)throw new TypeError('invalid_day');
 return day;
}
export function validClock(value){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new TypeError('invalid_day_clock');return value;}
const instant=at=>{if(!Number.isSafeInteger(at)||at<0||at>MAX_TIME)throw new TypeError('invalid_day_instant');return at;};
function formatter(zone){
 if(typeof zone!=='string'||!zone||zone.length>100)throw new TypeError('invalid_time_zone');
 if(!formats.has(zone)){
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  formats.set(zone,format);while(formats.size>32)formats.delete(formats.keys().next().value);
 }
 return formats.get(zone);
}
function local(at,zone){
 const p=Object.fromEntries(formatter(zone).formatToParts(at).map(x=>[x.type,x.value]));
 return {day:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`,wall:Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)};
}
export function shiftDay(day,amount){validDay(day);return new Date(Date.parse(`${day}T00:00:00Z`)+amount*DAY_MS).toISOString().slice(0,10);}
// Compatible DST disambiguation: earliest occurrence for repeated local time;
// a missing clock time moves forward by the offset gap. No fixed 24-hour UTC day.
function localInstant(day,time,zone){
 validDay(day);validClock(time);formatter(zone);
 const key=JSON.stringify([day,time,zone]);if(times.has(key))return times.get(key);
 const remember=at=>{times.set(key,at);while(times.size>256)times.delete(times.keys().next().value);return at;};
 const wanted=Date.parse(`${day}T${time}:00Z`),offsets=new Set();
 for(let delta=-36;delta<=36;delta+=6){const probe=wanted+delta*3600000;offsets.add(local(probe,zone).wall-probe);}
 const candidates=[...offsets].map(offset=>wanted-offset).filter(at=>Number.isSafeInteger(at)&&Math.abs(at)<=MAX_TIME);
 const exact=candidates.filter(at=>local(at,zone).wall===wanted).sort((a,b)=>a-b);
 if(exact.length)return remember(exact[0]);
 const forward=candidates.filter(at=>local(at,zone).wall>wanted).sort((a,b)=>local(a,zone).wall-local(b,zone).wall||a-b);
 if(!forward.length)throw new TypeError('unresolvable_day_clock');
 return remember(forward[0]);
}
export function workdayBounds(day,{dayStart='00:00',timeZone='Asia/Shanghai',closeTime='21:00'}={}){
 validDay(day);validClock(dayStart);validClock(closeTime);
 // The evidence clock starts at Unix zero. A local day can begin before it;
 // keep that unrepresentable prefix outside the nonnegative evidence window.
 const startAt=Math.max(0,localInstant(day,dayStart,timeZone)),endAt=Math.max(0,localInstant(shiftDay(day,1),dayStart,timeZone));
 const closeAt=Math.max(startAt,localInstant(closeTime<dayStart?shiftDay(day,1):day,closeTime,timeZone));
 if(endAt<=startAt||endAt-startAt>2*DAY_MS||closeAt<startAt||closeAt>endAt)throw new TypeError('invalid_workday_window');
 return {day,timeZone,dayStart,startAt,endAt,closeAt};
}
export function workdayFor(at,{dayStart='00:00',timeZone='Asia/Shanghai'}={}){
 instant(at);validClock(dayStart);const date=local(at,timeZone).day;
 return at<localInstant(date,dayStart,timeZone)?shiftDay(date,-1):date;
}
