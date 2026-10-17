import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { OAuthConsentPage } from './OAuthConsentPage';
import { renderWithRouter } from '../test-utils';

// Translate every i18n key to a stable token so assertions don't depend on
// which locale is active. LANGUAGES + Language are needed by PublicLayout's
// language switcher (consent page renders inside PublicLayout for visual
// consistency with the rest of the public surface).
vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string) => key,
    language: 'en',
    setLanguage: () => {},
  }),
  LANGUAGES: [
    { code: 'en', label: 'EN' },
    { code: 'pl', label: 'PL' },
  ],
}));

// Stub api.ts entirely — its top-level `__APP_VERSION__` is a Vite `define`
// that vitest doesn't apply, so a real import would crash. We need
// `api.getOauthConsent` and `api.postOauthConsent` plus `ApiError`.
const { mockGetConsent, mockPostConsent } = vi.hoisted(() => ({
  mockGetConsent: vi.fn(),
  mockPostConsent: vi.fn(),
}));

vi.mock('../api', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    api: {
      getOauthConsent: (...args: unknown[]) => mockGetConsent(...args),
      postOauthConsent: (...args: unknown[]) => mockPostConsent(...args),
    },
    ApiError,
  };
});

const CONSENT_DATA = {
  clientName: 'MyCoolMCPClient',
  scopes: ['videos:read', 'videos:delete'],
  redirectUri: 'https://mymcpclient.example.com/callback',
};

describe('OAuthConsentPage', () => {
  beforeEach(() => {
    mockGetConsent.mockReset();
    mockPostConsent.mockReset();
    Object.defineProperty(window, 'location', {
      value: { assign: vi.fn() },
      writable: true,
    });
  });

  it('renders client name, scopes, and redirect URI host on successful fetch', async () => {
    mockGetConsent.mockResolvedValue(CONSENT_DATA);
    renderWithRouter(<OAuthConsentPage />, { route: '/oauth/consent?txn=test-txn-123' });

    await waitFor(() => expect(screen.getByText('MyCoolMCPClient')).toBeInTheDocument());

    expect(screen.getByText('oauth.consent.title')).toBeInTheDocument();
    expect(screen.getByText('oauth.consent.scopeRead')).toBeInTheDocument();
    expect(screen.getByText('oauth.consent.scopeDelete')).toBeInTheDocument();
    // Redirect URI is shown as host only
    expect(screen.getByText('mymcpclient.example.com')).toBeInTheDocument();
    expect(mockGetConsent).toHaveBeenCalledWith('test-txn-123');
  });

  it('shows expired message on 404 from API', async () => {
    const { ApiError } = await import('../api');
    mockGetConsent.mockRejectedValue(new ApiError('Not Found', 404));
    renderWithRouter(<OAuthConsentPage />, { route: '/oauth/consent?txn=expired-txn' });

    await waitFor(() =>
      expect(screen.getByText('oauth.consent.expired')).toBeInTheDocument(),
    );
  });

  it('shows error message on non-404 API error', async () => {
    const { ApiError } = await import('../api');
    mockGetConsent.mockRejectedValue(new ApiError('Internal Server Error', 500));
    renderWithRouter(<OAuthConsentPage />, { route: '/oauth/consent?txn=error-txn' });

    await waitFor(() =>
      expect(screen.getByText('oauth.consent.error')).toBeInTheDocument(),
    );
  });

  it('Approve button triggers POST with decision=approve and redirects', async () => {
    mockGetConsent.mockResolvedValue(CONSENT_DATA);
    mockPostConsent.mockResolvedValue({ redirectUrl: 'https://mymcpclient.example.com/callback?code=abc' });

    renderWithRouter(<OAuthConsentPage />, { route: '/oauth/consent?txn=test-txn-123' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'oauth.consent.approve' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'oauth.consent.approve' }));

    await waitFor(() =>
      expect(mockPostConsent).toHaveBeenCalledWith('test-txn-123', {
        decision: 'approve',
        scopes: ['videos:read', 'videos:delete'],
      }),
    );
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        'https://mymcpclient.example.com/callback?code=abc',
      ),
    );
  });

  it('Deny button triggers POST with decision=deny and no scopes, then redirects', async () => {
    mockGetConsent.mockResolvedValue(CONSENT_DATA);
    mockPostConsent.mockResolvedValue({ redirectUrl: 'https://mymcpclient.example.com/callback?error=access_denied' });

    renderWithRouter(<OAuthConsentPage />, { route: '/oauth/consent?txn=test-txn-123' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'oauth.consent.deny' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'oauth.consent.deny' }));

    await waitFor(() =>
      expect(mockPostConsent).toHaveBeenCalledWith('test-txn-123', { decision: 'deny' }),
    );
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        'https://mymcpclient.example.com/callback?error=access_denied',
      ),
    );
  });

  it('disables both buttons during submission', async () => {
    mockGetConsent.mockResolvedValue(CONSENT_DATA);
    // postOauthConsent never resolves during the test — keeps submitting state
    mockPostConsent.mockReturnValue(new Promise(() => {}));

    renderWithRouter(<OAuthConsentPage />, { route: '/oauth/consent?txn=test-txn-123' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'oauth.consent.approve' })).toBeInTheDocument());

    const approveBtn = screen.getByRole('button', { name: 'oauth.consent.approve' });
    const denyBtn = screen.getByRole('button', { name: 'oauth.consent.deny' });

    expect(approveBtn).not.toBeDisabled();
    expect(denyBtn).not.toBeDisabled();

    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(approveBtn).toBeDisabled();
      expect(denyBtn).toBeDisabled();
    });
  });
});
