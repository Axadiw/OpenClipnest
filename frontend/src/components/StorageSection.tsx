import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useTranslation } from '../i18n';
import { paletteForCameras } from '../lib/cameraColors';
import { formatBytes } from '../utils/format';
import { UsageBar } from './UsageBar';

interface Usage {
  disk: { usageBytes: number; limitBytes: number; percent: number };
  transfer: { usageBytes: number; limitBytes: number; percent: number; resetAt: string | null };
}

interface CameraUsage {
  cameraName: string;
  bytes: number;
  durationSeconds: number;
  eventCount: number;
}

const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_SAVE_DEBOUNCE_MS = 600;
const RETENTION_MIN = 1;
const RETENTION_MAX = 365;

export function StorageSection() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cameraUsage, setCameraUsage] = useState<CameraUsage[] | null>(null);
  const [autoDelete, setAutoDelete] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null | undefined>(undefined);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const retentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.getUsage().then(setUsage).catch(() => setUsage(null));
    api.getUsageByCamera().then(r => setCameraUsage(r.cameras)).catch(() => setCameraUsage([]));
    api.getAutoDelete().then(r => setAutoDelete(r.enabled)).catch(() => setAutoDelete(null));
    api.getAutoDeleteAfterDays().then(r => setRetentionDays(r.days)).catch(() => setRetentionDays(null));
  }, []);

  // Camera color map — same djb2 palette the Timeline uses, so the
  // breakdown bar matches the colors a user already associates with each
  // camera elsewhere in the app.
  const cameraColors = useMemo(
    () => paletteForCameras((cameraUsage ?? []).map(c => c.cameraName)),
    [cameraUsage],
  );

  // Cancel any pending retention save when the component unmounts so we don't
  // fire a stale request after the user navigates away.
  useEffect(() => () => {
    if (retentionTimerRef.current) clearTimeout(retentionTimerRef.current);
  }, []);

  const toggle = async (next: boolean) => {
    if (autoDelete === null) return;
    setSaving(true);
    try {
      await api.setAutoDelete(next);
      setAutoDelete(next);
    } finally {
      setSaving(false);
    }
  };

  const persistRetention = (next: number | null) => {
    if (retentionTimerRef.current) clearTimeout(retentionTimerRef.current);
    retentionTimerRef.current = setTimeout(async () => {
      setRetentionSaving(true);
      try {
        await api.setAutoDeleteAfterDays(next);
      } finally {
        setRetentionSaving(false);
      }
    }, RETENTION_SAVE_DEBOUNCE_MS);
  };

  const toggleRetention = (next: boolean) => {
    if (retentionDays === undefined) return;
    if (next) {
      const value = retentionDays ?? DEFAULT_RETENTION_DAYS;
      setRetentionDays(value);
      persistRetention(value);
    } else {
      setRetentionDays(null);
      persistRetention(null);
    }
  };

  const onRetentionDaysChange = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(RETENTION_MIN, Math.min(RETENTION_MAX, parsed));
    setRetentionDays(clamped);
    persistRetention(clamped);
  };

  const bumpRetentionDays = (delta: number) => {
    if (typeof retentionDays !== 'number') return;
    const next = Math.max(RETENTION_MIN, Math.min(RETENTION_MAX, retentionDays + delta));
    if (next === retentionDays) return;
    setRetentionDays(next);
    persistRetention(next);
  };

  return (
    <div className="settings-storage">
      {usage && (
        <>
          <UsageBar
            label={t('usage.diskUsage')}
            usageBytes={usage.disk.usageBytes}
            limitBytes={usage.disk.limitBytes}
            percent={usage.disk.percent}
            unlimitedLabel={t('usage.unlimited')}
          />
          <StorageBreakdown
            cameras={cameraUsage}
            colors={cameraColors}
            diskLimitBytes={usage.disk.limitBytes}
            t={t}
          />
          {/* No transfer limit and nothing transferred (every self-hosted account)
              leaves nothing to chart — the row would only read "0 B · Unlimited". */}
          {(usage.transfer.limitBytes > 0 || usage.transfer.usageBytes > 0) && (
            <UsageBar
              label={t('usage.transferUsage')}
              usageBytes={usage.transfer.usageBytes}
              limitBytes={usage.transfer.limitBytes}
              percent={usage.transfer.percent}
              resetAt={usage.transfer.resetAt}
              resetLabel={t('usage.resetsAt')}
              unlimitedLabel={t('usage.unlimited')}
            />
          )}
          {usage.disk.percent >= 80 && (
            <div className="usage-warning">
              {usage.disk.percent >= 100
                ? t(autoDelete ? 'usage.warning100AutoDelete' : 'usage.warning100')
                : t(autoDelete ? 'usage.warning80AutoDelete' : 'usage.warning80')}
            </div>
          )}
          {usage.transfer.percent >= 80 && (
            <div className="usage-warning">{usage.transfer.percent >= 100 ? t('usage.transferWarning100') : t('usage.transferWarning80')}</div>
          )}
        </>
      )}
      <label className="settings-toggle">
        <input
          type="checkbox"
          disabled={autoDelete === null || saving}
          checked={autoDelete ?? false}
          onChange={e => toggle(e.target.checked)}
        />
        <span>{t('settings.autoDeleteOldest')}</span>
      </label>
      <p className="settings-hint">{t('settings.autoDeleteHint')}</p>

      <label className="settings-toggle">
        <input
          type="checkbox"
          disabled={retentionDays === undefined || retentionSaving}
          checked={retentionDays !== null && retentionDays !== undefined}
          onChange={e => toggleRetention(e.target.checked)}
        />
        <span>{t('settings.autoDeleteAfterDays')}</span>
      </label>
      {retentionDays !== null && retentionDays !== undefined && (
        <div className="settings-row inline-form" style={{ cursor: 'default' }}>
          <div
            className="settings-stepper"
            role="spinbutton"
            aria-valuenow={retentionDays}
            aria-valuemin={RETENTION_MIN}
            aria-valuemax={RETENTION_MAX}
            aria-label={t('settings.autoDeleteAfterDays')}
          >
            <button
              type="button"
              onClick={() => bumpRetentionDays(-1)}
              disabled={retentionSaving || retentionDays <= RETENTION_MIN}
              aria-label="−1"
            >−</button>
            <div className="settings-stepper-val">
              <input
                type="number"
                min={RETENTION_MIN}
                max={RETENTION_MAX}
                step={1}
                value={retentionDays}
                disabled={retentionSaving}
                onChange={e => onRetentionDaysChange(e.target.value)}
                style={{
                  width: '100%', height: '100%', padding: 0, margin: 0,
                  background: 'transparent', border: 0, color: 'inherit',
                  font: 'inherit', textAlign: 'center', appearance: 'textfield',
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => bumpRetentionDays(1)}
              disabled={retentionSaving || retentionDays >= RETENTION_MAX}
              aria-label="+1"
            >+</button>
          </div>
          <span>{t('settings.daysUnit')}</span>
        </div>
      )}
      <p className="settings-hint">{t('settings.autoDeleteAfterDaysHint')}</p>
    </div>
  );
}

interface StorageBreakdownProps {
  cameras: CameraUsage[] | null;
  colors: Map<string, string>;
  diskLimitBytes: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}

/**
 * Per-camera disk-usage breakdown — a stacked bar showing each camera's
 * share of the total quota, plus per-camera rows with a color dot, GB
 * size, mini progress bar (relative to the biggest camera so the visual
 * hierarchy reads as "who's hogging disk"), and recorded-hours label.
 *
 * Rendered nothing while loading; nothing while there are no cameras.
 * Numbers come from `GET /api/v0/usage/by-camera`; sum may be slightly
 * less than the disk usage bar because orphan file_metadata rows
 * (in-flight uploads not linked to events yet) are excluded.
 */
function StorageBreakdown({ cameras, colors, diskLimitBytes, t }: StorageBreakdownProps) {
  if (cameras === null || cameras.length === 0) return null;

  const totalBytes = cameras.reduce((s, c) => s + c.bytes, 0);
  if (totalBytes === 0) return null;

  return (
    <div className="settings-storage-breakdown">
      <div className="settings-storage-breakdown-header">
        <span className="settings-storage-breakdown-title">{t('settings.storage.perCamera')}</span>
        <span className="settings-storage-breakdown-summary">
          {t('settings.storage.acrossCameras', { count: cameras.length })}
        </span>
      </div>
      <div className="settings-storage-stack" aria-hidden="true">
        {cameras.map((c) => {
          // Width = camera share of the user's disk quota. Never overflows:
          // the denominator is max(quota, used) so over-quota bars fill the
          // whole width instead of wrapping.
          const denom = Math.max(diskLimitBytes, totalBytes);
          const widthPct = denom > 0 ? (c.bytes / denom) * 100 : 0;
          if (widthPct <= 0) return null;
          return (
            <div
              key={c.cameraName}
              style={{ width: `${widthPct.toFixed(2)}%`, background: colors.get(c.cameraName) ?? 'var(--text2)' }}
              title={`${c.cameraName} — ${formatBytes(c.bytes)}`}
            />
          );
        })}
        {(() => {
          const denom = Math.max(diskLimitBytes, totalBytes);
          const freeBytes = Math.max(0, denom - totalBytes);
          const widthPct = denom > 0 ? (freeBytes / denom) * 100 : 0;
          if (widthPct <= 0) return null;
          return (
            <div
              className="settings-storage-free"
              style={{ width: `${widthPct.toFixed(2)}%` }}
              title={`${t('settings.storage.freeSpace')} — ${formatBytes(freeBytes)}`}
            />
          );
        })()}
      </div>
      <div className="settings-storage-cams">
        {cameras.map((c) => {
          const color = colors.get(c.cameraName) ?? 'var(--text2)';
          const relPct = totalBytes > 0 ? (c.bytes / totalBytes) * 100 : 0;
          const hours = c.durationSeconds / 3600;
          const hoursLabel = hours >= 1
            ? t('settings.storage.hoursRecorded', { hours: hours.toFixed(0) })
            : t('settings.storage.minutesRecorded', { minutes: Math.max(1, Math.round(c.durationSeconds / 60)) });
          return (
            <div
              key={c.cameraName}
              className="settings-storage-cam-row"
              style={{ ['--cam-color' as never]: color }}
            >
              <div className="settings-storage-cam-head">
                <span className="settings-storage-cam-dot" />
                <span className="settings-storage-cam-name">{c.cameraName}</span>
                <span className="settings-storage-cam-size">{formatBytes(c.bytes)}</span>
              </div>
              <div className="settings-storage-cam-bar">
                <div style={{ width: `${relPct.toFixed(2)}%` }} />
              </div>
              <div className="settings-storage-cam-foot">
                <span>{hoursLabel}</span>
                <span>{t('settings.storage.eventCount', { count: c.eventCount })}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
