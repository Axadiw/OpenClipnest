import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyRecordings } from './EmptyRecordings';
import { story } from '../test-story';

const state = vi.hoisted(() => ({
  config: null as null | { features: { passkeys: boolean }; ftps: { host: string; port: number } },
  user: null as null | { email: string },
}));

vi.mock('../hooks/useServerConfig', () => ({
  useServerConfig: () => state.config,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: state.user }),
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('EmptyRecordings', () => {
  beforeEach(() => {
    state.config = null;
    state.user = null;
  });

  it('renders empty-recordings testid and i18n keys', (ctx) => {
    story(ctx, 'Nowy użytkownik bez nagrań widzi przyjazny komunikat z instrukcją, jak dodać pierwsze nagranie — zamiast pustego ekranu dostaje pomocną wskazówkę.');
    render(<EmptyRecordings />);
    expect(screen.getByTestId('empty-recordings')).toBeInTheDocument();
    expect(screen.getByText('events.emptyFirstTime.title')).toBeInTheDocument();
    expect(screen.getByText('events.emptyFirstTime.body')).toBeInTheDocument();
  });

  it('renders upload icon svg', (ctx) => {
    story(ctx, 'Pusta strona jest wzbogacona o ikonę uploadu, która wizualnie podpowiada kolejny krok — zachęta do działania, a nie tylko tekst.');
    render(<EmptyRecordings />);
    const svg = document.querySelector('.empty-recordings svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders the filtered copy (not the first-time copy) when filtered', (ctx) => {
    story(ctx, 'Gdy filtry odsiały wszystkie nagrania, użytkownik widzi komunikat "nic nie pasuje do filtrów" zamiast mylącego "brak nagrań" — wie, że nagrania istnieją, tylko są ukryte.');
    render(<EmptyRecordings filtered onClearFilters={vi.fn()} />);
    expect(screen.getByText('events.emptyFiltered.title')).toBeInTheDocument();
    expect(screen.getByText('events.emptyFiltered.body')).toBeInTheDocument();
    expect(screen.queryByText('events.emptyFirstTime.title')).not.toBeInTheDocument();
  });

  it('shows a Clear filters button that invokes onClearFilters when filtered', (ctx) => {
    story(ctx, 'Pusty-przefiltrowany stan oferuje jeden klik "Wyczyść filtry", który zdejmuje wszystkie filtry i przywraca pełną listę — użytkownik nie musi ręcznie odznaczać każdego filtra.');
    const onClearFilters = vi.fn();
    render(<EmptyRecordings filtered onClearFilters={onClearFilters} />);
    const btn = screen.getByRole('button', { name: 'events.clearFilters' });
    fireEvent.click(btn);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('does not show the Clear filters button in first-time (non-filtered) mode', (ctx) => {
    story(ctx, 'Świeży użytkownik bez filtrów nie widzi przycisku czyszczenia filtrów — nie ma czego czyścić, więc UI nie sugeruje nieistniejącej akcji.');
    render(<EmptyRecordings />);
    expect(screen.queryByRole('button', { name: 'events.clearFilters' })).not.toBeInTheDocument();
  });

  it('shows the camera connection details under the first-time message', (ctx) => {
    story(ctx, 'Świeża instalacja bez nagrań pokazuje pod komunikatem "Brak nagrań" dane do wpisania w kamerze (host, port, e-mail konta) — użytkownik od razu wie, dokąd kamera ma wysyłać pliki.');
    state.config = { features: { passkeys: false }, ftps: { host: '192.168.1.10', port: 21 } };
    state.user = { email: 'owner@example.test' };
    render(<EmptyRecordings />);
    expect(screen.getByTestId('camera-connect')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.10')).toBeInTheDocument();
    expect(screen.getByText('owner@example.test')).toBeInTheDocument();
  });

  it('keeps the first-time message alone while the server configuration is unavailable', (ctx) => {
    story(ctx, 'Gdy /config nie odpowiada, pusty ekran nadal pokazuje swój zwykły komunikat — brak danych FTP nie psuje widoku.');
    render(<EmptyRecordings />);
    expect(screen.getByText('events.emptyFirstTime.title')).toBeInTheDocument();
    expect(screen.queryByTestId('camera-connect')).not.toBeInTheDocument();
  });

  it('does not show the connection details when filters, not an empty account, hid the recordings', (ctx) => {
    story(ctx, 'Gdy nagrania ukryły filtry, użytkownik już je ma i kamera działa — instrukcja podłączania kamery byłaby tu szumem, więc jej nie ma.');
    state.config = { features: { passkeys: false }, ftps: { host: '192.168.1.10', port: 21 } };
    state.user = { email: 'owner@example.test' };
    render(<EmptyRecordings filtered onClearFilters={vi.fn()} />);
    expect(screen.queryByTestId('camera-connect')).not.toBeInTheDocument();
  });
});
