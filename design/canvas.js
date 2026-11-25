/* Buildless, offline Mova Design layout prototype. No AI or backend requests. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const STORAGE_KEY = 'mova-canvas.prototype.v1';
  const fresh = () => ({ version: 1, title: '栖游 · 旅行应用', direction: 1, boards: [
    { id: 'discover', kind: 'discover', name: '发现目的地', width: 390, height: 780, background: '#f5f3ed', radius: 3, accent: '#365a4d', x: 0, y: 0, edits: {} },
    { id: 'detail', kind: 'detail', name: '旅行详情', width: 390, height: 780, background: '#f5f3ed', radius: 3, accent: '#365a4d', x: 0, y: 0, edits: {} },
    { id: 'saved', kind: 'saved', name: '我的收藏', width: 390, height: 780, background: '#f5f3ed', radius: 3, accent: '#365a4d', x: 0, y: 0, edits: {} }
  ], nodes: [] });
  const validColor = value => /^#[\da-f]{6}$/i.test(value || '');
  const finite = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
  function validDocument(value) {
    if (value?.version !== 1 || !Array.isArray(value.boards) || value.boards.length > 30 || !Array.isArray(value.nodes)) return false;
    const ids = new Set();
    for (const board of value.boards) {
      if (!board || typeof board.id !== 'string' || ids.has(board.id) || !['discover', 'detail', 'saved'].includes(board.kind) || typeof board.name !== 'string') return false;
      ids.add(board.id);
      if (!validColor(board.background) || !validColor(board.accent) || !board.edits || typeof board.edits !== 'object') return false;
      board.width = finite(board.width, 390, 240, 1200); board.height = finite(board.height, 780, 360, 1800); board.radius = finite(board.radius, 3, 0, 80);
      board.x = finite(board.x, 0, -20000, 20000); board.y = finite(board.y, 0, -20000, 20000);
    }
    if (value.nodes.length > 100) return false;
    for (const node of value.nodes) {
      if (!node || typeof node.id !== 'string' || ids.has(node.id) || !['text', 'rect', 'comment', 'image'].includes(node.kind)) return false;
      ids.add(node.id);
      if (node.kind === 'image' && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z\d+/=]+$/.test(node.src || '')) return false;
      node.x = finite(node.x, 0, -20000, 20000); node.y = finite(node.y, 0, -20000, 20000);
      node.width = finite(node.width, 200, 40, 2000); node.height = finite(node.height, 120, 30, 2000);
      node.fontSize = finite(node.fontSize, 24, 10, 120); node.radius = finite(node.radius, 0, 0, 100);
      if (node.color && !validColor(node.color)) return false;
    }
    value.title = String(value.title || '未命名设计').slice(0, 60); value.direction = finite(value.direction, 1, 1, 999);
    return true;
  }
  let state = fresh();
  try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (validDocument(saved)) state = saved; } catch { /* File protocol may restrict storage. */ }
  let selected = state.boards[0]?.id || null;
  let tool = 'select';
  let viewport = { zoom: .67, x: 0, y: 0 };
  let history = [], future = [], storageAvailable = true, saveTimer, toastTimer, space = false, gesture = null, fitPending = true, previewIndex = 0;
  const canvas = $('#canvas-viewport'), world = $('#canvas-world');
  let playing = false;
  function slidePanel(panel, side) {
    let open = false, animation;
    return { get open() { return open; }, setOpen(next) {
      if (next === open) return; open = next; animation?.cancel();
      if (next) panel.hidden = false;
      $('.design-panel').classList.toggle(side === 'left' ? 'pages-open' : 'properties-open', next);
      if (side === 'left') $('#canvas-refresh').setAttribute('aria-expanded', String(next));
      if (matchMedia('(prefers-reduced-motion:reduce)').matches) { panel.hidden = !next; return; }
      animation = panel.animate([{transform:next ? `translateX(${side === 'left' ? '-100%' : '100%'})` : 'none',opacity:next ? 0 : 1},{transform:next ? 'none' : `translateX(${side === 'left' ? '-100%' : '100%'})`,opacity:next ? 1 : 0}],{duration:260,easing:'cubic-bezier(.22,.9,.26,1)',fill:'both'});
      const current=animation; current.onfinish=()=>{if(current!==animation)return;panel.hidden=!open;current.cancel();};
    }, close() { this.setOpen(false); } };
  }
  const layersMorph = slidePanel($('#layers-panel'), 'left');
  const inspectorMorph = slidePanel($('#inspector'), 'right');
  let inspectNext = false;
  function pages() { state.pages ||= [{id:'screens',name:'Screens'}]; state.activePage ||= state.pages[0].id; state.boards.forEach(b=>{b.pageId ||= 'screens';}); return state.pages; }
  function visibleBoards() { pages(); return state.boards.filter(b=>b.pageId===state.activePage); }
  function visibleNodes() { return state.nodes.filter(n=>(n.pageId || 'screens')===state.activePage); }

  const art = (name = 'landscape') => `<svg class="scenic-art" viewBox="0 0 640 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><use href="#${name}"/></svg>`;
  const status = () => `<div class="device-status"><span>9:41</span><span>${icon('signal')}<span class="battery"></span></span></div>`;
  const text = (board, key, fallback) => `<span data-edit="${key}">${escape(board.edits[key] ?? fallback)}</span>`;
  const bottom = active => `<div class="screen-bottom"><span class="${active === 0 ? 'active' : ''}" data-preview-page="discover">${icon('compass')}发现</span><span data-preview-page="detail">${icon('pin')}旅程</span><span class="${active === 2 ? 'active' : ''}" data-preview-page="saved">${icon('heart')}收藏</span><span data-preview-page="saved">${icon('person')}我的</span><div class="home-indicator"></div></div>`;

  function screenContent(board) {
    if (board.kind === 'discover') return `${status()}<div class="app-top"><div class="qiyo-logo">栖游<small>QIYO</small></div>${icon('settings')}</div><p class="screen-greeting">向山野，向自由。</p><h3 class="screen-title">${text(board, 'heading', '下一站，')}<br>${text(board, 'heading-two', '去心之所向。')}</h3><div class="screen-search">${icon('search')}<span>想去哪里，放空一下？</span>${icon('settings')}</div><div class="screen-categories"><span class="active">为你推荐</span><span>山野</span><span>海岸</span><span>城市漫游</span></div><div class="destination-card" data-preview-page="detail">${art()}<div class="destination-overlay"></div><span class="card-badge">本周灵感</span><span class="card-heart">${icon('heart')}</span><div class="destination-copy"><small>FIND YOUR STILLNESS</small><h4>${text(board, 'destination', '在山水之间，慢下来。')}</h4><p>${icon('pin')}浙江 · 桐庐 <span>　3 天 2 夜</span></p></div><span class="card-next">${icon('arrow-right')}</span></div><div class="section-row"><span>小众，才动人</span><small>查看全部 ↗</small></div><div class="mini-destinations"><div class="mini-destination">${art('mountains')}<span>走进旷野</span></div><div class="mini-destination">${art()}<span>枕水而居</span></div></div>${bottom(0)}`;
    if (board.kind === 'detail') return `<div class="detail-hero">${art()}${status()}<div class="detail-nav"><span data-preview-page="discover">${icon('arrow-left')}</span><span data-preview-page="saved">${icon('heart')}</span></div><div class="image-pagination"><i></i><i></i><i></i></div></div><div class="detail-body"><span class="eyebrow">A LITTLE CLOSER TO NATURE</span><div class="detail-heading"><h3>${text(board, 'heading', '山水之间，桐庐')}</h3><span class="rating">★ 4.9</span></div><p class="location">${icon('pin')}浙江 · 杭州 · 桐庐</p><div class="trip-stats"><span>3 天 2 夜<small>刚好的旅行长度</small></span><span>轻徒步<small>放慢脚步去感受</small></span><span>2–6 人<small>和喜欢的人同行</small></span></div><p class="detail-description">${text(board, 'description', '把城市的喧嚣留在身后。沿着富春江畔漫步，在青山与水雾间，找回属于自己的节奏。')}</p></div><div class="detail-book"><div class="detail-price">¥ 1,280<small>/ 人起</small></div><div class="book-button" data-preview-page="saved">${text(board, 'button', '把向往变成出发')}${icon('arrow-right')}</div><div class="home-indicator"></div></div>`;
    return `${status()}<div class="app-top"><div class="qiyo-logo">栖游<small>QIYO</small></div>${icon('more')}</div><h3 class="saved-title">${text(board, 'heading', '把向往，慢慢收藏。')}</h3><p class="saved-subtitle">${text(board, 'description', '有些地方，光是想想就很美好。')}<br>这里装着你的下一次出发。</p><div class="saved-tabs"><span class="active">全部收藏 <small>03</small></span><span>目的地</span><span>旅行灵感</span></div><div class="saved-card" data-preview-page="detail"><div class="saved-card-art">${art()}</div><div class="saved-card-info"><small>RIVER & MOUNTAINS</small><h4>山水之间，桐庐</h4><p>浙江 · 3 天 2 夜</p><span>¥ 1,280 起 ${icon('heart')}</span></div></div><div class="saved-card" data-preview-page="detail"><div class="saved-card-art">${art('mountains')}</div><div class="saved-card-info"><small>INTO THE WILDERNESS</small><h4>${text(board, 'destination', '去阿勒泰，追一场风')}</h4><p>新疆 · 5 天 4 夜</p><span>¥ 3,680 起 ${icon('heart')}</span></div></div><div class="saved-quote">${icon('compass')}<p>不着急出发，<br>先把喜欢的远方收好。</p></div>${bottom(2)}`;
  }

  const selectedBoard = () => state.boards.find(b => b.id === selected);
  const selectedNode = () => state.nodes.find(n => n.id === selected);
  const boardElement = id => $$('.artboard').find(el => el.dataset.id === id);
  const nodeElement = id => $$('.extra-node', world).find(el => el.dataset.id === id);
  const surfaceStyle = b => `width:${b.width}px;height:${b.height}px;border-radius:${b.radius}px;background:${b.background};--accent:${b.accent};opacity:${(b.opacity??100)/100};overflow:${b.clip===false?'visible':'hidden'};transform:scale(${b.flipX?-1:1},${b.flipY?-1:1})`;

  function render() {
    $('#document-name').textContent = state.title;
    document.title = `${state.title} · Mova Design`;
    pages();

    world.style.width = `${Math.max(390, visibleBoards().reduce((sum, b) => sum + b.width, 0) + (visibleBoards().length - 1) * 60)}px`;
    $('#artboards').innerHTML = visibleBoards().map(b => `<article class="artboard${selected === b.id ? ' selected' : ''}" data-id="${escape(b.id)}" style="width:${b.width}px;transform:translate(${b.x}px,${b.y}px) rotate(${b.rotation||0}deg)" tabindex="0" aria-label="${escape(b.name)}画板" aria-selected="${selected === b.id}"><div class="artboard-label"><span>${icon('frame')}<span>${escape(b.name)}</span></span><span class="board-dimensions">${b.width} × ${b.height}</span></div><div class="board-surface" style="${surfaceStyle(b)}">${screenContent(b)}</div><i class="selection-handle tl"></i><i class="selection-handle tr"></i><i class="selection-handle bl"></i><i class="selection-handle br"></i></article>`).join('');
    $$('.extra-node', world).forEach(n => n.remove());
    for (const node of visibleNodes()) {
      const el = document.createElement('div'); el.dataset.id = node.id; el.tabIndex = 0;
      el.className = `extra-node ${node.kind}-node${selected === node.id ? ' selected' : ''}`;
      el.setAttribute('aria-label', node.kind === 'rect' ? '矩形' : node.kind === 'image' ? '导入图片' : node.text || '文字');
      el.style.cssText = `left:${node.x}px;top:${node.y}px;width:${node.width}px;min-height:${node.height}px;font-size:${node.fontSize || 24}px;border-radius:${node.radius || 0}px`;
      el.style.opacity=String((node.opacity??100)/100);el.style.transform=`rotate(${node.rotation||0}deg) scale(${node.flipX?-1:1},${node.flipY?-1:1})`;
      if (node.kind === 'rect') { el.style.height = `${node.height}px`; el.style.background = node.color; }
      else if (node.kind === 'image') { el.style.height = `${node.height}px`; const img = new Image(); img.src = node.src; img.alt = node.name || '参考图片'; el.append(img); }
      else { el.textContent = node.text || ''; if (node.color) el.style.color = node.color; }
      world.append(el);
    }
    renderLayers(); updateSelection(); transformWorld(); updateHistory();
    world.classList.toggle("empty-page", !visibleBoards().length);
  }

  function updateSelection() {
    $$('.artboard', world).forEach(el => { const active = el.dataset.id === selected; el.classList.toggle('selected', active); el.setAttribute('aria-selected', active); });
    $$('.extra-node', world).forEach(el => el.classList.toggle('selected', el.dataset.id === selected));
    $$('.layer-row').forEach(el => { const active = el.dataset.select === selected; el.classList.toggle('active', active); el.setAttribute('aria-pressed', active); });
    const board = selectedBoard(), node = selectedNode();
    $('#selection-context').hidden = !board && !node;
    $('#context-name').textContent = board?.name || (node ? { text: '文字', rect: '矩形', image: '参考图片', comment: '批注' }[node.kind] : '');
    renderInspector();
  }

  function select(id) { selected = id; updateSelection(); if(id && !playing) inspectorMorph.setOpen(true); }
  function renderLayers() {
    $('#pages-list').innerHTML = pages().map(p=>`<button class="op-page-row ${p.id===state.activePage?'active':''}" data-page="${escape(p.id)}">${icon('rect')}${escape(p.name)}</button>`).join('');
    $('#layers-list').innerHTML = visibleBoards().map(b => `<button class="layer-row${selected === b.id ? ' active' : ''}" data-select="${escape(b.id)}" aria-pressed="${selected === b.id}">${icon('frame')}${escape(b.name)}<small>${b.width}</small></button><div class="layer-child">${icon('text')}文字与内容</div><div class="layer-child">${icon('image')}目的地视觉</div>`).join('') + visibleNodes().map(n => `<button class="layer-row" data-select="${escape(n.id)}" aria-pressed="${selected === n.id}">${icon(n.kind === 'text' ? 'text' : n.kind === 'image' ? 'image' : n.kind === 'comment' ? 'comment' : 'rect')}${escape(n.text?.slice(0, 13) || n.name || '矩形')}</button>`).join('');
  }

  function renderInspector() {
    const b=selectedBoard(), n=selectedNode(), item=b||n;
    if(!item){$('#inspector-content').innerHTML='<div class="op-object-header">Page<button class="icon-button small" id="op-properties-close" aria-label="关闭属性">×</button></div><section class="op-section"><h4>页面</h4><p>选择画板或图层查看属性</p></section>';return;}
    const number=(key,label,value,min=-20000,max=20000)=>`<label class="op-field"><span>${label}</span><input data-property="${key}" type="number" value="${value}" min="${min}" max="${max}" aria-label="${label}"></label>`;
    const group=(title,content)=>`<section class="op-section"><h4>${title}</h4>${content}</section>`;
    $('#inspector-content').innerHTML=`<div class="op-object-header">${icon(b?'frame':n.kind==='text'?'text':'rect')}<input data-property="${b?'name':n.kind==='image'?'name':'text'}" value="${escape(b?.name||n?.text||n?.name||'Rectangle')}" aria-label="对象名称"><button class="icon-button small" id="op-properties-close" aria-label="关闭属性">×</button></div>`+
      (b?group('Frame','<select id="frame-preset" aria-label="画板尺寸"><option value="custom">Custom</option><option value="390,780">Mobile · 390 × 780</option><option value="768,1024">Tablet · 768 × 1024</option><option value="1200,800">Desktop · 1200 × 800</option></select>'):'')+
      group('Position',`<div class="op-alignment">${['⇤','↔','⇥','↥','↕','↧'].map((v,i)=>`<button data-align="${i}" title="对齐 ${i+1}">${v}</button>`).join('')}</div><div class="op-fields">${number('x','X',Math.round(item.x))}${number('y','Y',Math.round(item.y))}${number('rotation','↻',item.rotation||0,-360,360)}<div class="op-flips"><button data-flip="x" aria-label="水平翻转">⋈</button><button data-flip="y" aria-label="垂直翻转">⋈</button></div></div>`)+
      group('Auto layout',`<div class="op-caption">Flow</div><div class="op-flow">${['absolute','vertical','horizontal','grid','wrap'].map((v,i)=>`<button data-layout="${v}" aria-label="${v}" aria-pressed="${(item.layout||'absolute')===v}">${['✥','▤','▥','⊞','↪'][i]}</button>`).join('')}</div><div class="op-caption">Dimensions</div><div class="op-fields">${number('width','W',item.width,b?240:40,b?1200:2000)}${number('height','H',item.height,b?360:30,b?1800:2000)}</div><div class="op-caption">Direction</div><select data-property="direction"><option>Auto</option><option ${item.direction==='Left to right'?'selected':''}>Left to right</option><option ${item.direction==='Right to left'?'selected':''}>Right to left</option></select><div class="op-layout-space"><div class="op-anchor">${Array.from({length:9},(_,i)=>`<button data-anchor="${i}" aria-label="对齐位置 ${i+1}" aria-pressed="${(item.anchor||0)===i}">•</button>`).join('')}</div><div>${number('gap','↕',item.gap||0,0,200)}${number('padding','↔',item.padding||0,0,200)}</div></div><div class="op-caption">Corner radius</div>${number('radius','⌜',item.radius||0,0,80)}<label class="op-checkbox"><input type="checkbox" data-property="clip" ${item.clip!==false?'checked':''}>Clip content</label>`)+
      group('Appearance',`<div class="op-caption">Blend mode</div><select data-property="blend"><option>Pass through</option><option ${item.blend==='Multiply'?'selected':''}>Multiply</option><option ${item.blend==='Screen'?'selected':''}>Screen</option></select><div class="op-caption">Opacity</div>${number('opacity','◉',item.opacity??100,0,100)}`)+
      group('Fill',`<div class="op-color"><input type="color" data-property="${b?'background':'color'}" value="${b?.background||n?.color||'#eeeeee'}" aria-label="填充颜色"><span>${(b?.background||n?.color||'#eeeeee').toUpperCase()}</span><span>100%</span></div>`)+
      (b?group('Theme',`<div class="op-color"><input type="color" data-property="accent" value="${b.accent}" aria-label="主题色"><span>${b.accent.toUpperCase()}</span></div><button class="property-action" id="sync-accent">应用到全部画板</button>`):'');
  }

  function transformWorld() {
    world.style.transform = `translate(-50%,-50%) translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`;
    canvas.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`;
    canvas.style.backgroundSize = `${20 * viewport.zoom}px ${20 * viewport.zoom}px`;
  }
  function fit() {
    const rect = canvas.getBoundingClientRect();
    const bounds = worldBounds();
    viewport.zoom = Math.max(.1, Math.min(.84, (rect.width - 100) / Math.max(bounds.width, 390), (rect.height - 182) / Math.max(bounds.height, 400)));
    viewport.x = -(bounds.centerX - world.offsetWidth / 2) * viewport.zoom;
    viewport.y = -(bounds.centerY - world.offsetHeight / 2) * viewport.zoom - 2;
    transformWorld();
  }
  function worldBounds() {
    let minX = 0, minY = 0, maxX = world.offsetWidth, maxY = world.offsetHeight;
    for (const b of state.boards) { const el = boardElement(b.id); if (el) { const top = $('#artboards').offsetTop + el.offsetTop + b.y; minX = Math.min(minX, el.offsetLeft + b.x); maxX = Math.max(maxX, el.offsetLeft + b.x + b.width); minY = Math.min(minY, top); maxY = Math.max(maxY, top + b.height); } }
    for (const n of state.nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height); }
    return { width: maxX - minX, height: maxY - minY, centerX: (maxX + minX) / 2, centerY: (maxY + minY) / 2 };
  }
  function zoom(value, x, y) {
    const old = viewport.zoom, next = Math.max(.1, Math.min(2, value));
    if (x != null) { const r = canvas.getBoundingClientRect(); const dx = x - r.left - r.width / 2, dy = y - r.top - r.height / 2; viewport.x = dx - (dx - viewport.x) * next / old; viewport.y = dy - (dy - viewport.y) * next / old; }
    viewport.zoom = next; transformWorld();
  }
  function checkpoint() { history.push(clone(state)); if (history.length > 40) history.shift(); future = []; }
  function updateHistory() { $('#undo').disabled = !history.length; $('#redo').disabled = !future.length; }
  function persist() {
    clearTimeout(saveTimer);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); storageAvailable = true; } catch { storageAvailable = false; }
    $('#saved-state').textContent = storageAvailable ? '已保存' : '未持久保存';
    updateHistory();
  }
  function changed() { $('#saved-state').textContent = '保存中'; clearTimeout(saveTimer); saveTimer = setTimeout(persist, 200); updateHistory(); }
  function undo() { if (!history.length) return; future.push(clone(state)); state = history.pop(); if (!state.boards.some(b => b.id === selected) && !state.nodes.some(n => n.id === selected)) selected = state.boards[0]?.id || null; render(); persist(); }
  function redo() { if (!future.length) return; history.push(clone(state)); state = future.pop(); render(); persist(); }
  function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3300); }
  function togglePanel(panel, trigger, force) {
    const controller = panel.id === 'layers-panel' ? layersMorph : panel.id === 'inspector' ? inspectorMorph : null;
    if (controller) { const open = force ?? !controller.open; controller.setOpen(open); return open; }
    const open = force ?? panel.hidden; panel.hidden = !open; trigger.setAttribute('aria-expanded', String(open)); return open;
  }
  function toggleChat() {
    if (matchMedia('(max-width:740px)').matches) { $('#content-frame').classList.toggle('chat-mobile-open'); $('#toggle-chat').setAttribute('aria-expanded', String($('#content-frame').classList.contains('chat-mobile-open'))); }
    else { $('#content-frame').classList.toggle('chat-collapsed'); const open = !$('#content-frame').classList.contains('chat-collapsed'); $('#toggle-chat').setAttribute('aria-expanded', String(open)); $('#toggle-chat').setAttribute('aria-label', open ? '收起对话' : '展开对话'); }
    requestAnimationFrame(fit);
  }
  function setTool(next) {
    if (next === 'frame') { addBoard(); return; }
    if (next === 'image') { $('#image-input').click(); return; }
    tool = next; canvas.dataset.tool = tool;
    $$('.drawing-toolbar [data-tool]').forEach(b => { const active = b.dataset.tool === tool; b.classList.toggle('active', active); if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', String(active)); });
    $('#canvas-hint').textContent = ({ select: '双击文字编辑 · 空格拖动画布', hand: '拖动画布 · 滚轮平移', text: '点击画布添加文字', rect: '在画布空白处拖动绘制矩形', comment: '点击画布留下批注', pen:'钢笔工具' })[tool];
  }
  function newId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
  function addBoard(duplicate = false) {
    if (state.boards.length >= 30) { toast('原型最多支持 30 个画板'); return; }
    checkpoint(); const base = duplicate ? selectedBoard() : state.boards[0];
    const board = clone(base || fresh().boards[0]); board.id = newId('board'); board.name = duplicate ? `${board.name} 副本` : `新画板 ${state.boards.length + 1}`; board.x = 0; board.y = 0;
    if (!duplicate) board.kind = 'saved';
    board.pageId=state.activePage || 'screens'; state.boards.push(board); selected = board.id; render(); fit(); changed(); toast(duplicate ? '已复制画板，可拖动标题重新排列' : '已新增画板');
  }
  function removeSelected() {
    const b = selectedBoard(), n = selectedNode(); if (!b && !n) return;
    if (b && state.boards.length === 1) { toast('请至少保留一个画板'); return; }
    checkpoint(); state.boards = state.boards.filter(b => b.id !== selected); state.nodes = state.nodes.filter(n => n.id !== selected); selected = null; render(); changed(); toast('已删除，可撤销恢复');
  }

  $('#toggle-chat').addEventListener('click', toggleChat); $('#rail-chat').addEventListener('click', toggleChat);
  $('#rail-canvas').addEventListener('click', fit);

  $('#rail-layers').addEventListener('click', () => togglePanel($('#layers-panel'), $('#canvas-refresh')));

  $('#layers-list').addEventListener('click', event => { const row = event.target.closest('[data-select]'); if (row) focusBoard(row.dataset.select); });
  $$('[data-select-board]').forEach(button => button.addEventListener('click', () => focusBoard(button.dataset.selectBoard)));
  function focusBoard(id) {
    const item = state.boards.find(b => b.id === id) || state.nodes.find(n => n.id === id);
    if (!item) { toast('该示例画板已删除，可以撤销恢复'); return; }
    const targetBoard=state.boards.find(b=>b.id===id); if(targetBoard && targetBoard.pageId!==state.activePage){state.activePage=targetBoard.pageId;render();}
    select(id); const el = boardElement(id) || nodeElement(id);
    const w = el.offsetWidth, h = el.offsetHeight;
    viewport.x = -(el.offsetLeft + item.x + w / 2 - world.offsetWidth / 2) * viewport.zoom;
    // Extra nodes already have x/y in their absolute position.
    if (selectedNode()) viewport.x = -(item.x + w / 2 - world.offsetWidth / 2) * viewport.zoom;
    viewport.y = -((selectedBoard() ? $('#artboards').offsetTop : 0) + item.y + h / 2 - world.offsetHeight / 2) * viewport.zoom;
    transformWorld();
  }
  $('#selection-context').addEventListener('click', event => { if (event.target.closest('#clear-selection')) select(null); else { togglePanel($('#inspector'), $('#canvas-inspect'), true); } });
  $('#clear-selection').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(null); } });
  $('#add-board').addEventListener('click', () => addBoard());
  $('#undo').addEventListener('click', undo); $('#redo').addEventListener('click', redo);
  $('#canvas-refresh').addEventListener('click', () => layersMorph.setOpen(!layersMorph.open));
  $('#canvas-inspect').addEventListener('click', () => { inspectNext = !inspectNext; setTool('select'); $('#canvas-inspect').setAttribute('aria-pressed', String(inspectNext)); $('#canvas-hint').textContent = inspectNext ? '点击画板或对象，查看属性' : '双击文字编辑 · 空格拖动画布'; });
  $$('.drawing-toolbar [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('.swatch').forEach(b => b.addEventListener('click', () => { checkpoint(); state.boards.forEach(board => { board.accent = b.dataset.accent; }); render(); changed(); toast('已更新全部画板的主题色'); }));
  $('#inspector-content').addEventListener('change', event => {
    const input = event.target.closest('[data-property]'), item = selectedBoard() || selectedNode(); if (!input || !item) return;
    const key = input.dataset.property; checkpoint();
    item[key] = input.type === 'number' ? finite(input.value, item[key], Number(input.min), Number(input.max)) : input.type==='checkbox' ? input.checked : input.value;
    render(); changed();
  });
  $('#inspector-content').addEventListener('click', event => { if (event.target.id === 'sync-accent' && selectedBoard()) { checkpoint(); const color = selectedBoard().accent; state.boards.forEach(b => { b.accent = color; }); render(); changed(); toast('主题色已应用到全部画板'); } });
  $('#new-direction').addEventListener('click', () => { checkpoint(); state.direction += 1; state.boards.forEach(b => { b.accent = ['#365a4d', '#526b85', '#9a694b'][(state.direction - 1) % 3]; }); render(); changed(); toast(`已创建探索方向 ${String(state.direction).padStart(2, '0')}，可撤销回上一方向`); });

  canvas.addEventListener('wheel', event => {
    if (event.target.closest('.op-sidebar, .op-tool-menu, .op-play-stage, .floating-panel, .drawing-toolbar, .zoom-toolbar, .canvas-overview')) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) zoom(viewport.zoom * Math.exp(-event.deltaY * .005), event.clientX, event.clientY);
    else { viewport.x -= event.shiftKey ? event.deltaY : event.deltaX; viewport.y -= event.shiftKey ? 0 : event.deltaY; transformWorld(); }
  }, { passive: false });
  function pointInWorld(event) { const r = world.getBoundingClientRect(); return { x: (event.clientX - r.left) / viewport.zoom, y: (event.clientY - r.top) / viewport.zoom }; }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target.closest('.op-sidebar, .op-tool-menu, .op-play-stage, .floating-panel, .drawing-toolbar, .zoom-toolbar, .canvas-overview, .inspector-toggle, .design-tokens, [contenteditable=true]')) return;
    if(playing) return;
    if (space || tool === 'hand' || event.button === 1) {
      event.preventDefault(); gesture = { kind: 'pan', startX: event.clientX, startY: event.clientY, x: viewport.x, y: viewport.y }; canvas.classList.add('is-panning'); canvas.setPointerCapture(event.pointerId); return;
    }
    const boardEl = event.target.closest('.artboard'), nodeEl = event.target.closest('.extra-node');
    if (inspectNext && (boardEl || nodeEl)) { select((boardEl || nodeEl).dataset.id); inspectNext = false; $('#canvas-inspect').setAttribute('aria-pressed', 'false'); inspectorMorph.setOpen(true); return; }
    if (boardEl && tool === 'select') {
      select(boardEl.dataset.id);
      if (event.target.closest('.artboard-label')) { const b = selectedBoard(); gesture = { kind: 'move', item: b, el: boardEl, startX: event.clientX, startY: event.clientY, x: b.x, y: b.y, saved: false }; event.preventDefault(); canvas.setPointerCapture(event.pointerId); }
      return;
    }
    if (nodeEl && tool === 'select') { select(nodeEl.dataset.id); const n = selectedNode(); gesture = { kind: 'move', item: n, el: nodeEl, startX: event.clientX, startY: event.clientY, x: n.x, y: n.y, node: true, saved: false }; event.preventDefault(); canvas.setPointerCapture(event.pointerId); return; }
    if (tool === 'select') { select(null); return; }
    if (state.nodes.length >= 100) { toast('原型最多支持 100 个额外对象'); return; }
    if(tool==='pen'){toast('钢笔工具尚未接入编辑引擎');setTool('select');return;}
    const point = pointInWorld(event); checkpoint();
    const node = { id: newId(tool), kind: tool, x: Math.round(point.x), y: Math.round(point.y), width: tool === 'rect' ? 150 : 240, height: tool === 'rect' ? 100 : 60, radius: tool === 'rect' ? 10 : 0, fontSize: tool === 'comment' ? 16 : 24, color: tool === 'rect' ? '#8ca597' : tool === 'comment' ? '#574f3c' : '#eeeeee', text: tool === 'text' ? '写下你的想法' : tool === 'comment' ? '在这里留下设计想法…' : '' };
    node.pageId=state.activePage || 'screens'; state.nodes.push(node); selected = node.id; render();
    if (tool === 'rect') { gesture = { kind: 'draw', item: node, start: point, el: nodeElement(node.id) }; canvas.setPointerCapture(event.pointerId); }
    else { setTool('select'); editElement(nodeElement(node.id)); }
    changed();
  });
  canvas.addEventListener('pointermove', event => {
    if (!gesture) return;
    if (gesture.kind === 'pan') { viewport.x = gesture.x + event.clientX - gesture.startX; viewport.y = gesture.y + event.clientY - gesture.startY; transformWorld(); }
    else if (gesture.kind === 'move') {
      const dx = (event.clientX - gesture.startX) / viewport.zoom, dy = (event.clientY - gesture.startY) / viewport.zoom;
      if (!gesture.saved && Math.abs(dx) + Math.abs(dy) > 3) { checkpoint(); gesture.saved = true; canvas.classList.add('is-dragging'); }
      if (!gesture.saved) return;
      gesture.item.x = Math.round(gesture.x + dx); gesture.item.y = Math.round(gesture.y + dy);
      if (gesture.node) { gesture.el.style.left = `${gesture.item.x}px`; gesture.el.style.top = `${gesture.item.y}px`; } else gesture.el.style.transform = `translate(${gesture.item.x}px,${gesture.item.y}px)`;
    } else if (gesture.kind === 'draw') {
      const p = pointInWorld(event), n = gesture.item; n.x = Math.min(p.x, gesture.start.x); n.y = Math.min(p.y, gesture.start.y); n.width = Math.max(40, Math.abs(p.x - gesture.start.x)); n.height = Math.max(30, Math.abs(p.y - gesture.start.y));
      Object.assign(gesture.el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.width}px`, height: `${n.height}px` });
    }
  });
  function finishGesture() { if (!gesture) return; const modified = gesture.kind === 'draw' || gesture.saved; gesture = null; canvas.classList.remove('is-panning', 'is-dragging'); if (modified) { setTool('select'); renderInspector(); changed(); } }
  canvas.addEventListener('pointerup', finishGesture); canvas.addEventListener('pointercancel', finishGesture); canvas.addEventListener('lostpointercapture', finishGesture);
  canvas.addEventListener('dblclick', event => { const textEl = event.target.closest('[data-edit], .text-node, .comment-node'); if (textEl && tool === 'select') { event.preventDefault(); editElement(textEl); } });
  function editElement(el) {
    if (!el || el.isContentEditable) return;
    const old = el.textContent; el.contentEditable = 'true'; el.focus();
    const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    function finish(cancel = false) {
      el.contentEditable = 'false'; el.removeEventListener('blur', onBlur); el.removeEventListener('keydown', onKey); el.removeEventListener('paste', onPaste);
      const value = el.textContent.trim().slice(0, 500); if (cancel || !value) { el.textContent = old; return; }
      if (value !== old) { checkpoint(); const board = state.boards.find(b => b.id === el.closest('.artboard')?.dataset.id); if (board && el.dataset.edit) board.edits[el.dataset.edit] = value; else { const node = state.nodes.find(n => n.id === el.dataset.id); if (node) node.text = value; } el.textContent = value; changed(); renderInspector(); }
      window.getSelection()?.removeAllRanges();
    }
    const onBlur = () => finish(); const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(true); el.blur(); } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(); el.blur(); } };
    const onPaste = e => { e.preventDefault(); const plain = e.clipboardData?.getData('text/plain') || ''; document.execCommand('insertText', false, plain); };
    el.addEventListener('blur', onBlur); el.addEventListener('keydown', onKey); el.addEventListener('paste', onPaste);
  }

  const resizer = $('#split-resizer'); let resizing = null;
  resizer.addEventListener('pointerdown', event => { if (event.button !== 0) return; resizing = { start: event.clientX, width: $('.conversation-panel').offsetWidth }; resizer.setPointerCapture(event.pointerId); event.preventDefault(); });
  function resizeChat(value) { const width = Math.round(Math.max(280, Math.min(Math.min(520, innerWidth * .5), value))); document.documentElement.style.setProperty('--chat-width', `${width}px`); resizer.setAttribute('aria-valuenow', width); requestAnimationFrame(fit); }
  resizer.addEventListener('pointermove', event => { if (resizing) resizeChat(resizing.width + event.clientX - resizing.start); });
  resizer.addEventListener('pointerup', () => { resizing = null; }); resizer.addEventListener('pointercancel', () => { resizing = null; });
  resizer.addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--chat-width'); requestAnimationFrame(fit); });
  resizer.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); resizeChat($('.conversation-panel').offsetWidth + (e.key === 'ArrowLeft' ? -20 : 20)); } });

  function preview() { if (!state.boards.length) return; previewIndex = Math.max(0, state.boards.findIndex(b => b.id === selected)); renderPreview(); $('#preview-dialog').showModal(); }
  function renderPreview() {
    const b = state.boards[previewIndex]; if (!b) return;
    $('#preview-stage').innerHTML = `<div class="board-surface" style="${surfaceStyle(b)}">${screenContent(b)}</div>`;
    $('#preview-page-name').textContent = `${b.name} · ${previewIndex + 1} / ${state.boards.length}`;
    const scale = Math.min(1, (innerHeight - 210) / b.height, (innerWidth - 70) / b.width);
    const surface = $('.board-surface', $('#preview-stage')); surface.style.zoom = String(Math.max(.3, scale));
  }
  $('#play-toggle').addEventListener('click', () => setPlaying(!playing));
  $('#preview-prev').addEventListener('click', () => { previewIndex = (previewIndex - 1 + state.boards.length) % state.boards.length; renderPreview(); });
  $('#preview-next').addEventListener('click', () => { previewIndex = (previewIndex + 1) % state.boards.length; renderPreview(); });
  $('#preview-stage').addEventListener('click', event => { const target = event.target.closest('[data-preview-page]')?.dataset.previewPage; if (!target) return; const index = state.boards.findIndex(b => b.kind === target); if (index >= 0) { previewIndex = index; renderPreview(); } });
  $('#export-open').addEventListener('click', () => $('#export-dialog').showModal());
  $('#document-title').addEventListener('click', () => { $('#rename-input').value = state.title; $('#rename-dialog').showModal(); $('#rename-input').select(); });
  $('#rename-form').addEventListener('submit', event => { event.preventDefault(); const title = $('#rename-input').value.trim(); if (!title) return; checkpoint(); state.title = title.slice(0, 60); render(); changed(); $('#rename-dialog').close(); });
  $('#shortcut-help').addEventListener('click', () => $('#help-dialog').showModal());
  $$('[data-close-dialog]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); }));
  $$('[data-export]').forEach(button => button.addEventListener('click', () => {
    const type = button.dataset.export;
    const name = state.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
    const contents = type === 'json' ? JSON.stringify(state, null, 2) : exportHTML();
    const blob = new Blob([contents], { type: type === 'json' ? 'application/json;charset=utf-8' : 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${name}.${type}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); $('#export-dialog').close(); toast(`已导出 ${type.toUpperCase()} 文件`);
  }));
  function exportHTML() {
    const defs = $('.svg-defs').outerHTML;
    const styles = $('#screen-styles')?.textContent || '';
    const screens = state.boards.map(b => `<section><h2>${escape(b.name)}</h2><div class="board-surface" style="${surfaceStyle(b)}">${screenContent(b)}</div></section>`).join('');
    const nodes = state.nodes.length ? `<aside class="export-extras"><h2>参考与批注</h2>${state.nodes.map(n => n.kind === 'image' ? `<figure><img src="${escape(n.src)}" alt="${escape(n.name || '参考图片')}"></figure>` : n.kind === 'rect' ? `<div style="width:${n.width}px;height:${n.height}px;border-radius:${n.radius}px;background:${n.color}"></div>` : `<p style="color:${validColor(n.color) ? n.color : '#eee'};font-size:${n.fontSize}px;white-space:pre-wrap">${escape(n.text)}</p>`).join('')}</aside>` : '';
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(state.title)}</title><style>*{box-sizing:border-box}body{margin:0;padding:40px;background:#181818;color:#ddd;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif}header{margin-bottom:35px}header h1{font-size:22px;font-weight:500}header p,section h2{font-size:12px;color:#aaa}main{display:flex;gap:35px;align-items:flex-start;flex-wrap:wrap}.board-surface{position:relative;overflow:hidden;color:#2b352e;background:#f5f3ed;color-scheme:light;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif}h3,h4,p{margin:0}svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle;flex-shrink:0}.svg-defs{width:0;height:0;position:absolute;overflow:hidden}section h2{margin-bottom:14px;font-weight:400}.export-extras{margin-top:35px}.export-extras img{max-width:500px;max-height:400px}${styles}</style>${defs}<header><h1>${escape(state.title)}</h1><p>Mova Design · 本地前端设计展示</p></header><main>${screens}</main>${nodes}</html>`;
  }

  ['#attach-image', '#rail-assets'].forEach(s => $(s).addEventListener('click', () => $('#image-input').click()));
  $('#image-input').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { toast('请选择 PNG、JPEG、WebP 或 GIF 图片'); return; }
    if (file.size > 2 * 1024 * 1024) { toast('本地原型支持 2 MB 以内的参考图片'); return; }
    if (state.nodes.length >= 100) { toast('原型最多支持 100 个额外对象'); return; }
    const reader = new FileReader(); reader.onload = () => { const img = new Image(); img.onload = () => { checkpoint(); const width = Math.min(360, img.width), height = width * img.height / img.width; const n = { id: newId('image'), kind: 'image', name: file.name, src: reader.result, width, height: Math.min(2000, height), x: -width - 45, y: 170, radius: 3 }; state.nodes.push(n); selected = n.id; render(); fit(); changed(); toast('参考图片已加入画布，可拖动或在属性中调整'); }; img.onerror = () => toast('图片无法读取，请换一张试试'); img.src = reader.result; }; reader.onerror = () => toast('图片读取失败'); reader.readAsDataURL(file);
  });

  function addChat(role, message) { const div = document.createElement('div'); div.className = role === 'user' ? 'user-message' : 'assistant-message'; div.style.marginTop = '22px'; if (role === 'assistant') div.innerHTML = `<div class="assistant-label"><span class="assistant-mark">${icon('spark')}</span><span>Mova</span><span style="font-size:9px;font-weight:400;color:#999">本地演示</span></div>`; const p = document.createElement('p'); p.textContent = message; div.append(p); $('#conversation-scroll').append(div); $('#conversation-scroll').scrollTop = $('#conversation-scroll').scrollHeight; }
  $('#prompt-form').addEventListener('submit', event => {
    event.preventDefault(); const prompt = $('#prompt').value.trim(); if (!prompt) { $('#prompt').focus(); return; }
    addChat('user', prompt); $('#prompt').value = '';
    const color = prompt.match(/#[a-f\d]{6}/i)?.[0] || (/蓝/.test(prompt) ? '#526b85' : /橙|陶土|暖色/.test(prompt) ? '#9a694b' : /绿/.test(prompt) ? '#365a4d' : null);
    const heading = prompt.match(/(?:标题|文案)(?:改为|改成|换成|设为|：|:)\s*[“"「]?(.+?)[”"」]?$/)?.[1];
    if (color) { checkpoint(); const targets = /全部|主题/.test(prompt) || !selectedBoard() ? state.boards : [selectedBoard()]; targets.forEach(b => { b.accent = color; }); render(); changed(); addChat('assistant', `已在本地示例中更新${targets.length === 1 ? '选中画板' : '全部画板'}的主题色，布局和内容继续保留。`); }
    else if (/新增|添加|加一个|再加/.test(prompt) && /页|画板/.test(prompt)) { addBoard(); addChat('assistant', '已从现有视觉语言新增一张可编辑的示例画板。可以双击标题修改内容，或打开属性调整尺寸。'); }
    else if (heading && selectedBoard()) { checkpoint(); selectedBoard().edits.heading = heading; render(); changed(); addChat('assistant', '已修改选中画板的标题。你也可以双击文字继续编辑。'); }
    else addChat('assistant', '这是本地界面原型，尚未连接 AI。你可以试试“把主题色改为蓝色”“新增一个页面”，或选中画板输入“标题改为你的下一站”。也支持双击文字直接编辑。');
  });
  $('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#prompt-form').requestSubmit(); } });
  $$('[data-prompt]').forEach(b => b.addEventListener('click', () => { $('#prompt').value = b.dataset.prompt; $('#prompt-form').requestSubmit(); }));

  document.addEventListener('keydown', event => {
    const editing = event.target.closest('input,textarea,select,[contenteditable=true]');
    if (editing || $('dialog[open]')) return;
    if(playing){if(event.key==='Escape')setPlaying(false);return;}
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === ' ' && !event.repeat) { event.preventDefault(); space = true; canvas.classList.add('is-panning'); return; }
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); if (selectedBoard()) addBoard(true); return; }
    if (event.shiftKey && (event.code === 'Digit1' || event.key === '!')) { event.preventDefault(); fit(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { if (event.target.closest('button,a')) return; event.preventDefault(); removeSelected(); return; }
    if (event.key === 'Escape') { select(null); inspectNext = false; $('#canvas-inspect').setAttribute('aria-pressed', 'false'); layersMorph.close(); inspectorMorph.close(); return; }
    if (mod || event.altKey) return;
    const shortcuts = { v: 'select', h: 'hand', t: 'text', r: 'rect', f: 'frame', c: 'comment' }; if (shortcuts[event.key.toLowerCase()]) { event.preventDefault(); setTool(shortcuts[event.key.toLowerCase()]); }
    if (event.key === '+' || event.key === '=') zoom(viewport.zoom + .1); if (event.key === '-') zoom(viewport.zoom - .1);
  });
  document.addEventListener('keyup', event => { if (event.key === ' ') { space = false; if (!gesture) canvas.classList.remove('is-panning'); } });
  window.addEventListener('blur', () => { space = false; finishGesture(); });
  new ResizeObserver(() => { if (!fitPending) { fitPending = true; requestAnimationFrame(() => { fitPending = false; fit(); }); } }).observe(canvas);

  $('#inspector-content').addEventListener('click',e=>{const control=e.target.closest('[data-layout],[data-anchor]'),item=selectedBoard()||selectedNode();if(!control||!item)return;checkpoint();if(control.dataset.layout)item.layout=control.dataset.layout;else item.anchor=+control.dataset.anchor;renderInspector();changed();});
  $('#pages-list').addEventListener('click', e=>{const id=e.target.closest('[data-page]')?.dataset.page;if(!id)return;state.activePage=id;selected=null;render();fit();changed();});
  $('#pages-list').addEventListener('dblclick', e=>{const row=e.target.closest('[data-page]');if(!row)return;const pg=pages().find(p=>p.id===row.dataset.page);const input=document.createElement('input');input.value=pg.name;row.replaceChildren(input);input.focus();input.select();const commit=()=>{checkpoint();pg.name=input.value.trim()||pg.name;renderLayers();changed();};input.addEventListener('blur',commit,{once:true});input.addEventListener('keydown',e=>{if(e.key==='Enter')input.blur();});});
  $('#add-page').addEventListener('click',()=>{checkpoint();const page={id:newId('page'),name:`Page ${pages().length+1}`};state.pages.push(page);state.activePage=page.id;selected=null;render();fit();changed();});
  $('#inspector-content').addEventListener('change',e=>{if(e.target.id!=='frame-preset'||e.target.value==='custom')return;const item=selectedBoard();if(!item)return;checkpoint();[item.width,item.height]=e.target.value.split(',').map(Number);render();changed();});
  $('#inspector-content').addEventListener('click',e=>{if(e.target.closest('#op-properties-close')){inspectorMorph.close();return;}const align=e.target.closest('[data-align]'),flip=e.target.closest('[data-flip]'),item=selectedBoard()||selectedNode();if(!item)return;if(align||flip){checkpoint();if(flip)item[flip.dataset.flip==='x'?'flipX':'flipY']=!item[flip.dataset.flip==='x'?'flipX':'flipY'];else{const v=+align.dataset.align;const base=v<3?'x':'y',el=selectedBoard()?boardElement(item.id):nodeElement(item.id),extent=v<3?world.offsetWidth:world.offsetHeight,size=v<3?item.width:item.height,origin=selectedBoard()?(v<3?el.offsetLeft:$('#artboards').offsetTop+el.offsetTop):0;item[base]=Math.round((v%3===0?0:v%3===1?(extent-size)/2:extent-size)-origin);}render();changed();}});
  $$('[data-tool-menu]').forEach(button=>button.addEventListener('click',()=>{const menu=$('#op-tool-menu'),frame=button.dataset.toolMenu==='frames';menu.innerHTML=(frame?['Mobile · 390 × 780','Tablet · 768 × 1024','Desktop · 1200 × 800']:['矩形','图片']).map((name,i)=>`<button data-option="${i}" data-menu-kind="${frame?'frames':'shapes'}">${name}</button>`).join('');menu.hidden=!menu.hidden;}));
  $('#op-tool-menu').addEventListener('click',e=>{const b=e.target.closest('[data-option]');if(!b)return;$('#op-tool-menu').hidden=true;if(b.dataset.menuKind==='frames'){addBoard();const item=selectedBoard();[item.width,item.height]=[[390,780],[768,1024],[1200,800]][+b.dataset.option];render();fit();changed();}else setTool(+b.dataset.option===1?'image':'rect');});
  function setPlaying(value){playing=value;$('#play-toggle').innerHTML=icon(value?'pause':'play');$('#play-toggle').setAttribute('aria-label',value?'暂停并返回画板':'播放');$('#play-toggle').setAttribute('aria-pressed',String(value));$('.design-panel').classList.toggle('is-playing',value);$('#op-play-stage').hidden=!value;if(value){previewIndex=Math.max(0,state.boards.findIndex(b=>b.id===selected));showInlinePreview();}}
  function showInlinePreview(){const b=state.boards[previewIndex];if(!b)return;const r=canvas.getBoundingClientRect(),scale=Math.min(.9,(r.height-60)/b.height,(r.width-70)/b.width);$('#op-play-stage').innerHTML=`<div class="board-surface" style="${surfaceStyle(b)};zoom:${scale}">${screenContent(b)}</div><span class="op-preview-caption">${escape(b.name)} · 点击右上角暂停，返回画板</span>`;}
  $('#op-play-stage').addEventListener('click',e=>{const page=e.target.closest('[data-preview-page]')?.dataset.previewPage;if(!page)return;const i=state.boards.findIndex(b=>b.kind===page);if(i>=0){previewIndex=i;showInlinePreview();}});

  window.addEventListener('beforeunload', persist);
  render(); setTool('select'); requestAnimationFrame(() => { fitPending = false; fit(); persist(); });
})();
