require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");

const BUILD_TIME = new Date().toLocaleString();

const app = express();
const port = process.env.PORT || 3000;

const APP_PASSWORD = process.env.APP_PASSWORD || "test";

app.use(express.urlencoded({ extended: true }));
app.use(
  require("express-session")({
    secret: "checkin-secret",
    resave: false,
    saveUninitialized: false,
  })
);

// --- Google Sheets auth (service account) ---
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || "service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const SHEET_ID = process.env.SHEET_ID;
const HISTORY_TAB = process.env.SHEET_TAB || "Sheet1";
const STUDENTS_TAB = process.env.STUDENTS_TAB || "Students";

// In-memory current week counts (history persists in Sheets)
const currentWeek = {}; // key -> number
const currentTeachers = {}; // key -> array of teacher names this week

const TORREY_PINE_IMG =
  "https://commons.wikimedia.org/wiki/Special:FilePath/Pinus_torreyana_at_State_Reserve.jpg?width=1200";

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

function normalizeOwner(s) {
  return (s || "").trim().toLowerCase();
}

function ownerStudentKey(owner, student) {
  return `${owner}||${student}`;
}

// Friday of the current week (Mon–Fri => that Fri; Sat/Sun => previous Fri)
function getWeekEndingFridayISO() {
  const today = new Date();
  const day = today.getDay(); // Sun=0 ... Sat=6

  if (day === 6) today.setDate(today.getDate() - 1);
  if (day === 0) today.setDate(today.getDate() - 2);

  const diff = 5 - today.getDay();
  today.setDate(today.getDate() + diff);
  return today.toISOString().split("T")[0];
}

function colorForCount(count) {
  if (count >= 5) return "#14532d";
  if (count === 4) return "green";
  if (count === 3) return "goldenrod";
  if (count === 2) return "orange";
  if (count === 1) return "crimson";
  return "black";
}

function summaryForCount(count) {
  if (count >= 5) return "Above & beyond!";
  if (count === 4) return "Met goal--nice.";
  if (count === 3) return "Close!";
  if (count === 2) return "In progress...";
  if (count === 1) return "Uh oh--what happened?";
  return "No check-ins";
}

async function getSheetValues(rangeA1) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
  });
  return resp.data.values || [];
}

async function updateSheetValues(rangeA1, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

async function appendRow(rangeA1, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

// Ensure required headers exist (prevents crashes / “entity not found” confusion)
async function ensureHistoryHeaders() {
  const values = await getSheetValues(`${HISTORY_TAB}!A1:E1`);
  const row = values[0] || [];
  const normalized = row.map((x) => (x || "").toString().trim().toLowerCase());

  const wanted = ["owner", "student", "week_ending", "checkins", "teacher"];
  const ok = wanted.every((h, i) => (normalized[i] || "") === h);

  if (!ok) {
    await updateSheetValues(`${HISTORY_TAB}!A1:E1`, [wanted]);
  }
}

async function ensureStudentsHeaders() {
  // Students should be: owner | student
  const values = await getSheetValues(`${STUDENTS_TAB}!A1:B1`);
  const row = values[0] || [];
  const a = (row[0] || "").toString().trim().toLowerCase();
  const b = (row[1] || "").toString().trim().toLowerCase();

  if (!(a === "owner" && b === "student")) {
    await updateSheetValues(`${STUDENTS_TAB}!A1:B1`, [["owner", "student"]]);
  }
}

async function readHistoryRows() {
  await ensureHistoryHeaders();
  const values = await getSheetValues(`${HISTORY_TAB}!A:E`);
  if (values.length <= 1) return [];

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const owner = normalizeOwner((r[0] || "").toString());
    const student = (r[1] || "").toString().trim();
    const weekEnding = (r[2] || "").toString().trim();
    const checkins = Number((r[3] || "").toString().trim());
    const teacher = (r[4] || "").toString().trim();
    if (!owner || !student || !weekEnding || Number.isNaN(checkins)) continue;
    rows.push({ owner, student, weekEnding, checkins, teacher });
  }
  return rows;
}

async function readStudentsList() {
  await ensureStudentsHeaders();
  const values = await getSheetValues(`${STUDENTS_TAB}!A:B`);
  if (values.length <= 1) return [];

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const owner = normalizeOwner((r[0] || "").toString());
    const student = (r[1] || "").toString().trim();
    if (owner && student) rows.push({ owner, student });
  }
  return rows;
}

async function ensureStudentInSheet(owner, name) {
  const o = normalizeOwner(owner);
  const student = normalizeStudentName(name);
  if (!o || !student) return;

  await ensureStudentsHeaders();

  const existing = await readStudentsList();
  const exists = existing.some(
    (r) => r.owner === o && r.student.toLowerCase() === student.toLowerCase()
  );
  if (!exists) {
    await appendRow(`${STUDENTS_TAB}!A:B`, [o, student]);
  }
}

async function saveWeekToHistory(owner, student, friday, count, teacherSummary) {
  const o = normalizeOwner(owner);
  await ensureHistoryHeaders();
  await appendRow(`${HISTORY_TAB}!A:E`, [o, student, friday, count, teacherSummary || ""]);
}

// ---------- routes ----------

// --- Login page ---
app.get("/login", (req, res) => {
  res.send(`
    <html>
    <body style="font-family:Arial; background:#f6f7fb; display:flex; align-items:center; justify-content:center; height:100vh;">
      <form method="POST" action="/login" style="background:white; padding:30px; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.1); min-width:320px;">
        <h2>Weekly Check-in Tracker</h2>

        <input type="text" name="username" placeholder="Username" required
          style="padding:10px; margin-top:10px; width:100%; box-sizing:border-box;">
        <input type="password" name="password" placeholder="Password" required
          style="padding:10px; margin-top:10px; width:100%; box-sizing:border-box;">

        <br><br>
        <button type="submit" style="padding:10px 20px; width:100%;">Login</button>
      </form>
    </body>
    </html>
  `);
});

app.post("/login", (req, res) => {
  const username = (req.body.username || "").trim().toLowerCase();
  const password = (req.body.password || "").trim();

  if (!username) return res.redirect("/login");

  if (password === APP_PASSWORD) {
    req.session.loggedIn = true;
    req.session.user = username;
    res.redirect("/");
  } else {
    res.redirect("/login");
  }
});

// Protect all routes except /login
app.use((req, res, next) => {
  if (req.path === "/login") return next();
  if (!req.session.loggedIn) return res.redirect("/login");
  next();
});

app.get("/", async (req, res) => {
  const owner = normalizeOwner(req.session.user);
  if (!owner) return res.redirect("/login");

  let historyAll = [];
  let studentsRows = [];
  let errorBanner = "";

  try {
    historyAll = await readHistoryRows();
  } catch (e) {
    errorBanner = `History read error: ${escapeHtml(e?.message || String(e))}`;
  }

  try {
    studentsRows = await readStudentsList();
  } catch (e) {
    errorBanner = `Students read error: ${escapeHtml(e?.message || String(e))}`;
  }

  const ownerStudents = studentsRows.filter((r) => r.owner === owner).map((r) => r.student);

  const set = new Set(ownerStudents);
  historyAll.forEach((r) => {
    if (r.owner === owner) set.add(r.student);
  });
  if (set.size === 0) set.add("Student 1");

  const students = Array.from(set).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );

  const selected = normalizeStudentName(req.query.student) || students[0];
  const key = ownerStudentKey(owner, selected);

  if (!(key in currentWeek)) currentWeek[key] = 0;
  if (!currentTeachers[key]) currentTeachers[key] = [];

  const current = currentWeek[key];

  const map = new Map();
  for (const r of historyAll) {
    if (r.owner !== owner) continue;
    if (r.student !== selected) continue;
    const prev = map.get(r.weekEnding);
    if (!prev || r.checkins > prev.checkins) {
      map.set(r.weekEnding, { checkins: r.checkins, teacher: r.teacher || "" });
    }
  }

  const weeklySummary = Array.from(map.entries())
    .map(([weekEnding, v]) => ({
      weekEnding,
      checkins: v.checkins,
      teacher: v.teacher,
    }))
    .sort((a, b) =>
      a.weekEnding < b.weekEnding ? 1 : a.weekEnding > b.weekEnding ? -1 : 0
    );

  const optionsHtml = students
    .map(
      (s) =>
        `<option value="${escapeHtml(s)}" ${
          s === selected ? "selected" : ""
        }>${escapeHtml(s)}</option>`
    )
    .join("");

  const historyRowsHtml =
    weeklySummary.length > 0
      ? weeklySummary
          .map(
            (r) => `
<tr>
  <td>${escapeHtml(selected)}</td>
  <td>${escapeHtml(r.weekEnding)}</td>
  <td><span class="badge" style="background:${colorForCount(
    r.checkins
  )}">${r.checkins}</span></td>
  <td class="muted">${escapeHtml(r.teacher || "")}</td>
  <td class="muted">${escapeHtml(summaryForCount(r.checkins))}</td>
</tr>`
          )
          .join("")
      : `<tr><td colspan="5" class="muted">No weeks recorded yet for this student.</td></tr>`;

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
    button:hover { opacity: .94; }
    .primary { background:#2563eb; color:white; }
    .ghost { background:#eef2ff; color:#1e3a8a; }
    .danger { background:#fee2e2; color:#7f1d1d; }
    .big { font-size: 34px; font-weight: 900; margin: 12px 0 4px; }
    .badge { display:inline-block; color:white; padding: 6px 10px; border-radius: 999px; font-weight: 900; min-width: 36px; text-align:center; }
    .muted { color:#666; font-size: 13px; }
    table { width:100%; border-collapse: collapse; margin-top: 12px; overflow:hidden; border-radius: 12px; }
    th, td { padding: 12px; text-align:left; border-bottom: 1px solid #eee; vertical-align: middle; }
    th { background:#fafafa; font-size: 12px; color:#444; text-transform: uppercase; letter-spacing:.06em; }
    .hr { height:1px; background:#eee; margin: 14px 0; }
    .grid { display:grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 860px){ .grid { grid-template-columns: 1.2fr .8fr; } }
    @media (max-width: 520px){
      .controls { flex-direction: column; align-items: stretch; }
      select, input[type="text"], button { width: 100%; }
    }
    .imgbox img { width:100%; border-radius: 14px; display:block; }
    .caption { margin-top:10px; }
    .banner { background:#fff7ed; border:1px solid #fed7aa; padding:10px 12px; border-radius:12px; color:#9a3412; margin-bottom:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Weekly Check-in Tracker</h1>
      <div style="font-size:12px; color:#666;">Build: ${BUILD_TIME}</div>
      <p class="sub">Logged in as <b>${escapeHtml(owner)}</b></p>

      ${errorBanner ? `<div class="banner">${errorBanner}</div>` : ""}

      <div class="panel">
        <div class="controls">
          <form method="GET" action="/" style="margin:0;">
            <select name="student" onchange="this.form.submit()">${optionsHtml}</select>
          </form>

          <form method="POST" action="/addstudent" style="margin:0; display:flex; gap:12px; align-items:center;">
            <input type="text" name="student" placeholder="Add new student..." required />
            <button class="ghost" type="submit">Add Student</button>
          </form>

          <form method="POST" action="/clearweek" style="margin:0;">
            <input type="hidden" name="student" value="${escapeHtml(selected)}" />
            <button class="danger" type="submit">Clear Current Week</button>
          </form>
        </div>

        <div class="big">
          This Week: <span class="badge" style="background:${colorForCount(current)}">${current}${current >= 5 ? " ⭐" : ""}</span> / 5
        </div>
        <div class="muted">Goal: 4 check-ins (5 = above & beyond)</div>

        <div class="controls" style="margin-top:12px;">
          <form method="POST" action="/add" style="margin:0;">
            <input type="hidden" name="student" value="${escapeHtml(selected)}" />
            <input type="hidden" name="teacher" value="" />
            <button class="primary" type="button"
              onclick="(function(btn){
                const f = btn.closest('form');
                const t = f.querySelector('input[name=teacher]');
                const name = prompt('Teacher met with (optional):');
                if (name === null) return;
                t.value = name.trim();
                f.submit();
              })(this);">
              Add Check-In
            </button>
          </form>

          <form method="POST" action="/endweek" style="margin:0;">
            <input type="hidden" name="student" value="${escapeHtml(selected)}" />
            <button class="ghost" type="submit">End Week (Save)</button>
          </form>
        </div>
      </div>

      <div class="hr"></div>

      <div class="grid">
        <div class="panel">
          <h2 style="margin:0 0 6px;">Weekly History</h2>
          <table>
            <tr>
              <th>Student</th>
              <th>Week Ending (Friday)</th>
              <th>Check-ins</th>
              <th>Teacher</th>
              <th>Summary</th>
            </tr>
            ${historyRowsHtml}
          </table>
        </div>

        <div class="panel imgbox">
          <img src="${TORREY_PINE_IMG}" alt="Torrey pine tree" />
          <div class="caption muted">Torrey pine (Pinus torreyana)</div>
        </div>
      </div>

    </div>
  </div>
</body>
</html>`);
});

app.post("/add", (req, res) => {
  const owner = normalizeOwner(req.session.user);
  if (!owner) return res.redirect("/login");

  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");

  const key = ownerStudentKey(owner, student);

  currentWeek[key] = Math.min((currentWeek[key] || 0) + 1, 5);

  const teacher = (req.body.teacher || "").trim();
  if (teacher) {
    if (!currentTeachers[key]) currentTeachers[key] = [];
    currentTeachers[key].push(teacher);
  }

  res.redirect("/?student=" + encodeURIComponent(student));
});

app.post("/clearweek", (req, res) => {
  const owner = normalizeOwner(req.session.user);
  if (!owner) return res.redirect("/login");

  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");

  const key = ownerStudentKey(owner, student);

  currentWeek[key] = 0;
  currentTeachers[key] = [];
  res.redirect("/?student=" + encodeURIComponent(student));
});

app.post("/addstudent", async (req, res) => {
  const owner = normalizeOwner(req.session.user);
  if (!owner) return res.redirect("/login");

  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");

  try {
    await ensureStudentInSheet(owner, student);
  } catch (e) {
    console.log("[addstudent] ERROR:", e?.message || e);
  }

  const key = ownerStudentKey(owner, student);
  if (!(key in currentWeek)) currentWeek[key] = 0;
  if (!currentTeachers[key]) currentTeachers[key] = [];

  res.redirect("/?student=" + encodeURIComponent(student));
});

app.post("/endweek", async (req, res) => {
  const owner = normalizeOwner(req.session.user);
  if (!owner) return res.redirect("/login");

  const student = normalizeStudentName(req.body.student);
  if (!student) return res.redirect("/");

  const key = ownerStudentKey(owner, student);

  try {
    await ensureStudentInSheet(owner, student);

    const count = currentWeek[key] || 0;
    const friday = getWeekEndingFridayISO();

    const teacherSummary = (currentTeachers[key] || [])
      .map((t) => t.trim())
      .filter(Boolean)
      .join("; ");

    await saveWeekToHistory(owner, student, friday, count, teacherSummary);

    currentWeek[key] = 0;
    currentTeachers[key] = [];
  } catch (e) {
    console.log("[endweek] ERROR:", e?.message || e);
    // keep state so user doesn't lose it if save fails
  }

  res.redirect("/?student=" + encodeURIComponent(student));
});

app.listen(port, () => {
  console.log("Server running on port " + port);
});