import React from 'react';
import {
  FileText,
  FileCode,
  FileArchive,
  FileAudio,
  FileVideo,
  FileImage,
  FileSpreadsheet,
  File,
} from 'lucide-react';
import { getFileTypeInfo } from '../lib/crypto';

interface FileIconPreviewProps {
  fileName?: string;
  fileType?: string;
  dataUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const FileIconPreview: React.FC<FileIconPreviewProps> = ({
  fileName = '',
  fileType = '',
  dataUrl,
  size = 'md',
  className = '',
}) => {
  const info = getFileTypeInfo(fileName, fileType);

  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-8 h-8',
  };

  const containerSizes = {
    sm: 'w-8 h-8 rounded-lg',
    md: 'w-12 h-12 rounded-xl',
    lg: 'w-16 h-16 rounded-2xl',
  };

  // If decrypted image dataUrl exists and is valid, show rich thumbnail
  if (info.category === 'image' && dataUrl && dataUrl.startsWith('data:image/')) {
    return (
      <div
        className={`${containerSizes[size]} overflow-hidden border border-white/10 bg-black/40 flex items-center justify-center relative flex-shrink-0 ${className}`}
      >
        <img
          src={dataUrl}
          alt={fileName}
          className="w-full h-full object-cover"
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }

  // Render distinctive icons based on resolved category
  let IconComponent = File;
  let iconColor = 'text-white/70';
  let bgColor = 'bg-white/[0.04] border-white/10';

  if (info.category === 'document') {
    if (fileName.endsWith('.xls') || fileName.endsWith('.xlsx') || fileName.endsWith('.csv')) {
      IconComponent = FileSpreadsheet;
      iconColor = 'text-emerald-400';
      bgColor = 'bg-emerald-500/10 border-emerald-500/20';
    } else {
      IconComponent = FileText;
      iconColor = 'text-red-400';
      bgColor = 'bg-red-500/10 border-red-500/20';
    }
  } else if (info.category === 'code') {
    IconComponent = FileCode;
    iconColor = 'text-blue-400';
    bgColor = 'bg-blue-500/10 border-blue-500/20';
  } else if (info.category === 'archive') {
    IconComponent = FileArchive;
    iconColor = 'text-amber-400';
    bgColor = 'bg-amber-500/10 border-amber-500/20';
  } else if (info.category === 'audio') {
    IconComponent = FileAudio;
    iconColor = 'text-purple-400';
    bgColor = 'bg-purple-500/10 border-purple-500/20';
  } else if (info.category === 'video') {
    IconComponent = FileVideo;
    iconColor = 'text-indigo-400';
    bgColor = 'bg-indigo-500/10 border-indigo-500/20';
  } else if (info.category === 'image') {
    IconComponent = FileImage;
    iconColor = 'text-teal-400';
    bgColor = 'bg-teal-500/10 border-teal-500/20';
  }

  return (
    <div
      className={`${containerSizes[size]} ${bgColor} border flex items-center justify-center flex-shrink-0 shadow-sm ${className}`}
    >
      <IconComponent className={`${sizeClasses[size]} ${iconColor}`} />
    </div>
  );
};
