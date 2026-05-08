// content.js — SuckLess Factors Auto-Submit (ISOLATED world)
// Listens for events from interceptor.js (MAIN world) and stores to chrome.storage.local.
// Also does Phase 2 active detection via fetch (same-origin).

const PREFIX = '[SF-EXT content.js]';
console.log(PREFIX, '▶ Script loaded at', document.readyState, location.href);

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1 — Listen for CustomEvents from interceptor.js and store directly
// ═══════════════════════════════════════════════════════════════════════════════
function store(data) {
  chrome.storage.local.set(data).then(() => {
    console.log(PREFIX, '  ✓ stored:', Object.keys(data).join(', '));
  }).catch(e => {
    console.error(PREFIX, '  ✗ storage.session.set FAILED:', e.message, 'data:', JSON.stringify(data));

  });
}

window.addEventListener('__sf_csrf__', e => {
  console.log(PREFIX, 'Intercepted CSRF token');
  store({ csrfToken: e.detail });
});
window.addEventListener('__sf_aid__', e => {
  console.log(PREFIX, 'Intercepted assignmentId:', e.detail);
  store({ assignmentId: e.detail });
});
window.addEventListener('__sf_shift__', e => {
  console.log(PREFIX, 'Intercepted shiftDate:', e.detail);
  store({ anchorDate: e.detail });
});
window.addEventListener('__sf_atttype__', e => {
  console.log(PREFIX, 'Intercepted attendanceType:', e.detail);
  store({ attendanceTypeCode: e.detail });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2 — Active detection (runs once DOM is ready)
// ═══════════════════════════════════════════════════════════════════════════════
async function detect() {
  console.log(PREFIX, '▶ Phase 2 detect() starting…');
  const BASE = '/odatav4/timemanagement/attendance/AttendanceRecordingUi.svc/v2';

  // ── Company ID from page URL or meta ───────────────────────────────────────
  // document.cookie may be empty (HttpOnly cookies), try URL patterns
  const companyMatch = document.cookie.match(/bizxCompanyId=([^;]+)/);
  if (companyMatch) {
    const companyId = decodeURIComponent(companyMatch[1]);
    console.log(PREFIX, '  Company from cookie:', companyId);
    store({ companyId });
  } else {
    // Try to get it from page content or known patterns
    // The company shows in SF URLs and page elements
    const bodyText = document.body?.innerHTML || '';
    const companyFromPage = bodyText.match(/companyId[=:][\s"']*([A-Za-z0-9_]+)/);
    if (companyFromPage) {
      console.log(PREFIX, '  Company from page:', companyFromPage[1]);
      store({ companyId: companyFromPage[1] });
    } else {
      console.log(PREFIX, '  ⚠ No companyId found in cookies or page');
    }
  }

  // ── CSRF token via SAP Fetch pattern ───────────────────────────────────────
  // Check storage directly
  let hasToken = false;
  try {
    const stored = await chrome.storage.local.get('csrfToken');
    hasToken = !!stored?.csrfToken;
    console.log(PREFIX, '  csrfToken in storage:', hasToken);
  } catch (e) {
    console.error(PREFIX, '  storage.session.get failed:', e.message);
  }

  if (!hasToken) {
    // Try _s.crb from URL first (fastest)
    const crbMatch = window.location.search.match(/_s\.crb=([^&]+)/);
    if (crbMatch) {
      const token = decodeURIComponent(decodeURIComponent(crbMatch[1]));
      console.log(PREFIX, '  Found _s.crb token in URL');
      store({ csrfToken: token });
      hasToken = true;
    }
  }

  if (!hasToken) {
    console.log(PREFIX, '  Attempting HEAD fetch for CSRF token…');
    try {
      const resp = await fetch(`${BASE}/`, {
        method: 'HEAD',
        credentials: 'include',
        headers: { 'x-csrf-token': 'Fetch' },
      });
      console.log(PREFIX, '  HEAD response status:', resp.status);
      const token = resp.headers.get('x-csrf-token');
      console.log(PREFIX, '  x-csrf-token header:', token ? 'present' : 'NULL');
      if (token && token !== 'Required' && token !== 'Fetch') {
        store({ csrfToken: token });
        hasToken = true;
        console.log(PREFIX, '  ✓ CSRF token obtained from HEAD');
      } else {
        console.log(PREFIX, '  ⚠ Token value rejected:', token);
      }
    } catch (e) {
      console.error(PREFIX, '  ✗ HEAD fetch failed:', e.message);
    }
  }

  if (!hasToken) {
    console.warn(PREFIX, '  ✗ No CSRF token after all attempts — aborting detect()');
    return;
  }

  // Get current session state from storage directly
  let session = {};
  try {
    session = await chrome.storage.local.get(null);
  } catch (_) {}
  console.log(PREFIX, '  Current storage state:', JSON.stringify(session));

  // ── Attendance type ────────────────────────────────────────────────────────
  // AttendanceTypes entity set doesn't support direct GET on this API version.
  // It will be fetched via $batch by background.js at submit time, or captured
  // by the interceptor from SAP's own requests.
  if (!session.attendanceTypeCode) {
    console.log(PREFIX, '  attendanceTypeCode not yet available (will be fetched at submit time)');
  } else {
    console.log(PREFIX, '  ✓ attendanceTypeCode already set:', session.attendanceTypeCode);
  }

  // ── Assignment ID ──────────────────────────────────────────────────────────
  // The interceptor captures assignmentId and shiftDate from SAP's own XHR calls
  // (e.g., TimeSheetSummary URL). No need for a separate API call — it arrives
  // automatically once the timesheet page finishes loading.
  if (!session.assignmentId) {
    console.log(PREFIX, '  assignmentId not yet captured — waiting for SAP XHRs via interceptor');
  } else {
    console.log(PREFIX, '  ✓ assignmentId already set:', session.assignmentId);
  }

  console.log(PREFIX, '▶ detect() complete');
}

// Trigger Phase 2 after DOM is ready (gives interceptor time to capture initial XHRs)
if (document.readyState === 'loading') {
  console.log(PREFIX, 'Waiting for DOMContentLoaded…');
  document.addEventListener('DOMContentLoaded', () => setTimeout(detect, 500));
} else {
  console.log(PREFIX, 'DOM already ready, calling detect() in 500ms');
  setTimeout(detect, 500);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Listen for messages from background
// ═══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'redetect') {
    console.log(PREFIX, '◀ Received "redetect" message');
    detect().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'proxyFetch') {
    // Execute fetch in the content script context (has cookies for SF domain)
    console.log(PREFIX, '◀ proxyFetch:', msg.method, msg.url?.slice(0, 80));
    fetch(msg.url, {
      method: msg.method || 'GET',
      credentials: 'include',
      headers: msg.headers || {},
      body: msg.body || undefined,
    })
      .then(async resp => {
        const text = await resp.text();
        sendResponse({ status: resp.status, headers: Object.fromEntries(resp.headers.entries()), body: text });
      })
      .catch(e => {
        console.error(PREFIX, '  proxyFetch error:', e.message);
        sendResponse({ error: e.message });
      });
    return true;
  }
});
