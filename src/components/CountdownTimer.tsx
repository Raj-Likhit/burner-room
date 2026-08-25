import React, { useEffect, useState } from 'react';

interface CountdownTimerProps {
  expiresAt: number;
  totalDurationSeconds?: number;
  onExpire?: () => void;
  label?: string;
}

export const CountdownTimer: React.FC<CountdownTimerProps> = ({
  expiresAt,
  totalDurationSeconds = 600,
  onExpire,
  label = 'Self-Destruct Sequence',
}) => {
  const [remainingMs, setRemainingMs] = useState<number>(() => Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, expiresAt - Date.now());
      setRemainingMs(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        onExpire?.();
      }
    }, 500);

    return () => clearInterval(interval);
  }, [expiresAt, onExpire]);

  const totalMs = totalDurationSeconds * 1000;
  const progressPercent = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));

  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const formattedTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const isCritical = remainingMs < 60000; // less than 1 min

  const formatDurationLabel = (seconds: number) => {
    if (seconds >= 3600) {
      const hours = Math.floor(seconds / 3600);
      const remMin = Math.round((seconds % 3600) / 60);
      return remMin > 0 ? `${hours}h ${remMin}m TTL` : `${hours}h TTL`;
    }
    const mins = Math.max(1, Math.round(seconds / 60));
    return `${mins}m TTL`;
  };

  return (
    <div id="countdown-timer-container" className="w-full max-w-sm space-y-3 select-none">
      <div className="flex justify-between items-end">
        <span className="text-[10px] uppercase tracking-widest text-white/40 font-medium">
          {label}
        </span>
        <span
          className={`text-[12px] font-mono transition-colors ${
            isCritical ? 'text-[#FF3B30] animate-pulse font-bold' : 'text-[#FF3B30]'
          }`}
        >
          {formattedTime}
        </span>
      </div>

      {/* Sleek hairline progress bar */}
      <div className="h-[1px] w-full bg-white/10 overflow-hidden relative">
        <div
          className="h-full bg-gradient-to-r from-transparent via-[#FF3B30] to-[#FF3B30] transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="flex justify-between text-[9px] uppercase tracking-[0.2em] text-white/20">
        <span>T-Zero Auto Purge</span>
        <span>{formatDurationLabel(totalDurationSeconds)}</span>
      </div>
    </div>
  );
};
