mod api;
mod auth;
mod config;
mod encryption;
mod metadata;
mod metrics;
mod redis_lock;
mod redis_pool;
mod s3;
mod storage;
mod streams;
mod user;

use std::sync::Arc;

use libunftp::options::{FtpsRequired, PassiveHost, TlsFlags};
use tracing::{error, info, warn};

use crate::api::InternalApi;
use crate::auth::{ClipnestAuth, ClipnestUserProvider};
use crate::config::Config;
use crate::redis_pool::RedisPool;
use crate::s3::S3;
use crate::storage::ClipnestStorage;
use crate::streams::StreamsPublisher;

#[tokio::main]
async fn main() {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env();

    info!("Clipnest FTPS Server starting...");
    info!("  Port: {}", config.ftp_port);
    info!("  Passive ports: {}-{}", config.pasv_min, config.pasv_max);
    info!("  Passive URL: {}", config.pasv_url);
    info!("  S3 endpoint: {}", config.s3_endpoint);
    info!("  S3 bucket: {}", config.s3_recordings_bucket);
    info!("  Internal API: {}", config.internal_api_url);
    info!("  Redis URL:   {}", redact_redis_url(&config.redis_url));
    info!("  SSE-C encryption: enabled");

    // Prometheus /metrics. Started BEFORE the FTP listener so a scrape landing
    // during startup gets zeros rather than a refused connection — "target
    // down" and "server still booting" look identical in Prometheus otherwise.
    //
    // Binds 0.0.0.0 because this pod is hostNetwork; UFW (2222/21/passive
    // range + the internal CIDRs) is what keeps the port off the public
    // internet. A bind failure is NOT fatal: losing observability must never
    // take camera uploads down with it.
    if config.metrics_port > 0 {
        let addr = format!("0.0.0.0:{}", config.metrics_port);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => {
                info!("  Metrics: http://{}/metrics", addr);
                tokio::spawn(metrics::serve(listener));
            }
            Err(e) => warn!(error = %e, addr = %addr, "metrics endpoint disabled — bind failed"),
        }
    } else {
        info!("  Metrics: disabled (CLIPNEST_FTPS_METRICS_PORT=0)");
    }

    // Shared services
    let s3 = S3::new(&config);
    let internal_api = InternalApi::new(&config.internal_api_url, &config.internal_api_key);

    // Redis — distributed lock for periodic transfer flush (N+ FTPS pods).
    // Precondition for the FTPS StatefulSet to be safely scaled past 1.
    let redis = RedisPool::connect(&config.redis_url)
        .await
        .unwrap_or_else(|e| {
            error!("Failed to connect to Redis: {}", e);
            std::process::exit(1);
        });

    // Auth with shared cache between Authenticator and UserDetailProvider
    let auth = ClipnestAuth::new(internal_api.clone());
    let user_provider = ClipnestUserProvider::new(auth.cache());

    // Redis Streams publisher — fire-and-forget XADD (scan-trigger, delete-notify).
    let streams = StreamsPublisher::new(redis.clone());

    // Storage factory — creates a new storage instance per connection.
    let s3_clone = s3.clone();
    let api_clone = internal_api.clone();
    let streams_clone = streams.clone();
    let storage_factory = Box::new(move || {
        ClipnestStorage::new(s3_clone.clone(), api_clone.clone(), streams_clone.clone())
    });

    // Parse passive host
    let pasv_host: PassiveHost = config
        .pasv_url
        .parse::<std::net::Ipv4Addr>()
        .map(PassiveHost::Ip)
        .unwrap_or_else(|_| PassiveHost::Dns(config.pasv_url.clone()));

    // Build FTP server
    // 1. Create with storage factory + UserDetailProvider (sets the User type)
    // 2. Set authenticator separately
    let mut builder = libunftp::ServerBuilder::with_user_detail_provider(
        storage_factory,
        Arc::new(user_provider),
    )
    .authenticator(Arc::new(auth))
    .greeting("Welcome to Clipnest FTPS Server")
    .passive_ports(config.pasv_min..=config.pasv_max)
    .passive_host(pasv_host);

    // Configure TLS
    let has_cert = std::path::Path::new(&config.tls_cert_path).exists();
    let has_key = std::path::Path::new(&config.tls_key_path).exists();

    if has_cert && has_key {
        info!("  TLS: enabled");
        info!("  Cert: {}", config.tls_cert_path);
        info!("  Key:  {}", config.tls_key_path);

        builder = builder
            .ftps(&config.tls_cert_path, &config.tls_key_path)
            // FtpsRequired::None on both control + data — client picks.
            // AUTH TLS still works (and is recommended for cameras over
            // the public internet), but legacy / cleartext-only clients
            // are no longer rejected with 534. Cert above stays mandatory
            // so the AUTH TLS handshake is available when a client asks
            // for it.
            .ftps_required(FtpsRequired::None, FtpsRequired::None)
            // TLS 1.2 only — TLS 1.3 on the FTPS PROT P data channel
            // triggers rustls "received corrupt message of type
            // InvalidContentType" on long/slow uploads (2026-05-05:
            // ~5 min STOR at ~700 B/s reset by peer mid-transfer, partial
            // bytes committed to S3, partial mp4 → frontend decode error).
            // Mirrors the curl-side `--tls-max 1.2` already used by e2e.
            // Patched libunftp fork has no per-channel TlsFlags split, so
            // we pin the whole server to 1.2 — control-channel impact is
            // nil (rustls 1.2 ships only AEAD ciphers, PCI/SOC2-acceptable,
            // lib's own default is 1.2-only anyway).
            .ftps_tls_flags(
                TlsFlags::V1_2
                    | TlsFlags::RESUMPTION_SESS_ID
                    | TlsFlags::RESUMPTION_TICKETS,
            );
    } else {
        error!("TLS cert/key not found — refusing to start without TLS");
        error!("  Expected cert: {}", config.tls_cert_path);
        error!("  Expected key:  {}", config.tls_key_path);
        error!("Mount the Let's Encrypt volume and ensure cert files are present.");
        std::process::exit(1);
    }

    let server = builder.build().unwrap_or_else(|e| {
        error!("Failed to build server: {}", e);
        std::process::exit(1);
    });

    let bind_addr = format!("0.0.0.0:{}", config.ftp_port);
    info!("Listening on {}", bind_addr);

    // Fix 0B — periodic transfer-usage flush. Default 10 s (matches Fix 0A
    // TTL). FLUSH_INTERVAL_SECS env override drops it for CI / e2e tests
    // where waitForUserUsage polls with a 5 s budget.
    let flush_secs: u64 = std::env::var("FLUSH_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);
    info!("  Transfer-usage flush interval: {}s", flush_secs);
    let flush_api = internal_api.clone();
    let flush_redis = redis.clone();
    // TTL is 2× the flush interval — leaves enough headroom for a slow POST
    // without letting a crashed pod hold the lock longer than one missed tick.
    let flush_lock_ttl_ms: usize = (flush_secs as usize).saturating_mul(2).saturating_mul(1000);
    let flush_handle = tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(flush_secs));
        tick.tick().await; // skip the immediate first fire — interval fires right away
        loop {
            tick.tick().await;
            // Serialize transfer flushes across FTPS pods. Per-pod pending
            // bytes live in a DashMap (api.rs::pending_transfer) that is
            // additive, so skipping this tick is safe — the bytes flush on
            // the next tick once the lock frees up.
            match redis_lock::try_acquire(&flush_redis, "transfer-flush", flush_lock_ttl_ms).await {
                Ok(Some(mut guard)) => {
                    flush_api.flush_transfer().await;
                    guard.release().await;
                }
                Ok(None) => {
                    // Another pod holds the lock — harmless; we try again next tick.
                }
                Err(e) => {
                    warn!(error = %e, "transfer-flush lock acquire failed — flushing without lock");
                    flush_api.flush_transfer().await;
                }
            }
        }
    });

    // SIGTERM future — on non-Unix targets, fall back to a never-ready future
    // so the select! arm is harmless. Docker Compose sends SIGTERM on `docker
    // stop`, so this branch is what fires on every redeploy.
    #[cfg(unix)]
    let sigterm_fut = async {
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        sigterm.recv().await;
    };
    #[cfg(not(unix))]
    let sigterm_fut = std::future::pending::<()>();

    // Best-effort drain: a RETR that completes after the iter().collect()
    // inside flush_transfer will be lost (next flush won't happen).
    let drain = || async {
        flush_handle.abort();
        internal_api.flush_transfer().await;
    };

    tokio::select! {
        res = server.listen(bind_addr) => {
            if let Err(e) = res {
                error!("Server error: {}", e);
                drain().await;
                std::process::exit(1);
            }
        }
        _ = tokio::signal::ctrl_c() => {
            info!("SIGINT received, draining transfer usage before exit");
            drain().await;
            info!("Drain complete");
        }
        _ = sigterm_fut => {
            info!("SIGTERM received, draining transfer usage before exit");
            drain().await;
            info!("Drain complete");
        }
    }
}

/// Redact the password portion of a `redis://user:pass@host` URL for logging.
fn redact_redis_url(url: &str) -> String {
    match url.find("//") {
        Some(scheme_end) => {
            let (prefix, rest) = url.split_at(scheme_end + 2);
            match rest.rfind('@') {
                Some(at) => {
                    let (_creds, host) = rest.split_at(at);
                    format!("{prefix}***{host}")
                }
                None => url.to_string(),
            }
        }
        None => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::redact_redis_url;

    ///story: Hasło do Redisa w URL-u jest maskowane w logach FTPS — sekret nie wycieka do journald nawet gdy admin uruchamia serwer z `redis://user:pass@host`.
    #[test]
    fn redact_with_creds() {
        assert_eq!(redact_redis_url("redis://:secret@host:6379"), "redis://***@host:6379");
        assert_eq!(
            redact_redis_url("redis://user:pass@host:6379/0"),
            "redis://***@host:6379/0"
        );
    }

    ///story: URL Redisa bez poświadczeń przechodzi przez redakcję bez zmian — nie psujemy normalnych logów startu serwera gdy nie ma czego ukrywać.
    #[test]
    fn redact_without_creds() {
        assert_eq!(redact_redis_url("redis://host:6379"), "redis://host:6379");
    }
}
