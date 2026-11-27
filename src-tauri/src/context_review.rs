/// Optional developer build: one fixed identity with storage below a validated
/// test root. Runtime identifiers are deliberately not accepted.
pub const REVIEW_IDENTITY: &str = "app.harbor.context-review";
const REVIEW_PRODUCT: &str = "Harbor Context Review";
static STORAGE_ATTESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn is_context_review() -> bool {
    cfg!(feature = "context-review")
}

fn is_review_identity(identifier: &str) -> bool {
    identifier == REVIEW_IDENTITY
}

fn contains_reparse(path: &std::path::Path) -> Result<(), String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("cannot resolve storage root: {error}"))?
            .join(path)
    };
    let mut current = std::path::PathBuf::new();
    for component in absolute.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("storage path contains parent traversal".into());
        }
        current.push(component.as_os_str());
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "cannot inspect storage component {current:?}: {error}"
                ))
            }
        };
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "storage path contains a reparse/symlink component: {current:?}"
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(format!(
                    "storage path contains a reparse component: {current:?}"
                ));
            }
        }
    }
    Ok(())
}

fn validate_review_storage() -> Result<std::path::PathBuf, String> {
    let temp = std::env::temp_dir().join(REVIEW_IDENTITY);
    contains_reparse(&std::env::temp_dir())?;
    for variable in ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR"] {
        if let Some(value) = std::env::var_os(variable) {
            contains_reparse(std::path::Path::new(&value))?;
            if matches!(variable, "APPDATA" | "LOCALAPPDATA") {
                contains_reparse(&std::path::Path::new(&value).join(REVIEW_IDENTITY))?;
            }
        }
    }
    contains_reparse(&temp)?;
    Ok(temp)
}

pub fn prepare(config: &tauri::Config) -> Result<(), String> {
    if !cfg!(feature = "context-review") {
        return Ok(());
    }
    if !is_review_identity(&config.identifier)
        || config.product_name.as_deref() != Some(REVIEW_PRODUCT)
    {
        return Err("context-review requires tauri.context-review.conf.json".into());
    }
    let temp = validate_review_storage()?;
    let nonce = std::env::var("HARBOR_DIAG_RUN_NONCE").unwrap_or_default();
    if !nonce.is_empty()
        && (nonce.len() > 128
            || !nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'))
    {
        return Err("HARBOR_DIAG_RUN_NONCE has an invalid format".into());
    }
    std::fs::create_dir_all(&temp)
        .map_err(|error| format!("Could not create review temporary directory: {error}"))?;
    for variable in ["TEMP", "TMP", "TMPDIR"] {
        std::env::set_var(variable, &temp);
    }
    Ok(())
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("context-review")
        .js_init_script("Object.defineProperty(window, '__HARBOR_CONTEXT_REVIEW__', { value: true, writable: false, configurable: false });")
        .on_webview_ready(|webview| {
            if let Ok(script) = identity_script(webview.label()) {
                let _ = webview.eval(script);
            }
        })
        .build()
}

/// Called by the application before any service starts and before emitting an
/// identity. The caller must pass its actual WebView2 data directory as well.
pub fn attest_storage<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    webview_data: &std::path::Path,
) -> Result<(), String> {
    use tauri::Manager;
    if !is_context_review() || app.config().identifier != REVIEW_IDENTITY {
        return Err("review storage requires the compiled review identity".into());
    }
    let paths = [
        app.path().app_data_dir(),
        app.path().app_local_data_dir(),
        app.path().app_cache_dir(),
        app.path().app_log_dir(),
    ];
    for path in paths {
        let path = path.map_err(|error| error.to_string())?;
        if !path
            .components()
            .any(|component| component.as_os_str() == REVIEW_IDENTITY)
        {
            return Err("resolved application storage is not review-scoped".into());
        }
        contains_reparse(&path)?;
    }
    let local = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    if !webview_data.starts_with(&local) || webview_data == local {
        return Err("WebView storage is not review-scoped".into());
    }
    contains_reparse(webview_data)?;
    STORAGE_ATTESTED.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Only call after attest_storage succeeds, passing the actual native label.
pub fn identity_script(label: &str) -> Result<String, String> {
    if !is_context_review() || !STORAGE_ATTESTED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("review storage is not attested".into());
    }
    let nonce = std::env::var("HARBOR_DIAG_RUN_NONCE").map_err(|_| "missing runner nonce")?;
    if nonce.is_empty()
        || nonce.len() > 128
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("invalid runner nonce".into());
    }
    let role = match label {
        "main" => "main",
        "harbor-tray-menu" => "tray",
        _ => "auxiliary",
    };
    let identity = serde_json::json!({"appId": REVIEW_IDENTITY, "buildId": "context-review", "windowRole": role, "nonce": nonce, "pid": std::process::id(), "storageVerified": true});
    Ok(format!("Object.defineProperty(window, '__HARBOR_CONTEXT_IDENTITY__', {{ value: Object.freeze({identity}), writable: false, configurable: false }});"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_fixed_review_identity_is_accepted() {
        assert!(super::is_review_identity("app.harbor.context-review"));
        for identifier in [
            "app.harbor",
            "app.harbor.context-review.run-1",
            "app.harbor.context-review.",
            "app.harbor.context-review/../harbor",
            "app.harbor.context-review.other/path",
        ] {
            assert!(!super::is_review_identity(identifier));
        }
    }

    #[test]
    fn storage_validation_rejects_parent_traversal() {
        assert!(super::contains_reparse(&std::env::temp_dir().join("..").join("outside")).is_err());
    }

    #[test]
    fn review_build_cannot_use_production_identity() {
        if cfg!(feature = "context-review") {
            assert!(super::prepare(&tauri::Config::default()).is_err());
        }
    }
}
