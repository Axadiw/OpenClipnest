import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccountLockedBanner } from './AccountLockedBanner';
import { story } from '../test-story';

vi.mock('../i18n', async () => {
  const { en } = await import('../i18n/en');
  return {
    registerTranslations: vi.fn(),
    useTranslation: () => ({ t: (key: string) => (en as Record<string, string>)[key] ?? key }),
  };
});

describe('AccountLockedBanner', () => {
  it('renders the banner when locked', (ctx) => {
    story(ctx, 'Zablokowane konto widzi komunikat, że odtwarzanie i pobieranie są niedostępne.');
    render(<AccountLockedBanner locked />);
    expect(screen.getByRole('status')).toHaveTextContent('playback, downloads and uploads are unavailable');
  });
  it('renders nothing when not locked', (ctx) => {
    story(ctx, 'Zwykłe konto nie widzi banera.');
    const { container } = render(<AccountLockedBanner locked={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AccountLockedBanner action', () => {
  it('renders the supplied action next to the message', (ctx) => {
    story(ctx, 'Edycja może dodać do banera przycisk akcji.');
    render(<AccountLockedBanner locked action={<a href="/x">Go</a>} />);
    expect(screen.getByRole('link', { name: 'Go' })).toBeInTheDocument();
  });
});
