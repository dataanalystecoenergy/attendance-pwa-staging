// ============================================================
// CONFIG — fill this in after deploying Api.gs.txt's doPost() as part of
// the Apps Script web app (Deploy > Manage deployments > copy the /exec URL).
// ============================================================
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycbysjczGw2hPim2ah9M82PqoHPSjOiHeZb7GyQtkYH6UKoqiXCKho0nBeFmmaJj6Z5QDbg/exec';

// Login is temporarily switched off - flip back to true to re-enable
// Employee ID + PIN accounts. While off, the form asks for a free-text
// name/email instead (same as the original pre-auth app) and submits
// through the unauthenticated action, so nothing server-side needs to
// change to turn this back on later.
const REQUIRE_LOGIN = false;

// ============================================================
// State
// ============================================================
let token = localStorage.getItem('attendance_token');
let employee = JSON.parse(localStorage.getItem('attendance_employee') || 'null');

let currentPosition = null;
let employeeData = [];
let allEmployees = [];
let serverToday = null;

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
  if (!REQUIRE_LOGIN || (token && employee)) {
    showForm();
    initAttendanceForm();
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
  document.getElementById('loginScreen').style.display = 'block';
  document.getElementById('formContainer').style.display = 'none';
  document.getElementById('appHeader').style.display = 'none';
}

function showForm() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('formContainer').style.display = 'block';
  // Nothing to show/log out of when login is switched off entirely.
  document.getElementById('appHeader').style.display = REQUIRE_LOGIN ? 'flex' : 'none';
  document.getElementById('whoAmI').textContent = employee ? `Logged in as ${employee.fullName}` : '';
  document.getElementById('submitterEmailGroup').style.display = REQUIRE_LOGIN ? 'none' : 'block';
  document.getElementById('gpsScopeNote').textContent = REQUIRE_LOGIN
    ? 'GPS is verified for you (the logged-in submitter) only — not individually for every name checked below.'
    : 'GPS is captured with this submission but not tied to a verified account while login is switched off — not individually for every name checked below.';
}

function logout() {
  token = null;
  employee = null;
  localStorage.removeItem('attendance_token');
  localStorage.removeItem('attendance_employee');
  showLogin();
}

document.getElementById('logoutBtn').addEventListener('click', logout);

document.getElementById('loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const employeeId = document.getElementById('loginEmployeeId').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
  const loginBtn = document.getElementById('loginBtn');
  const statusDiv = document.getElementById('loginStatus');

  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in...';
  statusDiv.style.display = 'none';

  try {
    const result = await apiCall('login', { employeeId, pin });
    if (result.success) {
      token = result.token;
      employee = result.employee;
      localStorage.setItem('attendance_token', token);
      localStorage.setItem('attendance_employee', JSON.stringify(employee));
      document.getElementById('loginPin').value = '';
      showForm();
      initAttendanceForm();
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

// Preloaded once on script load - watermarks every captured/fallback-uploaded
// photo alongside the timestamp. Loading is async, so callers must await
// watermarkLogoReady before drawing; if it fails to load for any reason,
// capture still proceeds without it rather than breaking submission.
const watermarkLogo = new Image();
let watermarkLogoLoaded = false;
const watermarkLogoReady = new Promise((resolve) => {
  watermarkLogo.onload = () => { watermarkLogoLoaded = true; resolve(true); };
  watermarkLogo.onerror = () => resolve(false);
});
watermarkLogo.src = 'watermark-logo.png';

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

document.getElementById('cameraShutterBtn').addEventListener('click', async () => {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('captureCanvas');
  const w = video.videoWidth;
  const h = video.videoHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  await watermarkLogoReady; // usually already resolved well before someone taps the shutter
  drawTimestampOverlay(ctx, w, h, formatTimestampText(syncedNow()));

  capturedImageDataUrl = canvas.toDataURL('image/jpeg', 0.85);
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
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      await watermarkLogoReady;
      drawTimestampOverlay(ctx, canvas.width, canvas.height, formatTimestampText(syncedNow()));
      capturedImageDataUrl = canvas.toDataURL('image/jpeg', 0.85);
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
function loadEmployeeData() {
  document.getElementById('loadingNames').style.display = 'block';
  document.getElementById('nameCheckboxes').style.display = 'none';

  apiCall('getEmployeeData', { token })
    .then(function (employees) {
      if (employees && employees.error) throw new Error(employees.error);
      allEmployees = employees;
      employeeData = employees;
      generateCheckboxes(employees);
      document.getElementById('loadingNames').style.display = 'none';
      document.getElementById('nameCheckboxes').style.display = 'grid';
      setupNameCheckboxHandlers();
      setupSearchFunctionality();
      setupAgencyFilter();
    })
    .catch(function (error) {
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
  if (REQUIRE_LOGIN) return true; // identity comes from the session instead
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
    if (!REQUIRE_LOGIN) {
      submissionData.email = formData.get('submitterEmail');
    }

    showMessage('Saving attendance record...', 'loading');

    const result = REQUIRE_LOGIN
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
