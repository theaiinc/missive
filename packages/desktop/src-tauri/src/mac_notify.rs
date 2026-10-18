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

pub fn post(title: &str, body: &str) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let id = NSString::from_str(&format!("missive-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
}

define_class!(
    // Shows notifications while Missive is the active app too (macOS hides
    // them by default then), and brings the window back when one is clicked.
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
            _response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let handle = self.ivars().clone();
            let _ = self.ivars().run_on_main_thread(move || {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
            handler.call(());
        }
    }
);

/// Installs the delegate; the notification center holds it weakly, so it lives as long as the app.
pub fn install_delegate(handle: AppHandle) {
    let delegate: Retained<Delegate> = unsafe { msg_send![super(Delegate::alloc().set_ivars(handle)), init] };
    UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
}
