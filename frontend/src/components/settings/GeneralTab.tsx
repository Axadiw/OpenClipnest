import { useEffect, useState } from 'react';
import { useTranslation, LANGUAGES, type Language } from '../../i18n';
import { useTheme, type ThemeMode } from '../../hooks/useTheme';
import { usePwaInstall } from '../../hooks/usePwaInstall';
import { api } from '../../api';
import { DEFAULT_TIMEZONE, selectableTimezones } from '../../utils/timezones';

const ALL_TIMEZONES: string[] = selectableTimezones();

const THEME_OPTIONS: { value: ThemeMode; labelKey: string }[] = [
  { value: 'auto', labelKey: 'menu.themeAuto' },
  { value: 'light', labelKey: 'menu.themeLight' },
  { value: 'dark', labelKey: 'menu.themeDark' },
];

function TimezoneRow() {
  const { t } = useTranslation();
  const [timezone, setTimezone] = useState<string | null>(null);
  useEffect(() => {
    api.getAccountTimezone().then(r => setTimezone(r.timezone)).catch(() => setTimezone(DEFAULT_TIMEZONE));
  }, []);
  function onChange(next: string) {
    const prev = timezone;
    setTimezone(next);
    api.setAccountTimezone(next).catch(() => setTimezone(prev));
  }
  return (
    <label className="settings-row" style={{ gap: 12 }}>
      <span className="settings-row-label" style={{ minWidth: 96 }}>{t('settings.timezone')}</span>
      <select
        className="page-size-select"
        value={timezone ?? DEFAULT_TIMEZONE}
        onChange={e => onChange(e.target.value)}
        disabled={timezone === null}
      >
        {ALL_TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
      </select>
    </label>
  );
}

export function GeneralTab() {
  const { t, language, setLanguage } = useTranslation();
  const theme = useTheme();
  const { showIosHint } = usePwaInstall();

  return (
    <section className="settings-section">
      <div className="settings-row" style={{ gap: 12, cursor: 'default' }}>
        <span className="settings-row-label" style={{ minWidth: 96 }}>{t('menu.theme')}</span>
        <div className="settings-segmented" role="radiogroup" aria-label={t('menu.theme')}>
          {THEME_OPTIONS.map(o => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={theme.mode === o.value}
              className={theme.mode === o.value ? 'on' : ''}
              onClick={() => theme.setMode(o.value)}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
      </div>
      <label className="settings-row" style={{ gap: 12 }}>
        <span className="settings-row-label" style={{ minWidth: 96 }}>{t('menu.language')}</span>
        <select className="page-size-select" value={language} onChange={e => setLanguage(e.target.value as Language)}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </label>
      <TimezoneRow />
      {showIosHint && (
        <>
          <hr />
          <p className="settings-hint" data-testid="ios-install-hint">{t('pwa.iosHint')}</p>
        </>
      )}
    </section>
  );
}
