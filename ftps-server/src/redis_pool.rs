use redis::{aio::ConnectionManager, Client};
use tracing::info;

/// Shared Redis connection wrapper.
///
/// Backed by `redis::aio::ConnectionManager`, which owns one multiplexed
/// connection and reconnects transparently. `ConnectionManager` is `Clone`
/// and commands issued through clones share the same underlying socket, so
/// consumers should clone freely instead of opening new connections.
///
/// Used by:
///   - `redis_lock` (distributed lock for `flush_transfer` — see step B)
///   - `streams`    (XADD publisher for scan/delete notify — see step C)
#[derive(Clone)]
pub struct RedisPool {
    conn: ConnectionManager,
}

impl RedisPool {
    /// Open a connection to the broker URL and return a ready-to-use pool.
    ///
    /// Returns `Err` if the URL is malformed or the initial handshake fails.
    /// Subsequent reconnects are handled by `ConnectionManager` and surface
    /// as per-command errors to the caller.
    pub async fn connect(url: &str) -> Result<Self, String> {
        let client = Client::open(url).map_err(|e| format!("Invalid REDIS_URL: {e}"))?;
        let conn = ConnectionManager::new(client)
            .await
            .map_err(|e| format!("Redis connect failed: {e}"))?;
        info!("Redis: connection manager ready");
        Ok(Self { conn })
    }

    /// Clone-on-each-use connection handle. Cheap — multiplexes over the
    /// underlying socket managed by `ConnectionManager`.
    pub fn conn(&self) -> ConnectionManager {
        self.conn.clone()
    }
}
