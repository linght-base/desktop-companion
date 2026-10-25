# Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Native cognitive badges: compact single-stroke vector icons before the status footer.

The host/model picks badges explicitly (no inference anywhere in this module);
each badge is one pen stroke on the shared 412x412 accessory canvas. Paths are
authored in a local 30px box (x 0-30, y 305-335, inside the y 300-338 footer
band) as bold 28-30px silhouettes with negative-space detail, so they stay
recognizable on the round face; companion_device translates them by
COGNITIVE_SLOT_X so badge i lands centered at x 120/150/180, then shifts the
status glyphs right by COGNITIVE_LABEL_SHIFT per active badge. Web renders the
identical shapes in local 0-30 space. COGNITIVE_STROKE_WIDTH is the suggested
pen width for these badges on both runtimes.
"""
COGNITIVE_ICONS = ("office", "home", "person", "cup", "keyboard", "book", "plant", "focus", "rest", "question")

COGNITIVE_MAX_BADGES = 3
COGNITIVE_SLOT_X = (105, 135, 165)
COGNITIVE_LABEL_SHIFT = 12
COGNITIVE_STROKE_WIDTH = 3

COGNITIVE_BADGE_PATHS = {
    # Multi-storey block: outline + center mullion + two floor lines = 6-pane window grid.
    "office": ["M4 335 L4 307 L26 307 L26 335 Z L15 335 L15 307 L4 307 L4 317 L26 317 L26 325 L4 325 L4 335"],
    # Pitched roof with eaves over a square body, door cut from the baseline.
    "home": ["M1 320 L15 307 L29 320 L26 320 L26 335 L4 335 L4 320 Z L4 320 L4 335 L11 335 L11 326 L19 326 L19 335"],
    # Round (octagon) head on flared shoulders, closed by the baseline.
    "person": ["M3 335 L6 326 L11 321 L9 317 L9 311 L12 307 L18 307 L21 311 L21 317 L19 321 L24 326 L27 335 Z"],
    # Tall mug body with a distinct handle loop on the right.
    "cup": ["M5 335 L5 307 L21 307 L21 335 Z L21 335 L21 313 L28 313 L28 324 L21 324"],
    # Wide slab with a 3x3 key grid (two mullions, two rows).
    "keyboard": ["M2 307 L2 335 L28 335 L28 307 Z L2 335 L11 335 L11 307 L20 307 L20 335 L28 335 L28 326 L2 326 L2 316 L28 316"],
    # Open book: W top edge, V bottom edge, central spine drop.
    "book": ["M2 310 L8 307 L15 310 L22 307 L28 310 L28 335 L22 332 L15 335 L8 332 L2 335 Z L8 307 L15 310 L15 335"],
    # Seedling: stem with two opposite angular leaves.
    "plant": ["M15 335 L15 323 L9 320 L3 313 L11 315 L15 317 L21 314 L27 307 L19 310 L15 313"],
    # Bullseye: two concentric rings joined at the top, center tick.
    "focus": ["M15 306 L25 310 L29 320 L25 330 L15 334 L5 330 L1 320 L5 310 Z L15 314 L19 316 L21 320 L19 324 L15 326 L11 324 L9 320 L11 316 L15 314 L15 318 L15 322"],
    # Crescent moon opening to the right.
    "rest": ["M20 307 L7 311 L2 321 L7 331 L20 335 L12 328 L8 321 L12 314 Z"],
    # Question mark: hooked arch, short stem, diamond dot.
    "question": ["M10 314 L10 310 L13 307 L19 307 L22 310 L22 315 L15 319 L15 326 L19 330 L15 335 L11 330 L15 326"],
}
