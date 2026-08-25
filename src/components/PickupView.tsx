import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { KeyRound, Download, Copy, Check, Flame, AlertCircle, ArrowLeft, ShieldAlert, Sparkles, CheckCircle2 } from 'lucide-react';
import { BurnerPayload } from '../types';

interface PickupViewProps {
  initialPin?: string;
  onPickupSuccess: (payload: BurnerPayload) => void;
  onReturnToDrop: () => void;
}

export const PickupView: React.FC<PickupViewProps> = ({
  initialPin = '',
  onPickupSuccess,
  onReturnToDrop,
}) => {
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retrievedPayload, setRetrievedPayload] = useState<BurnerPayload | null>(null);
  const [isBurned, setIsBurned] = useState(false);
  const [copiedText, setCopiedText] = useState(false);

  const inputRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];

  // If initialPin provided from URL query param
  useEffect(() => {
    if (initialPin && initialPin.length === 4) {
      const pinDigits = initialPin.split('');
      setDigits(pinDigits);
      handleFetchPayload(initialPin);
    }
  }, [initialPin]);

  const handleDigitChange = (index: number, value: string) => {
    // Handle paste of 4 digits
    if (value.length > 1) {
      const cleaned = value.replace(/[^0-9]/g, '').slice(0, 4);
      if (cleaned.length === 4) {
        const next = cleaned.split('');
        setDigits(next);
        inputRefs[3].current?.focus();
        handleFetchPayload(cleaned);
        return;
      }
    }

    const singleDigit = value.replace(/[^0-9]/g, '').slice(-1);
    const nextDigits = [...digits];
    nextDigits[index] = singleDigit;
    setDigits(nextDigits);

    if (singleDigit && index < 3) {
      inputRefs[index + 1].current?.focus();
    }

    // If all 4 filled, trigger pickup
    if (singleDigit && index === 3 && nextDigits.every((d) => d !== '')) {
      handleFetchPayload(nextDigits.join(''));
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs[index - 1].current?.focus();
    }
  };

  const handleFetchPayload = async (pinCode: string) => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/pickup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinCode }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to retrieve payload.');
        setIsLoading(false);
        return;
      }

      if (data.success && data.payload) {
        setRetrievedPayload(data.payload);
        setIsBurned(true);
        onPickupSuccess(data.payload);
      } else {
        setErrorMessage(data.error || 'No active payload found.');
      }
    } catch (err) {
      setErrorMessage('Network connection error.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyText = async () => {
    if (retrievedPayload?.textContent) {
      await navigator.clipboard.writeText(retrievedPayload.textContent);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    }
  };

  const handleDownloadFile = () => {
    if (!retrievedPayload?.file?.dataUrl) return;
    const a = document.createElement('a');
    a.href = retrievedPayload.file.dataUrl;
    a.download = retrievedPayload.file.name || 'burner-file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <div className="w-full max-w-2xl flex flex-col items-center select-none">
      <AnimatePresence mode="wait">
        {!retrievedPayload ? (
          /* PIN INPUT PROMPT */
          <motion.div
            key="pin-entry"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="w-full flex flex-col items-center space-y-10"
          >
            <div className="text-center space-y-3">
              <p className="text-[11px] uppercase tracking-[0.4em] text-white/40">
                Retrieve Remote Payload
              </p>
              <h2 className="text-2xl sm:text-3xl font-light text-white tracking-tight">
                Enter 4-Digit Session PIN
              </h2>
              <p className="text-xs text-white/50 max-w-sm mx-auto">
                Enter the session PIN to retrieve the shared text or file payload.
              </p>
            </div>

            {/* 4 Digit Interactive Boxes */}
            <div className="flex space-x-3 sm:space-x-5">
              {digits.map((digit, idx) => (
                <input
                  key={idx}
                  id={`pickup-digit-${idx}`}
                  ref={inputRefs[idx]}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleDigitChange(idx, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(idx, e)}
                  autoFocus={idx === 0}
                  className="w-16 h-20 sm:w-20 sm:h-24 text-center text-4xl sm:text-5xl font-extralight bg-white/[0.03] border border-white/20 rounded-2xl text-white focus:border-[#FF3B30] focus:ring-1 focus:ring-[#FF3B30] outline-none transition-all placeholder-transparent"
                />
              ))}
            </div>

            {/* Error Message */}
            {errorMessage && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="p-4 rounded-xl bg-[#FF3B30]/10 border border-[#FF3B30]/30 text-[#FF3B30] text-xs flex items-center space-x-3 max-w-md"
              >
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{errorMessage}</span>
              </motion.div>
            )}

            {/* Submit & Back Controls */}
            <div className="flex flex-col items-center space-y-4">
              <button
                id="fetch-payload-btn"
                onClick={() => handleFetchPayload(digits.join(''))}
                disabled={isLoading || digits.some((d) => d === '')}
                className="px-8 py-3 rounded-xl bg-white text-black text-xs uppercase tracking-[0.25em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shadow-lg"
              >
                {isLoading ? 'Retrieving Payload...' : 'Fetch Payload'}
              </button>

              <button
                onClick={onReturnToDrop}
                className="flex items-center space-x-1.5 text-[10px] uppercase tracking-[0.2em] text-white/40 hover:text-white transition-colors"
              >
                <ArrowLeft className="w-3 h-3" />
                <span>Return to Drop</span>
              </button>
            </div>
          </motion.div>
        ) : (
          /* RETRIEVED & BURNED SUCCESS VIEW */
          <motion.div
            key="retrieved-content"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full flex flex-col items-center space-y-6"
          >
            {/* Burn or Multi-Share Alert Banner */}
            {retrievedPayload.shareMode === 'multiple_reads' ? (
              <div className="w-full p-4 rounded-2xl bg-white/[0.03] border border-white/20 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white">
                    <CheckCircle2 className="w-4 h-4 text-[#FF3B30]" />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-widest text-white font-semibold flex items-center space-x-2">
                      <span>Multi-Device Drop Retrieved</span>
                      <span className="text-[10px] text-white/50 font-normal font-mono">
                        (Access #{retrievedPayload.readCount || 1})
                      </span>
                    </p>
                    <p className="text-[10px] text-white/50">
                      Payload remains available for other devices until the {Math.max(1, Math.round((retrievedPayload.ttlSeconds || 600) / 60))}-minute TTL expires.
                    </p>
                  </div>
                </div>
                <span className="text-[9px] uppercase tracking-widest font-mono text-white/90 bg-white/10 px-2.5 py-1 rounded-full border border-white/20">
                  Multi-Share
                </span>
              </div>
            ) : (
              <div className="w-full p-4 rounded-2xl bg-[#FF3B30]/10 border border-[#FF3B30]/30 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-full bg-[#FF3B30]/20 flex items-center justify-center text-[#FF3B30]">
                    <Flame className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-widest text-[#FF3B30] font-semibold">
                      Read-Once Triggered — Payload Burned
                    </p>
                    <p className="text-[10px] text-white/50">
                      Permanently purged from memory. This window holds the only remaining copy.
                    </p>
                  </div>
                </div>
                <span className="text-[9px] uppercase tracking-widest font-mono text-[#FF3B30] bg-[#FF3B30]/20 px-2.5 py-1 rounded-full border border-[#FF3B30]/30">
                  Purged
                </span>
              </div>
            )}

            {/* PAYLOAD CONTAINER */}
            {retrievedPayload.type === 'text' ? (
              <div className="w-full relative border border-white/20 rounded-2xl bg-white/[0.02] p-6 sm:p-8 flex flex-col space-y-4">
                <div className="flex justify-between items-center pb-3 border-b border-white/[0.05]">
                  <span className="text-[10px] uppercase tracking-widest text-white/40 font-mono">
                    Decrypted String ({retrievedPayload.textContent?.length} characters)
                  </span>
                  <button
                    id="copy-retrieved-text"
                    onClick={handleCopyText}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white text-white hover:text-black transition-all text-[10px] uppercase tracking-widest font-medium"
                  >
                    {copiedText ? (
                      <>
                        <Check className="w-3 h-3 text-[#FF3B30]" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy All</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="p-4 rounded-xl bg-black/40 border border-white/5 overflow-x-auto max-h-80 select-text">
                  <pre className="font-mono text-sm text-white/90 whitespace-pre-wrap break-all leading-relaxed">
                    {retrievedPayload.textContent}
                  </pre>
                </div>
              </div>
            ) : (
              /* FILE CONTAINER */
              <div className="w-full relative border border-white/20 rounded-2xl bg-white/[0.02] p-8 flex flex-col items-center text-center space-y-6">
                <div className="w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/10 flex items-center justify-center">
                  <Download className="w-8 h-8 text-[#FF3B30]" />
                </div>

                <div className="space-y-1">
                  <h3 className="text-lg font-mono text-white">
                    {retrievedPayload.file?.name}
                  </h3>
                  <p className="text-xs text-white/40 uppercase tracking-widest">
                    {formatFileSize(retrievedPayload.file?.size)} • {retrievedPayload.file?.type}
                  </p>
                </div>

                <button
                  id="download-retrieved-file"
                  onClick={handleDownloadFile}
                  className="flex items-center space-x-2 px-8 py-3 rounded-xl bg-white text-black text-xs uppercase tracking-[0.25em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all shadow-xl cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Download File</span>
                </button>
              </div>
            )}

            {/* Finish and New Session */}
            <div className="pt-4 flex items-center space-x-4">
              <button
                id="pickup-done-btn"
                onClick={onReturnToDrop}
                className="px-6 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-white text-[11px] uppercase tracking-[0.2em] transition-all border border-white/10"
              >
                Close & Return
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
