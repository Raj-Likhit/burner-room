import React from 'react';

export const Footer: React.FC = () => {
  return (
    <footer className="w-full px-6 sm:px-12 py-6 sm:py-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-t border-zinc-800/80 bg-[#0D0D0D] text-xs text-zinc-500 select-none">
      <div>
        <p className="text-zinc-400 font-medium">Burner Room</p>
        <p className="text-zinc-500 text-[11px] mt-0.5">Files and notes are automatically deleted after download or expiry.</p>
      </div>

      <div className="flex items-center space-x-6 text-[11px]">
        <span>End-to-End Encrypted</span>
        <span>•</span>
        <span>No Account Required</span>
        <span>•</span>
        <span>Private & Temporary</span>
      </div>
    </footer>
  );
};
