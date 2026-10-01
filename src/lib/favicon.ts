/**
 * Dynamic document title and favicon badge manager
 */

let originalTitle = 'Burner Room — Private & Temporary File Sharing';

/**
 * Set document title with dynamic prefix
 */
export function updateTabTitle(
  state: 'idle' | 'armed' | 'burned' | 'expired' | 'offline',
  pin?: string,
  remainingSeconds?: number
) {
  if (typeof document === 'undefined') return;

  if (state === 'offline') {
    document.title = `[Offline] Burner Room`;
    return;
  }

  if (state === 'burned') {
    document.title = `Deleted — Burner Room`;
    setFavicon('burned');
    return;
  }

  if (state === 'expired') {
    document.title = `Expired — Burner Room`;
    setFavicon('burned');
    return;
  }

  if (state === 'armed' && pin) {
    if (typeof remainingSeconds === 'number' && remainingSeconds > 0) {
      const mins = Math.floor(remainingSeconds / 60);
      const secs = remainingSeconds % 60;
      const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      document.title = `[${timeStr}] Code ${pin} — Burner Room`;
    } else {
      document.title = `Code ${pin} — Burner Room`;
    }
    setFavicon('armed');
    return;
  }

  document.title = originalTitle;
  setFavicon('normal');
}

/**
 * Dynamically generate a canvas-based SVG/PNG favicon badge
 */
export function setFavicon(type: 'normal' | 'armed' | 'burned') {
  if (typeof document === 'undefined') return;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 32, 32);

    if (type === 'armed') {
      // Glowing Red Circle
      ctx.fillStyle = '#0D0D0D';
      ctx.beginPath();
      ctx.arc(16, 16, 15, 0, 2 * Math.PI);
      ctx.fill();

      ctx.strokeStyle = '#FF3B30';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#FF3B30';
      ctx.beginPath();
      ctx.arc(16, 16, 7, 0, 2 * Math.PI);
      ctx.fill();
    } else if (type === 'burned') {
      // Gray/Ash Extinguished Dot
      ctx.fillStyle = '#1A1A1A';
      ctx.beginPath();
      ctx.arc(16, 16, 15, 0, 2 * Math.PI);
      ctx.fill();

      ctx.strokeStyle = '#555555';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#777777';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✕', 16, 16);
    } else {
      // Normal Fire Red Flame icon
      ctx.fillStyle = '#FF3B30';
      ctx.beginPath();
      ctx.arc(16, 16, 14, 0, 2 * Math.PI);
      ctx.fill();
    }

    let link: HTMLLinkElement | null = document.querySelector("link[rel*='icon']");
    if (!link) {
      link = document.createElement('link');
      link.type = 'image/x-icon';
      link.rel = 'shortcut icon';
      document.getElementsByTagName('head')[0].appendChild(link);
    }
    link.href = canvas.toDataURL('image/png');
  } catch {
    // Ignore canvas security or head element errors
  }
}
