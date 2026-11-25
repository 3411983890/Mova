import React, { useEffect, useId, useRef, useState } from 'react';
import './ask-card.css';

/* AI 问答卡片：AI 提问时接管底部输入栏（对话页规范 5.8）。
   单选点选即发出；多选、简答、自定义回答需要「提交」；Esc 或「跳过」收起卡片。 */

function answerOf(ask, picked, customText) {
  const options = ask.options ?? [];
  if (!options.length) return customText.trim();
  const labels = picked
    .map(value => options.find(option => option.value === value)?.label ?? value)
    .filter(Boolean);
  const extra = customText.trim();
  if (ask.multi) return [...labels, extra].filter(Boolean).join('、');
  return extra || labels[0] || '';
}

/* 卡片只负责展示，长度由主进程（electron/chat-agent.mjs）先限一次；
   这里再收紧一道，保证旧会话或异常输入也撑不破底部输入区。 */
const MAX_OPTIONS = 4;
const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function AskCard({ ask, onSubmit, onSkip }) {
  const uid = useId();
  const options = (ask.options ?? []).slice(0, MAX_OPTIONS).map(option => ({
    ...option,
    label: clip(option.label, 26),
    description: option.description ? clip(option.description, 56) : '',
  }));
  const question = clip(ask.question, 84) || '需要你确认一下';
  const detail = ask.detail ? clip(ask.detail, 160) : '';
  const plain = options.length === 0;
  const multi = Boolean(ask.multi) && !plain;

  const [picked, setPicked] = useState([]);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  const optionsRef = useRef([]);
  const inputRef = useRef(null);
  const timer = useRef(0);

  const customActive = custom && draft.trim().length > 0;
  const canSubmit = plain ? draft.trim().length > 0 : multi ? (picked.length > 0 || customActive) : customActive;
  const needsSubmit = plain || multi || custom;

  useEffect(() => {
    setPicked([]);
    setCustom(false);
    setDraft('');
    setSent(false);
    // 卡片一出现就把焦点放进来：键盘可以立刻作答，读屏也能读到题干。
    const frame = requestAnimationFrame(() => {
      const target = plain ? inputRef.current : optionsRef.current[0];
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ask.id]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function emit(text) {
    if (sent || !text) return;
    setSent(true);
    onSubmit(text);
  }

  function choose(option) {
    if (multi) {
      setCustom(false);
      setPicked(current => current.includes(option.value)
        ? current.filter(value => value !== option.value)
        : [...current, option.value]);
      return;
    }
    setCustom(false);
    setPicked([option.value]);
    // 先让选中态露一下脸，再发出，避免「点了但没看见发生了什么」。
    clearTimeout(timer.current);
    timer.current = setTimeout(() => emit(option.label), 160);
  }

  function focusCustom() {
    setCustom(true);
    setPicked([]);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }

  function submit() {
    if (canSubmit) emit(answerOf(ask, picked, draft));
  }

  function onOptionKeyDown(event, index) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const total = optionsRef.current.length;
    if (!total) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    optionsRef.current[(index + step + total) % total]?.focus();
  }

  function onTextKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section
      className="ask-card"
      role="group"
      aria-labelledby={`${uid}-question`}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onSkip(); } }}
    >
      <div className="ask-body">
        <div className="ask-head">
          <span className="ask-badge">AI 提问</span>
          <h2 className="ask-question" id={`${uid}-question`}>{question}</h2>
        </div>
        {detail && <p className="ask-detail">{detail}</p>}

        {!plain && (
          <div className="ask-options" role={multi ? 'group' : 'radiogroup'} aria-labelledby={`${uid}-question`}>
            {options.map((option, index) => {
              const selected = picked.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  ref={element => { optionsRef.current[index] = element; }}
                  className="ask-option"
                  role={multi ? undefined : 'radio'}
                  aria-checked={multi ? undefined : selected}
                  aria-pressed={multi ? selected : undefined}
                  data-selected={selected || undefined}
                  onClick={() => choose(option)}
                  onKeyDown={event => onOptionKeyDown(event, index)}
                >
                  <span className="ask-mark" data-kind={multi ? 'multi' : 'single'} aria-hidden="true" />
                  <span className="ask-option-text">
                    <strong>{option.label}</strong>
                    {option.description && <span>{option.description}</span>}
                  </span>
                </button>
              );
            })}
            {ask.allowCustom && (
              <button
                type="button"
                className="ask-option ask-option-custom"
                data-selected={custom || undefined}
                aria-pressed={custom}
                onClick={focusCustom}
              >
                <span className="ask-mark" data-kind={multi ? 'multi' : 'single'} aria-hidden="true" />
                <span className="ask-option-text"><strong>自定义回答</strong><span>自己写一句，我按它继续</span></span>
              </button>
            )}
          </div>
        )}

        {(plain || custom) && (
          <textarea
            ref={inputRef}
            className="ask-input"
            rows={1}
            value={draft}
            aria-label="回答"
            placeholder={ask.placeholder ?? '写一句你的回答'}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onTextKeyDown}
          />
        )}
      </div>

      <div className="ask-foot">
        <span className="ask-hint">
          {plain || custom ? 'Enter 提交 · Shift + Enter 换行' : multi ? '可多选 · Enter 提交' : '点一下即可发出'}
        </span>
        <button type="button" className="ask-skip" onClick={onSkip}>跳过</button>
        {needsSubmit && (
          <button type="button" className="ask-submit" disabled={!canSubmit || sent} onClick={submit}>提交</button>
        )}
      </div>
    </section>
  );
}

export default AskCard;
