// popup.js — UI logic for SuckLess Factors Auto-Submit

// ---------------------------------------------------------------------------
// Week helpers
// ---------------------------------------------------------------------------
function getWeekDays(anchorIso) {
  // Use the SF-tracked anchor date if available, otherwise today
  const anchor = anchorIso ? new Date(anchorIso + 'T12:00:00') : new Date();
  const dow    = anchor.getDay();           // 0=Sun … 6=Sat
  const diff   = dow === 0 ? 6 : dow - 1;  // days since Monday
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - diff);

  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((name, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return {
      name,
      date:   d.toISOString().slice(0, 10),
      start:  '',
      end:    '',
      status: 'empty',
    };
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let weekDays    = getWeekDays(null); // rebuilt in init() once anchorDate is known
let isConnected  = false;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg) {
  document.getElementById('log').textContent = msg;
}

// ---------------------------------------------------------------------------
// Render the week table
// ---------------------------------------------------------------------------
function renderTable() {
  const tbody = document.getElementById('times-body');
  tbody.innerHTML = '';

  weekDays.forEach((day, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${day.name}</td>` +
      `<td>${day.date}</td>` +
      `<td><input type="time" id="s${i}" value="${day.start}"></td>` +
      `<td><input type="time" id="e${i}" value="${day.end}"></td>` +
      `<td><span class="dot dot-${day.status}" title="${day.status}"></span></td>`;
    tbody.appendChild(tr);

    document.getElementById(`s${i}`).addEventListener('change', ev => { weekDays[i].start = ev.target.value; });
    document.getElementById(`e${i}`).addEventListener('change', ev => { weekDays[i].end   = ev.target.value; });
  });
}

// ---------------------------------------------------------------------------
// Status check on popup open
// ---------------------------------------------------------------------------
async function init() {
  let session = await chrome.storage.local.get(['csrfToken', 'assignmentId', 'companyId', 'anchorDate', 'attendanceTypeCode']);

  // If nothing yet, try waking the background and redetecting
  if (!session?.csrfToken) {
    log('Detecting session data…');
    try {
      await chrome.runtime.sendMessage({ action: 'redetect' });
    } catch (_) {}
    // Wait for interceptor to store data
    await new Promise(r => setTimeout(r, 2000));
    session = await chrome.storage.local.get(['csrfToken', 'assignmentId', 'companyId', 'anchorDate', 'attendanceTypeCode']);
  }

  const { csrfToken, assignmentId, companyId, anchorDate } = session || {};

  // Rebuild week based on whatever SF week the user is currently viewing
  weekDays = getWeekDays(anchorDate);

  isConnected = !!csrfToken;

  // ── Status bar ──────────────────────────────────────────────────────────
  const bar = document.getElementById('status-bar');
  if (isConnected) {
    const weekLabel = `${weekDays[0].date} → ${weekDays[4].date}`;
    bar.textContent = `Connected  ·  Week ${weekLabel}`;
    bar.className   = 'status-bar status-ok';
    log('');
  } else {
    bar.textContent = 'Not connected — reload the SF timesheet tab (F5), then reopen this popup';
    bar.className   = 'status-bar status-err';
  }

  // ── Info bar (auto-detected values) ─────────────────────────────────────
  const infoEl = document.getElementById('info-text');
  const parts  = [];
  if (companyId)    parts.push(`Company: <span>${companyId}</span>`);
  if (assignmentId) parts.push(`Employee ID: <span>${assignmentId}</span>`);

  if (parts.length > 0) {
    infoEl.innerHTML = parts.join('  ·  ');
  } else if (isConnected) {
    infoEl.innerHTML = '<span class="warn">Detecting assignment ID… interact with the SF timesheet page and reopen this popup.</span>';
  } else {
    infoEl.innerHTML = '<span class="warn">Session data not available.</span>';
  }

  // ── Buttons ──────────────────────────────────────────────────────────────
  document.getElementById('btn-load').disabled   = false;
  document.getElementById('btn-submit').disabled = !(isConnected && !!assignmentId);

  renderTable();
}

// ---------------------------------------------------------------------------
// Retry connection button
// ---------------------------------------------------------------------------
document.getElementById('btn-retry').addEventListener('click', async () => {
  const btn = document.getElementById('btn-retry');
  btn.disabled = true;
  log('Detecting session data…');
  try {
    const result = await chrome.runtime.sendMessage({ action: 'redetect' });
    if (result?.error) throw new Error(result.error);
  } catch (e) {
    log(`Could not connect: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
  // Re-run init to refresh the whole popup with newly detected values
  await init();
});

// ---------------------------------------------------------------------------
// Load times from PC event log via native messaging
// ---------------------------------------------------------------------------
document.getElementById('btn-load').addEventListener('click', async () => {
  const btn = document.getElementById('btn-load');
  btn.disabled = true;
  log('Loading times from PC event log…');

  try {
    const result = await chrome.runtime.sendMessage({ action: 'getWorkTimes' });
    if (result.error) throw new Error(result.error);

    let loaded = 0;
    for (const d of result.days) {
      const idx = weekDays.findIndex(w => w.date === d.date);
      if (idx !== -1) {
        weekDays[idx].start  = d.start;
        weekDays[idx].end    = d.end;
        weekDays[idx].status = 'loaded';
        loaded++;
      }
    }
    renderTable();
    log(`Loaded ${loaded} day(s) from event log.`);
  } catch (e) {
    log(`Error: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Submit the week to SuccessFactors
// ---------------------------------------------------------------------------
document.getElementById('btn-submit').addEventListener('click', async () => {
  if (!isConnected) { log('Not connected — open the timesheet page first.'); return; }

  const toSubmit = weekDays.filter(d => d.start && d.end);
  if (toSubmit.length === 0) { log('No times to submit. Load from PC or fill in times manually.'); return; }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  log(`Submitting ${toSubmit.length} day(s)…`);

  try {
    const result = await chrome.runtime.sendMessage({ action: 'submitTimes', days: toSubmit });
    if (result.error) throw new Error(result.error);

    let ok = 0;
    for (const r of result.results) {
      const idx = weekDays.findIndex(d => d.date === r.date);
      if (idx === -1) continue;
      if (r.success)  { weekDays[idx].status = 'submitted'; ok++; }
      else if (!r.skipped) { weekDays[idx].status = 'error'; }
    }

    renderTable();

    const failed = result.results.filter(r => !r.success && !r.skipped);
    if (failed.length > 0) {
      log(`${ok} submitted, ${failed.length} failed: ${failed[0].error}`);
    } else {
      log(`${ok} day(s) submitted successfully.`);
    }
  } catch (e) {
    log(`Submit error: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
init();
refreshDebug();

// Listen for storage changes and auto-refresh when new data arrives
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.csrfToken || changes.assignmentId || changes.anchorDate || changes.companyId)) {
    init();
    refreshDebug();
  }
});

// ---------------------------------------------------------------------------
// Debug panel — dump all session storage + extension info
// ---------------------------------------------------------------------------
async function refreshDebug() {
  const out = document.getElementById('debug-output');
  try {
    const storage = await chrome.storage.local.get(null);
    const info = {
      extensionId: chrome.runtime.id,
      storageSession: storage,
      manifestPermissions: chrome.runtime.getManifest().permissions,
      timestamp: new Date().toISOString(),
    };
    out.textContent = JSON.stringify(info, null, 2);
  } catch (e) {
    out.textContent = 'ERROR communicating with background:\n' + e.message +
      '\n\nThis likely means the service worker crashed.\n' +
      'Check brave://extensions → "Errors" or "Service Worker" link.';
  }
}

// Refresh debug on retry
const origRetryHandler = document.getElementById('btn-retry').onclick;
document.getElementById('btn-retry').addEventListener('click', () => {
  setTimeout(refreshDebug, 2000);
});
