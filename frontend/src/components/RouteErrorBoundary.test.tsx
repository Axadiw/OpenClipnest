import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { story } from '../test-story';

// Drive a real route into its error state by throwing from a loader; React
// Router then renders the route's errorElement with useRouteError() populated —
// the same path a failed React.lazy import takes.
function renderWithRouteError(error: unknown) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <div>app</div>,
        loader: () => {
          throw error;
        },
        errorElement: <RouteErrorBoundary />,
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RouteErrorBoundary', () => {
  it('auto-reloads once when a route fails on a stale code-split chunk', async (ctx) => {
    story(ctx, 'Stary tab po deployu importuje znikły chunk → boundary cicho przeładowuje stronę, by pobrać świeży index.html z nowymi hashami.');
    renderWithRouteError(
      new Error(
        'error loading dynamically imported module: https://clipnest.video/assets/SettingsLayout-00SdRP7B.js',
      ),
    );
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows an actionable recovery card for a generic crash instead of the dev error page', async (ctx) => {
    story(ctx, 'Zwykła awaria trasy pokazuje przyjazną kartę z przyciskiem odświeżenia zamiast surowego ekranu React Routera "Hey developer".');
    renderWithRouteError(new Error('Cannot read properties of undefined'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh|odśwież/i })).toBeInTheDocument();
    // A generic crash must NOT silently reload — the user decides.
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the page when the user clicks Refresh on the recovery card', async (ctx) => {
    story(ctx, 'Kliknięcie „Odśwież" na karcie ratunkowej przeładowuje stronę.');
    renderWithRouteError(new Error('boom'));
    fireEvent.click(await screen.findByRole('button', { name: /refresh|odśwież/i }));
    expect(reload).toHaveBeenCalled();
  });
});
