import React from 'react';
import {
  FileText,
  FileCode,
  FileArchive,
  FileAudio,
  FileVideo,
  FileImage,
  FileCheck,
  File,
} from 'lucide-react';

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
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const isImage =
    fileType.startsWith('image/') ||
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(extension);
  const isVideo =
    fileType.startsWith('video/') ||
    ['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(extension);
  const isAudio =
    fileType.startsWith('audio/') ||
    ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(extension);
  const isCode =
    ['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'html', 'css', 'go', 'rs', 'c', 'cpp', 'sh', 'sql', 'yaml', 'yml'].includes(extension);
  const isArchive =
    ['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(extension);
  const isPdf =
    fileType === 'application/pdf' || extension === 'pdf';

  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-10 h-10',
  };

  const containerSizes = {
    sm: 'w-7 h-7 rounded-lg',
    md: 'w-12 h-12 rounded-2xl',
    lg: 'w-20 h-20 rounded-3xl',
  };

  // If decrypted image dataUrl exists and is valid, show rich thumbnail!
  if (isImage && dataUrl && dataUrl.startsWith('data:image/')) {
    return (
      <div
        className={`${containerSizes[size]} overflow-hidden border border-white/20 bg-black/40 flex items-center justify-center relative flex-shrink-0 ${className}`}
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

  // Render distinctive icons
  let IconComponent = FileCheck;
  let iconColor = 'text-[#FF3B30]';

  if (isPdf) {
    IconComponent = FileText;
    iconColor = 'text-rose-500';
  } else if (isCode) {
    IconComponent = FileCode;
    iconColor = 'text-blue-400';
  } else if (isArchive) {
    IconComponent = FileArchive;
    iconColor = 'text-amber-400';
  } else if (isAudio) {
    IconComponent = FileAudio;
    iconColor = 'text-purple-400';
  } else if (isVideo) {
    IconComponent = FileVideo;
    iconColor = 'text-indigo-400';
  } else if (isImage) {
    IconComponent = FileImage;
    iconColor = 'text-emerald-400';
  }

  return (
    <div
      className={`${containerSizes[size]} bg-white/[0.04] border border-white/10 flex items-center justify-center flex-shrink-0 ${className}`}
    >
      <IconComponent className={`${sizeClasses[size]} ${iconColor}`} />
    </div>
  );
};
