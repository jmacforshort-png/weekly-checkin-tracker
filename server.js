const express = require("express");
const Database = require("better-sqlite3");

const app = express();
const port = process.env.PORT || 3000;

const db = new Database("checkins.db");
app.use(express.urlencoded({ extended: true }));

// ---------- DB Schema (multi-student) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS current_week (
    student_id INTEGER PRIMARY KEY,
    checkins INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS weekly_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    week_ending_friday TEXT NOT NULL,
    checkins INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_history_student_date
  ON weekly_history(student_id, week_ending_friday);
`);

// ---------- Helpers ----------
function getColor(count) {
  if (count >= 4) return "green";
  if (count === 3) return "goldenrod";
  if (count === 2) return "orange";
  if (count === 1) return "crimson";
  return "black";
}

function getCurrentFridayISO() {
  const today = new Date();
  const day = today.getDay(); // Sun=0 ... Fri=5
  const diff = 5 - day; // upcoming Friday (or today if Friday)
  const friday = new Date(today);
  friday.setDate(today.getDate() + diff);

  const y = friday.getFullYear();
  const m = String(friday.getMonth() + 1).padStart(2, "0");
  const d = String(friday.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function allStudents() {
  return db.prepare("SELECT id, name FROM students ORDER BY name COLLATE NOCASE").all();
}

function ensureStudentRow(studentId) {
  db.prepare("INSERT OR IGNORE INTO current_week (student_id, checkins) VALUES (?, 0)").run(studentId);
}

function getCurrentCheckins(studentId) {
  ensureStudentRow(studentId);
  return db.prepare("SELECT checkins FROM current_week WHERE student_id = ?").get(studentId).checkins;
}

function setCurrentCheckins(studentId, n) {
  ensureStudentRow(studentId);
  db.prepare("UPDATE current_week SET checkins = ? WHERE student_id = ?").run(n, studentId);
}

function getHistory(studentId) {
  return db
    .prepare(
      `SELECT week_ending_friday AS date, checkins AS count
       FROM weekly_history
       WHERE student_id = ?
       ORDER BY week_ending_friday DESC, id DESC`
    )
    .all(studentId);
}

function firstOrCreateDefaultStudent() {
  const existing = db.prepare("SELECT id FROM students ORDER BY id LIMIT 1").get();
  if (existing) return existing.id;

  // Create a default student so the UI has something to show
  const info = db.prepare("INSERT INTO students (name) VALUES (?)").run("Student 1");
  ensureStudentRow(info.lastInsertRowid);
  return info.lastInsertRowid;
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  const students = allStudents();
  const selectedId = Number(req.query.student_id) || (students[0]?.id ?? firstOrCreateDefaultStudent());

  // Re-fetch students in case we just created one
  const students2 = allStudents();
  const activeId = students2.some(s => s.id === selectedId) ? selectedId : (students2[0]?.id ?? firstOrCreateDefaultStudent());

  const current = getCurrentCheckins(activeId);
  const history = getHistory(activeId);

  const rows = history
    .map(
      (w) => `
        <tr>
          <td>${w.date}</td>
          <td><span class="badge" style="background:${getColor(w.count)}">${w.count}</span></td>
        </tr>`
    )
    .join("");

  const options = students2
    .map(
      (s) => `<option value="${s.id}" ${s.id === activeId ? "selected" : ""}>${escapeHtml(s.name)}</option>`
    )
    .join("");

  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Weekly Check-in Tracker</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background:#f6f7fb; margin:0; }
    .wrap { max-width: 980px; margin: 40px auto; padding: 0 16px; }
    .card { background: white; border-radius: 14px; box-shadow: 0 6px 18px rgba(0,0,0,.08); padding: 22px; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    .sub { color:#555; margin: 0 0 18px; }
    .row { display:flex; gap: 12px; align-items:center; flex-wrap:wrap; }
    .big { font-size: 34px; font-weight: 800; margin: 12px 0; }
    .badge { display:inline-block; color:white; padding: 6px 10px; border-radius: 999px; font-weight: 800; min-width: 34px; text-align:center; }
    button { border:0; border-radius: 10px; padding: 10px 14px; font-weight: 700; cursor:pointer; }
    .primary { background:#2563eb; color:white; }
    .ghost { background:#eef2ff; color:#1e3a8a; }
    .danger { background:#fee2e2; color:#991b1b; }
    .muted { color:#666; font-size: 13px; }
    table { width:100%; border-collapse: collapse; margin-top: 18px; overflow:hidden; border-radius: 12px; }
    th, td { padding: 12px; text-align:left; border-bottom: 1px solid #eee; }
    th { background:#fafafa; font-size: 13px; color:#444; text-transform: uppercase; letter-spacing:.04em; }
    .controls { display:flex; gap:12px; flex-wrap:wrap; margin: 12px 0 2px; }
    select, input[type="text"] {
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #ddd;
      font-weight: 600;
      background: white;
    }
    .pill { background:#f1f5f9; padding: 10px 12px; border-radius: 12px; }
    form { margin: 0; }
    .divider { height:1px; background:#eee; margin: 18px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Weekly Check-in Tracker</h1>
      <p class="sub">Track weekly teacher check-ins (goal: 4 per week), per student.</p>

      <div class="controls">
        <form method="GET" action="/">
          <span class="pill">
            Student:
            <select name="student_id" onchange="this.form.submit()">
              ${options}
            </select>
          </span>
        </form>

        <form method="POST" action="/students/add">
          <input type="hidden" name="student_id" value="${activeId}" />
          <input type="text" name="name" placeholder="Add new student name" required />
          <button class="ghost" type="submit">Add Student</button>
        </form>

        <form method="POST" action="/students/delete" onsubmit="return confirm('Delete this student and all their data?');">
          <input type="hidden" name="student_id" value="${activeId}" />
          <button class="danger" type="submit">Delete Student</button>
        </form>
      </div>

      <div class="row">
        <div class="big">
          This Week:
          <span class="badge" style="background:${getColor(current)}">${current}</span>
          / 4
        </div>
      </div>

      <div class="row">
        <form method="POST" action="/add">
          <input type="hidden" name="student_id" value="${activeId}" />
          <button class="primary" type="submit">Add Check-In</button>
        </form>

        <form method="POST" action="/endweek">
          <input type="hidden" name="student_id" value="${activeId}" />
          <button class="ghost" type="submit">End Week (Save + Reset)</button>
        </form>

        <form method="POST" action="/resetweek">
          <input type="hidden" name="student_id" value="${activeId}" />
          <button class="ghost" type="submit">Clear Current Week</button>
        </form>

        <form method="POST" action="/clearall" onsubmit="return confirm('Clear ALL history for this student and reset week to 0?');">
          <input type="hidden" name="student_id" value="${activeId}" />
          <button class="danger" type="submit">Clear Student Data</button>
        </form>
      </div>

      <p class="muted" style="margin-top:10px;">
        Color key: 4 = green, 3 = yellow, 2 = orange, 1 = red, 0 = black.
      </p>

      <div class="divider"></div>

      <h2 style="margin:0;">Weekly History</h2>
      <table>
        <tr>
          <th>Week Ending (Friday)</th>
          <th>Check-Ins</th>
        </tr>
        ${rows || `<tr><td colspan="2" class="muted">No weeks recorded yet.</td></tr>`}
      </table>
    </div>
  </div>
</body>
</html>
  `);
});

app.post("/add", (req, res) => {
  const studentId = Number(req.body.student_id);
  const current = getCurrentCheckins(studentId);
  if (current < 4) setCurrentCheckins(studentId, current + 1);
  res.redirect(`/?student_id=${studentId}`);
});

app.post("/resetweek", (req, res) => {
  const studentId = Number(req.body.student_id);
  setCurrentCheckins(studentId, 0);
  res.redirect(`/?student_id=${studentId}`);
});

app.post("/endweek", (req, res) => {
  const studentId = Number(req.body.student_id);
  const current = getCurrentCheckins(studentId);
  const friday = getCurrentFridayISO();

  db.prepare("INSERT INTO weekly_history (student_id, week_ending_friday, checkins) VALUES (?, ?, ?)")
    .run(studentId, friday, current);

  setCurrentCheckins(studentId, 0);
  res.redirect(`/?student_id=${studentId}`);
});

app.post("/clearall", (req, res) => {
  const studentId = Number(req.body.student_id);
  db.prepare("DELETE FROM weekly_history WHERE student_id = ?").run(studentId);
  setCurrentCheckins(studentId, 0);
  res.redirect(`/?student_id=${studentId}`);
});

app.post("/students/add", (req, res) => {
  const currentStudentId = Number(req.body.student_id);
  const name = (req.body.name || "").trim();

  if (!name) return res.redirect(`/?student_id=${currentStudentId}`);

  try {
    const info = db.prepare("INSERT INTO students (name) VALUES (?)").run(name);
    const newId = info.lastInsertRowid;
    ensureStudentRow(newId);
    res.redirect(`/?student_id=${newId}`);
  } catch (e) {
    // likely UNIQUE constraint (name already exists)
    res.redirect(`/?student_id=${currentStudentId}`);
  }
});

app.post("/students/delete", (req, res) => {
  const studentId = Number(req.body.student_id);
  db.prepare("DELETE FROM students WHERE id = ?").run(studentId);

  // pick another student (or recreate default)
  const next = db.prepare("SELECT id FROM students ORDER BY name COLLATE NOCASE LIMIT 1").get();
  const nextId = next ? next.id : firstOrCreateDefaultStudent();
  res.redirect(`/?student_id=${nextId}`);
});

// Basic HTML escape for student names in <option>
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.listen(port, () => {
  console.log("Server running at http://localhost:3000");
});

