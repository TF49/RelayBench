// 动效层：GSAP + 移植的 react-bits 效果（原生实现，无 React）。
//
// 计时安全：首字延迟在浏览器主线程里测量。测试运行期间进入 quiet 模式：
// 暂停持续性的背景动画（极光、点阵重绘），只保留轻量的 transform/opacity 过渡。
// GSAP 加载失败或用户关闭动效 / 系统「减少动态效果」时，所有函数安全降级为直接显示。
import { fmtMs, fmtPct, fmtNum } from './dom.js';

const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
let userEnabled = true;
let quiet = false;
let triggers = [];   // 当前视图的 ScrollTrigger，切换视图时清理
let auroraTweens = [];

const G = () => window.gsap;
export const motionOn = () => userEnabled && !reducedMq.matches && !!G();

// ------------------------------------------------------------------ 初始化
export function initMotion({ enabled = true } = {}) {
  userEnabled = enabled;
  const gsap = G();
  if (gsap) {
    const plugins = ['Flip', 'SplitText', 'CustomEase', 'ScrollTrigger', 'ScrambleTextPlugin', 'DrawSVGPlugin']
      .map((n) => window[n]).filter(Boolean);
    gsap.registerPlugin(...plugins);
    if (window.CustomEase) {
      window.CustomEase.create('premium', '0.32,0.72,0,1');
      window.CustomEase.create('springy', '0.34,1.56,0.64,1');
    }
    gsap.defaults({ ease: window.CustomEase ? 'premium' : 'power3.out', duration: 0.7 });
  }
  applyFlags();
  initAurora();
  initDotGrid();
  initPointerFx();
  initClickSpark();
  reducedMq.addEventListener?.('change', applyFlags);
  document.addEventListener('visibilitychange', syncAmbient);
}

export function setMotionEnabled(v) {
  userEnabled = v;
  applyFlags();
}

/** 测试运行中：暂停持续性动画，保护计时精度。 */
export function setQuiet(v) {
  if (quiet === v) return;
  quiet = v;
  document.documentElement.classList.toggle('is-quiet', v);
  syncAmbient();
  dotgrid.draw?.();
}

function applyFlags() {
  document.documentElement.classList.toggle('motion-off', !motionOn());
  syncAmbient();
  dotgrid.draw?.();
}

function syncAmbient() {
  const run = motionOn() && !quiet && !document.hidden;
  auroraTweens.forEach((t) => (run ? t.resume() : t.pause()));
}

// ------------------------------------------------------------------ SoftAurora：环境光斑
function initAurora() {
  const gsap = G();
  const blobs = document.querySelectorAll('.ambient .blob');
  if (!gsap || !blobs.length) return;
  auroraTweens = [...blobs].map((b, i) => gsap.to(b, {
    xPercent: gsap.utils.random(-18, 18),
    yPercent: gsap.utils.random(-14, 14),
    scale: gsap.utils.random(0.85, 1.2),
    rotation: gsap.utils.random(-25, 25),
    duration: 14 + i * 5,
    ease: 'sine.inOut',
    repeat: -1,
    yoyo: true,
    repeatRefresh: true,
  }));
  syncAmbient();
}

// ------------------------------------------------------------------ DotGrid：点阵背景 + 指针邻近高亮
const dotgrid = {};
function initDotGrid() {
  const canvas = document.getElementById('dotgrid');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const GAP = 28;
  const R = 150;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let px = -9999;
  let py = -9999;
  let colors = {};
  let raf = 0;

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    colors = { dot: cs.getPropertyValue('--dot').trim() || 'rgba(0,0,0,.1)', hi: cs.getPropertyValue('--accent').trim() || '#1f6f62' };
  };
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  const draw = () => {
    raf = 0;
    ctx.clearRect(0, 0, w, h);
    const live = motionOn() && !quiet;
    const ox = (w % GAP) / 2;
    const oy = (h % GAP) / 2;
    for (let y = oy; y < h; y += GAP) {
      for (let x = ox; x < w; x += GAP) {
        let dx = 0;
        let dy = 0;
        let t = 0;
        if (live) {
          const ddx = x - px;
          const ddy = y - py;
          const d = Math.hypot(ddx, ddy);
          if (d < R) {
            t = (1 - d / R) ** 2;
            dx = (ddx / (d || 1)) * t * 7;
            dy = (ddy / (d || 1)) * t * 7;
          }
        }
        ctx.beginPath();
        ctx.fillStyle = t > 0.02 ? colors.hi : colors.dot;
        ctx.globalAlpha = t > 0.02 ? 0.25 + t * 0.6 : 1;
        ctx.arc(x + dx, y + dy, 1 + t * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
  dotgrid.draw = schedule;

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (e) => {
    if (!motionOn() || quiet || e.pointerType === 'touch') return;
    px = e.clientX;
    py = e.clientY;
    schedule();
  }, { passive: true });
  document.addEventListener('pointerleave', () => { px = py = -9999; schedule(); });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', () => { readColors(); schedule(); });
  readColors();
  resize();
}

// ------------------------------------------------------------------ 指针效果：SpotlightCard / Magnet / TiltedCard
function initPointerFx() {
  let magnetEl = null;
  let tiltEl = null;
  let frame = 0;
  let last = null;

  const resetMagnet = () => {
    if (magnetEl && G()) G().to(magnetEl, { x: 0, y: 0, duration: 0.9, ease: 'elastic.out(1, 0.45)' });
    magnetEl = null;
  };
  const resetTilt = () => {
    if (tiltEl && G()) G().to(tiltEl, { rotateX: 0, rotateY: 0, duration: 0.8 });
    tiltEl = null;
  };

  const run = () => {
    frame = 0;
    const e = last;
    if (!e) return;
    const el = e.target instanceof Element ? e.target : null;

    const spot = el?.closest('.spotlight');
    if (spot) {
      const r = spot.getBoundingClientRect();
      spot.style.setProperty('--mx', `${e.clientX - r.left}px`);
      spot.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
    if (!motionOn()) return;

    const mag = el?.closest('[data-magnet]');
    if (mag !== magnetEl) resetMagnet();
    if (mag && !mag.disabled) {
      magnetEl = mag;
      const r = mag.getBoundingClientRect();
      const strength = Number(mag.dataset.magnet) || 0.28;
      G().to(mag, { x: (e.clientX - (r.left + r.width / 2)) * strength, y: (e.clientY - (r.top + r.height / 2)) * strength, duration: 0.4, ease: 'power3.out' });
    }

    const tilt = quiet ? null : el?.closest('[data-tilt]');
    if (tilt !== tiltEl) resetTilt();
    if (tilt) {
      tiltEl = tilt;
      const r = tilt.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      G().to(tilt, { rotateY: nx * 7, rotateX: -ny * 7, transformPerspective: 900, duration: 0.5, ease: 'power3.out' });
    }
  };

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    last = e;
    if (!frame) frame = requestAnimationFrame(run);
  }, { passive: true });
  document.addEventListener('pointerleave', () => { resetMagnet(); resetTilt(); });
}

// ------------------------------------------------------------------ ClickSpark：点击火花
function initClickSpark() {
  const canvas = document.getElementById('sparks');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let sparks = [];
  let raf = 0;
  let color = '#1f6f62';
  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const tick = (now) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    sparks = sparks.filter((s) => now - s.t0 < 420);
    for (const s of sparks) {
      const p = (now - s.t0) / 420;
      const eased = 1 - (1 - p) ** 3;
      const dist = eased * 22;
      const len = 8 * (1 - eased);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 1 - p;
      ctx.beginPath();
      ctx.moveTo(s.x + Math.cos(s.a) * dist, s.y + Math.sin(s.a) * dist);
      ctx.lineTo(s.x + Math.cos(s.a) * (dist + len), s.y + Math.sin(s.a) * (dist + len));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    raf = sparks.length ? requestAnimationFrame(tick) : 0;
  };
  window.addEventListener('resize', resize);
  resize();
  document.addEventListener('pointerdown', (e) => {
    if (!motionOn()) return;
    if (!(e.target instanceof Element) || !e.target.closest('button, a, .seg-btn, [data-spark]')) return;
    color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || color;
    const t0 = performance.now();
    for (let i = 0; i < 8; i += 1) sparks.push({ x: e.clientX, y: e.clientY, a: (Math.PI * 2 * i) / 8, t0 });
    if (!raf) raf = requestAnimationFrame(tick);
  });
}

// ------------------------------------------------------------------ 视图入场
/**
 * 视图挂载后调用：
 *  [data-split]   标题逐字模糊入场（SplitText / BlurText）
 *  [data-reveal]  内容块错峰上浮入场（AnimatedContent），屏幕外的滚动到时再入场（ScrollTrigger.batch）
 *  [data-count]   数字滚动（CountUp）
 *  [data-ring]    评分环描边（DrawSVG）
 *  [data-scramble] 解密文字（DecryptedText）
 */
export function enterView(root) {
  triggers.forEach((t) => t.kill());
  triggers = [];
  const gsap = G();
  if (!motionOn()) {
    root.querySelectorAll('[data-ring]').forEach(setRingFinal);
    return;
  }
  gsap.fromTo(root, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, clearProps: 'transform,opacity' });
  splitIn(root.querySelectorAll('[data-split]'));
  reveal(root);
  countUps(root);
  rings(root);
  scrambles(root);
}

/** 对新插入的局部内容做同样的入场处理（不含整页淡入）。 */
export function enterPart(el) {
  if (!el) return;
  if (!motionOn()) {
    el.querySelectorAll('[data-ring]').forEach(setRingFinal);
    return;
  }
  reveal(el, true);
  countUps(el);
  rings(el);
  scrambles(el);
}

function splitIn(nodes) {
  const gsap = G();
  nodes.forEach((node) => {
    if (!window.SplitText) {
      gsap.from(node, { opacity: 0, y: 16, filter: 'blur(8px)', duration: 0.8 });
      return;
    }
    const split = new window.SplitText(node, { type: 'chars', charsClass: 'split-char' });
    gsap.from(split.chars, {
      opacity: 0,
      y: '0.45em',
      filter: 'blur(10px)',
      duration: 0.9,
      stagger: 0.028,
      onComplete: () => split.revert(),
    });
  });
}

function reveal(root, immediate = false) {
  const gsap = G();
  const items = [...root.querySelectorAll('[data-reveal]')];
  if (root.matches?.('[data-reveal]')) items.unshift(root);
  if (!items.length) return;
  const vh = window.innerHeight;
  const now = [];
  const later = [];
  for (const el of items) (immediate || el.getBoundingClientRect().top < vh ? now : later).push(el);
  if (now.length) {
    gsap.fromTo(now, { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.85, stagger: 0.06, clearProps: 'transform,opacity' });
  }
  if (later.length && window.ScrollTrigger) {
    gsap.set(later, { opacity: 0, y: 30 });
    triggers.push(...window.ScrollTrigger.batch(later, {
      start: 'top 92%',
      once: true,
      onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 0.85, stagger: 0.07, clearProps: 'transform,opacity' }),
    }));
  }
}

const FORMATS = {
  int: (v) => String(Math.round(v)),
  fixed1: (v) => fmtNum(v, 1),
  pct: (v) => fmtPct(v, 1),
  pct0: (v) => fmtPct(v, 0),
  ms: (v) => fmtMs(v),
  money: (v) => `$${v.toFixed(v >= 100 ? 2 : v >= 1 ? 3 : 4)}`,
};

function countUps(root) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count);
    if (!Number.isFinite(to)) return;
    countTo(el, to, el.dataset.format || 'int', 0);
  });
}

/** CountUp：把元素里的数字从 from（默认取上次的值）滚动到 to。 */
export function countTo(el, to, format = 'int', from) {
  const f = FORMATS[format] || FORMATS.int;
  const prev = from ?? (Number(el.dataset.v) || 0);
  el.dataset.v = String(to);
  if (!motionOn() || !Number.isFinite(to)) {
    el.textContent = f(to);
    return;
  }
  if (prev === to) {
    el.textContent = f(to);
    return;
  }
  const o = { v: prev };
  G().to(o, { v: to, duration: quiet ? 0.45 : 1.1, ease: 'power3.out', onUpdate: () => { el.textContent = f(o.v); } });
}

function setRingFinal(el) {
  const c = el.querySelector('.ring-val');
  const v = Math.max(0, Math.min(100, Number(el.dataset.ring) || 0));
  if (c) c.style.strokeDasharray = `${v} 100`;
}

function rings(root) {
  root.querySelectorAll('[data-ring]').forEach((el) => {
    const c = el.querySelector('.ring-val');
    const v = Math.max(0, Math.min(100, Number(el.dataset.ring) || 0));
    if (!c) return;
    if (window.DrawSVGPlugin) G().fromTo(c, { drawSVG: '0%' }, { drawSVG: `0% ${v}%`, duration: 1.4, delay: 0.15 });
    else setRingFinal(el);
  });
}

function scrambles(root) {
  if (!window.ScrambleTextPlugin) return;
  root.querySelectorAll('[data-scramble]').forEach((el) => {
    const text = el.textContent;
    G().to(el, { duration: 0.9, scrambleText: { text, chars: '0123456789ABCDEFSAB', speed: 0.5, revealDelay: 0.2 } });
  });
}

/** 鼠标悬停时重新解密一遍（品牌名等）。 */
export function scrambleOnHover(el) {
  if (!el) return;
  const text = el.textContent;
  el.addEventListener('pointerenter', () => {
    if (!motionOn() || !window.ScrambleTextPlugin) return;
    G().to(el, { duration: 0.7, scrambleText: { text, chars: 'RELAYBNCH01', speed: 0.6 } });
  });
}

// ------------------------------------------------------------------ AnimatedList：新增条目入场
export function listIn(nodes, { from = 'top' } = {}) {
  if (!motionOn() || !nodes.length) return;
  G().fromTo(nodes, { opacity: 0, y: from === 'top' ? -10 : 14, scale: 0.985 }, {
    opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.04, clearProps: 'transform,opacity',
  });
}

/** 数值变化时闪一下（AI 分到达等）。 */
export function flash(el) {
  if (!motionOn() || !el) return;
  G().fromTo(el, { backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'rgba(0,0,0,0)', duration: 1.4, ease: 'power2.out', clearProps: 'backgroundColor' });
}

// ------------------------------------------------------------------ Flip：布局变化过渡
export function flipCapture(targets) {
  if (!motionOn() || !window.Flip) return null;
  return window.Flip.getState(targets);
}

export function flipPlay(state, targets) {
  if (!state || !motionOn()) return;
  window.Flip.from(state, { targets, duration: 0.6, ease: 'premium', absolute: false, nested: true, onEnter: (els) => G().fromTo(els, { opacity: 0 }, { opacity: 1, duration: 0.4 }) });
}

// ------------------------------------------------------------------ PillNav：导航指示器
export function moveNavIndicator(ind, link, instant = false) {
  if (!ind || !link) return;
  const x = link.offsetLeft;
  const w = link.offsetWidth;
  if (!motionOn() || instant || !ind.dataset.ready) {
    ind.style.width = `${w}px`;
    ind.style.transform = `translateX(${x}px)`;
    ind.dataset.ready = '1';
    return;
  }
  G().to(ind, { x, width: w, duration: 0.6, ease: 'premium' });
}

// ------------------------------------------------------------------ 浮层：Toast / Modal
export function toastIn(el) {
  if (!motionOn()) return;
  G().fromTo(el, { opacity: 0, y: 18, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.55, ease: window.CustomEase ? 'springy' : 'back.out(1.6)' });
}

export function toastOut(el, done) {
  if (!motionOn()) return done();
  G().to(el, { opacity: 0, y: 8, scale: 0.96, duration: 0.3, ease: 'power2.in', onComplete: done });
  return undefined;
}

export function modalIn(backdrop, modal) {
  if (!motionOn()) return;
  const gsap = G();
  gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.35, ease: 'power2.out' });
  gsap.fromTo(modal, { opacity: 0, y: 28, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.6 });
  const items = modal.querySelectorAll('[data-list-item]');
  if (items.length && items.length < 120) gsap.fromTo(items, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.008, delay: 0.12, clearProps: 'transform,opacity' });
}

export function modalOut(backdrop, modal, done) {
  if (!motionOn()) return done();
  const gsap = G();
  gsap.to(modal, { opacity: 0, y: 14, scale: 0.98, duration: 0.25, ease: 'power2.in' });
  gsap.to(backdrop, { opacity: 0, duration: 0.3, ease: 'power2.in', onComplete: done });
  return undefined;
}

/** 展开的详情面板入场。 */
export function expandIn(el) {
  if (!motionOn() || !el) return;
  G().fromTo(el, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: 0.55, clearProps: 'transform,opacity' });
  enterPart(el);
}
