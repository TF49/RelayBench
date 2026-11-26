import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyError, parseErrorBody, extractRequestId } from '../js/core/errors.js';
import { SSEParser, interpretEvent, newAccumulator, runChat, parseFullResponse, resolveProtocol, buildRequest, estimateTokens } from '../js/core/client.js';
import { normalizeBaseUrl, parseBulkImport, parseNewApiUsage, parseSub2apiUsage, parseBillingUsage, parseModels, preselectModels, balanceDelta, detectSite } from '../js/core/relay.js';
import { percentile, computeStats } from '../js/core/stats.js';
import { ruleScore, grade, combineScore, linear } from '../js/core/scoring.js';
import { parseJudgeResponse, buildJudgePrompt } from '../js/core/judge.js';
import { QUALITY_PROBES, getProbe } from '../js/core/probes.js';
import { runBenchmark, Semaphore, planJobs, interleave } from '../js/core/runner.js';

// ---------------------------------------------------------------- errors
test('classifyError: new-api / sub2api 典型错误', () => {
  const c = (o) => classifyError(o).type;
  assert.equal(c({ status: 401, message: '无效的令牌' }), 'auth');
  assert.equal(c({ status: 403, code: 'insufficient_user_quota', message: '用户额度不足' }), 'quota');
  assert.equal(c({ status: 429, code: 'API_KEY_QUOTA_EXHAUSTED' }), 'quota');
  assert.equal(c({ status: 503, code: 'get_channel_failed', message: 'No available channel for model x under group default' }), 'no_channel');
  assert.equal(c({ status: 503, type: 'api_error', message: 'No available accounts' }), 'no_channel');
  assert.equal(c({ status: 500, code: 'channel:invalid_key' }), 'no_channel');
  assert.equal(c({ status: 404, code: 'model_not_found' }), 'model_not_found');
  assert.equal(c({ status: 429, type: 'rate_limit_error' }), 'rate_limit');
  assert.equal(c({ status: 502, type: 'upstream_error', message: 'bad gateway' }), 'upstream');
  assert.equal(c({ status: 504 }), 'timeout');
  assert.equal(c({ status: 502, type: 'proxy_error', message: '无法连接上游' }), 'network');
  assert.equal(c({ status: 400, message: 'invalid param' }), 'bad_request');
  assert.equal(c({ kind: 'ttft_timeout' }), 'timeout');
  assert.equal(c({ kind: 'aborted' }), 'aborted');
});

test('parseErrorBody: OpenAI / Claude / sub2api / HTML 形状', () => {
  assert.deepEqual(parseErrorBody('{"error":{"message":"m (request id: abc123)","type":"new_api_error","code":"x"}}'),
    { code: 'x', type: 'new_api_error', message: 'm (request id: abc123)' });
  assert.deepEqual(parseErrorBody('{"type":"error","error":{"type":"upstream_error","message":"u"}}'),
    { code: '', type: 'upstream_error', message: 'u' });
  assert.deepEqual(parseErrorBody('{"code":"INVALID_API_KEY","message":"bad"}'), { code: 'INVALID_API_KEY', type: '', message: 'bad' });
  assert.match(parseErrorBody('<!DOCTYPE html><html><title>502 Bad Gateway</title></html>').message, /502 Bad Gateway/);
  assert.equal(extractRequestId('oops (request id: 2026abc-1)'), '2026abc-1');
});

// ---------------------------------------------------------------- client
test('SSEParser 处理跨块分割与 event 字段', () => {
  const p = new SSEParser();
  let evs = p.push('event: message_start\ndata: {"a"');
  assert.equal(evs.length, 0);
  evs = p.push(':1}\n\ndata: [DONE]\n\n');
  assert.deepEqual(evs, [{ event: 'message_start', data: '{"a":1}' }, { event: '', data: '[DONE]' }]);
});

test('interpretEvent: OpenAI 流', () => {
  const acc = newAccumulator();
  assert.equal(interpretEvent({ data: '{"choices":[{"delta":{"role":"assistant"}}]}' }, acc).token, false);
  assert.equal(interpretEvent({ data: '{"choices":[{"delta":{"content":"Hi"}}]}' }, acc).token, true);
  interpretEvent({ data: '{"choices":[{"delta":{},"finish_reason":"stop"}]}' }, acc);
  interpretEvent({ data: '{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}' }, acc);
  interpretEvent({ data: '[DONE]' }, acc);
  assert.equal(acc.text, 'Hi');
  assert.equal(acc.usageOut, 7);
  assert.equal(acc.done, true);
});

test('interpretEvent: Anthropic 流与错误事件', () => {
  const acc = newAccumulator();
  interpretEvent({ event: 'message_start', data: '{"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}' }, acc);
  assert.equal(interpretEvent({ data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}' }, acc).token, true);
  interpretEvent({ data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}' }, acc);
  interpretEvent({ data: '{"type":"message_stop"}' }, acc);
  assert.equal(acc.text, '你好');
  assert.equal(acc.usageOut, 12);
  assert.equal(acc.done, true);
  const acc2 = newAccumulator();
  interpretEvent({ event: 'error', data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }, acc2);
  assert.equal(acc2.error.type, 'overloaded_error');
});

test('resolveProtocol / buildRequest', () => {
  assert.equal(resolveProtocol('auto', 'claude-sonnet-4-5'), 'anthropic');
  assert.equal(resolveProtocol('auto', 'gpt-5'), 'openai');
  assert.equal(resolveProtocol('openai', 'claude-x'), 'openai');
  const r = buildRequest({ baseUrl: 'https://a.com', apiKey: 'sk-1', model: 'claude-x', protocol: 'anthropic', prompt: 'hi', system: 's' });
  assert.equal(r.url, 'https://a.com/v1/messages');
  assert.equal(r.body.system, 's');
  assert.equal(r.headers['x-api-key'], 'sk-1');
  const o = buildRequest({ baseUrl: 'https://a.com', apiKey: 'sk-1', model: 'gpt', protocol: 'openai', prompt: 'hi' });
  assert.equal(o.url, 'https://a.com/v1/chat/completions');
  assert.equal(o.body.max_tokens, undefined);
  assert.deepEqual(o.body.stream_options, { include_usage: true });
});

test('parseFullResponse / estimateTokens', () => {
  assert.equal(parseFullResponse({ choices: [{ message: { content: 'x' } }], usage: { completion_tokens: 3 } }).usageOut, 3);
  assert.equal(parseFullResponse({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }).text, 'ab');
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('abcdefgh'), 2);
});

function sseResponse(chunks, { status = 200, delayMs = 0, contentType = 'text/event-stream' } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      for (const c of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        ctrl.enqueue(enc.encode(c));
      }
      ctrl.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

test('runChat: 成功流式请求计时与 token', async () => {
  let clock = 0;
  const fetchImpl = async (url, init) => {
    assert.match(url, /^\/api\/proxy\?target=/);
    assert.equal(init.headers['X-RB-Proxy'], '1');
    clock = 100;
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"completion_tokens":20}}\n\ndata: [DONE]\n\n',
    ]);
  };
  const ticks = [0, 400, 1400];
  const now = () => ticks.shift();
  const rec = await runChat({ baseUrl: 'https://x.com', apiKey: 'k', model: 'gpt', protocol: 'openai', prompt: 'p', fetchImpl, now });
  assert.equal(rec.ok, true, rec.errorMessage);
  assert.equal(rec.text, 'Hello world');
  assert.equal(rec.ttftMs, 400);
  assert.equal(rec.totalMs, 1400);
  assert.equal(rec.outputTokens, 20);
  assert.equal(rec.tps, 20);
  assert.ok(clock);
});

test('runChat: 扣除浏览器/代理排队时间', async () => {
  // t0=0；响应头在 300ms 到达，但代理说上游只用了 50ms → 排队 250ms
  const ticks = [0, 300, 700, 1700];
  const now = () => ticks.shift();
  const fetchImpl = async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const h = new Headers(res.headers);
    h.set('x-rb-upstream-ms', '50');
    return new Response(res.body, { status: 200, headers: h });
  };
  const rec = await runChat({ baseUrl: 'https://x.com', apiKey: 'k', model: 'gpt', protocol: 'openai', prompt: 'p', fetchImpl, now });
  assert.equal(rec.ok, true, rec.errorMessage);
  assert.equal(rec.queueMs, 250);
  assert.equal(rec.ttftMs, 450);
  assert.equal(rec.totalMs, 1450);
});

test('runChat: HTTP 错误、断流、空回复、首字超时', async () => {
  const base = { baseUrl: 'https://x.com', apiKey: 'k', model: 'gpt', protocol: 'openai', prompt: 'p' };
  let rec = await runChat({ ...base, fetchImpl: async () => new Response('{"error":{"message":"No available channel for model gpt (request id: r1)","code":"get_channel_failed"}}', { status: 503 }) });
  assert.equal(rec.errorType, 'no_channel');
  assert.equal(rec.requestId, 'r1');

  rec = await runChat({ ...base, fetchImpl: async () => sseResponse(['data: {"choices":[{"delta":{"content":"half"}}]}\n\n']) });
  assert.equal(rec.errorType, 'stream_broken');

  rec = await runChat({ ...base, fetchImpl: async () => sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']) });
  assert.equal(rec.errorType, 'empty');

  rec = await runChat({
    ...base,
    ttftTimeoutMs: 50,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  assert.equal(rec.errorType, 'timeout');
  assert.match(rec.errorMessage, /首字超时/);

  rec = await runChat({ ...base, fetchImpl: async () => new Response('{"choices":[{"message":{"content":"ok"}}],"usage":{"completion_tokens":2}}', { headers: { 'content-type': 'application/json' } }) });
  assert.equal(rec.ok, true);
  assert.equal(rec.streamed, false);
});

// ---------------------------------------------------------------- relay
test('normalizeBaseUrl / parseBulkImport', () => {
  assert.equal(normalizeBaseUrl('api.foo.com/v1/'), 'https://api.foo.com');
  assert.equal(normalizeBaseUrl('http://1.2.3.4:3000'), 'http://1.2.3.4:3000');
  const { sites, errors } = parseBulkImport('https://a.com/v1 sk-abcdefghijklmnop 站点A\nb.com,sk-zzzzzzzzzzzzzzzzzz\n# 注释\n乱写一行');
  assert.equal(sites.length, 2);
  assert.deepEqual(sites[0], { baseUrl: 'https://a.com', apiKey: 'sk-abcdefghijklmnop', name: '站点A' });
  assert.equal(sites[1].name, 'b.com');
  assert.equal(errors.length, 1);
});

test('余额解析与消耗计算', () => {
  const nb = parseNewApiUsage({ total_available: 5000000, total_used: 500000, unlimited_quota: false, expires_at: 0, name: 't' }, 500000);
  assert.equal(nb.remaining, 10);
  assert.equal(nb.used, 1);
  assert.equal(parseNewApiUsage({ unlimited_quota: true, total_used: 0 }).unlimited, true);
  const sb = parseSub2apiUsage({ mode: 'quota_limited', isValid: true, remaining: 3.5, quota: { limit: 10, used: 6.5, remaining: 3.5, unit: 'USD' } });
  assert.equal(sb.remaining, 3.5);
  assert.equal(sb.used, 6.5);
  assert.equal(parseSub2apiUsage({ foo: 1 }), null);
  assert.equal(balanceDelta({ remaining: 10, used: 1 }, { remaining: 9.25, used: 1.75 }), 0.75);
  assert.equal(balanceDelta({ unlimited: true, remaining: null, used: 1 }, { unlimited: true, remaining: null, used: 1.5 }), 0.5);
});

test('detectSite: new-api / sub2api / 通用', async () => {
  const mk = (routes) => async (url) => {
    const target = decodeURIComponent(url.split('target=')[1]);
    const path = new URL(target).pathname;
    const r = routes[path];
    return r ? new Response(JSON.stringify(r)) : new Response('404 page not found', { status: 404 });
  };
  let d = await detectSite('https://n.com', 'k', { fetchImpl: mk({ '/api/usage/token/': { code: true, data: { total_available: 1000000, total_used: 0 } }, '/api/status': { success: true, data: { quota_per_unit: 1000000 } } }) });
  assert.equal(d.type, 'newapi');
  assert.equal(d.balance.remaining, 1);
  d = await detectSite('https://s.com', 'k', { fetchImpl: mk({ '/v1/usage': { mode: 'unrestricted', balance: 8, remaining: 8 } }) });
  assert.equal(d.type, 'sub2api');
  assert.equal(d.balance.remaining, 8);
  d = await detectSite('https://o.com', 'k', { fetchImpl: mk({ '/dashboard/billing/subscription': { object: 'billing_subscription', hard_limit_usd: 20, access_until: 0 }, '/dashboard/billing/usage': { object: 'list', total_usage: 550 } }) });
  assert.equal(d.type, 'oneapi');
  assert.equal(d.balance.remaining, 14.5);
  assert.equal(d.balance.used, 5.5);
  d = await detectSite('https://g.com', 'k', { fetchImpl: mk({}) });
  assert.equal(d.type, 'generic');
});

test('parseBillingUsage: 无限额度', () => {
  assert.equal(parseBillingUsage({ hard_limit_usd: 100000000 }, { total_usage: 0 }).unlimited, true);
  assert.equal(parseBillingUsage({}, {}), null);
});

test('parseModels / preselectModels', () => {
  const m = parseModels({ object: 'list', data: [{ id: 'gpt-5' }, { id: 'claude-sonnet-4-5' }, { id: 'gpt-5' }] });
  assert.deepEqual(m, ['claude-sonnet-4-5', 'gpt-5']);
  assert.deepEqual(preselectModels(m, ['Sonnet']), ['claude-sonnet-4-5']);
});

// ---------------------------------------------------------------- stats / scoring
test('percentile / computeStats', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([], 50), null);
  const recs = [
    { ok: true, ttftMs: 1000, totalMs: 2000, tps: 50, streamed: true, kind: 'stability' },
    { ok: true, ttftMs: 1000, totalMs: 2000, tps: 50, streamed: true, kind: 'probe', probeResult: { pass: true } },
    { ok: false, errorType: 'rate_limit', kind: 'stability' },
    { ok: false, errorType: 'aborted', kind: 'stability' },
  ];
  const s = computeStats(recs);
  assert.equal(s.total, 3);
  assert.equal(s.success, 2);
  assert.deepEqual(s.errors, { rate_limit: 1 });
  assert.equal(s.ttftCv, 0);
  assert.equal(s.probesPassed, 1);
});

test('ruleScore / grade / combineScore', () => {
  assert.equal(linear(500, 1000, 10000), 1);
  assert.equal(linear(5500, 1000, 10000), 0.5);
  assert.equal(linear(32.5, 60, 5), 0.5);
  const perfect = { successRate: 1, success: 10, ttft: { p50: 800 }, tps: { p50: 80 }, ttftCv: 0.1, tailRatio: 1.2, probesTotal: 4, probesPassed: 4 };
  assert.equal(ruleScore(perfect).total, 100);
  const dead = { successRate: 0, success: 0, ttft: { p50: null }, tps: { p50: null }, ttftCv: null, tailRatio: null, probesTotal: 4, probesPassed: 0 };
  assert.equal(ruleScore(dead).total, 0);
  assert.equal(grade(91), 'S');
  assert.equal(grade(59), 'D');
  assert.equal(combineScore(80, 60, 0.4), 72);
  assert.equal(combineScore(80, null, 0.4), 80);
});

// ---------------------------------------------------------------- probes / judge
test('质量题本地判分', () => {
  assert.equal(getProbe('arith').check('1905').pass, true);
  assert.equal(getProbe('arith').check('37×48=1776，1776+129=1,905').pass, true);
  assert.equal(getProbe('arith').check('1900').pass, false);
  assert.equal(getProbe('format').check('APPLE, BANANA, CHERRY').pass, true);
  assert.equal(getProbe('format').check('Apple,Banana,Cherry').pass, false);
  assert.equal(getProbe('json').check('{"name":"relay","count":3,"tags":["a","b"]}').pass, true);
  assert.equal(getProbe('json').check('```json\n{"name":"relay","count":3,"tags":["a","b"]}\n```').pass, true);
  assert.equal(getProbe('json').check('{"name":"relay"}').pass, false);
  assert.equal(getProbe('reason').check('<think>5-2+3=6, 6/2=3</think>3').pass, true);
  assert.equal(QUALITY_PROBES.length, 4);
});

test('parseJudgeResponse 容错', () => {
  const j = parseJudgeResponse('好的：\n```json\n{"score": 87.6, "quality_score": "90", "verdict":"稳定", "strengths":"快", "issues":[], "suggestion":"可用"}\n```');
  assert.equal(j.score, 88);
  assert.equal(j.qualityScore, 90);
  assert.deepEqual(j.strengths, ['快']);
  assert.equal(parseJudgeResponse('not json'), null);
  assert.equal(parseJudgeResponse('{"score":"abc"}'), null);
  assert.equal(parseJudgeResponse('{"score":150}').score, 100);
});

test('buildJudgePrompt 包含统计与质量题', () => {
  const stats = computeStats([{ ok: true, ttftMs: 900, totalMs: 1500, tps: 40, streamed: true, kind: 'probe', probeId: 'arith', text: '1905', probeResult: { pass: true, detail: '答案正确' } }]);
  const p = buildJudgePrompt({ siteName: 'A', model: 'm', stats, records: [{ ok: true, kind: 'probe', probeId: 'arith', text: '1905', probeResult: { pass: true, detail: '答案正确' } }] });
  assert.match(p, /"站点": "A"/);
  assert.match(p, /1905/);
  assert.doesNotMatch(p, /sk-/);
});

// ---------------------------------------------------------------- runner
test('Semaphore 限制并发且可中止', async () => {
  const s = new Semaphore(1);
  assert.equal(await s.acquire(), true);
  const ctrl = new AbortController();
  const p = s.acquire(ctrl.signal);
  ctrl.abort();
  assert.equal(await p, false);
  s.release();
  assert.equal(await s.acquire(), true);
});

test('planJobs / interleave', () => {
  const jobs = planJobs([{ id: 's1', name: 'S', baseUrl: 'u', protocol: 'auto', selectedModels: ['a', 'claude-b'] }], { requestsPerModel: 2, qualityProbes: true });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].requests.length, 6);
  assert.equal(jobs[1].protocol, 'anthropic');
  const order = interleave(jobs).map((x) => x.job.model);
  assert.deepEqual(order.slice(0, 4), ['a', 'claude-b', 'a', 'claude-b']);
});

test('runBenchmark 端到端（注入依赖）', async () => {
  let active = 0;
  let peak = 0;
  const runChat = async ({ model, prompt }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    if (model === 'bad') return { ok: false, errorType: 'upstream', errorLabel: '上游错误', errorMessage: 'x', status: 502 };
    const probe = QUALITY_PROBES.find((p) => p.prompt === prompt);
    return { ok: true, ttftMs: 500, totalMs: 1500, tps: 70, streamed: true, outputTokens: 70, text: probe ? probe.expect : '一段解释' };
  };
  const detectSite = async () => ({ type: 'newapi', balance: { unit: 'USD', remaining: 10, used: 0 }, error: '' });
  const judged = [];
  const completeOnce = async ({ prompt }) => {
    judged.push(prompt);
    return prompt.includes('排行榜')
      ? { ok: true, text: '推荐 good。' }
      : { ok: true, text: '{"score":90,"quality_score":95,"verdict":"好","strengths":[],"issues":[],"suggestion":""}' };
  };
  const events = [];
  const run = await runBenchmark({
    sites: [{ id: 's1', name: 'S1', baseUrl: 'https://s1', apiKey: 'sk-secret', protocol: 'auto', selectedModels: ['good', 'bad'] }],
    settings: { requestsPerModel: 3, concurrencyPerSite: 2, concurrencyGlobal: 8 },
    judge: { enabled: true, baseUrl: 'https://j', apiKey: 'jk', model: 'judge', protocol: 'openai' },
    onEvent: (e) => events.push(e.type),
    deps: { runChat, detectSite, completeOnce },
  });
  assert.ok(peak <= 2, `peak=${peak}`);
  assert.equal(run.items.length, 2);
  assert.equal(run.items[0].model, 'good');
  assert.equal(run.items[0].stats.successRate, 1);
  assert.equal(run.items[0].rule.total, 100);
  assert.equal(run.items[0].final, 96);
  assert.equal(run.items[1].stats.errors.upstream, 7);
  assert.equal(run.summary, '推荐 good。');
  assert.equal(judged.length, 3);
  assert.ok(events.includes('done'));
  assert.doesNotMatch(JSON.stringify(run), /sk-secret|"jk"/);
});

test('runBenchmark 中止后跳过评审并标记 aborted', async () => {
  const ctrl = new AbortController();
  let n = 0;
  const runChat = async () => {
    n += 1;
    if (n === 2) ctrl.abort();
    return { ok: true, ttftMs: 1, totalMs: 2, text: 'x', streamed: true };
  };
  let judgedCalls = 0;
  const run = await runBenchmark({
    sites: [{ id: 's', name: 'S', baseUrl: 'u', apiKey: 'k', selectedModels: ['m'] }],
    settings: { requestsPerModel: 10, qualityProbes: false, concurrencyPerSite: 1 },
    judge: { enabled: true, model: 'j' },
    signal: ctrl.signal,
    deps: { runChat, detectSite: async () => ({ type: 'generic', balance: null }), completeOnce: async () => { judgedCalls += 1; return { ok: false }; } },
  });
  assert.equal(run.aborted, true);
  assert.equal(run.items[0].records.length, 2);
  assert.equal(judgedCalls, 0);
});
