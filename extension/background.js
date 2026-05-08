// background.js — Service worker for SuckLess Factors Auto-Submit
// Handles: native messaging (PC event log), SF OData API calls

const NATIVE_HOST = 'com.sftimesheet.host';
const SF_ODATA_PATH = '/odatav4/timemanagement/attendance/AttendanceRecordingUi.svc/v2';
const SF_URL_PATTERNS = ['https://*.successfactors.eu/*', 'https://*.successfactors.com/*'];
const BG = '[SF-EXT background.js]';

// Derive OData base URL from the stored SF origin (set by content script / webRequest)
async function getSfOdata() {
  const { sfOrigin } = await chrome.storage.local.get('sfOrigin');
  if (!sfOrigin) throw new Error('SF origin not detected yet. Open a SuccessFactors page first.');
  return sfOrigin + SF_ODATA_PATH;
}

console.log(BG, '▶ Service worker started');

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log(BG, '◀ Message received:', msg.action, msg);
  switch (msg.action) {
    case 'redetect':
      redetectInActiveTab()
        .then(r => { console.log(BG, '  redetect result:', JSON.stringify(r)); sendResponse(r); })
        .catch(e => { console.error(BG, '  redetect error:', e.message); sendResponse({ error: e.message }); });
      return true;

    case 'getStatus':
      chrome.storage.local
        .get(['csrfToken', 'assignmentId', 'companyId', 'anchorDate', 'attendanceTypeCode'])
        .then(s => { console.log(BG, '  getStatus result:', JSON.stringify(s)); sendResponse(s); });
      return true;

    case 'storeSessionData':
      console.log(BG, '  storeSessionData:', JSON.stringify(msg.data));
      chrome.storage.local.set(msg.data)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;

    case 'debugDump':
      chrome.storage.local.get(null)
        .then(all => sendResponse({ storage: all }));
      return true;

    case 'fetchCsrfToken':
      fetchCsrfToken()
        .then(sendResponse)
        .catch(e => sendResponse({ error: e.message }));
      return true;

    case 'getWorkTimes':
      getWorkTimesFromHost(msg.anchorDate)
        .then(sendResponse)
        .catch(e => sendResponse({ error: e.message }));
      return true;

    case 'submitTimes':
      submitTimes(msg.days)
        .then(async (result) => {
          // Reload the SF tab so the page reflects the new entries
          try {
            const tabs = await chrome.tabs.query({ url: SF_URL_PATTERNS });
            for (const tab of tabs) chrome.tabs.reload(tab.id);
          } catch (_) {}
          sendResponse(result);
        })
        .catch(e => sendResponse({ error: e.message }));
      return true;
  }
});

// ---------------------------------------------------------------------------
// Find the active SF tab and ask its content script to re-detect
// ---------------------------------------------------------------------------
async function redetectInActiveTab() {
  console.log(BG, 'redetectInActiveTab() called');
  const tabs = await chrome.tabs.query({
    url: SF_URL_PATTERNS,
  });
  console.log(BG, '  Found SF tabs:', tabs.length, tabs.map(t => `[${t.id}] ${t.url?.slice(0, 80)}`));
  if (tabs.length === 0) {
    throw new Error(
      'No SuccessFactors tab found.\n' +
      'Open your SuccessFactors timesheet page in this browser first.'
    );
  }
  // Prefer the most recently active SF tab
  const tab = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  console.log(BG, '  Using tab:', tab.id, tab.url?.slice(0, 80));
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { action: 'redetect' });
    console.log(BG, '  sendMessage to content script succeeded:', resp);
  } catch (e) {
    console.warn(BG, '  sendMessage failed (content script not injected?):', e.message);
    console.log(BG, '  Injecting content.js via scripting API…');
    // Content script not yet injected on this tab — use scripting API to run detect() directly
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ['content.js'],
    });
    console.log(BG, '  ✓ content.js injected');
  }
  // Give it a moment to write to session storage
  await new Promise(r => setTimeout(r, 1500));
  const result = await chrome.storage.local.get(['csrfToken', 'assignmentId', 'companyId', 'anchorDate']);
  console.log(BG, '  redetect final state:', JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Passively capture CSRF token, companyId, and assignmentId from any outgoing SF request
// ---------------------------------------------------------------------------
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Store the SF origin so we can build OData URLs dynamically
    try {
      const origin = new URL(details.url).origin;
      chrome.storage.local.set({ sfOrigin: origin });
    } catch (_) {}

    const headers = details.requestHeaders ?? [];

    const tok = headers.find(h => h.name.toLowerCase() === 'x-csrf-token');
    if (tok?.value && tok.value !== 'Fetch' && tok.value !== 'Required') {
      console.log(BG, '[webRequest] CSRF token from header:', tok.value.slice(0, 10) + '…');
      chrome.storage.local.set({ csrfToken: tok.value });
    }

    const spi = headers.find(h => h.name.toLowerCase() === 'x-sap-page-info');
    if (spi?.value) {
      const m = spi.value.match(/companyId=([^&]+)/);
      if (m) {
        console.log(BG, '[webRequest] companyId from x-sap-page-info:', m[1]);
        chrome.storage.local.set({ companyId: decodeURIComponent(m[1]) });
      }
    }

    // Parse assignmentId and currently-viewed shiftDate (= week anchor) from the URL
    const aidMatch = details.url.match(/assignmentId='(\d+)'/);
    if (aidMatch) {
      console.log(BG, '[webRequest] assignmentId from URL:', aidMatch[1]);
      chrome.storage.local.set({ assignmentId: aidMatch[1] });
    }

    // shiftDate appears in TimeSheetSummary key — track whichever week the user is viewing
    const shiftMatch = details.url.match(/shiftDate=(\d{4}-\d{2}-\d{2})/);
    if (shiftMatch) {
      console.log(BG, '[webRequest] anchorDate from URL:', shiftMatch[1]);
      chrome.storage.local.set({ anchorDate: shiftMatch[1] });
    }
  },
  { urls: SF_URL_PATTERNS },
  ['requestHeaders', 'extraHeaders']
);

// ---------------------------------------------------------------------------
// Actively fetch a fresh CSRF token using SAP's Fetch pattern
// ---------------------------------------------------------------------------
async function fetchCsrfToken() {
  // SAP services return the CSRF token in the response when the request
  // carries 'x-csrf-token: Fetch'. We use the OData service root.
  const sfOdata = await getSfOdata();
  const resp = await fetch(
    `${sfOdata}/`,
    {
      method: 'HEAD',
      credentials: 'include',
      headers: { 'x-csrf-token': 'Fetch' },
    }
  );

  const token = resp.headers.get('x-csrf-token');
  if (!token || token === 'Required' || token === 'Fetch') {
    throw new Error(
      'Could not obtain CSRF token.\n' +
      'Make sure you are logged into SuccessFactors in this browser, ' +
      'then try again.'
    );
  }

  await chrome.storage.local.set({ csrfToken: token });
  return { csrfToken: token };
}

// ---------------------------------------------------------------------------
// Native messaging — get times from the PC event log for a specific week
// ---------------------------------------------------------------------------
function getWorkTimesFromHost(anchorDate) {
  return new Promise(async (resolve, reject) => {
    // Get anchorDate from storage if not provided
    if (!anchorDate) {
      const stored = await chrome.storage.local.get('anchorDate');
      anchorDate = stored.anchorDate || null;
    }

    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      return reject(new Error('Native host not available. Run install.ps1 first. (' + e.message + ')'));
    }

    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('Native host timed out after 10 s'));
    }, 10_000);

    port.onMessage.addListener(msg => {
      clearTimeout(timer);
      port.disconnect();
      resolve(msg);
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      reject(new Error(err?.message ?? 'Native host disconnected unexpectedly'));
    });

    port.postMessage({ action: 'getWeekTimes', anchorDate: anchorDate });
  });
}

// ---------------------------------------------------------------------------
// Submit times for the given days array
// ---------------------------------------------------------------------------
async function submitTimes(days) {
  const session = await chrome.storage.local.get(['csrfToken', 'assignmentId', 'companyId', 'attendanceTypeCode', 'anchorDate']);
  const { csrfToken, companyId = '' } = session;
  const aid        = session.assignmentId;
  const anchorDate = session.anchorDate || new Date().toISOString().slice(0, 10);

  if (!csrfToken) throw new Error('No CSRF token — reload the SuccessFactors timesheet tab, then try again.');
  if (!aid)       throw new Error('Assignment ID not detected yet — reload the SF timesheet tab and wait a moment, then try again.');

  // Fetch existing record IDs so we know POST vs PATCH per day
  const existingMap = await fetchExistingRecords(csrfToken, aid, companyId, anchorDate);

  // Re-read attendanceTypeCode — fetchExistingRecords may have just populated it.
  // If still missing, try fetching AttendanceTypes directly.
  let { attendanceTypeCode } = await chrome.storage.local.get('attendanceTypeCode');
  if (!attendanceTypeCode) {
    attendanceTypeCode = await fetchAttendanceTypeCode(csrfToken, companyId);
  }
  if (!attendanceTypeCode) {
    throw new Error(
      'Could not detect your attendance type.\n' +
      'Make sure the SuccessFactors timesheet page is open and try again.'
    );
  }

  const results = [];
  for (const day of days) {
    if (!day.start || !day.end) {
      results.push({ date: day.date, skipped: true });
      continue;
    }
    try {
      const existingId = existingMap[day.date] ?? null;
      await submitDay(csrfToken, aid, companyId, anchorDate, day, existingId, attendanceTypeCode);
      results.push({ date: day.date, success: true });
    } catch (e) {
      results.push({ date: day.date, success: false, error: e.message });
    }
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Fetch attendance type code via $batch
// ---------------------------------------------------------------------------
async function fetchAttendanceTypeCode(csrfToken, companyId) {
  try {
    const boundary = `batch_id-${Date.now()}-atttype`;
    const body =
      `--${boundary}\r\n` +
      `Content-Type:application/http\r\n` +
      `Content-Transfer-Encoding:binary\r\n` +
      `\r\n` +
      `GET AttendanceTypes?$top=5&$select=externalCode,name HTTP/1.1\r\n` +
      `Accept:application/json;odata.metadata=minimal;IEEE754Compatible=true\r\n` +
      `Accept-Language:en-US\r\n` +
      `X-CSRF-Token:${csrfToken}\r\n` +
      `Content-Type:application/json;charset=UTF-8;IEEE754Compatible=true\r\n` +
      `\r\n` +
      `\r\n` +
      `--${boundary}--\r\n`;

    const sfOdata = await getSfOdata();
    const resp = await fetch(`${sfOdata}/$batch`, {
      method: 'POST',
      credentials: 'include',
      headers: buildHeaders(csrfToken, companyId, boundary),
      body,
    });

    if (!resp.ok && resp.status !== 202) return null;
    const text  = await resp.text();
    const data  = extractJsonFromBatch(text);
    const types = data?.value ?? [];
    const preferred =
      types.find(t => /work/i.test(t.name) || /work/i.test(t.externalCode)) ||
      types[0];
    if (preferred?.externalCode) {
      await chrome.storage.local.set({ attendanceTypeCode: preferred.externalCode });
      return preferred.externalCode;
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// GET current week to build a date→recordId map
// ---------------------------------------------------------------------------
async function fetchExistingRecords(csrfToken, assignmentId, companyId, anchorDate) {
  // Use the SF-tracked anchor date (= week the user is currently viewing);
  // fall back to today which SF will normalise to the current week.
  anchorDate = anchorDate || new Date().toISOString().slice(0, 10);
  const boundary = `batch_id-${Date.now()}-fetch`;
  const query =
    `TimeSheetSummary(assignmentId='${assignmentId}',shiftDate=${anchorDate})` +
    `?$expand=days($expand=attendances)&$select=days`;

  const body =
    `--${boundary}\r\n` +
    `Content-Type:application/http\r\n` +
    `Content-Transfer-Encoding:binary\r\n` +
    `\r\n` +
    `GET ${query} HTTP/1.1\r\n` +
    `Accept:application/json;odata.metadata=minimal;IEEE754Compatible=true\r\n` +
    `Accept-Language:en-US\r\n` +
    `X-CSRF-Token:${csrfToken}\r\n` +
    `Content-Type:application/json;charset=UTF-8;IEEE754Compatible=true\r\n` +
    `\r\n` +
    `\r\n` +
    `--${boundary}--\r\n`;

  const sfOdata = await getSfOdata();
  const resp = await fetch(`${sfOdata}/$batch`, {
    method: 'POST',
    credentials: 'include',
    headers: buildHeaders(csrfToken, companyId, boundary),
    body,
  });

  if (!resp.ok && resp.status !== 202) {
    throw new Error(`GET week summary failed: HTTP ${resp.status}`);
  }

  const text = await resp.text();
  const data = extractJsonFromBatch(text);
  if (!data?.days) return {};

  const map = {};
  for (const day of data.days) {
    if (day.attendances?.length > 0) {
      const att = day.attendances[0];
      map[day.shiftDate] = att.mdfSystemRecordId;
      // Cache the attendance type so POST calls don't need it hardcoded
      if (att.attendanceTypeExternalCode) {
        chrome.storage.local.set({ attendanceTypeCode: att.attendanceTypeExternalCode });
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// POST (new) or PATCH (existing) a single day
// ---------------------------------------------------------------------------
async function submitDay(csrfToken, assignmentId, companyId, anchorDate, day, existingId, attendanceTypeCode) {
  const [sh, sm] = day.start.split(':').map(Number);
  const [eh, em] = day.end.split(':').map(Number);
  const durationInMinutes = String((eh * 60 + em) - (sh * 60 + sm));

  const outerBnd     = `batch_id-${Date.now()}-${rndSuffix()}`;
  const changesetBnd = `changeset_id-${Date.now()}-${rndSuffix()}`;

  const dayPath =
    `TimeSheetSummary(assignmentId='${assignmentId}',shiftDate=${anchorDate})` +
    `/days(assignmentId='${assignmentId}',shiftDate=${day.date})/attendances`;

  let changesetContent;

  if (existingId) {
    // ---- PATCH existing record ----
    const payload = JSON.stringify({
      startTime:                day.start,
      endTime:                  day.end,
      durationInMinutes,
      physicalStartDate:        day.date,
      physicalEndDate:          day.date,
      startTimeDayOffset:       '0',
      endTimeDayOffset:         '0',
      originalStartTime:        null,
      originalEndTime:          null,
      originalPhysicalStartDate: null,
      originalPhysicalEndDate:  null,
    });

    changesetContent =
      `--${changesetBnd}\r\n` +
      `Content-Type:application/http\r\n` +
      `Content-Transfer-Encoding:binary\r\n` +
      `Content-ID:0.0\r\n` +
      `\r\n` +
      `PATCH ${dayPath}('${existingId}') HTTP/1.1\r\n` +
      `Accept:application/json;odata.metadata=minimal;IEEE754Compatible=true\r\n` +
      `Accept-Language:en-US\r\n` +
      `X-CSRF-Token:${csrfToken}\r\n` +
      `Content-Type:application/json;charset=UTF-8;IEEE754Compatible=true\r\n` +
      `\r\n` +
      payload + `\r\n` +
      `--${changesetBnd}--`;
  } else {
    // ---- POST new record ----
    const externalCode    = `id${Date.now()}`;
    const mdfSystemRecordId = crypto.randomUUID().replace(/-/g, '').toUpperCase();

    const payload = JSON.stringify({
      assignmentId,
      startTime:                   day.start,
      endTime:                     day.end,
      durationInMinutes,
      durationInDays:              null,
      startTimeDayOffset:          '0',
      endTimeDayOffset:            '0',
      physicalStartDate:           day.date,
      physicalEndDate:             day.date,
      externalCode,
      durationInDays_FC:           '0',
      mdfSystemRecordId,
      attendanceTypeExternalCode:  attendanceTypeCode,
      attendanceTypeName:          'Working Time',
      originalStartTime:           null,
      originalEndTime:             null,
      originalPhysicalStartDate:   null,
      originalPhysicalEndDate:     null,
    });

    changesetContent =
      `--${changesetBnd}\r\n` +
      `Content-Type:application/http\r\n` +
      `Content-Transfer-Encoding:binary\r\n` +
      `Content-ID:0.0\r\n` +
      `\r\n` +
      `POST ${dayPath} HTTP/1.1\r\n` +
      `Accept:application/json;odata.metadata=minimal;IEEE754Compatible=true\r\n` +
      `Accept-Language:en-US\r\n` +
      `X-CSRF-Token:${csrfToken}\r\n` +
      `Content-Type:application/json;charset=UTF-8;IEEE754Compatible=true\r\n` +
      `\r\n` +
      payload + `\r\n` +
      `--${changesetBnd}--`;
  }

  const batchBody =
    `--${outerBnd}\r\n` +
    `Content-Type: multipart/mixed;boundary=${changesetBnd}\r\n` +
    `\r\n` +
    changesetContent + `\r\n` +
    `--${outerBnd}--\r\n`;

  const sfOdata = await getSfOdata();
  const resp = await fetch(`${sfOdata}/$batch`, {
    method: 'POST',
    credentials: 'include',
    headers: buildHeaders(csrfToken, companyId, outerBnd),
    body: batchBody,
  });

  if (!resp.ok && resp.status !== 202) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  // Check sub-response for OData errors
  const respText = await resp.text();
  if (respText.includes('"error"')) {
    const m = respText.match(/"message"\s*:\s*"([^"]+)"/);
    throw new Error(m ? m[1] : 'OData error (see DevTools for details)');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildHeaders(csrfToken, companyId, boundary) {
  return {
    'Content-Type':    `multipart/mixed; boundary=${boundary}`,
    'Accept':          'multipart/mixed',
    'OData-Version':   '4.0',
    'OData-MaxVersion': '4.0',
    'MIME-Version':    '1.0',
    'X-CSRF-Token':    csrfToken,
    'X-Ajax-Token':    csrfToken,
    'X-Requested-With': 'XMLHttpRequest',
    'X-SAP-Page-Info': `companyId=${companyId}&moduleId=EMPLOYEE_FILE&pageId=EMPLOYEE_FILE&pageQualifier=TIME_SHEET_WEB_2&uiVersion=V12`,
  };
}

function rndSuffix() {
  return Math.random().toString(36).slice(2, 7);
}

/**
 * Extracts the first JSON object that contains a "days" key from
 * an OData $batch multipart response body.
 */
function extractJsonFromBatch(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;

    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc)              { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true;  continue; }
      if (c === '"')        { inStr = !inStr; continue; }
      if (inStr)            { continue; }
      if (c === '{')        { depth++; }
      else if (c === '}')   { depth--; if (depth === 0) { end = j; break; } }
    }

    if (end !== -1) {
      try {
        const obj = JSON.parse(text.slice(i, end + 1));
        if (obj?.days) return obj;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}
