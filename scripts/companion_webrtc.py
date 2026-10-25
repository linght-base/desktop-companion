#!/usr/bin/env python3
# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Local, video-only aiortc receiver. JSON IPC only; no HTTP listener or media files.

After the offer line, stdin carries bounded JSONL control messages. The only
accepted message is {"type":"presence_detection","enabled":<bool>}, toggling the
local face detector; anything else gets a fixed error and stops the receiver.
Raw input is never logged.
"""
import asyncio
import base64
import io
import json
from pathlib import Path
import signal
import sys

MAX_INPUT = 140000
MAX_OUTPUT_BUFFER = 512000


def parse_control(line):
    """Strict bounded control parse. Returns the validated message or None."""
    try:
        value = json.loads(line)
    except Exception:
        return None
    if not isinstance(value, dict) or set(value.keys()) != {'type', 'enabled'}:
        return None
    if value['type'] != 'presence_detection' or not isinstance(value['enabled'], bool):
        return None
    return value


async def receive(offer, output, reader):
    # Import after startup so a missing optional runtime becomes an explicit capability error.
    try:
        from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
        from aiortc.mediastreams import MediaStreamError
        from PIL import Image
    except ImportError:
        output({'type': 'error', 'reason': 'webrtc_runtime_unavailable'})
        return

    try:
        from companion_sight import LocalSight
        sight = LocalSight(Path(__file__).resolve().parent.parent / '.runtime/companion-sim/models/face_detection_yunet_2023mar.onnx')
    except Exception:
        sight = None

    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    stopped = asyncio.Event()
    tasks = set()
    counters = {'receivedFrames': 0, 'decodedFrames': 0, 'droppedFrames': 0}
    # Host-controlled local detection toggle. Only control messages change this;
    # the receiver never re-enables detection on its own.
    detection = {'enabled': True}
    latest = asyncio.Queue(maxsize=1)
    gaps = []
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)

    def start_task(coro):
        task = asyncio.create_task(coro)
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    def error(reason):
        output({'type': 'error', 'reason': reason})
        stopped.set()

    async def read_track(track):
        last_pts = None
        try:
            while not stopped.is_set():
                frame = await asyncio.wait_for(track.recv(), 5)
                counters['receivedFrames'] += 1
                counters['decodedFrames'] += 1
                if counters['decodedFrames'] > 1_000_000_000:
                    error('video_receiver_overflow')
                    return
                if frame.width > offer['width'] or frame.height > offer['height']:
                    error('invalid_video_dimensions')
                    return
                if frame.pts is None or frame.time_base is None:
                    error('video_receiver_failed')
                    return
                pts = float(frame.pts * frame.time_base) * 1000
                if last_pts is not None and pts - last_pts > max(1000, 3000 / offer['frameRate']):
                    gaps.append({'startPtsMs': last_pts, 'endPtsMs': pts})
                    del gaps[:-16]
                last_pts = pts
                if latest.full():
                    latest.get_nowait()
                    counters['droppedFrames'] += 1
                latest.put_nowait((frame, pts))
        except asyncio.TimeoutError:
            error('video_track_stalled')
        except MediaStreamError:
            error('video_track_ended')
        except asyncio.CancelledError:
            pass
        except Exception:
            error('video_receiver_failed')

    def jpeg(frame, pts):
        image = frame.to_image().convert('RGB')
        signature = base64.b64encode(image.resize((32, 24), Image.Resampling.BOX).tobytes()).decode('ascii')
        data = io.BytesIO()
        image.save(data, format='JPEG', quality=75)
        # Detection disabled: encode the preview but omit sight entirely, never
        # emitting empty targets as if a detection ran.
        if not detection['enabled']:
            return base64.b64encode(data.getvalue()).decode('ascii'), signature, None
        positions = sight.analyze(image, pts) if sight else {'status':'unavailable','detector':'yunet-2023mar','targets':[],'processingMs':0}
        return base64.b64encode(data.getvalue()).decode('ascii'), signature, positions

    async def sample_track():
        next_output = 0
        try:
            while not stopped.is_set():
                frame, pts = await latest.get()
                now = loop.time()
                if now < next_output:
                    # Sampling never stops the receive loop or queues a full video history.
                    continue
                next_output = now + 1 / min(8, offer['frameRate'])
                data, signature, positions = await asyncio.to_thread(jpeg, frame, pts)
                if len(data) > 400000:
                    error('video_receiver_overflow')
                    return
                frame_gaps = [gap for gap in gaps if gap['endPtsMs'] <= pts]
                message = {'type': 'frame', 'ptsMs': pts, 'width': frame.width, 'height': frame.height, 'data': data, 'visualSignature': signature, **counters, 'gaps': frame_gaps}
                if positions is not None:
                    message['sight'] = positions
                emitted = output(message)
                if emitted:
                    gaps[:] = [gap for gap in gaps if gap['endPtsMs'] > pts]
                else:
                    counters['droppedFrames'] += 1
        except asyncio.CancelledError:
            pass
        except Exception:
            error('video_receiver_failed')

    @pc.on('track')
    def on_track(track):
        if track.kind != 'video' or tasks:
            error('invalid_video_offer')
            return
        start_task(read_track(track))
        start_task(sample_track())

    @pc.on('connectionstatechange')
    async def on_connectionstatechange():
        if pc.connectionState == 'failed':
            error('video_peer_failed')
        elif pc.connectionState == 'closed':
            stopped.set()

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer['sdp'], type='offer'))
        for transceiver in pc.getTransceivers():
            transceiver.direction = 'recvonly'
        await pc.setLocalDescription(await pc.createAnswer())
        output({'type': 'answer', 'sdp': pc.localDescription.sdp})

        async def watch_parent():
            # Post-offer stdin is a bounded JSONL control channel. EOF means the
            # parent closed stdin or exited; anything but the strict
            # presence_detection schema is a fixed error and stops the receiver.
            while not stopped.is_set():
                try:
                    line = await reader.readline()
                except Exception:
                    error('invalid_control_message')
                    return
                if not line:
                    stopped.set()
                    return
                if len(line) > MAX_INPUT:
                    error('invalid_control_message')
                    return
                control = parse_control(line)
                if control is None:
                    error('invalid_control_message')
                    return
                detection['enabled'] = control['enabled']

        start_task(watch_parent())
        await stopped.wait()
    except Exception:
        error('invalid_video_offer')
    finally:
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*list(tasks), return_exceptions=True)
        await pc.close()


async def main():
    loop = asyncio.get_running_loop()
    # Nonblocking bounded output prevents a slow Node consumer from backing up decoded video.
    transport, _ = await loop.connect_write_pipe(asyncio.Protocol, sys.stdout.buffer)

    def output(value):
        if transport.is_closing() or transport.get_write_buffer_size() > MAX_OUTPUT_BUFFER:
            return False
        encoded = (json.dumps(value, separators=(',', ':')) + '\n').encode()
        if len(encoded) > 450000:
            return False
        transport.write(encoded)
        return True

    reader = asyncio.StreamReader(limit=MAX_INPUT)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    try:
        line = await asyncio.wait_for(reader.readline(), 5)
        if len(line) > MAX_INPUT:
            raise ValueError('offer too large')
        offer = json.loads(line)
        if offer.get('type') != 'offer' or not isinstance(offer.get('sdp'), str):
            raise ValueError('offer required')
        await receive(offer, output, reader)
    except Exception:
        output({'type': 'error', 'reason': 'invalid_video_offer'})
    finally:
        # Give small terminal state messages one event-loop turn to reach the parent.
        await asyncio.sleep(0)
        transport.close()


if __name__ == '__main__':
    asyncio.run(main())
