# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Only supervises this application's own Node process; no takeover or pairing."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

MANAGED_ENV = ('WATCHER_APP_ID', 'WATCHER_APP_RUN_CREDENTIAL',
               'WATCHER_APP_DESKTOP_WS_URL', 'WATCHER_APP_DEVICE_WS_URL')
MODEL_FIELDS = {
    'provider': 'COMPANION_MODEL_PROVIDER', 'model': 'COMPANION_MODEL_ID',
    'baseUrl': 'COMPANION_MODEL_BASE_URL', 'apiKey': 'COMPANION_MODEL_API_KEY',
}


class UserError(RuntimeError):
    pass


def data_directory(environment):
    return Path(environment.get('COMPANION_DATA_DIR') or
                Path.home() / 'Library/Application Support/WatcherRobot/desktop-companion').expanduser().resolve()


def model_environment(data, base, *, require_configured=True):
    env = dict(base)
    config = Path(data) / 'settings.json'
    if config.exists():
        if config.is_symlink() or config.stat().st_size > 16000:
            raise UserError('请重新配置桌面伙伴的模型服务。')
        try:
            settings = json.loads(config.read_text())
            if not isinstance(settings, dict) or set(settings) - (set(MODEL_FIELDS) | {'revision', 'authentication'}):
                raise ValueError()
            for field, key in MODEL_FIELDS.items():
                if field in settings:
                    if not isinstance(settings[field], str) or not settings[field].strip():
                        raise ValueError()
                    env.setdefault(key, settings[field])
            if settings.get('authentication', 'api-key') != 'api-key':
                raise ValueError()
        except (ValueError, OSError, TypeError):
            raise UserError('模型配置无法读取，请运行 python prepare.py --configure。') from None
    for key in ('COMPANION_MODEL_API_KEY', 'COMPANION_MODEL_ID', 'COMPANION_MODEL_BASE_URL'):
        if require_configured and not env.get(key):
            raise UserError('请先运行 python prepare.py --configure，设置模型服务。')
    env.setdefault('COMPANION_MODEL_PROVIDER', 'minimax')
    return env


def build_environment(package, data, base, python):
    if not all(base.get(key) for key in MANAGED_ENV):
        raise UserError('请通过 watcherobot app run 启动桌面伙伴。')
    env = model_environment(data, base, require_configured=False)
    env.update(COMPANION_DEVICE_PYTHON=str(python), COMPANION_DATA_DIR=str(data),
               COMPANION_MODEL_MODE='cloud', PYTHONDONTWRITEBYTECODE='1')
    return env


def find_node(data, environment):
    saved = None
    config = Path(data) / 'runtime.json'
    if config.exists():
        try:
            if config.is_symlink() or config.stat().st_size > 8000:
                raise ValueError()
            runtime = json.loads(config.read_text())
            if not isinstance(runtime, dict) or set(runtime) != {'node'} or not isinstance(runtime['node'], str):
                raise ValueError()
            saved = runtime['node']
        except (ValueError, OSError, TypeError):
            raise UserError('运行环境无法读取，请重新运行 python prepare.py。') from None
    for candidate in (environment.get('COMPANION_NODE_PATH'), saved, shutil.which('node', path=environment.get('PATH', ''))):
        if not candidate:
            continue
        path = Path(candidate)
        if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
            continue
        try:
            version = subprocess.check_output([str(path), '-p', 'process.versions.node'], text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
            if tuple(map(int, version.split('.')[:2])) >= (22, 19):
                return str(path.resolve())
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    raise UserError('请安装 Node 24，并重新运行 python prepare.py。')


def supervise(command, environment, cwd, shutdown_file):
    if shutdown_file and Path(shutdown_file).exists():
        return 0
    stopped = False
    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True
    previous = {s: signal.signal(s, stop) for s in (signal.SIGINT, signal.SIGTERM)}
    child = None
    try:
        child = subprocess.Popen(command, cwd=cwd, env=environment, start_new_session=True)
        while child.poll() is None:
            if stopped or shutdown_file and Path(shutdown_file).exists():
                stopped = True
                break
            time.sleep(.1)
        return 0 if stopped else child.returncode
    finally:
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            # The group belongs only to this launch. Clean up descendants even
            # when Node exits first; never signal another application's group.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main():
    package = Path(__file__).resolve().parent
    try:
        if sys.platform != 'darwin':
            raise UserError('当前桌面伙伴发布版支持 Mac。')
        env = build_environment(package, data_directory(os.environ), os.environ, sys.executable)
        node = find_node(Path(env['COMPANION_DATA_DIR']), os.environ)
        if not (package / 'apps/companion-sim/node_modules/@earendil-works/pi-agent-core/package.json').is_file() or not (package / '.runtime/companion-webrtc-venv/bin/python').is_file():
            raise UserError('首次使用请先在作品目录运行 python prepare.py。')
        data = Path(env['COMPANION_DATA_DIR'])
        data.mkdir(parents=True, exist_ok=True, mode=0o700)
        print('桌面伙伴正在启动。请打开 http://127.0.0.1:8794/ 开始陪伴。', flush=True)
        return supervise([node, str(package / 'host.mjs')], env, package,
                         env.get('WATCHER_APP_SHUTDOWN_SIGNAL'))
    except UserError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print('桌面伙伴未启动，请查看安装说明；没有输出账号信息。', file=sys.stderr)
        return 1
