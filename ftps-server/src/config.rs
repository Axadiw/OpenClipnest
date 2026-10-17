use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    // FTP
    pub ftp_port: u16,
    pub pasv_url: String,
    pub pasv_min: u16,
    pub pasv_max: u16,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    /// Port for the Prometheus /metrics endpoint. `0` disables it entirely —
    /// local dev and the e2e stack have no scraper and no reason to open a
    /// listener. See src/metrics.rs for why this is a separate port and not a
    /// path on :21.
    pub metrics_port: u16,

    // S3
    pub s3_endpoint: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_recordings_bucket: String,

    // Encryption
    pub encryption_master_key: String,
    /// PEM CA bundle for self-signed S3 TLS cert (local dev only).
    /// Set CLIPNEST_S3_CA_BUNDLE; unset in production.
    pub s3_ca_bundle: Option<String>,

    // Internal API
    pub internal_api_url: String,
    pub internal_api_key: String,

    // Redis — distributed locks (transfer flush) + Streams publisher
    // (scan-trigger, delete-notify).
    pub redis_url: String,

}

impl Config {
    pub fn from_env() -> Self {
        Self {
            ftp_port: env::var("FTP_PORT")
                .unwrap_or_else(|_| "21".to_string())
                .parse()
                .expect("FTP_PORT must be a valid port number"),
            pasv_url: env::var("FTP_PASV_URL").unwrap_or_else(|_| "0.0.0.0".to_string()),
            pasv_min: env::var("FTP_PASV_MIN")
                .unwrap_or_else(|_| "30010".to_string())
                .parse()
                .expect("FTP_PASV_MIN must be a valid port number"),
            pasv_max: env::var("FTP_PASV_MAX")
                .unwrap_or_else(|_| "30019".to_string())
                .parse()
                .expect("FTP_PASV_MAX must be a valid port number"),
            tls_cert_path: env::var("TLS_CERT_PATH")
                .unwrap_or_else(|_| "/certs/fullchain.pem".to_string()),
            metrics_port: env::var("CLIPNEST_FTPS_METRICS_PORT")
                .unwrap_or_else(|_| "9106".to_string())
                .parse()
                .expect("CLIPNEST_FTPS_METRICS_PORT must be a valid port number"),
            tls_key_path: env::var("TLS_KEY_PATH")
                .unwrap_or_else(|_| "/certs/privkey.pem".to_string()),

            s3_endpoint: env::var("CLIPNEST_S3_ENDPOINT")
                .expect("CLIPNEST_S3_ENDPOINT is required"),
            s3_access_key: env::var("CLIPNEST_S3_ACCESS_KEY")
                .expect("CLIPNEST_S3_ACCESS_KEY is required"),
            s3_secret_key: env::var("CLIPNEST_S3_SECRET_KEY")
                .expect("CLIPNEST_S3_SECRET_KEY is required"),
            s3_recordings_bucket: env::var("CLIPNEST_S3_RECORDINGS_BUCKET")
                .unwrap_or_else(|_| "recordings".to_string()),

            encryption_master_key: env::var("CLIPNEST_ENCRYPTION_MASTER_KEY")
                .expect("CLIPNEST_ENCRYPTION_MASTER_KEY is required"),
            s3_ca_bundle: env::var("CLIPNEST_S3_CA_BUNDLE").ok(),

            internal_api_url: env::var("CLIPNEST_INTERNAL_API_URL")
                .unwrap_or_else(|_| "http://clipnest-api:3000".to_string()),
            internal_api_key: internal_api_key(
                env::var("CLIPNEST_INTERNAL_API_KEY").ok(),
                env::var("CLIPNEST_INTERNAL_API_KEY_FILE").ok(),
            )
            .expect("CLIPNEST_INTERNAL_API_KEY or CLIPNEST_INTERNAL_API_KEY_FILE is required"),
            redis_url: env::var("REDIS_URL")
                .unwrap_or_else(|_| "redis://redis:6379".to_string()),
        }
    }
}

/// The key presented to the API on /internal: CLIPNEST_INTERNAL_API_KEY when
/// set, otherwise the contents of the file CLIPNEST_INTERNAL_API_KEY_FILE
/// names (the self-hosted install generates one on first start). Same rule
/// as `internalApiKeyFromEnv` in server/config.ts.
fn internal_api_key(value: Option<String>, file: Option<String>) -> Option<String> {
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        return Some(v);
    }
    let path = file.filter(|p| !p.is_empty())?;
    let key = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read CLIPNEST_INTERNAL_API_KEY_FILE {path}: {e}"));
    Some(key.trim().to_string()).filter(|k| !k.is_empty())
}

#[cfg(test)]
mod tests {
    use super::internal_api_key;

    #[test]
    fn the_variable_wins_over_the_file() {
        let key = internal_api_key(Some("from-env".into()), Some("/nonexistent".into()));
        assert_eq!(key.as_deref(), Some("from-env"));
    }

    #[test]
    fn the_file_is_read_and_trimmed_when_the_variable_is_empty() {
        let dir = std::env::temp_dir().join(format!("ikey-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("internal-api-key");
        std::fs::write(&path, "abc123\n").unwrap();
        let key = internal_api_key(Some(String::new()), Some(path.display().to_string()));
        assert_eq!(key.as_deref(), Some("abc123"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn neither_means_none() {
        assert_eq!(internal_api_key(None, None), None);
        assert_eq!(internal_api_key(Some(String::new()), Some(String::new())), None);
    }
}
