import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StorageSection } from './StorageSection';
import { story } from '../test-story';

const apiMocks = vi.hoisted(() => ({
  getUsage: vi.fn(),
  getUsageByCamera: vi.fn(),
  getAutoDelete: vi.fn(),
  getAutoDeleteAfterDays: vi.fn(),
  setAutoDelete: vi.fn(),
  setAutoDeleteAfterDays: vi.fn(),
}));

vi.mock('../api', () => ({
  api: apiMocks,
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const GB = 1024 ** 3;

function usage(disk: { usageBytes: number; limitBytes: number }, transfer: { usageBytes: number; limitBytes: number }) {
  const percent = (u: number, l: number) => (l > 0 ? Math.round((u / l) * 100) : 0);
  return {
    disk: { ...disk, percent: percent(disk.usageBytes, disk.limitBytes) },
    transfer: { ...transfer, percent: percent(transfer.usageBytes, transfer.limitBytes), resetAt: null },
  };
}

describe('StorageSection — usage bars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getUsageByCamera.mockResolvedValue({ cameras: [] });
    apiMocks.getAutoDelete.mockResolvedValue({ enabled: false });
    apiMocks.getAutoDeleteAfterDays.mockResolvedValue({ days: null });
  });

  it('shows no transfer bar when the account has neither a transfer limit nor any transfer', async (ctx) => {
    story(ctx, 'Konto bez planu (serwer self-hosted) nie ma limitu transferu ani nic do pokazania — zamiast bezsensownego paska "0 B · Bez limitu" widzi tylko zużycie dysku z napisem "Bez limitu".');
    apiMocks.getUsage.mockResolvedValue(usage({ usageBytes: 3 * GB, limitBytes: 0 }, { usageBytes: 0, limitBytes: 0 }));
    const { container } = render(<StorageSection />);

    await waitFor(() => expect(screen.getByText('usage.diskUsage')).toBeInTheDocument());
    expect(screen.getByText(/usage\.unlimited/)).toBeInTheDocument();
    expect(screen.queryByText('usage.transferUsage')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.usage-bar-container')).toHaveLength(1);
  });

  it('keeps the disk bar with its limit and still no transfer bar on an install with only a disk limit', async (ctx) => {
    story(ctx, 'Instalacja z ustawionym limitem dysku (bez limitu transferu) widzi pasek zajętości dysku z procentami, ale nie dostaje drugiego, pustego paska transferu.');
    apiMocks.getUsage.mockResolvedValue(usage({ usageBytes: 100 * GB, limitBytes: 500 * GB }, { usageBytes: 0, limitBytes: 0 }));
    const { container } = render(<StorageSection />);

    await waitFor(() => expect(screen.getByText('usage.diskUsage')).toBeInTheDocument());
    expect(screen.getByText('20%')).toBeInTheDocument();
    expect(screen.queryByText('usage.transferUsage')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.usage-bar-container')).toHaveLength(1);
  });

  it('shows both bars when the plan limits transfer', async (ctx) => {
    story(ctx, 'Konto z planem, który limituje transfer, nadal widzi oba paski — disk i transfer — żeby wiedzieć, kiedy zbliża się do limitu.');
    apiMocks.getUsage.mockResolvedValue(usage({ usageBytes: 1 * GB, limitBytes: 4 * GB }, { usageBytes: 1 * GB, limitBytes: 5 * GB }));
    const { container } = render(<StorageSection />);

    await waitFor(() => expect(screen.getByText('usage.transferUsage')).toBeInTheDocument());
    expect(screen.getByText('usage.diskUsage')).toBeInTheDocument();
    expect(container.querySelectorAll('.usage-bar-container')).toHaveLength(2);
  });

  it('keeps the transfer row, with the unlimited wording, once data has actually been transferred', async (ctx) => {
    story(ctx, 'Bez limitu, ale z realnym transferem w tym miesiącu, wiersz transferu zostaje i pokazuje ile przesłano z dopiskiem "Bez limitu" — pusty jest ukrywany, nie ten z danymi.');
    apiMocks.getUsage.mockResolvedValue(usage({ usageBytes: 3 * GB, limitBytes: 0 }, { usageBytes: 2 * GB, limitBytes: 0 }));
    render(<StorageSection />);

    await waitFor(() => expect(screen.getByText('usage.transferUsage')).toBeInTheDocument());
    expect(screen.getByText('2 GB · usage.unlimited')).toBeInTheDocument();
  });
});
