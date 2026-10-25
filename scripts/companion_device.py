#!/usr/bin/env python3
# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""JSONL bridge between the companion host and the real Watcher device.

stdin carries one JSON command per line; stdout carries only JSONL replies,
ready event and camera frames. stderr carries fixed error tokens only.
Uses the official watcherobot SDK (DesktopRobotSession + WatcheRobot); it does
not implement any device protocol itself and never enables face tracking.
"""

from __future__ import annotations

import base64
import io
import json
import math
import re
import signal
import sys
import threading
import time
import urllib.request
from collections import deque
from typing import Any

import watcherobot
from watcherobot import JobCancelledError, JobFailedError, WatcheRobotError
from watcherobot.desktop_session import DesktopRobotSession
from watcherobot.robot import WatcheRobot

from PIL import Image
from functools import lru_cache
from pathlib import Path

WS_URL = "ws://127.0.0.1:8765"
HTTP_BASE = "http://127.0.0.1:8767"
APP_ACTIVE_STATES = {"starting", "running", "stopping"}

MAX_LINE_BYTES = 64 * 1024
SAFE_INT_MAX = 2**53 - 1
MAX_FRAME_BYTES = 300 * 1024
FRAME_MIN_INTERVAL_S = 1.0 / 8.0
HEAD_MAX_WAIT_S = 3.0
COMMAND_TIMEOUT_S = 10.0

ICONS = ("none", "question", "sparkle", "clock", "check", "water", "movement", "posture", "book")

STATUS_LABELS = {'none':'','observing':'观察','thinking':'思考','tracking':'注视','searching':'寻找','curious':'好奇','recorded':'记下','recalling':'回想','reminder':'提醒','paused':'暂停','resting':'休息','camera_off':'待启','connecting':'连接','waiting':'稍候','unavailable':'异常','manual':'手动','interrupted':'断流','cheering':'加油'}

ERROR_CODES = (
    "invalid_request",
    "unknown_op",
    "stale_generation",
    "expired",
    "device_busy",
    "capability_unavailable",
    "device_error",
    "closed",
)

# Icon strokes copied from apps/companion-sim/web/robot.js (same 412x412 canvas).
_ICON_PATHS = {
    "question": ["M194 103C194 84 222 83 222 101C222 114 207 113 207 128", "M207 143L207 144"],
    "sparkle": ["M206 76L213 96L232 103L213 110L206 130L199 110L180 103L199 96Z"],
    "clock": ["M229 108A23 23 0 1 1 183 108A23 23 0 1 1 229 108", "M206 94V109L217 114"],
    "check": ["M187 105L201 119L227 91"],
    "water": [
        "M206 77C201 88 186 103 186 115A20 20 0 0 0 226 115C226 103 211 88 206 77Z",
        "M196 116C196 123 201 127 206 127",
    ],
    "movement": [
        "M215 78A6 6 0 1 0 215 90A6 6 0 1 0 215 78",
        "M194 116L204 98L216 102L229 112",
        "M209 101L203 117L191 133",
        "M203 117L218 125L223 138",
    ],
    "book": [
        "M185 298Q195 294 206 301Q217 294 227 298V321Q217 317 206 324Q195 317 185 321Z",
        "M206 301V324",
    ],
    "posture": [
        "M208 76A6 6 0 1 0 208 88A6 6 0 1 0 208 76",
        "M207 95V116H226V138",
        "M187 95V126H212",
        "M182 138V126H212",
    ],
}

_VECTOR_STROKE_WIDTH = 12
_VECTOR_MAX_STROKES = 12
_VECTOR_MAX_POINTS_PER_STROKE = 48
_VECTOR_MAX_POINTS = 192
_VECTOR_COORD_MAX = 411

_PATH_TOKEN = re.compile(r"[MLHVCQAZmlhvcqaz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_PATH_ARG_COUNTS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "Q": 4, "A": 7}


class VectorPathError(ValueError):
    pass


def _arc_points(x1: float, y1: float, rx: float, ry: float, rotation: float,
                large: float, sweep: float, x2: float, y2: float, samples: int) -> list[tuple[float, float]]:
    if (x1, y1) == (x2, y2):
        return []
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0:
        return [(x2, y2)]
    phi = math.radians(rotation)
    cos_phi, sin_phi = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2.0, (y1 - y2) / 2.0
    x1p = cos_phi * dx + sin_phi * dy
    y1p = -sin_phi * dx + cos_phi * dy
    lam = (x1p / rx) ** 2 + (y1p / ry) ** 2
    if lam > 1.0:
        scale = math.sqrt(lam)
        rx, ry = rx * scale, ry * scale
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    coef = math.sqrt(max(num / den, 0.0)) if den else 0.0
    if bool(large) == bool(sweep):
        coef = -coef
    cxp = coef * rx * y1p / ry
    cyp = -coef * ry * x1p / rx
    cx = cos_phi * cxp - sin_phi * cyp + (x1 + x2) / 2.0
    cy = sin_phi * cxp + cos_phi * cyp + (y1 + y2) / 2.0

    def _angle(ux: float, uy: float, vx: float, vy: float) -> float:
        norm = math.hypot(ux, uy) * math.hypot(vx, vy)
        value = max(-1.0, min(1.0, (ux * vx + uy * vy) / norm))
        sign = -1.0 if ux * vy - uy * vx < 0 else 1.0
        return sign * math.acos(value)

    theta1 = _angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    delta = _angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and delta > 0:
        delta -= 2.0 * math.pi
    elif sweep and delta < 0:
        delta += 2.0 * math.pi
    points = []
    for step in range(1, samples + 1):
        angle = theta1 + delta * step / samples
        px = cos_phi * rx * math.cos(angle) - sin_phi * ry * math.sin(angle) + cx
        py = sin_phi * rx * math.cos(angle) + cos_phi * ry * math.sin(angle) + cy
        points.append((px, py))
    return points


def _sample_cubic(p0, p1, p2, p3, samples):
    points = []
    for step in range(1, samples + 1):
        t = step / samples
        mt = 1.0 - t
        x = mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
        points.append((x, y))
    return points


def _sample_quadratic(p0, p1, p2, samples):
    points = []
    for step in range(1, samples + 1):
        t = step / samples
        mt = 1.0 - t
        points.append((mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
                       mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]))
    return points


def _parse_svg_path(data: str) -> list[list[tuple[float, float]]]:
    if re.fullmatch(r"[\s,MLHVCQAZmlhvcqaz0-9+\-.eE]*", data) is None:
        raise VectorPathError("unsupported character in icon path")
    tokens = _PATH_TOKEN.findall(data)
    strokes: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] | None = None
    subpath_start = (0.0, 0.0)
    x = y = 0.0
    command = ""
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.isalpha():
            command = token
            index += 1
            if command in "Zz":
                if current is not None and current[-1] != subpath_start:
                    current.append(subpath_start)
                    x, y = subpath_start
                command = ""
            continue
        if not command:
            raise VectorPathError("icon path data without command")
        absolute = command.isupper()
        name = command.upper()
        count = _PATH_ARG_COUNTS[name]
        if index + count > len(tokens):
            raise VectorPathError("truncated icon path")
        values = [float(value) for value in tokens[index:index + count]]
        index += count
        if not absolute:
            if name in ("M", "L", "C", "Q"):
                values = [value + (x if pos % 2 == 0 else y) for pos, value in enumerate(values)]
            elif name == "A":
                values[5] += x
                values[6] += y
            elif name == "H":
                values[0] += x
            elif name == "V":
                values[0] += y
        if name == "M":
            x, y = values
            current = [(x, y)]
            strokes.append(current)
            subpath_start = (x, y)
            command = "L" if absolute else "l"
        elif current is None:
            raise VectorPathError("icon path segment before moveto")
        elif name == "L":
            x, y = values
            current.append((x, y))
        elif name == "H":
            x = values[0]
            current.append((x, y))
        elif name == "V":
            y = values[0]
            current.append((x, y))
        elif name == "C":
            p0 = (x, y)
            p1 = (values[0], values[1])
            p2 = (values[2], values[3])
            x, y = values[4], values[5]
            current.extend(_sample_cubic(p0, p1, p2, (x, y), 12))
        elif name == "Q":
            p0 = (x, y)
            p1 = (values[0], values[1])
            x, y = values[2], values[3]
            current.extend(_sample_quadratic(p0, p1, (x, y), 12))
        elif name == "A":
            end = (values[5], values[6])
            current.extend(_arc_points(x, y, values[0], values[1], values[2],
                                       values[3], values[4], end[0], end[1], 16))
            x, y = end
    return strokes


def _encode_vector_path(paths: list[str]) -> str:
    strokes = _parse_all(paths)
    total = sum(len(stroke) for stroke in strokes)
    if not strokes or len(strokes) > _VECTOR_MAX_STROKES or total > _VECTOR_MAX_POINTS:
        raise VectorPathError("icon exceeds vector path budget")
    encoded = bytearray((1, len(strokes)))
    for stroke in strokes:
        encoded.append(_VECTOR_STROKE_WIDTH)
        encoded.append(len(stroke))
        for px, py in stroke:
            encoded += px.to_bytes(2, "big")
            encoded += py.to_bytes(2, "big")
    return encoded.hex()


def _parse_all(paths: list[str]) -> list[list[tuple[int, int]]]:
    strokes: list[list[tuple[int, int]]] = []
    for path in paths:
        raw = _parse_svg_path(path)
        for stroke in raw:
            points: list[tuple[int, int]] = []
            for px, py in stroke:
                point = (max(0, min(_VECTOR_COORD_MAX, int(round(px)))),
                         max(0, min(_VECTOR_COORD_MAX, int(round(py)))))
                if not points or points[-1] != point:
                    points.append(point)
            if len(points) > _VECTOR_MAX_POINTS_PER_STROKE:
                stride = (len(points) - 1) / (_VECTOR_MAX_POINTS_PER_STROKE - 1)
                points = [points[round(i * stride)] for i in range(_VECTOR_MAX_POINTS_PER_STROKE)]
            if points:
                strokes.append(points)
    return strokes


def _compile_icons() -> dict[str, str]:
    return {name: _encode_vector_path(paths) for name, paths in _ICON_PATHS.items()}


def _stderr(kind: str) -> None:
    sys.stderr.write(kind + "\n")
    sys.stderr.flush()


class Reject(Exception):
    def __init__(self, code: str, request_id: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.request_id = request_id


def _host_ms() -> int:
    return int(time.time() * 1000)


@lru_cache(maxsize=256)
def _feedback_vector(code: str, icon: str, cognitive_icons: tuple = ()) -> str:
    from companion_feedback import FEEDBACK_TEXT_PATHS
    # Native 412-coordinate vector paths; a label never passes through the 51px bitmap.
    main=_parse_all(_ICON_PATHS[icon]) if icon != "none" else []
    if icon == "book": main=[[(x,y-200) for x,y in stroke] for stroke in main]
    label=_parse_all(FEEDBACK_TEXT_PATHS.get(code,[]))
    from companion_vector_budget import fit_label_strokes
    badges=[]
    badge_width=3
    if cognitive_icons:
        from companion_cognition import COGNITIVE_BADGE_PATHS, COGNITIVE_LABEL_SHIFT, COGNITIVE_SLOT_X
        for slot,name in enumerate(cognitive_icons):
            dx=COGNITIVE_SLOT_X[slot]
            badges.extend([[(x+dx,y) for x,y in stroke] for stroke in _parse_all(COGNITIVE_BADGE_PATHS[name])])
        shift=COGNITIVE_LABEL_SHIFT*len(cognitive_icons)
        label=[[(x+shift,y) for x,y in stroke] for stroke in label]
    frame=[]
    def fits(paths):return len(paths)<=12 and sum(map(len,paths))<=192 and all(len(path)<=48 for path in paths)
    if not fits(badges+label+main):main=[]
    if not fits(badges+label):label=fit_label_strokes(label,12-len(badges),192-sum(map(len,badges)))
    if not fits(badges+label+main+frame):frame=[]
    strokes=[(badge_width,s) for s in badges]+[(8,s) for s in main]+[(2,s) for s in label]+[(2,s) for s in frame]
    if not fits([s for _,s in strokes]):raise VectorPathError("feedback exceeds SDK budget")
    encoded=bytearray((1,len(strokes)))
    for width,stroke in strokes:
        encoded.extend((width,len(stroke)))
        for x,y in stroke:encoded.extend(x.to_bytes(2,'big'));encoded.extend(y.to_bytes(2,'big'))
    return encoded.hex()


def _json_loads_strict(line: str) -> Any:
    def _reject_constant(_value: str) -> None:
        raise ValueError("non-finite number")
    return json.loads(line, parse_constant=_reject_constant)


def _require_number(value: Any, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Reject("invalid_request")
    numeric = float(value)
    if not math.isfinite(numeric) or not minimum <= numeric <= maximum:
        raise Reject("invalid_request")
    return numeric


def _require_int(value: Any, minimum: int, maximum: int) -> int:
    numeric = _require_number(value, minimum, maximum)
    if not numeric.is_integer():
        raise Reject("invalid_request")
    return int(numeric)


class Outbox:
    """Single writer thread: control replies first, frames latest-only."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._control: deque[dict[str, Any]] = deque()
        self._frame: dict[str, Any] | None = None
        self._closed = False
        self._last_frame_at = 0.0
        self._pending_writes = 0
        self._thread = threading.Thread(target=self._run, name="companion-outbox", daemon=True)
        self._thread.start()

    def reply(self, message: dict[str, Any]) -> None:
        with self._condition:
            if self._closed:
                return
            self._control.append(message)
            self._pending_writes += 1
            self._condition.notify_all()

    def frame(self, message: dict[str, Any]) -> None:
        with self._condition:
            if self._closed:
                return
            self._frame = message
            self._condition.notify_all()

    def clear_frames(self) -> None:
        with self._condition:
            self._frame = None

    def wait_idle(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        with self._condition:
            while self._pending_writes:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self._condition.wait(remaining)

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._frame = None
            self._condition.notify_all()
        self._thread.join(timeout=2.0)

    def _run(self) -> None:
        while True:
            with self._condition:
                while True:
                    if self._control:
                        message = self._control.popleft()
                        is_frame = False
                        break
                    if self._closed:
                        return
                    if self._frame is not None:
                        delay = FRAME_MIN_INTERVAL_S - (time.monotonic() - self._last_frame_at)
                        if delay <= 0:
                            message = self._frame
                            self._frame = None
                            is_frame = True
                            break
                        self._condition.wait(delay)
                        continue
                    self._condition.wait()
            try:
                sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
                sys.stdout.flush()
            except (OSError, ValueError):
                with self._condition:
                    self._closed = True
                return
            with self._condition:
                if is_frame:
                    self._last_frame_at = time.monotonic()
                else:
                    self._pending_writes -= 1
                self._condition.notify_all()


class HeadChannel:
    """Owns the head worker thread; at most one pending and one running move."""

    def __init__(self, bridge: "Bridge") -> None:
        self._bridge = bridge
        self._condition = threading.Condition()
        self._pending: dict[str, Any] | None = None
        self._running: dict[str, Any] | None = None
        self._shutdown = False
        self._worker = threading.Thread(target=self._work, name="companion-head", daemon=True)
        self._worker.start()

    def submit(self, command: dict[str, Any]) -> None:
        with self._condition:
            if self._shutdown:
                raise Reject("closed", command["id"])
            previous = self._pending
            self._pending = command
            self._condition.notify_all()
        if previous is not None:
            self._bridge.outbox.reply({
                "type": "reply", "id": previous["id"], "ok": True,
                "result": {"status": "stopped", "reason": "superseded"},
            })

    def revoke_pending(self) -> None:
        with self._condition:
            previous = self._pending
            self._pending = None
        if previous is not None:
            self._bridge.outbox.reply({
                "type": "reply", "id": previous["id"], "ok": True,
                "result": {"status": "stopped", "reason": "superseded"},
            })

    def stop(self) -> None:
        self.revoke_pending()
        with self._condition:
            running = self._running
            if running is not None:
                running["cancel_requested"] = True
            job = running.get("job") if running is not None else None
        if job is not None:
            try:
                job.cancel()
            except Exception:
                pass
        self._bridge.stop_motion()

    def shutdown(self) -> None:
        with self._condition:
            self._shutdown = True
            self._condition.notify_all()
        self.stop()
        self._worker.join(timeout=2.0)

    def _take(self) -> dict[str, Any] | None:
        with self._condition:
            while True:
                if self._shutdown:
                    return None
                if self._pending is not None:
                    command = self._pending
                    self._pending = None
                    self._running = command
                    return command
                self._condition.wait()

    def _finish(self, command: dict[str, Any]) -> None:
        with self._condition:
            if self._running is command:
                self._running = None

    def _work(self) -> None:
        while True:
            command = self._take()
            if command is None:
                return
            try:
                self._execute(command)
            finally:
                self._finish(command)

    def _execute(self, command: dict[str, Any]) -> None:
        bridge = self._bridge
        request_id = command["id"]

        def _reply(result: dict[str, Any]) -> None:
            bridge.outbox.reply({"type": "reply", "id": request_id, "ok": True, "result": result})

        def _reject(code: str) -> None:
            bridge.outbox.reply({"type": "reply", "id": request_id, "ok": False, "error": code})

        with bridge.lock:
            if bridge.closing:
                return _reject("closed")
            if command["generation"] != bridge.generation:
                return _reply({"status": "stopped", "reason": "superseded"})
        now = _host_ms()
        if now >= min(command["expiresAt"],command.get("startBefore",command["expiresAt"])):
            return _reject("expired")
        pan = 90 + int(round(command["yaw"]))
        tilt = 115 + int(round(command["pitch"]))
        try:
            job = bridge.robot.motion.move_to(
                pan_deg=pan, tilt_deg=tilt,
                duration_ms=command["durationMs"], profile="ease_in_out",
            )
        except Exception:
            return _reject("device_error")
        with self._condition:
            command["job"] = job
            cancel_requested = command.get("cancel_requested", False)
        if cancel_requested:
            try:
                job.cancel()
            except Exception:
                pass
        wait_s = min((command["expiresAt"] - _host_ms()) / 1000.0, HEAD_MAX_WAIT_S)
        try:
            job.wait(timeout=max(wait_s, 0.0))
        except TimeoutError:
            bridge.stop_motion()
            return _reply({"status": "stopped", "reason": "expired"})
        except JobCancelledError:
            return _reply({"status": "stopped", "reason": "cancelled"})
        except JobFailedError:
            return _reject("device_error")
        except Exception:
            return _reject("device_error")
        with self._condition:
            if command.get("cancel_requested"):
                return _reply({"status": "stopped", "reason": "cancelled"})
        _reply({"status": "completed", "jobState": "completed"})


class Bridge:
    def __init__(self, session: DesktopRobotSession, robot: WatcheRobot,
                 icons: dict[str, str]) -> None:
        self.session = session
        self.robot = robot
        self.icons = icons
        self.outbox = Outbox()
        self.lock = threading.RLock()
        self.generation: int | None = None
        self.closing = False
        self.head = HeadChannel(self)
        self._expression_token = 0
        self._expression_active = False
        self._expression_timer: threading.Timer | None = None
        self._camera_token = 0
        self._camera_session: Any | None = None
        self._camera_thread: threading.Thread | None = None

    # ---- shared helpers -------------------------------------------------

    def reply_ok(self, request_id: str, result: dict[str, Any]) -> None:
        self.outbox.reply({"type": "reply", "id": request_id, "ok": True, "result": result})

    def reply_error(self, request_id: str, code: str) -> None:
        self.outbox.reply({"type": "reply", "id": request_id, "ok": False, "error": code})

    def stop_motion(self) -> None:
        try:
            self.robot.motion.stop()
        except Exception:
            pass

    def _stop_expression_locked(self) -> None:
        self._expression_token += 1
        timer = self._expression_timer
        self._expression_timer = None
        if timer is not None:
            timer.cancel()
        if self._expression_active:
            self._expression_active = False
            try:
                self.robot.expression_runtime.stop()
            except Exception:
                pass

    def stop_expression(self) -> None:
        with self.lock:
            self._stop_expression_locked()

    def _advance_generation(self, generation: int) -> None:
        self.generation = generation
        self.head.revoke_pending()
        self._stop_expression_locked()
        self.stop_motion()

    def check_generation(self, command: dict[str, Any]) -> None:
        with self.lock:
            if self.closing:
                raise Reject("closed", command["id"])
            generation = command["generation"]
            if self.generation is None:
                self.generation = generation
            elif generation < self.generation:
                raise Reject("stale_generation", command["id"])
            elif generation > self.generation:
                self._advance_generation(generation)

    # ---- ops ------------------------------------------------------------

    def op_head(self, command: dict[str, Any]) -> None:
        if _host_ms() >= command["expiresAt"]:
            raise Reject("expired", command["id"])
        self.head.submit(command)

    def op_prepare_message(self, command: dict[str, Any]) -> None:
        from companion_message import prepare_message
        self.reply_ok(command['id'], prepare_message(command['text']))

    def op_expression(self, command: dict[str, Any]) -> None:
        now = _host_ms()
        if now >= command["expiresAt"]:
            raise Reject("expired", command["id"])
        eyes = command["eyes"]
        kwargs: dict[str, Any] = {
            "style": "watcher_focus",
            "gaze_x": eyes["gazeX"],
            "gaze_y": eyes["gazeY"],
            "openness": eyes["openness"],
            "roundness": eyes["roundness"],
            "tilt_deg": int(round(eyes["tilt"])),
            "color": eyes["color"],
            "auto_blink": True,
        }
        icon = "none"  # Decorative icons are temporarily hidden; agent state is preserved.
        status_code = command.get("statusCode")
        if status_code in {"paused", "resting"}:
            kwargs.update(scale_y=.82,accessory="custom_vector", custom_vector_path=_feedback_vector(status_code,"none",()), custom_accessory_layer="front",accessory_scale=1.0,accessory_x=0,accessory_y=0)
            kwargs["gaze_y"] = eyes["gazeY"]*.75-.18
            kwargs["auto_blink"] = status_code not in {"paused","resting","manual","unavailable"}
        elif icon == "none":
            kwargs["accessory"] = "none"
        else:
            vector_path = self.icons.get(icon)
            if vector_path is None:
                raise Reject("device_error", command["id"])
            kwargs["accessory"] = "custom_vector"
            kwargs["custom_vector_path"] = vector_path
            kwargs["custom_accessory_layer"] = "front"
        base_kwargs = dict(kwargs)
        pages = None
        message_result = None
        user_message = command.get("userMessage")
        if user_message is not None:
            from companion_message import compile_message_pages, page_at, MessageRenderError
            try:
                if user_message["createdAt"] <= now < user_message["expiresAt"]:
                    pages = compile_message_pages(user_message["text"])
                    page_at(user_message["createdAt"], user_message["expiresAt"], len(pages), now)
                else:
                    message_result = {"id": user_message["id"], "status": "expired"}
            except MessageRenderError as error:
                message_result = {"id": user_message["id"], "status": "unavailable", "reason": str(error), **({"diagnostics":error.diagnostics} if error.diagnostics else {})}
                pages = None
        try:
            with self.lock:
                if self.closing:
                    raise Reject("closed", command["id"])
                if _host_ms() >= command["expiresAt"]:
                    raise Reject("expired", command["id"])
                if pages:
                    kwargs, next_at, message_result = self._message_frame(command, base_kwargs, pages, _host_ms())
                else:
                    next_at = command["expiresAt"]
                self._expression_token += 1
                token = self._expression_token
                timer = self._expression_timer
                self._expression_timer = None
                if timer is not None:
                    timer.cancel()
                if self._expression_active:
                    self.robot.expression_runtime.update(**kwargs)
                else:
                    self.robot.expression_runtime.start("standby", **kwargs)
                    self._expression_active = True
                delay = max((next_at - _host_ms()) / 1000.0, 0.001)
                self._expression_timer = threading.Timer(delay, self._expression_page, args=(token, command, base_kwargs, pages)) if pages else threading.Timer(delay, self._expression_expire, args=(token,))
                self._expression_timer.daemon = True
                self._expression_timer.start()
        except Reject:
            raise
        except WatcheRobotError as error:
            if "does not advertise" in str(error):
                raise Reject("capability_unavailable", command["id"]) from error
            raise Reject("device_error", command["id"]) from error
        except Exception:
            raise Reject("device_error", command["id"])
        self.reply_ok(command["id"], {"status": "device_acknowledged", **({"userMessage": message_result} if message_result else {})})

    @staticmethod
    def _message_frame(command, base_kwargs, pages, now):
        from companion_message import page_at, RENDERER_VERSION
        message = command["userMessage"]
        position = page_at(message["createdAt"], message["expiresAt"], len(pages), now)
        if position is None:
            return dict(base_kwargs), command["expiresAt"], {"id": message["id"], "status": "expired"}
        index, boundary = position
        kwargs = {**base_kwargs, "scale_y": .82, "gaze_y": command["eyes"]["gazeY"] * .75 - .18,
                  "accessory": "custom_vector", "custom_vector_path": pages[index]["vector"],
                  "custom_accessory_layer": "front", "accessory_scale": 1.0, "accessory_x": 0, "accessory_y": 0}
        page=pages[index]
        diagnostic=page.get('diagnostics',{})
        return kwargs, min(command["expiresAt"], boundary), {"id": message["id"], "status": "device_acknowledged", "complete":True,"lineCount":diagnostic.get('lineCount',1),"fontSize":diagnostic.get('fontSize'),"layout":diagnostic.get('layout','single_line'),"page": 1, "pageCount": 1, "rendering": page.get('rendering','system_font_skeleton'), "rendererVersion":RENDERER_VERSION, **({"diagnostics":diagnostic} if diagnostic else {})}

    def _expression_page(self, token, command, base_kwargs, pages):
        with self.lock:
            if token != self._expression_token or not self._expression_active or self.closing:
                return
            now = _host_ms()
            if now >= command["expiresAt"]:
                self._expression_expire(token)
                return
            try:
                kwargs, next_at, _ = self._message_frame(command, base_kwargs, pages, now)
                self.robot.expression_runtime.update(**kwargs)
                self._expression_timer = threading.Timer(max((next_at - _host_ms()) / 1000.0, .001), self._expression_page, args=(token, command, base_kwargs, pages))
                self._expression_timer.daemon = True
                self._expression_timer.start()
            except Exception:
                self._stop_expression_locked()
                _stderr("message_page_failed")

    def _expression_expire(self, token: int) -> None:
        with self.lock:
            if token != self._expression_token or not self._expression_active or self.closing:
                return
            self._expression_token += 1
            self._expression_timer = None
            self._expression_active = False
            try:
                self.robot.expression_runtime.stop()
            except Exception:
                pass

    def op_stop(self, command: dict[str, Any]) -> None:
        channels = command.get("channels") or ["head", "expression"]
        if "head" in channels:
            self.head.stop()
        if "expression" in channels:
            self.stop_expression()
        self.reply_ok(command["id"], {"status": "stopped", "channels": list(channels)})

    def op_camera_status(self, command: dict[str, Any]) -> None:
        try:
            status=self.robot.vision.status(timeout=3)
            self.reply_ok(command["id"], {"initialized":status.initialized,"connected":status.connected,"streaming":status.streaming,"inferencing":status.inferencing,"statusCode":status.status_code,"modelId":status.model.model_id if status.model else None})
        except Exception:
            self.reply_error(command["id"],"device_error")

    def op_camera_recover(self, command: dict[str, Any]) -> None:
        # Explicit recovery while this exclusive host owns no active camera.
        with self.lock:
            if self._camera_session is not None:raise Reject("device_busy",command["id"])
        try:
            self.robot.vision.stop_inference(timeout=2)
            status=self.robot.vision.status(timeout=2)
            self.robot.face_tracking.stop(policy="hold",timeout=2)
            if status.model:self.robot.vision.select_model(status.model.model_id,timeout=2)
            self.reply_ok(command["id"],{"status":"device_acknowledged"})
        except Exception:self.reply_error(command["id"],"device_error")

    def op_camera_start(self, command: dict[str, Any]) -> None:
        with self.lock:
            if self.closing:
                raise Reject("closed", command["id"])
            if self._camera_session is not None:
                raise Reject("device_busy", command["id"])
        try:
            self.robot.vision.stop_inference(timeout=2)
            models = self.robot.vision.models(timeout=3)
        except WatcheRobotError as error:
            code = "capability_unavailable" if "does not advertise" in str(error) else "device_error"
            raise Reject(code, command["id"]) from error
        except Exception:
            raise Reject("device_error", command["id"])
        candidates=[m for m in models if m.task == "detection" and m.verified]
        try:current_model=self.robot.vision.active_model(timeout=2)
        except Exception:current_model=None
        model=next((m for m in candidates if current_model and m.model_id==current_model.model_id),None) or next(iter(candidates),None)
        if model is None:
            raise Reject("capability_unavailable", command["id"])
        try:
            session = self.robot.vision.start_inference(model.model_id, preview=True, timeout=4)
        except WatcheRobotError as error:
            code = "capability_unavailable" if "does not advertise" in str(error) else "device_error"
            raise Reject(code, command["id"]) from error
        except Exception:
            raise Reject("device_error", command["id"])
        with self.lock:
            if self.closing or self._camera_session is not None:
                try:
                    session.close()
                except Exception:
                    pass
                raise Reject("closed" if self.closing else "device_busy", command["id"])
            self._camera_token += 1
            token = self._camera_token
            self._camera_session = session
            self._camera_thread = threading.Thread(
                target=self._camera_loop, args=(token, session),
                name="companion-camera", daemon=True,
            )
            self._camera_thread.start()
        self.reply_ok(command["id"], {"status": "device_acknowledged"})

    def _camera_loop(self, token: int, session: Any) -> None:
        last_sequence: int | None = None
        next_poll=time.monotonic()
        consecutive_timeouts=0
        while True:
            with self.lock:
                if token != self._camera_token or self.closing:
                    return
            delay=next_poll-time.monotonic()
            if delay>0:time.sleep(delay)
            next_poll=time.monotonic()+FRAME_MIN_INTERVAL_S
            try:
                result = session.latest(timeout=2)
                consecutive_timeouts=0
            except TimeoutError:
                consecutive_timeouts+=1
                if consecutive_timeouts<3:
                    time.sleep(.2)
                    continue
                current_session=self._camera_revoke(token)
                if current_session is not None:self._close_camera_session(current_session)
                _stderr("camera_timeout")
                return
            except RuntimeError:
                current_session=self._camera_revoke(token)
                if current_session is not None:self._close_camera_session(current_session)
                return
            except Exception:
                with self.lock:
                    current = token == self._camera_token and not self.closing
                if current:
                    _stderr("camera_error")
                    current_session=self._camera_revoke(token)
                    if current_session is not None:self._close_camera_session(current_session)
                return
            if result is None or result.jpeg is None or result.sequence == last_sequence:
                continue
            at = _host_ms()
            last_sequence = result.sequence
            frame = self._build_frame(result.jpeg, at, result.sequence)
            if frame is not None:
                with self.lock:
                    if token != self._camera_token or self.closing:return
                    self.outbox.frame(frame)

    @staticmethod
    def _build_frame(jpeg: bytes, at: int, sequence: int) -> dict[str, Any] | None:
        try:
            image = Image.open(io.BytesIO(jpeg))
            image.load()
        except Exception:
            return None
        data = jpeg
        if len(data) > MAX_FRAME_BYTES:
            buffer = io.BytesIO()
            scale = min(1, 640 / image.width, 480 / image.height)
            width, height = max(1, round(image.width * scale)), max(1, round(image.height * scale))
            image.convert("RGB").resize((width, height)).save(buffer, format="JPEG", quality=75)
            data = buffer.getvalue()
            if len(data) > MAX_FRAME_BYTES:
                return None
        else:
            width, height = image.size
        return {
            "type": "frame",
            "at": at,
            "sequence": sequence,
            "width": width,
            "height": height,
            "data": base64.b64encode(data).decode("ascii"),
        }

    def _camera_revoke(self, token: int) -> Any | None:
        with self.lock:
            if token != self._camera_token:
                return None
            self._camera_token += 1
            session = self._camera_session
            self._camera_session = None
            self._camera_thread = None
        self.outbox.clear_frames()
        return session

    def op_camera_stop(self, command: dict[str, Any]) -> None:
        session = self._camera_revoke(self._current_camera_token())
        if session is not None:
            threading.Thread(target=self._close_camera_session, args=(session,),
                             name="companion-camera-close", daemon=True).start()
        self.reply_ok(command["id"], {"status": "stopped"})

    def _current_camera_token(self) -> int:
        with self.lock:
            return self._camera_token

    @staticmethod
    def _close_camera_session(session: Any) -> None:
        try:
            session.close()
        except Exception:
            pass

    def op_close(self, command: dict[str, Any]) -> None:
        self.reply_ok(command["id"], {"status": "completed"})
        self.outbox.wait_idle(2.0)
        self.shutdown()

    # ---- teardown ---------------------------------------------------------

    def shutdown(self) -> None:
        with self.lock:
            if self.closing:
                return
            self.closing = True
            self._camera_token += 1
            session = self._camera_session
            self._camera_session = None
        self.outbox.clear_frames()
        if session is not None:
            self._close_camera_session(session)
        self.head.shutdown()
        self.stop_expression()
        self.stop_motion()
        try:
            self.robot.close()
        except Exception:
            pass
        self.outbox.close()


# ---- request validation ---------------------------------------------------

_OPS = ("head", "expression", "prepare_message", "stop", "camera_start", "camera_stop", "camera_status", "camera_recover", "close")

_OP_FIELDS = {
    "prepare_message": {"text"},
    "head": {"yaw", "pitch", "expiresAt", "durationMs", "startBefore"},
    "expression": {"eyes", "icon", "expiresAt", "statusCode", "cognitiveIcons", "userMessage"},
    "stop": {"channels"},
    "camera_start": set(),
    "camera_stop": set(),
    "camera_status": set(),
    "camera_recover": set(),
    "close": set(),
}

_EYE_FIELDS = ("gazeX", "gazeY", "openness", "tilt", "roundness", "color")


def parse_command(line: str) -> dict[str, Any]:
    if len(line.encode("utf-8")) > MAX_LINE_BYTES:
        raise Reject("invalid_request")
    try:
        obj = _json_loads_strict(line)
    except ValueError:
        raise Reject("invalid_request")
    if not isinstance(obj, dict):
        raise Reject("invalid_request")
    request_id = obj.get("id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
        raise Reject("invalid_request")
    op = obj.get("op")
    if not isinstance(op, str):
        raise Reject("invalid_request", request_id)
    if op not in _OPS:
        raise Reject("unknown_op", request_id)
    generation = obj.get("generation")
    if isinstance(generation, bool) or not isinstance(generation, int) \
            or not 0 <= generation <= SAFE_INT_MAX:
        raise Reject("invalid_request", request_id)
    extra = set(obj) - {"id", "op", "generation"} - _OP_FIELDS[op]
    if extra:
        raise Reject("invalid_request", request_id)
    command: dict[str, Any] = {"id": request_id, "op": op, "generation": generation}
    if op == "prepare_message":
        value=obj.get('text')
        if not isinstance(value,str) or not value.strip() or len(value)>16 or any(ord(c)<32 or ord(c)==127 or 0xd800<=ord(c)<=0xdfff for c in value):
            raise Reject('invalid_request',request_id)
        command['text']=value
    elif op == "head":
        command["yaw"] = _require_number(obj.get("yaw"), -45.0, 45.0)
        command["pitch"] = _require_number(obj.get("pitch"), -15.0, 15.0)
        command["expiresAt"] = _require_int(obj.get("expiresAt"), 0, SAFE_INT_MAX)
        command["durationMs"] = _require_int(obj.get("durationMs"), 100, 1000)
        if "startBefore" in obj:command["startBefore"]=_require_int(obj["startBefore"],0,command["expiresAt"])
    elif op == "expression":
        eyes = obj.get("eyes")
        if not isinstance(eyes, dict) or set(eyes) != set(_EYE_FIELDS):
            raise Reject("invalid_request", request_id)
        command["eyes"] = {
            "gazeX": _require_number(eyes.get("gazeX"), -1.0, 1.0),
            "gazeY": _require_number(eyes.get("gazeY"), -1.0, 1.0),
            "openness": _require_number(eyes.get("openness"), 0.05, 1.2),
            "tilt": _require_number(eyes.get("tilt"), -30.0, 30.0),
            "roundness": _require_number(eyes.get("roundness"), 0.0, 1.0),
            "color": _require_color(eyes.get("color")),
        }
        icon = obj.get("icon")
        if icon not in ICONS:
            raise Reject("invalid_request", request_id)
        command["icon"] = icon
        if "userMessage" in obj:
            value = obj["userMessage"]
            if not isinstance(value, dict) or set(value) != {"id", "text", "createdAt", "expiresAt"}:
                raise Reject("invalid_request", request_id)
            message_id, message_text = value["id"], value["text"]
            if not isinstance(message_id, str) or not 1 <= len(message_id) <= 100 or not isinstance(message_text, str) or not message_text.strip() or len(message_text) > 16 or any(ord(c) < 32 or ord(c) == 127 or 0xd800 <= ord(c) <= 0xdfff for c in message_text):
                raise Reject("invalid_request", request_id)
            created_at = _require_int(value["createdAt"], 0, SAFE_INT_MAX)
            message_expires_at = _require_int(value["expiresAt"], 0, SAFE_INT_MAX)
            if message_expires_at <= created_at:
                raise Reject("invalid_request", request_id)
            command["userMessage"] = {"id": message_id, "text": message_text, "createdAt": created_at, "expiresAt": message_expires_at}
        if "statusCode" in obj:
            if not isinstance(obj["statusCode"],str) or obj["statusCode"] not in STATUS_LABELS: raise Reject("invalid_request",request_id)
            command["statusCode"] = obj["statusCode"]
        if "cognitiveIcons" in obj:
            from companion_cognition import COGNITIVE_ICONS, COGNITIVE_MAX_BADGES
            cognitive = obj["cognitiveIcons"]
            if not isinstance(cognitive, list) or len(cognitive) > COGNITIVE_MAX_BADGES \
                    or any(not isinstance(item, str) or item not in COGNITIVE_ICONS for item in cognitive) \
                    or len(set(cognitive)) != len(cognitive):
                raise Reject("invalid_request", request_id)
            if cognitive and "statusCode" not in obj:
                # Badges attach to the status footer; without one they would be
                # silently dropped, so the command is rejected instead.
                raise Reject("invalid_request", request_id)
            command["cognitiveIcons"] = tuple(cognitive)
        command["expiresAt"] = _require_int(obj.get("expiresAt"), 0, SAFE_INT_MAX)
    elif op == "stop":
        channels = obj.get("channels")
        if channels is not None:
            if not isinstance(channels, list) \
                    or any(channel not in ("head", "expression") for channel in channels):
                raise Reject("invalid_request", request_id)
            command["channels"] = list(dict.fromkeys(channels))
    return command


def _require_color(value: Any) -> str:
    if not isinstance(value, str) or re.fullmatch(r"#[0-9A-Fa-f]{6}", value) is None:
        raise Reject("invalid_request")
    return value.upper()


# ---- startup ----------------------------------------------------------------


def _http_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=3.0) as response:
        body = response.read(64 * 1024)
    parsed = json.loads(body.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("unexpected daemon response")
    return parsed


def _preflight() -> None:
    try:
        status = _http_json(HTTP_BASE + "/daemon/status")
    except Exception:
        _stderr("startup_daemon_unreachable")
        raise SystemExit(1)
    application = status.get("application")
    if isinstance(application, dict) and application.get("state") in APP_ACTIVE_STATES:
        _stderr("startup_application_active")
        raise SystemExit(1)
    try:
        devices = _http_json(HTTP_BASE + "/daemon/devices")
    except Exception:
        _stderr("startup_daemon_unreachable")
        raise SystemExit(1)
    device = devices.get("device", devices)
    if not isinstance(device, dict) or not bool(device.get("online")):
        _stderr("startup_device_offline")
        raise SystemExit(1)


def _connect() -> tuple[DesktopRobotSession, WatcheRobot]:
    session = DesktopRobotSession(WS_URL, command_timeout=COMMAND_TIMEOUT_S)
    robot = WatcheRobot(session)
    try:
        session.start(timeout=COMMAND_TIMEOUT_S)
    except Exception:
        _stderr("startup_session_failed")
        try:
            robot.close()
        except Exception:
            pass
        raise SystemExit(1)
    return session, robot


def main(*, connect=None, preflight=None) -> int:
    try:
        icons = _compile_icons()
    except VectorPathError:
        _stderr("startup_icon_invalid")
        return 1
    (preflight or _preflight)()
    session, robot = (connect or _connect)()
    try:
        robot.refresh_device_info(timeout=2.0)
    except Exception:
        pass
    device_info = robot.device_info
    firmware_version = device_info.get("firmware_version")
    bridge = Bridge(session, robot, icons)
    bridge.outbox.reply({
        "type": "ready",
        "online": True,
        "sdkVersion": watcherobot.__version__,
        "firmwareVersion": firmware_version if isinstance(firmware_version, str) else None,
        "capabilities": [item for item in robot.capabilities if isinstance(item, str)],
    })

    def _terminate(_signum: int, _frame: Any) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGINT, _terminate)

    dispatch = {
        "prepare_message": bridge.op_prepare_message,
        "head": bridge.op_head,
        "expression": bridge.op_expression,
        "stop": bridge.op_stop,
        "camera_start": bridge.op_camera_start,
        "camera_stop": bridge.op_camera_stop,
        "camera_status": bridge.op_camera_status,
        "camera_recover": bridge.op_camera_recover,
        "close": bridge.op_close,
    }
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                command = parse_command(line)
            except Reject as error:
                if error.request_id is not None:
                    bridge.reply_error(error.request_id, error.code)
                else:
                    _stderr("protocol_error")
                continue
            try:
                if command['op']!='prepare_message':bridge.check_generation(command)
                dispatch[command["op"]](command)
            except Reject as error:
                bridge.reply_error(command["id"], error.code)
            except Exception:
                bridge.reply_error(command["id"], "device_error")
            if command["op"] == "close":
                return 0
    except SystemExit as exit:
        code = exit.code if isinstance(exit.code, int) else 0
        bridge.shutdown()
        return code
    bridge.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
