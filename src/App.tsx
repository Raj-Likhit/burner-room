/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Navigation } from './components/Navigation';
import { PinDisplay } from './components/PinDisplay';
import { DropZone } from './components/DropZone';
import { PickupView } from './components/PickupView';
import { CountdownTimer } from './components/CountdownTimer';
import { Footer } from './components/Footer';
import { SpotlightOnboarding } from './components/SpotlightOnboarding';
import { OfflineBanner } from './components/OfflineBanner';
import { BurnerFileMetadata, EncryptedBundle, PayloadType, ShareMode, StoredSenderSession } from './types';
import { updateTabTitle, setFavicon } from './lib/favicon';
import { BurnerApi, normalizeApiError } from './lib/api';
import { Flame, ShieldCheck, Activity, CheckCircle2, AlertTriangle, ShieldAlert } from 'lucide-react';

const SESSION_STORAGE_KEY = 'burner_room_active_session_v2';

export default function App() {
  const [mode, setMode] = useState<'drop' | 'pickup'>('drop');
  const [pin, setPin] = useState<string>('----');
  const [senderToken, setSenderToken] = useState<string>('');
  const [ttlSeconds, setTtlSeconds] = useState<number>(600);
  const [expiresAt, setExpiresAt] = useState<number>(Date.now() + 600 * 1000);
  const [isUploaded, setIsUploaded] = useState<boolean>(false);
  const [uploadedType, setUploadedType] = useState<PayloadType | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | undefined>();
  const [uploadedFileSize, setUploadedFileSize] = useState<number | undefined>();
  const [uploadedTextPreview, setUploadedTextPreview] = useState<string | undefined>();
  const [shareMode, setShareMode] = useState<ShareMode>('burn_on_read');
  const [maxReads, setMaxReads] = useState<number | undefined>();
  const [e2eKeyString, setE2eKeyString] = useState<string | undefined>();
  const [liveReadCount, setLiveReadCount] = useState<number>(0);
  const [lastEventMessage, setLastEventMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [burnedNotice, setBurnedNotice] = useState<string | null>(null);
  const [isFileDeleted, setIsFileDeleted] = useState<boolean>(false);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(false);
  const [isOffline, setIsOffline] = useState<boolean>(!navigator.onLine);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Online / Offline network event listeners
  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      updateTabTitle(isUploaded ? 'armed' : 'idle', pin);
    };
    const handleOffline = () => {
      setIsOffline(true);
      updateTabTitle('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [isUploaded, pin]);

  // Dynamic Browser Tab Title & Favicon synchronization
  useEffect(() => {
    if (isOffline) {
      updateTabTitle('offline');
      return;
    }
    if (burnedNotice) {
      updateTabTitle('burned');
      return;
    }
    if (isUploaded && pin && pin !== '----') {
      const remainingSecs = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      updateTabTitle('armed', pin, remainingSecs);
    } else {
      updateTabTitle('idle');
    }
  }, [isUploaded, pin, expiresAt, burnedNotice, isOffline]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if typing in an input or textarea
      const target = e.target as HTMLElement;
      const isInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMode((prev) => (prev === 'drop' ? 'pickup' : 'drop'));
      } else if (e.altKey && e.key.toLowerCase() === 'n' && !isUploaded) {
        e.preventDefault();
        fetchNewSession();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isUploaded]);

  // Fetch or generate fresh session PIN from server
  const fetchNewSession = useCallback(async (customTtl?: number, requestedCustomPin?: string) => {
    setIsLoading(true);
    const activeTtl = customTtl || ttlSeconds;
    sessionStorage.removeItem(SESSION_STORAGE_KEY);

    try {
      const data = await BurnerApi.createSession(activeTtl, requestedCustomPin);
      setPin(data.pin);
      setSenderToken(data.senderToken);
      setExpiresAt(data.expiresAt);
      if (data.ttlSeconds) {
        setTtlSeconds(data.ttlSeconds);
      }
      setIsUploaded(false);
      setIsFileDeleted(false);
      setUploadedType(null);
      setUploadedFileName(undefined);
      setUploadedFileSize(undefined);
      setUploadedTextPreview(undefined);
      setE2eKeyString(undefined);
      setLiveReadCount(0);
      setLastEventMessage(null);
      setBurnedNotice(null);
    } catch (e) {
      console.error('Failed to fetch new session', e);
      const localPin = requestedCustomPin || Math.floor(1000 + Math.random() * 9000).toString();
      setPin(localPin);
      setSenderToken(Math.random().toString(36).substring(2));
      setExpiresAt(Date.now() + activeTtl * 1000);
    } finally {
      setIsLoading(false);
    }
  }, [ttlSeconds]);

  // Restore sender session from sessionStorage if present (Sender-side reconnect QoL)
  useEffect(() => {
    let restored = false;
    try {
      const saved = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (saved) {
        const parsed: StoredSenderSession = JSON.parse(saved);
        if (parsed.expiresAt > Date.now()) {
          setPin(parsed.pin);
          setSenderToken(parsed.senderToken);
          setExpiresAt(parsed.expiresAt);
          setTtlSeconds(parsed.ttlSeconds);
          setIsUploaded(parsed.isUploaded);
          setUploadedType(parsed.uploadedType || null);
          setUploadedFileName(parsed.uploadedFileName);
          setUploadedFileSize(parsed.uploadedFileSize);
          setUploadedTextPreview(parsed.uploadedTextPreview);
          setShareMode(parsed.shareMode);
          setMaxReads(parsed.maxReads);
          setE2eKeyString(parsed.e2eKeyString);
          restored = true;
        } else {
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
        }
      }
    } catch {
      // ignore
    }

    if (!restored) {
      fetchNewSession();
    }
  }, [fetchNewSession]);

  // Save active session state whenever it updates
  useEffect(() => {
    if (isUploaded && pin !== '----' && senderToken && expiresAt > Date.now()) {
      const sessionState: StoredSenderSession = {
        pin,
        senderToken,
        expiresAt,
        ttlSeconds,
        isUploaded,
        uploadedType: uploadedType || undefined,
        uploadedFileName,
        uploadedFileSize,
        uploadedTextPreview,
        shareMode,
        maxReads,
        e2eKeyString,
      };
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionState));
    }
  }, [
    isUploaded,
    pin,
    senderToken,
    expiresAt,
    ttlSeconds,
    uploadedType,
    uploadedFileName,
    uploadedFileSize,
    uploadedTextPreview,
    shareMode,
    maxReads,
    e2eKeyString,
  ]);

  // Check URL query parameters for direct ?pin=4921 pairing and check first-time visitor status
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const queryPin = urlParams.get('pin');
    if (queryPin && queryPin.length === 4) {
      setMode('pickup');
    }

    try {
      const hasSeenOnboarding = localStorage.getItem('burner_has_seen_onboarding');
      if (!hasSeenOnboarding && !queryPin) {
        setShowOnboarding(true);
      }
    } catch {
      // LocalStorage fallback
    }
  }, []);

  // Real-Time Server-Sent Events (SSE) listener for active uploaded sessions
  useEffect(() => {
    if (!isUploaded || !pin || pin === '----' || !senderToken) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Connect to SSE stream
    const sseUrl = `/api/events/${pin}?senderToken=${senderToken}`;
    const es = new EventSource(sseUrl);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pickup') {
          setLiveReadCount(data.readCount || 1);
          if (data.isBurned) {
            setIsFileDeleted(true);
            setLastEventMessage('File has been deleted.');
            setBurnedNotice('File has been deleted.');
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
          } else {
            setLastEventMessage(`Recipient downloaded transfer (${data.readCount} times).`);
          }
        } else if (data.type === 'burned' || data.isBurned || data.message === 'File has been deleted.') {
          setIsFileDeleted(true);
          setLastEventMessage('File has been deleted.');
          setBurnedNotice('File has been deleted.');
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
        } else if (data.type === 'expired') {
          setIsFileDeleted(true);
          setBurnedNotice('File has been deleted.');
          setLastEventMessage('File has been deleted.');
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
        }
      } catch (err) {
        console.error('SSE parse error', err);
      }
    };

    es.onerror = () => {
      es.close();
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [isUploaded, pin, senderToken]);

  const handleCloseOnboarding = () => {
    setShowOnboarding(false);
    try {
      localStorage.setItem('burner_has_seen_onboarding', 'true');
    } catch {
      // ignore
    }
  };

  const handleOpenOnboarding = () => {
    setShowOnboarding(true);
  };

  const handleTtlChange = (newTtl: number) => {
    const clamped = Math.min(3600, Math.max(60, newTtl));
    setTtlSeconds(clamped);
    if (!isUploaded) {
      setExpiresAt(Date.now() + clamped * 1000);
    }
  };

  useEffect(() => {
    if (!isUploaded && pin === '----') {
      fetchNewSession();
    }
  }, [isUploaded, pin, fetchNewSession]);

  // Handle Drop action
  const handleDropPayload = async (
    type: PayloadType,
    textContent?: string,
    fileMeta?: BurnerFileMetadata,
    modeSetting?: ShareMode,
    ttlSetting?: number,
    encryptedBundle?: EncryptedBundle,
    e2eKeyStr?: string,
    maxReadsSetting?: number,
    customPin?: string
  ) => {
    setIsLoading(true);
    const activeShareMode = modeSetting || shareMode;
    const activeTtl = ttlSetting || ttlSeconds;
    const activeMaxReads = maxReadsSetting || maxReads;
    const activePin = customPin || pin;

    try {
      const data = await BurnerApi.dropPayload({
        pin: activePin,
        senderToken,
        type,
        shareMode: activeShareMode,
        maxReads: activeMaxReads,
        ttlSeconds: activeTtl,
        textContent,
        file: fileMeta,
        encryptedBundle,
      });

      if (data.success) {
        setPin(activePin);
        setIsUploaded(true);
        setUploadedType(type);
        setShareMode(activeShareMode);
        setMaxReads(activeMaxReads);
        setTtlSeconds(activeTtl);
        setUploadedFileName(fileMeta?.name);
        setUploadedFileSize(fileMeta?.size);
        setUploadedTextPreview(textContent);
        if (e2eKeyStr) {
          setE2eKeyString(e2eKeyStr);
        }
        if (data.senderToken) {
          setSenderToken(data.senderToken);
        }
        if (data.expiresAt) {
          setExpiresAt(data.expiresAt);
        }
      }
    } catch (e: any) {
      const normalized = normalizeApiError(e);
      console.error('Drop failed', normalized);
      throw normalized;
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Manual Burn from Sender (Protected with senderToken)
  const handleManualBurn = async () => {
    setIsLoading(true);
    try {
      const data = await BurnerApi.burnPayload(pin, senderToken);
      if (data.success) {
        setIsFileDeleted(true);
        setBurnedNotice('File has been deleted.');
        setLastEventMessage('File has been deleted.');
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch (e: any) {
      const normalized = normalizeApiError(e);
      console.error('Burn failed', normalized);
    } finally {
      setIsLoading(false);
    }
  };

  // When timer expires
  const handleTimerExpire = () => {
    if (isUploaded) {
      setIsFileDeleted(true);
      setBurnedNotice('File has been deleted.');
      setLastEventMessage('File has been deleted.');
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  };

  return (
    <div className="min-h-[100dvh] w-full bg-[#0D0D0D] text-[#F5F5F5] flex flex-col font-sans select-none antialiased">
      {/* Offline Status Banner */}
      <OfflineBanner isOffline={isOffline} onRetry={() => window.location.reload()} />

      {/* Top Header Nav */}
      <Navigation
        mode={mode}
        setMode={setMode}
        onOpenOnboarding={handleOpenOnboarding}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-12 py-8 sm:py-16">
        <div className="w-full max-w-3xl flex flex-col items-center space-y-8 sm:space-y-12">
          <AnimatePresence mode="wait">
            {mode === 'drop' ? (
              <motion.div
                key="drop-mode"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="w-full flex flex-col items-center space-y-6 sm:space-y-10"
              >
                {/* Centerpiece 4-Digit Transfer Code */}
                <PinDisplay
                  pin={pin}
                  e2eKeyString={e2eKeyString}
                  onRefreshPin={() => fetchNewSession()}
                  isLocked={isUploaded}
                  subtitle={isFileDeleted ? 'Transfer Completed' : (isUploaded ? 'Active Transfer Code' : 'Transfer Code')}
                />

                {/* Status Notice Banner if active and not already in deleted card */}
                {burnedNotice && !isFileDeleted && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.2 }}
                    className="p-3 px-5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs flex items-center space-x-2 shadow-md"
                  >
                    <span>{burnedNotice}</span>
                  </motion.div>
                )}

                {/* Send / Upload State */}
                <DropZone
                  pin={pin}
                  senderToken={senderToken}
                  isUploaded={isUploaded}
                  isFileDeleted={isFileDeleted}
                  uploadedType={uploadedType}
                  uploadedFileName={uploadedFileName}
                  uploadedFileSize={uploadedFileSize}
                  uploadedTextPreview={uploadedTextPreview}
                  shareMode={shareMode}
                  setShareMode={setShareMode}
                  maxReads={maxReads}
                  setMaxReads={setMaxReads}
                  ttlSeconds={ttlSeconds}
                  setTtlSeconds={handleTtlChange}
                  e2eKeyString={e2eKeyString}
                  setE2eKeyString={setE2eKeyString}
                  liveReadCount={liveReadCount}
                  lastEventMessage={lastEventMessage}
                  onDropPayload={handleDropPayload}
                  onManualBurn={handleManualBurn}
                  onReset={() => fetchNewSession()}
                  isLoading={isLoading}
                />

                {/* Expiry Timer - Active once uploaded and not deleted */}
                {isUploaded && !isFileDeleted && (
                  <CountdownTimer
                    expiresAt={expiresAt}
                    totalDurationSeconds={ttlSeconds}
                    onExpire={handleTimerExpire}
                    label="Expires in"
                  />
                )}
              </motion.div>
            ) : (
              <motion.div
                key="pickup-mode"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="w-full flex flex-col items-center"
              >
                <PickupView
                  initialPin={new URLSearchParams(window.location.search).get('pin') || ''}
                  initialKey={window.location.hash.replace('#key=', '')}
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

      {/* Skippable Spotlight Guided Tour for First Time Visitors */}
      <SpotlightOnboarding
        isOpen={showOnboarding}
        onClose={handleCloseOnboarding}
      />

      {/* Persistent Minimalist Footer */}
      <Footer />
    </div>
  );
}
