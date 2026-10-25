import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, act, fireEvent } from '@testing-library/react';
import { LoginPage } from './LoginPage';
import { renderWithRouter } from '../test-utils';
import { api, ApiError } from '../api';
import { story } from '../test-story';

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params && 'time' in params ? `${key} ${params.time}` : key,
  }),
}));
// Password-only sign-in (no passkey pre-flight), as in the self-hosted edition.
vi.mock('../edition', async () => await import('../editions/selfhost'));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ login: vi.fn() }) }));

describe('LoginPage — rate-limit countdown on password submit', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('shows a ticking countdown when the password endpoint returns 429', async (ctx) => {
    story(ctx, 'Limit logowania (10 prób / 15 min) na /auth/login wpadał dotąd w generyczne "błąd logowania". Teraz użytkownik widzi konkretne "Spróbuj ponownie za 0:40" — i to samo, niezależnie czy padł limiter per-IP czy per-email (brak oracle enumeracji kont).');
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('rl', 429, undefined, 40));

    renderWithRouter(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('login.email'), { target: { value: 'a@b.co' } });
    await act(async () => { fireEvent.click(screen.getByText('login.continue')); });

    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });

    expect(screen.getByText(/login\.rateLimitedWait 0:40/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/0:39/)).toBeInTheDocument();
  });
});

describe('LoginPage — after the e-mail confirmation link', () => {
  it('says the account can sign in when the link marks it ready', (ctx) => {
    story(ctx, 'Konto z opłaconym planem jest aktywne od rejestracji — po potwierdzeniu adresu (?verified=1&ready=1) strona logowania mówi „możesz się zalogować”, a nie „czekaj na admina”.');
    renderWithRouter(<LoginPage />, { route: '/login?verified=1&ready=1' });
    expect(screen.getByText('login.verifiedReady')).toBeInTheDocument();
    expect(screen.queryByText('login.verifiedSuccess')).toBeNull();
  });

  it('keeps the awaiting-activation copy for other accounts', (ctx) => {
    story(ctx, 'Bez ready=1 (zwykła rejestracja czekająca na admina) komunikat zostaje bez zmian.');
    renderWithRouter(<LoginPage />, { route: '/login?verified=1' });
    expect(screen.getByText('login.verifiedSuccess')).toBeInTheDocument();
  });
});

describe('LoginPage — an address that is not confirmed yet', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('asks to confirm the address instead of showing a generic error', async (ctx) => {
    story(ctx, 'Gdy serwer odmawia logowania kodem 403 EMAIL_NOT_VERIFIED (poprawne hasło, niepotwierdzony adres), strona logowania pokazuje „Potwierdź adres e-mail — wysłaliśmy Ci link” zamiast „konto czeka na admina” czy ogólnego błędu.');
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('Confirm your e-mail address first', 403, { code: 'EMAIL_NOT_VERIFIED' }));

    renderWithRouter(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('login.email'), { target: { value: 'a@b.co' } });
    await act(async () => { fireEvent.click(screen.getByText('login.continue')); });
    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });

    expect(screen.getByTestId('login-email-not-verified')).toHaveTextContent('login.emailNotVerified');
    expect(screen.queryByText('login.inactive')).toBeNull();
    expect(screen.queryByText('login.error')).toBeNull();
  });

  it('keeps the activation copy for any other 403', async (ctx) => {
    story(ctx, 'Inne 403 (bez kodu EMAIL_NOT_VERIFIED) nadal pokazują dotychczasowy komunikat o aktywacji.');
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('Forbidden', 403, {}));

    renderWithRouter(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('login.email'), { target: { value: 'a@b.co' } });
    await act(async () => { fireEvent.click(screen.getByText('login.continue')); });
    fireEvent.change(screen.getByPlaceholderText('login.password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByText('login.submit')); });

    expect(screen.getByText('login.inactive')).toBeInTheDocument();
    expect(screen.queryByTestId('login-email-not-verified')).toBeNull();
  });
});
