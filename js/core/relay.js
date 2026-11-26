// 中转站适配：URL 规范化、类型识别、余额、模型列表。
// new-api: GET /api/usage/token/ （Bearer）+ GET /api/status（quota_per_unit）
// sub2api: GET /v1/usage
import { fetchJson, bearer } from './http.js';

export const SITE_TYPE_LABELS = { newapi: 'new-api', sub2api: 'sub2api', generic: '通用兼容', unknown: '未检测' };

export function normalizeBaseUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/v1$/i, '');
  return u.replace(/\/+$/, '');
}

export function siteNameFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 批量导入：每行「地址 Key [名称]」，分隔符可为空白、逗号、竖线、制表符。 */
export function parseBulkImport(text) {
  const out = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const parts = s.split(/[\s,|]+/).filter(Boolean);
    const urlIdx = parts.findIndex((p) => /^https?:\/\//i.test(p) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(p));
    const keyIdx = parts.findIndex((p, j) => j !== urlIdx && /^(sk-|cr_|[A-Za-z0-9_-]{20,})/.test(p));
    if (urlIdx === -1 || keyIdx === -1) {
      errors.push(`第 ${i + 1} 行无法识别：${s.slice(0, 60)}`);
      return;
    }
    const baseUrl = normalizeBaseUrl(parts[urlIdx]);
    const rest = parts.filter((_, j) => j !== urlIdx && j !== keyIdx).join(' ');
    out.push({ baseUrl, apiKey: parts[keyIdx], name: rest || siteNameFromUrl(baseUrl) });
  });
  return { sites: out, errors };
}

/** new-api /api/usage/token/ 的 data → 统一余额结构（单位 USD）。 */
export function parseNewApiUsage(data, quotaPerUnit = 500000) {
  if (!data || typeof data !== 'object') return null;
  const per = quotaPerUnit > 0 ? quotaPerUnit : 500000;
  const unlimited = !!data.unlimited_quota;
  return {
    unit: 'USD',
    unlimited,
    remaining: unlimited ? null : num(data.total_available) / per,
    used: num(data.total_used) / per,
    expiresAt: data.expires_at > 0 ? data.expires_at * 1000 : null,
    note: data.name ? `令牌：${data.name}` : '',
  };
}

/** sub2api /v1/usage → 统一余额结构。 */
export function parseSub2apiUsage(json) {
  if (!json || typeof json !== 'object') return null;
  const remaining = json.remaining ?? json.quota?.remaining ?? json.balance;
  if (remaining === undefined && !json.mode) return null;
  const used = json.quota?.used ?? json.usage?.total?.actual_cost ?? json.usage?.total?.cost ?? null;
  const notes = [];
  if (json.planName) notes.push(`套餐：${json.planName}`);
  if (json.isValid === false) notes.push('Key 无效');
  if (json.status && json.status !== 'active') notes.push(`状态：${json.status}`);
  return {
    unit: json.quota?.unit || 'USD',
    unlimited: remaining == null || remaining < 0,
    remaining: remaining == null || remaining < 0 ? null : num(remaining),
    used: used == null ? null : num(used),
    expiresAt: json.subscription?.expires_at ? Date.parse(json.subscription.expires_at) || null : null,
    note: notes.join(' · '),
  };
}

export function parseModels(json) {
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const ids = list.map((m) => (typeof m === 'string' ? m : m?.id)).filter((x) => typeof x === 'string' && x);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 识别站点类型并查询余额。
 * @returns {Promise<{type:string, balance:object|null, error:string}>}
 */
export async function detectSite(baseUrl, apiKey, { fetchImpl, signal } = {}) {
  const auth = bearer(apiKey);
  const nu = await fetchJson(`${baseUrl}/api/usage/token/`, { headers: auth, fetchImpl, signal });
  if (nu.data && typeof nu.data === 'object' && typeof nu.data.code === 'boolean') {
    if (nu.data.code && nu.data.data) {
      const st = await fetchJson(`${baseUrl}/api/status`, { fetchImpl, signal });
      const per = Number(st.data?.data?.quota_per_unit) || 500000;
      return { type: 'newapi', balance: parseNewApiUsage(nu.data.data, per), error: '' };
    }
    return { type: 'newapi', balance: null, error: nu.data.message || '余额查询失败' };
  }
  const su = await fetchJson(`${baseUrl}/v1/usage`, { headers: auth, fetchImpl, signal });
  if (su.ok && su.data) {
    const bal = parseSub2apiUsage(su.data);
    if (bal) return { type: 'sub2api', balance: bal, error: '' };
  }
  if (su.data?.code && /API_KEY|INVALID|INSUFFICIENT/i.test(String(su.data.code))) {
    return { type: 'sub2api', balance: null, error: su.data.message || su.data.code };
  }
  return { type: 'generic', balance: null, error: '' };
}

/** @returns {Promise<{ok:boolean, models:string[], error:string}>} */
export async function listModels(baseUrl, apiKey, { fetchImpl, signal } = {}) {
  const r = await fetchJson(`${baseUrl}/v1/models`, { headers: bearer(apiKey), fetchImpl, signal });
  if (!r.ok) {
    const msg = r.error || r.data?.error?.message || r.data?.message || (r.text || '').slice(0, 200) || `HTTP ${r.status}`;
    return { ok: false, models: [], error: `拉取模型失败：${msg}` };
  }
  const models = parseModels(r.data);
  return { ok: models.length > 0, models, error: models.length ? '' : '模型列表为空' };
}

/** 按「常用模型关键字」预选（关键字不区分大小写，子串匹配）。 */
export function preselectModels(models, keywords) {
  const kws = (keywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return [];
  return models.filter((m) => kws.some((k) => m.toLowerCase().includes(k)));
}

export function balanceDelta(before, after) {
  if (!before || !after) return null;
  if (!before.unlimited && !after.unlimited && before.remaining != null && after.remaining != null) {
    return Math.max(0, before.remaining - after.remaining);
  }
  if (before.used != null && after.used != null) return Math.max(0, after.used - before.used);
  return null;
}
