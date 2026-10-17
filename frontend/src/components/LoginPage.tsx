import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, getRememberMe, type OAuthResult } from '../api';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from '../i18n';
import { edition } from '../edition';
import type { PasskeyChallenge } from '../editions/types';
import { VersionFooter } from './VersionFooter';
import { useCountdown } from '../hooks/useCountdown';
import { formatDuration } from '../utils/format';

interface BanInfo {
  until: string | null;
  reason: string | null;
  indefinite: boolean;
}

type Stage = 'email' | 'password' | 'passkey' | 'backup';

/**
 * Two-stage login:
 *
 * 1. User types email. When the edition supports passkeys, its `begin` slot
 *    (/auth/login/begin) tells us whether the account has one.
 * 2a. password → render the password form.
 * 2b. passkey  → the edition's passkey stage runs the WebAuthn ceremony.
 *
 * Backup-code recovery is a separate edition stage opened from a "Lost your
 * passkey?" link. OAuth buttons, the ban notice and the links under the form
 * are edition slots too — the self-hosted edition renders none of them.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const { OAuthButtons, BanNotice, EmailStageLinks, passkey } = edition.login;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(getRememberMe);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [ban, setBan] = useState<BanInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<Stage>('email');
  const [passkeyChallenge, setPasskeyChallenge] = useState<PasskeyChallenge | null>(null);
  // Shared rate-limit countdown. Every login limiter (per-IP and per-email,
  // across begin/password/passkey/backup) feeds the SAME ticking message so
  // the wait time never differs by which bucket tripped — that uniformity is
  // what keeps it from leaking whether an account exists.
  const { remaining: rlRemaining, active: rlActive, start: rlStart } = useCountdown();

  // Pick up ?verified=1|0 from the GET /verify-email redirect.
  useEffect(() => {
    const verified = searchParams.get('verified');
    if (verified === '1') setInfo(t('login.verifiedSuccess'));
    else if (verified === '0') setError(t('login.verifiedFailure'));
    if (verified !== null) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('verified');
        return next;
      }, { replace: true });
    }
  }, [t, searchParams, setSearchParams]);

  const handleBanError = (err: ApiError) => {
    const body = err.body as { until?: string | null; reason?: string | null; indefinite?: boolean } | undefined;
    setBan({
      until: body?.until ?? null,
      reason: body?.reason ?? null,
      indefinite: !!body?.indefinite,
    });
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBan(null);
    const normalized = email.trim().toLowerCase();
    setEmail(normalized);
    setLoading(true);
    try {
      const challenge = passkey ? await passkey.begin(normalized) : null;
      if (challenge) {
        setPasskeyChallenge(challenge);
        setStage('passkey');
      } else {
        setStage('password');
      }
    } catch (err) {
      // 429 / 423 from /login/begin must stay on the email stage — falling
      // through to password would confuse a passkey user (they'd see a
      // password form they can't use) or a locked user (wrong retry path).
      if (err instanceof ApiError && err.status === 423) {
        if (err.retryAfter) rlStart(err.retryAfter);
        setError(t('login.locked'));
      } else if (err instanceof ApiError && err.status === 429) {
        if (err.retryAfter) rlStart(err.retryAfter);
        setError(t('login.rateLimited'));
      } else {
        // Any other error (network, 5xx) — fall back to password mode so
        // the SPA isn't completely blocked. The follow-up /login attempt
        // will surface the real cause.
        setStage('password');
      }
    } finally {
      setLoading(false);
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBan(null);
    setLoading(true);
    try {
      const result = await api.login(email, password);
      login(result.token, result.refreshToken, result.user, rememberMe);
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) setError(t('login.locked'));
      else if (err instanceof ApiError && err.status === 429) {
        if (err.retryAfter) rlStart(err.retryAfter);
        setError(t('login.rateLimited'));
      }
      else if (err instanceof ApiError && err.status === 403 && err.body?.banned) handleBanError(err);
      else if (err instanceof ApiError && err.status === 400 && (err.body as { passkeyRequired?: boolean })?.passkeyRequired) {
        // Account flipped to passkey-only between begin and submit — restart.
        setStage('email');
        setError(t('login.passkeyRequired'));
      } else if (err instanceof ApiError && err.status === 403) setError(t('login.inactive'));
      else setError(t('login.error'));
    } finally {
      setLoading(false);
    }
  };

  const restart = () => {
    setStage('email');
    setError('');
    setBan(null);
    setPasskeyChallenge(null);
    setPassword('');
  };

  const handleOAuthResult = useCallback((result: OAuthResult) => {
    if (result.token && result.refreshToken && result.user) {
      login(result.token, result.refreshToken, result.user, rememberMe);
    } else if (result.pendingActivation) {
      setInfo(t('login.pendingActivation'));
    }
  }, [login, rememberMe, t]);

  const [oauthConsenting, setOauthConsenting] = useState(false);

  const rateLimitWait = rlActive ? t('login.rateLimitedWait', { time: formatDuration(rlRemaining) }) : '';
  const displayError = rateLimitWait || error;

  if (stage === 'backup' && passkey) {
    return (
      <div className="auth-page">
        <passkey.BackupStage email={email} onCancel={restart} />
        <VersionFooter />
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={stage === 'email' ? submitEmail : submitPassword}>
        <img src="/logo.svg" alt="" className="auth-logo" />
        <h1>{t('login.title')}</h1>
        {ban && BanNotice && <BanNotice until={ban.until} reason={ban.reason} indefinite={ban.indefinite} />}
        {info && <div className="info" style={{ color: 'var(--accent, #6EE7B7)', marginBottom: '8px', textAlign: 'center' }}>{info}</div>}
        {displayError && <div className="error">{displayError}</div>}

        {stage === 'email' && (
          <>
            {!oauthConsenting && (
              <>
                <input
                  type="email"
                  placeholder={t('login.email')}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoFocus
                  autoComplete="email username webauthn"
                  inputMode="email"
                />
                <label className="remember-me">
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} />
                  {t('login.rememberMe')}
                </label>
                <button type="submit" disabled={loading || !email.trim()}>
                  {t('login.continue')}
                </button>
              </>
            )}
            {OAuthButtons && <OAuthButtons onResult={handleOAuthResult} onConsentChange={setOauthConsenting} />}
          </>
        )}

        {stage === 'password' && (
          <>
            <p className="settings-hint" style={{ textAlign: 'center', margin: '0 0 6px' }}>{email}</p>
            <input
              type="password"
              placeholder={t('login.password')}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
            <button type="submit" disabled={loading}>
              {t('login.submit')}
            </button>
            <button type="button" onClick={restart} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #888)', fontSize: '13px', marginTop: '4px', textDecoration: 'underline' }}>
              {t('login.backToEmail')}
            </button>
          </>
        )}

        {stage === 'passkey' && passkey && passkeyChallenge && (
          <passkey.Stage
            email={email}
            challenge={passkeyChallenge}
            onSuccess={(result) => login(result.token, result.refreshToken, result.user, rememberMe)}
            onError={setError}
            onRateLimit={rlStart}
            onBan={setBan}
            onUseBackup={() => setStage('backup')}
            onBack={restart}
          />
        )}

        {stage === 'email' && !oauthConsenting && EmailStageLinks && <EmailStageLinks />}
      </form>
      <VersionFooter />
    </div>
  );
}
