/**
 * 负责：在群聊详情中复用工作位置表单。
 * 不负责：保存群聊或配对凭据。
 * 被谁调用：app.js。
 */
import React, { useState } from 'react';
import { WorkspaceLocation } from '../cloud-connections/workspace-location.jsx';
import './place-dialog.css';

export function PlacePicker({ location, value, onSelect, onCancel }) {
  const [place, setPlace] = useState(value);
  return <div className="place-dialog-panel">
    <header className="place-dialog-head">
      <h2 id="place-dialog-title">工作位置</h2>
      <button type="button" className="place-dialog-close" aria-label="关闭" onClick={onCancel}>×</button>
    </header>
    <div className="place-dialog-body">
      <WorkspaceLocation {...location} value={place} onChange={setPlace}
        onPickFolders={location?.pickFolder ? () => location.pickFolder(setPlace) : undefined} />
    </div>
    <footer className="place-dialog-actions">
      <button type="button" className="place-dialog-cancel" onClick={onCancel}>取消</button>
      <button type="button" className="place-dialog-cancel place-dialog-save" onClick={() => onSelect(place)}>保存</button>
    </footer>
  </div>;
}
