// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as streamOpenAICompatible } from '@earendil-works/pi-ai/api/openai-completions';
import {reportingFetch,sanitizeProviderFailure} from './provider-failure.mjs';

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function model(id, provider, baseUrl) {
  return { id, name: id, api: 'openai-completions', provider, baseUrl, input: ['text', 'image'], reasoning: false, cost: zeroCost, contextWindow: 32768, maxTokens: 1024 };
}
function fixtureMessage(model, content, stopReason = 'stop') {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...zeroCost, total: 0 } } };
}
function fixtureOutput(model, transcript) {
  const eventIndex = transcript.messages.findLastIndex(m => m.role === 'user' && (typeof m.content==='string'?m.content:m.content?.find(c=>c.type==='text')?.text)?.includes('"event"'));
  const currentMessages=transcript.messages.slice(Math.max(0,eventIndex));
  const results = currentMessages.filter(m => m.role === 'toolResult');
  const result = name => results.find(m => m.toolName === name);
  const value = name => {
    const entry = result(name);
    if (!entry || entry.isError) return null;
    try { return JSON.parse(entry.content.find(c => c.type === 'text')?.text); } catch { return null; }
  };
  const call = (name, args) => fixtureMessage(model, [{ type: 'toolCall', id: `fixture-${results.length}-${name}`, name, arguments: args }], 'toolUse');
  const done = () => fixtureMessage(model, [{ type: 'text', text: 'Offline fixture completed software feedback only; no image recognition was performed.' }]);
  const input = currentMessages.find(m => m.role === 'user');
  const inputText = typeof input?.content === 'string' ? input.content : input?.content.find(c => c.type === 'text')?.text;
  let event;
  try { event = JSON.parse(inputText).event; } catch { /* unknown input needs no follow-up */ }
  if(event?.kind==='diary'){
    const candidates=event.payload?.panels??[];
    if(candidates.length&&!result('compose_comic'))return call('compose_comic',{panels:candidates.slice(0,6).map(r=>({basisId:r.id,objects:(r.entities??[]).slice(0,3).map((e,i)=>({entityId:e.id,shape:'rect',x:.15+i*.2,y:.4,width:.15,height:.2})),robot:{gazeX:0,gazeY:0,openness:.6}}))});
    return done();
  }
  if (!result('observe')) return call('observe', {});
  const observed = value('observe');
  if (!observed) return done();
  // Explicit accelerated demo goals may exercise the real lifecycle, never image semantics.
  if (event?.kind === 'reminder') {
    if ((event.payload?.demo === true || event.payload?.source === 'demo') && !result('respond_reminder')) return call('respond_reminder', {id:event.payload.id,decision:'show',basisObservationId:observed.id,reason:'Explicit offline demo delivery; no visual understanding.'});
    return done();
  }
  // A generic bounded gesture is software feedback only. Never manufacture a
  // personal memory, infer image contents or schedule a technical reminder.
  if (!result('express')) return call('express', { basisObservationId: observed.id, durationMs: 1200, head: { yaw: 8, pitch: -3 }, eyes: { gazeX: 0.15, gazeY: 0, openness: 0.9, tilt: 0, roundness: 0.8, color: '#76DCC5' }, icon: 'none', gesture: 'wave' });
  return done();
}

/** Only this deterministic model transport is fake; Pi executes and feeds back every tool. */
export function createFixtureProvider(config = {}) {
  const fixtureModel = model('offline-fixture', 'companion-fixture', 'offline://fixture');
  const delayMs = Math.max(0, Math.min(10000, Number(config.delayMs) || 0));
  return {
    model: fixtureModel,
    streamFn: config.streamFn ?? ((selectedModel, transcript, options = {}) => {
      const stream = new AssistantMessageEventStream();
      let finished = false;
      let timer;
      const finish = aborted => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        const message = aborted ? fixtureMessage(selectedModel, [], 'aborted') : fixtureOutput(selectedModel, transcript);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        if (aborted) stream.push({ type: 'error', reason: 'aborted', error: message });
        else stream.push({ type: 'done', reason: message.stopReason, message });
      };
      const abort = () => finish(true);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) queueMicrotask(abort);
      else timer = setTimeout(() => finish(false), delayMs);
      return stream;
    }),
  };
}

/** Explicit server-process configuration; no stored credentials or implicit provider discovery. */
export function createCloudProvider(config = {}) {
  const apiKey = config.apiKey ?? process.env.COMPANION_MODEL_API_KEY;
  const id = config.model ?? config.modelId ?? process.env.COMPANION_MODEL_ID;
  const baseUrl = config.baseUrl ?? process.env.COMPANION_MODEL_BASE_URL;
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof id !== 'string' || !id.trim() || typeof baseUrl !== 'string') throw new Error('Cloud model requires explicit API key, model and base URL');
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('Cloud model base URL is invalid'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Cloud model base URL is invalid');
  // Provider behavior is explicitly selected by the host; no credential discovery.
  const selectedProvider = config.provider ?? process.env.COMPANION_MODEL_PROVIDER ?? 'openai-compatible';
  if (!['openai-compatible', 'minimax'].includes(selectedProvider)) throw new Error('Unsupported cloud provider compatibility');
  const minimax = selectedProvider === 'minimax';
  const effort = config.reasoningEffort ?? process.env.COMPANION_MODEL_REASONING_EFFORT ?? 'low';
  if (minimax && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Unsupported MiniMax reasoning effort');
  const configuredTokens = config.maxTokens ?? process.env.COMPANION_MODEL_MAX_TOKENS;
  const maxTokens = configuredTokens === undefined ? (minimax ? 8192 : 1024) : Number(configuredTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 16384) throw new Error('Invalid cloud answer budget');
  const cloudModel = model(id, 'companion-cloud', endpoint.href.replace(/\/$/, ''));
  cloudModel.maxTokens = maxTokens;
  if (config.compat) cloudModel.compat = config.compat;
  if (minimax) {
    cloudModel.reasoning = true;
    cloudModel.compat = { ...config.compat, supportsStore:false, supportsDeveloperRole:false, supportsReasoningEffort:true, maxTokensField:'max_completion_tokens', requiresThinkingAsText:false, requiresReasoningContentOnAssistantMessages:true, thinkingFormat:'openai' };
    cloudModel.samplingParams = { thinking:{type:'adaptive'} };
  }
  return {
    model: cloudModel,
    thinkingLevel: minimax ? effort : 'off',
    streamFn: (selectedModel, transcript, options={}) => {
      const {onFailure,...requestOptions}=options;
      const report=failure=>{if(!options.signal?.aborted){try{onFailure?.(sanitizeProviderFailure(failure));}catch{/* Host observation cannot change the request. */}}};
      return streamOpenAICompatible(selectedModel, transcript, { ...requestOptions, apiKey, maxRetries: 0, timeoutMs: 30000, maxTokens:Math.min(maxTokens,requestOptions.maxTokens??maxTokens), ...(minimax ? { reasoning:effort } : {}),
        fetch:reportingFetch(requestOptions.fetch??globalThis.fetch,{signal:options.signal,onFailure:report}),
        onProviderStreamEvent:(data,model)=>{
          if(data?.choices?.some(choice=>choice.finish_reason==='network_error'))report({kind:'network',retryable:true});
          return requestOptions.onProviderStreamEvent?.(data,model);
        },
      });
    },
  };
}
