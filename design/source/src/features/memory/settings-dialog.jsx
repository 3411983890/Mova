import React, { useEffect, useRef } from 'react';

/**
 * 设置页通用对话框（原生 <dialog> + showModal）。
 * 自带焦点陷阱、Esc 关闭、点遮罩关闭；视觉与间距走 Mova设置页设计规范 6.13。
 */
export function SettingsDialog({ open, onClose, title, children, footer, size }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const cancel = event => { event.preventDefault(); onClose(); };
    const click = event => { if (event.target === dialog) onClose(); };
    dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('click', click);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('click', click);
    };
  }, [onClose]);

  return <dialog ref={ref} className="settings-dialog" data-size={size} aria-label={title}>
    <div className="settings-dialog-head">
      <h2>{title}</h2>
      <button type="button" className="memory-icon-button" aria-label="关闭" onClick={onClose}>×</button>
    </div>
    <div className="settings-dialog-body">{children}</div>
    <div className="settings-dialog-actions">{footer}</div>
  </dialog>;
}

export default SettingsDialog;
