import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../../testing/story.js';

// The `settings` table, kept in memory across simulated restarts.
const stored = new Map<string, string>();
vi.mock('../../db/queries/settings.js', () => ({
  getSetting: async (key: string) => stored.get(key) ?? null,
  setSetting: async (key: string, value: string) => { stored.set(key, value); },
}));

/** A fresh copy of the module, as a restarted server would load it. */
async function restartedRelayIdentity() {
  vi.resetModules();
  return (await import('./relayIdentity.js')).relayIdentity;
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ instanceId: 'inst-42' }), { status: 200 }));

beforeEach(() => {
  stored.clear();
  fetchMock.mockClear();
});

describe('relayIdentity', () => {
  it('keeps the same collapse id for a camera across restarts', async (ctx) => {
    story(ctx, 'Klucz collapseId wywodzi się z klucza instancji zapisanego w bazie, więc po restarcie serwera banery tej samej kamery dalej grupują się razem.');
    const first = await (await restartedRelayIdentity())('https://push.example', fetchMock as unknown as typeof fetch);
    const second = await (await restartedRelayIdentity())('https://push.example', fetchMock as unknown as typeof fetch);

    expect(first.collapseId('Driveway')).toBe(second.collapseId('Driveway'));
    expect(first.collapseId('Driveway')).not.toBe(first.collapseId('Garage'));
    expect(second.instanceId).toBe('inst-42');
    expect(fetchMock).toHaveBeenCalledTimes(1); // registered once, reused after the restart
  });

  it('gives another instance other collapse ids', async () => {
    const a = await (await restartedRelayIdentity())('https://push.example', fetchMock as unknown as typeof fetch);
    stored.clear(); // a different install: new key pair
    const b = await (await restartedRelayIdentity())('https://push.example', fetchMock as unknown as typeof fetch);
    expect(a.collapseId('Driveway')).not.toBe(b.collapseId('Driveway'));
  });
});
