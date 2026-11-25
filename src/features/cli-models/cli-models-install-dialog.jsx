/**
 * 「没装 antigravity CLI」弹窗。
 *
 * 负责：把 install-cli-prompt.mjs 生成的提示词展示成可复制的文本块，并给出
 * 「复制给 Agent / 已安装，重新检测 / 手动选择 CLI 路径 / 关闭」四个出口。
 * 不负责：判断该不该弹（由 cli-models-settings.jsx 决定）、探测 CLI（use-subscription）、
 * 文案本身（install-cli-prompt.mjs 的 buildDialogCopy）。
 *
 * 为什么复制不用 preload：剪贴板是浏览器能力，navigator.clipboard 失败时退回
 * 「全选提示词」，保证在权限被拒的情况下用户仍然能拿到这段文本。
 *
 * 被谁调用：src/features/cli-models/cli-models-settings.jsx
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  MIN_VERSION, buildAgentInstallPrompt, buildDialogCopy, cliStateOf, formatCliVersion,
} from './install-cli-prompt.mjs';

const COPY_TEXT = Object.freeze({
  ok: '已复制，粘贴给任意 AI Agent 即可。',
  failed: '复制失败，请手动全选下面的文本再复制。',
  manual: '请在文本块内手动全选复制。',
});

export function CliInstallDialog({ open, status, platform, onClose, onRecheck, onPickPath }) {
  const ref = useRef(null);
  const titleRef = useRef(null);
  const promptRef = useRef(null);
  const titleId = useId();
  const [copyState, setCopyState] = useState('idle');

  const state = cliStateOf(status);
  const copy = buildDialogCopy({ platform, status });
  const prompt = buildAgentInstallPrompt({ platform, status });
  const version = formatCliVersion(status?.version);

  // 原生 dialog：showModal 负责焦点陷阱与 Esc（Esc 走 onCancel，不让它直接关掉，
  // 这样「关闭」始终经过同一套状态回收）。
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // 每次打开都把「已复制」提示清掉，并聚焦标题：读屏用户先听到问题，再听到说明。
  useEffect(() => {
    if (!open) {
      setCopyState('idle');
      return;
    }
    const timer = setTimeout(() => titleRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  const selectPrompt = useCallback(() => {
    const node = promptRef.current;
    const selection = typeof window === 'undefined' ? null : window.getSelection?.();
    if (!node || !selection) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }, []);

  async function handleCopy() {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(prompt);
      setCopyState('ok');
    } catch {
      // 权限被拒 / 非安全上下文：把文本选中，用户按一次 Ctrl+C 就够。
      setCopyState(selectPrompt() ? 'failed' : 'manual');
    }
  }

  return (
    <dialog
      ref={ref}
      className="cm-install-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === ref.current) onClose(); }}
    >
      <div className="cm-install-body">
        <h3 className="cm-install-title" id={titleId} ref={titleRef} tabIndex={-1}>{copy.title}</h3>
        <p className="cm-install-desc">{copy.description}</p>
        {state === 'outdated' ? (
          <p className="cm-install-required">
            当前版本 {version ? `v${version}` : '读不出来'} · 需要 ≥ v{MIN_VERSION}
          </p>
        ) : null}

        <pre
          className="cm-install-prompt"
          ref={promptRef}
          tabIndex={0}
          aria-label="可直接复制给 AI Agent 的安装提示词"
        >
          {prompt}
        </pre>

        <p className="cm-install-hint" data-tone={copy.tone}>{copy.hint}</p>
        {copyState === 'idle' ? null : (
          <p className="cm-install-status" role="status" data-tone={copyState === 'ok' ? 'ok' : 'error'}>
            {COPY_TEXT[copyState]}
          </p>
        )}
      </div>

      <div className="cm-install-foot">
        <button type="button" className="cm-link cm-install-text" onClick={() => onPickPath?.()}>手动选择 CLI 路径</button>
        <div className="cm-install-buttons">
          <button type="button" className="settings-button" onClick={() => onRecheck?.()}>{copy.secondary}</button>
          <button type="button" className="settings-button primary" onClick={() => { void handleCopy(); }}>
            {copy.primary}
          </button>
          <button type="button" className="settings-button" onClick={() => onClose?.()}>关闭</button>
        </div>
      </div>
    </dialog>
  );
}

export default CliInstallDialog;
