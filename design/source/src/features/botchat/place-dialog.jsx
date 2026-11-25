// 选择工作位置：从下拉改成独立弹窗（项目 / 此电脑文件夹 / 不设置）。
import React, { useEffect, useRef } from 'react';
import { Check, Folder, Laptop } from '@keyline-icons/react';
import './place-dialog.css';

export function PlacePicker({ places = [], value, onSelect, onCancel }) {
  const folder = useRef(null);

  useEffect(() => {
    const input = folder.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const pick = place => onSelect(place);

  return <div className="place-dialog-panel">
    <header className="place-dialog-head">
      <h2 id="place-dialog-title">选择工作位置</h2>
      <button type="button" className="place-dialog-close" aria-label="关闭" onClick={onCancel}>×</button>
    </header>

    <div className="place-dialog-body">
      <p className="place-dialog-note">群聊的工作位置决定它在哪个项目或文件夹下协作。</p>

      {places.length > 0 && <section className="place-group" aria-label="项目">
        <p className="place-group-label">项目</p>
        {places.map(item => <button type="button" key={item.id} className={`place-option${value?.id === item.id ? ' is-current' : ''}`} aria-pressed={value?.id === item.id} onClick={() => pick(item)}>
          <Folder size={14} />
          <span className="place-option-copy"><strong>{item.name}</strong><small>项目</small></span>
          {value?.id === item.id && <Check size={13} />}
        </button>)}
      </section>}

      <section className="place-group" aria-label="此电脑">
        <p className="place-group-label">此电脑</p>
        <button type="button" className={`place-option${value?.kind === 'folder' ? ' is-current' : ''}`} onClick={() => folder.current?.click()}>
          <Laptop size={14} />
          <span className="place-option-copy"><strong>{value?.kind === 'folder' ? value.name : '选择一个文件夹…'}</strong><small>从本机挑选一个目录</small></span>
          {value?.kind === 'folder' && <Check size={13} />}
        </button>
        <input ref={folder} type="file" hidden onChange={event => {
          const file = event.target.files?.[0];
          if (!file) return;
          const path = file.webkitRelativePath?.split('/')[0] || file.name;
          event.target.value = '';
          pick({ id: `folder:${path}`, name: path, kind: 'folder' });
        }} />
      </section>

      {value && <button type="button" className="place-clear" onClick={() => pick(null)}>不设置工作位置</button>}
    </div>

    <footer className="place-dialog-actions">
      <button type="button" className="place-dialog-cancel" onClick={onCancel}>取消</button>
    </footer>
  </div>;
}
