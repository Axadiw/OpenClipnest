import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { router } from './routes';
import { edition } from './edition';
import { installChunkReloadHandler } from './utils/chunkReload';
import './fonts/fonts.css';
import './index.css';

// Auto-recover stale code-split chunks after a deploy: a tab opened before the
// release imports a hashed chunk that no longer exists (404) and Vite fires
// `vite:preloadError`. We reload once to pull the fresh index.html. The
// RouteErrorBoundary is the fallback if the reload can't recover.
installChunkReloadHandler();

// Edition boot: error monitoring / analytics in Clipnest Cloud, nothing on a
// self-hosted install.
edition.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>
);
