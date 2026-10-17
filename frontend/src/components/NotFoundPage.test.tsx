import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { NotFoundPage } from './NotFoundPage';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('NotFoundPage', () => {
  it('renders 404 code and i18n keys', (ctx) => {
    story(ctx, 'Użytkownik, który trafi na nieistniejący URL, zamiast surowego błędu serwera widzi przyjazną stronę 404 z wyjaśnieniem, co się stało.');
    renderWithRouter(<NotFoundPage />);
    expect(screen.getByTestId('not-found-page')).toBeInTheDocument();
    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByText('notFound.title')).toBeInTheDocument();
    expect(screen.getByText('notFound.body')).toBeInTheDocument();
  });

  it('CTA links back to the home page', (ctx) => {
    story(ctx, 'Ze strony 404 użytkownik jednym kliknięciem wraca na stronę główną — nie musi klikać w logo ani ręcznie edytować adresu URL.');
    renderWithRouter(<NotFoundPage />);
    const home = screen.getByTestId('not-found-home');
    expect(home.getAttribute('href')).toBe('/');
  });
});
