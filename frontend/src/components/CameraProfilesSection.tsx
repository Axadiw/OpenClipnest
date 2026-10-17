import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CameraProfileMode, UserCameraProfile, VendorProfileTemplate } from '../api';
import type { IconKind } from '../types';
import { ViewIcon, VIEW_ICON_KINDS } from './ViewIcon';
import { useTranslation } from '../i18n';

type ViewConfigEntry = { id: string; iconKind: IconKind };

/**
 * Shared dark-mode styling for the two native <select>s in this section (the
 * mode picker and the per-view icon picker). A bare <select> renders with a
 * white background in dark mode on most browsers; this matches the sibling
 * text inputs. The white <option> dropdown is a UA-rendered surface we can't
 * fully theme cross-browser, but setting color on the <select> keeps the
 * collapsed value legible against --bg3.
 */
const SELECT_STYLE: React.CSSProperties = {
  background: 'var(--bg3)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: '6px 10px',
};

/**
 * Per-view editor: an ordered list of rows, each a view-id text input + an
 * icon <select> with a live <ViewIcon> preview. Row one is the primary view
 * (default playback + the regex-no-view-group fallback id). At least one row
 * is always present; the remove button is hidden when only one remains.
 */
function ViewsEditor({
  views,
  onChange,
  idPrefix,
}: {
  views: ViewConfigEntry[];
  onChange: (next: ViewConfigEntry[]) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();

  const updateRow = (index: number, patch: Partial<ViewConfigEntry>) => {
    onChange(views.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  };
  const addRow = () => onChange([...views, { id: '', iconKind: 'generic' }]);
  const removeRow = (index: number) => onChange(views.filter((_, i) => i !== index));

  return (
    <div data-testid={`${idPrefix}-views-editor`}>
      <span className="settings-hint" style={{ display: 'block', marginBottom: 4 }}>
        {t('settings.cameraProfiles.viewsLabel')}
      </span>
      {views.map((v, i) => (
        <div
          key={i}
          style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}
          data-testid={`${idPrefix}-view-row-${i}`}
        >
          <span style={{ display: 'inline-flex', color: 'var(--text)' }} aria-hidden="true">
            <ViewIcon kind={v.iconKind} size={18} />
          </span>
          <input
            type="text"
            value={v.id}
            onChange={e => updateRow(i, { id: e.target.value })}
            placeholder={i === 0 ? '00' : '01'}
            maxLength={16}
            aria-label={`${t('settings.cameraProfiles.profileView')} ${i + 1}`}
            style={{ width: 80, background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 10px' }}
            data-testid={`${idPrefix}-view-id-${i}`}
          />
          <select
            value={v.iconKind}
            onChange={e => updateRow(i, { iconKind: e.target.value as IconKind })}
            aria-label={t('settings.cameraProfiles.viewIconLabel')}
            data-testid={`${idPrefix}-view-icon-${i}`}
            style={SELECT_STYLE}
          >
            {VIEW_ICON_KINDS.map(kind => (
              <option key={kind} value={kind} style={{ background: 'var(--bg3)', color: 'var(--text)' }}>{t(`profile.viewIcon.${kind}`)}</option>
            ))}
          </select>
          {views.length > 1 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => removeRow(i)}
              aria-label={t('settings.cameraProfiles.removeView')}
              data-testid={`${idPrefix}-view-remove-${i}`}
              style={{ color: 'var(--error, #f87171)' }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        onClick={addRow}
        data-testid={`${idPrefix}-view-add`}
        style={{ marginTop: 2, fontSize: '0.85rem' }}
      >
        {t('settings.cameraProfiles.addView')}
      </button>
    </div>
  );
}

/**
 * Drop blank-id rows and guarantee at least one entry. Used before any save so
 * the server always receives a valid 1..16-length array with non-empty ids.
 */
function sanitizeViews(views: ViewConfigEntry[]): ViewConfigEntry[] {
  const cleaned = views
    .map(v => ({ id: v.id.trim(), iconKind: v.iconKind }))
    .filter(v => v.id.length > 0);
  return cleaned.length > 0 ? cleaned : [{ id: '00', iconKind: 'generic' }];
}

// Recognition mode is now a simple binary: `auto` (try every built-in vendor
// pattern — a behavior-preserving superset of the retired single-vendor modes)
// vs `custom` (user-authored profiles, seeded from vendor templates). The
// backend CameraProfileMode enum still accepts the legacy single-vendor values
// for compatibility, but they are no longer offered in the UI.
type UiMode = 'auto' | 'custom';
const MODE_OPTIONS: { value: UiMode; labelKey: string; descKey: string }[] = [
  { value: 'auto', labelKey: 'settings.cameraProfiles.modeAuto', descKey: 'settings.cameraProfiles.descAuto' },
  { value: 'custom', labelKey: 'settings.cameraProfiles.modeCustom', descKey: 'settings.cameraProfiles.descCustom' },
];

/**
 * Collapse the backend mode to one of the two UI modes. A legacy single-vendor
 * value (reolink/hikvision/axis/foscam) DISPLAYS as `auto` — auto is a
 * behavior-preserving superset, so we don't auto-persist the change (the stored
 * value only flips when the user explicitly picks a mode).
 */
function toUiMode(mode: CameraProfileMode | null): UiMode | null {
  if (mode === null) return null;
  return mode === 'custom' ? 'custom' : 'auto';
}

interface TestResult {
  camera: string;
  view: string;
  tsRaw: string;
  ext: string;
}

interface RegexTestPanelProps {
  regex: string;
}

function RegexTestPanel({ regex }: RegexTestPanelProps) {
  const { t } = useTranslation();
  const [filename, setFilename] = useState('');
  const [result, setResult] = useState<TestResult | null | 'invalid' | 'loading' | ''>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onFilenameChange = (value: string) => {
    setFilename(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!value.trim() || !regex.trim()) {
      setResult('');
      return;
    }
    setResult('loading');
    timerRef.current = setTimeout(async () => {
      try {
        const r = await api.testCameraProfileRegex(regex, value);
        setResult(r.result ?? null);
      } catch {
        setResult('invalid');
      }
    }, 300);
  };

  return (
    <div style={{ marginTop: 8 }}>
      <input
        type="text"
        placeholder={t('settings.cameraProfiles.testFilename')}
        value={filename}
        onChange={e => onFilenameChange(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box' }}
        data-testid="regex-test-filename"
      />
      {result === 'loading' && (
        <div className="settings-hint" style={{ marginTop: 4 }}>…</div>
      )}
      {result === 'invalid' && (
        <div className="settings-hint" style={{ marginTop: 4, color: 'var(--error, #f87171)' }}>
          {t('settings.cameraProfiles.testInvalid')}
        </div>
      )}
      {result === null && (
        <div className="settings-hint" style={{ marginTop: 4 }}>
          {t('settings.cameraProfiles.testNoMatch')}
        </div>
      )}
      {result && typeof result === 'object' && (
        <div className="settings-hint" style={{ marginTop: 4, color: 'var(--accent, #6EE7B7)' }}>
          {t('settings.cameraProfiles.testMatch', {
            camera: result.camera,
            view: result.view,
            ts: result.tsRaw,
            ext: result.ext,
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Static, read-only vendor filename examples. Replaces the old
 * "Use Reolink template" button — informational only, no click behavior.
 */
function ExampleFilenames() {
  const { t } = useTranslation();
  return (
    <div className="settings-hint" style={{ marginBottom: 10, fontSize: '0.8rem' }} data-testid="profile-examples">
      <span style={{ display: 'block', marginBottom: 4 }}>{t('settings.cameraProfiles.examplesHint')}</span>
      <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc' }}>
        <li>
          Reolink: <code>Front_00_20240115143022.mp4</code> (wide), <code>Front_01_20240115143022.mp4</code> (zoom)
        </li>
        <li>Hikvision: <code>Webcam_G12345_20240115143022.mp4</code></li>
        <li>Axis: <code>Parking_2024-01-15_14-30-22.mp4</code></li>
        <li>Foscam: <code>MDAlarm_20240115-143022.mp4</code></li>
      </ul>
    </div>
  );
}

interface AddProfileFormProps {
  onSave: (data: { name: string; regex: string; viewsConfig: ViewConfigEntry[]; priority: number }) => Promise<void>;
  onCancel: () => void;
}

function AddProfileForm({ onSave, onCancel }: AddProfileFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [regex, setRegex] = useState('');
  // Per-view config: each row maps a view id (the value the regex's `view`
  // group emits — Reolink uses '00'/'01', other vendors anything) to a glyph.
  // Row one is the primary view (default playback + regex-no-view fallback).
  const [views, setViews] = useState<ViewConfigEntry[]>([{ id: '00', iconKind: 'generic' }]);
  const [priority, setPriority] = useState(10);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !regex.trim()) return;
    setSaving(true);
    setError('');
    try {
      await onSave({ name: name.trim(), regex: regex.trim(), viewsConfig: sanitizeViews(views), priority });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 12, padding: 12, border: '1px solid var(--border, rgba(255,255,255,0.1))', borderRadius: 6 }}>
      <ExampleFilenames />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, alignItems: 'flex-end' }}>
        <label>
          <span className="settings-hint" style={{ display: 'block', marginBottom: 2 }}>{t('settings.cameraProfiles.profileName')}</span>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            placeholder="My Camera"
            style={{ width: '100%', boxSizing: 'border-box' }}
            data-testid="profile-name-input"
          />
        </label>
        <label>
          <span className="settings-hint" style={{ display: 'block', marginBottom: 2 }}>{t('settings.cameraProfiles.profilePriority')}</span>
          <input
            type="number"
            value={priority}
            onChange={e => setPriority(Number(e.target.value))}
            min={1}
            max={999}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </label>
      </div>
      <label style={{ display: 'block', marginTop: 8 }}>
        <span className="settings-hint" style={{ display: 'block', marginBottom: 2 }}>{t('settings.cameraProfiles.profileRegex')}</span>
        <input
          type="text"
          value={regex}
          onChange={e => setRegex(e.target.value)}
          required
          placeholder="^(?<camera>[^_]+)_(?<ts>\d{14})\.(?<ext>mp4|jpg)$"
          style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mono, monospace)' }}
          data-testid="profile-regex-input"
        />
      </label>
      <p className="settings-hint" style={{ margin: '6px 0 0' }}>{t('settings.cameraProfiles.regexHint')}</p>
      <div style={{ marginTop: 10 }}>
        <ViewsEditor views={views} onChange={setViews} idPrefix="profile-add" />
      </div>
      {regex && <RegexTestPanel regex={regex} />}
      {error && <div style={{ color: 'var(--error, #f87171)', marginTop: 8, fontSize: '0.875rem' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="submit" className="btn btn-sm" disabled={saving} data-testid="profile-save-btn">
          {t('settings.cameraProfiles.saveProfile')}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={saving}>
          {t('settings.cameraProfiles.cancelProfile')}
        </button>
      </div>
    </form>
  );
}

interface ProfileRowProps {
  profile: UserCameraProfile;
  onToggle: (id: number, enabled: boolean) => Promise<void>;
  onUpdate: (id: number, data: { viewsConfig: ViewConfigEntry[] }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onError: (msg: string) => void;
}

function ProfileRow({ profile, onToggle, onUpdate, onDelete, onError }: ProfileRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [savingViews, setSavingViews] = useState(false);
  // Editable copy of the profile's views, seeded from the server value.
  const [views, setViews] = useState<ViewConfigEntry[]>(
    profile.viewsConfig.length > 0
      ? profile.viewsConfig.map(v => ({ id: v.id, iconKind: v.iconKind }))
      : [{ id: profile.viewDefault, iconKind: 'generic' }],
  );

  const handleToggle = async () => {
    setToggling(true);
    try { await onToggle(profile.id, !profile.enabled); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setToggling(false); }
  };

  const handleSaveViews = async () => {
    setSavingViews(true);
    try { await onUpdate(profile.id, { viewsConfig: sanitizeViews(views) }); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setSavingViews(false); }
  };

  const handleDelete = async () => {
    if (!window.confirm(`${t('settings.cameraProfiles.deleteProfile')} "${profile.name}"?`)) return;
    setDeleting(true);
    try { await onDelete(profile.id); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setDeleting(false); }
  };

  return (
    <div style={{ borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))', paddingBottom: 8, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label className="settings-toggle" style={{ margin: 0, flex: '0 0 auto' }}>
          <input
            type="checkbox"
            checked={profile.enabled}
            onChange={handleToggle}
            disabled={toggling}
            data-testid={`profile-toggle-${profile.id}`}
          />
          <span />
        </label>
        <span
          style={{ flex: 1, fontWeight: 500, cursor: 'pointer', opacity: profile.enabled ? 1 : 0.5 }}
          onClick={() => setExpanded(e => !e)}
          title={profile.regex}
        >
          {profile.name}
        </span>
        <code
          style={{
            flex: 2,
            fontSize: '0.78rem',
            opacity: 0.6,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 240,
            cursor: 'pointer',
          }}
          onClick={() => setExpanded(e => !e)}
          title={profile.regex}
        >
          {profile.regex}
        </code>
        <button
          className="btn btn-sm"
          onClick={() => setExpanded(e => !e)}
          title={t('settings.cameraProfiles.expandCollapse')}
          aria-label={t('settings.cameraProfiles.editProfile')}
        >
          ✎
        </button>
        <button
          className="btn btn-sm"
          onClick={handleDelete}
          disabled={deleting}
          data-testid={`profile-delete-${profile.id}`}
          style={{ color: 'var(--error, #f87171)' }}
        >
          {t('settings.cameraProfiles.deleteProfile')}
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, paddingLeft: 32 }}>
          <p className="settings-hint" style={{ margin: '0 0 4px' }}>{t('settings.cameraProfiles.profileRegex')}: <code>{profile.regex}</code></p>
          <div style={{ marginTop: 8, marginBottom: 8 }}>
            <ViewsEditor views={views} onChange={setViews} idPrefix={`profile-edit-${profile.id}`} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleSaveViews}
              disabled={savingViews}
              data-testid={`profile-views-save-${profile.id}`}
              style={{ marginTop: 8 }}
            >
              {t('settings.cameraProfiles.saveProfile')}
            </button>
          </div>
          <RegexTestPanel regex={profile.regex} />
        </div>
      )}
    </div>
  );
}

export function CameraProfilesSection() {
  const { t } = useTranslation();
  // `mode` holds the raw backend value (which may be a legacy single-vendor
  // string); `toUiMode(mode)` collapses it for display + branching.
  const [mode, setMode] = useState<CameraProfileMode | null>(null);
  const [profiles, setProfiles] = useState<UserCameraProfile[]>([]);
  const [templates, setTemplates] = useState<VendorProfileTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [modeChanging, setModeChanging] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    api.getCameraProfiles()
      .then(r => {
        setMode(r.mode);
        setProfiles(r.customProfiles);
        setTemplates(r.templates ?? []);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  /** POST every vendor template as a fresh custom profile, in order. Returns
   *  the created rows. Priorities ascend so the order matches the template
   *  array (lower priority sorts first server-side). */
  const seedTemplates = async (): Promise<UserCameraProfile[]> => {
    const created: UserCameraProfile[] = [];
    for (let i = 0; i < templates.length; i++) {
      const tpl = templates[i];
      created.push(await api.createCustomProfile({
        name: tpl.name,
        regex: tpl.regex,
        viewsConfig: tpl.viewsConfig,
        priority: (i + 1) * 10,
      }));
    }
    return created;
  };

  const onModeChange = async (nextUi: UiMode) => {
    const prev = mode;
    const prevProfiles = profiles;
    setMode(nextUi); // optimistic
    setModeChanging(true);
    try {
      await api.setCameraProfileMode(nextUi);
      // Switching to custom with an empty list seeds the vendor templates so
      // the user starts from working defaults rather than a blank slate. If
      // profiles already exist, just switch (never duplicate).
      if (nextUi === 'custom' && prevProfiles.length === 0 && templates.length > 0) {
        const seeded = await seedTemplates();
        setProfiles(seeded);
      }
    } catch (e) {
      setMode(prev); // rollback
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setModeChanging(false);
    }
  };

  /**
   * Reset custom profiles to the vendor defaults via the atomic server
   * endpoint (one transaction: delete all + seed the templates). This
   * replaced the client-driven seed-first-then-delete flow: that ordering
   * avoided an empty-profile window but could never
   * complete for users with >16 profiles — seeding 4 more hit the 20-profile
   * cap before the deletes ran. Server-side there is neither an empty window
   * nor a cap interaction.
   */
  const onReset = async () => {
    if (!window.confirm(t('settings.cameraProfiles.resetConfirm'))) return;
    setResetting(true);
    setError(null);
    try {
      const { customProfiles } = await api.resetCameraProfiles();
      setProfiles(customProfiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Best-effort re-sync so the UI isn't left showing a half-applied state.
      try {
        const fresh = await api.getCameraProfiles();
        setProfiles(fresh.customProfiles);
      } catch { /* keep the optimistic list */ }
    } finally {
      setResetting(false);
    }
  };

  const onSaveProfile = async (data: { name: string; regex: string; viewsConfig: ViewConfigEntry[]; priority: number }) => {
    const created = await api.createCustomProfile(data);
    setProfiles(prev => [...prev, created]);
    setShowAddForm(false);
  };

  const onToggleProfile = async (id: number, enabled: boolean) => {
    const updated = await api.updateCustomProfile(id, { enabled });
    setProfiles(prev => prev.map(p => p.id === id ? updated : p));
  };

  const onUpdateProfile = async (id: number, data: { viewsConfig: ViewConfigEntry[] }) => {
    const updated = await api.updateCustomProfile(id, data);
    setProfiles(prev => prev.map(p => p.id === id ? updated : p));
  };

  const onDeleteProfile = async (id: number) => {
    await api.deleteCustomProfile(id);
    setProfiles(prev => prev.filter(p => p.id !== id));
  };

  return (
    <section className="settings-section" style={{ marginTop: 24 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: '1rem' }}>{t('settings.cameraProfiles.title')}</h3>
      <p className="settings-hint">{t('settings.cameraProfiles.hint')}</p>

      {loading && <div className="spinner" />}
      {error && <div className="settings-error" style={{ marginBottom: 12 }}>{error}</div>}

      {!loading && mode !== null && (
        <div style={{ marginBottom: 12 }}>
          <label className="settings-row" style={{ gap: 12 }}>
            <span className="settings-row-label" style={{ minWidth: 120 }}>
              {t('settings.cameraProfiles.modeLabel')}
            </span>
            <select
              value={toUiMode(mode) ?? 'auto'}
              onChange={e => onModeChange(e.target.value as UiMode)}
              disabled={modeChanging}
              data-testid="camera-profile-mode-select"
              style={SELECT_STYLE}
            >
              {MODE_OPTIONS.map(o => (
                <option key={o.value} value={o.value} style={{ background: 'var(--bg3)', color: 'var(--text)' }}>{t(o.labelKey)}</option>
              ))}
            </select>
          </label>
          {(() => {
            const opt = MODE_OPTIONS.find(o => o.value === toUiMode(mode));
            return opt ? (
              <p className="settings-hint" style={{ marginTop: 6 }}>{t(opt.descKey)}</p>
            ) : null;
          })()}
        </div>
      )}

      {toUiMode(mode) === 'custom' && (
        <div>
          <h4 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>{t('settings.cameraProfiles.customProfiles')}</h4>

          {profiles.length === 0 && !showAddForm && (
            <p className="settings-hint">{t('settings.cameraProfiles.noProfiles')}</p>
          )}

          {profiles.map(profile => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              onToggle={onToggleProfile}
              onUpdate={onUpdateProfile}
              onDelete={onDeleteProfile}
              onError={msg => setError(msg)}
            />
          ))}

          {showAddForm ? (
            <AddProfileForm
              onSave={onSaveProfile}
              onCancel={() => setShowAddForm(false)}
            />
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-sm"
                onClick={() => setShowAddForm(true)}
                data-testid="add-profile-btn"
              >
                {t('settings.cameraProfiles.addProfile')}
              </button>
              {templates.length > 0 && (
                <button
                  className="btn btn-sm"
                  onClick={onReset}
                  disabled={resetting}
                  data-testid="reset-profiles-btn"
                >
                  {t('settings.cameraProfiles.resetToDefaults')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
