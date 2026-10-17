import { memo, useCallback, useEffect, useState } from 'react';
import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS, pl, de, fr, it, es, nb } from 'date-fns/locale';
import { useTranslation } from '../i18n';
import { forRelativeTime } from '../utils/format';

interface Props {
  timestamp: string;
  timezone?: string;
}

const localeMap: Record<string, Locale> = { pl, de, fr, it, es, no: nb };

// "X minutes ago" doesn't need to update on every parent re-render. The
// grid renders ~50 of these and `forRelativeTime` constructs an
// `Intl.DateTimeFormat` each call — that combo showed up as 22% main-thread
// CPU on the 2026-05-15 flame chart even with the tab idle. This component
// computes the label once on mount and schedules a single `setTimeout` to
// the moment the displayed text would next change, so a card mounted at
// "5 minutes ago" only re-renders ~60s later (not on every parent tick).
//
// `memo` wraps the export so a re-rendering parent doesn't reach in here at
// all — the component owns its own update cadence keyed on timestamp.
function pickRefreshMs(ageMs: number): number | null {
  if (ageMs < 60_000) return 10_000;         // <1min: tick every 10s so seconds visibly move
  if (ageMs < 3_600_000) return 60_000;      // <1h: tick every minute
  if (ageMs < 86_400_000) return 300_000;    // <24h: tick every 5 minutes
  return null;                                // >=24h: label won't change today, stop ticking
}

function RelativeTimeInner({ timestamp, timezone = 'UTC' }: Props) {
  const { language } = useTranslation();
  const locale = localeMap[language] || enUS;

  const compute = useCallback(() => {
    try {
      return formatDistanceToNow(forRelativeTime(timestamp, timezone), { addSuffix: true, locale });
    } catch {
      return '';
    }
  }, [timestamp, timezone, locale]);

  const [text, setText] = useState(compute);

  // Self-rescheduling tick. The first attempt at this hook put `text` in the
  // effect dep array, which React 18 strict mode flagged as
  // "Maximum update depth exceeded" — even though primitive setState bails
  // out on equal values, the rendezvous still trips the safety check and
  // shows up in CI as a slow run that times out. The `tick()` closure now
  // owns its own clock: it sets text, recomputes the next delay from a fresh
  // `Date.now()`, and queues itself. Cleanup cancels via the `cancelled`
  // flag + the live `timerId`. Effect re-fires only when the actual inputs
  // change (timestamp / language).
  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof window.setTimeout> | undefined;
    const tick = () => {
      if (cancelled) return;
      setText(compute());
      const ageMs = Date.now() - new Date(timestamp).getTime();
      const delay = pickRefreshMs(Math.max(0, ageMs));
      if (delay === null) return;
      timerId = window.setTimeout(tick, delay);
    };
    tick();
    return () => {
      cancelled = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [timestamp, compute]);

  return <>{text}</>;
}

export const RelativeTime = memo(RelativeTimeInner);
