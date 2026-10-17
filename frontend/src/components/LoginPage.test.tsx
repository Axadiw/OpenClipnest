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
