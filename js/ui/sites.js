// 站点视图：添加 / 批量导入 / 检测（类型、余额、模型）/ 选择模型。
import { state, addSite, updateSite, removeSite } from '../state.js';
import {
  normalizeBaseUrl, siteNameFromUrl, parseBulkImport, detectSite, listModels, preselectModels, SITE_TYPE_LABELS,
} from '../core/relay.js';
import { esc, toast, fmtBalance, maskKey, fmtTime, fmtMs, fmtPct, fmtNum, scoreColor, confirmBox, $ } from './dom.js';
import { startRun } from './run.js';
import { presetSwitchHtml, handlePresetClick } from './preset.js';
import { ERROR_LABELS } from '../core/errors.js';
import { icon } from './icons.js';
import { enterPart, listIn, modalIn, modalOut } from './motion.js';

const ui = { panel: '', checking: new Set(), seen: new Set() };

export async function checkSite(site) {
  if (!site.apiKey) {
    await updateSite(site.id, { detectError: '请先填写 Key' });
    return;
  }
  ui.checking.add(site.id);
  rerenderList();
  try {
    const [d, m] = await Promise.all([detectSite(site.baseUrl, site.apiKey), listModels(site.baseUrl, site.apiKey)]);
    const models = m.models;
    let selected = (site.selectedModels || []).filter((x) => models.includes(x));
    if (!site.selectedModels?.length) selected = preselectModels(models, state.settings.favoriteKeywords);
    const errors = [m.error, d.error].filter(Boolean).join('；');
    await updateSite(site.id, {
      type: d.type, balance: d.balance, models, selectedModels: selected, detectError: errors, checkedAt: Date.now(),
    });
  } finally {
    ui.checking.delete(site.id);
    rerenderList();
  }
}

let rootRef = null;

const btnIc = (name) => `<span class="btn-ic">${icon(name, 14)}</span>`;

export function render(root) {
  rootRef = root;
  ui.seen = new Set(state.sites.map((s) => s.id));
  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">01 · Sites</div>
        <h1 data-split>中转站与 Key</h1>
        <p>添加中转站地址和在该站创建的 API Key。检测会识别站点类型、查询余额并拉取模型列表，然后勾选要测的模型。</p>
      </div>
      <div class="actions">
        <button class="btn" data-act="toggle-bulk">${icon('import', 15)}批量导入</button>
        <button class="btn" data-act="toggle-add">${icon('plus', 15)}添加站点</button>
        <button class="btn" data-act="check-all">${icon('scan', 15)}全部检测</button>
        <button class="btn primary has-ic" data-act="run-all" data-magnet="0.22"><span class="shiny">开始测试全部</span>${btnIc('arrow')}</button>
      </div>
    </div>
    <div class="preset-bar" style="margin:-8px 0 26px" id="preset-bar" data-reveal><span class="muted">测试档位</span>${presetSwitchHtml()}</div>

    <form class="panel panel-pad collapse ${ui.panel === 'add' ? '' : 'hidden'}" id="add-form" autocomplete="off">
      <h2>${icon('plus', 16)}添加站点</h2>
      <div class="grid c4">
        <label class="field"><span>站点地址 *</span><input class="input" name="baseUrl" placeholder="https://api.example.com" required></label>
        <label class="field"><span>API Key *</span><input class="input" name="apiKey" type="password" placeholder="sk-..." required></label>
        <label class="field"><span>名称</span><input class="input" name="name" placeholder="默认取域名"></label>
        <label class="field"><span>协议</span>
          <select class="input" name="protocol">
            <option value="auto">自动（claude 走 /v1/messages）</option>
            <option value="openai">全部 OpenAI /v1/chat/completions</option>
            <option value="anthropic">全部 Anthropic /v1/messages</option>
          </select>
        </label>
      </div>
      <div class="actions" style="margin-top:18px;justify-content:space-between">
        <label class="check"><input type="checkbox" name="rememberKey"> 在本机浏览器记住 Key</label>
        <div class="actions"><button type="button" class="btn ghost" data-act="toggle-add">取消</button><button class="btn primary has-ic">添加并检测${btnIc('arrow')}</button></div>
      </div>
    </form>

    <form class="panel panel-pad collapse ${ui.panel === 'bulk' ? '' : 'hidden'}" id="bulk-form" autocomplete="off">
      <h2>${icon('import', 16)}批量导入</h2>
      <p class="muted" style="margin:-4px 0 12px">每行一个站点：<code class="mono">地址 Key [名称]</code>，分隔符可用空格、逗号或竖线；<code class="mono">#</code> 开头为注释。</p>
      <textarea class="input" name="text" rows="6" placeholder="https://api.site-a.com sk-xxxxxxxxxxxxxxxx 站点A&#10;api.site-b.com, sk-yyyyyyyyyyyyyyyy"></textarea>
      <div class="actions" style="margin-top:16px;justify-content:space-between">
        <label class="check"><input type="checkbox" name="rememberKey"> 在本机浏览器记住 Key</label>
        <div class="actions"><button type="button" class="btn ghost" data-act="toggle-bulk">取消</button><button class="btn primary has-ic">导入并检测${btnIc('arrow')}</button></div>
      </div>
    </form>

    <div id="site-list"></div>
  `;
  root.onclick = onClick;
  root.onsubmit = onSubmit;
  root.onchange = onChange;
  rerenderList(true);
}

export function onState(what) {
  if (what === 'settings') {
    const bar = rootRef && $('#preset-bar', rootRef);
    if (bar) bar.innerHTML = `<span class="muted">测试档位</span>${presetSwitchHtml()}`;
  }
  if (what === 'sites' || what === 'settings') rerenderList();
}

function rerenderList(mount = false) {
  const box = rootRef && $('#site-list', rootRef);
  if (!box || !box.isConnected) return;
  if (!state.sites.length) {
    box.innerHTML = emptyTemplate();
    if (!mount) enterPart(box);
    return;
  }
  box.innerHTML = `<div class="site-grid">${state.sites.map((s) => siteCard(s, mount)).join('')}</div>`;
  if (!mount) {
    const fresh = state.sites.filter((s) => !ui.seen.has(s.id)).map((s) => box.querySelector(`[data-card="${s.id}"]`)).filter(Boolean);
    listIn(fresh, { from: 'bottom' });
  }
  state.sites.forEach((s) => ui.seen.add(s.id));
}

function emptyTemplate() {
  return `
    <div class="panel empty-hero" data-reveal>
      <div>
        <div class="eyebrow">Getting started</div>
        <h3>三步测出哪个中转站最稳</h3>
        <p>给出地址和 Key，剩下的交给 RelayBench：批量发请求、统计报错与速度，再由 AI 评审打分排名。</p>
        <div class="actions">
          <button class="btn primary has-ic" data-act="toggle-add" data-magnet="0.22">添加第一个站点${btnIc('arrow')}</button>
          <button class="btn" data-act="toggle-bulk">${icon('import', 15)}批量导入</button>
        </div>
      </div>
      <div class="steps">
        <div class="step"><div class="step-ic">${icon('sites', 20)}</div><div><b>添加站点</b><span>地址 + Key，自动识别 new-api / sub2api 并查余额</span></div></div>
        <div class="step"><div class="step-ic">${icon('bolt', 20)}</div><div><b>一键测试</b><span>快速档每个模型 5 次请求，实时看报错和首字延迟</span></div></div>
        <div class="step"><div class="step-ic">${icon('spark', 20)}</div><div><b>AI 打分</b><span>评审模型给出分数、结论与建议，生成排行榜</span></div></div>
      </div>
    </div>`;
}

function siteCard(s, mount) {
  const checking = ui.checking.has(s.id);
  const typeBadge = s.type === 'unknown'
    ? '<span class="badge">未检测</span>'
    : `<span class="badge accent">${esc(SITE_TYPE_LABELS[s.type] || s.type)}</span>`;
  const sel = s.selectedModels || [];
  const chips = sel.slice(0, 6).map((m) => `<span class="chip">${esc(m)}</span>`).join('')
    + (sel.length > 6 ? `<span class="chip more">+${sel.length - 6}</span>` : '');
  const keyCell = s.apiKey
    ? `<span class="mono">${esc(maskKey(s.apiKey))}</span> ${s.rememberKey ? '<span class="badge">已记住</span>' : '<span class="badge">仅本次</span>'}`
    : `<div class="inline-form"><input class="input sm" type="password" placeholder="Key 未保存，请重新输入" data-key-input="${s.id}"><button class="btn sm" data-act="set-key" data-id="${s.id}">确定</button></div>`;
  const initial = esc((s.name || '?').trim().slice(0, 1));
  return `
    <article class="panel site-card spotlight" data-card="${s.id}" ${mount ? 'data-reveal' : ''}>
      <div class="head">
        <div class="site-id">
          <div class="site-avatar">${initial}</div>
          <div style="min-width:0">
            <div class="name">${esc(s.name)}</div>
            <div class="url">${esc(s.baseUrl)}</div>
          </div>
        </div>
        ${checking ? '<span class="badge accent"><span class="radar" style="width:12px;height:12px"></span>检测中</span>' : typeBadge}
      </div>
      <dl class="kv">
        <dt>Key</dt><dd>${keyCell}</dd>
        <dt>余额</dt><dd><b class="num" style="font-weight:600">${esc(fmtBalance(s.balance))}</b>${s.balance?.note ? ` <span class="faint">${esc(s.balance.note)}</span>` : ''}</dd>
        <dt>协议</dt><dd>
          <select class="input sm" data-protocol="${s.id}" style="width:auto">
            ${[['auto', '自动'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic']].map(([v, l]) => `<option value="${v}" ${s.protocol === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </dd>
        <dt>模型</dt><dd>${s.models?.length ? `已选 <b>${sel.length}</b> <span class="faint">/ 共 ${s.models.length}</span>` : '<span class="faint">未拉取</span>'}</dd>
      </dl>
      ${sel.length ? `<div class="chips">${chips}</div>` : ''}
      ${s.detectError ? `<div class="err-line">${icon('x', 14)}<span>${esc(s.detectError)}</span></div>` : ''}
      ${lastResultTemplate(s)}
      <div class="foot">
        <button class="btn sm primary has-ic" data-act="run-one" data-id="${s.id}" ${s.apiKey && sel.length ? '' : 'disabled'} title="${sel.length ? '只测试这个站点已勾选的模型' : '先勾选模型'}" data-magnet="0.2">测试<span class="btn-ic">${icon('play', 11)}</span></button>
        <button class="btn sm" data-act="check" data-id="${s.id}" ${checking ? 'disabled' : ''}>${icon('scan', 14)}检测</button>
        <button class="btn sm" data-act="pick" data-id="${s.id}" ${s.models?.length ? '' : 'disabled'}>${icon('list', 14)}选择模型</button>
        <span style="flex:1"></span>
        <button class="btn sm ghost danger" data-act="remove" data-id="${s.id}" aria-label="删除站点" title="删除站点">${icon('trash', 15)}</button>
      </div>
    </article>`;
}

/** 卡片上的最近一次测试结果：每个模型一行。 */
function lastResultTemplate(s) {
  const lr = s.lastResult;
  if (!lr?.models || !Object.keys(lr.models).length) {
    return s.models?.length
      ? `<div class="notice info">${icon('bolt', 15)}<span>还没测过：点下方「测试」开始，测完这里会显示得分、成功率、首字延迟和报错。</span></div>`
      : '';
  }
  const rows = Object.entries(lr.models).sort((a, b) => b[1].final - a[1].final).map(([m, r]) => {
    const errs = (r.errors || []).map(([k, v]) => `${ERROR_LABELS[k] || k}×${v}`).join(' ');
    return `<div class="res-row" title="${esc(r.verdict || '')}">
      <div class="res-model mono">${esc(m)}</div>
      <div class="res-score" style="color:${scoreColor(r.final)}">${r.final}<span class="grade ${esc(r.grade || '-')}">${esc(r.grade || '-')}</span></div>
      <div class="res-metrics">
        <span>成功 <b>${fmtPct(r.successRate, 0)}</b></span><span>首字 <b>${fmtMs(r.ttftP50)}</b></span><span><b>${fmtNum(r.tpsP50, 0)}</b> t/s</span>${r.ai != null ? '<span class="badge accent" style="height:18px;font-size:11px">AI</span>' : ''}
        ${errs ? `<span class="res-err">${esc(errs)}</span>` : '<span class="faint">无报错</span>'}
      </div>
    </div>`;
  }).join('');
  return `<div class="result-box">
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span>最近测试 ${lr.aborted ? '<span class="badge warn">中途停止</span>' : ''}</span>
      <a href="#report" data-act="open-report" data-run="${esc(lr.runId)}" style="font-weight:500;font-size:12px;display:inline-flex;gap:4px;align-items:center">${esc(fmtTime(lr.at))}${icon('arrow', 12)}</a>
    </div>
    <div class="res-list">${rows}</div>
  </div>`;
}

function togglePanel(name) {
  ui.panel = ui.panel === name ? '' : name;
  for (const n of ['add', 'bulk']) {
    const f = $(`#${n}-form`, rootRef);
    const show = ui.panel === n;
    const wasHidden = f.classList.contains('hidden');
    f.classList.toggle('hidden', !show);
    if (show && wasHidden) {
      f.setAttribute('data-reveal', '');
      enterPart(f);
      f.removeAttribute('data-reveal');
    }
  }
  if (ui.panel) $(`#${ui.panel}-form input, #${ui.panel}-form textarea`, rootRef)?.focus();
}

async function onClick(e) {
  if (await handlePresetClick(e)) return undefined;
  const btn = e.target.closest('[data-act]');
  if (!btn) return undefined;
  const act = btn.dataset.act;
  const site = state.sites.find((s) => s.id === btn.dataset.id);
  if (act === 'toggle-add' || act === 'toggle-bulk') {
    e.preventDefault();
    togglePanel(act === 'toggle-add' ? 'add' : 'bulk');
  } else if (act === 'check-all') {
    const targets = state.sites.filter((s) => s.apiKey);
    if (!targets.length) return toast('没有可检测的站点（缺少 Key）', 'bad');
    await Promise.all(targets.map(checkSite));
    toast(`已检测 ${targets.length} 个站点`, 'ok');
  } else if (act === 'check' && site) {
    await checkSite(site);
  } else if (act === 'run-one' && site) {
    startRun([site.id]);
  } else if (act === 'run-all') {
    startRun();
  } else if (act === 'open-report') {
    e.preventDefault();
    const { loadRun } = await import('../state.js');
    const { showRun } = await import('./report.js');
    const run = await loadRun(btn.dataset.run);
    if (run) showRun(run);
    else toast('该报告已被删除', 'bad');
  } else if (act === 'pick' && site) {
    openModelPicker(site);
  } else if (act === 'remove' && site) {
    if (confirmBox(`删除站点「${site.name}」？`)) await removeSite(site.id);
  } else if (act === 'set-key' && site) {
    const input = rootRef.querySelector(`[data-key-input="${site.id}"]`);
    const key = input?.value.trim();
    if (!key) return toast('请输入 Key', 'bad');
    site.apiKey = key;
    await updateSite(site.id, { apiKey: key, detectError: '' });
    if (!site.models?.length) await checkSite(site);
  }
  return undefined;
}

async function onChange(e) {
  const id = e.target.dataset?.protocol;
  if (id) await updateSite(id, { protocol: e.target.value });
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  if (form.id === 'add-form') {
    const fd = new FormData(form);
    const baseUrl = normalizeBaseUrl(fd.get('baseUrl'));
    const apiKey = String(fd.get('apiKey') || '').trim();
    if (!baseUrl || !apiKey) return toast('地址和 Key 必填', 'bad');
    const site = await addSite({
      baseUrl, apiKey, name: String(fd.get('name') || '').trim() || siteNameFromUrl(baseUrl),
      protocol: fd.get('protocol'), rememberKey: fd.get('rememberKey') === 'on',
    });
    form.reset();
    ui.panel = '';
    form.classList.add('hidden');
    await checkSite(site);
  } else if (form.id === 'bulk-form') {
    const fd = new FormData(form);
    const { sites, errors } = parseBulkImport(fd.get('text'));
    if (errors.length) toast(errors.slice(0, 3).join('\n'), 'bad', 6000);
    if (!sites.length) return undefined;
    const remember = fd.get('rememberKey') === 'on';
    const added = [];
    for (const s of sites) added.push(await addSite({ ...s, rememberKey: remember }));
    form.reset();
    ui.panel = '';
    form.classList.add('hidden');
    toast(`已导入 ${added.length} 个站点，正在检测…`);
    await Promise.all(added.map(checkSite));
  }
  return undefined;
}

// ------------------------------------------------------------ 模型选择弹窗
function openModelPicker(site) {
  const selected = new Set(site.selectedModels || []);
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal panel" role="dialog" aria-modal="true" aria-label="选择模型">
      <div class="modal-head">
        <h3>选择模型 <span class="faint" style="font-weight:500">· ${esc(site.name)}</span></h3>
        <div class="actions">
          <input class="input" placeholder="搜索模型…" data-search style="flex:1;min-width:160px">
          <button class="btn sm" data-m="fav" title="按设置中的常用模型关键字勾选">${icon('spark', 14)}按常用关键字</button>
          <button class="btn sm" data-m="all">全选可见</button>
          <button class="btn sm ghost" data-m="none">清空</button>
        </div>
      </div>
      <div class="modal-body"><div class="model-list" data-list></div></div>
      <div class="modal-foot">
        <span class="muted" data-count></span>
        <div class="actions"><button class="btn ghost" data-m="cancel">取消</button><button class="btn primary has-ic" data-m="save">保存${btnIc('check')}</button></div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const modal = wrap.querySelector('.modal');
  const list = wrap.querySelector('[data-list]');
  const search = wrap.querySelector('[data-search]');
  const count = wrap.querySelector('[data-count]');
  const visible = () => {
    const q = search.value.trim().toLowerCase();
    return site.models.filter((m) => !q || m.toLowerCase().includes(q));
  };
  const draw = () => {
    list.innerHTML = visible().map((m) => `<label class="check" data-list-item><input type="checkbox" value="${esc(m)}" ${selected.has(m) ? 'checked' : ''}> ${esc(m)}</label>`).join('')
      || '<div class="muted">没有匹配的模型</div>';
    count.textContent = `已选 ${selected.size} 个`;
  };
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKey);
    modalOut(wrap, modal, () => wrap.remove());
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  search.oninput = draw;
  list.onchange = (e) => {
    if (e.target.checked) selected.add(e.target.value);
    else selected.delete(e.target.value);
    count.textContent = `已选 ${selected.size} 个`;
  };
  wrap.onclick = async (e) => {
    if (e.target === wrap) return close();
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (m === 'fav') preselectModels(site.models, state.settings.favoriteKeywords).forEach((x) => selected.add(x));
    else if (m === 'all') visible().forEach((x) => selected.add(x));
    else if (m === 'none') selected.clear();
    else if (m === 'cancel') return close();
    else if (m === 'save') {
      const order = site.models.filter((x) => selected.has(x));
      await updateSite(site.id, { selectedModels: order });
      return close();
    }
    if (m) draw();
    return undefined;
  };
  draw();
  modalIn(wrap, modal);
  search.focus();
}
