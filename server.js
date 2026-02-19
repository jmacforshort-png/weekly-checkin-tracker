require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

// --- Google Sheets auth (service account) ---
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || "service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const SHEET_ID = process.env.SHEET_ID;

// History tab (your existing one)
const HISTORY_TAB = process.env.SHEET_TAB || "Sheet1";

// New students tab
const STUDENTS_TAB = process.env.STUDENTS_TAB || "Students";

// In-memory current week counts (history persists in Sheets)
const currentWeek = {};

// ---------- helpers ----------
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeStudentName(s) {
  return (s || "").trim();
}

function getWeekEndingFridayISO() {
  const today = new Date();
  const day = today.getDay(); // Sun=0 ... Fri=5
  const diff = 5 - day;
  const friday = new Date(today);
  friday.setDate(today.getDate() + diff);
  return friday.toISOString().split("T")[0]; // YYYY-MM-DD
}

function colorForCount(count) {
  if (count >= 4) return "green";
  if (count === 3) return "goldenrod"; // yellow-ish
  if (count === 2) return "orange";
  if (count === 1) return "crimson";
  return "black";
}

async function getSheetValues(rangeA1) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
  });
  return resp.data.values || [];
}

async function appendRow(rangeA1, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function readHistoryRows() {
  // Expects header row in HISTORY_TAB: student | week_ending | checkins
  const values = await getSheetValues(`${HISTORY_TAB}!A:C`);
  if (values.length === 0) return [];

  const header = (values[0] || []).map((h) => (h || "").trim().toLowerCase());
  const idxStudent = header.indexOf("student");
  const idxWeek = header.indexOf("week_ending");
  const idxCheckins = header.indexOf("checkins");
  const startRow = idxStudent === -1 || idxWeek === -1 || idxCheckins === -1 ? 0 : 1;

  const rows = [];
  for (let i = startRow; i < values.length; i++) {
    const r = values[i] || [];
    const student = (r[idxStudent] ?? r[0] ?? "").toString().trim();
    const weekEnding = (r[idxWeek] ?? r[1] ?? "").toString().trim();
    const checkins = Number((r[idxCheckins] ?? r[2] ?? "").toString().trim());
    if (!student || !weekEnding || Number.isNaN(checkins)) continue;
    rows.push({ student, weekEnding, checkins });
  }
  return rows;
}

async function readStudentsList() {
  // Expects header in STUDENTS_TAB: student
  let values;
  try {
    values = await getSheetValues(`${STUDENTS_TAB}!A:A`);
  } catch {
    // If the tab doesn't exist yet, return empty and the UI still works.
    return [];
  }

  if (values.length === 0) return [];

  const header = ((values[0] || [])[0] || "").trim().toLowerCase();
  const startRow = header === "student" ? 1 : 0;

  const students = [];
  for (let i = startRow; i < values.length; i++) {
    const name = ((values[i] || [])[0] || "").toString().trim();
    if (name) students.push(name);
  }
  return students;
}

async function ensureStudentInSheet(name) {
  const student = normalizeStudentName(name);
  if (!student) return;

  const existing = await readStudentsList();
  const exists = existing.some((s) => s.toLowerCase() === student.toLowerCase());
  if (!exists) {
    await appendRow(`${STUDENTS_TAB}!A:A`, [student]);
  }
}

async function saveWeekToHistory(student, friday, count) {
  await appendRow(`${HISTORY_TAB}!A:C`, [student, friday, count]);
}

// ---------- routes ----------
app.get("/", async (req, res) => {
  const historyAll = await readHistoryRows();
  const studentsFromSheet = await readStudentsList();

  // Combine students from Students tab + history + currentWeek (in case)
  const set = new Set(studentsFromSheet);
  historyAll.forEach((r) => set.add(r.student));
  Object.keys(currentWeek).forEach((s) => set.add(s));

  if (set.size === 0) set.add("Student 1");

  const students = Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const selected = normalizeStudentName(req.query.student) || students[0];

  if (!(selected in currentWeek)) currentWeek[selected] = 0;
  const current = currentWeek[selected];

  const history = historyAll
    .filter((r) => r.student === selected)
    .sort((a, b) => (a.weekEnding < b.weekEnding ? 1 : a.weekEnding > b.weekEnding ? -1 : 0));

  const optionsHtml = students
    .map((s) => `<option value="${escapeHtml(s)}" ${s === selected ? "selected" : ""}>${escapeHtml(s)}</option>`)
    .join("");

  const historyRowsHtml =
    history.length > 0
      ? history
          .map(
            (r) => `
            <tr>
              <td>${escapeHtml(r.weekEnding)}</td>
              <td><span class="badge" style="background:${colorForCount(r.checkins)}">${r.checkins}</span></td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="2" class="muted">No weeks recorded yet for this student.</td></tr>`;

  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Weekly Check-in Tracker</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background:#f6f7fb; margin:0; color:#111; }
    .wrap { max-width: 980px; margin: 40px auto; padding: 0 16px; }
    .card { background: white; border-radius: 16px; box-shadow: 0 10px 28px rgba(0,0,0,.08); padding: 22px; }
    h1 { margin: 0 0 6px; font-size: 26px; }
    .sub { color:#555; margin: 0 0 18px; }
    .panel { background:#fbfbfd; border:1px solid #eee; border-radius: 14px; padding: 16px; }
    .controls { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
    select, input[type="text"] { padding: 10px 12px; border-radius: 12px; border: 1px solid #ddd; font-weight: 600; background: white; }
    button { border:0; border-radius: 12px; padding: 10px 14px; font-weight: 750; cursor:pointer; }
    .primary { background:#2563eb; color:white; }
    .ghost { background:#eef2ff; color:#1e3a8a; }
    .big { font-size: 34px; font-weight: 900; margin: 12px 0 4px; }
    .badge { display:inline-block; color:white; padding: 6px 10px; border-radius: 999px; font-weight: 900; min-width: 36px; text-align:center; }
    .muted { color:#666; font-size: 13px; }
    table { width:100%; border-collapse: collapse; margin-top: 12px; overflow:hidden; border-radius: 12px; }
    th, td { padding: 12px; text-align:left; border-bottom: 1px solid #eee; }
    th { background:#fafafa; font-size: 12px; color:#444; text-transform: uppercase; letter-spacing:.06em; }
    .hr { height:1px; background:#eee; margin: 14px 0; }
    .grid { display:grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 860px){ .grid { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Weekly Check-in Tracker</h1>
      <p class="sub">Select a student, track check-ins (goal: 4/week), and save weekly totals to Google Sheets.</p>

      <div class="panel">
        <div class="controls">
          <form method="GET" action="/">
            <select name="student" onchange="this.form.submit()">${optionsHtml}</select>
          </form>

          <form method="POST" action="/addstudent" class="controls">
            <input type="text" name="student" placeholder="Add new student name" required />
            <button class="ghost" type="submit">Add Student</button>
          </form>

          <form method="POST" action="/clearweek">
            <input type="hidden" name="student" value="${escapeHtml(selected)}" />
            <button class="ghost" type="submit">Clear Current Week</button>
          </form>
        </div>

        <div class="big">
          This Week: <span class="badge" style="background:${colorForCount(current)}">${current}</span> / 4
        </div>

        <div class="controls">
          <form method="POST" action="/add">
            <input type="hidden" name="student" value="${escapeHtml(selected)}" />
            <button class="primary" type="submit">Add Check-In</button>
          </form>

          <form method="POST" action="/endweek">
            <input type="hidden" name="student" value="${escapeHtml(selected)}" />
            <button class="ghost" type="submit">End Week (Save)</button>
          </form>
        </div>

        <p class="muted" style="margin-top:10px;">Color key: 4=green, 3=yellow, 2=orange, 1=red, 0=black.</p>
      </div>

      <div class="hr"></div>

      <div class="grid">
        <div class="panel">
          <h2 style="margin:0 0 6px;">Weekly History</h2>
          <p class="muted" style="margin:0 0 10px;">Week ending Friday + the saved check-in total.</p>
          <table>
            <tr>
              <th>Week Ending (Friday)</th>
              <th>Check-ins</th>
            </tr>
            ${historyRowsHtml}
          </table>
        </div>

        <div class="panel">
          <h2 style="margin:0 0 6px;">Notes</h2>
          <p class="muted" style="margin:0;">“End Week (Save)” writes a row to the Sheet and resets the counter to 0.</p>
        </div>
      </div>

    </div>
  </div>
</body>
</html>`);
});

app.post("/add", (req, res) => {
  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");
  currentWeek[student] = Math.min((currentWeek[student] || 0) + 1, 4);
  res.redirect("/?student=" + encodeURIComponent(student));
});

app.post("/clearweek", (req, res) => {
  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");
  currentWeek[student] = 0;
  res.redirect("/?student=" + encodeURIComponent(student));
});

app.post("/addstudent", async (req, res) => {
  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");

  // Persist student in the Students tab so it shows in dropdown permanently
  await ensureStudentInSheet(student);

  if (!(student in currentWeek)) currentWeek[student] = 0;
  res.redirect("/?student=" + encodeURIComponent(student));
});

app.post("/endweek", async (req, res) => {
  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");

  // ensure student exists in Students tab too
  await ensureStudentInSheet(student);

  const count = currentWeek[student] || 0;
  const friday = getWeekEndingFridayISO();

  await saveWeekToHistory(student, friday, count);

  currentWeek[student] = 0;
  res.redirect("/?student=" + encodeURIComponent(student));
});

app.listen(port, () => {
  console.log("Server running on port " + port);
});

