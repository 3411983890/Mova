/**
 * 「网络与线路」页的三个弹窗：订阅导入、线路池编辑、删除确认。
 *
 * 负责：三者各自的表单结构、受控输入与提交动作的组装（动作本体由 use-vpn 提供）。
 * 不负责：数据读取（use-vpn.js）、页面编排（vpn-settings.jsx）、样式（vpn-settings.css）。
 *
 * 为什么单独成文件：vpn-settings.jsx 只该做「三段编排」，弹窗表单塞进同一个文件会让
 * 主视图淹没在 150 行表单 JSX 里（方案 §7.3 也把导入弹窗列为独立文件）。
 */
import React from 'react';
import { summarizeImportResult } from '../../../electron/vpn/contract.mjs';
import { CmDialog, CmSelect } from '../cli-models/cli-models-parts.jsx';

export const STRATEGY_OPTIONS = [
  { value: 'url-test', label: '自动优选（url-test）' },
  { value: 'fallback', label: '故障转移（fallback）' },
  { value: 'select', label: '手动选择（select）' },
];

/**
 * 导入结果提示：「共 9 条，导入 7 条，跳过 2 条（不支持的协议：anytls ×2）」。
 *
 * 为什么要有这一行：订阅里出现本版本不认识的协议时，旧行为是**静默少两个节点**，
 * 用户只会看到「导入成功 7 条」却不知道为什么少了、也看不到哪两个还能用。
 * 传入 `parseImportPayload` 的原始返回（或 IPC 透传后的同名字段）即可；没有结果时不渲染。
 */
export function ImportResultNote({ result }) {
  const summary = summarizeImportResult(result);
  if (!summary.text) return null;
  return (
    <p className="vpn-inline-note" role="status" data-tone={summary.partial ? 'warn' : 'ok'}>
      {summary.text}
    </p>
  );
}

/**
 * 订阅链接导入。`draft` 为 null 时关闭；提交成功后由调用方清空。
 * `error` 是**这一次**提交的失败原因，由调用方在失败分支里传进来（弹窗保持打开）。
 */
export function SubscriptionDialog({ draft, busy, error, onChange, onCancel, onSubmit, result }) {
  return (
    <CmDialog
      open={Boolean(draft)}
      title="导入订阅链接"
      body="链接会用 clash.meta UA 拉取并加密保存；节点密码不会出现在界面与日志里。"
      confirmLabel="导入"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onSubmit}
    >
      <label className="vpn-field">
        <span>订阅链接</span>
        <input
          type="url"
          value={draft?.url ?? ''}
          placeholder="https://…"
          onChange={event => onChange({ ...draft, url: event.target.value })}
        />
      </label>
      <label className="vpn-field">
        <span>显示名称（可选）</span>
        <input
          type="text"
          value={draft?.name ?? ''}
          placeholder="例如 机场 A"
          onChange={event => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <ImportResultNote result={result} />
    </CmDialog>
  );
}

/** 新建 / 编辑线路池。`draft = { id, name, strategy, nodeIds }`。 */
export function PoolDialog({ draft, nodes, busy, error, onChange, onCancel, onSubmit }) {
  return (
    <CmDialog
      open={Boolean(draft)}
      title={draft?.id ? '编辑线路池' : '新建线路池'}
      body="同一条线路被多个模型共用时只会启动一个本地入站端口。"
      confirmLabel="保存"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onSubmit}
    >
      <label className="vpn-field">
        <span>名称</span>
        <input
          type="text"
          value={draft?.name ?? ''}
          placeholder="例如 GPT 自动优选池"
          onChange={event => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <div className="vpn-field">
        <span>切换策略</span>
        <CmSelect
          ariaLabel="切换策略"
          value={draft?.strategy ?? 'url-test'}
          options={STRATEGY_OPTIONS}
          onChange={value => onChange({ ...draft, strategy: value })}
        />
      </div>
      <div className="vpn-field">
        <span>节点（已选 {draft?.nodeIds?.length ?? 0}）</span>
        <div className="vpn-node-picker">
          {nodes.map(node => {
            const checked = draft?.nodeIds?.includes(node.id) === true;
            return (
              <label className="vpn-node-pick" key={node.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange({
                    ...draft,
                    nodeIds: checked
                      ? draft.nodeIds.filter(id => id !== node.id)
                      : [...(draft?.nodeIds ?? []), node.id],
                  })}
                />
                <span>{node.name}</span>
                <em>{node.type}</em>
              </label>
            );
          })}
        </div>
      </div>
    </CmDialog>
  );
}

/** 删除确认：线路来源删除会连带删节点，线路池删除只回落路由。 */
export function RemoveDialog({ target, busy, error, onCancel, onConfirm }) {
  return (
    <CmDialog
      open={Boolean(target)}
      title={target?.kind === 'pool' ? '删除线路池' : '删除线路来源'}
      body={target?.kind === 'pool'
        ? '指向这个池的模型会回落为直连，节点本身不会被删除。'
        : '该来源下的节点会一并删除，指向它们的模型回落为直连。'}
      detail={target?.name}
      confirmLabel="删除"
      tone="danger"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
