import { fontManager } from '@open-pencil/core';
import { documentFontStatus, missingGlyphCharacters } from '@open-pencil/core/text';

const CJK_SAMPLE = '中文欢迎回来登录账号继续工作图层标题';

// CSS generic families (and CSS-wide keywords) have no meaning inside CanvasKit: the name is
// stored on the node, then shapes to nothing. They have to be rejected when written, otherwise
// the canvas silently loses the text.
const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit',
  'initial', 'unset', '-apple-system', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
]);

// CanvasKit needs to be told which installed family supplies CJK glyphs. The host loader in
// electron/design-fonts.cjs serves these families (plus their Chinese aliases), so the probe
// only has to cover the plausible Windows installs. Everything else fails over to the bundled
// Inter, which has no Han glyphs at all — that is what made text vanish.
const CJK_CANDIDATES = ['Microsoft YaHei', 'Microsoft YaHei UI', 'SimHei', 'SimSun'];

/** What a rejection means, so a caller can tell "wrong name" from "not installed". */
export class FontFamilyError extends Error {
  constructor(code, message, candidates = []) {
    super(message);
    this.name = 'FontFamilyError';
    this.code = code;
    this.candidates = candidates;
  }
}

// Boot state, read by `fontBootReport()` so `design_read` can explain missing text.
const boot = { ok: false, probe: [], cjkFamily: null, error: null };

// Families proven loadable. Starts empty: an empty catalog makes `assertFontFamily` fail open,
// which is the safe direction while nothing has been enumerated yet.
const catalog = new Set();
const remembered = new Set();
let catalogPromise = null;
let enumerated = false;
// Families the Electron font loader serves; the only complete list available to this process.
const hostFamilies = new Set();
// True once the host has told us the complete set of families it can serve. Only then does a
// missing family mean "cannot render here": the renderer's local-font enumeration comes back
// empty under Electron, and guessing from an empty list rejected families that do work.
let authoritative = false;

function remember(family) {
  if (typeof family !== 'string' || !family.trim()) return;
  const name = family.trim();
  remembered.add(name);
  // A family that just loaded proves it is available, so it belongs in the live catalog; keeping
  // it there stops `assertFontFamily` from rejecting a font the document already renders with.
  catalog.add(name);
}

/** Sync snapshot: a copy, so a caller cannot mutate the cache. May be empty before boot. */
export function availableFontFamilies() {
  return new Set(catalog);
}

/** What the boot probe found, for `design_read` and for diagnosing a blank canvas. */
export function fontBootReport() {
  return {
    ok: boot.ok,
    probe: boot.probe.map(entry => ({ ...entry })),
    cjkFamily: boot.cjkFamily,
    error: boot.error,
  };
}

// Families already registered in CanvasKit can be listed even when the host refuses to enumerate
// its fonts. `provider()` and `FontMgr.countFamilies()/getFamilyName()` are the only public
// accessors for that (verified in @open-pencil/core dist/text/fonts.d.ts and canvaskit-wasm).
function registeredProviderFamilies() {
  const families = [];
  try {
    const provider = fontManager.provider();
    const count = provider?.countFamilies?.() || 0;
    for (let index = 0; index < count; index += 1) families.push(provider.getFamilyName(index));
  } catch {
    // A detached provider throws on use; the catalog is best effort, never fatal.
  }
  return families;
}

/**
 * Fetch the host font list once and cache it. FontManager in this core version has no
 * `listAvailableFontsAsync` / `listAvailableFonts` (checked in dist/text/fonts.d.ts), so
 * `listFamilies()` is the only enumeration — and it comes back empty under Electron, which has no
 * `queryLocalFonts`. The catalog therefore unions everything that is provably renderable: the
 * families the host's font loader serves, the ones already registered in CanvasKit, the verified
 * CJK fallback and every family that actually loaded through this module.
 *
 * `authoritative` is set only from `hostFamilies`, because that list is complete by construction:
 * the loader returns null for anything outside it, so a family outside the union really cannot be
 * painted.
 */
export async function refreshFontCatalog() {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    if (!enumerated) {
      enumerated = true;
      try {
        for (const family of await fontManager.listFamilies()) {
          if (typeof family === 'string' && family.trim()) catalog.add(family.trim());
        }
      } catch (error) {
        // Enumeration is an optimisation, not a requirement: keep the known-good families.
        console.warn('无法枚举系统字体，字体目录回退到已验证的族名：', error?.message || error);
      }
    }
    for (const family of hostFamilies) catalog.add(family);
    for (const family of registeredProviderFamilies()) {
      if (family && family.trim()) catalog.add(family.trim());
    }
    for (const family of fontManager.getCJKFallbackFamilies()) {
      if (family && family.trim()) catalog.add(family.trim());
    }
    for (const entry of boot.probe) if (entry.loaded) catalog.add(entry.family);
    for (const family of remembered) catalog.add(family);
    return availableFontFamilies();
  })().finally(() => { catalogPromise = null; });
  return catalogPromise;
}

/**
 * Ask the host which families its font loader serves. That list is the only complete one, so it is
 * what makes an unknown family a real error instead of a guess. A missing or failing bridge leaves
 * the catalog non-authoritative, and validation then fails open.
 */
async function adoptHostFamilies(bridge) {
  if (typeof bridge?.fontFamilies !== 'function') return;
  try {
    const result = await bridge.fontFamilies();
    const families = result?.ok ? result.value : null;
    if (!Array.isArray(families)) return;
    for (const family of families) {
      if (typeof family === 'string' && family.trim()) hostFamilies.add(family.trim());
    }
    if (hostFamilies.size > 0) authoritative = true;
  } catch (error) {
    console.warn('无法读取主机字体目录，字体名校验改为放行：', error?.message || error);
  }
}

/** Throws `FontFamilyError` for a family that can never render. Returns the trimmed name. */
export function assertFontFamily(family) {
  const name = typeof family === 'string' ? family.trim() : '';
  if (!name) {
    throw new FontFamilyError(
      'missing_font_family',
      '文本节点必须给出 fontFamily，否则无法预加载字体、也渲染不出字形。请传具体字体名，例如 "Microsoft YaHei"（Windows 上必然可用的中文字体）或 "Inter"。',
    );
  }
  const normalized = name.toLowerCase();
  if (GENERIC_FAMILIES.has(normalized)) {
    throw new FontFamilyError(
      'generic_font_family',
      `"${name}" 是 CSS 通用族名，CanvasKit 没有通用族语义：写进文档只会得到空白文本。请改用具体字体名，例如 "Microsoft YaHei"（Windows 上必然可用，且带完整中文字形）。`,
    );
  }
  // A family is only rejected once we know the complete list. The renderer's own enumeration is
  // empty under Electron (no `queryLocalFonts`), so it cannot be used to judge availability.
  if (!authoritative) return name;
  const families = [...catalog];
  if (families.some(family => family.toLowerCase() === normalized)) return name;
  const candidates = families
    .filter(family => {
      const lower = family.toLowerCase();
      return lower.includes(normalized) || normalized.includes(lower);
    })
    .slice(0, 5);
  throw new FontFamilyError(
    'font_not_available',
    candidates.length
      ? `字体 "${name}" 不在本机可用字体目录里，最接近的是：${candidates.join('、')}。请改用已安装的字体名，例如 "Microsoft YaHei"。`
      : `字体 "${name}" 不在本机可用字体目录里（写进文档只会渲染成空白）。请改用目录里的字体名，例如 "Inter"（内置）或 "Microsoft YaHei"（Windows 中文）。`,
    candidates,
  );
}

// FontManager keeps its failed-face cache in the private `unavailableFaces` map and only exposes
// the read-only `unavailableReason()`, so there is no public way to forget a face. The field does
// exist in this core version, so clear it by feature-detecting it rather than assuming a shape;
// when it is not a Map we report "no safe way" and `loadDocumentFont` skips the retry.
function clearNegativeFontCache(family, style) {
  const faces = fontManager.unavailableFaces;
  if (!(faces instanceof Map)) return false;
  faces.delete(`${family}|${style}`);
  return true;
}

async function tryLoadLocalFont(family, style) {
  try {
    const data = await fontManager.loadLocalFont(family, style);
    return data || null;
  } catch (error) {
    console.warn(`加载字体 "${family}" ${style} 失败：`, error?.message || error);
    return null;
  }
}

/** `loadLocalFont` with exactly one retry after clearing the failed-face cache. Never throws. */
export async function loadDocumentFont(family, style = 'Regular') {
  if (typeof family !== 'string' || !family.trim()) return null;
  const name = family.trim();
  const face = typeof style === 'string' && style.trim() ? style.trim() : 'Regular';
  const data = await tryLoadLocalFont(name, face);
  if (data) {
    remember(name);
    return data;
  }
  if (!clearNegativeFontCache(name, face)) return null;
  const retried = await tryLoadLocalFont(name, face);
  if (retried) remember(name);
  return retried;
}

async function probeFamily(canvasKit, family) {
  const data = await loadDocumentFont(family, 'Regular');
  if (!data) return { family, loaded: false, supported: false };
  let face;
  try {
    face = canvasKit.Typeface.MakeFreeTypeFaceFromData(data);
  } catch {
    face = null;
  }
  if (!face) return { family, loaded: true, supported: false };
  const font = new canvasKit.Font(face, 14);
  try {
    const glyphs = Array.from(font.getGlyphIDs(CJK_SAMPLE));
    const supported = glyphs.length === CJK_SAMPLE.length && glyphs.every(id => id !== 0);
    return { family, loaded: true, supported };
  } catch {
    return { family, loaded: true, supported: false };
  } finally {
    font.delete();
    face.delete();
  }
}

export async function initializeDesignFonts(canvasKit, bridge) {
  boot.ok = false;
  boot.probe = [];
  boot.cjkFamily = null;
  boot.error = null;

  fontManager.setFallbackUserAgent(navigator.userAgent);
  const requests = new Map();
  fontManager.setHostFontLoader(async (family, style) => {
    const key = `${family}|${style}`;
    if (!requests.has(key)) requests.set(key, (async () => {
      const result = await bridge.font(family, style);
      if (!result?.ok) throw new Error(result?.error || '读取中文字体失败');
      if (!result.value) { requests.delete(key); return null; }
      return new Uint8Array(result.value).buffer;
    })().catch(error => { requests.delete(key); throw error; }));
    return requests.get(key);
  });

  // The host's list is complete by construction, so it is adopted before anything is probed:
  // from here on a family outside the catalog can be rejected instead of guessed at.
  await adoptHostFamilies(bridge);

  // Register in Skia before attaching any canvas provider. Text nodes and editor labels
  // then share the same CJK fallback, including nodes whose primary family is Inter.
  const candidates = [...new Set([...CJK_CANDIDATES, ...fontManager.getCJKFallbackFamilies()])]
    .filter(family => typeof family === 'string' && family.trim());
  let chosen = null;
  for (const family of candidates) {
    const result = await probeFamily(canvasKit, family);
    boot.probe.push(result);
    if (result.supported) { chosen = family; break; }
  }
  if (!chosen) {
    // The parent refuses to start the panel without a working CJK fallback, so keep throwing —
    // but say precisely which family failed and why, instead of a generic message.
    const details = boot.probe.map(({ family, loaded }) => `${family}（${loaded ? '安装但无中文字形' : '未安装'}）`);
    boot.error = `未能加载可用的中文字体：${details.join('、')}。`
      + '画板需要其中一款提供中文字形，否则中文文本会渲染成空白。'
      + '请安装 Microsoft YaHei（Windows 自带“微软雅黑”）或 SimHei / SimSun 后重新打开画板；'
      + '若已安装仍失败，说明字体文件被裁剪或损坏，请重新安装该字体。';
    throw new Error(boot.error);
  }

  fontManager.setCJKFallbackFamily(chosen);
  boot.cjkFamily = chosen;
  boot.ok = true;
  // Bold is the weight headings use; a host face without a bold file falls back to regular.
  await fontManager.loadLocalFont(chosen, 'Bold');

  // Fire and forget: a slow or failing enumeration must never delay or fail boot. The catalog is
  // rebuilt from known-good families anyway, so it is only a convenience for `assertFontFamily`.
  void refreshFontCatalog().catch(() => {});
}

export async function prepareDesignDocumentFonts(graph) {
  // A catalog failure only weakens validation, so it must never break saving a document.
  await refreshFontCatalog().catch(() => {});
  const faces = fontManager.collectFontKeys(graph, graph.getPages().map(page => page.id));
  // loadDocumentFont retries once and resolves to null, so one bad face cannot reject the batch.
  await Promise.all(faces.map(([family, style]) => loadDocumentFont(family, style)));
}

// Diagnostics are capped so one pathological page cannot blow the IPC payload.
const MAX_FONT_DIAGNOSTICS = 40;

// The renderer's own verdict for a node: 'ready' | 'substituted' | 'pending' | 'exhausted'
// (`canvas/text/index.ts`). FontManager exposes no equivalent report — it only knows
// `isNodeBlocked` — so ask the renderer, and report null instead of inventing a state name when
// the method is missing from a future core version.
function fontReadiness(renderer, node) {
  try {
    return typeof renderer.nodeFontReadiness === 'function' ? renderer.nodeFontReadiness(node) : null;
  } catch {
    return null;
  }
}

// Inspect the renderer's own paragraphs, including editor-owned frame labels.
// Reading Unicode from SceneGraph alone does not prove that a glyph was rendered.
export function designFontReport(editor, rootId) {
  const renderer = editor.renderer;
  if (!renderer?.fontsLoaded || !renderer.fontProvider) return { ready: false, summary: 'renderer-not-ready', issues: [] };
  const root = editor.graph.getNode(rootId);
  if (!root) return { ready: true, summary: 'ok', cjkFamilies: fontManager.getCJKFallbackFamilies(), checked: 0, truncated: false, issues: [] };
  const nodes = [root, ...editor.graph.flattenTree(rootId).map(entry => entry.node)];
  const uses = nodes.flatMap(node => [
    ...(node.type === 'TEXT' && node.text ? [{ node, kind: 'text', text: node.text }] : []),
    ...(['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(node.type) && node.name ? [{ node, kind: 'label', text: node.name }] : []),
  ]).filter(use => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(use.text));
  const issues = [];
  for (const { node, kind, text } of uses.slice(0, 200)) {
    let missing;
    if (kind === 'label') {
      missing = renderer.labelParagraphCache.use(renderer.ck, renderer.fontProvider, text, 12, 100000,
        renderer.ck.Color4f(1, 1, 1, 1), fontManager.generation(),
        ({ paragraph }) => missingGlyphCharacters(text, paragraph.getShapedLines()), node.type === 'SECTION' ? 600 : 400);
    } else {
      const paragraph = renderer.buildParagraph(node);
      try { missing = missingGlyphCharacters(text, paragraph.getShapedLines()); }
      finally { paragraph.delete(); }
    }
    if (missing.length) issues.push({ nodeId: node.id, kind, missing: [...new Set(missing)].join('') });
  }

  // Nodes the renderer skips outright: `canvas/scene.ts` drops exactly these before drawing, so
  // without this list a document full of text can read back as if nothing were wrong.
  const blocked = [];
  let blockedCount = 0;
  for (const node of nodes) {
    if (!fontManager.isNodeBlocked(node.id)) continue;
    blockedCount += 1;
    if (blocked.length >= MAX_FONT_DIAGNOSTICS) continue;
    const readiness = fontReadiness(renderer, node);
    // `nodeFontReadiness` answers 'ready' for every non-text node, which says nothing about why a
    // blocked frame was skipped, so those get the neutral 'blocked' instead of a false 'ready'.
    blocked.push({ nodeId: node.id, name: node.name, type: node.type, reason: node.type === 'TEXT' && readiness ? readiness : 'blocked' });
  }

  // TEXT nodes that do render, but through a face FontManager substituted for the requested one.
  // `documentFontStatus` is a real export of @open-pencil/core/text; if a future version drops it
  // the fields are omitted rather than faked, and the glyph report above still works.
  //
  // Only a *family* change is a real substitution. Core marks a face `substituted` as soon as the
  // exact style is unavailable (`dist/text/font/status.js:41-48`), so the family is very often
  // identical and the entry only says "this weight was synthesised, or the nearest weight was
  // picked" — the renderer still paints the text perfectly. Reporting that as `substituted` reads
  // as "this text is broken, fix it", and it buries the fields that do mean the text is invisible
  // (`issues` for missing glyphs, `blocked`/`blockedCount` for nodes the renderer skips).
  // So the two meanings are split: a different family stays in `substituted`, a same-family
  // weight-only change goes to `styleSubstituted`. Both are capped at MAX_FONT_DIAGNOSTICS.
  let substituted;
  let styleSubstituted;
  try {
    const status = documentFontStatus(editor.graph, [rootId]);
    substituted = [];
    styleSubstituted = [];
    for (const face of status.faces) {
      if (face.status !== 'substituted' || !face.substituteFamily) continue;
      // Compare trimmed and case-insensitive: core copies the requested name when it substitutes
      // within the family, but a host may report a differently-cased face name for it.
      const requestedFamily = typeof face.family === 'string' ? face.family.trim() : '';
      const usedFamily = String(face.substituteFamily).trim();
      const sameFamily = usedFamily.toLowerCase() === requestedFamily.toLowerCase();
      const bucket = sameFamily ? styleSubstituted : substituted;
      for (const nodeId of face.nodeIds) {
        if (bucket.length >= MAX_FONT_DIAGNOSTICS) break;
        const node = editor.graph.getNode(nodeId);
        // Blocked nodes are reported above: for those, nothing was substituted, it was skipped.
        if (!node || node.type !== 'TEXT' || fontManager.isNodeBlocked(nodeId)) continue;
        if (sameFamily) {
          // `DocumentFontFaceStatus` (core dist/text/font/status.d.ts:6-16) exposes the requested
          // `family` and `style` but no style for the face that was actually used, so report the
          // requested style only — `usedStyle` is left off rather than invented.
          bucket.push({ nodeId, name: node.name, family: face.family, requestedStyle: face.style });
        } else {
          bucket.push({ nodeId, name: node.name, requested: face.family, used: face.substituteFamily });
        }
      }
    }
  } catch (error) {
    console.warn('字体替代报告生成失败：', error?.message || error);
    substituted = undefined;
    styleSubstituted = undefined;
  }

  // One line a model can read first: are the glyphs actually painted, and is anything only a
  // weight mismatch? `issues`/`blockedCount` are the only invisible-text signals.
  const painted = issues.length === 0 && (blockedCount ?? 0) === 0;
  const summary = `${painted ? 'ok' : 'text-not-painted'}${styleSubstituted?.length ? '+style-substituted' : ''}`;

  return {
    ready: true,
    summary,
    cjkFamilies: fontManager.getCJKFallbackFamilies(),
    checked: Math.min(uses.length, 200),
    truncated: uses.length > 200,
    issues,
    blocked,
    // Total skipped nodes; `blocked` itself is capped at MAX_FONT_DIAGNOSTICS entries.
    blockedCount,
    ...(substituted === undefined ? {} : { substituted }),
    ...(styleSubstituted?.length ? { styleSubstituted } : {}),
  };
}
