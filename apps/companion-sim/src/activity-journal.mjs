// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const MAX_ENTRIES = 200;
const MAX_DEPTH = 4;
const MAX_LOOKUPS = 1024;
const MAX_SEGMENTS = 64;
const MAX_FRAMES = 64;
const MAX_REFERENCES = 65;
const MAX_TEXT = 500;
const VISUAL_SOURCES = new Set(['camera', 'replay']);
const MAX_TIMESTAMP = 8640000000000000;

function text(value, name, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function at(value, name = 'at') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) throw new TypeError(`Invalid ${name}`);
  return value;
}
function zoneOffsetMs(timeZone, instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const field = type => Number(parts.find(part => part.type === type).value);
  const asUtc = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'));
  return asUtc - (instant - (instant % 1000));
}
function localMidnight(day, timeZone) {
  const guess = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(guess)) throw new TypeError('Invalid day');
  const first = guess - zoneOffsetMs(timeZone, guess);
  return guess - zoneOffsetMs(timeZone, first);
}
function dayBounds(day, timeZone) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('Invalid day');
  if (typeof timeZone !== 'string' || !timeZone) throw new TypeError('Invalid timeZone');
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { throw new TypeError('Invalid timeZone'); }
  const [year, month, date] = day.split('-').map(Number);
  const nextDay = new Date(Date.UTC(year, month - 1, date) + 86400000).toISOString().slice(0, 10);
  const start = localMidnight(day, timeZone);
  const end = localMidnight(nextDay, timeZone);
  const check = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  if (check.format(start) !== day || check.format(end) !== nextDay || end <= start) throw new TypeError('Invalid day');
  return { start, end };
}
function explicitRange(startAt, endAt) {
  if ((startAt === undefined) !== (endAt === undefined)) throw new TypeError('Invalid range');
  if (startAt === undefined) return null;
  const start = at(startAt, 'startAt');
  const end = at(endAt, 'endAt');
  if (end <= start || end - start > 172800000) throw new TypeError('Invalid range');
  return { start, end };
}
function clipTime(value, { start, end }) {
  return Number.isSafeInteger(value) && value >= start && value < end;
}
function clipSegment(segment, bounds) {
  if (!segment || typeof segment !== 'object') return null;
  const startAt = at(segment.startAt, 'segment start');
  const endAt = at(segment.endAt, 'segment end');
  if (endAt < startAt) throw new TypeError('Invalid segment');
  const clippedStart = Math.max(startAt, bounds.start);
  const clippedEnd = Math.min(endAt, bounds.end);
  if (clippedEnd < clippedStart || clippedEnd <= bounds.start || clippedStart >= bounds.end) return null;
  return { startAt: clippedStart, endAt: clippedEnd };
}
function unionDurationMs(segments) {
  const sorted = [...segments].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  let total = 0;
  let current = null;
  for (const segment of sorted) {
    if (!current || segment.startAt > current.endAt) {
      if (current) total += current.endAt - current.startAt;
      current = { ...segment };
    } else if (segment.endAt > current.endAt) current.endAt = segment.endAt;
  }
  if (current) total += current.endAt - current.startAt;
  return total;
}

/** Read-only visible-activity timeline over continuity diary and evidence. No images, timers, network, model, or body calls. */
export function createActivityJournal({ clock = Date.now, readDiary, readEvidence } = {}) {
  if (typeof clock !== 'function') throw new TypeError('Invalid clock');
  if (typeof readDiary !== 'function') throw new TypeError('Invalid readDiary');
  if (typeof readEvidence !== 'function') throw new TypeError('Invalid readEvidence');
  let closed = false;
  function assertOpen() {
    if (closed) throw new TypeError('Activity journal closed');
  }
  function isVisualPerception(record, deskId) {
    return record && typeof record === 'object' && record.kind === 'perception'
      && record.status === 'active' && record.deskId === deskId && VISUAL_SOURCES.has(record.source);
  }
  function entryFor(perception, via, bounds) {
    const frameTimes = [...new Set((Array.isArray(perception.frameTimes) ? perception.frameTimes : [])
      .filter(value => clipTime(value, bounds)))].sort((a, b) => a - b).slice(0, MAX_FRAMES);
    const visibleSegments = (Array.isArray(perception.visibleSegments) ? perception.visibleSegments : [])
      .map(segment => { try { return clipSegment(segment, bounds); } catch { return null; } })
      .filter(Boolean).slice(0, MAX_SEGMENTS);
    const gaps = (Array.isArray(perception.gaps) ? perception.gaps : [])
      .map(gap => {
        const clipped = (() => { try { return clipSegment(gap, bounds); } catch { return null; } })();
        return clipped && clipped.endAt > clipped.startAt
          ? { ...clipped, ...(typeof gap.reason === 'string' ? { reason: gap.reason.slice(0, MAX_TEXT) } : {}) }
          : null;
      }).filter(Boolean).slice(0, MAX_SEGMENTS);
    const evidenceRefs = [{ id: text(perception.id, 'evidence id', 200), revision: at(perception.revision, 'revision') }];
    for (const step of via) {
      if (evidenceRefs.length >= MAX_REFERENCES) break;
      evidenceRefs.push({ id: step.id, revision: step.revision });
    }
    return {
      id: perception.id,
      activity: text(perception.activity, 'activity'),
      source: perception.source,
      deskId: perception.deskId,
      evidenceRefs,
      observedAt: clipTime(perception.observedAt, bounds) ? perception.observedAt : (frameTimes.at(-1) ?? null),
      frameTimes,
      visibleSegments,
      observedDurationMs: unionDurationMs(visibleSegments),
      gaps,
      uncertainties: (Array.isArray(perception.uncertainties) ? perception.uncertainties : [])
        .filter(value => typeof value === 'string').map(value => value.slice(0, MAX_TEXT)).slice(0, 32),
      actorStatus: 'unconfirmed',
      entityLabels: (Array.isArray(perception.entityLabels) ? perception.entityLabels : (perception.entities ?? []).map(entity => entity?.label))
        .filter(value => typeof value === 'string').map(value => value.slice(0, 200)).slice(0, 32),
    };
  }
  function forDay({ day, deskId, timeZone = 'Asia/Shanghai', startAt, endAt } = {}) {
    assertOpen();
    deskId = text(deskId, 'deskId', 200);
    const range = explicitRange(startAt, endAt);
    const natural = dayBounds(day, timeZone); // day/timeZone stay validated even when an explicit range replaces the natural day
    const bounds = range ?? natural;
    const diary = readDiary(range ? { day, deskId, timeZone, startAt, endAt } : { day, deskId, timeZone });
    if (!diary || typeof diary !== 'object' || !Array.isArray(diary.panels)) throw new TypeError('Invalid diary');
    const panels = diary.panels.slice(0, 500);
    const entries = [];
    const seen = new Set();
    let lookups = 0;
    const addPerception = (perception, via) => {
      if (entries.length >= MAX_ENTRIES || seen.has(perception.id)) return;
      if (!isVisualPerception(perception, deskId) || typeof perception.activity !== 'string' || !perception.activity.trim()) return;
      seen.add(perception.id);
      entries.push(entryFor(perception, via, bounds));
    };
    const addComposed = panel => {
      if(panel.episodeType!=='composed'||typeof panel.activity!=='string'||!panel.activity.trim())return false;
      if(lookups>=MAX_LOOKUPS)return true;
      let current;try{lookups++;current=readEvidence(panel.id,{deskId});}catch{return true;}
      if(!current||current.kind!=='episode'||current.status!=='active'||current.revision!==panel.revision||current.deskId!==deskId)return true;
      const references=current.evidenceIds??[];
      if(!references.length||references.length>64)return true;
      const parts=[];
      for(const id of references){
        if(lookups>=MAX_LOOKUPS)return true;
        let record;try{lookups++;record=readEvidence(id,{deskId});}catch{return true;}
        if(!isVisualPerception(record,deskId)||record.source!==current.source||record.revision!==current.evidenceRevisions?.[id])return true;
        parts.push(entryFor({...record,activity:record.activity??current.activity},[],bounds));
      }
      const frameTimes=[...new Set(parts.flatMap(part=>part.frameTimes))].sort((a,b)=>a-b);
      if(!frameTimes.length)return true;
      const visibleSegments=parts.flatMap(part=>part.visibleSegments);
      const entry={
        id:current.id,episodeType:'composed',activity:current.activity,summary:current.summary,
        semanticStatus:'model_summarized',source:current.source,deskId,
        evidenceRefs:[{id:current.id,revision:current.revision},...parts.map(part=>part.evidenceRefs[0])],
        observedAt:frameTimes[0],startAt:frameTimes[0],endAt:frameTimes.at(-1),frameTimes,
        visibleSegments,observedDurationMs:unionDurationMs(visibleSegments),continuousDurationKnown:false,
        gaps:[...parts.flatMap(part=>part.gaps),...frameTimes.slice(1).map((at,i)=>({startAt:frameTimes[i],endAt:at,reason:'采样之间的活动未经连续确认'}))],
        uncertainties:[...new Set([...parts.flatMap(part=>part.uncertainties),'起止为观测包络，不能作为持续工作时长'])],
        actorStatus:'unconfirmed',entityLabels:[...new Set(parts.flatMap(part=>part.entityLabels))],
      };
      for(const id of references)seen.add(id);seen.add(current.id);entries.push(entry);return true;
    };
    const resolve = (record, depth, visited, via) => {
      if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;
      const references = (Array.isArray(record.evidenceIds) ? record.evidenceIds : []).slice(0, MAX_REFERENCES);
      for (const id of references) {
        if (entries.length >= MAX_ENTRIES || lookups >= MAX_LOOKUPS) return;
        if (typeof id !== 'string' || visited.has(id)) continue;
        visited.add(id);
        lookups += 1;
        let evidence = null;
        try { evidence = readEvidence(id, { deskId }); } catch { continue; }
        if (!evidence || typeof evidence !== 'object') continue;
        if (isVisualPerception(evidence, deskId)) {
          addPerception(evidence, [...via, { id: record.id, revision: at(record.revision ?? 1, 'revision') }]);
        } else if (evidence.kind === 'episode' && evidence.status === 'active' && evidence.deskId === deskId) {
          resolve(evidence, depth + 1, visited, [...via, { id: record.id, revision: at(record.revision ?? 1, 'revision') }]);
        }
      }
    };
    for (const panel of panels) {
      if (entries.length >= MAX_ENTRIES) break;
      if (!panel || typeof panel !== 'object' || panel.status !== 'active') continue;
      // Interactions, understandings and hypotheses never count as visible activity.
      if (panel.kind === 'perception') addPerception(panel, []);
      else if (panel.kind === 'episode'&&!addComposed(panel)) resolve(panel, 0, new Set([panel.id]), []);
    }
    entries.sort((a, b) => (a.observedAt ?? 0) - (b.observedAt ?? 0));
    const gaps = (Array.isArray(diary.gaps) ? diary.gaps : [])
      .map(gap => {
        const clipped = (() => { try { return clipSegment(gap, bounds); } catch { return null; } })();
        if (!clipped || clipped.endAt <= clipped.startAt) return null;
        return { ...clipped, ...(typeof gap.reason === 'string' ? { reason: gap.reason.slice(0, MAX_TEXT) } : {}),
          ...(typeof gap.source === 'string' ? { source: gap.source.slice(0, 100) } : {}) };
      }).filter(Boolean).slice(0, MAX_SEGMENTS);
    const allSegments = entries.flatMap(entry => entry.visibleSegments);
    const allFrames = entries.flatMap(entry => entry.frameTimes);
    return {
      day, deskId,
      startAt: bounds.start, endAt: bounds.end,
      entries,
      gaps,
      totalPanelCount:diary.totalPanelCount??panels.length,
      omittedPanelCount:diary.omittedPanelCount??0,
      coverage: {
        observedFrameCount: allFrames.length,
        firstFrameAt: allFrames.length ? Math.min(...allFrames) : null,
        lastFrameAt: allFrames.length ? Math.max(...allFrames) : null,
        note: `仅离散采样帧；帧间、断流、遮挡与镜头转动期间未观察，采样点和流统计不构成持续覆盖${diary.omittedPanelCount?`；本次有界概览省略${diary.omittedPanelCount}条片段，不能当作完整活动清单`:''}`,
      },
      totalObservedDurationMs: unionDurationMs(allSegments),
      continuousDurationKnown: false,
      generatedAt: at(clock(), 'clock'),
    };
  }
  return {
    forDay,
    snapshot(input = {}) { return forDay(input); },
    close() { closed = true; },
  };
}
