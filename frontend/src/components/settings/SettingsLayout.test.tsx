import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { story } from '../../test-story';

const mockEdition = vi.hoisted(() => ({
  edition: { ProfileTab: null as unknown, settingsTabs: [] as unknown[] },
}));
vi.mock('../../edition', () => mockEdition);
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ isAdmin: false }) }));
vi.mock('../../i18n', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { SettingsLayout } from './SettingsLayout';

const renderLayout = () => render(<MemoryRouter><SettingsLayout /></MemoryRouter>);

describe('SettingsLayout edition tabs', () => {
  it('bez zakładek edycji (self-hosted) nie ma zakładki Subskrypcja', (ctx) => {
    story(ctx, 'Edycja bez settingsTabs pokazuje tylko zakładki rdzenia.');
    mockEdition.edition.settingsTabs = [];
    renderLayout();
    expect(screen.queryByText('settings.tabSubscription')).toBeNull();
    expect(screen.getByText('settings.tabGeneral')).toBeInTheDocument();
  });

  it('zakładka edycji jest widoczna tylko gdy hook widoczności zwraca true', (ctx) => {
    story(ctx, 'Zakładka edycji respektuje własny hook widoczności.');
    mockEdition.edition.settingsTabs = [{ path: 'subscription', labelKey: 'settings.tabSubscription', element: null, useVisible: () => false }];
    const { unmount } = renderLayout();
    expect(screen.queryByText('settings.tabSubscription')).toBeNull();
    unmount();
    mockEdition.edition.settingsTabs = [{ path: 'subscription', labelKey: 'settings.tabSubscription', element: null, useVisible: () => true }];
    renderLayout();
    expect(screen.getByText('settings.tabSubscription')).toBeInTheDocument();
  });
});
