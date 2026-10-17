import { useEffect, useState, type CSSProperties } from 'react';
import { useRouteError } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { getActiveLanguage, type Language } from '../i18n';
import { isChunkLoadError, shouldReloadOnce } from '../utils/chunkReload';

// react-router renders this as the root route's `errorElement`, which replaces
// the whole <RootLayout> subtree — so it sits OUTSIDE I18nProvider and cannot
// use useTranslation(). The copy is therefore self-contained: a recovery screen
// must keep working even when app context is the thing that failed. Languages we
// don't translate fall back to English.
interface Copy {
  stale: string;
  title: string;
  body: string;
  refresh: string;
}

const COPY: Record<'en', Copy> & Partial<Record<Language, Copy>> = {
  en: {
    stale: 'Updating to the latest version…',
    title: 'Something went wrong',
    body: 'The page failed to load. Refreshing usually fixes it.',
    refresh: 'Refresh',
  },
  pl: {
    stale: 'Aktualizuję do najnowszej wersji…',
    title: 'Coś poszło nie tak',
    body: 'Nie udało się załadować strony. Odświeżenie zwykle rozwiązuje problem.',
    refresh: 'Odśwież',
  },
  de: {
    stale: 'Aktualisierung auf die neueste Version…',
    title: 'Etwas ist schiefgelaufen',
    body: 'Die Seite konnte nicht geladen werden. Neu laden behebt das meist.',
    refresh: 'Neu laden',
  },
  fr: {
    stale: 'Mise à jour vers la dernière version…',
    title: 'Une erreur est survenue',
    body: "La page n'a pas pu se charger. Actualiser règle généralement le problème.",
    refresh: 'Actualiser',
  },
  it: {
    stale: "Aggiornamento all'ultima versione…",
    title: 'Qualcosa è andato storto',
    body: 'Impossibile caricare la pagina. Di solito basta aggiornare.',
    refresh: 'Aggiorna',
  },
  es: {
    stale: 'Actualizando a la última versión…',
    title: 'Algo salió mal',
    body: 'No se pudo cargar la página. Actualizar suele solucionarlo.',
    refresh: 'Actualizar',
  },
  no: {
    stale: 'Oppdaterer til nyeste versjon…',
    title: 'Noe gikk galt',
    body: 'Siden kunne ikke lastes. Å laste på nytt løser det som regel.',
    refresh: 'Last inn på nytt',
  },
};

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '60vh',
  gap: '1rem',
  textAlign: 'center',
  padding: '2rem',
};

export function RouteErrorBoundary() {
  const error = useRouteError();
  const isChunk = isChunkLoadError(error);
  const copy = COPY[getActiveLanguage()] ?? COPY.en;
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (isChunk) {
      // Stale code-split chunk after a deploy — reload once to pull the fresh
      // index.html (new chunk hashes). Guarded so a persistent failure can't loop.
      if (shouldReloadOnce({ storage: sessionStorage, now: Date.now() })) {
        setReloading(true);
        window.location.reload();
      }
      return;
    }
    // Route loader/render errors bypass the class ErrorBoundary in main.tsx,
    // so report them here rather than losing them.
    Sentry.captureException(error);
  }, [isChunk, error]);

  if (reloading) {
    return (
      <div role="status" style={containerStyle}>
        <div className="spinner" />
        <p>{copy.stale}</p>
      </div>
    );
  }

  return (
    <div role="alert" style={containerStyle}>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>{copy.title}</h1>
      <p style={{ margin: 0, opacity: 0.8 }}>{copy.body}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          padding: '0.6rem 1.4rem',
          borderRadius: '0.5rem',
          border: 'none',
          cursor: 'pointer',
          fontWeight: 600,
          background: 'var(--success, #2e7d32)',
          color: '#fff',
        }}
      >
        {copy.refresh}
      </button>
    </div>
  );
}
