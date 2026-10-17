import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { RateLimitToast } from './RateLimitToast';
import { story } from '../test-story';

// Key-passthrough i18n that appends the {time} param so assertions can see
// the live countdown value the component substitutes in.
vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params && 'time' in params ? `${key} ${params.time}` : key,
  }),
}));

const RATE_LIMITED = 'clipnest:rate-limited';
function fire(retryAfter?: number) {
  act(() => {
    window.dispatchEvent(new CustomEvent(RATE_LIMITED, { detail: { retryAfter } }));
  });
}

describe('RateLimitToast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders nothing until a rate-limit event fires', (ctx) => {
    story(ctx, 'Dopóki nie wpadnie 429, powiadomienie jest niewidoczne — zero szumu w normalnym użyciu.');
    render(<RateLimitToast />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a ticking countdown built from the Retry-After seconds', (ctx) => {
    story(ctx, 'Po przekroczeniu limitu użytkownik widzi konkretne "Spróbuj ponownie za 0:30" i jak liczba spada co sekundę — dokładnie odpowiedź na "ile zostało".');
    render(<RateLimitToast />);
    fire(30);
    expect(screen.getByText(/0:30/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/0:29/)).toBeInTheDocument();
  });

  it('disappears once the countdown reaches zero', (ctx) => {
    story(ctx, 'Gdy cooldown minie, powiadomienie samo znika — nie zostaje wisieć martwe "0:00".');
    render(<RateLimitToast />);
    fire(2);
    expect(screen.getByText(/0:02/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('coalesces parallel 429s into one notice (longest wait wins)', (ctx) => {
    story(ctx, 'Jeden CMD+R odpala kilka 429 naraz — pokazujemy jeden licznik z najdłuższym Retry-After, nie stos toastów.');
    render(<RateLimitToast />);
    fire(5);
    fire(10);
    fire(3);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText(/0:10/)).toBeInTheDocument();
  });

  it('falls back to a numberless message when Retry-After is missing', (ctx) => {
    story(ctx, 'Gdy 429 nie niesie nagłówka (ingress/nginx), pokazujemy ogólne "odczekaj chwilę" zamiast zmyślonego zera.');
    render(<RateLimitToast />);
    fire(undefined);
    expect(screen.getByText('errors.rateLimitedShort')).toBeInTheDocument();
  });

  it('can be dismissed manually', (ctx) => {
    story(ctx, 'Użytkownik może zamknąć powiadomienie ×, nie czekając do zera.');
    render(<RateLimitToast />);
    fire(30);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
