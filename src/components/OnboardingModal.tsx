import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  KeyRound,
  Clock,
  X,
  ChevronRight,
  Upload,
  Download,
} from 'lucide-react';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Step {
  title: string;
  badge: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const ONBOARDING_STEPS: Step[] = [
  {
    title: 'Easy 4-Digit Share Code',
    badge: 'Step 1 • Code & Link',
    description:
      'Every transfer gets a simple 4-digit code. Share the code or direct link with your recipient. No accounts, signups, or tracking.',
    icon: KeyRound,
  },
  {
    title: 'Send Files or Text Notes',
    badge: 'Step 2 • Up to 50MB',
    description:
      'Upload files or write confidential text notes and passwords. Everything is encrypted in memory and stored only temporarily.',
    icon: Upload,
  },
  {
    title: 'Set Expiration & Download Limits',
    badge: 'Step 3 • Control Access',
    description:
      'Choose how long the file remains available (5 minutes up to 1 hour) and whether to delete it immediately after the first download.',
    icon: Clock,
  },
  {
    title: 'Instant Download & Automatic Deletion',
    badge: 'Step 4 • Safe & Private',
    description:
      'The recipient enters the code on any device to download the file. Once downloaded or expired, it is permanently deleted.',
    icon: Download,
  },
];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [currentStep, setCurrentStep] = useState(0);

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
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{
              type: 'spring',
              damping: 26,
              stiffness: 300,
            }}
            className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-8 shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between relative z-10 mb-6">
              <span className="text-xs font-semibold text-zinc-400">
                Welcome to Burner Room
              </span>

              <button
                id="onboarding-skip-btn"
                onClick={onClose}
                className="text-xs text-zinc-500 hover:text-white transition-colors px-2 py-1 rounded cursor-pointer"
              >
                Skip
              </button>
            </div>

            {/* Content */}
            <div className="relative min-h-[200px] flex flex-col justify-between z-10">
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentStep}
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  <div className="w-12 h-12 rounded-xl bg-zinc-800 flex items-center justify-center">
                    <StepIcon className="w-6 h-6 text-white" />
                  </div>

                  <div className="space-y-1">
                    <span className="text-xs font-semibold text-zinc-400">
                      {step.badge}
                    </span>
                    <h3 className="text-xl font-semibold text-white">
                      {step.title}
                    </h3>
                  </div>

                  <p className="text-sm text-zinc-400 font-normal leading-relaxed">
                    {step.description}
                  </p>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Footer */}
            <div className="mt-8 pt-5 border-t border-zinc-800 flex items-center justify-between relative z-10">
              <div className="flex items-center space-x-1.5">
                {ONBOARDING_STEPS.map((_, index) => (
                  <button
                    key={index}
                    id={`onboarding-dot-${index}`}
                    onClick={() => setCurrentStep(index)}
                    className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                      currentStep === index
                        ? 'w-6 bg-white'
                        : 'w-1.5 bg-zinc-700 hover:bg-zinc-500'
                    }`}
                    aria-label={`Go to slide ${index + 1}`}
                  />
                ))}
              </div>

              <div className="flex items-center space-x-2">
                {currentStep > 0 && (
                  <button
                    id="onboarding-prev-btn"
                    onClick={() => setCurrentStep((prev) => prev - 1)}
                    className="px-3.5 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white transition-all cursor-pointer"
                  >
                    Back
                  </button>
                )}

                {currentStep < ONBOARDING_STEPS.length - 1 ? (
                  <button
                    id="onboarding-next-btn"
                    onClick={() => setCurrentStep((prev) => prev + 1)}
                    className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200 transition-all cursor-pointer"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    id="onboarding-finish-btn"
                    onClick={onClose}
                    className="px-5 py-2 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200 transition-all cursor-pointer"
                  >
                    Get Started
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
