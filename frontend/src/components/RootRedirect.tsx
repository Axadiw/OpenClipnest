import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { edition } from '../edition';

export function RootRedirect() {
  const { isAuthenticated, isAdmin } = useAuth();
  const location = useLocation();

  // Anon → the edition's home for visitors (cloud: marketing landing, which
  // is also what the prerender script sees), or straight to sign-in.
  if (!isAuthenticated) {
    const { AnonymousHome } = edition;
    return AnonymousHome ? <AnonymousHome /> : <Navigate to="/login" replace />;
  }

  // Honour `?view=timeline` legacy query param so old bookmarks/emails still
  // open the timeline. Same idea for `?event=` deep-links — preserved via
  // location.search, which the redirect carries forward.
  const search = location.search;
  const params = new URLSearchParams(search);
  const legacyView = params.get('view');

  if (isAdmin && edition.operatorHome) return <Navigate to={`${edition.operatorHome}${search}`} replace />;

  let target: string;
  if (legacyView === 'timeline') {
    params.delete('view');
    const cleaned = params.toString();
    target = `/timeline${cleaned ? '?' + cleaned : ''}`;
  } else if (legacyView === 'grid') {
    params.delete('view');
    const cleaned = params.toString();
    target = `/grid${cleaned ? '?' + cleaned : ''}`;
  } else {
    const stored = (() => { try { return localStorage.getItem('viewMode'); } catch { return null; } })();
    target = `/${stored === 'timeline' ? 'timeline' : 'grid'}${search}`;
  }
  return <Navigate to={target} replace />;
}
