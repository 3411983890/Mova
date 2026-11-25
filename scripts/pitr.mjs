#!/usr/bin/env node
/**
 * Mova WAL / PITR control.
 *
 * CLI:    node scripts/pitr.mjs status|base-backup|list|restore|verify-archive
 * Module: createPitrService(...) from electron/services/pitr.cjs
 *
 * Safety: this CLI never restores into the live database. `restore` always
 * creates a NEW container/volume/directory on a NEW port and refuses a target
 * that matches the live container, its data volume, its data directory or its
 * port. Passwords are never printed; all output is redacted.
 *
 * Exit codes: 0 success, 1 runtime failure, 2 usage error.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDotEnv } from './db-migrate.mjs';
import { resolveServiceConfig, redactSecrets } from './services.mjs';
import { createRequire } from 'node:module';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createPitrService, PitrError, parseRecoveryTarget, resolveDockerBin } = require('../electron/services/pitr.cjs');

export class PitrUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PitrUsageError';
    this.code = 'usage';
  }
}

const COMMANDS = new Set(['status', 'base-backup', 'list', 'restore', 'verify-archive']);

const USAGE = `Usage: node scripts/pitr.mjs <command> [options]

Commands:
  status                     Archive/WAL/base-backup/capability status (read-only)
  base-backup                Take a physical base backup with pg_basebackup
  list                       List base backups with metadata and verification state
  restore                    Restore a base backup into a NEW disposable cluster
  verify-archive             Check the WAL archive (deep: parse a segment with pg_waldump)

Options:
  --json                     Single machine-readable JSON result on stdout
  --label <text>             base-backup: free-form label stored in metadata
  --base <id>                restore: base backup id (see \`list\`)
  --target <dir|volume>      restore: new data directory or new docker volume
  --dir | --volume           restore: force --target to be a directory / a volume
  --port <n>                 restore: published port (default: live port + 1)
  --at <iso>                 restore: recovery target time, e.g. 2026-11-10T13:07:03Z
  --name <point>             restore: named restore point (pg_create_restore_point)
  --lsn <X/Y>                restore: recovery target LSN
  --immediate                restore: stop right after the base backup
  --wait <ms>                restore: readiness timeout (default 180000)
  --deep                     verify-archive: parse a segment with pg_waldump
  --file <name>              verify-archive: specific archived WAL file
  --strict                   status: exit 1 unless WAL archiving AND PITR are proven
  -h, --help                 Show this help

Environment (see .env.example):
  MOVA_DB_URL, MOVA_DB_USER, MOVA_DB_PASSWORD, MOVA_DB_NAME, MOVA_DB_PORT,
  MOVA_BACKUPS_DIR, MOVA_DOCKER_CLI, MOVA_PITR_IMAGE, MOVA_PITR_CONTAINER

Typical flow:
  node scripts/pitr.mjs status
  node scripts/pitr.mjs base-backup
  node scripts/pitr.mjs list
  node scripts/pitr.mjs restore --base=base-20261110T130700Z --target=mova-pitr-check --volume --port=55499
  node scripts/pitr.mjs restore --base=<id> --target=mova-pitr-check2 --at=2026-11-10T13:07:03Z --port=55498

The restored cluster is disposable. To clean it up:
  docker rm -f mova-pitr-<restore-id> && docker volume rm <target volume>

Exit codes:
  0  command succeeded
  1  runtime failure (Docker missing/unreachable, backup failed, refused target, ...)
  2  usage error
`;

function parseFlags(argv) {
  const flags = {
    json: false,
    help: false,
    strict: false,
    deep: false,
    dir: false,
    volume: false,
    immediate: false,
    label: null,
    base: null,
    target: null,
    port: null,
    at: null,
    name: null,
    lsn: null,
    file: null,
    waitMs: null,
  };
  let command = null;
  const takeValue = (index, name) => {
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) throw new PitrUsageError(`${name} requires a value`);
    return value;
  };
  // Accept both `--flag value` and `--flag=value` (the help examples use the
  // latter). Only split the first "=" of a flag token.
  const tokens = argv.flatMap(item => {
    if (typeof item === 'string' && item.startsWith('--') && item.includes('=')) {
      const at = item.indexOf('=');
      return [item.slice(0, at), item.slice(at + 1)];
    }
    return [item];
  });
  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '--deep') flags.deep = true;
    else if (arg === '--dir') flags.dir = true;
    else if (arg === '--volume') flags.volume = true;
    else if (arg === '--immediate') flags.immediate = true;
    else if (arg === '--label') { flags.label = takeValue(index, '--label'); index += 1; }
    else if (arg === '--base') { flags.base = takeValue(index, '--base'); index += 1; }
    else if (arg === '--target') { flags.target = takeValue(index, '--target'); index += 1; }
    else if (arg === '--port') {
      const raw = takeValue(index, '--port');
      const port = Number.parseInt(raw, 10);
      if (!Number.isFinite(port) || port < 1024 || port > 65535) throw new PitrUsageError('--port must be an integer between 1024 and 65535');
      flags.port = port;
      index += 1;
    } else if (arg === '--at') { flags.at = takeValue(index, '--at'); index += 1; }
    else if (arg === '--name') { flags.name = takeValue(index, '--name'); index += 1; }
    else if (arg === '--lsn') { flags.lsn = takeValue(index, '--lsn'); index += 1; }
    else if (arg === '--file') { flags.file = takeValue(index, '--file'); index += 1; }
    else if (arg === '--wait') {
      const raw = takeValue(index, '--wait');
      const waitMs = Number.parseInt(raw, 10);
      if (!Number.isFinite(waitMs) || waitMs < 1000) throw new PitrUsageError('--wait must be at least 1000 milliseconds');
      flags.waitMs = waitMs;
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new PitrUsageError(`Unknown flag: ${arg}`);
    } else if (!command) {
      if (!COMMANDS.has(arg)) throw new PitrUsageError(`Unknown command: ${arg}`);
      command = arg;
    } else {
      throw new PitrUsageError(`Unexpected argument: ${arg}`);
    }
  }
  if (flags.help) return { command: 'help', flags };
  if (!command) throw new PitrUsageError('Missing command.');
  if (flags.dir && flags.volume) throw new PitrUsageError('--dir and --volume are mutually exclusive.');

  const allowed = {
    status: new Set(['json', 'strict']),
    'base-backup': new Set(['json', 'label']),
    list: new Set(['json']),
    restore: new Set(['json', 'base', 'target', 'port', 'dir', 'volume', 'at', 'name', 'lsn', 'immediate', 'waitMs']),
    'verify-archive': new Set(['json', 'deep', 'file']),
  }[command];
  const label = name => (name === 'waitMs' ? 'wait' : name);
  for (const [name, value] of Object.entries(flags)) {
    if (name === 'help' || name === 'json') continue;
    const isSet = typeof value === 'boolean' ? value : value !== null;
    if (isSet && !allowed.has(name)) throw new PitrUsageError(`--${label(name)} is not valid with \`${command}\`.`);
  }
  if (command === 'restore') {
    if (!flags.base) throw new PitrUsageError('restore requires --base=<id> (see `node scripts/pitr.mjs list`).');
    if (!flags.target) throw new PitrUsageError('restore requires --target=<volume|dir>; the live database is never a valid target.');
    const targets = [flags.at, flags.name, flags.lsn].filter(Boolean).length + (flags.immediate ? 1 : 0);
    if (targets > 1) throw new PitrUsageError('choose one recovery target: --at, --name, --lsn or --immediate.');
  }
  return { command, flags };
}

/** Decide whether `--target` names a docker volume or a host directory. */
export function classifyTarget(value, { dir = false, volume = false, cwd = DEFAULT_ROOT } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new PitrUsageError('--target requires a value');
  if (volume) return { type: 'volume', value: raw };
  if (dir) return { type: 'dir', value: path.resolve(cwd, raw) };
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('./') || raw.startsWith('.\\')
    || raw.startsWith('/') || raw.includes('/') || raw.includes('\\')) {
    return { type: 'dir', value: path.resolve(cwd, raw) };
  }
  return { type: 'volume', value: raw };
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '(unknown)';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function yesNo(value) {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

export function formatStatus(status) {
  const lines = [];
  const caps = status.capabilities ?? {};
  const wal = status.wal ?? {};
  const container = status.containerState ?? {};
  lines.push(`Container    : ${status.container} (${container.running ? 'running' : 'not running'})`);
  lines.push(`Image        : ${container.image ?? '(unknown)'}`);
  lines.push(`Data volume  : ${container.dataVolume?.name ?? '(none detected)'}`);
  lines.push(`WAL archive  : ${status.archiveDir}${wal.mountOk ? '' : ' (NOT mounted in the container)'}`);
  lines.push(`Base backups : ${status.baseDir}`);
  lines.push('');
  lines.push(`archive_mode : ${wal.archiveMode ?? 'unknown'}    archive_timeout: ${wal.archiveTimeout ?? 'unknown'}`);
  lines.push(`wal_level    : ${wal.walLevel ?? 'unknown'}    segment: ${wal.segmentSize ?? 'unknown'}`);
  lines.push(`Archived WAL : ${wal.files ?? 0} file(s), ${formatBytes(wal.bytes)} total, last ${wal.latestAt ?? 'n/a'}`);
  if (status.archiver) {
    lines.push(`Archiver     : archived=${status.archiver.archivedCount} failed=${status.archiver.failedCount} last=${status.archiver.lastArchivedAt ?? 'n/a'}`);
  } else {
    lines.push('Archiver     : (unavailable — database not queryable)');
  }
  lines.push(`Base backups : ${status.baseBackupCount ?? 0} completed${status.failedBaseBackupCount ? `, ${status.failedBaseBackupCount} failed` : ''}`);
  if (status.lastBaseBackup) {
    lines.push(`Latest base  : ${status.lastBaseBackup.id} (${formatBytes(status.lastBaseBackup.bytes)}, verified=${yesNo(status.lastBaseBackup.verified)})`);
  }
  if (status.lastRestore) {
    lines.push(`Last restore : ${status.lastRestore.restoreId} status=${status.lastRestore.status} verified=${yesNo(status.lastRestore.verified)}`);
  }
  lines.push('');
  lines.push(`walArchiving      : ${yesNo(caps.walArchiving)}`);
  lines.push(`baseBackup        : ${yesNo(caps.baseBackup)}`);
  lines.push(`restoreToNewCluster: ${yesNo(caps.restoreToNewCluster)}`);
  lines.push(`pointInTimeRecovery: ${yesNo(caps.pointInTimeRecovery)}`);
  for (const [key, reason] of Object.entries(caps.reasons ?? {})) {
    lines.push(`  - ${key}: ${reason}`);
  }
  if (status.warnings?.length) {
    lines.push('');
    lines.push(`Warnings: ${status.warnings.join(', ')}`);
  }
  if (status.error) lines.push(`Error: ${status.error}`);
  return `${lines.join('\n')}\n`;
}

export function formatList(records) {
  if (!records.length) return 'No base backups yet. Run: node scripts/pitr.mjs base-backup\n';
  const lines = ['ID                             STATUS     VERIFIED  SIZE        CREATED'];
  for (const record of records) {
    lines.push([
      String(record.id).padEnd(30),
      String(record.status).padEnd(10),
      String(yesNo(record.verified)).padEnd(9),
      formatBytes(record.bytes).padEnd(11),
      record.createdAt ?? '',
    ].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

export function formatRestore(result) {
  const lines = [
    `Restored     : ${result.baseBackupId} → ${result.container}`,
    `Status       : ${result.status} (verified=${yesNo(result.verified)})`,
    `Port         : 127.0.0.1:${result.port}`,
    `Target       : ${result.target?.type === 'volume' ? 'volume' : 'directory'} ${result.target?.value}`,
    `Recovery     : ${result.recoveryTarget ? `${result.recoveryTarget.type} ${result.recoveryTarget.value ?? ''}`.trim() : 'end of WAL'}`,
    `Connect      : ${result.connection?.redactedUrl ?? '(unknown)'}`,
    `Password     : ${result.connection?.passwordHint ?? '(unknown)'}`,
    `Cleanup      : docker rm -f ${result.container}` + (result.target?.type === 'volume' ? ` && docker volume rm ${result.target.value}` : ''),
  ];
  if (result.evidence) {
    const log = result.evidence.log ?? {};
    lines.push(`Evidence     : archive_recovery=${yesNo(log.archiveRecovery)} consistent=${yesNo(log.consistentRecovery)} `
      + `replay=${yesNo(log.replayStarted)} redo_done=${yesNo(log.redoDone)} target=${yesNo(log.targetReached)} promoted=${yesNo(log.timelineSwitched)}`);
  }
  if (result.warnings?.length) lines.push(`Warnings     : ${result.warnings.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = DEFAULT_ROOT,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  createService = createPitrService,
} = {}) {
  let parsed;
  try {
    parsed = parseFlags(argv);
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
  const config = resolveServiceConfig({ env: cliEnv, cwd });
  const sanitize = (text) => redactSecrets(text, config.secrets);
  const backupsDir = cliEnv.MOVA_BACKUPS_DIR
    ? path.resolve(cwd, cliEnv.MOVA_BACKUPS_DIR)
    : path.join(cwd, '.mova-backups');
  const dockerBin = resolveDockerBin({ env: cliEnv, platform: process.platform, existsSync });

  let service;
  try {
    service = createService({
      dockerBin,
      container: cliEnv.MOVA_PITR_CONTAINER || 'mova-db',
      databaseUrl: config.dbUrl,
      backupDir: backupsDir,
      projectRoot: cwd,
      env: cliEnv,
      ...(parsed.flags.waitMs ? { waitMs: parsed.flags.waitMs } : {}),
      logger: { info: (message, fields) => stderr(`${message} ${JSON.stringify(fields ?? {})}\n`) },
    });
  } catch (error) {
    const detail = error?.detail ? `${error.code}: ${error.detail}` : error?.message ?? String(error);
    stderr(`${sanitize(detail)}\n`);
    return 1;
  }

  let result;
  let exitCode = 0;
  try {
    switch (parsed.command) {
      case 'status':
        result = await service.status();
        // A status that cannot even reach Docker is a runtime failure; missing
        // capabilities alone are not (the settings page must stay usable).
        if (result.docker?.ok !== true) exitCode = 1;
        if (parsed.flags.strict && !(result.capabilities?.walArchiving && result.capabilities?.pointInTimeRecovery)) {
          exitCode = 1;
        }
        break;
      case 'base-backup':
        result = await service.baseBackup({ label: parsed.flags.label ?? undefined });
        break;
      case 'list':
        result = { module: 'pitr', baseDir: service.baseDir, backups: await service.listBaseBackups({ limit: 200 }) };
        break;
      case 'restore': {
        const target = classifyTarget(parsed.flags.target, {
          dir: parsed.flags.dir,
          volume: parsed.flags.volume,
          cwd,
        });
        const recoveryTarget = parsed.flags.immediate
          ? { type: 'immediate' }
          : parsed.flags.name
            ? { type: 'name', value: parsed.flags.name }
            : parsed.flags.lsn
              ? { type: 'lsn', value: parsed.flags.lsn }
              : parsed.flags.at
                ? parseRecoveryTarget(parsed.flags.at)
                : null;
        result = await service.restoreToNewCluster({
          baseBackupId: parsed.flags.base,
          recoveryTarget,
          ...(target.type === 'volume' ? { targetVolume: target.value } : { targetDir: target.value }),
          ...(parsed.flags.port ? { targetPort: parsed.flags.port } : {}),
        });
        break;
      }
      case 'verify-archive':
        result = await service.verifyArchive({ deep: parsed.flags.deep, file: parsed.flags.file ?? undefined });
        break;
      default:
        throw new PitrUsageError(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    const isUsage = error instanceof PitrUsageError;
    const code = error?.code ?? error?.name ?? 'error';
    const detail = error?.detail ? `: ${error.detail}` : '';
    const hint = error?.hint ? `\n  hint: ${error.hint}` : '';
    const message = error instanceof PitrError
      ? `${code}${detail}${hint}`
      : `${sanitize(error?.message ?? String(error))}${hint}`;
    if (parsed.flags.json) {
      stdout(`${JSON.stringify({ ok: false, module: 'pitr', action: parsed.command, code, error: sanitize(message) })}\n`);
    } else {
      stderr(`${sanitize(message)}\n`);
    }
    return isUsage ? 2 : 1;
  }

  if (parsed.flags.json) {
    stdout(`${JSON.stringify({ ok: exitCode === 0, module: 'pitr', action: parsed.command, value: result })}\n`);
    return exitCode;
  }

  switch (parsed.command) {
    case 'status':
      stdout(sanitize(formatStatus(result)));
      break;
    case 'list':
      stdout(sanitize(formatList(result.backups)));
      break;
    case 'base-backup':
      stdout(sanitize([
        `Base backup  : ${result.id}`,
        `Path         : ${result.path}`,
        `Size         : ${formatBytes(result.bytes)} in ${result.fileCount ?? '?'} file(s)`,
        `Checksum     : sha256:${result.checksum?.tree ?? '(none)'}`,
        `Verified     : ${yesNo(result.verified)}${result.verifyError ? ` (${result.verifyError})` : ''}`,
        `Created      : ${result.createdAt}`,
        '',
      ].join('\n')));
      break;
    case 'restore':
      stdout(sanitize(formatRestore(result)));
      break;
    case 'verify-archive':
      stdout(sanitize([
        `WAL file     : ${result.file ?? '(none)'}`,
        `Archive      : ${result.archiveDir} (${result.files} file(s), ${formatBytes(result.bytes)} checked)`,
        `Verified     : ${yesNo(result.verified)} via ${result.method}`,
        ...(result.warnings.length ? [`Warnings     : ${result.warnings.join(', ')}`] : []),
        ...(result.error ? [`Error        : ${result.error}`] : []),
        '',
      ].join('\n')));
      break;
    default:
      stdout(`${JSON.stringify(result)}\n`);
  }
  return exitCode;
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
