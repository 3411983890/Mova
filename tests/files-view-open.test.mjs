/**
 * 负责：右侧查看器新增的两个入口——`locate()`（原始路径 → 归属的已登记根）与
 *   `openFile()`（用系统默认程序打开），包括越界拒绝与非文件拒绝。
 * 不负责：渲染层怎么发起（open-target.mjs 的测试）、点击行为（open-target.test.mjs）。
 * 被谁调用：npm test / npm run accept。
 *
 * 为什么单独钉住：这两条是「模型给的绝对路径」唯一能落到磁盘上的入口。
 * 归属判定写错一个字符，就等于把任意本地文件交给渲染层打开（渲染层是不受信的）——
 * 所以根外、`..`、目录、以及 shell 报错都必须有明确结论。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesView } from '../electron/files-view.cjs';

const ROOT_ID = 'project-mova';

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mova-files-open-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const opens = [];
  const root = { id: ROOT_ID, path: base, name: 'mova', capabilities: { read: true, write: false, exec: false } };
  const permissions = options.permissions ?? {
    get: async rootId => (rootId === ROOT_ID ? root : null),
    list: async () => ({ version: 1, preset: 'default', roots: options.roots ?? [root] }),
  };
  const shell = {
    openPath: async target => {
      opens.push(target);
      return options.openError ?? '';
    },
  };
  const view = createFilesView({ permissions, shell });
  await mkdir(join(base, 'docs'), { recursive: true });
  await writeFile(join(base, 'docs', 'a.md'), '# a\n');
  return { base, view, opens };
}

test('locate：项目内的绝对路径 → 归属 rootId + 相对路径', async t => {
  const { base, view } = await fixture(t);
  const found = await view.locate({ raw: join(base, 'docs', 'a.md') });
  assert.deepEqual(found, { rootId: ROOT_ID, path: 'docs/a.md', type: 'file' });
});

test('locate：相对路径按根解析；带 #L12 / :12 锚点时把行号带出来', async t => {
  const { view } = await fixture(t);
  assert.deepEqual(await view.locate({ raw: 'docs/a.md' }), { rootId: ROOT_ID, path: 'docs/a.md', type: 'file' });
  assert.deepEqual(await view.locate({ raw: 'docs/a.md#L12' }), { rootId: ROOT_ID, path: 'docs/a.md', line: 12, type: 'file' });
  assert.deepEqual(await view.locate({ raw: 'docs/a.md:7' }), { rootId: ROOT_ID, path: 'docs/a.md', line: 7, type: 'file' });
});

test('locate：根目录本身可以定位（侧栏据此当目录打开）', async t => {
  const { base, view } = await fixture(t);
  assert.deepEqual(await view.locate({ raw: base }), { rootId: ROOT_ID, path: '', type: 'dir' });
});

test('locate：根外路径 / 越界 / 不存在一律 not-found，绝不返回磁盘路径', async t => {
  const { base, view } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'mova-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const raw of [
    join(outside, 'secret.txt'),
    join(base, '..', 'escape.md'),
    join(base, 'docs', 'missing.md'),
    'docs/../a.md',
  ]) {
    await assert.rejects(() => view.locate({ raw }), error => error.code === 'not-found', `应当拒绝：${raw}`);
  }
});

test('locate：没有可读根时给 not-registered（而不是静默成功）', async t => {
  const { base, view } = await fixture(t, { roots: [] });
  await assert.rejects(() => view.locate({ raw: join(base, 'docs', 'a.md') }), error => error.code === 'not-registered');
});

test('openFile：用系统默认程序打开文件（shell.openPath 收到绝对路径）', async t => {
  const { base, view, opens } = await fixture(t);
  const result = await view.openFile({ raw: join(base, 'docs', 'a.md') });
  assert.equal(result.opened, true);
  assert.equal(result.path, 'docs/a.md');
  assert.deepEqual(opens, [join(base, 'docs', 'a.md')]);
});

test('openFile：也接受渲染层已经知道的 { rootId, path }', async t => {
  const { base, view, opens } = await fixture(t);
  const result = await view.openFile({ rootId: ROOT_ID, path: 'docs/a.md' });
  assert.equal(result.rootId, ROOT_ID);
  assert.deepEqual(opens, [join(base, 'docs', 'a.md')]);
});

test('openFile：目录、根外路径都不打开（一个字节都不交给 shell）', async t => {
  const { base, view, opens } = await fixture(t);
  await assert.rejects(() => view.openFile({ raw: join(base, 'docs') }), error => error.code === 'not-a-file');
  const outside = await mkdtemp(join(tmpdir(), 'mova-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(() => view.openFile({ raw: join(outside, 'x.md') }), error => error.code === 'not-found');
  assert.deepEqual(opens, [], '拒绝时不能调用 shell.openPath');
});

test('openFile：shell 报错时转成 open-failed（模型/用户都能看到原因）', async t => {
  const { base, view } = await fixture(t, { openError: 'no association' });
  await assert.rejects(() => view.openFile({ raw: join(base, 'docs', 'a.md') }), error => error.code === 'open-failed');
});

test('openFile：能力位被撤销后打不开（每次调用都重新查 store）', async t => {
  const base = await mkdtemp(join(tmpdir(), 'mova-files-open-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(join(base, 'a.md'), '# a');
  const root = { id: ROOT_ID, path: base, name: 'mova', capabilities: { read: false, write: false, exec: false } };
  const view = createFilesView({
    permissions: {
      get: async () => root,
      list: async () => ({ version: 1, preset: 'default', roots: [root] }),
    },
    shell: { openPath: async () => '' },
  });
  await assert.rejects(() => view.openFile({ raw: join(base, 'a.md') }), error => error.code === 'not-registered');
});
