'use strict';

/**
 * Physical base backups + WAL archiving + restore-to-new-cluster for Mova.
 *
 * Contract: Mova服务版接口约定.md §9 (“WAL/PITR 作为后续增强，但文档/设置必须明确状态”),
 * dev doc §11.3 (RPO/RTO targets, monthly restore drill) and §13 V3.
 *
 * What this module actually does — nothing is reported as done unless files and
 * command output prove it:
 *  - Reads the local PostgreSQL container's real configuration and state:
 *    `archive_mode`, `archive_timeout`, `wal_level`, `wal_segment_size`,
 *    `pg_stat_archiver`, the host WAL archive directory, and the base-backup
 *    metadata on disk.
 *  - Takes physical base backups with `pg_basebackup` **inside** the database
 *    container (plain format, `-X stream`, SHA256 manifest) writing into the
 *    host bind mount `/base-backups` → `<project>/.mova-backups/base`, then
 *    verifies them with `pg_verifybackup`. Metadata JSON + checksums live next
 *    to the data. Existing backups are never deleted or overwritten.
 *  - Restores one base backup into a **brand-new** cluster: new data
 *    directory/volume, new container name, new port, then replays archived WAL
 *    through `restore_command` (the standard PostgreSQL mechanism) until the
 *    requested recovery target or the end of WAL, and promotes. The live
 *    `mova-db` container and its data volume are never written, stopped or
 *    removed; every destructive helper refuses to touch them.
 *  - Refuses to claim point-in-time recovery until a restore has actually run
 *    and been verified: `status().capabilities.pointInTimeRecovery` stays false
 *    until a verified restore record exists on disk.
 *
 * Dependencies are injected (`runner`, `fs`, `now`, `clock`, `dockerBin`), so
 * tests run with fakes and never start Docker. Passwords never appear on a
 * command line and are redacted from every error/log string.
 */

const fsDefaults = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnRunner, connectionEnv, redact, safeError } = require('./backup.cjs');

/** Container-side mount points (see docker-compose.yml). */
const WAL_MOUNT = '/wal-archive';
const BASE_MOUNT = '/base-backups';
const DATA_MOUNT = '/var/lib/postgresql/data';
/** Paths inside the disposable restore containers. */
const RESTORE_WAL = '/wal';
const RESTORE_BASE = '/base';
const RESTORE_TARGET = '/target';
const RESTORE_WORK = '/work';

const DEFAULT_CONTAINER = 'mova-db';
const DEFAULT_IMAGE = 'pgvector/pgvector:pg16';
const DEFAULT_DB_PORT = 55432;
const MAX_LABEL_LENGTH = 64;
const DEFAULT_BASE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RESTORE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_MS = 180_000;
const RESTORE_POLL_MS = 1_000;
/** Separator for the multi-field `docker inspect --format` payload. */
const INSPECT_SEPARATOR = '@@MOVA-PITR-SEP@@';

/** `000000010000000000000003`, `00000002.history`, `....backup`. */
const WAL_SEGMENT_PATTERN = /^[0-9A-F]{24}$/;
const WAL_SPECIAL_PATTERN = /^[0-9A-F]{24}\.(backup|partial)$/;
const WAL_HISTORY_PATTERN = /^[0-9A-F]{8}\.history$/;
const BASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
const LSN_PATTERN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
const RESTORE_POINT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/**
 * Shell script executed inside a one-shot container to lay down the base backup
 * and the recovery configuration. Written to a file (not `sh -c`) so Windows
 * argument quoting cannot corrupt it, and kept in the restore workspace as an
 * audit artifact.
 */
const PREPARE_SCRIPT = `#!/bin/sh
# Written by electron/services/pitr.cjs. Copies one plain-format base backup
# into an EMPTY target directory and configures archive recovery.
# It never deletes data and never touches the live cluster.
set -eu
: "\${MOVA_PITR_SRC:?MOVA_PITR_SRC missing}"
: "\${MOVA_PITR_TARGET:?MOVA_PITR_TARGET missing}"
: "\${MOVA_PITR_WAL:?MOVA_PITR_WAL missing}"
if [ -f "$MOVA_PITR_TARGET/PG_VERSION" ]; then
  echo "target already contains a PostgreSQL cluster" >&2
  exit 3
fi
if [ ! -f "$MOVA_PITR_SRC/PG_VERSION" ]; then
  echo "base backup is incomplete (no PG_VERSION)" >&2
  exit 4
fi
cp -a "$MOVA_PITR_SRC/." "$MOVA_PITR_TARGET/"
: > "$MOVA_PITR_TARGET/recovery.signal"
{
  printf "restore_command = 'cp %s/%%f %%p'\\n" "$MOVA_PITR_WAL"
  if [ -n "\${MOVA_PITR_TARGET_TIME:-}" ]; then printf "recovery_target_time = '%s'\\n" "$MOVA_PITR_TARGET_TIME"; fi
  if [ -n "\${MOVA_PITR_TARGET_NAME:-}" ]; then printf "recovery_target_name = '%s'\\n" "$MOVA_PITR_TARGET_NAME"; fi
  if [ -n "\${MOVA_PITR_TARGET_LSN:-}" ]; then printf "recovery_target_lsn = '%s'\\n" "$MOVA_PITR_TARGET_LSN"; fi
  if [ -n "\${MOVA_PITR_TARGET_IMMEDIATE:-}" ]; then printf "recovery_target = 'immediate'\\n"; fi
  if [ -n "\${MOVA_PITR_TARGET_ACTION:-}" ]; then printf "recovery_target_action = '%s'\\n" "$MOVA_PITR_TARGET_ACTION"; fi
} >> "$MOVA_PITR_TARGET/postgresql.auto.conf"
chown -R postgres:postgres "$MOVA_PITR_TARGET"
chmod 700 "$MOVA_PITR_TARGET"
echo "MOVA_PITR_PREPARED"
`;

class PitrError extends Error {
  constructor(code, detail, hint) {
    super(code);
    this.name = 'PitrError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    if (hint !== undefined) this.hint = hint;
  }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function timestampSlug(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Normalize a host path for comparison (case-insensitive on Windows). */
function normalizeHostPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right, platform = process.platform) {
  const a = normalizeHostPath(left, platform);
  return Boolean(a) && a === normalizeHostPath(right, platform);
}

/** True when `child` is `parent` or lives underneath it. */
function isInside(child, parent, platform = process.platform) {
  const inner = normalizeHostPath(child, platform);
  const outer = normalizeHostPath(parent, platform);
  if (!inner || !outer) return false;
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}

/**
 * Map a docker-reported mount source back to a host path. Docker Desktop
 * reports bind mounts as VM-internal paths such as
 * `/run/desktop/mnt/host/c/Users/x/...`, which is not a usable Windows path.
 */
function hostPathFromDockerSource(source, platform = process.platform) {
  if (typeof source !== 'string' || !source) return '';
  const match = /^\/(?:run\/desktop\/mnt\/host|host_mnt|mnt\/host)\/([a-zA-Z])(\/.*)?$/.exec(source);
  if (match && platform === 'win32') {
    const drive = match[1].toUpperCase();
    return `${drive}:${(match[2] ?? '\\').replace(/\//g, '\\')}`;
  }
  if (match) {
    // A Linux host with a drive-letter path is unlikely; keep the original.
    return source;
  }
  return source;
}

/**
 * Pick a docker executable. An explicit `MOVA_DOCKER_CLI` always wins; on
 * Windows the Docker Desktop install locations are checked because Electron
 * does not always inherit an updated PATH.
 */
function resolveDockerBin({ env = process.env, platform = process.platform, existsSync } = {}) {
  if (env.MOVA_DOCKER_CLI) return env.MOVA_DOCKER_CLI;
  const candidates = [];
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || env.ProgramW6432 || 'C:\\Program Files';
    if (programFiles) candidates.push(path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'));
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'));
  }
  if (typeof existsSync === 'function') {
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'docker';
}

/**
 * Parse a recovery target. Accepts an ISO timestamp string (time target) or an
 * object `{type:'time'|'name'|'lsn'|'immediate', value?}`. Anything else is
 * rejected instead of being silently ignored.
 */
function parseRecoveryTarget(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input === 'string') {
    const value = input.trim();
    if (!ISO_TIME_PATTERN.test(value)) throw new PitrError('invalid-recovery-target', 'expected an ISO-8601 timestamp');
    const parsed = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) throw new PitrError('invalid-recovery-target', 'unparsable timestamp');
    return { type: 'time', value: parsed.toISOString() };
  }
  if (!isObject(input)) throw new PitrError('invalid-recovery-target', 'expected a string or object');
  const type = input.type;
  if (type === 'immediate') return { type: 'immediate', value: null };
  const value = typeof input.value === 'string' ? input.value.trim() : '';
  if (type === 'time') return parseRecoveryTarget(value);
  if (type === 'name') {
    if (!RESTORE_POINT_PATTERN.test(value)) throw new PitrError('invalid-recovery-target', 'invalid restore point name');
    return { type: 'name', value };
  }
  if (type === 'lsn') {
    if (!LSN_PATTERN.test(value)) throw new PitrError('invalid-recovery-target', 'invalid LSN');
    return { type: 'lsn', value: value.toUpperCase() };
  }
  throw new PitrError('invalid-recovery-target', 'type must be time, name, lsn or immediate');
}

function describeRecoveryTarget(target) {
  if (!target) return null;
  return target.type === 'immediate' ? { type: 'immediate' } : { type: target.type, value: target.value };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeLogger(logger) {
  const noop = () => {};
  return {
    debug: typeof logger?.debug === 'function' ? logger.debug.bind(logger) : noop,
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : noop,
  };
}

function emptyArchive() {
  return {
    dir: null, files: 0, segments: 0, bytes: 0,
    latest: null, latestAt: null, earliestAt: null, error: null,
  };
}

/**
 * @param {object} options
 * @param {string} [options.dockerBin] defaults to MOVA_DOCKER_CLI or Docker Desktop
 * @param {string} [options.container='mova-db'] live database container
 * @param {string} [options.databaseUrl] defaults to MOVA_DB_URL
 * @param {string} [options.backupDir] root for base backups/WAL/restore records
 * @param {(spec: object) => Promise<{code: number|null, stdout?: string, stderr?: string, timedOut?: boolean}>} [options.runner]
 * @param {Function} [options.now] audit clock (`() => Date`)
 * @param {Function} [options.clock] monotonic-ish clock for timeouts (`() => ms`)
 * @param {Function} [options.sleep] injectable delay for readiness polling
 * @param {object} [options.fs] node:fs/promises-compatible
 * @param {object} [options.env]
 * @param {string} [options.image] image used for restore containers
 * @param {string} [options.network] docker network for restore containers
 * @param {string} [options.platform]
 * @param {object} [options.logger]
 * @param {number} [options.timeoutMs] base backup timeout
 * @param {number} [options.waitMs] restore readiness timeout
 * @param {boolean} [options.verifyBaseBackup=true] run pg_verifybackup after a backup
 */
function createPitrService(options = {}) {
  if (!isObject(options)) throw new PitrError('invalid-options');
  const env = options.env || process.env;
  const io = options.fs || fsDefaults;
  const platform = options.platform || process.platform;
  const logger = normalizeLogger(options.logger);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const runner = typeof options.runner === 'function' ? options.runner : spawnRunner;

  const container = options.container || DEFAULT_CONTAINER;
  if (typeof container !== 'string' || !container.trim()) throw new PitrError('invalid-container');

  const dockerBin = options.dockerBin
    || env.MOVA_DOCKER_CLI
    || resolveDockerBin({ env, platform, existsSync: options.existsSync });
  if (typeof dockerBin !== 'string' || !dockerBin.trim()) throw new PitrError('docker-bin-missing');

  const image = options.image || env.MOVA_PITR_IMAGE || DEFAULT_IMAGE;
  const databaseUrl = options.databaseUrl === undefined ? env.MOVA_DB_URL || '' : options.databaseUrl;

  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : path.resolve(__dirname, '..', '..');
  const backupDir = path.resolve(options.backupDir || env.MOVA_BACKUPS_DIR || path.join(projectRoot, '.mova-backups'));
  const configuredBaseDir = path.resolve(options.baseDir || path.join(backupDir, 'base'));
  const configuredArchiveDir = path.resolve(options.archiveDir || path.join(backupDir, 'wal'));
  const restoresDir = path.join(backupDir, 'restores');

  const baseTimeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_BASE_TIMEOUT_MS;
  const prepareTimeoutMs = Number.isInteger(options.prepareTimeoutMs) && options.prepareTimeoutMs > 0
    ? options.prepareTimeoutMs
    : DEFAULT_RESTORE_TIMEOUT_MS;
  const waitMs = Number.isInteger(options.waitMs) && options.waitMs > 0 ? options.waitMs : DEFAULT_WAIT_MS;
  const verifyBaseBackup = options.verifyBaseBackup !== false;
  const networkOverride = typeof options.network === 'string' && options.network.trim() ? options.network.trim() : null;

  function currentDate() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new PitrError('invalid-clock');
    return date;
  }

  function connection() {
    if (!databaseUrl) throw new PitrError('database-url-missing', undefined, 'set MOVA_DB_URL');
    try {
      return connectionEnv(databaseUrl, env);
    } catch (error) {
      throw new PitrError('invalid-database-url', safeError(error));
    }
  }

  function livePort() {
    try {
      const value = Number.parseInt(connection().port, 10);
      return Number.isFinite(value) && value > 0 ? value : DEFAULT_DB_PORT;
    } catch {
      return DEFAULT_DB_PORT;
    }
  }

  function delay(ms) {
    if (typeof options.sleep === 'function') return options.sleep(ms);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Run docker, mapping spawn failures to a stable error code. */
  async function docker(args, { timeoutMs = 60_000, extraEnv = null } = {}) {
    const spec = {
      command: dockerBin,
      args,
      cwd: projectRoot,
      timeoutMs,
      ...(extraEnv ? { env: { ...env, ...extraEnv } } : {}),
    };
    let result;
    try {
      result = await runner(spec);
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 'docker-not-found' : 'docker-unavailable';
      throw new PitrError(
        code,
        safeError(error),
        code === 'docker-not-found'
          ? 'install Docker Desktop or set MOVA_DOCKER_CLI to the docker executable'
          : 'check that the Docker daemon is running',
      );
    }
    if (!result || typeof result.code !== 'number') throw new PitrError('docker-unavailable', 'docker produced no exit code');
    return {
      code: result.code,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      timedOut: Boolean(result.timedOut),
    };
  }

  /**
   * `docker inspect` facts, requested through a compact Go template: the full
   * JSON of a container is larger than the bounded runner capture, and this
   * also keeps exactly the fields we use.
   */
  async function inspectLive() {
    const format = [
      '{{json .State}}',
      '{{json .Mounts}}',
      '{{json .NetworkSettings.Networks}}',
      '{{.Config.Image}}',
    ].join(INSPECT_SEPARATOR);
    const result = await docker(['inspect', '--format', format, container]);
    if (result.code !== 0) return { ok: false, error: safeError(result.stderr || `docker inspect exited ${result.code}`) };
    const parts = String(result.stdout ?? '').trim().split(INSPECT_SEPARATOR);
    if (parts.length < 4) return { ok: false, error: 'cannot parse docker inspect output' };
    try {
      const [state, mounts, networks, imageName] = parts;
      return {
        ok: true,
        inspect: {
          State: JSON.parse(state),
          Mounts: JSON.parse(mounts),
          NetworkSettings: { Networks: JSON.parse(networks) },
          Config: { Image: imageName },
        },
      };
    } catch (error) {
      return { ok: false, error: `cannot parse docker inspect output: ${safeError(error)}` };
    }
  }

  function mountsOf(inspect) {
    const mounts = new Map();
    for (const mount of Array.isArray(inspect?.Mounts) ? inspect.Mounts : []) {
      if (mount?.Destination) mounts.set(mount.Destination, mount);
    }
    return mounts;
  }

  function liveDataVolume(inspect) {
    const mount = mountsOf(inspect).get(DATA_MOUNT);
    if (!mount) return null;
    return { type: mount.Type || 'volume', name: mount.Name || null, source: mount.Source || null };
  }

  /**
   * Effective host directories + whether the container really sees them.
   *
   * `docker inspect` mount sources cannot be trusted as host paths (Docker
   * Desktop reports `/run/desktop/mnt/host/...` style paths), so the written
   * directories are the configured ones and the link is *proven* by having the
   * container create a probe file that we then look for on the host. That also
   * proves the `postgres` user (uid 999) can write there, which is exactly what
   * archiving and pg_basebackup need.
   */
  const identityCache = new Map();
  async function checkMountIdentity(directory, mountPoint, key) {
    const cached = identityCache.get(key);
    if (cached && clock() - cached.at < 30_000) return cached.value;
    const token = `.mova-pitr-probe-${crypto.randomBytes(4).toString('hex')}`;
    let ok = false;
    try {
      const created = await docker([
        'exec', '-u', 'postgres', container, 'sh', '-c', `touch ${mountPoint}/${token}`,
      ], { timeoutMs: 20_000 });
      if (created.code === 0) {
        ok = Boolean(await statSafe(path.join(directory, token)));
        await docker(['exec', '-u', 'postgres', container, 'sh', '-c', `rm -f ${mountPoint}/${token}`], {
          timeoutMs: 20_000,
        }).catch(() => null);
      }
    } catch {
      ok = false;
    }
    identityCache.set(key, { at: clock(), value: ok });
    return ok;
  }

  function layoutFor(inspect) {
    const mounts = mountsOf(inspect);
    const baseMount = mounts.get(BASE_MOUNT) || null;
    const walMount = mounts.get(WAL_MOUNT) || null;
    const network = networkOverride
      || Object.keys(inspect?.NetworkSettings?.Networks ?? {})[0]
      || null;
    return {
      baseDir: configuredBaseDir,
      archiveDir: configuredArchiveDir,
      baseMountOk: Boolean(baseMount?.Source),
      archiveMountOk: Boolean(walMount?.Source),
      baseMountVerified: false,
      archiveMountVerified: false,
      // Docker Desktop reports VM-internal mount sources; map them back so a
      // matching directory can be trusted without a write probe.
      baseMountMatches: Boolean(baseMount?.Source)
        && samePath(hostPathFromDockerSource(baseMount.Source, platform), configuredBaseDir, platform),
      archiveMountMatches: Boolean(walMount?.Source)
        && samePath(hostPathFromDockerSource(walMount.Source, platform), configuredArchiveDir, platform),
      liveVolume: liveDataVolume(inspect),
      network,
      running: Boolean(inspect?.State?.Running),
      image: inspect?.Config?.Image || image,
    };
  }

  const fallbackLayout = () => ({
    baseDir: configuredBaseDir,
    archiveDir: configuredArchiveDir,
    baseMountOk: false,
    archiveMountOk: false,
    baseMountVerified: false,
    archiveMountVerified: false,
    baseMountMatches: false,
    archiveMountMatches: false,
    liveVolume: null,
    network: networkOverride,
    running: false,
    image,
  });

  /** Layout when the container is reachable, otherwise the configured paths. */
  async function resolveLayout() {
    const inspected = await inspectLive().catch(error => ({ ok: false, error: safeError(error) }));
    if (!inspected.ok) return { ...fallbackLayout(), inspectOk: false, inspect: null, error: inspected.error ?? 'docker unavailable' };
    const layout = layoutFor(inspected.inspect);
    if (layout.running && layout.archiveMountOk) {
      layout.archiveMountVerified = layout.archiveMountMatches
        || await checkMountIdentity(configuredArchiveDir, WAL_MOUNT, 'wal');
    }
    if (layout.running && layout.baseMountOk) {
      layout.baseMountVerified = layout.baseMountMatches
        || await checkMountIdentity(configuredBaseDir, BASE_MOUNT, 'base');
    }
    return { ...layout, inspectOk: true, inspect: inspected.inspect, error: null };
  }

  async function readDirSafe(directory, entriesOptions = { withFileTypes: true }) {
    try {
      return await io.readdir(directory, entriesOptions);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
      throw error;
    }
  }

  async function statSafe(target) {
    try {
      return await io.stat(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Scan the WAL archive directory. Never throws. */
  async function scanArchive(directory) {
    const summary = { ...emptyArchive(), dir: directory };
    let entries;
    try {
      entries = await readDirSafe(directory);
    } catch (error) {
      summary.error = safeError(error);
      return summary;
    }
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const isFile = typeof entry === 'string' ? true : Boolean(entry.isFile?.());
      if (!name || !isFile) continue;
      if (!WAL_SEGMENT_PATTERN.test(name) && !WAL_SPECIAL_PATTERN.test(name) && !WAL_HISTORY_PATTERN.test(name)) continue;
      let stat;
      try {
        stat = await io.stat(path.join(directory, name));
      } catch {
        continue;
      }
      summary.files += 1;
      summary.bytes += Number(stat.size) || 0;
      if (WAL_SEGMENT_PATTERN.test(name)) summary.segments += 1;
      const stamp = stat.mtime instanceof Date ? stat.mtime.getTime() : null;
      if (stamp !== null) {
        if (!summary.latestAt || stamp > new Date(summary.latestAt).getTime()) {
          summary.latestAt = stat.mtime.toISOString();
          summary.latest = name;
        }
        if (!summary.earliestAt || stamp < new Date(summary.earliestAt).getTime()) {
          summary.earliestAt = stat.mtime.toISOString();
        }
      }
    }
    return summary;
  }

  async function listWalFiles(directory) {
    const entries = await readDirSafe(directory);
    return entries
      .map(entry => (typeof entry === 'string' ? { name: entry, isFile: () => true } : entry))
      .filter(entry => Boolean(entry.isFile?.()))
      .map(entry => entry.name)
      .filter(name => WAL_SEGMENT_PATTERN.test(name) || WAL_HISTORY_PATTERN.test(name));
  }

  async function readJson(target) {
    try {
      return JSON.parse(await io.readFile(target, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return { __error: safeError(error) };
    }
  }

  async function writeJson(target, value) {
    await io.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.tmp`;
    await io.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await io.rename(temp, target);
  }

  /** Metadata file for a backup id: `<baseDir>/<id>.json` (sibling of the data). */
  function metadataPath(baseDir, id) {
    return path.join(baseDir, `${id}.json`);
  }

  function normalizeBaseRecord(raw, baseDir) {
    return {
      id: raw.id,
      label: raw.label ?? null,
      status: raw.status ?? 'completed',
      createdAt: toIso(raw.createdAt),
      completedAt: toIso(raw.completedAt),
      durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : null,
      path: raw.path ? path.resolve(baseDir, raw.id) : path.join(baseDir, raw.id),
      bytes: Number.isFinite(raw.bytes) ? raw.bytes : null,
      fileCount: Number.isFinite(raw.fileCount) ? raw.fileCount : null,
      checksum: raw.checksum ?? null,
      verified: raw.verified === true,
      verifiedAt: toIso(raw.verifiedAt),
      verifyMethod: raw.verifyMethod ?? null,
      verifyError: raw.verifyError ?? null,
      format: raw.format ?? 'plain',
      container: raw.container ?? null,
      image: raw.image ?? null,
      database: raw.database ?? null,
      error: raw.error ?? null,
    };
  }

  async function listBaseBackupsIn(baseDir, { limit = 50 } = {}) {
    const max = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 50;
    const entries = await readDirSafe(baseDir);
    const records = [];
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!name || !name.endsWith('.json')) continue;
      if (name.startsWith('.')) continue;
      if (typeof entry !== 'string' && !entry.isFile?.()) continue;
      const raw = await readJson(path.join(baseDir, name));
      if (!raw || raw.__error || !raw.id) continue;
      records.push(normalizeBaseRecord(raw, baseDir));
    }
    records.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
    return records.slice(0, max);
  }

  async function listBaseBackups(input = {}) {
    const layout = await resolveLayout();
    return listBaseBackupsIn(layout.baseDir, input);
  }

  async function getBaseBackup(id, baseDir = configuredBaseDir) {
    if (typeof id !== 'string' || !BASE_ID_PATTERN.test(id.trim())) throw new PitrError('invalid-base-backup-id', String(id));
    const raw = await readJson(metadataPath(baseDir, id.trim()));
    if (!raw) throw new PitrError('base-backup-not-found', id);
    if (raw.__error) throw new PitrError('base-backup-metadata-invalid', raw.__error);
    return normalizeBaseRecord(raw, baseDir);
  }

  async function nextBaseId(baseDir, date) {
    const stem = `base-${timestampSlug(date)}`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? stem : `${stem}-${attempt + 1}`;
      const data = await statSafe(path.join(baseDir, candidate));
      const meta = await statSafe(metadataPath(baseDir, candidate));
      if (!data && !meta) return candidate;
    }
    throw new PitrError('base-backup-dir-unavailable', 'cannot find a free base backup directory name');
  }

  /** Resolve a container-side tool (pg_verifybackup/pg_waldump) to an absolute path. */
  const toolCache = new Map();
  async function containerTool(name) {
    if (toolCache.has(name)) return toolCache.get(name);
    const result = await docker([
      'exec', container, 'sh', '-c',
      `command -v ${name} 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/${name} 2>/dev/null | tail -n 1`,
    ], { timeoutMs: 20_000 });
    const located = result.code === 0
      ? String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() || null
      : null;
    toolCache.set(name, located);
    return located;
  }

  /** One psql round trip with all archive facts; null config when unavailable. */
  async function probePostgres() {
    let connectionInfo;
    try {
      connectionInfo = connection();
    } catch (error) {
      return { ok: false, error: safeError(error), config: null, archiver: null };
    }
    const sql = [
      "select 'config', current_setting('archive_mode'), current_setting('archive_timeout'),",
      "current_setting('wal_level'), current_setting('wal_segment_size'), current_setting('server_version')",
      'union all',
      "select 'archiver', archived_count::text, failed_count::text,",
      "coalesce(last_archived_time::text, ''), coalesce(last_failed_time::text, ''), coalesce(last_archived_wal, '')",
      'from pg_stat_archiver',
    ].join(' ');
    const args = [
      'exec', '-e', 'PGPASSWORD', '-u', 'postgres', container, 'psql',
      '-U', connectionInfo.env.PGUSER || 'postgres',
      '-d', connectionInfo.database,
      '-A', '-t', '-F', '|', '-c', sql,
    ];
    const result = await docker(args, {
      timeoutMs: 30_000,
      extraEnv: connectionInfo.env.PGPASSWORD ? { PGPASSWORD: connectionInfo.env.PGPASSWORD } : null,
    });
    if (result.code !== 0) {
      return { ok: false, error: safeError(result.stderr || `psql exited ${result.code}`), config: null, archiver: null };
    }
    const config = {};
    const archiver = {};
    for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [kind, ...rest] = line.split('|');
      if (kind === 'config') {
        [config.archiveMode, config.archiveTimeout, config.walLevel, config.walSegmentSize, config.serverVersion] = rest;
      } else if (kind === 'archiver') {
        [archiver.archivedCount, archiver.failedCount, archiver.lastArchivedAt, archiver.lastFailedAt, archiver.lastArchivedWal] = rest;
      }
    }
    if (config.archiveMode === undefined) {
      return { ok: false, error: 'unexpected psql output', config: null, archiver: null };
    }
    archiver.archivedCount = Number(archiver.archivedCount ?? 0);
    archiver.failedCount = Number(archiver.failedCount ?? 0);
    archiver.lastArchivedAt = toIso(archiver.lastArchivedAt);
    archiver.lastFailedAt = toIso(archiver.lastFailedAt);
    archiver.lastArchivedWal = archiver.lastArchivedWal || null;
    return { ok: true, error: null, config, archiver };
  }

  function buildCapabilities({ inspectOk, running, layout, archiveMode, archive, backups, restores }) {
    const completed = (backups ?? []).filter(record => record.status === 'completed');
    const verifiedRestore = (restores ?? []).find(record => record.status === 'completed' && record.verified === true) ?? null;
    const walArchiving = Boolean(inspectOk && running && archiveMode === 'on' && layout.archiveMountOk && layout.archiveMountVerified);
    const baseBackup = Boolean(inspectOk && running && layout.baseMountOk && layout.baseMountVerified);
    const restoreToNewCluster = Boolean(baseBackup && walArchiving && completed.length > 0);
    const pointInTimeRecovery = Boolean(
      walArchiving && baseBackup && (archive?.files ?? 0) > 0 && completed.length > 0 && verifiedRestore,
    );
    const reasons = {};
    if (!inspectOk) reasons.all = 'docker container unreachable';
    else if (!running) reasons.all = `container ${container} is not running`;
    else {
      if (!layout.archiveMountOk) reasons.walArchiving = `container has no ${WAL_MOUNT} mount (recreate it with docker compose up -d)`;
      else if (!layout.archiveMountVerified) reasons.walArchiving = `${WAL_MOUNT} is not the configured directory ${configuredArchiveDir} (set MOVA_BACKUPS_DIR to match the compose bind mount)`;
      else if (archiveMode !== 'on') reasons.walArchiving = `archive_mode is ${archiveMode ?? 'unknown'}`;
      if (!layout.baseMountOk) reasons.baseBackup = `container has no ${BASE_MOUNT} mount`;
      else if (!layout.baseMountVerified) reasons.baseBackup = `${BASE_MOUNT} is not the configured directory ${configuredBaseDir}`;
      if (baseBackup && completed.length === 0) reasons.restoreToNewCluster = 'no completed base backup';
      if (!restoreToNewCluster && walArchiving === false) reasons.restoreToNewCluster = reasons.walArchiving;
      if (!pointInTimeRecovery) {
        if (!walArchiving) reasons.pointInTimeRecovery = reasons.walArchiving || 'WAL archiving is not active';
        else if ((archive?.files ?? 0) === 0) reasons.pointInTimeRecovery = 'WAL archive is empty';
        else if (completed.length === 0) reasons.pointInTimeRecovery = 'no completed base backup';
        else if (!verifiedRestore) reasons.pointInTimeRecovery = 'no verified restore has been recorded yet (run node scripts/pitr.mjs restore ...)';
      }
    }
    return {
      walArchiving,
      pointInTimeRecovery,
      baseBackup,
      restoreToNewCluster,
      verifiedRestoreId: verifiedRestore?.restoreId ?? null,
      verifiedRestoreAt: verifiedRestore?.completedAt ?? null,
      reasons,
      note: '能力按实际文件与配置计算；pointInTimeRecovery 只有在完成一次经过验证的恢复到新集群后才为 true。',
    };
  }

  async function readRestoreRecords({ limit = 20 } = {}) {
    const entries = await readDirSafe(restoresDir);
    const records = [];
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!name || name.startsWith('.')) continue;
      if (typeof entry !== 'string' && !entry.isDirectory?.()) continue;
      const raw = await readJson(path.join(restoresDir, name, 'restore.json'));
      if (!raw || raw.__error) continue;
      records.push({
        restoreId: raw.restoreId ?? name,
        status: raw.status ?? 'unknown',
        baseBackupId: raw.baseBackupId ?? null,
        recoveryTarget: raw.recoveryTarget ?? null,
        container: raw.container ?? null,
        port: raw.port ?? null,
        target: raw.target ?? null,
        verified: raw.verified === true,
        startedAt: toIso(raw.startedAt),
        completedAt: toIso(raw.completedAt),
        error: raw.error ?? null,
        evidence: raw.evidence ?? null,
      });
    }
    records.sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')));
    return records.slice(0, limit);
  }

  /** Status snapshot for the settings page / CLI. Never throws. */
  async function status() {
    const base = {
      module: 'pitr',
      container,
      backupDir,
      baseDir: configuredBaseDir,
      archiveDir: configuredArchiveDir,
      database: redact(databaseUrl) || null,
      docker: { bin: dockerBin, ok: false, error: null },
      containerState: { running: false, image: null, dataVolume: null, mounts: { wal: null, base: null }, network: null },
      wal: { ...emptyArchive(), archiveMode: null, archiveTimeout: null, walLevel: null, segmentSize: null, serverVersion: null, mountOk: false },
      archiver: null,
      baseBackups: [],
      baseBackupCount: 0,
      failedBaseBackupCount: 0,
      lastBaseBackup: null,
      restores: [],
      lastRestore: null,
      capabilities: buildCapabilities({
        inspectOk: false, running: false, layout: {}, archiveMode: null, archive: emptyArchive(), backups: [], restores: [],
      }),
      warnings: [],
      error: null,
      checkedAt: currentDate().toISOString(),
    };

    const layout = await resolveLayout();
    base.archiveDir = layout.archiveDir;
    base.baseDir = layout.baseDir;

    // Filesystem facts are readable even when Docker is unavailable, so the
    // settings page still shows what exists on disk.
    const archive = await scanArchive(layout.archiveDir);
    const backups = await listBaseBackupsIn(layout.baseDir, { limit: 500 }).catch(error => {
      base.warnings.push('base-backup-list-failed');
      logger.warn?.('pitr.base-list-failed', { message: safeError(error) });
      return [];
    });
    const restores = await readRestoreRecords().catch(() => []);
    base.baseBackups = backups;
    base.baseBackupCount = backups.filter(record => record.status === 'completed').length;
    base.failedBaseBackupCount = backups.filter(record => record.status !== 'completed').length;
    base.lastBaseBackup = backups.find(record => record.status === 'completed') ?? null;
    base.restores = restores;
    base.lastRestore = restores[0] ?? null;
    base.wal = { ...archive, mountOk: layout.archiveMountOk };

    if (!layout.inspectOk) {
      base.docker.error = layout.error;
      base.error = layout.error;
      base.warnings.push('docker-inspect-failed');
      if (base.baseBackupCount === 0) base.warnings.push('no-base-backup');
      if (!restores.some(record => record.status === 'completed' && record.verified)) base.warnings.push('pitr-not-verified');
      return base;
    }
    base.docker.ok = true;
    base.containerState = {
      running: layout.running,
      image: layout.image,
      dataVolume: layout.liveVolume,
      mounts: {
        wal: layout.archiveMountOk ? layout.archiveDir : null,
        base: layout.baseMountOk ? layout.baseDir : null,
      },
      network: layout.network,
    };

    let probe = { ok: false, error: null, config: null, archiver: null };
    if (layout.running) {
      probe = await probePostgres();
      if (!probe.ok) base.warnings.push('postgres-probe-failed');
    } else {
      base.warnings.push('container-not-running');
    }

    base.wal = {
      ...archive,
      archiveMode: probe.config?.archiveMode ?? null,
      archiveTimeout: probe.config?.archiveTimeout ?? null,
      walLevel: probe.config?.walLevel ?? null,
      segmentSize: probe.config?.walSegmentSize ?? null,
      serverVersion: probe.config?.serverVersion ?? null,
      mountOk: layout.archiveMountOk,
      mountVerified: layout.archiveMountVerified,
    };
    base.baseMountVerified = layout.baseMountVerified;
    base.archiver = probe.archiver;

    if (!layout.archiveMountOk) base.warnings.push('archive-mount-missing');
    else if (!layout.archiveMountVerified) base.warnings.push('archive-mount-unverified');
    if (!layout.baseMountOk) base.warnings.push('base-mount-missing');
    else if (!layout.baseMountVerified) base.warnings.push('base-mount-unverified');
    if (layout.archiveMountOk && !samePath(layout.archiveDir, configuredArchiveDir, platform)) {
      base.warnings.push('archive-dir-overridden-by-mount');
    }
    if (!layout.baseMountOk) base.warnings.push('base-mount-missing');
    if (layout.archiveMountOk && archive.files === 0) base.warnings.push('archive-empty');
    if (probe.ok && probe.config?.archiveMode !== 'on') base.warnings.push('archive-mode-off');
    if (probe.ok && probe.archiver && probe.archiver.failedCount > 0) base.warnings.push('archive-failures-recorded');
    if (base.baseBackupCount === 0) base.warnings.push('no-base-backup');
    if (!restores.some(record => record.status === 'completed' && record.verified)) base.warnings.push('pitr-not-verified');
    if (probe.error && !base.error) base.error = probe.error;

    base.capabilities = buildCapabilities({
      inspectOk: true,
      running: layout.running,
      layout,
      archiveMode: probe.config?.archiveMode ?? null,
      archive,
      backups,
      restores,
    });
    logger.debug?.('pitr.status', {
      archiving: base.capabilities.walArchiving,
      pitr: base.capabilities.pointInTimeRecovery,
      backups: base.baseBackupCount,
    });
    return base;
  }

  /**
   * Hash a base backup's files as `<relative path>:<size>` lines. Runs on the
   * host when permissions allow, otherwise inside the container (the data files
   * are 0600 and owned by `postgres`, so a non-root host user cannot read them
   * on Linux).
   */
  async function hashTree(directory, baseDir, id) {
    const manifestPath = path.join(directory, 'backup_manifest');
    let manifestHash = null;
    try {
      manifestHash = sha256(await io.readFile(manifestPath));
    } catch {
      manifestHash = null;
    }
    try {
      const rows = [];
      let bytes = 0;
      let files = 0;
      async function walk(current, prefix) {
        const entries = await io.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const absolute = path.join(current, entry.name);
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(absolute, relative);
          } else if (entry.isFile()) {
            const stat = await io.stat(absolute);
            rows.push(`${relative}:${stat.size}`);
            bytes += Number(stat.size) || 0;
            files += 1;
          }
        }
      }
      await walk(directory, '');
      rows.sort();
      return { value: sha256(rows.join('\n')), bytes, files, manifest: manifestHash, source: 'host' };
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
      logger.debug?.('pitr.hash-host-denied', { code: error.code });
    }
    // Fallback: enumerate inside the container (GNU find/stat in the image).
    const result = await docker([
      'exec', '-u', 'postgres', container, 'sh', '-c',
      `cd ${BASE_MOUNT}/${id} && find . -type f -exec stat -c '%n:%s' {} + | sed 's|^\\./||' | sort`,
    ], { timeoutMs: 10 * 60 * 1000 });
    if (result.code !== 0) throw new PitrError('base-backup-unreadable', safeError(result.stderr));
    const rows = String(result.stdout ?? '').split(/\r?\n/).filter(Boolean);
    let bytes = 0;
    for (const row of rows) {
      const size = Number.parseInt(row.slice(row.lastIndexOf(':') + 1), 10);
      if (Number.isFinite(size)) bytes += size;
    }
    return { value: sha256(rows.join('\n')), bytes, files: rows.length, manifest: manifestHash, source: 'container' };
  }

  /**
   * Take a physical base backup with `pg_basebackup` inside the live container.
   * Never deletes or overwrites an existing backup: a new timestamped directory
   * is created, and a name collision gets a numeric suffix.
   */
  async function baseBackup(input = {}) {
    if (!isObject(input)) throw new PitrError('invalid-input');
    let label = null;
    if (input.label !== undefined && input.label !== null) {
      if (typeof input.label !== 'string' || input.label.length > MAX_LABEL_LENGTH) throw new PitrError('invalid-label');
      label = input.label.trim() || null;
    }
    const connectionInfo = connection();
    const layout = await resolveLayout();
    if (!layout.inspectOk) throw new PitrError('container-not-found', layout.error, 'is the local stack running? (node scripts/services.mjs up)');
    if (!layout.running) throw new PitrError('container-not-running', container);
    if (!layout.baseMountOk) {
      throw new PitrError(
        'base-backup-mount-missing',
        `${container} has no ${BASE_MOUNT} mount`,
        'recreate the database container with the current docker-compose.yml: docker compose up -d mova-db',
      );
    }

    const startedAt = currentDate();
    const id = await nextBaseId(layout.baseDir, startedAt);
    const directory = path.join(layout.baseDir, id);
    const containerDir = `${BASE_MOUNT}/${id}`;
    const user = connectionInfo.env.PGUSER || 'postgres';

    // Create the directory as `postgres` inside the container so ownership is
    // right on Linux; pg_basebackup requires an empty target directory.
    const made = await docker(['exec', '-u', 'postgres', container, 'mkdir', '-p', containerDir], { timeoutMs: 30_000 });
    if (made.code !== 0) {
      throw new PitrError('base-backup-dir-unavailable', safeError(made.stderr || `exit ${made.code}`), `check that ${layout.baseDir} is writable`);
    }

    const record = {
      id,
      label,
      status: 'running',
      format: 'plain',
      container,
      image: layout.image,
      path: directory,
      containerPath: containerDir,
      createdAt: startedAt.toISOString(),
      completedAt: null,
      durationMs: null,
      bytes: null,
      fileCount: null,
      checksum: null,
      verified: false,
      verifiedAt: null,
      verifyMethod: null,
      verifyError: null,
      database: { host: connectionInfo.host, port: connectionInfo.port, database: connectionInfo.database, user },
      error: null,
    };
    await writeJson(metadataPath(layout.baseDir, id), record);

    const args = [
      'exec', '-u', 'postgres', container,
      'pg_basebackup',
      '-D', containerDir,
      '-Fp',
      '-X', 'stream',
      '--manifest-checksums=SHA256',
      '-U', user,
      '-c', 'fast',
      '--no-password',
    ];
    let result;
    try {
      result = await docker(args, { timeoutMs: baseTimeoutMs });
    } catch (error) {
      await failBaseBackup(layout.baseDir, record, safeError(error));
      throw error instanceof PitrError ? error : new PitrError('base-backup-failed', safeError(error));
    }
    if (result.code !== 0) {
      const detail = result.timedOut ? 'pg_basebackup timed out' : safeError(result.stderr || `pg_basebackup exited ${result.code}`);
      await failBaseBackup(layout.baseDir, record, detail);
      throw new PitrError(result.timedOut ? 'base-backup-timeout' : 'base-backup-failed', detail, 'existing base backups were left untouched');
    }

    let tree;
    try {
      tree = await hashTree(directory, layout.baseDir, id);
    } catch (error) {
      await failBaseBackup(layout.baseDir, record, safeError(error));
      throw new PitrError('base-backup-failed', safeError(error));
    }
    if (!tree.files || !(await readDirSafe(directory)).some(entry => (typeof entry === 'string' ? entry : entry.name) === 'PG_VERSION')) {
      await failBaseBackup(layout.baseDir, record, 'pg_basebackup produced no usable data directory');
      throw new PitrError('base-backup-empty', directory);
    }

    record.status = 'completed';
    record.completedAt = currentDate().toISOString();
    record.durationMs = new Date(record.completedAt).getTime() - startedAt.getTime();
    record.bytes = tree.bytes;
    record.fileCount = tree.files;
    record.checksum = { algorithm: 'sha256', tree: tree.value, manifest: tree.manifest, source: tree.source };

    if (verifyBaseBackup) {
      try {
        const tool = await containerTool('pg_verifybackup');
        if (!tool) {
          record.verified = false;
          record.verifyError = 'pg_verifybackup not found in the container';
        } else {
          const verify = await docker(['exec', '-u', 'postgres', container, tool, containerDir], { timeoutMs: 15 * 60 * 1000 });
          record.verifyMethod = 'pg_verifybackup';
          record.verified = verify.code === 0;
          if (record.verified) {
            record.verifiedAt = currentDate().toISOString();
          } else {
            record.verifyError = safeError(verify.stderr || `pg_verifybackup exited ${verify.code}`);
          }
        }
      } catch (error) {
        record.verified = false;
        record.verifyError = safeError(error);
      }
    }

    await writeJson(metadataPath(layout.baseDir, id), record);
    logger.info?.('pitr.base-backup', { id, bytes: record.bytes, verified: record.verified });
    if (verifyBaseBackup && record.verified !== true) {
      throw new PitrError(
        'base-backup-verify-failed',
        record.verifyError ?? 'verification did not run',
        'the backup files are kept; inspect metadata before relying on it',
      );
    }
    return normalizeBaseRecord(record, layout.baseDir);
  }

  async function failBaseBackup(baseDir, record, detail) {
    const failed = { ...record, status: 'failed', completedAt: currentDate().toISOString(), error: safeError(detail) };
    try {
      await writeJson(metadataPath(baseDir, record.id), failed);
    } catch (error) {
      logger.error?.('pitr.base-backup-metadata-failed', { id: record.id, message: safeError(error) });
    }
    logger.warn?.('pitr.base-backup-failed', { id: record.id, detail: failed.error });
  }

  /**
   * Structural (and optionally cryptographic) check of the WAL archive.
   * `verified` is true only when `pg_waldump` actually parsed a segment inside
   * the container; a directory listing alone never proves WAL is restorable.
   */
  async function verifyArchive(input = {}) {
    if (!isObject(input)) throw new PitrError('invalid-input');
    const deep = input.deep === true;
    const layout = await resolveLayout();
    const result = {
      module: 'pitr',
      archiveDir: layout.archiveDir,
      verified: false,
      method: 'structure-only',
      file: null,
      files: 0,
      bytes: 0,
      lastArchivedAt: null,
      warnings: [],
      error: null,
    };

    let names;
    try {
      names = (await listWalFiles(layout.archiveDir)).sort();
    } catch (error) {
      result.error = safeError(error);
      result.warnings.push('archive-unreadable');
      return result;
    }
    if (!names.length) {
      result.warnings.push('archive-empty');
      return result;
    }
    result.files = names.length;
    const requested = typeof input.file === 'string' && input.file.trim() ? input.file.trim() : null;
    if (requested && !names.includes(requested)) throw new PitrError('wal-file-not-found', requested);
    const target = requested || [...names].reverse().find(name => WAL_SEGMENT_PATTERN.test(name)) || names[names.length - 1];
    result.file = target;

    const stat = await statSafe(path.join(layout.archiveDir, target));
    result.bytes = stat ? Number(stat.size) || 0 : 0;
    result.lastArchivedAt = stat?.mtime instanceof Date ? stat.mtime.toISOString() : null;
    if (!stat || result.bytes === 0) {
      result.warnings.push('archive-file-empty');
      return result;
    }
    if (WAL_SEGMENT_PATTERN.test(target)) {
      const segment = await segmentSizeBytes();
      if (segment && result.bytes % segment !== 0) {
        result.warnings.push('segment-size-mismatch');
        result.error = `segment is ${result.bytes} bytes, expected a multiple of ${segment}`;
        return result;
      }
      if (segment && result.bytes !== segment) result.warnings.push('partial-segment');
    }

    if (!deep) {
      result.warnings.push('deep-verification-not-run');
      return result;
    }
    if (!layout.inspectOk || !layout.running) {
      result.warnings.push('container-not-running');
      return result;
    }
    const tool = await containerTool('pg_waldump');
    if (!tool) {
      result.warnings.push('pg-waldump-missing');
      return result;
    }
    const dump = await docker(['exec', '-u', 'postgres', container, tool, '-n', '1', `${WAL_MOUNT}/${target}`], { timeoutMs: 60_000 });
    if (dump.code === 0) {
      result.verified = true;
      result.method = 'pg_waldump';
      result.warnings = result.warnings.filter(warning => warning !== 'deep-verification-not-run');
    } else {
      result.error = safeError(dump.stderr || `pg_waldump exited ${dump.code}`);
      result.warnings.push('wal-dump-failed');
    }
    return result;
  }

  async function segmentSizeBytes() {
    const probe = await probePostgres();
    const raw = probe.config?.walSegmentSize;
    if (!raw) return null;
    // PostgreSQL reports e.g. `16MB`, `1GB`, `16384kB`.
    const match = /^(\d+)\s*(kB|MB|GB|B)?$/i.exec(String(raw).trim());
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    const unit = (match[2] || 'B').toLowerCase();
    if (unit === 'kb') return value * 1024;
    if (unit === 'mb') return value * 1024 * 1024;
    if (unit === 'gb') return value * 1024 * 1024 * 1024;
    return value;
  }

  function restoreIdFor(date) {
    return `restore-${timestampSlug(date)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  function restoreContainerName(restoreId) {
    const safe = restoreId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
    return `mova-pitr-${safe}`.slice(0, 60);
  }

  async function dockerInspectObject(kind, name) {
    if (!name) return null;
    const result = await docker(['inspect', '--type', kind, '--format', '{{.Id}}', name]);
    if (result.code !== 0) return null;
    const id = String(result.stdout ?? '').trim();
    return id ? { id } : null;
  }

  async function volumeIsEmpty(name) {
    const result = await docker([
      'run', '--rm', '-v', `${name}:/check`, '--entrypoint', 'sh', image, '-c',
      'test -f /check/PG_VERSION && echo CLUSTER || (ls -A /check 2>/dev/null | head -n 1)',
    ], { timeoutMs: 120_000 });
    if (result.code !== 0) throw new PitrError('restore-target-unreadable', safeError(result.stderr || `exit ${result.code}`));
    const output = String(result.stdout ?? '').trim();
    if (output === 'CLUSTER') return { empty: false, reason: 'contains a PostgreSQL cluster' };
    if (output) return { empty: false, reason: `is not empty (${output.slice(0, 60)})` };
    return { empty: true, reason: null };
  }

  /**
   * Restore `baseBackupId` plus archived WAL into a BRAND NEW cluster.
   *
   * Safety rules (enforced, not merely documented):
   *  - exactly one of `targetVolume` / `targetDir`; it must not already hold a
   *    cluster and must be empty — nothing is ever deleted to make room;
   *  - the target must differ from the live data volume/directory, the restore
   *    container name must differ from the live container, and the port must
   *    differ from the live port;
   *  - the live container/volume is never stopped, written, or removed; the
   *    only container this method may remove is its own failed attempt.
   */
  async function restoreToNewCluster(input = {}) {
    if (!isObject(input)) throw new PitrError('invalid-input');
    const baseBackupId = typeof input.baseBackupId === 'string' ? input.baseBackupId.trim() : '';
    if (!baseBackupId) throw new PitrError('base-backup-required');
    const recoveryTarget = parseRecoveryTarget(input.recoveryTarget);

    const hasVolume = typeof input.targetVolume === 'string' && input.targetVolume.trim() !== '';
    const hasDir = typeof input.targetDir === 'string' && input.targetDir.trim() !== '';
    if (hasVolume && hasDir) throw new PitrError('restore-target-ambiguous', 'pass targetVolume or targetDir, not both');
    if (!hasVolume && !hasDir) {
      throw new PitrError(
        'restore-target-required',
        undefined,
        'pass a new volume name (--target=<volume>) or a new directory (--target=<dir> --dir)',
      );
    }
    const targetVolume = hasVolume ? input.targetVolume.trim() : null;
    if (targetVolume && !VOLUME_NAME_PATTERN.test(targetVolume)) throw new PitrError('invalid-target-volume', targetVolume);
    const targetDir = hasDir ? path.resolve(String(input.targetDir).trim()) : null;

    const connectionInfo = connection();
    const layout = await resolveLayout();
    if (!layout.inspectOk) throw new PitrError('container-not-found', layout.error);
    if (!layout.running) throw new PitrError('container-not-running', container);
    if (!layout.baseMountOk) {
      throw new PitrError('base-backup-mount-missing', `${container} has no ${BASE_MOUNT} mount`, 'docker compose up -d mova-db');
    }

    // ---- target guards ------------------------------------------------------
    const liveVolume = layout.liveVolume;
    if (targetVolume) {
      if (targetVolume === container) throw new PitrError('restore-target-is-live', targetVolume);
      if (liveVolume?.name && targetVolume === liveVolume.name) {
        throw new PitrError('restore-target-is-live', targetVolume, 'that is the live database volume; restoring into it is never allowed');
      }
      if (liveVolume?.source && samePath(targetVolume, liveVolume.source, platform)) {
        throw new PitrError('restore-target-is-live', targetVolume);
      }
    }
    if (targetDir) {
      if (liveVolume?.source && (isInside(targetDir, liveVolume.source, platform) || isInside(liveVolume.source, targetDir, platform))) {
        throw new PitrError('restore-target-is-live', targetDir, 'the live data directory cannot be used as a restore target');
      }
      if (isInside(targetDir, layout.baseDir, platform) || isInside(layout.baseDir, targetDir, platform)
        || isInside(targetDir, layout.archiveDir, platform) || isInside(layout.archiveDir, targetDir, platform)) {
        throw new PitrError('restore-target-invalid', targetDir, 'the target must not overlap the base backup or WAL archive directories');
      }
      if (isInside(targetDir, restoresDir, platform) || isInside(restoresDir, targetDir, platform)) {
        throw new PitrError('restore-target-invalid', targetDir, 'the target must not overlap the restore workspace');
      }
    }

    const livePortNumber = livePort();
    const requestedPort = input.targetPort === undefined || input.targetPort === null ? livePortNumber + 1 : Number(input.targetPort);
    if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
      throw new PitrError('invalid-target-port', String(input.targetPort));
    }
    if (requestedPort === livePortNumber) {
      throw new PitrError('restore-target-is-live-port', String(requestedPort), 'choose a different port; the live database keeps its port');
    }
    const targetPort = requestedPort;

    const record = await getBaseBackup(baseBackupId, layout.baseDir);
    if (record.status !== 'completed') throw new PitrError('base-backup-not-completed', baseBackupId);
    const basePath = path.join(layout.baseDir, record.id);
    if (!(await statSafe(path.join(basePath, 'PG_VERSION')))) {
      throw new PitrError('base-backup-incomplete', baseBackupId, `expected ${basePath}/PG_VERSION`);
    }

    const restoreId = restoreIdFor(currentDate());
    const containerName = restoreContainerName(restoreId);
    if (containerName === container) throw new PitrError('restore-target-is-live', containerName);
    if (await dockerInspectObject('container', containerName)) throw new PitrError('restore-target-exists', containerName);

    // ---- target preparation (never deletes) --------------------------------
    if (targetVolume) {
      const existing = await dockerInspectObject('volume', targetVolume);
      if (existing) {
        const check = await volumeIsEmpty(targetVolume);
        if (!check.empty) throw new PitrError('restore-target-not-empty', `${targetVolume} ${check.reason}`);
      } else {
        const created = await docker(['volume', 'create', targetVolume], { timeoutMs: 60_000 });
        if (created.code !== 0) throw new PitrError('restore-target-unavailable', safeError(created.stderr || `exit ${created.code}`));
      }
    } else {
      const existing = await statSafe(targetDir);
      if (existing) {
        if (!existing.isDirectory()) throw new PitrError('restore-target-invalid', 'not a directory');
        if ((await readDirSafe(targetDir)).length > 0) throw new PitrError('restore-target-not-empty', targetDir);
      } else {
        try {
          await io.mkdir(targetDir, { recursive: true, mode: 0o700 });
        } catch (error) {
          throw new PitrError('restore-target-unavailable', safeError(error));
        }
      }
    }

    const workspace = path.join(restoresDir, restoreId);
    const warnings = [];
    if (targetDir && platform === 'win32') {
      warnings.push('windows-bind-mount-permissions: PostgreSQL may refuse a host directory; prefer a docker volume');
    }
    const restore = {
      restoreId,
      status: 'running',
      baseBackupId: record.id,
      recoveryTarget: describeRecoveryTarget(recoveryTarget),
      container: containerName,
      image: layout.image,
      port: targetPort,
      target: targetVolume ? { type: 'volume', value: targetVolume } : { type: 'dir', value: targetDir },
      live: { container, port: livePortNumber, dataVolume: liveVolume?.name ?? null },
      startedAt: currentDate().toISOString(),
      completedAt: null,
      verified: false,
      evidence: null,
      connection: null,
      warnings,
      error: null,
    };
    await io.mkdir(workspace, { recursive: true, mode: 0o700 });
    await io.writeFile(path.join(workspace, 'prepare.sh'), PREPARE_SCRIPT, { mode: 0o600 });
    await writeJson(path.join(workspace, 'restore.json'), restore);

    // ---- lay down the base backup + recovery configuration -----------------
    const prepareEnv = {
      MOVA_PITR_SRC: `${RESTORE_BASE}/${record.id}`,
      MOVA_PITR_TARGET: RESTORE_TARGET,
      MOVA_PITR_WAL: RESTORE_WAL,
    };
    if (recoveryTarget?.type === 'time') {
      prepareEnv.MOVA_PITR_TARGET_TIME = recoveryTarget.value;
      prepareEnv.MOVA_PITR_TARGET_ACTION = 'promote';
    } else if (recoveryTarget?.type === 'name') {
      prepareEnv.MOVA_PITR_TARGET_NAME = recoveryTarget.value;
      prepareEnv.MOVA_PITR_TARGET_ACTION = 'promote';
    } else if (recoveryTarget?.type === 'lsn') {
      prepareEnv.MOVA_PITR_TARGET_LSN = recoveryTarget.value;
      prepareEnv.MOVA_PITR_TARGET_ACTION = 'promote';
    } else if (recoveryTarget?.type === 'immediate') {
      prepareEnv.MOVA_PITR_TARGET_IMMEDIATE = '1';
      prepareEnv.MOVA_PITR_TARGET_ACTION = 'promote';
    }
    const targetMount = targetVolume ? `${targetVolume}:${RESTORE_TARGET}` : `${targetDir}:${RESTORE_TARGET}`;
    const prepareArgs = [
      'run', '--rm', '--name', `${containerName}-prep`,
      '-v', targetMount,
      '-v', `${layout.baseDir}:${RESTORE_BASE}:ro`,
      '-v', `${layout.archiveDir}:${RESTORE_WAL}:ro`,
      '-v', `${workspace}:${RESTORE_WORK}:ro`,
      ...Object.entries(prepareEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '--entrypoint', 'sh', layout.image, `${RESTORE_WORK}/prepare.sh`,
    ];
    let prepare;
    try {
      prepare = await docker(prepareArgs, { timeoutMs: prepareTimeoutMs });
    } catch (error) {
      await failRestore(workspace, restore, safeError(error));
      throw error instanceof PitrError ? error : new PitrError('restore-failed', safeError(error));
    }
    if (prepare.code !== 0) {
      const stderr = prepare.stderr ?? '';
      const detail = prepare.timedOut ? 'restore preparation timed out' : safeError(stderr || `exit ${prepare.code}`);
      const code = stderr.includes('already contains a PostgreSQL cluster')
        ? 'restore-target-not-empty'
        : stderr.includes('base backup is incomplete')
          ? 'base-backup-incomplete'
          : prepare.timedOut ? 'restore-timeout' : 'restore-failed';
      await failRestore(workspace, restore, detail);
      throw new PitrError(code, detail, 'the live database was not touched');
    }

    // ---- start the new cluster ---------------------------------------------
    const startArgs = [
      'run', '-d', '--name', containerName,
      ...(layout.network ? ['--network', layout.network] : []),
      '-p', `127.0.0.1:${targetPort}:5432`,
      '-v', `${targetVolume ?? targetDir}:${DATA_MOUNT}`,
      '-v', `${layout.archiveDir}:${RESTORE_WAL}:ro`,
      '--label', `mova.pitr.restore=${restoreId}`,
      '--label', `mova.pitr.base=${record.id}`,
      layout.image,
    ];
    const start = await docker(startArgs, { timeoutMs: 120_000 });
    if (start.code !== 0) {
      const detail = safeError(start.stderr || `docker run exited ${start.code}`);
      const code = /port is already allocated|address already in use/i.test(start.stderr ?? '')
        ? 'restore-port-unavailable'
        : 'restore-failed';
      await failRestore(workspace, restore, detail);
      throw new PitrError(code, detail, 'the live database was not touched');
    }

    // ---- wait for recovery to finish and the cluster to accept writes ------
    const readiness = await waitForPromotion(containerName, connectionInfo);
    if (!readiness.ok) {
      const logs = await containerLogs(containerName);
      const detail = `${readiness.error ?? 'not ready'}; last log: ${lastLine(logs)}`;
      await failRestore(workspace, restore, detail, { containerName, removeContainer: true, logs });
      throw new PitrError('restore-not-ready', detail, 'the live database was not touched');
    }

    const evidence = {
      promoted: readiness.promoted,
      inRecovery: readiness.inRecovery,
      serverVersion: readiness.serverVersion,
      checkedAt: readiness.checkedAt,
      log: readiness.evidence,
      walReplayed: Boolean(readiness.evidence.replayStarted || readiness.evidence.consistentRecovery),
    };

    restore.status = 'completed';
    restore.completedAt = currentDate().toISOString();
    restore.verified = evidence.promoted && evidence.inRecovery === false;
    restore.evidence = evidence;
    restore.connection = {
      host: '127.0.0.1',
      port: targetPort,
      database: connectionInfo.database,
      user: connectionInfo.env.PGUSER || 'postgres',
      redactedUrl: `postgres://${encodeURIComponent(connectionInfo.env.PGUSER || 'postgres')}@127.0.0.1:${targetPort}/${encodeURIComponent(connectionInfo.database)}`,
      passwordHint: 'the restored cluster reuses the source pg_hba.conf; connect with the MOVA_DB_PASSWORD from .env',
    };
    if (!evidence.walReplayed) warnings.push('no-wal-replay-evidence: the cluster started from the base backup only');
    await writeJson(path.join(workspace, 'restore.json'), restore);
    logger.info?.('pitr.restored', { restoreId, baseBackupId: record.id, port: targetPort, verified: restore.verified });
    return restore;
  }

  function lastLine(text) {
    const lines = String(text ?? '').trim().split(/\r?\n/).filter(Boolean);
    return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
  }

  async function containerLogs(name) {
    const result = await docker(['logs', '--tail', '400', name], { timeoutMs: 30_000 }).catch(() => null);
    return result ? `${result.stdout ?? ''}\n${result.stderr ?? ''}` : '';
  }

  /**
   * Poll the new container until PostgreSQL finished recovery and accepts
   * writes. Uses `docker exec` (local socket) so no password is needed.
   */
  async function waitForPromotion(name, connectionInfo) {
    const deadline = clock() + waitMs;
    const user = connectionInfo.env.PGUSER || 'postgres';
    const database = connectionInfo.database;
    let lastError = null;
    for (;;) {
      const ready = await docker(['exec', name, 'pg_isready', '-U', user, '-d', database], { timeoutMs: 15_000 });
      if (ready.code === 0) {
        const query = await docker([
          'exec', name, 'psql', '-U', user, '-d', database, '-A', '-t', '-F', '|', '-c',
          "select pg_is_in_recovery(), current_setting('server_version')",
        ], { timeoutMs: 15_000 });
        if (query.code === 0) {
          const [inRecoveryRaw, serverVersion] = String(query.stdout ?? '').trim().split('|');
          const inRecovery = inRecoveryRaw === 't';
          if (!inRecovery) {
            const logs = await containerLogs(name);
            return {
              ok: true,
              inRecovery,
              promoted: true,
              serverVersion: serverVersion ?? null,
              checkedAt: currentDate().toISOString(),
              evidence: {
                archiveRecovery: /starting archive recovery/.test(logs),
                consistentRecovery: /consistent recovery state reached/.test(logs),
                replayStarted: /redo starts at/.test(logs),
                redoDone: /redo done at/.test(logs),
                targetReached: /recovery stopping (before|after|at)/.test(logs),
                timelineSwitched: /selected new timeline ID/.test(logs),
              },
            };
          }
        } else {
          lastError = safeError(query.stderr);
        }
      } else {
        lastError = safeError(ready.stderr || `pg_isready exited ${ready.code}`);
        const state = await docker(['inspect', '--format', '{{.State.Running}}', name], { timeoutMs: 15_000 }).catch(() => null);
        if (state && state.code === 0 && String(state.stdout).trim() === 'false') {
          return { ok: false, error: 'the restored container exited before becoming ready' };
        }
      }
      if (clock() >= deadline) return { ok: false, error: lastError || 'timed out waiting for the restored cluster' };
      await delay(RESTORE_POLL_MS);
    }
  }

  async function failRestore(workspace, restore, detail, { containerName = null, removeContainer = false, logs = '' } = {}) {
    if (removeContainer && containerName) {
      if (containerName === container) {
        logger.error?.('pitr.refuse-remove-live', { containerName });
      } else {
        await docker(['rm', '-f', containerName], { timeoutMs: 60_000 }).catch(() => null);
      }
    }
    const failed = {
      ...restore,
      status: 'failed',
      completedAt: currentDate().toISOString(),
      error: safeError(detail),
      verified: false,
      ...(logs ? { logTail: redact(logs).slice(-2_000) } : {}),
    };
    try {
      await writeJson(path.join(workspace, 'restore.json'), failed);
    } catch (error) {
      logger.error?.('pitr.restore-metadata-failed', { id: restore.restoreId, message: safeError(error) });
    }
    logger.warn?.('pitr.restore-failed', { id: restore.restoreId, detail: failed.error });
    return failed;
  }

  /** Explicit removal of a restore container — never the live container/volume. */
  async function removeRestoreCluster({ restoreId, containerName, volume = null } = {}) {
    const name = containerName || (restoreId ? restoreContainerName(restoreId) : null);
    if (!name) throw new PitrError('invalid-input');
    if (name === container) throw new PitrError('refuse-live-container', name);
    const layout = await resolveLayout();
    if (layout.liveVolume?.name && volume && volume === layout.liveVolume.name) {
      throw new PitrError('refuse-live-volume', volume);
    }
    const removed = await docker(['rm', '-f', name], { timeoutMs: 60_000 });
    if (removed.code !== 0 && !/No such container/i.test(removed.stderr ?? '')) {
      throw new PitrError('restore-remove-failed', safeError(removed.stderr));
    }
    if (volume) await docker(['volume', 'rm', volume], { timeoutMs: 60_000 }).catch(() => null);
    return { removed: true, container: name, volume };
  }

  return {
    container,
    backupDir,
    baseDir: configuredBaseDir,
    archiveDir: configuredArchiveDir,
    dockerBin,
    databaseUrl,
    image,
    status,
    baseBackup,
    listBaseBackups,
    getBaseBackup,
    verifyArchive,
    restoreToNewCluster,
    removeRestoreCluster,
    _internals: { layoutFor, buildCapabilities, PREPARE_SCRIPT, metadataPath },
  };
}

module.exports = {
  createPitrService,
  PitrError,
  PREPARE_SCRIPT,
  WAL_SEGMENT_PATTERN,
  parseRecoveryTarget,
  resolveDockerBin,
  hostPathFromDockerSource,
  timestampSlug,
  normalizeHostPath,
  samePath,
  isInside,
  INSPECT_SEPARATOR,
  WAL_MOUNT,
  BASE_MOUNT,
  DATA_MOUNT,
};
