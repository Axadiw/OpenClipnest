import { useEffect, useState } from 'react';

/** The shape Chrome/Edge dispatch on `beforeinstallprompt`. The Web App
 *  Manifest spec calls this `BeforeInstallPromptEvent` but the type
 *  isn't in lib.dom yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** PWA install state for the marketing/app chrome.
 *
 *  Three platforms to handle:
 *    1. Chrome/Edge desktop + Android Chrome — fire `beforeinstallprompt`,
 *       we capture the event and call `.prompt()` on click.
 *    2. iOS Safari — never fires `beforeinstallprompt`. The user has to
 *       use the share sheet → "Add to Home Screen". We detect iOS and
 *       expose a hint to render in the menu instead of a button.
 *    3. Already installed — `display-mode: standalone` matches when
 *       launched from the home-screen icon. Suppress everything.
 *
 *  Returns:
 *    - canPromptInstall: true when (1) is available and we haven't been
 *      installed yet. Render an install button.
 *    - showIosHint: true when on iOS Safari, not installed, and not
 *      already in standalone mode. Render a one-line hint in the menu.
 *    - install: triggers the saved prompt. After resolution clears
 *      canPromptInstall. */
export function usePwaInstall(): {
  canPromptInstall: boolean;
  showIosHint: boolean;
  install: () => Promise<void>;
} {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => {
    if (typeof window === 'undefined') return false;
    // matchMedia hits in iOS Safari + Android Chrome + desktop Chrome
    // when launched from the home-screen icon / installed app shell.
    return window.matchMedia?.('(display-mode: standalone)').matches
      // iOS Safari sets navigator.standalone instead of obeying the media query.
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  });

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const isIosSafari = (() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent;
    // iPad on iOS 13+ reports MacIntel; check maxTouchPoints to
    // disambiguate from a real Mac. iPhone always reports iPhone.
    const isIos = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIos) return false;
    // Filter out third-party iOS browsers (Chrome, Firefox, Edge on iOS
    // all use WebKit but their UA strings carry CriOS / FxiOS / EdgiOS).
    return !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua);
  })();

  return {
    canPromptInstall: !!promptEvent && !installed,
    showIosHint: isIosSafari && !installed,
    install: async () => {
      if (!promptEvent) return;
      try {
        await promptEvent.prompt();
        await promptEvent.userChoice;
      } finally {
        // Browsers fire beforeinstallprompt at most once per session;
        // null it whether the user accepted or dismissed so we don't
        // show a stale button.
        setPromptEvent(null);
      }
    },
  };
}
