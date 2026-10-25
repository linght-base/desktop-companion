// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Realtime state does not duplicate the full day's diary on every body update.
 * The source records and full coverage remain available from the read-only API.
 */
export function projectStateForStream(state){
  const diary=state?.companion?.diary;
  if(!diary)return state;
  const {panels=[],gaps=[],...metadata}=diary;
  return {...state,companion:{...state.companion,diary:{...metadata,
    panelCount:panels.length,gapCount:gaps.length,detailsIncluded:false,
    detailUrl:`/api/diary${diary.day?`?day=${encodeURIComponent(diary.day)}`:''}`,
  }}};
}
