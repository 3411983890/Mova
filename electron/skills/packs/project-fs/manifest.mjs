/**
 * 负责：`project-fs` 技能包的纯数据声明——文件/检索/Git/命令共 16 个工具的名字、MCP 名、
 *   风险分级、审批策略、暴露方式与 JSON Schema；零 IO、零函数、零宿主 import。
 * 不负责：工具实现（handlers.mjs 转调 electron/agent-tools.cjs）、路径 realpath 与 `.git` 保护
 *   （agent-tools.cjs 的 resolveInside / guardWrite）、字段校验（manifest-schema.mjs）。
 * 被谁调用：electron/skills/packs/index.mjs（DEFAULT_PACKS）、electron/skills/registry.mjs、
 *   tests/skills-packs.test.mjs（assertValidManifest）。
 *
 * 工具名沿用方案 §2.1 的短名，MCP 名一律 `mova_` 前缀由本文件声明（handler 里绝不自己拼）。
 */

/**
 * 只读工具的审批声明：能力位复查由 agent-tools.cjs 的 stillAllowed('read') 在每次调用时做，
 * 不需要再弹人工确认条（写/执行才必须过闸门）。
 */
const READ_APPROVAL = Object.freeze({ mode: 'none' });
/** 写类工具：风险等级即能力位；同一会话内同类只问一次（allowSession 由 approval-bridge 缓存）。 */
const WRITE_APPROVAL = Object.freeze({ mode: 'policy', capability: 'write', allowSession: true });
/** 命令类工具：shell 不受项目目录限制，因此永远单独走 exec 能力位与人工确认。 */
const EXEC_APPROVAL = Object.freeze({ mode: 'policy', capability: 'exec', allowSession: true });

/** 路径参数的长度上限：与 electron/mcp/tools.mjs 与 agent-tools 的 schema 保持一致。 */
const PATH_MAX = 400;

/** 单个工具定义里与具体能力无关的公共字段（core / on_demand 由各条自己声明）。 */
const onDemand = Object.freeze({ piAi: true, mcp: 'on_demand' });
const core = Object.freeze({ piAi: true, mcp: 'core' });

export const manifest = Object.freeze({
  apiVersion: 1,
  id: 'project-fs',
  version: '1.0.0',
  title: '文件与命令',
  summary: '读写项目内文件、检索代码与符号、查看 Git 差异并运行命令，安全校验统一由 agent-tools 负责。',
  capabilities: ['fs.read', 'fs.write', 'fs.search', 'project.tree', 'project.git', 'exec.command'],
  dependencies: ['projectTools'],
  permissions: {
    fs: 'write',
    exec: true,
    net: false,
    desktop: false,
    browser: false,
    canvas: false,
    memory: 'none',
  },
  sessionPolicy: { allowTemporary: true, allowBrowserOnly: false },
  deprecation: null,
  tools: [
    {
      name: 'read_file',
      mcpName: 'mova_read_file',
      aliases: [],
      label: '读取文件',
      mcpSummary: '读取项目内文件，返回文本内容与行号范围；二进制文件返回类型与可打印片段。',
      description: 'Read a file inside the project folders. Text files: use startLine/endLine for large files; '
        + 'files above 4 MB are streamed by line range instead of refused. Binary files are described (mime, size, '
        + 'base64 head, printable strings) instead of refused.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: core,
      timeoutMs: 30_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: PATH_MAX, description: '相对项目根的路径，可带「项目文件夹名/」前缀' },
          startLine: { type: 'integer', minimum: 1, description: '起始行（1 起）；大文件分段读取时使用' },
          endLine: { type: 'integer', minimum: 1, description: '结束行（含）' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      examples: [
        { title: '读取 package.json 的前 40 行', arguments: { path: 'package.json', startLine: 1, endLine: 40 } },
      ],
    },
    {
      name: 'list_files',
      mcpName: 'mova_list_files',
      aliases: [],
      label: '列出文件',
      mcpSummary: '列出项目文件夹里的文件与子目录，可下探 1–3 层。',
      description: 'List files and folders inside the project folders. Paths are relative to a project folder; '
        + 'prefix with the folder name when there are several.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: core,
      timeoutMs: 20_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: PATH_MAX, description: '相对目录路径；省略或传 "." 表示所有项目根' },
          depth: { type: 'integer', minimum: 1, maximum: 3, description: '下探层数，默认 1' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '列出项目根下两层', arguments: { path: '.', depth: 2 } },
      ],
    },
    {
      name: 'write_file',
      mcpName: 'mova_write_file',
      aliases: [],
      label: '写入文件',
      mcpSummary: '新建或整体覆盖项目内文本文件，写前走审批与 diff 预览，写完可撤销。',
      description: 'Create or overwrite a text file inside a project folder. Prefer replace_in_file / apply_patch '
        + 'for small edits. The user approves the change in the app and the diff comes back for the timeline card.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: core,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: PATH_MAX, description: '相对文件路径，可带项目文件夹名前缀' },
          content: { type: 'string', maxLength: 512_000, description: '完整的新文件内容（最多 512000 字符，可为空字符串表示清空文件）' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      examples: [
        { title: '新建一个说明文件', arguments: { path: 'docs/notes/todo.md', content: '# TODO\n- 写测试\n' } },
      ],
    },
    {
      name: 'apply_patch',
      mcpName: 'mova_apply_patch',
      aliases: [],
      label: '应用补丁',
      mcpSummary: '把统一 diff 补丁（或精确的原文→新文）应用到项目内一个文件，逐个 hunk 走审批与 diff 预览。',
      description: 'Apply a unified diff (one `path` + up to 20 `@@` hunks) to one file inside the project folders, '
        + 'or pass oldText/newText for one exact replacement. Every hunk is delegated to replace_in_file, so the '
        + '`.git` guard, realpath check, approval bar and undo record all still apply.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: core,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: PATH_MAX, description: '相对文件路径，可带项目文件夹名前缀' },
          patch: {
            type: 'string',
            maxLength: 20_000,
            description: '统一 diff 文本：---/+++ 头可省略，每个 @@ hunk 至少要有一行以 "-" 开头的待替换原文',
          },
          oldText: { type: 'string', maxLength: 8_000, description: '精确替换模式下的原文（与 patch 二选一）' },
          newText: { type: 'string', maxLength: 8_000, description: '精确替换模式下的新文本' },
          all: { type: 'boolean', description: '精确替换模式下是否替换全部出现的位置' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      examples: [
        {
          title: '把一个函数名改掉',
          arguments: {
            path: 'src/features/chat/chat-reply.ts',
            patch: '@@ -1,3 +1,3 @@\n-export function mergeReplyEvent(\n+export function mergeReplyEvents(\n',
          },
        },
      ],
    },
    {
      name: 'search_files',
      mcpName: 'mova_search_files',
      aliases: [],
      label: '搜索文件内容',
      mcpSummary: '在项目里按文本或正则搜索，返回文件路径、行号与命中行。',
      description: 'Search text inside the project folders and return matching lines with file paths and line '
        + 'numbers. Prefer this over reading whole files to find code. Files above 8 MB are skipped and counted.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: '要找的文本（默认按字面量）' },
          path: { type: 'string', maxLength: PATH_MAX, description: '相对目录；省略表示搜索所有项目文件夹' },
          regex: { type: 'boolean', description: '把 query 当正则表达式' },
          ignoreCase: { type: 'boolean', description: '忽略大小写（默认 true）' },
          maxResults: { type: 'integer', minimum: 1, maximum: 120, description: '最多返回多少行命中（默认 60）' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      examples: [
        { title: '找 buildSkillRuntime 的定义位置', arguments: { query: 'buildSkillRuntime', path: 'electron/skills' } },
      ],
    },
    {
      name: 'project_tree',
      mcpName: 'mova_project_tree',
      aliases: [],
      label: '查看项目树',
      mcpSummary: '返回项目文件夹的有界目录树（名称、类型、大小），跳过 .git 与 node_modules。',
      description: 'Show a bounded tree of the project folders (names, types, sizes). Skips .git, node_modules and '
        + 'symlinks. Read-only; needs no approval.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 30_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: PATH_MAX, description: '相对文件夹路径；省略则列出每个项目文件夹' },
          depth: { type: 'integer', minimum: 1, maximum: 4, description: '向下展开几层（默认 3）' },
          maxEntries: { type: 'integer', minimum: 1, maximum: 400, description: '最多返回多少个条目（默认 400）' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '看 skills 目录结构', arguments: { path: 'electron/skills', depth: 3 } },
      ],
    },
    {
      name: 'find_symbol',
      mcpName: 'mova_find_symbol',
      aliases: [],
      label: '查找符号',
      mcpSummary: '按字面量查找一个符号的定义与引用，返回路径、行号与命中行。',
      description: 'Find where a name is defined or referenced across the project folders. Literal matching only '
        + '(never a regular expression). Read-only; needs no approval.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120, description: '要查找的符号名（按字面量匹配）' },
          kind: { type: 'string', enum: ['any', 'definition', 'reference'], description: '查找范围（默认 any）' },
          path: { type: 'string', maxLength: PATH_MAX, description: '相对文件夹或文件；省略则搜索每个项目文件夹' },
          maxResults: { type: 'integer', minimum: 1, maximum: 120, description: '最多返回多少条命中（默认 60）' },
          ignoreCase: { type: 'boolean', description: '是否忽略大小写（默认 false）' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      examples: [
        { title: '查 createProjectTools 的定义', arguments: { name: 'createProjectTools', kind: 'definition' } },
      ],
    },
    {
      name: 'git_status',
      mcpName: 'mova_git_status',
      aliases: [],
      label: '查看 Git 状态',
      mcpSummary: '查看项目文件夹的分支与变更文件列表，只读免审批。',
      description: 'Show the working tree status of a project folder (branch plus changed files). Read-only; needs '
        + 'no approval.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 20_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: PATH_MAX, description: '仓库内的相对文件夹；省略表示第一个项目文件夹' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '看当前改动', arguments: { path: '.' } },
      ],
    },
    {
      name: 'git_diff',
      mcpName: 'mova_git_diff',
      aliases: [],
      label: '查看 Git 差异',
      mcpSummary: '查看未提交改动的统一 diff（可选只看已暂存），只读免审批。',
      description: 'Show the unified diff of uncommitted changes in a project folder. Read-only; needs no approval.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 30_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: PATH_MAX, description: '相对文件或文件夹；省略表示整个仓库' },
          staged: { type: 'boolean', description: '只看已暂存的改动' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '看整个仓库的未提交改动', arguments: {} },
      ],
    },
    {
      name: 'list_changes',
      mcpName: 'mova_list_changes',
      aliases: [],
      label: '查看最近的修改',
      mcpSummary: '列出本应用最近改过的文件，按 changeId 可撤销。',
      description: 'List recent file changes this app made in the project folders, so one can be undone by id. '
        + 'Only available when a change-history directory is injected.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 20_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 30, description: '返回多少条最近改动（默认 10）' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '看最近 5 条改动', arguments: { limit: 5 } },
      ],
    },
    {
      name: 'replace_in_file',
      mcpName: 'mova_replace_in_file',
      aliases: [],
      label: '修改文件',
      mcpSummary: '把文件里一段精确原文替换成新文本，写前审批、写完可撤销。',
      description: 'Replace one exact text fragment in a file. Fails when the fragment is missing or appears more '
        + 'than once, unless `all` is true.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: PATH_MAX, description: '相对文件路径' },
          oldText: { type: 'string', minLength: 1, maxLength: 8_000, description: '要精确匹配的原文' },
          newText: { type: 'string', maxLength: 512_000, description: '替换后的文本' },
          all: { type: 'boolean', description: '替换全部出现的位置' },
        },
        required: ['path', 'oldText'],
        additionalProperties: false,
      },
      examples: [
        { title: '改一个常量值', arguments: { path: 'src/config.ts', oldText: 'timeout: 30_000', newText: 'timeout: 60_000' } },
      ],
    },
    {
      name: 'delete_path',
      mcpName: 'mova_delete_path',
      aliases: [],
      label: '删除文件或文件夹',
      mcpSummary: '删除项目内一个文件或文件夹（文件夹需 recursive），删除前审批、可撤销。',
      description: 'Delete one file or one folder inside a project folder. A folder that still has content needs '
        + 'recursive=true. A file deletion is recorded so undo_change can restore the content.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: PATH_MAX, description: '要删除的相对路径' },
          recursive: { type: 'boolean', description: '删除文件夹时是否连同内容一起删除（默认 false）' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      examples: [
        { title: '删掉一个临时文件', arguments: { path: 'tmp/probe.log' } },
      ],
    },
    {
      name: 'move_path',
      mcpName: 'mova_move_path',
      aliases: [],
      label: '移动文件或文件夹',
      mcpSummary: '在同一个项目文件夹内移动或重命名，跨文件夹会被拒绝。',
      description: 'Move one file or folder to another path inside the same project folder. Never copies across '
        + 'project folders or drives, so one approval always covers both endpoints.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', minLength: 1, maxLength: PATH_MAX, description: '源路径' },
          to: { type: 'string', minLength: 1, maxLength: PATH_MAX, description: '目标路径（同一项目文件夹内）' },
          overwrite: { type: 'boolean', description: '目标已存在时是否覆盖（默认 false）' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      examples: [
        { title: '重命名一个文件', arguments: { from: 'docs/plan-old.md', to: 'docs/plan.md' } },
      ],
    },
    {
      name: 'apply_changes',
      mcpName: 'mova_apply_changes',
      aliases: [],
      label: '批量修改文件',
      mcpSummary: '一次审批内对同一项目文件夹的 1–20 个文件做整写或精确替换，任一失败全部不写。',
      description: 'Apply 1 to 20 whole-file writes and exact replacements in a single approval. Every change is '
        + 'validated first, and if any file changed while the dialog was open nothing is written at all.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: onDemand,
      timeoutMs: 90_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            description: '要一起应用的修改：同一项目文件夹，每个文件只能出现一次',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', minLength: 1, maxLength: PATH_MAX, description: '相对文件路径' },
                content: { type: 'string', maxLength: 512_000, description: '整文件写入的完整内容（与 oldText 二选一）' },
                oldText: { type: 'string', minLength: 1, maxLength: 8_000, description: '要精确替换的原文（与 content 二选一）' },
                newText: { type: 'string', maxLength: 8_000, description: '替换后的文本' },
                all: { type: 'boolean', description: '替换全部出现的位置' },
              },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
      examples: [
        {
          title: '一次改两个文件里的同一个常量',
          arguments: {
            changes: [
              { path: 'src/a.ts', oldText: 'export const LIMIT = 10;', newText: 'export const LIMIT = 20;' },
              { path: 'src/b.ts', content: 'export const LIMIT = 20;\n' },
            ],
          },
        },
      ],
    },
    {
      name: 'undo_change',
      mcpName: 'mova_undo_change',
      aliases: [],
      label: '撤销修改',
      mcpSummary: '按 changeId 把文件恢复到某次修改之前的内容，撤销前审批。',
      description: 'Restore a file to the content it had before one earlier change, using its changeId. Works for '
        + 'writes, replacements, deletions and file moves. Only available when a change-history directory is injected.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          changeId: { type: 'string', minLength: 1, maxLength: 80, description: '写/改/删/移 返回的 changeId' },
        },
        required: ['changeId'],
        additionalProperties: false,
      },
      examples: [
        { title: '撤销刚才那次写入', arguments: { changeId: '8f14e45f-ceea-467f-a1c2-3f9d2a4b6c11' } },
      ],
    },
    {
      name: 'run_command',
      mcpName: 'mova_run_command',
      aliases: [],
      label: '运行命令',
      mcpSummary: '以项目文件夹为工作目录运行命令（或直接执行 argv），用户逐条审批，输出截断后返回。',
      description: 'Run a command with the project folder as working directory. Two mutually exclusive ways: '
        + '`command` is a shell line (at most 2000 characters), `argv` is [program, ...args] run without a shell so '
        + 'every argument arrives exactly as written. Output is UTF-8 with head/tail kept and `truncated: true` when '
        + 'the middle was elided. The shell is NOT sandboxed: it runs with the user account\'s full rights.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 130_000,
      supportsProgress: true,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', maxLength: 2_000, description: 'shell 命令行（与 argv 二选一）' },
          argv: {
            type: 'array',
            maxItems: 64,
            items: { type: 'string', maxLength: 2_000 },
            description: '程序与参数，直接执行不经 shell（与 command 二选一）',
          },
          shell: { type: 'boolean', description: '仅对 command 有意义；shell 行始终经 shell 解释' },
          path: { type: 'string', maxLength: PATH_MAX, description: '作为工作目录的相对文件夹（默认第一个项目文件夹）' },
          timeoutMs: { type: 'integer', minimum: 1_000, maximum: 120_000, description: '超时毫秒数（默认 60000）' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '跑单测的 skills 用例', arguments: { command: 'node --test tests/skills-packs.test.mjs' } },
        { title: '不经 shell 直接跑 node', arguments: { argv: ['node', '-e', 'console.log("hi")'] } },
      ],
    },
  ],
});
