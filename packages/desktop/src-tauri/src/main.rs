// Missive's desktop app: one window on the live site, so it gets its own Dock
// icon. Nothing is served locally; sign-in, mail and settings are the web app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
mod mac_notify;

const SITE: &str = "https://missive.theaiinc.com";
const APP_URL: &str = "https://missive.theaiinc.com/inbox";

// Google refuses OAuth in embedded web views it can spot by their user agent
// (disallowed_useragent), so Gmail connect and Google sign-in need Safari's.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

// Signing in happens in the default browser, where passkeys and security keys
// work (a web view can't use them). The site's /auth/login is opened there with
// desktop=1; when it's done the browser opens missive://auth?code=..., and the
// code, redeemed once at /auth/desktop, signs this window in
// (packages/backend/src/auth/desktop-handoff.ts).
fn is_sign_in(url: &Url) -> bool {
    url.origin().ascii_serialization() == SITE && url.path() == "/auth/login"
}

// Connecting Gmail, Outlook or Google Calendar (Settings, Calendar) goes to
// the provider's sign-in, which stalls in a web view too (Google's two-step
// verification never finishes). It also goes to the browser, with "desktop:"
// before its state; Google sends that back to /oauth, which then opens
// missive://oauth?... (web/src/pages/OAuthCallback.tsx) and this window
// finishes the connection on /oauth, signed in as itself.
const PROVIDER_SIGN_IN: &[&str] = &["accounts.google.com", "login.microsoftonline.com", "login.live.com"];
const AEGIS: &str = "id.theaiinc.com";

fn is_provider_sign_in(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|h| PROVIDER_SIGN_IN.contains(&h))
}

// Aegis's own pages (sign-in, two-step, passkeys) as well, except signing out,
// which has to clear this window's Aegis session.
fn is_aegis(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(AEGIS) && url.path() != "/session/end"
}

fn sign_in_in_browser(handle: &AppHandle, login: &Url) {
    let mut url = login.clone();
    let kept: Vec<(String, String)> = login
        .query_pairs()
        .filter(|(k, _)| k != "desktop")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(kept)
        .append_pair("desktop", "1");
    open_in_browser(handle, &url);
    show_waiting(handle, "signin", login);
}

fn connect_in_browser(handle: &AppHandle, provider: &Url) {
    let mut url = provider.clone();
    let pairs: Vec<(String, String)> = provider
        .query_pairs()
        .map(|(k, v)| {
            let v = if k == "state" && !v.starts_with("desktop:") { format!("desktop:{v}") } else { v.into_owned() };
            (k.into_owned(), v)
        })
        .collect();
    if !pairs.is_empty() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    open_in_browser(handle, &url);
    show_waiting(handle, "connect", provider);
}

fn open_in_browser(handle: &AppHandle, url: &Url) {
    // A signed-out page asks to sign in once per request that failed: open
    // the browser for the first only, or each new tab spoils the one before.
    static LAST_OPENED: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let mut last = LAST_OPENED.lock().unwrap();
    if last.is_none_or(|at| at.elapsed() > std::time::Duration::from_secs(5)) {
        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
        *last = Some(std::time::Instant::now());
    }
}

/// The window stays on a page saying where to look, with a way to open the browser again.
fn show_waiting(handle: &AppHandle, kind: &str, again: &Url) {
    if let Some(window) = handle.get_webview_window("main") {
        let mut page = Url::parse("tauri://localhost/signin.html").expect("a URL");
        page.query_pairs_mut().append_pair("kind", kind).append_pair("again", again.as_str());
        tauri::async_runtime::spawn(async move {
            let _ = window.navigate(page);
        });
    }
}

fn signed_in(handle: &AppHandle, urls: Vec<Url>) {
    let Some(link) = urls.iter().find(|u| u.scheme() == "missive") else {
        return;
    };
    let mut url = Url::parse(SITE).expect("SITE is a URL");
    match link.host_str() {
        // Signed in in the browser: redeem the code here (auth.controller.ts).
        Some("auth") => {
            let Some(code) = link.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.into_owned()) else {
                return;
            };
            url.set_path("/auth/desktop");
            url.query_pairs_mut().append_pair("code", &code);
        }
        // Back from connecting an account: /oauth exchanges the code as this window's user.
        Some("oauth") => {
            url.set_path("/oauth");
            url.set_query(link.query());
        }
        _ => return,
    }
    let Some(window) = handle.get_webview_window("main") else {
        return;
    };
    let _ = window.navigate(url);
    let _ = window.show();
    let _ = window.set_focus();
}

// The page's Notification stand-in (notifications.js) calls these.
#[cfg(target_os = "macos")]
async fn answer(ask: fn(Box<dyn Fn(&'static str)>)) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    ask(Box::new(move |state| {
        let _ = tx.send(state);
    }));
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(120)))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or("default")
        .to_string()
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn notification_permission() -> String {
    answer(|done| mac_notify::permission(done)).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_notification_permission() -> String {
    answer(|done| mac_notify::request(done)).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn notify(title: String, body: String) {
    mac_notify::post(&title, &body);
}

/// At launch: asks to notify if never asked; if notifications are off, offers
/// to turn them on in System Settings (macOS doesn't let an app ask twice).
#[cfg(target_os = "macos")]
fn ask_to_notify(handle: AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    mac_notify::permission(move |state| match state {
        "default" => mac_notify::request(|_| {}),
        "denied" => {
            let opener = handle.clone();
            handle
                .dialog()
                .message("Turn them on to hear about new mail and see the unread count on the Dock icon.")
                .title("Notifications are off for Missive")
                .buttons(MessageDialogButtons::OkCancelCustom("Open Settings".into(), "Not Now".into()))
                .show(move |open| {
                    if open {
                        let _ = opener.opener().open_url(
                            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.theaiinc.missive",
                            None::<&str>,
                        );
                    }
                });
        }
        _ => {}
    });
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        notification_permission,
        request_notification_permission,
        notify
    ]);
    let app = builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                mac_notify::install_delegate(app.handle().clone());
                ask_to_notify(app.handle().clone());
            }
            let handle = app.handle().clone();
            let nav_handle = app.handle().clone();
            let link_handle = app.handle().clone();
            app.deep_link()
                .on_open_url(move |event| signed_in(&link_handle, event.urls()));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(APP_URL.parse()?))
                .title("Missive")
                .inner_size(1280.0, 840.0)
                .min_inner_size(800.0, 560.0)
                .user_agent(USER_AGENT)
                // New mail as macOS notifications (see the script).
                .initialization_script(include_str!("notifications.js"))
                .on_navigation(move |url| {
                    if is_sign_in(url) {
                        sign_in_in_browser(&nav_handle, url);
                        return false;
                    }
                    if is_provider_sign_in(url) {
                        connect_in_browser(&nav_handle, url);
                        return false;
                    }
                    if is_aegis(url) {
                        open_in_browser(&nav_handle, url);
                        show_waiting(&nav_handle, "signin", url);
                        return false;
                    }
                    true
                })
                // Links that open a new tab (a message's links, the account page)
                // go to the default browser rather than a bare window.
                .on_new_window(move |url, _features| {
                    let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    NewWindowResponse::Deny
                })
                .build()?;
            // Launched by the missive:// link itself.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                signed_in(app.handle(), urls);
            }
            Ok(())
        })
        // Closing the window hides it, so Missive keeps checking for mail and
        // notifying; the Dock icon brings it back, Cmd+Q quits. Windows has no
        // Dock (and Missive no tray icon) to bring it back, so there it quits.
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building Missive");

    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event);
    });
}
