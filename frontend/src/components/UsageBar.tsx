import { formatBytes } from '../utils/format';

interface Props {
  label: string;
  usageBytes: number;
  limitBytes: number;
  percent: number;
  resetAt?: string | null;
  resetLabel?: string;
  /** Shown instead of the limit when `limitBytes <= 0` (no plan ⇒ unlimited). */
  unlimitedLabel?: string;
}

function getBarColor(percent: number): string {
  if (percent >= 100) return 'var(--usage-red, #e53e3e)';
  if (percent >= 80) return 'var(--usage-orange, #dd6b20)';
  if (percent >= 60) return 'var(--usage-yellow, #d69e2e)';
  return 'var(--usage-green, #38a169)';
}

export function UsageBar({ label, usageBytes, limitBytes, percent, resetAt, resetLabel, unlimitedLabel }: Props) {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  // A limit of 0 means "no limit" everywhere on the server (plan_id NULL) —
  // show plain usage and no fill/percentage rather than "X / 0 B, 0%".
  const unlimited = limitBytes <= 0;

  return (
    <div className="usage-bar-container">
      <div className="usage-bar-header">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-values">
          {unlimited
            ? (unlimitedLabel ? `${formatBytes(usageBytes)} · ${unlimitedLabel}` : formatBytes(usageBytes))
            : `${formatBytes(usageBytes)} / ${formatBytes(limitBytes)}`}
        </span>
      </div>
      {!unlimited && (
        <div className="usage-bar-track">
          <div
            className="usage-bar-fill"
            style={{ width: `${clampedPercent}%`, backgroundColor: getBarColor(percent) }}
          />
        </div>
      )}
      <div className="usage-bar-footer">
        {!unlimited && <span className="usage-bar-percent">{percent}%</span>}
        {resetAt && resetLabel && (
          <span className="usage-bar-reset">{resetLabel}: {new Date(resetAt).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  );
}
