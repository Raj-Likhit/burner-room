import React, { useState } from 'react';
import { Copy, Check, RefreshCw, QrCode, Share2, Download, Link2, KeyRound } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ClipboardFallbackModal } from './ClipboardFallbackModal';

interface PinDisplayProps {
  pin: string;
  e2eKeyString?: string;
  onRefreshPin?: () => void;
  isLocked?: boolean;
  subtitle?: string;
}

export const PinDisplay: React.FC<PinDisplayProps> = ({
  pin,
  e2eKeyString,
  onRefreshPin,
  isLocked = false,
  subtitle = 'Session Access Key',
}) => {
  const [copiedPin, setCopiedPin] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [shared, setShared] = useState(false);
  const [isDownloadingQr, setIsDownloadingQr] = useState(false);
  const [fallbackModalText, setFallbackModalText] = useState<string | null>(null);

  const digits = (pin || '----').padEnd(4, '-').split('');

  const getShareUrl = () => {
    let url = `${window.location.origin}/?pin=${pin}`;
    if (e2eKeyString) {
      url += `#key=${e2eKeyString}`;
    }
    return url;
  };

  const copyPinOnly = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(pin);
        setCopiedPin(true);
        setTimeout(() => setCopiedPin(false), 2000);
      } else {
        setFallbackModalText(pin);
      }
    } catch {
      setFallbackModalText(pin);
    }
  };

  const copyFullLink = async () => {
    const url = getShareUrl();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      } else {
        setFallbackModalText(url);
      }
    } catch {
      setFallbackModalText(url);
    }
  };

  const handleNativeShare = async () => {
    const url = getShareUrl();
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Burner Room PIN',
          text: `Use PIN ${pin} to pickup your zero-persistence payload.`,
          url: url,
        });
        setShared(true);
        setTimeout(() => setShared(false), 2000);
      } catch {
        copyFullLink();
      }
    } else {
      copyFullLink();
    }
  };

  // Download QR as PNG with Canvas
  const handleDownloadQrPng = async () => {
    setIsDownloadingQr(true);
    try {
      const shareUrl = getShareUrl();
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(shareUrl)}&color=000000&bgcolor=FFFFFF&margin=2`;

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 440;
        canvas.height = 500;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Background
        ctx.fillStyle = '#0D0D0D';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw Card border
        ctx.strokeStyle = '#262626';
        ctx.lineWidth = 2;
        ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

        // Header Title
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('BURNER ROOM // EPHEMERAL PIN', canvas.width / 2, 45);

        // Draw QR Code in white square
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(40, 70, 360, 360);
        ctx.drawImage(img, 40, 70, 360, 360);

        // Footer PIN
        ctx.fillStyle = '#FF3B30';
        ctx.font = 'bold 24px monospace';
        ctx.fillText(`PIN: ${pin}`, canvas.width / 2, 465);

        // Download
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = `burner-room-pin-${pin}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setIsDownloadingQr(false);
      };
      img.onerror = () => {
        setIsDownloadingQr(false);
      };
      img.src = qrApiUrl;
    } catch {
      setIsDownloadingQr(false);
    }
  };

  return (
    <div className="flex flex-col items-center space-y-4 select-none">
      <div className="flex items-center space-x-2">
        <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.4em] text-white/40 font-medium font-mono">
          {subtitle}
        </p>
        {!isLocked && onRefreshPin && (
          <button
            id="refresh-pin-button"
            onClick={onRefreshPin}
            title="Generate New PIN"
            className="p-1 text-white/30 hover:text-white/80 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* 4 Large Digits */}
      <div
        id="session-pin-container"
        onClick={copyPinOnly}
        className="flex items-center space-x-3 sm:space-x-6 cursor-pointer group px-4 py-2 rounded-3xl transition-all hover:bg-white/[0.02]"
        title="Click to copy PIN"
        role="button"
        tabIndex={0}
        aria-label={`Session PIN is ${pin}. Click to copy.`}
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

      {/* Action shortcuts with distinct actions */}
      <div className="flex flex-wrap items-center justify-center gap-2 text-[10px] uppercase tracking-[0.2em] text-white/40 font-mono">
        {/* Copy PIN only */}
        <button
          id="copy-pin-button"
          onClick={copyPinOnly}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] hover:text-white transition-all border border-white/[0.08] cursor-pointer"
        >
          {copiedPin ? (
            <>
              <Check className="w-3 h-3 text-[#FF3B30]" />
              <span className="text-[#FF3B30]">PIN Copied</span>
            </>
          ) : (
            <>
              <KeyRound className="w-3 h-3 text-white/50" />
              <span>Copy PIN</span>
            </>
          )}
        </button>

        {/* Copy Full Link */}
        <button
          id="copy-full-link-btn"
          onClick={copyFullLink}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] hover:text-white transition-all border border-white/[0.08] cursor-pointer"
        >
          {copiedLink ? (
            <>
              <Check className="w-3 h-3 text-[#FF3B30]" />
              <span className="text-[#FF3B30]">Link Copied</span>
            </>
          ) : (
            <>
              <Link2 className="w-3 h-3 text-white/50" />
              <span>Copy Link</span>
            </>
          )}
        </button>

        {/* QR Pair */}
        <button
          id="toggle-qr-button"
          onClick={() => setShowQr(!showQr)}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-full transition-all border cursor-pointer ${
            showQr
              ? 'bg-white text-black border-white'
              : 'bg-white/[0.04] hover:bg-white/[0.08] hover:text-white border-white/[0.08]'
          }`}
        >
          <QrCode className="w-3 h-3" />
          <span>QR Code</span>
        </button>

        {/* Web Share */}
        <button
          id="quick-share-btn"
          onClick={handleNativeShare}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] hover:text-white transition-all border border-white/[0.08] cursor-pointer"
        >
          <Share2 className="w-3 h-3 text-white/50" />
          <span>{shared ? 'Shared' : 'Share'}</span>
        </button>
      </div>

      {/* QR Code Popup with Download PNG */}
      <AnimatePresence>
        {showQr && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="mt-4 p-5 rounded-2xl bg-[#141414] border border-white/10 flex flex-col items-center space-y-3 shadow-2xl z-20"
          >
            <div className="p-2 bg-white rounded-xl">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(getShareUrl())}&color=000000&bgcolor=FFFFFF&margin=2`}
                alt={`QR code for PIN ${pin}`}
                className="w-36 h-36 rounded-md"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="text-center max-w-xs">
              <p className="text-[10px] uppercase tracking-widest text-white/60">Scan with secondary device</p>
              <p className="text-[11px] font-mono text-[#FF3B30] mt-0.5 font-semibold">PIN: {pin}</p>
              {e2eKeyString && (
                <p className="text-[9px] text-white/40 mt-1 leading-tight">
                  Contains Zero-Knowledge E2E key in hash fragment.
                </p>
              )}
            </div>

            {/* Save QR As Image Button */}
            <button
              id="download-qr-btn"
              onClick={handleDownloadQrPng}
              disabled={isDownloadingQr}
              className="mt-2 flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white text-white hover:text-black text-[10px] uppercase tracking-wider font-semibold font-mono transition-all cursor-pointer"
            >
              <Download className="w-3 h-3" />
              <span>{isDownloadingQr ? 'Generating PNG...' : 'Download QR (PNG)'}</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Clipboard Fallback Modal */}
      <ClipboardFallbackModal
        isOpen={fallbackModalText !== null}
        onClose={() => setFallbackModalText(null)}
        textToCopy={fallbackModalText || ''}
        title={fallbackModalText?.length === 4 ? 'Copy Session PIN' : 'Copy Session Link'}
      />
    </div>
  );
};
