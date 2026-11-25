/**
 * 负责：验证 Bot 自研小程序完整生命周期（Manifest 校验、对话式孵化产生 mini_app_card（<=3 个快捷入口）、
 *   版本号迭代升级严格保留用户数据、独立存储 KV/JSON/CSV 导出、跨 Bot sharedWith 权限拦截与放行、
 *   异常捕获与创建 Bot 自动修复自愈、以及沙箱 HTML CSP/window.mova SDK 组装与 RPC）。
 * 不负责：Electron preload 窗口或真实 Browser iframe 渲染。
 * 被谁调用：`node --test` 与 `scripts/accept.mjs`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRuntime } from '../electron/bots/runtime.mjs';

test('MiniAppService: validate, incubate card (<=3 routes), data-preserving upgrade, JSON/CSV export', async () => {
  const rt = createBotRuntime({ initialSeed: true });

  // Manifest 校验
  assert.equal(rt.miniAppService.validateManifest({ appId: 'a1', name: 'Bad' }).valid, false);
  assert.equal(
    rt.miniAppService.validateManifest({ appId: 'a1', name: 'GoodApp', createdByBotId: 'planner', version: '1.0.0' }).valid,
    true,
  );

  // 孵化新小程序并自动发布到会话卡片
  const res = rt.miniAppService.incubateMiniApp({
    botId: 'planner',
    conversationId: 'group-team',
    spec: {
      name: '旅行开销统计',
      description: '记录旅行中的餐饮、交通与住宿费用',
      routes: [
        { id: 'overview', title: '总览' },
        { id: 'expenses', title: '记账明细' },
        { id: 'split', title: '分账' },
        { id: 'extra', title: '更多统计' },
      ],
      sharedWith: ['mova'],
    },
    postCardMessage: true,
  });

  assert.equal(res.cardPayload.type, 'mini_app_card');
  assert.ok(res.cardPayload.quickRoutes.length <= 3); // 卡片快捷入口不超过 3 个
  assert.ok(res.message);

  // 写入用户数据
  await rt.miniAppService.handleSdkRpc(res.app.appId, {
    method: 'storage.set',
    params: { key: 'records', value: [{ item: '机票', amount: 1800 }] },
  });

  // 迭代升级 v1.0.0 -> v1.0.1（严格保留 mova_mini_app_storage 数据）
  const upgraded = rt.miniAppService.upgradeMiniApp({
    appId: res.app.appId,
    botId: 'planner',
    patchSpec: { description: '支持多币种折算的版本' },
  });
  assert.equal(upgraded.version, '1.0.1');
  const storedAfterUpgrade = rt.miniAppService.getStorage(res.app.appId, 'records');
  assert.deepEqual(storedAfterUpgrade, [{ item: '机票', amount: 1800 }]);

  // 停用期间禁止写入，重新启用后可导出 JSON 与 CSV
  rt.miniAppService.setDisabled(res.app.appId, true);
  assert.throws(
    () => rt.miniAppService.setStorage(res.app.appId, 'records', []),
    /已停用/,
  );
  rt.miniAppService.setDisabled(res.app.appId, false);

  const jsonExp = rt.miniAppService.exportAppData(res.app.appId, 'json');
  const csvExp = rt.miniAppService.exportAppData(res.app.appId, 'csv');
  assert.match(jsonExp.content, /机票/);
  assert.match(csvExp.content, /^namespace,key,updatedAt,value_json/);

  // 卸载时保留数据备份选项
  const uninstalled = rt.miniAppService.uninstallApp(res.app.appId, { retainDataBackup: true });
  assert.ok(uninstalled.backup);
  assert.equal(rt.miniAppService.getApp(res.app.appId), null);
});

test('MiniAppService: cross-Bot sharedWith isolation, sandbox HTML CSP + window.mova SDK & error boundary self-repair', async () => {
  const rt = createBotRuntime({ initialSeed: true });
  const { app } = rt.miniAppService.incubateMiniApp({
    botId: 'planner',
    conversationId: 'mova',
    spec: {
      name: '私有数据看板',
      sharedWith: ['developer'],
    },
    postCardMessage: false,
  });

  rt.miniAppService.setStorage(app.appId, 'k1', { secretScore: 99 });

  // creator & sharedWith 允许读取，未授权 helper 被拒绝
  const devRead = rt.miniAppService.queryMiniAppDataForBot({ requesterBotId: 'developer', appId: app.appId, key: 'k1' });
  assert.deepEqual(devRead.value, { secretScore: 99 });
  assert.throws(
    () => rt.miniAppService.queryMiniAppDataForBot({ requesterBotId: 'helper', appId: app.appId, key: 'k1' }),
    /无权读取小程序.*not_in_manifest_shared_with/,
  );

  // 生成沙箱 HTML：包含 CSP connect-src 'none' 与 window.mova SDK
  const html = rt.miniAppService.buildSandboxedAppHtml(app, { route: 'overview', theme: 'dark' });
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /window\.mova =/);
  assert.match(html, /mova-miniapp-error/);

  // 上报运行时错误 -> 调用 requestBotRepair 由创建 Bot 自动修复升级版本号并清除 lastError，数据保持完好
  const errored = rt.miniAppService.reportRuntimeError(app.appId, { message: 'TypeError: cannot read property x' });
  assert.ok(errored.lastError);
  const repaired = rt.miniAppService.requestBotRepair(app.appId);
  assert.equal(repaired.lastError, null);
  assert.equal(repaired.version, '1.0.1');
  assert.deepEqual(rt.miniAppService.getStorage(app.appId, 'k1'), { secretScore: 99 });
});

test('MiniAppService & CollabTools: JSON schemas, custom LLM codegen & invalid output fallback', async () => {
  const rt = createBotRuntime({ initialSeed: true });

  // 所有 7 个协作工具均附带标准 JSON Schema parameters
  assert.equal(rt.collabTools.length, 7);
  for (const tool of rt.collabTools) {
    assert.equal(tool.parameters?.type, 'object');
    assert.equal(typeof tool.parameters?.properties, 'object');
    assert.ok(Array.isArray(tool.parameters?.required));
  }

  // 注入自定义代码生成器 -> 剥离 markdown fence 并产出定制 HTML
  rt.miniAppService.setCodeGenerator(async ({ spec }) => `\`\`\`html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"></head><body><h1>定制应用:${spec.name}</h1><script>window.mova?.context?.get();</script></body></html>
\`\`\``);

  const customRes = await rt.miniAppService.incubateMiniAppWithCodegen({
    botId: 'developer',
    conversationId: 'mova',
    name: '定制追踪器',
    summary: '跟踪日常里程碑',
    fields: ['项目', '进度'],
    postCardMessage: false,
  });
  assert.match(customRes.app.entryHtml, /定制应用:定制追踪器/);

  // 代码生成器返回无效文本时安全回退内置模板
  rt.miniAppService.setCodeGenerator(async () => '无法生成代码');
  const fallbackRes = await rt.miniAppService.incubateMiniAppWithCodegen({
    botId: 'developer',
    conversationId: 'mova',
    spec: { name: '兜底应用', description: '回退模板验证' },
    postCardMessage: false,
  });
  assert.match(fallbackRes.app.entryHtml, /window\.mova/);
  assert.match(fallbackRes.app.entryHtml, /兜底应用/);
});
