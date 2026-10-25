// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {mkdirSync,openSync,closeSync,readFileSync,writeFileSync,fsyncSync,renameSync,unlinkSync,lstatSync,existsSync,constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';

const fail=(code,status=400)=>Object.assign(new Error(code),{status});
const fields=new Set(['revision','provider','baseUrl','model','authentication','apiKey']);
const localHost=host=>{
  host=host.replace(/^\[|\]$/g,'');
  if(host==='localhost'||host==='::1')return true;
  if(isIP(host)!==4)return false;
  const [a,b]=host.split('.').map(Number);
  return a===127||a===10||a===192&&b===168||a===172&&b>=16&&b<=31;
};
function normalize(value){
  if(!['minimax','openai-compatible'].includes(value.provider))throw fail('invalid_model_settings');
  if(typeof value.baseUrl!=='string'||value.baseUrl.length>2048)throw fail('invalid_model_url');
  let url;try{url=new URL(value.baseUrl);}catch{throw fail('invalid_model_url');}
  if(url.href.length>4096||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.protocol==='http:'&&!localHost(url.hostname))throw fail('invalid_model_url');
  if(typeof value.model!=='string'||!value.model.trim()||value.model.length>200||/[\x00-\x1f\x7f]/.test(value.model))throw fail('invalid_model_name');
  const authentication=value.authentication??'api-key';
  if(authentication!=='api-key')throw fail('invalid_model_authentication');
  const apiKey=value.apiKey??'';
  if(typeof apiKey!=='string'||Buffer.byteLength(apiKey)>8192||/[\x00-\x1f\x7f]/.test(apiKey))throw fail('invalid_model_key');
  return {provider:value.provider,baseUrl:url.href.replace(/\/$/,''),model:value.model.trim(),authentication,apiKey:apiKey.trim()};
}

/** Raw credentials never leave runtimeConfig; snapshot is safe for the browser. */
export function createModelSettings({path=null,initial={},environment=process.env}={}){
  const hasRoute=initial.baseUrl||environment.COMPANION_MODEL_BASE_URL;
  let value={provider:initial.provider??environment.COMPANION_MODEL_PROVIDER??(hasRoute?'openai-compatible':'minimax'),baseUrl:initial.baseUrl??environment.COMPANION_MODEL_BASE_URL??'https://api.minimax.cn/v1',model:initial.model??initial.modelId??environment.COMPANION_MODEL_ID??'MiniMax-M3.1-Flash-Preview',apiKey:initial.apiKey??environment.COMPANION_MODEL_API_KEY??'',authentication:environment.COMPANION_MODEL_AUTHENTICATION??'api-key'};
  let revision=0,source='environment',loadError=false;
  try{value=normalize(value);}catch{value=normalize({provider:'minimax',baseUrl:'https://api.minimax.cn/v1',model:'MiniMax-M3.1-Flash-Preview'});loadError=true;}
  if(path&&existsSync(path)){
    let fd;
    try{
      fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      if(lstatSync(path).size>16000)throw new Error();
      const saved=JSON.parse(readFileSync(fd,'utf8'));
      if(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.keys(saved).some(key=>!fields.has(key)))throw new Error();
      value=normalize(saved);revision=Number.isSafeInteger(saved.revision)&&saved.revision>=0?saved.revision:0;source='saved';
    }catch{loadError=true;}finally{if(fd!==undefined)closeSync(fd);}
  }
  const configured=next=>Boolean(next.apiKey);
  const snapshot=()=>({revision,provider:value.provider,baseUrl:value.baseUrl,model:value.model,authentication:value.authentication,configured:configured(value),hasApiKey:Boolean(value.apiKey),keyHint:value.apiKey?'已设置，密钥不回传':'未设置',source:configured(value)?source:'unset',persisted:source==='saved',loadError,connectionVerified:false});
  return {
    snapshot,
    prepare(input){
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.has(k)))throw fail('invalid_model_settings');
      if(input.revision!==revision)throw fail('model_settings_conflict',409);
      const next=normalize({...input,apiKey:input.apiKey??''});
      if(next.authentication==='api-key'&&!next.apiKey){
        if(next.baseUrl!==value.baseUrl&&value.apiKey)throw fail('model_key_required_for_new_address');
        next.apiKey=value.apiKey;
      }
      if(!configured(next))throw fail('model_key_required');
      return {...next,revision:revision+1};
    },
    commit(next){
      if(next.revision!==revision+1)throw fail('model_settings_conflict',409);
      if(path){
        const parent=dirname(path),temporary=join(parent,`.model-settings-${randomUUID()}.tmp`);let fd;
        try{
          mkdirSync(parent,{recursive:true,mode:0o700});
          if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error();
          fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify(next)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
          renameSync(temporary,path);
        }catch{throw fail('model_settings_write_failed',500);}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
      }
      value=normalize(next);revision=next.revision;source=path?'saved':'session';loadError=false;
      return snapshot();
    },
    runtimeConfig(next=value){return {provider:next.provider,baseUrl:next.baseUrl,model:next.model,apiKey:next.apiKey};}
  };
}
