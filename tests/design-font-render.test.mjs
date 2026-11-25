import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEditor, SceneGraph, SkiaRenderer, fontManager, getCanvasKit } from '@open-pencil/core';
import { createDesignFontLoader } from '../electron/design-fonts.cjs';
import { designFontReport, initializeDesignFonts, prepareDesignDocumentFonts } from '../src/features/design/design-fonts.js';

test('Skia renders CJK labels and Inter/YaHei text, including cold document reload', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const ck = await getCanvasKit({ locateFile: file => fileURLToPath(new URL('../node_modules/canvaskit-wasm/bin/' + file, import.meta.url)) });
  fontManager.setOnlineFontProviders({ google: false, fontsource: false, bunny: false, fontshare: false });
  const surface = ck.MakeSurface(1000, 1000), renderer = new SkiaRenderer(ck, surface);
  const graph = new SceneGraph(), editor = createEditor({ graph });
  editor.setCanvasKit(ck, renderer);
  await renderer.loadFonts();
  const frame = graph.createNode('FRAME', graph.getPages()[0].id, { name: 'App 登录页面', width: 500, height: 700 });
  for (const [text, family, weight] of [
    ['欢迎回来', 'Microsoft YaHei', 600],
    ['登录你的账号，继续未完成的工作', 'Microsoft YaHei', 400],
    ['中文与 English 混排', 'Inter', 400],
  ]) graph.createNode('TEXT', frame.id, { name: text, text, fontFamily: family, fontWeight: weight, width: 500, height: 100 });
  const before = designFontReport(editor, frame.id);
  assert.ok(before.issues.some(issue => issue.kind === 'label'), 'Regression fixture must detect missing CJK label glyphs before fallback: ' + JSON.stringify(before));
  const load = createDesignFontLoader();
  await initializeDesignFonts(ck, { font: async (family, style) => ({ ok: true, value: await load(family, style) }) });
  await prepareDesignDocumentFonts(graph);
  const after = designFontReport(editor, frame.id);
  assert.equal(after.checked, 4); assert.deepEqual(after.issues, [], JSON.stringify(after));
  assert.ok(fontManager.isStyleLoaded('Microsoft YaHei', 'SemiBold'));
  // A new renderer/provider must inherit the loaded fallback without rewriting document fonts.
  const next = new SkiaRenderer(ck, ck.MakeSurface(1000, 1000));
  try {
    editor.setCanvasKit(ck, next); await next.loadFonts();
    assert.deepEqual(designFontReport(editor, frame.id).issues, []);
    assert.equal(graph.getChildren(frame.id).at(-1).fontFamily, 'Inter');
  } finally { next.destroy(); renderer.destroy(); }
});
