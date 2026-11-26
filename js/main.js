// 入口：加载持久化数据，按 hash 切换视图，把状态变化分发给当前视图；初始化动效层。
import { state, loadAll, subscribe } from './state.js';
import * as sites from './ui/sites.js';
import * as run from './ui/run.js';
import * as report from './ui/report.js';
import * as history from './ui/history.js';
import * as settings from './ui/settings.js';
import { toast } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { initMotion, enterView, moveNavIndicator, setQuiet, scrambleOnHover } from './ui/motion.js';

const VIEWS = { sites, run, report, history, settings };
const NAV = {
  sites: ['sites', '站点'],
  run: ['run', '测试'],
  report: ['report', '报告'],
  history: ['history', '历史'],
  settings: ['settings', '设置'],
};
const root = document.getElementById('view');
const navInd = document.getElementById('nav-ind');
let current = null;

for (const a of document.querySelectorAll('#nav a')) {
  const [ic, label] = NAV[a.dataset.view];
  a.innerHTML = `${icon(ic, 16)}<span class="lbl">${label}</span>`;
  a.setAttribute('aria-label', label);
}

function route() {
  const name = (location.hash || '#sites').slice(1);
  const view = VIEWS[name] ? name : 'sites';
  current = view;
  root.onclick = null;
  root.onchange = null;
  root.onsubmit = null;
  VIEWS[view].render(root);
  updateNav();
  window.scrollTo({ top: 0 });
  enterView(root);
}

function updateNav(instant = false) {
  let activeLink = null;
  for (const a of document.querySelectorAll('#nav a')) {
    const on = a.dataset.view === current;
    a.classList.toggle('active', on);
    if (on) {
      a.setAttribute('aria-current', 'page');
      activeLink = a;
    } else {
      a.removeAttribute('aria-current');
    }
  }
  // 窄屏下激活项会显示文字、宽度变化：等布局完成后再移动指示器
  requestAnimationFrame(() => moveNavIndicator(navInd, activeLink, instant));
  const running = state.current?.status === 'running';
  const chip = document.getElementById('run-chip');
  chip.classList.toggle('on', running && current !== 'run');
}

function updateRunChip() {
  const cur = state.current;
  if (cur?.status !== 'running') return;
  let total = 0;
  let done = 0;
  for (const j of cur.jobs.values()) {
    total += j.total;
    done += j.done;
  }
  const el = document.querySelector('[data-run-chip-text]');
  if (el) el.textContent = total ? `测试中 ${done}/${total}` : '测试中';
}

let rafPending = false;
subscribe((what) => {
  if (what === 'run') {
    setQuiet(state.current?.status === 'running');
    updateNav();
  }
  if (what === 'run-progress') {
    // 高频进度事件合并到一帧刷新一次
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateRunChip();
      VIEWS[current]?.onState?.('run-progress');
    });
    return;
  }
  if (what === 'settings') settingsChanged();
  VIEWS[current]?.onState?.(what);
});

let lastMotion = null;
function settingsChanged() {
  const m = state.settings.motion !== false;
  if (lastMotion !== null && m !== lastMotion) import('./ui/motion.js').then((mod) => mod.setMotionEnabled(m));
  lastMotion = m;
}

window.addEventListener('hashchange', route);
window.addEventListener('resize', () => updateNav(true));
window.addEventListener('beforeunload', (e) => {
  if (state.current?.status === 'running') {
    e.preventDefault();
    e.returnValue = '';
  }
});

(async () => {
  try {
    const health = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    if (!health?.ok) {
      toast('未检测到本地代理：请用 python server.py 启动后访问 http://127.0.0.1:8000/', 'bad', 10000);
    }
    await loadAll();
  } catch (err) {
    console.error(err);
    toast(`加载本地数据失败：${err?.message || err}`, 'bad', 8000);
  }
  lastMotion = state.settings.motion !== false;
  initMotion({ enabled: lastMotion });
  scrambleOnHover(document.getElementById('brand-name'));
  route();
})();
