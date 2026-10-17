import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Wraps `render` in a MemoryRouter so components that use react-router-dom
 * hooks (useNavigate, useSearchParams, Link, NavLink) work in unit tests
 * without the full <RouterProvider> setup.
 *
 * Pass `route` to seed the initial URL when the component reads searchParams
 * or pathname.
 */
export function renderWithRouter(ui: ReactElement, opts: { route?: string } = {}): RenderResult {
  return render(<MemoryRouter initialEntries={[opts.route ?? '/']}>{ui}</MemoryRouter>);
}
