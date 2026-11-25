/**
 * 负责：声明本地模型可调用的云项目管理工具。
 * 不负责：读取配对令牌、联网下载或执行任务。
 * 被谁调用：skills/turn-runtime.mjs。
 */
import { CLOUD_TASK_PROVIDERS } from '../../../../src/services/cloud-connection.mjs';

const url = 'http://127.0.0.1:17642';
const host = { type: 'string', maxLength: 2048, description: '已配对主机的 origin，从 mova_cloud_hosts 获取' };
const projectId = { type: 'string', maxLength: 48, description: '小写云项目标识' };
const revision = { type: 'integer', minimum: 0, description: '项目当前版本，创建项目时填 0' };
const fields = { host, projectId };
function tool(name, label, description, properties, required, example, write = false, timeoutMs = 30_000) {
  return {
    name, mcpName: 'mova_' + name, aliases: [], label, description, mcpSummary: description,
    risk: write ? 'write' : 'read', approval: write ? { mode: 'always', capability: 'write', allowSession: false } : { mode: 'none' },
    exposure: { piAi: true, mcp: name === 'cloud_hosts' ? 'core' : 'on_demand' }, timeoutMs, supportsProgress: false, imageOutput: false,
    maxResultChars: name === 'cloud_task_get' ? 48_000 : 24_000,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    examples: [{ title: label, arguments: example }],
  };
}

export const manifest = Object.freeze({
  apiVersion: 1, id: 'cloud-projects', version: '1.0.0', title: '云项目管理',
  summary: '通过本机已配对的 Linux 主机管理云项目、导入 GitHub 工具、提交与查看云端任务。',
  capabilities: ['cloud.project.read', 'cloud.project.write', 'cloud.task.submit'],
  dependencies: ['cloudProjects'],
  permissions: { fs: 'none', exec: false, net: true, desktop: false, browser: false, canvas: false, memory: 'none' },
  sessionPolicy: { allowTemporary: false, allowBrowserOnly: false }, deprecation: null,
  tools: [
    tool('cloud_hosts', '查看已配对主机', '列出已配对的管理员云主机。通过 mova_skill_search 查询 cloud-projects 技能包中的项目管理操作。', {}, [], {}),
    tool('cloud_projects_list', '查看云项目与 API 档案', '读取指定主机的云项目和已配置的 API 档案。若返回 nextOffset，用它继续翻页。', {
      host, offset: { type: 'integer', minimum: 0, maximum: 199 },
    }, ['host'], { host: url }),
    tool('cloud_project_get', '读取云项目配置', '读取项目配置、当前 revision 和已导入工具的来源。', fields, ['host', 'projectId'], { host: url, projectId: 'research' }),
    tool('cloud_project_save', '修改或创建云项目', '更新指定字段，或用 revision=0 创建。用 provider=api 和已有 apiProfile 选择 API。先读取当前 revision。', {
      ...fields, revision, name: { type: 'string', maxLength: 80 }, instructions: { type: 'string', maxLength: 4000, allowEmpty: true },
      provider: { type: 'string', enum: CLOUD_TASK_PROVIDERS }, model: { type: 'string', maxLength: 200, allowEmpty: true },
      apiProfile: { type: 'string', maxLength: 32, description: '已由 Linux 管理员配置的 API 档案 ID' },
    }, ['host', 'projectId', 'revision'], { host: url, projectId: 'research', revision: 0, name: '研究项目', provider: 'api' }, true, 120_000),
    tool('cloud_project_import', '导入 GitHub 工具到云项目', '下载公开 GitHub 仓库固定提交中的 mova-tool.json，或把指定文本文件注册成只读工具。使用 API 模型的云任务可调用它。', {
      ...fields, revision, repository: { type: 'string', maxLength: 140, description: 'owner/repo' },
      commit: { type: 'string', minLength: 40, maxLength: 40, description: '完整 GitHub 提交 SHA' },
      manifestPath: { type: 'string', maxLength: 260, description: '默认 mova-tool.json' },
      filePath: { type: 'string', maxLength: 260, description: '直接导入仓库内文本时提供，和 manifestPath 二选一' },
      toolName: { type: 'string', maxLength: 48, description: '直接导入文本时必填，使用小写字母、数字或连字符' },
      description: { type: 'string', maxLength: 300 },
    }, ['host', 'projectId', 'revision', 'repository', 'commit'], { host: url, projectId: 'research', revision: 1, repository: 'owner/knowledge', commit: '0'.repeat(40) }, true, 120_000),
    tool('cloud_project_run', '提交云项目任务', '把用户明确要求的任务提交给这个云项目当前配置的模型。返回任务 ID，之后可查询结果。', {
      ...fields, revision, prompt: { type: 'string', maxLength: 12000 }, research: { type: 'boolean' },
    }, ['host', 'projectId', 'revision', 'prompt'], { host: url, projectId: 'research', revision: 1, prompt: '读取项目资料并用中文总结' }, true, 120_000),
    tool('cloud_task_get', '查看云任务结果', '按任务 ID 查看该已配对主机上的任务状态与结果。', {
      host, taskId: { type: 'string', maxLength: 100 },
    }, ['host', 'taskId'], { host: url, taskId: 'task-id' }),
  ],
});
