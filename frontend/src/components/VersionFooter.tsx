import { useEffect } from 'react';
import { FRONTEND_VERSION } from '../api';

// Logs the frontend version to the browser console on the login page.
// Version info is intentionally not shown in the UI — admins can see it
// in the header menu after logging in.
export function VersionFooter() {
  useEffect(() => {
    console.info(`[Clipnest] Frontend version: ${FRONTEND_VERSION}`);
  }, []);
  return null;
}
