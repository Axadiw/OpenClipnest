import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useTranslation } from '../i18n';
import { edition } from '../edition';
// No <Seo> on the consent screen — it's an OAuth flow page, not a marketing
// surface, and shouldn't appear in search results.

interface ConsentInfo {
  clientName: string;
  scopes: string[];
  redirectUri: string;
}

type PageState =
  | { kind: 'loading' }
  | { kind: 'expired' }
  | { kind: 'error' }
  | { kind: 'ready'; info: ConsentInfo }
  | { kind: 'submitting'; info: ConsentInfo };

function scopeLabel(scope: string, t: (key: string) => string): string {
  if (scope === 'videos:read') return t('oauth.consent.scopeRead');
  if (scope === 'videos:delete') return t('oauth.consent.scopeDelete');
  if (scope === 'account:read') return t('oauth.consent.scopeAccountRead');
  if (scope === 'notifications:write') return t('oauth.consent.scopeNotificationsWrite');
  return scope;
}

function parseHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

// The edition decides the chrome around the consent card (cloud: the public
// site layout; self-hosted: the plain auth card).
const ConsentShell = edition.FlowLayout;

export function OAuthConsentPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const txn = searchParams.get('txn') ?? '';
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.getOauthConsent(txn).then((info) => {
      if (!cancelled) setState({ kind: 'ready', info });
    }).catch((err: unknown) => {
      if (cancelled) return;
      if (err instanceof ApiError && err.status === 404) {
        setState({ kind: 'expired' });
      } else {
        setState({ kind: 'error' });
      }
    });
    return () => { cancelled = true; };
  }, [txn]);

  async function handleDecision(decision: 'approve' | 'deny') {
    if (state.kind !== 'ready') return;
    const info = state.info;
    setState({ kind: 'submitting', info });
    try {
      const body: { decision: 'approve' | 'deny'; scopes?: string[] } =
        decision === 'approve'
          ? { decision: 'approve', scopes: info.scopes }
          : { decision: 'deny' };
      const { redirectUrl } = await api.postOauthConsent(txn, body);
      window.location.assign(redirectUrl);
    } catch {
      setState({ kind: 'error' });
    }
  }

  if (state.kind === 'loading') {
    return (
      <ConsentShell>
        <p style={{ color: 'var(--text2)', fontSize: 15, lineHeight: 1.7 }}>
          {t('common.loading')}
        </p>
      </ConsentShell>
    );
  }

  if (state.kind === 'expired') {
    return (
      <ConsentShell>
        <h1>{t('oauth.consent.title')}</h1>
        <p style={{ color: 'var(--text2)', fontSize: 15, lineHeight: 1.7 }}>
          {t('oauth.consent.expired')}
        </p>
      </ConsentShell>
    );
  }

  if (state.kind === 'error') {
    return (
      <ConsentShell>
        <h1>{t('oauth.consent.title')}</h1>
        <p style={{ color: 'var(--text2)', fontSize: 15, lineHeight: 1.7 }}>
          {t('oauth.consent.error')}
        </p>
      </ConsentShell>
    );
  }

  const { info } = state;
  const submitting = state.kind === 'submitting';
  const redirectHost = parseHost(info.redirectUri);

  return (
    <ConsentShell>
      <h1>{t('oauth.consent.title')}</h1>
      <p style={{ color: 'var(--text2)', fontSize: 15, lineHeight: 1.7 }}>
        {t('oauth.consent.intro')}
      </p>

      <div className="settings-section" style={{ marginTop: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.3px' }}>
          {info.clientName}
        </div>
      </div>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12, letterSpacing: '-0.3px' }}>
        {t('oauth.consent.scopesHeader')}
      </h2>
      <ul style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.6, marginTop: 0, marginBottom: 24, paddingLeft: 20 }}>
        {info.scopes.map((scope) => (
          <li key={scope}>{scopeLabel(scope, t)}</li>
        ))}
      </ul>

      <div className="settings-section" style={{ marginBottom: 24 }}>
        <div style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.6, marginBottom: 8 }}>
          {t('oauth.consent.redirectInfo')}
        </div>
        <code style={{ fontSize: 14 }}>{redirectHost}</code>
        <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6, marginTop: 12, marginBottom: 0 }}>
          {t('oauth.consent.phishingWarning')}
        </p>
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting}
          onClick={() => handleDecision('approve')}
        >
          {t('oauth.consent.approve')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={submitting}
          onClick={() => handleDecision('deny')}
        >
          {t('oauth.consent.deny')}
        </button>
      </div>

      <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6, marginTop: 32, marginBottom: 0 }}>
        {t('oauth.consent.surviveHint')}
      </p>
    </ConsentShell>
  );
}
