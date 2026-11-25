// Runs in the extension's isolated world, with no access to Mova credentials.
export async function pageOperation(operation, args) {
  const state = globalThis.__movaEdgePage ??= { refs: new Map(), tickets: new Map(), next: 0 };
  // 页面版本号：任何一次动作后 +1。桥接层用它判断「这份观察结果还新不新鲜」，
  // 从而不再对同一步重复执行「执行前全量快照 + 执行后 diff + 表单摘要」。
  state.version ??= 0;
  state.frames ??= new Map();
  state.refs ??= new Map();
  state.tickets ??= new Map();
  state.next ??= 0;
  const result = value => ({ origin: location.origin, ...value });
  const fail = (code, message, suggestion, detail) => {
    throw Object.assign(new Error(message), { code, suggestion, detail });
  };
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const redact = text => text.replace(/\b(?:Bearer\s+[\w.-]+|sk-[\w-]{12,})\b/gi, '[已遮盖]');
  const visible = el => el.checkVisibility({ checkVisibilityCSS: true }) && el.getClientRects().length > 0;
  const controls = 'a[href],button,input:not([type=hidden]),textarea,select,summary,canvas,[role=button],[role=link],[role=textbox],[contenteditable=true]';
  const semantic = 'main,nav,header,footer,aside,section,article,form,h1,h2,h3,h4,h5,h6,ul,ol,li,table,tr,th,td,p,img,[role],[aria-live],iframe';
  // settle/idle 探针：安装一次 MutationObserver 与 rAF 心跳，之后轮询只读计数。
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const settleState = () => {
    state.settle ??= { mutations: 0, lastMutationAt: nowMs(), observer: null };
    const probe = state.settle;
    if (!probe.observer && typeof MutationObserver === 'function' && document.documentElement) {
      probe.observer = new MutationObserver(records => { probe.mutations += records.length; probe.lastMutationAt = nowMs(); });
      probe.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    const running = typeof document.getAnimations === 'function'
      ? document.getAnimations().filter(animation => animation && animation.playState === 'running').length : 0;
    const pendingImages = document.images ? Array.from(document.images).filter(image => image && !image.complete).length : 0;
    return {
      mutations: probe.mutations,
      quietMs: Math.max(0, Math.round(nowMs() - probe.lastMutationAt)),
      animations: running,
      images: pendingImages,
      busy: document.readyState === 'loading',
      readyState: document.readyState,
      fonts: document.fonts && document.fonts.status ? document.fonts.status : 'loaded',
    };
  };
  const frameIndexOf = el => {
    const frames = document.querySelectorAll('iframe,frame');
    return Array.prototype.indexOf.call(frames, el);
  };

  const label = el => {
    const referenced = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => el.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim();
    return redact(normalize(referenced || el.getAttribute('aria-label') || el.labels?.[0]?.innerText ||
      el.innerText || el.placeholder || el.title || el.localName)).slice(0, 140);
  };
  const protectedField = el => el.matches('input[type=password],input[type=file],input[type=hidden]') ||
    /password|one-time-code|cc-|current-password|new-password/i.test(el.getAttribute('autocomplete') || '') ||
    /password|passcode|otp|captcha|token|密码|验证码|银行卡/i.test([label(el), el.name, el.id].join(' '));
  const optionRows = el => Array.from(el.options, (option, index) => ({
    index, value: option.value, label: option.label || option.textContent || '',
    disabled: option.disabled || Boolean(option.closest('optgroup[disabled]')), selected: option.selected,
  }));
  const optionKey = value => String(value ?? '').normalize('NFKC').trim().toLowerCase()
    .replace(/^([+-]?\d+(?:\.\d+)?)\s*(?:[kmgt](?:b(?:ps)?|bit\/s)?|bps)$/i, '$1')
    .replace(/[\s_\-‐‑‒–—−]+/g, '');
  const optionPairs = rows => rows.map(({ label: text, value }) => ({ label: normalize(text), value }));
  function matchOption(el, value) {
    const options = optionRows(el);
    const input = String(value ?? '');
    const key = optionKey(input);
    const available = optionPairs(options.filter(option => !option.disabled));
    for (const matches of [
      options.filter(option => option.value === input),
      options.filter(option => option.label === input),
      key ? options.filter(option => optionKey(option.label) === key) : [],
      key ? options.filter(option => optionKey(option.label).startsWith(key)) : [],
    ]) {
      if (!matches.length) continue;
      const enabled = matches.filter(option => !option.disabled);
      if (enabled.length === 1) return enabled[0];
      if (enabled.length > 1) {
        fail('option-ambiguous', '多个选项符合输入，无法唯一确定。', '从候选中选择精确的 value。', { matches: optionPairs(enabled), options: available });
      }
      break;
    }
    fail('option-unavailable', '指定选项不存在或已禁用。', '从可用选项选择 label 或 value。', { options: available });
  }
  const fieldKey = el => el.id ? `id:${el.id}` : state.ids?.get(el) || `label:${label(el)}`;
  const get = (ref, fileInput = false) => {
    const el = state.refs.get(ref);
    for (let doc = el?.ownerDocument; doc && doc !== document;) {
      const frame = doc.defaultView?.frameElement;
      if (!frame?.isConnected || frame.contentDocument !== doc) fail('iframe-unavailable', '目标 iframe 已变化。', '重新读取页面快照。');
      doc = frame.ownerDocument;
    }
    if (!el?.isConnected) fail('stale-element', '元素引用已失效。', '调用 browser_snapshot 获取新引用。');
    if (el.matches(':disabled,[aria-disabled=true]')) fail('element-disabled', '控件已禁用。', '先满足表单前置条件。');
    if (!fileInput && !visible(el)) fail('element-hidden', '控件不可见。', '等待控件出现或打开其所在区域。');
    return el;
  };
  const read = max => redact((document.querySelector('main,article,[role=main]') || document.body).innerText).slice(0, max);
  const summary = () => {
    const fields = [];
    for (const el of document.querySelectorAll('input,select,textarea,[aria-checked],[aria-selected]')) {
      if (fields.length >= 24) break;
      if (!visible(el) || protectedField(el) || el.matches('input[type=email],input[type=tel]')) continue;
      if (/token|secret|address|phone|email|手机号|邮箱|地址/i.test([label(el), el.name, el.id].join(' '))) continue;
      const value = el.matches('select') ? Array.from(el.selectedOptions, option => normalize(option.textContent)).join(' / ')
        : el.matches('input[type=checkbox],input[type=radio]') ? el.checked
        : el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.value;
      if (value !== undefined) fields.push({ key: fieldKey(el), label: label(el), value: typeof value === 'string' ? redact(value).slice(0, 100) : value });
    }
    const prices = new Set();
    const pattern = /(?:总价|合计|应付|实付|金额|total|amount due|price)?\s*(?:[¥￥$€£]\s*[\d,.]+|[\d,.]+\s*(?:元|CNY|USD|EUR))/gi;
    for (const match of (document.body?.innerText || '').slice(0, 50000).matchAll(pattern)) {
      prices.add(normalize(match[0]));
      if (prices.size >= 12) break;
    }
    const statuses = [...new Set(Array.from(document.querySelectorAll('[role=status],[role=alert],[aria-live]'))
      .filter(visible).map(el => redact(normalize(el.innerText || el.textContent)).slice(0, 140)).filter(Boolean))].slice(0, 12);
    return { fields, prices: [...prices], statuses };
  };
  try {
    if (operation === 'bind') return result({ title: document.title });
    if (operation === 'form_summary') return result(summary());
    if (operation === 'pointer_preview') {
      const hits = args.points.map(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const semanticControl = el?.closest('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=textbox],[contenteditable=true]');
        const control = semanticControl || el;
        const blockedCode = !el ? 'element-hidden'
          : el.matches('iframe,frame') ? 'element-in-iframe'
          : control.matches(':disabled,[aria-disabled=true]') ? 'element-disabled'
          : protectedField(control) ? 'requires-handoff'
          : semanticControl ? 'element-ref-available' : undefined;
        return { label: control ? label(control) : '', blockedCode, ref: semanticControl ? state.ids?.get(semanticControl) : undefined };
      });
      const blockedHit = hits.find(hit => hit.blockedCode);
      return result({ labels: hits.map(hit => hit.label), blocked: Boolean(blockedHit), blockedCode: blockedHit?.blockedCode, ref: blockedHit?.ref });
    }
    if (operation === 'read') return result({ text: read(Math.min(20_000, Math.max(100, Number(args.maxChars) || 12_000))) });
    if (operation === 'download_file') {
      const link = get(args.target);
      if (!link.matches('a[href]')) throw new Error('Choose a download link from the page snapshot.');
      const url = new URL(link.href);
      if (url.origin !== location.origin || !['https:', 'http:', 'blob:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('The download link must belong to the authorized page origin.');
      }
      const limit = 8 * 1024 * 1024;
      const response = await fetch(url, { credentials: 'same-origin', mode: 'same-origin', signal: AbortSignal.timeout(25_000) });
      if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
      const reader = response.body.getReader();
      const bytes = new Uint8Array(limit);
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (size + value.length > limit) throw new Error('Download exceeds 8 MiB.');
          bytes.set(value, size);
          size += value.length;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      let binary = '';
      for (let offset = 0; offset < size; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(size, offset + 8192)));
      }
      return result({ data: btoa(binary) });
    }
    if (operation === 'preview_upload' || operation === 'upload_file') {
      const el = get(args.target, true);
      if (!el.matches('input[type=file]')) throw new Error('Choose a file input from the page snapshot.');
      if (operation === 'preview_upload') {
        const ticket = crypto.randomUUID();
        state.upload = { ticket, el, url: location.href, formAction: el.form?.action, label: label(el), expires: Date.now() + 125_000 };
        return result({ ticket, label: state.upload.label, formAction: state.upload.formAction });
      }
      const upload = state.upload;
      state.upload = undefined;
      if (!upload || upload.ticket !== args.ticket || upload.el !== el || upload.url !== location.href ||
          upload.formAction !== el.form?.action || upload.label !== label(el) || upload.expires < Date.now()) {
        throw new Error('Upload destination changed. Take a fresh snapshot and retry.');
      }
      const realm = el.ownerDocument.defaultView;
      const data = new realm.DataTransfer();
      const bytes = Uint8Array.from(atob(args.data), char => char.charCodeAt(0));
      data.items.add(new realm.File([bytes], args.name));
      el.files = data.files;
      el.dispatchEvent(new realm.Event('input', { bubbles: true }));
      el.dispatchEvent(new realm.Event('change', { bubbles: true }));
      return result({ selected: true });
    }
    if (operation === 'snapshot') {
      const previous = state.snapshot;
      const refs = new Map();
      const entries = [];
      const frameRows = [];
      // frames:"index"（默认）只列 iframe，不展开内容；frames:"all" 才是旧行为。
      const framesMode = args.frame ? 'none'
        : ['none', 'index', 'all'].includes(args.frames) ? args.frames
        : args.scope === 'main' ? 'none' : 'index';
      const framesMap = new Map();
      function frameLine(el, depth) {
        const index = frameIndexOf(el) + 1;
        const id = `f${index}`;
        const href = el.getAttribute('src') || '';
        if (!framesMap.has(id)) framesMap.set(id, el);
        const crossOrigin = !el.contentDocument;
        frameRows.push({ id, url: href, crossOrigin });
        return `${'  '.repeat(Math.min(depth, 8))}- iframe ${id} ${JSON.stringify(href)}${crossOrigin ? ' [cross-origin]' : ''} — 用 browser_snapshot {frame:"${id}"} 读取内容`;
      }
      function walk(root, depth = 0) {
        for (const el of root.children) {
          if (entries.length >= 240) return;
          const fileInput = el.matches('input[type=file]');
          if (el.matches('script,style,template,[inert],[aria-hidden=true]') ||
              (!fileInput && (el.hidden || getComputedStyle(el).display === 'none'))) continue;
          const interactive = el.matches(controls);
          const include = fileInput || ((interactive || el.matches(semantic)) && visible(el));
          if (include) {
            const isFrame = el.localName === 'iframe' || el.localName === 'frame';
            // iframe 只输出一行带编号的索引，不再额外输出一行没有名字的 `- iframe`。
            if (isFrame && !fileInput) {
              if (framesMode === 'index') {
                entries.push(frameLine(el, depth));
              } else if (framesMode === 'all') {
                if (el.contentDocument?.body) walk(el.contentDocument.body, depth + 1);
                else entries.push(`${'  '.repeat(Math.min(depth + 1, 8))}- [frame requires separate access]`);
              }
              walk(el, depth + 1);
              continue;
            }
            const role = fileInput ? 'file-input' : el.getAttribute('role') || el.localName;
            const ref = fileInput || (interactive && !protectedField(el)) ? state.ids?.get(el) || '@e' + ++state.next : '';
            if (ref) {
              (state.ids ??= new WeakMap()).set(el, ref);
              refs.set(ref, el);
            }
            const name = interactive || el.matches('h1,h2,h3,h4,h5,h6,p,th,td,[aria-live]')
              ? label(el) : redact(normalize(el.getAttribute('aria-label') || el.alt || el.title)).slice(0, 140);
            const flags = [
              el.matches(':disabled,[aria-disabled=true]') ? 'disabled' : '',
              el.matches('input[type=checkbox],input[type=radio]') ? (el.checked ? 'checked' : 'unchecked') : '',
              el.hasAttribute('aria-expanded') ? `expanded=${el.getAttribute('aria-expanded')}` : '',
            ].filter(Boolean).join(' ');
            entries.push(`${'  '.repeat(Math.min(depth, 8))}- ${role}${ref ? ' ' + ref : ''}${name ? ' ' + JSON.stringify(name) : ''}${flags ? ' [' + flags + ']' : ''}`);
            if (el.matches('select')) {
              for (const option of optionRows(el)) {
                if (entries.length >= 240) break;
                entries.push(`${'  '.repeat(Math.min(depth + 1, 8))}- option ${JSON.stringify(normalize(option.label))} value=${JSON.stringify(option.value)}${option.selected ? ' [selected]' : ''}${option.disabled ? ' [disabled]' : ''}`);
              }
            }
          }
          walk(el, depth + Number(include));
        }
      }
      const rootRef = typeof args.ref === 'string' && args.ref ? args.ref.replace(/^ref=/, '').replace(/^@/, '@') : '';
      let scoped = null;
      if (args.frame) {
        // 只读某个 iframe：跨域时明确说明，而不是返回空内容。
        const frameEl = state.frames.get(String(args.frame)) || null;
        if (!frameEl) fail('frame-not-found', `找不到 iframe ${args.frame}。`, '先取一次带 frames:"index" 的快照。');
        if (frameEl.isConnected === false) fail('frame-not-found', `iframe ${args.frame} 已从页面移除。`, '重新读取页面快照。');
        if (!frameEl.contentDocument?.body) {
          return result({
            title: document.title, mode: 'full', version: state.version, url: location.href,
            text: `# scope frame:${args.frame}\n- 跨域 iframe（${frameEl.getAttribute('src') || ''}）无法读取内容：需要用户授权该站点，或直接打开该网址`,
            frames: frameRows, crossOrigin: true,
          });
        }
        scoped = frameEl.contentDocument.body;
      } else if (rootRef) {
        const target = state.refs.get(rootRef);
        if (!target) fail('stale-element', `元素引用 ${rootRef} 已失效。`, '重新读取页面快照后再按子树展开。');
        scoped = target;
        entries.push(`- ${target.localName} ${rootRef} ${JSON.stringify(label(target)).slice(0, 140)}`);
      }
      const start = scoped || ((args.scope === 'main' && document.querySelector('main,[role=main]')) || document.body || document.documentElement);
      if (scoped) walk(scoped, 1);
      else walk(start);
      state.refs = refs;
      state.snapshot = entries;
      if (!args.frame && !rootRef) state.frames = framesMap;
      const diff = previous && args.mode !== 'full';
      const changes = diff ? [
        ...previous.filter(line => !entries.includes(line)).map(line => '- ' + line),
        ...entries.filter(line => !previous.includes(line)).map(line => '+ ' + line),
      ] : entries;
      const mode = diff ? 'diff' : 'full';
      const limit = Math.min(24_000, Math.max(100, Number(args.maxChars) || 12_000));
      // 按需取子集时在首行标明范围，模型才知道这份结果不是整页。
      const scopeHeader = args.frame ? `# scope frame:${args.frame}\n` : (rootRef ? `# scope ref:${rootRef}\n` : '');
      return result({
        title: document.title, mode, version: state.version, url: location.href,
        text: (scopeHeader + (changes.join('\n') || '页面控件未变化')).slice(0, limit),
        ...(frameRows.length ? { frames: frameRows } : {}),
        ...(args.frame ? { scope: `frame:${args.frame}` } : {}),
        ...(rootRef ? { scope: `ref:${rootRef}` } : {}),
      });
    }
    if (operation === 'wait') {
      if (args.for === 'text-change') {
        const el = args.selector ? document.querySelector(args.selector) : document.body;
        return result({ matched: Boolean(el && typeof args.text === 'string' && normalize(el.innerText) !== normalize(args.text)) });
      }
      if (args.for === 'text') return result({ matched: Boolean(args.text && read(20_000).includes(args.text)) });
      if (args.for === 'load') return result({ matched: document.readyState === 'complete' });
      if (args.for === 'url') return result({ matched: Boolean(args.url && location.href.includes(args.url)) });
      if (args.for === 'selector') {
        const el = document.querySelector(args.selector);
        const matched = args.state === 'detached' ? !el : args.state === 'hidden' ? !el || !visible(el)
          : args.state === 'attached' ? Boolean(el) : Boolean(el && visible(el));
        return result({ matched });
      }
      if (args.for === 'settle' || args.for === 'idle') {
        const probe = settleState();
        const quiet = Math.max(50, Math.min(5000, Number(args.quietMs) || 150));
        const matched = probe.busy === false && probe.animations === 0 && probe.images === 0
          && probe.quietMs >= quiet && (args.for === 'idle' ? probe.fonts !== 'loading' : true);
        return result({ matched, state: probe });
      }
      if (args.for === 'animation') {
        const root = args.selector ? document.querySelector(args.selector) : document.documentElement;
        if (!root) return result({ matched: false });
        const running = typeof document.getAnimations === 'function'
          ? document.getAnimations().filter(animation => animation && animation.playState === 'running' &&
              (root === document.documentElement || root.contains(animation.effect?.target) || animation.effect?.target === root)).length
          : 0;
        return result({ matched: running === 0, running });
      }
      if (args.for === 'frame') {
        const el = args.selector ? document.querySelector(args.selector)
          : (args.frame ? state.frames.get(String(args.frame)) : null);
        if (!el || el.isConnected === false) return result({ matched: false });
        if (!el.contentDocument) return result({ matched: true, crossOrigin: true });
        return result({ matched: el.contentDocument.readyState === 'complete' && Boolean(el.contentDocument.body), crossOrigin: false });
      }
      throw new Error('请等待一个可检查的页面条件');
    }
    const el = args.action === 'scroll' && !args.target ? document.scrollingElement : get(args.target);
    const realm = el.ownerDocument.defaultView;
    if (protectedField(el)) fail('requires-handoff', '该字段需要你本人填写（银行卡、密码或验证码）。', '调用 browser_handoff 交给用户完成这一步。');
    const isText = el.matches('textarea,input:not([type]),input[type=text],input[type=search],input[type=email],input[type=tel],input[type=url],input[type=number]');
    const isCheck = el.matches('input[type=checkbox],input[type=radio]');
    if (args.submit || !['click', 'fill', 'type', 'select', 'check', 'scroll', 'press'].includes(args.action)) fail('requires-handoff', '该操作需要人工完成。', '调用 browser_handoff。');
    if (['fill', 'type'].includes(args.action) && !isText || args.action === 'check' && !isCheck ||
        args.action === 'select' && !el.matches('select')) fail('element-action-mismatch', '控件类型与操作不匹配。', '查看快照并选择匹配的动作。');
    const anchor = el.closest('a[href]');
    const href = anchor?.href || '';
    const linkTarget = anchor?.target || el.ownerDocument.querySelector('base[target]')?.target || '';
    if (anchor && (anchor.hasAttribute('download') || (linkTarget && linkTarget !== '_self'))) {
      throw new Error('Use browser_open_tab for new tabs. Downloads require manual control.');
    }
    if (href && !/^https?:\/\//.test(href)) throw new Error('不支持此链接协议');
    const option = args.action === 'select' ? matchOption(el, args.value) : null;
    if (operation === 'preview') {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const onScreen = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
      const hit = onScreen && el.ownerDocument === document ? document.elementFromPoint(x, y) : null;
      if (hit && hit !== el && !el.contains(hit) && args.action !== 'scroll') {
        fail('element-obscured', '控件被其他页面元素遮挡。', '检查弹窗、遮罩或滚动位置，再重新探测。');
      }
      if (args.preflight) return result({
        writable: true, label: label(el), onScreen, safeFill: isText && !el.form,
        proposedValue: option ? normalize(option.label) : args.value, resolvedValue: option?.value,
        fieldKey: fieldKey(el), elementId: el.id, summary: summary(),
      });
      state.tickets.clear();
      const ticket = crypto.randomUUID();
      state.tickets.set(ticket, { el, href, label: label(el), url: location.href, action: args.action, value: args.value,
        option: option && { value: option.value, label: option.label }, expires: Date.now() + 125_000 });
      return result({ ticket, safeFill: isText && !el.form, label: label(el),
        proposedValue: option ? normalize(option.label) : args.value, resolvedValue: option?.value,
        nativePoint: (el.localName === 'canvas' || typeof el.click !== 'function') && onScreen && el.ownerDocument === document
          ? { x: x / innerWidth, y: y / innerHeight } : undefined });
    }
    if (operation !== 'act') throw new Error('未知的网页操作');
    const preview = state.tickets.get(args.ticket);
    state.tickets.delete(args.ticket);
    if (!preview || preview.el !== el || preview.url !== location.href || preview.href !== href ||
        preview.action !== args.action || preview.value !== args.value ||
        (option && (preview.option?.value !== option.value || preview.option?.label !== option.label)) ||
        preview.label !== label(el) || preview.expires < Date.now()) fail('preview-changed', '预演后网页状态已变化。', '重新探测并确认，本次动作未执行。');
    // 页面版本号在这里 +1：桥接层据此知道「上一次观察结果已经过期」，不必再无条件重采。
    state.version += 1;
    if (option?.selected && el.selectedOptions.length === 1) return result({ ok: true, noOp: true, selected: optionPairs([option])[0] });
    if (args.action !== 'scroll') el.scrollIntoView({ block: 'nearest' });
    if (args.action === 'click' && el.ownerDocument === document) {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || (hit !== el && !el.contains(hit))) fail('element-obscured', '点击前检测到控件被遮挡或已移出视口。', '重新查看页面；本次点击未执行。');
    }
    if (args.action === 'scroll') {
      const amount = Number(args.value ?? 600);
      if (!Number.isFinite(amount)) throw new Error('Scroll requires a signed pixel distance.');
      const before = el.scrollTop;
      el.scrollBy({ top: Math.max(-2500, Math.min(2500, amount)), behavior: 'instant' });
      return result({ ok: true, scroll: { before, after: el.scrollTop } });
    } else if (args.action === 'press') {
      const key = String(args.value || '');
      if (!/^(Escape|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(key)) {
        throw new Error('This key requires manual control.');
      }
      el.focus();
      for (const type of ['keydown', 'keyup']) el.dispatchEvent(new realm.KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      return result({ ok: true, dispatched: true, trusted: false });
    } else if (args.action === 'click') el.click();
    else if (args.action === 'check') {
      const checked = args.value !== 'false';
      if (el.checked === checked) return result({ ok: true, noOp: true });
      el.click();
      if (el.checked !== checked) throw new Error('未能改变选中状态');
    } else {
      const value = String(args.value ?? '').slice(0, 5000);
      if (option) {
        Object.getOwnPropertyDescriptor(realm.HTMLSelectElement.prototype, 'selectedIndex').set.call(el, option.index);
      } else {
        const prototype = el.matches('textarea') ? realm.HTMLTextAreaElement.prototype : realm.HTMLInputElement.prototype;
        const proposed = args.action === 'type' ? el.value + value : value;
        if (el.value === proposed) return result({ ok: true, noOp: true });
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, proposed);
      }
      el.dispatchEvent(new realm.Event('input', { bubbles: true }));
      el.dispatchEvent(new realm.Event('change', { bubbles: true }));
    }
    return result({ ok: true, ...(option ? { selected: optionPairs([option])[0] } : {}), message: '动作已发送，请重新读取页面确认结果' });
  } catch (error) {
    return result({ error: { code: error.code || 'page-operation-failed', message: error.message, suggestion: error.suggestion, detail: error.detail } });
  }
}
