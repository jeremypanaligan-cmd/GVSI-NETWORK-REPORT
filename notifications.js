// ====================== PUSH NOTIFICATIONS MODULE ======================
// Firebase Cloud Messaging integration para sa critical incident alerts

// Firebase Config — PALITAN ang values mula sa iyong Firebase Project
// Setup: https://console.firebase.google.com → Project Settings → General → Web App
// Firebase DISABLED — causes console errors (firebase.messaging is not a function)
// Re-enable by replacing 'YOUR_API_KEY' with the actual apiKey below:
// const FIREBASE_CONFIG = {
//   apiKey: "AIzaSyAUF0X0Zo2caTQeilIPA9LTuo68WpJ7ZL8",
//   authDomain: "tryproject-1833f.firebaseapp.com",
//   projectId: "tryproject-1833f",
//   storageBucket: "tryproject-1833f.firebasestorage.app",
//   messagingSenderId: "247812195513",
//   appId: "1:247812195513:web:8aa689921cb9d4d02a8768"
// };
const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY"
};

// VAPID Key — mula sa Firebase Project Settings → Cloud Messaging → Web push certificates
const VAPID_KEY = "BMqo7f-ID_C8xN7Bksac8c_DHd4SgnwS5vfwT3jZ-ngAUAcbvbk58amPgxmG7_wj7dUb711n1RSk7UfIlMvZHWk";

// Apps Script endpoint para sa subscription storage (i-set kapag na-deploy na ang backend)
const NOTIFICATION_API_URL = null; // Set to your Apps Script URL when ready

let _messaging = null;

// ====================== INITIALIZATION ======================

async function initNotifications() {
  // Skip kung hindi pa naka-configure ang Firebase
  if (FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
    console.log('[Notifications] Firebase not configured — skipping push setup');
    return;
  }

  try {
    // Load Firebase SDK
    await loadFirebaseSDK();

    // Check if Firebase is already initialized
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    
    _messaging = firebase.messaging();

    // Listen for foreground messages
    if (_messaging) {
      _messaging.onMessage((payload) => {
        console.log('[Notifications] Foreground message:', payload);
        showInAppNotification(payload);
      });
    }

    console.log('[Notifications] Firebase Messaging initialized');
  } catch (err) {
    console.error('[Notifications] Init failed:', err);
    _messaging = null;
  }
}

function loadFirebaseSDK() {
  return new Promise((resolve, reject) => {
    if (typeof firebase !== 'undefined') { resolve(); return; }

    const scripts = [
      'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js'
    ];

    let loaded = 0;
    scripts.forEach(src => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { loaded++; if (loaded === scripts.length) resolve(); };
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  });
}

// ====================== PERMISSION & SUBSCRIPTION ======================

async function requestNotificationPermission() {
  // Check kung naka-configure ang Firebase SDK
  if (!_messaging) {
    showToast('Notifications initializing — please wait...', 'info');
    return false;
  }

  try {
    // Check current permission
    if (Notification.permission === 'granted') {
      await subscribeToPush();
      return true;
    }

    if (Notification.permission === 'denied') {
      showToast('Notifications blocked. Enable in browser settings.', 'error');
      return false;
    }

    // Request permission
    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
      localStorage.setItem('notif_enabled', 'true');
      updateNotificationUI(true);
      showToast('Notifications enabled! 🔔', 'success');
      await subscribeToPush();
      return true;
    } else {
      showToast('Notifications declined.', 'info');
      return false;
    }
  } catch (err) {
    console.error('[Notifications] Permission error:', err);
    return false;
  }
}

async function subscribeToPush() {
  if (!_messaging) {
    console.log('[Notifications] Messaging not initialized');
    return;
  }

  try {
    const token = await _messaging.getToken({ vapidKey: VAPID_KEY });

    if (token) {
      console.log('[Notifications] FCM Token:', token);

      // Save token locally
      localStorage.setItem('fcm_token', token);

      // Send token to server (Apps Script)
      await sendTokenToServer(token);

      // Update subscription badge
      updateNotificationUI(true);
    }
  } catch (err) {
    console.error('[Notifications] Subscribe error:', err);
  }
}

async function unsubscribeFromPush() {
  try {
    // Delete FCM token if messaging is available
    if (_messaging) {
      const token = await _messaging.getToken();
      if (token) {
        await _messaging.deleteToken();
        localStorage.removeItem('fcm_token');

        // Notify server to remove token
        if (NOTIFICATION_API_URL) {
          await fetch(NOTIFICATION_API_URL, {
            method: 'POST',
            body: JSON.stringify({ action: 'unsubscribe', token: token }),
            headers: { 'Content-Type': 'application/json' }
          }).catch(() => {});
        }
      }
    }

    // Revoke permission via browser API
    if ('permissions' in navigator) {
      const status = await navigator.permissions.query({ name: 'notifications' });
      // Note: Cannot programmatically revoke — user must do it via browser settings
    }

    localStorage.removeItem('fcm_token');
    localStorage.removeItem('notif_enabled');
    updateNotificationUI(false);
    showToast('Notifications disabled. To fully revoke, click the lock icon in the address bar.', 'info', 4000);
  } catch (err) {
    console.error('[Notifications] Unsubscribe error:', err);
  }
}

async function sendTokenToServer(token) {
  if (!NOTIFICATION_API_URL) return;

  try {
    await fetch(NOTIFICATION_API_URL, {
      method: 'POST',
      body: JSON.stringify({
        action: 'subscribe',
        token: token,
        platform: /Android/.test(navigator.userAgent) ? 'android' : 'desktop',
        subscribedAt: new Date().toISOString()
      }),
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('[Notifications] Token sent to server');
  } catch (err) {
    console.error('[Notifications] Failed to send token:', err);
  }
}

// ====================== IN-APP NOTIFICATION ======================

function showInAppNotification(payload) {
  const title = payload.notification?.title || 'GVSI NetPulse';
  const body = payload.notification?.body || 'New incident detected';
  const data = payload.data || {};

  // Use toast system
  showToast(title + ': ' + body, 'warning', 5000);

  // Also try browser notification if permitted
  if (Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body: body,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: data.ticketNo || 'netpulse-alert',
        data: data
      });
    } catch (e) {
      // Silent fail — toast na lang
    }
  }
}

// ====================== UI HELPERS ======================

function updateNotificationUI(isSubscribed) {
  const btn = document.getElementById('notifToggleBtn');
  if (!btn) return;

  /* Both states are outline now, so the difference is carried by weight and colour: the ON
     bell is drawn heavier (the filled bell it replaces read heavier too) and the button's
     own colour is set below. */
  const bellOn = iconMarkup('bell', { size: 14, strokeWidth: 2.6 });
  const bellOff = iconMarkup('bell-off', { size: 14 });

  if (isSubscribed) {
    btn.innerHTML = bellOn;
    btn.title = 'Notifications ON — Click to disable';
    btn.classList.add('active');
    btn.style.color = 'var(--badge-green-text)';
  } else {
    btn.innerHTML = bellOff;
    btn.title = 'Notifications OFF — Click to enable';
    btn.classList.remove('active');
    btn.style.color = '';
  }
}

function isNotificationSubscribed() {
  return Notification.permission === 'granted';
}

// ====================== BUTTON TOGGLE ======================

async function toggleNotifications() {
  if (isNotificationSubscribed()) {
    await unsubscribeFromPush();
  } else {
    await requestNotificationPermission();
  }
}

// Initialize on load — sync bell icon with actual permission state
setTimeout(() => {
  updateNotificationUI(Notification.permission === 'granted');
}, 500);
