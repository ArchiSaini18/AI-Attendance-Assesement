'use strict';

// ============================================================
//  server.js — HR Attendance Backend
//
//  HOW TO RUN:
//    1. npm install
//    2. Copy .env.example to .env and fill in your values
//    3. node server.js
//    4. Open http://localhost:3000
//
//  ENVIRONMENT VARIABLES (.env file):
//    PORT=3000
//    EMAIL_USER=yourname@gmail.com
//    EMAIL_PASS=your_gmail_app_password
//    EMAIL_FROM=HR System <yourname@gmail.com>
//    GROQ_API_KEY=gsk_...
//    GOOGLE_CLIENT_EMAIL=...    (optional — for real Calendar events)
//    GOOGLE_PRIVATE_KEY=...     (optional — for real Calendar events)
// ============================================================

require('dotenv').config();

const express    = require('express');
const multer     = require('multer');
const XLSX       = require('xlsx');
const cors       = require('cors');
const path       = require('path');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ── Multer ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx or .xls files are accepted'), false);
    }
  },
});

// ── In-memory store ───────────────────────────────────────────
let employeeMap = {};
let alerts      = [];
let trendCounts = [0, 0, 0, 0, 0, 0, 0]; // Mon–Sun

// ── Email setup ───────────────────────────────────────────────
let mailer = null;

function getMailer() {
  if (mailer) return mailer;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[email] EMAIL_USER or EMAIL_PASS not set — emails disabled');
    return null;
  }
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  return mailer;
}

// ── Helpers ───────────────────────────────────────────────────
function to12hr(t) {
  if (!t) return null;
  const parts = String(t).trim().split(':');
  let h = parseInt(parts[0], 10);
  const m = (parts[1] || '00').slice(0, 2);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function isLate(timeStr) {
  if (!timeStr) return false;
  return String(timeStr).trim() > '11:00';
}

function dayIndex(dateStr) {
  const d = new Date(dateStr).getDay();
  return d === 0 ? 6 : d - 1;
}

function sendError(res, status, msg) {
  return res.status(status).json({ error: msg });
}

// ── Google Calendar event (stub — enable with env vars) ───────
async function createCalendarEvent(empName, dateStr) {
  // When GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY are set,
  // uncomment the block below and install: npm install googleapis
  //
  // const { google } = require('googleapis');
  // const auth = new google.auth.JWT(
  //   process.env.GOOGLE_CLIENT_EMAIL, null,
  //   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  //   ['https://www.googleapis.com/auth/calendar']
  // );
  // const cal = google.calendar({ version: 'v3', auth });
  // const event = await cal.events.insert({
  //   calendarId: 'primary',
  //   requestBody: {
  //     summary: `HR Meeting - ${empName}`,
  //     description: '3rd late strike — mandatory HR review.',
  //     start: { dateTime: `${dateStr}T17:00:00`, timeZone: 'Asia/Kolkata' },
  //     end:   { dateTime: `${dateStr}T17:30:00`, timeZone: 'Asia/Kolkata' },
  //   },
  // });
  // return event.data.htmlLink;

  // Fallback: pre-filled Google Calendar link
  const d = dateStr.replace(/-/g, '');
  return `https://calendar.google.com/calendar/r/eventedit?text=HR+Meeting+-+${encodeURIComponent(empName)}&dates=${d}T170000/${d}T173000&details=3rd+late+strike+mandatory+HR+review`;
}

// ── AI warning email via Groq ────────────────────────────────
async function generateWarningEmail(emp, strike, calendarLink) {
  const apiKey = process.env.GROQ_API_KEY;
  const strikeLabel = strike === 1 ? '1st' : strike === 2 ? '2nd' : '3rd';
  const calNote = calendarLink
    ? `\n\nA mandatory HR meeting has been scheduled for today at 5:00 PM.\nCalendar link: ${calendarLink}`
    : '';

  if (!apiKey) {
    // Plain fallback — no API key set, use static templates
    let body = '';
    if (strike === 1) {
      body = `Hi ${emp.name},\n\nThis is a friendly reminder that your check-in today was recorded after 11:00 AM. This is your 1st late arrival this month.\n\nPlease make sure to arrive on time going forward.\n\nRegards,\nHR Team`;
    } else if (strike === 2) {
      body = `Hi ${emp.name},\n\nThis is your 2nd late arrival this month. Please note that one more late check-in will trigger a mandatory HR meeting.\n\nPlease treat this as a formal warning.\n\nRegards,\nHR Team`;
    } else {
      body = `Hi ${emp.name},\n\nYou have reached 3 late arrivals this month. A mandatory HR meeting has been scheduled.${calNote}\n\nPlease confirm your attendance.\n\nRegards,\nHR Team`;
    }
    return { subject: `Late Arrival Warning — ${strikeLabel} Strike`, body };
  }

  // Groq API — OpenAI-compatible, very fast (free tier available)
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: 'You are an HR assistant. Write professional, concise warning emails. Always return valid JSON only — no markdown, no extra text.',
          },
          {
            role: 'user',
            content: `Write a professional HR warning email for an employee who arrived late to work.

Employee: ${emp.name}, Department: ${emp.dept}
Strike: ${strikeLabel} out of 3 this month
Check-in time today: ${emp.checkIn || 'not recorded'}
${calendarLink ? 'Calendar meeting link: ' + calendarLink : ''}

Tone rules:
- 1st strike: warm and friendly reminder, encouraging tone
- 2nd strike: firm but respectful, mention one more will trigger a mandatory meeting
- 3rd strike: serious and direct, confirm 5 PM HR meeting is mandatory, include the calendar link

Return ONLY this JSON object, nothing else:
{"subject": "...", "body": "..."}`,
          },
        ],
      }),
    });

    const data = await res.json();

    if (data.error) {
      throw new Error(data.error.message || 'Groq API returned an error');
    }

    const text = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);

    // Make sure calendar link is in the body for 3rd strike
    const body = parsed.body + (strike >= 3 && calendarLink && !parsed.body.includes(calendarLink) ? calNote : '');
    return { subject: parsed.subject, body };
  } catch (e) {
    console.warn('[AI email] Groq call failed, using plain template:', e.message);
    return {
      subject: `Late Arrival Warning — ${strikeLabel} Strike`,
      body: `Hi ${emp.name},\n\nThis is your ${strikeLabel} late arrival warning this month.${calNote}\n\nRegards,\nHR Team`,
    };
  }
}

// ── Send warning email ────────────────────────────────────────
async function sendWarningEmail(emp, strike, date) {
  const transport = getMailer();
  if (!transport) return;

  // If the email is still the placeholder, skip actual SMTP send
  if (!emp.email || emp.email.endsWith('@company.com')) {
    console.log(`[email] Placeholder email for ${emp.name} — skipping SMTP. Assign real email to send.`);
    return;
  }

  let calendarLink = null;
  if (strike >= 3) {
    calendarLink = await createCalendarEvent(emp.name, date);
  }

  const { subject, body } = await generateWarningEmail(emp, strike, calendarLink);

  try {
    await transport.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to:   emp.email,
      subject,
      text: body,
    });
    console.log(`[email] Sent ${strike}-strike warning to ${emp.email}`);
  } catch (e) {
    console.error(`[email] Failed for ${emp.email}:`, e.message);
  }
}

// ── Process Excel buffer ──────────────────────────────────────
async function processExcelBuffer(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (e) {
    throw new Error('Cannot parse Excel file: ' + e.message);
  }

  const sheetName = wb.SheetNames.includes('Attendance')
    ? 'Attendance'
    : wb.SheetNames[0];
  if (!sheetName) throw new Error('Excel file has no sheets');

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  if (!rows.length) throw new Error(`Sheet "${sheetName}" has no data rows`);

  // Auto-detect columns (case-insensitive, handles spaces/underscores)
  const COL = {};
  for (const k of Object.keys(rows[0])) {
    const n = k.toLowerCase().replace(/[\s_\-]/g, '');
    if (n.includes('employeeid') || n === 'id')                      COL.id   = k;
    if (n.includes('employeename') || n === 'name')                  COL.name = k;
    if (n.includes('department') || n === 'dept')                    COL.dept = k;
    if (n === 'date')                                                 COL.date = k;
    if (n === 'time')                                                 COL.time = k;
    if (n.includes('punch') || n.includes('type') || n === 'status') COL.type = k;
    if (n.includes('email'))                                          COL.email = k;
  }

  const missing = ['id', 'name', 'dept', 'date', 'time', 'type'].filter(c => !COL[c]);
  if (missing.length) {
    throw new Error(
      'Missing columns: ' + missing.join(', ') +
      '. Found columns: ' + Object.keys(rows[0]).join(', ')
    );
  }

  const groups = {};
  let skipped  = 0;

  for (const row of rows) {
    const id    = String(row[COL.id]   || '').trim();
    const name  = String(row[COL.name] || '').trim();
    const dept  = String(row[COL.dept] || '').trim();
    const date  = String(row[COL.date] || '').trim();
    const time  = String(row[COL.time] || '').trim();
    const type  = String(row[COL.type] || '').trim().toUpperCase();
    const email = COL.email ? String(row[COL.email] || '').trim() : null;

    if (!id || !date || !time || !['IN', 'OUT'].includes(type)) {
      skipped++;
      continue;
    }

    const key = id + '|' + date;
    if (!groups[key]) {
      groups[key] = { id, name, dept, date, email, ins: [], outs: [] };
    }
    if (type === 'IN')  groups[key].ins.push(time);
    if (type === 'OUT') groups[key].outs.push(time);
  }

  let processed = 0;
  const emailQueue = [];

  for (const g of Object.values(groups)) {
    const checkInRaw  = g.ins.length  ? g.ins.sort()[0]            : null;
    const checkOutRaw = g.outs.length ? g.outs.sort().slice(-1)[0] : null;

    // Edge case: missing OUT punch — keep checkout blank, log warning
    if (!checkOutRaw) {
      console.warn(`[data] No OUT punch for ${g.id} on ${g.date} — checkout left blank`);
    }

    const late     = isLate(checkInRaw);
    const checkIn  = to12hr(checkInRaw);
    const checkOut = to12hr(checkOutRaw);

    if (!employeeMap[g.id]) {
      employeeMap[g.id] = {
        id: g.id, name: g.name, dept: g.dept,
        email: g.email || (g.id.toLowerCase().replace(/[^a-z0-9]/g, '') + '@company.com'),
        checkIn: null, checkOut: null,
        late: false, lateCount: 0,
        excused: false, photo: null,
      };
    }

    const emp     = employeeMap[g.id];
    const wasLate = emp.late;

    // Update email if Excel provided a real one
    if (g.email && !g.email.endsWith('@company.com')) {
      emp.email = g.email;
    }

    emp.checkIn  = checkIn;
    emp.checkOut = checkOut;
    emp.late     = late;

    if (late && !wasLate && !emp.excused) {
      emp.lateCount++;

      const di = dayIndex(g.date);
      if (di >= 0 && di < 7) trendCounts[di]++;

      const now = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      });

      if (emp.lateCount >= 3) {
        alerts.unshift({
          name: emp.name,
          msg: `${emp.name} hit 3 strikes. HR meeting booked at 5:00 PM.`,
          level: 'critical',
          time: now,
        });
        emailQueue.push({ emp: { ...emp }, strike: 3, date: g.date });
      } else if (emp.lateCount === 2) {
        alerts.unshift({
          name: emp.name,
          msg: `${emp.name} is at 2 strikes — 1 more triggers a mandatory meeting.`,
          level: 'warning',
          time: now,
        });
        emailQueue.push({ emp: { ...emp }, strike: 2, date: g.date });
      } else if (emp.lateCount === 1) {
        emailQueue.push({ emp: { ...emp }, strike: 1, date: g.date });
      }

      if (alerts.length > 50) alerts = alerts.slice(0, 50);
    }

    processed++;
  }

  // Fire-and-forget emails (don't block the upload response)
  for (const item of emailQueue) {
    sendWarningEmail(item.emp, item.strike, item.date).catch(e => {
      console.error('[email queue error]', e.message);
    });
  }

  return { processed, skipped };
}

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

app.get('/api/employees', (_req, res) => {
  try {
    res.json(Object.values(employeeMap));
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.get('/api/dashboard', (_req, res) => {
  try {
    res.json({
      totalEmployees: Object.keys(employeeMap).length,
      onTime:    Object.values(employeeMap).filter(e => !e.late).length,
      lateToday: Object.values(employeeMap).filter(e => e.late && !e.excused).length,
      critical:  Object.values(employeeMap).filter(e => e.lateCount >= 3).length,
      trend: trendCounts.map((count, i) => ({
        day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i],
        count,
      })),
      monthly: Object.values(employeeMap).map(e => ({
        id:        e.id,
        name:      e.name,
        dept:      e.dept,
        lateCount: e.lateCount,
        late:      e.late ? 'YES' : 'NO',
        excused:   e.excused,
        checkIn:   e.checkIn,
        checkOut:  e.checkOut,
        photo:     e.photo || null,
      })),
      alerts,
    });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// POST /api/upload-excel
app.post('/api/upload-excel', (req, res) => {
  upload.single('file')(req, res, async (multerErr) => {
    if (multerErr) {
      return sendError(res, 400, multerErr.message);
    }
    if (!req.file) {
      return sendError(res, 400, 'No file received. Make sure the form field is named "file".');
    }

    let result;
    try {
      result = await processExcelBuffer(req.file.buffer);
    } catch (e) {
      return sendError(res, 422, e.message);
    }

    return res.json({
      success:   true,
      processed: result.processed,
      skipped:   result.skipped,
      message:   `Processed ${result.processed} records (${result.skipped} skipped). Warning emails sent where applicable.`,
    });
  });
});

// POST /api/mark-attendance (webcam punch)
app.post('/api/mark-attendance', async (req, res) => {
  try {
    const { employeeId, photo, punchStatus } = req.body;
    if (!employeeId) return sendError(res, 400, 'employeeId is required');

    const emp = employeeMap[employeeId];
    if (!emp) return sendError(res, 404, 'Employee not found: ' + employeeId);

    const now     = new Date();
    const hh      = String(now.getHours()).padStart(2, '0');
    const mm      = String(now.getMinutes()).padStart(2, '0');
    const timeStr = hh + ':' + mm;
    const dateStr = now.toISOString().slice(0, 10);

    if (punchStatus === 'IN') {
      emp.checkIn = to12hr(timeStr);
      emp.late    = timeStr > '11:00';
      if (photo) emp.photo = photo;

      if (emp.late && !emp.excused) {
        emp.lateCount++;
        const di = dayIndex(dateStr);
        if (di >= 0 && di < 7) trendCounts[di]++;

        sendWarningEmail(emp, emp.lateCount, dateStr).catch(e => {
          console.error('[webcam email error]', e.message);
        });
      }
    } else {
      emp.checkOut = to12hr(timeStr);
    }

    res.json({ success: true, record: { ...emp, late: emp.late ? 'YES' : 'NO' } });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// POST /api/excuse
app.post('/api/excuse', (req, res) => {
  try {
    const { employeeId } = req.body;
    if (!employeeId) return sendError(res, 400, 'employeeId is required');

    const emp = employeeMap[employeeId];
    if (!emp) return sendError(res, 404, 'Employee not found: ' + employeeId);

    emp.excused = !emp.excused;
    res.json({ success: true, employeeId, excused: emp.excused });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// GET /api/download-excel
app.get('/api/download-excel', (_req, res) => {
  try {
    const rows = Object.values(employeeMap).map(e => ({
      'Employee ID': e.id,
      'Name':        e.name,
      'Department':  e.dept,
      'Email':       e.email,
      'Check-In':    e.checkIn  || '—',
      'Check-Out':   e.checkOut || '—',
      'Late Today':  e.late     ? 'YES' : 'NO',
      'Late Count':  e.lateCount,
      'Status':      e.lateCount >= 3 ? 'Critical' : e.lateCount >= 2 ? 'At Risk' : 'Safe',
      'Excused':     e.excused  ? 'YES' : 'NO',
    }));

    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No data yet' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="attendance_export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return sendError(res, 404, 'Route not found: ' + req.path);
  next();
});

app.use((_req, res) => {
  const fs = require('fs');
  for (const name of ['index.html', 'index_.html']) {
    const full = path.join(__dirname, name);
    if (fs.existsSync(full)) return res.sendFile(full);
  }
  res.status(404).send('index.html not found');
});

app.use((err, _req, res, _next) => {
  console.error('[unhandled error]', err);
  if (!res.headersSent) sendError(res, 500, err.message || 'Internal server error');
});

app.listen(PORT, () => {
  console.log('\nHR Attendance server running at http://localhost:' + PORT);
  console.log('Email : ' + (process.env.EMAIL_USER ? 'ENABLED (' + process.env.EMAIL_USER + ')' : 'DISABLED — set EMAIL_USER + EMAIL_PASS in .env'));
  console.log('AI    : ' + (process.env.GROQ_API_KEY ? 'ENABLED (Groq)' : 'DISABLED — set GROQ_API_KEY in .env for AI emails'));
  console.log('');
});
