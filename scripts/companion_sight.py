# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Optional local YuNet geometry. Never stores images, embeddings, or identities."""
import copy
import hashlib
import math
from numbers import Real
from pathlib import Path
import time
import uuid

MODEL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
DETECTOR = 'yunet-2023mar'

# Conservative, tunable geometry gates, not calibrated pose/probability values.
# Lateral distances use eye span; nose depth is a fraction of eye-to-mouth depth.
FACE_ORIENTATION_THRESHOLDS = {
    'min_eye_pixels': 2.0,
    'min_eye_box_ratio': .12,
    'max_eye_box_ratio': .95,
    'mouth_eye_ratio': (.15, 1.2),
    'min_mouth_alignment': .7,
    'mouth_depth_eye_ratio': (.35, 1.8),
    'max_mouth_offset': .5,
    'valid_nose_depth': (.05, 1.15),
    'max_nose_offset': .9,
    'toward_nose_depth': (.25, .7),
    'toward_eye_offset': .12,
    'toward_mouth_offset': .16,
    'toward_mouth_center': .2,
    'away_eye_offset': .32,
    'away_mouth_offset': .22,
    'away_nose_depth': .88,
}


def estimate_face_orientation(row):
    """Estimate face-facing geometry from one YuNet row, without retaining it.

    YuNet row[4:14] is right eye, left eye, nose tip, right mouth corner,
    left mouth corner (OpenCV Zoo models/face_detection_yunet/demo.py).
    Projecting onto the eye line removes roll; a centered nose between eyes
    and mouth supports ``toward``. Only clear lateral or downward nose
    displacement supports ``away``; the gap and invalid geometry are unknown.
    This cannot infer eye gaze, attention, identity, or a 3-D head pose.
    Confidence measures heuristic support, never a calibrated probability.
    Occlusion, perspective, expressions and landmark errors can defeat it.
    """
    unknown = {'direction': 'unknown', 'confidence': 0.0, 'source': 'landmarks'}
    gates = FACE_ORIENTATION_THRESHOLDS
    try:
        if len(row) != 15 or not all(isinstance(value, Real) and not isinstance(value, bool)
                                     and math.isfinite(value) for value in row):
            return unknown
        x, y, width, height = map(float, row[:4])
        if width <= 0 or height <= 0 or not 0 <= row[14] <= 1:
            return unknown
        points = [(float(row[index]), float(row[index + 1])) for index in range(4, 14, 2)]
        if not all(x <= px <= x + width and y <= py <= y + height for px, py in points):
            return unknown
        right_eye, left_eye, nose, right_mouth, left_mouth = points
        eye_dx, eye_dy = left_eye[0] - right_eye[0], left_eye[1] - right_eye[1]
        eye_span = math.hypot(eye_dx, eye_dy)
        if not max(gates['min_eye_pixels'], gates['min_eye_box_ratio'] * width) <= eye_span <= gates['max_eye_box_ratio'] * width:
            return unknown
        horizontal = (eye_dx / eye_span, eye_dy / eye_span)
        vertical = (-horizontal[1], horizontal[0])
        eye_center = ((right_eye[0] + left_eye[0]) / 2, (right_eye[1] + left_eye[1]) / 2)
        mouth_center = ((right_mouth[0] + left_mouth[0]) / 2, (right_mouth[1] + left_mouth[1]) / 2)
        mouth_dx, mouth_dy = left_mouth[0] - right_mouth[0], left_mouth[1] - right_mouth[1]
        mouth_span = math.hypot(mouth_dx, mouth_dy)
        if not gates['mouth_eye_ratio'][0] <= mouth_span / eye_span <= gates['mouth_eye_ratio'][1]:
            return unknown
        if (mouth_dx * horizontal[0] + mouth_dy * horizontal[1]) / mouth_span < gates['min_mouth_alignment']:
            return unknown

        def project(point, axis):
            return ((point[0] - eye_center[0]) * axis[0] +
                    (point[1] - eye_center[1]) * axis[1]) / eye_span

        mouth_offset, mouth_depth = project(mouth_center, horizontal), project(mouth_center, vertical)
        if (not gates['mouth_depth_eye_ratio'][0] <= mouth_depth <= gates['mouth_depth_eye_ratio'][1]
                or abs(mouth_offset) > gates['max_mouth_offset']):
            return unknown
        nose_offset = project(nose, horizontal)
        nose_depth = project(nose, vertical) / mouth_depth
        if (not gates['valid_nose_depth'][0] <= nose_depth <= gates['valid_nose_depth'][1]
                or abs(nose_offset) > gates['max_nose_offset']):
            return unknown
        from_mouth = nose_offset - mouth_offset
        if (abs(nose_offset) <= gates['toward_eye_offset'] and
                abs(from_mouth) <= gates['toward_mouth_offset'] and
                abs(mouth_offset) <= gates['toward_mouth_center'] and
                gates['toward_nose_depth'][0] <= nose_depth <= gates['toward_nose_depth'][1]):
            support = 1 - max(abs(nose_offset) / gates['toward_eye_offset'],
                              abs(from_mouth) / gates['toward_mouth_offset'])
            return {'direction': 'toward', 'confidence': round(.8 + .15 * support, 3), 'source': 'landmarks'}
        lateral = (abs(nose_offset) >= gates['away_eye_offset'] and
                   abs(from_mouth) >= gates['away_mouth_offset'] and nose_offset * from_mouth > 0)
        downward = nose_depth >= gates['away_nose_depth']
        if lateral or downward:
            support = max((abs(nose_offset) - gates['away_eye_offset']) if lateral else 0,
                          (nose_depth - gates['away_nose_depth']) if downward else 0)
            return {'direction': 'away', 'confidence': round(min(.95, .75 + support), 3), 'source': 'landmarks'}
        return unknown
    except (TypeError, ValueError, OverflowError):
        return unknown


def _validated_face_orientation(value):
    if not isinstance(value, dict):
        return None
    direction, confidence = value.get('direction'), value.get('confidence')
    if (direction not in ('toward', 'away', 'unknown') or value.get('source') != 'landmarks'
            or not isinstance(confidence, Real) or isinstance(confidence, bool)
            or not 0 <= confidence <= 1 or not math.isfinite(confidence)):
        return None
    return {'direction': direction, 'confidence': float(confidence), 'source': 'landmarks'}


def _valid_detection(item):
    try:
        box = item['box']
        x, y, width, height = (box[key] for key in ('x', 'y', 'width', 'height'))
        confidence = item['confidence']
        return (all(isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v)
                    for v in (x, y, width, height, confidence)) and
                x >= 0 and y >= 0 and width > 0 and height > 0 and
                x + width <= 1.000001 and y + height <= 1.000001 and 0 <= confidence <= 1)
    except (KeyError, TypeError):
        return False


def _overlap(a, b):
    x = max(0, min(a['x'] + a['width'], b['x'] + b['width']) - max(a['x'], b['x']))
    y = max(0, min(a['y'] + a['height'], b['y'] + b['height']) - max(a['y'], b['y']))
    intersection = x * y
    return intersection / (a['width'] * a['height'] + b['width'] * b['height'] - intersection)


class GeometricTracker:
    """Conservative one-to-one IoU association with a 500 ms maximum gap."""
    def __init__(self):
        self._tracks = []
        self._last_pts = None

    def reset(self):
        self._tracks = []
        self._last_pts = None

    def snapshot(self):
        return copy.deepcopy(self._tracks)

    def update(self, detections, pts_ms):
        if not isinstance(pts_ms, (int, float)) or not math.isfinite(pts_ms):
            self.reset()
            return []
        if self._last_pts is not None and pts_ms < self._last_pts:
            self.reset()
        self._last_pts = pts_ms
        previous = [track for track in self._tracks if pts_ms - track['seenAt'] < 500]
        # Association may retain a box briefly, but orientation belongs only to
        # the current observation and must never survive a missed frame.
        for track in previous:
            track['target'].pop('faceOrientation', None)
        detections = sorted((item for item in detections if _valid_detection(item)),
                            key=lambda item: item['confidence'], reverse=True)[:8]
        edges = [[i for i, old in enumerate(previous) if _overlap(item['box'], old['target']['box']) >= .15]
                 for item in detections]
        degrees = [sum(index in options for options in edges) for index in range(len(previous))]
        targets, current = [], []
        touched = {index for options in edges for index in options}
        for item, options in zip(detections, edges):
            matched = len(options) == 1 and degrees[options[0]] == 1
            identifier = previous[options[0]]['target']['id'] if matched else 'face-' + uuid.uuid4().hex
            target = {'id': identifier, 'kind': 'face', 'identity': 'unknown',
                      'box': dict(item['box']), 'confidence': float(item['confidence'])}
            orientation = _validated_face_orientation(item.get('faceOrientation'))
            if orientation is not None:
                target['faceOrientation'] = orientation
            targets.append(target)
            current.append({'target': target, 'seenAt': pts_ms})
        # Ambiguous candidates are retired; never resurrect them after a crossing.
        retained = [track for index, track in enumerate(previous) if index not in touched]
        self._tracks = (current + retained)[:8]
        return copy.deepcopy(targets)


class LocalSight:
    def __init__(self, model_path):
        self._tracker = GeometricTracker()
        self._detector = None
        self._cv2 = None
        self._np = None
        self._last_pts = None
        self._last_targets = []
        try:
            path = Path(model_path)
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_SHA256:
                return
            import cv2
            import numpy as np
            if not cv2.__version__.startswith('4.12.'):
                return
            self._cv2, self._np = cv2, np
            self._detector = cv2.FaceDetectorYN_create(str(path), '', (320, 320), .8, .3, 5000)
        except (ImportError, OSError, ValueError, AttributeError):
            self._detector = None

    def reset(self):
        self._tracker.reset()
        self._last_pts = None
        self._last_targets = []

    def analyze(self, image, pts_ms):
        started = time.perf_counter()

        def result(status, targets):
            return {'status': status, 'detector': DETECTOR, 'targets': targets,
                    'processingMs': round((time.perf_counter() - started) * 1000, 3)}

        if self._detector is None:
            return result('unavailable', [])
        try:
            if not isinstance(pts_ms, (int, float)) or not math.isfinite(pts_ms):
                raise ValueError('invalid timestamp')
            width, height = image.size
            if width < 1 or height < 1 or width * height > 16_777_216:
                raise ValueError('invalid dimensions')
            if self._last_pts is not None:
                if pts_ms < self._last_pts:
                    self.reset()
                elif pts_ms - self._last_pts < 125:
                    return result('ready', copy.deepcopy(self._last_targets))
            pixels = self._cv2.cvtColor(self._np.asarray(image.convert('RGB')), self._cv2.COLOR_RGB2BGR)
            self._detector.setInputSize((width, height))
            _, faces = self._detector.detect(pixels)
            detections = []
            if faces is not None:
                for row in faces:
                    x, y, box_width, box_height = map(float, row[:4])
                    left, top = max(0, x / width), max(0, y / height)
                    right, bottom = min(1, (x + box_width) / width), min(1, (y + box_height) / height)
                    detections.append({'box': {'x': left, 'y': top, 'width': right - left, 'height': bottom - top},
                                       'confidence': float(row[-1]),
                                       'faceOrientation': estimate_face_orientation(row)})
            self._last_targets = self._tracker.update(detections, pts_ms)
            self._last_pts = pts_ms
            return result('ready', copy.deepcopy(self._last_targets))
        except Exception:
            self.reset()
            return result('error', [])
