/**
 * CLI 模型设置页的原子控件。
 *
 * 负责：开关、下拉（按钮 + 固定定位菜单）、图标、「…」菜单、对话框、右下角 toast。
 * 不负责：任何业务数据（账号 / 额度）。
 *
 * 为什么菜单用 createPortal + position:fixed：卡片是 overflow:hidden，
 * 任何 absolute 菜单都会被裁掉（见 cli-models-settings.html 的 .menu-host 注释）。
 *
 * 被谁调用：src/features/cli-models/cli-models-settings.jsx
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// useLayoutEffect 在 SSR 下会告警；没有 window 时退化成 useEffect。
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const ICONS = Object.freeze({
  more: <><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></>,
  refresh: <path d="M20 11a8 8 0 1 0-2.6 6M20 5v6h-6" />,
  logout: <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M15 8l4 4-4 4M19 12H9" />,
  plus: <path d="M12 5v14M5 12h14" />,
  caret: <path d="m6 9 6 6 6-6" />,
  check: <path d="m4 12 5.5 5.5L20 6" />,
  warn: <><path d="M12 4 3 20h18L12 4Z" /><path d="M12 10v4M12 17.5h.01" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
});

/** 图标：内联 path，不依赖 index.html 里的 <symbol>，也不用新增图标依赖。 */
export function Icon({ name, className = '' }) {
  return (
    <svg className={`cm-icon ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name] ?? ICONS.terminal}
    </svg>
  );
}

/** 开关：role="switch" + aria-checked（§6.6）。 */
export function CmSwitch({ label, checked, disabled, onChange }) {
  return (
    <button
      type="button"
      className="settings-switch cm-switch"
      role="switch"
      aria-checked={checked === true}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/**
 * 固定定位弹层：先渲染再量高度，空间不够就向上翻（与原型 placeMenu 一致）。
 */
export function CmPopup({ open, anchorRef, onClose, children, role = 'menu', ariaLabel, className = '' }) {
  const menuRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState(null);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 168;
    const height = menu.offsetHeight || 0;
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 6) : below;
    setPosition({ top, left });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (menuRef.current && menuRef.current.contains(event.target)) return;
      closeRef.current();
    };
    const onKeyDown = event => { if (event.key === 'Escape') closeRef.current(); };
    const onViewportChange = () => closeRef.current();
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    // 加载期的布局抖动会派发 scroll；延迟挂监听，免得刚打开就被关掉。
    const timer = setTimeout(() => window.addEventListener('scroll', onViewportChange, true), 260);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      clearTimeout(timer);
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={menuRef}
      className={`cm-popup ${className}`.trim()}
      role={role}
      aria-label={ariaLabel}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 下拉：按钮 + 菜单（选中项带勾），取值变化后立刻回写设置。 */
export function CmSelect({ value, options, onChange, disabled, ariaLabel, fallbackLabel = '—', className = '' }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const current = options.find(option => option.value === value) ?? null;
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`settings-select cm-select ${className}`.trim()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onMouseDown={event => event.stopPropagation()}
        onClick={() => setOpen(previous => !previous)}
      >
        <span className="cm-select-value">{current?.label ?? fallbackLabel}</span>
        <Icon name="caret" />
      </button>
      <CmPopup open={open} anchorRef={buttonRef} onClose={close} ariaLabel={ariaLabel}>
        {options.map(option => (
          <button
            key={String(option.value)}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === value}
            className="cm-menu-item"
            onClick={() => {
              setOpen(false);
              if (option.value !== value) onChange(option.value);
            }}
          >
            <span className="cm-menu-label">{option.label}</span>
            {option.value === value ? <Icon name="check" className="cm-menu-check" /> : null}
          </button>
        ))}
      </CmPopup>
    </>
  );
}

/**
 * 原生 dialog：危险确认（§6.13）。开关由 open 驱动，ESC / 点遮罩都按「取消」处理。
 *
 * `error`（可选）：**这一次**提交失败的原因。有值时在正文下方渲染一行行内报错
 * （`role="alert"`），弹窗保持打开，用户改完可以直接再点一次。
 * 为什么需要它：`showModal()` + `::backdrop` 会把页面里的错误横幅整个盖住，
 * 弹窗内的动作失败如果只写进页级状态，用户看到的就是「点保存什么都不发生」。
 * 不传 `error` 的调用方完全不受影响（不渲染这一行）。
 */
export function CmDialog({ open, title, body, detail, confirmLabel, cancelLabel = '取消', tone = 'default', busy, error, onConfirm, onCancel, children }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="cm-dialog"
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onCancel(); }}
      onClick={event => { if (event.target === ref.current) onCancel(); }}
    >
      <div className="cm-dialog-body">
        <h3 id={titleId}>{title}</h3>
        {body ? <p>{body}</p> : null}
        {detail ? <div className="cm-dialog-subject">{detail}</div> : null}
        {children}
        {error ? <div className="cm-dialog-error" role="alert">{error}</div> : null}
      </div>
      <div className="cm-dialog-foot">
        <button type="button" className="settings-button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button
          type="button"
          className={`settings-button ${tone === 'danger' ? 'danger-solid' : 'primary'}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/** toast 队列：3 秒自动消失，最多同时 3 条（§6.20）。 */
export function useToasts() {
  const [items, setItems] = useState([]);
  const seq = useRef(0);

  const push = useCallback((message, tone = 'default') => {
    if (!message) return;
    seq.current += 1;
    const id = seq.current;
    setItems(previous => [...previous.slice(-2), { id, message, tone }]);
    setTimeout(() => setItems(previous => previous.filter(item => item.id !== id)), 3000);
  }, []);

  const dismiss = useCallback(id => setItems(previous => previous.filter(item => item.id !== id)), []);

  return { items, push, dismiss };
}

export function CmToastStack({ items, onDismiss }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="cm-toast-stack" role="status" aria-live="polite">
      {items.map(item => (
        <div className="cm-toast" key={item.id} data-tone={item.tone}>
          <span className="cm-toast-text">{item.message}</span>
          <button type="button" className="cm-toast-close" aria-label="关闭提示" onClick={() => onDismiss(item.id)}>✕</button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
