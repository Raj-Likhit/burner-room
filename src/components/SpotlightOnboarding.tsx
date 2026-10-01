import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  KeyRound,
  Clock,
  X,
  ChevronRight,
  ChevronLeft,
  Lock,
  Upload,
  Download,
  Trash2,
} from 'lucide-react';

interface SpotlightOnboardingProps {
  isOpen: boolean;
  onClose: () => void;
}

interface StepConfig {
  id: string;
  targetId: string;
  badge: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  positionPreference?: 'top' | 'bottom' | 'center';
}

const STEPS: StepConfig[] = [
  {
    id: 'pin',
    targetId: 'session-pin-container',
    badge: 'Step 1 • Share Code',
    title: '4-Digit Transfer Code',
    description:
      'Every transfer gets a 4-digit code. Share this code or the direct link with whoever you want to send the file to.',
    icon: KeyRound,
    positionPreference: 'bottom',
  },
  {
    id: 'dropzone',
    targetId: 'file-dropzone-container',
    badge: 'Step 2 • Add File or Text',
    title: 'Drop Files or Write Notes',
    description:
      'Drag and drop any file up to 50MB, or switch to "Note" to paste text, passwords, or credentials.',
    icon: Upload,
    positionPreference: 'bottom',
  },
  {
    id: 'ttl',
    targetId: 'ttl-selector-container',
    badge: 'Step 3 • Expiration',
    title: 'Choose Expiration Time',
    description:
      'Set how long the file will be available (5 minutes up to 1 hour). When time is up, the file is deleted automatically.',
    icon: Clock,
    positionPreference: 'bottom',
  },
  {
    id: 'policy',
    targetId: 'share-policy-container',
    badge: 'Step 4 • Download Limit',
    title: 'Single or Multiple Downloads',
    description:
      'Choose "One download" to delete the file immediately upon retrieval, or allow 2, 5, 10, or unlimited downloads. The dropdown opens upwards so options are clearly visible.',
    icon: Lock,
    positionPreference: 'bottom',
  },
  {
    id: 'receive',
    targetId: 'nav-tab-pickup',
    badge: 'Step 5 • Receive & Auto-Delete',
    title: 'Receive on Any Device',
    description:
      'Recipients click Receive or enter the 4-digit code to download. Once the set download limit is completed, the file is automatically and permanently deleted.',
    icon: Download,
    positionPreference: 'bottom',
  },
];

interface ElementRect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

export const SpotlightOnboarding: React.FC<SpotlightOnboardingProps> = ({
  isOpen,
  onClose,
}) => {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<ElementRect | null>(null);
  const [windowDimensions, setWindowDimensions] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 390,
    height: typeof window !== 'undefined' ? window.innerHeight : 844,
  });

  const touchStartX = useRef<number | null>(null);
  const step = STEPS[currentStepIndex];
  const StepIcon = step.icon;

  const isMobile = windowDimensions.width < 640;

  // Measure targeted element
  const updateTargetRect = useCallback(() => {
    if (!isOpen) return;

    const winW = window.innerWidth;
    const winH = window.innerHeight;
    setWindowDimensions({ width: winW, height: winH });

    const targetElement = document.getElementById(step.targetId);

    if (targetElement) {
      const rect = targetElement.getBoundingClientRect();
      const padding = isMobile ? 6 : 10;

      setTargetRect({
        top: Math.max(0, rect.top - padding),
        left: Math.max(0, rect.left - padding),
        width: Math.min(winW, rect.width + padding * 2),
        height: rect.height + padding * 2,
        bottom: rect.bottom + padding,
        right: rect.right + padding,
      });
    } else {
      setTargetRect(null);
    }
  }, [isOpen, step.targetId, isMobile]);

  // Smooth scroll target into comfortable view on step change
  useEffect(() => {
    if (!isOpen) return;

    const targetElement = document.getElementById(step.targetId);
    if (targetElement) {
      targetElement.scrollIntoView({
        behavior: 'smooth',
        block: isMobile ? 'center' : (step.positionPreference === 'bottom' ? 'start' : 'center'),
        inline: 'nearest',
      });
      const t1 = setTimeout(updateTargetRect, 50);
      const t2 = setTimeout(updateTargetRect, 200);
      const t3 = setTimeout(updateTargetRect, 450);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    } else {
      updateTargetRect();
    }
  }, [isOpen, step.targetId, currentStepIndex, isMobile, step.positionPreference, updateTargetRect]);

  // Window resize & scroll listener
  useEffect(() => {
    if (!isOpen) return;

    updateTargetRect();
    const handleResize = () => updateTargetRect();
    const handleScroll = () => updateTargetRect();

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [isOpen, updateTargetRect]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (currentStepIndex < STEPS.length - 1) {
          setCurrentStepIndex((prev) => prev + 1);
        } else {
          onClose();
        }
      } else if (e.key === 'ArrowLeft') {
        if (currentStepIndex > 0) {
          setCurrentStepIndex((prev) => prev - 1);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, currentStepIndex, onClose]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX.current - touchEndX;

    if (Math.abs(diff) > 50) {
      if (diff > 0) {
        if (currentStepIndex < STEPS.length - 1) {
          setCurrentStepIndex((prev) => prev + 1);
        } else {
          onClose();
        }
      } else {
        if (currentStepIndex > 0) {
          setCurrentStepIndex((prev) => prev - 1);
        }
      }
    }
    touchStartX.current = null;
  };

  const getCardStyle = (): React.CSSProperties => {
    if (isMobile) {
      return {
        position: 'fixed',
        bottom: 'max(16px, env(safe-area-inset-bottom, 16px))',
        left: '12px',
        right: '12px',
        margin: '0 auto',
        maxWidth: 'calc(100vw - 24px)',
      };
    }

    if (!targetRect) {
      return {
        position: 'fixed',
        left: '50%',
        top: '50%',
        marginLeft: '-190px',
        marginTop: '-110px',
        width: '380px',
      };
    }

    const popoverWidth = 380;
    const popoverHeight = 180;
    const viewportWidth = windowDimensions.width;
    const viewportHeight = windowDimensions.height;

    let left = targetRect.left + targetRect.width / 2 - popoverWidth / 2;
    left = Math.max(16, Math.min(left, viewportWidth - popoverWidth - 16));

    let top = 0;
    // When step.positionPreference is 'bottom' (especially for downloads dropdown which opens upwards),
    // position the walkthrough card strictly BELOW the target so the upward dropdown space is 100% free!
    if (step.positionPreference === 'bottom') {
      if (targetRect.bottom + popoverHeight + 16 <= viewportHeight) {
        top = targetRect.bottom + 14;
      } else {
        // If near bottom of viewport, position below with minimal gap or dock above if no room below
        top = Math.min(viewportHeight - popoverHeight - 16, Math.max(16, targetRect.bottom + 8));
      }
    } else if (step.positionPreference === 'top') {
      top = Math.max(16, targetRect.top - popoverHeight - 14);
    } else {
      if (targetRect.bottom + popoverHeight + 20 > viewportHeight) {
        top = Math.max(16, targetRect.top - popoverHeight - 14);
      } else {
        top = Math.min(viewportHeight - popoverHeight - 16, targetRect.bottom + 14);
      }
    }

    return {
      position: 'fixed',
      left: `${left}px`,
      top: `${top}px`,
      width: `${popoverWidth}px`,
    };
  };

  const cardStyle = getCardStyle();

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 pointer-events-auto select-none overflow-hidden touch-none">
          {/* Dimmed backdrop with smooth SVG cutout hole around target */}
          <motion.svg
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 w-full h-full pointer-events-auto"
            onClick={onClose}
          >
            <defs>
              <mask id="spotlight-mask">
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                {targetRect && (
                  <rect
                    x={targetRect.left}
                    y={targetRect.top}
                    width={targetRect.width}
                    height={targetRect.height}
                    rx={isMobile ? '12' : '16'}
                    ry={isMobile ? '12' : '16'}
                    fill="black"
                  />
                )}
              </mask>
            </defs>

            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="rgba(0, 0, 0, 0.85)"
              mask="url(#spotlight-mask)"
            />
          </motion.svg>

          {/* Glowing highlight framing target */}
          {targetRect && (
            <motion.div
              layoutId="spotlight-highlight-ring"
              initial={false}
              animate={{
                top: targetRect.top,
                left: targetRect.left,
                width: targetRect.width,
                height: targetRect.height,
              }}
              transition={{
                type: 'spring',
                damping: 26,
                stiffness: 280,
              }}
              className="absolute pointer-events-none rounded-2xl border-2 border-white/60 shadow-[0_0_24px_rgba(255,255,255,0.2)] z-40"
            />
          )}

          {/* Guide card */}
          <motion.div
            key={`step-${step.id}`}
            style={cardStyle}
            initial={{
              opacity: 0,
              y: isMobile ? 10 : 6,
              scale: 0.98,
            }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
            }}
            exit={{
              opacity: 0,
              y: isMobile ? 10 : 6,
              scale: 0.98,
            }}
            transition={{
              type: 'spring',
              damping: 28,
              stiffness: 320,
            }}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            className="z-50 bg-zinc-900 border border-zinc-800 rounded-2xl p-5 sm:p-6 shadow-2xl pointer-events-auto"
          >
            {/* Top Bar */}
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center space-x-2 min-w-0">
                <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0">
                  <StepIcon className="w-3.5 h-3.5 text-zinc-300" />
                </div>
                <span className="text-xs font-medium text-zinc-400 truncate">
                  {step.badge}
                </span>
              </div>

              <button
                id="spotlight-skip-btn"
                onClick={onClose}
                className="shrink-0 text-xs text-zinc-500 hover:text-white transition-colors px-2 py-1 rounded cursor-pointer"
              >
                Skip
              </button>
            </div>

            {/* Step Content */}
            <div className="space-y-1 mb-5">
              <h4 className="text-base font-semibold text-white">
                {step.title}
              </h4>
              <p className="text-xs sm:text-sm text-zinc-400 font-normal leading-relaxed">
                {step.description}
              </p>
            </div>

            {/* Footer */}
            <div className="pt-3 border-t border-zinc-800 flex items-center justify-between gap-2">
              {/* Step indicator dots */}
              <div className="flex items-center space-x-1.5">
                {STEPS.map((_, idx) => (
                  <button
                    key={idx}
                    id={`spotlight-dot-${idx}`}
                    onClick={() => setCurrentStepIndex(idx)}
                    aria-label={`Go to step ${idx + 1}`}
                    className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                      currentStepIndex === idx
                        ? 'w-5 bg-white'
                        : 'w-1.5 bg-zinc-700 hover:bg-zinc-500'
                    }`}
                  />
                ))}
              </div>

              {/* Navigation Controls */}
              <div className="flex items-center space-x-2">
                {currentStepIndex > 0 && (
                  <button
                    id="spotlight-prev-btn"
                    onClick={() => setCurrentStepIndex((prev) => prev - 1)}
                    className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
                  >
                    Back
                  </button>
                )}

                {currentStepIndex < STEPS.length - 1 ? (
                  <button
                    id="spotlight-next-btn"
                    onClick={() => setCurrentStepIndex((prev) => prev + 1)}
                    className="flex items-center space-x-1 px-4 py-2 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200 transition-all cursor-pointer"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    id="spotlight-finish-btn"
                    onClick={onClose}
                    className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200 transition-all cursor-pointer"
                  >
                    <span>Got it</span>
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
