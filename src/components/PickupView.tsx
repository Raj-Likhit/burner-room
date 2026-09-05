import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  KeyRound,
  Download,
  Copy,
  Check,
  Flame,
  AlertCircle,
  ArrowLeft,
  ShieldAlert,
  Sparkles,
  CheckCircle2,
  Lock,
  FileCheck,
  FileText,
  Clock,
  Unlock,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
  Zap,
  ExternalLink,
} from 'lucide-react';
import { BurnerFileMetadata, BurnerPayload, CheckPayloadResponse, ApiErrorDetail } from '../types';
import {
  importKeyFromString,
  decryptData,
  sanitizeFilename,
  downloadDataUrlAsBlob,
  unwrapKeyWithPin,
  getByteLengthFromDataUrl,
  triggerServerStreamDownload,
  openDataUrlInNewTab,
} from '../lib/crypto';
import { BurnerApi, normalizeApiError } from '../lib/api';
import { FileIconPreview } from './FileIconPreview';
import { ClipboardFallbackModal } from './ClipboardFallbackModal';

interface PickupViewProps {
  initialPin?: string;
  initialKey?: string;
  onPickupSuccess: (payload: BurnerPayload) => void;
  onReturnToDrop: () => void;
}

export const PickupView: React.FC<PickupViewProps> = ({
  initialPin = '',
  initialKey = '',
  onPickupSuccess,
  onReturnToDrop,
}) => {
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorDetail | null>(null);
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null);
  const [inspectedMeta, setInspectedMeta] = useState<CheckPayloadResponse | null>(null);
  const [retrievedPayload, setRetrievedPayload] = useState<BurnerPayload | null>(null);
  const [decryptedText, setDecryptedText] = useState<string | null>(null);
  const [decryptedFile, setDecryptedFile] = useState<BurnerFileMetadata | null>(null);
  const [e2eKeyString, setE2eKeyString] = useState<string>(initialKey);
  const [manualKeyInput, setManualKeyInput] = useState<string>('');
  const [needsManualKey, setNeedsManualKey] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [fallbackModalText, setFallbackModalText] = useState<string | null>(null);

  const inputRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];

  // Parse URL hash for #key=... if present
  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const match = hash.match(/key=([^&]+)/);
      if (match && match[1]) {
        setE2eKeyString(match[1]);
      }
    }
  }, []);

  // Lockout countdown timer
  useEffect(() => {
    if (lockoutSeconds === null || lockoutSeconds <= 0) return;
    const timer = setInterval(() => {
      setLockoutSeconds((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          setApiError(null);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutSeconds]);

  // Initial PIN from URL query param: prefill digits and inspect metadata WITHOUT burning!
  useEffect(() => {
    if (initialPin && initialPin.length === 4) {
      const pinDigits = initialPin.split('');
      setDigits(pinDigits);
      handleInspectPayload(initialPin);
    }
  }, [initialPin]);

  // Non-destructive check on PIN with BurnerApi client
  const handleInspectPayload = async (pinCode: string) => {
    setIsChecking(true);
    setApiError(null);
    setInspectedMeta(null);

    try {
      const data = await BurnerApi.checkPayload(pinCode);
      if (data.exists) {
        setInspectedMeta(data);
      }
    } catch (err: any) {
      const normalized = normalizeApiError(err);
      setApiError(normalized);
      if (normalized.retryAfter) {
        setLockoutSeconds(Number(normalized.retryAfter));
      }
    } finally {
      setIsChecking(false);
    }
  };

  const handleDigitChange = (index: number, value: string) => {
    if (value.length > 1) {
      const cleaned = value.replace(/[^0-9]/g, '').slice(0, 4);
      if (cleaned.length === 4) {
        const next = cleaned.split('');
        setDigits(next);
        inputRefs[3].current?.focus();
        handleInspectPayload(cleaned);
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

    // When all 4 digits entered, inspect metadata (safe preview, no burn)
    if (singleDigit && index === 3 && nextDigits.every((d) => d !== '')) {
      handleInspectPayload(nextDigits.join(''));
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs[index - 1].current?.focus();
    } else if (e.key === 'Enter') {
      const activePin = digits.join('');
      if (activePin.length === 4) {
        if (inspectedMeta) {
          handleExplicitPickup(activePin);
        } else {
          handleInspectPayload(activePin);
        }
      }
    }
  };

  // Explicit Human Tap: Executes /api/pickup & Decrypts
  const handleExplicitPickup = async (pinCode: string, providedKey?: string) => {
    setIsLoading(true);
    setApiError(null);
    setDownloadProgress(20);

    const activeKeyStr = providedKey || e2eKeyString || manualKeyInput.trim();

    try {
      setDownloadProgress(45);
      const data = await BurnerApi.pickupPayload(pinCode);
      setDownloadProgress(70);

      if (data.success && data.payload) {
        const payload: BurnerPayload = data.payload;
        setRetrievedPayload(payload);
        setDownloadProgress(85);

        // Handle End-to-End Decryption
        if (payload.encryptedBundle?.isEncrypted) {
          let resolvedKeyStr = activeKeyStr;

          // If key is not in URL hash or manual input, automatically unwrap using PIN
          if (!resolvedKeyStr && payload.encryptedBundle.pinKeyBundle && pinCode) {
            try {
              resolvedKeyStr = await unwrapKeyWithPin(payload.encryptedBundle.pinKeyBundle, pinCode);
            } catch (unwrapErr) {
              console.warn('Failed to unwrap master key with PIN:', unwrapErr);
            }
          }

          if (!resolvedKeyStr) {
            setNeedsManualKey(true);
            setIsLoading(false);
            setDownloadProgress(null);
            return;
          }

          try {
            const cryptoKey = await importKeyFromString(resolvedKeyStr);
            const decryptedRaw = await decryptData(payload.encryptedBundle, cryptoKey);

            if (payload.type === 'text') {
              setDecryptedText(decryptedRaw);
            } else if (payload.type === 'file') {
              const fileObj = JSON.parse(decryptedRaw);
              const computedSize = (fileObj.size && fileObj.size > 0)
                ? fileObj.size
                : (payload.file?.size && payload.file.size > 0)
                ? payload.file.size
                : getByteLengthFromDataUrl(fileObj.dataUrl || '');

              setDecryptedFile({
                name: sanitizeFilename(fileObj.name || payload.file?.name || 'decrypted-file'),
                size: computedSize,
                type: fileObj.type || payload.file?.type || 'application/octet-stream',
                dataUrl: fileObj.dataUrl,
              });
            }
          } catch (decryptErr) {
            console.error('Decryption failed', decryptErr);
            setApiError({
              code: 'DECRYPTION_FAILED',
              message: 'Decryption failed. The encryption key in the link is invalid, mismatching, or corrupted.',
              retryable: false,
            });
            setNeedsManualKey(true);
          }
        } else {
          // Standard unencrypted payload
          if (payload.type === 'text') {
            setDecryptedText(payload.textContent || '');
          } else if (payload.file) {
            const computedSize = (payload.file.size && payload.file.size > 0)
              ? payload.file.size
              : getByteLengthFromDataUrl(payload.file.dataUrl || '');

            setDecryptedFile({
              name: sanitizeFilename(payload.file.name),
              size: computedSize,
              type: payload.file.type || 'application/octet-stream',
              dataUrl: payload.file.dataUrl,
            });
          }
        }

        setDownloadProgress(100);
        onPickupSuccess(payload);
      }
    } catch (err: any) {
      const normalized = normalizeApiError(err);
      setApiError(normalized);
      if (normalized.retryAfter) {
        setLockoutSeconds(Number(normalized.retryAfter));
      }
    } finally {
      setIsLoading(false);
      setTimeout(() => setDownloadProgress(null), 300);
    }
  };

  const handleApplyManualKey = async () => {
    if (!manualKeyInput.trim()) return;
    const key = manualKeyInput.trim();
    setE2eKeyString(key);

    if (retrievedPayload?.encryptedBundle?.isEncrypted) {
      setIsLoading(true);
      try {
        const cryptoKey = await importKeyFromString(key);
        const decryptedRaw = await decryptData(retrievedPayload.encryptedBundle, cryptoKey);

        if (retrievedPayload.type === 'text') {
          setDecryptedText(decryptedRaw);
        } else if (retrievedPayload.type === 'file') {
          const fileObj = JSON.parse(decryptedRaw);
          setDecryptedFile({
            name: sanitizeFilename(fileObj.name || retrievedPayload.file?.name || 'decrypted-file'),
            size: fileObj.size || retrievedPayload.file?.size || 0,
            type: fileObj.type || retrievedPayload.file?.type || 'application/octet-stream',
            dataUrl: fileObj.dataUrl,
          });
        }
        setNeedsManualKey(false);
        setApiError(null);
      } catch (err) {
        console.error('Decryption failed with manual key', err);
        setApiError({
          code: 'DECRYPTION_FAILED',
          message: 'Invalid key. Unable to decrypt payload.',
          retryable: true,
        });
      } finally {
        setIsLoading(false);
      }
    } else if (digits.every((d) => d !== '')) {
      handleExplicitPickup(digits.join(''), key);
    }
  };

  const handleCopyText = async () => {
    const textToCopy = decryptedText || retrievedPayload?.textContent;
    if (textToCopy) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(textToCopy);
          setCopiedText(true);
          setTimeout(() => setCopiedText(false), 2000);
        } else {
          setFallbackModalText(textToCopy);
        }
      } catch {
        setFallbackModalText(textToCopy);
      }
    }
  };

  const handleDownloadFile = async () => {
    const targetFile = decryptedFile || retrievedPayload?.file;
    if (!targetFile?.dataUrl) {
      setApiError({
        code: 'FILE_DATA_MISSING',
        message: 'File binary data is unavailable in the retrieved payload.',
        retryable: false,
      });
      return;
    }

    const safeName = sanitizeFilename(targetFile.name || 'burner-download');
    const success = await downloadDataUrlAsBlob(
      targetFile.dataUrl,
      safeName,
      targetFile.type || 'application/octet-stream'
    );

    if (success) {
      setIsDownloaded(true);
      setTimeout(() => setIsDownloaded(false), 2500);
    }
  };

  const handleDirectStreamDownload = () => {
    const targetFile = decryptedFile || retrievedPayload?.file;
    if (!targetFile?.dataUrl) {
      setApiError({
        code: 'FILE_DATA_MISSING',
        message: 'File binary data is unavailable in the retrieved payload.',
        retryable: false,
      });
      return;
    }

    const safeName = sanitizeFilename(targetFile.name || 'burner-download');
    triggerServerStreamDownload(
      targetFile.dataUrl,
      safeName,
      targetFile.type || 'application/octet-stream'
    );
    setIsDownloaded(true);
    setTimeout(() => setIsDownloaded(false), 2500);
  };

  const handleOpenInNewTab = async () => {
    const targetFile = decryptedFile || retrievedPayload?.file;
    if (!targetFile?.dataUrl) return;
    const safeName = sanitizeFilename(targetFile.name || 'burner-preview');
    await openDataUrlInNewTab(targetFile.dataUrl, safeName);
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const activePinString = digits.join('');

  return (
    <div className="w-full max-w-2xl flex flex-col items-center select-none">
      <AnimatePresence mode="wait">
        {!retrievedPayload ? (
          /* PIN INPUT PROMPT & PREVIEW */
          <motion.div
            key="pin-entry"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="w-full flex flex-col items-center space-y-8"
          >
            <div className="text-center space-y-2">
              <p className="text-[11px] uppercase tracking-[0.4em] text-white/40 font-mono">
                Retrieve Ephemeral Payload
              </p>
              <h2 className="text-2xl sm:text-3xl font-light text-white tracking-tight">
                Enter 4-Digit Session PIN
              </h2>
              <p className="text-xs text-white/50 max-w-sm mx-auto leading-relaxed">
                Enter the session PIN or follow a shared link to unlock the payload.
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

            {/* Progress / Decryption Bar */}
            {downloadProgress !== null && (
              <div className="w-full max-w-md space-y-1.5 p-3 rounded-xl bg-white/[0.03] border border-white/10">
                <div className="flex justify-between text-[10px] uppercase tracking-widest font-mono text-white/60">
                  <span>Retrieving & Decrypting...</span>
                  <span>{downloadProgress}%</span>
                </div>
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-[#FF3B30]"
                    initial={{ width: '0%' }}
                    animate={{ width: `${downloadProgress}%` }}
                    transition={{ ease: 'easeOut', duration: 0.2 }}
                  />
                </div>
              </div>
            )}

            {/* ERROR CARD / LOCKOUT CARD / DISTRIBUTED ATTACK NOTIFICATION */}
            {apiError && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className={`p-4 rounded-2xl border text-xs flex items-start space-x-3 max-w-md w-full ${
                  apiError.code === 'DISTRIBUTED_ATTACK_BURNED'
                    ? 'bg-[#FF3B30]/20 border-[#FF3B30] text-white shadow-[0_0_15px_rgba(255,59,48,0.3)]'
                    : apiError.code === 'LOCKED_OUT'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                    : 'bg-[#FF3B30]/10 border-[#FF3B30]/30 text-[#FF3B30]'
                }`}
              >
                {apiError.code === 'DISTRIBUTED_ATTACK_BURNED' ? (
                  <Flame className="w-5 h-5 flex-shrink-0 text-[#FF3B30] animate-pulse" />
                ) : apiError.code === 'LOCKED_OUT' ? (
                  <ShieldAlert className="w-5 h-5 flex-shrink-0 text-amber-400" />
                ) : (
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                )}
                <div className="flex-1 text-left">
                  <div className="flex items-center space-x-2">
                    <span className="font-semibold uppercase tracking-wider text-[10px] font-mono">
                      {apiError.code === 'DISTRIBUTED_ATTACK_BURNED'
                        ? 'SECURITY ALERT'
                        : apiError.code === 'LOCKED_OUT'
                        ? 'RATE LIMIT LOCKOUT'
                        : 'PICKUP ERROR'}
                    </span>
                    {lockoutSeconds !== null && lockoutSeconds > 0 && (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-black/40 text-amber-300">
                        Unlocks in {Math.floor(lockoutSeconds / 60)}m {lockoutSeconds % 60}s
                      </span>
                    )}
                  </div>
                  <p className="mt-1 leading-relaxed text-white/90">{apiError.message}</p>
                </div>
              </motion.div>
            )}

            {/* SKELETON LOADING PREVIEW (Shows while non-destructively checking PIN) */}
            {isChecking && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="w-full max-w-md p-6 rounded-2xl bg-white/[0.02] border border-white/10 flex flex-col space-y-4 text-center items-center animate-pulse"
              >
                <div className="w-10 h-10 rounded-xl bg-white/10" />
                <div className="space-y-2 w-full flex flex-col items-center">
                  <div className="h-4 bg-white/10 rounded w-3/4" />
                  <div className="h-3 bg-white/5 rounded w-1/2" />
                </div>
                <div className="h-10 bg-white/10 rounded-xl w-full" />
              </motion.div>
            )}

            {/* GATED PREVIEW CARD (Protects against Slack/iMessage Bot Unfurling auto-burn!) */}
            {!isChecking && inspectedMeta && (
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-md p-6 rounded-2xl bg-white/[0.03] border border-white/20 flex flex-col space-y-4 shadow-xl text-center items-center"
              >
                <FileIconPreview
                  fileName={inspectedMeta.fileMeta?.name}
                  fileType={inspectedMeta.type === 'text' ? 'text/plain' : inspectedMeta.fileMeta?.type}
                  size="lg"
                />

                <div className="space-y-1">
                  <h4 className="text-base font-mono text-white font-medium">
                    {inspectedMeta.type === 'file'
                      ? inspectedMeta.fileMeta?.name || 'Incoming File'
                      : 'Incoming Encrypted Text'}
                  </h4>
                  <p className="text-xs text-white/50">
                    {inspectedMeta.type === 'file'
                      ? `${formatFileSize(inspectedMeta.fileMeta?.size)} • ${inspectedMeta.fileMeta?.type || 'Binary'}`
                      : 'Zero-persistence confidential snippet'}
                  </p>
                </div>

                <div className="flex items-center space-x-2 text-[10px] font-mono text-white/60">
                  <span className="px-2.5 py-1 rounded bg-white/5 border border-white/10 flex items-center space-x-1">
                    <Clock className="w-3 h-3 text-[#FF3B30]" />
                    <span>Expires in {Math.round((inspectedMeta.remainingSeconds || 600) / 60)}m</span>
                  </span>

                  {inspectedMeta.shareMode === 'multiple_reads' ? (
                    <span className="px-2.5 py-1 rounded bg-white/10 border border-white/20 text-white">
                      Multi-Share
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded bg-[#FF3B30]/20 border border-[#FF3B30]/30 text-[#FF3B30]">
                      1-Time Self-Destruct
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-white/40 italic">
                  {inspectedMeta.shareMode === 'multiple_reads'
                    ? 'Retrieving will log access. Payload remains until TTL expires.'
                    : '🔥 Tapping below will retrieve and permanently incinerate this payload.'}
                </p>

                {/* EXPLICIT HUMAN TAP BUTTON */}
                <button
                  id="unlock-payload-btn"
                  onClick={() => handleExplicitPickup(activePinString)}
                  disabled={isLoading}
                  className="w-full py-3.5 rounded-xl bg-white text-black text-xs uppercase tracking-[0.25em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all shadow-xl cursor-pointer flex items-center justify-center space-x-2"
                >
                  <Unlock className="w-4 h-4" />
                  <span>{inspectedMeta.shareMode === 'multiple_reads' ? 'Unlock Payload' : 'Unlock & Incinerate'}</span>
                </button>
              </motion.div>
            )}

            {/* Fallback button if metadata not yet inspected */}
            {!isChecking && !inspectedMeta && (
              <div className="flex flex-col items-center space-y-4">
                <button
                  id="fetch-payload-btn"
                  onClick={() => handleInspectPayload(activePinString)}
                  disabled={isChecking || activePinString.length !== 4 || lockoutSeconds !== null}
                  className="px-8 py-3 rounded-xl bg-white text-black text-xs uppercase tracking-[0.25em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shadow-lg"
                >
                  {isChecking ? 'Checking PIN...' : 'Inspect Session'}
                </button>

                <button
                  onClick={onReturnToDrop}
                  className="flex items-center space-x-1.5 text-[10px] uppercase tracking-[0.2em] text-white/40 hover:text-white transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3 h-3" />
                  <span>Return to Drop</span>
                </button>
              </div>
            )}
          </motion.div>
        ) : needsManualKey ? (
          /* MANUAL KEY PROMPT IF E2E ENCRYPTED BUT KEY NOT IN URL */
          <motion.div
            key="key-prompt"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md p-8 rounded-3xl bg-white/[0.03] border border-white/20 flex flex-col space-y-6 text-center items-center shadow-2xl"
          >
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
              <ShieldCheck className="w-6 h-6 text-emerald-400" />
            </div>

            <div className="space-y-1">
              <h3 className="text-xl font-light text-white tracking-wide">
                Decryption Key Required
              </h3>
              <p className="text-xs text-white/50 max-w-xs mx-auto">
                This payload was encrypted client-side with Zero-Knowledge AES-GCM. Enter the secret key provided by the sender.
              </p>
            </div>

            <input
              type="text"
              id="manual-key-input"
              value={manualKeyInput}
              onChange={(e) => setManualKeyInput(e.target.value)}
              placeholder="Paste Base64 URL key..."
              className="w-full p-3 rounded-xl bg-black/50 border border-white/20 text-xs font-mono text-white placeholder-white/20 outline-none focus:border-emerald-400 text-center"
            />

            <div className="flex items-center space-x-3 w-full">
              <button
                onClick={handleApplyManualKey}
                disabled={!manualKeyInput.trim()}
                className="flex-1 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs uppercase tracking-[0.2em] font-semibold transition-all cursor-pointer disabled:opacity-40"
              >
                Decrypt Payload
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
            {retrievedPayload.shareMode === 'multiple_reads' && !retrievedPayload.status?.includes('retrieved') ? (
              <div className="w-full p-4 rounded-2xl bg-white/[0.03] border border-white/20 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white">
                    <CheckCircle2 className="w-4 h-4 text-[#FF3B30]" />
                  </div>
                  <div className="text-left">
                    <p className="text-xs uppercase tracking-widest text-white font-semibold flex items-center space-x-2">
                      <span>Multi-Device Drop Retrieved</span>
                      <span className="text-[10px] text-white/50 font-normal font-mono">
                        (Access #{retrievedPayload.readCount || 1} / {retrievedPayload.maxReads || '∞'})
                      </span>
                    </p>
                    <p className="text-[10px] text-white/50">
                      Payload remains available for other authorized devices until TTL expiration.
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
                  <div className="text-left">
                    <p className="text-xs uppercase tracking-widest text-[#FF3B30] font-semibold">
                      Read-Once Triggered — Payload Burned
                    </p>
                    <p className="text-[10px] text-white/50">
                      Permanently incinerated from RAM. This browser holds the only remaining copy.
                    </p>
                  </div>
                </div>
                <span className="text-[9px] uppercase tracking-widest font-mono text-[#FF3B30] bg-[#FF3B30]/20 px-2.5 py-1 rounded-full border border-[#FF3B30]/30">
                  Purged
                </span>
              </div>
            )}

            {/* PAYLOAD CONTENT CONTAINER */}
            {retrievedPayload.type === 'text' ? (
              <div className="w-full relative border border-white/20 rounded-3xl bg-white/[0.02] p-6 sm:p-8 flex flex-col space-y-4 shadow-xl">
                <div className="flex justify-between items-center pb-3 border-b border-white/[0.05]">
                  <span className="text-[10px] uppercase tracking-widest text-white/40 font-mono">
                    Decrypted String ({(decryptedText || retrievedPayload.textContent || '').length} characters)
                  </span>
                  <button
                    id="copy-retrieved-text"
                    onClick={handleCopyText}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white text-white hover:text-black transition-all text-[10px] uppercase tracking-widest font-medium cursor-pointer"
                  >
                    {copiedText ? (
                      <>
                        <Check className="w-3 h-3 text-[#FF3B30]" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy Text</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="p-4 rounded-2xl bg-black/40 border border-white/5 overflow-x-auto max-h-80 select-text">
                  <pre className="font-mono text-sm text-white/90 whitespace-pre-wrap break-all leading-relaxed text-left">
                    {decryptedText || retrievedPayload.textContent}
                  </pre>
                </div>
              </div>
            ) : (
              /* FILE CONTAINER */
              <div className="w-full relative border border-white/20 rounded-3xl bg-white/[0.02] p-8 flex flex-col items-center text-center space-y-6 shadow-xl">
                <FileIconPreview
                  fileName={decryptedFile?.name || retrievedPayload.file?.name}
                  fileType={decryptedFile?.type || retrievedPayload.file?.type}
                  dataUrl={decryptedFile?.dataUrl || retrievedPayload.file?.dataUrl}
                  size="lg"
                />

                <div className="space-y-1">
                  <h3 className="text-lg font-mono text-white max-w-sm truncate font-medium">
                    {decryptedFile?.name || retrievedPayload.file?.name}
                  </h3>
                  <div className="flex items-center justify-center flex-wrap gap-2 text-xs text-white/50 font-mono">
                    <span className="uppercase tracking-wider">
                      {formatFileSize(decryptedFile?.size || retrievedPayload.file?.size)}
                    </span>
                    <span>•</span>
                    <span className="uppercase tracking-wider">
                      {decryptedFile?.type || retrievedPayload.file?.type || 'Binary'}
                    </span>
                    {(decryptedFile?.size || retrievedPayload.file?.size) ? (
                      <>
                        <span>•</span>
                        <span className="text-emerald-400 font-mono">
                          {(decryptedFile?.size || retrievedPayload.file?.size || 0).toLocaleString()} bytes verified
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3 w-full max-w-md">
                  <button
                    id="download-retrieved-file"
                    onClick={handleDownloadFile}
                    className={`flex-1 flex items-center justify-center space-x-2 px-6 py-3 rounded-xl text-xs uppercase tracking-[0.2em] font-semibold transition-all shadow-xl cursor-pointer ${
                      isDownloaded
                        ? 'bg-emerald-500 text-white shadow-emerald-500/20'
                        : 'bg-white text-black hover:bg-[#FF3B30] hover:text-white'
                    }`}
                  >
                    {isDownloaded ? (
                      <>
                        <Check className="w-4 h-4 text-white animate-bounce" />
                        <span>Saved</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        <span>Download File</span>
                      </>
                    )}
                  </button>

                  <button
                    id="download-stream-btn"
                    onClick={handleDirectStreamDownload}
                    title="Direct binary stream from server — guaranteed non-0-byte download bypassing browser sandbox"
                    className="flex items-center justify-center space-x-2 px-4 py-3 rounded-xl text-xs uppercase tracking-wider font-medium text-white/80 bg-white/5 hover:bg-white/10 hover:text-white border border-white/10 transition-all cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-[#FF3B30]" />
                    <span>Direct Stream</span>
                  </button>

                  <button
                    id="open-tab-btn"
                    onClick={handleOpenInNewTab}
                    title="Open file in a new browser tab to view or save directly"
                    className="flex items-center justify-center space-x-1.5 px-3.5 py-3 rounded-xl text-xs uppercase tracking-wider font-medium text-white/60 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 transition-all cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Preview</span>
                  </button>
                </div>
              </div>
            )}

            {/* Privacy note on residual URL hash keys */}
            <div className="p-3 px-4 rounded-xl bg-white/[0.02] border border-white/10 text-[11px] text-white/40 text-center max-w-lg leading-relaxed">
              <span className="text-white/60 font-medium">Privacy Note:</span> Hash fragment keys (<code className="text-[#FF3B30] font-mono">#key=...</code>) never reach server logs, but remain in local browser history & clipboard on this device. Close this browser tab or clear history for maximum confidentiality.
            </div>

            {/* Finish and New Session */}
            <div className="pt-2 flex items-center space-x-4">
              <button
                id="pickup-done-btn"
                onClick={onReturnToDrop}
                className="px-6 py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-white text-[11px] uppercase tracking-[0.2em] transition-all border border-white/10 cursor-pointer"
              >
                Close & Return
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Clipboard Fallback Modal */}
      <ClipboardFallbackModal
        isOpen={fallbackModalText !== null}
        onClose={() => setFallbackModalText(null)}
        textToCopy={fallbackModalText || ''}
        title="Copy Retrieved Text"
      />
    </div>
  );
};
