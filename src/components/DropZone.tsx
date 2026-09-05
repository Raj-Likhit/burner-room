import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';
import {
  FileText,
  UploadCloud,
  FileCheck,
  Flame,
  ArrowRight,
  X,
  AlertTriangle,
  Users,
  Lock,
  Clock,
  SlidersHorizontal,
  ShieldCheck,
  Share2,
  Check,
  Copy,
  Activity,
  Sparkles,
  Hash,
  KeyRound,
  RotateCcw,
  Zap,
  ShieldAlert,
} from 'lucide-react';
import { BurnerFileMetadata, EncryptedBundle, PayloadType, ShareMode, ApiErrorDetail } from '../types';
import { generateE2EKey, exportKeyToString, encryptData, sanitizeFilename, wrapKeyWithPin, getByteLengthFromDataUrl } from '../lib/crypto';
import { BurnerApi, normalizeApiError, BurnerApiError } from '../lib/api';
import { FileIconPreview } from './FileIconPreview';

interface DropZoneProps {
  pin: string;
  senderToken: string;
  isUploaded: boolean;
  uploadedType: PayloadType | null;
  uploadedFileName?: string;
  uploadedFileSize?: number;
  uploadedTextPreview?: string;
  shareMode: ShareMode;
  setShareMode: (mode: ShareMode) => void;
  maxReads?: number;
  setMaxReads: (max?: number) => void;
  ttlSeconds: number;
  setTtlSeconds: (ttl: number) => void;
  e2eKeyString?: string;
  setE2eKeyString: (keyStr?: string) => void;
  liveReadCount: number;
  lastEventMessage: string | null;
  onDropPayload: (
    type: PayloadType,
    textContent?: string,
    fileMeta?: BurnerFileMetadata,
    modeSetting?: ShareMode,
    ttlSetting?: number,
    encryptedBundle?: EncryptedBundle,
    e2eKeyStr?: string,
    maxReadsSetting?: number,
    customPin?: string
  ) => Promise<void>;
  onManualBurn: () => Promise<void>;
  onReset: () => void;
  isLoading: boolean;
  onRequestCustomPin?: (pin: string) => Promise<void>;
}

const TTL_PRESETS = [
  { label: '5m', value: 300 },
  { label: '10m', value: 600 },
  { label: '15m', value: 900 },
  { label: '30m', value: 1800 },
  { label: '1h', value: 3600 },
];

const MAX_READS_PRESETS = [
  { label: 'Unlimited', value: undefined },
  { label: '2 Reads', value: 2 },
  { label: '5 Reads', value: 5 },
  { label: '10 Reads', value: 10 },
];

export const DropZone: React.FC<DropZoneProps> = ({
  pin,
  senderToken,
  isUploaded,
  uploadedType,
  uploadedFileName,
  uploadedFileSize,
  uploadedTextPreview,
  shareMode,
  setShareMode,
  maxReads,
  setMaxReads,
  ttlSeconds,
  setTtlSeconds,
  e2eKeyString,
  setE2eKeyString,
  liveReadCount,
  lastEventMessage,
  onDropPayload,
  onManualBurn,
  onReset,
  isLoading,
  onRequestCustomPin,
}) => {
  const [activeInputMode, setActiveInputMode] = useState<'both' | 'text' | 'file'>('both');
  const [textContent, setTextContent] = useState('');
  const [selectedFile, setSelectedFile] = useState<{ file: File; dataUrl: string } | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [apiError, setApiError] = useState<ApiErrorDetail | null>(null);
  const [showCustomSlider, setShowCustomSlider] = useState(false);
  const [e2eEnabled, setE2eEnabled] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);
  const [sharedSuccess, setSharedSuccess] = useState(false);

  // Undo Window State (5s countdown before arming)
  const [undoCountdown, setUndoCountdown] = useState<number | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ type: 'text' | 'file' } | null>(null);
  const undoTimerRef = useRef<any>(null);

  // Custom Memorable PIN state
  const [useCustomPin, setUseCustomPin] = useState(false);
  const [customPinInput, setCustomPinInput] = useState('');
  const [customPinAvailability, setCustomPinAvailability] = useState<{
    checking: boolean;
    available?: boolean;
    message?: string;
  }>({ checking: false });
  const pinCheckTimeoutRef = useRef<any>(null);

  // WebCrypto capability check
  const isWebCryptoAvailable = typeof window !== 'undefined' && !!window.crypto?.subtle;

  // Debounced check for custom PIN availability
  useEffect(() => {
    if (!useCustomPin || customPinInput.length !== 4) {
      setCustomPinAvailability({ checking: false });
      return;
    }

    if (pinCheckTimeoutRef.current) {
      clearTimeout(pinCheckTimeoutRef.current);
    }

    setCustomPinAvailability({ checking: true });
    pinCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await BurnerApi.checkPinAvailability(customPinInput);
        setCustomPinAvailability({
          checking: false,
          available: res.available,
          message: res.message,
        });
        if (res.available && onRequestCustomPin) {
          onRequestCustomPin(customPinInput);
        }
      } catch (err: any) {
        setCustomPinAvailability({
          checking: false,
          available: false,
          message: 'Error verifying PIN availability.',
        });
      }
    }, 400);

    return () => {
      if (pinCheckTimeoutRef.current) {
        clearTimeout(pinCheckTimeoutRef.current);
      }
    };
  }, [customPinInput, useCustomPin]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearInterval(undoTimerRef.current);
    };
  }, []);

  // File drop handler
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setApiError(null);
    if (acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    if (file.size === 0) {
      setApiError({
        code: 'EMPTY_FILE',
        message: 'The selected file is empty (0 bytes). Please choose a file with content.',
        retryable: false,
      });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setApiError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'File size exceeds maximum 50MB RAM buffer ceiling.',
        retryable: false,
      });
      return;
    }

    setIsProcessingFile(true);
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        if (!dataUrl || dataUrl === 'data:' || dataUrl.length <= 15) {
          setApiError({
            code: 'FILE_READ_ERROR',
            message: 'File content could not be read into memory (empty data received).',
            retryable: true,
          });
          setIsProcessingFile(false);
          return;
        }
        setSelectedFile({ file, dataUrl });
        setIsProcessingFile(false);
      };
      reader.onerror = () => {
        setApiError({
          code: 'FILE_READ_ERROR',
          message: 'Failed to read file from browser storage.',
          retryable: true,
        });
        setIsProcessingFile(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setApiError({
        code: 'FILE_READ_ERROR',
        message: 'Error reading uploaded file.',
        retryable: true,
      });
      setIsProcessingFile(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDrop as any,
    multiple: false,
    maxSize: 50 * 1024 * 1024,
    noClick: activeInputMode === 'text' || selectedFile !== null,
  } as any);

  // Simulated smooth progress animation
  const simulateProgress = async () => {
    setUploadProgress(15);
    await new Promise((r) => setTimeout(r, 60));
    setUploadProgress(45);
    await new Promise((r) => setTimeout(r, 80));
    setUploadProgress(85);
    await new Promise((r) => setTimeout(r, 70));
    setUploadProgress(100);
  };

  // Trigger 5-second reversible countdown before arming
  const triggerArmCountdown = (type: 'text' | 'file') => {
    if (type === 'text' && !textContent.trim()) {
      setApiError({
        code: 'EMPTY_TEXT',
        message: 'Please enter text content before dropping.',
        retryable: false,
      });
      return;
    }
    if (type === 'file' && !selectedFile) {
      setApiError({
        code: 'NO_FILE_SELECTED',
        message: 'Please choose or drag a file to drop.',
        retryable: false,
      });
      return;
    }

    setApiError(null);
    setPendingDrop({ type });
    setUndoCountdown(5);

    if (undoTimerRef.current) clearInterval(undoTimerRef.current);

    undoTimerRef.current = setInterval(() => {
      setUndoCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(undoTimerRef.current);
          executeFinalArm(type);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Cancel arming and return to editor
  const handleCancelUndo = () => {
    if (undoTimerRef.current) clearInterval(undoTimerRef.current);
    setUndoCountdown(null);
    setPendingDrop(null);
  };

  // Immediate arm without waiting
  const handleImmediateArm = () => {
    if (undoTimerRef.current) clearInterval(undoTimerRef.current);
    if (pendingDrop) {
      executeFinalArm(pendingDrop.type);
    }
    setUndoCountdown(null);
    setPendingDrop(null);
  };

  // Execute payload upload & encryption
  const executeFinalArm = async (type: 'text' | 'file') => {
    setUploadProgress(10);
    setApiError(null);

    const activeCustomPin = useCustomPin && customPinAvailability.available ? customPinInput : undefined;
    const targetPin = (activeCustomPin || (pin && pin !== '----' && /^[0-9]{4}$/.test(pin) ? pin : undefined)) || Math.floor(1000 + Math.random() * 9000).toString();

    try {
      if (type === 'text') {
        await simulateProgress();
        if (e2eEnabled && isWebCryptoAvailable) {
          const key = await generateE2EKey();
          const keyStr = await exportKeyToString(key);
          const encryptedBundle = await encryptData(textContent.trim(), key);
          try {
            const pinKeyBundle = await wrapKeyWithPin(keyStr, targetPin);
            encryptedBundle.pinKeyBundle = pinKeyBundle;
          } catch (wrapErr) {
            console.warn('Could not wrap key with PIN', wrapErr);
          }
          setE2eKeyString(keyStr);
          await onDropPayload(
            'text',
            undefined,
            undefined,
            shareMode,
            ttlSeconds,
            encryptedBundle,
            keyStr,
            maxReads,
            targetPin
          );
        } else {
          setE2eKeyString(undefined);
          await onDropPayload(
            'text',
            textContent.trim(),
            undefined,
            shareMode,
            ttlSeconds,
            undefined,
            undefined,
            maxReads,
            targetPin
          );
        }
      } else if (type === 'file' && selectedFile) {
        await simulateProgress();
        const sanitizedName = sanitizeFilename(selectedFile.file.name);
        const effectiveSize = (selectedFile.file.size && selectedFile.file.size > 0)
          ? selectedFile.file.size
          : getByteLengthFromDataUrl(selectedFile.dataUrl);

        const fileMeta: BurnerFileMetadata = {
          name: sanitizedName,
          size: effectiveSize,
          type: selectedFile.file.type || 'application/octet-stream',
          dataUrl: selectedFile.dataUrl,
        };

        if (e2eEnabled && isWebCryptoAvailable) {
          const key = await generateE2EKey();
          const keyStr = await exportKeyToString(key);
          const payloadString = JSON.stringify(fileMeta);
          const encryptedBundle = await encryptData(payloadString, key);
          try {
            const pinKeyBundle = await wrapKeyWithPin(keyStr, targetPin);
            encryptedBundle.pinKeyBundle = pinKeyBundle;
          } catch (wrapErr) {
            console.warn('Could not wrap key with PIN', wrapErr);
          }
          setE2eKeyString(keyStr);

          const securePlaceholderMeta: BurnerFileMetadata = {
            name: sanitizedName,
            size: effectiveSize,
            type: selectedFile.file.type || 'application/octet-stream',
          };

          await onDropPayload(
            'file',
            undefined,
            securePlaceholderMeta,
            shareMode,
            ttlSeconds,
            encryptedBundle,
            keyStr,
            maxReads,
            targetPin
          );
        } else {
          setE2eKeyString(undefined);
          await onDropPayload(
            'file',
            undefined,
            fileMeta,
            shareMode,
            ttlSeconds,
            undefined,
            undefined,
            maxReads,
            targetPin
          );
        }
      }
    } catch (err: any) {
      const normalized = normalizeApiError(err);
      setApiError(normalized);
    } finally {
      setUploadProgress(null);
      setPendingDrop(null);
      setUndoCountdown(null);
    }
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const formatDurationText = (seconds: number) => {
    if (seconds >= 3600) {
      const hours = Math.floor(seconds / 3600);
      const rem = Math.round((seconds % 3600) / 60);
      return rem > 0 ? `${hours}h ${rem}m` : `${hours} hour`;
    }
    return `${Math.round(seconds / 60)} mins`;
  };

  const getFullShareUrl = () => {
    let url = `${window.location.origin}/?pin=${pin}`;
    if (e2eKeyString) {
      url += `#key=${e2eKeyString}`;
    }
    return url;
  };

  const handleCopyFullLink = async () => {
    try {
      await navigator.clipboard.writeText(getFullShareUrl());
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) {
      console.error('Copy failed', err);
    }
  };

  const handleNativeShare = async () => {
    const url = getFullShareUrl();
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Burner Room Ephemeral Drop',
          text: `Pickup your secure payload (PIN: ${pin}). It will self-destruct after pickup.`,
          url: url,
        });
        setSharedSuccess(true);
        setTimeout(() => setSharedSuccess(false), 2000);
      } catch (err) {
        handleCopyFullLink();
      }
    } else {
      handleCopyFullLink();
    }
  };

  return (
    <div className="w-full max-w-3xl">
      <AnimatePresence mode="wait">
        {/* STATE 1: ALREADY UPLOADED -> "ARMED & READY FOR PICKUP" */}
        {isUploaded ? (
          <motion.div
            key="ready-state"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="w-full relative border border-white/20 rounded-3xl p-8 sm:p-12 bg-white/[0.02] flex flex-col items-center text-center space-y-6 shadow-2xl backdrop-blur-md overflow-hidden"
          >
            {/* Top Laser Accent */}
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#FF3B30] to-transparent animate-laser" />

            {/* Live Uplink Status & SSE Event Listener Status */}
            <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-4">
              <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/10">
                <div className="w-2 h-2 rounded-full bg-[#FF3B30] shadow-[0_0_8px_#FF3B30] animate-pulse" />
                <span className="text-[10px] uppercase tracking-[0.25em] text-white/70 font-mono">
                  Live In-RAM Uplink Active
                </span>
              </div>

              {e2eKeyString && (
                <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] uppercase tracking-[0.2em] font-mono">
                  <ShieldCheck className="w-3 h-3 text-emerald-400" />
                  <span>Zero-Knowledge AES-GCM</span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-xl sm:text-2xl font-light tracking-wide text-white">
                Payload Armed & Ready for Pickup
              </h3>
              <p className="text-xs sm:text-sm font-light text-white/60 max-w-md mx-auto leading-relaxed">
                Share PIN <span className="font-mono text-[#FF3B30] font-semibold">{pin}</span> or send the 1-click link with your recipient.
                {shareMode === 'multiple_reads'
                  ? ` Multi-device pickup active (${liveReadCount} / ${maxReads || '∞'} retrieved).`
                  : ` Incinerates permanently immediately upon first human retrieval.`}
              </p>
            </div>

            {/* Real-time SSE Live Event Toast Banner if triggered */}
            {lastEventMessage && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-md p-3 rounded-xl bg-[#FF3B30]/15 border border-[#FF3B30]/40 text-[#FF3B30] text-xs flex items-center space-x-2.5 font-mono shadow-lg"
              >
                <Activity className="w-4 h-4 animate-spin text-[#FF3B30]" />
                <span>{lastEventMessage}</span>
              </motion.div>
            )}

            {/* Payload Brief info card with rich thumbnail */}
            <div className="w-full max-w-md p-4 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-between text-left shadow-sm">
              <div className="flex items-center space-x-3 overflow-hidden">
                <FileIconPreview
                  fileName={uploadedFileName}
                  fileType={uploadedType === 'text' ? 'text/plain' : 'application/octet-stream'}
                  size="md"
                />
                <div className="truncate">
                  <p className="text-xs font-mono text-white truncate font-medium">
                    {uploadedType === 'file' ? uploadedFileName : 'Encrypted Text Snippet'}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-white/40">
                    {uploadedType === 'file'
                      ? formatFileSize(uploadedFileSize)
                      : `${uploadedTextPreview?.length || 0} characters`}
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2 flex-shrink-0">
                <span className="text-[9px] uppercase tracking-widest px-2 py-0.5 rounded bg-white/5 text-white/60 font-mono border border-white/10 flex items-center space-x-1">
                  <Clock className="w-2.5 h-2.5" />
                  <span>{formatDurationText(ttlSeconds)}</span>
                </span>

                {shareMode === 'multiple_reads' ? (
                  <span className="text-[9px] uppercase tracking-widest px-2.5 py-1 rounded bg-white/10 text-white font-mono border border-white/20 flex items-center space-x-1">
                    <Users className="w-3 h-3 text-[#FF3B30]" />
                    <span>{liveReadCount > 0 ? `${liveReadCount} reads` : 'Multi'}</span>
                  </span>
                ) : (
                  <span className="text-[9px] uppercase tracking-widest px-2 py-0.5 rounded bg-[#FF3B30]/20 text-[#FF3B30] font-mono border border-[#FF3B30]/30">
                    1-Time
                  </span>
                )}
              </div>
            </div>

            {/* Quick Share Link Box */}
            <div className="w-full max-w-md p-3 rounded-2xl bg-black/40 border border-white/10 flex items-center justify-between space-x-2">
              <div className="truncate text-left pl-2">
                <p className="text-[9px] uppercase tracking-widest text-white/40 font-mono">1-Click Direct Link</p>
                <p className="text-[11px] font-mono text-white/80 truncate">{getFullShareUrl()}</p>
              </div>

              <div className="flex items-center space-x-1.5 flex-shrink-0">
                <button
                  id="share-native-btn"
                  onClick={handleNativeShare}
                  title="Share link via native device picker"
                  className="flex items-center space-x-1 px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white text-white hover:text-black transition-all text-[10px] uppercase tracking-wider font-semibold cursor-pointer"
                >
                  <Share2 className="w-3 h-3" />
                  <span className="hidden sm:inline">Share</span>
                </button>

                <button
                  id="copy-link-btn"
                  onClick={handleCopyFullLink}
                  title="Copy direct pickup link"
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/15 text-white/70 hover:text-white transition-all cursor-pointer"
                >
                  {copiedLink ? <Check className="w-3.5 h-3.5 text-[#FF3B30]" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* URL Fragment Key Residual Risk Copy */}
            {e2eKeyString && (
              <div className="w-full max-w-md p-3 px-4 rounded-xl bg-white/[0.02] border border-white/10 text-[11px] text-white/40 text-center leading-relaxed">
                <span className="text-white/60 font-medium">Privacy Note:</span> Hash fragment keys (<code className="text-[#FF3B30] font-mono">#key=...</code>) are processed entirely in the browser and never sent to server logs, but remain in local browser history & clipboard.
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                id="manual-burn-btn"
                onClick={onManualBurn}
                disabled={isLoading}
                className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-[#FF3B30]/10 hover:bg-[#FF3B30]/20 text-[#FF3B30] text-[11px] uppercase tracking-[0.2em] font-medium border border-[#FF3B30]/30 transition-all cursor-pointer active:scale-95"
              >
                <Flame className="w-3.5 h-3.5" />
                <span>Burn Now (Owner)</span>
              </button>

              <button
                id="drop-another-btn"
                onClick={onReset}
                className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-white text-[11px] uppercase tracking-[0.2em] font-medium border border-white/10 transition-all cursor-pointer"
              >
                <span>New Session</span>
              </button>
            </div>
          </motion.div>
        ) : (
          /* STATE 2: UPLOAD DROPZONE / TEXT EDITOR */
          <motion.div
            key="input-state"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="w-full flex flex-col space-y-4"
          >
            {/* Top configuration bar: Mode tabs, TTL selector, Share policy, and E2E toggle */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 px-1">
              <div className="flex items-center space-x-2">
                <button
                  id="tab-mode-both"
                  onClick={() => {
                    setActiveInputMode('both');
                    setSelectedFile(null);
                  }}
                  className={`text-[10px] uppercase tracking-[0.2em] px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                    activeInputMode === 'both' && !selectedFile
                      ? 'bg-white/10 text-white font-medium shadow-sm'
                      : 'text-white/40 hover:text-white'
                  }`}
                >
                  Universal Drop
                </button>
                <button
                  id="tab-mode-text"
                  onClick={() => {
                    setActiveInputMode('text');
                    setSelectedFile(null);
                  }}
                  className={`text-[10px] uppercase tracking-[0.2em] px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                    activeInputMode === 'text'
                      ? 'bg-white/10 text-white font-medium shadow-sm'
                      : 'text-white/40 hover:text-white'
                  }`}
                >
                  Paste Text
                </button>
              </div>

              {/* Right controls: TTL Duration Selector, Share Policy, E2E toggle */}
              <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                {/* Custom Memorable PIN Toggle */}
                <button
                  id="toggle-custom-pin-btn"
                  onClick={() => setUseCustomPin(!useCustomPin)}
                  title="Choose your own memorable 4-digit PIN"
                  className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg text-[9px] uppercase tracking-[0.18em] font-mono border transition-all cursor-pointer ${
                    useCustomPin
                      ? 'bg-white/15 border-white/30 text-white font-semibold'
                      : 'bg-white/[0.03] border-white/10 text-white/30 hover:text-white/60'
                  }`}
                >
                  <KeyRound className="w-3 h-3" />
                  <span>Custom PIN</span>
                </button>

                {/* Zero-Knowledge E2E Toggle */}
                <button
                  id="toggle-e2e-btn"
                  onClick={() => setE2eEnabled(!e2eEnabled)}
                  title="Client-Side AES-GCM End-to-End Encryption (Keys never touch server)"
                  className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg text-[9px] uppercase tracking-[0.18em] font-mono border transition-all cursor-pointer ${
                    e2eEnabled
                      ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400 font-semibold'
                      : 'bg-white/[0.03] border-white/10 text-white/30 hover:text-white/60'
                  }`}
                >
                  <ShieldCheck className="w-3 h-3 text-emerald-400" />
                  <span>E2E {e2eEnabled ? 'ON' : 'OFF'}</span>
                </button>

                {/* TTL Duration Selector */}
                <div id="ttl-selector-container" className="flex items-center space-x-1 bg-white/[0.03] border border-white/10 p-1 rounded-lg">
                  <div className="flex items-center px-1 text-white/30">
                    <Clock className="w-2.5 h-2.5" />
                  </div>
                  {TTL_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      id={`ttl-preset-${preset.label}`}
                      onClick={() => {
                        setTtlSeconds(preset.value);
                        setShowCustomSlider(false);
                      }}
                      className={`px-2 py-0.5 rounded text-[9px] uppercase tracking-wider font-mono transition-all cursor-pointer ${
                        ttlSeconds === preset.value && !showCustomSlider
                          ? 'bg-white/20 text-white font-semibold shadow-sm'
                          : 'text-white/40 hover:text-white/80'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    id="ttl-custom-toggle"
                    onClick={() => setShowCustomSlider(!showCustomSlider)}
                    title="Customize TTL (1m to 60m)"
                    className={`p-1 rounded text-[9px] transition-all cursor-pointer ${
                      showCustomSlider || !TTL_PRESETS.some((p) => p.value === ttlSeconds)
                        ? 'bg-white/20 text-[#FF3B30]'
                        : 'text-white/30 hover:text-white/80'
                    }`}
                  >
                    <SlidersHorizontal className="w-2.5 h-2.5" />
                  </button>
                </div>

                {/* Share Policy: 1-Time Burn vs Multiple-Time Sharing */}
                <div id="share-policy-container" className="flex items-center space-x-1 bg-white/[0.03] border border-white/10 p-1 rounded-lg">
                  <button
                    id="policy-burn-on-read"
                    onClick={() => setShareMode('burn_on_read')}
                    title="Self-destructs the moment the recipient opens or downloads it"
                    className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-[9px] uppercase tracking-[0.2em] font-medium transition-all cursor-pointer ${
                      shareMode === 'burn_on_read'
                        ? 'bg-[#FF3B30]/20 text-[#FF3B30] border border-[#FF3B30]/30 font-semibold'
                        : 'text-white/40 hover:text-white'
                    }`}
                  >
                    <Lock className="w-2.5 h-2.5" />
                    <span>1-Time</span>
                  </button>
                  <button
                    id="policy-multiple-reads"
                    onClick={() => setShareMode('multiple_reads')}
                    title="Allows multiple downloads/reads across devices until TTL expires or max count reached"
                    className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-[9px] uppercase tracking-[0.2em] font-medium transition-all cursor-pointer ${
                      shareMode === 'multiple_reads'
                        ? 'bg-white/15 text-white border border-white/20 font-semibold'
                        : 'text-white/40 hover:text-white'
                    }`}
                  >
                    <Users className="w-2.5 h-2.5 text-[#FF3B30]" />
                    <span>Multi</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Custom Memorable PIN Drawer */}
            <AnimatePresence>
              {useCustomPin && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 bg-white/[0.03] border border-white/15 rounded-2xl flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center space-x-2">
                      <KeyRound className="w-4 h-4 text-[#FF3B30]" />
                      <span className="text-xs font-mono text-white/80">Choose Memorable 4-Digit PIN:</span>
                    </div>

                    <div className="flex items-center space-x-3">
                      <input
                        type="text"
                        id="custom-pin-field"
                        maxLength={4}
                        placeholder="e.g. 7788"
                        value={customPinInput}
                        onChange={(e) => {
                          const val = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
                          setCustomPinInput(val);
                        }}
                        className="w-24 px-3 py-1.5 rounded-xl bg-black/60 border border-white/20 text-center font-mono text-base font-semibold text-white tracking-widest focus:border-[#FF3B30] outline-none"
                      />

                      {customPinInput.length === 4 && (
                        <div className="text-[11px] font-mono flex items-center space-x-1">
                          {customPinAvailability.checking ? (
                            <span className="text-white/40">Checking availability...</span>
                          ) : customPinAvailability.available ? (
                            <span className="text-emerald-400 flex items-center space-x-1">
                              <Check className="w-3.5 h-3.5" />
                              <span>Available</span>
                            </span>
                          ) : (
                            <span className="text-amber-400 flex items-center space-x-1">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>{customPinAvailability.message || 'Unavailable'}</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Warning if user explicitly opts out of E2E */}
            {!e2eEnabled && (
              <div className="w-full p-2.5 px-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] flex items-center justify-between font-mono">
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 text-amber-400" />
                  <span>Unencrypted Mode: Content will be kept in ephemeral server RAM without client encryption.</span>
                </div>
                <button
                  onClick={() => setE2eEnabled(true)}
                  className="px-2 py-0.5 rounded bg-amber-400 text-black text-[9px] uppercase tracking-wider font-semibold cursor-pointer"
                >
                  Enable E2E
                </button>
              </div>
            )}

            {/* Custom TTL Slider Drawer */}
            <AnimatePresence>
              {showCustomSlider && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 bg-white/[0.03] border border-white/10 rounded-xl flex items-center space-x-4">
                    <span className="text-[10px] uppercase tracking-widest text-white/50 font-mono flex-shrink-0">
                      Custom TTL:
                    </span>
                    <input
                      type="range"
                      min={60}
                      max={3600}
                      step={60}
                      value={ttlSeconds}
                      onChange={(e) => setTtlSeconds(Number(e.target.value))}
                      className="w-full accent-[#FF3B30] cursor-pointer"
                    />
                    <span className="text-xs font-mono text-[#FF3B30] font-semibold w-16 text-right">
                      {formatDurationText(ttlSeconds)}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Multi-Share Max-Reads Preset Selector */}
            <AnimatePresence>
              {shareMode === 'multiple_reads' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 bg-white/[0.02] border border-white/10 rounded-xl flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center space-x-2 text-[10px] uppercase tracking-widest text-white/50 font-mono">
                      <Hash className="w-3 h-3 text-[#FF3B30]" />
                      <span>Max Download Cap:</span>
                    </div>
                    <div className="flex items-center space-x-1.5">
                      {MAX_READS_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          onClick={() => setMaxReads(p.value)}
                          className={`px-2.5 py-1 rounded text-[9px] uppercase tracking-wider font-mono transition-all cursor-pointer ${
                            maxReads === p.value
                              ? 'bg-[#FF3B30]/20 text-[#FF3B30] border border-[#FF3B30]/30 font-semibold'
                              : 'bg-white/5 text-white/40 hover:text-white border border-transparent'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 5-SECOND REVERSIBLE UNDO BANNER */}
            <AnimatePresence>
              {undoCountdown !== null && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.98, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  className="w-full p-4 rounded-2xl bg-[#FF3B30]/15 border border-[#FF3B30]/40 text-white flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xl backdrop-blur-md"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-9 h-9 rounded-full bg-[#FF3B30] text-white flex items-center justify-center font-mono font-bold text-sm shadow-md animate-pulse">
                      {undoCountdown}s
                    </div>
                    <div className="text-left">
                      <p className="text-xs font-semibold uppercase tracking-wider text-white">
                        Arming Payload into RAM in {undoCountdown} seconds...
                      </p>
                      <p className="text-[11px] text-white/60">
                        Drop will publish automatically. Click Undo to modify or cancel.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <button
                      id="undo-arm-btn"
                      onClick={handleCancelUndo}
                      className="px-4 py-2 rounded-xl bg-white text-black text-xs uppercase tracking-wider font-semibold hover:bg-white/90 transition-all cursor-pointer flex items-center space-x-1.5 shadow-md"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Undo & Edit</span>
                    </button>
                    <button
                      id="arm-immediately-btn"
                      onClick={handleImmediateArm}
                      className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs uppercase tracking-wider font-semibold transition-all cursor-pointer flex items-center space-x-1"
                    >
                      <Zap className="w-3.5 h-3.5 text-[#FF3B30]" />
                      <span>Arm Now</span>
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* STANDARDIZED RICH ERROR NOTIFICATION */}
            {apiError && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-4 rounded-2xl border text-xs flex items-start justify-between gap-3 ${
                  apiError.code === 'BUFFER_FULL' || apiError.code === 'QUOTA_EXCEEDED'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                    : 'bg-[#FF3B30]/10 border-[#FF3B30]/30 text-[#FF3B30]'
                }`}
              >
                <div className="flex items-start space-x-3">
                  <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
                  <div className="text-left">
                    <div className="flex items-center space-x-2">
                      <span className="font-semibold uppercase tracking-wider text-[10px] font-mono">
                        {apiError.code}
                      </span>
                      {apiError.retryAfter && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-black/40 text-amber-300">
                          Retry in {apiError.retryAfter}s
                        </span>
                      )}
                    </div>
                    <p className="mt-1 leading-relaxed text-white/90">{apiError.message}</p>
                  </div>
                </div>

                <div className="flex items-center space-x-1 flex-shrink-0">
                  {apiError.retryable && (
                    <button
                      onClick={() => {
                        setApiError(null);
                        if (pendingDrop) triggerArmCountdown(pendingDrop.type);
                        else if (selectedFile) triggerArmCountdown('file');
                        else if (textContent) triggerArmCountdown('text');
                      }}
                      className="px-2.5 py-1 rounded bg-white/20 hover:bg-white/30 text-white text-[10px] uppercase tracking-wider font-semibold cursor-pointer"
                    >
                      Retry
                    </button>
                  )}
                  <button onClick={() => setApiError(null)} className="p-1 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </motion.div>
            )}

            {/* PROGRESS BAR ANIMATION */}
            {uploadProgress !== null && (
              <div className="w-full space-y-1.5 p-3 rounded-xl bg-white/[0.03] border border-white/10">
                <div className="flex justify-between text-[10px] uppercase tracking-widest font-mono text-white/60">
                  <span>{e2eEnabled ? 'Encrypting & Arming...' : 'Arming Payload...'}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-[#FF3B30]"
                    initial={{ width: '0%' }}
                    animate={{ width: `${uploadProgress}%` }}
                    transition={{ ease: 'easeOut', duration: 0.2 }}
                  />
                </div>
              </div>
            )}

            {/* FILE OR TEXT INPUT CONTAINER */}
            {activeInputMode === 'text' ? (
              /* TEXT EDITOR */
              <div className="relative w-full border border-white/20 rounded-3xl bg-white/[0.02] p-5 sm:p-6 flex flex-col space-y-4 focus-within:border-[#FF3B30] transition-colors">
                <div className="flex justify-between items-center text-[10px] uppercase tracking-widest text-white/40 font-mono">
                  <span>Paste Secret Notes or Credentials</span>
                  <span>{textContent.length} chars</span>
                </div>

                <textarea
                  id="text-payload-input"
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  placeholder="Paste confidential credentials, keys, or message here..."
                  rows={6}
                  className="w-full bg-transparent text-sm font-mono text-white placeholder-white/20 outline-none resize-none leading-relaxed"
                />

                <div className="flex justify-end pt-2">
                  <button
                    id="drop-text-payload-btn"
                    onClick={() => triggerArmCountdown('text')}
                    disabled={isLoading || !textContent.trim() || undoCountdown !== null}
                    className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-white text-black text-xs uppercase tracking-[0.25em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shadow-lg"
                  >
                    <span>Arm Payload</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : selectedFile ? (
              /* SELECTED FILE PREVIEW WITH THUMBNAILS */
              <div className="relative w-full border border-white/20 rounded-3xl bg-white/[0.02] p-8 flex flex-col items-center text-center space-y-5">
                <FileIconPreview
                  fileName={selectedFile.file.name}
                  fileType={selectedFile.file.type}
                  dataUrl={selectedFile.dataUrl}
                  size="lg"
                />

                <div className="space-y-1">
                  <h4 className="text-base font-mono text-white max-w-sm truncate font-medium">
                    {selectedFile.file.name}
                  </h4>
                  <p className="text-xs font-mono text-white/40">
                    {formatFileSize(selectedFile.file.size)} • {selectedFile.file.type || 'Binary'}
                  </p>
                </div>

                <div className="flex items-center space-x-3">
                  <button
                    id="cancel-file-btn"
                    onClick={() => setSelectedFile(null)}
                    disabled={undoCountdown !== null}
                    className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white/60 hover:text-white text-[11px] uppercase tracking-wider transition-all cursor-pointer"
                  >
                    Remove
                  </button>

                  <button
                    id="drop-selected-file-btn"
                    onClick={() => triggerArmCountdown('file')}
                    disabled={isLoading || isProcessingFile || undoCountdown !== null}
                    className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-white text-black text-xs uppercase tracking-[0.25em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all cursor-pointer shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span>{isProcessingFile ? 'Reading File...' : 'Arm File'}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              /* DRAG & DROP UNIVERSAL ZONE */
              <div
                {...getRootProps()}
                id="file-dropzone-container"
                className={`relative w-full border-2 border-dashed rounded-3xl p-10 sm:p-14 flex flex-col items-center text-center justify-center transition-all cursor-pointer group ${
                  isDragActive
                    ? 'border-[#FF3B30] bg-[#FF3B30]/5 scale-[0.99]'
                    : 'border-white/15 hover:border-white/40 bg-white/[0.01] hover:bg-white/[0.02]'
                }`}
              >
                <input {...getInputProps()} id="file-upload-input" />

                <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center mb-4 group-hover:scale-105 transition-transform">
                  <UploadCloud className="w-7 h-7 text-white/60 group-hover:text-[#FF3B30] transition-colors" />
                </div>

                <h3 className="text-base sm:text-lg font-light text-white tracking-wide">
                  {isDragActive ? 'Release to upload' : 'Drag & drop any file or click to browse'}
                </h3>
                <p className="text-xs text-white/40 mt-1 font-mono">
                  Up to 50MB per drop • Kept strictly in RAM • Zero disk persistence
                </p>

                <div className="mt-6 flex items-center space-x-2 text-[10px] uppercase tracking-[0.2em] text-white/40 font-mono">
                  <span>Or switch tab to paste text</span>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
