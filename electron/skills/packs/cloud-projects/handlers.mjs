/**
 * 负责：校验本地模型参数，在桌面审批后调用已配对云主机。
 * 不负责：返回配对令牌、写入 API 密钥或实现 MCP 传输。
 * 被谁调用：cloud-projects Skill 包。
 */
import { randomUUID } from 'node:crypto';
import { errorResult, textResult } from '../../../mcp/normalize.mjs';
import { invalidArgumentsResult, validateInput } from '../../input-schema.mjs';
import { manifest } from './manifest.mjs';

export function createHandlers({ cloudProjects }) {
  const operations = {
    cloud_hosts: () => cloudProjects('hosts').then(items => items.filter(host => host.role !== 'client').slice(0, 60)),
    cloud_projects_list: async ({ host, offset = 0 }) => {
      const [projects, profiles] = await Promise.all([cloudProjects('projects', host), cloudProjects('api-profiles', host)]);
      const end = offset + 12;
      return { projects: projects.slice(offset, end), nextOffset: end < projects.length ? end : null, apiProfiles: profiles };
    },
    cloud_project_get: ({ host, ...input }) => cloudProjects('project', host, input),
    cloud_project_save: ({ host, ...input }) => cloudProjects('project-save', host, input),
    cloud_project_import: ({ host, ...input }) => cloudProjects('project-import', host, input),
    cloud_project_run: ({ host, ...input }) => cloudProjects('project-run', host, { ...input, id: randomUUID() }),
    cloud_task_get: ({ host, taskId }) => cloudProjects('task', host, { id: taskId }),
  };
  return Object.fromEntries(manifest.tools.map(def => [def.name, async (args, ctx) => {
    const checked = validateInput(def.inputSchema, args, { emptyStrings: 'keep' });
    if (!checked.ok) return invalidArgumentsResult(checked.errors);
    const input = checked.value;
    try {
      if (def.risk === 'write') {
        const allowed = await ctx.authorize(def, input, {
          preview: { kind: 'write', path: input.host + '/projects/' + input.projectId, after: JSON.stringify(input, null, 2) },
        });
        if (!allowed.allowed) return errorResult(allowed.code, allowed.reason);
      }
      return textResult(JSON.stringify(await operations[def.name](input)));
    } catch (error) {
      const message = error.code === 'not_found' && def.name === 'cloud_projects_list'
        ? '该 Linux 主机需要升级到支持云项目管理的 Mova CLI'
        : String(error.message || '云项目操作失败').slice(0, 300);
      return errorResult(error.code || 'cloud_project', message);
    }
  }]));
}
