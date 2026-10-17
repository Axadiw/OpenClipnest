import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CameraConnectionDetails } from './CameraConnectionDetails';
import { story } from '../test-story';

const state = vi.hoisted(() => ({
  config: null as null | { features: { passkeys: boolean }; ftps: { host: string; port: number } },
  user: null as null | { email: string },
}));
const copyText = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useServerConfig', () => ({
  useServerConfig: () => state.config,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: state.user }),
}));

vi.mock('../utils/clipboard', () => ({
  copyText: (...a: unknown[]) => copyText(...a),
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));

const P = 'events.emptyFirstTime.connect.';

function selfHosted(overrides: Partial<{ host: string; port: number; passkeys: boolean }> = {}) {
  state.config = {
    features: { passkeys: overrides.passkeys ?? false },
    ftps: { host: overrides.host ?? '192.168.1.10', port: overrides.port ?? 21 },
  };
  state.user = { email: 'owner@example.test' };
}

describe('CameraConnectionDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.config = null;
    state.user = null;
    copyText.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists everything a camera needs: server, port, user name, password, encryption and the passive-mode hint', (ctx) => {
    story(ctx, 'Pusty ekran świeżej instalacji podaje wszystko, co trzeba wpisać w kamerze: adres i port FTP z konfiguracji serwera, e-mail konta jako nazwę użytkownika, informację że hasło to hasło konta, zalecenie FTPS i wskazówkę o trybie pasywnym — bez zaglądania do README.');
    selfHosted();
    render(<CameraConnectionDetails />);

    expect(screen.getByTestId('camera-connect')).toBeInTheDocument();
    expect(screen.getByText(`${P}title`)).toBeInTheDocument();
    expect(screen.getByText('192.168.1.10')).toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();
    expect(screen.getByText('owner@example.test')).toBeInTheDocument();
    expect(screen.getByText(`${P}passwordValue`)).toBeInTheDocument();
    expect(screen.getByText(`${P}encryptionValue`)).toBeInTheDocument();
    expect(screen.getByText(`${P}passiveHint {"host":"192.168.1.10"}`)).toBeInTheDocument();
  });

  it('offers a copy button for the server, the port and the user name — not for the password or the notes', (ctx) => {
    story(ctx, 'Przycisk "Kopiuj" jest przy trzech wartościach, które się przepisuje do kamery; przy haśle i opisach go nie ma — hasło konta nie jest nigdzie wyświetlane ani kopiowane.');
    selfHosted();
    render(<CameraConnectionDetails />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(screen.getByRole('button', { name: new RegExp(`${P}server`) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(`${P}port`) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(`${P}username`) })).toBeInTheDocument();
  });

  it('copies the value of its own row and confirms briefly', async (ctx) => {
    story(ctx, 'Kliknięcie "Kopiuj" przy adresie serwera wkłada do schowka dokładnie ten adres i na chwilę zmienia napis na "Skopiowano", po czym wraca do "Kopiuj" — użytkownik widzi, że zadziałało.');
    vi.useFakeTimers();
    selfHosted();
    render(<CameraConnectionDetails />);

    const button = screen.getByRole('button', { name: new RegExp(`${P}server`) });
    expect(button).toHaveTextContent(`${P}copy`);
    await act(async () => { fireEvent.click(button); });

    expect(copyText).toHaveBeenCalledWith('192.168.1.10');
    expect(button).toHaveTextContent(`${P}copied`);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(button).toHaveTextContent(`${P}copy`);
    expect(button).not.toHaveTextContent(`${P}copied`);
  });

  it('copies the e-mail and the port from their own rows', async (ctx) => {
    story(ctx, 'Każdy przycisk kopiuje wartość ze swojego wiersza — e-mail trafia do schowka jako nazwa użytkownika, port jako sam numer.');
    selfHosted({ port: 2121 });
    render(<CameraConnectionDetails />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(`${P}username`) })); });
    expect(copyText).toHaveBeenLastCalledWith('owner@example.test');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(`${P}port`) })); });
    expect(copyText).toHaveBeenLastCalledWith('2121');
  });

  it('does not claim "Copied" when the browser refused to copy', async (ctx) => {
    story(ctx, 'Jeśli przeglądarka nie pozwoli skopiować, napis nie zmienia się na "Skopiowano" — użytkownik nie jest wprowadzany w błąd i może zaznaczyć wartość ręcznie.');
    copyText.mockResolvedValue(false);
    selfHosted();
    render(<CameraConnectionDetails />);

    const button = screen.getByRole('button', { name: new RegExp(`${P}server`) });
    await act(async () => { fireEvent.click(button); });
    expect(copyText).toHaveBeenCalled();
    expect(button).toHaveTextContent(`${P}copy`);
    expect(button).not.toHaveTextContent(`${P}copied`);
  });

  it('renders nothing until the server configuration has loaded', (ctx) => {
    story(ctx, 'Dopóki /config się nie wczyta (albo gdy się nie uda), pusty ekran pokazuje zwykły komunikat bez dziur i bez zgadywania adresu FTP.');
    state.user = { email: 'owner@example.test' };
    const { container } = render(<CameraConnectionDetails />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a server with passkeys, where the FTP password is not the account password', (ctx) => {
    story(ctx, 'Gdy serwer obsługuje passkeys, konto może mieć osobne hasło FTP — podpowiedź "hasło konta" byłaby fałszywa, więc blok się nie pokazuje.');
    selfHosted({ passkeys: true });
    const { container } = render(<CameraConnectionDetails />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without a signed-in user e-mail or with an unusable host or port', (ctx) => {
    story(ctx, 'Brak e-maila konta, pustego hosta albo niepoprawnego portu nie wyświetla niepełnej instrukcji — lepiej nic niż błędne dane do wpisania w kamerze.');
    selfHosted();
    state.user = null;
    const noUser = render(<CameraConnectionDetails />);
    expect(noUser.container).toBeEmptyDOMElement();
    noUser.unmount();

    selfHosted({ host: '' });
    const noHost = render(<CameraConnectionDetails />);
    expect(noHost.container).toBeEmptyDOMElement();
    noHost.unmount();

    selfHosted({ port: Number.NaN });
    const badPort = render(<CameraConnectionDetails />);
    expect(badPort.container).toBeEmptyDOMElement();
  });
});
