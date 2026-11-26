// 历史视图：运行记录列表，可打开、删除。
import { state, loadRun, deleteRun } from '../state.js';
import { esc, fmtTime, fmtDuration, scoreColor, confirmBox, toast } from './dom.js';
import { showRun } from './report.js';

let rootRef = null;

export function render(root) {
  rootRef = root;
  root.onclick = onClick;
  root.onsubmit = null;
  root.onchange = null;
  draw();
}

export function onState(what) {
  if (rootRef?.isConnected && what === 'runs') draw();
}

function draw() {
  const runs = state.runs;
  rootRef.innerHTML = `
    <div class="page-head"><div><h1>历史</h1><p>测试记录保存在本机浏览器（IndexedDB），不包含任何 Key。</p></div></div>
    ${runs.length ? `
    <div class="panel"><div class="table-wrap"><table class="tbl">
      <thead><tr><th>时间</th><th>用时</th><th class="num">站点</th><th class="num">站点×模型</th><th class="num">请求</th><th>最佳</th><th>状态</th><th></th></tr></thead>
      <tbody>${runs.map((r) => `
        <tr class="clickable" data-open="${esc(r.id)}">
          <td>${esc(fmtTime(r.startedAt))}</td>
          <td>${fmtDuration(r.finishedAt - r.startedAt)}</td>
          <td class="num">${r.siteCount}</td>
          <td class="num">${r.itemCount}</td>
          <td class="num">${r.requestCount}</td>
          <td>${r.best ? `<b style="color:${scoreColor(r.best.final)}">${r.best.final}</b> <span class="mono">${esc(r.best.model)}</span> <span class="muted">@ ${esc(r.best.siteName)}</span>` : '—'}</td>
          <td>${r.aborted ? '<span class="badge warn">中途停止</span>' : '<span class="badge ok">完成</span>'} ${r.judged ? '<span class="badge accent">AI 评审</span>' : ''}</td>
          <td style="text-align:right"><button class="btn sm ghost danger" data-del="${esc(r.id)}">删除</button></td>
        </tr>`).join('')}</tbody>
    </table></div></div>` : '<div class="panel empty"><h3>暂无历史记录</h3><p>每次测试完成后会自动保存在这里。</p></div>'}`;
}

async function onClick(e) {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (confirmBox('删除这条测试记录？')) await deleteRun(del.dataset.del);
    return;
  }
  const row = e.target.closest('[data-open]');
  if (row) {
    const run = await loadRun(row.dataset.open);
    if (run) showRun(run);
    else toast('记录不存在', 'bad');
  }
}
