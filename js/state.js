// 全局状态 + 持久化。Key 只在内存，除非站点/评审勾选「记住 Key」。
import { db } from './store/db.js';
import { DEFAULT_SETTINGS, MAX_GLOBAL_CONCURRENCY } from './core/runner.js';
import { pickJudgeModel } from './core/judge.js';

const listeners = new Set();

export const state = {
  sites: [],          // {id,name,baseUrl,apiKey,rememberKey,protocol,type,balance,models[],selectedModels[],detectError,checkedAt}
  settings: { ...DEFAULT_SETTINGS },
  // source: 'site' = 用已添加站点的模型（siteId+model 为空时自动挑选）；'custom' = 单独填写的渠道
  judge: { enabled: true, source: 'site', siteId: '', model: '', baseUrl: '', apiKey: '', protocol: 'auto', rememberKey: false },
  runs: [],           // 历史摘要（完整记录按需从 IndexedDB 读）
  current: null,      // 正在运行或刚完成的 run 的实时视图
  viewingRun: null,   // 报告页正在看的 run
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(what) {
  for (const fn of listeners) fn(what);
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function siteForStorage(s) {
  const { apiKey, ...rest } = s;
  return s.rememberKey ? { ...rest, apiKey } : rest;
}

export async function loadAll() {
  const [sites, settings, judge, runs] = await Promise.all([
    db.getAll('sites'),
    db.getKV('settings', null),
    db.getKV('judge', null),
    db.getAll('runs'),
  ]);
  state.sites = (sites || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => ({ apiKey: '', ...s }));
  if (settings) state.settings = { ...DEFAULT_SETTINGS, ...settings };
  state.settings.concurrencyGlobal = Math.min(MAX_GLOBAL_CONCURRENCY, state.settings.concurrencyGlobal);
  state.settings.concurrencyPerSite = Math.min(MAX_GLOBAL_CONCURRENCY, state.settings.concurrencyPerSite);
  if (judge) {
    // 旧版本配置没有 source 字段：填过地址+模型的视为自定义，否则改为默认的「自动从站点挑选」并启用
    const migrated = judge.source ? judge : {
      ...judge,
      source: judge.baseUrl && judge.model ? 'custom' : 'site',
      enabled: judge.baseUrl && judge.model ? judge.enabled : true,
      model: judge.baseUrl ? judge.model : '',
    };
    state.judge = { ...state.judge, apiKey: '', ...migrated };
  }
  state.runs = (runs || []).map(runSummary).sort((a, b) => b.startedAt - a.startedAt);
}

export async function saveSite(site) {
  await db.put('sites', siteForStorage(site));
}

export async function addSite(partial) {
  const site = {
    id: uid('site'),
    name: partial.name,
    baseUrl: partial.baseUrl,
    apiKey: partial.apiKey || '',
    rememberKey: !!partial.rememberKey,
    protocol: partial.protocol || 'auto',
    type: 'unknown',
    balance: null,
    models: [],
    selectedModels: [],
    detectError: '',
    checkedAt: null,
    order: Date.now(),
  };
  state.sites.push(site);
  await saveSite(site);
  notify('sites');
  return site;
}

export async function updateSite(id, patch) {
  const site = state.sites.find((s) => s.id === id);
  if (!site) return null;
  Object.assign(site, patch);
  await saveSite(site);
  notify('sites');
  return site;
}

export async function removeSite(id) {
  state.sites = state.sites.filter((s) => s.id !== id);
  await db.delete('sites', id);
  notify('sites');
}

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await db.setKV('settings', state.settings);
  notify('settings');
}

export async function saveJudge(patch) {
  state.judge = { ...state.judge, ...patch };
  const { apiKey, ...rest } = state.judge;
  await db.setKV('judge', state.judge.rememberKey ? { ...rest, apiKey } : rest);
  notify('settings');
}

/**
 * 解析出本次实际使用的评审渠道。
 * @returns {{baseUrl, apiKey, model, protocol, label, auto:boolean}|null} null 表示没有可用评审
 */
export function resolveJudge() {
  const j = state.judge;
  if (!j.enabled) return null;
  if (j.source === 'custom') {
    if (!j.baseUrl || !j.apiKey || !j.model) return null;
    return { baseUrl: j.baseUrl, apiKey: j.apiKey, model: j.model, protocol: j.protocol, label: j.baseUrl, auto: false };
  }
  let site = state.sites.find((s) => s.id === j.siteId && s.apiKey);
  let model = j.model;
  let auto = false;
  if (!site || !model) {
    const pick = pickJudgeModel(state.sites);
    if (!pick) return null;
    site = state.sites.find((s) => s.id === pick.siteId);
    model = pick.model;
    auto = true;
  }
  return { baseUrl: site.baseUrl, apiKey: site.apiKey, model, protocol: site.protocol, label: site.name, auto };
}

export function runSummary(run) {
  const best = run.items?.[0];
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    aborted: run.aborted,
    siteCount: run.sites?.length || 0,
    itemCount: run.items?.length || 0,
    requestCount: (run.items || []).reduce((n, it) => n + it.stats.total, 0),
    best: best ? { siteName: best.siteName, model: best.model, final: best.final } : null,
    judged: (run.items || []).some((it) => it.ai),
  };
}

export async function saveRun(run) {
  await db.put('runs', run);
  state.runs = [runSummary(run), ...state.runs.filter((r) => r.id !== run.id)];
  notify('runs');
}

export async function loadRun(id) {
  return db.get('runs', id);
}

export async function deleteRun(id) {
  await db.delete('runs', id);
  state.runs = state.runs.filter((r) => r.id !== id);
  if (state.viewingRun?.id === id) state.viewingRun = null;
  notify('runs');
}
