// frontend/src/editions/selfhostTranslations.ts
//
// Copy the self-hosted edition words differently from the core catalogs. A
// self-hosted install has no plans to pick or upgrade — only an optional disk
// limit from its configuration — so nothing here may mention a "plan".
import type { Language } from '../i18n';

export const selfhostTranslations: Partial<Record<Language, Record<string, string>>> = {
  en: {
    'settings.autoDeleteOldest': 'Auto-delete oldest events when storage nears the disk limit',
    'settings.autoDeleteHint': 'When enabled, the oldest recordings are removed automatically once usage exceeds 95% of the disk limit.',
    'usage.warning80': 'Disk usage above 80% — free some space or raise the disk limit',
    'usage.warning80AutoDelete': 'Storage near the disk limit — oldest uploads will be evicted to make room.',
    'usage.warning100AutoDelete': 'Disk limit reached — evicting oldest uploads to fit new ones.',
    'oauth.consent.scopeAccountRead': 'Read account info (storage, cameras, stats)',
    'settings.mcpClients.empty': 'You haven\'t authorized any MCP clients yet. To add one, enter {url} as a custom connector (remote MCP server) in your client, e.g. Claude Desktop, then sign in and approve the access.',
  },
  pl: {
    'settings.autoDeleteOldest': 'Automatycznie usuwaj najstarsze zdarzenia, gdy pamięć zbliża się do limitu miejsca',
    'settings.autoDeleteHint': 'Gdy opcja jest włączona, najstarsze nagrania są usuwane automatycznie, gdy użycie przekracza 95% limitu miejsca.',
    'usage.warning80': 'Użycie dysku powyżej 80% — zwolnij miejsce lub zwiększ limit miejsca',
    'usage.warning80AutoDelete': 'Pamięć blisko limitu miejsca — najstarsze pliki będą usuwane automatycznie.',
    'usage.warning100AutoDelete': 'Limit miejsca osiągnięty — usuwam najstarsze pliki, by zmieścić nowe.',
    'oauth.consent.scopeAccountRead': 'Odczyt danych konta (magazyn, kamery, statystyki)',
    'settings.mcpClients.empty': 'Nie autoryzowałeś jeszcze żadnego klienta MCP. Aby go dodać, wpisz {url} jako własny konektor (zdalny serwer MCP) w swoim kliencie, np. Claude Desktop, a następnie zaloguj się i zatwierdź dostęp.',
  },
  de: {
    'settings.autoDeleteOldest': 'Älteste Ereignisse automatisch löschen, wenn der Speicher sich dem Speicherlimit nähert',
    'settings.autoDeleteHint': 'Wenn aktiviert, werden die ältesten Aufnahmen automatisch entfernt, sobald die Nutzung 95 % des Speicherlimits überschreitet.',
    'usage.warning80': 'Speichernutzung über 80% — geben Sie Speicher frei oder erhöhen Sie das Speicherlimit',
    'usage.warning80AutoDelete': 'Speicher nahe am Limit — älteste Uploads werden automatisch entfernt.',
    'usage.warning100AutoDelete': 'Speicherlimit erreicht — älteste Uploads werden entfernt, um Platz zu schaffen.',
    'oauth.consent.scopeAccountRead': 'Kontoinformationen lesen (Speicher, Kameras, Statistiken)',
    'settings.mcpClients.empty': 'Sie haben noch keinen MCP-Client autorisiert. Tragen Sie dazu {url} als eigenen Connector (Remote-MCP-Server) in Ihrem Client ein, z. B. Claude Desktop, melden Sie sich an und bestätigen Sie den Zugriff.',
  },
  fr: {
    'settings.autoDeleteOldest': 'Supprimer automatiquement les événements les plus anciens lorsque le stockage approche de la limite de stockage',
    'settings.autoDeleteHint': 'Lorsque cette option est activée, les enregistrements les plus anciens sont supprimés automatiquement dès que l\'utilisation dépasse 95 % de la limite de stockage.',
    'usage.warning80': 'Utilisation du disque au-dessus de 80% — libérez de l\'espace ou augmentez la limite de stockage',
    'usage.warning80AutoDelete': 'Stockage proche de la limite — les plus anciens fichiers seront supprimés automatiquement.',
    'usage.warning100AutoDelete': 'Limite atteinte — suppression des plus anciens fichiers pour faire de la place.',
    'oauth.consent.scopeAccountRead': 'Lire les informations du compte (stockage, caméras, statistiques)',
    'settings.mcpClients.empty': 'Vous n\'avez encore autorisé aucun client MCP. Pour en ajouter un, saisissez {url} comme connecteur personnalisé (serveur MCP distant) dans votre client, p. ex. Claude Desktop, puis connectez-vous et approuvez l\'accès.',
  },
  it: {
    'settings.autoDeleteOldest': 'Elimina automaticamente gli eventi più vecchi quando l\'archiviazione si avvicina al limite di spazio',
    'settings.autoDeleteHint': 'Quando è abilitato, le registrazioni più vecchie vengono rimosse automaticamente quando l\'utilizzo supera il 95% del limite di spazio.',
    'usage.warning80': 'Utilizzo disco superiore all\'80% — libera spazio o aumenta il limite di spazio',
    'usage.warning80AutoDelete': 'Spazio vicino al limite — i file più vecchi verranno rimossi automaticamente.',
    'usage.warning100AutoDelete': 'Limite di spazio raggiunto — rimozione dei file più vecchi per fare spazio ai nuovi.',
    'oauth.consent.scopeAccountRead': 'Lettura dei dati dell\'account (archiviazione, telecamere, statistiche)',
    'settings.mcpClients.empty': 'Non hai ancora autorizzato alcun client MCP. Per aggiungerne uno, inserisci {url} come connettore personalizzato (server MCP remoto) nel tuo client, ad es. Claude Desktop, quindi accedi e approva l\'accesso.',
  },
  es: {
    'settings.autoDeleteOldest': 'Eliminar automáticamente los eventos más antiguos cuando el almacenamiento se acerque al límite de espacio',
    'settings.autoDeleteHint': 'Cuando está habilitado, las grabaciones más antiguas se eliminan automáticamente una vez que el uso supera el 95 % del límite de espacio.',
    'usage.warning80': 'Uso de disco superior al 80% — libere espacio o aumente el límite de espacio',
    'usage.warning80AutoDelete': 'Almacenamiento cerca del límite — los archivos más antiguos se eliminarán automáticamente.',
    'usage.warning100AutoDelete': 'Límite de espacio alcanzado — eliminando los archivos más antiguos para hacer espacio.',
    'oauth.consent.scopeAccountRead': 'Leer la información de la cuenta (almacenamiento, cámaras, estadísticas)',
    'settings.mcpClients.empty': 'Aún no has autorizado ningún cliente MCP. Para añadir uno, introduce {url} como conector personalizado (servidor MCP remoto) en tu cliente, p. ej. Claude Desktop, y luego inicia sesión y aprueba el acceso.',
  },
  no: {
    'settings.autoDeleteOldest': 'Slett automatisk de eldste hendelsene når lagringen nærmer seg lagringsgrensen',
    'settings.autoDeleteHint': 'Når dette er aktivert, fjernes de eldste opptakene automatisk når bruken overstiger 95 % av lagringsgrensen.',
    'usage.warning80': 'Diskbruk over 80% — frigjør plass eller øk lagringsgrensen',
    'usage.warning80AutoDelete': 'Lagring nær grensen — de eldste filene fjernes automatisk for å gi plass.',
    'usage.warning100AutoDelete': 'Lagringsgrensen er nådd — fjerner eldste filer for å gi plass til nye.',
    'oauth.consent.scopeAccountRead': 'Lese kontoinformasjon (lagring, kameraer, statistikk)',
    'settings.mcpClients.empty': 'Du har ikke autorisert noen MCP-klienter ennå. For å legge til en, skriv inn {url} som egen kobling (ekstern MCP-server) i klienten din, f.eks. Claude Desktop, og logg deretter inn og godkjenn tilgangen.',
  },
};
