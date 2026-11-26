// 测试档位切换（快速 / 标准 / 深度），站点页与测试页共用。
import { state, saveSettings } from '../state.js';
import { PRESETS, presetOf, requestsPerModelTotal } from '../core/runner.js';
import { esc } from './dom.js';

export function presetSwitchHtml() {
  const cur = presetOf(state.settings);
  const btns = Object.entries(PRESETS).map(([key, p]) => {
    const n = requestsPerModelTotal({ ...state.settings, ...p });
    return `<button type="button" class="seg-btn ${cur === key ? 'active' : ''}" data-act="preset" data-preset="${key}" title="${esc(p.desc)}">
      ${esc(p.label)} <span class="seg-sub">${n} 次/模型</span></button>`;
  }).join('');
  const custom = cur === 'custom'
    ? `<span class="seg-btn active" title="在设置中自定义">自定义 <span class="seg-sub">${requestsPerModelTotal(state.settings)} 次/模型</span></span>`
    : '';
  return `<div class="seg" role="group" aria-label="测试档位">${btns}${custom}</div>`;
}

/** 处理档位按钮点击；是档位按钮返回 true。 */
export async function handlePresetClick(e) {
  const btn = e.target.closest('[data-act="preset"]');
  if (!btn) return false;
  const p = PRESETS[btn.dataset.preset];
  if (p) await saveSettings({ requestsPerModel: p.requestsPerModel, probeSet: p.probeSet });
  return true;
}
