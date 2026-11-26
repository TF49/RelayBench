// 规则分（0–100）与综合分。权重见设计文档第 6 节。

/** 线性插值打分：x 越小越好时 good<bad，越大越好时 good>bad。返回 0..1 */
export function linear(x, good, bad) {
  if (x == null || !Number.isFinite(x)) return 0;
  if (good < bad) {
    if (x <= good) return 1;
    if (x >= bad) return 0;
    return (bad - x) / (bad - good);
  }
  if (x >= good) return 1;
  if (x <= bad) return 0;
  return (x - bad) / (good - bad);
}

export function ruleScore(stats) {
  const availability = stats.successRate * 45;
  let speed = 0;
  let stability = 0;
  if (stats.success > 0) {
    const ttftPart = linear(stats.ttft.p50, 1000, 10000) * 15;
    // 无 TPS（全部非流式/回答极短）时，速度只按 TTFT 等比放大
    const tpsPart = stats.tps.p50 != null ? linear(stats.tps.p50, 60, 5) * 10 : (ttftPart / 15) * 10;
    speed = ttftPart + tpsPart;
    const cvPart = stats.ttftCv == null ? 0 : linear(stats.ttftCv, 0.2, 1.0) * 10;
    const tailPart = stats.tailRatio == null ? 0 : linear(stats.tailRatio, 1.5, 4) * 5;
    // 只有 1 个成功样本时无法评估抖动，给一半分
    stability = stats.success >= 2 ? cvPart + tailPart : 7.5;
  }
  const quality = stats.probesTotal ? (stats.probesPassed / stats.probesTotal) * 15 : 0;
  const total = Math.round(availability + speed + stability + quality);
  return {
    total,
    parts: {
      availability: round1(availability),
      speed: round1(speed),
      stability: round1(stability),
      quality: round1(quality),
    },
  };
}

export function grade(score) {
  if (score == null) return '-';
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

/** 综合分：aiWeight ∈ [0,1]，无 AI 分时等于规则分。 */
export function combineScore(rule, ai, aiWeight = 0.4) {
  if (ai == null || !Number.isFinite(ai)) return rule;
  const w = Math.min(1, Math.max(0, aiWeight));
  return Math.round(rule * (1 - w) + ai * w);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
