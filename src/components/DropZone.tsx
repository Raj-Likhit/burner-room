import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';
import {
  FileText,
  Upload,
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
  Hash,
  KeyRound,
  RotateCcw,
  Zap,
  Trash2,
  CheckCircle2,
} from 'lucide-react';
import { BurnerFileMetadata, EncryptedBundle, PayloadType, ShareMode, ApiErrorDetail } from '../types';
import {
  generateE2EKey,
  exportKeyToString,
  encryptData,
  sanitizeFilename,
  wrapKeyWithPin,
  getByteLengthFromDataUrl,
  getFileTypeInfo,
  formatFriendlyFileSize,
} from '../lib/crypto';
import { BurnerApi } from '../lib/api';
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

const EXPIRY_PRESETS = [
  { label: '5m', value: 300 },
  { label: '10m', value: 600 },
  { label: '15m', value: 900 },
  { label: '30m', value: 1800 },
  { label: '1h', value: 3600 },
];

const MAX_DOWNLOAD_PRESETS = [
  { label: 'Unlimited', value: undefined },
  { label: '2 times', value: 2 },
  { label: '5 times', value: 5 },
  { label: '10 times', value: 10 },
];

export const DropZone: React.FC<DropZoneProps> = ({
  pin,
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
}) => {
  const [activeTab, setActiveTab] = useState<'file' | 'text'>('file');
  const [textContent, setTextContent] = useState('');
  const [selectedFile, setSelectedFile] = useState<{ file: File; dataUrl: string } | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [apiError, setApiError] = useState<ApiErrorDetail | null>(null);
  const [showCustomExpiry, setShowCustomExpiry] = useState(false);
  const [e2eEnabled, setE2eEnabled] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);
  const [sharedSuccess, setSharedSuccess] = useState(false);

  // Undo window (5s countdown before final publish)
  const [undoCountdown, setUndoCountdown] = useState<number | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ type: 'text' | 'file' } | null>(null);
  const undoTimerRef = useRef<any>(null);

  // Custom 4-digit code option
  const [useCustomPin, setUseCustomPin] = useState(false);
  const [customPinInput, setCustomPinInput] = useState('');
  const [customPinAvailability, setCustomPinAvailability] = useState<{
    checking: boolean;
    available?: boolean;
    message?: string;
  }>({ checking: false });
  const pinCheckTimeoutRef = useRef<any>(null);

  const isWebCryptoAvailable = typeof window !== 'undefined' && !!window.crypto?.subtle;

  // Debounced check for custom code
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
      } catch {
        setCustomPinAvailability({
          checking: false,
          available: false,
          message: 'Unable to verify code availability.',
        });
      }
    }, 400);

    return () => {
      if (pinCheckTimeoutRef.current) {
        clearTimeout(pinCheckTimeoutRef.current);
      }
    };
  }, [customPinInput, useCustomPin]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearInterval(undoTimerRef.current);
    };
  }, []);

  // Handle file selection
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setApiError(null);
    if (acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    if (file.size === 0) {
      setApiError({
        code: 'EMPTY_FILE',
        message: 'The selected file is empty (0 bytes). Please choose a valid file.',
        retryable: false,
      });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setApiError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'File size exceeds the 50MB limit.',
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
            message: 'Could not read file into memory. Please try again.',
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
          message: 'Failed to read file from disk.',
          retryable: true,
        });
        setIsProcessingFile(false);
      };
      reader.readAsDataURL(file);
    } catch {
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
    noClick: activeTab === 'text' || selectedFile !== null,
  } as any);

  // Smooth progress animation
  const simulateProgress = async () => {
    setUploadProgress(15);
    await new Promise((r) => setTimeout(r, 60));
    setUploadProgress(50);
    await new Promise((r) => setTimeout(r, 80));
    setUploadProgress(90);
    await new Promise((r) => setTimeout(r, 60));
    setUploadProgress(100);
  };

  // 5-second countdown to cancel
  const triggerSendCountdown = (type: 'text' | 'file') => {
    if (type === 'text' && !textContent.trim()) {
      setApiError({
        code: 'EMPTY_TEXT',
        message: 'Please write or paste some text before sending.',
        retryable: false,
      });
      return;
    }
    if (type === 'file' && !selectedFile) {
      setApiError({
        code: 'NO_FILE_SELECTED',
        message: 'Please select a file to send.',
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
          executeSend(type);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleCancelUndo = () => {
    if (undoTimerRef.current) clearInterval(undoTimerRef.current);
    setUndoCountdown(null);
    setPendingDrop(null);
  };

  const handleSendImmediately = () => {
    if (undoTimerRef.current) clearInterval(undoTimerRef.current);
    if (pendingDrop) {
      executeSend(pendingDrop.type);
    }
    setUndoCountdown(null);
    setPendingDrop(null);
  };

  // Upload & encrypt transfer
  const executeSend = async (type: 'text' | 'file') => {
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

        // Resolve clean MIME type
        const typeInfo = getFileTypeInfo(sanitizedName, selectedFile.file.type);

        const fileMeta: BurnerFileMetadata = {
          name: sanitizedName,
          size: effectiveSize,
          type: typeInfo.mimeType,
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

          // Placeholder metadata for server preview without exposing payload contents
          const securePlaceholderMeta: BurnerFileMetadata = {
            name: sanitizedName,
            size: effectiveSize,
            type: typeInfo.mimeType,
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
      setApiError(err);
    } finally {
      setTimeout(() => setUploadProgress(null), 400);
    }
  };

  const formatDurationText = (secs: number) => {
    if (secs >= 3600) {
      const h = Math.floor(secs / 3600);
      const m = Math.round((secs % 3600) / 60);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return `${Math.round(secs / 60)} min`;
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
          title: 'Secure File Transfer',
          text: `Download your file with code ${pin}.`,
          url: url,
        });
        setSharedSuccess(true);
        setTimeout(() => setSharedSuccess(false), 2000);
      } catch {
        handleCopyFullLink();
      }
    } else {
      handleCopyFullLink();
    }
  };

  return (
    <div className="w-full max-w-2xl">
      <AnimatePresence mode="wait">
        {/* STATE: READY TO SHARE */}
        {isUploaded ? (
          <motion.div
            key="ready-state"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="w-full relative border border-zinc-800 rounded-3xl p-6 sm:p-10 bg-zinc-900/60 flex flex-col items-center text-center space-y-6 shadow-2xl backdrop-blur-md"
          >
            {/* Header Status */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Ready to Share</span>
              </div>

              {e2eKeyString && (
                <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-zinc-800 text-zinc-300 text-xs">
                  <ShieldCheck className="w-3.5 h-3.5 text-zinc-400" />
                  <span>End-to-End Encrypted</span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <h3 className="text-xl sm:text-2xl font-light text-white tracking-tight">
                Your transfer is ready
              </h3>
              <p className="text-xs sm:text-sm text-zinc-400 max-w-md mx-auto leading-relaxed">
                Give code <span className="font-mono text-white font-semibold text-base">{pin}</span> or share the link below with your recipient.
              </p>
            </div>

            {/* Live Recipient Event Notification */}
            {lastEventMessage && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-md p-3 rounded-xl bg-zinc-800/80 border border-zinc-700 text-zinc-200 text-xs flex items-center space-x-2.5 font-medium shadow-md"
              >
                <Check className="w-4 h-4 text-emerald-400" />
                <span>{lastEventMessage}</span>
              </motion.div>
            )}

            {/* Transfer Summary Card */}
            <div className="w-full max-w-md p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800 flex items-center justify-between text-left shadow-sm">
              <div className="flex items-center space-x-3 overflow-hidden">
                <FileIconPreview
                  fileName={uploadedFileName}
                  fileType={uploadedType === 'text' ? 'text/plain' : 'application/octet-stream'}
                  size="md"
                />
                <div className="truncate">
                  <p className="text-sm font-medium text-white truncate">
                    {uploadedType === 'file' ? uploadedFileName : 'Text Note'}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {uploadedType === 'file'
                      ? `${formatFriendlyFileSize(uploadedFileSize)} • ${getFileTypeInfo(uploadedFileName).label}`
                      : `${uploadedTextPreview?.length || 0} characters`}
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2 flex-shrink-0">
                <span className="text-xs px-2.5 py-1 rounded-lg bg-zinc-800 text-zinc-400 flex items-center space-x-1">
                  <Clock className="w-3 h-3" />
                  <span>{formatDurationText(ttlSeconds)}</span>
                </span>
              </div>
            </div>

            {/* Link Box */}
            <div className="w-full max-w-md p-3 rounded-xl bg-black/50 border border-zinc-800 flex items-center justify-between space-x-2">
              <div className="truncate text-left pl-2">
                <p className="text-[10px] uppercase font-mono text-zinc-500">Direct Link</p>
                <p className="text-xs font-mono text-zinc-300 truncate">{getFullShareUrl()}</p>
              </div>

              <div className="flex items-center space-x-1.5 flex-shrink-0">
                <button
                  id="share-native-btn"
                  onClick={handleNativeShare}
                  title="Share link"
                  className="flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-white text-black hover:bg-zinc-200 transition-all text-xs font-semibold cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>Share</span>
                </button>

                <button
                  id="copy-link-btn"
                  onClick={handleCopyFullLink}
                  title="Copy link"
                  className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-all cursor-pointer"
                >
                  {copiedLink ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Actions: Send Another & Delete Now */}
            <div className="flex items-center space-x-4 pt-2 text-xs">
              <button
                onClick={onReset}
                className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                Send another file
              </button>
              <span className="text-zinc-600">•</span>
              <button
                id="manual-burn-btn"
                onClick={onManualBurn}
                disabled={isLoading}
                className="text-red-400/80 hover:text-red-300 transition-colors flex items-center space-x-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete file now</span>
              </button>
            </div>
          </motion.div>
        ) : (
          /* STATE: UPLOAD FORM */
          <motion.div
            key="upload-form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full flex flex-col space-y-6"
          >
            {/* Top Toolbar: Switch tabs (File vs Text) + Expiry & Options */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              {/* File / Text Tabs */}
              <div className="flex items-center space-x-1 bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
                <button
                  id="tab-mode-file"
                  onClick={() => {
                    setActiveTab('file');
                  }}
                  className={`text-xs font-medium px-3.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                    activeTab === 'file'
                      ? 'bg-zinc-800 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Send File
                </button>
                <button
                  id="tab-mode-text"
                  onClick={() => {
                    setActiveTab('text');
                    setSelectedFile(null);
                  }}
                  className={`text-xs font-medium px-3.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                    activeTab === 'text'
                      ? 'bg-zinc-800 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Send Note
                </button>
              </div>

              {/* Options: Expiry Presets + Download Limit */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Expiry Selector */}
                <div id="ttl-selector-container" className="flex items-center space-x-1 bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
                  <div className="flex items-center px-1.5 text-zinc-500">
                    <Clock className="w-3 h-3" />
                  </div>
                  {EXPIRY_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      id={`ttl-preset-${preset.label}`}
                      onClick={() => {
                        setTtlSeconds(preset.value);
                        setShowCustomExpiry(false);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                        ttlSeconds === preset.value && !showCustomExpiry
                          ? 'bg-zinc-800 text-white font-semibold shadow-sm'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    id="ttl-custom-toggle"
                    onClick={() => setShowCustomExpiry(!showCustomExpiry)}
                    title="Customize expiry time"
                    className={`p-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                      showCustomExpiry ? 'bg-zinc-800 text-[#FF3B30]' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <SlidersHorizontal className="w-3 h-3" />
                  </button>
                </div>

                {/* Download Limit: Single download vs Multiple */}
                <div id="share-policy-container" className="flex items-center space-x-1 bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
                  <button
                    id="policy-burn-on-read"
                    onClick={() => setShareMode('burn_on_read')}
                    title="File is deleted immediately after the first download"
                    className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      shareMode === 'burn_on_read'
                        ? 'bg-zinc-800 text-white font-semibold shadow-sm'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <Lock className="w-3 h-3 text-red-400" />
                    <span>Single download</span>
                  </button>
                  <button
                    id="policy-multiple-reads"
                    onClick={() => setShareMode('multiple_reads')}
                    title="Allow multiple downloads before expiry"
                    className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      shareMode === 'multiple_reads'
                        ? 'bg-zinc-800 text-white font-semibold shadow-sm'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <Users className="w-3 h-3 text-zinc-400" />
                    <span>Multiple</span>
                  </button>
                </div>

                {/* Custom 4-digit code toggle */}
                <button
                  id="toggle-custom-pin-btn"
                  onClick={() => setUseCustomPin(!useCustomPin)}
                  title="Choose your own 4-digit code"
                  className={`flex items-center space-x-1 px-2.5 py-1.5 rounded-xl text-xs border transition-all cursor-pointer ${
                    useCustomPin
                      ? 'bg-zinc-800 border-zinc-700 text-white font-semibold'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Custom code</span>
                </button>
              </div>
            </div>

            {/* Custom Expiry Slider Drawer */}
            <AnimatePresence>
              {showCustomExpiry && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl flex items-center space-x-4">
                    <span className="text-xs text-zinc-400 flex-shrink-0">
                      Expiration time:
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
                    <span className="text-xs font-semibold text-white w-16 text-right">
                      {formatDurationText(ttlSeconds)}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Custom 4-Digit Code Input Drawer */}
            <AnimatePresence>
              {useCustomPin && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center space-x-2 text-xs text-zinc-300">
                      <KeyRound className="w-4 h-4 text-zinc-400" />
                      <span>Choose your 4-digit code:</span>
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
                        className="w-24 px-3 py-1.5 rounded-lg bg-black/60 border border-zinc-700 text-center font-mono text-base font-semibold text-white tracking-widest focus:border-white outline-none"
                      />

                      {customPinInput.length === 4 && (
                        <div className="text-xs flex items-center space-x-1">
                          {customPinAvailability.checking ? (
                            <span className="text-zinc-500">Checking...</span>
                          ) : customPinAvailability.available ? (
                            <span className="text-emerald-400 flex items-center space-x-1 font-medium">
                              <Check className="w-3.5 h-3.5" />
                              <span>Available</span>
                            </span>
                          ) : (
                            <span className="text-amber-400 flex items-center space-x-1">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>{customPinAvailability.message || 'Taken'}</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Multi-download limit drawer */}
            <AnimatePresence>
              {shareMode === 'multiple_reads' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center space-x-2 text-xs text-zinc-400">
                      <Hash className="w-3.5 h-3.5 text-zinc-500" />
                      <span>Download limit:</span>
                    </div>
                    <div className="flex items-center space-x-1.5">
                      {MAX_DOWNLOAD_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          onClick={() => setMaxReads(p.value)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                            maxReads === p.value
                              ? 'bg-zinc-800 text-white font-semibold'
                              : 'text-zinc-400 hover:text-white'
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

            {/* 5-SECOND REVERSIBLE SENDING BANNER */}
            <AnimatePresence>
              {undoCountdown !== null && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.98, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  className="w-full p-4 rounded-2xl bg-zinc-900 border border-zinc-700 text-white flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xl backdrop-blur-md"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center font-mono font-bold text-sm shadow-md">
                      {undoCountdown}s
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-semibold text-white">
                        Sending in {undoCountdown} seconds...
                      </p>
                      <p className="text-xs text-zinc-400">
                        Transfer will publish automatically. Click Cancel to modify.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <button
                      id="undo-arm-btn"
                      onClick={handleCancelUndo}
                      className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold transition-all cursor-pointer flex items-center space-x-1.5"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Cancel</span>
                    </button>
                    <button
                      id="arm-immediately-btn"
                      onClick={handleSendImmediately}
                      className="px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-black text-xs font-semibold transition-all cursor-pointer flex items-center space-x-1"
                    >
                      <Zap className="w-3.5 h-3.5 text-[#FF3B30]" />
                      <span>Send Now</span>
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ERROR NOTIFICATION */}
            {apiError && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-4 rounded-xl border text-xs flex items-start justify-between gap-3 bg-red-950/20 border-red-500/30 text-red-300"
              >
                <div className="flex items-start space-x-2.5">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" />
                  <div className="text-left">
                    <p className="font-semibold text-xs text-red-200">{apiError.code}</p>
                    <p className="mt-0.5 text-zinc-300">{apiError.message}</p>
                  </div>
                </div>

                <button onClick={() => setApiError(null)} className="p-1 text-zinc-400 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </motion.div>
            )}

            {/* PROGRESS BAR */}
            {uploadProgress !== null && (
              <div className="w-full space-y-1.5 p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>Encrypting & preparing transfer...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-[#FF3B30]"
                    initial={{ width: '0%' }}
                    animate={{ width: `${uploadProgress}%` }}
                    transition={{ ease: 'easeOut', duration: 0.2 }}
                  />
                </div>
              </div>
            )}

            {/* FILE OR TEXT INPUT */}
            {activeTab === 'text' ? (
              /* TEXT NOTE WRITER */
              <div className="relative w-full border border-zinc-800 rounded-3xl bg-zinc-900/60 p-5 sm:p-6 flex flex-col space-y-4 focus-within:border-zinc-700 transition-colors shadow-lg">
                <div className="flex justify-between items-center text-xs text-zinc-400">
                  <span className="font-medium">Write or Paste Note</span>
                  <span>{textContent.length} characters</span>
                </div>

                <textarea
                  id="text-payload-input"
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  placeholder="Paste confidential notes, passwords, or messages here..."
                  rows={6}
                  className="w-full bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none resize-none leading-relaxed font-mono"
                />

                <div className="flex justify-end pt-2">
                  <button
                    id="drop-text-payload-btn"
                    onClick={() => triggerSendCountdown('text')}
                    disabled={isLoading || !textContent.trim() || undoCountdown !== null}
                    className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-white text-black text-xs uppercase tracking-wider font-semibold hover:bg-zinc-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shadow-md"
                  >
                    <span>Send Note</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : selectedFile ? (
              /* SELECTED FILE PREVIEW */
              <div className="relative w-full border border-zinc-800 rounded-3xl bg-zinc-900/60 p-8 flex flex-col items-center text-center space-y-4 shadow-lg">
                <FileIconPreview
                  fileName={selectedFile.file.name}
                  fileType={selectedFile.file.type}
                  dataUrl={selectedFile.dataUrl}
                  size="lg"
                />

                <div className="space-y-1">
                  <h4 className="text-base font-medium text-white max-w-sm truncate">
                    {selectedFile.file.name}
                  </h4>
                  <p className="text-xs text-zinc-400">
                    {formatFriendlyFileSize(selectedFile.file.size)} • {getFileTypeInfo(selectedFile.file.name, selectedFile.file.type).label}
                  </p>
                </div>

                <div className="flex items-center space-x-3 pt-2">
                  <button
                    id="cancel-file-btn"
                    onClick={() => setSelectedFile(null)}
                    disabled={undoCountdown !== null}
                    className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition-all cursor-pointer"
                  >
                    Change File
                  </button>

                  <button
                    id="drop-selected-file-btn"
                    onClick={() => triggerSendCountdown('file')}
                    disabled={isLoading || isProcessingFile || undoCountdown !== null}
                    className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-white text-black text-xs uppercase tracking-wider font-semibold hover:bg-zinc-200 transition-all cursor-pointer shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span>{isProcessingFile ? 'Processing...' : 'Send File'}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              /* DRAG & DROP ZONE */
              <div
                {...getRootProps()}
                id="file-dropzone-container"
                className={`relative w-full border-2 border-dashed rounded-3xl p-10 sm:p-14 flex flex-col items-center text-center justify-center transition-all cursor-pointer group ${
                  isDragActive
                    ? 'border-[#FF3B30] bg-[#FF3B30]/5 scale-[0.99]'
                    : 'border-zinc-800 hover:border-zinc-600 bg-zinc-900/40 hover:bg-zinc-900/60'
                }`}
              >
                <input {...getInputProps()} id="file-upload-input" />

                <div className="w-14 h-14 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center mb-4 group-hover:scale-105 transition-transform shadow-sm">
                  <Upload className="w-6 h-6 text-zinc-300 group-hover:text-white transition-colors" />
                </div>

                <h3 className="text-base sm:text-lg font-normal text-white tracking-tight">
                  {isDragActive ? 'Release to select this file' : 'Drop any file here or click to browse'}
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Files up to 50MB • Encrypted in memory • Automatically deleted after download
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
