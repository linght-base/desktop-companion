// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// Render vocabulary only. Pi selects meaning from grounded context.
// Shapes mirror scripts/companion_cognition.py exactly: same single-stroke
// paths in the local 0-30 box (native y = local y + 305 on the 412 canvas).
export const COGNITIVE_STROKE_WIDTH=3;
export const COGNITIVE_PATHS=Object.freeze({
 office:'M4 30L4 2H26V30H4M15 30V2H4M4 12H26M26 20H4V30',
 home:'M1 15L15 2L29 15H26V30H4V15H1M4 15V30H11V21H19V30',
 person:'M3 30L6 21L11 16L9 12V6L12 2H18L21 6V12L19 16L24 21L27 30H3',
 cup:'M5 30V2H21V30H5M21 30V8H28V19H21',
 keyboard:'M2 2V30H28V2H2M2 30H11V2H20V30H28M28 21H2V11H28',
 book:'M2 5L8 2L15 5L22 2L28 5V30L22 27L15 30L8 27L2 30V5M8 2L15 5V30',
 plant:'M15 30V18L9 15L3 8L11 10L15 12L21 9L27 2L19 5L15 8',
 focus:'M15 1L25 5L29 15L25 25L15 29L5 25L1 15L5 5L15 1V9L19 11L21 15L19 19L15 21L11 19L9 15L11 11L15 9V13V17',
 rest:'M20 2L7 6L2 16L7 26L20 30L12 23L8 16L12 9L20 2',
 question:'M10 9V5L13 2H19L22 5V10L15 14V21L19 25L15 30L11 25L15 21'
});
export function cognitiveItems(value){const items=Array.isArray(value)?value:value?.items;return (items??[]).filter(x=>Object.hasOwn(COGNITIVE_PATHS,x.icon)).slice(0,3);}
