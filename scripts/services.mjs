#!/usr/bin/env node
/**
 * Mova local Docker service control.
 *
 * CLI:    node scripts/services.mjs status|up|down|logs|migrate|ensure
 * Module: createServicesManager({ run, fs, now, sleep, migrate }) for Electron.
 *
 * The manager is fully dependency-injected: unit tests never start Docker.
 * Passwords are never printed; all child output is redacted before logging.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDotEnv } from './db-migrate.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CAPTURE_CHARS = 2_000_000;

export const SERVICE_NAMES = Object.freeze(['mova-db', 'mova-redis', 'mova-minio']);
export const SERVICE_LABELS = Object.freeze({
  'mova-db': 'PostgreSQL + pgvector',
  'mova-redis': 'Redis 7',
  'mova-minio': 'MinIO object storage',
});

export class ServiceError extends Error {
  constructor(message, code = 'service_error') {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

export class ServiceUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServiceUsageError';
    this.code = 'usage';
  }
}

export function redactSecrets(text, secrets = []) {
  let output = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3 && output.includes(secret)) {
      output = output.split(secret).join('***');
    }
  }
  return output
    .replace(/(postgres(?:ql)?:\/\/[^:/?#\s]+:)([^@/?#\s]*)(@)/gi, '$1***$3')
    .replace(/(redis:\/\/[^:/?#\s]+:)([^@/?#\s]*)(@)/gi, '$1***$3');
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function integerEnv(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] ?? '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function resolveServiceConfig({ env = process.env, cwd = DEFAULT_ROOT, platform = process.platform } = {}) {
  const dbUser = env.MOVA_DB_USER || 'mova';
  const dbPassword = env.MOVA_DB_PASSWORD || 'mova_local_password';
  const dbName = env.MOVA_DB_NAME || 'mova';
  const dbPort = String(integerEnv(env.MOVA_DB_PORT, 55432));
  const redisPort = String(integerEnv(env.MOVA_REDIS_PORT, 56379));
  const minioPort = String(integerEnv(env.MOVA_MINIO_PORT, 59090));
  const minioConsolePort = String(integerEnv(env.MOVA_MINIO_CONSOLE_PORT, 59091));
  const s3AccessKey = env.MOVA_S3_ACCESS_KEY || 'mova';
  const s3SecretKey = env.MOVA_S3_SECRET_KEY || 'mova_local_password';
  const dbUrl =
    env.MOVA_DB_URL ||
    `postgres://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@127.0.0.1:${dbPort}/${dbName}`;

  const programFiles = env.ProgramFiles || env.ProgramW6432 || 'C:\\Program Files';
  const localAppData = env.LOCALAPPDATA || '';

  const dockerCliCandidates = [
    env.MOVA_DOCKER_CLI ? { path: env.MOVA_DOCKER_CLI, source: 'MOVA_DOCKER_CLI', absolute: false } : null,
    { path: 'docker', source: 'PATH', absolute: false },
    platform === 'win32'
      ? {
          path: path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
          source: 'ProgramFiles',
          absolute: true,
        }
      : null,
    platform === 'win32' && localAppData
      ? {
          path: path.join(localAppData, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
          source: 'LOCALAPPDATA',
          absolute: true,
        }
      : null,
  ].filter(Boolean);

  const desktopCandidates = [
    env.MOVA_DOCKER_DESKTOP_PATH
      ? { path: env.MOVA_DOCKER_DESKTOP_PATH, source: 'MOVA_DOCKER_DESKTOP_PATH' }
      : null,
    platform === 'win32'
      ? { path: path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'), source: 'ProgramFiles' }
      : null,
    platform === 'win32' && localAppData
      ? { path: path.join(localAppData, 'Docker', 'Docker Desktop.exe'), source: 'LOCALAPPDATA' }
      : null,
  ].filter(Boolean);

  return {
    cwd,
    platform,
    composeFile: env.MOVA_COMPOSE_FILE
      ? path.resolve(cwd, env.MOVA_COMPOSE_FILE)
      : path.join(cwd, 'docker-compose.yml'),
    projectName: env.MOVA_COMPOSE_PROJECT || 'mova-local',
    dbUrl,
    dbUser,
    dbName,
    dbPort,
    redisPort,
    minioPort,
    minioConsolePort,
    s3AccessKey,
    s3SecretKey,
    secrets: unique([dbPassword, s3SecretKey, env.MOVA_REDIS_PASSWORD, 'mova_local_password']),
    autostart: parseBoolean(env.MOVA_AUTOSTART_SERVICES, true),
    desktopTimeoutMs: integerEnv(env.MOVA_DOCKER_START_TIMEOUT_MS, 180_000, { min: 5_000 }),
    healthTimeoutMs: integerEnv(env.MOVA_SERVICE_HEALTH_TIMEOUT_MS, 120_000, { min: 5_000 }),
    pollMs: integerEnv(env.MOVA_SERVICE_POLL_MS, 2_000, { min: 100 }),
    dockerCliCandidates,
    desktopCandidates,
    services: [
      { name: 'mova-db', port: `127.0.0.1:${dbPort}` },
      { name: 'mova-redis', port: `127.0.0.1:${redisPort}` },
      { name: 'mova-minio', port: `127.0.0.1:${minioPort} (console ${minioConsolePort})` },
    ],
  };
}

export function parseComposePs(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    /* older compose versions print one JSON object per line */
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (Array.isArray(parsed)) entries.push(...parsed);
    else entries.push(parsed);
  }
  return entries;
}

function normalizeEntry(entry) {
  const name = entry?.Service ?? entry?.service ?? entry?.Name ?? entry?.name ?? '';
  const state = String(entry?.State ?? entry?.state ?? 'unknown').toLowerCase();
  const rawHealth = String(entry?.Health ?? entry?.health ?? '').toLowerCase();
  const health = rawHealth && rawHealth !== '<no value>' ? rawHealth : 'unknown';
  return { name, state, health };
}

export function createDefaultRun() {
  return function defaultRun(command, args = [], options = {}) {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let timer = null;

      const finish = (code, extra = {}) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr, ...extra });
      };

      const append = (current, chunk) => {
        if (current.length >= MAX_CAPTURE_CHARS) return current;
        return current + String(chunk).slice(0, MAX_CAPTURE_CHARS - current.length);
      };

      let child;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: { ...process.env, ...(options.env ?? {}) },
          shell: false,
          windowsHide: true,
          detached: Boolean(options.detached),
          stdio: options.detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ code: 127, stdout: '', stderr: String(error?.message ?? error) });
        return;
      }

      if (options.detached) {
        child.once('error', (error) => finish(127, { stderr: String(error?.message ?? error) }));
        child.once('spawn', () => {
          child.unref();
          finish(0, { detached: true });
        });
        return;
      }

      child.stdout?.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.once('error', (error) => finish(127, { stderr: String(error?.message ?? error) }));
      child.once('close', (code) => finish(code ?? 1));

      if (options.timeoutMs) {
        timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          stderr = append(stderr, `\nCommand timed out after ${options.timeoutMs}ms`);
          finish(124);
        }, options.timeoutMs);
      }
    });
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createServicesManager(options = {}) {
  const {
    env = process.env,
    cwd = DEFAULT_ROOT,
    platform = process.platform,
    run = createDefaultRun(),
    fs = { existsSync },
    now = Date.now,
    sleep = defaultSleep,
    logger = () => {},
    migrate: migrateImpl,
    migrationStatus: migrationStatusImpl,
  } = options;

  const config = resolveServiceConfig({ env, cwd, platform });
  const childEnv = { ...env };
  const sanitize = (text) => redactSecrets(text, config.secrets);
  const log = (message) => logger(sanitize(message));

  // Docker Desktop installs docker-credential-desktop.exe next to docker.exe but
  // does not always put that directory on the PATH inherited by Electron. Without
  // it, `docker compose pull` fails with "docker-credential-desktop not found".
  function addToChildPath(directory) {
    const key = Object.keys(childEnv).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
    const current = String(childEnv[key] ?? '');
    const entries = current.split(path.delimiter).filter(Boolean);
    const alreadyPresent = entries.some((entry) => entry.toLowerCase() === directory.toLowerCase());
    if (!alreadyPresent) childEnv[key] = [directory, ...entries].join(path.delimiter);
  }

  for (const candidate of config.dockerCliCandidates) {
    if (!candidate.absolute) continue;
    const directory = path.dirname(candidate.path);
    if (fs.existsSync(directory)) addToChildPath(directory);
  }

  const runMigrations =
    migrateImpl ??
    (async (migrationOptions) => {
      const module = await import('./db-migrate.mjs');
      return module.runMigrations(migrationOptions);
    });
  const readMigrationStatus =
    migrationStatusImpl ??
    (async (migrationOptions) => {
      const module = await import('./db-migrate.mjs');
      return module.migrationStatus(migrationOptions);
    });

  function composeArgs(extra = []) {
    return ['compose', '-p', config.projectName, '-f', config.composeFile, ...extra];
  }

  function runCompose(dockerPath, extra, { timeoutMs = 300_000 } = {}) {
    return run(dockerPath, composeArgs(extra), {
      cwd,
      env: childEnv,
      timeoutMs,
    });
  }

  function resolveDesktopExe() {
    for (const candidate of config.desktopCandidates) {
      if (fs.existsSync(candidate.path)) return candidate;
    }
    return null;
  }

  async function resolveDockerCli() {
    const failures = [];
    for (const candidate of config.dockerCliCandidates) {
      if (candidate.absolute && !fs.existsSync(candidate.path)) continue;
      const result = await run(candidate.path, ['--version'], {
        cwd,
        env: childEnv,
        timeoutMs: 15_000,
      });
      if (result.code === 0) {
        return {
          found: true,
          path: candidate.path,
          source: candidate.source,
          version: firstLine(result.stdout),
        };
      }
      failures.push(`${candidate.path}: ${sanitize(result.stderr || `exit ${result.code}`)}`);
    }
    return { found: false, failures };
  }

  async function checkDaemon(dockerPath) {
    const result = await run(dockerPath, ['info', '--format', '{{.ServerVersion}}'], {
      cwd,
      env: childEnv,
      timeoutMs: 20_000,
    });
    return {
      up: result.code === 0,
      version: firstLine(result.stdout),
      error: result.code === 0 ? '' : sanitize(result.stderr || `exit ${result.code}`),
    };
  }

  async function composePs(dockerPath) {
    const result = await runCompose(dockerPath, ['ps', '-a', '--format', 'json'], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      return {
        ok: false,
        entries: [],
        error: sanitize(result.stderr || result.stdout || `exit ${result.code}`),
      };
    }
    try {
      return { ok: true, entries: parseComposePs(result.stdout).map(normalizeEntry), error: '' };
    } catch (error) {
      return { ok: false, entries: [], error: `Cannot parse docker compose ps output: ${sanitize(error.message)}` };
    }
  }

  function serviceViews(entries) {
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return config.services.map((expected) => {
      const entry = byName.get(expected.name);
      const state = entry?.state ?? 'missing';
      const health = entry?.health ?? 'unknown';
      return {
        name: expected.name,
        label: SERVICE_LABELS[expected.name],
        port: expected.port,
        state,
        health,
        healthy: state === 'running' && health === 'healthy',
      };
    });
  }

  async function inspectStatus() {
    const docker = await resolveDockerCli();
    const desktop = resolveDesktopExe();
    const result = {
      ok: false,
      mode: 'docker',
      composeFile: config.composeFile,
      project: config.projectName,
      docker: {
        cli: docker.found ? 'ok' : 'missing',
        path: docker.found ? docker.path : null,
        version: docker.found ? docker.version : '',
        daemon: 'down',
        desktop: { installed: Boolean(desktop), path: desktop?.path ?? null },
      },
      services: config.services.map((service) => ({
        name: service.name,
        label: SERVICE_LABELS[service.name],
        port: service.port,
        state: 'unknown',
        health: 'unknown',
        healthy: false,
      })),
      message: '',
    };

    if (!docker.found) {
      result.message = [
        'Docker CLI not found.',
        'Install Docker Desktop 4.99+, open it once, and make sure `docker` is on PATH',
        'or set MOVA_DOCKER_CLI to the full docker.exe path.',
        ...docker.failures.slice(0, 3),
      ].join(' ');
      return result;
    }

    const daemon = await checkDaemon(docker.path);
    result.docker.daemon = daemon.up ? 'up' : 'down';
    if (!daemon.up) {
      result.message = [
        'Docker daemon is not running.',
        config.autostart
          ? 'Run `node scripts/services.mjs ensure` to start Docker Desktop automatically.'
          : 'Start Docker Desktop (MOVA_AUTOSTART_SERVICES is false).',
        daemon.error,
      ]
        .filter(Boolean)
        .join(' ');
      return result;
    }

    if (!fs.existsSync(config.composeFile)) {
      result.message = `docker-compose.yml not found at ${config.composeFile}`;
      return result;
    }

    const ps = await composePs(docker.path);
    if (!ps.ok) {
      result.message = `docker compose ps failed: ${ps.error}`;
      return result;
    }

    result.services = serviceViews(ps.entries);
    const servicesHealthy = result.services.every((service) => service.healthy);
    result.ok = servicesHealthy;

    if (result.ok) {
      result.message = 'All local services are healthy.';
    } else {
      const unhealthy = result.services.filter((service) => !service.healthy);
      result.message = `Not healthy: ${unhealthy
        .map((service) => `${service.name} (${service.state}/${service.health})`)
        .join(', ')}`;
    }
    return result;
  }

  function summarize(status) {
    return (status?.services ?? [])
      .map((service) => `${service.name}=${service.state}/${service.health}`)
      .join(', ');
  }

  async function waitForDaemon(dockerPath, timeoutMs) {
    const deadline = now() + timeoutMs;
    let last = await checkDaemon(dockerPath);
    while (!last.up) {
      if (now() >= deadline) {
        throw new ServiceError(
          `Docker daemon did not become ready within ${Math.round(timeoutMs / 1000)}s. ` +
            'Docker Desktop may need a manual first-run license acceptance or WSL update.',
        );
      }
      await sleep(config.pollMs);
      last = await checkDaemon(dockerPath);
    }
    log(`Docker daemon is ready${last.version ? ` (${last.version})` : ''}.`);
    return last;
  }

  async function waitForHealthy(timeoutMs) {
    const deadline = now() + timeoutMs;
    let last = await inspectStatus();
    for (;;) {
      if (last.ok) return last;
      const broken = last.services.find((service) => ['exited', 'dead', 'restarting'].includes(service.state));
      if (broken) {
        throw new ServiceError(
          `Service ${broken.name} is ${broken.state} (${broken.health}); check \`node scripts/services.mjs logs --service ${broken.name}\`.`,
        );
      }
      if (now() >= deadline) {
        throw new ServiceError(
          `Services did not become healthy within ${Math.round(timeoutMs / 1000)}s: ${summarize(last)}`,
        );
      }
      await sleep(config.pollMs);
      last = await inspectStatus();
    }
  }

  async function startDockerDesktop() {
    if (platform !== 'win32') {
      throw new ServiceError(
        'Automatic Docker Desktop start is only implemented on Windows. Start Docker manually and retry.',
        'desktop_autostart_unsupported',
      );
    }
    const desktop = resolveDesktopExe();
    if (!desktop) {
      throw new ServiceError(
        'Docker Desktop executable not found. Install Docker Desktop, or set MOVA_DOCKER_DESKTOP_PATH to "Docker Desktop.exe".',
        'desktop_not_found',
      );
    }
    log(`Starting Docker Desktop: ${desktop.path}`);
    const launched = await run(desktop.path, [], {
      cwd,
      env: childEnv,
      detached: true,
      timeoutMs: 15_000,
    });
    if (launched.code !== 0) {
      throw new ServiceError(
        `Failed to launch Docker Desktop (${desktop.path}): ${sanitize(launched.stderr || `exit ${launched.code}`)}`,
        'desktop_launch_failed',
      );
    }
    return desktop;
  }

  async function startStack({ allowAutostart, shouldMigrate, timeoutMs }) {
    const docker = await resolveDockerCli();
    if (!docker.found) {
      throw new ServiceError(
        'Docker CLI not found. Install Docker Desktop 4.99+ and ensure `docker` is on PATH, or set MOVA_DOCKER_CLI.',
        'docker_missing',
      );
    }
    if (!fs.existsSync(config.composeFile)) {
      throw new ServiceError(`docker-compose.yml not found at ${config.composeFile}`, 'compose_missing');
    }

    let daemon = await checkDaemon(docker.path);
    if (!daemon.up) {
      if (!allowAutostart) {
        throw new ServiceError(
          'Docker daemon is not running. Start Docker Desktop, or run `node scripts/services.mjs ensure` to autostart it.',
          'daemon_down',
        );
      }
      await startDockerDesktop();
      log('Waiting for Docker daemon...');
      daemon = await waitForDaemon(docker.path, config.desktopTimeoutMs);
    }

    log('Starting local services: docker compose up -d');
    const up = await runCompose(docker.path, ['up', '-d'], { timeoutMs: 300_000 });
    if (up.code !== 0) {
      throw new ServiceError(
        `docker compose up failed (exit ${up.code}): ${sanitize(up.stderr || up.stdout || 'no output')}`,
        'compose_up_failed',
      );
    }

    log('Waiting for service health...');
    const health = await waitForHealthy(timeoutMs ?? config.healthTimeoutMs);

    let migrations = null;
    if (shouldMigrate) {
      log('Applying database migrations...');
      migrations = await applyMigrations();
      if (!migrations.ok) {
        log(`Migration failed: ${migrations.error ?? 'unknown error'}`);
      } else if (migrations.applied?.length) {
        log(`Applied ${migrations.applied.length} migration(s).`);
      } else {
        log('Database schema is up to date.');
      }
    }

    return { docker, health, migrations };
  }

  async function applyMigrations() {
    try {
      const result = await runMigrations({ env, cwd, logger: log });
      const { error, ...rest } = result ?? {};
      return {
        ok: result?.ok !== false,
        ...rest,
        ...(error ? { error: sanitize(error) } : {}),
      };
    } catch (error) {
      return { ok: false, error: sanitize(error?.message ?? error) };
    }
  }

  async function status() {
    try {
      return await inspectStatus();
    } catch (error) {
      return {
        ok: false,
        mode: 'docker',
        composeFile: config.composeFile,
        docker: { cli: 'unknown', daemon: 'unknown', desktop: { installed: Boolean(resolveDesktopExe()) } },
        services: [],
        message: sanitize(error?.message ?? error),
      };
    }
  }

  function failure(action, error, extra = {}) {
    return {
      ok: false,
      action,
      error: sanitize(error?.message ?? error),
      ...extra,
    };
  }

  async function up({ migrate = true, timeoutMs } = {}) {
    const startedAt = now();
    try {
      const stack = await startStack({
        allowAutostart: config.autostart,
        shouldMigrate: migrate,
        timeoutMs,
      });
      const finalStatus = await inspectStatus();
      const ok = finalStatus.ok && (stack.migrations?.ok ?? true);
      return {
        ok,
        action: 'up',
        docker: finalStatus.docker,
        services: finalStatus.services,
        migrations: stack.migrations,
        durationMs: Math.max(0, now() - startedAt),
        message: ok
          ? 'Local services are ready.'
          : stack.migrations && stack.migrations.ok === false
            ? `Migration failed: ${stack.migrations.error ?? 'unknown error'}`
            : finalStatus.message,
      };
    } catch (error) {
      return failure('up', error, await bestEffortStatus());
    }
  }

  async function ensure({ migrate = true, timeoutMs } = {}) {
    const startedAt = now();
    try {
      const stack = await startStack({
        allowAutostart: config.autostart,
        shouldMigrate: migrate,
        timeoutMs,
      });
      const finalStatus = await inspectStatus();
      const ok = finalStatus.ok && (stack.migrations?.ok ?? true);
      return {
        ok,
        action: 'ensure',
        docker: finalStatus.docker,
        services: finalStatus.services,
        migrations: stack.migrations,
        durationMs: Math.max(0, now() - startedAt),
        message: ok
          ? 'Local services are ready.'
          : stack.migrations && stack.migrations.ok === false
            ? `Migration failed: ${stack.migrations.error ?? 'unknown error'}`
            : finalStatus.message,
      };
    } catch (error) {
      return failure('ensure', error, await bestEffortStatus());
    }
  }

  async function bestEffortStatus() {
    try {
      const current = await inspectStatus();
      return {
        docker: current.docker,
        services: current.services,
        statusMessage: current.message,
      };
    } catch {
      return {};
    }
  }

  async function down({ volumes = false } = {}) {
    try {
      const docker = await resolveDockerCli();
      if (!docker.found) throw new ServiceError('Docker CLI not found.', 'docker_missing');
      const args = ['down'];
      if (volumes) args.push('--volumes');
      const result = await runCompose(docker.path, args, { timeoutMs: 120_000 });
      if (result.code !== 0) {
        throw new ServiceError(
          `docker compose down failed (exit ${result.code}): ${sanitize(result.stderr || result.stdout)}`,
          'compose_down_failed',
        );
      }
      return {
        ok: true,
        action: 'down',
        volumes,
        message: volumes
          ? 'Services stopped and named volumes removed. Data is gone.'
          : 'Services stopped. Named volumes were kept.',
      };
    } catch (error) {
      return failure('down', error);
    }
  }

  async function logs({ service = null, tail = 200 } = {}) {
    try {
      if (service && !SERVICE_NAMES.includes(service)) {
        throw new ServiceUsageError(`Unknown service: ${service}. Expected one of ${SERVICE_NAMES.join(', ')}.`);
      }
      const docker = await resolveDockerCli();
      if (!docker.found) throw new ServiceError('Docker CLI not found.', 'docker_missing');
      const args = ['logs', '--no-color', '--tail', String(tail)];
      if (service) args.push(service);
      const result = await runCompose(docker.path, args, { timeoutMs: 60_000 });
      if (result.code !== 0) {
        throw new ServiceError(
          `docker compose logs failed (exit ${result.code}): ${sanitize(result.stderr)}`,
          'compose_logs_failed',
        );
      }
      return {
        ok: true,
        action: 'logs',
        service,
        tail,
        output: sanitize(result.stdout),
      };
    } catch (error) {
      return failure('logs', error);
    }
  }

  async function migrate({ status: statusOnly = false } = {}) {
    try {
      if (statusOnly) {
        const result = await readMigrationStatus({ env, cwd, logger: log });
        return { ...result, ok: result?.ok !== false, action: 'migrate-status' };
      }
      return { ...(await applyMigrations()), action: 'migrate' };
    } catch (error) {
      return failure('migrate', error);
    }
  }

  return {
    config,
    status,
    up,
    down,
    logs,
    migrate,
    ensure,
  };
}

export function parseServiceArgs(argv = []) {
  const flags = {
    json: false,
    noMigrate: false,
    volumes: false,
    status: false,
    service: null,
    tail: 200,
    timeoutMs: null,
    help: false,
  };
  const commands = new Set(['status', 'up', 'down', 'logs', 'migrate', 'ensure']);
  let command = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--no-migrate') flags.noMigrate = true;
    else if (arg === '--volumes') flags.volumes = true;
    else if (arg === '--status') flags.status = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--service') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new ServiceUsageError('--service requires a service name');
      if (!SERVICE_NAMES.includes(value)) {
        throw new ServiceUsageError(`Unknown service: ${value}. Expected one of ${SERVICE_NAMES.join(', ')}.`);
      }
      flags.service = value;
      index += 1;
    } else if (arg === '--tail') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new ServiceUsageError('--tail requires a line count');
      const tail = Number.parseInt(value, 10);
      if (!Number.isFinite(tail) || tail < 0) throw new ServiceUsageError('--tail must be a non-negative integer');
      flags.tail = tail;
      index += 1;
    } else if (arg === '--timeout') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new ServiceUsageError('--timeout requires milliseconds');
      const timeout = Number.parseInt(value, 10);
      if (!Number.isFinite(timeout) || timeout < 1000) {
        throw new ServiceUsageError('--timeout must be at least 1000 milliseconds');
      }
      flags.timeoutMs = timeout;
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new ServiceUsageError(`Unknown flag: ${arg}`);
    } else if (!command) {
      if (!commands.has(arg)) throw new ServiceUsageError(`Unknown command: ${arg}`);
      command = arg;
    } else {
      throw new ServiceUsageError(`Unexpected argument: ${arg}`);
    }
  }

  if (flags.help) return { command: 'help', flags };
  if (!command) throw new ServiceUsageError('Missing command.');

  if (flags.status && command !== 'migrate') {
    throw new ServiceUsageError('--status is only valid with `migrate` (or use `node scripts/db-migrate.mjs --status`).');
  }
  if (flags.volumes && command !== 'down') {
    throw new ServiceUsageError('--volumes is only valid with `down`.');
  }
  if ((flags.service || flags.tail !== 200) && command !== 'logs') {
    throw new ServiceUsageError('--service/--tail are only valid with `logs`.');
  }
  if ((flags.noMigrate || flags.timeoutMs) && !['up', 'ensure'].includes(command)) {
    throw new ServiceUsageError('--no-migrate/--timeout are only valid with `up` or `ensure`.');
  }

  return { command, flags };
}

const USAGE = `Usage: node scripts/services.mjs <command> [options]

Commands:
  status                 Probe Docker, containers, health, and bucket init
  up                     docker compose up -d, wait for health, then migrate
  down                   docker compose down (keeps named volumes unless --volumes)
  logs                   Show recent container logs (redacted)
  migrate                Apply pending PostgreSQL migrations
  migrate --status       Show migration status without changing anything
  ensure                 Autostart Docker Desktop if needed, then up + migrate

Options:
  --json                 Single machine-readable JSON result on stdout
  --no-migrate           up/ensure only: skip database migrations
  --timeout <ms>         up/ensure: health wait timeout (default 120000)
  --volumes              down: also delete named volumes (DESTRUCTIVE)
  --service <name>       logs: mova-db | mova-redis | mova-minio
  --tail <n>             logs: lines to show (default 200)
  --status               migrate: status only
  -h, --help             Show this help

Environment (see .env.example):
  MOVA_AUTOSTART_SERVICES, MOVA_SERVICE_HEALTH_TIMEOUT_MS, MOVA_DOCKER_START_TIMEOUT_MS,
  MOVA_DOCKER_CLI, MOVA_DOCKER_DESKTOP_PATH, MOVA_COMPOSE_FILE, MOVA_DB_URL

Exit codes:
  0  command succeeded (status: all services healthy)
  1  runtime failure (Docker missing/down, unhealthy service, migration error)
  2  usage error
`;

function formatStatus(result) {
  const lines = [];
  const docker = result.docker ?? {};
  lines.push(`Compose file : ${result.composeFile ?? '(unknown)'}`);
  lines.push(`Project      : ${result.project ?? '(unknown)'}`);
  lines.push(`Docker CLI   : ${docker.cli ?? 'unknown'}${docker.path ? ` (${docker.path})` : ''}`);
  lines.push(`Daemon       : ${docker.daemon ?? 'unknown'}`);
  lines.push(`Desktop app  : ${docker.desktop?.installed ? 'installed' : 'not found'}`);
  lines.push('');
  for (const service of result.services ?? []) {
    lines.push(
      `${service.name.padEnd(12)} ${String(service.state).padEnd(9)} ${String(service.health).padEnd(9)} ${service.port}`,
    );
  }
  if (result.migrations) {
    lines.push('');
    if (result.migrations.ok) {
      lines.push(
        `Migrations   : ${result.migrations.applied?.length ?? 0} applied this run, ${result.migrations.alreadyApplied ?? 0} already applied`,
      );
    } else {
      lines.push(`Migrations   : FAILED - ${result.migrations.error ?? 'unknown error'}`);
    }
  }
  lines.push('');
  lines.push(`Result       : ${result.ok ? 'ready' : 'not ready'}${result.message ? ` - ${result.message}` : ''}`);
  return `${lines.join('\n')}\n`;
}

function formatMigrations(result) {
  if (result.action === 'migrate-status' || Array.isArray(result.rows)) {
    const lines = [
      `Database : ${result.database ?? '(unknown)'}`,
      `Ledger   : ${result.ledger ?? 'unknown'}`,
      `Applied  : ${result.applied?.length ?? 0}`,
      `Pending  : ${result.pending?.length ?? 0}`,
    ];
    for (const row of result.rows ?? []) lines.push(`  ${String(row.status).padEnd(8)} ${row.filename}`);
    if (result.changed?.length) lines.push(`Changed  : ${result.changed.join(', ')}`);
    if (result.missing?.length) lines.push(`Missing  : ${result.missing.join(', ')}`);
    return `${lines.join('\n')}\n`;
  }
  if (!result.ok) return `Migration FAILED: ${result.error ?? 'unknown error'}\n`;
  if (result.applied?.length) {
    return `Applied ${result.applied.length} migration(s):\n${result.applied.map((name) => `  ${name}`).join('\n')}\n`;
  }
  return `Database is up to date (${result.alreadyApplied ?? 0} migration(s)).\n`;
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = DEFAULT_ROOT,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  createManager = createServicesManager,
  ...managerDeps
} = {}) {
  let parsed;
  try {
    parsed = parseServiceArgs(argv);
  } catch (error) {
    stderr(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.command === 'help') {
    stdout(USAGE);
    return 0;
  }

  const cliEnv = { ...env };
  loadDotEnv(path.join(cwd, '.env'), cliEnv);
  const manager = createManager({ ...managerDeps, env: cliEnv, cwd });

  let result;
  try {
    switch (parsed.command) {
      case 'status':
        result = await manager.status();
        break;
      case 'up':
        result = await manager.up({ migrate: !parsed.flags.noMigrate, timeoutMs: parsed.flags.timeoutMs ?? undefined });
        break;
      case 'down':
        result = await manager.down({ volumes: parsed.flags.volumes });
        break;
      case 'logs':
        result = await manager.logs({ service: parsed.flags.service, tail: parsed.flags.tail });
        break;
      case 'migrate':
        result = await manager.migrate({ status: parsed.flags.status });
        break;
      case 'ensure':
        result = await manager.ensure({ migrate: !parsed.flags.noMigrate, timeoutMs: parsed.flags.timeoutMs ?? undefined });
        break;
      default:
        throw new ServiceUsageError(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    result = { ok: false, error: redactSecrets(error?.message ?? error) };
  }

  if (parsed.flags.json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else if (parsed.command === 'logs') {
    stdout(result.ok ? `${result.output}\n` : `Logs failed: ${result.error}\n`);
  } else if (parsed.command === 'migrate') {
    stdout(formatMigrations(result));
  } else if (parsed.command === 'down') {
    stdout(`${result.ok ? result.message : `Down failed: ${result.error}`}\n`);
  } else {
    stdout(formatStatus(result));
    if (!result.ok && result.error) stdout(`Error: ${result.error}\n`);
  }

  return result?.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${redactSecrets(error?.stack ?? error)}\n`);
      process.exitCode = 1;
    });
}
