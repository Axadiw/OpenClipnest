//! Prometheus metrics for the FTPS server — specifically, how long the object store
//! object storage takes to answer.
//!
//! WHY THIS EXISTS: every FTPS operation traverses S3. `storage::list` is a
//! ListObjectsV2, STOR streams straight into PutObject/UploadPart, MLSD is a
//! HeadObject. When an upload stalls, the FTPS server is almost never the
//! thing that is slow — but until now there was no way to say so with data.
//!
//! Without them a diagnosis has to be assembled from log lines (`Successful
//! LIST "/"; Duration 37s 362ms; Bytes copied 84 B`) cross-referenced against
//! the *API's* S3 metrics on entirely different nodes, because the FTPS server
//! published nothing at all. These metrics close that gap.
//!
//! WHAT IS DELIBERATELY NOT MEASURED: the wall time of `put_object_stream`.
//! That clock includes waiting for the camera to deliver bytes — a 4-minute
//! STOR from a residential uplink is normal and says nothing about S3. Only
//! the individual S3 calls inside it are timed, which is what makes the
//! resulting histogram mean "S3 latency" rather than "upload duration".
//!
//! LABEL HYGIENE (same hard rule as server/utils/metrics.ts): `op` is a closed
//! enum. No keys, no user ids, no buckets, no camera names — those are
//! unbounded, would explode cardinality, and would leak identifiers into the
//! ops store. `label_domain_is_closed` enforces it.

use std::sync::OnceLock;

use tracing::warn;

use prometheus::{
    HistogramOpts, HistogramVec, IntCounter, IntCounterVec, Opts, Registry, TextEncoder,
};

/// S3 operations worth timing separately. Closed set — this IS the label
/// domain for `op`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum S3Op {
    /// Single-shot PutObject (small files and the non-streaming path).
    Put,
    CreateMultipart,
    UploadPart,
    CompleteMultipart,
    AbortMultipart,
    Get,
    Head,
    Copy,
    Delete,
    /// Batched DeleteObjects.
    DeleteBatch,
    List,
    /// Bounded single-page ListObjectsV2 used only to answer "does anything
    /// exist under this prefix?" (`storage.rs::cwd` / `metadata`).
    ///
    /// Separate from `List` on purpose. These probes are the MAJORITY of
    /// list-family calls, and they are fast by construction (`max_keys(1)`,
    /// one page). Folding them into `list` would drag that histogram's mean
    /// down and hide a genuinely slow full listing — and the mean is what the
    /// ingest dashboard reads, because every quantile of this histogram pins
    /// to a bucket edge (healthy `head` is 0.0065 s against a 0.01 s lowest
    /// bucket).
    ListProbe,
}

impl S3Op {
    pub const ALL: [S3Op; 12] = [
        S3Op::Put,
        S3Op::CreateMultipart,
        S3Op::UploadPart,
        S3Op::CompleteMultipart,
        S3Op::AbortMultipart,
        S3Op::Get,
        S3Op::Head,
        S3Op::Copy,
        S3Op::Delete,
        S3Op::DeleteBatch,
        S3Op::List,
        S3Op::ListProbe,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            S3Op::Put => "put",
            S3Op::CreateMultipart => "create_multipart",
            S3Op::UploadPart => "upload_part",
            S3Op::CompleteMultipart => "complete_multipart",
            S3Op::AbortMultipart => "abort_multipart",
            S3Op::Get => "get",
            S3Op::Head => "head",
            S3Op::Copy => "copy",
            S3Op::Delete => "delete",
            S3Op::DeleteBatch => "delete_batch",
            S3Op::List => "list",
            S3Op::ListProbe => "list_probe",
        }
    }
}

/// Latency buckets, in seconds.
///
/// The top of the range is deliberately far past anything healthy: the whole
/// point is to resolve the 10-40 s stalls that were making probe cycles time
/// out. A histogram that tops out at 1 s would report those as "+Inf" and
/// answer nothing.
const LATENCY_BUCKETS: &[f64] = &[
    0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0,
];

pub struct Metrics {
    registry: Registry,
    s3_duration: HistogramVec,
    s3_errors: IntCounterVec,
    dir_probe_timeouts: IntCounter,
}

impl Metrics {
    pub fn new() -> Self {
        let registry = Registry::new();

        let s3_duration = HistogramVec::new(
            HistogramOpts::new(
                "clipnest_ftps_s3_request_duration_seconds",
                "Latency of a single S3 request made by the FTPS server. Excludes time spent waiting for client bytes.",
            )
            .buckets(LATENCY_BUCKETS.to_vec()),
            &["op"],
        )
        .expect("valid histogram");

        let s3_errors = IntCounterVec::new(
            Opts::new(
                "clipnest_ftps_s3_errors_total",
                "S3 requests that returned an error to the FTPS server, by operation.",
            ),
            &["op"],
        )
        .expect("valid counter");

        registry
            .register(Box::new(s3_duration.clone()))
            .expect("register histogram");
        let dir_probe_timeouts = IntCounter::new(
            "clipnest_ftps_dir_probe_timeouts_total",
            "Directory-existence probes that ran out of their wall-clock budget. Each one is a CWD/stat that S3 was too slow to answer, resolved by assumption instead of by fact.",
        )
        .expect("valid counter");

        registry
            .register(Box::new(s3_errors.clone()))
            .expect("register counter");
        registry
            .register(Box::new(dir_probe_timeouts.clone()))
            .expect("register counter");

        // Pre-create every label set so a panel for an operation that has not
        // happened yet reads "0", not "No data". "No data" is indistinguishable
        // from "the exporter is broken", which is the wrong thing for a metric
        // whose job is to be believed during an incident.
        for op in S3Op::ALL {
            s3_duration.with_label_values(&[op.as_str()]);
            s3_errors.with_label_values(&[op.as_str()]);
        }

        Self {
            registry,
            s3_duration,
            s3_errors,
            dir_probe_timeouts,
        }
    }

    pub fn observe_s3(&self, op: S3Op, seconds: f64) {
        self.s3_duration
            .with_label_values(&[op.as_str()])
            .observe(seconds);
    }

    pub fn record_s3_error(&self, op: S3Op) {
        self.s3_errors.with_label_values(&[op.as_str()]).inc();
    }

    pub fn record_dir_probe_timeout(&self) {
        self.dir_probe_timeouts.inc();
    }

    pub fn render(&self) -> String {
        TextEncoder::new()
            .encode_to_string(&self.registry.gather())
            .unwrap_or_default()
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

static GLOBAL: OnceLock<Metrics> = OnceLock::new();

/// The process-wide instance. Tests build their own `Metrics` instead, so they
/// never race each other through shared counters.
pub fn global() -> &'static Metrics {
    GLOBAL.get_or_init(Metrics::new)
}

/// Time one S3 call, recording its duration and — on `Err` — an error.
///
/// Wrapping the future rather than exposing start/stop handles is what keeps
/// the call sites in `s3.rs` a one-line change and makes it impossible to
/// record a duration while forgetting the error, or vice versa.
pub async fn timed<T, E, F>(op: S3Op, fut: F) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    timed_on(global(), op, fut).await
}

/// `timed`, against an explicit registry. Exists for tests.
pub async fn timed_on<T, E, F>(metrics: &Metrics, op: S3Op, fut: F) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    timed_where_on(metrics, op, |_| true, fut).await
}

/// `timed`, but a caller-supplied predicate decides which `Err`s are real
/// failures.
///
/// WHY: this counter answers "did S3 fail to serve us", and an alert reads it
/// as "recordings are being lost". Not every `Err` means that. HeadObject's
/// 404 is the motivating case — `storage.rs::metadata` probes a key and falls
/// back to a directory marker when it is absent, so a missing object is
/// ordinary control flow on every single directory stat. Counting it made
/// `clipnest_ftps_s3_errors_total{op="head"}` read ~50% (about half of all
/// head requests) and would eventually have tripped
/// `FtpsS3ErrorsSustained` with nothing wrong.
///
/// The DURATION is recorded either way. A slow 404 is still slow S3, and the
/// latency histogram is what the FTPS server was instrumented to provide.
pub async fn timed_where<T, E, F>(op: S3Op, is_failure: impl Fn(&E) -> bool, fut: F) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    timed_where_on(global(), op, is_failure, fut).await
}

/// `timed_where`, against an explicit registry. Exists for tests.
pub async fn timed_where_on<T, E, F>(
    metrics: &Metrics,
    op: S3Op,
    is_failure: impl Fn(&E) -> bool,
    fut: F,
) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    let started = std::time::Instant::now();
    let out = fut.await;
    metrics.observe_s3(op, started.elapsed().as_secs_f64());
    if let Err(e) = &out {
        if is_failure(e) {
            metrics.record_s3_error(op);
        }
    }
    out
}

/// Run one S3 call under a hard wall-clock budget, recording its latency
/// whether it finishes or not. `None` means the budget expired.
///
/// ⚠️ THE TRAP THIS EXISTS TO AVOID. The obvious spelling —
/// `tokio::time::timeout(budget, timed(op, fut))` — is NOT equivalent and is
/// actively harmful. When the budget expires, `timeout` DROPS the inner
/// future, so `timed`'s `observe_s3` never runs. The histogram then loses
/// exactly the samples that were slowest, and S3 looks HEALTHIER the worse it
/// actually gets. That is the same class of blindness that lets a recording
/// loss go uncounted: an instrument that goes quiet
/// precisely when it matters is worse than no instrument, because it reads as
/// evidence of health.
///
/// So the budget is observed as its own data point. A run that hits the
/// ceiling reports the ceiling — an understatement of the true latency, but a
/// visible one, and `clipnest_ftps_dir_probe_timeouts_total` says how often it
/// happened.
///
/// Takes the registry explicitly (tests build their own) and a failure
/// predicate, so HeadObject's 404-is-not-an-error rule applies here too — see
/// `timed_where`.
pub async fn timed_within_on<T, E, F>(
    metrics: &Metrics,
    op: S3Op,
    budget: std::time::Duration,
    is_failure: impl Fn(&E) -> bool,
    fut: F,
) -> Option<Result<T, E>>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    let started = std::time::Instant::now();
    match tokio::time::timeout(budget, fut).await {
        Ok(out) => {
            metrics.observe_s3(op, started.elapsed().as_secs_f64());
            if let Err(e) = &out {
                if is_failure(e) {
                    metrics.record_s3_error(op);
                }
            }
            Some(out)
        }
        Err(_) => {
            // Observe FIRST, then count. Both, always — see the trap above.
            metrics.observe_s3(op, started.elapsed().as_secs_f64());
            metrics.record_dir_probe_timeout();
            None
        }
    }
}

/// Serve the registry on `listener`, forever.
///
/// Hand-rolled HTTP/1.1 rather than a framework: this answers exactly one path
/// with a text body, and pulling a whole server stack into an internet-facing
/// FTPS binary for that is a poor trade in both dependencies and attack
/// surface. Anything that is not `GET /metrics` gets a 404 — the endpoint
/// binds `0.0.0.0` on a `hostNetwork` node (UFW is what keeps it off the
/// public internet), so it should do as little as possible.
pub async fn serve(listener: tokio::net::TcpListener) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "metrics: accept failed");
                continue;
            }
        };

        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            // The request line is all we need, and a fixed-size read is what
            // stops an unauthenticated peer from making us buffer forever.
            let mut buf = [0u8; 1024];
            let n = match socket.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            let head = String::from_utf8_lossy(&buf[..n]);
            let request_line = head.lines().next().unwrap_or_default();

            let response = if request_line.starts_with("GET /metrics ") {
                let body = global().render();
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; version=0.0.4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            } else {
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
            };

            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    ///story: Każda metryka serwera FTPS musi być w przestrzeni clipnest_ftps_, żeby nie zlewała się z clipnest_api_* ani clipnest_probe_* w tym samym Prometheusie — trzy różne procesy mierzą tu trzy różne rzeczy i mylenie ich prowadzi do diagnozy postawionej na cudzych danych.
    #[test]
    fn every_metric_is_namespaced() {
        let m = Metrics::new();
        let text = m.render();
        let names: Vec<&str> = text
            .lines()
            .filter(|l| l.starts_with("# HELP "))
            .map(|l| l.trim_start_matches("# HELP ").split(' ').next().unwrap())
            .collect();

        assert!(!names.is_empty(), "registry rendered no metrics");
        for n in names {
            assert!(
                n.starts_with("clipnest_ftps_"),
                "metric {n} is outside the clipnest_ftps_ namespace"
            );
        }
    }

    ///story: To jest zautomatyzowane egzekwowanie reguły LABEL HYGIENE: jedyna etykieta to `op`, a jej wartości pochodzą z zamkniętego enuma. Klucz S3, uuid użytkownika czy nazwa kamery jako etykieta wysadziłyby kardynalność i wyciekłyby identyfikatory do składnicy metryk.
    #[test]
    fn label_domain_is_closed() {
        let m = Metrics::new();
        m.observe_s3(S3Op::List, 0.1);
        let text = m.render();

        let allowed: Vec<&str> = S3Op::ALL.iter().map(|o| o.as_str()).collect();
        for line in text.lines().filter(|l| l.contains("op=\"")) {
            let value = line.split("op=\"").nth(1).unwrap().split('"').next().unwrap();
            assert!(
                allowed.contains(&value),
                "unexpected op label value {value:?}"
            );
            // `le` is the histogram's own bucket label; nothing else may appear.
            for label in line
                .split('{')
                .nth(1)
                .unwrap()
                .split('}')
                .next()
                .unwrap()
                .split(',')
            {
                let name = label.split('=').next().unwrap().trim();
                assert!(
                    name == "op" || name == "le",
                    "unexpected label {name:?} in {line}"
                );
            }
        }
    }

    ///story: Panel dla operacji, która jeszcze się nie wydarzyła, ma pokazywać 0, a nie "No data" — w trakcie awarii "No data" jest nie do odróżnienia od "eksporter padł", więc metryka traci wiarygodność dokładnie wtedy, kiedy jest potrzebna.
    #[test]
    fn pre_registers_every_operation() {
        let text = Metrics::new().render();
        for op in S3Op::ALL {
            let needle = format!("clipnest_ftps_s3_errors_total{{op=\"{}\"}} 0", op.as_str());
            assert!(text.contains(&needle), "missing zero series for {needle}");
        }
    }

    ///story: Timeout, który porzuca zmierzony future, gubi DOKŁADNIE najwolniejsze próbki — histogram wygląda wtedy tym zdrowiej, im gorzej jest naprawdę. Ta cisza w metrykach jest tą samą klasą ślepoty, przez którą utrata nagrań nie zostaje policzona. Przekroczony budżet musi zostawić ślad w histogramie I w liczniku.
    #[tokio::test]
    async fn expired_budget_still_records_latency_and_counts() {
        let m = Metrics::new();

        let out: Option<Result<(), ()>> = timed_within_on(
            &m,
            S3Op::ListProbe,
            std::time::Duration::from_millis(20),
            |_| true,
            async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                Ok(())
            },
        )
        .await;

        assert!(out.is_none(), "an expired budget must report as such");

        let text = m.render();
        assert!(
            text.contains("clipnest_ftps_s3_request_duration_seconds_count{op=\"list_probe\"} 1"),
            "the timed-out probe left NO latency observation — this is the trap:\n{text}"
        );
        assert!(
            text.contains("clipnest_ftps_dir_probe_timeouts_total 1"),
            "the timeout was not counted:\n{text}"
        );
    }

    ///story: Sonda, która zmieściła się w budżecie, ma raportować swój PRAWDZIWY czas, a nie sufit budżetu — inaczej każdy zdrowy odczyt wyglądałby jak awaria.
    #[tokio::test]
    async fn probe_within_budget_reports_its_real_duration() {
        let m = Metrics::new();

        let out: Option<Result<u8, ()>> = timed_within_on(
            &m,
            S3Op::ListProbe,
            std::time::Duration::from_secs(30),
            |_| true,
            async { Ok(7) },
        )
        .await;

        assert_eq!(out, Some(Ok(7)));
        let text = m.render();
        assert!(
            text.contains("clipnest_ftps_s3_request_duration_seconds_count{op=\"list_probe\"} 1")
        );
        assert!(
            text.contains("clipnest_ftps_dir_probe_timeouts_total 0"),
            "a probe that finished must not be counted as a timeout:\n{text}"
        );
    }

    ///story: Histogram musi trafiać obserwację do właściwej operacji i właściwego kubełka — bez tego wykres opóźnień S3 jest ozdobą, a nie dowodem.
    #[test]
    fn observation_lands_in_the_right_series() {
        let m = Metrics::new();
        m.observe_s3(S3Op::Head, 12.0);

        let text = m.render();
        assert!(text.contains("clipnest_ftps_s3_request_duration_seconds_count{op=\"head\"} 1"));
        assert!(text.contains("clipnest_ftps_s3_request_duration_seconds_sum{op=\"head\"} 12"));
        // 12 s belongs above the 10 s bucket and below 30 s.
        assert!(text
            .contains("clipnest_ftps_s3_request_duration_seconds_bucket{op=\"head\",le=\"10\"} 0"));
        assert!(text
            .contains("clipnest_ftps_s3_request_duration_seconds_bucket{op=\"head\",le=\"30\"} 1"));
        // A pure latency observation is not an error.
        assert!(text.contains("clipnest_ftps_s3_errors_total{op=\"head\"} 0"));
    }

    ///story: `timed` na sukcesie zapisuje czas i NIE podbija licznika błędów. Gdyby podbijał, wskaźnik błędów S3 byłby zawsze 100% i nie dałoby się na nim oprzeć żadnego alertu.
    #[tokio::test]
    async fn timed_records_duration_without_an_error_on_success() {
        let m = Metrics::new();
        let out: Result<u8, ()> = timed_on(&m, S3Op::Get, async { Ok(7) }).await;

        assert_eq!(out, Ok(7));
        let text = m.render();
        assert!(text.contains("clipnest_ftps_s3_request_duration_seconds_count{op=\"get\"} 1"));
        assert!(text.contains("clipnest_ftps_s3_errors_total{op=\"get\"} 0"));
    }

    ///story: Nieudane wywołanie S3 musi trafić do OBU serii — czas mówi "jak długo czekaliśmy zanim padło", licznik mówi "padło". Sam czas ukryłby awarię jako wolne żądanie; sam licznik zgubiłby to, że wywołanie wisiało 30 sekund, zanim zwróciło błąd.
    #[tokio::test]
    async fn timed_records_both_duration_and_error_on_failure() {
        let m = Metrics::new();
        let out: Result<(), &str> = timed_on(&m, S3Op::Put, async { Err("service error") }).await;

        assert_eq!(out, Err("service error"));
        let text = m.render();
        assert!(text.contains("clipnest_ftps_s3_request_duration_seconds_count{op=\"put\"} 1"));
        assert!(text.contains("clipnest_ftps_s3_errors_total{op=\"put\"} 1"));
    }

    ///story: Nie każdy `Err` to awaria S3. `timed_where` pozwala wywołującemu odsiać odpowiedzi, które są normalnym przepływem sterowania (HEAD 404 przy rozróżnianiu pliku od katalogu), zachowując przy tym pomiar czasu — wolne 404 to nadal wolne S3. Bez tego rozdziału licznik błędów mierzy ruch, a nie awarie, i alert oparty na nim kłamie.
    #[tokio::test]
    async fn timed_where_skips_errors_the_caller_calls_expected() {
        let m = Metrics::new();

        let expected: Result<(), &str> =
            timed_where_on(&m, S3Op::Head, |e: &&str| *e != "not found", async {
                Err("not found")
            })
            .await;
        assert_eq!(
            expected,
            Err("not found"),
            "the Err still reaches the caller"
        );

        let text = m.render();
        assert!(text.contains("clipnest_ftps_s3_request_duration_seconds_count{op=\"head\"} 1"));
        assert!(text.contains("clipnest_ftps_s3_errors_total{op=\"head\"} 0"));

        // A failure the predicate does NOT excuse is still counted.
        let broken: Result<(), &str> =
            timed_where_on(&m, S3Op::Head, |e: &&str| *e != "not found", async {
                Err("service error")
            })
            .await;
        assert_eq!(broken, Err("service error"));

        let text = m.render();
        assert!(text.contains("clipnest_ftps_s3_request_duration_seconds_count{op=\"head\"} 2"));
        assert!(text.contains("clipnest_ftps_s3_errors_total{op=\"head\"} 1"));
    }

    ///story: Prometheus musi móc zescrapować te metryki po HTTP — bez endpointu rejestr jest tylko pamięcią procesu, która ginie razem z podem przy każdym deployu.
    #[tokio::test]
    async fn serves_the_registry_over_http() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(serve(listener));

        let resp = reqwest::get(format!("http://{addr}/metrics")).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = resp.text().await.unwrap();
        assert!(body.contains("clipnest_ftps_s3_request_duration_seconds"));
        assert!(body.contains("clipnest_ftps_s3_errors_total"));
    }

    ///story: Endpoint metryk nasłuchuje na 0.0.0.0 na węźle hostNetwork, więc odpowiadanie czymkolwiek poza /metrics rozszerzałoby powierzchnię ataku serwera wystawionego do internetu bez żadnego zysku.
    #[tokio::test]
    async fn answers_404_on_every_other_path() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(serve(listener));

        for path in ["/", "/healthz", "/../etc/passwd", "/metrics/../secrets"] {
            let resp = reqwest::get(format!("http://{addr}{path}")).await.unwrap();
            assert_eq!(resp.status().as_u16(), 404, "path {path} was not rejected");
        }
    }

    ///story: Nazwy operacji są stabilnym kontraktem — trafiają do zapytań PromQL w dashboardach i regułach alertów, więc zmiana literki tutaj po cichu wygasza panel na produkcji.
    #[test]
    fn operation_names_are_stable_and_unique() {
        let names: Vec<&str> = S3Op::ALL.iter().map(|o| o.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "duplicate op name");
        assert!(names.contains(&"list"));
        assert!(names.contains(&"upload_part"));
        assert!(names.contains(&"complete_multipart"));
    }
}
