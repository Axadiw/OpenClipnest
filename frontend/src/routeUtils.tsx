import { Suspense, type ReactElement } from 'react';

// Suspense fallback — reuses the global `.spinner` CSS, centered.
export function RouteFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '50vh' }}>
      <div className="spinner" />
    </div>
  );
}

/** Wrap a lazy element in a Suspense boundary with the shared fallback. */
export function lazyEl(node: ReactElement): ReactElement {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}
