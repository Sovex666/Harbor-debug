use std::sync::OnceLock;

use regex::Regex;

const REDACTED: &str = "[REDACTED]";

struct ScrubRules {
    network_url: Regex,
    request_target: Regex,
    private_header: Regex,
    curl_cookie: Regex,
    bearer: Regex,
    authorization: Regex,
    storage_key: Regex,
    key_value: Regex,
    email: Regex,
    user_path: Regex,
    local_path: Regex,
    absolute_path: Regex,
    ip_addr: Regex,
    path_seg: Regex,
    base64_token: Regex,
    long_token: Regex,
}

fn rules() -> &'static ScrubRules {
    static RULES: OnceLock<ScrubRules> = OnceLock::new();
    RULES.get_or_init(|| ScrubRules {
        network_url: Regex::new(r#"(?i)\b(?:https?|ftp|rtsp|rtmp|smb)://[^\s\"'<>]+"#).unwrap(),
        request_target: Regex::new(
            r"(?i)\b(GET|POST|HEAD|PUT|PATCH|DELETE|OPTIONS)\s+\S+(\s+HTTP/\d(?:\.\d)?)",
        )
        .unwrap(),
        private_header: Regex::new(
            r"(?im)\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key|location|referer|path)\s*:\s*[^\r\n]*",
        )
        .unwrap(),
        curl_cookie: Regex::new(r"(?im)\b(?:Added|Replaced) cookie[^\r\n]*").unwrap(),
        bearer: Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/=\-]{8,}").unwrap(),
        authorization: Regex::new(
            r#"(?i)(authorization"?\s*[:=]\s*"?)(bearer\s+|basic\s+)?([^"'\s,;&}\)]+)"#,
        )
        .unwrap(),
        storage_key: Regex::new(
            r#"(?i)(harbor\.(?:theme-session|session\.token|auth(?:\.[A-Za-z0-9_.-]+)?))("?\s*[:=]\s*"?)([^"'\s,;&}\)]+)"#,
        )
        .unwrap(),
        key_value: Regex::new(
            r#"(?i)(auth[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd)("?\s*[:=]\s*"?)([^"'\s,;&}\)]+)"#,
        )
        .unwrap(),
        email: Regex::new(r"(?i)[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").unwrap(),
        user_path: Regex::new(r#"(?i)([A-Za-z]:[\\/]+Users[\\/]+|/Users/|/home/)([^\\/\s"']+)"#)
            .unwrap(),
        local_path: Regex::new(r#"(?i)(?:file://[^\r\n"'<>]+|\b[A-Za-z]:[\\/][^\r\n"'<>]+|/(?:Users|home|Volumes|mnt|media|tmp)/[^\r\n"'<>]+)"#).unwrap(),
        absolute_path: Regex::new(r#"(?m)(^|[\s"'=\(])(/[^\s/"'<>\r\n][^\r\n"'<>]*)"#).unwrap(),
        ip_addr: Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap(),
        path_seg: Regex::new(r"(/)([A-Za-z0-9_+=\-]{12,})").unwrap(),
        base64_token: Regex::new(r"[A-Za-z0-9+/]{32,}={0,2}").unwrap(),
        long_token: Regex::new(r"[A-Za-z0-9_\-]{20,}").unwrap(),
    })
}

pub fn scrub(text: &str) -> String {
    let r = rules();
    // A playback URL's path can be the credential itself, even without a named token parameter.
    let urls =
        r.network_url
            .replace_all(text, |c: &regex::Captures| match url::Url::parse(&c[0]) {
                Ok(url) if url.host_str().is_some() => {
                    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
                    format!(
                        "{}://{}{port}/{REDACTED}",
                        url.scheme(),
                        url.host_str().unwrap()
                    )
                }
                _ => REDACTED.to_string(),
            });
    let requests = r.request_target.replace_all(&urls, |c: &regex::Captures| {
        format!("{} {REDACTED}{}", &c[1], &c[2])
    });
    let headers = r
        .private_header
        .replace_all(&requests, |c: &regex::Captures| {
            let bearer = if c[0].to_ascii_lowercase().contains(": bearer ") {
                "Bearer "
            } else {
                ""
            };
            format!("{}: {bearer}{REDACTED}", &c[1])
        });
    let headers = r.curl_cookie.replace_all(&headers, "cookie [REDACTED]");
    let step1 = r
        .bearer
        .replace_all(&headers, |_: &regex::Captures| format!("Bearer {REDACTED}"));
    let step2 = r.authorization.replace_all(&step1, |c: &regex::Captures| {
        // The scheme group is optional; indexing it would panic when absent.
        format!(
            "{}{}{}",
            &c[1],
            c.get(2).map_or("", |m| m.as_str()),
            REDACTED
        )
    });
    let step3 = r.storage_key.replace_all(&step2, |c: &regex::Captures| {
        format!("{}{}{}", &c[1], &c[2], REDACTED)
    });
    let step4 = r.key_value.replace_all(&step3, |c: &regex::Captures| {
        format!("{}{}{}", &c[1], &c[2], REDACTED)
    });
    let step5 = r.email.replace_all(&step4, "<email>");
    let local_paths = r.local_path.replace_all(&step5, "<local-path>");
    let local_paths = r
        .absolute_path
        .replace_all(&local_paths, "${1}<local-path>");
    let step6 = r
        .user_path
        .replace_all(&local_paths, |c: &regex::Captures| {
            format!("{}<user>", &c[1])
        });
    let step7 = r.ip_addr.replace_all(&step6, "<ip>");
    let step8 = r.path_seg.replace_all(&step7, |c: &regex::Captures| {
        format!("{}{}", &c[1], REDACTED)
    });
    let step9 = r.base64_token.replace_all(&step8, REDACTED);
    r.long_token
        .replace_all(&step9, |c: &regex::Captures| {
            let value = c.get(0).unwrap();
            // Large byte ranges can resemble tokens; retain only this HTTP field.
            let is_range = step9[..value.start()]
                .to_ascii_lowercase()
                .ends_with("content-range: bytes ")
                && value.as_str().split_once('-').is_some_and(|(start, end)| {
                    start.parse::<u64>().is_ok() && end.parse::<u64>().is_ok()
                });
            if is_range { value.as_str() } else { REDACTED }.to_owned()
        })
        .into_owned()
}

const LOG_QUEUE_CAPACITY: usize = 512;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;

fn compact_log(file: &mut std::fs::File, limit: u64) -> std::io::Result<()> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let length = file.metadata()?.len();
    if length <= limit {
        return Ok(());
    }
    file.seek(SeekFrom::Start(length.saturating_sub(limit / 2)))?;
    let mut tail = Vec::with_capacity((limit / 2) as usize);
    file.read_to_end(&mut tail)?;
    // The first line can be partial; retain complete UTF-8 messages only.
    let start = tail
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(tail.len(), |at| at + 1);
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    writeln!(
        file,
        "[{}] [harbor] log-rotated discarded_bytes={}",
        timestamp_ms(),
        length.saturating_sub((tail.len() - start) as u64)
    )?;
    file.write_all(&tail[start..])?;
    Ok(())
}

#[derive(Clone)]
pub struct LogWriter {
    send: std::sync::mpsc::SyncSender<LogRequest>,
    dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

enum LogRequest {
    Message {
        timestamp_ms: u128,
        text: String,
    },
    Export {
        destination: std::path::PathBuf,
        runtime_text: Option<String>,
        reply: std::sync::mpsc::SyncSender<Result<(), String>>,
    },
}

static PLAYER_LOG: OnceLock<LogWriter> = OnceLock::new();

pub fn initialize_log(path: &std::path::Path) -> std::io::Result<LogWriter> {
    // Session recreation must reuse the same writer, including while an old
    // event loop drains its final messages.
    static INIT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = INIT.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(writer) = PLAYER_LOG.get() {
        return Ok(writer.clone());
    }
    let writer = start_log(path)?;
    let _ = PLAYER_LOG.set(writer.clone());
    Ok(writer)
}

/// The shared player log, once a player session has initialized it.
pub fn player_log() -> Option<LogWriter> {
    PLAYER_LOG.get().cloned()
}

pub fn record(message: String) {
    // Structured sessions receive only a fixed event class; legacy text remains
    // on its existing compatibility path and is never copied wholesale.
    #[cfg(feature = "context-review")]
    {
        let event = if message.contains("stop-request") {
            Some("native:command")
        } else if message.contains("buffer") {
            Some("native:buffering")
        } else if message.contains("audio") || message.contains("WASAPI") {
            Some("native:audio")
        } else if message.contains("HTTP/") || message.contains("receive") {
            Some("native:network")
        } else if message.contains("reload") {
            Some("native:lifecycle")
        } else {
            None
        };
        if let Some(name) = event {
            crate::diagnostics_sessions::native(name, serde_json::json!({"event": true}));
        }
    }
    if let Some(writer) = PLAYER_LOG.get() {
        writer.record(message);
    }
}

pub fn timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn bounded_runtime(mut text: String) -> String {
    const MAX_RUNTIME_BYTES: usize = 1024 * 1024;
    if text.len() > MAX_RUNTIME_BYTES {
        let mut boundary = MAX_RUNTIME_BYTES;
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
        text.push_str("\n[runtime diagnostics truncated]");
    }
    text
}

impl LogWriter {
    /// Same shape as `SyncSender::try_send`, for callers that only queue a line.
    pub fn try_send(&self, text: String) {
        self.record(text);
    }

    pub fn record(&self, mut text: String) {
        use std::sync::atomic::Ordering;
        if text.len() > MAX_MESSAGE_BYTES {
            let mut boundary = MAX_MESSAGE_BYTES;
            while !text.is_char_boundary(boundary) {
                boundary -= 1;
            }
            text.truncate(boundary);
            text.push_str(" [message truncated]");
        }
        // No filesystem work, regex redaction, or waiting on a full queue in
        // mpv's event thread. Count every lost message for the next export.
        if self
            .send
            .try_send(LogRequest::Message {
                timestamp_ms: timestamp_ms(),
                text,
            })
            .is_err()
        {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn export(
        &self,
        destination: std::path::PathBuf,
        runtime_text: Option<String>,
    ) -> Result<(), String> {
        let (reply, receive) = std::sync::mpsc::sync_channel(1);
        self.send
            .send(LogRequest::Export {
                destination,
                runtime_text: runtime_text.map(bounded_runtime),
                reply,
            })
            .map_err(|_| "Player log writer unavailable".to_string())?;
        receive
            .recv()
            .map_err(|_| "Player log writer unavailable".to_string())?
    }
}

pub fn start_log(path: &std::path::Path) -> std::io::Result<LogWriter> {
    use std::io::{Seek, SeekFrom, Write};
    use std::sync::atomic::Ordering;

    // Append across application/player sessions; legacy content is scrubbed
    // during export too. Never rewrite the accumulated source on startup.
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    compact_log(&mut file, MAX_LOG_BYTES)?;
    file.seek(SeekFrom::End(0))?;
    let path = path.to_owned();
    let (send, receive) = std::sync::mpsc::sync_channel::<LogRequest>(LOG_QUEUE_CAPACITY);
    let dropped = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let worker_dropped = dropped.clone();
    std::thread::Builder::new()
        .name("mpv-log".into())
        .spawn(move || {
            let mut write_error = None;
            let mut messages = 0_u64;
            for request in receive {
                let lost = worker_dropped.swap(0, Ordering::Relaxed);
                if lost > 0 {
                    if let Err(error) = writeln!(
                        file,
                        "[{}] [harbor] log-dropped count={lost}",
                        timestamp_ms()
                    ) {
                        write_error = Some(error.to_string());
                    }
                }
                match request {
                    LogRequest::Message { timestamp_ms, text } => {
                        if let Err(error) = writeln!(file, "[{timestamp_ms}] {}", scrub(&text)) {
                            write_error = Some(error.to_string());
                        }
                        messages = messages.wrapping_add(1);
                        if messages % 64 == 0 {
                            if let Err(error) = compact_log(&mut file, MAX_LOG_BYTES) {
                                write_error = Some(error.to_string());
                                let _ = file.seek(SeekFrom::End(0));
                            }
                        }
                    }
                    LogRequest::Export {
                        destination,
                        runtime_text,
                        reply,
                    } => {
                        let result = (|| -> Result<(), String> {
                            file.flush().map_err(|e| format!("flush: {e}"))?;
                            // create_new prevents accidental overwrites. Only a fully
                            // written, synced snapshot acknowledges these messages.
                            let mut snapshot = std::fs::OpenOptions::new()
                                .write(true)
                                .create_new(true)
                                .open(&destination)
                                .map_err(|e| format!("export: {e}"))?;
                            let write_snapshot = (|| -> std::io::Result<()> {
                                use std::io::BufRead;
                                if let Some(error) = &write_error {
                                    writeln!(
                                        snapshot,
                                        "[harbor] log-write-error messages-may-be-missing: {}",
                                        scrub(error)
                                    )?;
                                }
                                // Accumulated multi-video logs can be large; stream
                                // them instead of copying the whole file into RAM.
                                let source = std::fs::File::open(&path)?;
                                for line in std::io::BufReader::new(source).split(b'\n') {
                                    writeln!(
                                        snapshot,
                                        "{}",
                                        scrub(&String::from_utf8_lossy(&line?))
                                    )?;
                                }
                                if let Some(runtime) = runtime_text {
                                    writeln!(snapshot, "\n--- Harbor runtime diagnostics ---")?;
                                    writeln!(snapshot, "{}", scrub(&bounded_runtime(runtime)))?;
                                }
                                snapshot.sync_all()
                            })();
                            if let Err(error) = write_snapshot {
                                drop(snapshot);
                                let _ = std::fs::remove_file(&destination);
                                return Err(format!("export write: {error}"));
                            }
                            // Requests received concurrently are still queued and
                            // are appended after this acknowledged snapshot clears.
                            file.set_len(0)
                                .map_err(|e| format!("acknowledge export: {e}"))?;
                            file.seek(SeekFrom::Start(0))
                                .map_err(|e| format!("reset log cursor: {e}"))?;
                            write_error = None;
                            Ok(())
                        })();
                        let _ = reply.send(result);
                    }
                }
            }
        })?;
    Ok(LogWriter { send, dropped })
}

#[cfg(test)]
mod tests {
    use super::scrub;

    #[test]
    fn hides_torbox_and_other_provider_urls_without_changing_the_input() {
        for input in [
            "Opening https://cdn.torbox.app/download/short-key/file.mkv?token=other-key",
            "https://api.torbox.app/v1/api/torrents/requestdl?token=short&file_id=1",
            "https://user:pass@host.example:8443/d/short/file.mkv#secret",
            "https://real-debrid.example/d/short/file.mkv",
            "https://host.example/%73ecret/file.mkv?api_key=short",
        ] {
            let original = input.to_owned();
            let out = scrub(input);
            assert!(out.contains("[REDACTED]"));
            for secret in ["short", "other-key", "user:pass", "%73ecret", "file.mkv"] {
                assert!(!out.contains(secret), "{out}");
            }
            assert_eq!(input, original);
        }
    }

    #[test]
    fn hides_relative_http_targets_and_private_headers() {
        let out = scrub("GET /download/short?token=key HTTP/1.1\r\nAuthorization: Bearer tiny\r\nCookie: session=small; other=secret\r\nX-Api-Key: key\r\nHTTP/1.1 403 Forbidden");
        assert!(out.contains("GET [REDACTED] HTTP/1.1"));
        assert!(out.contains("HTTP/1.1 403 Forbidden"));
        for secret in ["short", "tiny", "small", "secret", ": key"] {
            assert!(!out.contains(secret), "{out}");
        }
    }

    #[test]
    fn scrubs_curl_trace_secrets_but_preserves_network_timing_and_ranges() {
        let input = "[wall_ms=1794176866229] [curl] trace: > GET /short/key HTTP/1.1\n\
                     [curl] trace: [HTTP/2] [1] [:path: /short/key]\n\
                     [curl] trace: < Location: /short/redirect\n\
                     [curl] trace: > Authorization: Bearer tiny\n\
                     [curl] trace: * Added cookie sid=\"small\" for domain example.test\n\
                     [curl] trace: < HTTP/2 206\n\
                     [curl] trace: > Range: bytes=5199796854-\n\
                     [curl] trace: < Content-Range: bytes 5199796854-21513062332/21513062333";
        let out = scrub(input);
        for secret in ["/short", "tiny", "small"] {
            assert!(!out.contains(secret), "{out}");
        }
        for diagnostic in [
            "wall_ms=1794176866229",
            "HTTP/2 206",
            "Range: bytes=5199796854-",
            "Content-Range: bytes 5199796854-21513062332/21513062333",
        ] {
            assert!(out.contains(diagnostic), "{out}");
        }
        assert_eq!(scrub(&out), out);
    }

    #[test]
    fn redacts_authorization_headers_without_a_scheme() {
        for (input, secret) in [
            ("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"),
            (
                "Authorization: Digest username=\"u\", response=\"digest-secret\"",
                "digest-secret",
            ),
            ("Authorization:Bearer tight-secret", "tight-secret"),
            ("authorization=bare-secret", "bare-secret"),
            (r#"{"authorization":"json-secret"}"#, "json-secret"),
            ("Proxy-Authorization: Basic proxy-secret", "proxy-secret"),
        ] {
            let out = scrub(input);
            assert!(out.contains("[REDACTED]"), "{input} -> {out}");
            assert!(!out.contains(secret), "{input} -> {out}");
        }
    }

    #[test]
    fn preserves_playback_diagnostics_and_scrubs_legacy_log_exports() {
        assert_eq!(
            scrub("[vo/gpu] Vulkan initialized; dropped frames: 3"),
            "[vo/gpu] Vulkan initialized; dropped frames: 3"
        );
        let out = scrub("[ffmpeg] https://cdn.torbox.app/tiny/file: HTTP error 403");
        assert!(out.contains("cdn.torbox.app"));
        assert!(out.contains("HTTP error 403"));
        assert!(!out.contains("tiny"));
        assert_eq!(scrub(&out), out);
    }

    fn test_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "harbor-log-{}-{}.log",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn multiple_videos_survive_until_successful_export() {
        let path = test_path();
        std::fs::write(&path, "previous-video token=private-key\n").unwrap();
        let writer = super::start_log(&path).unwrap();
        writer.record("session-start video=2".into());
        writer.record("https://cdn.example/private-key/movie.mkv HTTP error 403".into());
        let destination = test_path();
        writer.export(destination.clone(), None).unwrap();
        let exported = std::fs::read_to_string(&destination).unwrap();
        assert!(exported.contains("previous-video"));
        assert!(exported.contains("session-start video=2"));
        assert!(exported.contains("HTTP error 403"));
        assert!(!exported.contains("private-key"));
        assert!(std::fs::read_to_string(&path).unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn failed_exports_preserve_messages_and_success_only_acknowledges_its_snapshot() {
        let path = test_path();
        let writer = super::start_log(&path).unwrap();
        writer.record("before-fail".into());
        assert!(writer
            .export(path.join("missing/output.txt"), None)
            .is_err());
        let destination = test_path();
        writer.export(destination.clone(), None).unwrap();
        assert!(std::fs::read_to_string(&destination)
            .unwrap()
            .contains("before-fail"));
        writer.record("after-export".into());
        let next = test_path();
        writer.export(next.clone(), None).unwrap();
        let exported = std::fs::read_to_string(&next).unwrap();
        assert!(exported.contains("after-export"));
        assert!(!exported.contains("before-fail"));
        for file in [path, destination, next] {
            std::fs::remove_file(file).unwrap();
        }
    }

    #[test]
    fn queued_events_after_export_survive_and_runtime_is_bounded_and_scrubbed() {
        let path = test_path();
        let writer = super::start_log(&path).unwrap();
        writer.record("before-snapshot".into());
        let first = test_path();
        let (reply, receive) = std::sync::mpsc::sync_channel(1);
        writer
            .send
            .send(super::LogRequest::Export {
                destination: first.clone(),
                runtime_text: Some(format!("token=private-key\n{}", "é ".repeat(600_000))),
                reply,
            })
            .unwrap();
        // Enqueue without waiting for export completion: these messages belong
        // to the next snapshot regardless of the worker's scheduling.
        writer.record("concurrent-event".into());
        receive.recv().unwrap().unwrap();
        let first_text = std::fs::read_to_string(&first).unwrap();
        assert!(first_text.contains("before-snapshot"));
        assert!(!first_text.contains("concurrent-event"));
        assert!(!first_text.contains("private-key"));
        assert!(first_text.contains("runtime diagnostics truncated"));
        assert!(first_text.len() < 1024 * 1024 + 1024);
        let next = test_path();
        writer.export(next.clone(), None).unwrap();
        assert!(std::fs::read_to_string(&next)
            .unwrap()
            .contains("concurrent-event"));
        for file in [path, first, next] {
            std::fs::remove_file(file).unwrap();
        }
    }

    #[test]
    fn failed_export_never_overwrites_existing_downloads() {
        let path = test_path();
        let writer = super::start_log(&path).unwrap();
        let destination = test_path();
        std::fs::write(&destination, "existing-download").unwrap();
        writer.record("unexported-video".into());
        writer
            .dropped
            .store(7, std::sync::atomic::Ordering::Relaxed);
        assert!(writer.export(destination.clone(), None).is_err());
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            "existing-download"
        );
        let next = test_path();
        writer.export(next.clone(), None).unwrap();
        let output = std::fs::read_to_string(&next).unwrap();
        assert!(output.contains("unexported-video"));
        assert!(output.contains("log-dropped count=7"));
        for file in [path, destination, next] {
            std::fs::remove_file(file).unwrap();
        }
    }

    #[test]
    fn local_media_paths_are_private() {
        for line in [
            r"Playing C:\Users\Alice\Videos\Anime Episode.mkv",
            "Playing /Users/alice/Videos/Anime Episode.mkv",
            "file:///home/alice/secret.mkv",
            "Playing /srv/media/Private Episode.mkv",
            "path='/data/videos/Private Episode.mkv'",
            "/custom/library/Private Episode.mkv",
        ] {
            let output = scrub(line);
            for private in ["Alice", "alice", "Episode", "secret.mkv"] {
                assert!(!output.contains(private), "{output}");
            }
        }
    }

    #[test]
    fn oversized_logs_keep_recent_complete_messages_and_remain_writable() {
        use std::io::Write;
        let path = test_path();
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        for index in 0..100 {
            writeln!(file, "message-{index:03} {}", "x".repeat(30)).unwrap();
        }
        super::compact_log(&mut file, 1024).unwrap();
        writeln!(file, "after-rotation").unwrap();
        file.flush().unwrap();
        let output = std::fs::read_to_string(&path).unwrap();
        assert!(output.len() < 1024);
        assert!(output.starts_with('['));
        assert!(output.contains("log-rotated discarded_bytes="));
        assert!(output.contains("message-099"));
        assert!(output.ends_with("after-rotation\n"));
        assert!(!output.contains("message-000"));
        drop(file);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn queue_saturation_is_nonblocking_and_reported() {
        let (send, receive) = std::sync::mpsc::sync_channel(super::LOG_QUEUE_CAPACITY);
        let writer = super::LogWriter {
            send,
            dropped: Default::default(),
        };
        for _ in 0..super::LOG_QUEUE_CAPACITY + 7 {
            writer.record("message".into());
        }
        assert_eq!(writer.dropped.load(std::sync::atomic::Ordering::Relaxed), 7);
        assert_eq!(receive.try_iter().count(), super::LOG_QUEUE_CAPACITY);
    }
}
