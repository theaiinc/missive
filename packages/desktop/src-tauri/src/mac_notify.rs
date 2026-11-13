// macOS notifications through UserNotifications, so Missive asks for
// permission the way other Mac apps do and appears in System Settings →
// Notifications. The page reaches it through the commands in main.rs
// (see notifications.js).
use std::sync::atomic::{AtomicU64, Ordering};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Manager};

/// As the web's Notification.permission: "granted", "denied" or "default" (not asked yet).
pub fn permission(done: impl Fn(&'static str) + 'static) {
    let block = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        done(match status {
            UNAuthorizationStatus::NotDetermined => "default",
            UNAuthorizationStatus::Denied => "denied",
            _ => "granted",
        });
    });
    UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block);
}

/// The system's Allow / Don't Allow prompt; once answered, macOS answers by itself.
pub fn request(done: impl Fn(&'static str) + 'static) {
    let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        done(if granted.as_bool() { "granted" } else { "denied" });
    });
    let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(options, &block);
}

/// `key` (the page's tag: one per conversation) makes a newer notification
/// replace the last one and groups them; `url` is where a click goes. Both
/// ride in the identifier, so a click works after a relaunch too.
pub fn post(title: &str, body: &str, key: Option<&str>, url: Option<&str>) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let key = key.filter(|k| !k.is_empty()).map(str::to_string).unwrap_or_else(|| format!("n-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    content.setThreadIdentifier(&NSString::from_str(&key));
    let id = NSString::from_str(&format!("missive|{}|{}", key.replace('|', "_"), url.unwrap_or("/inbox")));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
}

define_class!(
    // Shows notifications while Missive is the active app too (macOS hides
    // them by default then), and opens what one was about when it's clicked.
    #[unsafe(super(NSObject))]
    #[name = "MissiveNotificationDelegate"]
    #[ivars = AppHandle]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            let handle = self.ivars().clone();
            let _ = self.ivars().run_on_main_thread(move || {
                match parse_identifier(&id) {
                    Some((key, url)) => crate::open_from_notification(&handle, &key, &url),
                    None => {
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            });
            handler.call(());
        }
    }
);

/// "missive|key|/chat/t_abc" → (key, path); older ones ("missive-3") carry no path.
fn parse_identifier(id: &str) -> Option<(String, String)> {
    let mut parts = id.splitn(3, '|');
    if parts.next()? != "missive" {
        return None;
    }
    let key = parts.next()?.to_string();
    let url = parts.next()?.to_string();
    Some((key, url))
}

/// Installs the delegate; the notification center holds it weakly, so it lives as long as the app.
pub fn install_delegate(handle: AppHandle) {
    let delegate: Retained<Delegate> = unsafe { msg_send![super(Delegate::alloc().set_ivars(handle)), init] };
    UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
}
