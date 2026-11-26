// 调度：站点 × 模型 × N 次请求，全局并发 + 每站并发，可中止；随后规则打分与 AI 评审。
import { runChat as defaultRunChat, completeOnce as defaultCompleteOnce, resolveProtocol } from './client.js';
import { detectSite as defaultDetectSite, balanceDelta } from './relay.js';
import { stabilityPrompt, probesFor, getProbe } from './probes.js';
import { computeStats, topErrors } from './stats.js';
import { ruleScore, combineScore, grade } from './scoring.js';
import { JUDGE_SYSTEM, buildJudgePrompt, parseJudgeResponse, SUMMARY_SYSTEM, buildSummaryPrompt } from './judge.js';
import { ERROR_LABELS } from './errors.js';

export class Semaphore {
  constructor(n) {
    this.free = Math.max(1, n | 0);
    this.waiters = [];
  }

  /** @returns {Promise<boolean>} false 表示在等待中被中止 */
  acquire(signal) {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const w = { resolve, signal, onAbort: null };
      w.onAbort = () => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(false);
      };
      signal?.addEventListener('abort', w.onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  release() {
    const w = this.waiters.shift();
    if (w) {
      w.signal?.removeEventListener('abort', w.onAbort);
      w.resolve(true);
    } else {
      this.free += 1;
    }
  }
}

export const MAX_GLOBAL_CONCURRENCY = 6;

/** 测试档位。每个模型请求数 = requestsPerModel + 质量题数。 */
export const PRESETS = {
  quick: { label: '快速', desc: '看通不通、大概快不快', requestsPerModel: 3, probeSet: 'basic' },
  standard: { label: '标准', desc: '日常对比几个站点', requestsPerModel: 6, probeSet: 'full' },
  deep: { label: '深度', desc: '认真挑渠道、看稳定性', requestsPerModel: 15, probeSet: 'full' },
};

export function presetOf(settings) {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.requestsPerModel === settings.requestsPerModel && p.probeSet === settings.probeSet) return key;
  }
  return 'custom';
}

export function requestsPerModelTotal(settings) {
  return settings.requestsPerModel + probesFor(settings.probeSet).length;
}

export const DEFAULT_SETTINGS = {
  requestsPerModel: 3,
  probeSet: 'basic',
  concurrencyPerSite: 3,
  // 浏览器对同一主机（本地代理）最多 6 个 HTTP/1.1 连接，超过会在浏览器内排队
  concurrencyGlobal: 6,
  ttftTimeoutSec: 30,
  totalTimeoutSec: 120,
  aiWeight: 0.4,
  favoriteKeywords: ['claude-sonnet-4', 'claude-opus-4', 'gpt-5', 'gemini-2.5-pro', 'deepseek'],
};

export function planJobs(sites, settings, rand = Math.random) {
  const jobs = [];
  for (const site of sites) {
    for (const model of site.selectedModels || []) {
      const requests = [];
      for (let i = 0; i < settings.requestsPerModel; i += 1) {
        requests.push({ kind: 'stability', prompt: stabilityPrompt(i, rand) });
      }
      for (const p of probesFor(settings.probeSet)) requests.push({ kind: 'probe', probeId: p.id, prompt: p.prompt });
      jobs.push({
        key: `${site.id}::${model}`,
        siteId: site.id,
        siteName: site.name,
        baseUrl: site.baseUrl,
        model,
        protocol: resolveProtocol(site.protocol, model),
        requests,
        records: [],
      });
    }
  }
  return jobs;
}

/** 同一站点内按模型轮转交错，让各模型进度均匀推进。 */
export function interleave(jobs) {
  const queues = jobs.map((j) => j.requests.map((r) => ({ job: j, req: r })));
  const out = [];
  for (let i = 0; queues.some((q) => i < q.length); i += 1) {
    for (const q of queues) if (i < q.length) out.push(q[i]);
  }
  return out;
}

function settingsSnapshot(settings, judge) {
  const { requestsPerModel, probeSet, concurrencyPerSite, concurrencyGlobal, ttftTimeoutSec, totalTimeoutSec, aiWeight } = settings;
  return {
    requestsPerModel, probeSet, probeCount: probesFor(probeSet).length,
    concurrencyPerSite, concurrencyGlobal, ttftTimeoutSec, totalTimeoutSec, aiWeight,
    judgeModel: judge?.enabled ? judge.model : null,
  };
}

/**
 * @param {object} p
 * @param {Array}  p.sites     [{id,name,baseUrl,apiKey,protocol,selectedModels}]
 * @param {object} p.settings
 * @param {object} [p.judge]   {enabled, baseUrl, apiKey, model, protocol}
 * @param {AbortSignal} [p.signal]
 * @param {Function} [p.onEvent]
 * @param {object} [p.deps]    注入依赖（测试用）
 */
export async function runBenchmark({ sites, settings: rawSettings, judge, signal, onEvent = () => {}, deps = {} }) {
  const settings = { ...DEFAULT_SETTINGS, ...rawSettings };
  const runChat = deps.runChat || defaultRunChat;
  const detectSite = deps.detectSite || defaultDetectSite;
  const completeOnce = deps.completeOnce || defaultCompleteOnce;
  const rand = deps.rand || Math.random;
  const emit = (e) => {
    try { onEvent(e); } catch (err) { console.error(err); }
  };

  const jobs = planJobs(sites, settings, rand);
  const run = {
    id: `run_${Date.now().toString(36)}_${Math.floor(rand() * 1e6).toString(36)}`,
    startedAt: Date.now(),
    finishedAt: null,
    aborted: false,
    settings: settingsSnapshot(settings, judge),
    sites: sites.map((s) => ({ id: s.id, name: s.name, baseUrl: s.baseUrl, type: s.type || 'unknown', balanceBefore: null, balanceAfter: null, cost: null })),
    items: [],
    summary: '',
    summaryError: '',
  };
  emit({ type: 'plan', jobs: jobs.map((j) => ({ key: j.key, siteName: j.siteName, model: j.model, protocol: j.protocol, total: j.requests.length })) });

  // 1) 测前余额
  emit({ type: 'phase', phase: 'balance', message: '查询测试前余额…' });
  await Promise.all(sites.map(async (s, i) => {
    const r = await detectSite(s.baseUrl, s.apiKey, { signal });
    run.sites[i].type = r.type;
    run.sites[i].balanceBefore = r.balance;
  }));

  // 2) 批量请求
  emit({ type: 'phase', phase: 'requests', message: '批量请求中…' });
  const global = new Semaphore(Math.min(MAX_GLOBAL_CONCURRENCY, settings.concurrencyGlobal));
  await Promise.all(sites.map(async (site) => {
    const queue = interleave(jobs.filter((j) => j.siteId === site.id));
    const worker = async () => {
      while (queue.length && !signal?.aborted) {
        const { job, req } = queue.shift();
        if (!(await global.acquire(signal))) break;
        let rec;
        try {
          rec = await runChat({
            baseUrl: site.baseUrl,
            apiKey: site.apiKey,
            model: job.model,
            protocol: job.protocol,
            prompt: req.prompt,
            signal,
            ttftTimeoutMs: settings.ttftTimeoutSec * 1000,
            totalTimeoutMs: settings.totalTimeoutSec * 1000,
          });
        } finally {
          global.release();
        }
        rec.kind = req.kind;
        if (req.kind === 'probe') {
          rec.probeId = req.probeId;
          rec.prompt = req.prompt;
          rec.probeResult = rec.ok ? getProbe(req.probeId).check(rec.text) : { pass: false, detail: '请求失败' };
        }
        rec.text = (rec.text || '').slice(0, req.kind === 'probe' ? 1500 : 300);
        if (rec.errorType === 'aborted') continue;
        job.records.push(rec);
        emit({ type: 'request', key: job.key, record: rec, done: job.records.length, total: job.requests.length });
      }
    };
    const n = Math.min(settings.concurrencyPerSite, queue.length);
    await Promise.all(Array.from({ length: n }, worker));
  }));
  run.aborted = !!signal?.aborted;

  // 3) 统计 + 规则分
  run.items = jobs.map((j) => {
    const stats = computeStats(j.records);
    const rule = ruleScore(stats);
    return {
      key: j.key, siteId: j.siteId, siteName: j.siteName, baseUrl: j.baseUrl, model: j.model, protocol: j.protocol,
      records: j.records, stats, rule, ai: null, aiError: '', final: rule.total, grade: grade(rule.total),
    };
  });
  emit({ type: 'scored', items: run.items });

  // 4) 测后余额（中止时也查，用于计算消耗）
  emit({ type: 'phase', phase: 'balance', message: '查询测试后余额…' });
  await Promise.all(sites.map(async (s, i) => {
    const r = await detectSite(s.baseUrl, s.apiKey, {});
    run.sites[i].balanceAfter = r.balance;
    run.sites[i].cost = balanceDelta(run.sites[i].balanceBefore, r.balance);
  }));

  // 5) AI 评审
  if (judge?.enabled && !signal?.aborted && run.items.length) {
    emit({ type: 'phase', phase: 'judge', message: `AI 评审中（${judge.model}）…` });
    const judgeQueue = run.items.filter((it) => it.stats.total > 0);
    const jSem = new Semaphore(2);
    await Promise.all(judgeQueue.map(async (it) => {
      if (!(await jSem.acquire(signal))) return;
      try {
        const r = await completeOnce({
          baseUrl: judge.baseUrl, apiKey: judge.apiKey, model: judge.model, protocol: judge.protocol,
          system: JUDGE_SYSTEM, prompt: buildJudgePrompt(it), signal,
        });
        if (!r.ok) {
          it.aiError = r.error;
        } else {
          const parsed = parseJudgeResponse(r.text);
          if (parsed) it.ai = parsed;
          else it.aiError = `无法解析评审输出：${r.text.slice(0, 120)}`;
        }
      } finally {
        jSem.release();
      }
      it.final = combineScore(it.rule.total, it.ai?.score, settings.aiWeight);
      it.grade = grade(it.final);
      emit({ type: 'judge', key: it.key, ai: it.ai, aiError: it.aiError, final: it.final });
    }));
  }

  run.items.sort((a, b) => b.final - a.final || b.stats.successRate - a.stats.successRate);

  if (judge?.enabled && !signal?.aborted && run.items.length > 1) {
    emit({ type: 'phase', phase: 'summary', message: 'AI 生成综合点评…' });
    const rows = run.items.map((it) => ({
      siteName: it.siteName,
      model: it.model,
      final: it.final,
      rule: it.rule.total,
      ai: it.ai?.score ?? null,
      successRate: `${(it.stats.successRate * 100).toFixed(1)}%`,
      ttftP50: it.stats.ttft.p50 == null ? null : Math.round(it.stats.ttft.p50),
      tpsP50: it.stats.tps.p50 == null ? null : Math.round(it.stats.tps.p50),
      topErrors: topErrors(it.stats.errors).map(([k, v]) => `${ERROR_LABELS[k] || k}×${v}`).join('，'),
      verdict: it.ai?.verdict || '',
    }));
    const r = await completeOnce({
      baseUrl: judge.baseUrl, apiKey: judge.apiKey, model: judge.model, protocol: judge.protocol,
      system: SUMMARY_SYSTEM, prompt: buildSummaryPrompt(rows), signal,
    });
    if (r.ok) run.summary = r.text.trim();
    else run.summaryError = r.error;
  }

  run.aborted = !!signal?.aborted;
  run.finishedAt = Date.now();
  emit({ type: 'done', run });
  return run;
}
