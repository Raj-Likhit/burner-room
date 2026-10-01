import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';
import {
  FileText,
  Upload,
  ArrowRight,
  X,
  AlertTriangle,
  RotateCcw,
  Zap,
  Check,
  ShieldCheck,
  Clock,
  Trash2,
  Share2,
  Copy,
  ChevronDown,
  ArrowUp,
  CheckCircle2,
} from 'lucide-react';
import {
  PayloadType,
  ShareMode,
  BurnerFileMetadata,
  EncryptedBundle,
  ApiErrorDetail,
} from '../types';
import {
  generateE2EKey,
  exportKeyToString,
  encryptData,
  wrapKeyWithPin,
  sanitizeFilename,
  getByteLengthFromDataUrl,
  getFileTypeInfo,
  formatFriendlyFileSize,
} from '../lib/crypto';
import { FileIconPreview } from './FileIconPreview';

interface DropZoneProps {
  pin: string;
  senderToken: string;
  isUploaded: boolean;
  isFileDeleted?: boolean;
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
}

const EXPIRY_OPTIONS = [
  { label: '5 min', value: 300 },
  { label: '10 min', value: 600 },
  { label: '15 min', value: 900 },
  { label: '30 min', value: 1800 },
  { label: '1 hour', value: 3600 },
];

const DOWNLOAD_OPTIONS = [
  { label: 'One download', mode: 'burn_on_read' as ShareMode, maxReads: 1 },
  { label: '2 downloads', mode: 'multiple_reads' as ShareMode, maxReads: 2 },
  { label: '5 downloads', mode: 'multiple_reads' as ShareMode, maxReads: 5 },
  { label: '10 downloads', mode: 'multiple_reads' as ShareMode, maxReads: 10 },
  { label: 'Unlimited downloads', mode: 'multiple_reads' as ShareMode, maxReads: undefined },
];

export const DropZone: React.FC<DropZoneProps> = ({
  pin,
  isUploaded,
  isFileDeleted = false,
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
  lastEventMessage,
  onDropPayload,
  onManualBurn,
  onReset,
  isLoading,
}) => {
  const [activeTab, setActiveTab] = useState<'file' | 'note'>('file');
  const [textContent, setTextContent] = useState('');
  const [selectedFile, setSelectedFile] = useState<{ file: File; dataUrl: string } | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [apiError, setApiError] = useState<ApiErrorDetail | null>(null);
  const [isDownloadDropdownOpen, setIsDownloadDropdownOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // Undo window (5s countdown before final publish)
  const [undoCountdown, setUndoCountdown] = useState<number | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ type: 'text' | 'file' } | null>(null);
  const undoTimerRef = useRef<any>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const isWebCryptoAvailable = typeof window !== 'undefined' && !!window.crypto?.subtle;

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDownloadDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
    noClick: activeTab === 'note' || selectedFile !== null,
  } as any);

  const simulateProgress = (): Promise<void> => {
    return new Promise((resolve) => {
      setUploadProgress(20);
      setTimeout(() => {
        setUploadProgress(60);
        setTimeout(() => {
          setUploadProgress(90);
          setTimeout(() => {
            setUploadProgress(100);
            setTimeout(() => {
              setUploadProgress(null);
              resolve();
            }, 100);
          }, 150);
        }, 150);
      }, 150);
    });
  };

  // Trigger 5-second reversible countdown
  const triggerSendCountdown = (type: 'text' | 'file') => {
    setApiError(null);
    if (type === 'text' && !textContent.trim()) {
      setApiError({
        code: 'EMPTY_PAYLOAD',
        message: 'Please write or paste a note before sending.',
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

    setPendingDrop({ type });
    setUndoCountdown(5);

    if (undoTimerRef.current) clearInterval(undoTimerRef.current);

    undoTimerRef.current = setInterval(() => {
      setUndoCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(undoTimerRef.current);
          undoTimerRef.current = null;
          executeDropPayload(type);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleCancelUndo = () => {
    if (undoTimerRef.current) {
      clearInterval(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoCountdown(null);
    setPendingDrop(null);
  };

  const handleSendImmediately = () => {
    if (undoTimerRef.current) {
      clearInterval(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoCountdown(null);
    if (pendingDrop) {
      executeDropPayload(pendingDrop.type);
    }
  };

  // Perform payload creation and encryption
  const executeDropPayload = async (type: 'text' | 'file') => {
    setApiError(null);
    const targetPin = (pin && pin !== '----' && /^[0-9]{4}$/.test(pin) ? pin : undefined) || Math.floor(1000 + Math.random() * 9000).toString();

    try {
      if (type === 'text') {
        await simulateProgress();
        if (isWebCryptoAvailable) {
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

        const typeInfo = getFileTypeInfo(sanitizedName, selectedFile.file.type);

        const fileMeta: BurnerFileMetadata = {
          name: sanitizedName,
          size: effectiveSize,
          type: typeInfo.mimeType,
          dataUrl: selectedFile.dataUrl,
        };

        if (isWebCryptoAvailable) {
          const key = await generateE2EKey();
          const keyStr = await exportKeyToString(key);
          const rawJson = JSON.stringify({
            name: sanitizedName,
            size: effectiveSize,
            type: typeInfo.mimeType,
            dataUrl: selectedFile.dataUrl,
          });

          const encryptedBundle = await encryptData(rawJson, key);
          try {
            const pinKeyBundle = await wrapKeyWithPin(keyStr, targetPin);
            encryptedBundle.pinKeyBundle = pinKeyBundle;
          } catch (wrapErr) {
            console.warn('Could not wrap key with PIN', wrapErr);
          }
          setE2eKeyString(keyStr);

          await onDropPayload(
            'file',
            undefined,
            fileMeta,
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
      setApiError({
        code: 'SEND_FAILED',
        message: err.message || 'Failed to prepare transfer. Please try again.',
        retryable: true,
      });
    } finally {
      setPendingDrop(null);
    }
  };

  const getFullShareUrl = (): string => {
    if (typeof window === 'undefined') return '';
    const base = `${window.location.origin}${window.location.pathname}?pin=${pin}`;
    if (e2eKeyString) {
      return `${base}#key=${encodeURIComponent(e2eKeyString)}`;
    }
    return base;
  };

  const handleCopyFullLink = async () => {
    const url = getFullShareUrl();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      }
    } catch {
      // fallback
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
      } catch {
        handleCopyFullLink();
      }
    } else {
      handleCopyFullLink();
    }
  };

  // Determine current download label
  const currentDownloadOption = DOWNLOAD_OPTIONS.find((opt) => {
    if (opt.mode === 'burn_on_read' && shareMode === 'burn_on_read') return true;
    if (opt.mode === 'multiple_reads' && shareMode === 'multiple_reads' && opt.maxReads === maxReads) return true;
    return false;
  }) || DOWNLOAD_OPTIONS[0];

  return (
    <div className="w-full max-w-2xl flex flex-col space-y-4">
      <AnimatePresence mode="wait">
        {/* STATE 1: FILE HAS BEEN DELETED (Auto-updated when download limit is reached) */}
        {isFileDeleted ? (
          <motion.div
            key="deleted-state"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="w-full relative border border-red-500/30 rounded-3xl p-6 sm:p-10 bg-[#141010] flex flex-col items-center text-center space-y-6 shadow-2xl"
          >
            <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-semibold">
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
              <span>File has been deleted</span>
            </div>

            <div className="space-y-1.5">
              <h3 className="text-xl sm:text-2xl font-light text-white tracking-tight">
                File has been deleted
              </h3>
              <p className="text-xs sm:text-sm text-zinc-400 max-w-md mx-auto leading-relaxed">
                The set limit of downloads has been reached. The file has been automatically and permanently deleted from the server.
              </p>
            </div>

            {/* Deleted Transfer Summary */}
            <div className="w-full max-w-md p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800 flex items-center justify-between text-left opacity-80">
              <div className="flex items-center space-x-3 overflow-hidden">
                <FileIconPreview
                  fileName={uploadedFileName}
                  fileType={uploadedType === 'text' ? 'text/plain' : 'application/octet-stream'}
                  size="md"
                />
                <div className="truncate">
                  <p className="text-sm font-medium text-white truncate line-through decoration-zinc-500">
                    {uploadedType === 'file' ? uploadedFileName : 'Text Note'}
                  </p>
                  <p className="text-xs text-red-400 font-medium">
                    Permanently removed
                  </p>
                </div>
              </div>

              <span className="text-xs px-2.5 py-1 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 font-mono">
                Code {pin}
              </span>
            </div>

            {/* Action to send another */}
            <div className="pt-2">
              <button
                onClick={onReset}
                className="px-6 py-2.5 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200 transition-all cursor-pointer shadow-md flex items-center space-x-2"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Send another file</span>
              </button>
            </div>
          </motion.div>
        ) : isUploaded ? (
          /* STATE 2: READY TO SHARE */
          <motion.div
            key="ready-state"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="w-full relative border border-zinc-800/80 rounded-3xl p-6 sm:p-10 bg-[#111113] flex flex-col items-center text-center space-y-6 shadow-2xl"
          >
            <div className="flex flex-wrap items-center justify-center gap-2">
              <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Ready to Share</span>
              </div>

              {e2eKeyString && (
                <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-zinc-800/80 text-zinc-300 text-xs">
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

            {/* Recipient status update */}
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
                  <span>{EXPIRY_OPTIONS.find((o) => o.value === ttlSeconds)?.label || `${Math.round(ttlSeconds / 60)} min`}</span>
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
          /* STATE 3: UPLOAD FORM */
          <motion.div
            key="upload-form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full flex flex-col space-y-3"
          >
            {/* 1. TOP TABS: File / Note */}
            <div className="flex items-center space-x-1 p-1 rounded-2xl bg-[#141416] border border-zinc-800/80 w-fit">
              <button
                id="tab-mode-file"
                onClick={() => setActiveTab('file')}
                className={`px-4 py-1.5 rounded-xl text-sm font-semibold transition-all cursor-pointer ${
                  activeTab === 'file'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                File
              </button>
              <button
                id="tab-mode-text"
                onClick={() => {
                  setActiveTab('note');
                  setSelectedFile(null);
                }}
                className={`px-4 py-1.5 rounded-xl text-sm font-medium transition-all cursor-pointer ${
                  activeTab === 'note'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Note
              </button>
            </div>

            {/* 2. DROP ZONE CONTAINER */}
            {activeTab === 'note' ? (
              /* NOTE WRITER */
              <div className="relative w-full border border-zinc-800/80 rounded-3xl p-6 sm:p-8 bg-[#111113] flex flex-col space-y-4">
                <div className="flex justify-between items-center text-xs text-zinc-400">
                  <span className="font-medium text-white">Write or Paste Note</span>
                  <span>{textContent.length} characters</span>
                </div>

                <textarea
                  id="text-payload-input"
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  placeholder="Paste confidential notes, credentials, passwords, or messages here..."
                  rows={5}
                  className="w-full bg-transparent text-sm text-zinc-200 placeholder-zinc-500 outline-none resize-none leading-relaxed font-mono"
                />

                <div className="flex justify-end pt-1">
                  <button
                    id="drop-text-payload-btn"
                    onClick={() => triggerSendCountdown('text')}
                    disabled={isLoading || !textContent.trim() || undoCountdown !== null}
                    className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shadow-md"
                  >
                    <span>Send Note</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : selectedFile ? (
              /* SELECTED FILE PREVIEW */
              <div className="relative w-full border border-zinc-800/80 rounded-3xl p-8 bg-[#111113] flex flex-col items-center text-center space-y-4">
                <FileIconPreview
                  fileName={selectedFile.file.name}
                  fileType={selectedFile.file.type}
                  dataUrl={selectedFile.dataUrl}
                  size="lg"
                />

                <div className="space-y-1">
                  <h4 className="text-base font-semibold text-white max-w-sm truncate">
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
                    className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200 transition-all cursor-pointer shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span>{isProcessingFile ? 'Processing...' : 'Send File'}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              /* MAIN DROP ZONE */
              <div
                {...getRootProps()}
                id="file-dropzone-container"
                className={`relative w-full border border-dashed rounded-3xl p-12 sm:p-14 bg-[#111113] flex flex-col items-center justify-center text-center transition-all cursor-pointer ${
                  isDragActive
                    ? 'border-white bg-zinc-900/60 scale-[0.99]'
                    : 'border-zinc-700/60 hover:border-zinc-500'
                }`}
              >
                <input {...getInputProps()} id="file-upload-input" />

                {/* Arrow Up Icon Box */}
                <div className="w-12 h-12 rounded-xl bg-zinc-800/70 border border-zinc-700/50 flex items-center justify-center mb-4 shadow-sm">
                  <ArrowUp className="w-5 h-5 text-white stroke-[2.5]" />
                </div>

                {/* Heading */}
                <h3 className="text-lg sm:text-xl font-semibold text-white tracking-tight">
                  {isDragActive ? 'Release to select this file' : 'Drop a file here or click to browse'}
                </h3>

                {/* Subtitle */}
                <p className="text-sm text-zinc-400 mt-1.5">
                  Up to 50 MB. Encrypted in memory.
                </p>
              </div>
            )}

            {/* 3. OPTIONS CARD (Row 1 Delete after, Row 2 Downloads - overflow-visible so dropdown is NEVER cut off) */}
            <div className="w-full bg-[#111113] border border-zinc-800/80 rounded-2xl divide-y divide-zinc-800/60 relative overflow-visible z-20">
              {/* Row 1: Delete after */}
              <div id="ttl-selector-container" className="flex flex-col sm:flex-row sm:items-center justify-between p-4 sm:px-6 gap-3">
                <span className="text-sm font-medium text-zinc-400">
                  Delete after
                </span>
                <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                  {EXPIRY_OPTIONS.map((opt) => {
                    const isSelected = ttlSeconds === opt.value;
                    return (
                      <button
                        key={opt.value}
                        id={`ttl-preset-${opt.label.replace(' ', '-')}`}
                        onClick={() => setTtlSeconds(opt.value)}
                        className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-white text-black font-semibold shadow-sm'
                            : 'bg-zinc-800/40 hover:bg-zinc-800 text-zinc-300 hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Row 2: Downloads */}
              <div id="share-policy-container" className="flex items-center justify-between p-4 sm:px-6 overflow-visible relative">
                <span className="text-sm font-medium text-zinc-400">
                  Downloads
                </span>

                <div className="relative" ref={dropdownRef}>
                  <button
                    id="downloads-dropdown-btn"
                    onClick={() => setIsDownloadDropdownOpen(!isDownloadDropdownOpen)}
                    className="flex items-center space-x-2 bg-zinc-800/70 hover:bg-zinc-800 border border-zinc-700/50 rounded-xl px-4 py-2 text-sm text-white font-medium transition-colors cursor-pointer"
                  >
                    <span>{currentDownloadOption.label}</span>
                    <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${isDownloadDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>

                  <AnimatePresence>
                    {isDownloadDropdownOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.98 }}
                        transition={{ duration: 0.15 }}
                        className="absolute right-0 bottom-full mb-2 w-56 bg-zinc-900 border border-zinc-700/90 rounded-2xl py-1.5 shadow-2xl z-[100] overflow-hidden"
                      >
                        {DOWNLOAD_OPTIONS.map((opt) => {
                          const isSelected = currentDownloadOption.label === opt.label;
                          return (
                            <button
                              key={opt.label}
                              onClick={() => {
                                setShareMode(opt.mode);
                                setMaxReads(opt.maxReads);
                                setIsDownloadDropdownOpen(false);
                              }}
                              className={`w-full px-4 py-2.5 text-left text-sm flex items-center justify-between transition-colors cursor-pointer ${
                                isSelected
                                  ? 'bg-zinc-800 text-white font-medium'
                                  : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-white'
                              }`}
                            >
                              <span>{opt.label}</span>
                              {isSelected && <Check className="w-4 h-4 text-white" />}
                            </button>
                          );
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>

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
                    <div className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center font-mono font-bold text-sm shadow-md">
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
                    className="h-full bg-white"
                    initial={{ width: '0%' }}
                    animate={{ width: `${uploadProgress}%` }}
                    transition={{ ease: 'easeOut', duration: 0.2 }}
                  />
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
