import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { getToken, setToken as saveToken, setRefreshToken as saveRefreshToken, clearToken, logout as apiLogout } from '../api';
import { clearAccountTimezone } from '../hooks/useAccountTimezone';
import type { User } from '../types';

interface AuthContextValue {
  token: string | null;
  user: User | null;
  login: (token: string, refreshToken: string, user: User, remember?: boolean) => void;
  logout: () => void;
  /** Ends every session of the account, this one included. False when the server did not confirm it (nothing changed locally then). */
  logoutEverywhere: () => Promise<boolean>;
  isAuthenticated: boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  token: null,
  user: null,
  login: () => {},
  logout: () => {},
  logoutEverywhere: async () => false,
  isAuthenticated: false,
  isAdmin: false,
});

function parseUserFromToken(token: string): User | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return { id: payload.userUuid, email: payload.email, isAdmin: payload.isAdmin, active: payload.active ?? true };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<User | null>(() => {
    const t = getToken();
    return t ? parseUserFromToken(t) : null;
  });

  const login = useCallback((newToken: string, newRefreshToken: string, newUser: User, remember = true) => {
    saveToken(newToken, remember);
    saveRefreshToken(newRefreshToken, remember);
    setTokenState(newToken);
    setUser(newUser);
  }, []);

  const clearSession = useCallback(() => {
    clearToken();
    // The account timezone is cached in localStorage to keep the timeline's
    // first frame stable across mounts. It belongs to the account, not the
    // device — drop it so the next user here doesn't open the timeline framed
    // on someone else's clock. Mirrors iOS `SettingsStore` sign-out.
    clearAccountTimezone();
    setTokenState(null);
    setUser(null);
  }, []);

  const logout = useCallback(() => {
    // Fire-and-forget: ends this device's session on the server; the other
    // devices stay signed in. apiLogout reads the tokens before clearSession
    // drops them, and a failed request must never strand the local sign-out.
    void apiLogout('device');
    clearSession();
  }, [clearSession]);

  const logoutEverywhere = useCallback(async () => {
    const ok = await apiLogout('all');
    if (ok) clearSession();
    return ok;
  }, [clearSession]);

  return (
    <AuthContext.Provider value={{
      token,
      user,
      login,
      logout,
      logoutEverywhere,
      isAuthenticated: !!token,
      isAdmin: user?.isAdmin ?? false,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
