/** 云项目权限、版本、桌面工具注册与 API 工具调用的回归。 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { apiProfiles, importGithubTool } from '../electron/services/cloud-projects.mjs';
import { openCloudStore } from '../electron/services/cloud-store.mjs';
import { createCloudRunner } from '../electron/services/cloud-worker.mjs';
import { createSkillRuntimeForTurn } from '../electron/skills/turn-runtime.mjs';

const source = { repository: 'Example/Tools', commit: 'a'.repeat(40) };
const toolManifest = { schemaVersion: 1, kind: 'github_file', name: 'guide', description: 'Read the guide', file: 'notes/guide.md' };

test('GitHub 导入固定路径，项目配置和工具内容在提交时固定', async t => {
  const requests = [];
  const tool = await importGithubTool(source, { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    requests.push(url);
    return new Response(url.endsWith('.json') ? JSON.stringify(toolManifest) : 'first guide');
  } });
  assert.deepEqual(requests, ['mova-tool.json', toolManifest.file].map(path =>
    `https://raw.githubusercontent.com/example/tools/${source.commit}/${path}`));
  await assert.rejects(importGithubTool({ ...source, filePath: '../guide.md', toolName: 'guide' }), { code: 'project_input' });
  await assert.rejects(importGithubTool({ ...source, filePath: 'guide.md', toolName: 'guide' }, {
    fetchImpl: async () => new Response('x'.repeat(33 * 1024)),
  }), { code: 'tool_size' });

  const store = openCloudStore(':memory:');
  t.after(() => store.close());
  const project = store.projects.save('work', 0, { instructions: 'Use the guide', apiProfile: 'team', model: 'first-model' });
  assert.throws(() => store.projects.save('work', 0, { name: 'Stale' }), { code: 'project_conflict' });
  const added = store.projects.linkTool('work', project.revision, tool);
  assert.equal(added.tools[0].content, undefined);
  const input = { id: 'task-one', prompt: 'Read guide', projectId: 'work', projectRevision: added.revision };
  const task = store.tasks.submit(input);
  assert.equal(task.provider, 'api');
  assert.equal(task.model, 'first-model');

  const replacement = await importGithubTool({ ...source, commit: 'b'.repeat(40), filePath: toolManifest.file, toolName: 'guide' }, {
    fetchImpl: async () => new Response('second guide'),
  });
  const linked = store.projects.linkTool('work', added.revision, replacement);
  store.projects.save('work', linked.revision, { model: 'second-model' });
  assert.deepEqual(store.tasks.submit(input), task);
  assert.throws(() => store.tasks.submit({ ...input, id: 'stale' }), { code: 'project_conflict' });
  assert.equal(store.tasks.projectFor(task).tools[0].content, 'first guide');
  const followup = store.tasks.submit({ id: 'task-two', conversationId: task.conversationId, prompt: 'Read again' });
  assert.equal(followup.model, 'second-model');
  assert.equal(store.tasks.projectFor(followup).tools[0].content, 'second guide');
});

test('桌面 MCP 在无本地目录的聊天中遍历主机，写入严格遵循审批', async () => {
  const calls = [];
  const approvals = [];
  let decision = 'deny';
  const host = 'http://127.0.0.1:17642';
  const deps = {
    cloudProjects: async (...args) => {
      calls.push(args);
      return args[0] === 'hosts' ? [{ origin: host, role: 'owner' }, { origin: 'https://client.test', role: 'client' }] : { revision: 1 };
    },
    sender: { id: 1, isDestroyed: () => false, send() {} },
    approvals: { async ask(request) { approvals.push(request); return decision; } },
    projectRoots: [], approvalPreset: 'full', reportMissingCore: false,
    logger: { info() {}, warn() {}, debug() {} },
  };
  const { toolTable } = createSkillRuntimeForTurn(deps);
  const hosts = await toolTable.call('mova_cloud_hosts', {});
  assert.deepEqual(JSON.parse(hosts.content[0].text), [{ origin: host, role: 'owner' }]);
  assert.equal(toolTable.has('mova_cloud_project_save'), true);
  const args = { host, projectId: 'work', revision: 0, name: 'Work', provider: 'api' };
  assert.equal((await toolTable.call('mova_cloud_project_save', args)).isError, true);
  assert.equal(calls.length, 1);
  decision = 'once';
  const result = await toolTable.call('mova_cloud_project_save', args);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(calls[1], ['project-save', host, { projectId: 'work', revision: 0, name: 'Work', provider: 'api' }]);
  assert.equal(approvals.length, 2);
  assert.equal(createSkillRuntimeForTurn({ ...deps, temporary: true }).toolTable.has('mova_cloud_hosts'), false);
});

for (const protocol of ['openai', 'anthropic']) {
  test(`${protocol} 档案返回公开信息，云端任务实际调用导入工具`, async t => {
    const anthropic = protocol === 'anthropic';
    const requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
      const response = requests.length > 1
        ? (anthropic ? { content: [{ type: 'text', text: 'Guide received' }] } : { choices: [{ message: { content: 'Guide received' } }] })
        : (anthropic ? { content: [{ type: 'tool_use', id: 'call-guide', name: 'project_guide', input: {} }] }
          : { choices: [{ message: { content: null, tool_calls: [{ id: 'call-guide', type: 'function', function: { name: 'project_guide', arguments: '{}' } }] } }] });
      res.end(JSON.stringify(response));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.close(); server.closeAllConnections(); });
    const env = {
      MOVA_API_PROFILE_TEAM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      MOVA_API_PROFILE_TEAM_KEY: 'test-only-key', MOVA_API_PROFILE_TEAM_MODEL: 'test-model', MOVA_API_PROFILE_TEAM_PROTOCOL: protocol,
    };
    assert.deepEqual(apiProfiles(env), [{ id: 'team', model: 'test-model', protocol }]);
    const run = createCloudRunner({ env });
    const result = await run({ provider: 'api', prompt: 'Read the guide' }, {
      history: [], signal: AbortSignal.timeout(4000),
      project: { apiProfile: 'team', instructions: 'Follow project format', tools: [
        { name: 'guide', description: 'Read the guide', source, path: toolManifest.file, content: 'The pinned data' },
      ] },
    });
    assert.equal(result, 'Guide received');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, anthropic ? '/v1/messages' : '/v1/chat/completions');
    assert.equal(requests[0].body.model, 'test-model');
    assert.equal(anthropic ? requests[0].headers['x-api-key'] : requests[0].headers.authorization, anthropic ? 'test-only-key' : 'Bearer test-only-key');
    const message = requests[1].body.messages.at(-1);
    const content = anthropic ? message.content[0].content : message.content;
    assert.equal(JSON.parse(content).content, 'The pinned data');
  });
}
