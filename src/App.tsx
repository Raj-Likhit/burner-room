/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Navigation } from './components/Navigation';
import { PinDisplay } from './components/PinDisplay';
import { DropZone } from './components/DropZone';
import { PickupView } from './components/PickupView';
import { CountdownTimer } from './components/CountdownTimer';
import { Footer } from './components/Footer';
import { BurnerFileMetadata, PayloadType, ShareMode } from './types';
import { Flame } from 'lucide-react';

export default function App() {
  const [mode, setMode] = useState<'drop' | 'pickup'>('drop');
  const [pin, setPin] = useState<string>('----');
  const [ttlSeconds, setTtlSeconds] = useState<number>(600);
  const [expiresAt, setExpiresAt] = useState<number>(Date.now() + 600 * 1000);
  const [isUploaded, setIsUploaded] = useState<boolean>(false);
  const [uploadedType, setUploadedType] = useState<PayloadType | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | undefined>();
  const [uploadedFileSize, setUploadedFileSize] = useState<number | undefined>();
  const [uploadedTextPreview, setUploadedTextPreview] = useState<string | undefined>();
  const [shareMode, setShareMode] = useState<ShareMode>('burn_on_read');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [burnedNotice, setBurnedNotice] = useState<string | null>(null);

  // Check URL query parameters for direct ?pin=4921 pairing
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const queryPin = urlParams.get('pin');
    if (queryPin && queryPin.length === 4) {
      setMode('pickup');
    }
  }, []);

  // Fetch or generate fresh session PIN from server
  const fetchNewSession = useCallback(async (customTtl?: number) => {
    setIsLoading(true);
    const activeTtl = customTtl || ttlSeconds;
    try {
      const res = await fetch(`/api/session?ttl=${activeTtl}`);
      if (res.ok) {
        const data = await res.json();
        setPin(data.pin);
        setExpiresAt(data.expiresAt);
        if (data.ttlSeconds) {
          setTtlSeconds(data.ttlSeconds);
        }
        setIsUploaded(false);
        setUploadedType(null);
        setUploadedFileName(undefined);
        setUploadedFileSize(undefined);
        setUploadedTextPreview(undefined);
        setBurnedNotice(null);
      }
    } catch (e) {
      console.error('Failed to fetch new session', e);
      // Fallback local PIN
      const localPin = Math.floor(1000 + Math.random() * 9000).toString();
      setPin(localPin);
      setExpiresAt(Date.now() + activeTtl * 1000);
    } finally {
      setIsLoading(false);
    }
  }, [ttlSeconds]);

  const handleTtlChange = (newTtl: number) => {
    const clamped = Math.min(3600, Math.max(60, newTtl));
    setTtlSeconds(clamped);
    if (!isUploaded) {
      setExpiresAt(Date.now() + clamped * 1000);
    }
  };

  useEffect(() => {
    fetchNewSession();
  }, []);

  // Handle Drop action
  const handleDropPayload = async (
    type: PayloadType,
    textContent?: string,
    fileMeta?: BurnerFileMetadata,
    modeSetting?: ShareMode,
    ttlSetting?: number
  ) => {
    setIsLoading(true);
    const activeShareMode = modeSetting || shareMode;
    const activeTtl = ttlSetting || ttlSeconds;
    try {
      const res = await fetch('/api/drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          type,
          shareMode: activeShareMode,
          ttlSeconds: activeTtl,
          textContent,
          file: fileMeta,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setIsUploaded(true);
        setUploadedType(type);
        setShareMode(activeShareMode);
        setTtlSeconds(activeTtl);
        setUploadedFileName(fileMeta?.name);
        setUploadedFileSize(fileMeta?.size);
        setUploadedTextPreview(textContent);
        if (data.expiresAt) {
          setExpiresAt(data.expiresAt);
        }
      } else {
        alert(data.error || 'Failed to upload payload.');
      }
    } catch (e) {
      console.error('Drop failed', e);
      alert('Error uploading payload.');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Manual Burn from Sender
  const handleManualBurn = async () => {
    setIsLoading(true);
    try {
      await fetch('/api/burn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      setBurnedNotice('Payload destroyed immediately.');
      setTimeout(() => {
        fetchNewSession();
      }, 1500);
    } catch (e) {
      console.error('Burn failed', e);
    } finally {
      setIsLoading(false);
    }
  };

  // When timer expires
  const handleTimerExpire = () => {
    if (isUploaded) {
      setBurnedNotice('TTL Expired: Payload incinerated automatically.');
      setTimeout(() => {
        fetchNewSession();
      }, 2000);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#0D0D0D] text-[#F5F5F5] flex flex-col font-sans select-none">
      {/* Top Header Nav */}
      <Navigation mode={mode} setMode={setMode} />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-12 py-10 sm:py-16">
        <div className="w-full max-w-3xl flex flex-col items-center space-y-12 sm:space-y-16">
          <AnimatePresence mode="wait">
            {mode === 'drop' ? (
              <motion.div
                key="drop-mode"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.25 }}
                className="w-full flex flex-col items-center space-y-12 sm:space-y-16"
              >
                {/* Centerpiece 4-Digit Session PIN */}
                <PinDisplay
                  pin={pin}
                  onRefreshPin={() => fetchNewSession()}
                  isLocked={isUploaded}
                  subtitle={isUploaded ? 'Active Uplink Key' : 'Session Access Key'}
                />

                {/* Burn Notice Banner if active */}
                {burnedNotice && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="p-3 px-6 rounded-xl bg-[#FF3B30]/10 border border-[#FF3B30]/30 text-[#FF3B30] text-xs flex items-center space-x-2 font-mono"
                  >
                    <Flame className="w-4 h-4 animate-pulse" />
                    <span>{burnedNotice}</span>
                  </motion.div>
                )}

                {/* Dropzone / Upload State */}
                <DropZone
                  pin={pin}
                  isUploaded={isUploaded}
                  uploadedType={uploadedType}
                  uploadedFileName={uploadedFileName}
                  uploadedFileSize={uploadedFileSize}
                  uploadedTextPreview={uploadedTextPreview}
                  shareMode={shareMode}
                  setShareMode={setShareMode}
                  ttlSeconds={ttlSeconds}
                  setTtlSeconds={handleTtlChange}
                  onDropPayload={handleDropPayload}
                  onManualBurn={handleManualBurn}
                  onReset={() => fetchNewSession()}
                  isLoading={isLoading}
                />

                {/* Self-Destruct Sequence Timer */}
                <CountdownTimer
                  expiresAt={expiresAt}
                  totalDurationSeconds={ttlSeconds}
                  onExpire={handleTimerExpire}
                  label={isUploaded ? 'Auto-Purge Countdown' : 'Session TTL Sequence'}
                />
              </motion.div>
            ) : (
              <motion.div
                key="pickup-mode"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.25 }}
                className="w-full flex flex-col items-center"
              >
                <PickupView
                  initialPin={new URLSearchParams(window.location.search).get('pin') || ''}
                  onPickupSuccess={(payload) => {
                    console.log('Payload retrieved:', payload);
                  }}
                  onReturnToDrop={() => {
                    setMode('drop');
                    fetchNewSession();
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Persistent Minimalist Footer */}
      <Footer />
    </div>
  );
}
