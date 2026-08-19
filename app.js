// ============================================================
// CONFIG — fill this in after deploying Api.gs.txt's doPost() as part of
// the Apps Script web app (Deploy > Manage deployments > copy the /exec URL).
// ============================================================
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycbysjczGw2hPim2ah9M82PqoHPSjOiHeZb7GyQtkYH6UKoqiXCKho0nBeFmmaJj6Z5QDbg/exec';

// Login (personal email + PIN accounts) is switched back on as of 2026-07-21.
// Flip to false to fall back to the free-text email field + unauthenticated
// submission path instead, same as before - nothing server-side needs to
// change either way.
const REQUIRE_LOGIN = true;

// ============================================================
// State
// ============================================================
let token = localStorage.getItem('attendance_token');
let employee = JSON.parse(localStorage.getItem('attendance_employee') || 'null');

let currentPosition = null;
let employeeData = [];
let allEmployees = [];
let serverToday = null;

// Session-only choice from the login screen's "Time In/Out" tab - lets
// someone submit attendance without logging in even while REQUIRE_LOGIN is
// on, same unauthenticated path production still uses. Never persisted
// (resets to false on reload) so the login screen is always the default.
let noAuthMode = false;
function authActive() {
  return REQUIRE_LOGIN && !noAuthMode;
}

// All top-level views the app can be on, kept mutually exclusive here so
// every screen function just calls showScreen() instead of separately
// hiding every other screen by hand (which only gets more error-prone as
// more full pages get added, as opposed to the popups these used to be).
// Declared this early (not down near showLogin/showHome) because the
// install-gate flow can call showHome()/showLogin() synchronously at
// module-load time via initInstallUI() below - a `const` declared any
// later would still be in its temporal dead zone at that point and throw.
const ALL_SCREEN_IDS = ['loginScreen', 'homeScreen', 'formContainer', 'leavePage', 'recordsPage', 'documentsPage', 'holidaysPage', 'adminPage'];
function showScreen(id) {
  ALL_SCREEN_IDS.forEach(sid => {
    document.getElementById(sid).style.display = sid === id ? 'block' : 'none';
  });
  closeDrawer();
}

// ============================================================
// API helper — POST with text/plain body to avoid a CORS preflight
// (Apps Script's doPost doesn't answer OPTIONS requests).
// ============================================================
async function apiCall(action, payload) {
  const res = await fetch(API_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action }, payload)),
  });
  if (!res.ok) {
    throw new Error('Request failed (' + res.status + ')');
  }
  return res.json();
}

// ============================================================
// Install gate + install button — Android/Chrome gets a real one-tap
// install prompt via beforeinstallprompt; iOS Safari has no such API
// (Apple has never implemented it), so it gets manual Share -> Add to
// Home Screen instructions instead.
//
// Anyone NOT already running the installed (standalone) app is shown a
// full-screen install gate before the login/attendance form - hard gate,
// deliberately no escape hatch. On a browser/device where install isn't
// supported at all, this blocks attendance submission entirely until
// that's resolved - a known, accepted tradeoff, not an oversight.
// ============================================================
let deferredInstallPrompt = null;

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const isStandalone =
  window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

function showGateStatus(text) {
  const el = document.getElementById('gateInstallStatus');
  el.className = 'status-message loading';
  el.textContent = text;
  el.style.display = 'block';
}

async function triggerInstall() {
  if (isIOS) {
    document.getElementById('iosInstallOverlay').style.display = 'flex';
    return;
  }

  if (!deferredInstallPrompt) {
    showGateStatus('Install isn’t ready yet - give it a second and try again, or check your browser’s menu for "Add to Home Screen" / "Install app".');
    return;
  }

  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
}

function proceedPastInstallGate() {
  document.getElementById('installGate').style.display = 'none';
  if (REQUIRE_LOGIN && token && employee) {
    showHome();
  } else if (!REQUIRE_LOGIN) {
    showAttendanceForm();
  } else {
    showLogin();
  }
}

function initInstallUI() {
  const pillBtn = document.getElementById('installBtn');
  const gateBtn = document.getElementById('gateInstallBtn');

  if (isStandalone) {
    // Already installed and running as the app - nothing to gate or nudge.
    proceedPastInstallGate();
    return;
  }

  document.getElementById('installGate').style.display = 'block';
  pillBtn.style.display = isIOS ? 'block' : 'none'; // Android pill only appears once beforeinstallprompt fires, below

  gateBtn.addEventListener('click', triggerInstall);
  pillBtn.addEventListener('click', triggerInstall);
  document.getElementById('iosInstallClose').addEventListener('click', () => {
    document.getElementById('iosInstallOverlay').style.display = 'none';
  });

  if (!isIOS) {
    // Android/Chrome/Edge: fires only once the browser's own install
    // criteria are met (manifest + service worker + HTTPS - all satisfied here).
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      pillBtn.style.display = 'block';
    });
  }

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    pillBtn.style.display = 'none';
    // Seamlessly continue into the app once install actually completes,
    // even if they were sitting on the gate at the time.
    if (document.getElementById('installGate').style.display !== 'none') {
      proceedPastInstallGate();
    }
  });
}

initInstallUI();

// ============================================================
// Auth — login / logout / session gating
// ============================================================
function showLogin() {
  showScreen('loginScreen');
}

// Shown right after login (or immediately if already standalone+logged in) -
// the attendance form itself is now a secondary view reached via the
// "Time In / Time Out" button or the drawer, not the first thing shown.
function showHome() {
  showScreen('homeScreen');
  document.getElementById('drawerName').textContent = employee ? employee.fullName : '';
  document.getElementById('adminNavItem').style.display = employee && employee.isAdmin ? 'flex' : 'none';

  const nameParts = employee && employee.fullName ? employee.fullName.split(',') : [];
  const lastName = nameParts[0] ? nameParts[0].trim() : '';
  const firstName = nameParts[1] ? nameParts[1].trim().split(' ')[0] : '';
  document.getElementById('homeGreetingName').textContent = firstName ? `Hi, ${firstName}` : 'Hi';
  document.getElementById('homeGreetingDate').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  document.getElementById('homeAvatar').textContent =
    ((firstName[0] || '') + (lastName[0] || '')).toUpperCase() || '🙂';

  loadTodayStatus();
  loadAnnouncements();
}

// Only initializes the attendance form's own data (employee checkbox list,
// server date, location, camera) the first time it's actually opened -
// no reason to pay that cost just for someone browsing Home.
let attendanceFormInitialized = false;
function showAttendanceForm() {
  showScreen('formContainer');
  document.getElementById('submitterEmailGroup').style.display = authActive() ? 'none' : 'block';
  document.getElementById('gpsScopeNote').textContent = authActive()
    ? 'GPS is verified for you (the logged-in submitter) only — not individually for every name checked below.'
    : 'GPS is captured with this submission but not tied to a verified account while login is switched off — not individually for every name checked below.';

  // No verified session (reached via the login screen's Time In/Out
  // shortcut) - show the same Log In / Time In/Out tabs as that screen
  // instead of "Back to Home" (there's no Home to go back to yet), so this
  // reads as the same card continuing rather than a jump to a separate page.
  const hasSession = !!employee;
  document.getElementById('formModeToggle').style.display = hasSession ? 'none' : 'flex';
  document.getElementById('backToHomeBtn').style.display = hasSession ? 'block' : 'none';

  if (!attendanceFormInitialized) {
    attendanceFormInitialized = true;
    initAttendanceForm();
  }
}

document.getElementById('homeTimeInOutBtn').addEventListener('click', showAttendanceForm);
document.getElementById('backToHomeBtn').addEventListener('click', () => {
  if (authActive() && employee) {
    showHome();
  } else {
    noAuthMode = false;
    showLogin(); // no verified session to go back to - just re-show the login screen
  }
});

document.getElementById('loginModeLoginBtn').addEventListener('click', () => {
  noAuthMode = false;
  showLogin();
});
document.getElementById('loginModeNoAuthBtn').addEventListener('click', () => {
  noAuthMode = true;
  showAttendanceForm();
});
document.getElementById('formModeLoginBtn').addEventListener('click', () => {
  noAuthMode = false;
  showLogin();
});
document.getElementById('formModeNoAuthBtn').addEventListener('click', () => {
  noAuthMode = true;
  showAttendanceForm();
});

function logout() {
  token = null;
  employee = null;
  localStorage.removeItem('attendance_token');
  localStorage.removeItem('attendance_employee');
  // Otherwise the next person to log in on this device would see the
  // previous employee's cached attendance/leave calendar until reopening it.
  myRecordsData = null;
  dayRecordMap = null;
  localStorage.removeItem(MY_RECORDS_CACHE_KEY);
  adminAttendanceEntries = null;
  adminDocumentsEmployees = null;
  attendanceFormInitialized = false;
  showLogin();
}

// ============================================================
// Auto-logout after 15 minutes of inactivity - user activity (taps,
// scrolls, typing) resets the clock; a real logged-in session that goes
// quiet for that long gets logged out automatically. Only applies to an
// actual logged-in session (authActive() && employee) - there's no login
// to expire while browsing via the Time In/Out no-auth shortcut.
//
// Tracks the last-activity timestamp in localStorage, not just an
// in-memory timer, so closing/backgrounding the app and reopening it after
// being away 20+ minutes logs out immediately on reopen instead of quietly
// granting a fresh 15 minutes just because the page reloaded.
// ============================================================
const INACTIVITY_LIMIT_MS = 15 * 60 * 1000;
const LAST_ACTIVITY_KEY = 'attendance_last_activity';
let inactivityTimer = null;

function hasActiveSession_() {
  return authActive() && !!employee;
}

function recordActivity_() {
  if (!hasActiveSession_()) return;
  localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
  resetInactivityTimer_();
}

function resetInactivityTimer_() {
  clearTimeout(inactivityTimer);
  if (!hasActiveSession_()) return;
  inactivityTimer = setTimeout(handleInactivityTimeout_, INACTIVITY_LIMIT_MS);
}

function handleInactivityTimeout_() {
  if (!hasActiveSession_()) return;
  logout();
  showToast("You've been logged out after 15 minutes of inactivity.");
}

['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'].forEach((evt) => {
  document.addEventListener(evt, recordActivity_, { passive: true });
});

// Runs once at load - catches a session that was already inactive too long
// before this page load even happened (app backgrounded or fully closed).
// Deferred via setTimeout(..., 0) so it runs after the rest of the script
// finishes its initial top-to-bottom pass: logout() touches state (like
// myRecordsData) declared further down the file, which would still be in
// its temporal dead zone if this ran synchronously from here.
setTimeout(() => {
  if (!hasActiveSession_()) return;
  const lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || 0);
  if (lastActivity && Date.now() - lastActivity > INACTIVITY_LIMIT_MS) {
    logout();
    showToast("You've been logged out after 15 minutes of inactivity.");
  } else {
    recordActivity_();
  }
}, 0);

document.getElementById('loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
  const loginBtn = document.getElementById('loginBtn');
  const statusDiv = document.getElementById('loginStatus');

  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in...';
  statusDiv.style.display = 'none';

  try {
    const result = await apiCall('login', { email, pin });
    if (result.success) {
      token = result.token;
      employee = result.employee;
      localStorage.setItem('attendance_token', token);
      localStorage.setItem('attendance_employee', JSON.stringify(employee));
      document.getElementById('loginPin').value = '';
      if (REQUIRE_LOGIN) {
        showHome();
      } else {
        showAttendanceForm();
      }
    } else {
      statusDiv.className = 'status-message error';
      statusDiv.textContent = result.error || 'Login failed.';
      statusDiv.style.display = 'block';
    }
  } catch (err) {
    statusDiv.className = 'status-message error';
    statusDiv.textContent = 'Could not reach the server: ' + err.message;
    statusDiv.style.display = 'block';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Log In';
  }
});

// ============================================================
// Navigation drawer
// ============================================================
function openDrawer() {
  document.getElementById('navDrawer').classList.add('open');
  document.getElementById('navDrawerBackdrop').style.display = 'block';
}

function closeDrawer() {
  document.getElementById('navDrawer').classList.remove('open');
  document.getElementById('navDrawerBackdrop').style.display = 'none';
}

document.getElementById('hamburgerBtn').addEventListener('click', openDrawer);
document.getElementById('navDrawerBackdrop').addEventListener('click', closeDrawer);

// Shared by every sub-page's topbar (Leave, Daily Time Record, Documents,
// PH Holidays) - one hamburger-opens-drawer / one-tap-back-to-Home pair,
// same as Home's own topbar, so all of these read as peer sections of one
// app rather than one-off popups.
document.querySelectorAll('.page-hamburger-btn').forEach((btn) => {
  btn.addEventListener('click', openDrawer);
});
document.querySelectorAll('.page-back-btn').forEach((btn) => {
  btn.addEventListener('click', showHome);
});
document.getElementById('drawerLogoutBtn').addEventListener('click', () => {
  closeDrawer();
  logout();
});

// "Coming soon" for everything not built yet - keeps the same layout as the
// reference design so each one just needs its click handler swapped out
// for the real feature later, one at a time.
const NAV_COMING_SOON_LABELS = {
  personal: 'Personal Information',
  events: 'Events',
  policies: 'Corporate Policies',
  forms: 'HR Related Forms',
  settings: 'Settings',
};

document.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const nav = btn.dataset.nav;
    closeDrawer();

    if (nav === 'home') {
      showHome();
    } else if (nav === 'leave') {
      openLeavePage();
    } else if (nav === 'records') {
      openRecordsPage();
    } else if (nav === 'documents') {
      openDocumentsPage();
    } else if (nav === 'calendar') {
      openHolidaysPage();
    } else if (nav === 'admin') {
      openAdminPage();
    } else if (NAV_COMING_SOON_LABELS[nav]) {
      showToast(`${NAV_COMING_SOON_LABELS[nav]} isn't built yet — coming soon.`);
    }
  });
});

// Small, self-dismissing notice - used for "coming soon" taps from the
// drawer, which can be opened from Home or from the attendance form, so it
// can't rely on either view's own #statusMessage element being visible.
function showToast(message) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ============================================================
// Home — today's status + announcements
// ============================================================
async function loadTodayStatus() {
  const el = document.getElementById('homeTimeStatus');
  el.className = 'home-time-status';
  el.textContent = "Loading today's status...";

  try {
    const result = await apiCall('getTodayStatus', { token });
    if (result.error) throw new Error(result.error);

    const entries = result.entries || [];
    if (!entries.length) {
      el.className = 'home-time-status not-yet';
      el.textContent = "⏳ You haven't timed in today yet.";
      return;
    }

    const timeIn = entries.find(e => e.purpose === 'Time In');
    const timeOut = entries.slice().reverse().find(e => e.purpose === 'Time Out');
    const formatTime = (ts) => {
      const m = String(ts).match(/(\d{1,2}:\d{2}:\d{2})/);
      return m ? m[1] : ts;
    };

    if (timeOut) {
      el.className = 'home-time-status timed-out';
      el.textContent = `🔵 Timed out at ${formatTime(timeOut.timestamp)} (in at ${timeIn ? formatTime(timeIn.timestamp) : '?'})`;
    } else if (timeIn) {
      el.className = 'home-time-status timed-in';
      el.textContent = `🟢 Timed in at ${formatTime(timeIn.timestamp)}`;
    } else {
      el.className = 'home-time-status not-yet';
      el.textContent = "⏳ You haven't timed in today yet.";
    }
  } catch (err) {
    el.className = 'home-time-status';
    el.textContent = "Could not load today's status.";
  }
}

async function loadAnnouncements() {
  const el = document.getElementById('announcementsList');
  el.innerHTML = '<div class="loading">Loading announcements...</div>';

  try {
    const result = await apiCall('getAnnouncements', { token });
    if (result.error) throw new Error(result.error);

    const announcements = result.announcements || [];
    if (!announcements.length) {
      el.innerHTML = '<div class="no-results">No announcements right now.</div>';
      return;
    }

    el.innerHTML = announcements.map(a => `
      <div class="announcement-card">
        <div class="announcement-title">${a.title}</div>
        <div class="announcement-date">${a.date}</div>
        <div class="announcement-message">${a.message}</div>
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = `<div class="no-results">Could not load announcements.</div>`;
  }
}

// ============================================================
// Admin — read-only Time In/Out + Documents overview for accounts on the
// Admins sheet (employee.isAdmin, set at login). No editing here on
// purpose - see Api.gs.txt's Admin section comment for why.
// ============================================================
let adminAttendanceEntries = null;
let adminDocumentsEmployees = null;

function openAdminPage() {
  showScreen('adminPage');
  if (!document.getElementById('adminAttendanceDate').value) {
    document.getElementById('adminAttendanceDate').value = serverToday || new Date().toISOString().slice(0, 10);
  }
  if (!adminAttendanceEntries) {
    loadAdminAttendance();
  } else {
    renderAdminAttendance();
  }
}

document.getElementById('adminTabAttendanceBtn').addEventListener('click', () => switchAdminTab('attendance'));
document.getElementById('adminTabDocumentsBtn').addEventListener('click', () => switchAdminTab('documents'));

function switchAdminTab(tab) {
  document.getElementById('adminTabAttendanceBtn').classList.toggle('selected', tab === 'attendance');
  document.getElementById('adminTabDocumentsBtn').classList.toggle('selected', tab === 'documents');
  document.getElementById('adminAttendanceTab').style.display = tab === 'attendance' ? 'block' : 'none';
  document.getElementById('adminDocumentsTab').style.display = tab === 'documents' ? 'block' : 'none';

  if (tab === 'documents' && !adminDocumentsEmployees) {
    loadAdminDocumentsOverview();
  }
}

async function loadAdminAttendance() {
  const statusDiv = document.getElementById('adminAttendanceStatus');
  statusDiv.className = 'status-message loading';
  statusDiv.textContent = 'Loading attendance...';
  statusDiv.style.display = 'block';
  document.getElementById('adminAttendanceList').innerHTML = '';

  try {
    const dateIso = document.getElementById('adminAttendanceDate').value;
    const result = await apiCall('adminGetAttendance', { token, data: { date: dateIso } });
    if (result.error) throw new Error(result.error);
    adminAttendanceEntries = result.entries || [];
    statusDiv.style.display = 'none';
    renderAdminAttendance();
  } catch (err) {
    statusDiv.className = 'status-message error';
    statusDiv.textContent = 'Could not load attendance: ' + err.message;
  }
}

function renderAdminAttendance() {
  const el = document.getElementById('adminAttendanceList');
  const filterTerm = document.getElementById('adminAttendanceNameFilter').value.toLowerCase().trim();
  const entries = (adminAttendanceEntries || []).filter(e =>
    !filterTerm || String(e.name || '').toLowerCase().includes(filterTerm)
  );

  if (!entries.length) {
    el.innerHTML = '<div class="no-results">No entries found.</div>';
    return;
  }

  el.innerHTML = entries.map(e => {
    const timeLabel = (String(e.timestamp || '').match(/(\d{1,2}:\d{2}:\d{2})/) || [])[1] || e.timestamp;
    const purposeClass = e.purpose === 'Time In' ? 'admin-purpose-in' : 'admin-purpose-out';
    return `
      <div class="admin-attendance-row">
        <div class="admin-attendance-time">${timeLabel}</div>
        <div class="admin-attendance-info">
          <div class="admin-attendance-name">${e.name}</div>
          <div class="admin-attendance-meta">${e.siteName || ''}${e.agency ? ' · ' + e.agency : ''}</div>
        </div>
        <span class="admin-purpose-badge ${purposeClass}">${e.purpose || ''}</span>
      </div>
    `;
  }).join('');
}

document.getElementById('adminAttendanceSearchBtn').addEventListener('click', loadAdminAttendance);
document.getElementById('adminAttendanceNameFilter').addEventListener('input', renderAdminAttendance);

async function loadAdminDocumentsOverview() {
  const statusDiv = document.getElementById('adminDocumentsStatus');
  statusDiv.className = 'status-message loading';
  statusDiv.textContent = 'Loading documents overview...';
  statusDiv.style.display = 'block';
  document.getElementById('adminDocumentsOverviewList').innerHTML = '';

  try {
    const result = await apiCall('adminGetDocumentsOverview', { token });
    if (result.error) throw new Error(result.error);
    adminDocumentsEmployees = result.employees || [];
    statusDiv.style.display = 'none';
    renderAdminDocumentsOverview();
  } catch (err) {
    statusDiv.className = 'status-message error';
    statusDiv.textContent = 'Could not load documents overview: ' + err.message;
  }
}

function renderAdminDocumentsOverview() {
  const el = document.getElementById('adminDocumentsOverviewList');
  const filterTerm = document.getElementById('adminDocumentsFilter').value.toLowerCase().trim();
  const employees = (adminDocumentsEmployees || []).filter(emp =>
    !filterTerm || String(emp.fullName || '').toLowerCase().includes(filterTerm)
  );

  if (!employees.length) {
    el.innerHTML = '<div class="no-results">No employees found.</div>';
    return;
  }

  el.innerHTML = employees.map(emp => `
    <div class="admin-doc-row">
      <div class="admin-doc-name">${emp.fullName}</div>
      <div class="admin-doc-badges">
        ${emp.documents.map(d => d.uploaded
          ? `<a href="${d.link}" target="_blank" rel="noopener" class="admin-doc-badge admin-doc-uploaded">${d.type} ✓</a>`
          : `<span class="admin-doc-badge admin-doc-missing">${d.type} ✕</span>`
        ).join('')}
      </div>
    </div>
  `).join('');
}

document.getElementById('adminDocumentsFilter').addEventListener('input', renderAdminDocumentsOverview);

// ============================================================
// Leave Application — submits into the existing, separate Leave
// Application system's own spreadsheet via a new API action; that
// system's own approval workflow/tracking page/deployment are untouched.
// Name/Position/Agency/Remaining Leave come straight from the verified
// login session, not re-entered.
// ============================================================
function isInstallerPosition(position) {
  const p = (position || '').toString().trim().toLowerCase();
  return p === 'installer' || p.includes('electrician');
}

function openLeavePage() {
  showScreen('leavePage');
  document.getElementById('leaveName').value = employee.fullName || '';
  document.getElementById('leaveAgency').value = employee.agency || '';

  // Position isn't shown - the installer-only fields below are still
  // driven automatically from employee.role, just never displayed as a field.
  const isInstaller = isInstallerPosition(employee.role);
  document.getElementById('leaveProjectGroup').style.display = isInstaller ? 'block' : 'none';
  document.getElementById('leaveEngineerGroup').style.display = isInstaller ? 'block' : 'none';
  document.getElementById('leaveProject').required = isInstaller;
  document.getElementById('leaveEngineer').required = isInstaller;

  document.getElementById('leaveStatus').style.display = 'none';
}

// ============================================================
// Documents — employees upload their own SSS/Pag-IBIG/PhilHealth/TIN once
// each; stored in a dedicated Documents spreadsheet + Drive folder, kept
// entirely separate from every other system this app touches. One-time
// only by design - the backend refuses a second upload for a type that
// already has a link on file (contact HR directly to replace one).
// ============================================================
const DOCUMENT_TYPES = ['SSS', 'Pag-IBIG', 'PhilHealth', 'TIN'];
let pendingUploadType = null;

function openDocumentsPage() {
  showScreen('documentsPage');
  document.getElementById('documentsStatus').style.display = 'none';
  loadMyDocuments();
}

async function loadMyDocuments() {
  const el = document.getElementById('documentsList');
  el.innerHTML = '<div class="loading">Loading documents...</div>';

  try {
    const result = await apiCall('getMyDocuments', { token });
    if (result.error) throw new Error(result.error);

    const documents = result.documents || DOCUMENT_TYPES.map(type => ({ type, uploaded: false }));
    el.innerHTML = documents.map(doc => `
      <div class="document-row">
        <div class="document-info">
          <div class="document-type">${doc.type}</div>
          ${doc.uploaded
            ? `<div class="document-uploaded">✅ Submitted${doc.uploadedAt ? ' on ' + doc.uploadedAt : ''}</div>`
            : `<div class="document-pending">Not submitted yet</div>`}
        </div>
        ${doc.uploaded
          ? `<span class="document-locked">Locked</span>`
          : `<button type="button" class="control-btn document-upload-btn" data-doc-type="${doc.type}">Upload</button>`}
      </div>
    `).join('');

    document.querySelectorAll('.document-upload-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingUploadType = btn.dataset.docType;
        document.getElementById('documentFileInput').click();
      });
    });
  } catch (err) {
    el.innerHTML = `<div class="no-results">Could not load documents: ${err.message}</div>`;
  }
}

document.getElementById('documentFileInput').addEventListener('change', async function () {
  const file = this.files[0];
  this.value = ''; // allow re-selecting the same file later if this attempt fails
  if (!file || !pendingUploadType) return;

  const statusDiv = document.getElementById('documentsStatus');
  statusDiv.className = 'status-message loading';
  statusDiv.textContent = `Uploading ${pendingUploadType}...`;
  statusDiv.style.display = 'block';

  try {
    const fileData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.readAsDataURL(file);
    });

    const result = await apiCall('uploadDocument', {
      token,
      data: { docType: pendingUploadType, fileData, fileName: file.name, fileType: file.type },
    });

    if (!result.success) throw new Error(result.error || 'Upload failed.');

    statusDiv.className = 'status-message success';
    statusDiv.textContent = `${pendingUploadType} submitted successfully.`;
    loadMyDocuments();
  } catch (err) {
    statusDiv.className = 'status-message error';
    statusDiv.textContent = err.message;
  } finally {
    pendingUploadType = null;
  }
});

// ============================================================
// Philippine Holidays — month-grid calendar (same look as the Daily Time
// Record calendar), browsed client-side after one fetch. The underlying
// sheet is editable directly (same pattern as Announcements), not through
// any in-app admin UI. A grid cell can't fit a holiday's name, so the list
// below the grid shows the names for whichever month is currently in view.
// ============================================================
let holidaysData = null; // [{date, name, type, notes}, ...] - cached after first fetch
let holidayDateMap = null; // Map<'yyyy-MM-dd', {name, type, notes}>
// Own Date() rather than reusing the shared `today` const below - that one
// isn't declared until the My Records section further down the file, and
// this runs at module load time, before it would exist yet.
const holidayCalendarToday = new Date();
let holidayCalendarYear = holidayCalendarToday.getFullYear();
let holidayCalendarMonth = holidayCalendarToday.getMonth(); // 0-indexed

function renderHolidayCalendar() {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  document.getElementById('holidayCalendarMonthLabel').textContent = `${monthNames[holidayCalendarMonth]} ${holidayCalendarYear}`;

  const firstWeekday = new Date(holidayCalendarYear, holidayCalendarMonth, 1).getDay();
  const daysInMonth = new Date(holidayCalendarYear, holidayCalendarMonth + 1, 0).getDate();
  const todayKey = toDateKey(holidayCalendarToday.getFullYear(), holidayCalendarToday.getMonth(), holidayCalendarToday.getDate());

  const grid = document.getElementById('holidayCalendarGrid');
  grid.innerHTML = '';

  for (let i = 0; i < firstWeekday; i++) {
    grid.appendChild(Object.assign(document.createElement('div'), { className: 'calendar-day empty' }));
  }

  const monthHolidays = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const key = toDateKey(holidayCalendarYear, holidayCalendarMonth, day);
    const cell = document.createElement('div');
    cell.className = 'calendar-day';
    cell.textContent = day;

    const holiday = holidayDateMap.get(key);
    if (holiday) {
      const isRegular = holiday.type === 'Regular Holiday';
      cell.classList.add(isRegular ? 'holiday-regular' : 'holiday-special');
      cell.title = holiday.name;
      monthHolidays.push(Object.assign({ date: key }, holiday));
    }

    if (key === todayKey) cell.classList.add('today');
    grid.appendChild(cell);
  }

  const listEl = document.getElementById('holidayMonthList');
  if (!monthHolidays.length) {
    listEl.innerHTML = '<div class="no-results">No holidays this month.</div>';
    return;
  }
  listEl.innerHTML = monthHolidays.map(h => {
    const dateObj = new Date(h.date + 'T00:00:00');
    const dayLabel = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const typeClass = h.type === 'Regular Holiday' ? 'holiday-regular' : 'holiday-special';
    return `
      <div class="holiday-row">
        <div class="holiday-date">${dayLabel}</div>
        <div class="holiday-info">
          <div class="holiday-name">${h.name}</div>
          ${h.type ? `<span class="holiday-type ${typeClass}">${h.type}</span>` : ''}
          ${h.notes ? `<div class="holiday-notes">${h.notes}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function changeHolidayCalendarMonth(delta) {
  holidayCalendarMonth += delta;
  if (holidayCalendarMonth < 0) { holidayCalendarMonth = 11; holidayCalendarYear--; }
  else if (holidayCalendarMonth > 11) { holidayCalendarMonth = 0; holidayCalendarYear++; }
  renderHolidayCalendar();
}

async function openHolidaysPage() {
  showScreen('holidaysPage');
  document.getElementById('holidaysStatus').style.display = 'none';

  if (!holidaysData) {
    const statusDiv = document.getElementById('holidaysStatus');
    statusDiv.className = 'status-message loading';
    statusDiv.textContent = 'Loading holidays...';
    statusDiv.style.display = 'block';

    try {
      const result = await apiCall('getHolidays', { token });
      if (result.error) throw new Error(result.error);
      holidaysData = result.holidays || [];
      holidayDateMap = new Map(holidaysData.map(h => [h.date, h]));
      statusDiv.style.display = 'none';
      renderHolidayCalendar();
    } catch (err) {
      statusDiv.className = 'status-message error';
      statusDiv.textContent = 'Could not load holidays: ' + err.message;
      statusDiv.style.display = 'block';
    }
  } else {
    renderHolidayCalendar();
  }
}

document.getElementById('holidayCalendarPrevBtn').addEventListener('click', () => changeHolidayCalendarMonth(-1));
document.getElementById('holidayCalendarNextBtn').addEventListener('click', () => changeHolidayCalendarMonth(1));

document.getElementById('leaveForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  const startDate = document.getElementById('leaveStartDate').value;
  const endDate = document.getElementById('leaveEndDate').value;
  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    const statusDiv = document.getElementById('leaveStatus');
    statusDiv.className = 'status-message error';
    statusDiv.textContent = 'Start date cannot be after end date.';
    statusDiv.style.display = 'block';
    return;
  }

  const submitBtn = document.getElementById('leaveSubmitBtn');
  const statusDiv = document.getElementById('leaveStatus');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';
  statusDiv.style.display = 'none';

  const data = {
    leaveType: document.getElementById('leaveType').value,
    startDate,
    endDate,
    reason: document.getElementById('leaveReason').value,
    projectName: document.getElementById('leaveProject').value,
    engineerInCharge: document.getElementById('leaveEngineer').value,
  };

  try {
    const result = await apiCall('submitLeaveApplication', { token, data });
    if (result.success) {
      statusDiv.className = 'status-message success';
      statusDiv.textContent = result.message || 'Leave application submitted successfully!';
      statusDiv.style.display = 'block';
      document.getElementById('leaveForm').reset();
      document.getElementById('leaveProjectGroup').style.display = 'none';
      document.getElementById('leaveEngineerGroup').style.display = 'none';
      setTimeout(showHome, 2000);
    } else {
      statusDiv.className = 'status-message error';
      statusDiv.textContent = result.error || 'Submission failed.';
      statusDiv.style.display = 'block';
    }
  } catch (err) {
    statusDiv.className = 'status-message error';
    statusDiv.textContent = 'Could not reach the server: ' + err.message;
    statusDiv.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Leave Application';
  }
});

// ============================================================
// My Records — a read-only calendar sourced from the "Attendance Tracking
// 2026" sheet, HR's own authoritative per-employee-per-day record (one row
// per day, with Status already computed as Present/Absent/Leave/Rest/etc.)
// - fetched once via getMyRecords, then browsed month-to-month entirely
// client-side, no re-fetch per month.
// ============================================================
let myRecordsData = null; // { days: [{date, status, timeIn, timeOut}, ...] } - cached in-memory after first fetch this session

// "Attendance Tracking 2026" is a full-year, one-row-per-employee-per-day
// sheet - apiGetMyRecords has to scan the whole thing to find this
// employee's rows scattered through it, which only gets more expensive as
// the year goes on. That sheet is itself only synced on a periodic batch
// delay (not instant), so a 2-hour-old copy is very unlikely to be stale in
// a way that matters - persisting it means reopening the app later the
// same day skips that expensive scan entirely instead of redoing it.
const MY_RECORDS_CACHE_KEY = 'attendance_my_records_cache';
const MY_RECORDS_CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function loadMyRecordsCache_() {
  try {
    const cached = JSON.parse(localStorage.getItem(MY_RECORDS_CACHE_KEY) || 'null');
    if (!cached || cached.employeeId !== (employee && employee.employeeId)) return null;
    if (Date.now() - cached.fetchedAt > MY_RECORDS_CACHE_MAX_AGE_MS) return null;
    return cached.days;
  } catch (e) {
    return null;
  }
}

function saveMyRecordsCache_(days) {
  try {
    localStorage.setItem(MY_RECORDS_CACHE_KEY, JSON.stringify({
      employeeId: employee && employee.employeeId,
      fetchedAt: Date.now(),
      days,
    }));
  } catch (e) { /* storage full/unavailable - not worth failing the page over */ }
}

let dayRecordMap = null; // Map<'yyyy-MM-dd', {status, timeIn, timeOut}>
const today = new Date();
let calendarYear = today.getFullYear();
let calendarMonth = today.getMonth(); // 0-indexed

function toDateKey(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function renderCalendar() {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  document.getElementById('calendarMonthLabel').textContent = `${monthNames[calendarMonth]} ${calendarYear}`;

  const firstWeekday = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const todayKey = toDateKey(today.getFullYear(), today.getMonth(), today.getDate());

  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  for (let i = 0; i < firstWeekday; i++) {
    grid.appendChild(Object.assign(document.createElement('div'), { className: 'calendar-day empty' }));
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const key = toDateKey(calendarYear, calendarMonth, day);
    const cell = document.createElement('div');
    cell.className = 'calendar-day';
    cell.textContent = day;

    const record = dayRecordMap.get(key);
    if (record) {
      const status = (record.status || '').toLowerCase();
      if (status === 'present') {
        cell.classList.add('present');
        cell.title = record.timeIn ? `Present (${record.timeIn} - ${record.timeOut || '...'})` : 'Present';
      } else if (status === 'leave') {
        cell.classList.add('leave');
        cell.title = 'On Leave';
      } else if (status === 'absent') {
        cell.classList.add('absent');
        cell.title = 'Absent';
      } else if (status === 'rest') {
        cell.classList.add('rest');
        cell.title = 'Rest Day';
      }
      // "Resign" / "Resign this month" and anything else - left unmarked,
      // not directly actionable for the employee viewing their own calendar.
    }

    if (key === todayKey) cell.classList.add('today');
    grid.appendChild(cell);
  }
}

function changeCalendarMonth(delta) {
  calendarMonth += delta;
  if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
  else if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
  renderCalendar();
}

async function openRecordsPage() {
  showScreen('recordsPage');
  document.getElementById('recordsStatus').style.display = 'none';

  if (!myRecordsData) {
    const cachedDays = loadMyRecordsCache_();
    if (cachedDays) {
      myRecordsData = { days: cachedDays };
      dayRecordMap = new Map(cachedDays.map(d => [d.date, d]));
      renderCalendar();
      return; // instant from cache - refetches once the cache ages past MY_RECORDS_CACHE_MAX_AGE_MS
    }

    const statusDiv = document.getElementById('recordsStatus');
    statusDiv.className = 'status-message loading';
    statusDiv.textContent = 'Loading your records...';
    statusDiv.style.display = 'block';

    try {
      const result = await apiCall('getMyRecords', { token });
      if (result.error) throw new Error(result.error);
      myRecordsData = result;
      dayRecordMap = new Map((result.days || []).map(d => [d.date, d]));
      saveMyRecordsCache_(result.days || []);
      statusDiv.style.display = 'none';
      renderCalendar();
    } catch (err) {
      statusDiv.className = 'status-message error';
      statusDiv.textContent = 'Could not load your records: ' + err.message;
      statusDiv.style.display = 'block';
    }
  } else {
    renderCalendar();
  }
}

document.getElementById('calendarPrevBtn').addEventListener('click', () => changeCalendarMonth(-1));
document.getElementById('calendarNextBtn').addEventListener('click', () => changeCalendarMonth(1));

// ============================================================
// Location — mandatory for submission in the app (unlike the old form,
// which allowed a silent skip). Still requested early so it's usually
// already resolved by the time the user hits Submit.
// ============================================================
function tryGetLocation() {
  if (!navigator.geolocation) {
    console.log('Geolocation not supported by this browser.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    function (position) {
      currentPosition = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      document.getElementById('locationNotice').style.display = 'none';
    },
    function (error) {
      console.log('Location unavailable:', error.message);
      document.getElementById('locationNotice').style.display = 'block';
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
  );
}

// ============================================================
// Camera — in-app capture with a server-synced timestamp burned directly
// into the photo's pixels, so it can't be faked by picking an old photo
// from the gallery or by changing the phone's clock: the overlay text is
// computed from the Apps Script server's clock (fetched once per camera
// session via getServerTime), not the device's.
// ============================================================
let cameraStream = null;
let capturedImageDataUrl = null;
let serverTimeOffsetMs = 0; // serverTime - Date.now(), refreshed each time the camera opens
let clockIntervalId = null;
let currentFacingMode = 'user'; // 'user' = front/selfie (default), 'environment' = back camera

async function syncServerTime() {
  try {
    const result = await apiCall('getServerTime', { token });
    if (result && result.iso) {
      serverTimeOffsetMs = new Date(result.iso).getTime() - Date.now();
    }
  } catch (e) {
    console.log('Could not sync server time, falling back to device clock:', e.message);
    serverTimeOffsetMs = 0;
  }
}

function syncedNow() {
  return new Date(Date.now() + serverTimeOffsetMs);
}

function formatTimestampText(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }) + ' PHT';
}

// Watermarks every captured/fallback-uploaded photo alongside the
// timestamp. Loading is async, so callers must await watermarkLogoReady
// before drawing; if it fails to load for any reason, capture still
// proceeds without it rather than breaking submission.
//
// Not started until initAttendanceForm() actually runs (first time the
// attendance form opens), not on script load - this 91KB image has no
// reason to download for someone who only ever looks at Home/Leave/etc.
// this session. Still "usually already resolved well before someone taps
// the shutter" per the comment at its await sites, since form init happens
// well before the camera does.
const watermarkLogo = new Image();
let watermarkLogoLoaded = false;
let watermarkLogoReady = new Promise((resolve) => {
  watermarkLogo.onload = () => { watermarkLogoLoaded = true; resolve(true); };
  watermarkLogo.onerror = () => resolve(false);
});
function startWatermarkLogoLoad() {
  if (watermarkLogo.src) return; // already started
  watermarkLogo.src = 'watermark-logo.png';
}

function drawTimestampOverlay(ctx, width, height, text) {
  const bannerHeight = Math.max(36, Math.round(height * 0.07));
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, height - bannerHeight, width, bannerHeight);

  let textX = 14;

  if (watermarkLogoLoaded) {
    const logoMargin = Math.round(bannerHeight * 0.15);
    const logoHeight = bannerHeight - logoMargin * 2;
    const logoWidth = logoHeight * (watermarkLogo.naturalWidth / watermarkLogo.naturalHeight);
    ctx.drawImage(watermarkLogo, 10, height - bannerHeight + logoMargin, logoWidth, logoHeight);
    textX = 10 + logoWidth + 12;
  }

  const fontSize = Math.max(14, Math.round(bannerHeight * 0.42));
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, textX, height - bannerHeight / 2);
}

// facingMode 'ideal' hints are honored inconsistently across real phones
// (iOS Safari especially) - once a specific camera has been granted, asking
// for the opposite facingMode again often just re-selects the same device,
// which looks like the flip button "does nothing". Explicit deviceId
// selection is far more reliable, so devices are enumerated once permission
// is granted and the flip button cycles through them by id.
let videoDeviceIds = [];
let currentDeviceIndex = 0;

async function refreshVideoDeviceList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDeviceIds = devices.filter(d => d.kind === 'videoinput' && d.deviceId).map(d => d.deviceId);
  } catch (e) {
    videoDeviceIds = [];
  }
  // Nothing to flip to on a single-camera device - hide the button instead
  // of leaving one that does nothing.
  document.getElementById('cameraFlipBtn').style.display = videoDeviceIds.length > 1 ? 'flex' : 'none';
}

async function startVideoStream(constraints) {
  cameraStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  const video = document.getElementById('cameraVideo');
  video.srcObject = cameraStream;
  try {
    await video.play(); // some browsers (iOS Safari) don't auto-resume on a srcObject swap
  } catch (e) { /* ignore - the autoplay attribute usually covers this anyway */ }
  updateMirrorState();
}

// Mirrors the front-camera preview so it feels like looking in a mirror
// (what everyone expects from a selfie camera) - the back camera is never
// mirrored. This only affects the live <video> preview via CSS; the actual
// captured frame is drawn from the raw, unmirrored video source, so the
// saved attendance photo is always true-to-camera regardless of preview.
function updateMirrorState() {
  const track = cameraStream?.getVideoTracks()[0];
  const settings = track?.getSettings();
  let isFront;

  if (settings?.facingMode) {
    // Authoritative when the browser actually reports it.
    isFront = settings.facingMode === 'user';
  } else {
    // facingMode isn't reported on some devices/browsers, and the
    // facingMode *constraint* we requested with is only an "ideal" hint -
    // the browser is free to ignore it and open whichever camera it wants,
    // so trusting our own requested value here would risk mirroring a back
    // camera that got opened despite asking for the front one. The device
    // label (available once permission is granted) is a more reliable
    // real-world signal than the constraint we sent.
    const label = (track?.label || '').toLowerCase();
    if (/front|user|face/.test(label)) isFront = true;
    else if (/back|rear|environment/.test(label)) isFront = false;
    else isFront = false; // unknown - default to NOT mirroring, safer than mirroring a back camera by mistake
  }

  document.getElementById('cameraVideo').classList.toggle('mirrored', isFront);
}

async function openCamera() {
  document.getElementById('cameraError').style.display = 'none';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    useFallbackUpload();
    return;
  }

  try {
    // First open: no device list yet (enumerateDevices needs a prior
    // permission grant to return usable ids), so start with a facingMode hint.
    await startVideoStream({ facingMode: { ideal: currentFacingMode } });
  } catch (err) {
    console.log('Camera unavailable, falling back to file upload:', err.message);
    useFallbackUpload();
    return;
  }

  // Show the preview the moment the stream is ready - don't make the user
  // stare at a blank screen while device enumeration and the server-time
  // round trip finish. The clock overlay starts ticking on local time
  // immediately and silently corrects itself once syncServerTime resolves
  // (it reads serverTimeOffsetMs fresh on every tick).
  document.getElementById('cameraModal').style.display = 'flex';

  const updateClock = () => {
    document.getElementById('cameraClockOverlay').textContent = formatTimestampText(syncedNow());
  };
  updateClock();
  clockIntervalId = setInterval(updateClock, 1000);

  refreshVideoDeviceList().then(() => {
    const activeDeviceId = cameraStream?.getVideoTracks()[0]?.getSettings().deviceId;
    const matchedIndex = videoDeviceIds.indexOf(activeDeviceId);
    currentDeviceIndex = matchedIndex !== -1 ? matchedIndex : 0;
  });
  syncServerTime();
}

// Cycles to the next known camera device. Restarts the stream on the same
// open modal - the clock overlay keeps ticking throughout.
let isFlipping = false; // guards against a second tap racing the first mid-switch

async function flipCamera() {
  if (videoDeviceIds.length < 2 || isFlipping) return;
  isFlipping = true;

  const flipBtn = document.getElementById('cameraFlipBtn');
  flipBtn.disabled = true;
  flipBtn.classList.add('flipping');

  const previousIndex = currentDeviceIndex;
  currentDeviceIndex = (currentDeviceIndex + 1) % videoDeviceIds.length;

  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }

  // Stopping a track doesn't guarantee the OS has released the camera
  // hardware yet - re-requesting it too quickly is a common cause of
  // intermittent NotReadableError on Android. A short pause fixes most of
  // that at the cost of a bit of the lag being felt here rather than hidden.
  await new Promise(r => setTimeout(r, 250));

  try {
    await startVideoStream({ deviceId: { exact: videoDeviceIds[currentDeviceIndex] } });
  } catch (err) {
    console.log('Could not switch camera, reverting:', err.message);
    currentDeviceIndex = previousIndex;
    await new Promise(r => setTimeout(r, 250));
    try {
      await startVideoStream({ deviceId: { exact: videoDeviceIds[currentDeviceIndex] } }); // restore, so the preview isn't left dead
      document.getElementById('cameraError').textContent = "Couldn't switch cameras — staying on this one.";
      document.getElementById('cameraError').style.display = 'block';
      setTimeout(() => { document.getElementById('cameraError').style.display = 'none'; }, 2500);
    } catch (e2) {
      document.getElementById('cameraError').textContent = 'Could not access the camera.';
      document.getElementById('cameraError').style.display = 'block';
    }
  } finally {
    isFlipping = false;
    flipBtn.disabled = false;
    flipBtn.classList.remove('flipping');
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  if (clockIntervalId) {
    clearInterval(clockIntervalId);
    clockIntervalId = null;
  }
  document.getElementById('cameraModal').style.display = 'none';
}

function useFallbackUpload() {
  stopCamera();
  document.getElementById('attendanceImageFallback').click();
}

function showPhotoPreview() {
  document.getElementById('photoPreview').src = capturedImageDataUrl;
  document.getElementById('photoPreviewWrap').style.display = 'block';
  document.getElementById('openCameraBtn').style.display = 'none';
  document.getElementById('photoError').style.display = 'none';
}

function resetPhoto() {
  capturedImageDataUrl = null;
  document.getElementById('photoPreviewWrap').style.display = 'none';
  document.getElementById('openCameraBtn').style.display = 'block';
}

function validatePhoto() {
  if (!capturedImageDataUrl) {
    document.getElementById('photoError').style.display = 'block';
    return false;
  }
  return true;
}

document.getElementById('openCameraBtn').addEventListener('click', openCamera);
document.getElementById('cameraCancelBtn').addEventListener('click', stopCamera);
document.getElementById('cameraFlipBtn').addEventListener('click', flipCamera);
document.getElementById('retakePhotoBtn').addEventListener('click', () => {
  resetPhoto();
  openCamera();
});

// Caps the longest edge so uploads stay small and fast. Full-resolution
// phone photos are several MB as base64, and that slow upload is exactly
// what can make submissions time out ("Load failed") on weak mobile signal
// - the row can still save server-side, but the confirmation never makes
// it back. 1600px keeps the person/timestamp/watermark clearly legible.
// (Same setting already shipped on production for this exact reason.)
const MAX_PHOTO_EDGE = 1600;
const PHOTO_JPEG_QUALITY = 0.8;
function scaledPhotoDimensions(srcW, srcH) {
  const longest = Math.max(srcW, srcH);
  if (longest <= MAX_PHOTO_EDGE) return { width: srcW, height: srcH };
  const scale = MAX_PHOTO_EDGE / longest;
  return { width: Math.round(srcW * scale), height: Math.round(srcH * scale) };
}

document.getElementById('cameraShutterBtn').addEventListener('click', async () => {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('captureCanvas');
  const { width: w, height: h } = scaledPhotoDimensions(video.videoWidth, video.videoHeight);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  await watermarkLogoReady; // usually already resolved well before someone taps the shutter
  drawTimestampOverlay(ctx, w, h, formatTimestampText(syncedNow()));

  capturedImageDataUrl = canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
  stopCamera();
  showPhotoPreview();
});

// Fallback path (camera unavailable/denied) - still burns the same
// server-synced timestamp overlay onto whatever photo gets picked, so the
// result is consistent no matter which path was used.
document.getElementById('attendanceImageFallback').addEventListener('change', async function () {
  const file = this.files && this.files[0];
  this.value = ''; // allow picking the same file again later
  if (!file) return;

  await syncServerTime();

  const img = new Image();
  const reader = new FileReader();
  reader.onload = () => {
    img.onload = async () => {
      const canvas = document.getElementById('captureCanvas');
      const { width, height } = scaledPhotoDimensions(img.naturalWidth, img.naturalHeight);
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      await watermarkLogoReady;
      drawTimestampOverlay(ctx, width, height, formatTimestampText(syncedNow()));
      capturedImageDataUrl = canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
      showPhotoPreview();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// ============================================================
// Attendance form — ported from the original app, google.script.run swapped
// for apiCall(), email field removed (server derives it from the session).
// ============================================================
const EMPLOYEE_CACHE_KEY = 'attendance_employees_cache';

function renderEmployeeList(employees) {
  allEmployees = employees;
  employeeData = employees;
  generateCheckboxes(employees);
  document.getElementById('loadingNames').style.display = 'none';
  document.getElementById('nameCheckboxes').style.display = 'grid';
  setupNameCheckboxHandlers();
  setupSearchFunctionality();
  setupAgencyFilter();
}

function loadEmployeeData() {
  // Show the cached roster instantly if we have one - it changes rarely, so
  // this avoids blocking the form on a cold Apps Script round-trip every
  // time it opens. A fresh copy is still fetched below and swapped in when
  // it lands. (Same pattern already shipped on production.)
  let hadCache = false;
  try {
    const cached = JSON.parse(localStorage.getItem(EMPLOYEE_CACHE_KEY) || 'null');
    if (Array.isArray(cached) && cached.length) {
      renderEmployeeList(cached);
      hadCache = true;
    }
  } catch (e) { /* ignore a malformed cache and just fetch fresh */ }

  if (!hadCache) {
    document.getElementById('loadingNames').style.display = 'block';
    document.getElementById('nameCheckboxes').style.display = 'none';
  }

  apiCall('getEmployeeData', { token })
    .then(function (employees) {
      if (employees && employees.error) throw new Error(employees.error);
      if (!Array.isArray(employees)) throw new Error('Unexpected employee data.');
      localStorage.setItem(EMPLOYEE_CACHE_KEY, JSON.stringify(employees));
      renderEmployeeList(employees);
    })
    .catch(function (error) {
      if (hadCache) return; // keep the cached list showing; a background refresh failing isn't worth alarming anyone
      showMessage('Error loading employee data: ' + error.message, 'error');
      document.getElementById('loadingNames').innerHTML = 'Error loading employees. Please refresh the page.';
    });
}

function generateCheckboxes(employees) {
  const container = document.getElementById('nameCheckboxes');
  container.innerHTML = '';

  employees.forEach(employee => {
    const checkboxItem = document.createElement('div');
    checkboxItem.className = 'checkbox-item';

    const checkboxId = 'name_' + employee.fullName.replace(/[^a-zA-Z0-9]/g, '');

    checkboxItem.innerHTML = `
        <input type="checkbox" id="${checkboxId}" name="names" value="${employee.fullName}" data-form-name="${employee.formName}" data-agency="${employee.agency}">
        <label for="${checkboxId}" class="checkbox-label">${employee.fullName}</label>
    `;

    container.appendChild(checkboxItem);
  });
}

function setupAgencyFilter() {
  const buttons = document.querySelectorAll('.agency-btn');
  const hiddenInput = document.getElementById('agency');

  buttons.forEach(btn => {
    btn.addEventListener('click', function () {
      buttons.forEach(b => b.classList.remove('selected'));
      this.classList.add('selected');
      hiddenInput.value = this.dataset.value;
      document.getElementById('agencyError').style.display = 'none';
      filterEmployeesByAgency(this.dataset.value);
    });
  });
}

function filterEmployeesByAgency(selectedAgency) {
  if (!selectedAgency) {
    employeeData = allEmployees;
  } else {
    employeeData = allEmployees.filter(employee => employee.agency === selectedAgency);
  }

  generateCheckboxes(employeeData);
  setupNameCheckboxHandlers();

  const searchInput = document.getElementById('nameSearch');
  searchInput.value = '';
  resetSearchResults();

  if (employeeData.length === 0 && selectedAgency) {
    showEmployeesMessage('No employees found for the selected agency.');
  } else {
    hideEmployeesMessage();
  }
}

function showEmployeesMessage(message) {
  const container = document.getElementById('nameCheckboxes');
  container.innerHTML = `<div class="no-results" style="display: block; grid-column: 1 / -1;">${message}</div>`;
}

function hideEmployeesMessage() {
  const noResultsElement = document.querySelector('#nameCheckboxes .no-results');
  if (noResultsElement) {
    noResultsElement.remove();
  }
}

function resetSearchResults() {
  const checkboxItems = document.querySelectorAll('.checkbox-item');
  const noResults = document.getElementById('noResults');

  checkboxItems.forEach(item => {
    item.classList.remove('hidden');
    item.style.display = 'flex';
  });
  noResults.style.display = 'none';
}

function setDefaultDate() {
  const dateInput = document.getElementById('deploymentDate');

  apiCall('getServerDate', { token })
    .then(function (serverDate) {
      if (serverDate && serverDate.error) throw new Error(serverDate.error);
      serverToday = serverDate;
      dateInput.value = serverDate;

      dateInput.addEventListener('change', function () {
        const existing = document.getElementById('dateWarning');
        if (this.value !== serverToday) {
          if (!existing) {
            const warning = document.createElement('small');
            warning.id = 'dateWarning';
            warning.style.color = '#e67e22';
            warning.style.display = 'block';
            warning.style.marginTop = '5px';
            warning.textContent = '⚠ You changed the date from today. Please make sure this is correct before submitting.';
            dateInput.insertAdjacentElement('afterend', warning);
          }
        } else if (existing) {
          existing.remove();
        }
      });
    })
    .catch(function () {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      dateInput.value = `${year}-${month}-${day}`;
    });
}

function setupPurposeToggle() {
  const buttons = document.querySelectorAll('.purpose-btn:not(.agency-btn)');
  const hiddenInput = document.getElementById('purpose');

  buttons.forEach(btn => {
    btn.addEventListener('click', function () {
      buttons.forEach(b => b.classList.remove('selected'));
      this.classList.add('selected');
      hiddenInput.value = this.dataset.value;
      document.getElementById('purposeError').style.display = 'none';
    });
  });
}

function setupSiteSearch() {
  const searchInput = document.getElementById('siteSearch');
  const clearBtn = document.getElementById('clearSiteSearch');
  const select = document.getElementById('siteName');
  const allOptions = Array.from(select.options);

  searchInput.addEventListener('input', function () {
    const term = this.value.toLowerCase().trim();
    allOptions.forEach(opt => {
      if (opt.value === '') return;
      opt.hidden = term !== '' && !opt.text.toLowerCase().includes(term);
    });
    const visible = allOptions.filter(o => o.value !== '' && !o.hidden);
    if (visible.length === 1) {
      select.value = visible[0].value;
      searchInput.value = visible[0].text;
    }
  });

  select.addEventListener('change', function () {
    searchInput.value = this.value ? this.options[this.selectedIndex].text : '';
  });

  clearBtn.addEventListener('click', function () {
    searchInput.value = '';
    allOptions.forEach(opt => (opt.hidden = false));
    select.value = '';
  });
}

function setupNameCheckboxHandlers() {
  document.getElementById('clearAllNames').addEventListener('click', function () {
    document.querySelectorAll('input[name="names"]').forEach(cb => (cb.checked = false));
  });

  document.querySelectorAll('input[name="names"]').forEach(checkbox => {
    checkbox.addEventListener('change', hideNameError);
  });
}

function setupSearchFunctionality() {
  const searchInput = document.getElementById('nameSearch');
  const noResults = document.getElementById('noResults');

  searchInput.addEventListener('input', function () {
    const searchTerm = this.value.toLowerCase().trim();
    const checkboxItems = document.querySelectorAll('.checkbox-item');
    let visibleCount = 0;

    checkboxItems.forEach(item => {
      const label = item.querySelector('.checkbox-label');
      const name = label.textContent.toLowerCase();

      if (searchTerm === '' || name.includes(searchTerm)) {
        item.classList.remove('hidden');
        item.style.display = 'flex';
        visibleCount++;
      } else {
        item.classList.add('hidden');
        item.style.display = 'none';
      }
    });

    noResults.style.display = visibleCount === 0 && searchTerm !== '' ? 'block' : 'none';
  });

  document.getElementById('clearAllNames').addEventListener('click', function () {
    searchInput.value = '';
    resetSearchResults();
  });
}

function hideNameError() {
  document.getElementById('nameError').style.display = 'none';
}

function validateNames() {
  const checkboxes = document.querySelectorAll('input[name="names"]:checked');
  if (checkboxes.length === 0) {
    document.getElementById('nameError').style.display = 'block';
    return false;
  }
  return true;
}

function validatePurpose() {
  if (!document.getElementById('purpose').value) {
    document.getElementById('purposeError').style.display = 'block';
    return false;
  }
  return true;
}

function validateAgency() {
  if (!document.getElementById('agency').value) {
    document.getElementById('agencyError').style.display = 'block';
    return false;
  }
  return true;
}

function validateSubmitterEmail() {
  if (authActive()) return true; // identity comes from the session instead
  const emailField = document.getElementById('submitterEmail');
  if (!emailField.value || !emailField.checkValidity()) {
    emailField.style.borderColor = '#dc3545';
    return false;
  }
  emailField.style.borderColor = '';
  return true;
}

function getSelectedNames() {
  const checkboxes = document.querySelectorAll('input[name="names"]:checked');
  return Array.from(checkboxes).map(cb => cb.dataset.formName).join(', ');
}

function showMessage(message, type) {
  const statusDiv = document.getElementById('statusMessage');
  statusDiv.className = 'status-message ' + type;
  statusDiv.innerHTML = type === 'loading' ? '<div class="spinner"></div>' + message : message;
  statusDiv.style.display = 'block';

  if (type === 'success') {
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 5000);
  }
}

function initAttendanceForm() {
  tryGetLocation();
  loadEmployeeData();
  setDefaultDate();
  setupSiteSearch();
  setupPurposeToggle();
  startWatermarkLogoLoad();
}

document.getElementById('attendanceForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  const namesOk = validateNames();
  const purposeOk = validatePurpose();
  const agencyOk = validateAgency();
  const photoOk = validatePhoto();
  const emailOk = validateSubmitterEmail();

  if (!namesOk || !purposeOk || !agencyOk || !photoOk || !emailOk) {
    if (!emailOk) showMessage('Please enter a valid email address.', 'error');
    else if (!namesOk) showMessage('Please select at least one name.', 'error');
    else if (!purposeOk) showMessage('Please select a purpose (Time In / Time Out).', 'error');
    else if (!agencyOk) showMessage('Please select an agency.', 'error');
    else showMessage('Please take a photo.', 'error');
    return;
  }

  // Location is mandatory in the app — re-attempt once right before blocking,
  // in case the user just granted permission after seeing the notice.
  if (!currentPosition) {
    showMessage('Getting your location...', 'loading');
    await new Promise(resolve => {
      if (!navigator.geolocation) return resolve();
      navigator.geolocation.getCurrentPosition(
        pos => {
          currentPosition = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
          resolve();
        },
        () => resolve(),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }
  if (!currentPosition) {
    document.getElementById('locationNotice').style.display = 'block';
    showMessage('Location access is required to submit. Please allow location and try again.', 'error');
    return;
  }

  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  showMessage('Processing your submission...', 'loading');

  try {
    const formData = new FormData(this);
    const selectedNames = getSelectedNames();

    const submissionData = {
      deploymentDate: formData.get('deploymentDate'),
      siteName: formData.get('siteName'),
      names: selectedNames,
      agency: formData.get('agency'),
      purpose: formData.get('purpose'),
      remarks: formData.get('remarks'),
      imageData: capturedImageDataUrl,
      imageName: 'attendance_' + Date.now() + '.jpg',
      imageType: 'image/jpeg',
      location: currentPosition,
    };
    if (!authActive()) {
      submissionData.email = formData.get('submitterEmail');
    }

    showMessage('Saving attendance record...', 'loading');

    const result = authActive()
      ? await apiCall('submitAttendance', { token, data: submissionData })
      : await apiCall('submitAttendanceNoAuth', { data: submissionData });

    if (!result.success) {
      throw new Error(result.error || 'Submission failed.');
    }

    showMessage('Attendance submitted successfully!', 'success');
    document.getElementById('attendanceForm').reset();

    const dateWarning = document.getElementById('dateWarning');
    if (dateWarning) dateWarning.remove();

    if (serverToday) {
      document.getElementById('deploymentDate').value = serverToday;
    } else {
      setDefaultDate();
    }

    document.getElementById('siteSearch').value = '';
    document.querySelectorAll('#siteName option').forEach(opt => (opt.hidden = false));
    document.querySelectorAll('.purpose-btn:not(.agency-btn)').forEach(b => b.classList.remove('selected'));
    document.getElementById('purpose').value = '';

    document.querySelectorAll('.agency-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('agency').value = '';

    document.getElementById('nameSearch').value = '';
    employeeData = allEmployees;
    generateCheckboxes(employeeData);
    setupNameCheckboxHandlers();
    resetSearchResults();
    hideEmployeesMessage();

    resetPhoto();
    tryGetLocation();

    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Attendance';
  } catch (error) {
    showMessage('Error: ' + error.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Attendance';
  }
});

// ============================================================
// Init
// ============================================================
// Showing the login/attendance form is handled by initInstallUI() above
// (called on load) - either immediately if already installed (standalone),
// or once the install gate is dismissed/completed. Nothing to do here.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW registration failed:', err));
  });
}
