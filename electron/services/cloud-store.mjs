/**
 * 负责：单用户 Linux 服务的任务队列、会话、事件与设备凭证事务。
 * 不负责：模型请求、HTTP 身份认证和设备凭证发放界面。
 * 被谁调用：cloud-api.mjs、cloud-worker.mjs 和 Linux 服务运维命令。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';

export const terminalTaskStates = new Set(['done', 'failed', 'cancelled', 'blocked']);
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(24).toString('base64url');
const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    prompt TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, research INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    result TEXT, error TEXT, attempt INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cloud_tasks_queue ON tasks(status, created_at);
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cloud_projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, api_profile TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cloud_project_sessions (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES cloud_projects(id)
  );
  CREATE TABLE IF NOT EXISTS cloud_project_artifacts (sha256 TEXT PRIMARY KEY, content TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cloud_project_tools (
    project_id TEXT NOT NULL REFERENCES cloud_projects(id), name TEXT NOT NULL, definition TEXT NOT NULL,
    PRIMARY KEY (project_id, name)
  );
  CREATE TABLE IF NOT EXISTS cloud_task_projects (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, project TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pairs (hash TEXT PRIMARY KEY, role TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS push_targets (device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS push_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL REFERENCES push_targets(device_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0, ready_at INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO bots VALUES ('mova', 'Mova', '以用户指定的语言作答。明确事实、推断与资料来源。');
`;

export function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function text(value, label, max, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw fail('invalid_input', `${label}格式无效（最多 ${max} 字符）`);
  }
  return value.trim();
}

function sqlMethods(db) {
  const get = (query, ...params) => db.prepare(query).get(...params);
  const all = (query, ...params) => db.prepare(query).all(...params);
  const run = (query, ...params) => db.prepare(query).run(...params);
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { get, all, run, transaction };
}

const taskFields = 'id, conversation_id AS conversationId, prompt, provider, model, research, status, result, error, attempt, created_at AS createdAt, updated_at AS updatedAt';

function createTaskStore(db, now, projects) {
  const { get, all, run, transaction } = sqlMethods(db);
  const find = id => get(`SELECT ${taskFields} FROM tasks WHERE id=?`, id);
  const events = (after = 0) => all('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 250', after)
    .map(row => ({ seq: row.seq, type: row.kind, data: JSON.parse(row.data) }));
  const addEvent = (kind, data) => run('INSERT INTO events(kind,data) VALUES (?,?)', kind, JSON.stringify(data));

  function submit({ id, botId = 'mova', conversationId, prompt, provider, model, research = false, projectId, projectRevision }) {
    return transaction(() => {
      const prior = find(id);
      if (prior) {
        if (prior.prompt !== prompt || (provider !== undefined && prior.provider !== provider) || (model !== undefined && prior.model !== model)
          || Boolean(prior.research) !== (research && prior.provider !== 'research') || (projectId && projects.session(prior.conversationId) !== projectId)
          || (conversationId && prior.conversationId !== conversationId)) throw fail('conflict', '此提交标识已被使用', 409);
        return prior;
      }
      const cid = conversationId || randomUUID();
      if (conversationId && !get('SELECT id FROM conversations WHERE id=?', cid)) throw fail('not_found', '会话不存在', 404);
      const boundProject = conversationId ? projects.session(cid) : projectId;
      if (conversationId && projectId && projectId !== boundProject) throw fail('conflict', '会话不属于该云项目', 409);
      const project = boundProject ? projects.mustGet(boundProject) : null;
      if (projectRevision !== undefined && project?.revision !== projectRevision) throw fail('project_conflict', '云项目已更新，请重新读取后再提交', 409);
      const effectiveProvider = provider || project?.provider || 'research';
      if (!conversationId) {
        if (!get('SELECT id FROM bots WHERE id=?', botId)) throw fail('not_found', 'Bot 不存在', 404);
        run('INSERT INTO conversations VALUES (?,?,?,?)', cid, botId, prompt.slice(0, 54), now());
        if (project) run('INSERT INTO cloud_project_sessions VALUES (?,?)', cid, project.id);
        addEvent('conversation', { id: cid, botId });
      }
      run(`INSERT INTO tasks(id,conversation_id,prompt,provider,model,research,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?)`,
        id, cid, prompt, effectiveProvider, model ?? (effectiveProvider === project?.provider ? project.model : ''), Number(research && effectiveProvider !== 'research'), now(), now());
      if (project) run('INSERT INTO cloud_task_projects VALUES (?,?)', id, JSON.stringify(project));
      const task = find(id);
      addEvent('task', task);
      return task;
    });
  }

  function claim(owner, leaseMs) {
    return transaction(() => {
      const expired = all("SELECT id FROM tasks WHERE status='running' AND lease_until<=?", now());
      for (const { id } of expired) {
        run("UPDATE tasks SET status=CASE WHEN attempt>=3 THEN 'failed' ELSE 'queued' END,error=CASE WHEN attempt>=3 THEN '运行多次中断，请手动重试' ELSE NULL END,owner=NULL,lease_until=NULL,updated_at=? WHERE id=?", now(), id);
        addEvent('task', find(id));
      }
      const row = get("SELECT id FROM tasks WHERE status='queued' ORDER BY created_at,rowid LIMIT 1");
      if (!row) return null;
      run("UPDATE tasks SET status='running',attempt=attempt+1,owner=?,lease_until=?,updated_at=? WHERE id=?", owner, now() + leaseMs, now(), row.id);
      const task = find(row.id);
      addEvent('task', task);
      return task;
    });
  }

  function change(id, status, { owner = null, result = null, error = null } = {}) {
    return transaction(() => {
      const task = find(id);
      if (!task) throw fail('not_found', '任务不存在', 404);
      if (owner && !get("SELECT id FROM tasks WHERE id=? AND status='running' AND owner=?", id, owner)) return task;
      if (!owner && status === 'cancelled' && ['done', 'failed', 'cancelled'].includes(task.status)) return task;
      if (!owner && status === 'queued' && !['blocked', 'failed', 'cancelled'].includes(task.status)) throw fail('conflict', '只能重试已停止的任务', 409);
      run('UPDATE tasks SET status=?,result=?,error=?,owner=NULL,lease_until=NULL,updated_at=?,attempt=CASE WHEN ? THEN 0 ELSE attempt END WHERE id=?',
        status, result, error, now(), !owner && status === 'queued' ? 1 : 0, id);
      const updated = find(id);
      addEvent('task', updated);
      if (owner && ['done', 'failed', 'blocked'].includes(status)) {
        run('INSERT INTO push_outbox(device_id,task_id,status,ready_at) SELECT device_id,?,?,? FROM push_targets', id, status, now());
      }
      return updated;
    });
  }

  return {
    find, submit, claim, change, events, addEvent,
    heartbeat: (id, owner, leaseMs) => run("UPDATE tasks SET lease_until=? WHERE id=? AND status='running' AND owner=?", now() + leaseMs, id, owner).changes === 1,
    list: (limit = 100) => all(`SELECT ${taskFields} FROM tasks ORDER BY created_at DESC,rowid DESC LIMIT ?`, limit),
    history: task => all(`SELECT prompt,result FROM tasks WHERE conversation_id=? AND status='done' AND rowid<(SELECT rowid FROM tasks WHERE id=?) ORDER BY rowid DESC LIMIT 6`, task.conversationId, task.id).reverse(),
    botFor: task => get('SELECT b.* FROM bots b JOIN conversations c ON c.bot_id=b.id WHERE c.id=?', task.conversationId),
    projectFor(task) {
      const row = get('SELECT project FROM cloud_task_projects WHERE task_id=?', task.id);
      if (!row) return null;
      const project = JSON.parse(row.project);
      project.tools = project.tools.map(tool => ({ ...tool, content: get('SELECT content FROM cloud_project_artifacts WHERE sha256=?', tool.sha256)?.content ?? '' }));
      return project;
    },
  };
}

function createProjectStore(db, now) {
  const { get, all, run, transaction } = sqlMethods(db);
  const fields = 'id,name,instructions,provider,model,api_profile AS apiProfile,revision,updated_at AS updatedAt';
  function mustGet(id) {
    const project = get(`SELECT ${fields} FROM cloud_projects WHERE id=?`, id);
    if (!project) throw fail('not_found', '云项目不存在', 404);
    return { ...project, tools: all('SELECT definition FROM cloud_project_tools WHERE project_id=? ORDER BY name', id).map(row => JSON.parse(row.definition)) };
  }
  function requireRevision(current, revision) {
    if ((current?.revision ?? 0) !== revision) throw fail('project_conflict', '云项目已更新，请重新读取后再修改', 409);
  }
  return {
    mustGet,
    session: cid => get('SELECT project_id FROM cloud_project_sessions WHERE conversation_id=?', cid)?.project_id,
    list: () => all('SELECT id,name,provider,model,api_profile AS apiProfile,revision FROM cloud_projects ORDER BY name,id LIMIT 200'),
    save(id, revision, patch) {
      return transaction(() => {
        const current = get(`SELECT ${fields} FROM cloud_projects WHERE id=?`, id);
        requireRevision(current, revision);
        if (!current && get('SELECT count(*) AS total FROM cloud_projects').total >= 200) throw fail('project_limit', '云项目已达到上限', 409);
        const next = { name: id, instructions: '', provider: 'api', model: '', apiProfile: 'default', ...current, ...patch };
        run(`INSERT INTO cloud_projects VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,instructions=excluded.instructions,provider=excluded.provider,model=excluded.model,api_profile=excluded.api_profile,revision=excluded.revision,updated_at=excluded.updated_at`,
        id, next.name, next.instructions, next.provider, next.model, next.apiProfile, revision + 1, now());
        return mustGet(id);
      });
    },
    linkTool(id, revision, tool) {
      return transaction(() => {
        const project = mustGet(id);
        requireRevision(project, revision);
        if (project.tools.length >= 8 && !project.tools.some(item => item.name === tool.name)) throw fail('tool_limit', '一个项目最多配置 8 个 GitHub 工具', 409);
        const { content, ...definition } = tool;
        run('INSERT OR IGNORE INTO cloud_project_artifacts VALUES (?,?)', tool.sha256, content);
        run('INSERT INTO cloud_project_tools VALUES (?,?,?) ON CONFLICT(project_id,name) DO UPDATE SET definition=excluded.definition',
          id, tool.name, JSON.stringify(definition));
        run('UPDATE cloud_projects SET revision=revision+1,updated_at=? WHERE id=?', now(), id);
        return mustGet(id);
      });
    },
  };
}

function createDeviceStore(db, now) {
  const { get, all, run, transaction } = sqlMethods(db);
  function invite(role) {
    return transaction(() => {
      run('DELETE FROM pairs WHERE expires_at<=?', now());
      if (get('SELECT count(*) AS total FROM pairs').total >= 20) throw fail('too_many_codes', '有效配对码过多，请稍后再试', 429);
      const code = secret();
      const expiresAt = now() + 5 * 60_000;
      run('INSERT INTO pairs VALUES (?,?,?)', digest(code), role, expiresAt);
      return { code, expiresAt };
    });
  }

  function pair(code, name) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(code)) throw fail('invalid_pair', '配对码无效或已过期', 401);
    return transaction(() => {
      const hash = digest(code);
      const row = get('SELECT role,expires_at FROM pairs WHERE hash=?', hash);
      if (!row || row.expires_at <= now()) throw fail('invalid_pair', '配对码无效或已过期', 401);
      run('DELETE FROM pairs WHERE hash=?', hash);
      const id = randomUUID();
      const token = secret();
      run('INSERT INTO devices VALUES (?,?,?,?,?)', id, name, row.role, digest(token), now());
      return { id, name, role: row.role, token };
    });
  }

  return {
    invite, pair,
    authenticate: token => /^[A-Za-z0-9_-]{32}$/.test(token) && get('SELECT id,name,role FROM devices WHERE hash=?', digest(token)),
    list: () => all('SELECT id,name,role,created_at AS createdAt FROM devices ORDER BY created_at'),
    revoke: id => run('DELETE FROM devices WHERE id=?', id).changes === 1,
  };
}

export function openCloudStore(path, now = Date.now) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    db.exec(schema);
    sqlMethods(db).transaction(() => {
      if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'research')) {
        db.exec('ALTER TABLE tasks ADD COLUMN research INTEGER NOT NULL DEFAULT 0');
      }
    });
  }
  catch (error) { db.close(); throw error; }
  const { get, all, run, transaction } = sqlMethods(db);
  const projects = createProjectStore(db, now);
  const tasks = createTaskStore(db, now, projects);
  return {
    tasks, projects, devices: createDeviceStore(db, now),
    push: {
      set(id, token) {
        transaction(() => {
          if (token && get('SELECT token FROM push_targets WHERE device_id=?', id)?.token === token) return;
          run('DELETE FROM push_targets WHERE device_id=? OR token=?', id, token);
          if (token) run('INSERT INTO push_targets VALUES (?,?)', id, token);
        });
      },
      next: () => all(`SELECT n.seq, n.task_id AS taskId, n.status, n.attempt, t.token FROM push_outbox n
        JOIN push_targets t ON n.device_id=t.device_id WHERE n.ready_at<=? ORDER BY n.seq LIMIT 25`, now()),
      remove: seq => run('DELETE FROM push_outbox WHERE seq=?', seq),
      invalidate: token => run('DELETE FROM push_targets WHERE token=?', token),
      retry: (seq, attempt) => run('UPDATE push_outbox SET attempt=?,ready_at=? WHERE seq=?', attempt, now() + Math.min(900_000, 15_000 * 2 ** attempt), seq),
    },
    importBot(name, instructions) {
      return transaction(() => {
        const id = randomUUID();
        run('INSERT INTO bots VALUES (?,?,?)', id, name, instructions);
        const bot = { id, name, instructions };
        tasks.addEvent('bot', bot);
        return bot;
      });
    },
    snapshot: after => transaction(() => {
      const { cursor } = get('SELECT coalesce(max(seq),0) AS cursor FROM events');
      if (after === cursor) return { cursor, unchanged: true };
      return {
        bots: all('SELECT id,name FROM bots ORDER BY name,id'),
        conversations: all('SELECT id,bot_id AS botId,title,created_at AS createdAt FROM conversations ORDER BY created_at DESC,rowid DESC LIMIT 100'),
        tasks: tasks.list(), cursor,
      };
    }),
    backup(destination) {
      run('VACUUM INTO ?', destination);
      try {
        const backup = new DatabaseSync(destination);
        try { backup.exec('DELETE FROM push_targets; VACUUM'); } finally { backup.close(); }
      } catch (error) {
        unlinkSync(destination);
        throw error;
      }
    },
    close: () => db.close(),
  };
}
