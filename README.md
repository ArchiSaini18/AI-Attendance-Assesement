# HR Attendance & Warning System

A local web dashboard that processes biometric Excel exports, tracks late arrivals, fires AI-written warning emails, and books HR meetings on the 3rd strike.

---

## Setup

```bash
npm install
cp .env.example .env
# fill in .env with your credentials (see below)
node server.js
```

Open **http://localhost:3000** in your browser.

---

## Environment Variables

All configuration lives in `.env`. Copy `.env.example` to get started.

| Variable | Required | What it does |
|---|---|---|
| `PORT` | No | Port to run on (default: 3000) |
| `EMAIL_USER` | For emails | Your Gmail address |
| `EMAIL_PASS` | For emails | Gmail App Password (not your real password) |
| `EMAIL_FROM` | No | Sender name shown in email (e.g. `HR System <hr@company.com>`) |
| `ANTHROPIC_API_KEY` | For AI emails | Claude API key — get from console.anthropic.com |
| `GOOGLE_CLIENT_EMAIL` | For real Calendar | Service account email from Google Cloud |
| `GOOGLE_PRIVATE_KEY` | For real Calendar | Private key from the service account JSON |

### Gmail App Password setup
1. Go to your Google Account → Security → 2-Step Verification
2. Scroll down to **App passwords**
3. Create one for "Mail" — use that 16-character password as `EMAIL_PASS`

---

## How it works

### Excel Upload
Upload a `.xlsx` or `.xls` file from the **Upload Excel** tab (or drag and drop it).

Required columns in the sheet (column names are case-insensitive):

| Column | Example |
|---|---|
| Employee ID | EMP-001 |
| Name | Jane Doe |
| Department | Engineering |
| Date | 2025-07-01 |
| Time | 09:15 |
| Punch Status | IN or OUT |
| Email *(optional)* | jane@company.com |

Multiple rows per employee per day are fine — the system picks the **earliest IN** and **latest OUT** automatically.

### Late Rule
Any check-in recorded after **11:00 AM** is flagged as late.

### Warning System (3-strike)

| Strike | Action |
|---|---|
| 1st | Friendly reminder email sent |
| 2nd | Firm warning email — mentions one more triggers a meeting |
| 3rd | Serious warning + mandatory 5 PM HR meeting booked (Calendar link in email) |

Emails are written by Claude (Anthropic API) if `ANTHROPIC_API_KEY` is set. If not, a plain text template is used instead.

### Google Calendar
On the 3rd strike, a pre-filled Google Calendar link is included in the email. To create real calendar events automatically, set `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` and uncomment the `createCalendarEvent` block in `server.js`.

### Missing OUT Punch
If an employee has no OUT punch for a day, the system still processes their record with checkout left blank. A warning is logged to the console.

---

## API Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/dashboard` | All dashboard data (stats, employee list, alerts, trend) |
| GET | `/api/employees` | Employee list for dropdowns |
| POST | `/api/upload-excel` | Upload `.xlsx` file (field name: `file`) |
| POST | `/api/mark-attendance` | Webcam check-in/out (JSON body: `employeeId`, `punchStatus`, `photo`) |
| POST | `/api/excuse` | Toggle excuse flag (JSON body: `employeeId`) |
| GET | `/api/download-excel` | Download current attendance data as `.xlsx` |

---

## Architecture

```
Browser
  │
  ├── Upload Excel ──► POST /api/upload-excel
  │                       │
  │                       ├── Parse sheet (multer + xlsx)
  │                       ├── Group by Employee + Date
  │                       ├── Earliest IN / Latest OUT
  │                       ├── Flag late arrivals (> 11:00 AM)
  │                       ├── Update strike counts
  │                       └── Send warning emails (nodemailer + Claude AI)
  │                                │
  │                                └── 3rd strike → Google Calendar link
  │
  ├── Dashboard (auto-refresh 60s) ──► GET /api/dashboard
  │
  └── Webcam attendance ──► POST /api/mark-attendance
                                └── Same late check + email flow
```

---

## Scalability Notes (for 500+ employees across 5 locations)

Right now all data lives in memory — fine for a demo, but for production:

- **Replace the in-memory store** with a PostgreSQL or MySQL database. The employee and attendance objects map directly to two tables (see database schema below).
- **Add a location column** to the Excel and database schema. Each location can have its own late threshold if needed.
- **Use a job queue** (e.g. Bull + Redis) for emails so a spike of 100 late arrivals doesn't block the upload response.
- **Rate-limit the Anthropic API calls** — batch them or cache email templates per strike level per day.

### Database Schema

**Table: `attendance_daily`** — one processed record per employee per day

```sql
CREATE TABLE attendance_daily (
  employee_id   VARCHAR(20)  NOT NULL,
  name          VARCHAR(100) NOT NULL,
  department    VARCHAR(50),
  date          DATE         NOT NULL,
  check_in      TIME,
  check_out     TIME,
  late_flag     BOOLEAN      DEFAULT FALSE,
  PRIMARY KEY (employee_id, date)
);
```

**Table: `monthly_late_counter`** — running late count per employee per month

```sql
CREATE TABLE monthly_late_counter (
  employee_id        VARCHAR(20)  NOT NULL,
  name               VARCHAR(100),
  email              VARCHAR(150),
  current_late_count INT          DEFAULT 0,
  last_warning_date  DATE,
  month_year         CHAR(7),     -- e.g. "2025-07"
  excused            BOOLEAN      DEFAULT FALSE,
  PRIMARY KEY (employee_id, month_year)
);
```
