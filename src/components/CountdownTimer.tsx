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
  label = 'Expires in',
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
      return remMin > 0 ? `${hours}h ${remMin}m total` : `${hours}h total`;
    }
    const mins = Math.max(1, Math.round(seconds / 60));
    return `${mins}m total`;
  };

  return (
    <div id="countdown-timer-container" className="w-full max-w-sm space-y-2.5 select-none">
      <div className="flex justify-between items-center text-xs">
        <span className="text-zinc-400 font-medium">
          {label}
        </span>
        <span
          className={`font-mono font-medium ${
            isCritical ? 'text-red-400 animate-pulse' : 'text-zinc-200'
          }`}
        >
          {formattedTime}
        </span>
      </div>

      {/* Clean hairline progress bar */}
      <div className="h-[2px] w-full bg-zinc-800 rounded-full overflow-hidden relative">
        <div
          className="h-full bg-white transition-all duration-500 rounded-full"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="flex justify-between text-[11px] text-zinc-500">
        <span>Deleted automatically</span>
        <span>{formatDurationLabel(totalDurationSeconds)}</span>
      </div>
    </div>
  );
};
