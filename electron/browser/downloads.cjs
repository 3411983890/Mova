'use strict';
// Download policy: keep files out of the user's Downloads folder, make the
// filename safe, never overwrite, and refuse executable types by default.

const { existsSync } = require('node:fs');
const { extname, join } = require('node:path');

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.scr', '.vbs', '.js', '.jse', '.wsf', '.lnk', '.reg',
]);

function sanitizeFilename(name, fallback = 'download') {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return base || fallback;
}

function isBlocked(filename) {
  return BLOCKED_EXTENSIONS.has(extname(String(filename || '')).toLowerCase());
}

function uniquePath(directory, filename) {
  const safe = sanitizeFilename(filename);
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length) || 'download';
  let candidate = join(directory, safe);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = join(directory, `${stem} (${index})${extension}`);
    index += 1;
  }
  return candidate;
}

module.exports = { sanitizeFilename, isBlocked, uniquePath, BLOCKED_EXTENSIONS };
