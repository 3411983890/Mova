import React, { useState } from 'react';
import { PINYIN_CANDIDATES } from '../data/movaData';
import {
  BackspaceKeyIcon,
  ChevronDownIcon,
  EmojiSmileIcon,
  GlobeKeyboardIcon,
  MicOutlineIcon,
  ReturnArrowIcon,
  ShiftKeyIcon,
} from './IOSIcons';

interface IOSKeyboardProps {
  onInsertText: (text: string) => void;
  onBackspace: () => void;
  onReturn: () => void;
  dimmed?: boolean;
}

const ROW_1 = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];
const ROW_2 = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];
const ROW_3 = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];

export const IOSKeyboard: React.FC<IOSKeyboardProps> = ({
  onInsertText,
  onBackspace,
  onReturn,
  dimmed = false,
}) => {
  const [shifted, setShifted] = useState(false);
  const [numeric, setNumeric] = useState(false);

  const renderChar = (ch: string) => (shifted ? ch.toUpperCase() : ch);

  return (
    <div className={`ios26-keyboard ${dimmed ? 'is-dimmed' : ''}`} onMouseDown={(e) => e.preventDefault()}>
      {/* Chinese Pinyin Candidate Strip (Screenshot 2) */}
      <div className="ios26-kb-candidates">
        <div className="ios26-kb-candidate-list">
          {PINYIN_CANDIDATES.map((word) => (
            <button
              key={word}
              type="button"
              className="ios26-kb-candidate-btn"
              onClick={() => onInsertText(word)}
            >
              {word}
            </button>
          ))}
        </div>
        <button type="button" className="ios26-kb-candidate-more" aria-label="展开候选词">
          <ChevronDownIcon size={16} color="rgba(235,235,245,0.68)" />
        </button>
      </div>

      {/* Main Key Rows */}
      <div className="ios26-kb-rows">
        {/* Row 1 */}
        <div className="ios26-kb-row">
          {(numeric ? ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] : ROW_1).map((ch) => (
            <button
              key={ch}
              type="button"
              className="ios26-key ios26-key--letter"
              onClick={() => onInsertText(renderChar(ch))}
            >
              {renderChar(ch)}
            </button>
          ))}
        </div>

        {/* Row 2 */}
        <div className="ios26-kb-row ios26-kb-row--indented">
          {(numeric ? ['-', '/', ':', ';', '(', ')', '¥', '@', '"'] : ROW_2).map((ch) => (
            <button
              key={ch}
              type="button"
              className="ios26-key ios26-key--letter"
              onClick={() => onInsertText(renderChar(ch))}
            >
              {renderChar(ch)}
            </button>
          ))}
        </div>

        {/* Row 3 */}
        <div className="ios26-kb-row ios26-kb-row--r3">
          <button
            type="button"
            className={`ios26-key ios26-key--system ios26-key--wide ${shifted ? 'is-active' : ''}`}
            onClick={() => setShifted((v) => !v)}
            aria-label="切换大小写"
          >
            <ShiftKeyIcon size={19} color={shifted ? '#1C1C1E' : '#FFFFFF'} filled={shifted} />
          </button>

          <div className="ios26-kb-r3-letters">
            {(numeric ? ['.', ',', '?', '!', "'", '#', '%'] : ROW_3).map((ch) => (
              <button
                key={ch}
                type="button"
                className="ios26-key ios26-key--letter"
                onClick={() => onInsertText(renderChar(ch))}
              >
                {renderChar(ch)}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="ios26-key ios26-key--system ios26-key--wide"
            onClick={onBackspace}
            aria-label="删除"
          >
            <BackspaceKeyIcon size={21} color="#FFFFFF" />
          </button>
        </div>

        {/* Row 4: 123 · Emoji · Space (拼) · Return */}
        <div className="ios26-kb-row ios26-kb-row--r4">
          <button
            type="button"
            className="ios26-key ios26-key--system ios26-key--num"
            onClick={() => setNumeric((v) => !v)}
          >
            {numeric ? 'ABC' : '123'}
          </button>

          <button
            type="button"
            className="ios26-key ios26-key--system ios26-key--emoji"
            onClick={() => onInsertText('✨')}
            aria-label="表情符号"
          >
            <EmojiSmileIcon size={22} color="#EBEBF5" />
          </button>

          <button
            type="button"
            className="ios26-key ios26-key--letter ios26-key--space"
            onClick={() => onInsertText(' ')}
            aria-label="空格"
          >
            <span className="ios26-space-sub">拼</span>
          </button>

          <button
            type="button"
            className="ios26-key ios26-key--system ios26-key--return"
            onClick={onReturn}
            aria-label="换行或发送"
          >
            <ReturnArrowIcon size={20} color="#FFFFFF" />
          </button>
        </div>
      </div>

      {/* Bottom Dock: Globe + Dictation + Home Indicator */}
      <div className="ios26-kb-bottom">
        <button type="button" className="ios26-kb-dock-btn" aria-label="切换输入法">
          <GlobeKeyboardIcon size={24} color="rgba(235,235,245,0.82)" />
        </button>
        <button type="button" className="ios26-kb-dock-btn" aria-label="语音听写">
          <MicOutlineIcon size={23} color="rgba(235,235,245,0.82)" />
        </button>
      </div>
      <div className="ios26-kb-home-bar">
        <span />
      </div>
    </div>
  );
};
