// 站点视图：添加 / 批量导入 / 检测（类型、余额、模型）/ 选择模型。
import { state, addSite, updateSite, removeSite } from '../state.js';
import {
  normalizeBaseUrl, siteNameFromUrl, parseBulkImport, detectSite, listModels, preselectModels, SITE_TYPE_LABELS,
} from '../core/relay.js';
import { esc, toast, fmtBalance, maskKey, fmtTime, fmtMs, fmtPct, fmtNum, scoreColor, confirmBox, $ } from './dom.js';
import { startRun } from './run.js';
import { presetSwitchHtml, handlePresetClick } from './preset.js';
import { ERROR_LABELS } from '../core/errors.js';

const ui = { panel: '', checking: new Set() };

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

export function render(root) {
  rootRef = root;
  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>站点</h1>
        <p>添加中转站地址和该站创建的 API Key，检测后勾选要测的模型。</p>
      </div>
      <div class="actions">
        <button class="btn" data-act="toggle-bulk">批量导入</button>
        <button class="btn" data-act="toggle-add">添加站点</button>
        <button class="btn" data-act="check-all">全部检测</button>
        <button class="btn primary" data-act="run-all">开始测试全部 →</button>
      </div>
    </div>
    <div class="actions" style="margin:-6px 0 16px;gap:12px" id="preset-bar"><span class="muted">测试档位</span>${presetSwitchHtml()}</div>

    <form class="panel panel-pad collapse ${ui.panel === 'add' ? '' : 'hidden'}" id="add-form" autocomplete="off">
      <h2>添加站点</h2>
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
      <div class="actions" style="margin-top:14px;justify-content:space-between">
        <label class="check"><input type="checkbox" name="rememberKey"> 在本机浏览器记住 Key</label>
        <div class="actions"><button type="button" class="btn ghost" data-act="toggle-add">取消</button><button class="btn primary">添加并检测</button></div>
      </div>
    </form>

    <form class="panel panel-pad collapse ${ui.panel === 'bulk' ? '' : 'hidden'}" id="bulk-form" autocomplete="off">
      <h2>批量导入</h2>
      <p class="muted" style="margin:-4px 0 10px">每行一个站点：<code>地址 Key [名称]</code>，分隔符可用空格、逗号或竖线；<code>#</code> 开头为注释。</p>
      <textarea class="input" name="text" rows="6" placeholder="https://api.site-a.com sk-xxxxxxxxxxxxxxxx 站点A&#10;api.site-b.com, sk-yyyyyyyyyyyyyyyy"></textarea>
      <div class="actions" style="margin-top:12px;justify-content:space-between">
        <label class="check"><input type="checkbox" name="rememberKey"> 在本机浏览器记住 Key</label>
        <div class="actions"><button type="button" class="btn ghost" data-act="toggle-bulk">取消</button><button class="btn primary">导入并检测</button></div>
      </div>
    </form>

    <div id="site-list"></div>
  `;
  root.onclick = onClick;
  root.onsubmit = onSubmit;
  root.onchange = onChange;
  rerenderList();
}

export function onState(what) {
  if (what === 'settings') {
    const bar = rootRef && $('#preset-bar', rootRef);
    if (bar) bar.innerHTML = `<span class="muted">测试档位</span>${presetSwitchHtml()}`;
  }
  if (what === 'sites' || what === 'settings') rerenderList();
}

function rerenderList() {
  const box = rootRef && $('#site-list', rootRef);
  if (!box || !box.isConnected) return;
  if (!state.sites.length) {
    box.innerHTML = `
      <div class="panel empty">
        <h3>还没有站点</h3>
        <p>点「添加站点」或「批量导入」，填入中转站地址和 Key。</p>
      </div>`;
    return;
  }
  box.innerHTML = `<div class="site-grid">${state.sites.map(siteCard).join('')}</div>`;
}

function siteCard(s) {
  const checking = ui.checking.has(s.id);
  const typeBadge = s.type === 'unknown'
    ? '<span class="badge">未检测</span>'
    : `<span class="badge accent">${esc(SITE_TYPE_LABELS[s.type] || s.type)}</span>`;
  const sel = s.selectedModels || [];
  const chips = sel.slice(0, 6).map((m) => `<span class="chip">${esc(m)}</span>`).join('')
    + (sel.length > 6 ? `<span class="chip more">+${sel.length - 6}</span>` : '');
  const keyCell = s.apiKey
    ? `<span class="mono">${esc(maskKey(s.apiKey))}</span> ${s.rememberKey ? '<span class="badge">已记住</span>' : '<span class="badge">仅本次</span>'}`
    : `<div class="inline-form"><input class="input" type="password" placeholder="Key 未保存，请重新输入" data-key-input="${s.id}" style="height:28px"><button class="btn sm" data-act="set-key" data-id="${s.id}">确定</button></div>`;
  return `
    <div class="panel site-card">
      <div class="head">
        <div style="min-width:0">
          <div class="name">${esc(s.name)}</div>
          <div class="url">${esc(s.baseUrl)}</div>
        </div>
        ${checking ? '<span class="spinner" title="检测中"></span>' : typeBadge}
      </div>
      <dl class="kv">
        <dt>Key</dt><dd>${keyCell}</dd>
        <dt>余额</dt><dd>${esc(fmtBalance(s.balance))}${s.balance?.note ? ` <span class="faint">${esc(s.balance.note)}</span>` : ''}</dd>
        <dt>协议</dt><dd>
          <select class="input" data-protocol="${s.id}" style="height:28px;width:auto">
            ${[['auto', '自动'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic']].map(([v, l]) => `<option value="${v}" ${s.protocol === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </dd>
        <dt>模型</dt><dd>${s.models?.length ? `已选 <b>${sel.length}</b> / 共 ${s.models.length}` : '<span class="faint">未拉取</span>'}</dd>
      </dl>
      ${sel.length ? `<div class="chips">${chips}</div>` : ''}
      ${s.detectError ? `<div class="err-line">${esc(s.detectError)}</div>` : ''}
      ${lastResultTemplate(s)}
      <div class="foot">
        <button class="btn sm primary" data-act="run-one" data-id="${s.id}" ${s.apiKey && sel.length ? '' : 'disabled'} title="${sel.length ? '只测试这个站点已勾选的模型' : '先勾选模型'}">测试</button>
        <button class="btn sm" data-act="check" data-id="${s.id}" ${checking ? 'disabled' : ''}>检测</button>
        <button class="btn sm" data-act="pick" data-id="${s.id}" ${s.models?.length ? '' : 'disabled'}>选择模型</button>
        <span style="flex:1"></span>
        ${s.checkedAt ? `<span class="faint" style="font-size:12px;align-self:center">${esc(fmtTime(s.checkedAt))}</span>` : ''}
        <button class="btn sm ghost danger" data-act="remove" data-id="${s.id}">删除</button>
      </div>
    </div>`;
}

/** 卡片上的最近一次测试结果：每个模型一行。 */
function lastResultTemplate(s) {
  const lr = s.lastResult;
  if (!lr?.models || !Object.keys(lr.models).length) {
    return s.models?.length
      ? '<div class="notice info" style="font-size:12.5px">还没测过：点下方「测试」开始，测完这里会显示得分、成功率、首字延迟和报错。</div>'
      : '';
  }
  const rows = Object.entries(lr.models).sort((a, b) => b[1].final - a[1].final).map(([m, r]) => {
    const errs = (r.errors || []).map(([k, v]) => `${ERROR_LABELS[k] || k}×${v}`).join(' ');
    return `<tr title="${esc(r.verdict || '')}">
      <td class="mono ellipsis" style="max-width:130px">${esc(m)}</td>
      <td class="num"><b style="color:${scoreColor(r.final)}">${r.final}</b>${r.ai != null ? '<span class="faint" style="font-size:11px"> AI</span>' : ''}</td>
      <td class="num">${fmtPct(r.successRate, 0)}</td>
      <td class="num">${fmtMs(r.ttftP50)}</td>
      <td class="num">${fmtNum(r.tpsP50, 0)}</td>
      <td>${errs ? `<span style="color:var(--bad)">${esc(errs)}</span>` : '<span class="faint">无</span>'}</td>
    </tr>`;
  }).join('');
  return `<div>
    <div class="section-title" style="display:flex;justify-content:space-between">
      <span>最近测试 ${lr.aborted ? '<span class="badge warn">中途停止</span>' : ''}</span>
      <a href="#report" data-act="open-report" data-run="${esc(lr.runId)}" class="faint" style="font-weight:400;font-size:12px">${esc(fmtTime(lr.at))} · 查看报告</a>
    </div>
    <div class="table-wrap"><table class="tbl mini">
      <thead><tr><th>模型</th><th class="num">得分</th><th class="num">成功率</th><th class="num">首字</th><th class="num">TPS</th><th>报错</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

async function onClick(e) {
  if (await handlePresetClick(e)) return undefined;
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const site = state.sites.find((s) => s.id === btn.dataset.id);
  if (act === 'toggle-add' || act === 'toggle-bulk') {
    e.preventDefault();
    const name = act === 'toggle-add' ? 'add' : 'bulk';
    ui.panel = ui.panel === name ? '' : name;
    $('#add-form', rootRef).classList.toggle('hidden', ui.panel !== 'add');
    $('#bulk-form', rootRef).classList.toggle('hidden', ui.panel !== 'bulk');
    if (ui.panel) $(`#${name}-form input, #${name}-form textarea`, rootRef)?.focus();
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
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>选择模型 · ${esc(site.name)}</h3>
        <div class="actions">
          <input class="input" placeholder="搜索模型…" data-search style="flex:1;min-width:160px">
          <button class="btn sm" data-m="fav" title="按设置中的常用模型关键字勾选">按常用关键字</button>
          <button class="btn sm" data-m="all">全选可见</button>
          <button class="btn sm" data-m="none">清空</button>
        </div>
      </div>
      <div class="modal-body"><div class="model-list" data-list></div></div>
      <div class="modal-foot">
        <span class="muted" data-count></span>
        <div class="actions"><button class="btn" data-m="cancel">取消</button><button class="btn primary" data-m="save">保存</button></div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const list = wrap.querySelector('[data-list]');
  const search = wrap.querySelector('[data-search]');
  const count = wrap.querySelector('[data-count]');
  const visible = () => {
    const q = search.value.trim().toLowerCase();
    return site.models.filter((m) => !q || m.toLowerCase().includes(q));
  };
  const draw = () => {
    list.innerHTML = visible().map((m) => `<label class="check"><input type="checkbox" value="${esc(m)}" ${selected.has(m) ? 'checked' : ''}> ${esc(m)}</label>`).join('')
      || '<div class="muted">没有匹配的模型</div>';
    count.textContent = `已选 ${selected.size} 个`;
  };
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
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
  search.focus();
}
