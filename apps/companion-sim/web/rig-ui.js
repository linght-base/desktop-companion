// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
export function mountRigControls({request,onState,stopLocalInput,showError,canPreview=()=>true}) {
  const $=id=>document.getElementById(id),buttons=[...document.querySelectorAll('[data-camera-yaw], [data-camera-pitch]')];
  let state,pending=null,desired=null,draining=false,generation=0,expectedEpoch=null;
  function cancel(){generation++;pending=null;desired=null;expectedEpoch=null;for(const button of buttons)button.disabled=true;}
  $('rig-profile').addEventListener('change',async()=>{
    cancel();stopLocalInput();
    try{await request('/api/rig',{method:'POST',body:{profile:$('rig-profile').value}});onState(await request('/api/state'));}catch(error){showError(error);}
  });
  async function drain(){
    if(draining)return;
    draining=true;const run=generation;
    try{
      while(pending&&run===generation){
        const pose=pending;pending=null;
        try{
          const result=await request('/api/rig/preview',{method:'POST',body:{...pose,durationMs:3000,epoch:expectedEpoch}});
          if(run!==generation)return;
          if(result.receipt.status!=='accepted'||result.state.epoch<state.epoch){pending=null;desired=null;$('camera-receipt').textContent='这次试转未执行，请重新点击。';return;}
          expectedEpoch=result.state.epoch;
          onState(result.state);
          $('camera-receipt').textContent=result.receipt.status==='accepted'?`已提交：水平 ${pose.yaw}° / 俯仰 ${pose.pitch}°，${state.rig.profile==='integrated-device'?'设备执行见回执':'3秒后归中'}`:'这次试转未执行，请重新点击。';
        }catch(error){if(run===generation){pending=null;showError(error);}}
      }
    }finally{draining=false;if(run===generation){desired=null;expectedEpoch=null;}if(pending)drain();}
  }
  for(const button of buttons)button.addEventListener('click',()=>{
    if(!state||!canPreview()||!['integrated-sim','integrated-device'].includes(state.rig?.profile))return;
    if(!desired)expectedEpoch=state.epoch;
    const pose={...(desired??state.rig.camera.pose)};
    if(button.id==='camera-center'){pose.yaw=0;pose.pitch=0;}
    else{
      if(button.dataset.cameraYaw!==undefined)pose.yaw=Number(button.dataset.cameraYaw);
      if(button.dataset.cameraPitch!==undefined)pose.pitch=Number(button.dataset.cameraPitch);
    }
    desired={yaw:pose.yaw,pitch:pose.pitch};pending={...desired};stopLocalInput();drain();
  });
  return {cancel,render(next){
    state=next;if(!next.rig)return;
    const {camera,presentation,profile}=next.rig;
    $('rig-profile').value=profile;
    $('rig-motion').textContent=({unsupported:'不支持相机运动',simulated:'仅仿真云台',driver:'已配置物理驱动',hardware:'官方SDK真机'})[camera.motion];
    $('rig-description').textContent=profile==='integrated-device'?'真实SDK云台与圆屏；显示的是头姿目标，不是编码器回传。手动试转会暂停陪伴并停止分享；到期停止，归中请点归中。':presentation.headControlsCamera?'一体仿真：云台、头部、圆屏与虚拟镜头共用同一姿态。可以直接手动试转，无需开启摄像头或模型；试转会暂停陪伴，3秒后归中。仿真转动不改变电脑摄像头机位。':profile==='pocket-uvc-pet'?'Pocket型号支持UVC时可选择对应摄像头；PC云台控制尚未接通。下方L-PET是独立展示适配预览。':camera.motion==='driver'?'运动经独立驱动执行，姿态以实际回执为准；原生L-PET桥尚未接入。':'摄像头、运动与展示独立声明能力。模拟姿态不会改变真实镜头，L-PET展示仅消费表达流。';
    $('gimbal-diagram').hidden=!camera.capabilities.panTilt;
    $('gimbal-yaw').style.transform=`rotate(${-camera.pose.yaw}deg)`;
    $('gimbal-pitch').style.transform=`rotate(${-camera.pose.pitch}deg)`;
    $('joint-description').textContent=camera.pose.source==='reported'?'独立云台 · 驱动回报姿态':presentation.headControlsCamera?'一体关节 · 头部与虚拟镜头同步 · 目标姿态，非真机回传':'独立云台 · 不带动 L-PET · 目标姿态，非真机回传';
    $('camera-pose').textContent=`相机 yaw ${camera.pose.yaw}° / pitch ${camera.pose.pitch}° · ${camera.pose.source}`;
    for(const button of buttons)button.disabled=!['integrated-sim','integrated-device'].includes(profile)||!camera.capabilities.panTilt||!canPreview();
    const pet=presentation.kind==='lpet';$('pet-preview').hidden=!pet;$('robot-stage').hidden=pet;
  }};
}
