#!/usr/bin/env python3
# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Explicit optional model setup; runtime never downloads weights or personal images."""
import hashlib
import json
from pathlib import Path
import urllib.request


def main():
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / 'config/integration/companion-sight-model.json').read_text())
    target = root / manifest['runtimePath']
    data = target.read_bytes() if target.exists() else urllib.request.urlopen(manifest['url'], timeout=60).read(manifest['bytes'] + 1)
    if len(data) != manifest['bytes'] or hashlib.sha256(data).hexdigest() != manifest['sha256']:
        raise SystemExit('Model verification failed')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    target.chmod(0o600)
    print('Verified optional YuNet model; images and embeddings are not downloaded or stored.')


if __name__ == '__main__':
    main()
