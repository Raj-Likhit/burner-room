import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Copy, X, Check } from 'lucide-react';

interface ClipboardFallbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  textToCopy: string;
  title?: string;
}

export const ClipboardFallbackModal: React.FC<ClipboardFallbackModalProps> = ({
  isOpen,
  onClose,
  textToCopy,
  title = 'Copy Link Manually',
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = React.useState(false);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.select();
        }
      }, 50);
    }
  }, [isOpen]);

  const handleSelectAllAndCopy = () => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // user can still manual copy
      }
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md p-6 rounded-3xl bg-[#141414] border border-white/20 text-white flex flex-col space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-white font-mono">
                {title}
              </h3>
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-white/60 leading-relaxed">
              Automatic clipboard copy was blocked by browser security restrictions. Please select and copy the text below using <kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px]">Ctrl+C</kbd> or <kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px]">Cmd+C</kbd>:
            </p>

            <div className="relative">
              <textarea
                ref={textareaRef}
                readOnly
                value={textToCopy}
                rows={4}
                className="w-full p-3 rounded-xl bg-black/60 border border-white/15 text-xs font-mono text-white/90 select-all outline-none focus:border-[#FF3B30] resize-none"
              />
            </div>

            <div className="flex items-center space-x-3 pt-2">
              <button
                onClick={handleSelectAllAndCopy}
                className="flex-1 py-2.5 rounded-xl bg-white text-black text-xs uppercase tracking-widest font-semibold hover:bg-[#FF3B30] hover:text-white transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Select All & Copy'}</span>
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl bg-white/10 text-white/70 hover:text-white text-xs uppercase tracking-widest font-semibold transition-all cursor-pointer"
              >
                Done
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
