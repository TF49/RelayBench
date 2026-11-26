// 细线图标（1.5 描边，Phosphor Light 风格），内联 SVG，随 currentColor 着色。
const P = {
  sites: '<rect x="3.5" y="4.5" width="17" height="6" rx="2"/><rect x="3.5" y="13.5" width="17" height="6" rx="2"/><circle cx="7.5" cy="7.5" r=".6" fill="currentColor"/><circle cx="7.5" cy="16.5" r=".6" fill="currentColor"/>',
  run: '<path d="M4 12h3l2.5-6 4 12 2.5-6H20"/>',
  report: '<path d="M4.5 19.5V4.5"/><path d="M4.5 19.5h15"/><path d="M8.5 15.5v-4"/><path d="M12.5 15.5v-8"/><path d="M16.5 15.5v-6"/>',
  history: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  settings: '<path d="M4.5 7h9"/><path d="M17.5 7h2"/><circle cx="15.5" cy="7" r="2"/><path d="M4.5 17h2"/><path d="M10.5 17h9"/><circle cx="8.5" cy="17" r="2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  import: '<path d="M12 4.5v10"/><path d="M8 10.5l4 4 4-4"/><path d="M5 15.5v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/>',
  scan: '<path d="M4.5 8V6.5a2 2 0 0 1 2-2H8"/><path d="M16 4.5h1.5a2 2 0 0 1 2 2V8"/><path d="M19.5 16v1.5a2 2 0 0 1-2 2H16"/><path d="M8 19.5H6.5a2 2 0 0 1-2-2V16"/><path d="M4.5 12h15"/>',
  play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.9-6.2a.8.8 0 0 0 0-1.4L9.2 5.1A.8.8 0 0 0 8 5.8z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  arrow: '<path d="M7 17L17 7"/><path d="M9 7h8v8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
  trash: '<path d="M5 7h14"/><path d="M9.5 7V5.5h5V7"/><path d="M7 7l.8 11.2a1.5 1.5 0 0 0 1.5 1.3h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7"/>',
  spark: '<path d="M12 3.5l1.6 5.2a2 2 0 0 0 1.3 1.3L20.5 12l-5.6 1.6a2 2 0 0 0-1.3 1.3L12 20.5l-1.6-5.6a2 2 0 0 0-1.3-1.3L3.5 12l5.6-1.6a2 2 0 0 0 1.3-1.3z"/>',
  download: '<path d="M12 4.5v11"/><path d="M7.5 11l4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5l8-8"/><path d="M16 7l2.5 2.5"/>',
  list: '<path d="M9 7h10.5"/><path d="M9 12h10.5"/><path d="M9 17h10.5"/><circle cx="5" cy="7" r=".7" fill="currentColor"/><circle cx="5" cy="12" r=".7" fill="currentColor"/><circle cx="5" cy="17" r=".7" fill="currentColor"/>',
  bolt: '<path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z"/>',
  wallet: '<rect x="3.5" y="6.5" width="17" height="12" rx="2.5"/><path d="M3.5 10h17"/><circle cx="16.5" cy="14.5" r=".8" fill="currentColor"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5"/>',
  gauge: '<path d="M4.5 16a7.5 7.5 0 1 1 15 0"/><path d="M12 16l3.5-4.5"/>',
};

export function icon(name, size = 16, cls = '') {
  const body = P[name] || '';
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
