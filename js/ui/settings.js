// 设置视图：AI 评审 + 测试参数。
import { state, saveSettings, saveJudge, resolveJudge } from '../state.js';
import { completeOnce } from '../core/client.js';
import { listModels, normalizeBaseUrl } from '../core/relay.js';
import { DEFAULT_SETTINGS } from '../core/runner.js';
import { esc, toast, $ } from './dom.js';

let rootRef = null;
let customModels = [];

export function render(root) {
  rootRef = root;
  const s = state.settings;
  root.innerHTML = `
    <div class="page-head"><div><h1>设置</h1><p>修改后自动保存在本机浏览器。</p></div></div>

    <form class="panel panel-pad" id="judge-form" autocomplete="off"></form>

    <form class="panel panel-pad" id="settings-form" style="margin-top:16px" autocomplete="off">
      <h2>测试参数</h2>
      <div class="grid c3">
        <label class="field"><span>每个模型的稳定性请求数</span><input class="input" type="number" min="1" max="200" name="requestsPerModel" value="${s.requestsPerModel}"><small>越多越准，也越费额度</small></label>
        <label class="field"><span>每站并发</span><input class="input" type="number" min="1" max="6" name="concurrencyPerSite" value="${s.concurrencyPerSite}"><small>同一站点同时在途的请求数</small></label>
        <label class="field"><span>全局并发</span><input class="input" type="number" min="1" max="6" name="concurrencyGlobal" value="${s.concurrencyGlobal}"><small>所有站点合计，最多 6（浏览器同主机连接上限）</small></label>
        <label class="field"><span>首字超时（秒）</span><input class="input" type="number" min="3" max="600" name="ttftTimeoutSec" value="${s.ttftTimeoutSec}"></label>
        <label class="field"><span>总超时（秒）</span><input class="input" type="number" min="5" max="1800" name="totalTimeoutSec" value="${s.totalTimeoutSec}"></label>
        <label class="field"><span>AI 分权重（0–1）</span><input class="input" type="number" min="0" max="1" step="0.1" name="aiWeight" value="${s.aiWeight}"><small>综合分 = 规则分 × (1−w) + AI 分 × w</small></label>
      </div>
      <div style="margin-top:14px" class="grid">
        <label class="field"><span>质量题</span>
          <select class="input" name="probeSet" style="max-width:360px">
            ${[['none', '不跑质量题'], ['basic', '基础 2 道（算术、JSON）'], ['full', '全部 4 道（算术、指令遵循、JSON、推理）']].map(([v, l]) => `<option value="${v}" ${s.probeSet === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <small>档位（快速 3+2 / 标准 6+4 / 深度 15+4）可在「站点」或「测试」页一键切换；这里改数字即为自定义。</small>
        </label>
        <label class="field"><span>常用模型关键字（逗号分隔，检测站点时自动预选包含这些关键字的模型）</span>
          <input class="input" name="favoriteKeywords" value="${esc((s.favoriteKeywords || []).join(', '))}">
        </label>
      </div>
      <div class="actions" style="margin-top:14px"><button type="button" class="btn ghost" data-act="reset">恢复默认参数</button></div>
    </form>`;

  root.onchange = onChange;
  root.onsubmit = (e) => e.preventDefault();
  root.onclick = onClick;
  drawJudge();
}

export function onState(what) {
  // 站点变化（新增/检测完成）会影响「从站点挑选」的选项
  if (what === 'sites' && rootRef?.isConnected) drawJudge();
}

function usableSites() {
  return state.sites.filter((x) => x.apiKey && x.models?.length);
}

function judgeStatusLine() {
  const r = resolveJudge();
  if (!state.judge.enabled) return '<div class="notice">AI 评审已关闭，测试只给规则分。</div>';
  if (!r) {
    return state.judge.source === 'custom'
      ? '<div class="notice bad">自定义评审渠道的地址、Key、模型还没填完整，测试时将只给规则分。</div>'
      : '<div class="notice bad">还没有可用的评审模型：请先在「站点」页添加并检测至少一个站点（需要有 Key），或改用自定义渠道。</div>';
  }
  return `<div class="notice info">当前评审：<b class="mono">${esc(r.model)}</b> @ ${esc(r.label)}${r.auto ? '（自动挑选，可在上方指定）' : ''}</div>`;
}

function drawJudge() {
  const f = $('#judge-form', rootRef);
  if (!f) return;
  const j = state.judge;
  const sites = usableSites();
  const site = sites.find((x) => x.id === j.siteId);
  const protoOptions = [['auto', '自动（claude 走 messages）'], ['openai', 'OpenAI chat/completions'], ['anthropic', 'Anthropic messages']]
    .map(([v, l]) => `<option value="${v}" ${j.protocol === v ? 'selected' : ''}>${l}</option>`).join('');
  f.innerHTML = `
    <h2>AI 评审</h2>
    <p class="muted" style="margin:-4px 0 14px">每个站点×模型测完后，把成功率、错误、速度数据和质量题回答交给评审模型，给出 0–100 分、一句话结论、优缺点和建议，最后再生成一段综合点评。建议用强模型（Claude Sonnet / GPT-5 级别）。</p>
    <label class="check" style="margin-bottom:14px"><input type="checkbox" name="enabled" ${j.enabled ? 'checked' : ''}> 启用 AI 评审</label>
    <div class="${j.enabled ? '' : 'hidden'}">
      <div class="grid c3">
        <label class="field"><span>评审模型来源</span>
          <select class="input" name="source">
            <option value="site" ${j.source !== 'custom' ? 'selected' : ''}>使用已添加站点的模型</option>
            <option value="custom" ${j.source === 'custom' ? 'selected' : ''}>单独填写一个渠道</option>
          </select>
        </label>
        ${j.source !== 'custom' ? `
        <label class="field"><span>站点</span>
          <select class="input" name="siteId">
            <option value="">自动挑选（推荐）</option>
            ${sites.map((x) => `<option value="${esc(x.id)}" ${x.id === j.siteId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>模型</span>
          <select class="input" name="siteModel" ${site ? '' : 'disabled'}>
            ${site ? site.models.map((m) => `<option value="${esc(m)}" ${m === j.model ? 'selected' : ''}>${esc(m)}</option>`).join('') : '<option>自动</option>'}
          </select>
        </label>` : `
        <label class="field"><span>协议</span><select class="input" name="protocol">${protoOptions}</select></label>
        <div></div>
        <label class="field"><span>地址</span><input class="input" name="baseUrl" value="${esc(j.baseUrl)}" placeholder="https://api.example.com"></label>
        <label class="field"><span>Key</span><input class="input" name="apiKey" type="password" value="${esc(j.apiKey)}" placeholder="sk-..."></label>
        <label class="field"><span>模型</span>
          <div class="inline-form">
            <input class="input" name="model" list="judge-models" value="${esc(j.model)}" placeholder="例如 claude-sonnet-4-5">
            <datalist id="judge-models">${customModels.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
            <button type="button" class="btn" data-act="pull-models">拉取</button>
          </div>
        </label>
        <label class="check"><input type="checkbox" name="rememberKey" ${j.rememberKey ? 'checked' : ''}> 记住 Key</label>`}
      </div>
      <div class="actions" style="margin-top:14px;align-items:flex-start;gap:12px;flex-wrap:nowrap">
        <div style="flex:1" data-judge-status>${judgeStatusLine()}</div>
        <button type="button" class="btn" data-act="test-judge">测试评审连接</button>
      </div>
      <div data-judge-msg style="margin-top:10px"></div>
    </div>`;
}

function clampInt(v, lo, hi, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

async function onChange(e) {
  const form = e.target.form;
  if (!form) return;
  if (form.id === 'judge-form') {
    const name = e.target.name;
    const patch = {};
    if (name === 'enabled') patch.enabled = e.target.checked;
    else if (name === 'source') patch.source = e.target.value;
    else if (name === 'siteId') {
      patch.siteId = e.target.value;
      const site = state.sites.find((x) => x.id === e.target.value);
      // 选了站点后默认挑这个站里最合适的模型
      patch.model = site ? (pickFrom(site) || site.models[0] || '') : '';
    } else if (name === 'siteModel') patch.model = e.target.value;
    else if (name === 'baseUrl') patch.baseUrl = normalizeBaseUrl(e.target.value);
    else if (name === 'apiKey') patch.apiKey = e.target.value.trim();
    else if (name === 'model') patch.model = e.target.value.trim();
    else if (name === 'protocol') patch.protocol = e.target.value;
    else if (name === 'rememberKey') patch.rememberKey = e.target.checked;
    if (name === 'source') {
      // 切换来源时清掉另一种来源的模型选择，避免串用
      patch.model = '';
      patch.siteId = '';
    }
    await saveJudge(patch);
    if (['enabled', 'source', 'siteId'].includes(name)) drawJudge();
    else {
      const st = $('[data-judge-status]', rootRef);
      if (st) st.innerHTML = judgeStatusLine();
    }
  } else if (form.id === 'settings-form') {
    const fd = new FormData(form);
    const d = DEFAULT_SETTINGS;
    const aiWeight = Number(fd.get('aiWeight'));
    await saveSettings({
      requestsPerModel: clampInt(fd.get('requestsPerModel'), 1, 200, d.requestsPerModel),
      concurrencyPerSite: clampInt(fd.get('concurrencyPerSite'), 1, 6, d.concurrencyPerSite),
      concurrencyGlobal: clampInt(fd.get('concurrencyGlobal'), 1, 6, d.concurrencyGlobal),
      ttftTimeoutSec: clampInt(fd.get('ttftTimeoutSec'), 3, 600, d.ttftTimeoutSec),
      totalTimeoutSec: clampInt(fd.get('totalTimeoutSec'), 5, 1800, d.totalTimeoutSec),
      aiWeight: Number.isFinite(aiWeight) ? Math.min(1, Math.max(0, aiWeight)) : d.aiWeight,
      probeSet: ['none', 'basic', 'full'].includes(fd.get('probeSet')) ? fd.get('probeSet') : d.probeSet,
      favoriteKeywords: String(fd.get('favoriteKeywords') || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean),
    });
  }
}

function pickFrom(site) {
  return site.models.find((m) => /claude-(opus|sonnet)-4/i.test(m))
    || site.models.find((m) => /^gpt-5/i.test(m))
    || site.models.find((m) => /gpt-4\.1|gpt-4o(?!-mini)|gemini.*pro|deepseek-(chat|v3)/i.test(m));
}

async function onClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'reset') {
    await saveSettings({ ...DEFAULT_SETTINGS });
    render(rootRef);
    toast('已恢复默认参数');
  } else if (act === 'pull-models') {
    const j = state.judge;
    if (!j.baseUrl || !j.apiKey) return toast('先填写地址和 Key', 'bad');
    const r = await listModels(j.baseUrl, j.apiKey);
    if (!r.ok) return toast(r.error, 'bad', 5000);
    customModels = r.models;
    $('#judge-models', rootRef).innerHTML = customModels.map((m) => `<option value="${esc(m)}">`).join('');
    toast(`已拉取 ${r.models.length} 个模型，点击模型输入框选择`, 'ok');
  } else if (act === 'test-judge') {
    const msg = $('[data-judge-msg]', rootRef);
    const r0 = resolveJudge();
    if (!r0) return toast('当前没有可用的评审模型', 'bad');
    msg.innerHTML = `<div class="phase"><span class="spinner"></span> 正在用 ${esc(r0.model)} 测试…</div>`;
    const t0 = performance.now();
    const r = await completeOnce({ ...r0, prompt: '请只回复 JSON：{"score": 100}', timeoutMs: 60000 });
    const ms = Math.round(performance.now() - t0);
    msg.innerHTML = r.ok
      ? `<div class="notice info">连接成功（${ms}ms），模型回复：<span class="mono">${esc(r.text.slice(0, 200))}</span></div>`
      : `<div class="notice bad">连接失败：${esc(r.error)}</div>`;
  }
  return undefined;
}
