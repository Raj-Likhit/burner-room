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
  subtitle = 'Transfer Code',
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
          title: 'Burner Room Transfer',
          text: `Use code ${pin} to receive the shared file.`,
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

        // Border
        ctx.strokeStyle = '#27272A';
        ctx.lineWidth = 2;
        ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

        // Header Title
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('BURNER ROOM // TRANSFER CODE', canvas.width / 2, 45);

        // Draw QR Code in white square
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(40, 70, 360, 360);
        ctx.drawImage(img, 40, 70, 360, 360);

        // Footer Code
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 24px monospace';
        ctx.fillText(`Code: ${pin}`, canvas.width / 2, 465);

        // Download as safe blob
        canvas.toBlob((blob) => {
          if (!blob) {
            setIsDownloadingQr(false);
            return;
          }
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = `burner-room-code-${pin}.png`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          }, 2000);
          setIsDownloadingQr(false);
        }, 'image/png');
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
    <div className="flex flex-col items-center space-y-3 select-none">
      <div className="flex items-center space-x-2">
        <p className="text-xs uppercase tracking-widest text-zinc-500 font-medium">
          {subtitle}
        </p>
        {!isLocked && onRefreshPin && (
          <button
            id="refresh-pin-button"
            onClick={onRefreshPin}
            title="Generate new code"
            className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 4 Large Digits */}
      <div
        id="session-pin-container"
        onClick={copyPinOnly}
        className="flex items-center space-x-3 sm:space-x-6 cursor-pointer group px-5 py-1 rounded-3xl transition-all hover:bg-zinc-900/50"
        title="Click to copy code"
        role="button"
        tabIndex={0}
        aria-label={`Transfer code is ${pin}. Click to copy.`}
      >
        {digits.map((digit, idx) => {
          return (
            <motion.div
              key={`${idx}-${digit}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: idx * 0.04 }}
              className="flex flex-col items-center"
            >
              <span
                className="text-7xl sm:text-9xl font-extralight tracking-tighter text-white transition-all group-hover:scale-105"
              >
                {digit}
              </span>
            </motion.div>
          );
        })}
      </div>

      {/* Action shortcuts */}
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-zinc-400 pt-1">
        {/* Copy Code */}
        <button
          id="copy-pin-button"
          onClick={copyPinOnly}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-zinc-900 hover:bg-zinc-800 hover:text-white transition-all border border-zinc-800 cursor-pointer"
        >
          {copiedPin ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Code Copied</span>
            </>
          ) : (
            <>
              <KeyRound className="w-3.5 h-3.5 text-zinc-400" />
              <span>Copy Code</span>
            </>
          )}
        </button>

        {/* Copy Link */}
        <button
          id="copy-full-link-btn"
          onClick={copyFullLink}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-zinc-900 hover:bg-zinc-800 hover:text-white transition-all border border-zinc-800 cursor-pointer"
        >
          {copiedLink ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Link Copied</span>
            </>
          ) : (
            <>
              <Link2 className="w-3.5 h-3.5 text-zinc-400" />
              <span>Copy Link</span>
            </>
          )}
        </button>

        {/* QR Code */}
        <button
          id="toggle-qr-button"
          onClick={() => setShowQr(!showQr)}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-full transition-all border cursor-pointer ${
            showQr
              ? 'bg-white text-black border-white'
              : 'bg-zinc-900 hover:bg-zinc-800 hover:text-white border-zinc-800'
          }`}
        >
          <QrCode className="w-3.5 h-3.5" />
          <span>QR Code</span>
        </button>

        {/* Share */}
        <button
          id="quick-share-btn"
          onClick={handleNativeShare}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-zinc-900 hover:bg-zinc-800 hover:text-white transition-all border border-zinc-800 cursor-pointer"
        >
          <Share2 className="w-3.5 h-3.5 text-zinc-400" />
          <span>{shared ? 'Shared' : 'Share'}</span>
        </button>
      </div>

      {/* QR Code Card */}
      <AnimatePresence>
        {showQr && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="mt-3 p-5 rounded-2xl bg-zinc-900 border border-zinc-800 flex flex-col items-center space-y-3 shadow-2xl z-20"
          >
            <div className="p-2 bg-white rounded-xl">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(getShareUrl())}&color=000000&bgcolor=FFFFFF&margin=2`}
                alt={`QR code for code ${pin}`}
                className="w-36 h-36 rounded-md"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="text-center max-w-xs">
              <p className="text-xs text-zinc-400">Scan with another phone or laptop to download</p>
              <p className="text-sm font-mono text-white mt-0.5 font-semibold">Code: {pin}</p>
            </div>

            <button
              id="download-qr-btn"
              onClick={handleDownloadQrPng}
              disabled={isDownloadingQr}
              className="mt-1 flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-medium transition-all cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isDownloadingQr ? 'Saving...' : 'Save QR Image'}</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Clipboard Fallback Modal */}
      <ClipboardFallbackModal
        isOpen={fallbackModalText !== null}
        onClose={() => setFallbackModalText(null)}
        textToCopy={fallbackModalText || ''}
        title={fallbackModalText?.length === 4 ? 'Copy Code' : 'Copy Link'}
      />
    </div>
  );
};
