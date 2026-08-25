import React from 'react';
import { Flame, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';

interface NavigationProps {
  mode: 'drop' | 'pickup';
  setMode: (mode: 'drop' | 'pickup') => void;
}

export const Navigation: React.FC<NavigationProps> = ({ mode, setMode }) => {
  return (
    <nav className="w-full flex justify-between items-center px-6 sm:px-12 py-6 sm:py-8 border-b border-white/[0.05] bg-[#0D0D0D]/80 backdrop-blur-sm sticky top-0 z-30">
      {/* Brand Title */}
      <div className="flex items-center space-x-3">
        <div className="w-8 h-8 rounded-xl bg-white/[0.04] border border-white/10 flex items-center justify-center">
          <Flame className="w-4 h-4 text-[#FF3B30]" />
        </div>
        <div className="flex flex-col">
          <h1 className="text-[13px] sm:text-[14px] uppercase tracking-[0.4em] font-light text-white leading-none">
            Burner Room
          </h1>
          <span className="text-[9px] uppercase tracking-[0.25em] text-white/30 font-mono mt-1">
            Zero-Persistence Sharing
          </span>
        </div>
      </div>

      {/* Mode Switcher Buttons */}
      <div className="flex items-center space-x-1 sm:space-x-2 bg-white/[0.03] border border-white/10 p-1 rounded-xl">
        <button
          id="nav-tab-drop"
          onClick={() => setMode('drop')}
          className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-[10px] uppercase tracking-[0.2em] font-medium transition-all cursor-pointer ${
            mode === 'drop'
              ? 'bg-white text-black font-semibold shadow-sm'
              : 'text-white/50 hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <ArrowUpFromLine className="w-3 h-3" />
          <span>Drop</span>
        </button>
        <button
          id="nav-tab-pickup"
          onClick={() => setMode('pickup')}
          className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-[10px] uppercase tracking-[0.2em] font-medium transition-all cursor-pointer ${
            mode === 'pickup'
              ? 'bg-[#FF3B30] text-white font-semibold shadow-[0_0_12px_rgba(255,59,48,0.4)]'
              : 'text-white/50 hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <ArrowDownToLine className="w-3 h-3" />
          <span>Pickup</span>
        </button>
      </div>
    </nav>
  );
};

