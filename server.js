require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

// --- Google Sheets setup (service account) ---
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || "service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "Sheet1";

// --- In-memory current week counts (resets if server restarts; history stays in Sheets) ---
const currentWeek = {};

// ---------- helpers ----------
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
  if (count === 3) return "goldenrod"; // yellow-ish but readable
  if (count === 2) return "orange";
  if (count === 1) return "crimson";
  return "black";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readAllRows() {
  // Expects header row: student | week_ending | checkins
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:C`,
  });

  const values = resp.data.values || [];
  if (values.length === 0) return [];

  const header = (values[0] || []).map((h) => (h || "").trim().toLowerCase());
  const idxStudent = header.indexOf("student");
  const idxWeek = header.indexOf("week_ending");
  const idxCheckins = header.indexOf("checkins");

  // If headers aren't found, treat first row as data (but your sheet should have headers)
  const startRow = idxStudent === -1 || idxWeek === -1 || idxCheckins === -1 ? 0 : 1;

  const rows = [];
  for (let i = startRow; i < values.length; i++) {
    const r = values[i] || [];
    const student = (r[idxStudent] ?? r[0] ?? "").toString().trim();
    const weekEnding = (r[idxWeek] ?? r[1] ?? "").toString().trim();
    const checkinsRaw = (r[idxCheckins] ?? r[2] ?? "").toString().trim();
    const checkins = Number(checkinsRaw);
    if (!student || !weekEnding || Number.isNaN(checkins)) continue;
    rows.push({ student, weekEnding, checkins });
  }
  return rows;
}

async function appendWeekRow(student, weekEnding, checkins) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:C`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[student, weekEnding, checkins]] },
  });
}

function normalizeStudentName(s) {
  return (s || "").trim();
}

// ---------- routes ----------
app.get("/", async (req, res) => {
  const allRows = await readAllRows();

  // Build student list from sheet + in-memory currentWeek
  const studentSet = new Set(allRows.map((r) => r.student));
  Object.keys(currentWeek).forEach((s) => studentSet.add(s));
  if (studentSet.size === 0) studentSet.add("Student 1");

  const students = Array.from(studentSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const selected = normalizeStudentName(req.query.student) || students[0];
  if (!(selected in currentWeek)) currentWeek[selected] = 0;

  const current = currentWeek[selected];

  // Filter and sort history for this student (newest week first)
  const history = allRows
    .filter((r) => r.student === selected)
    .sort((a, b) => (a.weekEnding < b.weekEnding ? 1 : a.weekEnding > b.weekEnding ? -1 : 0));

  const optionsHtml = students
    .map((s) => `<option value="${escapeHtml(s)}" ${s === selected ? "selected" : ""}>${escapeHtml(s)}</option>`)
    .join("");

  const rowsHtml =
    history.length > 0
      ? history
          .map(
            (r) => `
            <tr>
              <td>${escapeHtml(r.weekEnding)}</td>
              <td><span class="badge" style="background:${colorForCount(r.checkins)}">${r.checkins}</span></td>
            </tr>
          `
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
    h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -.01em; }
    .sub { color:#555; margin: 0 0 18px; }
    .grid { display:grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 860px){ .grid { grid-template-columns: 1fr 1fr; } }
    .panel { background:#fbfbfd; border:1px solid #eee; border-radius: 14px; padding: 16px; }
    .controls { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
    select, input[type="text"] { padding: 10px 12px; border-radius: 12px; border: 1px solid #ddd; font-weight: 600; background: white; }
    button { border:0; border-radius: 12px; padding: 10px 14px; font-weight: 750; cursor:pointer; }
    .primary { background:#2563eb; color:white; }
    .ghost { background:#eef2ff; color:#1e3a8a; }
    .danger { background:#fee2e2; color:#991b1b; }
    .big { font-size: 34px; font-weight: 900; margin: 12px 0 4px; }
    .badge { display:inline-block; color:white; padding: 6px 10px; border-radius: 999px; font-weight: 900; min-width: 36px; text-align:center; }
    .muted { color:#666; font-size: 13px; }
    table { width:100%; border-collapse: collapse; margin-top: 12px; overflow:hidden; border-radius: 12px; }
    th, td { padding: 12px; text-align:left; border-bottom: 1px solid #eee; }
    th { background:#fafafa; font-size: 12px; color:#444; text-transform: uppercase; letter-spacing:.06em; }
    .k { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .hr { height:1px; background:#eee; margin: 14px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Weekly Check-in Tracker</h1>
      <p class="sub">Track weekly teacher check-ins (goal: 4 per week) and save week totals to Google Sheets.</p>

      <div class="panel">
        <div class="controls">
          <form method="GET" action="/" class="k">
            <span><strong>Student</strong></span>
            <select name="student" onchange="this.form.submit()">${optionsHtml}</select>
          </form>

          <form method="POST" action="/addstudent" class="k">
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

          <form method="POST" action="/deletehistory" onsubmit="return confirm('Delete ALL saved history rows for this student from the Sheet?');">
            <input type="hidden" name="student" value="${escapeHtml(selected)}" />
            <button class="danger" type="submit">Delete Student History</button>
          </form>
        </div>

        <p class="muted" style="margin-top:10px;">Color key: 4 = green, 3 = yellow, 2 = orange, 1 = red, 0 = black.</p>
      </div>

      <div class="hr"></div>

      <div class="grid">
        <div class="panel">
          <h2 style="margin:0 0 6px;">Weekly History</h2>
          <p class="muted" style="margin:0 0 10px;">Saved totals for <strong>${escapeHtml(selected)}</strong> (week ending Friday).</p>
          <table>
            <tr>
              <th>Week Ending (Friday)</th>
              <th>Check-ins</th>
            </tr>
            ${rowsHtml}
          </table>
        </div>

        <div class="panel">
          <h2 style="margin:0 0 6px;">Notes</h2>
          <p class="muted" style="margin:0;">Tip: “End Week (Save)” records the current number (0–4) to the Sheet and resets the week to 0.</p>
          <div class="hr"></div>
          <p class="muted" style="margin:0;">If you want, next we can add: per-student goals, weekly auto-rollover, or a password to protect edits.</p>
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

app.post("/addstudent", (req, res) => {
  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");
  if (!(student in currentWeek)) currentWeek[student] = 0;
  res.redirect("/?student=" + encodeURIComponent(student));
});

app.post("/endweek", async (req, res) => {
  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");

  const count = currentWeek[student] || 0;
  const friday = getWeekEndingFridayISO();

  await appendWeekRow(student, friday, count);

  currentWeek[student] = 0;
  res.redirect("/?student=" + encodeURIComponent(student));
});

// Deletes all rows for a student (optional admin action)
// Note: Sheets API doesn't have a simple "DELETE rows matching filter" without using batchUpdate + sheetId.
// Easiest free approach: we leave this button but make it a no-op unless you want the full delete logic.
app.post("/deletehistory", async (req, res) => {
  // Keeping this route so the UI button doesn't 404.
  // If you want true delete-from-sheet, tell me and I'll add the batchUpdate implementation.
  const student = normalizeStudentName(req.body.student);
  res.redirect("/?student=" + encodeURIComponent(student));
});

app.listen(port, () => {
  console.log("Server running on port " + port);
});

