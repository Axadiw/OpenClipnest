//! FTPS authenticator delegating to the Clipnest internal API.
//!
//! libunftp calls us on every connect with a username/password pair. We
//! forward the credentials over HTTP (internal API key auth) to the Node
//! server, which owns the bcrypt hashes, ban state, and quota row. The
//! response is cached per (username, password) for a short TTL so a single
//! FTP session doesn't flood the API on every command.
//!
//! A banned user's response carries `banned_until`; we reject the login with
//! FTP 530 so the client sees a clear "account suspended" reply.
use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use moka::future::Cache;
use tracing::{info, warn};
use unftp_core::auth::{
    AuthenticationError, Authenticator, Credentials, Principal, UserDetailError, UserDetailProvider,
};

use crate::api::InternalApi;
use crate::user::ClipnestUser;

/// Authenticator that verifies credentials against the internal API.
///
/// On successful authentication, caches the user context (uuid, encryption_salt)
/// with a 1-hour TTL (capped at 10 000 entries) so the UserDetailProvider can
/// retrieve it for the same session without extra API calls.
#[derive(Clone)]
pub struct ClipnestAuth {
    api: InternalApi,
    cache: Cache<String, ClipnestUser>,
}

impl fmt::Debug for ClipnestAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `cache` is a moka Cache<String, _> keyed by the user's email (PII).
        // moka's derived Debug prints every entry as a map, so libunftp's
        // session-level `self = ?` instrument would spill up to 10 000 cached
        // emails into a single WARN record (the per-value `ClipnestUser` Debug
        // redacts username + salt, but the map KEY is the raw email). Redact
        // the whole cache — ops correlates via `user_uuid`, never email.
        f.debug_struct("ClipnestAuth")
            .field("api", &self.api)
            .field("cache", &"<redacted>")
            .finish()
    }
}

impl ClipnestAuth {
    pub fn new(api: InternalApi) -> Self {
        let cache = Cache::builder()
            .time_to_live(Duration::from_secs(3600))
            .max_capacity(10_000)
            .build();
        Self { api, cache }
    }

    /// Get the shared cache (for use by ClipnestUserProvider).
    pub fn cache(&self) -> Cache<String, ClipnestUser> {
        self.cache.clone()
    }
}

#[async_trait]
impl Authenticator for ClipnestAuth {
    async fn authenticate(
        &self,
        username: &str,
        creds: &Credentials,
    ) -> Result<Principal, AuthenticationError> {
        let password = creds
            .password
            .as_deref()
            .ok_or(AuthenticationError::BadPassword)?;

        info!(username = username, "Login attempt");

        let auth_result = self
            .api
            .verify_auth(username, password, creds.source_ip)
            .await
            .map_err(|e| {
                warn!(
                    username = username,
                    error = %e,
                    "Internal API error during authentication"
                );
                AuthenticationError::new(format!("API error: {}", e))
            })?;

        if !auth_result.valid {
            let reason = auth_result
                .reason
                .unwrap_or_else(|| "invalid credentials".to_string());
            info!(username = username, reason = %reason, "Login failed");
            return Err(AuthenticationError::BadPassword);
        }

        let user_uuid = auth_result.user_uuid.ok_or_else(|| {
            warn!(username = username, "Login failed: missing user_uuid");
            AuthenticationError::new("Missing user data")
        })?;

        let encryption_salt = auth_result.encryption_salt.ok_or_else(|| {
            warn!(username = username, "Login failed: missing encryption_salt");
            AuthenticationError::new("Missing user data")
        })?;

        info!(username = username, uuid = %user_uuid, "Login successful");

        let user = ClipnestUser {
            username: username.to_string(),
            user_uuid,
            encryption_salt,
        };

        // Cache for the UserDetailProvider to retrieve (TTL: 1h, max: 10 000 entries)
        self.cache.insert(username.to_string(), user).await;

        Ok(Principal {
            username: username.to_string(),
        })
    }
}

/// Provides user details from the auth cache.
/// Works together with ClipnestAuth — after authenticate() caches the user data,
/// this provider retrieves it when libunftp needs the full user context.
pub struct ClipnestUserProvider {
    cache: Cache<String, ClipnestUser>,
}

impl fmt::Debug for ClipnestUserProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Same moka cache as `ClipnestAuth` — keyed by email (PII). Redact it
        // wholesale so libunftp's session Debug can't enumerate cached emails.
        f.debug_struct("ClipnestUserProvider")
            .field("cache", &"<redacted>")
            .finish()
    }
}

impl ClipnestUserProvider {
    pub fn new(cache: Cache<String, ClipnestUser>) -> Self {
        Self { cache }
    }
}

#[async_trait]
impl UserDetailProvider for ClipnestUserProvider {
    type User = ClipnestUser;

    async fn provide_user_detail(
        &self,
        principal: &Principal,
    ) -> Result<ClipnestUser, UserDetailError> {
        self.cache.get(&principal.username).await.ok_or_else(|| {
            UserDetailError::new(format!("User {} not found in cache", principal.username))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_user() -> ClipnestUser {
        ClipnestUser {
            username: "alice@example.com".to_string(),
            user_uuid: "f24450a4-ff34-4052-8eb5-52699a1e9905".to_string(),
            encryption_salt: "NhCZ0UA_ZkzbyUULKUDjAbhVoXlvrVSzdsYxtE44KVA".to_string(),
        }
    }

    ///story: Debug-format `ClipnestUserProvider` nie ujawnia żadnego e-maila z cache — moka `Cache<String, _>` jest kluczowana e-mailem (PII), a libunftp Debug-uje całą sesję na WARN. Redakcja pola w `ClipnestUser` nie wystarcza, bo Debug mapy drukuje KLUCZE. Regresja: wyciek PII przez klucz cache.
    #[tokio::test]
    async fn provider_debug_does_not_leak_cached_emails() {
        let cache: Cache<String, ClipnestUser> = Cache::builder().build();
        cache.insert("alice@example.com".to_string(), sample_user()).await;
        cache.run_pending_tasks().await;

        let provider = ClipnestUserProvider::new(cache);
        let dbg = format!("{:?}", provider);

        assert!(
            !dbg.contains("alice@example.com"),
            "ClipnestUserProvider Debug leaked a cached email (moka cache key is PII): {}",
            dbg,
        );
        assert!(
            !dbg.contains("NhCZ0UA_ZkzbyUULKUDjAbhVoXlvrVSzdsYxtE44KVA"),
            "ClipnestUserProvider Debug leaked encryption_salt: {}",
            dbg,
        );
    }

    ///story: Debug-format `ClipnestAuth` nie ujawnia e-maili z cache ani `api_key` — ten sam wektor (klucz moka = e-mail) co provider, plus regresja na maskowaniu klucza API w `InternalApi`.
    #[tokio::test]
    async fn auth_debug_does_not_leak_cached_emails_or_api_key() {
        let api = InternalApi::new("http://internal.test", "test-api-key");
        let auth = ClipnestAuth::new(api);
        auth.cache()
            .insert("bob@example.com".to_string(), sample_user())
            .await;
        auth.cache().run_pending_tasks().await;

        let dbg = format!("{:?}", auth);

        assert!(
            !dbg.contains("bob@example.com"),
            "ClipnestAuth Debug leaked a cached email (moka cache key is PII): {}",
            dbg,
        );
        assert!(
            !dbg.contains("test-api-key"),
            "ClipnestAuth Debug leaked api_key: {}",
            dbg,
        );
    }
}
