/**
 * Line-level diff for the in-app approval bar.
 *
 * The main process sends a before/after snapshot with every write approval, but
 * the bar used to print the two blocks side by side. Reviewing a change meant
 * eyeballing two 60-line blocks. This module computes a real diff in the
 * renderer: no dependency, no second copy of the file, nothing leaves the app.
 *
 * `computeLineDiff(before, after)` returns:
 *   [{ type: 'context' | 'add' | 'remove', beforeLine?, afterLine?, text }]
 * `beforeLine`/`afterLine` are 1-based line numbers on each side.
 */

/** Above this many characters the bar shows plain text instead of a diff. */
export const DIFF_CHAR_LIMIT = 200_000;

/** Diff rows rendered before the "show all" button appears. */
export const DEFAULT_DIFF_LINES = 300;

/**
 * The LCS table is O(n*m) cells. Two 5,000-line files would need 100 MB, which
 * would stall the window for a change the user only wants to skim. Past this
 * budget the changed block is reported as "all removed, then all added": still
 * truthful (every line is shown on the right side), just not minimal.
 */
const MAX_DP_CELLS = 2_000_000;

/**
 * Splits text into lines the way an editor counts them. A file that ends with a
 * newline does not get a phantom empty last line; CRLF is normalized first so a
 * Windows file does not diff every line because of `\r`.
 */
export function splitLines(text) {
  if (text == null) return [];
  const normalized = String(text).replace(/\r\n?/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** True when the pair is too large to diff; the bar then falls back to text. */
export function exceedsDiffLimit(before, after) {
  const beforeLength = typeof before === 'string' ? before.length : 0;
  const afterLength = typeof after === 'string' ? after.length : 0;
  return Math.max(beforeLength, afterLength) > DIFF_CHAR_LIMIT;
}

function row(type, text, beforeIndex, afterIndex) {
  const entry = { type, text };
  // Only the side the line exists on carries a number: a removed line has no
  // place in the new file, and vice versa.
  if (beforeIndex != null) entry.beforeLine = beforeIndex + 1;
  if (afterIndex != null) entry.afterLine = afterIndex + 1;
  return entry;
}

/** Diff of two line arrays whose common prefix/suffix are already removed. */
function diffMiddle(beforeLines, afterLines) {
  const beforeCount = beforeLines.length;
  const afterCount = afterLines.length;

  if (!beforeCount || !afterCount) {
    const rows = [];
    for (let index = 0; index < beforeCount; index += 1) rows.push(row('remove', beforeLines[index], index, null));
    for (let index = 0; index < afterCount; index += 1) rows.push(row('add', afterLines[index], null, index));
    return rows;
  }

  if ((beforeCount + 1) * (afterCount + 1) > MAX_DP_CELLS) {
    const rows = [];
    for (let index = 0; index < beforeCount; index += 1) rows.push(row('remove', beforeLines[index], index, null));
    for (let index = 0; index < afterCount; index += 1) rows.push(row('add', afterLines[index], null, index));
    return rows;
  }

  // Suffix LCS table, one Uint32Array: table[i][j] is the LCS length of
  // beforeLines[i:] and afterLines[j:]. Walking it forward reproduces the diff
  // without recursion.
  const width = afterCount + 1;
  const table = new Uint32Array((beforeCount + 1) * width);
  for (let i = beforeCount - 1; i >= 0; i -= 1) {
    const rowStart = i * width;
    const nextRowStart = rowStart + width;
    for (let j = afterCount - 1; j >= 0; j -= 1) {
      table[rowStart + j] = beforeLines[i] === afterLines[j]
        ? table[nextRowStart + j + 1] + 1
        : Math.max(table[nextRowStart + j], table[rowStart + j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < beforeCount && j < afterCount) {
    if (beforeLines[i] === afterLines[j]) {
      rows.push(row('context', beforeLines[i], i, j));
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push(row('remove', beforeLines[i], i, null));
      i += 1;
    } else {
      rows.push(row('add', afterLines[j], null, j));
      j += 1;
    }
  }
  while (i < beforeCount) {
    rows.push(row('remove', beforeLines[i], i, null));
    i += 1;
  }
  while (j < afterCount) {
    rows.push(row('add', afterLines[j], null, j));
    j += 1;
  }
  return rows;
}

/**
 * Line diff between two snapshots. `null`/`undefined` mean "no file on that
 * side" (a new file or a deleted one) and become an empty side, never a crash.
 */
export function computeLineDiff(before, after) {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const maxHead = Math.min(beforeLines.length, afterLines.length);

  let head = 0;
  while (head < maxHead && beforeLines[head] === afterLines[head]) head += 1;

  let tail = 0;
  const maxTail = Math.min(beforeLines.length, afterLines.length) - head;
  while (
    tail < maxTail
    && beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) tail += 1;

  const result = [];
  for (let index = 0; index < head; index += 1) {
    result.push(row('context', beforeLines[index], index, index));
  }

  const beforeMiddle = beforeLines.slice(head, beforeLines.length - tail);
  const afterMiddle = afterLines.slice(head, afterLines.length - tail);
  for (const entry of diffMiddle(beforeMiddle, afterMiddle)) {
    result.push({
      ...entry,
      ...(entry.beforeLine != null ? { beforeLine: entry.beforeLine + head } : {}),
      ...(entry.afterLine != null ? { afterLine: entry.afterLine + head } : {}),
    });
  }

  for (let offset = tail; offset > 0; offset -= 1) {
    const beforeIndex = beforeLines.length - offset;
    const afterIndex = afterLines.length - offset;
    result.push(row('context', beforeLines[beforeIndex], beforeIndex, afterIndex));
  }
  return result;
}

/** `{ added, removed }` for the `+X −Y` label. */
export function diffSummary(diff) {
  let added = 0;
  let removed = 0;
  for (const entry of Array.isArray(diff) ? diff : []) {
    if (entry?.type === 'add') added += 1;
    else if (entry?.type === 'remove') removed += 1;
  }
  return { added, removed };
}
