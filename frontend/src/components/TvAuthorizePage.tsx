import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useTranslation } from '../i18n';
import { VersionFooter } from './VersionFooter';

// Canonical = upper-case, A–Z/0–9 only, exactly 8 chars (mirrors the server's
// normalizeUserCode). We keep the user's raw text — which carries the display
// dash — for the field, but send the canonical form to the API.
function canonical(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Display form: canonical, capped at 8 chars, with a "-" after the 4th so the
// field reads XXXX-XXXX as you type. Submission still uses canonical(), so the
// dash is purely cosmetic.
function formatDisplay(raw: string): string {
  const c = canonical(raw).slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

// Index in `display` just after the n-th alphanumeric char — used to keep the
// caret put when the auto-inserted dash shifts characters during a mid-string edit.
function caretAfterAlnum(display: string, n: number): number {
  if (n <= 0) return 0;
  let count = 0;
  for (let i = 0; i < display.length; i++) {
    if (/[A-Z0-9]/.test(display[i])) {
      count += 1;
      if (count === n) return i + 1;
    }
  }
  return display.length;
}

/**
 * /tv — a signed-in user enters the code shown on their Apple TV
 * to authorize it. RequireAuth gates this route, so an anonymous visitor (e.g.
 * who scanned the QR) is bounced to /login and returned here with ?code= intact.
 *
 * Approval requires a deliberate gesture — clicking "Authorize" (or pressing
 * Enter in the field). The code field pre-fills from ?code= for convenience, but
 * a pre-filled/complete code MUST NOT authorize on its own: an attacker who sent
 * the victim /tv?code=<attacker_code> could otherwise bind their
 * TV to the victim's session with zero taps (one-click account takeover). The
 * field still uppercases and auto-dashes as you type.
 */
export function TvAuthorizePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(() => formatDisplay(searchParams.get('code') ?? ''));
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const canon = canonical(code);
  const valid = canon.length === 8;

  // The canonical code we last fired an attempt for. An attempt (success OR
  // failure) leaves it set, so a double-click / double-Enter on the same code
  // can't double-submit; the user has to edit the code (yielding a new canonical
  // value) before it will try again.
  const submittedRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reformat to XXXX-XXXX on every keystroke/paste, restoring the caret to the
  // same logical position so inserting the dash doesn't bounce it to the end.
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const alnumBeforeCaret = canonical(el.value.slice(0, el.selectionStart ?? el.value.length)).length;
    const next = formatDisplay(el.value);
    setCode(next);
    const caret = caretAfterAlnum(next, alnumBeforeCaret);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(caret, caret));
  };

  const approve = async (value: string) => {
    setError('');
    setLoading(true);
    try {
      await api.tvApprove(value);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.message === 'invalid_or_expired') {
        setError('tv.expired');
      } else if (err instanceof ApiError && err.message === 'invalid_code') {
        setError('tv.invalidCode');
      } else {
        setError('tv.error');
      }
    } finally {
      setLoading(false);
    }
  };

  // Submission is gesture-driven: the Authorize button (or Enter in the field)
  // calls this. A pre-filled ?code= never authorizes on its own. The single-fire
  // guard stops a double-click from double-submitting the same code.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (done || loading || !valid || submittedRef.current === canon) return;
    submittedRef.current = canon;
    void approve(canon);
  };

  if (done) {
    return (
      <div className="auth-page">
        <div className="auth-form" data-testid="tv-success">
          <img src="/logo.svg" alt="" className="auth-logo" />
          <h1>{t('tv.title')}</h1>
          <div className="info" style={{ color: 'var(--accent, #6EE7B7)', marginBottom: '16px', textAlign: 'center' }}>
            {t('tv.success')}
          </div>
          <button onClick={() => navigate('/grid')}>{t('tv.done')}</button>
        </div>
        <VersionFooter />
      </div>
    );
  }

  return (
    <div className="auth-page" data-testid="tv-authorize-page">
      {/* Submission requires a deliberate gesture — the Authorize button, or Enter
          in the field (both routed through handleSubmit). A pre-filled ?code=
          never authorizes on its own. */}
      <form className="auth-form" onSubmit={handleSubmit}>
        <img src="/logo.svg" alt="" className="auth-logo" />
        <h1>{t('tv.title')}</h1>
        <p style={{ color: 'var(--text-muted, #888)', fontSize: '13px', marginBottom: '8px', textAlign: 'center' }}>
          {t('tv.subtitle')}
        </p>
        {error && <div className="error">{t(error)}</div>}
        <input
          ref={inputRef}
          data-testid="tv-code-input"
          type="text"
          placeholder={t('tv.codePlaceholder')}
          value={code}
          onChange={handleChange}
          autoFocus
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={9}
          style={{ textAlign: 'center', fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.2em', fontSize: '20px' }}
        />
        <button type="submit" data-testid="tv-authorize" disabled={!valid || loading}>
          {t('tv.authorize')}
        </button>
        {loading && (
          <div data-testid="tv-connecting" className="info" style={{ color: 'var(--text-muted, #888)', marginTop: '12px', textAlign: 'center' }}>
            {t('tv.connecting')}
          </div>
        )}
      </form>
      <VersionFooter />
    </div>
  );
}
