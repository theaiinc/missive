fn main() {
    // The app's own commands, so capabilities/missive-site.json can let the
    // live site call them (src/notifications.js).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["notification_permission", "request_notification_permission", "notify"]),
    ))
    .expect("failed to run tauri-build");
}
