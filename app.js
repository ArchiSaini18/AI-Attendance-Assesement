// ============================================================
//  FILE: app.js
//  PURPOSE: All JavaScript logic for index.html
//
//  HOW IT WORKS:
//    1. On page load → fetch employees + dashboard data from server
//    2. If server is offline → use STATIC_* fallback data below
//    3. All render functions write HTML into the empty containers
//       defined in index.html
//    4. Webcam functions open the camera, capture a frame, and
//       POST the photo + employee ID to the server
//
//  API ENDPOINTS USED (all served by server.js):
//    GET  /api/employees        → list of employees
//    GET  /api/dashboard        → today's stats + monthly data
//    POST /api/mark-attendance  → submit a check-in/out + photo
//    POST /api/excuse           → toggle an employee's excuse flag
//    POST /api/upload-excel     → bulk import from .xlsx file
//    GET  /api/download-excel   → download attendance as .xlsx
//
//  ── HOW EMPLOYEE DATA ENTERS THIS SYSTEM (n8n Pipeline) ─────
//
//  Step 1 — Webhook Node
//    Receives the uploaded Excel (.xlsx) file via HTTP POST.
//    Trigger URL : POST /webhook/attendance-upload
//    Payload     : multipart/form-data  { file: <xlsx binary> }
//
//  Step 2 — Code Node (JavaScript inside n8n)
//    Groups all raw punch rows by Employee + Date, then applies:
//      • Earliest IN  punch of the day  → checkIn
//      • Latest   OUT punch of the day  → checkOut
//      • checkIn after 11:00 AM         → late = true
//    Emits one clean record per employee per day.
//    Example n8n Code Node logic:
//    ─────────────────────────────────────────────────────────
//    const rows   = $input.all().map(i => i.json);
//    const groups = {};
//    for (const r of rows) {
//      const key = r.employeeId + '|' + r.date;
//      if (!groups[key]) groups[key] = { ...r, punches: [] };
//      groups[key].punches.push({ time: r.time, type: r.punchType });
//    }
//    return Object.values(groups).map(g => {
//      const ins  = g.punches.filter(p => p.type === 'IN' ).map(p => p.time);
//      const outs = g.punches.filter(p => p.type === 'OUT').map(p => p.time);
//      const checkIn  = ins.length  ? ins.sort()[0]               : null;
//      const checkOut = outs.length ? outs.sort().reverse()[0]    : null;
//      const late = checkIn ? checkIn.slice(0,5) > '11:00'        : false;
//      return { json: { ...g, checkIn, checkOut, late, punches: undefined } };
//    });
//    ─────────────────────────────────────────────────────────
//
//  Step 3 — Google Sheets / MySQL Node
//    Structure 1 (Google Sheets):
//      Action : Append Row
//      Sheet  : "Attendance"
//      Columns: id | name | dept | date | checkIn | checkOut |
//               late | lateCount
//    Structure 2 (MySQL):
//      Action : Execute Query (UPSERT)
//      Query  : INSERT INTO attendance (...) VALUES (...)
//               ON DUPLICATE KEY UPDATE checkIn=VALUES(checkIn), ...
//
//  Step 4 — Google Calendar Node
//    Condition : lateCount === 3  (exactly on the 3rd strike)
//    Action    : Create Event
//      Title   : "HR Meeting – {{ $json.name }}"
//      Date    : {{ $json.date }}
//      Start   : 17:00   End: 17:30
//      Description: "3rd late strike — mandatory HR review."
//
//  The dashboard reads processed data from GET /api/employees
//  (served by server.js, which reads from Sheets/MySQL).
//  When the server is offline the STATIC_* arrays below act as
//  fallback — they are intentionally empty so no dummy data shows.
// ─────────────────────────────────────────────────────────────
//
//  SECTIONS:
//    1.  Fallback data      — used when the server is not running
//    2.  App state          — shared variables
//    3.  Startup            — runs on DOMContentLoaded
//    4.  Data loading       — fetch from server or use fallback
//    5.  Render: stats      — 4 top summary cards
//    6.  Render: emp table  — "All Employees" table rows
//    7.  Render: at-risk    — right-sidebar ranked list
//    8.  Render: trend      — 7-day bar chart
//    9.  Render: alerts     — alert feed + full alerts view
//    10. Render: dept chart — department breakdown bars
//    11. Render: monthly    — bottom monthly counter table
//    12. Webcam             — open/close/capture camera
//    13. Excuse toggle      — mark an employee as excused
//    14. Excel upload       — send .xlsx to server
//    15. View switcher      — sidebar navigation
//    16. Helpers            — formatTime()
// ============================================================


// ── 1. FALLBACK DATA ─────────────────────────────────────────
// Used automatically when the Node server is not running.
// Intentionally empty — records are inserted via the n8n pipeline.

const STATIC_EMPLOYEES = [];  // populated at runtime via webhook pipeline

const STATIC_DASHBOARD = {
  totalEmployees: 0,
  onTime:         0,
  lateToday:      0,
  critical:       0,
  // 7-day trend: [Mon … Sun]
  trend: [
    { day: 'Mon', count: 0 }, { day: 'Tue', count: 0 }, { day: 'Wed', count: 0 },
    { day: 'Thu', count: 0 }, { day: 'Fri', count: 0 }, { day: 'Sat', count: 0 }, { day: 'Sun', count: 0 },
  ],
  // One entry per employee — lateCount = strikes this month
  // Records are inserted by the n8n pipeline (see Step 2–3 above)
  monthly: [],
  alerts: [],
};


// ── 2. APP STATE ─────────────────────────────────────────────
// These variables are shared across functions.

let employees  = [];     // populated by loadEmployees()
let dashData   = {};     // populated by loadDashboard()
let punchState = { 1: 'IN', 2: 'IN' };  // which punch button is active per modal instance
let stream     = null;   // the active webcam MediaStream


// ── 3. STARTUP ───────────────────────────────────────────────
// Runs once when the page finishes loading.

document.addEventListener('DOMContentLoaded', () => {
  startClock();               // tick the live clock in the top bar
  loadEmployees();            // fetch employee list → populate dropdowns
  loadDashboard();            // fetch dashboard data → render all panels
  setInterval(loadDashboard, 60000);  // auto-refresh every 60 seconds
});

// Ticks the HH:MM:SS clock in the top bar
function startClock() {
  setInterval(() => {
    document.getElementById('clockDisplay').textContent =
      new Date().toLocaleTimeString('en-IN', { hour12: false });
  }, 1000);
}


// ── 4. DATA LOADING ──────────────────────────────────────────

// Fetches the employee list from the server.
// Falls back to STATIC_EMPLOYEES if the server is offline.
async function loadEmployees() {
  try {
    const response = await fetch('/api/employees');
    if (!response.ok) throw new Error('Server status: ' + response.status);
    employees = await response.json();
  } catch (e) {
    console.warn('Employees error:', e.message);
    employees = STATIC_EMPLOYEES;  // offline fallback
  }

  // Populate both employee dropdowns (modal + attendance view)
  ['empSelect', 'empSelect2'].forEach(selectId => {
    const select = document.getElementById(selectId);
    employees.forEach(emp => {
      const option = document.createElement('option');
      option.value       = emp.id;
      option.textContent = `${emp.name} · ${emp.id}`;
      select.appendChild(option);
    });
  });
}

// Fetches all dashboard data and re-renders every panel.
// Falls back to STATIC_DASHBOARD if the server is offline.
async function loadDashboard() {
  try {
    const response = await fetch('/api/dashboard');
    if (!response.ok) throw new Error('Server status: ' + response.status);
    dashData = await response.json();
  } catch (e) {
    console.warn('Dashboard error:', e.message);
    dashData = STATIC_DASHBOARD;
  }

  // Re-render every section with the fresh data
  renderStats();
  renderEmployeeTable();
  renderAtRisk();
  renderTrend();
  renderAlerts();
  renderDeptChart();
  renderMonthly();
}


// ── 5. RENDER: STATS CARDS ───────────────────────────────────
// Updates the 4 summary numbers at the top of the dashboard.

function renderStats() {
  const d     = dashData;
  const total = d.totalEmployees || 0;

  document.getElementById('sTotalEmp').textContent = total;
  document.getElementById('sOnTime').textContent   = d.onTime    ?? 0;
  document.getElementById('sLate').textContent     = d.lateToday ?? 0;
  document.getElementById('sCritical').textContent = d.critical  ?? 0;

  // Show percentages below each number
  const onPct = total > 0 ? Math.round(((d.onTime    || 0) / total) * 100) : 0;
  const ltPct = total > 0 ? Math.round(((d.lateToday || 0) / total) * 100) : 0;
  document.getElementById('sOnTimePct').textContent = `${onPct}% of staff`;
  document.getElementById('sLatePct').textContent   = `${ltPct}% of staff`;
}


// ── 6. RENDER: EMPLOYEE TABLE ────────────────────────────────
// Builds every row in the "All Employees — Strike Status" table.

function renderEmployeeTable() {
  const tbody = document.getElementById('empTableBody');
  tbody.innerHTML = '';  // clear before re-drawing
  document.getElementById('empCount').textContent = `${employees.length} employees`;

  if (!employees.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">No employee records. Upload an Excel file via the pipeline to populate.</td></tr>';
    return;
  }

  // Avatar colours — cycles through 7 options
  const avatarColors = ['#6c8ef5','#34d399','#f59e0b','#f87171','#a78bfa','#2dd4bf','#fb923c'];

  (dashData.monthly || []).forEach(emp => {
    const count = emp.lateCount;

    // Determine status tier
    const status      = count >= 3 ? 'critical' : count >= 2 ? 'risk' : 'safe';
    const statusLabel = count >= 3 ? 'Critical' : count >= 2 ? 'At Risk' : 'Safe';
    const dotColor    = count >= 3 ? 'filled-red' : count >= 2 ? 'filled-amber' : 'filled-green';

    // Draw 3 circles — filled ones = strikes, empty = unused
    let dots = '';
    for (let i = 0; i < 3; i++) {
      dots += `<div class="strike-dot ${i < count ? dotColor : ''}"></div>`;
    }

    // Check-in/out time strings (amber if late)
    const timeClass = emp.late === 'YES' && !emp.excused ? 'time-late' : 'time-ok';
    const checkInHtml  = emp.checkIn  ? `<span class="${timeClass}">${formatTime(emp.checkIn)}</span>`  : '<span class="time-missing">—</span>';
    const checkOutHtml = emp.checkOut ? `<span class="time-ok">${formatTime(emp.checkOut)}</span>`      : '<span class="time-missing">—</span>';

    // Avatar: show photo if available, otherwise show coloured initials
    const initials   = emp.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    const color      = avatarColors[parseInt(emp.id.replace(/\D/g, '')) % avatarColors.length];
    const avatarHtml = emp.photo
      ? `<img src="${emp.photo}" alt="${emp.name}">`
      : `<span>${initials}</span>`;

    tbody.innerHTML += `
      <tr>
        <td>
          <div class="emp-cell">
            <div class="avatar" style="background:${emp.photo ? '#000' : color + '22'};color:${color}">${avatarHtml}</div>
            <div>
              <div class="emp-name">${emp.name}</div>
              <div class="emp-sub">${emp.id} · ${emp.dept}</div>
            </div>
          </div>
        </td>
        <td>${checkInHtml}</td>
        <td>${checkOutHtml}</td>
        <td><div class="strikes">${dots}</div></td>
        <td><span class="badge badge-${status}">${statusLabel}</span></td>
        <td>
          <button class="btn-excuse ${emp.excused ? 'excused' : ''}"
                  onclick="toggleExcuse('${emp.id}', this)">
            ${emp.excused ? 'Excused' : 'Excuse'}
          </button>
        </td>
      </tr>`;
  });
}


// ── 7. RENDER: AT-RISK LIST ──────────────────────────────────
// Right sidebar — employees with 2+ strikes, ranked highest first.

function renderAtRisk() {
  // Filter and sort
  const atRisk = (dashData.monthly || [])
    .filter(e => e.lateCount >= 2)
    .sort((a, b) => b.lateCount - a.lateCount);

  document.getElementById('atRiskCount').textContent = `${atRisk.length} employees`;

  const container = document.getElementById('atRiskList');

  if (!atRisk.length) {
    container.innerHTML = '<div style="padding:16px 20px;font-size:12px;color:var(--muted)">No employees at risk</div>';
    return;
  }

  container.innerHTML = atRisk.map((emp, i) => `
    <div class="risk-item">
      <span class="risk-rank">#${i + 1}</span>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500">${emp.name}</div>
        <div style="font-size:11px;color:var(--muted)">${emp.dept}</div>
      </div>
      <div>
        <div class="risk-count ${emp.lateCount >= 3 ? 'red' : 'amber'}">${emp.lateCount}</div>
        <div style="font-size:10px;color:var(--muted);text-align:right">strikes</div>
      </div>
    </div>`).join('');
}


// ── 8. RENDER: TREND CHART ───────────────────────────────────
// 7-day bar chart — each bar = number of late arrivals that day.
// The last bar (today) is highlighted in amber.

function renderTrend() {
  const trend = dashData.trend || [];
  const max   = Math.max(...trend.map(t => t.count), 1); // avoid divide-by-zero

  document.getElementById('trendBars').innerHTML = trend.map((t, i) => {
    const barHeight = Math.max(Math.round((t.count / max) * 72), 4); // min 4px
    const isToday   = (i === trend.length - 1);

    return `
      <div class="trend-bar-wrap">
        <div class="trend-count">${t.count || ''}</div>
        <div class="trend-bar ${isToday ? 'today' : ''}" style="height:${barHeight}px"></div>
        <div class="trend-label">${t.day}</div>
      </div>`;
  }).join('');
}


// ── 9. RENDER: ALERTS ────────────────────────────────────────
// Shows the latest alerts in the sidebar card and the full Alerts view.

function renderAlerts() {
  const alerts    = dashData.alerts || [];
  const alertsEl  = document.getElementById('alertsList');
  const allAlertsEl = document.getElementById('allAlertsList');

  const buildRow = a => {
    // server uses 'warning' level, CSS uses 'warning' class — map correctly
    const dotClass = a.level === 'critical' ? 'critical' : 'warning';
    const msg = a.msg || '';
    const name = a.name || '';
    const body = msg.startsWith(name) ? msg.slice(name.length).trim() : msg;
    return `
    <div class="alert-item">
      <div class="alert-dot ${dotClass}"></div>
      <div class="alert-msg"><strong>${name}</strong> ${body}</div>
      <div class="alert-time">${a.time || ''}</div>
    </div>`;
  };

  // Sidebar shows latest 6 only
  if (!alerts.length) {
    alertsEl.innerHTML = '<div style="padding:16px 20px;font-size:12px;color:var(--muted)">No alerts</div>';
  } else {
    alertsEl.innerHTML = alerts.slice(0, 6).map(buildRow).join('');
  }

  // Full alerts view shows everything
  if (allAlertsEl) {
    allAlertsEl.innerHTML = alerts.length
      ? alerts.map(buildRow).join('')
      : '<div style="padding:16px 20px;font-size:12px;color:var(--muted)">No alerts yet</div>';
  }
}


// ── 10. RENDER: DEPARTMENT CHART ─────────────────────────────
// Horizontal bar chart — total late count per department.

function renderDeptChart() {
  // Sum up late counts per department from the monthly data
  const deptTotals = {};
  (dashData.monthly || []).forEach(emp => {
    // Shorten long department names for the chart label
    const label = emp.dept === 'Engineering' ? 'Eng'
                : emp.dept === 'Marketing'   ? 'Mktg'
                : emp.dept === 'Finance'     ? 'Fin'
                : emp.dept;                   // HR, Sales — keep as-is

    deptTotals[label] = (deptTotals[label] || 0) + emp.lateCount;
  });

  const max    = Math.max(...Object.values(deptTotals), 1);
  const deptEl = document.getElementById('deptChart');
  deptEl.style.padding = '16px 20px';

  if (!Object.keys(deptTotals).length) {
    deptEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0">No department data yet</div>';
    return;
  }

  deptEl.innerHTML =
    `<div style="display:flex;align-items:flex-end;gap:10px;height:90px">` +
    Object.entries(deptTotals).map(([dept, count]) => {
      const barH = Math.max(Math.round((count / max) * 65), 4);
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
          <div style="font-size:10px;color:var(--muted);font-family:var(--mono);font-weight:500">${count}</div>
          <div style="height:${barH}px;width:100%;background:#7c6fcd;border-radius:3px 3px 0 0"></div>
          <div style="font-size:10px;color:var(--muted)">${dept}</div>
        </div>`;
    }).join('') +
    `</div>`;
}


// ── 11. RENDER: MONTHLY LATE COUNTER ─────────────────────────
// Bottom-right table — employees who have been late at least once this month.

function renderMonthly() {
  // Show current month/year in the card header badge
  const month = `${new Date().toLocaleString('default', { month: 'long' })} ${new Date().getFullYear()}`;
  document.getElementById('monthLabel').textContent = month;

  const tbody = document.getElementById('monthlyBody');

  // Show only employees with at least 1 strike, sorted worst-first
  const lateEmployees = (dashData.monthly || [])
    .filter(e => e.lateCount > 0)
    .sort((a, b) => b.lateCount - a.lateCount);

  if (!lateEmployees.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center;padding:20px">No late arrivals this month</td></tr>';
    return;
  }

  tbody.innerHTML = lateEmployees.map(emp => {
    const status      = emp.lateCount >= 3 ? 'critical' : emp.lateCount >= 2 ? 'risk' : 'safe';
    const statusLabel = emp.lateCount >= 3 ? 'Critical' : emp.lateCount >= 2 ? 'At Risk' : 'Safe';
    const countColor  = emp.lateCount >= 3 ? 'var(--red)' : 'var(--amber)';

    return `
      <tr>
        <td><div style="font-weight:500">${emp.name}</div></td>
        <td><div style="font-size:11px;color:var(--muted)">${emp.dept}</div></td>
        <td><div style="font-family:var(--mono);font-size:14px;font-weight:600;color:${countColor}">${emp.lateCount}</div></td>
        <td><span class="badge badge-${status}">${statusLabel}</span></td>
      </tr>`;
  }).join('');
}


// ── 12. WEBCAM ───────────────────────────────────────────────
// Opens/closes the camera and captures a photo on submit.
// instance = 1 → modal overlay  |  instance = 2 → attendance view

async function startCam(videoElementId) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 },
      audio: false,
    });
    document.getElementById(videoElementId).srcObject = stream;
  } catch (e) {
    alert('Camera access denied. Please allow camera access in your browser.');
  }
}

function stopCam() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
}

// Open the floating modal and start the camera
function openCam() {
  document.getElementById('camModal').classList.add('open');
  document.getElementById('flash1').style.display = 'none';
  startCam('webcamVideo');
}

// Close the modal and stop the camera stream
function closeCam() {
  document.getElementById('camModal').classList.remove('open');
  stopCam();
}

// Toggle the selected state of IN/OUT punch buttons
function selectPunch(type, instance) {
  punchState[instance] = type;
  if (instance === 1) {
    document.getElementById('punchIn').classList.toggle('selected',  type === 'IN');
    document.getElementById('punchOut').classList.toggle('selected', type === 'OUT');
  } else {
    document.getElementById('punchIn2').classList.toggle('selected',  type === 'IN');
    document.getElementById('punchOut2').classList.toggle('selected', type === 'OUT');
  }
}

// Capture a frame from the video and POST it to the server
function snapAndSubmit(instance) {
  // Determine which elements belong to this modal instance
  const selectId = instance === 1 ? 'empSelect'   : 'empSelect2';
  const videoId  = instance === 1 ? 'webcamVideo' : 'webcamVideo2';
  const canvasId = instance === 1 ? 'snapCanvas'  : 'snapCanvas2';
  const flashId  = instance === 1 ? 'flash1'      : 'flash2';

  const empId = document.getElementById(selectId).value;
  if (!empId) { alert('Please select an employee'); return; }

  // Draw a single frame from the video onto an invisible canvas, then export as JPEG
  const video  = document.getElementById(videoId);
  const canvas = document.getElementById(canvasId);
  canvas.width  = video.videoWidth  || 320;
  canvas.height = video.videoHeight || 240;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const photoBase64 = canvas.toDataURL('image/jpeg', 0.6);

  // Send to server
  fetch('/api/mark-attendance', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ employeeId: empId, photo: photoBase64, punchStatus: punchState[instance] }),
  })
  .then(r => r.json())
  .then(data => {
    const flash = document.getElementById(flashId);

    if (data.error) {
      flash.textContent       = 'Error: ' + data.error;
      flash.style.background  = '#2d0a0a';
      flash.style.color       = 'var(--red)';
    } else {
      // Show different message depending on whether they were late
      flash.textContent = data.record.late === 'YES'
        ? '✓ Marked! Employee is late — warning email sent.'
        : '✓ Attendance marked successfully!';
      flash.style.background = '#052e16';
      flash.style.color      = 'var(--green)';
    }

    flash.style.display = 'block';
    setTimeout(() => { flash.style.display = 'none'; }, 3500);
    loadDashboard();  // refresh the dashboard to show updated data
  })
  .catch(e => { alert('Error: ' + e.message); });
}


// ── 13. EXCUSE TOGGLE ────────────────────────────────────────
// Marks an employee as excused (or un-excused) via the server.

async function toggleExcuse(empId, btn) {
  const response = await fetch('/api/excuse', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ employeeId: empId }),
  });
  const data = await response.json();

  // Update the button text and style immediately (no need to reload)
  btn.textContent = data.excused ? 'Excused' : 'Excuse';
  btn.classList.toggle('excused', data.excused);

  loadDashboard(); // then fully refresh so stats update too
}


// ── 14. EXCEL UPLOAD ─────────────────────────────────────────
// Sends a .xlsx file to the server for bulk attendance import.
// The server forwards it to the n8n Webhook Node (Step 1 of pipeline).

async function uploadExcel(input) {
  const file = input.files[0];
  if (!file) return;

  // Validate file type before sending
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    setUploadResult('error', '✗ Please select a .xlsx or .xls file.');
    return;
  }

  setUploadResult('loading', '⏳ Uploading and processing...');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch('/api/upload-excel', { method: 'POST', body: formData });

    let data;
    try {
      data = await response.json();
    } catch (_) {
      setUploadResult('error',
        '✗ Server returned no JSON. Run: npm install && node server.js'
      );
      return;
    }

    if (!response.ok || data.error) {
      setUploadResult('error', '✗ ' + (data.error || 'Upload failed (HTTP ' + response.status + ')'));
      return;
    }

    setUploadResult('success',
      `✓ ${data.processed} records processed` +
      (data.skipped ? ` · ${data.skipped} rows skipped` : '') +
      ' — dashboard updated!'
    );

    input.value = '';       // reset input so same file can be re-uploaded
    await loadDashboard();  // refresh all panels

  } catch (e) {
    setUploadResult('error',
      '✗ Cannot reach server: ' + e.message +
      ' — make sure server.js is running on port 3000.'
    );
  }
}

// Helper: update the upload result box with colour + message
function setUploadResult(type, message) {
  const el = document.getElementById('uploadResult');
  if (!el) return;
  el.textContent = message;
  if (type === 'success') {
    el.style.color      = 'var(--green)';
    el.style.background = 'rgba(52,211,153,0.08)';
    el.style.border     = '1px solid rgba(52,211,153,0.25)';
  } else if (type === 'error') {
    el.style.color      = 'var(--red)';
    el.style.background = 'rgba(248,113,113,0.08)';
    el.style.border     = '1px solid rgba(248,113,113,0.25)';
  } else {
    el.style.color      = 'var(--muted)';
    el.style.background = 'var(--bg3)';
    el.style.border     = '1px solid var(--border)';
  }
}

// Trigger a file download of the current attendance data as Excel
function downloadExcel() {
  window.location = '/api/download-excel';
}


// ── 15. VIEW SWITCHER ────────────────────────────────────────
// Called by each nav-item in the sidebar. Shows the matching view
// and hides all others.

function switchView(view, clickedNavItem) {
  // Hide all view panels
  document.querySelectorAll('.view-content').forEach(v => v.classList.remove('active'));
  // Remove .active from all nav items
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Show the requested view and highlight the nav item
  document.getElementById('view-' + view).classList.add('active');
  clickedNavItem.classList.add('active');

  // Update the page title in the top bar
  const titles = {
    dashboard:  "TODAY'S OVERVIEW",
    attendance: 'TAKE ATTENDANCE',
    upload:     'UPLOAD EXCEL',
    alerts:     'ALERTS & NOTIFICATIONS',
  };
  document.getElementById('pageTitle').textContent = titles[view] || '';

  // Start the camera automatically when navigating to the attendance view
  if (view === 'attendance') {
    startCam('webcamVideo2');
  } else if (stream && !document.getElementById('camModal').classList.contains('open')) {
    stopCam(); // stop camera when leaving the attendance view (unless modal is open)
  }
}


// ── 16. HELPERS ──────────────────────────────────────────────

// Converts a time string to a clean "HH:MM AM/PM" display format.
// Handles both ISO timestamps ("2026-03-21T09:40:00") and
// plain time strings ("09:40 AM" or "11:00").
function formatTime(t) {
  if (!t || t === 'MISSING') return '—';

  const s = String(t).trim().toUpperCase();

  // Already in 12-hour format — just clean up any extra spaces
  if (s.includes('AM') || s.includes('PM')) {
    return s.replace(/\s+/g, ' ').replace(/(\d)(AM|PM)/, '$1 $2');
  }

  // ISO timestamp or 24-hour string — convert to 12-hour
  const timePart = s.includes('T') ? s.split('T')[1] : s;  // strip date if present
  const parts    = timePart.split(':');
  if (parts.length < 2) return t;

  let hours       = parseInt(parts[0], 10);
  const minutes   = parts[1].substring(0, 2).padStart(2, '0');
  const ampm      = hours >= 12 ? 'PM' : 'AM';
  if (hours > 12) hours -= 12;
  if (hours === 0) hours = 12;

  return `${hours}:${minutes} ${ampm}`;
}


// ── Drag-and-drop upload ──────────────────────────────────────
// Called by ondrop on the upload zone in index.html
function handleDrop(event) {
  event.preventDefault();
  document.getElementById('dropZone').style.borderColor = '';

  const file = event.dataTransfer.files[0];
  if (!file) return;

  // Create a fake input object so uploadExcel() can handle it the same way
  uploadExcel({ files: [file], value: file.name });
}


// ── Download blank Excel template ────────────────────────────
// Lets HR download a properly structured template to fill in.
// Uses the server's download endpoint if data exists,
// otherwise builds a blank template in the browser.
function downloadTemplate() {
  const link = document.createElement('a');

  // Build a CSV that Excel opens natively — no library needed
  const headers = ['Employee ID', 'Name', 'Department', 'Date', 'Time', 'Punch Status', 'Email'];
  const example = [
    ['EMP-001', 'Jane Doe',   'Engineering', '2025-07-01', '09:15', 'IN',  'jane@company.com'],
    ['EMP-001', 'Jane Doe',   'Engineering', '2025-07-01', '18:00', 'OUT', 'jane@company.com'],
    ['EMP-002', 'John Smith', 'Marketing',   '2025-07-01', '11:30', 'IN',  'john@company.com'],
    ['EMP-002', 'John Smith', 'Marketing',   '2025-07-01', '17:45', 'OUT', 'john@company.com'],
  ];

  const csv = [headers, ...example]
    .map(row => row.map(cell => `"${cell}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  link.href   = URL.createObjectURL(blob);
  link.download = 'attendance_template.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}
