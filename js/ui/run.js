// 测试视图 + 运行控制器（运行状态挂在 state.current 上，切换视图不影响运行）。
import { state, notify, saveRun, updateSite, resolveJudge } from '../state.js';
import { runBenchmark } from '../core/runner.js';
import { probesFor } from '../core/probes.js';
import { requestsPerModelTotal } from '../core/runner.js';
import { presetSwitchHtml, handlePresetClick } from './preset.js';
import { ERROR_LABELS } from '../core/errors.js';
import { SITE_TYPE_LABELS } from '../core/relay.js';
import { topErrors } from '../core/stats.js';
import { esc, toast, fmtMs, fmtPct, fmtNum, fmtClock, fmtDuration, $ } from './dom.js';
import { icon } from './icons.js';
import { countTo, listIn, flash, enterView } from './motion.js';

const LOG_LIMIT = 200;

function eligibleSites() {
  return state.sites.filter((s) => s.apiKey && s.selectedModels?.length);
}

/** 把本次结果写回站点卡片（每个模型一行摘要）。 */
async function saveLastResults(run) {
  for (const rs of run.sites) {
    const items = run.items.filter((it) => it.siteId === rs.id && it.stats.total > 0);
    if (!items.length) continue;
    const models = {};
    for (const it of items) {
      models[it.model] = {
        final: it.final,
        grade: it.grade,
        ai: it.ai?.score ?? null,
        successRate: it.stats.successRate,
        success: it.stats.success,
        total: it.stats.total,
        ttftP50: it.stats.ttft.p50,
        tpsP50: it.stats.tps.p50,
        errors: topErrors(it.stats.errors, 2),
        verdict: it.ai?.verdict || '',
      };
    }
    await updateSite(rs.id, {
      lastResult: { runId: run.id, at: run.startedAt, aborted: run.aborted, models },
      ...(rs.balanceAfter ? { balance: rs.balanceAfter } : {}),
    });
  }
}

/** @param {string[]} [onlySiteIds] 只测这些站点（站点卡片上的「测试」按钮） */
export async function startRun(onlySiteIds) {
  if (state.current?.status === 'running') {
    toast('已有测试在运行', 'bad');
    location.hash = '#run';
    return;
  }
  const sites = eligibleSites().filter((s) => !onlySiteIds || onlySiteIds.includes(s.id));
  if (!sites.length) {
    toast(onlySiteIds ? '这个站点还不能测：需要填 Key 并勾选至少一个模型' : '没有可测试的站点：需要已填 Key 且勾选了模型', 'bad', 5000);
    return;
  }
  const judge = resolveJudge();
  if (state.judge.enabled && !judge) {
    toast('没有可用的 AI 评审模型，本次只给规则分（可在「设置」中配置）', 'info', 5000);
  }
  location.hash = '#run';
  const abort = new AbortController();
  const cur = {
    status: 'running', phase: 'balance', message: '准备中…', startedAt: Date.now(), abort,
    jobs: new Map(), order: [], log: [], logSeq: 0, run: null,
  };
  state.current = cur;
  notify('run');

  const onEvent = (e) => {
    if (e.type === 'plan') {
      for (const j of e.jobs) {
        cur.jobs.set(j.key, { ...j, done: 0, ok: 0, ttft: [], tps: [], errors: {}, ai: null, aiError: '', final: null, judged: false });
        cur.order.push(j.key);
      }
    } else if (e.type === 'phase') {
      cur.phase = e.phase;
      cur.message = e.message;
    } else if (e.type === 'request') {
      const j = cur.jobs.get(e.key);
      const r = e.record;
      j.done = e.done;
      if (r.ok) {
        j.ok += 1;
        if (Number.isFinite(r.ttftMs)) j.ttft.push(r.ttftMs);
        if (Number.isFinite(r.tps)) j.tps.push(r.tps);
      } else {
        j.errors[r.errorType] = (j.errors[r.errorType] || 0) + 1;
      }
      cur.logSeq += 1;
      cur.log.unshift({ seq: cur.logSeq, at: Date.now(), siteName: j.siteName, model: j.model, kind: r.kind, rec: r });
      if (cur.log.length > LOG_LIMIT) cur.log.length = LOG_LIMIT;
    } else if (e.type === 'scored') {
      for (const it of e.items) {
        const j = cur.jobs.get(it.key);
        if (j) j.final = it.final;
      }
    } else if (e.type === 'judge') {
      const j = cur.jobs.get(e.key);
      if (j) Object.assign(j, { ai: e.ai, aiError: e.aiError, final: e.final, judged: true });
    }
    notify('run-progress');
  };

  try {
    const run = await runBenchmark({
      sites: sites.map((s) => ({
        id: s.id, name: s.name, baseUrl: s.baseUrl, apiKey: s.apiKey, protocol: s.protocol,
        type: s.type, selectedModels: [...s.selectedModels],
      })),
      settings: state.settings,
      judge: judge ? { enabled: true, ...judge } : null,
      signal: abort.signal,
      onEvent,
    });
    cur.run = run;
    cur.status = 'done';
    if (run.items.some((it) => it.stats.total > 0)) {
      await saveRun(run);
      await saveLastResults(run);
      state.viewingRun = run;
      // 跑完直接看报告（用户还停在测试页时）
      if (location.hash === '#run' || location.hash === '') location.hash = '#report';
    }
    toast(run.aborted ? '测试已停止，已保存部分结果' : '测试完成', run.aborted ? 'info' : 'ok');
  } catch (err) {
    console.error(err);
    cur.status = 'error';
    cur.message = `运行出错：${err?.message || err}`;
    toast(cur.message, 'bad', 6000);
  } finally {
    cur.finishedAt = Date.now();
    notify('run');
  }
}

export function stopRun() {
  if (state.current?.status === 'running') {
    state.current.abort.abort();
    state.current.message = '正在停止…';
    notify('run-progress');
  }
}

// ------------------------------------------------------------------ view
let rootRef = null;
let live = null;      // { rows: Map<key, tr>, renderedSeq, judged: Set }
let ticker = 0;

const btnIc = (name, s = 14) => `<span class="btn-ic">${icon(name, s)}</span>`;

export function render(root) {
  rootRef = root;
  root.onclick = async (e) => {
    if (await handlePresetClick(e)) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'start') startRun();
    else if (act === 'stop') stopRun();
    else if (act === 'report') location.hash = '#report';
  };
  root.onsubmit = null;
  root.onchange = null;
  draw();
}

export function onState(what) {
  if (!rootRef?.isConnected) return;
  const inLive = !!$('#run-live', rootRef);
  if (what === 'run-progress') {
    if (inLive) patchLive();
    return;
  }
  if (what === 'run') {
    draw();
    enterView(rootRef);
    return;
  }
  if (what === 'settings' || what === 'sites') {
    if (!inLive) draw();
    else {
      const bar = $('#run-preset', rootRef);
      if (bar) bar.innerHTML = presetSwitchHtml();
    }
  }
}

function draw() {
  clearInterval(ticker);
  const cur = state.current;
  if (cur && ['running', 'done', 'error'].includes(cur.status)) {
    rootRef.innerHTML = liveTemplate(cur);
    live = { rows: new Map(), renderedSeq: 0, judged: new Set() };
    patchLive(true);
    if (cur.status === 'running') {
      ticker = setInterval(() => {
        if (!rootRef?.isConnected || state.current?.status !== 'running') return clearInterval(ticker);
        const el = $('[data-h="elapsed"]', rootRef);
        if (el) el.textContent = fmtDuration(Date.now() - state.current.startedAt);
        return undefined;
      }, 1000);
    }
  } else {
    live = null;
    rootRef.innerHTML = preflightTemplate();
  }
}

function preflightTemplate() {
  const sites = eligibleSites();
  const st = state.settings;
  const perModel = requestsPerModelTotal(st);
  const probeN = probesFor(st.probeSet).length;
  const models = sites.reduce((n, s) => n + s.selectedModels.length, 0);
  const skipped = state.sites.length - sites.length;
  const j = state.judge;
  const judge = resolveJudge();
  return `
    <div class="page-head">
      <div>
        <div class="eyebrow">02 · Run</div>
        <h1 data-split>批量测试</h1>
        <p>对已勾选的模型批量发流式请求，统计报错、首字延迟、输出速度和抖动，再交给评审模型打分。</p>
      </div>
    </div>
    <section class="panel panel-pad spotlight" data-reveal>
      <div class="preset-bar" style="margin-bottom:26px"><span class="muted">测试档位</span>${presetSwitchHtml()}</div>
      <div class="stat-row">
        <div class="stat"><div class="v" data-count="${sites.length}">${sites.length}</div><div class="k">参与站点</div></div>
        <div class="stat"><div class="v" data-count="${models}">${models}</div><div class="k">站点 × 模型</div></div>
        <div class="stat"><div class="v" data-count="${models * perModel}">${models * perModel}</div><div class="k">请求总数</div></div>
        <div class="stat"><div class="v">${st.requestsPerModel}<small> + ${probeN}</small></div><div class="k">每模型：稳定性 + 质量题</div></div>
        <div class="stat"><div class="v">${st.concurrencyPerSite}<small> / ${st.concurrencyGlobal}</small></div><div class="k">每站 / 全局并发</div></div>
      </div>
      <div style="margin-top:22px;display:flex;flex-direction:column;gap:10px">
        ${skipped > 0 ? `<div class="notice">${icon('x', 15)}<span>有 ${skipped} 个站点因缺少 Key 或未勾选模型被跳过，可到「站点」页处理。</span></div>` : ''}
        ${judge
          ? `<div class="notice info">${icon('spark', 15)}<span>AI 评审：<b class="mono">${esc(judge.model)}</b> @ ${esc(judge.label)}${judge.auto ? '（自动挑选）' : ''}；综合分 = 规则分 × ${fmtNum(1 - st.aiWeight, 1)} + AI 分 × ${fmtNum(st.aiWeight, 1)}。<a href="#settings">更换</a></span></div>`
          : `<div class="notice">${icon('spark', 15)}<span>${j.enabled ? '没有可用的 AI 评审模型' : 'AI 评审已关闭'}，本次只给规则分。可在 <a href="#settings">设置</a> 中配置。</span></div>`}
      </div>
      <div class="actions" style="margin-top:26px">
        <button class="btn primary lg has-ic" data-act="start" data-magnet="0.25" ${sites.length ? '' : 'disabled'}><span class="shiny">开始测试</span>${btnIc('play', 15)}</button>
        ${!sites.length ? '<a href="#sites">先去添加站点并勾选模型 →</a>' : ''}
      </div>
    </section>
    ${sites.length ? `
    <section class="panel" data-reveal style="margin-top:26px">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>站点</th><th>类型</th><th>模型</th></tr></thead>
        <tbody>${sites.map((s) => `<tr><td><div class="cell-main">${esc(s.name)}</div><div class="cell-sub mono">${esc(s.baseUrl)}</div></td><td><span class="badge accent">${esc(SITE_TYPE_LABELS[s.type] || s.type)}</span></td><td><div class="chips">${s.selectedModels.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div></td></tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}`;
}

function liveTemplate(cur) {
  const running = cur.status === 'running';
  const title = running ? '正在测试' : cur.status === 'error' ? '运行出错' : cur.run?.aborted ? '测试已停止' : '测试完成';
  return `
    <div class="page-head">
      <div>
        <div class="eyebrow">02 · Run</div>
        <h1 data-split>${title}</h1>
        <p>开始于 ${esc(fmtClock(cur.startedAt))}${running ? ' · 运行期间背景动效会暂停，以免影响计时' : ''}</p>
      </div>
      <div class="actions">
        ${running
          ? `<button class="btn danger solid has-ic" data-act="stop">停止${btnIc('stop', 12)}</button>`
          : `<span id="run-preset">${presetSwitchHtml()}</span>${cur.run ? `<button class="btn" data-act="report">${icon('report', 15)}查看报告</button>` : ''}<button class="btn primary has-ic" data-act="start" data-magnet="0.22">重新测试${btnIc('play', 12)}</button>`}
      </div>
    </div>
    <div id="run-live">
      <section class="panel panel-pad ${running ? 'glow-border' : ''}" data-reveal>
        <div class="stat-row">
          <div class="stat"><div class="v"><span data-h="done">0</span><small> / <span data-h="total">0</span></small></div><div class="k">已完成请求</div></div>
          <div class="stat"><div class="v" data-h="rate">—</div><div class="k">总成功率</div></div>
          <div class="stat"><div class="v" data-h="jobs">0</div><div class="k">站点 × 模型</div></div>
          <div class="stat"><div class="v" data-h="elapsed">0 秒</div><div class="k">耗时</div></div>
        </div>
        <div class="progress" style="margin-top:22px"><div data-bar></div></div>
        <div class="phase" data-phase></div>
      </section>
      <section class="panel" data-reveal style="margin-top:26px">
        <div class="table-wrap"><table class="tbl">
          <thead><tr>
            <th>站点</th><th>模型</th><th>进度</th><th class="num">成功率</th><th class="num">平均首字</th><th class="num">平均 TPS</th><th>错误</th><th class="num">得分</th>
          </tr></thead>
          <tbody data-jobs></tbody>
        </table></div>
      </section>
      <section class="panel" data-reveal style="margin-top:26px">
        <div class="panel-pad" style="padding-bottom:10px"><h2 style="margin:0">${icon('list', 16)}请求日志 <span class="faint" style="font-weight:400;font-size:12px">最近 ${LOG_LIMIT} 条</span></h2></div>
        <div class="log" data-log><div class="muted" data-empty style="padding:14px 24px">等待请求…</div></div>
      </section>
    </div>`;
}

function avg(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function jobRowHtml(j) {
  return `
    <td><div class="cell-main">${esc(j.siteName)}</div></td>
    <td><span class="mono">${esc(j.model)}</span> <span class="faint" style="font-size:11px">${j.protocol === 'anthropic' ? 'messages' : 'chat'}</span></td>
    <td><div style="display:flex;align-items:center;gap:10px"><div class="progress sm"><div data-c="bar"></div></div><span class="num muted" data-c="prog"></span></div></td>
    <td class="num" data-c="rate">—</td>
    <td class="num" data-c="ttft">—</td>
    <td class="num" data-c="tps">—</td>
    <td data-c="errs"><span class="faint">—</span></td>
    <td class="num"><span data-c="score" style="font-weight:650">—</span><span data-c="ai"></span></td>`;
}

function logRowHtml(l) {
  const r = l.rec;
  return `<div class="log-row">
    <span class="faint">${esc(fmtClock(l.at))}</span>
    <span class="ellipsis" title="${esc(l.siteName)} · ${esc(l.model)}">${esc(l.siteName)} · ${esc(l.model)}${l.kind === 'probe' ? ' <span class="badge">质量题</span>' : ''}</span>
    ${r.ok ? `<span class="ok">✓ ${r.status || ''}</span>` : `<span class="bad" title="${esc(r.errorMessage)}">✗ ${esc(r.errorLabel)}${r.status ? ` ${r.status}` : ''}</span>`}
    <span>首字 ${fmtMs(r.ttftMs)}</span>
    <span>总 ${fmtMs(r.totalMs)}</span>
    <span>${r.ok ? `${fmtNum(r.tps, 0)} t/s` : ''}</span>
  </div>`;
}

function patchLive(initial = false) {
  const cur = state.current;
  const root = rootRef;
  if (!cur || !root || !live) return;
  const jobs = cur.order.map((k) => cur.jobs.get(k));
  const total = jobs.reduce((n, j) => n + j.total, 0);
  const done = jobs.reduce((n, j) => n + j.done, 0);
  const ok = jobs.reduce((n, j) => n + j.ok, 0);

  const h = (k) => $(`[data-h="${k}"]`, root);
  if (h('done')) countTo(h('done'), done, 'int');
  if (h('total')) h('total').textContent = String(total);
  if (h('rate') && done) countTo(h('rate'), ok / done, 'pct');
  if (h('jobs')) countTo(h('jobs'), jobs.length, 'int');
  if (h('elapsed')) h('elapsed').textContent = fmtDuration((cur.finishedAt || Date.now()) - cur.startedAt);
  const bar = $('[data-bar]', root);
  if (bar) bar.style.setProperty('--p', total ? String(done / total) : '0');
  const phase = $('[data-phase]', root);
  if (phase) {
    const elapsed = fmtDuration((cur.finishedAt || Date.now()) - cur.startedAt);
    phase.innerHTML = cur.status === 'running'
      ? `<span class="radar"></span> ${esc(cur.message)}`
      : cur.status === 'error' ? `<span class="badge bad">出错</span> ${esc(cur.message)}`
        : `<span class="badge ${cur.run?.aborted ? 'warn' : 'ok'}">${icon(cur.run?.aborted ? 'stop' : 'check', 12)}${cur.run?.aborted ? '已停止' : '已完成'}</span> 用时 ${elapsed}`;
  }

  // 任务表：行只创建一次，之后原地更新，进度条才能平滑过渡
  const tbody = $('[data-jobs]', root);
  if (tbody) {
    const fresh = [];
    for (const j of jobs) {
      let tr = live.rows.get(j.key);
      if (!tr) {
        tr = document.createElement('tr');
        tr.innerHTML = jobRowHtml(j);
        tbody.appendChild(tr);
        live.rows.set(j.key, tr);
        fresh.push(tr);
      }
      const c = (k) => tr.querySelector(`[data-c="${k}"]`);
      c('bar').style.setProperty('--p', String(j.done / j.total));
      c('prog').textContent = `${j.done}/${j.total}`;
      c('rate').textContent = fmtPct(j.done ? j.ok / j.done : null);
      c('ttft').textContent = fmtMs(avg(j.ttft));
      c('tps').textContent = fmtNum(avg(j.tps));
      const errs = Object.entries(j.errors).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<span class="badge bad">${esc(ERROR_LABELS[k] || k)} ×${v}</span>`).join(' ');
      const errHtml = errs || '<span class="faint">—</span>';
      if (c('errs').dataset.v !== errHtml) {
        c('errs').innerHTML = errHtml;
        c('errs').dataset.v = errHtml;
      }
      if (j.final != null) countTo(c('score'), j.final, 'int');
      if (j.judged && !live.judged.has(j.key)) {
        live.judged.add(j.key);
        c('ai').innerHTML = j.ai ? ' <span class="badge accent">AI</span>' : ` <span class="badge warn" title="${esc(j.aiError)}">评审失败</span>`;
        if (!initial) flash(tr);
      }
    }
    if (!initial) listIn(fresh);
  }

  // 日志：只插入新条目（AnimatedList）
  const log = $('[data-log]', root);
  if (log) {
    const news = cur.log.filter((l) => l.seq > live.renderedSeq);
    if (news.length) {
      log.querySelector('[data-empty]')?.remove();
      log.insertAdjacentHTML('afterbegin', news.map(logRowHtml).join(''));
      live.renderedSeq = cur.log[0].seq;
      if (!initial) listIn([...log.children].slice(0, Math.min(news.length, 12)));
      while (log.children.length > LOG_LIMIT) log.lastElementChild.remove();
    }
  }
}
