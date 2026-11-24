use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        mpsc::{sync_channel, SyncSender},
        OnceLock,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const SEGMENT: u64 = 4 * 1024 * 1024;
const SEGMENTS: u32 = 4;
static SERVICE: OnceLock<SyncSender<Request>> = OnceLock::new();
static CLOCK: OnceLock<Instant> = OnceLock::new();
static NATIVE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static NATIVE_DROPS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn wall() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn mono() -> f64 {
    CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
fn id_ok(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok() && value.len() == 36
}
fn trusted(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("main window required".into())
    }
}
fn safe_path(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, std::path::Component::ParentDir) {
            return Err("invalid diagnostics path".into());
        }
        current.push(part);
        if let Ok(meta) = fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err("diagnostics links are not supported".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("diagnostics reparse points are not supported".into());
                }
            }
        }
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    session_id: String,
    started_at: u64,
    ended_at: Option<u64>,
    mode: String,
    domains: u32,
    events: u64,
    bytes: u64,
    dropped: u64,
    rotated: u64,
    interrupted: bool,
    producers: HashMap<String, u64>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    seq: u64,
    mono_ms: f64,
    wall_ms: u64,
    name: String,
    fields: HashMap<String, Value>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    session_id: String,
    producer: String,
    dropped_before: u64,
    events: Vec<Event>,
}
enum Op {
    Start(String, u32, bool),
    Stop(String),
    Status,
    List,
    Append(Batch),
    Export(String),
    Prune,
    PrefsRead,
    PrefsWrite(Value),
    Native(String, Value, u64),
    Folder(Option<String>),
}
struct Request {
    op: Op,
    reply: Option<tokio::sync::oneshot::Sender<Result<Value, String>>>,
}
struct Engine {
    root: PathBuf,
    active: Option<Manifest>,
    segment: u32,
    size: u64,
    file: Option<File>,
}
fn known_event(name: &str) -> bool {
    matches!(
        name,
        "calendar.load"
            | "calendar.cache"
            | "calendar.library.candidates"
            | "calendar.library.resolve"
            | "calendar.library.partial"
            | "calendar:fetch"
            | "ui:longtask"
            | "ui:event-loop-stall"
            | "image:loaded"
            | "image:error"
            | "image:memory-hit"
            | "image:failure-cached"
            | "image:coalesced"
            | "image:proxy"
            | "image:disk-lookup"
            | "image:fetch"
            | "image:base64-decode"
            | "image:queue"
            | "runtime:started"
            | "runtime:error"
            | "runtime:unhandled-rejection"
            | "image:art-error"
            | "memory:pressure"
            | "navigation:scroll-memory"
            | "view:discover:mount"
            | "view:home:mount"
            | "native:lifecycle"
            | "native:position"
            | "native:buffering"
            | "native:network"
            | "native:audio"
            | "native:command"
            | "native:pipeline"
    ) || [
        "load",
        "loaded",
        "restart",
        "file-loaded",
        "end-file",
        "buffering",
        "failure",
        "audio-reload",
        "audio-resync",
        "timer-gap",
        "wake-reconnect",
        "wake-reconnect-error",
    ]
    .iter()
    .any(|stage| name == format!("playback:{stage}"))
        || ["img", "fetch", "xmlhttprequest", "script", "css", "other"]
            .iter()
            .any(|kind| name == format!("resource:{kind}"))
        || ["direct", "directfail", "harborfetch", "pluginhttp"]
            .iter()
            .any(|kind| {
                ["ok", "error", "timeout", "abort"]
                    .iter()
                    .any(|outcome| name == format!("bridge:{kind}:{outcome}"))
            })
        || [
            "home",
            "settings",
            "anime",
            "discover",
            "catalogs",
            "plugins",
            "addons",
            "calendar",
            "movies",
            "shows",
            "music",
            "games",
            "kids",
            "library",
            "collections-hub",
            "live",
            "sports",
            "vod",
            "downloads",
            "wrapped",
            "manga",
            "ebook",
            "people",
        ]
        .iter()
        .any(|view| {
            ["requested", "superseded", "shell-paint", "first-paint"]
                .iter()
                .any(|stage| name == format!("navigation:{view}:{stage}"))
        })
}
fn project(fields: &HashMap<String, Value>) -> Value {
    const KEYS: &[&str] = &[
        "navigationId",
        "elapsedMs",
        "error",
        "cancelled",
        "bytes",
        "cached",
        "hit",
        "items",
        "candidates",
        "rows",
        "series",
        "movies",
        "persistent",
        "load",
        "allowPaused",
        "normalized",
        "position",
        "active",
        "cache",
        "stopped",
        "failed",
        "suppressed",
        "buffering",
        "live",
        "advancing",
        "status",
        "resolved",
        "pending",
        "complete",
        "count",
        "cause",
        "event",
        "reason",
        "underrun",
        "retry",
        "gapMs",
        "dropped",
        "decoder",
        "frameDrops",
        "idle",
        "paused",
        "hasSnapshot",
        "high",
        "rssMB",
        "local",
        "insecure",
        "fallback",
    ];
    let mut safe = serde_json::Map::new();
    for (key, value) in fields.iter().take(32) {
        if KEYS.contains(&key.as_str())
            && (value.is_boolean()
                || value
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && v.abs() <= 9_007_199_254_740_991.0))
        {
            safe.insert(key.clone(), value.clone());
        }
    }
    Value::Object(safe)
}
impl Engine {
    fn session_dir(&self, id: &str) -> Result<PathBuf, String> {
        if !id_ok(id) {
            return Err("invalid session ID".into());
        }
        let path = self.root.join(id);
        safe_path(&path)?;
        Ok(path)
    }
    fn save(&self) -> Result<(), String> {
        if let Some(m) = &self.active {
            let dir = self.session_dir(&m.session_id)?;
            let path = dir.join("manifest.json");
            fs::write(
                dir.join("manifest.tmp"),
                serde_json::to_vec_pretty(m).map_err(|_| "manifest encoding")?,
            )
            .map_err(|_| "manifest write failed")?;
            fs::rename(dir.join("manifest.tmp"), path)
                .map_err(|_| "manifest replacement failed")?;
        }
        Ok(())
    }
    fn manifests(&self) -> Result<Vec<Manifest>, String> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.root)
            .map_err(|_| "session directory unavailable")?
            .flatten()
        {
            let id = entry.file_name().to_string_lossy().into_owned();
            if !id_ok(&id) {
                continue;
            }
            let dir = self.session_dir(&id)?;
            if let Ok(bytes) = fs::read(dir.join("manifest.json")) {
                if bytes.len() < 64 * 1024 {
                    if let Ok(m) = serde_json::from_slice::<Manifest>(&bytes) {
                        out.push(m);
                    }
                }
            }
        }
        out.sort_by_key(|m| std::cmp::Reverse(m.started_at));
        Ok(out)
    }
    fn prune(&mut self) -> Result<(), String> {
        let sessions = self.manifests()?;
        let mut kept = 0;
        let mut total = 0;
        for m in sessions {
            let active = self
                .active
                .as_ref()
                .is_some_and(|a| a.session_id == m.session_id);
            if active
                || (kept < 8
                    && total + m.bytes < 256 * 1024 * 1024
                    && wall().saturating_sub(m.started_at) < 7 * 86400 * 1000)
            {
                kept += 1;
                total += m.bytes;
            } else {
                let dir = self.session_dir(&m.session_id)?;
                fs::remove_dir_all(dir).map_err(|_| "session prune failed")?;
            }
        }
        Ok(())
    }
    fn stop(&mut self) -> Result<Value, String> {
        if let Some(file) = &mut self.file {
            file.flush().map_err(|_| "session flush failed")?;
        }
        if let Some(m) = &mut self.active {
            m.ended_at = Some(wall());
        }
        self.save()?;
        self.file = None;
        self.active = None;
        Ok(self.status())
    }
    fn status(&self) -> Value {
        json!({"active":self.active,"nativeDrops":NATIVE_DROPS.load(std::sync::atomic::Ordering::Relaxed),"nativeMonoMs":mono(),"nativeWallMs":wall(),"schemaVersion":1,"buildIdentity":if cfg!(feature="context-review") {"context-review"} else {"production"}})
    }
    fn write_line(&mut self, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "event encoding failed")?;
        bytes.push(b'\n');
        if bytes.len() > 4096 {
            return Err("event too large".into());
        }
        if self.file.is_none() || self.size + bytes.len() as u64 > SEGMENT {
            self.file = None;
            self.segment += 1;
            self.size = 0;
            let m = self.active.as_ref().ok_or("no active session")?;
            let dir = self.session_dir(&m.session_id)?;
            self.file = Some(
                OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(dir.join(format!("events-{:06}.jsonl", self.segment)))
                    .map_err(|_| "segment create failed")?,
            );
            if self.segment > SEGMENTS {
                let old = dir.join(format!("events-{:06}.jsonl", self.segment - SEGMENTS));
                safe_path(&old)?;
                let removed = fs::metadata(&old).map(|m| m.len()).unwrap_or(0);
                fs::remove_file(old).map_err(|_| "segment rotation failed")?;
                if let Some(m) = &mut self.active {
                    m.bytes = m.bytes.saturating_sub(removed);
                    m.rotated += removed;
                }
            }
        }
        self.file
            .as_mut()
            .unwrap()
            .write_all(&bytes)
            .map_err(|_| "session write failed")?;
        self.size += bytes.len() as u64;
        if let Some(m) = &mut self.active {
            m.events += 1;
            m.bytes += bytes.len() as u64;
        }
        Ok(())
    }
    fn run(&mut self, op: Op) -> Result<Value, String> {
        match op {
            Op::Start(mode, domains, rotate) => {
                if !["basic", "detailed"].contains(&mode.as_str()) || domains > 63 {
                    return Err("invalid capture options".into());
                }
                if self.active.is_some() {
                    if !rotate {
                        return Ok(self.status());
                    }
                    self.stop()?;
                }
                self.prune()?;
                let id = uuid::Uuid::new_v4().to_string();
                let dir = self.session_dir(&id)?;
                fs::create_dir(&dir).map_err(|_| "session create failed")?;
                self.segment = 0;
                self.size = 0;
                self.active = Some(Manifest {
                    schema_version: 1,
                    session_id: id,
                    started_at: wall(),
                    mode,
                    domains,
                    ..Default::default()
                });
                self.save()?;
                self.write_line(&json!({"producer":"native","seq":0,"monoMs":mono(),"wallMs":wall(),"name":"native:pipeline","fields":{"active":true}}))?;
                Ok(self.status())
            }
            Op::Stop(id) => {
                if !self.active.as_ref().is_some_and(|m| m.session_id == id) {
                    return Err("session is not active".into());
                }
                self.stop()
            }
            Op::Status => Ok(self.status()),
            Op::List => Ok(json!(self.manifests()?)),
            Op::Prune => {
                self.prune()?;
                Ok(self.status())
            }
            Op::Append(batch) => {
                if batch.events.len() > 128
                    || !id_ok(&batch.producer)
                    || serde_json::to_vec(&batch)
                        .map_err(|_| "invalid batch")?
                        .len()
                        > 64 * 1024
                {
                    return Err("invalid batch bounds".into());
                }
                let m = self.active.as_ref().ok_or("no active session")?;
                if m.session_id != batch.session_id {
                    return Err("session changed".into());
                }
                let mut last = *m.producers.get(&batch.producer).unwrap_or(&0);
                let mut lost = 0;
                for event in &batch.events {
                    if !event.mono_ms.is_finite()
                        || event.mono_ms < 0.0
                        || !known_event(&event.name)
                        || event.fields.len() > 32
                    {
                        return Err("invalid event".into());
                    }
                    if event.seq <= last {
                        continue;
                    }
                    if event.seq != last + 1 {
                        let gap = event.seq - last - 1;
                        if lost + gap > batch.dropped_before {
                            return Err("undeclared sequence gap".into());
                        }
                        lost += gap;
                    }
                    last = event.seq;
                }
                let mut previous = *self
                    .active
                    .as_ref()
                    .unwrap()
                    .producers
                    .get(&batch.producer)
                    .unwrap_or(&0);
                for event in batch.events {
                    if event.seq <= previous {
                        continue;
                    }
                    self.write_line(&json!({"producer":batch.producer,"seq":event.seq,"monoMs":event.mono_ms,"wallMs":event.wall_ms,"name":event.name,"fields":project(&event.fields)}))?;
                    self.active
                        .as_mut()
                        .unwrap()
                        .producers
                        .insert(batch.producer.clone(), event.seq);
                    previous = event.seq;
                }
                if let Some(file) = &mut self.file {
                    file.flush().map_err(|_| "session flush failed")?;
                }
                if let Some(m) = &mut self.active {
                    m.dropped += lost;
                }
                self.save()?;
                Ok(json!({"acceptedThroughSeq":last,"persistedThroughSeq":last,"dropped":lost}))
            }
            Op::Native(name, fields, seq) => {
                let bit = if name == "native:network" { 4 } else { 1 };
                if !self.active.as_ref().is_some_and(|m| m.domains & bit != 0) || !known_event(&name) {
                    return Ok(Value::Null);
                }
                let fields = fields
                    .as_object()
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                    .unwrap_or_default();
                self.write_line(&json!({"producer":"native","seq":seq,"monoMs":mono(),"wallMs":wall(),"name":name,"fields":project(&fields)}))?;
                Ok(Value::Null)
            }
            Op::Folder(id) => {
                let path = if let Some(id) = id {
                    self.session_dir(&id)?
                } else {
                    self.root.clone()
                };
                Ok(json!(path.to_string_lossy()))
            }
            Op::Export(id) => {
                if self.active.as_ref().is_some_and(|m| m.session_id == id) {
                    if let Some(file) = &mut self.file {
                        file.flush().map_err(|_| "session flush failed")?;
                    }
                    self.save()?;
                }
                let dir = self.session_dir(&id)?;
                let manifest =
                    fs::read(dir.join("manifest.json")).map_err(|_| "session not found")?;
                let destination = self
                    .root
                    .join(format!("export-{}.zip", uuid::Uuid::new_v4()));
                let mut zip = zip::ZipWriter::new(
                    File::create(&destination).map_err(|_| "export create failed")?,
                );
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);
                zip.start_file("manifest.json", options)
                    .map_err(|_| "ZIP failed")?;
                zip.write_all(&manifest).map_err(|_| "ZIP write failed")?;
                let mut files = fs::read_dir(&dir)
                    .map_err(|_| "session unavailable")?
                    .flatten()
                    .filter(|e| {
                        e.file_name().to_string_lossy().starts_with("events-")
                            && e.file_name().to_string_lossy().ends_with(".jsonl")
                    })
                    .collect::<Vec<_>>();
                files.sort_by_key(|e| e.file_name());
                let mut total = 0;
                for entry in files {
                    safe_path(&entry.path())?;
                    let len = entry.metadata().map_err(|_| "event metadata failed")?.len();
                    if total + len > 20 * 1024 * 1024 {
                        return Err("export input exceeds bound".into());
                    }
                    total += len;
                    zip.start_file(entry.file_name().to_string_lossy(), options)
                        .map_err(|_| "ZIP failed")?;
                    let mut file = File::open(entry.path()).map_err(|_| "event read failed")?;
                    std::io::copy(&mut file, &mut zip).map_err(|_| "ZIP copy failed")?;
                }
                zip.start_file("summary.txt", options)
                    .map_err(|_| "ZIP failed")?;
                zip.write_all(b"Structured diagnostics only. Monotonic clocks are producer-local; wall clocks are correlation anchors, not exact synchronization. Rotation, drop counts and producer watermarks are in manifest.json. Legacy player history and private caches are excluded.\n").map_err(|_|"ZIP write failed")?;
                zip.finish().map_err(|_| "ZIP finish failed")?;
                let bytes = fs::metadata(&destination)
                    .map_err(|_| "export unavailable")?
                    .len();
                Ok(json!({"sessionId":id,"path":destination,"bytes":bytes}))
            }
            Op::PrefsRead => {
                let path = self.root.join("preferences.json");
                let value = fs::read(&path)
                    .ok()
                    .filter(|v| v.len() < 4096)
                    .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
                    .unwrap_or(
                        json!({"enabled":false,"autoStart":false,"mode":"basic","domains":63}),
                    );
                Ok(value)
            }
            Op::PrefsWrite(value) => {
                let enabled = value
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or("invalid preference")?;
                let auto_start = value
                    .get("autoStart")
                    .and_then(Value::as_bool)
                    .ok_or("invalid preference")?;
                let mode = value
                    .get("mode")
                    .and_then(Value::as_str)
                    .filter(|m| ["basic", "detailed"].contains(m))
                    .ok_or("invalid mode")?;
                let domains = value
                    .get("domains")
                    .and_then(Value::as_u64)
                    .filter(|d| *d <= 63)
                    .ok_or("invalid domains")?;
                let safe =
                    json!({"enabled":enabled,"autoStart":auto_start,"mode":mode,"domains":domains});
                fs::write(
                    self.root.join("preferences.tmp"),
                    serde_json::to_vec(&safe).unwrap(),
                )
                .map_err(|_| "preferences write failed")?;
                fs::rename(
                    self.root.join("preferences.tmp"),
                    self.root.join("preferences.json"),
                )
                .map_err(|_| "preferences replace failed")?;
                Ok(safe)
            }
        }
    }
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    if SERVICE.get().is_some() {
        return Ok(());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "app data unavailable")?
        .join("diagnostics")
        .join("sessions");
    safe_path(&root)?;
    fs::create_dir_all(&root).map_err(|_| "diagnostics directory unavailable")?;
    let (send, receive) = sync_channel::<Request>(32);
    SERVICE
        .set(send)
        .map_err(|_| "diagnostics already started")?;
    CLOCK.get_or_init(Instant::now);
    std::thread::spawn(move || {
        let mut engine = Engine {
            root,
            active: None,
            segment: 0,
            size: 0,
            file: None,
        };
        if let Ok(sessions) = engine.manifests() {
            for mut m in sessions {
                if m.ended_at.is_none() {
                    m.interrupted = true;
                    m.ended_at = Some(wall());
                    engine.active = Some(m);
                    let _ = engine.save();
                    engine.active = None;
                }
            }
        }
        let _ = engine.prune();
        while let Ok(request) = receive.recv() {
            let result = engine.run(request.op);
            if let Some(reply) = request.reply {
                let _ = reply.send(result);
            }
        }
    });
    Ok(())
}
async fn submit(op: Op) -> Result<Value, String> {
    let (reply, receive) = tokio::sync::oneshot::channel();
    SERVICE
        .get()
        .ok_or("diagnostics service unavailable")?
        .try_send(Request {
            op,
            reply: Some(reply),
        })
        .map_err(|_| "diagnostics queue full")?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receive)
        .await
        .map_err(|_| "diagnostics operation timed out")?
        .map_err(|_| "diagnostics worker unavailable")?
}
pub fn native(name: &str, fields: Value) {
    let seq = NATIVE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    if let Some(service) = SERVICE.get() {
        if service
            .try_send(Request {
                op: Op::Native(name.into(), fields, seq),
                reply: None,
            })
            .is_err()
        {
            NATIVE_DROPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}
#[tauri::command]
pub async fn diagnostics_session_start(
    window: tauri::WebviewWindow,
    mode: String,
    domains: u32,
    rotate_current: bool,
) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::Start(mode, domains, rotate_current)).await
}
#[tauri::command]
pub async fn diagnostics_session_status(window: tauri::WebviewWindow) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::Status).await
}
#[tauri::command]
pub async fn diagnostics_session_stop(
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::Stop(session_id)).await
}
#[tauri::command]
pub async fn diagnostics_append_batch(
    window: tauri::WebviewWindow,
    batch: Batch,
) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::Append(batch)).await
}
#[tauri::command]
pub async fn diagnostics_sessions_list(window: tauri::WebviewWindow) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::List).await
}
#[tauri::command]
pub async fn diagnostics_session_export(
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::Export(session_id)).await
}
#[tauri::command]
pub async fn diagnostics_sessions_prune(window: tauri::WebviewWindow) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::Prune).await
}
#[tauri::command]
pub async fn diagnostics_preferences_read(window: tauri::WebviewWindow) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::PrefsRead).await
}
#[tauri::command]
pub async fn diagnostics_preferences_write(
    window: tauri::WebviewWindow,
    value: Value,
) -> Result<Value, String> {
    trusted(&window)?;
    submit(Op::PrefsWrite(value)).await
}
#[tauri::command]
pub async fn diagnostics_clock_sample(window: tauri::WebviewWindow) -> Result<Value, String> {
    trusted(&window)?;
    Ok(json!({"monoMs":mono(),"wallMs":wall()}))
}
#[tauri::command]
pub async fn diagnostics_session_open_folder(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: Option<String>,
) -> Result<(), String> {
    trusted(&window)?;
    let path = submit(Op::Folder(session_id)).await?;
    app.opener()
        .open_path(path.as_str().ok_or("invalid folder")?, None::<&str>)
        .map_err(|_| "could not open diagnostics folder".into())
}
