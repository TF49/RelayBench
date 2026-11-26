// 报告视图：冠军卡、AI 综合点评、余额消耗、排行榜（Flip 排序）、逐项详情、导出。
import { state, loadRun } from '../state.js';
import { ERROR_LABELS } from '../core/errors.js';
import { QUALITY_PROBES } from '../core/probes.js';
import { topErrors } from '../core/stats.js';
import { SITE_TYPE_LABELS } from '../core/relay.js';
import {
  esc, fmtMs, fmtPct, fmtNum, fmtTime, fmtDuration, fmtBalance, fmtMoney, scoreColor, download, $,
} from './dom.js';
import { icon } from './icons.js';
import { flipCapture, flipPlay, expandIn, motionOn } from './motion.js';

const ui = { sort: { key: 'final', dir: -1 }, open: new Set() };
let rootRef = null;

const COLS = [
  { key: 'final', label: '综合分', get: (it) => it.final },
  { key: 'rule', label: '规则分', get: (it) => it.rule.total },
  { key: 'ai', label: 'AI 分', get: (it) => it.ai?.score ?? -1 },
  { key: 'successRate', label: '成功率', get: (it) => it.stats.successRate },
  { key: 'ttftP50', label: '首字 P50', get: (it) => it.stats.ttft.p50 ?? Infinity, asc: true },
  { key: 'ttftP95', label: '首字 P95', get: (it) => it.stats.ttft.p95 ?? Infinity, asc: true },
  { key: 'tpsP50', label: 'TPS P50', get: (it) => it.stats.tps.p50 ?? -1 },
];

export function render(root) {
  rootRef = root;
  root.onclick = onClick;
  root.onsubmit = null;
  root.onchange = null;
  if (!state.viewingRun && state.runs.length) {
    root.innerHTML = '<div class="empty"><span class="radar" style="margin:0 auto"></span></div>';
    loadRun(state.runs[0].id).then((run) => {
      state.viewingRun = run || null;
      if (rootRef === root && root.isConnected) {
        draw();
        import('./motion.js').then((m) => m.enterView(root));
      }
    });
    return;
  }
  draw();
}

export function onState(what) {
  if (!rootRef?.isConnected) return;
  if (what === 'runs' || what === 'run') draw();
}

const ring = (value, size = 92) => `
  <div class="ring" data-ring="${value}" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="15.9155" pathLength="100"/><circle class="ring-val" cx="18" cy="18" r="15.9155" pathLength="100" style="stroke:${scoreColor(value)}"/></svg>
    <div class="ring-num" data-count="${value}">${value}</div>
  </div>`;

function draw() {
  const run = state.viewingRun;
  if (!run) {
    rootRef.innerHTML = `
      <div class="page-head"><div><div class="eyebrow">03 · Report</div><h1 data-split>测试报告</h1></div></div>
      <div class="panel empty" data-reveal>${icon('report', 28)}<h3 style="margin-top:12px">还没有测试报告</h3><p>到 <a href="#run">测试</a> 页开始一次批量测试，跑完会自动来到这里。</p></div>`;
    return;
  }
  const reqs = run.items.reduce((n, it) => n + it.stats.total, 0);
  const best = [...run.items].sort((a, b) => b.final - a.final)[0];
  rootRef.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">03 · Report</div>
        <h1 data-split>测试报告</h1>
        <p>${esc(fmtTime(run.startedAt))} · 用时 ${fmtDuration(run.finishedAt - run.startedAt)} · ${run.sites.length} 个站点 · ${run.items.length} 个站点×模型 · ${reqs} 次请求
          · 每模型 ${run.settings.requestsPerModel} 次${probeCountOf(run) ? ` + ${probeCountOf(run)} 道质量题` : ''}${run.settings.judgeModel ? ` · 评审 ${esc(run.settings.judgeModel)}` : ''}
          ${run.aborted ? ' <span class="badge warn">中途停止</span>' : ''}</p>
      </div>
      <div class="actions">
        <button class="btn" data-act="csv">${icon('download', 15)}导出 CSV</button>
        <button class="btn" data-act="json">${icon('download', 15)}导出 JSON</button>
      </div>
    </div>

    ${aiNotice(run)}

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:22px;align-items:stretch">
      ${best ? `
      <section class="panel panel-pad spotlight" data-reveal data-tilt>
        <div class="section-title" style="display:flex;align-items:center;gap:6px">${icon('gauge', 14)}本次最佳</div>
        <div class="score-head" style="margin:6px 0 0">
          ${ring(best.final, 104)}
          <div style="min-width:0">
            <div class="mono" style="font-size:16px;font-weight:600;color:var(--text);word-break:break-all">${esc(best.model)}</div>
            <div class="muted" style="margin:2px 0 10px">${esc(best.siteName)}</div>
            <div class="actions" style="gap:6px">
              <span class="grade ${esc(best.grade)}" data-scramble>${esc(best.grade)}</span>
              <span class="badge ok">成功率 ${fmtPct(best.stats.successRate, 0)}</span>
              <span class="badge">首字 ${fmtMs(best.stats.ttft.p50)}</span>
            </div>
          </div>
        </div>
        ${best.ai?.verdict ? `<div class="verdict" style="margin:18px 0 0">“${esc(best.ai.verdict)}”</div>` : ''}
      </section>` : ''}
      ${run.summary ? `
      <section class="panel panel-pad spotlight" data-reveal>
        <div class="summary">
          <div class="summary-ic">${icon('spark', 24)}</div>
          <div><h2 style="margin-bottom:6px">AI 综合点评</h2><div class="summary-text">${esc(run.summary)}</div></div>
        </div>
      </section>` : ''}
    </div>
    ${run.summaryError ? `<div class="notice bad" style="margin-top:16px">${icon('x', 15)}<span>综合点评生成失败：${esc(run.summaryError)}</span></div>` : ''}

    <div class="balance-strip" style="margin-top:26px">
      ${run.sites.map((s) => `
        <article class="panel balance-card spotlight glare" data-reveal>
          <div class="t">${icon('wallet', 15)}${esc(s.name)} <span class="badge">${esc(SITE_TYPE_LABELS[s.type] || s.type)}</span></div>
          <div class="muted" style="font-size:12px">本次消耗</div>
          <div class="cost" ${s.cost != null ? `data-count="${s.cost}" data-format="money"` : ''}>${s.cost == null ? '—' : esc(fmtMoney(s.cost, s.balanceAfter?.unit || 'USD'))}</div>
          <div class="faint" style="font-size:12px;margin-top:6px">余额 ${esc(fmtBalance(s.balanceBefore))} → ${esc(fmtBalance(s.balanceAfter))}</div>
        </article>`).join('')}
    </div>

    <section class="panel" style="margin-top:26px" data-reveal>
      <div class="panel-pad" style="padding-bottom:4px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">${icon('layers', 16)}排行榜</h2>
        <span class="faint" style="font-size:12px">点击表头排序，点击行展开详情</span>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead data-head>${headTemplate()}</thead>
        <tbody data-board>${boardTemplate(run)}</tbody>
      </table></div>
    </section>
    <p class="faint" style="font-size:12px;margin-top:14px">规则分 = 可用性 45 + 速度 25 + 稳定性 15 + 质量 15；综合分 = 规则分 × ${fmtNum(1 - run.settings.aiWeight, 1)} + AI 分 × ${fmtNum(run.settings.aiWeight, 1)}（无 AI 分时等于规则分）。</p>`;
  // 首屏：展开的详情需要直接显示最终状态
  rootRef.querySelectorAll('.detail').forEach(animateDetailBars);
}

function headTemplate() {
  return `<tr>
    <th>#</th><th>站点 / 模型</th>
    ${COLS.map((c) => `<th class="num sortable ${ui.sort.key === c.key ? 'sorted' : ''}" data-sort="${c.key}">${c.label}${ui.sort.key === c.key ? `<span class="arrow">${ui.sort.dir < 0 ? '▼' : '▲'}</span>` : ''}</th>`).join('')}
    <th>主要错误</th><th>AI 结论</th>
  </tr>`;
}

function boardTemplate(run) {
  return sortedItems(run).map((it, i) => rowTemplate(it, i)).join('');
}

function probeCountOf(run) {
  // 旧记录只有 qualityProbes 布尔值（当时固定 4 道）
  return run.settings.probeCount ?? (run.settings.qualityProbes ? QUALITY_PROBES.length : 0);
}

function aiNotice(run) {
  const wrap = (cls, text) => `<div class="notice ${cls}" style="margin-bottom:22px">${icon('spark', 15)}<span>${text}</span></div>`;
  if (!run.settings.judgeModel) {
    return wrap('', `本次没有进行 AI 评审，只有规则分${run.aborted ? '（测试中途停止时不做评审）' : ''}。可在 <a href="#settings">设置</a> 中启用后重新测试。`);
  }
  const judged = run.items.filter((it) => it.stats.total > 0);
  const failed = judged.filter((it) => !it.ai);
  if (judged.length && failed.length === judged.length) {
    return wrap('bad', `AI 评审全部失败（评审模型 ${esc(run.settings.judgeModel)}）：${esc(failed[0].aiError || '未知错误')}。请到 <a href="#settings">设置</a> 点「测试评审连接」排查。`);
  }
  if (failed.length) {
    return wrap('', `${failed.length} 项 AI 评审失败，这些项只用规则分。原因示例：${esc(failed[0].aiError || '')}`);
  }
  return '';
}

function sortedItems(run) {
  const col = COLS.find((c) => c.key === ui.sort.key) || COLS[0];
  return [...run.items].sort((a, b) => (col.get(a) - col.get(b)) * ui.sort.dir);
}

function rowTemplate(it, i) {
  const open = ui.open.has(it.key);
  const errs = topErrors(it.stats.errors).map(([k, v]) => `<span class="badge bad">${esc(ERROR_LABELS[k] || k)} ×${v}</span>`).join(' ');
  const s = it.stats;
  return `
    <tr class="clickable ${open ? 'open' : ''}" data-row="${esc(it.key)}" data-flip-id="${esc(it.key)}" aria-expanded="${open}">
      <td><span class="rank ${i < 3 ? 'top' : ''}">${String(i + 1).padStart(2, '0')}</span></td>
      <td><div class="cell-main mono" style="font-size:13px">${esc(it.model)}</div><div class="cell-sub">${esc(it.siteName)}</div></td>
      <td class="num"><span class="score-cell" style="color:${scoreColor(it.final)}"><span data-count="${it.final}">${it.final}</span><span class="grade ${esc(it.grade)}">${esc(it.grade)}</span></span></td>
      <td class="num">${it.rule.total}</td>
      <td class="num">${it.ai ? `<b>${it.ai.score}</b>` : `<span class="faint" title="${esc(it.aiError)}">—</span>`}</td>
      <td class="num">${fmtPct(s.successRate)} <span class="faint">${s.success}/${s.total}</span></td>
      <td class="num">${fmtMs(s.ttft.p50)}</td>
      <td class="num">${fmtMs(s.ttft.p95)}</td>
      <td class="num">${fmtNum(s.tps.p50)}</td>
      <td>${errs || '<span class="faint">—</span>'}</td>
      <td><div class="ellipsis" title="${esc(it.ai?.verdict || it.aiError)}">${esc(it.ai?.verdict || '')}</div></td>
    </tr>
    ${open ? `<tr data-detail="${esc(it.key)}" data-flip-id="d-${esc(it.key)}"><td colspan="${COLS.length + 4}" class="detail-cell">${detailTemplate(it)}</td></tr>` : ''}`;
}

function detailTemplate(it) {
  const s = it.stats;
  const parts = [
    ['可用性', it.rule.parts.availability, 45],
    ['速度', it.rule.parts.speed, 25],
    ['稳定性', it.rule.parts.stability, 15],
    ['质量', it.rule.parts.quality, 15],
  ];
  const fails = it.records.filter((r) => !r.ok);
  return `<div class="detail">
    <section class="panel panel-pad" data-reveal>
      <h2>${icon('gauge', 16)}规则分构成</h2>
      <div class="score-head">
        ${ring(it.rule.total)}
        <div class="parts">${parts.map(([n, v, max]) => `
          <div class="part"><span class="muted">${n}</span><div class="bar"><div style="--p:${v / max}"></div></div><span class="num">${fmtNum(v)} <span class="faint">/ ${max}</span></span></div>`).join('')}
        </div>
      </div>
      <div class="metric-grid">
        <div><div class="muted">首字 P50 / P95</div><b>${fmtMs(s.ttft.p50)} / ${fmtMs(s.ttft.p95)}</b></div>
        <div><div class="muted">总耗时 P50 / P95</div><b>${fmtMs(s.latency.p50)} / ${fmtMs(s.latency.p95)}</b></div>
        <div><div class="muted">首字抖动 CV</div><b>${fmtNum(s.ttftCv, 2)}</b></div>
        <div><div class="muted">首字 最快 / 最慢</div><b>${fmtMs(s.ttft.min)} / ${fmtMs(s.ttft.max)}</b></div>
        <div><div class="muted">TPS P50 / 平均</div><b>${fmtNum(s.tps.p50)} / ${fmtNum(s.tps.avg)}</b></div>
        <div><div class="muted">流式响应占比</div><b>${fmtPct(s.streamedRatio, 0)}</b></div>
      </div>
    </section>

    <section class="panel panel-pad spotlight" data-reveal>
      <h2>${icon('spark', 16)}AI 评审 ${it.ai ? `<span class="badge accent">${it.ai.score} 分</span>${it.ai.qualityScore != null ? ` <span class="badge">质量 ${it.ai.qualityScore}</span>` : ''}` : ''}</h2>
      ${it.ai ? `
        <div class="verdict">${esc(it.ai.verdict)}</div>
        ${it.ai.strengths.length ? `<div class="muted" style="font-size:12.5px">优点</div><ul class="list">${it.ai.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${it.ai.issues.length ? `<div class="muted" style="font-size:12.5px;margin-top:10px">问题</div><ul class="list">${it.ai.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${it.ai.suggestion ? `<div class="notice info" style="margin-top:14px">${icon('bolt', 15)}<span>${esc(it.ai.suggestion)}</span></div>` : ''}`
        : `<div class="muted">${it.aiError ? `评审失败：${esc(it.aiError)}` : '本次未启用 AI 评审'}</div>`}
    </section>

    <section class="panel panel-pad" data-reveal>
      <h2>${icon('history', 16)}请求时间线</h2>
      ${waterfall(it.records)}
      <div class="legend"><span><i style="background:color-mix(in srgb, var(--accent) 28%, transparent)"></i>等待首字</span><span><i style="background:var(--accent)"></i>生成</span><span><i style="background:var(--bad)"></i>失败</span></div>
    </section>

    <section class="panel panel-pad" data-reveal>
      <h2>${icon('x', 16)}错误 ${fails.length ? `<span class="badge bad">${fails.length}</span>` : ''}</h2>
      ${fails.length ? `
        <div class="err-chips">${Object.entries(s.errors).map(([k, v]) => `<span class="badge bad">${esc(ERROR_LABELS[k] || k)} ×${v}</span>`).join('')}</div>
        <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
          ${fails.slice(0, 6).map((r) => `<div class="mono" style="font-size:12px;word-break:break-all"><span class="badge bad">${esc(r.errorLabel)}${r.status ? ` ${r.status}` : ''}</span> ${esc(r.errorMessage)}${r.requestId ? ` <span class="faint">[${esc(r.requestId)}]</span>` : ''}</div>`).join('')}
          ${fails.length > 6 ? `<div class="faint">… 另有 ${fails.length - 6} 条</div>` : ''}
        </div>` : `<div class="notice info">${icon('check', 15)}<span>这一项没有任何报错</span></div>`}
    </section>

    ${QUALITY_PROBES.some((p) => it.records.find((r) => r.probeId === p.id)) ? `
    <section class="panel panel-pad full" data-reveal>
      <h2>${icon('check', 16)}质量题 <span class="faint" style="font-weight:400">${s.probesPassed} / ${s.probesTotal} 通过</span></h2>
      ${QUALITY_PROBES.map((p) => {
        const r = it.records.find((x) => x.probeId === p.id);
        if (!r) return '';
        const badge = r.probeResult?.pass ? '<span class="badge ok">通过</span>' : '<span class="badge bad">未通过</span>';
        return `<div class="probe">
          <div><b>${esc(p.name)}</b> ${badge} <span class="muted" style="font-size:12.5px">${esc(r.probeResult?.detail || '')} · 期望：<span class="mono">${esc(p.expect)}</span></span></div>
          <div class="q">${esc(p.prompt)}</div>
          <pre>${r.ok ? esc(r.text) : `请求失败：${esc(r.errorLabel)} ${esc(r.errorMessage)}`}</pre>
        </div>`;
      }).join('')}
    </section>` : ''}

    <section class="panel panel-pad full" data-reveal>
      <details class="records"><summary>全部请求明细（${it.records.length} 条）</summary>
        <div class="table-wrap" style="margin-top:12px"><table class="tbl">
          <thead><tr><th>#</th><th>类型</th><th>结果</th><th class="num">首字</th><th class="num">总耗时</th><th class="num">输出 tokens</th><th class="num">TPS</th><th>回答 / 错误</th></tr></thead>
          <tbody>${it.records.map((r, i) => `<tr>
            <td class="num faint">${i + 1}</td>
            <td>${r.kind === 'probe' ? '质量题' : '稳定性'}</td>
            <td>${r.ok ? `<span class="badge ok">${r.status || 'OK'}</span>` : `<span class="badge bad">${esc(r.errorLabel)}${r.status ? ` ${r.status}` : ''}</span>`}${r.ok && !r.streamed ? ' <span class="badge warn">非流式</span>' : ''}</td>
            <td class="num">${fmtMs(r.ttftMs)}</td>
            <td class="num">${fmtMs(r.totalMs)}</td>
            <td class="num">${r.outputTokens ?? '—'}${r.tokensEstimated ? '<span class="faint">≈</span>' : ''}</td>
            <td class="num">${fmtNum(r.tps)}</td>
            <td><div class="ellipsis" style="max-width:420px" title="${esc(r.ok ? r.text : r.errorMessage)}">${esc(r.ok ? r.text : r.errorMessage)}</div></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </details>
    </section>
  </div>`;
}

function waterfall(records) {
  if (!records.length) return '<div class="muted">没有请求</div>';
  const max = Math.max(...records.map((r) => r.totalMs || 0), 1);
  return `<div class="waterfall">${records.map((r, i) => {
    const total = r.totalMs || 0;
    let bars;
    if (!r.ok) {
      bars = `<div class="wf-fail" style="left:0;width:${Math.max(1.5, (total / max) * 100)}%" title="${esc(r.errorLabel)}"></div>`;
    } else {
      const ttft = Math.min(r.ttftMs ?? total, total);
      bars = `<div class="wf-ttft" style="left:0;width:${(ttft / max) * 100}%"></div><div class="wf-gen" style="left:${(ttft / max) * 100}%;width:${Math.max(0.5, ((total - ttft) / max) * 100)}%"></div>`;
    }
    return `<div class="wf-row" title="${r.ok ? `首字 ${fmtMs(r.ttftMs)} · 总 ${fmtMs(r.totalMs)}` : esc(`${r.errorLabel}：${r.errorMessage}`)}"><span>${String(i + 1).padStart(2, '0')}</span><div class="wf-track"><div class="wf-bars">${bars}</div></div><span>${r.ok ? fmtMs(total) : esc(r.errorLabel)}</span></div>`;
  }).join('')}</div>`;
}

/** 详情里的分项条与时间线：从 0 生长到实际值。 */
function animateDetailBars(detail) {
  const gsap = window.gsap;
  if (!detail || !gsap || !motionOn()) return;
  gsap.from(detail.querySelectorAll('.bar > div'), { scaleX: 0, duration: 1.1, stagger: 0.08, delay: 0.15, ease: 'premium' });
  gsap.from(detail.querySelectorAll('.wf-bars'), { scaleX: 0, duration: 0.9, stagger: 0.025, delay: 0.2, ease: 'premium' });
}

/** 只重画排行榜（排序 / 展开），用 Flip 让行平滑换位。 */
function redrawBoard(expandedKey) {
  const run = state.viewingRun;
  const tbody = $('[data-board]', rootRef);
  const thead = $('[data-head]', rootRef);
  if (!tbody) return;
  const flipState = flipCapture(tbody.querySelectorAll('tr[data-flip-id]'));
  thead.innerHTML = headTemplate();
  tbody.innerHTML = boardTemplate(run);
  flipPlay(flipState, tbody.querySelectorAll('tr[data-flip-id]'));
  if (expandedKey) {
    const detail = tbody.querySelector(`[data-detail="${CSS.escape(expandedKey)}"]`);
    if (detail) {
      expandIn(detail);
      animateDetailBars(detail);
    }
  }
}

function onClick(e) {
  const run = state.viewingRun;
  if (!run) return;
  const th = e.target.closest('[data-sort]');
  if (th) {
    const key = th.dataset.sort;
    const col = COLS.find((c) => c.key === key);
    if (ui.sort.key === key) ui.sort.dir *= -1;
    else ui.sort = { key, dir: col?.asc ? 1 : -1 };
    redrawBoard();
    return;
  }
  const row = e.target.closest('[data-row]');
  if (row) {
    const k = row.dataset.row;
    const opening = !ui.open.has(k);
    if (opening) ui.open.add(k);
    else ui.open.delete(k);
    redrawBoard(opening ? k : null);
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  const stamp = new Date(run.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  if (act === 'json') download(`relaybench-${stamp}.json`, JSON.stringify(run, null, 2));
  else if (act === 'csv') download(`relaybench-${stamp}.csv`, toCsv(run), 'text/csv');
}

export function toCsv(run) {
  const head = ['排名', '站点', '地址', '模型', '协议', '综合分', '等级', '规则分', 'AI分', '成功率', '成功数', '请求数',
    '首字P50ms', '首字P95ms', '总耗时P50ms', '总耗时P95ms', 'TPS_P50', '首字CV', '质量题通过', '错误分布', 'AI结论'];
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const r0 = (x) => (x == null ? '' : Math.round(x));
  const rows = run.items.map((it, i) => [
    i + 1, it.siteName, it.baseUrl, it.model, it.protocol, it.final, it.grade, it.rule.total, it.ai?.score ?? '',
    (it.stats.successRate * 100).toFixed(1) + '%', it.stats.success, it.stats.total,
    r0(it.stats.ttft.p50), r0(it.stats.ttft.p95), r0(it.stats.latency.p50), r0(it.stats.latency.p95),
    it.stats.tps.p50 == null ? '' : it.stats.tps.p50.toFixed(1), it.stats.ttftCv == null ? '' : it.stats.ttftCv.toFixed(2),
    `${it.stats.probesPassed}/${it.stats.probesTotal}`,
    Object.entries(it.stats.errors).map(([k, v]) => `${ERROR_LABELS[k] || k}×${v}`).join(' '),
    it.ai?.verdict || '',
  ]);
  return `﻿${[head, ...rows].map((r) => r.map(q).join(',')).join('\n')}`;
}

export function showRun(run) {
  state.viewingRun = run;
  ui.open.clear();
  if (location.hash === '#report' && rootRef?.isConnected) {
    draw();
    import('./motion.js').then((m) => m.enterView(rootRef));
  } else {
    location.hash = '#report';
  }
}
