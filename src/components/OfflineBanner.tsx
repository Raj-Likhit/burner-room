import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { WifiOff, RefreshCw } from 'lucide-react';

interface OfflineBannerProps {
  isOffline: boolean;
  onRetry?: () => void;
}

export const OfflineBanner: React.FC<OfflineBannerProps> = ({ isOffline, onRetry }) => {
  return (
    <AnimatePresence>
      {isOffline && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.2 }}
          className="w-full bg-[#FF3B30] text-white py-2 px-4 flex items-center justify-between text-xs font-mono z-40 sticky top-0 shadow-lg"
        >
          <div className="flex items-center space-x-2 mx-auto sm:mx-0">
            <WifiOff className="w-4 h-4 animate-pulse" />
            <span className="font-medium">
              Network Connection Lost — Burner Room is offline. Actions will queue and retry upon reconnect.
            </span>
          </div>

          {onRetry && (
            <button
              onClick={onRetry}
              className="hidden sm:flex items-center space-x-1 px-2.5 py-1 rounded bg-black/30 hover:bg-black/50 text-[10px] uppercase tracking-wider font-semibold cursor-pointer transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Retry</span>
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
