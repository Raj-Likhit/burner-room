import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  KeyRound,
  Flame,
  Clock,
  ArrowRight,
  X,
  Zap,
  Sparkles,
  ChevronRight,
  ShieldCheck,
  Users,
  Lock,
  Compass,
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
      'Every drop is assigned a non-colliding numeric key. Click anytime to copy the code or generate a fresh key with the refresh icon.',
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
      'Drag and drop files up to 50MB or switch to "Paste Text" for credentials and notes. All uploads live purely in RAM.',
    icon: Zap,
    accentColor: '#FF3B30',
    positionPreference: 'bottom',
  },
  {
    id: 'ttl',
    targetId: 'ttl-selector-container',
    badge: 'Step 3 • Auto-Destruct Lifetime',
    title: 'Customizable TTL (Up to 1 Hour)',
    description:
      'Choose quick presets (5m, 10m, 15m, 30m, 1h) or click the slider icon for custom 1-60 minute intervals before automatic memory wipe.',
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
      'Toggle between "1-Time Read" (incinerates instantly on first retrieval) and "Multi-Share" (allows multiple devices to fetch before the TTL timer expires).',
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
      'Monitors real-time remaining lifespan. When this reaches zero, all payload buffers are destroyed unconditionally.',
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
  const [isWindowSmall, setIsWindowSmall] = useState(false);

  const step = STEPS[currentStepIndex];
  const StepIcon = step.icon;

  // Measure targeted element
  const updateTargetRect = useCallback(() => {
    if (!isOpen) return;

    setIsWindowSmall(window.innerWidth < 640);
    const targetElement = document.getElementById(step.targetId);

    if (targetElement) {
      // Scroll into view if needed gently
      targetElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });

      const rect = targetElement.getBoundingClientRect();
      // Add comfortable padding around the highlighted element
      const padding = 10;
      setTargetRect({
        top: Math.max(0, rect.top - padding),
        left: Math.max(0, rect.left - padding),
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
        bottom: rect.bottom + padding,
        right: rect.right + padding,
      });
    } else {
      // Fallback center if element not in DOM (e.g., hidden state)
      setTargetRect(null);
    }
  }, [isOpen, step.targetId]);

  useEffect(() => {
    updateTargetRect();
    const handleResize = () => updateTargetRect();
    const handleScroll = () => updateTargetRect();

    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll);
    const interval = setInterval(updateTargetRect, 250);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll);
      clearInterval(interval);
    };
  }, [updateTargetRect]);

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

  // Calculate tooltip popover positioning
  const calculateTooltipPosition = () => {
    if (!targetRect || isWindowSmall) {
      // Centered or fixed bottom on mobile screens
      return {
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
      };
    }

    const popoverWidth = 380;
    const popoverHeight = 240;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Center horizontally with respect to target
    let left = targetRect.left + targetRect.width / 2 - popoverWidth / 2;
    // Keep inside viewport horizontal boundaries
    left = Math.max(20, Math.min(left, viewportWidth - popoverWidth - 20));

    let top = 0;
    if (step.positionPreference === 'top' || targetRect.bottom + popoverHeight + 20 > viewportHeight) {
      // Place above target
      top = Math.max(20, targetRect.top - popoverHeight - 16);
    } else {
      // Place below target
      top = Math.min(viewportHeight - popoverHeight - 20, targetRect.bottom + 16);
    }

    return {
      left: `${left}px`,
      top: `${top}px`,
      transform: 'none',
    };
  };

  const tooltipStyle = calculateTooltipPosition();

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 pointer-events-auto select-none overflow-hidden">
          {/* Dimmed backdrop with smooth SVG cutout hole around target */}
          <motion.svg
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeInOut' }}
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
                    rx="16"
                    ry="16"
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
              fill="rgba(0, 0, 0, 0.78)"
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
                damping: 28,
                stiffness: 280,
              }}
              className="absolute pointer-events-none rounded-2xl border-2 border-[#FF3B30] shadow-[0_0_24px_rgba(255,59,48,0.45)] z-40"
            >
              {/* Corner accents */}
              <span className="absolute -top-1 -left-1 w-2.5 h-2.5 border-t-2 border-l-2 border-white"></span>
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 border-t-2 border-r-2 border-white"></span>
              <span className="absolute -bottom-1 -left-1 w-2.5 h-2.5 border-b-2 border-l-2 border-white"></span>
              <span className="absolute -bottom-1 -right-1 w-2.5 h-2.5 border-b-2 border-r-2 border-white"></span>
            </motion.div>
          )}

          {/* Smooth Moving Tour Tooltip Box */}
          <motion.div
            layoutId="spotlight-card-box"
            style={tooltipStyle}
            initial={{ opacity: 0, scale: 0.92, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 10 }}
            transition={{
              type: 'spring',
              damping: 26,
              stiffness: 280,
            }}
            className="absolute z-50 w-[92vw] sm:w-[390px] bg-[#141414] border border-white/15 rounded-2xl sm:rounded-3xl p-5 sm:p-6 shadow-[0_16px_50px_rgba(0,0,0,0.8)] backdrop-blur-xl"
          >
            {/* Top Bar: Step & Skip */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <div className="w-7 h-7 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center">
                  <StepIcon className="w-3.5 h-3.5 text-[#FF3B30]" />
                </div>
                <span className="text-[10px] uppercase tracking-[0.2em] font-mono text-[#FF3B30] font-semibold">
                  {step.badge}
                </span>
              </div>

              <button
                id="spotlight-skip-btn"
                onClick={onClose}
                className="flex items-center space-x-1 text-[10px] uppercase tracking-wider font-mono text-white/40 hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/5 cursor-pointer"
              >
                <span>Skip Tour</span>
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Step Body */}
            <div className="space-y-2 mb-6">
              <h4 className="text-base sm:text-lg font-light text-white tracking-tight">
                {step.title}
              </h4>
              <p className="text-xs sm:text-sm text-white/60 font-light leading-relaxed">
                {step.description}
              </p>
            </div>

            {/* Footer: Progress Dots & Next / Finish */}
            <div className="pt-3 border-t border-white/[0.08] flex items-center justify-between">
              {/* Step indicator dots */}
              <div className="flex items-center space-x-1.5">
                {STEPS.map((_, idx) => (
                  <button
                    key={idx}
                    id={`spotlight-dot-${idx}`}
                    onClick={() => setCurrentStepIndex(idx)}
                    className={`h-1 rounded-full transition-all duration-300 cursor-pointer ${
                      currentStepIndex === idx
                        ? 'w-5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.7)]'
                        : 'w-1.5 bg-white/20 hover:bg-white/40'
                    }`}
                  />
                ))}
              </div>

              {/* Navigation Actions */}
              <div className="flex items-center space-x-2">
                {currentStepIndex > 0 && (
                  <button
                    id="spotlight-prev-btn"
                    onClick={() => setCurrentStepIndex((prev) => prev - 1)}
                    className="px-3 py-1.5 rounded-lg text-xs uppercase tracking-wider font-mono text-white/50 hover:text-white transition-colors cursor-pointer"
                  >
                    Back
                  </button>
                )}

                {currentStepIndex < STEPS.length - 1 ? (
                  <button
                    id="spotlight-next-btn"
                    onClick={() => setCurrentStepIndex((prev) => prev + 1)}
                    className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-white text-black text-xs uppercase tracking-[0.18em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all shadow-sm cursor-pointer"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    id="spotlight-finish-btn"
                    onClick={onClose}
                    className="flex items-center space-x-1.5 px-5 py-2 rounded-xl bg-[#FF3B30] text-white text-xs uppercase tracking-[0.18em] font-semibold hover:bg-white hover:text-black transition-all shadow-[0_0_12px_rgba(255,59,48,0.4)] cursor-pointer"
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
