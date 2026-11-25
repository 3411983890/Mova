'use strict';
// Opt-in JavaScript batch runner. The sandbox is a capability boundary, not a
// security boundary: it has no require/process/fs/fetch, but vm is not a
// hardened jail. Callers must approve every run.

const vm = require('node:vm');

const MAX_SCRIPT = 20000;
const DEFAULT_TIMEOUT = 15000;

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

async function runJavaScript(target, script, options = {}) {
  if (typeof script !== 'string' || !script.trim()) throw coded('invalid-argument', 'script is required');
  if (script.length > MAX_SCRIPT) throw coded('invalid-argument', `script exceeds ${MAX_SCRIPT} chars`);
  const timeout = Number.isInteger(options.timeout) ? Math.min(Math.max(options.timeout, 50), 60000) : DEFAULT_TIMEOUT;

  const page = Object.freeze({
    goto: url => target.navigate(url),
    click: selector => target.act({ action: 'click', target: selector, snapshot: false }),
    fill: (selector, value) => target.act({ action: 'fill', target: selector, value: String(value ?? ''), snapshot: false }),
    press: key => target.act({ action: 'press', value: key, snapshot: false }),
    waitFor: condition => target.wait(condition),
    snapshot: options => target.snapshot({ mode: 'auto', ...(options || {}) }),
    evaluate: expression => target.evaluate(typeof expression === 'function' ? `(${expression})()` : String(expression)),
    text: async selector => target.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); return el ? el.innerText : null; })()`),
  });

  const sandbox = {
    page,
    console: { log() {}, info() {}, warn() {}, error() {} },
    JSON,
    Math,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);

  let execution;
  try {
    execution = vm.runInContext(`(async () => {\n${script}\n})()`, sandbox, { timeout });
  } catch (error) {
    throw coded('js-failed', error?.message || 'script failed');
  }

  let timer;
  try {
    const value = await Promise.race([
      execution,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(coded('js-timeout', 'script timed out')), timeout);
      }),
    ]);
    let serialized;
    try { serialized = JSON.stringify(value ?? null); } catch { throw coded('js-result', 'result is not JSON serializable'); }
    if (typeof serialized !== 'string' || serialized.length > 32000) throw coded('js-result', 'result exceeds 32 KB');
    // vm returns objects from another realm; normalize to plain JSON values.
    return { ok: true, result: JSON.parse(serialized) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runJavaScript, MAX_SCRIPT, DEFAULT_TIMEOUT };
