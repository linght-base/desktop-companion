// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const messages={model_settings_conflict:'设置已在别处更新，请点“重新读取”后再保存。',model_settings_busy:'正在结束上一轮，请稍等再保存。',model_key_required:'请填写 API Key。',model_key_required_for_new_address:'服务地址变了，请重新填写这个服务的 API Key。',invalid_model_url:'请填写服务提供的有效地址。',invalid_model_authentication:'请选择需要 API Key 的服务。',invalid_model_name:'请填写模型名称。',invalid_model_key:'API Key 格式不正确，请重新填写。',model_settings_write_failed:'设置未能保存在本机，请检查后重试。'};

export function mountModelSettings({request,onSaved=()=>{}}){
  const panel=document.getElementById('model-settings');if(!panel)return {load:async()=>{}};
  const form=panel.querySelector('form'),field=name=>form.elements.namedItem(name);
  const status=panel.querySelector('[data-model-status]'),summary=panel.querySelector('[data-model-summary]');
  const key=field('apiKey');let current=null,busy=false;
  function render(value){
    current=value;
    for(const name of ['provider','baseUrl','model'])field(name).value=value[name]??'';
    key.value='';key.type='password';
    key.placeholder=value.hasApiKey?'已设置；留空保持，填写新值可替换':'填写这个服务的 API Key';
    panel.querySelector('[data-show-key]').textContent='显示输入';
    summary.textContent=value.configured?`已设置 · ${value.model}`:'首次使用请先设置';
    status.textContent=value.loadError?'原有设置未能完整读取，请核对后重新保存。':value.configured?`${value.hasApiKey?'Key 已设置，密钥不回传。':'请填写 API Key。'}${value.persisted?'设置已保存在本机。':'当前使用运行环境的配置。'}尚未在这里验证连接。`:'设置服务地址、模型和 Key 后再开始陪伴。';
  }
  async function load(){
    if(busy)return;
    try{const value=await request('/api/model/settings');render(value);panel.open=true;}
    catch{summary.textContent='设置暂未就绪';status.textContent='暂时无法读取设置，请刷新页面后重试。';}
  }
  field('provider').addEventListener('change',()=>{
    if(field('provider').value==='minimax'){
      field('baseUrl').value='https://api.minimax.cn/v1';field('model').value='MiniMax-M3.1-Flash-Preview';
    }else{
      field('baseUrl').value='';field('model').value='';
    }
    key.value='';
  });
  panel.querySelector('[data-show-key]').addEventListener('click',event=>{
    key.type=key.type==='password'?'text':'password';event.target.textContent=key.type==='password'?'显示输入':'隐藏输入';
  });
  panel.querySelector('[data-refresh-model]').addEventListener('click',load);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!current)return;
    busy=true;const submit=panel.querySelector('[type=submit]');submit.disabled=true;status.textContent='正在保存并暂停陪伴…';
    try{
      const value=await request('/api/model/settings',{method:'POST',body:{revision:current.revision,provider:field('provider').value,baseUrl:field('baseUrl').value.trim(),model:field('model').value.trim(),authentication:'api-key',apiKey:key.value}});
      render(value);panel.open=true;status.textContent='已保存并生效，陪伴已暂停。重新开始后使用这份设置；尚未验证服务连接。';onSaved(value);
    }catch(error){status.textContent=messages[error.message]??'设置未保存，请检查后重试。';}
    finally{busy=false;submit.disabled=false;}
  });
  return {load};
}
