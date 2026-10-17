import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface LocationState {
  from?: { pathname?: string; search?: string };
}

export function RequireAnonymous() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (isAuthenticated) {
    const state = location.state as LocationState | null;
    const dest = (state?.from?.pathname ?? '/') + (state?.from?.search ?? '');
    return <Navigate to={dest} replace />;
  }
  return <Outlet />;
}
