import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { TvAuthorizePage } from './TvAuthorizePage';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';

const { mockTvApprove } = vi.hoisted(() => ({ mockTvApprove: vi.fn() }));

vi.mock('../api', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    api: { tvApprove: (...a: unknown[]) => mockTvApprove(...a) },
    ApiError,
  };
});

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./VersionFooter', () => ({ VersionFooter: () => null }));

describe('TvAuthorizePage', () => {
  beforeEach(() => {
    mockTvApprove.mockReset();
    mockTvApprove.mockResolvedValue({ ok: true });
  });

  it('does NOT auto-submit a code prefilled from ?code= — approval needs a click (takeover fix)', async (ctx) => {
    story(ctx, 'Zamknięta luka: link clipnest.video/tv?code=<kod_atakującego> podrzucony ofierze NIE autoryzuje już telewizora sam z siebie. Kod wygodnie wskakuje do pola z ?code=, ale bez świadomego gestu (kliknięcia „Połącz telewizor") nic się nie dzieje — dopiero klik autoryzuje.');
    renderWithRouter(<TvAuthorizePage />, { route: '/tv?code=K7QF-3M9P' });
    const input = screen.getByTestId('tv-code-input') as HTMLInputElement;
    expect(input.value).toBe('K7QF-3M9P');
    // Zero-tap approval was the takeover vector: give any pending effects a beat,
    // then assert nothing was sent without a gesture.
    await new Promise(r => setTimeout(r, 0));
    expect(mockTvApprove).not.toHaveBeenCalled();
    // The deliberate gesture — clicking Authorize — is what submits.
    fireEvent.click(screen.getByTestId('tv-authorize'));
    await waitFor(() => expect(mockTvApprove).toHaveBeenCalledWith('K7QF3M9P'));
    await waitFor(() => expect(screen.getByTestId('tv-success')).toBeInTheDocument());
  });

  it('uppercases whatever the user types', (ctx) => {
    story(ctx, 'Kody na telewizorze są zawsze WIELKIMI literami — pole zamienia wpisywane znaki na wielkie w locie, więc nieważne czy user pisze małymi.');
    renderWithRouter(<TvAuthorizePage />, { route: '/tv' });
    const input = screen.getByTestId('tv-code-input') as HTMLInputElement;
    // Partial code (4 chars) so the field uppercases without tripping auto-submit.
    fireEvent.change(input, { target: { value: 'k7qf' } });
    expect(input.value).toBe('K7QF');
  });

  it('auto-inserts the dash as you type, rendering XXXX-XXXX', (ctx) => {
    story(ctx, 'User wpisuje 8 znaków bez myślnika — pole samo wstawia „-" po 4. znaku, więc kod czyta się jak na telewizorze (XXXX-XXXX), bez ręcznego dziubania myślnika.');
    renderWithRouter(<TvAuthorizePage />, { route: '/tv' });
    const input = screen.getByTestId('tv-code-input') as HTMLInputElement;
    // Five chars (partial, won't auto-submit) typed without a dash.
    fireEvent.change(input, { target: { value: 'k7qf3' } });
    expect(input.value).toBe('K7QF-3');
  });

  it('auto-dashes a full code typed without a dash and submits the canonical form on click', async (ctx) => {
    story(ctx, 'Nawet gdy user wpisze 8 znaków bez myślnika, pole renderuje XXXX-XXXX, a po kliknięciu „Połącz telewizor" do backendu leci kanoniczna forma bez myślnika.');
    renderWithRouter(<TvAuthorizePage />, { route: '/tv' });
    const input = screen.getByTestId('tv-code-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'k7qf3m9p' } });
    expect(input.value).toBe('K7QF-3M9P');
    fireEvent.click(screen.getByTestId('tv-authorize'));
    await waitFor(() => expect(mockTvApprove).toHaveBeenCalledWith('K7QF3M9P'));
  });

  it('does not submit until a full 8-character code is present', (ctx) => {
    story(ctx, 'Niekompletny kod (mniej niż 8 znaków) nie jest wysyłany — broni przed strzałem śmieciowym kodem zanim user dokończy wpisywanie.');
    renderWithRouter(<TvAuthorizePage />, { route: '/tv' });
    fireEvent.change(screen.getByTestId('tv-code-input'), { target: { value: 'K7QF' } });
    expect(mockTvApprove).not.toHaveBeenCalled();
  });

  it('submits the canonical (un-dashed, upper-case) code when Authorize is clicked', async (ctx) => {
    story(ctx, 'Gdy w polu jest 8 poprawnych znaków i user kliknie „Połącz telewizor", kanoniczna forma leci do backendu.');
    renderWithRouter(<TvAuthorizePage />, { route: '/tv' });
    fireEvent.change(screen.getByTestId('tv-code-input'), { target: { value: 'k7qf-3m9p' } });
    fireEvent.click(screen.getByTestId('tv-authorize'));
    await waitFor(() => expect(mockTvApprove).toHaveBeenCalledWith('K7QF3M9P'));
  });

  it('shows the success state once the TV is authorized', async (ctx) => {
    story(ctx, 'Po kliknięciu i zatwierdzeniu user widzi potwierdzenie i wie, że może wrócić do telewizora — ten zaloguje się sam przy najbliższym odpytaniu.');
    renderWithRouter(<TvAuthorizePage />, { route: '/tv?code=K7QF-3M9P' });
    fireEvent.click(screen.getByTestId('tv-authorize'));
    await waitFor(() => expect(screen.getByTestId('tv-success')).toBeInTheDocument());
  });

  it('shows an "expired" message when the code has lapsed', async (ctx) => {
    story(ctx, 'Kod żyje 5 minut — jeśli wygasł, po kliknięciu user dostaje czytelny komunikat i wie, że ma poprosić telewizor o nowy kod, zamiast w kółko próbować ten sam.');
    const { ApiError } = await import('../api');
    mockTvApprove.mockRejectedValueOnce(new ApiError('invalid_or_expired', 400));
    renderWithRouter(<TvAuthorizePage />, { route: '/tv?code=K7QF-3M9P' });
    fireEvent.click(screen.getByTestId('tv-authorize'));
    await waitFor(() => expect(screen.getByText('tv.expired')).toBeInTheDocument());
  });

  it('shows an "invalid code" message for a malformed code', async (ctx) => {
    story(ctx, 'Jeśli backend odrzuci kod jako niepoprawny, komunikat jest inny niż „wygasł" — user wie, że to literówka, a nie kwestia czasu.');
    const { ApiError } = await import('../api');
    mockTvApprove.mockRejectedValueOnce(new ApiError('invalid_code', 400));
    renderWithRouter(<TvAuthorizePage />, { route: '/tv?code=K7QF-3M9P' });
    fireEvent.click(screen.getByTestId('tv-authorize'));
    await waitFor(() => expect(screen.getByText('tv.invalidCode')).toBeInTheDocument());
  });

  it('shows a generic error on an unexpected failure', async (ctx) => {
    story(ctx, 'Na 5xx / błąd sieci pokazujemy generyczny błąd zamiast mylić usera komunikatem o wygaśnięciu — może spróbować ponownie lub odświeżyć.');
    const { ApiError } = await import('../api');
    mockTvApprove.mockRejectedValueOnce(new ApiError('server_error', 500));
    renderWithRouter(<TvAuthorizePage />, { route: '/tv?code=K7QF-3M9P' });
    fireEvent.click(screen.getByTestId('tv-authorize'));
    await waitFor(() => expect(screen.getByText('tv.error')).toBeInTheDocument());
  });

  it('submits a failed code only once per click, then re-fires after the user edits it to a new code', async (ctx) => {
    story(ctx, 'Pojedynczy klik = pojedyncza próba: podwójne kliknięcie tego samego kodu nie strzela dwa razy. Dopiero zmiana na nowy, kompletny kod i kolejny klik wywołuje następną próbę.');
    const { ApiError } = await import('../api');
    mockTvApprove.mockRejectedValueOnce(new ApiError('invalid_code', 400));
    renderWithRouter(<TvAuthorizePage />, { route: '/tv?code=AAAA-AAAA' });
    const button = screen.getByTestId('tv-authorize');
    fireEvent.click(button);
    fireEvent.click(button); // double-click must not double-submit the same code
    await waitFor(() => expect(screen.getByText('tv.invalidCode')).toBeInTheDocument());
    expect(mockTvApprove).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByTestId('tv-code-input'), { target: { value: 'BBBB-BBBB' } });
    fireEvent.click(screen.getByTestId('tv-authorize'));
    await waitFor(() => expect(mockTvApprove).toHaveBeenCalledTimes(2));
    expect(mockTvApprove).toHaveBeenLastCalledWith('BBBBBBBB');
  });
});
