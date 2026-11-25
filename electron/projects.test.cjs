const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve, parse } = require('node:path');
const vm = require('node:vm');
const { installProjectsIpc } = require('./projects.cjs');

function setup(result, authorize = () => window) {
  const calls = [];
  let handle;
  installProjectsIpc(authorize, {
    ipcMain: { handle(channel, callback) {
      assert.equal(channel, 'projects:pick-folders');
      handle = callback;
    } },
    dialog: { async showOpenDialog(...args) {
      calls.push(args);
      return typeof result === 'function' ? result() : result;
    } },
  });
  return { invoke: event => handle(event), calls };
}
const window = { name: 'authorized window' };

test('opens a parented native multi-directory picker and returns normalized metadata', async () => {
  const a = resolve('项目 A');
  const b = resolve('project-b');
  const fixture = setup({ canceled: false, filePaths: [a, b, a] });
  const folders = await fixture.invoke({});
  assert.equal(fixture.calls[0][0], window);
  assert.deepEqual(fixture.calls[0][1].properties, ['openDirectory', 'multiSelections']);
  assert.deepEqual(folders.map(({ name, path }) => ({ name, path })), [
    { name: '项目 A', path: a }, { name: 'project-b', path: b },
  ]);
  assert.match(folders[0].id, /^project-[a-f0-9]{64}$/);
  assert.notEqual(folders[0].id, folders[1].id);
  assert.deepEqual(await fixture.invoke({}), folders, 'ids are stable across picks');
});

test('cancellation and empty native selections resolve to empty arrays', async () => {
  assert.deepEqual(await setup({ canceled: true, filePaths: [resolve('ignored')] }).invoke({}), []);
  assert.deepEqual(await setup({ canceled: false, filePaths: [] }).invoke({}), []);
});

test('filesystem roots have a nonempty display name', async () => {
  const root = parse(resolve('.')).root;
  const [folder] = await setup({ canceled: false, filePaths: [root] }).invoke({});
  assert.equal(folder.name, root);
  assert.equal(folder.path, root);
});

test('rejects unauthorized senders before opening a native dialog', async () => {
  const fixture = setup(null, () => { throw new Error('IPC requires the Mova app'); });
  await assert.rejects(fixture.invoke({}), /IPC requires the Mova app/);
  assert.equal(fixture.calls.length, 0);
});

test('reauthorizes the sender after the native dialog completes', async () => {
  let authorized = true;
  const fixture = setup(() => {
    authorized = false;
    return { canceled: false, filePaths: [resolve('private-project')] };
  }, () => {
    if (!authorized) throw new Error('IPC requires the Mova app');
    return window;
  });
  await assert.rejects(fixture.invoke({}), /IPC requires the Mova app/);
});

test('rejects relative paths and propagates native dialog failures', async () => {
  for (const folder of ['relative/project', 'https://example.com/folder', null, 'bad\0path']) {
    await assert.rejects(setup({ canceled: false, filePaths: [folder] }).invoke({}), /invalid absolute path/);
  }
  await assert.rejects(setup(() => { throw new Error('dialog failed'); }).invoke({}), /dialog failed/);
});

test('Windows paths deduplicate case and normalize without reading folder contents', { skip: process.platform !== 'win32' }, async () => {
  const fixture = setup({ canceled: false, filePaths: ['C:\\Work\\Mova\\..\\Mova\\', 'c:\\work\\mova'] });
  const folders = await fixture.invoke({});
  assert.equal(folders.length, 1);
  assert.equal(folders[0].path, 'C:\\Work\\Mova');
  assert.equal(folders[0].name, 'Mova');
});

test('preload exposes only a no-argument picker invocation, not raw IPC', async () => {
  let bridge;
  const invocations = [];
  const expected = [{ id: 'project-id', name: 'Mova', path: resolve('.') }];
  vm.runInNewContext(readFileSync(resolve(__dirname, 'preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, value) {
          assert.equal(name, 'movaDesktop');
          bridge = value;
        } },
        ipcRenderer: { invoke(...args) { invocations.push(args); return Promise.resolve(expected); } },
      };
    },
  });
  assert.equal(await bridge.projects.pickFolders('untrusted path'), expected);
  assert.deepEqual(invocations, [['projects:pick-folders']]);
  assert.deepEqual(Object.keys(bridge.projects), ['pickFolders']);
  assert.equal(bridge.ipcRenderer, undefined);
});
