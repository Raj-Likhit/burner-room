import React from 'react';
import { Flame, Download, Upload, HelpCircle } from 'lucide-react';

interface NavigationProps {
  mode: 'drop' | 'pickup';
  setMode: (mode: 'drop' | 'pickup') => void;
  onOpenOnboarding?: () => void;
}

export const Navigation: React.FC<NavigationProps> = ({ mode, setMode, onOpenOnboarding }) => {
  return (
    <nav className="w-full flex justify-between items-center px-6 sm:px-12 py-5 sm:py-6 border-b border-zinc-800/80 bg-[#0D0D0D]/90 backdrop-blur-md sticky top-0 z-30">
      {/* Brand Title */}
      <div className="flex items-center space-x-3">
        <div className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner">
          <Flame className="w-4 h-4 text-[#FF3B30]" />
        </div>
        <div className="flex flex-col">
          <h1 className="text-sm font-semibold tracking-wide text-white leading-tight">
            Burner Room
          </h1>
          <span className="text-[11px] text-zinc-500 font-normal">
            Private & Temporary File Sharing
          </span>
        </div>
      </div>

      {/* Mode Switcher & Help Button */}
      <div className="flex items-center space-x-2 sm:space-x-3">
        {onOpenOnboarding && (
          <button
            id="nav-onboarding-btn"
            onClick={onOpenOnboarding}
            title="How it works"
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all text-xs font-medium cursor-pointer"
          >
            <HelpCircle className="w-3.5 h-3.5 text-zinc-400" />
            <span className="hidden sm:inline">How it works</span>
          </button>
        )}

        <div className="flex items-center space-x-1 bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          <button
            id="nav-tab-drop"
            onClick={() => setMode('drop')}
            className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              mode === 'drop'
                ? 'bg-zinc-800 text-white font-semibold shadow-sm'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Send</span>
          </button>
          <button
            id="nav-tab-pickup"
            onClick={() => setMode('pickup')}
            className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              mode === 'pickup'
                ? 'bg-white text-black font-semibold shadow-sm'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>Receive</span>
          </button>
        </div>
      </div>
    </nav>
  );
};
