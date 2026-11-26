// 设置视图：AI 评审渠道 + 测试参数。
import { state, saveSettings, saveJudge } from '../state.js';
import { completeOnce } from '../core/client.js';
import { listModels, normalizeBaseUrl } from '../core/relay.js';
import { DEFAULT_SETTINGS } from '../core/runner.js';
import { esc, toast, $ } from './dom.js';

let rootRef = null;
let judgeModels = [];

export function render(root) {
  rootRef = root;
  const j = state.judge;
  const s = state.settings;
  root.innerHTML = `
    <div class="page-head"><div><h1>设置</h1><p>修改后自动保存在本机浏览器。</p></div></div>

    <form class="panel panel-pad" id="judge-form" autocomplete="off">
      <h2>AI 评审渠道</h2>
      <p class="muted" style="margin:-4px 0 14px">用一个稳定可靠的模型给所有被测渠道统一打分（建议用强模型，例如 Claude Sonnet / GPT-5 级别）。</p>
      <label class="check" style="margin-bottom:14px"><input type="checkbox" name="enabled" ${j.enabled ? 'checked' : ''}> 启用 AI 评审</label>
      <div class="grid c2">
        <label class="field"><span>从已添加站点填入</span>
          <select class="input" name="fromSite">
            <option value="">— 手动填写 —</option>
            ${state.sites.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>协议</span>
          <select class="input" name="protocol">
            ${[['auto', '自动（claude 走 messages）'], ['openai', 'OpenAI chat/completions'], ['anthropic', 'Anthropic messages']].map(([v, l]) => `<option value="${v}" ${j.protocol === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>地址</span><input class="input" name="baseUrl" value="${esc(j.baseUrl)}" placeholder="https://api.example.com"></label>
        <label class="field"><span>Key</span><input class="input" name="apiKey" type="password" value="${esc(j.apiKey)}" placeholder="sk-..."></label>
        <label class="field"><span>评审模型</span>
          <div class="inline-form">
            <input class="input" name="model" list="judge-models" value="${esc(j.model)}" placeholder="例如 claude-sonnet-4-5">
            <datalist id="judge-models">${judgeModels.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
            <button type="button" class="btn" data-act="pull-models">拉取</button>
          </div>
        </label>
        <div class="field"><span>&nbsp;</span>
          <div class="actions" style="justify-content:space-between">
            <label class="check"><input type="checkbox" name="rememberKey" ${j.rememberKey ? 'checked' : ''}> 记住 Key</label>
            <button type="button" class="btn" data-act="test-judge">测试评审连接</button>
          </div>
        </div>
      </div>
      <div data-judge-msg style="margin-top:12px"></div>
    </form>

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
        <label class="check"><input type="checkbox" name="qualityProbes" ${s.qualityProbes ? 'checked' : ''}> 运行质量题（算术、指令遵循、JSON、推理，各 1 次）</label>
        <label class="field"><span>常用模型关键字（逗号分隔，检测站点时自动预选包含这些关键字的模型）</span>
          <input class="input" name="favoriteKeywords" value="${esc((s.favoriteKeywords || []).join(', '))}">
        </label>
      </div>
      <div class="actions" style="margin-top:14px"><button type="button" class="btn ghost" data-act="reset">恢复默认参数</button></div>
    </form>`;

  root.onchange = onChange;
  root.onsubmit = (e) => e.preventDefault();
  root.onclick = onClick;
}

export function onState() {}

function readJudge() {
  const f = $('#judge-form', rootRef);
  const fd = new FormData(f);
  return {
    enabled: fd.get('enabled') === 'on',
    baseUrl: normalizeBaseUrl(fd.get('baseUrl')),
    apiKey: String(fd.get('apiKey') || '').trim(),
    model: String(fd.get('model') || '').trim(),
    protocol: fd.get('protocol'),
    rememberKey: fd.get('rememberKey') === 'on',
  };
}

function clampInt(v, lo, hi, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

async function onChange(e) {
  const form = e.target.form;
  if (!form) return;
  if (form.id === 'judge-form') {
    if (e.target.name === 'fromSite' && e.target.value) {
      const site = state.sites.find((x) => x.id === e.target.value);
      if (site) {
        form.baseUrl.value = site.baseUrl;
        form.apiKey.value = site.apiKey || '';
        if (!site.apiKey) toast('该站点的 Key 未保存，请手动填写', 'bad');
        judgeModels = site.models || [];
        $('#judge-models', rootRef).innerHTML = judgeModels.map((m) => `<option value="${esc(m)}">`).join('');
      }
      e.target.value = '';
    }
    await saveJudge(readJudge());
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
      qualityProbes: fd.get('qualityProbes') === 'on',
      favoriteKeywords: String(fd.get('favoriteKeywords') || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean),
    });
  }
}

async function onClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const msg = $('[data-judge-msg]', rootRef);
  if (act === 'reset') {
    await saveSettings({ ...DEFAULT_SETTINGS });
    render(rootRef);
    toast('已恢复默认参数');
  } else if (act === 'pull-models') {
    const j = readJudge();
    if (!j.baseUrl || !j.apiKey) return toast('先填写地址和 Key', 'bad');
    const r = await listModels(j.baseUrl, j.apiKey);
    if (!r.ok) return toast(r.error, 'bad', 5000);
    judgeModels = r.models;
    $('#judge-models', rootRef).innerHTML = judgeModels.map((m) => `<option value="${esc(m)}">`).join('');
    toast(`已拉取 ${r.models.length} 个模型，点击模型输入框选择`, 'ok');
  } else if (act === 'test-judge') {
    const j = readJudge();
    await saveJudge(j);
    if (!j.baseUrl || !j.apiKey || !j.model) return toast('地址、Key、模型都要填写', 'bad');
    msg.innerHTML = '<div class="phase"><span class="spinner"></span> 正在测试…</div>';
    const t0 = performance.now();
    const r = await completeOnce({ ...j, prompt: '请只回复 JSON：{"score": 100}', timeoutMs: 60000 });
    const ms = Math.round(performance.now() - t0);
    msg.innerHTML = r.ok
      ? `<div class="notice info">连接成功（${ms}ms），模型回复：<span class="mono">${esc(r.text.slice(0, 200))}</span></div>`
      : `<div class="notice bad">连接失败：${esc(r.error)}</div>`;
  }
  return undefined;
}
