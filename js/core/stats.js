// 统计：成功率、错误分布、TTFT/总耗时分位数、TPS、抖动。

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const idx = (p / 100) * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

export function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function stddev(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/**
 * @param {Array} records  runChat 的结果，可带 kind:'stability'|'probe' 与 probe 判分 probeResult
 * 取消（aborted）的请求不计入。
 */
export function computeStats(records) {
  const rs = records.filter((r) => r.errorType !== 'aborted');
  const ok = rs.filter((r) => r.ok);
  const errors = {};
  for (const r of rs) if (!r.ok) errors[r.errorType] = (errors[r.errorType] || 0) + 1;

  const ttft = ok.map((r) => r.ttftMs).filter(Number.isFinite);
  const total = ok.map((r) => r.totalMs).filter(Number.isFinite);
  const tps = ok.map((r) => r.tps).filter(Number.isFinite);
  const ttftMean = mean(ttft);
  const probes = rs.filter((r) => r.kind === 'probe');

  return {
    total: rs.length,
    success: ok.length,
    successRate: rs.length ? ok.length / rs.length : 0,
    errors,
    ttft: { avg: ttftMean, p50: percentile(ttft, 50), p95: percentile(ttft, 95), min: ttft.length ? Math.min(...ttft) : null, max: ttft.length ? Math.max(...ttft) : null },
    latency: { avg: mean(total), p50: percentile(total, 50), p95: percentile(total, 95) },
    tps: { avg: mean(tps), p50: percentile(tps, 50) },
    ttftCv: ttftMean ? stddev(ttft) / ttftMean : null,
    tailRatio: percentile(total, 50) ? percentile(total, 95) / percentile(total, 50) : null,
    probesTotal: probes.length,
    probesPassed: probes.filter((r) => r.ok && r.probeResult?.pass).length,
    streamedRatio: ok.length ? ok.filter((r) => r.streamed).length / ok.length : null,
  };
}

/** 主要错误（按次数降序），用于表格摘要。 */
export function topErrors(errors, n = 2) {
  return Object.entries(errors || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
}
