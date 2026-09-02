import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  KeyRound,
  Flame,
  Clock,
  X,
  Zap,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  Lock,
} from 'lucide-react';

interface SpotlightOnboardingProps {
  isOpen: boolean;
  onClose: () => void;
}

interface StepConfig {
  id: string;
  targetId: string; // The DOM element id to anchor the spotlight to
  badge: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  accentColor: string;
  positionPreference?: 'top' | 'bottom' | 'center';
}

const STEPS: StepConfig[] = [
  {
    id: 'pin',
    targetId: 'session-pin-container',
    badge: 'Step 1 • Dynamic Session Key',
    title: '4-Digit Ephemeral PIN',
    description:
      'Every drop is assigned a non-colliding numeric key. Tap anytime to copy or use the refresh button to generate a new key.',
    icon: KeyRound,
    accentColor: '#FFFFFF',
    positionPreference: 'bottom',
  },
  {
    id: 'dropzone',
    targetId: 'burner-dropzone',
    badge: 'Step 2 • Zero-Trace Payload',
    title: 'Universal Drop & Text Buffer',
    description:
      'Upload files up to 50MB or switch to "Paste Text" for confidential snippets and credentials. All data is RAM-only.',
    icon: Zap,
    accentColor: '#FF3B30',
    positionPreference: 'bottom',
  },
  {
    id: 'ttl',
    targetId: 'ttl-selector-container',
    badge: 'Step 3 • Auto-Destruct Lifetime',
    title: 'Customizable TTL Lifespan',
    description:
      'Select quick presets (5m to 1h) or use the custom slider to set the exact auto-purge countdown before memory incineration.',
    icon: Clock,
    accentColor: '#FF9500',
    positionPreference: 'bottom',
  },
  {
    id: 'policy',
    targetId: 'share-policy-container',
    badge: 'Step 4 • Read Policy',
    title: '1-Time Read vs Multi-Share',
    description:
      'Choose "1-Time Read" (destroys instantly upon first unlock) or "Multi-Share" (allows multiple retrievals before the TTL timer expires).',
    icon: Lock,
    accentColor: '#FF3B30',
    positionPreference: 'bottom',
  },
  {
    id: 'timer',
    targetId: 'countdown-timer-container',
    badge: 'Step 5 • Real-Time Purge Clock',
    title: 'Active Auto-Purge Countdown',
    description:
      'Tracks remaining session lifespan in real-time. When the countdown hits zero, payload buffers are destroyed permanently.',
    icon: Flame,
    accentColor: '#FF3B30',
    positionPreference: 'top',
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
        block: isMobile ? 'center' : 'nearest',
        inline: 'nearest',
      });
      // Re-measure after scroll animation starts and finishes
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
  }, [isOpen, step.targetId, currentStepIndex, isMobile, updateTargetRect]);

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

  // Handle touch swipes on mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX.current - touchEndX;

    // Threshold of 50px for swipe gesture
    if (Math.abs(diff) > 50) {
      if (diff > 0) {
        // Swiped left -> Next
        if (currentStepIndex < STEPS.length - 1) {
          setCurrentStepIndex((prev) => prev + 1);
        } else {
          onClose();
        }
      } else {
        // Swiped right -> Prev
        if (currentStepIndex > 0) {
          setCurrentStepIndex((prev) => prev - 1);
        }
      }
    }
    touchStartX.current = null;
  };

  // Determine whether card on mobile should sit at top or bottom
  const shouldDockTopOnMobile = Boolean(
    targetRect && targetRect.top + targetRect.height / 2 > windowDimensions.height / 2
  );

  // Calculate position styles for desktop vs mobile
  const getCardStyle = (): React.CSSProperties => {
    if (isMobile) {
      // Mobile: Clean inset-x docking at top or bottom with safe area padding
      if (shouldDockTopOnMobile) {
        return {
          position: 'fixed',
          top: 'max(14px, env(safe-area-inset-top, 14px))',
          left: '12px',
          right: '12px',
          margin: '0 auto',
          maxWidth: 'calc(100vw - 24px)',
        };
      }
      return {
        position: 'fixed',
        bottom: 'max(16px, env(safe-area-inset-bottom, 16px))',
        left: '12px',
        right: '12px',
        margin: '0 auto',
        maxWidth: 'calc(100vw - 24px)',
      };
    }

    // Desktop: Smart positioning relative to target
    if (!targetRect) {
      return {
        position: 'fixed',
        left: '50%',
        top: '50%',
        marginLeft: '-195px',
        marginTop: '-120px',
        width: '390px',
      };
    }

    const popoverWidth = 390;
    const popoverHeight = 220;
    const viewportWidth = windowDimensions.width;
    const viewportHeight = windowDimensions.height;

    let left = targetRect.left + targetRect.width / 2 - popoverWidth / 2;
    left = Math.max(16, Math.min(left, viewportWidth - popoverWidth - 16));

    let top = 0;
    if (
      step.positionPreference === 'top' ||
      targetRect.bottom + popoverHeight + 20 > viewportHeight
    ) {
      top = Math.max(16, targetRect.top - popoverHeight - 14);
    } else {
      top = Math.min(viewportHeight - popoverHeight - 16, targetRect.bottom + 14);
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
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="absolute inset-0 w-full h-full pointer-events-auto"
            onClick={onClose}
          >
            <defs>
              <mask id="spotlight-mask">
                {/* White fills everything (masked area is visible dark overlay) */}
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                {/* Black cuts out hole for the targeted element */}
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

            {/* Dark blur backdrop overlay with cutout */}
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="rgba(0, 0, 0, 0.82)"
              mask="url(#spotlight-mask)"
            />
          </motion.svg>

          {/* Animated Glowing Ring framing the target element */}
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
              className="absolute pointer-events-none rounded-xl sm:rounded-2xl border-2 border-[#FF3B30] shadow-[0_0_20px_rgba(255,59,48,0.5)] z-40"
            >
              {/* Corner accents */}
              <span className="absolute -top-1 -left-1 w-2 h-2 sm:w-2.5 sm:h-2.5 border-t-2 border-l-2 border-white"></span>
              <span className="absolute -top-1 -right-1 w-2 h-2 sm:w-2.5 sm:h-2.5 border-t-2 border-r-2 border-white"></span>
              <span className="absolute -bottom-1 -left-1 w-2 h-2 sm:w-2.5 sm:h-2.5 border-b-2 border-l-2 border-white"></span>
              <span className="absolute -bottom-1 -right-1 w-2 h-2 sm:w-2.5 sm:h-2.5 border-b-2 border-r-2 border-white"></span>
            </motion.div>
          )}

          {/* Refined Tour Tooltip Box with Mobile Viewport Containment */}
          <motion.div
            key={`step-${step.id}`}
            style={cardStyle}
            initial={{
              opacity: 0,
              y: isMobile ? (shouldDockTopOnMobile ? -14 : 14) : 8,
              scale: 0.98,
            }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
            }}
            exit={{
              opacity: 0,
              y: isMobile ? (shouldDockTopOnMobile ? -14 : 14) : 8,
              scale: 0.98,
            }}
            transition={{
              type: 'spring',
              damping: 28,
              stiffness: 320,
            }}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            className="z-50 bg-[#141414]/95 border border-white/20 rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-[0_16px_50px_rgba(0,0,0,0.9)] backdrop-blur-2xl pointer-events-auto"
          >
            {/* Top Bar: Step Badge & Skip Tour Button */}
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center space-x-2 min-w-0">
                <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg sm:rounded-xl bg-white/[0.08] border border-white/10 flex items-center justify-center shrink-0">
                  <StepIcon className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#FF3B30]" />
                </div>
                <span className="text-[10px] sm:text-[11px] uppercase tracking-[0.16em] sm:tracking-[0.2em] font-mono text-[#FF3B30] font-semibold truncate">
                  {step.badge}
                </span>
              </div>

              <button
                id="spotlight-skip-btn"
                onClick={onClose}
                className="shrink-0 flex items-center space-x-1 text-[10px] uppercase tracking-wider font-mono text-white/50 hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/10 cursor-pointer"
              >
                <span>Skip</span>
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Step Content: Title & Description */}
            <div className="space-y-1 sm:space-y-1.5 mb-4 sm:mb-5">
              <h4 className="text-sm sm:text-base font-medium text-white tracking-tight">
                {step.title}
              </h4>
              <p className="text-xs sm:text-[13px] text-white/70 font-normal leading-relaxed">
                {step.description}
              </p>
            </div>

            {/* Footer: Progress Indicator Dots & Action Buttons */}
            <div className="pt-3 border-t border-white/[0.08] flex items-center justify-between gap-2">
              {/* Step indicator dots */}
              <div className="flex items-center space-x-1.5">
                {STEPS.map((_, idx) => (
                  <button
                    key={idx}
                    id={`spotlight-dot-${idx}`}
                    onClick={() => setCurrentStepIndex(idx)}
                    aria-label={`Go to step ${idx + 1}`}
                    className={`h-1 rounded-full transition-all duration-300 cursor-pointer ${
                      currentStepIndex === idx
                        ? 'w-4 sm:w-5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]'
                        : 'w-1.5 bg-white/20 hover:bg-white/40'
                    }`}
                  />
                ))}
              </div>

              {/* Navigation Controls */}
              <div className="flex items-center space-x-1.5 sm:space-x-2">
                {currentStepIndex > 0 && (
                  <button
                    id="spotlight-prev-btn"
                    onClick={() => setCurrentStepIndex((prev) => prev - 1)}
                    className="flex items-center space-x-1 px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-lg text-xs font-mono text-white/60 hover:text-white transition-colors cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5 sm:hidden" />
                    <span className="hidden sm:inline uppercase tracking-wider">Back</span>
                  </button>
                )}

                {currentStepIndex < STEPS.length - 1 ? (
                  <button
                    id="spotlight-next-btn"
                    onClick={() => setCurrentStepIndex((prev) => prev + 1)}
                    className="flex items-center space-x-1 sm:space-x-1.5 px-3.5 py-2 sm:px-4 sm:py-2 rounded-xl bg-white text-black text-xs uppercase tracking-[0.14em] sm:tracking-[0.18em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all shadow-sm cursor-pointer active:scale-95"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    id="spotlight-finish-btn"
                    onClick={onClose}
                    className="flex items-center space-x-1.5 px-4 py-2 sm:px-5 sm:py-2 rounded-xl bg-[#FF3B30] text-white text-xs uppercase tracking-[0.14em] sm:tracking-[0.18em] font-semibold hover:bg-white hover:text-black transition-all shadow-[0_0_14px_rgba(255,59,48,0.5)] cursor-pointer active:scale-95"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Got It</span>
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

