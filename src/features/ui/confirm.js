/* 原生确认弹窗：供不用 React 的区域（已归档、聊天操作等）使用，
   视觉与 React 的 SettingsDialog 完全一致（复用 .settings-dialog 系列类）。 */

export function confirmAction({ title, body, detail, confirmLabel = '确认', cancelLabel = '取消', confirmWord, tone = 'primary' }) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-dialog';
    dialog.setAttribute('aria-label', title);

    const head = document.createElement('div');
    head.className = 'settings-dialog-head';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'memory-icon-button';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    head.append(heading, close);

    const content = document.createElement('div');
    content.className = 'settings-dialog-body';
    const paragraph = document.createElement('p');
    paragraph.textContent = body;
    content.append(paragraph);
    if (detail) {
      const box = document.createElement('p');
      box.className = 'memory-detail-text';
      box.textContent = detail;
      content.append(box);
    }

    let input;
    if (confirmWord) {
      const field = document.createElement('label');
      field.className = 'memory-confirm-field';
      const label = document.createElement('span');
      label.append('输入 ');
      const word = document.createElement('strong');
      word.className = 'memory-confirm-word';
      word.textContent = confirmWord;
      label.append(word, ' 以确认');
      input = document.createElement('input');
      input.autocomplete = 'off';
      field.append(label, input);
      content.append(field);
    }

    const actions = document.createElement('div');
    actions.className = 'settings-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'settings-button';
    cancel.textContent = cancelLabel;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = `settings-button ${tone === 'danger' ? 'danger-solid' : 'primary'}`;
    confirm.textContent = confirmLabel;
    confirm.disabled = Boolean(confirmWord);
    actions.append(cancel, confirm);

    dialog.append(head, content, actions);
    document.body.append(dialog);

    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };

    if (input) {
      input.addEventListener('input', () => { confirm.disabled = input.value !== confirmWord; });
      setTimeout(() => input.focus(), 20);
    }
    cancel.addEventListener('click', () => finish(false));
    close.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('click', event => { if (event.target === dialog) finish(false); });

    dialog.showModal();
    // 与其它弹窗一致的 Q 弹入场。
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const opening = dialog.animate([
        { opacity: 0, transform: 'scale(.94) translateY(6px)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 300, easing: 'cubic-bezier(.2, 1.22, .35, 1)', fill: 'both' });
      opening.addEventListener('finish', () => opening.cancel(), { once: true });
    }
    if (!input) setTimeout(() => confirm.focus(), 20);
  });
}
