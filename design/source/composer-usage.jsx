import React, { useId, useState } from 'react';
import { ChevronDown, X } from '@keyline-icons/react';

const contextWindow = 1_000_000;
const contextSections = [
  { label: '消息', tokens: 520_000, color: '#3795f5' },
  { label: '系统工具', tokens: 96_000, color: '#b77af8' },
  { label: 'MCP 工具', tokens: 68_000, color: '#f56cb2' },
  { label: '技能', tokens: 54_000, color: '#f7c531' },
  { label: '系统提示词', tokens: 42_000, color: '#3795f5' },
  { label: '记忆文件', tokens: 24_000, color: '#5aa9e6' },
  { label: '自定义代理', tokens: 16_000, color: '#4da3e8' },
];

const deferredSections = [
  { label: 'MCP 工具（延迟加载）', tokens: 69_900 },
  { label: '系统工具（延迟加载）', tokens: 16_100 },
];

const quotaExamples = [
  { label: '5 小时额度', used: 38, reset: '2 小时 46 分钟后重置' },
  { label: '每周 · 所有模型', used: 3, reset: '周二 15:00 重置' },
  { label: '每周 · Pro', used: 5, reset: '周二 15:00 重置' },
];

const usedTokens = contextSections.reduce((sum, section) => sum + section.tokens, 0);
const usedRatio = usedTokens / contextWindow;
const percent = (tokens) => (tokens / contextWindow * 100).toFixed(1) + '%';
const formatTokens = (tokens) => tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1_000}k`;

export function UsagePanel({ onClose }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const rows = [
    ...contextSections,
    ...deferredSections,
    { label: '剩余空间', tokens: contextWindow - usedTokens, color: '#4a4a4a' },
  ];

  return (
    <section className="mova-usage" aria-label="上下文与剩余额度">
      <div className="mova-usage-heading">
        <h2>用量概览</h2>
        <span>示例数据</span>
        <button type="button" className="mova-usage-close" aria-label="关闭用量面板" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <button type="button" className="mova-usage-context-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
        <span>上下文窗口</span>
        <span className="mova-usage-summary">{formatTokens(usedTokens)} / {formatTokens(contextWindow)} <strong>({Math.round(usedRatio * 100)}%)</strong></span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div className="mova-usage-track" role="meter" aria-label="上下文已用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedRatio * 100)}>
        {contextSections.map(({ label, tokens, color }) => (
          <span className="mova-usage-segment" key={label} style={{ width: percent(tokens), backgroundColor: color }} />
        ))}
      </div>

      <ul id={detailsId} className="mova-usage-details" hidden={!expanded} aria-label="上下文构成">
        {rows.map(({ label, tokens, color }) => (
          <li key={label}>
            <span className="mova-usage-dot" style={{ backgroundColor: color }} aria-hidden="true" />
            <span>{label}</span>
            <span className="mova-usage-secondary">{formatTokens(tokens)}</span>
            <strong>{color ? percent(tokens) : '—'}</strong>
          </li>
        ))}
      </ul>

      <section className="mova-usage-quotas" aria-label="套餐额度">
        <h3>套餐额度 · Max (5x)</h3>
        {quotaExamples.map(({ label, used, reset }) => (
          <div className="mova-quota" key={label}>
            <div className="mova-quota-caption">
              <strong>{label}</strong>
              <span>剩余 <strong>{100 - used}%</strong></span>
            </div>
            <div className="mova-usage-track" role="meter" aria-label={`${label}已用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
              <span className="mova-quota-used" style={{ width: `${used}%` }} />
            </div>
            <div className="mova-quota-meta"><span>{reset}</span><span>已用 {used}%</span></div>
          </div>
        ))}
      </section>
    </section>
  );
}

function UsageRing({ ratio }) {
  const size = 16;
  const radius = 6.6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={radius} fill="none" stroke="#4d4d4d" strokeWidth="2.4" />
      <circle
        cx="8" cy="8" r={radius} fill="none" stroke="#3795f5" strokeWidth="2.4" strokeLinecap="round"
        strokeDasharray={`${(circumference * ratio).toFixed(2)} ${circumference.toFixed(2)}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/** Ring button used as the morph trigger for the usage panel. */
export function UsageButton({ open = false, onToggle }) {
  const percent = Math.round(usedRatio * 100);
  return (
    <button
      type="button"
      className="mova-usage-trigger"
      aria-label={`上下文与剩余额度，上下文已用 ${percent}%`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <UsageRing ratio={usedRatio} />
    </button>
  );
}

export const composerUsage = { usedRatio, Panel: UsagePanel, Button: UsageButton };
