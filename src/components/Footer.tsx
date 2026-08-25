import React from 'react';

export const Footer: React.FC = () => {
  return (
    <footer className="w-full px-6 sm:px-12 py-8 sm:py-10 flex flex-col sm:flex-row justify-between items-start sm:items-end gap-6 border-t border-white/[0.05] bg-[#0D0D0D] select-none">
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-widest text-white/30">Architecture</p>
        <p className="text-[11px] font-light text-white/60 uppercase tracking-wider">
          Zero-Persistence / Read-Once
        </p>
      </div>

      <div className="flex space-x-8 sm:space-x-12">
        <div className="space-y-1 sm:text-right">
          <p className="text-[10px] uppercase tracking-widest text-white/30">Storage</p>
          <p className="text-[11px] font-light text-white/60 uppercase tracking-wider">
            Vercel KV — In-Memory
          </p>
        </div>
        <div className="space-y-1 sm:text-right">
          <p className="text-[10px] uppercase tracking-widest text-white/30">Security</p>
          <p className="text-[11px] font-light text-white/60 uppercase tracking-wider">
            AES-GCM 256-Bit
          </p>
        </div>
      </div>
    </footer>
  );
};
