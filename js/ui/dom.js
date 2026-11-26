// DOM 与格式化小工具。
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, type = 'info', ms = 3200) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const fmtMs = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
};
export const fmtPct = (r, d = 1) => (r == null || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(d)}%`);
export const fmtNum = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');
export const fmtClock = (ts) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '');
export function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function fmtMoney(v, unit = 'USD') {
  if (v == null || !Number.isFinite(v)) return '—';
  const sym = unit === 'USD' ? '$' : unit === 'CNY' ? '¥' : '';
  const digits = Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 3 : 4;
  return `${sym}${v.toFixed(digits)}${sym ? '' : ` ${unit}`}`;
}

export function fmtBalance(b) {
  if (!b) return '—';
  if (b.unlimited) return b.used != null ? `无限额度（已用 ${fmtMoney(b.used, b.unit)}）` : '无限额度';
  return fmtMoney(b.remaining, b.unit);
}

export function maskKey(k) {
  if (!k) return '';
  return k.length <= 10 ? '••••' : `${k.slice(0, 5)}••••${k.slice(-4)}`;
}

export function scoreColor(score) {
  if (score == null) return 'var(--faint)';
  if (score >= 90) return 'var(--g-s)';
  if (score >= 80) return 'var(--g-a)';
  if (score >= 70) return 'var(--g-b)';
  if (score >= 60) return 'var(--g-c)';
  return 'var(--g-d)';
}

export function download(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 简易确认框（原生 confirm 足够用）。 */
export const confirmBox = (msg) => window.confirm(msg);
