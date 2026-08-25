import React, { useState } from 'react';
import { Copy, Check, RefreshCw, QrCode, Share2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface PinDisplayProps {
  pin: string;
  onRefreshPin?: () => void;
  isLocked?: boolean;
  subtitle?: string;
}

export const PinDisplay: React.FC<PinDisplayProps> = ({
  pin,
  onRefreshPin,
  isLocked = false,
  subtitle = 'Session Access Key',
}) => {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const digits = (pin || '----').padEnd(4, '-').split('');

  const copyPin = async () => {
    try {
      await navigator.clipboard.writeText(pin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Clipboard copy failed', e);
    }
  };

  const getShareUrl = () => {
    return `${window.location.origin}/?pin=${pin}`;
  };

  return (
    <div className="flex flex-col items-center space-y-4 select-none">
      <div className="flex items-center space-x-2">
        <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.4em] text-white/40 font-medium">
          {subtitle}
        </p>
        {!isLocked && onRefreshPin && (
          <button
            id="refresh-pin-button"
            onClick={onRefreshPin}
            title="Generate New PIN"
            className="p-1 text-white/30 hover:text-white/80 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* 4 Large Digits */}
      <div
        id="session-pin-container"
        onClick={copyPin}
        className="flex items-center space-x-3 sm:space-x-6 cursor-pointer group px-4 py-2 rounded-2xl transition-all hover:bg-white/[0.02]"
        title="Click to copy PIN"
      >
        {digits.map((digit, idx) => {
          const isLast = idx === 3;
          return (
            <motion.div
              key={`${idx}-${digit}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: idx * 0.05 }}
              className="flex flex-col items-center"
            >
              <span
                className={`text-7xl sm:text-9xl font-extralight tracking-tighter transition-all group-hover:scale-105 ${
                  isLast ? 'text-[#FF3B30]' : 'text-white'
                }`}
              >
                {digit}
              </span>
            </motion.div>
          );
        })}
      </div>

      {/* Action shortcuts */}
      <div className="flex items-center space-x-4 text-[10px] uppercase tracking-[0.2em] text-white/40">
        <button
          id="copy-pin-button"
          onClick={copyPin}
          className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-white/[0.04] hover:bg-white/[0.08] hover:text-white transition-all border border-white/[0.08]"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-[#FF3B30]" />
              <span className="text-[#FF3B30]">PIN Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3 text-white/50" />
              <span>Copy PIN</span>
            </>
          )}
        </button>

        <button
          id="toggle-qr-button"
          onClick={() => setShowQr(!showQr)}
          className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-white/[0.04] hover:bg-white/[0.08] hover:text-white transition-all border border-white/[0.08]"
        >
          <QrCode className="w-3 h-3 text-white/50" />
          <span>QR Pair</span>
        </button>
      </div>

      {/* QR Code Popup */}
      <AnimatePresence>
        {showQr && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="mt-4 p-5 rounded-2xl bg-[#141414] border border-white/10 flex flex-col items-center space-y-3 shadow-2xl z-20"
          >
            <div className="p-2 bg-white rounded-xl">
              {/* Quick SVG QR code visualizer based on standard pixel pattern */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(getShareUrl())}&color=000000&bgcolor=FFFFFF&margin=2`}
                alt={`QR code for PIN ${pin}`}
                className="w-36 h-36 rounded-md"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-widest text-white/60">Scan with secondary device</p>
              <p className="text-[11px] font-mono text-[#FF3B30] mt-0.5">PIN: {pin}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
