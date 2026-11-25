/**
 * 负责：按确定性时间函数 `render(t)`（0–60 秒）驱动 Mova 宣传片 6 幕分镜的画面、镜头推拉、光标轨迹与播放控制。
 * 不负责：不依赖真实后端/IPC/数据库，也不负责底层音频合成细节（交由 `audio.js` 的 `window.MovaAudio` 处理）。
 * 被谁调用：`docs/prototypes/promo/index.html` 与录制探针脚本 `scripts/probes/record-promo.cjs`。
 */
(function () {
  'use strict';

  const DUR = 60;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const eo = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
  const eio = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const lerp = (a, b, p) => a + (b - a) * p;
  /** 在 [a, b] 区间可见：前 fi 秒淡入，后 fo 秒淡出。 */
  const vis = (t, a, b, fi = 0.35, fo = 0.35) => {
    if (t < a || t > b) return 0;
    const i = fi > 0 ? eo(prog(t, a, a + fi)) : 1;
    const o = b === Infinity || fo <= 0 ? 1 : 1 - eio(prog(t, b - fo, b));
    return Math.min(i, o);
  };
  const css = (el, s) => { for (const k in s) { const v = s[k]; if (el.__s?.[k] !== v) { (el.__s ||= {})[k] = v; if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v; } } };
  const html = (el, s) => { if (el.__h !== s) { el.__h = s; el.innerHTML = s; } };
  const text = (el, s) => { if (el.__t !== s) { el.__t = s; el.textContent = s; } };
  const cls = (el, c, on) => { if (el.classList.contains(c) !== on) el.classList.toggle(c, on); };
  const typed = (str, t, a, b) => Array.from(str).slice(0, Math.floor(Array.from(str).length * prog(t, a, b))).join('');

  /* ---------------- 图标（线性，24 栅格） ---------------- */
  const ICONS = {
    home: 'M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z',
    chat: 'M4 12a8 8 0 1 1 3.5 6.6L4 20l1.3-3.6A7.9 7.9 0 0 1 4 12zM8.5 12h.01M12 12h.01M15.5 12h.01',
    contacts: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6zM12 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 17c.8-2 2.2-3 4-3s3.2 1 4 3',
    cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
    aperture: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
    dots: 'M6 12h.01M12 12h.01M18 12h.01',
    puzzle: 'M9 4h3a2 2 0 1 1 4 0h3v5a2 2 0 1 1 0 4v6h-5a2 2 0 1 0-4 0H5v-6a2 2 0 1 0 0-4V4z',
    plusc: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8v8M8 12h8',
    plus: 'M12 5v14M5 12h14',
    search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-4-4',
    bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
    folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
    arrowL: 'M19 12H5M11 6l-6 6 6 6', arrowR: 'M5 12h14M13 6l6 6-6 6', arrowUp: 'M12 19V5M6 11l6-6 6 6',
    sidebar: 'M4 5h16v14H4zM9 5v14', panel: 'M4 5h16v14H4zM15 5v14',
    caret: 'M7 10l5 5 5-5', check: 'M5 12.5l4.5 4.5L19 7', x: 'M6 6l12 12M18 6L6 18', minus: 'M5 12h14', square: 'M6 6h12v12H6z',
    globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
    cursor: 'M9 9l11 4-5 2-2 5zM4 4l2.5 2.5M9 2.5V5M2.5 9H5',
    file: 'M6 3h8l5 5v13H6zM14 3v5h5',
    lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    shield: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z',
    zap: 'M13 3L5 13h6l-1 8 8-10h-6z',
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
    pen: 'M4 20l4-1 11-11-3-3L5 16z', layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', type: 'M5 6V4h14v2M12 4v16M9 20h6',
    quote: 'M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6',
    db: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    key: 'M14 4a6 6 0 1 1-4.9 9.5L4 18.6V21h3v-2h2v-2h2l1.1-1.1A6 6 0 0 1 14 4zM16 8h.01',
  };
  $$('[data-i]').forEach((el) => {
    const d = ICONS[el.dataset.i];
    if (!d) return;
    const w = el.dataset.i === 'dots' ? 3 : 1.6;
    el.insertAdjacentHTML('afterbegin', `<svg class="i" viewBox="0 0 24 24" style="stroke-width:${w}"><path d="${d}"/></svg>`);
  });

  /* ---------------- 静态内容 ---------------- */
  const CODE = [
    `<span class="tk-k">import</span> { <span class="tk-t">createRoot</span> } <span class="tk-k">from</span> <span class="tk-s">'react-dom/client'</span>;`,
    `<span class="tk-k">import</span> <span class="tk-s">'../../app.js'</span>;`,
    `<span class="tk-k">import</span> { <span class="tk-t">WindowControls</span> } <span class="tk-k">from</span> <span class="tk-s">'./window-controls'</span>;`,
    ``,
    `<span class="tk-k">const</span> controls <span class="tk-p">=</span> document.<span class="tk-f">querySelector</span>(<span class="tk-s">'#window-controls'</span>);`,
    `<span class="tk-k">if</span> (controls) {`,
    `  <span class="tk-k">const</span> desktop <span class="tk-p">=</span> window.movaDesktop;`,
    `  <span class="tk-k">if</span> (desktop) {`,
    `    document.documentElement.classList.<span class="tk-f">add</span>(<span class="tk-s">'desktop-window'</span>);`,
    `    controls.<span class="tk-f">setAttribute</span>(<span class="tk-s">'aria-label'</span>, <span class="tk-s">'窗口控制'</span>);`,
    `  }`,
    `  <span class="tk-f">createRoot</span>(controls).<span class="tk-f">render</span>(<span class="tk-p">&lt;</span><span class="tk-t">WindowControls</span> desktop<span class="tk-p">=</span>{desktop} <span class="tk-p">/&gt;</span>);`,
    `}`,
  ];
  $('#codeView').innerHTML = CODE.map((l, i) => `<div class="cl" id="cl${i + 1}"><span class="ln">${i + 1}</span>${l}</div>`).join('');

  const ANSWER = [
    [{ sel: '在百万级向量规模下，pgvector 的 HNSW 索引已能满足多数应用的毫秒级检索' }, { cite: 1 }, { text: '；纯检索负载更看重尾延迟时，Qdrant 这类专用引擎往往更有优势' }, { cite: 2 }, { text: '。' }],
    [{ text: '如果数据本就在 PostgreSQL，pgvector 省去了同步链路，运维成本最低' }, { cite: 3 }, { text: '。' }],
  ];
  const ANSWER_LEN = ANSWER.flat().reduce((n, s) => n + (s.cite ? 1 : Array.from(s.sel || s.text).length), 0);
  function answerHtml(n) {
    let left = n;
    return ANSWER.map((para) => {
      let out = '';
      for (const seg of para) {
        if (left <= 0) break;
        if (seg.cite) { out += `<span class="cite">${seg.cite}</span>`; left -= 1; continue; }
        const chars = Array.from(seg.sel || seg.text);
        const part = chars.slice(0, left).join('');
        left -= chars.length;
        out += seg.sel ? `<span class="sel" id="selSpan">${part}</span>` : part;
      }
      return out ? `<p>${out}</p>` : '';
    }).join('');
  }

  const BOT_TEXT = ['#b1t', '#b2t', '#b3t'].map((s) => $(s).innerHTML);
  const TYPING = '<span class="typing" style="padding:0;border:0;background:none"><i></i><i></i><i></i></span>';

  /* ---------------- 字幕 ---------------- */
  const CAPS = [
    [7.6, 18.7, 'ChatMova · 句句有据', 'Multi-Source RRF Search · Verified Citations', '02'],
    [19.6, 31.7, 'CodeMova · 自主，但始终受控', 'Autonomous Goal Loop · Line-Level Diff Approval', '03'],
    [32.6, 41.8, 'MovaBot · 你的专属智能体矩阵', 'Custom Personas · Reasoning Tier Control', '04'],
    [42.6, 52.8, '不止于对话 · 代码、网页与画布合一', 'Unified Viewer · DOM Inspector · OpenPencil Canvas', '05'],
    [53.2, 56.6, 'Local-First. Private by Design.', 'PostgreSQL · pgvector · AES-256-GCM — 全部留在本机', '06'],
  ];

  /* ---------------- 镜头（frameInner 内的推拉） ---------------- */
  const FW = 1614, FH = 774;
  const CAM = [
    [0, 807, 387, 1], [7.2, 807, 387, 1], [8.4, 957, 700, 1.75], [10.45, 957, 700, 1.75], [11.6, 957, 330, 1.12], [19.0, 957, 330, 1.12],
    [19.8, 807, 387, 1], [23.0, 807, 387, 1], [23.7, 1150, 230, 1.28], [25.95, 1150, 230, 1.28], [26.7, 957, 520, 1.12], [30.7, 957, 520, 1.12], [31.6, 807, 387, 1],
    [35.6, 807, 387, 1], [36.4, 957, 330, 1.1], [39.5, 957, 330, 1.1], [39.8, 807, 387, 1],
    [45.9, 807, 387, 1], [46.6, 1310, 330, 1.32], [48.4, 1310, 330, 1.32], [49.1, 807, 387, 1],
    [50.0, 807, 387, 1], [51.3, 960, 420, 1.2], [52.9, 960, 420, 1.2], [53.4, 807, 387, 1],
  ];
  function camera(t) {
    let i = 0;
    while (i < CAM.length - 1 && CAM[i + 1][0] <= t) i++;
    const a = CAM[i], b = CAM[Math.min(i + 1, CAM.length - 1)];
    const p = a === b ? 0 : eio(prog(t, a[0], b[0]));
    const s = lerp(a[3], b[3], p);
    let cx = lerp(a[1], b[1], p), cy = lerp(a[2], b[2], p);
    cx = clamp(cx, FW / 2 / s, FW - FW / 2 / s);
    cy = clamp(cy, FH / 2 / s, FH - FH / 2 / s);
    return { s, tx: FW / 2 - cx * s, ty: FH / 2 - cy * s };
  }

  /* ---------------- 光标 ---------------- */
  const CUR = [
    { t: 7.3, at: '#composer', ax: 0.3, dy: 10 }, { t: 9.05, at: '#modelChip', click: 1 }, { t: 9.5, at: '#sThumb' }, { t: 9.9, at: '#sThumb' },
    { t: 10.3, at: '#modelChip', click: 1 }, { t: 10.7, at: '#sendBtn', click: 1 },
    { t: 15.8, at: '#cAnswer', ax: 0, ay: 0, dx: 4, dy: 16 }, { t: 16.45, at: '#cAnswer', ax: 0, ay: 0, dx: 560, dy: 46 }, { t: 16.95, at: '#quotePill', click: 1 },
    { t: 19.15, at: '#modeToggle', dx: 40, dy: 30 }, { t: 19.4, at: '#modeToggle', click: 1 }, { t: 19.75, at: '#miCode' }, { t: 19.95, at: '#miCode', click: 1 },
    { t: 20.55, at: '#grip' }, { t: 20.6, at: '#grip' }, { t: 21.2, at: '#grip' }, { t: 21.95, at: '#chatTitle', dx: 160, dy: 240 },
    { t: 22.8, at: '#aimPill', dx: -60, dy: 60 }, { t: 23.0, at: '#aimPill', click: 1 }, { t: 24.8, at: '#moreBtn', click: 1 }, { t: 25.25, at: '#moreBtn', dx: -60, dy: 70 },
    { t: 26.1, at: '#approvalChip', dx: 50, dy: -60 }, { t: 26.4, at: '#approvalChip', click: 1 }, { t: 26.85, at: '#lv1' }, { t: 27.1, at: '#lv2' }, { t: 27.35, at: '#lv0', click: 1 },
    { t: 29.6, at: '#apAllow', dx: -40, dy: -40 }, { t: 30.0, at: '#apAllow', click: 1 }, { t: 30.3, at: '#apAllow', dx: -30, dy: 50 },
    { t: 32.0, at: '#rMsg', dx: 70, dy: 30 }, { t: 32.35, at: '#rMsg', click: 1 }, { t: 33.15, at: '#botAdd', click: 1 }, { t: 34.15, at: '#mc0', click: 1 },
    { t: 34.65, at: '#seg2', click: 1 }, { t: 35.15, at: '#botCreate', click: 1 }, { t: 35.55, at: '#botCreate', dx: -70, dy: 50 },
    { t: 39.4, at: '#rContacts', dx: 90, dy: 20 }, { t: 39.7, at: '#rContacts', click: 1 }, { t: 40.8, at: '#rForum', click: 1 }, { t: 41.15, at: '#rForum', dx: 70, dy: 30 },
    { t: 41.8, at: '#rHome', dx: 70, dy: 40 }, { t: 42.1, at: '#rHome', click: 1 }, { t: 42.95, at: '#fileRef', click: 1 }, { t: 43.35, at: '#fileRef', dx: 50, dy: 60 },
    { t: 46.2, at: '#inspectBtn', dx: -50, dy: 50 }, { t: 46.65, at: '#inspectBtn', click: 1 }, { t: 46.95, at: '#heroTitle', dx: 30 }, { t: 47.5, at: '#cta' },
    { t: 47.95, at: '#cta', click: 1 }, { t: 48.35, at: '#cta', dx: 40, dy: 50 },
  ];
  const CURVIS = [[7.3, 10.95], [15.6, 17.4], [19.1, 22.1], [22.75, 25.35], [26.0, 30.35], [31.9, 35.65], [39.3, 41.2], [41.75, 43.45], [46.1, 48.45]];

  let SR = null, S = 1;
  function center(k) {
    const el = $(k.at);
    const r = el.getBoundingClientRect();
    const x = (r.left + r.width * (k.ax ?? 0.5) - SR.left) / S + (k.dx || 0);
    const y = (r.top + r.height * (k.ay ?? 0.5) - SR.top) / S + (k.dy || 0);
    return [x, y];
  }
  function cursorAt(t) {
    let i = 0;
    while (i < CUR.length - 1 && CUR[i + 1].t <= t) i++;
    const a = CUR[i], b = CUR[i + 1];
    if (t <= CUR[0].t || !b) return center(t <= CUR[0].t ? CUR[0] : a);
    const pa = center(a), pb = center(b);
    const p = eio(prog(t, Math.max(a.t, b.t - 0.5), b.t));
    return [lerp(pa[0], pb[0], p), lerp(pa[1], pb[1], p)];
  }
  const CLICKS = CUR.filter((k) => k.click).map((k) => k.t);

  /* ---------------- 声音排程 ---------------- */
  const CUES = [];
  const cue = (t, s, v, d) => CUES.push({ t, s, v, d });
  const series = (a, b, step, s, v) => { for (let x = a; x < b; x += step) cue(+x.toFixed(3), s, v); };
  cue(0.3, 'crystal'); cue(1.3, 'shimmer', 0.6); cue(2.5, 'blink'); cue(3.0, 'whoosh', 0.9, 1.0); cue(4.2, 'boom'); cue(4.9, 'blink', 0.6);
  cue(5.7, 'whoosh', 0.8, 1.2);
  for (let x = 7; x <= 52; x += 1) cue(x, 'pulse', 0.8);
  series(7.6, 9.0, 0.07, 'type', 1);
  cue(9.15, 'pop'); series(9.5, 9.95, 0.11, 'tick', 2); cue(10.7, 'whoosh', 0.45, 0.5);
  [11.1, 11.3, 11.7, 12.0, 12.3, 12.9, 13.2].forEach((x) => cue(x, 'pop', 0.45));
  series(13.6, 15.6, 0.06, 'tick', 0.8);
  series(15.8, 16.45, 0.05, 'tick', 0.6); cue(16.5, 'pop', 0.7); cue(17.15, 'whoosh', 0.5, 0.45); cue(17.6, 'pop', 0.9);
  cue(19.45, 'pop', 0.7); cue(20.05, 'whooshDown', 0.5, 0.6); cue(20.6, 'spring', 1, 1.5);
  cue(22.0, 'pop', 0.6); cue(22.3, 'shimmer', 0.45); cue(23.05, 'whoosh', 0.4, 0.4);
  [23.7, 24.4, 25.0].forEach((x) => { cue(x, 'pop', 0.7); cue(x + 0.03, 'tick', 1.5); });
  cue(24.0, 'tick', 1.2); cue(24.85, 'whoosh', 0.4, 0.4); series(25.0, 25.9, 0.05, 'tick', 0.5); cue(25.9, 'whooshDown', 0.4, 0.4);
  cue(26.45, 'pop', 0.7); cue(27.6, 'whoosh', 0.6, 0.5); series(28.1, 28.85, 0.09, 'tick', 0.9); cue(30.0, 'chime'); cue(30.0, 'boom', 0.45); cue(30.5, 'pop', 0.6);
  cue(32.4, 'whooshDown', 0.5, 0.6); cue(33.25, 'whoosh', 0.5, 0.5); series(33.6, 34.1, 0.06, 'type', 1); cue(35.5, 'pop', 0.7);
  [35.7, 36.5, 37.3, 38.1].forEach((x) => cue(x, 'pop', 0.85)); cue(39.75, 'whoosh', 0.4, 0.4); cue(40.85, 'whoosh', 0.4, 0.4);
  cue(42.1, 'whooshDown', 0.4, 0.5); cue(43.0, 'whoosh', 0.6, 0.6); cue(44.6, 'whoosh', 0.3, 0.3); cue(45.6, 'whoosh', 0.3, 0.3);
  cue(46.95, 'tick', 2); cue(47.5, 'tick', 2); cue(47.95, 'shutter'); cue(48.15, 'pop', 0.8);
  cue(49.0, 'whoosh', 0.7, 1.0); series(50.3, 51.7, 0.12, 'tick', 0.6); cue(51.75, 'pop', 0.7);
  cue(53.0, 'boom', 0.7); cue(53.0, 'whooshDown', 0.6, 0.8); [53.4, 53.7, 54.0].forEach((x) => cue(x, 'pop', 0.6));
  series(54.1, 54.9, 0.05, 'type', 0.7); series(54.2, 55.0, 0.08, 'tick', 0.6); cue(55.45, 'lock');
  cue(56.2, 'whoosh', 0.8, 1.2); cue(57.45, 'boom'); cue(57.6, 'shimmer', 0.5); cue(58.7, 'blink', 0.8);
  CLICKS.forEach((x) => cue(x, 'click'));
  CUES.sort((a, b) => a.t - b.t);

  /* ---------------- 元素 ---------------- */
  const E = {};
  ['win', 'frameInner', 'wordmark', 'tagline', 'endline', 'fade', 'ball', 'ballRing', 'ballBody', 'eyes', 'eyeL', 'eyeR', 'cursor', 'clickRing', 'cap', 'capTitle', 'capSub', 'actNo', 'actCur',
    'sbChat', 'sbCode', 'sbBot', 'modeMenu', 'miCode', 'ckChat', 'ckCode', 'sidebar', 'grip', 'gripPath', 'main', 'mainCol', 'welcome', 'chatTitle', 'members', 'aimPill',
    'vChat', 'vCode', 'vRef', 'vBot', 'cUser', 'cTrace', 'cTraceHead', 'cAnswer', 'quotePill', 'chips', 'chipQuote', 'chipEl', 'composerText', 'approvalChip', 'effortLabel',
    'modelPop', 'sFill', 'sThumb', 'levelPop', 'lv0', 'lv1', 'lv2', 'approval', 'apAllow', 'aimCard', 'usageCard', 'aimBar', 'aimMeta', 'usTotal', 'usSub', 'usCache', 'usIn', 'usOut', 'usC',
    'usLast', 'usTime', 'usCalls', 'kUser', 'kT1', 'kT2', 'kT3', 'kNote', 'kT4', 'kToast', 'rHome', 'rMsg', 'rContacts', 'rForum', 'dim', 'botDialog', 'botName', 'mc0', 'segKnob',
    'newBotRow', 'b0', 'b1', 'b2', 'b3', 'b1t', 'b2t', 'b3t', 'vContacts', 'vForum', 'panel', 'addr', 'pvCode', 'pvPdf', 'pvWeb', 'cl12', 'inspectBtn', 'insBox', 'insTag', 'heroTitle', 'cta',
    'design', 'artboard', 'abTitle', 'abSub', 'abBtn', 'vecCurve', 'vecPts', 'selbox', 'pX', 'pY', 'pW', 'pH', 'memCards', 'mem0', 'mem1', 'mem2', 'keyText', 'bearerText',
    'h0', 'h1', 'h2', 'h0v', 'h1v', 'h2v', 'shackle', 'companion', 'stage'].forEach((id) => { E[id] = document.getElementById(id); });
  const diffLines = $$('#diff .dl');
  const traceRows = [0, 1, 2, 3, 4, 5].map((i) => $('#tr' + i));
  const favs = [0, 1, 2, 3].map((i) => $('#fv' + i));
  const steps = [0, 1, 2, 3].map((i) => $('#st' + i));
  const ccards = $$('#vContacts .ccard');
  const posts = $$('#vForum .post');

  const BLINKS = [2.5, 4.9, 9.5, 14.2, 21.0, 27.5, 33.8, 38.6, 44.5, 55.0, 58.7];
  const LOOK = [[0, 0, 0], [2.75, 0, 0], [2.95, -14, 0], [3.3, -14, 0], [3.5, 14, 0], [3.85, 14, 0], [4.05, 0, 0], [49.2, 0, 0], [49.6, 6, -12], [52.8, 6, -12], [53.2, 0, 0], [58.0, 0, 0], [58.3, 6, 3]];
  function look(t) {
    let i = 0;
    while (i < LOOK.length - 1 && LOOK[i + 1][0] <= t) i++;
    const a = LOOK[i], b = LOOK[Math.min(i + 1, LOOK.length - 1)];
    const p = a === b ? 0 : eio(prog(t, a[0], b[0]));
    return [lerp(a[1], b[1], p), lerp(a[2], b[2], p)];
  }
  const WM = { x: 504 + 334 * 1.2, y: 384 + 146.5 * 1.2, r: 51 * 1.2 };

  function mask(str, from, n, cls2 = 'mask') {
    const c = Array.from(str);
    const m = Math.min(n, c.length - from);
    return c.slice(0, from).join('') + `<span class="${cls2}">${'•'.repeat(m)}</span>` + c.slice(from + m).join('');
  }

  /* ================= render ================= */
  function render(t) {
    SR = E.stage.getBoundingClientRect();
    S = SR.width / 1920;

    /* --- 窗口出现 / 收合 --- */
    const wIn = eo(prog(t, 5.6, 7.0));
    const wOut = eio(prog(t, 56.2, 57.4));
    const dim6 = vis(t, 53.0, 56.6, 0.5, 0.6);
    css(E.win, {
      opacity: String(wIn * (1 - wOut)),
      transform: `perspective(2400px) translateY(${lerp(70, 0, wIn) + wOut * 20}px) rotateX(${lerp(18, 0, wIn)}deg) scale(${lerp(0.9, 1, wIn) * lerp(1, 0.9, wOut)})`,
      filter: dim6 > 0.001 ? `brightness(${1 - 0.62 * dim6}) blur(${(6 * dim6).toFixed(2)}px)` : 'none',
      '--sweep': `${lerp(130, -30, eio(prog(t, 6.4, 7.8)))}%`,
      visibility: wIn * (1 - wOut) > 0.001 ? 'visible' : 'hidden',
    });

    /* --- 字标 --- */
    const wmOp = t < 30 ? 1 - eio(prog(t, 5.6, 6.4)) : eo(prog(t, 56.8, 57.9));
    const wmScale = t < 30 ? lerp(1, 1.08, eio(prog(t, 5.6, 6.4))) : lerp(0.96, 1, eo(prog(t, 56.8, 58.2)));
    css(E.wordmark, { opacity: String(wmOp), transform: `scale(${wmScale})`, visibility: wmOp > 0.001 ? 'visible' : 'hidden' });
    [['sM', 'fM', 0], ['sV', 'fV', 0.1], ['sA', 'fA', 0.2]].forEach(([s, f, d]) => {
      const el = document.getElementById(s);
      css(el, { strokeDashoffset: String(1 - eio(prog(t, 3.0 + d, 4.2 + d))), opacity: String(t < 30 ? vis(t, 3.0 + d, 5.0 + d, 0.15, 0.8) : 0) });
      const fp = t < 30 ? eo(prog(t, 3.65 + d * 0.8, 4.6 + d * 0.8)) : 1;
      css(document.getElementById(f), { opacity: String(fp), transform: `translateY(${(1 - fp) * 4}px)` });
    });
    const tg = Math.max(vis(t, 4.4, 6.0, 0.7, 0.4), t > 30 ? eo(prog(t, 57.7, 58.6)) : 0);
    css(E.tagline, { opacity: String(tg), letterSpacing: `${lerp(0.5, 0.32, t < 30 ? eo(prog(t, 4.4, 5.6)) : eo(prog(t, 57.7, 59)))}em` });
    css(E.endline, { opacity: String(eo(prog(t, 58.3, 59.2)) * 0.9) });
    css(E.fade, { opacity: String(eio(prog(t, 59.45, 60))) });

    /* --- 字幕 --- */
    const cap = CAPS.find((c) => t >= c[0] && t <= c[1]);
    if (cap) {
      text(E.capTitle, cap[2]); text(E.capSub, cap[3]); text(E.actCur, cap[4]);
      const o = vis(t, cap[0], cap[1], 0.7, 0.5);
      css(E.cap, { opacity: String(o), transform: `translateY(${(1 - o) * 14}px)`, filter: `blur(${((1 - o) * 6).toFixed(2)}px)` });
      css(E.actNo, { opacity: String(o * 0.9) });
    } else {
      css(E.cap, { opacity: '0' }); css(E.actNo, { opacity: '0' });
    }

    /* --- 镜头 --- */
    const cam = camera(t);
    css(E.frameInner, { transform: `translate(${cam.tx.toFixed(2)}px, ${cam.ty.toFixed(2)}px) scale(${cam.s.toFixed(4)})` });

    /* --- 侧栏宽度（第三幕拖动分隔线，弹簧回弹） --- */
    const dragDx = (x) => {
      if (x < 20.6) return 0;
      if (x < 21.2) return 80 * eio(prog(x, 20.6, 21.2));
      const u = x - 21.2;
      return 80 * Math.exp(-5.5 * u) * Math.cos(9 * u);
    };
    const dx = dragDx(t);
    const vel = (dragDx(t + 0.008) - dragDx(t - 0.008)) / 0.016;
    const sbW = 300 + dx;
    const panelOpen = eo(prog(t, 43.0, 43.6)) * (1 - eio(prog(t, 49.0, 49.5)));
    const panelW = 620 * panelOpen;
    const mainW = FW - sbW - panelW;
    const colW = Math.min(720, mainW - 74);
    css(E.sidebar, { width: `${sbW}px` });
    css(E.main, { left: `${sbW}px`, width: `${mainW}px` });
    css(E.mainCol, { left: `${(mainW - colW) / 2}px`, width: `${colW}px` });
    css(E.panel, { left: `${FW - panelW}px`, visibility: panelOpen > 0.001 ? 'visible' : 'hidden' });
    const gripVis = vis(t, 20.4, 22.6, 0.2, 0.4);
    const bulge = clamp(vel / 500, -1, 1) * 16;
    css(E.grip, { left: `${sbW}px`, opacity: String(gripVis) });
    E.gripPath.setAttribute('d', `M 20 340 Q ${(20 + bulge).toFixed(2)} 387 20 434`);

    /* --- 侧栏视图 --- */
    const sbChat = vis(t, -1, 20.3, 0, 0.3);
    const sbCode = Math.max(vis(t, 20.05, 32.6, 0.3, 0.25), vis(t, 42.1, Infinity, 0.3, 0));
    const sbBot = vis(t, 32.4, 42.3, 0.3, 0.25);
    css(E.sbChat, { opacity: String(sbChat) }); css(E.sbCode, { opacity: String(sbCode) }); css(E.sbBot, { opacity: String(sbBot) });
    cls($('#chatItem1'), 'sel', t >= 10.7);
    cls($('#codeItem1'), 'sel', t >= 20.05 && t < 42.1);
    cls($('#codeItem2'), 'sel', t >= 42.1);
    const mm = vis(t, 19.45, 20.05, 0.18, 0.15);
    css(E.modeMenu, { opacity: String(mm), transform: `scale(${lerp(0.96, 1, mm)})`, visibility: mm > 0.001 ? 'visible' : 'hidden' });
    cls(E.miCode, 'hov', t >= 19.75);
    css($('#ckChat'), { opacity: t < 19.95 ? '1' : '0' }); css($('#ckCode'), { opacity: t >= 19.95 ? '1' : '0' });
    const nb = eo(prog(t, 35.45, 35.85));
    css(E.newBotRow, { height: `${52 * nb}px`, opacity: String(nb), marginBottom: `${2 * nb}px` });

    /* --- 导航轨 --- */
    const railSel = t >= 32.4 && t < 39.7 ? 'rMsg' : t >= 39.7 && t < 40.8 ? 'rContacts' : t >= 40.8 && t < 42.1 ? 'rForum' : 'rHome';
    ['rHome', 'rMsg', 'rContacts', 'rForum'].forEach((id) => cls(E[id], 'sel', id === railSel));

    /* --- 标题栏 --- */
    text(E.chatTitle, t < 10.8 ? '新聊天' : t < 20.05 ? '本地向量库检索延迟对比' : t < 32.4 ? '记忆检索改为 RRF 混合排序' : t < 42.1 ? '设计评审群' : '定位渲染入口');
    css(E.members, { display: t >= 32.4 && t < 42.1 ? 'flex' : 'none' });
    const aimOpen = eo(prog(t, 23.05, 23.55)) * (1 - eio(prog(t, 25.9, 26.3)));
    const usOpen = eo(prog(t, 24.85, 25.3)) * (1 - eio(prog(t, 25.9, 26.3)));
    css(E.aimPill, { opacity: String(vis(t, 22.3, 32.4, 0.4, 0.3) * (1 - aimOpen)), '--shine': `${lerp(110, -10, (t * 0.55) % 1)}%`, visibility: t >= 22.3 && t < 32.4 ? 'visible' : 'hidden' });
    css(E.welcome, { opacity: String(vis(t, -1, 10.8, 0, 0.3)) });

    /* --- 主区域视图 --- */
    css(E.vChat, { opacity: String(vis(t, 10.6, 20.3, 0.2, 0.3)) });
    css(E.vCode, { opacity: String(vis(t, 20.05, 32.5, 0.3, 0.3)) });
    css(E.vBot, { opacity: String(vis(t, 32.4, 42.1, 0.3, 0.3)) });
    css(E.vRef, { opacity: String(vis(t, 42.1, Infinity, 0.35, 0)) });

    /* ===== 第二幕 · ChatMova ===== */
    const appear = (el, at, dist = 10) => { const p = eo(prog(t, at, at + 0.45)); css(el, { opacity: String(p), transform: `translateY(${(1 - p) * dist}px)` }); };
    appear(E.cUser, 10.85);
    css(E.cTrace, { opacity: String(eo(prog(t, 11.05, 11.4))) });
    [11.3, 11.7, 12.0, 12.3, 12.9, 13.2].forEach((at, i) => { const p = eo(prog(t, at, at + 0.4)); css(traceRows[i], { opacity: String(p), transform: `translateX(${(1 - p) * -8}px)` }); });
    favs.forEach((f, i) => { const p = eo(prog(t, 13.25 + i * 0.1, 13.6 + i * 0.1)); css(f, { opacity: String(p), transform: `scale(${lerp(0.8, 1, p)})` }); });
    text(E.cTraceHead, t < 13.6 ? '思考与操作 · 正在检索…' : '思考与操作 · 已搜索 3 次 · 读取 4 页');
    html(E.cAnswer, answerHtml(Math.floor(ANSWER_LEN * prog(t, 13.6, 15.6))));
    const selSpan = document.getElementById('selSpan');
    if (selSpan) {
      const sp = t < 17.15 ? eio(prog(t, 15.8, 16.45)) * 100 : 0;
      css(selSpan, { backgroundSize: `${sp}% 100%` });
    }
    const qp = vis(t, 16.5, 17.15, 0.2, 0.12);
    css(E.quotePill, { left: '6px', top: '258px', opacity: String(qp), transform: `translateY(${(1 - qp) * 5}px)` });
    const cq = t < 20.05 ? eo(prog(t, 17.15, 17.65)) : 1 - eio(prog(t, 20.05, 20.3));
    css(E.chipQuote, { opacity: String(cq), transform: t < 20.05 ? `translateY(${lerp(-290, 0, eo(prog(t, 17.15, 17.65)))}px) scale(${lerp(0.92, 1, cq)})` : 'none', display: t >= 17.15 && t < 20.3 ? 'inline-flex' : 'none' });
    const ce = eo(prog(t, 48.1, 48.65));
    css(E.chipEl, { opacity: String(ce * (1 - eio(prog(t, 49.0, 49.4)))), transform: `translateX(${(1 - ce) * 360}px)`, display: t >= 48.1 && t < 49.4 ? 'inline-flex' : 'none' });

    /* 输入框 */
    const mode = t < 20.05 ? 'chat' : t < 32.4 ? 'code' : t < 42.1 ? 'bot' : 'code';
    const PROMPT = '对比主流本地向量数据库的检索延迟，给出处';
    let ctext;
    if (t >= 7.5 && t < 10.7) {
      const caretOn = (t > 7.6 && t < 9.05) || Math.floor(t * 2.2) % 2 === 0;
      ctext = `${typed(PROMPT, t, 7.6, 9.0)}${caretOn ? '<span class="caret"></span>' : ''}`;
    } else {
      ctext = `<span class="ph">${mode === 'chat' ? '有问题，尽管问' : mode === 'bot' ? '发消息给 设计评审群' : '要求后续变更'}</span>`;
    }
    html(E.composerText, ctext);
    css(E.approvalChip, { display: mode === 'code' ? 'inline-flex' : 'none' });
    text(E.effortLabel, t < 9.75 ? '中' : '高');
    const mp = vis(t, 9.15, 10.4, 0.2, 0.2);
    css(E.modelPop, { opacity: String(mp), transform: `translateY(${(1 - mp) * 8}px) scale(${lerp(0.97, 1, mp)})`, transformOrigin: '100% 100%', visibility: mp > 0.001 ? 'visible' : 'hidden' });
    const th = lerp(33.3, 66.6, eio(prog(t, 9.5, 9.9)));
    css(E.sThumb, { left: `${th}%` }); css(E.sFill, { width: `${th}%` });

    /* ===== 第三幕 · CodeMova ===== */
    appear(E.kUser, 22.0); appear(E.kT1, 22.3, 6); appear(E.kT2, 22.7, 6); appear(E.kT3, 23.0, 6); appear(E.kNote, 24.0, 4); appear(E.kT4, 26.9, 6); appear(E.kToast, 30.5, 8);
    // 卡片从入口位置形变展开（clip-path 由触发按钮的位置收放）
    const morph = (card, trigger, open, w, h) => {
      css(card, { visibility: open > 0.001 ? 'visible' : 'hidden', width: `${w}px`, height: `${h}px` });
      if (open <= 0.001) return;
      const cr = card.getBoundingClientRect(), tr = trigger.getBoundingClientRect();
      const k = cr.width / w || 1;
      const ins = [(tr.top - cr.top) / k, (cr.right - tr.right) / k, (cr.bottom - tr.bottom) / k, (tr.left - cr.left) / k].map((v) => clamp(v, 0, 2000) * (1 - open));
      css(card, { clipPath: `inset(${ins.map((v) => v.toFixed(1) + 'px').join(' ')} round ${lerp(14, 16, open)}px)`, opacity: String(Math.min(1, open * 1.6)) });
      css(card.firstElementChild, { opacity: String(prog(open, 0.45, 1)) });
    };
    css(E.aimCard, { right: '16px', top: '8px' });
    css(E.usageCard, { right: '408px', top: '8px' });
    morph(E.aimCard, E.aimPill, aimOpen, 380, 404);
    morph(E.usageCard, $('#moreBtn'), usOpen, 330, 318);
    const doneAt = [23.7, 24.4, 25.0, Infinity];
    let done = 0;
    steps.forEach((li, i) => {
      const isDone = t >= doneAt[i];
      const isActive = !isDone && (i === 0 || t >= doneAt[i - 1]);
      if (isDone) done++;
      cls(li, 'done', isDone); cls(li, 'active', isActive);
    });
    css(E.aimBar, { width: `${(done / 4) * 100}%` });
    text(E.aimMeta, `${done}/4`);
    const up = eio(prog(t, 25.0, 25.9));
    text(E.usTotal, `${(48.2 * up).toFixed(1)}k`);
    text(E.usSub, `输入 ${(39.6 * up).toFixed(1)}k · 输出 ${(8.6 * up).toFixed(1)}k`);
    text(E.usCache, `${Math.round(63 * up)}%`);
    css(E.usIn, { width: `${58 * up}%` }); css(E.usOut, { width: `${14 * up}%` }); css(E.usC, { width: `${28 * up}%` });
    text(E.usLast, t >= 25.6 ? '6.1k' : '—'); text(E.usTime, t >= 25.65 ? '18.4 s' : '—'); text(E.usCalls, String(Math.round(7 * up)));

    const lp = vis(t, 26.45, 27.5, 0.2, 0.15);
    css(E.levelPop, { opacity: String(lp), transform: `translateY(${(1 - lp) * 8}px)`, visibility: lp > 0.001 ? 'visible' : 'hidden' });
    cls(E.lv1, 'hov', t >= 26.75 && t < 27.0); cls(E.lv2, 'hov', t >= 27.0 && t < 27.22); cls(E.lv0, 'hov', t >= 27.22);
    const ap = eo(prog(t, 27.6, 28.1)) * (1 - eio(prog(t, 30.05, 30.45)));
    css(E.approval, { opacity: String(ap), transform: `translateY(${(1 - ap) * 36}px) scale(${lerp(0.98, 1, ap)})`, visibility: ap > 0.001 ? 'visible' : 'hidden' });
    diffLines.forEach((l, i) => { const p = eo(prog(t, 28.1 + i * 0.09, 28.45 + i * 0.09)); css(l, { opacity: String(p), transform: `translateX(${(1 - p) * -10}px)` }); });
    css(E.apAllow, { transform: `scale(${Math.abs(t - 30.0) < 0.07 ? 0.95 : 1})` });

    /* ===== 第四幕 · MovaBot ===== */
    const dlg = vis(t, 33.25, 35.55, 0.3, 0.3);
    css(E.dim, { opacity: String(dlg * 0.55) });
    css(E.botDialog, { opacity: String(dlg), transform: `translateY(${(1 - dlg) * 10}px) scale(${lerp(0.97, 1, dlg)})`, visibility: dlg > 0.001 ? 'visible' : 'hidden' });
    html(E.botName, typed('Muse · 审美评审', t, 33.6, 34.1) + (t < 34.15 ? '<span class="caret" style="display:inline-block;width:1.5px;height:16px;background:#eee;margin-left:1px"></span>' : ''));
    cls(E.mc0, 'sel', t >= 34.2);
    const segW = (520 - 48 - 2 - 6) / 3;
    css(E.segKnob, { left: `${3 + lerp(1, 2, eio(prog(t, 34.68, 34.95))) * segW}px`, width: `${segW}px` });
    const bubble = (el, txtEl, at, idx) => {
      const p = eo(prog(t, at - 0.45, at - 0.1));
      css(el, { opacity: String(p), transform: `translateY(${(1 - p) * 10}px)` });
      if (txtEl) html(txtEl, t < at ? TYPING : BOT_TEXT[idx]);
    };
    bubble(E.b0, null, 35.7); bubble(E.b1, E.b1t, 36.5, 0); bubble(E.b2, E.b2t, 37.3, 1); bubble(E.b3, E.b3t, 38.1, 2);
    $$('.typing i').forEach((d, i) => css(d, { transform: `translateY(${Math.sin(t * 12 - i * 0.9) * 2.5}px)` }));
    const vc = vis(t, 39.75, 40.95, 0.25, 0.2);
    css(E.vContacts, { opacity: String(vc), visibility: vc > 0.001 ? 'visible' : 'hidden' });
    ccards.forEach((c, i) => { const p = eo(prog(t, 39.8 + i * 0.06, 40.2 + i * 0.06)); css(c, { opacity: String(p), transform: `translateY(${(1 - p) * 16}px)` }); });
    const vf = vis(t, 40.85, 42.2, 0.25, 0.3);
    css(E.vForum, { opacity: String(vf), visibility: vf > 0.001 ? 'visible' : 'hidden' });
    posts.forEach((c, i) => { const p = eo(prog(t, 40.9 + i * 0.1, 41.35 + i * 0.1)); css(c, { opacity: String(p), transform: `translateY(${(1 - p) * 18}px)` }); });

    /* ===== 第五幕 · 统一视图 / 元素拾取 / 设计画布 ===== */
    const pvC = vis(t, 43.2, 44.75, 0.3, 0.2), pvP = vis(t, 44.6, 45.75, 0.2, 0.2), pvW = vis(t, 45.6, Infinity, 0.25, 0);
    css(E.pvCode, { opacity: String(pvC) }); css(E.pvPdf, { opacity: String(pvP), transform: `translateY(${(1 - eo(prog(t, 44.6, 45.0))) * 20}px)` }); css(E.pvWeb, { opacity: String(pvW) });
    const crumbs = (parts) => parts.map((p, i) => (i ? '<span class="crumb-sep">›</span>' : '') + `<span>${p}</span>`).join('');
    html(E.addr, t < 44.6 ? crumbs(['Mova', 'src', 'app', 'main.tsx']) : t < 45.6 ? crumbs(['Mova', 'docs', 'plans', 'Mova权限设计.pdf']) : '<span style="color:#7d7d7d">https://</span>example.com');
    cls(E.cl12, 'hl', t >= 43.7);
    cls(E.inspectBtn, 'on', t >= 46.65 && t < 48.4);
    // 元素拾取描边
    const box = (el) => { const h = el.offsetParent; return [h.offsetLeft + el.offsetLeft, h.offsetTop + el.offsetTop, el.offsetWidth, el.offsetHeight]; };
    const bA = box(E.heroTitle), bB = box(E.cta);
    const bp = eio(prog(t, 47.35, 47.55));
    const bx = bA.map((v, i) => lerp(v, bB[i], bp));
    const insV = vis(t, 46.85, 48.4, 0.15, 0.25);
    const flash = Math.abs(t - 47.98) < 0.1 ? 1 : 0;
    css(E.insBox, { left: `${bx[0] - 4}px`, top: `${bx[1] - 4}px`, width: `${bx[2] + 8}px`, height: `${bx[3] + 8}px`, opacity: String(insV), background: flash ? '#5b9bf040' : '#5b9bf014' });
    css(E.insTag, { left: `${bx[0] - 4}px`, top: `${bx[1] - 30}px`, opacity: String(insV) });
    text(E.insTag, bp < 0.5 ? `h1.hero-title  ${bA[2]}×${bA[3]}` : `button.cta  ${bB[2]}×${bB[3]}`);
    // 设计画布
    const dz = vis(t, 49.0, Infinity, 0.55, 0);
    css(E.design, { opacity: String(dz), visibility: dz > 0.001 ? 'visible' : 'hidden' });
    const ab = eo(prog(t, 49.3, 49.95));
    css(E.artboard, { opacity: String(ab), transform: `scale(${lerp(0.95, 1, ab)})` });
    appear(E.abTitle, 49.7, 12); appear(E.abSub, 49.9, 8); appear(E.abBtn, 50.1, 8);
    css(E.vecCurve, { strokeDashoffset: String(1 - eio(prog(t, 50.3, 51.7))) });
    css(E.vecPts, { opacity: String(vis(t, 50.3, 52.2, 0.25, 0.5)) });
    const sb = eo(prog(t, 51.7, 52.0));
    css(E.selbox, { opacity: String(sb), transform: `scale(${lerp(1.04, 1, sb)})` });
    const pp = eio(prog(t, 50.3, 51.7));
    text(E.pX, String(Math.round(460 * pp))); text(E.pY, String(Math.round(210 * pp))); text(E.pW, String(Math.round(350 * pp))); text(E.pH, String(Math.round(180 * pp)));

    /* ===== 第六幕 · 本机记忆与隐私 ===== */
    [[E.mem0, 53.4], [E.mem1, 53.7], [E.mem2, 54.0]].forEach(([el, at]) => {
      const p = vis(t, at, 56.6, 0.5, 0.5);
      css(el, { opacity: String(p), transform: `translateY(${(1 - p) * 26}px) scale(${lerp(0.97, 1, p)})`, visibility: p > 0.001 ? 'visible' : 'hidden' });
    });
    css(E.memCards, { visibility: t > 53.3 && t < 56.7 ? 'visible' : 'hidden' });
    const KEY = 'sk-proj-7Hc2Lq9VwX4mTz8R', BEARER = 'eyJhbGciOiJIUzI1NiJ9.x7Qe';
    html(E.keyText, mask(KEY, 8, Math.floor(16 * eio(prog(t, 54.1, 54.7)))));
    html(E.bearerText, mask(BEARER, 4, Math.floor(21 * eio(prog(t, 54.3, 54.9)))));
    [[E.h0, E.h0v, 0.92], [E.h1, E.h1v, 0.81], [E.h2, E.h2v, 0.64]].forEach(([bar, v, s], i) => {
      const p = eio(prog(t, 54.2 + i * 0.12, 55.0 + i * 0.12));
      css(bar, { width: `${s * p * 100}%` }); text(v, (s * p).toFixed(2));
    });
    const lk = eio(prog(t, 55.2, 55.45));
    E.shackle.setAttribute('transform', `translate(0 ${(-14 * (1 - lk)).toFixed(2)})`);

    /* ===== 小球 ===== */
    const R = (() => { const r = E.companion.getBoundingClientRect(); return { x: (r.left - SR.left) / S, y: (r.top - SR.top) / S, r: 15 }; })();
    const C0 = { x: 960, y: 520, r: 150 };
    let P;
    if (t < 3.0) P = C0;
    else if (t < 4.3) { const p = eio(prog(t, 3.0, 4.3)); P = { x: lerp(C0.x, WM.x, p), y: lerp(C0.y, WM.y, p), r: lerp(C0.r, WM.r, p) }; }
    else if (t < 5.7) P = WM;
    else if (t < 7.0) { const p = eio(prog(t, 5.7, 7.0)); P = { x: lerp(WM.x, R.x, p), y: lerp(WM.y, R.y, p), r: lerp(WM.r, R.r, p) }; }
    else if (t < 56.2) P = R;
    else if (t < 57.5) { const p = eio(prog(t, 56.2, 57.5)); P = { x: lerp(R.x, WM.x, p), y: lerp(R.y, WM.y, p), r: lerp(R.r, WM.r, p) }; }
    else P = WM;
    const breathe = 1 + 0.018 * Math.sin(t * 1.7);
    css(E.ball, { transform: `translate(${(P.x - 100).toFixed(2)}px, ${(P.y - 100).toFixed(2)}px) scale(${((P.r / 90) * breathe).toFixed(4)})`, opacity: String(1 - 0.45 * dim6) });
    css(E.ballRing, { strokeDashoffset: String(1 - eio(prog(t, 0.3, 1.6))), opacity: String(vis(t, 0.3, 2.4, 0.1, 0.7)) });
    const fill = eo(prog(t, 1.3, 2.1));
    css(E.ballBody, { opacity: String(fill) });
    let blink = 1;
    for (const b of BLINKS) { const d = Math.abs(t - b); if (d < 0.09) blink = Math.min(blink, 0.08 + (0.92 * d) / 0.09); }
    const squint = lerp(1, 0.6, eio(prog(t, 49.3, 49.7)) * (1 - eio(prog(t, 52.8, 53.2))));
    const [lx, ly] = look(t);
    E.eyes.setAttribute('transform', `translate(${lx.toFixed(2)} ${ly.toFixed(2)}) translate(0 -3) scale(1 ${(blink * squint).toFixed(3)}) translate(0 3)`);
    css(E.eyes, { opacity: String(eo(prog(t, 1.7, 2.3))) });

    /* ===== 光标 ===== */
    const cv = CURVIS.reduce((m, w) => Math.max(m, vis(t, w[0], w[1], 0.2, 0.25)), 0);
    if (cv > 0.001) {
      const [x, y] = cursorAt(t);
      const press = CLICKS.some((c) => Math.abs(t - c) < 0.06) ? 0.84 : 1;
      css(E.cursor, { opacity: String(cv), transform: `translate(${(x - 5).toFixed(1)}px, ${(y - 3).toFixed(1)}px) scale(${press})`, visibility: 'visible' });
      const last = CLICKS.filter((c) => c <= t).pop();
      const rp = last !== undefined ? prog(t, last, last + 0.4) : 1;
      css(E.clickRing, { opacity: String(rp < 1 ? (1 - rp) * 0.8 : 0), transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${lerp(0.3, 1.4, eo(rp))})` });
    } else {
      css(E.cursor, { visibility: 'hidden' }); css(E.clickRing, { opacity: '0' });
    }
  }

  /* ================= 舞台缩放 ================= */
  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    E.stage.style.transform = `translate(${-960 * s}px, ${-540 * s}px) scale(${s})`;
  }
  window.addEventListener('resize', () => { fit(); render(state.t); });

  /* ================= 播放控制 ================= */
  const state = { t: 0, playing: false, ctx: null, handle: null, t0: 0, raf: 0 };
  const playBtn = $('#playBtn'), scrub = $('#scrub'), timeLbl = $('#timeLbl'), hint = $('#startHint'), controls = $('#controls');

  function seek(t) {
    state.t = clamp(t, 0, DUR);
    render(state.t);
    scrub.value = String(state.t);
    timeLbl.textContent = `${state.t.toFixed(2).padStart(5, '0')} / 60`;
  }
  function loop() {
    if (!state.playing) return;
    const t = state.ctx.currentTime - state.t0;
    if (t >= DUR) { seek(DUR); pause(); return; }
    seek(t);
    state.raf = requestAnimationFrame(loop);
  }
  async function play(dest) {
    if (state.playing) return;
    if (state.t >= DUR - 0.01) state.t = 0;
    hint.style.display = 'none';
    state.ctx ||= new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    await state.ctx.resume();
    state.handle = window.MovaAudio.schedule(state.ctx, dest || state.ctx.destination, state.t, CUES);
    state.t0 = state.handle.startAt - state.t;
    state.playing = true;
    playBtn.textContent = '❚❚';
    loop();
  }
  function pause() {
    state.playing = false;
    cancelAnimationFrame(state.raf);
    state.handle?.stop(); state.handle = null;
    playBtn.textContent = '▶';
  }
  playBtn.addEventListener('click', () => (state.playing ? pause() : play()));
  hint.addEventListener('click', () => play());
  scrub.addEventListener('input', () => { const was = state.playing; if (was) pause(); seek(+scrub.value); if (was) play(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
    if (e.code === 'KeyF') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') { const was = state.playing; if (was) pause(); seek(state.t + (e.code === 'ArrowRight' ? 2 : -2)); if (was) play(); }
  });
  let idle = 0;
  window.addEventListener('mousemove', () => { controls.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => state.playing && controls.classList.add('idle'), 2200); });

  /* ================= 导出接口（scripts/probes/record-promo.cjs 使用） ================= */
  const params = new URLSearchParams(location.search);
  if (params.has('export')) { document.body.classList.add('export'); hint.style.display = 'none'; }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  window.promo = {
    duration: DUR,
    cues: CUES,
    seek(t) { seek(t); return true; },
    async renderWavBase64() { return toBase64(await window.MovaAudio.renderWav(CUES)); },
    /** 实时录制：画面来自 getDisplayMedia（宿主授权本帧），声音直接接入 MediaStreamDestination。 */
    async record({ bitrate = 16e6, fps = 60 } = {}) {
      const bridge = window.recorderBridge;
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false });
      const ctx = new AudioContext({ sampleRate: 48000 });
      const dest = ctx.createMediaStreamDestination();
      const stream = new MediaStream([...screen.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 256000 });
      rec.ondataavailable = async (e) => { if (e.data.size) bridge?.chunk(new Uint8Array(await e.data.arrayBuffer())); };
      seek(0);
      await new Promise((r) => setTimeout(r, 600));
      rec.start(1000);
      state.ctx = ctx;
      state.t = 0;
      await play(dest);
      await new Promise((resolve) => {
        const check = () => (state.playing ? setTimeout(check, 200) : resolve());
        check();
      });
      await new Promise((r) => setTimeout(r, 500));
      await new Promise((resolve) => { rec.onstop = resolve; rec.stop(); });
      screen.getTracks().forEach((tr) => tr.stop());
      await new Promise((r) => setTimeout(r, 300));
      bridge?.done();
      return mime;
    },
  };

  fit();
  seek(params.has('t') ? +params.get('t') : 0);
})();
