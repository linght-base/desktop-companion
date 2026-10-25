// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSimulationServer} from './apps/companion-sim/src/server.mjs';
import {createReconnectableDeviceBridge} from './apps/companion-sim/src/reconnectable-device-bridge.mjs';
import {createDeviceOutput} from './apps/companion-sim/src/device-output.mjs';

const root=dirname(fileURLToPath(import.meta.url));
if(!process.env.COMPANION_DEVICE_PYTHON||!process.env.COMPANION_DATA_DIR||!process.env.WATCHER_APP_ID)throw new Error('managed_application_required');
let app;
const bridge=createReconnectableDeviceBridge({pythonPath:process.env.COMPANION_DEVICE_PYTHON,scriptPath:join(root,'managed_device.py'),
  onFrame:frame=>app?.videoIngress.acceptFrame(frame),onChange:()=>app?.controller.publish()});
app=createSimulationServer({mode:'cloud',experienceProfile:'competition',statePath:join(process.env.COMPANION_DATA_DIR,'companion.sqlite'),
  deviceBridge:bridge,deviceOutputFactory:createDeviceOutput,deviceHealthFetch:globalThis.fetch});
let closing=false;
const close=async()=>{if(closing)return;closing=true;await app.close();};
process.on('SIGINT',close);process.on('SIGTERM',close);
app.server.on('error',async()=>{console.error('控制页面未能启动；请确认没有其它桌面伙伴正在运行。');process.exitCode=1;await close();});
app.server.listen(8794,'127.0.0.1',()=>{
  console.log('桌面伙伴：http://127.0.0.1:8794/（到陪伴页点击启动）');
  bridge.start().then(()=>app.controller.publish()).catch(()=>{app.controller.control('pause');console.error('机器人连接未就绪；请在控制页面查看状态。');});
});
