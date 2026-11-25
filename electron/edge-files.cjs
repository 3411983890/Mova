'use strict';

const fs = require('node:fs/promises');
const { constants: { COPYFILE_EXCL }, realpath } = require('node:fs');
const { promisify } = require('node:util');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_TRANSFER = 8 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const canonicalPath = promisify(realpath);

const contains = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

async function inspect(absolute) {
  const info = await fs.lstat(absolute).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (info?.isSymbolicLink()) throw new Error('Symbolic links and junctions cannot be used.');
  const real = info ? await canonicalPath(absolute)
    : path.join(await canonicalPath(path.dirname(absolute)), path.basename(absolute));
  if (path.relative(absolute, real)) throw new Error('Use the canonical path. Links and path aliases cannot be used.');
  return info;
}

function createEdgeFiles({ directory, approvals, sender, signal }) {
  const root = path.resolve(directory);

  async function authorize(action, values) {
    signal.throwIfAborted();
    await fs.mkdir(root, { recursive: true });
    await inspect(root);
    const files = values.map(value => {
      if (typeof value !== 'string' || !value || /[\x00-\x1f<>|"*?]/.test(value) ||
          value.replace(/^[a-z]:/i, '').includes(':') || /^[\\/]{2}/.test(value)) {
        throw new Error('Use a workspace-relative path or a local absolute path.');
      }
      const parts = value.replace(/^[a-z]:/i, '').split(/[\\/]/);
      if (parts.some(part => part === '..' || (part !== '.' && /[. ]$/.test(part)) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error('Parent traversal, reserved names and path aliases cannot be used.');
      }
      if (!path.isAbsolute(value) && /^[a-z]:/i.test(value)) throw new Error('Drive-relative paths cannot be used.');
      const absolute = path.resolve(root, value);
      return { absolute, inside: contains(root, absolute) };
    });
    if (files.some(file => !file.inside)) {
      const decision = await approvals.ask(sender, {
        capability: 'exec', allowSession: false, message: `Edge 文件夹外操作：${action}`,
        detail: files.map(file => file.absolute).join('\n'),
      }, signal);
      if (decision !== 'once') throw new Error('External file access was denied or expired.');
    }
    signal.throwIfAborted();
    return files.map(file => file.absolute);
  }

  async function checked(file) {
    signal.throwIfAborted();
    const info = await inspect(file);
    if (info && !info.isFile() && !info.isDirectory()) throw new Error('Only regular files and folders can be used.');
    if (info?.isFile() && info.nlink > 1) throw new Error('Hard-linked files cannot be used.');
    return info;
  }

  async function read(file, limit) {
    if (!(await checked(file))?.isFile()) throw new Error('File not found.');
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > limit) throw new Error('File is linked or exceeds the size limit.');
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) throw new Error('File changed while being read.');
      return bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  async function write(file, bytes, overwrite = false) {
    const info = await checked(file);
    if (info && (!overwrite || !info.isFile())) throw new Error('Destination already exists.');
    if (!overwrite) {
      await fs.writeFile(file, bytes, { flag: 'wx' });
      return;
    }
    const temp = path.join(path.dirname(file), `.mova-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, bytes, { flag: 'wx' });
      await checked(file);
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async function execute({ action, path: name = '.', destination, text }) {
    const [file, dest] = await authorize(action, action === 'move' ? [name, destination] : [name]);
    const info = await checked(file);
    if (action === 'list') {
      if (!info?.isDirectory()) throw new Error('Folder not found.');
      const entries = await fs.readdir(file, { withFileTypes: true });
      return { workspace: root, entries: entries.slice(0, 300).map(entry => ({
        name: entry.name, type: entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : 'other',
      })), truncated: entries.length > 300 };
    }
    if (action === 'read') return { text: new TextDecoder('utf-8', { fatal: true }).decode(await read(file, MAX_TEXT)) };
    if (action === 'write') {
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT) throw new Error('Provide at most 1 MiB of UTF-8 text.');
      await write(file, Buffer.from(text), true);
    } else if (action === 'mkdir') {
      if (!info?.isDirectory()) await fs.mkdir(file);
    } else if (action === 'delete') {
      if (file === root) throw new Error('The Edge workspace itself cannot be removed.');
      if (info?.isDirectory()) await fs.rmdir(file);
      else await fs.unlink(file);
    } else if (action === 'move') {
      if (file === root || !info?.isFile()) throw new Error('Move requires a regular file.');
      if (await checked(dest)) throw new Error('Destination already exists.');
      await fs.copyFile(file, dest, COPYFILE_EXCL);
      await fs.unlink(file);
    } else {
      throw new Error('Unknown file action.');
    }
    return { ok: true, path: name, ...(dest ? { destination } : {}) };
  }

  return { authorize, read, write, execute };
}

module.exports = { createEdgeFiles, MAX_TRANSFER };
