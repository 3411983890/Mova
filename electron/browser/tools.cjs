'use strict';
// Tool definitions for the in-app agent. The controller injects the actual
// operations, so this file stays free of Electron and easy to unit-test.

const { readFileSync } = require('node:fs');
const { classifyAction, labelOf, handoffLabelOf } = require('./policy.cjs');
const { classifyFailure, createTimingLedger } = require('./timing.cjs');

function coded(code, message, detail) {
  const error = new Error(message || code);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(error) {
  const image = error?.image;
  const verdict = classifyFailure(error, error?.detail);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: false,
        code: verdict.code,
        outcome: verdict.outcome,
        ...(verdict.indeterminate ? { indeterminate: true } : {}),
        message: error?.message || 'browser operation failed',
        ...(error?.suggestion ? { suggestion: error.suggestion } : (verdict.advice ? { suggestion: verdict.advice } : {})),
        ...(error?.detail ? { detail: error.detail } : {}),
      }),
    }, ...(image ? [image] : [])],
    isError: true,
  };
}

function createBrowserTools(operations) {
  const { navigate, snapshot, read, wait, act, dialog, runJs, storageExport, storageImport, upload, batch, login, handoff, screenshot, pointer, tabs, newTab, selectTab, closeTab, skillList, skillSave, skillRemove, emit, approve, getUrl, getPrefs } = operations;
  // 每轮账本：工具耗时、人工等待都记在这里。调用方（chat-agent / edge bridge）可以注入
  // 自己的账本，这样模型耗时和扩展通信耗时能和工具耗时汇总到同一份 summary。
  const timing = operations.timing || createTimingLedger({ label: 'browser' });
  const announce = (id, name, label, detail) => emit?.({ type: 'tool', id, name, label, status: 'running', detail });
  const settle = (id, name, label, status, detail) => emit?.({ type: 'tool', id, name, label, status, detail });

  const TIER_MAX = { read: 0, interact: 2, submit: 3 };
  async function authorize(input, signal) {
    const risk = classifyAction({ ...input, url: typeof getUrl === 'function' ? getUrl() : '' });
    // 只有「必须本人完成」的动作才停手：银行卡信息、扫码支付、密码/验证码。
    // 购买、下单、支付按钮属于正常购物流程，交给下面的等级判断即可。
    if (risk.handoff) {
      throw coded('requires-handoff', `${handoffLabelOf(risk.handoffReason)}；请调用 browser_handoff 让用户接过去完成`, {
        reason: risk.handoffReason,
        action: String(input.action || input.op || ''),
        target: input.target || '',
      });
    }
    const prefs = (typeof getPrefs === 'function' ? getPrefs() : null) ?? {};
    // 设置对象是 { agent: {...} }；老调用方直接传 agent 段。两种都要认，
    // 否则 sessionWaiver / confirmPerSite 在生产里会被静默忽略。
    const agentPrefs = prefs.agent ?? prefs;
    const tierMax = TIER_MAX[agentPrefs.tier] ?? TIER_MAX.interact;
    const overTier = risk.level > tierMax;
    const sensitive = risk.level >= 3 && agentPrefs.sensitiveAlwaysConfirm !== false;
    if (risk.level <= 1 && !overTier) return;
    if (typeof approve !== 'function') {
      throw coded('approval-unavailable', 'browser action approval is not configured');
    }
    const askEveryTime = sensitive || overTier;
    const askPerSite = agentPrefs.sessionWaiver !== true && agentPrefs.confirmPerSite !== false;
    if (!askEveryTime && !askPerSite) return;
    const decision = await timing.track('human', 'approval', () => approve({
      ...risk,
      action: String(input.action || input.op || ''),
      target: input.target || '',
      value: input.value || '',
      label: labelOf(risk),
      allowSession: !askEveryTime,
      tier: agentPrefs.tier ?? 'interact',
      overTier,
      handoff: risk.handoff,
      handoffReason: risk.handoffReason,
    }, signal));
    if (decision === 'deny') {
      throw coded('blocked-by-policy', '用户拒绝了这次浏览器操作', { origin: risk.origin, level: risk.level, reasons: risk.reasons });
    }
  }

  /**
   * 每个工具调用记一笔工具耗时。工具自己的 execute 已经负责 UI 事件与错误包装，
   * 这里只做计量，绝不改变返回值或吞掉异常。
   */
  function measured(tool) {
    if (!tool || typeof tool.execute !== 'function') return tool;
    const name = String(tool.name || 'browser_tool');
    return {
      ...tool,
      async execute(...args) {
        const started = Date.now();
        try {
          // guard() 把错误变成 isError 结果，同时挂一个非枚举之外的 __error，
          // 让计量能区分「成功」和「超时/未确定」，又不改变模型看到的 content。
          const value = await tool.execute(...args);
          const error = value && value.__error;
          const ms = Date.now() - started;
          if (error) timing.fail('tool', name, ms, error);
          else timing.span('tool', name, ms, { ok: true });
          if (value && '__error' in value) delete value.__error;
          return value;
        } catch (error) {
          timing.fail('tool', name, Date.now() - started, error);
          throw error;
        }
      },
    };
  }

  function guard(name, label, run) {
    return async (id, input, signal) => {
      announce(id, name, label);
      try {
        const value = await run(input || {}, signal);
        settle(id, name, label, 'done', value?.url || value?.mode || '');
        return result(value);
      } catch (error) {
        settle(id, name, label, 'error', error?.message || 'failed');
        return Object.assign(failure(error), { __error: error });
      }
    };
  }

  return [
    {
      name: 'browser_navigate',
      label: '打开网页',
      description: 'Open an http(s) URL — or a file:/// path inside a project folder — in the Mova side browser and return the page observation in the same call (observation.text), so no extra browser_snapshot is needed to see the page. Pass observe:"none" only when you will immediately act on a known page. Matching saved site skills are returned as skills:',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL, or a file:/// path inside a project folder (html/svg/images/pdf/text/markdown)' },
          timeout: { type: 'integer', description: 'Navigation timeout in ms (default 30000)' },
          observe: { type: 'string', enum: ['auto', 'full', 'none'], description: 'Default auto: wait for the page to settle and return a snapshot. none skips it.' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: guard('browser_navigate', '打开网页', input => navigate(input.url, input.space, { observe: input.observe, timeout: input.timeout })),
    },
    {
      name: 'browser_snapshot',
      label: '读取页面结构',
      description: 'Return the compact accessibility tree of the current page. Prefer this over screenshots. mode=auto returns only the diff since the last snapshot unless the page changed too much. Frames are on demand: the default frames:"index" lists iframes without their contents, then frame:"f1" reads one. ref:"@e12" returns only that subtree when a page is too large.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['auto', 'full', 'diff'], description: 'Default auto' },
          maxChars: { type: 'integer', description: 'Character budget, default 24000' },
          scope: { type: 'string', enum: ['page', 'main'], description: 'page includes the frame index; main skips frames entirely' },
          frames: { type: 'string', enum: ['none', 'index', 'all'], description: 'index (default) lists iframes only, all inlines their contents, none skips frames' },
          frame: { type: 'string', description: 'Frame id from a previous snapshot (f1, f2, ...) to read that iframe only' },
          ref: { type: 'string', description: 'Only return the subtree of this ref from the latest snapshot (@e12)' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        additionalProperties: false,
      },
      execute: guard('browser_snapshot', '读取页面结构', input => snapshot(input, input.space)),
    },
    {
      name: 'browser_read',
      label: '提取正文',
      description: 'Extract the main article/page text as Markdown. Use for reading content; use browser_snapshot to find controls.',
      parameters: {
        type: 'object',
        properties: {
          maxChars: { type: 'integer', description: 'Default 20000' },
          includeLinks: { type: 'boolean', description: 'Include the links found in the main content' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        additionalProperties: false,
      },
      execute: guard('browser_read', '提取正文', input => read(input, input.space)),
    },
    {
      name: 'browser_wait',
      label: '等待页面条件',
      description: 'Wait for a real page condition instead of sleeping. Prefer for="settle" after an action that triggers async work or animation, selector/text/url for a known target, frame for an iframe, download for a file. for="time" is capped at 2000 ms and is only a last resort.',
      parameters: {
        type: 'object',
        properties: {
          for: { type: 'string', enum: ['selector', 'text', 'text-change', 'url', 'load', 'settle', 'idle', 'animation', 'frame', 'download', 'time'] },
          selector: { type: 'string', description: 'Required for selector/frame/animation when scoping one element' },
          frame: { type: 'string', description: 'For for=frame: frame id from a previous snapshot (f1, f2, ...)' },
          state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
          text: { type: 'string', description: 'Expected text, or the previous text for text-change' },
          url: { type: 'string' },
          quietMs: { type: 'integer', description: 'For settle/idle: how long the DOM must stay quiet (default 150)' },
          ms: { type: 'integer', description: 'For for=time, max 2000' },
          timeout: { type: 'integer', description: 'Default 8000, max 30000' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        required: ['for'],
        additionalProperties: false,
      },
      execute: guard('browser_wait', '等待页面条件', input => wait(input, input.space)),
    },
    {
      name: 'browser_act',
      label: '操作页面',
      description: 'Click, fill, select, check, hover or press a key on one element. target is a ref from the latest snapshot (@e12) or css=selector. Returns a diff of what changed; if the diff is missing, take a snapshot.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll'] },
          target: { type: 'string', description: 'Ref (@e12) or css=selector' },
          value: { type: 'string', description: 'Text, option value, key name, true/false for check, or signed pixels for scroll' },
          clickCount: { type: 'integer', description: '1-3, default 1' },
          submit: { type: 'boolean', description: 'Press Enter after fill/type' },
          expect: {
            type: 'object',
            description: 'Optional post-condition: {selector,state,text,url}',
            properties: {
              selector: { type: 'string' },
              state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
              text: { type: 'string' },
              url: { type: 'string' },
              timeout: { type: 'integer' },
            },
            additionalProperties: false,
          },
          snapshot: { type: 'boolean', description: 'Set false to skip the post-action diff' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (id, input = {}, signal) => {
        announce(id, 'browser_act', '操作页面');
        try {
          await authorize(input, signal);
          const value = await act(input, input.space);
          const content = [{ type: 'text', text: JSON.stringify(value) }];
          if (value?.visualFallbackSuggested && input.visualFallback !== false) {
            try {
              const shot = await screenshot({ mode: 'thumb', reason: value.visualFallbackSuggested.reason, space: input.space });
              value.visualFallback = { mode: shot.mode, path: shot.path, width: shot.width, height: shot.height };
              content[0].text = JSON.stringify(value);
              if (shot.path) content.push({ type: 'image', data: readFileSync(shot.path).toString('base64'), mimeType: shot.mimeType || 'image/jpeg' });
            } catch { /* fallback only */ }
          }
          settle(id, 'browser_act', '操作页面', 'done', value?.url || '');
          return { content };
        } catch (error) {
          settle(id, 'browser_act', '操作页面', 'error', error?.message || 'failed');
          return Object.assign(failure(error), { __error: error });
        }
      },
    },
    {
      name: 'browser_dialog',
      label: '处理对话框',
      description: 'Accept or dismiss a currently open JavaScript alert/confirm/prompt. Alerts are auto-accepted and confirms are auto-dismissed by default; use this when the page needs a prompt answer.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['accept', 'dismiss', 'arm'] },
          policy: { type: 'string', enum: ['accept', 'dismiss'], description: 'For action=arm: policy for the next dialog' },
          promptText: { type: 'string', description: 'Text for a prompt dialog' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: guard('browser_dialog', '处理对话框', async (input, signal) => {
        await authorize({ action: 'press', value: 'Enter' }, signal);
        return dialog(input, input.space);
      }),
    },
    {
      name: 'browser_upload',
      label: '上传文件',
      description: 'Set absolute local file paths on a file input. Requires approval and accepts at most 5 files of 25 MB each.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Ref or css= selector for input[type=file]' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        required: ['target', 'files'],
        additionalProperties: false,
      },
      execute: guard('browser_upload', '上传文件', async (input, signal) => {
        if (getPrefs?.()?.transfer?.confirmUpload !== false) {
          await authorize({ action: 'upload', target: input.target }, signal);
        }
        return upload(input, input.space);
      }),
    },
    {
      name: 'browser_run_js',
      label: '执行 JS 批处理',
      description: 'Run a JavaScript batch against a small page API: goto/click/fill/press/waitFor/snapshot/evaluate/text. No require/process/fetch; vm is not a security boundary, so every run needs approval. Prefer browser_batch for ordinary steps.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript body; may await page.* calls and return JSON' },
          timeout: { type: 'integer', description: 'Default 15000, max 60000' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        required: ['script'],
        additionalProperties: false,
      },
      execute: guard('browser_run_js', '执行 JS 批处理', async (input, signal) => {
        if (getPrefs?.()?.advanced?.jsBatch !== true) {
          throw coded('js-batch-disabled', 'JavaScript 批处理已在设置中关闭，请先在「设置 → 浏览器 → 高级设置」打开');
        }
        await authorize({ action: 'run_js', value: '' }, signal);
        return runJs(input, input.space);
      }),
    },
    {
      name: 'browser_storage_state',
      label: '登录态导入导出',
      description: 'Export the current origin cookies/localStorage to an encrypted local file, or import it back. Values are never returned to the model. Import/export needs approval.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['export', 'import'] },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: guard('browser_storage_state', '登录态导入导出', async (input, signal) => {
        await authorize({ action: 'storage_state' }, signal);
        return input.action === 'import' ? storageImport(input.space) : storageExport(input.space);
      }),
    },
    {
      name: 'browser_batch',
      label: '批量操作',
      description: 'Preferred way to run a mechanical sequence: up to 30 steps in ONE tool call, one diff at the end, instead of one call per click. Use it whenever you already know the next 2+ steps, and replay a saved skill with {recipe, inputs} rather than re-deriving the flow. Steps: {op:"navigate"|"click"|"fill"|"type"|"press"|"select"|"check"|"hover"|"scroll"|"wait", ...}. Every write step is authorized separately; the batch stops at the first failure unless continueOnError is true. If the batch times out it returns partial results with the steps that really ran — continue from there instead of replaying. A successful result may include skillCandidate; when it does, weigh browser_skill save as described there.',
      parameters: {
        type: 'object',
        properties: {
          recipe: { type: 'string', description: 'Saved site skill id, replaces steps' },
          inputs: { type: 'object', description: 'Values for {{placeholders}} in the recipe', additionalProperties: true },
          steps: {
            type: 'array',
            description: 'Ordered steps',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['navigate', 'click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll', 'wait'] },
                url: { type: 'string' },
                target: { type: 'string' },
                value: { type: 'string' },
                selector: { type: 'string' },
                state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
                text: { type: 'string' },
                for: { type: 'string', enum: ['selector', 'text', 'text-change', 'url', 'load', 'settle', 'idle', 'animation', 'frame', 'download', 'time'] },
                ms: { type: 'integer' },
                quietMs: { type: 'integer' },
                timeout: { type: 'integer' },
                submit: { type: 'boolean' },
                observe: { type: 'boolean', description: 'For navigate: include the page snapshot in that step result' },
                expect: { type: 'object' },
              },
              required: ['op'],
              additionalProperties: true,
            },
          },
          continueOnError: { type: 'boolean' },
          snapshot: { type: 'string', enum: ['end', 'full', 'none'], description: 'Default end (diff)' },
          timeout: { type: 'integer', description: 'Whole batch timeout, default 90000' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
                    additionalProperties: false,
      },
      execute: guard('browser_batch', '批量操作', async (input, signal) => {
        const steps = input.steps || [];
        return batch(steps, {
          recipe: input.recipe || null,
          inputs: input.inputs || {},
          continueOnError: input.continueOnError === true,
          snapshot: input.snapshot || 'end',
          timeout: input.timeout,
          space: input.space,
          authorize: step => authorize({ ...step, action: step.op }, signal),
        });
      }),
    },
    {
      name: 'browser_login',
      label: '填充登录',
      description: 'Fill the current login form with credentials saved in the memory vault, optionally submitting. The password never enters the model context. If no credential exists, ask the user to use the key button in the browser panel.',
      parameters: {
        type: 'object',
        properties: {
          submit: { type: 'boolean', description: 'Press Enter after filling' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        additionalProperties: false,
      },
      execute: guard('browser_login', '填充登录', async (input, signal) => {
        await authorize({ action: 'login', value: '' }, signal);
        return login(input, input.space);
      }),
    },
    {
      name: 'browser_skill',
      label: '站点技能',
      description: 'List, save or remove reusable site procedures. Decide yourself when a flow is worth saving: save only after a successful multi-step flow (3+ steps) that is likely to be repeated and that the user did not say should be done just once; do not save one-off actions that only apply to the current data (this order, this search, this session\'s values). Saving uses the steps observed since the last navigation; replay with browser_batch({recipe, inputs}). After save succeeds, briefly tell the user the skill name.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'remove'] },
          id: { type: 'string', description: 'Skill id for remove' },
          title: { type: 'string', description: 'Required short human title for save (max 80 chars)' },
          intent: { type: 'array', items: { type: 'string' }, description: 'Words that describe when to use it' },
          verify: { type: 'object', description: 'Optional success check' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: guard('browser_skill', '站点技能', async input => {
        if (input.action === 'save') return skillSave(input);
        if (input.action === 'remove') return skillRemove(input.id);
        return skillList();
      }),
    },
    {
      name: 'browser_handoff',
      label: '交给用户接管',
      description: 'Pause and let the user take over the browser for bank-card details, QR-code or payment-code steps, CAPTCHA, 2FA, login credentials, or a decision you must not make. Ordinary purchase and checkout clicks do not need this. Waits until the user resumes or cancels (up to 10 minutes). Always take a fresh snapshot after resuming.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: ['login', 'captcha', '2fa', 'payment', 'consent', 'choice'] },
          note: { type: 'string', description: 'One short sentence telling the user what to do' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        required: ['reason'],
        additionalProperties: false,
      },
      execute: guard('browser_handoff', '交给用户接管', (input, signal) => timing.track('human', 'handoff', () => handoff(input, signal, input.space))),
    },
    {
      name: 'browser_screenshot',
      label: '页面截图',
      description: 'Capture the visible page (or the full page). Only works while the side browser is visible; if it fails with tab-not-visible, open the browser panel first.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['none', 'thumb', 'viewport', 'full'], description: 'Default viewport' },
          includeInResult: { type: 'boolean', description: 'Attach the image to the tool result' },
          reason: { type: 'string', description: 'visual-check | canvas | diff-empty | user-request' },
          fullPage: { type: 'boolean', description: 'Legacy alias for mode=full' },
          space: { type: 'string', description: 'Space id; omit for the active space' },
        },
        additionalProperties: false,
      },
      execute: async (id, input = {}, signal) => {
        announce(id, 'browser_screenshot', '页面截图');
        try {
          const { data, ...value } = await screenshot(input, input.space);
          const content = [{ type: 'text', text: JSON.stringify(value) }];
          if (input.includeInResult !== false && (data || value.path)) {
            content.push({ type: 'image', data: data || readFileSync(value.path).toString('base64'), mimeType: value.mimeType || 'image/png' });
          }
          settle(id, 'browser_screenshot', '页面截图', 'done', value?.mode || '');
          return { content };
        } catch (error) {
          settle(id, 'browser_screenshot', '页面截图', 'error', error?.message || 'failed');
          return Object.assign(failure(error), { __error: error });
        }
      },
    },
    ...(pointer ? [{
      name: 'browser_pointer',
      label: '网页鼠标操作',
      description: 'Click or drag inside the last viewport screenshot. Use its viewId and normalized coordinates: (0,0) is top left and each axis ranges from 0 to less than 1. Take a fresh screenshot after the operation.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'drag'] },
          viewId: { type: 'string' },
          x: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
          y: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
          endX: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
          endY: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
          space: { type: 'string' },
        },
        required: ['action', 'viewId', 'x', 'y'],
        additionalProperties: false,
      },
      execute: guard('browser_pointer', '网页鼠标操作', async (input, signal) => {
        await authorize({ action: input.action, target: `(${input.x}, ${input.y})`, value: input.action === 'drag' ? `(${input.endX}, ${input.endY})` : '' }, signal);
        return pointer(input, input.space, signal);
      }),
    }] : []),
    {
      name: 'browser_tabs',
      label: '标签页',
      description: 'List the browser tabs controlled by Mova and which one is active.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
          tabId: { type: 'string', description: 'Target tab for select/close' },
          url: { type: 'string', description: 'URL for new' },
          space: { type: 'string', description: 'Space id for new (defaults to the active space)' },
          background: { type: 'boolean', description: 'Create without switching the visible Space' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: guard('browser_tabs', '标签页', async input => {
        if (input.action === 'new') {
          const target = await newTab(input.url, input.space, { background: input.background === true });
          return { ok: true, tabId: target.tabId, url: target.url, title: target.title };
        }
        if (input.action === 'select') {
          const target = await selectTab(input.tabId);
          return { ok: true, tabId: target.tabId, url: target.url, title: target.title };
        }
        if (input.action === 'close') return closeTab(input.tabId);
        return tabs();
      }),
    },
  ].map(measured);
}

module.exports = { createBrowserTools };
