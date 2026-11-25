/**
 * 负责：把「这条线路现在用哪个节点、多快、多久前查过、有没有被切换过」渲染成设置页里的一行，
 *   外加「立即检查」与「允许跨地区切换」两个控件。
 * 不负责：纯逻辑（相对时间/延迟分档/摘要模型在 `vpn-health-view.mjs`）、
 *   真的去测速或切节点（`electron/vpn/health.mjs`）、数据读取（`use-vpn.js`）。
 * 被谁调用：`src/features/vpn/vpn-settings.jsx`（每个策略池下方一行）。
 *
 * 为什么单独一个文件：健康状态是**独立刷新**的（5 分钟一轮 + 手动触发），
 * 混进池行渲染会让整个设置页跟着重渲染；这里只吃一个 `health` 对象。
 *
 * 文案口径（避免误导用户）：
 * - 没测过 → 明确说「还没有检查」，不显示 0ms 或「良好」；
 * - 跨地区切换是**危险动作**（账号风控），一定单独标红提示，不能和普通切换长一样；
 * - 「同地区没有备选」不是错误，是我们的保护策略生效了，所以要中性说明而不是报错样式。
 */
import React from 'react';

import { healthLineModel } from './vpn-health-view.mjs';

/**
 * @param {{
 *   health?: object|null, allowCrossRegion?: boolean, busy?: boolean, disabled?: boolean,
 *   onCheck?: Function, onToggleCrossRegion?: Function
 * }} props
 */
export function VpnHealthLine({
  health = null, allowCrossRegion = false, busy = false, disabled = false,
  onCheck = null, onToggleCrossRegion = null,
} = {}) {
  const model = healthLineModel(health);
  const canCheck = typeof onCheck === 'function' && !disabled;

  return (
    <div className="vpn-health" data-tone={model.tone}>
      {/* 「立即检查」和节点信息同一行、按钮贴右：它作用的对象就是左边这个节点，
          分两行时按钮和它要检查的东西隔着一行文字，读起来像两个不相关的控件。 */}
      <div className="vpn-health-row">
        <div className="vpn-health-main">
          <span className="vpn-health-dot" aria-hidden="true" />
          <span className="vpn-health-node" title={model.title}>{model.title}</span>
          <span className="vpn-health-tag">{model.regionLabel}</span>
          <span className="vpn-health-delay">{model.delay}</span>
          <span className="vpn-health-checked">{model.checked}</span>
        </div>
        <button
          type="button"
          className="settings-button vpn-health-check"
          disabled={!canCheck || Boolean(busy)}
          onClick={() => { if (canCheck) void onCheck(); }}
        >
          {busy ? '检查中…' : '立即检查'}
        </button>
      </div>
      {model.unhealthy > 0 ? (
        <p className="vpn-health-note">{model.unhealthy} 个节点连续失败，已降低优先级</p>
      ) : null}
      {model.switchNote ? (
        <p
          className="vpn-health-note"
          data-cross-region={model.crossRegion ? 'true' : 'false'}
          role={model.crossRegion ? 'alert' : undefined}
        >
          {model.switchNote}
        </p>
      ) : null}
      <div className="vpn-health-actions">
        <label className="vpn-health-toggle">
          <input
            type="checkbox"
            checked={Boolean(allowCrossRegion)}
            disabled={disabled || typeof onToggleCrossRegion !== 'function'}
            onChange={event => {
              if (typeof onToggleCrossRegion === 'function') void onToggleCrossRegion(event.target.checked);
            }}
          />
          <span>允许跨地区切换</span>
        </label>
        <span className="vpn-health-hint">
          {allowCrossRegion
            ? '同地区没有可用节点时会换到别的地区（可能触发账号风控）'
            : '默认只换同地区节点，宁可不换也不跨区'}
        </span>
      </div>
    </div>
  );
}
