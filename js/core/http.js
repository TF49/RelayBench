// 所有出站请求都经本地代理（见 server.py）。

export function proxyUrl(target) {
  return `/api/proxy?target=${encodeURIComponent(target)}`;
}

/** 经代理发请求；fetchImpl 可注入（测试用）。 */
export function proxyFetch(target, { method = 'GET', headers = {}, body, signal, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch.bind(globalThis);
  return f(proxyUrl(target), {
    method,
    headers: { ...headers, 'X-RB-Proxy': '1' },
    body,
    signal,
    cache: 'no-store',
  });
}

/**
 * 请求并解析 JSON，带超时。不抛异常。
 * @returns {Promise<{ok:boolean,status:number,data:any,text:string,error?:string}>}
 */
export async function fetchJson(target, { method = 'GET', headers = {}, body, timeoutMs = 15000, signal, fetchImpl } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await proxyFetch(target, { method, headers, body, signal: ctrl.signal, fetchImpl });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, data, text };
  } catch (e) {
    return { ok: false, status: 0, data: null, text: '', error: ctrl.signal.aborted ? '请求超时' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function bearer(key) {
  return { Authorization: `Bearer ${key}` };
}
