import { createApp, h, reactive, ref } from 'vue';
import { createEditor, createDefaultEditorState, SceneGraph, fontManager, getCanvasKit, parseColor } from '@open-pencil/core';
import { deserializeInstanceOverrideState, layoutSizingInParent, serializeInstanceOverrideState } from '@open-pencil/scene-graph';
import { gradientPoint } from '@open-pencil/scene-graph/gradient';
import { provideEditor, useCanvas, useCanvasInput, useTextEdit } from '@open-pencil/vue';
import './design-workspace.css';
import {
  availableFontFamilies, assertFontFamily, designFontReport, fontBootReport,
  initializeDesignFonts, loadDocumentFont, prepareDesignDocumentFonts, refreshFontCatalog,
} from './design-fonts.js';
import { createDesignToolkit, DesignToolError } from './design-tools.js';
import { SpecError, createNode, updateNode } from './design-node-spec.js';
import { bundledIconSvg, hasBundledIcon, listBundledIcons } from './design-icons-offline.js';
import { createDesignUI } from './design-panel-ui.js';

const clone = value => structuredClone(value);
const unwrap = result => {
  if (!result?.ok) throw new Error(result?.error || '设计操作失败');
  return result.value;
};
const MAX_DEPTH = 6;
const MAX_OPS = 200;
/** A read result has to fit the IPC payload limit, so a huge page is summarised, not truncated mid-JSON. */
const MAX_REPORTED_NODES = 400;

function freshGraph() {
  const graph = new SceneGraph();
  const page = graph.getPages()[0];
  graph.updateNode(page.id, {
    source: { ...clone(page.source), fig: { ...clone(page.source.fig), rawNodeFields: { ...clone(page.source.fig.rawNodeFields), backgroundColor: parseColor('#181818') } } },
  });
  return graph;
}

/**
 * The design canvas. It renders into a slot the browser panel owns, so the browser,
 * the file viewer and the canvas are one surface with one toolbar.
 */
export function mountDesignWorkspace({ getScope, host }) {
  const bridge = window.movaDesktop?.design;
  const panel = document.createElement('section');
  panel.className = host?.slot ? 'mova-design-panel' : 'mova-design-panel is-standalone';
  panel.hidden = true;
  panel.setAttribute('aria-label', '设计画板');
  (host?.slot || document.querySelector('.content-frame')).append(panel);

  const model = reactive({
    scope: '', revision: 0, documentId: '', open: false, playing: false, version: 0,
    error: '', loading: false, ready: false,
    pagesOpen: false, menu: '', flyout: '', flyoutChoice: {}, expanded: new Set(), renamingPage: '', picking: false,
  });
  let editor, toolkit, canvasKitReady, saving = Promise.resolve(), initializing, applying = false, saveTimer, loaded = false, dirty = false, edits = 0, commands = Promise.resolve();
  const assetURL = file => new URL(`./vendor/open-pencil/${file.split('/').pop()}`, window.location.href).href;

  function snapshot() {
    return {
      // A node's override state holds Maps, and JSON on disk turns those into empty objects.
      // Storing the SDK's serialized form keeps a reloaded document usable: core's own
      // `captureDocumentChange` reads the Map form and throws on a plain object.
      nodes: [...editor.graph.nodes.values()].map(n => ({
        ...clone(n),
        instanceOverrides: serializeInstanceOverrideState(n.instanceOverrides),
      })),
      rootId: editor.graph.rootId,
      pageId: editor.state.currentPageId,
      images: [...editor.graph.images].map(([id, bytes]) => [id, Array.from(bytes)]),
      variables: clone([...editor.graph.variables]),
      variableCollections: clone([...editor.graph.variableCollections]),
      activeMode: [...editor.graph.activeMode],
    };
  }

  async function hydrate(data) {
    if (!data?.nodes?.length) return;
    const graph = new SceneGraph();
    const initial = graph.getPages()[0];
    const root = initial.parentId;
    graph.deleteNode(initial.id);
    const oldRoot = data.rootId || data.nodes.find(n => n.parentId === null)?.id;
    const pending = data.nodes.filter(n => n.id !== oldRoot);
    const mapping = new Map([[oldRoot, root]]);
    for (let round = 0; pending.length && round < 100; round++) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const n = pending[i], pid = mapping.get(n.parentId);
        if (!pid && !graph.getNode(n.parentId)) continue;
        // Accepts either form, so documents saved before this serialization still open.
        const props = {
          ...clone(n),
          childIds: [],
          instanceOverrides: deserializeInstanceOverrideState(n.instanceOverrides),
          ...(n.type === 'TEXT' ? { textPicture: null } : {}),
        };
        graph.createNodeWithId(n.id, n.type, pid || n.parentId, props);
        mapping.set(n.id, n.id);
        pending.splice(i, 1);
      }
    }
    if (pending.length) throw new Error('文档存在无效的图层父级');
    for (const n of data.nodes) {
      const node = graph.getNode(n.id === oldRoot ? root : n.id);
      if (node) node.childIds = (n.childIds || []).filter(id => graph.getNode(id));
    }
    for (const [id, bytes] of data.images || []) graph.images.set(id, new Uint8Array(bytes));
    for (const key of ['variables', 'variableCollections', 'activeMode']) {
      for (const [id, value] of data[key] || []) graph[key].set(id, clone(value));
    }
    await prepareDesignDocumentFonts(graph);
    editor.replaceGraph(graph);
    editor.undo.clear();
    editor.state.currentPageId = graph.getPages().some(p => p.id === data.pageId) ? data.pageId : graph.getPages()[0].id;
    editor.clearSelection();
    editor.requestRender();
  }

  function refresh() {
    model.version++;
    // The dot matrix drawn under the canvas replaces the page colour; keep the clear transparent
    // even after a page switch or a document load restores a stored background.
    if (editor && editor.state.pageColor?.a !== 0) editor.state.pageColor = { r: 0, g: 0, b: 0, a: 0 };
  }

  async function saveNow() {
    if (!bridge || !model.scope || !loaded || applying || !dirty) return;
    const scope = model.scope, data = snapshot(), version = edits;
    const work = saving.then(async () => {
      if (scope !== model.scope) return;
      const result = unwrap(await bridge.save(scope, model.revision, data));
      model.revision = result.revision;
      if (version === edits) dirty = false;
    });
    saving = work.catch(error => { model.error = error.message; });
    return work;
  }

  function changed() {
    refresh();
    if (applying || !loaded) return;
    dirty = true;
    edits++;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveNow().catch(() => {}); }, 150);
  }

  function notice(message) {
    model.error = message;
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => { if (model.error === message) model.error = ''; }, 2600);
  }

  function close() {
    model.playing = false;
    model.pagesOpen = false;
    model.menu = '';
    model.flyout = '';
    stopPicking();
    panel.hidden = true;
    host?.close?.();
  }

  function insertIcon() {
    notice('插入图标尚未接入图标库');
  }

  /**
   * Hand a canvas layer to the chat composer as a quote. The chat already accepts a
   * `mova:quote-to-chat` detail of `{ text, source }`, so a design layer rides the same path a web
   * element does: the text becomes the `[引用 · …]` line in front of the user's question, and the
   * id in `source.rootId` is what the model passes back to design_read.
   */
  function quoteLayer(id) {
    const node = editor?.getNode(id);
    if (!node) return false;
    const page = editor.getNode(editor.state.currentPageId);
    // The chip already renders `source.label`, so the body starts with the facts the model needs
    // (type, id, page) instead of repeating the layer name.
    const lines = [
      `${node.type} 图层 id ${node.id} · 页面 ${page?.name || '—'}`,
      `位置 ${Math.round(node.x)}, ${Math.round(node.y)} · 尺寸 ${Math.round(node.width)}×${Math.round(node.height)}`,
    ];
    const fill = (node.fills || []).find(paint => paint && paint.visible !== false && paint.type === 'SOLID');
    if (fill) lines.push(`填充 ${colorHex(fill.color)}`);
    if (node.cornerRadius) lines.push(`圆角 ${node.cornerRadius}`);
    if (node.rotation) lines.push(`旋转 ${Math.round(node.rotation * 100) / 100}°`);
    if (node.layoutMode && node.layoutMode !== 'NONE') lines.push(`自动布局 ${node.layoutMode}`);
    if (node.type === 'TEXT' && node.text) lines.push(`文本 ${String(node.text).replace(/\s+/g, ' ').slice(0, 200)}`);
    window.dispatchEvent(new CustomEvent('mova:quote-to-chat', {
      detail: {
        text: lines.join('\n'),
        source: { kind: 'element', label: `画板图层 ${node.name || node.type}`, tag: node.type, selector: node.id, rootId: node.id },
      },
    }));
    notice(`已引用图层「${node.name || node.type}」`);
    return true;
  }

  /**
   * Arm the picker: the next canvas selection becomes a chat reference. Clicking empty canvas
   * clears the selection, which must not end the mode, so only a real node stops it.
   */
  let pickWatch = null;
  function stopPicking() {
    pickWatch?.();
    pickWatch = null;
    if (model.picking) model.picking = false;
    panel.classList.remove('is-picking');
  }

  function pickElement() {
    if (!editor) return;
    if (model.picking) {
      stopPicking();
      refresh();
      return;
    }
    model.picking = true;
    panel.classList.add('is-picking');
    pickWatch = editor.onEditorEvent('selection:changed', () => {
      const id = [...editor.state.selectedIds][0];
      if (!id) return;
      stopPicking();
      quoteLayer(id);
      refresh();
    });
    notice('点击画板上的图层，即可引用到输入栏');
    refresh();
  }

  async function initialize() {
    if (initializing) return initializing;
    initializing = (async () => {
      model.loading = true;
      model.ready = false;
      let vueApp, readyTimer, failReady;
      const ready = new Promise((resolve, reject) => {
        failReady = reject;
        readyTimer = setTimeout(() => reject(new Error('画板启动超时，请关闭后重新打开')), 30000);
      });
      const failed = event => {
        if (!model.ready) {
          event.preventDefault();
          failReady(event.reason instanceof Error ? event.reason : new Error('画布启动失败，请关闭后重新打开'));
        }
      };
      window.addEventListener('unhandledrejection', failed);
      let finishReady;
      const surfaceReady = new Promise(resolve => { finishReady = resolve; });
      surfaceReady.then(() => { clearTimeout(readyTimer); });
      try {
        const canvasKit = await getCanvasKit({ locateFile: assetURL });
        canvasKitReady = Promise.resolve(canvasKit);
        fontManager.setBundledFontLocator(assetURL);
        await initializeDesignFonts(canvasKit, bridge);
        const graph = freshGraph();
        const state = reactive(createDefaultEditorState(graph.getPages()[0].id));
        state.theme = 'dark';
        // The canvas clears to nothing so the dot matrix under it stays visible.
        state.pageColor = { r: 0, g: 0, b: 0, a: 0 };
        editor = createEditor({
          graph,
          state,
          getViewportSize: () => {
            const el = panel.querySelector('.mova-design-canvas');
            return { width: el?.clientWidth || 900, height: el?.clientHeight || 700 };
          },
        });
        editor.onEditorEvent('selection:changed', () => {
          model.menu = '';
          refresh();
        });
        editor.onEditorEvent('history:changed', changed);
        for (const event of ['node:created', 'node:updated', 'node:deleted']) editor.onEditorEvent(event, changed);
        // The AI adapter talks to the same document through core's own tool layer, so a tool the
        // SDK already ships never has to be re-implemented here.
        toolkit = createDesignToolkit({ editor, getCanvasKit: () => canvasKitReady });
        const ui = createDesignUI({ editor, model, changed, refresh, notice, close, insertIcon, pickElement });

        const Canvas = {
          setup() {
            const canvas = ref(null);
            const surface = useCanvas(canvas, editor, {
              showRulers: false,
              preserveDrawingBuffer: true,
              onReady: () => {
                if (canvas.value?.dataset.ready !== '1') {
                  failReady(new Error('画布启动失败，请关闭后重新打开'));
                  return;
                }
                model.ready = true;
                model.loading = false;
                editor.zoomToFit();
                finishReady();
              },
            });
            useCanvasInput(canvas, editor, surface.hitTestSectionTitle, surface.hitTestComponentLabel, surface.hitTestFrameTitle, undefined, () => canvas.value?.focus(), () => !applying && !panel.hidden);
            useTextEdit(canvas, editor, { isEnabled: () => !applying && !panel.hidden });
            return () => h('canvas', { ref: canvas, tabindex: 0, 'aria-label': 'OpenPencil 编辑画布' });
          },
        };

        const app = createApp({
          setup() {
            provideEditor(editor);
            return () => {
              model.version;
              const selected = editor.state.selectedIds.size > 0;
              return [
                ui.head(),
                h('div', { class: 'mova-design-body' }, [
                  h('div', { class: 'mova-design-canvas' }, [
                    ui.canvasDots(),
                    h(Canvas),
                    ui.toolbar(),
                    model.error ? h('div', { class: 'mova-design-error', role: 'status', onClick: () => { model.error = ''; } }, model.error) : null,
                  ]),
                  ui.pages(),
                  selected ? h('aside', { class: 'mova-design-properties', 'aria-label': '选中对象属性' }, [ui.inspector()]) : null,
                ]),
                model.loading ? h('div', { class: 'mova-design-loading' }, '正在加载画板…') : null,
              ];
            };
          },
        });
        vueApp = app;
        app.config.errorHandler = error => {
          console.error('[design]', error);
          model.error = error?.message || String(error);
          if (!model.ready) failReady(error instanceof Error ? error : new Error(String(error)));
        };
        app.mount(panel);
        editor.onEditorEvent('render:requested', refresh);
        await Promise.race([surfaceReady, ready]);
      } catch (error) {
        vueApp?.unmount();
        editor = null;
        toolkit = null;
        initializing = null;
        model.loading = false;
        panel.textContent = `设计编辑器加载失败：${error.message}`;
        throw error;
      } finally {
        clearTimeout(readyTimer);
        window.removeEventListener('unhandledrejection', failed);
      }
    })();
    return initializing;
  }

  async function openScope(scope, document) {
    if (!bridge) throw new Error('请使用 Mova 桌面版打开设计画板');
    const config = unwrap(await bridge.settings());
    if (!config.enabled) throw new Error('请在设置 → 集成 → 设计中启用画板');
    panel.hidden = false;
    await initialize();
    if (model.scope !== scope) {
      clearTimeout(saveTimer);
      await saveNow();
      await saving;
    }
    const doc = document || unwrap(await bridge.load(scope));
    if (model.scope !== scope || model.revision !== doc.revision) {
      loaded = false;
      if (doc.snapshot) await hydrate(doc.snapshot);
      else {
        editor.replaceGraph(freshGraph());
        editor.undo.clear();
        editor.state.currentPageId = editor.graph.getPages()[0].id;
        editor.clearSelection();
      }
      model.scope = scope;
      model.documentId = doc.id;
      model.revision = doc.revision;
      loaded = true;
      dirty = false;
      refresh();
      requestAnimationFrame(() => editor.zoomToFit());
    }
    return editor;
  }

  /** One 0..1 channel as a two-digit hex byte; out-of-range input is clamped, never wrapped. */
  function hexByte(value) {
    const unit = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    return Math.round(unit * 255).toString(16).padStart(2, '0');
  }

  /**
   * `#RRGGBB`, plus `#RRGGBBAA` only when the paint is translucent.
   * Only SOLID paints and strokes fold the colour's alpha into `opacity` (design-node-spec.js
   * `paintColor`); effects and gradient stops keep it in the colour itself, so a `#00000066`
   * shadow used to read back as opaque black. Two decimals of alpha, then the byte, so
   * `#00000066` (a = 0.4 → 102 → "66") round-trips exactly.
   */
  function colorHex(color) {
    if (!color) return '#ffffff';
    const rgb = `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
    const alpha = Number.isFinite(color.a) ? color.a : 1;
    const byte = Math.round((Math.round(alpha * 100) / 100) * 255);
    return alpha < 1 && byte < 255 ? `${rgb}${byte.toString(16).padStart(2, '0')}` : rgb;
  }

  // ---- reading ------------------------------------------------------------------------------
  // The model used to be told "the write succeeded" with no way to check. Everything a paint, a
  // stroke, an effect or a typography property can hold is therefore reported back, so a round
  // trip through design_apply can be verified from the tool result alone.

  const DEGREES_PER_RADIAN = 180 / Math.PI;

  /**
   * The inverse of design-node-spec.js's gradient write, which must stay in sync with this:
   * that side turns `angle` degrees into `t = angle*PI/180`,
   * `start = {x:0.5-0.5cos t, y:0.5-0.5sin t}`, `end = {x:0.5+0.5cos t, y:0.5+0.5sin t}` and stores
   * `linearGradientTransform(start, end)`. A linear gradient runs from (0,0.5) to (1,0.5) in
   * gradient space, so projecting those two points back into the layer's unit square with
   * `gradientPoint` recovers the endpoints, and `atan2(end.y - start.y, end.x - start.x)` is the
   * angle again (0° = left → right, growing clockwise because y points down).
   */
  function gradientAngle(transform) {
    if (!transform) return undefined;
    // A singular transform has no inverse; reporting 0° there would be a wrong number, so the
    // field is omitted instead.
    const det = transform.m00 * transform.m11 - transform.m01 * transform.m10;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
    const start = gradientPoint(transform, { x: 0, y: 0.5 });
    const end = gradientPoint(transform, { x: 1, y: 0.5 });
    const degrees = Math.atan2(end.y - start.y, end.x - start.x) * DEGREES_PER_RADIAN;
    if (!Number.isFinite(degrees)) return undefined;
    const rounded = Math.round((((degrees % 360) + 360) % 360) * 1000) / 1000;
    return rounded === 360 ? 0 : rounded;
  }

  function paintsOf(fills) {
    return (fills || [])
      .filter(fill => fill && fill.visible !== false)
      .map(fill => {
        if (fill.type === 'SOLID') return { type: 'SOLID', color: colorHex(fill.color), opacity: fill.opacity ?? 1 };
        if (String(fill.type).startsWith('GRADIENT')) {
          const angle = gradientAngle(fill.gradientTransform);
          return {
            type: fill.type,
            opacity: fill.opacity ?? 1,
            // Reported after the write formula is inverted; without it the model cannot tell 45°
            // from 0° and "verify by re-reading" would pass on a gradient it wrote wrong.
            ...(angle === undefined ? {} : { angle }),
            stops: (fill.gradientStops || []).map(stop => ({ position: stop.position, color: colorHex(stop.color) })),
          };
        }
        if (fill.type === 'IMAGE') return { type: 'IMAGE', imageHash: fill.imageHash, scaleMode: fill.imageScaleMode };
        return { type: String(fill.type) };
      });
  }

  function strokesOf(node) {
    return (node.strokes || [])
      .filter(stroke => stroke && stroke.visible !== false)
      .map(stroke => ({ color: colorHex(stroke.color), weight: stroke.weight ?? node.strokeWeight, align: stroke.align ?? node.strokeAlign }));
  }

  function effectsOf(node) {
    return (node.effects || [])
      .filter(effect => effect && effect.visible !== false)
      .map(effect => ({
        type: effect.type,
        ...(effect.color ? { color: colorHex(effect.color) } : {}),
        ...(effect.offset ? { x: effect.offset.x, y: effect.offset.y } : {}),
        blur: effect.radius,
        ...(effect.spread !== undefined ? { spread: effect.spread } : {}),
      }));
  }

  const SIZING_VALUES = new Set(['FIXED', 'HUG', 'FILL']);

  /**
   * FIXED | HUG | FILL for one axis. A raw `SceneNode` has no `layoutSizingHorizontal` /
   * `layoutSizingVertical` (those are Figma plugin-API names; `types.d.ts` gives `SceneNode`
   * `primaryAxisSizing` / `counterAxisSizing` and `layoutGrow` / `layoutAlignSelf` instead), so the
   * fields are used when a node ever carries them and core's own `layoutSizingInParent` — the rule
   * that maps those real fields onto FIXED|HUG|FILL, fill from the parent and hug from the node's
   * own axis sizing — answers otherwise.
   */
  function sizingOf(node, parent, axis) {
    const direct = axis === 'HORIZONTAL' ? node.layoutSizingHorizontal : node.layoutSizingVertical;
    if (SIZING_VALUES.has(direct)) return direct;
    return layoutSizingInParent(parent, node, axis);
  }

  function layoutOf(node) {
    // `sizing` is reported even for `mode: 'NONE'`: the node still has one, the write side accepts
    // `layout.sizing` on any frame, and the R1 bug ("I set width 300 and read back 94") was the
    // model guessing at it because the read side only spoke for auto-layout frames.
    const parent = node.parentId ? editor.getNode(node.parentId) : undefined;
    const sizing = { horizontal: sizingOf(node, parent, 'HORIZONTAL'), vertical: sizingOf(node, parent, 'VERTICAL') };
    if (!node.layoutMode || node.layoutMode === 'NONE') return { mode: 'NONE', sizing };
    return {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft },
      // The raw field is `primaryAxisAlign` / `counterAxisAlign`; the `…Items` spellings are what
      // the Figma proxy accepts on write, so read whichever the node actually carries.
      align: node.primaryAxisAlign ?? node.primaryAxisAlignItems,
      counterAlign: node.counterAxisAlign ?? node.counterAxisAlignItems,
      sizing,
      grow: node.layoutGrow,
    };
  }

  /** Flat on purpose: the model round-trips these names straight back into design_apply. */
  function tree(id, depth = 3, budget = { left: MAX_REPORTED_NODES }) {
    const n = editor.getNode(id);
    if (!n) return undefined;
    budget.left--;
    const children = depth > 0 && budget.left > 0
      ? editor.getChildren(id).map(child => tree(child.id, depth - 1, budget)).filter(Boolean)
      : undefined;
    const isText = n.type === 'TEXT';
    return {
      id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height,
      rotation: n.rotation || 0, opacity: n.opacity ?? 1, visible: n.visible !== false,
      ...(n.clipsContent ? { clipsContent: true } : {}),
      cornerRadius: n.cornerRadius,
      fills: paintsOf(n.fills),
      ...(n.fill === undefined ? {} : { fill: n.fill }),
      strokes: strokesOf(n),
      effects: effectsOf(n),
      layout: layoutOf(n),
      ...(isText ? {
        text: n.text,
        fontSize: n.fontSize,
        fontFamily: n.fontFamily,
        fontWeight: n.fontWeight,
        lineHeight: n.lineHeight,
        letterSpacing: n.letterSpacing,
        textAlign: n.textAlignHorizontal,
        textAlignVertical: n.textAlignVertical,
        autoResize: n.textAutoResize,
      } : {}),
      ...(children ? { children } : depth > 0 ? { children: [] } : {}),
    };
  }

  // Core's own verdict on every face the page asks for. The per-face node lists are trimmed
  // because the model only needs the reason and a couple of examples to act on.
  const trimFace = face => (face && typeof face === 'object'
    ? { ...face, ...(Array.isArray(face.nodeIds) ? { nodeIds: face.nodeIds.slice(0, 20) } : {}) }
    : face);

  async function fontStatus() {
    try {
      const value = await toolkit.run('get_font_status', {});
      if (!value || typeof value !== 'object') return value;
      return {
        ...value,
        ...(Array.isArray(value.faces) ? { faces: value.faces.slice(0, 40).map(trimFace) } : {}),
        ...(Array.isArray(value.issues) ? { issues: value.issues.slice(0, 40).map(trimFace) } : {}),
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // Core's whole `get_font_status` document report plus the boot probe is ~1.5k tokens, repeated on
  // every read while the document is healthy. It is shipped only when it says something (missing
  // glyphs or blocked nodes) or the caller asked for it; `design_read`'s schema has no `fonts`
  // parameter, so that flag is optional and honoured only if a caller ever sends it.
  const FONT_HINT = '字体状态正常，已省略完整报告；出现缺字时会自动带回';

  async function readResult(input) {
    const rootId = input.nodeId || editor.state.currentPageId;
    if (!editor.getNode(rootId)) throw new SpecError('invalid_value', 'nodeId', '要读取的图层不存在');
    const depth = Math.min(MAX_DEPTH, Math.max(0, Number(input.depth ?? 3) || 0));
    const fonts = designFontReport(editor, rootId);
    // `issues` is the actionable signal and `blocked` is already capped upstream, so the compact
    // block keeps both and only the full status/boot report is conditional.
    const fontDetail = input.fonts === true || (fonts.issues?.length ?? 0) > 0 || (fonts.blockedCount ?? 0) > 0;
    const result = {
      pages: editor.getPages().map(page => ({ id: page.id, name: page.name })),
      currentPageId: editor.state.currentPageId,
      selectedIds: [...editor.state.selectedIds],
      fonts: fontDetail
        ? { ...fonts, status: await fontStatus(), boot: fontBootReport() }
        : { ...fonts, hint: FONT_HINT },
    };
    if (typeof input.query === 'string' && input.query.trim()) {
      const limit = Math.min(200, Math.max(1, Number(input.limit ?? 40) || 40));
      const hits = await toolkit.run('query_nodes', { selector: input.query.trim(), limit });
      if (hits?.error) throw new DesignToolError('tool_failed', hits.error);
      const nodes = [];
      for (const hit of (hits?.nodes || []).slice(0, limit)) {
        const entry = tree(hit.id, Math.min(depth, 2));
        if (entry) nodes.push(entry);
      }
      result.query = { selector: input.query.trim(), count: hits?.count ?? nodes.length, nodes };
    } else {
      result.tree = tree(rootId, depth);
    }
    return result;
  }

  // ---- writing ------------------------------------------------------------------------------

  const fontHooks = {
    async loadFont(family, style) { await loadDocumentFont(family || 'Inter', style || 'Regular'); },
    assertFontFamily(family) { assertFontFamily(family); },
  };

  const emptyChange = change => !change || (
    change.created.length === 0 && change.deleted.length === 0 && change.updated.length === 0
    && change.children.before.length === 0 && change.children.after.length === 0
    && change.variables.length === 0 && change.collections.length === 0
  );

  /**
   * One undo step for the whole batch, built from what the edit actually touched. Core's own
   * `captureDocumentChange` is used rather than a page snapshot, so an undo costs what the edit
   * changed instead of copying the document.
   */
  function recordUndo(change) {
    if (emptyChange(change)) return;
    editor.pushUndoEntry({
      label: 'AI 设计',
      forward: () => { editor.restoreDocumentChange(change, 'after'); editor.requestRender(); },
      inverse: () => { editor.restoreDocumentChange(change, 'before'); editor.requestRender(); },
    });
  }

  function failure(error) {
    const code = error?.code || (error?.name === 'DesignToolError' ? 'tool_failed' : 'failed');
    return { code, ...(error?.field ? { field: error.field } : {}), reason: error?.message || String(error) };
  }

  /** Every operation is applied in its own recorded transaction, so one bad op cannot cost the batch. */
  async function applyOperation(op, index, report) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw new SpecError('invalid_value', 'operations', `第 ${index} 项不是对象`);
    const parentOf = () => {
      const parentId = op.parentId || editor.state.currentPageId;
      if (!editor.getNode(parentId)) throw new SpecError('invalid_value', 'parentId', '父图层不存在');
      return parentId;
    };
    switch (op.action) {
      case 'create': {
        // Validation lives in design-node-spec.js so a spec is checked exactly once, against the
        // same rules whether it arrives from a batch, a child list or a direct call.
        const { created, rootId } = await createNode({ toolkit, spec: op, parentId: parentOf(), hooks: fontHooks });
        report.created.push(...created.map(node => ({ index, ...node })));
        report.applied.push({ index, id: rootId, changed: ['created'] });
        return;
      }
      case 'update': {
        const node = editor.getNode(op.id);
        if (!node || node.id === editor.graph.rootId || node.type === 'CANVAS') throw new SpecError('invalid_value', 'id', '要修改的图层不存在');
        const { changed } = await updateNode({ toolkit, id: op.id, patch: op.props, hooks: fontHooks });
        report.applied.push({ index, id: op.id, changed });
        return;
      }
      case 'delete': {
        const node = editor.getNode(op.id);
        if (!node || node.id === editor.graph.rootId || node.type === 'CANVAS') throw new SpecError('invalid_value', 'id', '只能删除现有设计图层');
        editor.select([op.id]);
        editor.deleteSelected();
        report.applied.push({ index, id: op.id, changed: ['deleted'] });
        return;
      }
      case 'svg': {
        if (typeof op.svg !== 'string' || !op.svg.trim()) throw new SpecError('missing_field', 'svg', 'svg 动作需要 svg 字符串');
        const value = await toolkit.run('import_svg', {
          svg: op.svg,
          ...(op.parentId ? { parent_id: parentOf() } : {}),
          ...(op.name ? { name: op.name } : {}),
          ...(op.color ? { color: op.color } : {}),
          ...(Number.isFinite(op.x) ? { x: op.x } : {}),
          ...(Number.isFinite(op.y) ? { y: op.y } : {}),
        });
        report.created.push({ index, ...value });
        report.applied.push({ index, id: value.id, changed: ['svg'] });
        return;
      }
      case 'icon': {
        const name = op.name || op.icon;
        // Bare names are bundled (`heart`); a `lucide:` prefix is accepted too. Only an unknown
        // name goes to the network, so the bundled set keeps working offline.
        if (typeof name !== 'string' || !name.trim()) throw new SpecError('invalid_value', 'name', '图标名要写成 lucide:heart 这类形式，或直接用内置图标名，例如 heart');
        let value;
        if (hasBundledIcon(name)) {
          const svg = bundledIconSvg(name, { size: Number.isFinite(op.size) ? op.size : 24, color: op.color || '#000000' });
          value = await toolkit.run('import_svg', {
            svg,
            name: String(name).replace(/^lucide:/i, ''),
            ...(op.parentId ? { parent_id: parentOf() } : {}),
          });
        } else {
          if (!name.includes(':')) {
            const available = listBundledIcons();
            throw new SpecError('invalid_value', 'name', `内置图标里没有 "${name}"。内置共 ${available.length} 个，例如：${available.slice(0, 24).join('、')}；其他图标写成 prefix:name（如 mdi:home）走网络图标集，需要联网`);
          }
          value = await toolkit.run('insert_icon', {
            name,
            ...(op.parentId ? { parent_id: parentOf() } : {}),
            ...(Number.isFinite(op.size) ? { size: op.size } : {}),
            ...(op.color ? { color: op.color } : {}),
          });
        }
        if (value?.error) throw new DesignToolError('tool_failed', value.error);
        report.created.push({ index, ...value });
        report.applied.push({ index, id: value.id, changed: ['icon'] });
        return;
      }
      default:
        throw new SpecError('unknown_action', 'action', `未知动作 ${JSON.stringify(op.action)}；允许 create/update/delete/svg/icon。没有 render 动作：应用的内容安全策略禁用 eval，JSX 无法执行，结构请用 create 的嵌套 children 表达`);
    }
  }

  async function applyBatch(input) {
    const operations = input.operations;
    if (!Array.isArray(operations) || operations.length === 0) throw new SpecError('missing_field', 'operations', 'operations 必须是非空数组');
    if (operations.length > MAX_OPS) throw new SpecError('invalid_value', 'operations', `一次最多提交 ${MAX_OPS} 项设计操作`);
    if (input.basedOnRevision !== undefined && Number(input.basedOnRevision) !== model.revision) {
      throw new DesignToolError('revision_conflict', `画板已被更新（当前 ${model.revision}，提交基于 ${input.basedOnRevision}），请重新读取后再修改`);
    }
    const report = { applied: [], created: [], failed: [], warnings: [] };
    const batch = editor.captureDocumentChange();
    try {
      for (const [index, op] of operations.entries()) {
        if (editor.graph.nodes.size >= 5000) {
          report.failed.push({ index, code: 'document_full', reason: '画板图层已达上限（5000），请先删除部分图层' });
          continue;
        }
        const item = editor.captureDocumentChange();
        try {
          await applyOperation(op, index, report);
        } catch (error) {
          try { editor.restoreDocumentChange(item(), 'before'); }
          catch (restoreError) { console.error('[design] 回滚失败', restoreError); }
          report.failed.push({ index, ...failure(error) });
        }
      }
    } finally {
      recordUndo(batch());
    }
    return report;
  }

  async function screenshot(input) {
    // Omitting `ids` lets core export every top-level node on the page; passing the page's own id
    // would export a CANVAS node, whose zero-size bounds make the export fail.
    const ids = Array.isArray(input.ids) && input.ids.length
      ? input.ids
      : input.nodeId ? [input.nodeId] : null;
    const value = await toolkit.run('export_image', {
      ...(ids ? { ids } : {}),
      format: String(input.format || 'PNG').toUpperCase(),
      ...(Number.isFinite(input.scale) ? { scale: Math.min(4, Math.max(0.1, input.scale)) } : {}),
      ...(Number.isFinite(input.maxEdge) ? { maxEdge: Math.min(4096, Math.max(64, input.maxEdge)) } : {}),
    });
    return value;
  }

  async function fontCatalogue(input) {
    await refreshFontCatalog().catch(() => {});
    const family = typeof input.family === 'string' ? input.family.trim().toLowerCase() : '';
    const families = [...availableFontFamilies()].sort((a, b) => a.localeCompare(b));
    const filtered = family ? families.filter(name => name.toLowerCase().includes(family)) : families;
    const report = designFontReport(editor, editor.state.currentPageId);
    return {
      count: filtered.length,
      families: filtered.slice(0, 800),
      truncated: filtered.length > 800,
      cjkFamilies: fontManager.getCJKFallbackFamilies(),
      boot: fontBootReport(),
      status: await fontStatus(),
      issues: report.issues,
    };
  }

  const executeCommand = async request => {
    try {
      clearTimeout(saveTimer);
      await saving;
      await saveNow();
      await openScope(request.scope);
      applying = true;
      panel.classList.add('is-applying');
      const input = request.input || {};
      // The canvas shares the right-hand panel with the browser and the file viewer. `openScope`
      // above already loaded the document and unhid the panel; this is what brings the canvas to
      // the front when the panel is closed or showing something else.
      if (request.operation === 'open') {
        host?.showView?.('canvas');
        const result = {
          ok: true,
          view: 'canvas',
          currentPageId: editor.state.currentPageId,
          pages: editor.getPages().map(page => ({ id: page.id, name: page.name })),
          selectedIds: [...editor.state.selectedIds],
        };
        unwrap(await bridge.respond({ id: request.id, result }));
        return;
      }
      if (request.operation === 'read') {
        unwrap(await bridge.respond({ id: request.id, result: await readResult(input) }));
        return;
      }
      if (request.operation === 'fonts') {
        unwrap(await bridge.respond({ id: request.id, result: await fontCatalogue(input) }));
        return;
      }
      if (request.operation === 'screenshot') {
        unwrap(await bridge.respond({ id: request.id, result: await screenshot(input) }));
        return;
      }
      if (request.operation === 'undo') {
        editor.undoAction();
        refresh();
        const result = unwrap(await bridge.respond({
          id: request.id,
          baseRevision: model.revision,
          snapshot: snapshot(),
          result: { selectedIds: [...editor.state.selectedIds], currentPageId: editor.state.currentPageId },
        }));
        model.revision = result.revision;
        dirty = false;
        return;
      }
      const report = await applyBatch(input);
      await prepareDesignDocumentFonts(editor.graph);
      editor.requestRender();
      if (report.created.length) editor.zoomToFit();
      refresh();
      // Same compact block as `design_read` (R10): confirm the edit did not block any node, but
      // never re-attach core's whole status/boot report to every apply result.
      const fonts = designFontReport(editor, editor.state.currentPageId);
      const result = unwrap(await bridge.respond({
        id: request.id,
        baseRevision: model.revision,
        snapshot: snapshot(),
        result: {
          ok: report.failed.length === 0,
          ...report,
          fonts,
          selectedIds: [...editor.state.selectedIds],
          currentPageId: editor.state.currentPageId,
        },
      }));
      model.revision = result.revision;
      dirty = false;
    } catch (error) {
      // The panel only shows the message; the stack is what makes an SDK-level failure debuggable.
      console.error('[design] 设计操作失败', error?.stack || String(error));
      model.error = error.message;
      await bridge.respond({ id: request.id, error: error.message }).catch(() => {});
    } finally {
      applying = false;
      panel.classList.remove('is-applying');
    }
  };

  const handleCommand = request => {
    const work = commands.then(() => executeCommand(request));
    commands = work.catch(() => {});
    return work;
  };

  const open = () => openScope(getScope()).catch(e => {
    model.error = e.message;
    panel.hidden = false;
    if (!editor) panel.textContent = e.message;
  });

  panel.addEventListener('keydown', event => {
    if (!editor || applying || panel.hidden || event.defaultPrevented || event.isComposing || event.target.closest('input,textarea,[contenteditable="true"]')) return;
    const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
    if (command && key === 'z') event.shiftKey ? editor.redoAction() : editor.undoAction();
    else if (command && key === 'a') editor.select(editor.getChildren(editor.state.currentPageId).map(n => n.id));
    else if (key === 'delete' || key === 'backspace') editor.deleteSelected();
    else if (event.shiftKey && key === '!') editor.zoomToFit();
    else if (key === 'escape') {
      if (model.picking) { stopPicking(); editor.clearSelection(); refresh(); }
      else if (model.menu || model.flyout) { model.menu = ''; model.flyout = ''; refresh(); }
      else if (model.pagesOpen) { model.pagesOpen = false; refresh(); }
      else if (model.playing) { editor.stopPlay(); model.playing = false; }
      else { editor.clearSelection(); editor.setTool('SELECT'); }
    } else if (!command && !event.altKey && { v: 'SELECT', f: 'FRAME', r: 'RECTANGLE', p: 'PEN', t: 'TEXT', h: 'HAND', c: 'COMMENT' }[key]) {
      editor.setTool({ v: 'SELECT', f: 'FRAME', r: 'RECTANGLE', p: 'PEN', t: 'TEXT', h: 'HAND', c: 'COMMENT' }[key]);
    } else return;
    event.preventDefault();
  });

  window.addEventListener('beforeunload', () => {
    clearTimeout(saveTimer);
    void saveNow();
  });

  const rekey = async (from, to) => {
    await commands;
    clearTimeout(saveTimer);
    await saveNow();
    await saving;
    const doc = unwrap(await bridge.rekey(from, to));
    if (model.scope === from && doc.snapshot) {
      model.scope = to;
      model.revision = doc.revision;
      model.documentId = doc.id;
    }
  };

  const syncScope = () => {
    if (!panel.hidden) {
      const work = commands.then(async () => {
        try { await openScope(getScope()); }
        catch { clearTimeout(saveTimer); await saveNow(); panel.hidden = true; }
      });
      commands = work.catch(() => {});
    }
  };

  return { open, handleCommand, rekey, syncScope, close };
}
