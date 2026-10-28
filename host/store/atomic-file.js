/**
 * Atomic single-file writes with durable-rename semantics (Z2).
 *
 * Contract: readers observe either the previous complete file or the next
 * complete file, never a partial one. The temp file is a sibling (same
 * filesystem) opened with 'wx', so a planted symlink cannot be followed.
 * Durability: fsync(file) before rename and fsync(dir) after it.
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Create the directory and its parents when missing. */
export function ensureDirSync(dir) {
  mkdirSync(dir, { recursive: true });
}

/** fsync a directory entry so a completed rename survives a crash. Best-effort where the platform rejects it. */
export function fsyncDirSync(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = error && error.code;
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EACCES' && code !== 'EPERM' && code !== 'EBADF') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Replace the target with data atomically and durably.
 * @param {string} filename absolute or relative target path
 * @param {string | Uint8Array} data complete next content
 * @param {{mode?: number}} [options] permission bits for the replacement inode (default 0600)
 */
export function writeFileAtomicSync(filename, data, options = {}) {
  const mode = options.mode === undefined ? 0o600 : options.mode;
  const dir = dirname(filename);
  ensureDirSync(dir);
  const temp = join(dir, '.' + basename(filename) + '.' + randomBytes(6).toString('hex') + '.tmp');
  let fd;
  try {
    fd = openSync(temp, 'wx', mode);
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, filename);
    fsyncDirSync(dir);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

/** Read a UTF-8 file, returning undefined when it does not exist. */
export function readFileSyncIfExists(filename) {
  try {
    return readFileSync(filename, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
