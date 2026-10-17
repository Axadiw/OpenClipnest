use redis::AsyncCommands;
use tracing::error;

use crate::redis_pool::RedisPool;

// Stream names — must stay in lockstep with server/services/streamsClient.ts.
pub const STREAM_DELETE_NOTIFY: &str = "stream:delete-notify";
pub const STREAM_FTPS_PREFIX_DELETED: &str = "stream:ftps-prefix-deleted";

// 2M absorbs a full wipe of a 10 TB user prefix (~400k events × 3 files
// = ~1.2M keys) without dropping messages. The storageReconciler's
// event↔S3 consistency sweep is the authoritative catch-all for any
// messages that still slip through (e.g. a multi-user simultaneous
// bulk delete), so this cap is the first, cheap layer of defence.
// Memory budget per entry ~= 100 bytes, so a fully saturated stream
// uses ~200 MB of Redis.
const MAXLEN: i64 = 2_000_000;

/// Fire-and-forget Redis Streams publisher for the FTPS server. At-least-once
/// delivery, non-blocking. The consumer side (Event Manager) uses a consumer
/// group + XACK + DLQ for crash-recovery guarantees.
#[derive(Clone)]
pub struct StreamsPublisher {
    pool: RedisPool,
}

impl StreamsPublisher {
    pub fn new(pool: RedisPool) -> Self {
        Self { pool }
    }

    /// `XADD stream:delete-notify MAXLEN ~ 10000 * userUuid <uuid> s3Key <key>`.
    /// Fire-and-forget. Loss here means the delete is applied on the next full
    /// rescan instead of immediately — acceptable.
    pub fn publish_delete_notify(&self, user_uuid: &str, s3_key: &str) {
        let mut conn = self.pool.conn();
        let user_uuid = user_uuid.to_string();
        let s3_key = s3_key.to_string();
        tokio::spawn(async move {
            let res: Result<String, _> = conn
                .xadd_maxlen(
                    STREAM_DELETE_NOTIFY,
                    redis::streams::StreamMaxlen::Approx(MAXLEN as usize),
                    "*",
                    &[
                        ("userUuid", user_uuid.as_str()),
                        ("s3Key", s3_key.as_str()),
                    ],
                )
                .await;
            if let Err(e) = res {
                error!(error = %e, "streams: failed to XADD delete-notify");
            }
        });
    }

    /// `XADD stream:ftps-prefix-deleted MAXLEN ~ N * userUuid <uuid> prefix <p>`.
    /// Fire-and-forget. Tells event-manager to sweep file_metadata under the
    /// prefix — covers the case where FTPS dir-delete cannot see all files
    /// so per-file delete-notify never fires for them.
    pub fn publish_prefix_deleted(&self, user_uuid: &str, prefix: &str) {
        let mut conn = self.pool.conn();
        let user_uuid = user_uuid.to_string();
        let prefix = prefix.to_string();
        tokio::spawn(async move {
            let res: Result<String, _> = conn
                .xadd_maxlen(
                    STREAM_FTPS_PREFIX_DELETED,
                    redis::streams::StreamMaxlen::Approx(MAXLEN as usize),
                    "*",
                    &[
                        ("userUuid", user_uuid.as_str()),
                        ("prefix", prefix.as_str()),
                    ],
                )
                .await;
            if let Err(e) = res {
                error!(error = %e, "streams: failed to XADD ftps-prefix-deleted");
            }
        });
    }
}
