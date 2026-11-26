// 入口：加载持久化数据，按 hash 切换视图，把状态变化分发给当前视图。
import { state, loadAll, subscribe } from './state.js';
import * as sites from './ui/sites.js';
import * as run from './ui/run.js';
import * as report from './ui/report.js';
import * as history from './ui/history.js';
import * as settings from './ui/settings.js';
import { toast } from './ui/dom.js';

const VIEWS = { sites, run, report, history, settings };
const root = document.getElementById('view');
let current = null;

function route() {
  const name = (location.hash || '#sites').slice(1);
  const view = VIEWS[name] ? name : 'sites';
  current = view;
  root.onclick = null;
  root.onchange = null;
  root.onsubmit = null;
  VIEWS[view].render(root);
  updateNav();
  window.scrollTo(0, 0);
}

function updateNav() {
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.dataset.view === current);
    const running = state.current?.status === 'running';
    const dot = a.querySelector('.dot');
    if (a.dataset.view === 'run' && running && !dot) a.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
    if (dot && !(a.dataset.view === 'run' && running)) dot.remove();
  }
}

let rafPending = false;
subscribe((what) => {
  if (what === 'run' || what === 'run-progress') updateNav();
  // 高频进度事件合并到一帧刷新一次
  if (what === 'run-progress') {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      VIEWS[current]?.onState?.('run-progress');
    });
    return;
  }
  VIEWS[current]?.onState?.(what);
});

window.addEventListener('hashchange', route);
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
  route();
})();
