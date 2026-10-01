import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Download,
  Copy,
  Check,
  AlertCircle,
  ArrowLeft,
  Clock,
  ShieldCheck,
  FileCheck,
  Send,
  Eye,
  Trash2,
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
  getFileTypeInfo,
  formatFriendlyFileSize,
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
  const [isFileDeleted, setIsFileDeleted] = useState(false);
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

  // Initial PIN from URL query param: prefill digits and inspect metadata
  useEffect(() => {
    if (initialPin && initialPin.length === 4) {
      const pinDigits = initialPin.split('');
      setDigits(pinDigits);
      handleInspectPayload(initialPin);
    }
  }, [initialPin]);

  // Real-time SSE listener for current PIN to detect deletion instantly
  const activePinString = digits.join('');
  useEffect(() => {
    if (activePinString.length !== 4) return;

    const sseUrl = `/api/events/${activePinString}`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(sseUrl);
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.isBurned || data.type === 'burned' || data.message === 'File has been deleted.') {
            setIsFileDeleted(true);
          } else if (data.type === 'pickup' && typeof data.readCount === 'number') {
            setInspectedMeta((prev) => (prev ? { ...prev, readCount: data.readCount } : null));
          }
        } catch {
          // ignore parse errors
        }
      };
      es.onerror = () => {
        es?.close();
      };
    } catch {
      // ignore connection error
    }

    return () => {
      es?.close();
    };
  }, [activePinString]);

  // Non-destructive check on PIN with BurnerApi client
  const handleInspectPayload = async (pinCode: string) => {
    setIsChecking(true);
    setApiError(null);
    setInspectedMeta(null);
    setIsFileDeleted(false);

    try {
      const data = await BurnerApi.checkPayload(pinCode);
      if (data.exists) {
        setInspectedMeta(data);
      }
    } catch (err: any) {
      const normalized = normalizeApiError(err);
      if (
        normalized.code === 'FILE_DELETED' ||
        normalized.message?.toLowerCase().includes('deleted') ||
        normalized.message?.toLowerCase().includes('incinerated')
      ) {
        setIsFileDeleted(true);
      } else {
        setApiError(normalized);
      }
      if (normalized.retryAfter) {
        setLockoutSeconds(Number(normalized.retryAfter));
      }
    } finally {
      setIsChecking(false);
    }
  };

  const handleDigitChange = (index: number, value: string) => {
    setIsFileDeleted(false);
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

    // When all 4 digits entered, inspect file details
    if (singleDigit && index === 3 && nextDigits.every((d) => d !== '')) {
      handleInspectPayload(nextDigits.join(''));
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs[index - 1].current?.focus();
    } else if (e.key === 'Enter') {
      const pinCode = digits.join('');
      if (pinCode.length === 4) {
        if (inspectedMeta) {
          handleExplicitPickup(pinCode);
        } else {
          handleInspectPayload(pinCode);
        }
      }
    }
  };

  // Human click: executes /api/pickup & decrypts payload
  const handleExplicitPickup = async (pinCode: string, providedKey?: string) => {
    setIsLoading(true);
    setApiError(null);
    setDownloadProgress(20);

    const activeKeyStr = providedKey || e2eKeyString || manualKeyInput.trim();

    try {
      setDownloadProgress(45);
      const data = await BurnerApi.pickupPayload(pinCode);
      setDownloadProgress(70);

      if (data.isBurned) {
        setIsFileDeleted(true);
      }

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
              console.warn('Could not unwrap key with PIN:', unwrapErr);
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
              const resolvedName = sanitizeFilename(fileObj.name || payload.file?.name || 'downloaded-file');
              const computedSize = (fileObj.size && fileObj.size > 0)
                ? fileObj.size
                : (payload.file?.size && payload.file.size > 0)
                ? payload.file.size
                : getByteLengthFromDataUrl(fileObj.dataUrl || '');

              const typeInfo = getFileTypeInfo(resolvedName, fileObj.type || payload.file?.type);

              setDecryptedFile({
                name: resolvedName,
                size: computedSize,
                type: typeInfo.mimeType,
                dataUrl: fileObj.dataUrl,
              });
            }
          } catch (decryptErr) {
            console.error('Decryption failed', decryptErr);
            setApiError({
              code: 'DECRYPTION_FAILED',
              message: 'Unable to decrypt file. The secret key is invalid or incomplete.',
              retryable: false,
            });
            setNeedsManualKey(true);
          }
        } else {
          // Standard unencrypted payload
          if (payload.type === 'text') {
            setDecryptedText(payload.textContent || '');
          } else if (payload.file) {
            const resolvedName = sanitizeFilename(payload.file.name || 'downloaded-file');
            const computedSize = (payload.file.size && payload.file.size > 0)
              ? payload.file.size
              : getByteLengthFromDataUrl(payload.file.dataUrl || '');

            const typeInfo = getFileTypeInfo(resolvedName, payload.file.type);

            setDecryptedFile({
              name: resolvedName,
              size: computedSize,
              type: typeInfo.mimeType,
              dataUrl: payload.file.dataUrl,
            });
          }
        }

        setDownloadProgress(100);
        onPickupSuccess(payload);
      }
    } catch (err: any) {
      const normalized = normalizeApiError(err);
      if (
        normalized.code === 'FILE_DELETED' ||
        normalized.message?.toLowerCase().includes('deleted') ||
        normalized.message?.toLowerCase().includes('incinerated')
      ) {
        setIsFileDeleted(true);
      } else {
        setApiError(normalized);
      }
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
          const resolvedName = sanitizeFilename(fileObj.name || retrievedPayload.file?.name || 'downloaded-file');
          const computedSize = fileObj.size || retrievedPayload.file?.size || getByteLengthFromDataUrl(fileObj.dataUrl || '') || 0;
          const typeInfo = getFileTypeInfo(resolvedName, fileObj.type || retrievedPayload.file?.type);

          setDecryptedFile({
            name: resolvedName,
            size: computedSize,
            type: typeInfo.mimeType,
            dataUrl: fileObj.dataUrl,
          });
        }
        setNeedsManualKey(false);
        setApiError(null);
      } catch (err) {
        console.error('Decryption failed with manual key', err);
        setApiError({
          code: 'DECRYPTION_FAILED',
          message: 'Incorrect encryption key. Please check the key and try again.',
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
        message: 'File data is not available for download.',
        retryable: false,
      });
      return;
    }

    const safeName = sanitizeFilename(targetFile.name || 'downloaded-file');
    const success = await downloadDataUrlAsBlob(
      targetFile.dataUrl,
      safeName,
      targetFile.type || 'application/octet-stream'
    );

    if (success) {
      setIsDownloaded(true);
      setTimeout(() => setIsDownloaded(false), 3000);
    }
  };

  const handleStreamDownload = () => {
    const targetFile = decryptedFile || retrievedPayload?.file;
    if (!targetFile?.dataUrl) return;
    const safeName = sanitizeFilename(targetFile.name || 'downloaded-file');
    triggerServerStreamDownload(
      targetFile.dataUrl,
      safeName,
      targetFile.type || 'application/octet-stream'
    );
    setIsDownloaded(true);
    setTimeout(() => setIsDownloaded(false), 3000);
  };

  const handlePreviewFile = async () => {
    const targetFile = decryptedFile || retrievedPayload?.file;
    if (!targetFile?.dataUrl) return;
    const safeName = sanitizeFilename(targetFile.name || 'file-preview');
    await openDataUrlInNewTab(targetFile.dataUrl, safeName);
  };

  const handleResetCode = () => {
    setIsFileDeleted(false);
    setDigits(['', '', '', '']);
    setInspectedMeta(null);
    setRetrievedPayload(null);
    setDecryptedFile(null);
    setDecryptedText(null);
    setApiError(null);
    inputRefs[0].current?.focus();
  };

  // Resolve display name, size, and label for inspected file preview
  const inspectedName = inspectedMeta?.fileMeta?.name || 'Shared File';
  const inspectedSize = inspectedMeta?.fileMeta?.size && inspectedMeta.fileMeta.size > 0
    ? formatFriendlyFileSize(inspectedMeta.fileMeta.size)
    : null;
  const inspectedTypeInfo = inspectedMeta?.type === 'file'
    ? getFileTypeInfo(inspectedName, inspectedMeta?.fileMeta?.type)
    : null;

  // Resolve display name, size, and label for retrieved file
  const resolvedRetrievedFile = decryptedFile || retrievedPayload?.file;
  const resolvedRetrievedName = resolvedRetrievedFile?.name || 'Shared File';
  const resolvedRetrievedSize = resolvedRetrievedFile?.size && resolvedRetrievedFile.size > 0
    ? resolvedRetrievedFile.size
    : (resolvedRetrievedFile?.dataUrl ? getByteLengthFromDataUrl(resolvedRetrievedFile.dataUrl) : 0);
  const resolvedRetrievedTypeInfo = getFileTypeInfo(resolvedRetrievedName, resolvedRetrievedFile?.type);

  return (
    <div className="w-full max-w-xl flex flex-col items-center select-none">
      <AnimatePresence mode="wait">
        {/* STATE A: FILE HAS BEEN DELETED (Before retrieval, e.g. download limit was reached) */}
        {isFileDeleted && !retrievedPayload ? (
          <motion.div
            key="deleted-receive-state"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="w-full max-w-md p-6 sm:p-8 rounded-3xl bg-[#141010] border border-red-500/30 flex flex-col items-center text-center space-y-6 shadow-2xl"
          >
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400">
              <Trash2 className="w-6 h-6 text-red-400" />
            </div>

            <div className="space-y-1.5">
              <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-semibold mb-1">
                <span>File has been deleted</span>
              </div>
              <h3 className="text-xl sm:text-2xl font-light text-white tracking-tight">
                File has been deleted
              </h3>
              <p className="text-xs sm:text-sm text-zinc-400 max-w-sm mx-auto leading-relaxed">
                The set limit of downloads has been reached for code{' '}
                <span className="font-mono text-white font-semibold">{activePinString || initialPin}</span>.
                This transfer has been automatically and permanently deleted from the server.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-3 w-full pt-2">
              <button
                onClick={handleResetCode}
                className="w-full py-3 px-5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold transition-all cursor-pointer"
              >
                Enter another code
              </button>
              <button
                onClick={onReturnToDrop}
                className="w-full py-3 px-5 rounded-xl bg-white hover:bg-zinc-200 text-black text-xs font-semibold transition-all cursor-pointer"
              >
                Send a file
              </button>
            </div>
          </motion.div>
        ) : !retrievedPayload ? (
          /* STATE B: ENTER CODE & PREVIEW FILE */
          <motion.div
            key="code-entry"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="w-full flex flex-col items-center space-y-7"
          >
            <div className="text-center space-y-1.5">
              <h2 className="text-2xl sm:text-3xl font-light text-white tracking-tight">
                Receive File or Note
              </h2>
              <p className="text-xs sm:text-sm text-zinc-400 max-w-sm mx-auto leading-relaxed">
                Enter the 4-digit code shared with you to access your transfer.
              </p>
            </div>

            {/* 4 Digit Interactive Boxes */}
            <div className="flex space-x-3 sm:space-x-4">
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
                  className="w-16 h-20 sm:w-20 sm:h-24 text-center text-3xl sm:text-4xl font-light bg-zinc-900/80 border border-zinc-700/60 rounded-2xl text-white focus:border-[#FF3B30] focus:ring-1 focus:ring-[#FF3B30] outline-none transition-all"
                />
              ))}
            </div>

            {/* Decrypting Progress Bar */}
            {downloadProgress !== null && (
              <div className="w-full max-w-md space-y-1.5 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Opening transfer...</span>
                  <span>{downloadProgress}%</span>
                </div>
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-white"
                    initial={{ width: '0%' }}
                    animate={{ width: `${downloadProgress}%` }}
                    transition={{ ease: 'easeOut', duration: 0.2 }}
                  />
                </div>
              </div>
            )}

            {/* ERROR CARD */}
            {apiError && (
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="p-4 rounded-xl border text-xs flex items-start space-x-3 max-w-md w-full bg-red-950/20 border-red-500/30 text-red-300"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" />
                <div className="flex-1 text-left">
                  <div className="flex items-center space-x-2">
                    <span className="font-semibold text-xs text-red-200">
                      {apiError.code === 'LOCKED_OUT' ? 'Too Many Attempts' : 'Transfer Unavailable'}
                    </span>
                    {lockoutSeconds !== null && lockoutSeconds > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-black/40 text-amber-300">
                        Try again in {Math.floor(lockoutSeconds / 60)}m {lockoutSeconds % 60}s
                      </span>
                    )}
                  </div>
                  <p className="mt-1 leading-relaxed text-zinc-300">{apiError.message}</p>
                </div>
              </motion.div>
            )}

            {/* PREVIEW CARD ONCE 4 DIGITS VALIDATED */}
            {inspectedMeta && (
              <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-md p-6 rounded-2xl bg-zinc-900/70 border border-zinc-700/60 flex flex-col space-y-4 shadow-xl text-center items-center"
              >
                <FileIconPreview
                  fileName={inspectedMeta.fileMeta?.name}
                  fileType={inspectedMeta.type === 'text' ? 'text/plain' : inspectedMeta.fileMeta?.type}
                  size="lg"
                />

                <div className="space-y-1 w-full">
                  <h4 className="text-base font-medium text-white truncate max-w-xs mx-auto">
                    {inspectedMeta.type === 'file' ? inspectedName : 'Secure Text Note'}
                  </h4>

                  <p className="text-xs text-zinc-400">
                    {inspectedMeta.type === 'file' ? (
                      inspectedSize ? (
                        <span>{inspectedSize} • {inspectedTypeInfo?.label || 'File'}</span>
                      ) : (
                        <span>{inspectedTypeInfo?.label || 'File'} • Ready for download</span>
                      )
                    ) : (
                      'Encrypted text message'
                    )}
                  </p>
                </div>

                <div className="flex items-center justify-center space-x-2 text-xs text-zinc-400">
                  <span className="px-2.5 py-1 rounded-lg bg-zinc-800/80 border border-zinc-700/50 flex items-center space-x-1.5">
                    <Clock className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Expires in {Math.round((inspectedMeta.remainingSeconds || 600) / 60)} min</span>
                  </span>

                  {inspectedMeta.shareMode === 'multiple_reads' ? (
                    <span className="px-2.5 py-1 rounded-lg bg-zinc-800/80 border border-zinc-700/50 text-zinc-300">
                      {inspectedMeta.maxReads ? `${inspectedMeta.maxReads} downloads limit` : 'Multi-download'}
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300">
                      Single download
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-zinc-400">
                  {inspectedMeta.shareMode === 'multiple_reads' && inspectedMeta.maxReads
                    ? `This file will be deleted automatically once ${inspectedMeta.maxReads} downloads are completed.`
                    : inspectedMeta.shareMode === 'multiple_reads'
                    ? 'This file will remain available until the expiration timer ends.'
                    : 'This file will be deleted from the server once downloaded.'}
                </p>

                {/* PRIMARY ACTION BUTTON */}
                <button
                  id="unlock-payload-btn"
                  onClick={() => handleExplicitPickup(activePinString)}
                  disabled={isLoading}
                  className="w-full py-3.5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-zinc-200 transition-all shadow-md cursor-pointer flex items-center justify-center space-x-2 active:scale-[0.99]"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {inspectedMeta.shareMode === 'multiple_reads'
                      ? 'Download File'
                      : 'Download & Delete'}
                  </span>
                </button>
              </motion.div>
            )}

            {/* Check button fallback */}
            {!isChecking && !inspectedMeta && (
              <div className="flex flex-col items-center space-y-3">
                <button
                  id="fetch-payload-btn"
                  onClick={() => handleInspectPayload(activePinString)}
                  disabled={isChecking || activePinString.length !== 4 || lockoutSeconds !== null}
                  className="px-8 py-3 rounded-xl bg-white text-black text-xs uppercase tracking-wider font-semibold hover:bg-zinc-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shadow-md"
                >
                  {isChecking ? 'Checking code...' : 'Find Transfer'}
                </button>

                <button
                  onClick={onReturnToDrop}
                  className="flex items-center space-x-1.5 text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Send a file instead</span>
                </button>
              </div>
            )}
          </motion.div>
        ) : needsManualKey ? (
          /* STATE C: PROMPT FOR KEY IF ENCRYPTED WITHOUT LINK */
          <motion.div
            key="key-prompt"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md p-6 rounded-2xl bg-zinc-900/80 border border-zinc-700/60 flex flex-col space-y-5 text-center items-center shadow-xl"
          >
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <ShieldCheck className="w-6 h-6 text-emerald-400" />
            </div>

            <div className="space-y-1">
              <h3 className="text-lg font-medium text-white">
                Enter Decryption Key
              </h3>
              <p className="text-xs text-zinc-400 max-w-xs mx-auto leading-relaxed">
                This transfer is end-to-end encrypted. Paste the secret key or link provided by the sender.
              </p>
            </div>

            <input
              type="text"
              id="manual-key-input"
              value={manualKeyInput}
              onChange={(e) => setManualKeyInput(e.target.value)}
              placeholder="Paste encryption key..."
              className="w-full p-3 rounded-xl bg-black/60 border border-zinc-700 text-xs font-mono text-white placeholder-zinc-500 outline-none focus:border-emerald-400 text-center"
            />

            <button
              onClick={handleApplyManualKey}
              disabled={!manualKeyInput.trim()}
              className="w-full py-3 rounded-xl bg-white hover:bg-zinc-200 text-black text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer disabled:opacity-40"
            >
              Decrypt & Open
            </button>
          </motion.div>
        ) : (
          /* STATE D: RETRIEVED CONTENT VIEW */
          <motion.div
            key="retrieved-content"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full flex flex-col items-center space-y-6"
          >
            {/* Status Banner: Auto-updates to 'File has been deleted' if download limit is done */}
            {isFileDeleted || retrievedPayload.isBurned ? (
              <div className="w-full p-4 rounded-2xl bg-red-950/20 border border-red-500/30 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-full bg-red-900/30 flex items-center justify-center text-red-400">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </div>
                  <div className="text-left">
                    <p className="text-xs font-semibold text-red-300">
                      File has been deleted
                    </p>
                    <p className="text-[11px] text-zinc-400">
                      The set limit of downloads has been reached. This file has been permanently deleted from the server.
                    </p>
                  </div>
                </div>
                <span className="text-[10px] uppercase font-mono text-red-300 bg-red-950/40 px-2.5 py-1 rounded-full border border-red-500/40 font-semibold">
                  Deleted
                </span>
              </div>
            ) : retrievedPayload.shareMode === 'multiple_reads' ? (
              <div className="w-full p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-300">
                    <FileCheck className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div className="text-left">
                    <p className="text-xs font-semibold text-white">
                      File Ready for Download
                    </p>
                    <p className="text-[11px] text-zinc-400">
                      Download #{retrievedPayload.readCount || 1}
                      {retrievedPayload.maxReads ? ` of ${retrievedPayload.maxReads}` : ''} • Available until expiry or download limit.
                    </p>
                  </div>
                </div>
                <span className="text-[10px] uppercase font-mono text-zinc-300 bg-zinc-800 px-2.5 py-1 rounded-full border border-zinc-700">
                  Active
                </span>
              </div>
            ) : (
              <div className="w-full p-4 rounded-2xl bg-red-950/20 border border-red-500/30 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-full bg-red-900/30 flex items-center justify-center text-red-400">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </div>
                  <div className="text-left">
                    <p className="text-xs font-semibold text-red-300">
                      File has been deleted
                    </p>
                    <p className="text-[11px] text-zinc-400">
                      This file has been permanently deleted from the server.
                    </p>
                  </div>
                </div>
                <span className="text-[10px] uppercase font-mono text-red-300 bg-red-950/40 px-2.5 py-1 rounded-full border border-red-500/40 font-semibold">
                  Deleted
                </span>
              </div>
            )}

            {/* TEXT PAYLOAD DISPLAY */}
            {retrievedPayload.type === 'text' ? (
              <div className="w-full border border-zinc-800 rounded-2xl bg-zinc-900/60 p-6 flex flex-col space-y-4 shadow-xl">
                <div className="flex justify-between items-center pb-3 border-b border-zinc-800">
                  <span className="text-xs font-medium text-zinc-400">
                    Text Note ({(decryptedText || retrievedPayload.textContent || '').length} characters)
                  </span>
                  <button
                    id="copy-retrieved-text"
                    onClick={handleCopyText}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white transition-all text-xs font-medium cursor-pointer"
                  >
                    {copiedText ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Text</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="p-4 rounded-xl bg-black/60 border border-zinc-800/80 overflow-x-auto max-h-80 select-text">
                  <pre className="font-mono text-sm text-zinc-200 whitespace-pre-wrap break-all leading-relaxed text-left">
                    {decryptedText || retrievedPayload.textContent}
                  </pre>
                </div>

                <div className="pt-2 flex justify-center">
                  <button
                    onClick={onReturnToDrop}
                    className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer flex items-center space-x-1.5"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send another file or note</span>
                  </button>
                </div>
              </div>
            ) : (
              /* FILE PAYLOAD DISPLAY */
              <div className="w-full border border-zinc-800 rounded-2xl bg-zinc-900/60 p-7 flex flex-col items-center text-center space-y-5 shadow-xl">
                <FileIconPreview
                  fileName={resolvedRetrievedName}
                  fileType={resolvedRetrievedFile?.type}
                  dataUrl={resolvedRetrievedFile?.dataUrl}
                  size="lg"
                />

                <div className="space-y-1 w-full max-w-md">
                  <h3 className="text-lg font-medium text-white truncate">
                    {resolvedRetrievedName}
                  </h3>
                  <div className="flex items-center justify-center flex-wrap gap-2 text-xs text-zinc-400">
                    <span className="font-medium text-zinc-300">
                      {formatFriendlyFileSize(resolvedRetrievedSize)}
                    </span>
                    <span>•</span>
                    <span>
                      {resolvedRetrievedTypeInfo.label}
                    </span>
                    {resolvedRetrievedSize > 0 && (
                      <>
                        <span>•</span>
                        <span className="text-zinc-500 font-mono">
                          {resolvedRetrievedSize.toLocaleString()} bytes
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Primary Download Buttons */}
                <div className="flex flex-col sm:flex-row items-center gap-3 w-full max-w-sm pt-2">
                  <button
                    id="download-file-btn"
                    onClick={handleDownloadFile}
                    className="w-full flex-1 py-3 px-5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-zinc-200 transition-all flex items-center justify-center space-x-2 shadow-md cursor-pointer active:scale-[0.99]"
                  >
                    {isDownloaded ? (
                      <>
                        <Check className="w-4 h-4 text-emerald-600" />
                        <span>Saved</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        <span>Download File</span>
                      </>
                    )}
                  </button>

                  {/* Preview button for images & text */}
                  {(resolvedRetrievedTypeInfo.category === 'image' || resolvedRetrievedTypeInfo.category === 'document') && (
                    <button
                      id="preview-file-btn"
                      onClick={handlePreviewFile}
                      title="Open preview in new tab"
                      className="w-full sm:w-auto px-4 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-medium transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
                    >
                      <Eye className="w-4 h-4 text-zinc-400" />
                      <span>Preview</span>
                    </button>
                  )}
                </div>

                {/* Direct Stream Fallback */}
                <div className="flex items-center space-x-4 text-xs text-zinc-500 pt-1">
                  <button
                    id="stream-download-btn"
                    onClick={handleStreamDownload}
                    className="hover:text-zinc-300 transition-colors underline cursor-pointer"
                  >
                    Alternative download link
                  </button>
                  <span>•</span>
                  <button
                    onClick={onReturnToDrop}
                    className="hover:text-zinc-300 transition-colors cursor-pointer flex items-center space-x-1"
                  >
                    <Send className="w-3 h-3" />
                    <span>Send a file</span>
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fallback copy modal if browser denies clipboard access */}
      <ClipboardFallbackModal
        isOpen={fallbackModalText !== null}
        onClose={() => setFallbackModalText(null)}
        textToCopy={fallbackModalText || ''}
        title="Copy Text"
      />
    </div>
  );
};
