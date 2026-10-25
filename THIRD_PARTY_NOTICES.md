# 第三方来源

本应用使用原生 Pi Agent Core 与 Pi AI 1.4.0、TypeBox 1.3.27；这三项已安装包的许可为 MIT。Node 依赖版本由 `apps/companion-sim/package-lock.json` 固定，安装时保留依赖随附的原始许可文件。

WatcherRobot Python SDK 的官方仓库为 <https://github.com/orulink-ai/WatcheRobot_python_sdk>，许可为 Apache-2.0。本发布目录调用 SDK，不复制 SDK 实现。

视频依赖通过 `config/integration/companion-webrtc.requirements.txt` 安装，分别遵循其随附许可；本目录不附带这些库的二进制或源码副本。

人物位置检测模型的公开来源与校验信息见 `config/integration/companion-sight-model.json`，原许可见同目录 `companion-sight-LICENSE.txt`。首次安装时由脚本下载并核验，不附带人物照片或身份向量。

中文显示使用运行者 Mac 的系统字体，不在工程包中分发字体。图标由本工程以 SVG 绘制。AI 服务及生成漫画遵循所用服务的账户条款；此包没有随附任何私人生成图片。

Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd. This attribution applies to original project code; third-party components retain their respective copyrights and licenses. Original project code is licensed under the Apache License, Version 2.0; see LICENSE.
