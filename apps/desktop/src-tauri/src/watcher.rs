//! Workspace file watcher for the file tree and changes panel (checklist M1-25).
//!
//! Emits `workspace://changed` with the workspace path, at most every 300 ms, and the UI re-reads `workspace.files`.
//! On Linux, inotify needs one watch per folder, so heavy folders like `node_modules` aren't watched there.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

const DEBOUNCE: Duration = Duration::from_millis(300);

/// Folders whose changes never show in the tree: dependencies, build output, git's object store.
const NOISE: &[&str] = &[
    "node_modules",
    "target",
    ".venv",
    "__pycache__",
    ".git/objects",
    ".git/logs",
];

#[derive(Default)]
pub struct Watchers {
    active: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl Watchers {
    /// Starts watching `cwd` (idempotent); `on_change` gets `cwd` after each burst of relevant changes.
    pub fn watch(
        &self,
        cwd: String,
        on_change: impl Fn(&str) + Send + 'static,
    ) -> Result<(), String> {
        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        if active.contains_key(&cwd) {
            return Ok(());
        }
        // Events carry resolved paths (e.g. /private/var on macOS), so compare against the resolved root.
        let root = PathBuf::from(&cwd)
            .canonicalize()
            .map_err(|_| format!("not a folder: {cwd}"))?;
        if !root.is_dir() {
            return Err(format!("not a folder: {cwd}"));
        }
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for path in event.paths {
                    let _ = tx.send(path);
                }
            }
        })
        .map_err(|e| e.to_string())?;
        add_watches(&mut watcher, &root)?;

        let name = cwd.clone();
        // Ends when the watcher is dropped (unwatch), which closes the channel.
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut relevant = !is_noise(&root, &first);
                while let Ok(next) = rx.recv_timeout(DEBOUNCE) {
                    relevant |= !is_noise(&root, &next);
                }
                if relevant {
                    on_change(&name);
                }
            }
        });
        active.insert(cwd, watcher);
        Ok(())
    }

    pub fn unwatch(&self, cwd: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(cwd);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn add_watches(watcher: &mut RecommendedWatcher, root: &Path) -> Result<(), String> {
    // FSEvents and ReadDirectoryChangesW watch a whole tree with one handle.
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn add_watches(watcher: &mut RecommendedWatcher, root: &Path) -> Result<(), String> {
    // The root itself (new top-level entries), git's HEAD and index (branch switches, staging), then every top-level
    // folder that isn't noise. A top-level folder created later shows up on the next refresh.
    watcher
        .watch(root, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    let git = root.join(".git");
    if git.is_dir() {
        let _ = watcher.watch(&git, RecursiveMode::NonRecursive);
    }
    for entry in std::fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        let name = entry.file_name();
        if path.is_dir() && name != ".git" && !NOISE.iter().any(|n| name == *n) {
            let _ = watcher.watch(&path, RecursiveMode::Recursive);
        }
    }
    Ok(())
}

fn is_noise(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    NOISE
        .iter()
        .any(|n| rel == *n || rel.starts_with(&format!("{n}/")) || rel.contains(&format!("/{n}/")))
}

#[cfg(test)]
mod tests {
    use super::{Watchers, is_noise};
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn reports_file_changes_but_not_dependency_churn() {
        let dir = std::env::temp_dir().join(format!("ac-watch-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("node_modules/dep")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let watchers = Watchers::default();
        let (tx, rx) = mpsc::channel();
        watchers
            .watch(cwd.clone(), move |name| {
                let _ = tx.send(name.to_owned());
            })
            .unwrap();
        // Let the OS watch settle (FSEvents can report a little history).
        std::thread::sleep(Duration::from_millis(500));
        while rx.try_recv().is_ok() {}

        std::fs::write(dir.join("node_modules/dep/index.js"), "x").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_secs(2)).is_err(),
            "node_modules churn is ignored"
        );

        std::fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), cwd);

        watchers.unwatch(&cwd);
        std::thread::sleep(Duration::from_millis(500));
        while rx.try_recv().is_ok() {}
        std::fs::write(dir.join("src/after.rs"), "").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_secs(2)).is_err(),
            "no events after unwatch"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_dependency_build_and_git_object_changes() {
        let root = Path::new("/repo");
        assert!(is_noise(root, Path::new("/repo/node_modules/x/index.js")));
        assert!(is_noise(
            root,
            Path::new("/repo/packages/a/node_modules/y.js")
        ));
        assert!(is_noise(root, Path::new("/repo/.git/objects/ab/cdef")));
        assert!(!is_noise(root, Path::new("/repo/src/main.rs")));
        assert!(!is_noise(root, Path::new("/repo/.git/index")));
        assert!(!is_noise(root, Path::new("/repo/.git/HEAD")));
        assert!(!is_noise(root, Path::new("/repo/targets.md")));
    }
}
