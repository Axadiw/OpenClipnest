import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { RATE_LIMITED_EVENT, type RateLimitedDetail } from '../api';
import { useCountdown } from '../hooks/useCountdown';
import { formatDuration } from '../utils/format';

// How long the numberless fallback ("wait a moment") lingers. We have no real
// Retry-After to count down, so it behaves like an ordinary auto-dismissing
// toast rather than hanging around forever.
const GENERIC_MS = 6000;

/**
 * Global, self-contained notice for HTTP 429s. Listens for the
 * `clipnest:rate-limited` window event broadcast by the API client and shows
 * a ticking "try again in M:SS" countdown built from the `Retry-After` header.
 *
 * Mounted once in the authed shell — it covers every API call (the silent
 * `getVersion`/`getCameras` included) without each call site handling 429.
 * The message is deliberately uniform and only states the wait time: it never
 * reveals which limiter tripped or any remaining-budget figure, so it can't
 * become an account-enumeration / threshold oracle.
 */
export function RateLimitToast() {
  const { t } = useTranslation();
  const { remaining, active, start } = useCountdown();
  const [genericVisible, setGenericVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const onRateLimited = (e: Event) => {
      // A fresh limit always re-reveals the notice, even if the user dismissed
      // a previous one.
      setDismissed(false);
      const retryAfter = (e as CustomEvent<RateLimitedDetail>).detail?.retryAfter;
      if (typeof retryAfter === 'number' && retryAfter > 0) {
        start(retryAfter);
        setGenericVisible(false); // a real countdown supersedes the numberless note
      } else {
        setGenericVisible(true);
      }
    };
    window.addEventListener(RATE_LIMITED_EVENT, onRateLimited);
    return () => window.removeEventListener(RATE_LIMITED_EVENT, onRateLimited);
  }, [start]);

  useEffect(() => {
    if (!genericVisible) return;
    const id = window.setTimeout(() => setGenericVisible(false), GENERIC_MS);
    return () => window.clearTimeout(id);
  }, [genericVisible]);

  const showCountdown = active && !dismissed;
  const showGeneric = genericVisible && !active && !dismissed;
  if (!showCountdown && !showGeneric) return null;

  const message = showCountdown
    ? t('errors.rateLimited', { time: formatDuration(remaining) })
    : t('errors.rateLimitedShort');

  return (
    <div className="toast toast-warn toast-countdown" role="status" aria-live="polite">
      <span className="toast-msg">{message}</span>
      <button
        type="button"
        className="toast-close"
        onClick={() => { setDismissed(true); setGenericVisible(false); }}
        aria-label="Dismiss"
      >×</button>
    </div>
  );
}
