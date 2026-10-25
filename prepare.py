# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Explicit first-use installation and private configuration. Never runs on import."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from launcher import data_directory, find_node, model_environment, UserError


def write_private_file(data, filename, settings):
    data = Path(data)
    if data.is_symlink():
        raise UserError('配置目录不能是快捷链接。')
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = data / filename
    if target.is_symlink():
        raise UserError('配置文件不能是快捷链接。')
    fd, temporary = tempfile.mkstemp(prefix='settings-', dir=data)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump(settings, file, ensure_ascii=False)
            file.write('\n')
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def write_settings(data, settings):
    write_private_file(data, 'settings.json', settings)


def configure(data):
    if not sys.stdin.isatty():
        raise UserError('请在自己的终端运行 python prepare.py --configure。')
    base = input('AI服务地址 [https://api.minimax.cn/v1]：').strip() or 'https://api.minimax.cn/v1'
    model = input('模型名 [MiniMax-M3.1-Flash-Preview]：').strip() or 'MiniMax-M3.1-Flash-Preview'
    key = getpass.getpass('服务密钥（输入不显示）：').strip()
    if not key:
        raise UserError('没有输入密钥，未保存设置。')
    from urllib.parse import urlsplit
    parsed = urlsplit(base)
    if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise UserError('服务地址格式不正确，未保存设置。')
    # This interactive route is deliberately the verified MiniMax route only.
    # Other compatible routes may be supplied through explicit process env.
    write_settings(data, {'provider': 'minimax', 'baseUrl': base, 'model': model, 'apiKey': key})
    print('设置已保存在你的电脑上。可以从 WatcherRobot 启动桌面伙伴了。')


def check(package, data):
    try:
        find_node(data, os.environ)
        node_ready = True
    except UserError:
        node_ready = False
    try:
        model_environment(data, os.environ)
        configured = True
    except UserError:
        configured = False
    try:
        manifest = json.loads((package / 'config/integration/companion-sight-model.json').read_text())
        model = (package / '.runtime/companion-sim/models/face_detection_yunet_2023mar.onnx').read_bytes()
        sight_ready = len(model) == manifest['bytes'] and hashlib.sha256(model).hexdigest() == manifest['sha256']
    except (OSError, ValueError, KeyError, TypeError):
        sight_ready = False
    checks = {
        'Node已安装': node_ready,
        '作品依赖已安装': (package / 'apps/companion-sim/node_modules/@earendil-works/pi-agent-core/package.json').is_file(),
        '视频环境已准备': (package / '.runtime/companion-webrtc-venv/bin/python').is_file(),
        '人物位置模型已准备': sight_ready,
        'AI服务已设置': configured,
    }
    for label, ready in checks.items():
        print(('已准备 · ' if ready else '待准备 · ') + label)
    print('此检查不连接机器人，不调用AI，也不代表真机已经验收。')
    return 0 if all(checks.values()) else 1


def install(package, data):
    if sys.platform != 'darwin':
        raise UserError('当前版本请使用 Mac。')
    node = find_node(data, os.environ)
    npm = str(Path(node).parent / 'npm') if (Path(node).parent / 'npm').is_file() else shutil.which('npm')
    if not npm:
        raise UserError('请先安装 Node 24，再重新执行。')
    version = subprocess.check_output([node, '-p', 'process.versions.node'], text=True).strip()
    if tuple(map(int, version.split('.')[:2])) < (22, 19):
        raise UserError('Node版本过低，请安装Node 24。')
    env = dict(os.environ)
    for key in ('COMPANION_MODEL_API_KEY', 'COMPANION_IMAGE_API_KEY', 'WATCHER_APP_RUN_CREDENTIAL'):
        env.pop(key, None)
    subprocess.run([npm, '--prefix', str(package / 'apps/companion-sim'), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], env=env, check=True)
    video = package / '.runtime/companion-webrtc-venv'
    subprocess.run([sys.executable, '-m', 'venv', str(video)], env=env, check=True)
    python = str(video / 'bin/python')
    subprocess.run([python, '-m', 'pip', 'install', '-r', str(package / 'config/integration/companion-webrtc.requirements.txt')], env=env, check=True)
    subprocess.run([python, str(package / 'scripts/setup-companion-sight.py')], env=env, check=True)
    write_private_file(data, 'runtime.json', {'node': node})
    print('安装完成。从 WatcherRobot 启动作品，在网页“初始化设置”中填写AI服务；也可运行 python prepare.py --configure。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--configure', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    package, data = Path(__file__).resolve().parent, data_directory(os.environ)
    try:
        if args.configure:
            configure(data)
        elif args.check:
            return check(package, data)
        else:
            install(package, data)
        return 0
    except (UserError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, UserError) else '准备未完成，请按安装说明检查依赖。没有输出账号信息。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
