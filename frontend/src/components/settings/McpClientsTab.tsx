import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '../../i18n';
import { api } from '../../api';

interface ClientRow {
  clientId: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; clients: ClientRow[] };

export function McpClientsTab() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const res = await api.listMcpClients();
      setState({ status: 'loaded', clients: res.clients });
    } catch {
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRevoke = async (client: ClientRow) => {
    const confirmed = window.confirm(
      t('settings.mcpClients.confirmRevoke', { name: client.clientName }),
    );
    if (!confirmed) return;
    try {
      await api.revokeMcpClient(client.clientId);
      await load();
    } catch {
      alert(t('settings.mcpClients.revokeError'));
    }
  };

  const activeClients =
    state.status === 'loaded' ? state.clients.filter((c) => c.revokedAt === null) : [];

  const handleRevokeAll = async () => {
    if (activeClients.length === 0) return;
    const confirmed = window.confirm(
      t('settings.mcpClients.confirmRevokeAll', { count: activeClients.length }),
    );
    if (!confirmed) return;
    try {
      // No bulk endpoint exists server-side; iterate over active clients and
      // revoke each via the existing per-client API, then refresh once.
      for (const client of activeClients) {
        await api.revokeMcpClient(client.clientId);
      }
      await load();
    } catch {
      alert(t('settings.mcpClients.revokeAllError'));
      // Refresh anyway so the UI reflects whichever clients were revoked
      // before the failure.
      await load();
    }
  };

  const formatDate = (iso: string | null): string => {
    if (iso === null) return t('settings.mcpClients.never');
    return new Date(iso).toLocaleString();
  };

  return (
    <section className="settings-section">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          margin: '0 0 16px',
        }}
      >
        <p style={{ margin: 0 }}>{t('settings.mcpClients.intro')}</p>
        <button
          className="btn btn-sm btn-danger"
          onClick={handleRevokeAll}
          disabled={activeClients.length === 0}
          style={{ flexShrink: 0 }}
        >
          {t('settings.mcpClients.revokeAll')}
        </button>
      </div>

      {state.status === 'loading' && (
        <p style={{ color: 'var(--text-muted, #888)' }}>Loading…</p>
      )}

      {state.status === 'error' && (
        <div>
          <p style={{ color: 'var(--error, #ef4444)' }}>Failed to load MCP clients.</p>
          <button className="btn btn-sm" onClick={load}>Retry</button>
        </div>
      )}

      {state.status === 'loaded' && state.clients.length === 0 && (
        <p style={{ color: 'var(--text-muted, #888)' }}>{t('settings.mcpClients.empty', { url: `${window.location.origin}/mcp` })}</p>
      )}

      {state.status === 'loaded' && state.clients.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border, #333)' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.mcpClients.colName')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.mcpClients.colCreated')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.mcpClients.colLastUsed')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.mcpClients.colStatus')}</th>
              <th style={{ padding: '6px 8px' }} />
            </tr>
          </thead>
          <tbody>
            {state.clients.map((c) => (
              <tr key={c.clientId} style={{ borderBottom: '1px solid var(--border-subtle, #222)' }}>
                <td style={{ padding: '8px' }}>{c.clientName}</td>
                <td style={{ padding: '8px', color: 'var(--text-muted, #888)' }}>
                  {formatDate(c.createdAt)}
                </td>
                <td style={{ padding: '8px', color: 'var(--text-muted, #888)' }}>
                  {formatDate(c.lastUsedAt)}
                </td>
                <td style={{ padding: '8px' }}>
                  {c.revokedAt === null
                    ? t('settings.mcpClients.statusActive')
                    : t('settings.mcpClients.statusRevoked')}
                </td>
                <td style={{ padding: '8px', textAlign: 'right' }}>
                  {c.revokedAt === null && (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => handleRevoke(c)}
                    >
                      {t('settings.mcpClients.revoke')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
