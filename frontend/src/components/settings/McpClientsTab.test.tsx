import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { McpClientsTab } from './McpClientsTab';

const mockListMcpClients = vi.hoisted(() => vi.fn());
const mockRevokeMcpClient = vi.hoisted(() => vi.fn());

vi.mock('../../api', () => ({
  api: {
    listMcpClients: (...a: unknown[]) => mockListMcpClients(...a),
    revokeMcpClient: (...a: unknown[]) => mockRevokeMcpClient(...a),
  },
}));

vi.mock('../../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (k: string, params?: Record<string, string | number>) => {
    let text = k;
    if (params) {
      for (const [pk, pv] of Object.entries(params)) {
        text = text.replace(`{${pk}}`, String(pv));
      }
    }
    return text;
  }, language: 'en' }),
}));

describe('McpClientsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // happy-dom doesn't define confirm/alert — stub them manually
    window.confirm = vi.fn().mockReturnValue(false);
    window.alert = vi.fn();
  });

  it('renders the empty-state message when no clients are returned', async () => {
    mockListMcpClients.mockResolvedValue({ clients: [] });
    render(<McpClientsTab />);
    await waitFor(() =>
      expect(screen.getByText('settings.mcpClients.empty')).toBeInTheDocument(),
    );
  });

  it('renders a table row with name and Revoke button for an active client', async () => {
    mockListMcpClients.mockResolvedValue({
      clients: [
        {
          clientId: 'abc123',
          clientName: 'Claude Desktop',
          createdAt: '2026-01-01T00:00:00Z',
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    });
    render(<McpClientsTab />);
    await waitFor(() => expect(screen.getByText('Claude Desktop')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'settings.mcpClients.revoke' })).toBeInTheDocument();
  });

  it('calls api.revokeMcpClient when Revoke is clicked and confirm returns true', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockListMcpClients.mockResolvedValue({
      clients: [
        {
          clientId: 'abc123',
          clientName: 'Claude Desktop',
          createdAt: '2026-01-01T00:00:00Z',
          lastUsedAt: '2026-02-01T00:00:00Z',
          revokedAt: null,
        },
      ],
    });
    mockRevokeMcpClient.mockResolvedValue({ ok: true });
    // second call after re-fetch returns empty list
    mockListMcpClients.mockResolvedValueOnce({
      clients: [
        {
          clientId: 'abc123',
          clientName: 'Claude Desktop',
          createdAt: '2026-01-01T00:00:00Z',
          lastUsedAt: '2026-02-01T00:00:00Z',
          revokedAt: null,
        },
      ],
    });
    render(<McpClientsTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mcpClients.revoke' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'settings.mcpClients.revoke' }));
    await waitFor(() => expect(mockRevokeMcpClient).toHaveBeenCalledWith('abc123'));
  });

  it('disables the "Revoke all" button when there are no active clients', async () => {
    mockListMcpClients.mockResolvedValue({
      clients: [
        {
          clientId: 'revoked1',
          clientName: 'Old Client',
          createdAt: '2026-01-01T00:00:00Z',
          lastUsedAt: null,
          revokedAt: '2026-02-01T00:00:00Z',
        },
      ],
    });
    render(<McpClientsTab />);
    await waitFor(() => expect(screen.getByText('Old Client')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'settings.mcpClients.revokeAll' })).toBeDisabled();
  });

  it('revokes every active client and refreshes after confirming "Revoke all"', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const activeClients = [
      {
        clientId: 'abc123',
        clientName: 'Claude Desktop',
        createdAt: '2026-01-01T00:00:00Z',
        lastUsedAt: null,
        revokedAt: null,
      },
      {
        clientId: 'def456',
        clientName: 'Cursor',
        createdAt: '2026-01-02T00:00:00Z',
        lastUsedAt: null,
        revokedAt: null,
      },
      {
        clientId: 'ghi789',
        clientName: 'Already Revoked',
        createdAt: '2026-01-03T00:00:00Z',
        lastUsedAt: null,
        revokedAt: '2026-02-01T00:00:00Z',
      },
    ];
    // First load returns the mixed list (2 active, 1 revoked); the refresh
    // after revoke-all returns everything revoked.
    mockListMcpClients.mockResolvedValueOnce({ clients: activeClients });
    mockListMcpClients.mockResolvedValue({
      clients: activeClients.map((c) => ({ ...c, revokedAt: '2026-03-01T00:00:00Z' })),
    });
    mockRevokeMcpClient.mockResolvedValue(undefined);

    render(<McpClientsTab />);
    const revokeAll = await screen.findByRole('button', { name: 'settings.mcpClients.revokeAll' });
    // The button is rendered disabled while the list loads; wait for the data.
    await waitFor(() => expect(revokeAll).toBeEnabled());

    fireEvent.click(revokeAll);

    // Confirmation dialog shown with the active-client count.
    expect(window.confirm).toHaveBeenCalledWith(
      'settings.mcpClients.confirmRevokeAll'.replace('{count}', '2'),
    );

    await waitFor(() => {
      // Only the two ACTIVE clients are revoked — not the already-revoked one.
      expect(mockRevokeMcpClient).toHaveBeenCalledWith('abc123');
      expect(mockRevokeMcpClient).toHaveBeenCalledWith('def456');
    });
    expect(mockRevokeMcpClient).toHaveBeenCalledTimes(2);
    expect(mockRevokeMcpClient).not.toHaveBeenCalledWith('ghi789');
    // List refreshed: initial load + one reload after revoke-all.
    await waitFor(() => expect(mockListMcpClients).toHaveBeenCalledTimes(2));
  });

  it('does not revoke anything when the "Revoke all" confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockListMcpClients.mockResolvedValue({
      clients: [
        {
          clientId: 'abc123',
          clientName: 'Claude Desktop',
          createdAt: '2026-01-01T00:00:00Z',
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    });
    render(<McpClientsTab />);
    const revokeAll = await screen.findByRole('button', { name: 'settings.mcpClients.revokeAll' });
    await waitFor(() => expect(revokeAll).toBeEnabled());
    fireEvent.click(revokeAll);
    expect(window.confirm).toHaveBeenCalled();
    expect(mockRevokeMcpClient).not.toHaveBeenCalled();
  });
});
