// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {createCloudProvider} from './provider.mjs';

export function createModelSettingsHost({store,controller,baseConfig,onApplied=()=>{}}){
  let saving=false;
  return {
    snapshot:()=>store.snapshot(),
    busy:()=>saving,
    async save(input){
      if(saving)throw Object.assign(new Error('model_settings_busy'),{status:409});
      const next=store.prepare(input),config=store.runtimeConfig(next);
      createCloudProvider({...baseConfig,...config}); // Validate locally; no service request.
      if(typeof controller.runtime.configureModel!=='function')throw Object.assign(new Error('model_settings_reload_unavailable'),{status:409});
      saving=true;
      try{
        controller.control('pause');
        const flushed=await controller.runtime.flush?.({timeoutMs:5000});
        if(flushed?.activeRunSettled===false||controller.runtime.status().running)throw Object.assign(new Error('model_settings_busy'),{status:409});
        const view=store.commit(next);
        controller.runtime.configureModel(config);
        controller.mode='cloud';controller.providerAvailability?.success();onApplied(config);controller.publish();
        return {...view,applied:true,paused:true};
      }finally{saving=false;}
    }
  };
}
