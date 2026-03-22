// ============================================================
//  FILE: dashboard.js
//  PURPOSE: All logic for dashboard.html
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
//      • Earliest IN  punch of the day  → checkin  (HH:MM AM/PM)
//      • Latest   OUT punch of the day  → checkout (HH:MM AM/PM)
//      • checkin after 11:00 AM         → late = true
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
//      const checkIn  = ins.length  ? ins.sort()[0]             : null;
//      const checkOut = outs.length ? outs.sort().reverse()[0]  : null;
//      const late     = checkIn ? checkIn.slice(0,5) > '11:00' : false;
//      return { json: { ...g, checkIn, checkOut, late, punches: undefined } };
//    });
//    ─────────────────────────────────────────────────────────
//
//  Step 3 — Google Sheets / MySQL Node
//    Structure 1 (Google Sheets):
//      Action : Append Row
//      Sheet  : "Attendance"
//      Columns: id | name | dept | date | checkin | checkout |
//               late | strikes
//    Structure 2 (MySQL):
//      Action : Execute Query (UPSERT)
//      Query  : INSERT INTO attendance (...) VALUES (...)
//               ON DUPLICATE KEY UPDATE checkin=VALUES(checkin), ...
//
//  Step 4 — Google Calendar Node
//    Condition : strikes === 3  (exactly on the 3rd strike)
//    Action    : Create Event
//      Title   : "HR Meeting – {{ $json.name }}"
//      Date    : {{ $json.date }}
//      Start   : 17:00   End: 17:30
//      Description: "3rd late strike — mandatory HR review."
//
//  The `employees` array below is intentionally EMPTY.
//  Records are inserted by the n8n pipeline above and loaded
//  from GET /api/employees (or Google Sheets / MySQL directly).
//
//  SECTIONS (in order):
//    1. Employee data          — empty; filled via pipeline
//    2. Helper functions       — small reusable calculations
//    3. Render: table          — draws the main employee rows
//    4. Render: KPI cards      — updates the 4 summary numbers
//    5. Render: At-risk list   — right-sidebar ranked list
//    6. Render: Alerts feed    — bottom-left alert messages
//    7. Render: Trend chart    — 7-day bar chart
//    8. Render: Dept chart     — per-department bar chart
//    9. Init                   — runs on page load
// ============================================================


// ── 1. EMPLOYEE DATA ─────────────────────────────────────────
// Intentionally empty — records are inserted via the n8n pipeline.
// Fields (once populated by pipeline):
//   id       — unique employee ID string
//   name     — display name
//   init     — 2-letter initials for the avatar circle
//   dept     — department label
//   checkin  — today's check-in time (string, e.g. "11:42 AM")
//   late     — true if they arrived after 11:00 AM
//   strikes  — how many late arrivals they have this month
//   excused  — true once the HR "Excuse" button has been clicked

var employees = [];  // populated at runtime via webhook pipeline

// Colour palette for avatar circles — cycles through if more than 9 employees
var avatarPalette = [
  ['#312E81', '#818CF8'],   // indigo
  ['#064E3B', '#34D399'],   // emerald
  ['#7C2D12', '#FB923C'],   // orange
  ['#831843', '#F472B6'],   // pink
  ['#1E1B4B', '#A78BFA'],   // violet
  ['#134E4A', '#2DD4BF'],   // teal
  ['#713F12', '#FCD34D'],   // yellow
  ['#4C1D95', '#C084FC'],   // purple
  ['#042F2E', '#5EEAD4'],   // cyan
];


// ── 2. HELPER FUNCTIONS ──────────────────────────────────────

// Returns [bgColour, textColour] for the avatar circle at position i
function avatarColor(i) {
  return avatarPalette[i % avatarPalette.length];
}

// If an employee has been excused, their strike count drops by 1 (min 0)
function effectiveStrikes(emp) {
  return emp.excused ? Math.max(0, emp.strikes - 1) : emp.strikes;
}

// Returns the right badge label + CSS class based on how many strikes
function statusBadge(strikes) {
  if (strikes >= 3) return { label: 'Critical', cls: 'badge-critical' };
  if (strikes === 2) return { label: 'At Risk',  cls: 'badge-risk' };
  return { label: 'Safe', cls: 'badge-safe' };
}

// Returns the correct dot CSS class for position i in the 3-dot row
function dotClass(dotIndex, totalStrikes) {
  if (dotIndex >= totalStrikes) return 'dot dot-empty';    // unfilled
  if (totalStrikes >= 3) return 'dot dot-critical';        // red
  if (totalStrikes === 2) return 'dot dot-risk';           // amber
  return 'dot dot-safe';                                   // green
}


// ── 3. RENDER: EMPLOYEE TABLE ────────────────────────────────
// Builds every row in the "All Employees — Strike Status" table.
// Called on page load and after any "Excuse" action.

function renderTable() {
  var tbody = document.getElementById('emp-tbody');
  tbody.innerHTML = ''; // clear old rows before redrawing

  if (!employees.length) {
    tbody.innerHTML =
      '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px 20px;font-size:13px">' +
      'No employee records yet.<br>' +
      '<span style="font-size:11px">Upload an Excel file via the n8n webhook pipeline to populate this table.</span>' +
      '</td></tr>';
    updateKPIs();
    renderRiskList();
    renderAlerts();
    return;
  }

  employees.forEach(function(emp, idx) {
    var colors = avatarColor(idx);
    var eff    = effectiveStrikes(emp);
    var status = statusBadge(eff);

    // Build the 3 strike dots
    var dots = [0, 1, 2].map(function(i) {
      return '<div class="' + dotClass(i, eff) + '"></div>';
    }).join('');

    // Show "Excuse" button, or a crossed-out "Excused" label if already done
    var actionBtn = emp.excused
      ? '<span class="btn-excuse done">Excused</span>'
      : '<button class="btn-excuse" onclick="excuse(' + idx + ')">Excuse</button>';

    // Add a small "excused" tag next to the name if applicable
    var nameCell = emp.name + (emp.excused ? '<span class="excused-tag">excused</span>' : '');

    // Highlight the check-in time in amber if the employee was late (and not excused)
    var timeColor = (emp.late && !emp.excused) ? 'var(--warn)' : 'var(--muted)';

    var row = document.createElement('tr');
    row.innerHTML =
      '<td>' +
        '<div class="avatar-wrap">' +
          '<div class="avatar" style="background:' + colors[0] + '; color:' + colors[1] + '">' + emp.init + '</div>' +
          '<div>' +
            '<div class="emp-name">' + nameCell + '</div>' +
            '<div class="emp-meta">' + emp.id + ' · ' + emp.dept + '</div>' +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td style="font-family:var(--mono); font-size:12px; color:' + timeColor + '">' + emp.checkin + '</td>' +
      '<td><div class="dots">' + dots + '</div></td>' +
      '<td><span class="badge ' + status.cls + '">' + status.label + '</span></td>' +
      '<td>' + actionBtn + '</td>';

    tbody.appendChild(row);
  });

  // After the table is redrawn, refresh the cards and sidebar too
  updateKPIs();
  renderRiskList();
  renderAlerts();
}

// Called when HR clicks "Excuse" on a row — marks the employee excused and redraws
function excuse(idx) {
  employees[idx].excused = true;
  renderTable();
}


// ── 4. RENDER: KPI CARDS ─────────────────────────────────────
// Updates the 4 summary numbers at the top of the page.

function updateKPIs() {
  var total    = employees.length;
  var lateCount = employees.filter(function(e) { return e.late && !e.excused; }).length;
  var ontime   = total - lateCount;
  var critical = employees.filter(function(e) { return effectiveStrikes(e) >= 3; }).length;

  // Update number labels
  document.getElementById('kpi-total').textContent    = total;
  document.getElementById('kpi-ontime').textContent   = ontime;
  document.getElementById('kpi-late').textContent     = lateCount;
  document.getElementById('kpi-critical').textContent = critical;

  // Update percentage subtitles
  document.getElementById('sub-ontime').textContent = total > 0 ? Math.round(ontime / total * 100) + '% of staff' : '—';
  document.getElementById('sub-late').textContent   = total > 0 ? Math.round(lateCount / total * 100) + '% of staff' : '—';

  // Update the thin progress bars inside each card
  document.getElementById('bar-total').style.width  = '100%';
  document.getElementById('bar-ontime').style.width = total > 0 ? Math.round(ontime / total * 100) + '%' : '0%';
  document.getElementById('bar-late').style.width   = total > 0 ? Math.round(lateCount / total * 100) + '%' : '0%';
  document.getElementById('bar-crit').style.width   = total > 0 ? Math.max(Math.round(critical / total * 100) * 4, critical > 0 ? 5 : 0) + '%' : '0%';

  document.getElementById('emp-count-badge').textContent = total + ' employees';
}


// ── 5. RENDER: AT-RISK LIST ──────────────────────────────────
// Right sidebar — shows only employees with 2+ strikes, ranked by count.

function renderRiskList() {
  // Filter to 2+ strikes, highest first
  var atRisk = employees
    .filter(function(e) { return effectiveStrikes(e) >= 2; })
    .sort(function(a, b) { return effectiveStrikes(b) - effectiveStrikes(a); });

  document.getElementById('risk-badge').textContent = atRisk.length + ' employees';

  if (!atRisk.length) {
    document.getElementById('risk-list').innerHTML =
      '<div style="padding:16px 20px;font-size:12px;color:var(--muted)">No employees at risk</div>';
    return;
  }

  var html = '';
  atRisk.forEach(function(emp, i) {
    var eff = effectiveStrikes(emp);
    var numClass = eff >= 3 ? 'red' : 'amber'; // colour the number

    html +=
      '<div class="risk-item">' +
        '<span class="risk-rank">#' + (i + 1) + '</span>' +
        '<div class="risk-info">' +
          '<div class="risk-name">' + emp.name + '</div>' +
          '<div class="risk-dept">' + emp.dept + '</div>' +
        '</div>' +
        '<div class="risk-count-wrap">' +
          '<span class="risk-num ' + numClass + '">' + eff + '</span>' +
          '<span class="risk-sub">strikes</span>' +
        '</div>' +
      '</div>';
  });

  document.getElementById('risk-list').innerHTML = html;
}


// ── 6. RENDER: ALERTS FEED ───────────────────────────────────
// Bottom-left panel — one message per critical/at-risk/excused employee.
// Google Calendar events are auto-created by the n8n pipeline (Step 4)
// when an employee hits exactly 3 strikes.

function renderAlerts() {
  var critical = employees.filter(function(e) { return effectiveStrikes(e) >= 3; });
  var atRisk   = employees.filter(function(e) { return effectiveStrikes(e) === 2; });
  var excused  = employees.filter(function(e) { return e.excused; });

  var items = [];

  // Critical employees get a red alert
  critical.forEach(function(e) {
    items.push({
      color: 'var(--danger)',
      text:  '<strong>' + e.name + '</strong> hit 3 strikes. HR meeting booked at 5:00 PM via Google Calendar.',
      time:  '09:42'
    });
  });

  // At-risk employees get an amber warning
  atRisk.forEach(function(e) {
    items.push({
      color: 'var(--warn)',
      text:  '<strong>' + e.name + '</strong> is at 2 strikes — next one triggers a mandatory meeting.',
      time:  '09:15'
    });
  });

  // Excused employees get a green info note
  excused.forEach(function(e) {
    items.push({
      color: 'var(--safe)',
      text:  '<strong>' + e.name + '\'s</strong> latest late has been excused.',
      time:  'now'
    });
  });

  // Fallback when there's nothing to show
  if (items.length === 0) {
    items.push({ color: 'var(--muted)', text: 'No active alerts. Data will appear once the pipeline runs.', time: '' });
  }

  var html = items.map(function(a) {
    return '<div class="alert-row">' +
      '<div class="alert-dot" style="background:' + a.color + '"></div>' +
      '<div class="alert-text">' + a.text + '</div>' +
      (a.time ? '<span class="alert-time">' + a.time + '</span>' : '') +
    '</div>';
  }).join('');

  document.getElementById('alerts-feed').innerHTML = html;
}


// ── 7. RENDER: TREND CHART ───────────────────────────────────
// 7-day bar chart in the right sidebar.
// Counts are derived from `employees` data when available.

function renderTrend() {
  var days   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var counts = [0, 0, 0, 0, 0, 0, 0];  // populated by pipeline data
  var max    = Math.max.apply(null, counts.concat([1]));  // avoid divide-by-zero
  var todayIdx = new Date().getDay();   // 0=Sun…6=Sat; adjust to Mon=0 index
  todayIdx = todayIdx === 0 ? 6 : todayIdx - 1;

  var html = days.map(function(day, i) {
    var heightPct = max > 0 ? (counts[i] / max * 100) : 0;
    var isToday   = (i === todayIdx);

    var barColor    = isToday ? 'var(--warn)'   : 'var(--surface2)';
    var borderColor = isToday ? 'var(--warn)'   : 'var(--border2)';
    var labelColor  = isToday ? 'var(--warn)'   : 'var(--muted)';

    return '<div class="bar-col">' +
      '<div class="bar-count" style="color:' + labelColor + '">' + (counts[i] > 0 ? counts[i] : '') + '</div>' +
      '<div class="bar-fill" style="height:' + Math.max(heightPct, 5) + '%; background:' + barColor + '; border: 1px solid ' + borderColor + '"></div>' +
      '<div class="bar-label">' + day + '</div>' +
    '</div>';
  }).join('');

  document.getElementById('trend-chart').innerHTML = html;
}


// ── 8. RENDER: DEPARTMENT CHART ──────────────────────────────
// Bottom-right chart — late count per department.
// Calculated from the live `employees` array.

function renderDepts() {
  // Aggregate late counts per department from live data
  var deptMap = {};
  employees.forEach(function(emp) {
    var label = emp.dept === 'Engineering' ? 'Eng'
              : emp.dept === 'Marketing'   ? 'Mktg'
              : emp.dept === 'Finance'     ? 'Fin'
              : emp.dept;
    if (!deptMap[label]) deptMap[label] = 0;
    if (emp.late && !emp.excused) deptMap[label]++;
  });

  var depts = Object.keys(deptMap).map(function(name) {
    return { name: name, late: deptMap[name] };
  });

  if (!depts.length) {
    document.getElementById('dept-chart').innerHTML =
      '<div style="width:100%;display:flex;align-items:center;justify-content:center;height:100px;font-size:12px;color:var(--muted)">No department data yet</div>';
    return;
  }

  var max = Math.max.apply(null, depts.map(function(d) { return d.late; }).concat([1]));

  var html = depts.map(function(d) {
    var heightPct = max > 0 ? (d.late / max * 100) : 0;
    var opacity   = 0.4 + heightPct / 160;

    return '<div class="bar-col">' +
      '<div class="bar-count" style="color:var(--muted)">' + d.late + '</div>' +
      '<div class="bar-fill" style="height:' + Math.max(heightPct, 5) + '%; background:var(--accent); opacity:' + opacity + '"></div>' +
      '<div class="bar-label">' + d.name + '</div>' +
    '</div>';
  }).join('');

  document.getElementById('dept-chart').innerHTML = html;
}


// ── 9. INIT ───────────────────────────────────────────────────
// Everything below runs once when the page first loads.

// Show today's date in the top-right pill
function setDate() {
  document.getElementById('today-date').textContent =
    new Date().toLocaleDateString('en-IN', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
    });
}

// Count down to the next auto-refresh (every 60 seconds)
var countdown = 60;
setInterval(function() {
  countdown--;
  if (countdown < 0) {
    countdown = 60;
    renderTable(); // simulates a data refresh
  }
  document.getElementById('countdown').textContent = countdown;
}, 1000);

// Kick off all renders
setDate();
renderTable();   // also calls updateKPIs, renderRiskList, renderAlerts
renderTrend();
renderDepts();
