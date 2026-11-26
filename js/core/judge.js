// AI 评审：构造评审 prompt、解析评审输出。
import { ERROR_LABELS } from './errors.js';
import { QUALITY_PROBES } from './probes.js';

export const JUDGE_SYSTEM = [
  '你是一名严格、客观的 API 中转渠道质量评审员。',
  '你会收到某个中转站上某个模型的批量测试数据（成功率、错误、首字延迟、吞吐、抖动）和几道带标准答案的质量题回答。',
  '请综合「可用性 > 稳定性 > 速度 > 回答质量」的优先级给出 0-100 的分数。',
  '评分参考：成功率低于 90% 一般不应超过 60 分；频繁限流/无可用渠道/上游错误需重罚；首字延迟 P50 在 2 秒内属优秀，超过 8 秒属差；',
  '质量题回答明显不符合要求、答非所问或疑似被替换成弱模型时要扣分并在 issues 中指出。',
  '只输出一个 JSON 对象，不要代码块，不要任何额外文字。',
].join('\n');

const fmt = (x, d = 0) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

/** 构造逐项评审的用户消息。item: {siteName, model, stats, records} */
export function buildJudgePrompt(item) {
  const s = item.stats;
  const errorSamples = item.records
    .filter((r) => !r.ok && r.errorType !== 'aborted')
    .slice(0, 5)
    .map((r) => ({ 类型: ERROR_LABELS[r.errorType] || r.errorType, HTTP: r.status || null, 信息: (r.errorMessage || '').slice(0, 200) }));
  const probes = QUALITY_PROBES.filter((p) => item.records.some((x) => x.kind === 'probe' && x.probeId === p.id)).map((p) => {
    const r = item.records.find((x) => x.kind === 'probe' && x.probeId === p.id);
    return {
      题目: p.prompt,
      标准答案: p.expect,
      模型回答: r ? (r.ok ? (r.text || '').slice(0, 600) : `（请求失败：${r.errorLabel}）`) : '（未执行）',
      本地判分: r?.probeResult ? (r.probeResult.pass ? '通过' : '不通过') + `：${r.probeResult.detail}` : '无',
    };
  });
  const data = {
    站点: item.siteName,
    模型: item.model,
    统计: {
      请求总数: s.total,
      成功数: s.success,
      成功率: fmt(s.successRate * 100, 1) + '%',
      错误分布: Object.fromEntries(Object.entries(s.errors).map(([k, v]) => [ERROR_LABELS[k] || k, v])),
      首字延迟ms: { P50: fmt(s.ttft.p50), P95: fmt(s.ttft.p95), 最小: fmt(s.ttft.min), 最大: fmt(s.ttft.max) },
      总耗时ms: { P50: fmt(s.latency.p50), P95: fmt(s.latency.p95) },
      输出速度tokens每秒: { P50: fmt(s.tps.p50, 1), 平均: fmt(s.tps.avg, 1) },
      首字延迟变异系数: fmt(s.ttftCv, 2),
      流式响应占比: s.streamedRatio == null ? null : fmt(s.streamedRatio * 100) + '%',
    },
    错误样本: errorSamples,
    质量题: probes,
  };
  return [
    '以下是测试数据（JSON）：',
    JSON.stringify(data, null, 2),
    '',
    '请输出如下格式的 JSON：',
    '{"score": 0-100 的整数总分, "quality_score": 0-100 的整数（仅回答质量）, "verdict": "一句话结论（30 字以内）", "strengths": ["优点"], "issues": ["问题"], "suggestion": "给使用者的一句建议"}',
  ].join('\n');
}

/** 从评审输出中解析 JSON；失败返回 null。 */
export function parseJudgeResponse(text) {
  if (!text) return null;
  let s = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  const score = clampScore(obj.score);
  if (score == null) return null;
  return {
    score,
    qualityScore: clampScore(obj.quality_score),
    verdict: String(obj.verdict || '').slice(0, 200),
    strengths: toList(obj.strengths),
    issues: toList(obj.issues),
    suggestion: String(obj.suggestion || '').slice(0, 300),
  };
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean).slice(0, 8);
  if (typeof v === 'string' && v) return [v];
  return [];
}

// 自动挑选评审模型的偏好顺序（越靠前越优先）。
const JUDGE_PREFERENCE = [
  /claude-(opus|sonnet)-4/i,
  /claude-3[.-]7-sonnet/i,
  /^gpt-5(\.\d+)?(-chat)?(-latest)?$/i,
  /gpt-4\.1(?!-(mini|nano))/i,
  /gpt-4o(?!-mini)/i,
  /gemini-(2\.5|3)[\w.-]*-pro/i,
  /deepseek-(chat|v3|reasoner|r1)/i,
  /qwen3?-(max|plus)/i,
  /claude/i,
  /gpt-5/i,
];

/**
 * 从已添加站点中挑一个最适合当评审的模型。
 * sites: [{id, apiKey, models[]}]；只考虑有 Key 且拉到模型的站点。
 * @returns {{siteId:string, model:string}|null}
 */
export function pickJudgeModel(sites) {
  const usable = (sites || []).filter((s) => s.apiKey && s.models?.length);
  for (const re of JUDGE_PREFERENCE) {
    for (const s of usable) {
      const m = s.models.find((x) => re.test(x) && !/(embed|image|audio|tts|whisper|vision-preview|instruct)/i.test(x));
      if (m) return { siteId: s.id, model: m };
    }
  }
  return null;
}

export const SUMMARY_SYSTEM = '你是 API 中转渠道选型顾问。根据多个站点/模型的测评结果，用简洁中文给出结论。不要使用 Markdown 标题，可以用短段落和「·」开头的要点。';

/** rows: [{siteName, model, final, rule, ai, successRate, ttftP50, tpsP50, topErrors, verdict}] */
export function buildSummaryPrompt(rows) {
  const lines = rows.map((r, i) => ({
    排名: i + 1,
    站点: r.siteName,
    模型: r.model,
    综合分: r.final,
    规则分: r.rule,
    AI分: r.ai,
    成功率: r.successRate,
    首字延迟P50ms: r.ttftP50,
    输出速度P50: r.tpsP50,
    主要错误: r.topErrors,
    评审结论: r.verdict,
  }));
  return [
    '以下是本次批量测评的排行榜（JSON）：',
    JSON.stringify(lines, null, 2),
    '',
    '请输出 200-400 字的综合点评：1) 最推荐哪个站点/模型及原因；2) 哪些不建议使用及原因；3) 共性问题；4) 同一模型在不同站点间的差异（如有）。',
  ].join('\n');
}
