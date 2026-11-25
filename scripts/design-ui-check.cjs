// Visual check for the rebuilt design panel: head, pages/layers, inspector, toolbar, view switching.
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const directory = path.join(__dirname, '../.test-temp/design-ui-' + Date.now());
require('node:fs').mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
process.env.MOVA_AUTOSTART_SERVICES = 'false';
process.env.MOVA_TEST_VAULT = '1';

let started = false;
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('did-finish-load', async () => {
    if (started || win.webContents.getURL() !== 'mova://app/index.html') return;
    started = true;
    win.setContentSize(1480, 940);
    const errors = [];
    win.webContents.on('console-message', event => {
      if (event.level === 'error' || event.level === 3) errors.push(event.message);
    });
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async (code, label) => {
      for (let i = 0; i < 400; i++) {
        if (await js(code)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Timed out: ' + (label || code));
    };
    const shot = async name => {
      await new Promise(resolve => setTimeout(resolve, 350));
      await fs.writeFile(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    const dragCanvas = (fromX, fromY, toX, toY) => js(`(async () => {
      const canvas = document.querySelector('.mova-design-canvas canvas');
      const rect = canvas.getBoundingClientRect();
      const x = rect.x + ${fromX}, y = rect.y + ${fromY};
      const fire = (type, dx, dy, buttons) => canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons,
        clientX: x + dx, clientY: y + dy, view: window,
      }));
      fire('mousedown', 0, 0, 1);
      for (let step = 1; step <= 8; step++) {
        await new Promise(r => setTimeout(r, 25));
        fire('mousemove', ${(toX - fromX)} * step / 8, ${(toY - fromY)} * step / 8, 1);
      }
      fire('mouseup', ${toX - fromX}, ${toY - fromY}, 0);
      await new Promise(r => setTimeout(r, 450));
    })()`);

    const clickCanvas = (atX, atY) => js(`(async () => {
      const canvas = document.querySelector('.mova-design-canvas canvas');
      const rect = canvas.getBoundingClientRect();
      const x = rect.x + ${atX}, y = rect.y + ${atY};
      const fire = type => canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0,
        buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: y, view: window,
      }));
      fire('mousedown'); fire('mouseup');
      await new Promise(r => setTimeout(r, 350));
    })()`);

    try {
      await wait(`!!document.querySelector('.rail-top [aria-label="设计画板"]')`, 'rail button');
      await js(`window.movaDesktop.design.configure({ enabled: true })`);
      await js(`document.querySelector('.rail-top [aria-label="设计画板"]').click()`);
      await wait(`!!document.querySelector('.browser-canvas .mova-design-panel')`, 'panel in canvas slot');
      await wait(`!!document.querySelector('.mova-design-canvas canvas') && !document.querySelector('.mova-design-loading')`, 'canvas ready');
      await new Promise(resolve => setTimeout(resolve, 900));
      await shot('01-canvas');

      // Draw a frame so the inspector has a selection.
      await js(`document.querySelector('.mova-design-tools [aria-label="画板"]').click()`);
      await dragCanvas(70, 90, 400, 520);
      await wait(`!!document.querySelector('.mova-design-properties')`, 'inspector');
      await shot('02-inspector');

      await js(`document.querySelector('.mova-design-head [aria-label="页面与图层"]').click()`);
      await wait(`!document.querySelector('.mova-design-pages').hidden`, 'pages open');
      await shot('03-pages');

      await js(`document.querySelector('.mova-design-pages .dp-layer-viewport .dp-layer-row')?.click()`);
      await shot('04-layers-selected');

      await js(`document.querySelector('.mova-design-head [aria-label="页面与图层"]').click()`);
      await js(`document.querySelectorAll('.dt-flyout-trigger')[1].click()`);
      await wait(`!!document.querySelector('.dt-menu')`, 'flyout');
      await shot('05-toolbar-flyout');

      const state = await js(`(() => {
        const toolbar = document.querySelector('.mova-design-tools');
        const tool = toolbar.querySelector('.dt-tool');
        const panel = document.querySelector('.mova-design-properties');
        return {
          panelInsideCanvas: !!document.querySelector('.browser-canvas .mova-design-panel'),
          view: document.querySelector('.browser-panel').dataset.view,
          chromeToolbarDisplay: getComputedStyle(document.querySelector('.browser-panel > .browser-toolbar')).display,
          headHeight: document.querySelector('.mova-design-head').getBoundingClientRect().height,
          sectionTitles: [...document.querySelectorAll('.dp-section-head h4')].map(n => n.textContent),
          toolCount: toolbar.querySelectorAll('.dt-tool').length,
          barHeight: Math.round(toolbar.getBoundingClientRect().height),
          buttonSize: Math.round(tool.getBoundingClientRect().width),
          iconSize: Math.round(tool.querySelector('svg').getBoundingClientRect().width),
          inspectorWidth: Math.round(panel.getBoundingClientRect().width),
          pagesWidth: Math.round(document.querySelector('.mova-design-pages').getBoundingClientRect().width),
          layerRowHeight: Math.round(document.querySelector('.dp-layer-row')?.getBoundingClientRect().height || 0),
          pageRowHeight: Math.round(document.querySelector('.dp-page-row')?.getBoundingClientRect().height || 0),
        };
      })()`);

      await js(`document.querySelector('.dt-flyout-trigger').click()`);
      await js(`document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))`).catch(() => {});

      // Layer picker: arming it and then clicking a *different* layer must reach the chat composer
      // as a quote. A second frame gives the click a selection change to report, and switching to
      // the move tool first keeps that click a pick instead of another draw.
      await js(`document.querySelector('.mova-design-tools [aria-label="画板"]').click()`);
      await dragCanvas(520, 90, 640, 200);
      await js(`document.querySelector('.mova-design-tools [aria-label="移动"]').click()`);
      await js(`window.__quotes = []; window.addEventListener('mova:quote-to-chat', event => window.__quotes.push(event.detail));`);
      await js(`document.querySelector('.mova-design-head [aria-label="选取图层并引用到对话"]').click()`);
      const pickingArmed = await js(`document.querySelector('.mova-design-pick').getAttribute('aria-pressed')`);
      await clickCanvas(120, 140);
      const picked = await js(`({ quotes: window.__quotes, stillArmed: document.querySelector('.mova-design-pick').getAttribute('aria-pressed') })`);
      await shot('05c-picked');
      if (pickingArmed !== 'true') throw new Error('选取按钮没有进入选取态：' + pickingArmed);
      if (picked.quotes.length !== 1) throw new Error('点选图层没有产生引用：' + JSON.stringify(picked.quotes));
      const quote = picked.quotes[0];
      if (quote?.source?.kind !== 'element') throw new Error('引用的 source.kind 不是 element：' + JSON.stringify(quote?.source));
      if (!String(quote?.source?.label || '').includes('画板图层')) throw new Error('引用标签不对：' + quote?.source?.label);
      if (!String(quote?.text || '').includes(quote?.source?.rootId)) throw new Error('引用正文里没有图层 id：' + quote?.text);
      if (picked.stillArmed !== 'false') throw new Error('取完一次后选取态没有退出：' + picked.stillArmed);

      // Head layout: the picker sits in the left pill with the other view actions, play keeps its
      // own round button outside the address pill, and there is no close button — closing goes
      // through the chat header's panel toggle.
      const head = await js(`(() => ({
        close: !!document.querySelector('.mova-design-head [aria-label="关闭画板"]'),
        pickInNavGroup: !!document.querySelector('.mova-design-head .browser-nav-group .mova-design-pick'),
        pickInPill: !!document.querySelector('.mova-design-head .browser-address .mova-design-pick'),
        playInAddress: !!document.querySelector('.mova-design-head .browser-address .mova-design-play'),
        playStandalone: !!document.querySelector('.mova-design-head > .mova-design-play'),
        trailingButtons: document.querySelectorAll('.mova-design-head > .browser-icon-button').length,
      }))()`);
      if (head.close) throw new Error('画板顶栏仍有关闭按钮');
      if (!head.pickInNavGroup) throw new Error('选取按钮不在最左侧胶囊里');
      if (head.pickInPill) throw new Error('选取按钮还留在地址药丸里');
      if (head.playInAddress) throw new Error('播放按钮还在地址药丸里');
      if (!head.playStandalone) throw new Error('播放按钮没有独立成圆形按钮');
      if (head.trailingButtons !== 1) throw new Error('药丸外应只剩播放一个圆形按钮：' + head.trailingButtons);
      await shot('05d-head');

      // The dot matrix follows the viewport: zooming widens its step, panning moves its origin.
      const dotsBefore = await js(`(() => { const s = getComputedStyle(document.querySelector('.dp-canvas-dots')); return { size: s.backgroundSize, position: s.backgroundPosition }; })()`);
      await js(`(() => {
        const canvas = document.querySelector('.mova-design-canvas canvas');
        const rect = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
      })()`);
      await new Promise(resolve => setTimeout(resolve, 500));
      const dotsAfterZoom = await js(`(() => { const s = getComputedStyle(document.querySelector('.dp-canvas-dots')); const c = document.querySelector('.mova-design-canvas canvas'); return { size: s.backgroundSize, position: s.backgroundPosition, canvas: { w: c.width, h: c.height } }; })()`);
      await shot('05b-zoomed');

      // A navigation must take the surface back to the browser without a second window.
      const before = await js(`document.querySelector('.browser-panel').dataset.view`);
      await js(`(() => {
        const input = document.querySelector('.browser-url');
        input.value = 'https://example.com';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const afterNavigation = await js(`(() => ({
        view: document.querySelector('.browser-panel').dataset.view,
        canvasHidden: document.querySelector('.browser-canvas').hidden,
        chromeToolbarDisplay: getComputedStyle(document.querySelector('.browser-panel > .browser-toolbar')).display,
        inspectHintHidden: document.querySelector('.browser-inspect-hint').hidden,
        inspectHintText: document.querySelector('.browser-inspect-hint-text').textContent,
      }))()`);
      await shot('06-after-navigation');
      // Opening a URL must not paint the red "选择页面元素" banner over the page.
      if (!afterNavigation.inspectHintHidden) throw new Error('打开网址后仍弹出提示条：' + afterNavigation.inspectHintText);

      // Returning to the canvas must show the same surface again.
      await js(`document.querySelector('.rail-top [aria-label="设计画板"]').click()`);
      await new Promise(resolve => setTimeout(resolve, 900));
      const backToCanvas = await js(`(() => ({
        view: document.querySelector('.browser-panel').dataset.view,
        canvasHidden: document.querySelector('.browser-canvas').hidden,
        designPanels: document.querySelectorAll('.mova-design-panel').length,
        canvasStillReady: document.querySelector('.mova-design-canvas canvas')?.dataset.ready || '',
      }))()`);
      await shot('07-back-to-canvas');

      // Closing is the chat header toggle; a second click (panel closed) asks which view to open.
      await js(`document.querySelector('#chat-browser-toggle').click()`);
      await new Promise(resolve => setTimeout(resolve, 400));
      const closedByToggle = await js(`document.querySelector('.browser-panel').hidden`);
      await js(`document.querySelector('#chat-browser-toggle').click()`);
      await new Promise(resolve => setTimeout(resolve, 300));
      const chooser = await js(`(() => {
        const menu = document.querySelector('.view-chooser');
        return { open: !menu.hidden, views: [...menu.querySelectorAll('[data-view]')].map(b => b.dataset.view) };
      })()`);
      await shot('08-view-chooser');
      if (!closedByToggle) throw new Error('聊天顶栏的面板开关没能关闭侧栏');
      if (!chooser.open) throw new Error('侧栏关闭时点开面板图标没有弹出视图选择');
      if (chooser.views.join(',') !== 'web,canvas,file') throw new Error('视图选择项不对：' + chooser.views.join(','));
      await js(`document.querySelector('.view-chooser [data-view="canvas"]').click()`);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const afterChooser = await js(`(() => ({
        view: document.querySelector('.browser-panel').dataset.view,
        hidden: document.querySelector('.browser-panel').hidden,
        canvasHidden: document.querySelector('.browser-canvas').hidden,
        chooserOpen: !document.querySelector('.view-chooser').hidden,
      }))()`);
      await shot('09-chooser-canvas');
      if (afterChooser.hidden) throw new Error('选了内置画板后侧栏仍关着');
      if (afterChooser.view !== 'canvas' || afterChooser.canvasHidden) throw new Error('选了内置画板却没进画板视图：' + JSON.stringify(afterChooser));
      if (afterChooser.chooserOpen) throw new Error('选完视图后选择弹窗没有收起');

      console.log(JSON.stringify({ ok: true, directory, state, dotsBefore, dotsAfterZoom, picked, head, closedByToggle, chooser, afterChooser, before, afterNavigation, backToCanvas, errors: errors.slice(0, 8) }, null, 1));
      app.quit();
      setTimeout(() => app.exit(0), 800);
    } catch (error) {
      console.error('FAILED', error.stack, errors.slice(0, 12));
      await fs.writeFile(path.join(directory, 'failure.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {});
      app.exit(1);
    }
  });
});
require('../electron/main.cjs');
setTimeout(() => {
  console.error('Design UI check timed out');
  app.exit(1);
}, 120000).unref();
