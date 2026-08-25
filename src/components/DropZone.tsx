import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';
import { FileText, UploadCloud, FileCheck, Flame, ArrowRight, X, AlertTriangle, Users, Lock, Clock, SlidersHorizontal } from 'lucide-react';
import { BurnerFileMetadata, PayloadType, ShareMode } from '../types';

interface DropZoneProps {
  pin: string;
  isUploaded: boolean;
  uploadedType: PayloadType | null;
  uploadedFileName?: string;
  uploadedFileSize?: number;
  uploadedTextPreview?: string;
  shareMode: ShareMode;
  setShareMode: (mode: ShareMode) => void;
  ttlSeconds: number;
  setTtlSeconds: (ttl: number) => void;
  onDropPayload: (
    type: PayloadType,
    textContent?: string,
    fileMeta?: BurnerFileMetadata,
    modeSetting?: ShareMode,
    ttlSetting?: number
  ) => Promise<void>;
  onManualBurn: () => Promise<void>;
  onReset: () => void;
  isLoading: boolean;
}

const TTL_PRESETS = [
  { label: '5m', value: 300 },
  { label: '10m', value: 600 },
  { label: '15m', value: 900 },
  { label: '30m', value: 1800 },
  { label: '1h', value: 3600 },
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
  ttlSeconds,
  setTtlSeconds,
  onDropPayload,
  onManualBurn,
  onReset,
  isLoading,
}) => {
  const [activeInputMode, setActiveInputMode] = useState<'both' | 'text' | 'file'>('both');
  const [textContent, setTextContent] = useState('');
  const [selectedFile, setSelectedFile] = useState<{ file: File; dataUrl: string } | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showCustomSlider, setShowCustomSlider] = useState(false);

  // File drop handler with base64 data conversion
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setErrorMessage(null);
    if (acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    if (file.size > 50 * 1024 * 1024) {
      setErrorMessage('File exceeds 50MB limit.');
      return;
    }

    setIsProcessingFile(true);
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setSelectedFile({ file, dataUrl });
        setIsProcessingFile(false);
      };
      reader.onerror = () => {
        setErrorMessage('Failed to read file.');
        setIsProcessingFile(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setErrorMessage('Error reading uploaded file.');
      setIsProcessingFile(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDrop as any,
    multiple: false,
    maxSize: 50 * 1024 * 1024,
    noClick: activeInputMode === 'text' || selectedFile !== null,
  } as any);

  const handleUploadText = async () => {
    if (!textContent.trim()) {
      setErrorMessage('Please enter text content before dropping.');
      return;
    }
    setErrorMessage(null);
    await onDropPayload('text', textContent.trim(), undefined, shareMode, ttlSeconds);
  };

  const handleUploadFile = async () => {
    if (!selectedFile) return;
    setErrorMessage(null);
    const fileMeta: BurnerFileMetadata = {
      name: selectedFile.file.name,
      size: selectedFile.file.size,
      type: selectedFile.file.type || 'application/octet-stream',
      dataUrl: selectedFile.dataUrl,
    };
    await onDropPayload('file', undefined, fileMeta, shareMode, ttlSeconds);
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

  return (
    <div className="w-full max-w-3xl">
      <AnimatePresence mode="wait">
        {/* STATE 1: ALREADY UPLOADED -> "READY FOR PICKUP" */}
        {isUploaded ? (
          <motion.div
            key="ready-state"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="w-full relative border border-white/20 rounded-2xl p-8 sm:p-12 bg-white/[0.02] flex flex-col items-center text-center space-y-6 shadow-2xl backdrop-blur-md overflow-hidden"
          >
            {/* Top Laser Accent */}
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#FF3B30] to-transparent animate-laser" />

            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 rounded-full bg-[#FF3B30] shadow-[0_0_8px_#FF3B30]" />
              <span className="text-[10px] uppercase tracking-[0.3em] text-white/50 font-medium">
                Live Payload Uplink Active
              </span>
            </div>

            <div className="space-y-2">
              <h3 className="text-xl sm:text-2xl font-light tracking-wide text-white">
                Payload Armed & Ready for Pickup
              </h3>
              <p className="text-sm font-light text-white/60 max-w-md mx-auto">
                Share PIN <span className="font-mono text-[#FF3B30] font-semibold">{pin}</span> with your recipient
                {shareMode === 'multiple_reads'
                  ? `. Multi-device pickup active for ${formatDurationText(ttlSeconds)}.`
                  : `. Incinerates permanently immediately upon first retrieval.`}
              </p>
            </div>

            {/* Payload Brief info card */}
            <div className="w-full max-w-md p-4 rounded-xl bg-white/[0.03] border border-white/10 flex items-center justify-between text-left">
              <div className="flex items-center space-x-3 overflow-hidden">
                {uploadedType === 'file' ? (
                  <FileCheck className="w-5 h-5 text-[#FF3B30] flex-shrink-0" />
                ) : (
                  <FileText className="w-5 h-5 text-[#FF3B30] flex-shrink-0" />
                )}
                <div className="truncate">
                  <p className="text-xs font-mono text-white truncate">
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
                    <span>Multi</span>
                  </span>
                ) : (
                  <span className="text-[9px] uppercase tracking-widest px-2 py-0.5 rounded bg-[#FF3B30]/20 text-[#FF3B30] font-mono border border-[#FF3B30]/30">
                    1-Time
                  </span>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                id="manual-burn-btn"
                onClick={onManualBurn}
                disabled={isLoading}
                className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-[#FF3B30]/10 hover:bg-[#FF3B30]/20 text-[#FF3B30] text-[11px] uppercase tracking-[0.2em] font-medium border border-[#FF3B30]/30 transition-all cursor-pointer"
              >
                <Flame className="w-3.5 h-3.5" />
                <span>Burn Now</span>
              </button>

              <button
                id="drop-another-btn"
                onClick={onReset}
                className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-white text-[11px] uppercase tracking-[0.2em] font-medium border border-white/10 transition-all cursor-pointer"
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
            {/* Top configuration bar: Mode tabs, TTL selector & Share policy picker */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 px-1">
              <div className="flex items-center space-x-2">
                <button
                  id="tab-mode-both"
                  onClick={() => {
                    setActiveInputMode('both');
                    setSelectedFile(null);
                  }}
                  className={`text-[10px] uppercase tracking-[0.2em] px-3 py-1 rounded-md transition-all cursor-pointer ${
                    activeInputMode === 'both' && !selectedFile
                      ? 'bg-white/10 text-white font-medium'
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
                  className={`text-[10px] uppercase tracking-[0.2em] px-3 py-1 rounded-md transition-all cursor-pointer ${
                    activeInputMode === 'text'
                      ? 'bg-white/10 text-white font-medium'
                      : 'text-white/40 hover:text-white'
                  }`}
                >
                  Paste Text
                </button>
              </div>

              {/* Right controls: TTL Duration Selector & Share Policy */}
              <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                {/* TTL Duration Selector */}
                <div id="ttl-selector-container" className="flex items-center space-x-1 bg-white/[0.03] border border-white/10 p-1 rounded-lg">
                  <div className="flex items-center px-1.5 text-white/30">
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
                    <span>1-Time Read</span>
                  </button>
                  <button
                    id="policy-multiple-reads"
                    onClick={() => setShareMode('multiple_reads')}
                    title="Allows multiple downloads/reads across devices until TTL expires"
                    className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-[9px] uppercase tracking-[0.2em] font-medium transition-all cursor-pointer ${
                      shareMode === 'multiple_reads'
                        ? 'bg-white/15 text-white border border-white/20 font-semibold'
                        : 'text-white/40 hover:text-white'
                    }`}
                  >
                    <Users className="w-2.5 h-2.5 text-[#FF3B30]" />
                    <span>Multi-Share</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Custom TTL Slider Drawer */}
            <AnimatePresence>
              {showCustomSlider && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 px-4 rounded-xl bg-white/[0.02] border border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                    <div className="flex items-center space-x-2">
                      <Clock className="w-3.5 h-3.5 text-[#FF3B30]" />
                      <span className="text-[10px] uppercase tracking-widest text-white/50">
                        Custom Auto-Destruct TTL:
                      </span>
                      <span className="font-mono text-white font-semibold">
                        {formatDurationText(ttlSeconds)} ({Math.round(ttlSeconds / 60)} min)
                      </span>
                    </div>
                    <div className="flex items-center space-x-3 flex-1 sm:max-w-xs">
                      <span className="text-[9px] font-mono text-white/30">1m</span>
                      <input
                        id="ttl-custom-slider"
                        type="range"
                        min="1"
                        max="60"
                        step="1"
                        value={Math.round(ttlSeconds / 60)}
                        onChange={(e) => setTtlSeconds(Number(e.target.value) * 60)}
                        className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#FF3B30]"
                      />
                      <span className="text-[9px] font-mono text-white/30">60m</span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Error banner */}
            {errorMessage && (
              <div className="p-3 rounded-xl bg-[#FF3B30]/10 border border-[#FF3B30]/30 text-[#FF3B30] text-xs flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4" />
                  <span>{errorMessage}</span>
                </div>
                <button onClick={() => setErrorMessage(null)}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* TEXT MODE EDITOR */}
            {activeInputMode === 'text' && !selectedFile ? (
              <div className="w-full relative border border-white/20 rounded-2xl bg-white/[0.02] p-6 flex flex-col space-y-4 hover:border-white/30 transition-all">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] uppercase tracking-widest text-white/40">
                    Secure Text Buffer
                  </span>
                  <span className="text-[10px] font-mono text-white/30">
                    {textContent.length} / 10,000 chars
                  </span>
                </div>

                <textarea
                  id="burner-text-input"
                  rows={7}
                  maxLength={10000}
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  placeholder="Paste passwords, API tokens, terminal commands, or secret notes here..."
                  className="w-full bg-transparent text-sm sm:text-base font-mono text-white/90 placeholder-white/20 border-none outline-none resize-none leading-relaxed focus:ring-0"
                />

                <div className="flex justify-between items-center pt-2 border-t border-white/[0.05]">
                  <span className="text-[9px] uppercase tracking-[0.2em] text-white/30">
                    {shareMode === 'multiple_reads' ? `Multi-device access (${formatDurationText(ttlSeconds)})` : `Self-destruct on 1st read (${formatDurationText(ttlSeconds)} max)`}
                  </span>
                  <button
                    id="upload-text-btn"
                    onClick={handleUploadText}
                    disabled={isLoading || !textContent.trim()}
                    className="flex items-center space-x-2 px-6 py-2 rounded-xl bg-white text-black text-[11px] uppercase tracking-[0.2em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <span>{isLoading ? 'Encrypting...' : 'Arm & Lock Drop'}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : selectedFile ? (
              /* SELECTED FILE READY STATE */
              <div className="w-full relative border border-white/30 rounded-2xl bg-white/[0.03] p-8 flex flex-col items-center text-center space-y-5">
                <div className="w-12 h-12 rounded-2xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
                  <FileText className="w-6 h-6 text-[#FF3B30]" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-mono text-white font-medium">{selectedFile.file.name}</p>
                  <p className="text-xs text-white/40">{formatFileSize(selectedFile.file.size)} • {formatDurationText(ttlSeconds)} TTL</p>
                </div>

                <div className="flex items-center space-x-3">
                  <button
                    id="cancel-file-btn"
                    onClick={() => setSelectedFile(null)}
                    className="px-4 py-2 rounded-xl text-white/50 hover:text-white text-xs uppercase tracking-wider cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    id="upload-file-btn"
                    onClick={handleUploadFile}
                    disabled={isLoading}
                    className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-white text-black text-[11px] uppercase tracking-[0.2em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all cursor-pointer"
                  >
                    <span>{isLoading ? 'Encrypting...' : 'Upload & Arm PIN'}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              /* UNIVERSAL DROPZONE (Clean Minimalism Design Template) */
              <div
                {...getRootProps()}
                id="burner-dropzone"
                className={`relative w-full aspect-[21/9] sm:min-h-[220px] border border-dashed rounded-2xl flex flex-col items-center justify-center transition-all cursor-pointer group ${
                  isDragActive
                    ? 'border-[#FF3B30] bg-[#FF3B30]/[0.05] scale-[1.01]'
                    : 'border-white/20 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/40'
                }`}
              >
                <input {...getInputProps()} id="file-drop-input" />

                {/* Top Protocol Tag */}
                <div className="absolute top-4 sm:top-6 left-6 sm:left-8 flex items-center space-x-2">
                  <div className="w-1.5 h-1.5 bg-white/20 rounded-full"></div>
                  <span className="text-[9px] uppercase tracking-widest text-white/30">
                    TTL: {formatDurationText(ttlSeconds)}
                  </span>
                </div>

                {/* Center Content */}
                <div className="flex flex-col items-center space-y-3 sm:space-y-4 px-4 text-center">
                  <div className="w-10 h-10 rounded-full bg-white/[0.03] border border-white/10 flex items-center justify-center text-white/40 group-hover:text-white group-hover:border-white/30 transition-all">
                    <UploadCloud className="w-5 h-5" />
                  </div>

                  <p className="text-base sm:text-lg font-light tracking-wide text-white/70 group-hover:text-white transition-colors">
                    {isDragActive
                      ? 'Release to upload payload'
                      : 'Drop payload or paste secure string'}
                  </p>

                  <span className="text-[10px] uppercase tracking-[0.2em] text-white/30 font-mono">
                    Max 50MB / 10k Characters • Up to 1 Hour TTL
                  </span>
                </div>

                {/* Bottom Uplink Tag */}
                <div className="absolute bottom-4 sm:bottom-6 right-6 sm:right-8 text-[9px] uppercase tracking-[0.2em] text-white/30">
                  Ready for uplink
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
