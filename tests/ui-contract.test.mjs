import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { passphraseChangePayload } from '../src/features/memory/vault-payload.js';

const here = resolve(fileURLToPath(import.meta.url), '..', '..');

test('memory settings describe on-demand search limits, not per-reply injection', async () => {
  const source = await readFile(resolve(here, 'src/features/memory/memory-settings.jsx'), 'utf8');
  assert.match(source, /每次记忆搜索条数上限/);
  assert.match(source, /每次记忆搜索字符上限/);
  assert.match(source, /模型在需要时可主动搜索/);
  assert.doesNotMatch(source, /每次对话最多注入|限制注入的记忆/);
});

/**
 * The settings form used to call `changePassphrase({ oldPassphrase, nextPassphrase })`
 * where `nextPassphrase` was never declared, so every "change master password"
 * call reached the vault with an undefined new passphrase. The payload is now
 * built by a named function, so these tests pin the wire shape end to end.
 */
test('the vault payload maps form state to the names the main process reads', () => {
  const payload = passphraseChangePayload('old pass phrase', 'new pass phrase');
  assert.deepEqual(payload, { oldPassphrase: 'old pass phrase', nextPassphrase: 'new pass phrase' });
  assert.equal(Object.keys(payload).length, 2, 'sends exactly the two documented fields');
});

test('the form builds its payload with that function, never with a bare binding', async () => {
  const source = await readFile(resolve(here, 'src/features/memory/privacy-vault.jsx'), 'utf8');
  assert.match(source, /api\.changePassphrase\(passphraseChangePayload\(oldPassphrase, newPassphrase\)\)/);
  // The shorthand `{ oldPassphrase, nextPassphrase }` is exactly the old bug.
  assert.doesNotMatch(source, /changePassphrase\(\{[^}]*nextPassphrase\s*[,}]/);
});

test('preload forwards the payload and the IPC handler reads both fields', async () => {
  const preload = await readFile(resolve(here, 'electron/preload.cjs'), 'utf8');
  assert.match(preload, /changePassphrase:\s*input\s*=>\s*ipcRenderer\.invoke\('vault:change-passphrase', input\)/);

  const calls = [];
  const handlers = new Map();
  const { installMemoryIpc } = await import('../electron/memory-ipc.cjs');
  installMemoryIpc(() => true, {
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    repository: {
      vault: {
        changePassphrase: (oldPassphrase, nextPassphrase) => {
          calls.push([oldPassphrase, nextPassphrase]);
          return { unlocked: true };
        },
      },
    },
  });
  const respond = handlers.get('vault:change-passphrase');
  assert.ok(respond, 'the channel is installed');
  const result = await respond({}, passphraseChangePayload('old pass phrase', 'new pass phrase'));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['old pass phrase', 'new pass phrase']]);
});

/**
 * The approval bar used to print the before/after blocks side by side. It now
 * computes a real line diff in the renderer; this pins the module's contract so
 * the view and its `+X −Y` summary cannot drift apart.
 */
test('the approval diff module exports computeLineDiff and diffSummary', async () => {
  const diff = await import('../src/features/approvals/diff.js');
  assert.equal(typeof diff.computeLineDiff, 'function');
  assert.equal(typeof diff.diffSummary, 'function');
  assert.deepEqual(diff.computeLineDiff('a\nb\nc', 'a\nB\nc'), [
    { type: 'context', text: 'a', beforeLine: 1, afterLine: 1 },
    { type: 'remove', text: 'b', beforeLine: 2 },
    { type: 'add', text: 'B', afterLine: 2 },
    { type: 'context', text: 'c', beforeLine: 3, afterLine: 3 },
  ]);
  assert.deepEqual(diff.diffSummary(diff.computeLineDiff('a\nb\nc', 'a\nB\nc')), { added: 1, removed: 1 });
  // A missing side is a new or deleted file, never a crash.
  assert.deepEqual(diff.computeLineDiff(null, ''), []);
  assert.deepEqual(diff.diffSummary(diff.computeLineDiff('only', null)), { added: 0, removed: 1 });
});

test('a file above the size limit is not diffed', async () => {
  const { exceedsDiffLimit, DIFF_CHAR_LIMIT } = await import('../src/features/approvals/diff.js');
  assert.equal(DIFF_CHAR_LIMIT, 200_000);
  assert.equal(exceedsDiffLimit('a'.repeat(DIFF_CHAR_LIMIT), 'b'), false, 'exactly at the limit still diffs');
  assert.equal(exceedsDiffLimit('a'.repeat(DIFF_CHAR_LIMIT + 1), 'b'), true);
});

test('the approval bar renders batch previews from preview.files', async () => {
  const source = await readFile(resolve(here, 'src/features/approvals/approval-bar.jsx'), 'utf8');
  assert.match(source, /preview\.files/, 'batch files come from the preview payload');
  assert.match(source, /kind === 'batch'/);
  assert.match(source, /DEFAULT_DIFF_LINES/, 'the 300-line fold is driven by the shared constant');
  assert.match(source, /aria-expanded=\{open\}/, 'each collapsible file header reports its state');
  assert.match(source, /role="group"/);
  assert.match(source, /ACTION_LABELS\[kind\] \?\? '修改文件'/, 'an unknown preview kind falls back to a plain edit');
});

/**
 * "改动历史" is a renderer-only panel over the change-history bridge. These
 * checks pin the parts that must not drift: it reads through `changes.list` /
 * `changes.diff` only, it reuses the approval diff instead of its own, it can
 * be dismissed with Esc, and it hides the reveal action when the preload has no
 * `files.reveal`.
 */
test('the changes panel lists and diffs through the documented bridge calls', async () => {
  const source = await readFile(resolve(here, 'src/features/changes/changes-panel.jsx'), 'utf8');
  assert.match(source, /\.list\(\{\s*rootId\s*\}\)/, 'the list call takes only the root id');
  assert.match(source, /\.diff\(\{\s*rootId,\s*changeId\s*\}\)/, 'the diff call takes the root and the change id');
  assert.match(source, /computeLineDiff/, 'rows come from the shared line diff');
  assert.match(source, /from '\.\.\/approvals\/diff\.js'/, 'the approval diff module is reused, not copied');
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby=\{titleId\}/);
  assert.match(source, /event\.key !== 'Escape'/, 'Esc closes the dialog');
  assert.match(source, /共 \$\{changes\.length\} 条/, 'the header counts the loaded changes');
  assert.match(source, /只显示最近 100 条/, 'the 100-entry cap is stated');
  assert.match(source, /主进程只发送了预览片段/, 'a truncated payload is called out');
});

test('the reveal button is hidden without a files.reveal bridge', async () => {
  const source = await readFile(resolve(here, 'src/features/changes/changes-panel.jsx'), 'utf8');
  assert.match(source, /canReveal = typeof bridge\?\.files\?\.reveal === 'function'/);
  assert.match(source, /\{canReveal && \(/, 'nothing is rendered when the bridge is missing');
  assert.match(source, /\.reveal\(\{\s*rootId,\s*path\s*\}\)/, 'reveal gets the root id and a root-relative path');
});

test('change labels and error codes are translated once, for both views', async () => {
  const format = await import('../src/features/changes/change-format.js');
  assert.deepEqual(
    ['write', 'create', 'replace', 'delete', 'move', 'undo'].map(format.kindLabel),
    ['写入', '新建', '替换', '删除', '移动', '撤销'],
  );
  assert.equal(format.kindLabel('teleport'), '未知操作', 'an unknown kind stays visible');
  assert.equal(format.changeErrorText('history-unreadable'), '改动历史不可读，可能文件已损坏或被占用。');
  assert.match(format.changeErrorText('not-registered'), /文件夹未登记/);
  assert.match(format.changeErrorText('made-up-code'), /未知错误/);
  assert.equal(format.revealErrorText('path-escape'), '这个路径不在项目文件夹内。');
  assert.equal(format.formatBytes(0), '0 B');
  assert.equal(format.formatBytes(2048), '2.0 KB');
  assert.equal(format.formatBytes(undefined), '大小未知');
  assert.equal(format.formatChangeTime('not a date'), '时间未知');
  assert.match(format.formatChangeTime(Date.UTC(2024, 0, 2, 3, 4, 5)), /2024/);

  // The approval bar borrows the reveal text instead of keeping a second copy.
  const bar = await readFile(resolve(here, 'src/features/approvals/approval-bar.jsx'), 'utf8');
  assert.match(bar, /import \{ revealErrorText \} from '\.\.\/changes\/change-format\.js'/);
});

/**
 * The approval bar reveals a file only from an explicit root id and only with a
 * root-relative path. The id is never matched back from the preview's display
 * path, and the `rootName/` prefix the preview does carry is stripped exactly
 * once — a guess here would open the wrong folder or the wrong file.
 */
test('the approval bar reveals only with an explicit rootId and a relative path', async () => {
  const source = await readFile(resolve(here, 'src/features/approvals/approval-bar.jsx'), 'utf8');
  assert.match(source, /function rootIdOf\(request\)/);
  assert.match(source, /request\?\.rootId \?\? request\?\.preview\?\.rootId/, 'the id comes from an explicit field');
  assert.doesNotMatch(source, /rootId[^\n]*preview\.path/, 'the id is never derived from the display path');
  assert.match(source, /function rootRelativePath\(request, shownPath\)/);
  assert.ok(
    source.includes('shownPath.startsWith(`${rootName}/`)'),
    'only the exact root-name prefix is stripped, once',
  );
  assert.ok(source.includes('revealBridge({ rootId, path: relPath })'), 'reveal gets the root id and a relative path');
  assert.match(source, /typeof revealBridge === 'function' && rootId/, 'no root id, no button');
});


