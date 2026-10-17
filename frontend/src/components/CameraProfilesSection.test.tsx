import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CameraProfilesSection } from './CameraProfilesSection';
import { story } from '../test-story';

const apiMocks = vi.hoisted(() => ({
  getCameraProfiles: vi.fn(),
  setCameraProfileMode: vi.fn(),
  createCustomProfile: vi.fn(),
  updateCustomProfile: vi.fn(),
  deleteCustomProfile: vi.fn(),
  resetCameraProfiles: vi.fn(),
  testCameraProfileRegex: vi.fn(),
}));

vi.mock('../api', () => ({
  api: apiMocks,
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const defaultProfile = {
  id: 1,
  name: 'My Camera',
  regex: '^(?<camera>[^_]+)',
  viewDefault: '00' as const,
  viewsConfig: [{ id: '00', iconKind: 'generic' as const }],
  priority: 10,
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
};

// The 4 canonical vendor templates the server surfaces in the
// camera-profiles GET response. Custom mode seeds these when the list is empty.
const templates = [
  { name: 'Reolink', regex: '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$', viewsConfig: [{ id: '00', iconKind: 'wide' as const }, { id: '01', iconKind: 'zoom' as const }] },
  { name: 'Hikvision', regex: '^Webcam_G(?<camera>\\d+)_(?<ts>\\d{14}).*$', viewsConfig: [{ id: '00', iconKind: 'generic' as const }] },
  { name: 'Axis', regex: '^(?<camera>.+)_(?<ts>\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})\\.(?<ext>mp4)$', viewsConfig: [{ id: '00', iconKind: 'generic' as const }] },
  { name: 'Foscam', regex: '^(?<camera>MDAlarm)_(?<ts>\\d{8}-\\d{6})\\.(?<ext>mp4)$', viewsConfig: [{ id: '00', iconKind: 'generic' as const }] },
];

describe('CameraProfilesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'auto', customProfiles: [], templates });
    apiMocks.setCameraProfileMode.mockResolvedValue({ mode: 'auto' });
    apiMocks.createCustomProfile.mockResolvedValue(defaultProfile);
    apiMocks.updateCustomProfile.mockResolvedValue({ ...defaultProfile, enabled: false });
    apiMocks.deleteCustomProfile.mockResolvedValue(undefined);
    apiMocks.testCameraProfileRegex.mockResolvedValue({ result: null });
  });

  it('mode select offers exactly two options: auto and custom', async (ctx) => {
    story(ctx, 'Tryb rozpoznawania jest binarny — użytkownik widzi tylko Auto i Własny; pojedyncze tryby producentów zostały zwinięte do Auto.');
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    const opts = Array.from((select as HTMLSelectElement).options).map(o => o.value);
    expect(opts).toEqual(['auto', 'custom']);
  });

  it('displays a legacy single-vendor mode as auto without auto-persisting', async (ctx) => {
    story(ctx, 'Użytkownik z zapisanym starym trybem "reolink" widzi select ustawiony na Auto (zachowanie-zachowujący nadzbiór) i nic nie jest zapisywane samoczynnie.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'reolink', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    expect((select as HTMLSelectElement).value).toBe('auto');
    // No write should happen just from rendering a legacy mode.
    expect(apiMocks.setCameraProfileMode).not.toHaveBeenCalled();
  });

  it('switching to custom with an empty list seeds the 4 vendor templates', async (ctx) => {
    story(ctx, 'Przełączenie na Własny przy pustej liście zasiewa cztery szablony producentów — użytkownik startuje z działających profili zamiast pustej strony.');
    apiMocks.createCustomProfile.mockImplementation((data: { name: string }) =>
      Promise.resolve({ ...defaultProfile, id: Math.random(), name: data.name }),
    );
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    fireEvent.change(select, { target: { value: 'custom' } });

    await waitFor(() => expect(apiMocks.setCameraProfileMode).toHaveBeenCalledWith('custom'));
    await waitFor(() => expect(apiMocks.createCustomProfile).toHaveBeenCalledTimes(4));
    // Seeded in template order with the vendor names.
    expect(apiMocks.createCustomProfile.mock.calls.map(c => c[0].name))
      .toEqual(['Reolink', 'Hikvision', 'Axis', 'Foscam']);
  });

  it('switching to custom does NOT seed when profiles already exist', async (ctx) => {
    story(ctx, 'Jeśli użytkownik ma już własne profile, przełączenie na Własny nie duplikuje szablonów — tylko zmienia tryb.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'auto', customProfiles: [defaultProfile], templates });
    render(<CameraProfilesSection />);
    const select = await screen.findByTestId('camera-profile-mode-select');
    fireEvent.change(select, { target: { value: 'custom' } });
    await waitFor(() => expect(apiMocks.setCameraProfileMode).toHaveBeenCalledWith('custom'));
    expect(apiMocks.createCustomProfile).not.toHaveBeenCalled();
  });

  it('custom mode shows profiles list', async (ctx) => {
    story(ctx, 'Po wybraniu trybu "custom" pojawia się lista własnych profili — użytkownik może zarządzać regexami dla swoich kamer.');
    apiMocks.getCameraProfiles.mockResolvedValue({
      mode: 'custom',
      customProfiles: [defaultProfile],
      templates,
    });
    render(<CameraProfilesSection />);
    await waitFor(() => expect(screen.getByText('My Camera')).toBeInTheDocument());
  });

  it('"+ Add profile" button shows the inline form', async (ctx) => {
    story(ctx, 'Kliknięcie przycisku dodawania profilu pokazuje formularz inline — użytkownik może wpisać nazwę i regex bez opuszczania strony.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    const btn = await screen.findByTestId('add-profile-btn');
    fireEvent.click(btn);
    expect(screen.getByTestId('profile-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('profile-regex-input')).toBeInTheDocument();
  });

  it('save calls createCustomProfile with form data', async (ctx) => {
    story(ctx, 'Wypełnienie formularza i kliknięcie Save zapisuje profil przez API — nowy profil pojawia się natychmiast na liście.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);

    const addBtn = await screen.findByTestId('add-profile-btn');
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByTestId('profile-name-input'), { target: { value: 'TestCam' } });
    fireEvent.change(screen.getByTestId('profile-regex-input'), { target: { value: '^(?<camera>test)' } });

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    await waitFor(() =>
      expect(apiMocks.createCustomProfile).toHaveBeenCalledWith({
        name: 'TestCam',
        regex: '^(?<camera>test)',
        viewsConfig: [{ id: '00', iconKind: 'generic' }],
        priority: 10,
      }),
    );

    // After save, form closes and new profile name is visible
    await waitFor(() => expect(screen.getByText('My Camera')).toBeInTheDocument());
  });

  it('per-view editor: add a row and pick an icon, then save sends both views', async (ctx) => {
    story(ctx, 'Użytkownik dodaje drugi widok i wybiera ikonę — Save wysyła pełną tablicę viewsConfig z per-widokowymi ikonami.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);

    const addBtn = await screen.findByTestId('add-profile-btn');
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByTestId('profile-name-input'), { target: { value: 'DualCam' } });
    fireEvent.change(screen.getByTestId('profile-regex-input'), { target: { value: '^(?<camera>x)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$' } });

    // First row defaults to id '00'/generic — set its icon to wide.
    fireEvent.change(screen.getByTestId('profile-add-view-id-0'), { target: { value: '00' } });
    fireEvent.change(screen.getByTestId('profile-add-view-icon-0'), { target: { value: 'wide' } });

    // Add a second view row, give it id '01' + tele icon.
    fireEvent.click(screen.getByTestId('profile-add-view-add'));
    fireEvent.change(screen.getByTestId('profile-add-view-id-1'), { target: { value: '01' } });
    fireEvent.change(screen.getByTestId('profile-add-view-icon-1'), { target: { value: 'tele' } });

    fireEvent.click(screen.getByTestId('profile-save-btn'));

    await waitFor(() =>
      expect(apiMocks.createCustomProfile).toHaveBeenCalledWith({
        name: 'DualCam',
        regex: '^(?<camera>x)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
        viewsConfig: [
          { id: '00', iconKind: 'wide' },
          { id: '01', iconKind: 'tele' },
        ],
        priority: 10,
      }),
    );
  });

  it('no longer renders the removed Reolink template button', async (ctx) => {
    story(ctx, 'Przycisk szablonu Reolink został usunięty na rzecz statycznych przykładów — nie powinien już istnieć w formularzu.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    const addBtn = await screen.findByTestId('add-profile-btn');
    fireEvent.click(addBtn);
    expect(screen.queryByTestId('profile-reolink-template-btn')).toBeNull();
    expect(screen.getByTestId('profile-examples')).toBeInTheDocument();
  });

  it('delete button calls deleteCustomProfile', async (ctx) => {
    story(ctx, 'Kliknięcie Delete na profilu i potwierdzenie usuwa go przez API — profil znika z listy bez przeładowania strony.');
    apiMocks.getCameraProfiles.mockResolvedValue({
      mode: 'custom',
      customProfiles: [defaultProfile],
      templates,
    });
    vi.stubGlobal('confirm', () => true);
    render(<CameraProfilesSection />);

    const deleteBtn = await screen.findByTestId('profile-delete-1');
    fireEvent.click(deleteBtn);

    await waitFor(() => expect(apiMocks.deleteCustomProfile).toHaveBeenCalledWith(1));
    // Profile row removed from list
    await waitFor(() => expect(screen.queryByText('My Camera')).toBeNull());
  });

  it('reset to defaults calls the atomic server endpoint — no client-side seed/delete', async (ctx) => {
    story(ctx, 'Reset do domyślnych to jeden atomowy POST /reset — serwer transakcyjnie kasuje i sieje, więc nie ma pustego okna ani konfliktu z capem 20 profili (>16 starych profili blokowało stary seed-first flow).');
    const stale = { ...defaultProfile, id: 99, name: 'StaleCam' };
    const seeded = templates.map((tpl, i) => ({ ...defaultProfile, id: 200 + i, name: tpl.name, priority: (i + 1) * 10 }));
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [stale], templates });
    apiMocks.resetCameraProfiles.mockResolvedValue({ customProfiles: seeded });

    vi.stubGlobal('confirm', () => true);
    render(<CameraProfilesSection />);

    const resetBtn = await screen.findByTestId('reset-profiles-btn');
    fireEvent.click(resetBtn);

    await waitFor(() => expect(apiMocks.resetCameraProfiles).toHaveBeenCalledTimes(1));
    // The old client-driven flow must be gone: no per-template creates, no
    // per-profile deletes (they were the source of the cap deadlock).
    expect(apiMocks.createCustomProfile).not.toHaveBeenCalled();
    expect(apiMocks.deleteCustomProfile).not.toHaveBeenCalled();

    // List reflects the endpoint's returned seeded set.
    await waitFor(() => expect(screen.getByText('Foscam')).toBeInTheDocument());
    expect(screen.queryByText('StaleCam')).toBeNull();
  });

  it('reset failure surfaces the error and re-syncs from the server', async (ctx) => {
    story(ctx, 'Awaria resetu — transakcja po stronie serwera się wycofała, klient pokazuje błąd i dociąga aktualny stan listy.');
    const stale = { ...defaultProfile, id: 99, name: 'StaleCam' };
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'custom', customProfiles: [stale], templates });
    apiMocks.resetCameraProfiles.mockRejectedValue(new Error('boom'));

    vi.stubGlobal('confirm', () => true);
    render(<CameraProfilesSection />);

    fireEvent.click(await screen.findByTestId('reset-profiles-btn'));

    await waitFor(() => expect(apiMocks.resetCameraProfiles).toHaveBeenCalledTimes(1));
    // Best-effort re-sync GET (initial load + post-failure).
    await waitFor(() => expect(apiMocks.getCameraProfiles).toHaveBeenCalledTimes(2));
    // The transaction rolled back server-side, so the stale profile is still there.
    await waitFor(() => expect(screen.getByText('StaleCam')).toBeInTheDocument());
  });

  it('does not show the reset button outside custom mode', async (ctx) => {
    story(ctx, 'Przycisk "Przywróć domyślne" jest dostępny tylko w trybie Własny — w Auto nie ma sensu.');
    apiMocks.getCameraProfiles.mockResolvedValue({ mode: 'auto', customProfiles: [], templates });
    render(<CameraProfilesSection />);
    await screen.findByTestId('camera-profile-mode-select');
    expect(screen.queryByTestId('reset-profiles-btn')).toBeNull();
  });
});
