import { Copy, Minus, Square, X } from '@keyline-icons/react';
import { useEffect, useState } from 'react';

export function WindowControls({ desktop }: { desktop?: DesktopWindow }) {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!desktop) return;
    let receivedChange = false;
    let active = true;
    const update = (value: boolean) => {
      document.documentElement.classList.toggle('window-maximized', value);
      setMaximized(value);
    };
    const unsubscribe = desktop.onMaximizedChange(value => {
      receivedChange = true;
      update(value);
    });
    desktop.isMaximized().then(value => {
      if (active && !receivedChange) update(value);
    }).catch(() => {
      if (active) setError('无法读取窗口状态');
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop]);

  function act(action: WindowAction) {
    setError('');
    desktop?.act(action).catch(() => setError('窗口操作失败，请重试'));
  }

  const maximizeLabel = maximized ? '还原窗口' : '最大化';
  const MaximizeIcon = maximized ? Copy : Square;
  const browserTooltip = '窗口操作仅在桌面版可用';
  return (
    <>
      <button type="button" aria-label="最小化" title={desktop ? '最小化' : browserTooltip} disabled={!desktop} onClick={() => act('minimize')}>
        <i className="keyline-icon" aria-hidden="true"><Minus size="1em" /></i>
      </button>
      <button type="button" aria-label={maximizeLabel} title={desktop ? maximizeLabel : browserTooltip} disabled={!desktop} onClick={() => act('toggleMaximize')}>
        <i className="keyline-icon" aria-hidden="true"><MaximizeIcon size="1em" /></i>
      </button>
      <button type="button" className="close-window" aria-label="关闭" title={desktop ? '关闭' : browserTooltip} disabled={!desktop} onClick={() => act('close')}>
        <i className="keyline-icon" aria-hidden="true"><X size="1em" /></i>
      </button>
      <span className="visually-hidden" role="status">{error}</span>
    </>
  );
}
