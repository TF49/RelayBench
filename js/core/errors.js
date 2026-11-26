// 错误分类：依据 HTTP 状态码 + 错误体中的 code/type/message 关键字。
// 关键字来源：new-api relaykit/types/error.go、middleware；sub2api middleware 与 gateway_handler。

export const ERROR_LABELS = {
  auth: 'Key 无效/无权限',
  quota: '额度/余额不足',
  no_channel: '无可用渠道',
  model_not_found: '模型不存在',
  rate_limit: '限流',
  upstream: '上游错误',
  timeout: '超时',
  network: '网络/代理失败',
  stream_broken: '流中断',
  empty: '空回复',
  bad_request: '请求被拒',
  aborted: '已取消',
  other: '其他错误',
};

/** 从响应体文本中尽力提取 {code, type, message}。 */
export function parseErrorBody(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (!trimmed) return { code: '', type: '', message: '' };
  if (/^<!doctype html|^<html/i.test(trimmed)) {
    const title = (trimmed.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    return { code: '', type: 'html', message: `HTML 错误页${title ? `：${title.trim()}` : '（可能是 CDN/网关拦截）'}` };
  }
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { code: '', type: '', message: trimmed.slice(0, 500) };
  }
  return pickErrorFields(obj);
}

export function pickErrorFields(obj) {
  if (!obj || typeof obj !== 'object') return { code: '', type: '', message: String(obj ?? '') };
  const err = obj.error;
  if (err && typeof err === 'object') {
    return {
      code: str(err.code ?? obj.code),
      type: str(err.type ?? (obj.type !== 'error' ? obj.type : '')),
      message: str(err.message ?? obj.message),
    };
  }
  if (typeof err === 'string') return { code: str(obj.code), type: str(obj.type), message: err };
  return { code: str(obj.code), type: obj.type === 'error' ? '' : str(obj.type), message: str(obj.message ?? obj.detail ?? obj.msg) };
}

function str(v) {
  if (v === undefined || v === null || typeof v === 'boolean') return '';
  return String(v);
}

export function extractRequestId(message, headers) {
  const m = /request id:\s*([\w-]+)/i.exec(message || '');
  if (m) return m[1];
  if (headers && typeof headers.get === 'function') {
    for (const h of ['x-oneapi-request-id', 'x-request-id', 'x-client-request-id', 'request-id']) {
      const v = headers.get(h);
      if (v) return v;
    }
  }
  return '';
}

const has = (hay, ...needles) => needles.some((n) => hay.includes(n));

/**
 * @param {object} p
 * @param {number} [p.status]   HTTP 状态码（0/undefined 表示没有拿到响应）
 * @param {string} [p.code]
 * @param {string} [p.type]
 * @param {string} [p.message]
 * @param {string} [p.kind]     客户端侧原因：ttft_timeout | total_timeout | network | aborted | stream_broken | empty
 * @returns {{type: string, label: string}}
 */
export function classifyError({ status = 0, code = '', type = '', message = '', kind = '' } = {}) {
  const t = (x) => ({ type: x, label: ERROR_LABELS[x] });
  if (kind === 'aborted') return t('aborted');
  if (kind === 'ttft_timeout' || kind === 'total_timeout') return t('timeout');
  if (kind === 'stream_broken') return t('stream_broken');
  if (kind === 'empty') return t('empty');
  if (kind === 'network') return t('network');

  const hay = `${code} ${type} ${message}`.toLowerCase();

  // 渠道自身的 key 问题属于站点上游问题，不是用户 Key 问题，必须先于 auth 判断。
  if (has(hay, 'channel:invalid_key', 'channel:no_available_key')) return t('no_channel');
  if (has(hay, 'no available channel', 'no available accounts', 'get_channel_failed', '无可用渠道', 'no available provider'))
    return t('no_channel');
  if (has(hay, 'insufficient_user_quota', 'pre_consume_token_quota_failed', 'api_key_quota_exhausted',
    'insufficient_balance', 'insufficient_quota', 'quota exceeded', 'quota is not enough', '额度不足', '余额不足', '额度已用尽'))
    return t('quota');
  if (status === 402) return t('quota');
  if (has(hay, 'model_not_found', 'model not found', 'does not exist', '模型不存在', 'no such model', 'unsupported model', 'model_not_supported'))
    return t('model_not_found');
  if (status === 401 || has(hay, 'invalid_api_key', 'api_key_disabled', 'api_key_expired', 'invalid token', '无效的令牌', '令牌已过期', 'token expired', 'authentication_error', 'unauthorized'))
    return t('auth');
  if (status === 429 || has(hay, 'rate_limit', 'rate limit', 'too many requests', '请求过于频繁'))
    return t('rate_limit');
  if (has(hay, 'proxy_timeout', 'response_time_exceeded', 'timed out', 'timeout', '超时') || status === 504 || status === 524 || status === 408)
    return t('timeout');
  if (type === 'proxy_error') return t('network');
  if (status >= 500 || has(hay, 'upstream_error', 'bad_response_status_code', 'do_request_failed', 'overloaded', 'api_error'))
    return t('upstream');
  if (status === 403 || has(hay, 'access_denied', 'permission')) return t('auth');
  if (status >= 400) return t('bad_request');
  return t('other');
}
