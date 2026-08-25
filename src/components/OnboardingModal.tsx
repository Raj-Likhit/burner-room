import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  KeyRound,
  Flame,
  Clock,
  ArrowRight,
  X,
  ShieldCheck,
  Zap,
  Sparkles,
  ChevronRight,
} from 'lucide-react';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Step {
  title: string;
  badge: string;
  subtitle: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  accentColor: string;
  visualTag: string;
}

const ONBOARDING_STEPS: Step[] = [
  {
    title: 'Zero-Trace Temporary Vaults',
    badge: 'Instant Provisioning',
    subtitle: 'Generate a 4-Digit Ephemeral Key',
    description:
      'Every session instantly reserves a unique, collision-free PIN. No account, login, or tracking required.',
    icon: KeyRound,
    accentColor: '#FFFFFF',
    visualTag: 'PIN 4-DIGIT MATRIX',
  },
  {
    title: 'Drop Files or Secure Text',
    badge: 'Up to 50MB & 10k chars',
    subtitle: 'Seamless Cross-Device Uplink',
    description:
      'Paste API credentials, notes, passwords, or drop files. Payloads exist purely in ephemeral RAM and never touch permanent disk storage.',
    icon: Zap,
    accentColor: '#FF3B30',
    visualTag: 'RAM-ONLY BUFFER',
  },
  {
    title: 'Choose Read Policy & TTL',
    badge: 'Custom 1m to 1h Expiry',
    subtitle: 'Burn-on-Read or Multi-Share',
    description:
      'Configure auto-destruct TTL (from 1 minute to 1 hour) and select 1-Time Read to incinerate immediately upon pickup, or Multi-Share across several devices.',
    icon: Clock,
    accentColor: '#FF9500',
    visualTag: 'AUTO-PURGE ENGINE',
  },
  {
    title: 'Instant Pickup & Clean Incineration',
    badge: 'Irreversible Destruction',
    subtitle: 'Enter PIN to Retrieve Anywhere',
    description:
      'Recipient enters the 4-digit PIN on any phone, laptop, or browser to download or copy. Memory is scrubbed without recovery trails.',
    icon: Flame,
    accentColor: '#FF3B30',
    visualTag: 'ZERO PERSISTENCE',
  },
];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [currentStep, setCurrentStep] = useState(0);

  // Keyboard navigation (Esc to skip, Arrow keys to navigate)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (currentStep < ONBOARDING_STEPS.length - 1) {
          setCurrentStep((prev) => prev + 1);
        } else {
          onClose();
        }
      } else if (e.key === 'ArrowLeft') {
        if (currentStep > 0) {
          setCurrentStep((prev) => prev - 1);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, currentStep, onClose]);

  const step = ONBOARDING_STEPS[currentStep];
  const StepIcon = step.icon;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 select-none">
          {/* Backdrop Blur */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
          />

          {/* Modal Card */}
          <motion.div
            initial={{ opacity: 0, scale: 0.93, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{
              type: 'spring',
              damping: 26,
              stiffness: 300,
            }}
            className="relative w-full max-w-lg bg-[#121212] border border-white/10 rounded-2xl sm:rounded-3xl p-6 sm:p-8 shadow-2xl overflow-hidden"
          >
            {/* Subtle Top Ambient Glow */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-24 bg-[#FF3B30]/10 blur-3xl pointer-events-none rounded-full" />

            {/* Header: Badge & Skip Button */}
            <div className="flex items-center justify-between relative z-10 mb-6">
              <div className="flex items-center space-x-2">
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#FF3B30] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#FF3B30]"></span>
                </span>
                <span className="text-[10px] uppercase tracking-[0.25em] font-mono text-white/50">
                  Welcome to Burner Room
                </span>
              </div>

              <button
                id="onboarding-skip-btn"
                onClick={onClose}
                className="flex items-center space-x-1 text-[11px] uppercase tracking-wider font-mono text-white/40 hover:text-white transition-colors px-2 py-1 rounded-lg hover:bg-white/5 cursor-pointer"
              >
                <span>Skip</span>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Step Content Carousel */}
            <div className="relative min-h-[260px] flex flex-col justify-between z-10">
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentStep}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                  className="space-y-4"
                >
                  {/* Icon & Protocol Tag */}
                  <div className="flex items-center justify-between">
                    <div
                      className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/10 flex items-center justify-center shadow-inner"
                      style={{ borderColor: `${step.accentColor}30` }}
                    >
                      <StepIcon className="w-7 h-7 text-[#FF3B30]" />
                    </div>

                    <span className="text-[9px] font-mono uppercase tracking-[0.2em] px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-white/50">
                      {step.visualTag}
                    </span>
                  </div>

                  {/* Title & Subtitle */}
                  <div className="space-y-1.5 pt-2">
                    <span className="text-[10px] uppercase tracking-[0.2em] font-semibold text-[#FF3B30] font-mono">
                      {step.badge}
                    </span>
                    <h3 className="text-xl sm:text-2xl font-light tracking-tight text-white">
                      {step.title}
                    </h3>
                    <p className="text-sm font-normal text-white/80">
                      {step.subtitle}
                    </p>
                  </div>

                  {/* Body description */}
                  <p className="text-xs sm:text-sm text-white/50 font-light leading-relaxed">
                    {step.description}
                  </p>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Footer Navigation & Dots */}
            <div className="mt-8 pt-5 border-t border-white/[0.06] flex items-center justify-between relative z-10">
              {/* Step indicator dots */}
              <div className="flex items-center space-x-2">
                {ONBOARDING_STEPS.map((_, index) => (
                  <button
                    key={index}
                    id={`onboarding-dot-${index}`}
                    onClick={() => setCurrentStep(index)}
                    className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                      currentStep === index
                        ? 'w-6 bg-white shadow-[0_0_8px_rgba(255,255,255,0.6)]'
                        : 'w-1.5 bg-white/20 hover:bg-white/40'
                    }`}
                    aria-label={`Go to slide ${index + 1}`}
                  />
                ))}
              </div>

              {/* Action Buttons */}
              <div className="flex items-center space-x-2">
                {currentStep > 0 && (
                  <button
                    id="onboarding-prev-btn"
                    onClick={() => setCurrentStep((prev) => prev - 1)}
                    className="px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider font-mono text-white/60 hover:text-white transition-all cursor-pointer hover:bg-white/5"
                  >
                    Back
                  </button>
                )}

                {currentStep < ONBOARDING_STEPS.length - 1 ? (
                  <button
                    id="onboarding-next-btn"
                    onClick={() => setCurrentStep((prev) => prev + 1)}
                    className="flex items-center space-x-1.5 px-5 py-2.5 rounded-xl bg-white text-black text-xs uppercase tracking-[0.2em] font-semibold hover:bg-[#FF3B30] hover:text-white transition-all shadow-md cursor-pointer"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    id="onboarding-finish-btn"
                    onClick={onClose}
                    className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-[#FF3B30] text-white text-xs uppercase tracking-[0.2em] font-semibold hover:bg-white hover:text-black transition-all shadow-[0_0_16px_rgba(255,59,48,0.4)] cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Get Started</span>
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
