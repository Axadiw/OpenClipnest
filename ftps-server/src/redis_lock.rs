use redis::{AsyncCommands, Script};
use tracing::warn;
use uuid::Uuid;

use crate::redis_pool::RedisPool;

// Same atomic-release pattern as server/services/distributedLock.ts: only
// the holder whose UUID is still stored can DEL the key. Lua script avoids
// the classic "T1 expires after timeout, T2 acquires, T1 DEL's T2's lock"
// race.
const RELEASE_SCRIPT: &str = r#"
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
"#;

pub struct LockGuard {
    pool: RedisPool,
    key: String,
    token: String,
    released: bool,
}

impl LockGuard {
    /// Release the lock explicitly. Idempotent — further calls are no-ops.
    pub async fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut conn = self.pool.conn();
        let script = Script::new(RELEASE_SCRIPT);
        if let Err(e) = script
            .key(self.key.clone())
            .arg(self.token.clone())
            .invoke_async::<i64>(&mut conn)
            .await
        {
            warn!(key = %self.key, error = %e, "redis lock: release failed");
        }
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        if !self.released {
            // Sync drop can't await; best-effort warn. TTL will auto-release
            // the lock on Redis's side, so correctness is preserved.
            warn!(key = %self.key, "redis lock: guard dropped without explicit release — relying on TTL");
        }
    }
}

/// Attempt to acquire the named lock. Returns `Ok(None)` if someone else
/// holds it, `Ok(Some(guard))` on success, `Err(_)` on Redis error.
pub async fn try_acquire(
    pool: &RedisPool,
    name: &str,
    ttl_ms: usize,
) -> Result<Option<LockGuard>, String> {
    let key = format!("lock:{name}");
    let token = Uuid::new_v4().to_string();
    let mut conn = pool.conn();

    // SET key token PX <ttl> NX — atomic acquire. SetExpiry::PX wants u64.
    let ttl_ms_u64: u64 = ttl_ms.try_into().map_err(|_| "ttl_ms overflow".to_string())?;
    let set_opts = redis::SetOptions::default()
        .conditional_set(redis::ExistenceCheck::NX)
        .with_expiration(redis::SetExpiry::PX(ttl_ms_u64));

    let acquired: redis::Value = conn
        .set_options(&key, &token, set_opts)
        .await
        .map_err(|e| format!("redis SET failed: {e}"))?;

    // Successful SET returns Okay (bare) or SimpleString("OK"); NX-miss returns Nil.
    let ok = match &acquired {
        redis::Value::Okay => true,
        redis::Value::SimpleString(s) => s == "OK",
        _ => false,
    };

    if !ok {
        return Ok(None);
    }

    Ok(Some(LockGuard {
        pool: pool.clone(),
        key,
        token,
        released: false,
    }))
}
