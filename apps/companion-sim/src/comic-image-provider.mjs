// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {sanitizeProviderFailure,classifyProviderFailure,classifyProviderNetworkFailure} from './provider-failure.mjs';

/** Fixed error codes only; provider status_msg strings never cross this boundary. */
export class ComicImageError extends Error {
  constructor(code,message,failure){
    super(message);
    this.name='ComicImageError';
    this.code=code;
    if(failure)this.failure=sanitizeProviderFailure(failure);
  }
}

// Documented MiniMax text-to-image contract (image_generation): prompt <=1500 chars.
// The static style prefix reserves the headroom; scene facts are never truncated.
const STYLE_PREFIX="Warm colorful single-panel comic, bold clean outlines. Circular-safe composition: center the recorded moment inside a circle with wide safe margins. Draw only these facts; no invented people, props, identity, emotions, health or achievements. Any screen in the facts must be blank. No text, logos or watermarks; the host adds the caption. Illustration, not a photo reconstruction. Facts: ";
const PROMPT_CHAR_LIMIT=1500;
const charCount=value=>Array.from(value).length;
const SCENE_CHAR_LIMIT=Math.min(1000,PROMPT_CHAR_LIMIT-charCount(STYLE_PREFIX));
const MAX_BODY_BYTES=8*1024*1024;
const MAX_IMAGE_BYTES=4*1024*1024;
const MAX_DIMENSION=2048;
const ALLOWED_IMAGE_HOSTS=['minimax.cn','minimax.chat','minimax.io','minimaxi.com'];

const fail=(code,message,failure)=>new ComicImageError(code,message,failure);
const abortError=()=>new DOMException('The operation was aborted.','AbortError');

export function buildComicImagePrompt(scenePrompt,characters=[]){
  if(typeof scenePrompt!=='string')throw fail('comic_image_prompt_rejected','Scene prompt must be a string',{kind:'request',retryable:false});
  const clean=scenePrompt.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').trim();
  if(!clean)throw fail('comic_image_prompt_rejected','Scene prompt is empty',{kind:'request',retryable:false});
  if(charCount(clean)>SCENE_CHAR_LIMIT)throw fail('comic_image_prompt_rejected','Scene prompt exceeds the illustration prompt budget; shorten the facts instead of truncating them',{kind:'request',retryable:false});
  let continuity='';
  if(!Array.isArray(characters)||characters.length>3)throw fail('comic_image_prompt_rejected','Invalid drawing characters',{kind:'request',retryable:false});
  if(characters.length)continuity=' Character continuity: '+characters.map((c,i)=>{
    if(typeof c.appearance!=='string'||typeof c.clothing!=='string'||charCount(c.appearance)>180||charCount(c.clothing)>180)throw fail('comic_image_prompt_rejected','Invalid character appearance or clothing',{kind:'request',retryable:false});
    return `Person ${i+1}: stable appearance=${c.appearance}; current moment clothing=${c.clothing}.`;
  }).join(' ')+' Keep facial design consistent. Use reference only for face/hair, never its clothing, pose or background. Current clothing above overrides old/reference clothing. Unknown details stay simple.';
  const prompt=STYLE_PREFIX+clean+continuity;
  if(charCount(prompt)>PROMPT_CHAR_LIMIT)throw fail('comic_image_prompt_rejected','Scene and character context exceed the illustration prompt budget',{kind:'request',retryable:false});
  return prompt;
}

function combineSignal(signal,timeoutMs){
  const timeout=AbortSignal.timeout(timeoutMs);
  if(!signal)return timeout;
  if(signal.aborted)throw abortError();
  return AbortSignal.any([signal,timeout]);
}

async function readCappedBody(response,capBytes,signal,onOverflow){
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader();
  const onAbort=()=>reader.cancel().catch(()=>{});
  signal?.addEventListener('abort',onAbort,{once:true});
  const chunks=[];let length=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>capBytes)onOverflow();
      chunks.push(value);
    }
  }finally{signal?.removeEventListener('abort',onAbort);}
  return Buffer.concat(chunks);
}

function businessCodeFrom(buffer){
  try{
    const code=String(JSON.parse(buffer.toString('utf8'))?.base_resp?.status_code??'');
    return /^\d{1,8}$/.test(code)?code:undefined;
  }catch{return undefined;}
}

function retryAfterMs(response){
  const text=response.headers.get('retry-after');if(!text||text.length>128)return undefined;
  const ms=/^\d+$/.test(text)?Number(text)*1000:Date.parse(text)-Date.now();
  return Number.isFinite(ms)&&ms>=0?Math.ceil(ms):undefined;
}

function sniffImage(bytes){
  if(bytes.length>=26&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47&&bytes[4]===0x0d&&bytes[5]===0x0a&&bytes[6]===0x1a&&bytes[7]===0x0a)
    return {mimeType:'image/png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  if(bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff){
    let offset=2;
    while(offset+9<=bytes.length){
      if(bytes[offset]!==0xff){offset++;continue;}
      const marker=bytes[offset+1];
      if(marker>=0xc0&&marker<=0xcf&&marker!==0xc4&&marker!==0xc8&&marker!==0xcc)
        return {mimeType:'image/jpeg',height:bytes.readUInt16BE(offset+5),width:bytes.readUInt16BE(offset+7)};
      if(marker===0xd8||marker===0x01){offset+=2;continue;}
      const length=bytes.readUInt16BE(offset+2);
      if(length<2)break;
      offset+=2+length;
    }
  }
  return null;
}

function verifyImage(bytes){
  if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw fail('comic_image_payload','Illustration bytes are empty or exceed the size cap',{kind:'unknown',retryable:false});
  const info=sniffImage(bytes);
  if(!info)throw fail('comic_image_payload','Illustration is not a PNG or JPEG image',{kind:'unknown',retryable:false});
  if(info.width>MAX_DIMENSION||info.height>MAX_DIMENSION)throw fail('comic_image_payload','Illustration dimensions exceed the 2048px cap',{kind:'unknown',retryable:false});
  return info.mimeType;
}

function decodeBase64Image(value){
  if(typeof value!=='string')throw fail('comic_image_payload','Illustration payload is missing',{kind:'unknown',retryable:false});
  const compact=value.replace(/\s+/g,'');
  if(!compact||compact.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(compact))throw fail('comic_image_payload','Illustration payload is not valid base64',{kind:'unknown',retryable:false});
  return Buffer.from(compact,'base64');
}

function assertAllowedImageUrl(raw){
  let url;
  try{url=new URL(raw);}catch{throw fail('comic_image_url_forbidden','Illustration URL is not a documented MiniMax CDN address',{kind:'request',retryable:false});}
  const host=url.hostname.toLowerCase();
  const allowed=url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')
    &&ALLOWED_IMAGE_HOSTS.some(domain=>host===domain||host.endsWith('.'+domain));
  if(!allowed)throw fail('comic_image_url_forbidden','Illustration URL is not a documented MiniMax CDN address',{kind:'request',retryable:false});
  return url.href;
}

/** Explicit MiniMax text-to-image transport; no retries, no credential discovery, no URL persistence. */
export function createComicImageProvider(config={}){
  const provider=config.provider??'minimax';
  if(provider!=='minimax')throw new Error('Unsupported comic image provider');
  const baseUrl=config.baseUrl??'https://api.minimax.cn/v1';
  let endpoint;
  try{endpoint=new URL(baseUrl);}catch{throw new Error('Comic image base URL is invalid');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Comic image base URL is invalid');
  const model=config.model??'image-01';
  if(typeof model!=='string'||!model.trim())throw new Error('Comic image model is invalid');
  const apiKey=config.apiKey;
  if(apiKey!==undefined&&(typeof apiKey!=='string'||!apiKey.trim()))throw new Error('Comic image API key is invalid');
  const fetchFn=config.fetch??globalThis.fetch;
  if(typeof fetchFn!=='function')throw new Error('Comic image provider requires a fetch implementation');
  const timeoutMs=config.timeoutMs??90000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new Error('Comic image timeout is invalid');
  const url=endpoint.href.replace(/\/+$/,'')+'/image_generation';

  async function request(input,init,callerSignal){
    try{return await fetchFn(input,init);}
    catch(error){
      const failure=classifyProviderNetworkFailure(error,{aborted:callerSignal?.aborted});
      if(!failure)throw error;
      throw fail('comic_image_network','Comic image request failed',failure);
    }
  }

  async function downloadImage(rawUrl,signal,callerSignal){
    const href=assertAllowedImageUrl(rawUrl);
    const response=await request(href,{method:'GET',headers:{accept:'image/png,image/jpeg'},redirect:'error',signal},callerSignal);
    if(response.status>=300&&response.status<400)throw fail('comic_image_url_forbidden','Illustration download redirects are not followed',{kind:'request',retryable:false});
    if(!response.ok)throw fail('comic_image_provider','Comic image download failed',classifyProviderFailure({httpStatus:response.status}));
    return readCappedBody(response,MAX_IMAGE_BYTES,signal,()=>{throw fail('comic_image_response_too_large','Illustration download exceeds the size cap',{kind:'unknown',retryable:false});});
  }

  return {
    provider:'minimax',
    model,
    status(){
      return {provider:'minimax',model,baseUrl:endpoint.href.replace(/\/+$/,''),configured:typeof apiKey==='string'&&!!apiKey.trim(),timeoutMs,source:'image_generation',semanticStatus:'unverified_illustration'};
    },
    async generate({scenePrompt,encouragement,characters=[],referenceImage,signal}={}){
      if(signal?.aborted)throw abortError();
      if(encouragement!==undefined&&typeof encouragement!=='string')throw fail('comic_image_prompt_rejected','Encouragement must be a string; it is overlaid by the host and never drawn into the image',{kind:'request',retryable:false});
      if(typeof apiKey!=='string'||!apiKey.trim())throw fail('comic_image_not_configured','Comic image provider has no API key',{kind:'authentication',retryable:false});
      const prompt=buildComicImagePrompt(scenePrompt,characters);
      let subject_reference;
      if(referenceImage){
        if(characters.length!==1)throw fail('comic_image_prompt_rejected','Reference requires a single grounded character',{kind:'request',retryable:false});
        const bytes=referenceImage.bytes;
        if(!Buffer.isBuffer(bytes)||verifyImage(bytes)!==referenceImage.mimeType)throw fail('comic_image_payload','Invalid character reference image',{kind:'request',retryable:false});
        subject_reference=[{type:'character',image_file:`data:${referenceImage.mimeType};base64,${bytes.toString('base64')}`}];
      }
      const combined=combineSignal(signal,timeoutMs);
      const response=await request(url,{
        method:'POST',
        headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json',accept:'application/json'},
        body:JSON.stringify({model,prompt,aspect_ratio:'1:1',n:1,response_format:'base64',prompt_optimizer:false,...(subject_reference?{subject_reference}:{})}),
        signal:combined,
      },signal);
      const body=await readCappedBody(response,MAX_BODY_BYTES,combined,()=>{throw fail('comic_image_response_too_large','Comic image response exceeds the size cap',{kind:'unknown',retryable:false});});
      if(!response.ok)throw fail('comic_image_provider','Comic image request was rejected',classifyProviderFailure({httpStatus:response.status,businessCode:businessCodeFrom(body),retryAfterMs:retryAfterMs(response)}));
      let payload;
      try{payload=JSON.parse(body.toString('utf8'));}catch{throw fail('comic_image_payload','Comic image response is not JSON',{kind:'unknown',retryable:false});}
      const businessCode=String(payload?.base_resp?.status_code??'');
      if(businessCode!=='0')throw fail('comic_image_provider','Comic image generation failed',classifyProviderFailure({httpStatus:200,businessCode}));
      const data=payload?.data??{};
      let bytes;
      const base64=[data.image_base64,...Array.isArray(data.images)?data.images.map(image=>image?.base64):[]].flat().find(entry=>typeof entry==='string'&&entry.trim());
      if(base64)bytes=decodeBase64Image(base64);
      else{
        const imageUrl=[data.image_urls,...Array.isArray(data.images)?data.images.map(image=>image?.url):[]].flat().find(entry=>typeof entry==='string'&&entry.trim());
        if(!imageUrl)throw fail('comic_image_payload','Comic image response carries no illustration',{kind:'unknown',retryable:false});
        // CDN URLs expire within 24h; only the verified local bytes are ever returned, never the URL.
        bytes=await downloadImage(imageUrl,combined,signal);
      }
      const mimeType=verifyImage(bytes);
      return {bytes,mimeType,provider:'minimax',model,source:'image_generation',semanticStatus:'unverified_illustration'};
    },
  };
}
