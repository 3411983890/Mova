import React from 'react';

interface IOSStatusBarProps {
  time?: string;
  carrierBadge?: string;
  battery?: number;
  cameraActive?: boolean;
}

export const IOSStatusBar: React.FC<IOSStatusBarProps> = ({
  time = '18:18',
  carrierBadge = '5GA',
  battery = 44,
  cameraActive = false,
}) => {
  const pct = Math.max(10, Math.min(100, battery));

  return (
    <div className="ios-status-bar">
      <span className="ios-status-time">{time}</span>
      {cameraActive && (
        <div className="ios-dynamic-island-cam" aria-label="相机正在使用">
          <span className="ios-dynamic-island-dot" />
        </div>
      )}
      <div className="ios-status-right">
        {/* 4-bar iOS Cellular Signal */}
        <svg width="17" height="12" viewBox="0 0 18 12" fill="none" aria-hidden="true">
          <rect x="0.8" y="8" width="2.7" height="3.5" rx="1" fill="#FFFFFF" />
          <rect x="5" y="5.8" width="2.7" height="5.7" rx="1" fill="#FFFFFF" />
          <rect x="9.2" y="3.3" width="2.7" height="8.2" rx="1" fill="#FFFFFF" />
          <rect x="13.4" y="0.8" width="2.7" height="10.7" rx="1" fill="rgba(255,255,255,0.34)" />
        </svg>
        <span className="ios-status-5g">{carrierBadge}</span>
        {/* iOS 26 Numeric Capsule Battery */}
        <div className="ios-battery-pill" aria-label={`电量 ${battery}%`}>
          <div className="ios-battery-body">
            <div className="ios-battery-fill" style={{ width: `${pct}%` }} />
            <span className="ios-battery-text">{battery}</span>
          </div>
          <span className="ios-battery-cap" />
        </div>
      </div>
    </div>
  );
};

export const IOSHomeIndicator: React.FC<{ subtle?: boolean }> = ({ subtle = false }) => (
  <div className={`ios-home-indicator-wrap ${subtle ? 'is-subtle' : ''}`}>
    <span className="ios-home-indicator-bar" />
  </div>
);
