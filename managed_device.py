# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Reuse the device bridge through official injected Application channels."""
import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / 'scripts'))
import companion_device


def main():
    from watcherobot.application import ApplicationContext
    context = None
    def connect():
        nonlocal context
        context = ApplicationContext.from_environment()
        asyncio.run(context.__aenter__())
        return context, context.robot
    try:
        return companion_device.main(connect=connect, preflight=lambda: None)
    finally:
        if context is not None:
            context.close()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('managed_application_connection_failed', file=sys.stderr)
        raise SystemExit(1)
