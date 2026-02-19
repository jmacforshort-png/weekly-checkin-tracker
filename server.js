require("dotenv").config();
console.log("Render SHEET_ID =", process.env.SHEET_ID);
console.log("Render SHEET_TAB =", process.env.SHEET_TAB);

const express = require("express");
const { google } = require("googleapis");

const app = express();
const port = process.env.PORT || 3000;

// --- Google Sheets Setup ---
const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "Sheet1";

// --- In-memory current week counts ---
let currentWeek = {};

// --- Helpers ---
function getFriday() {
  const today = new Date();
  const day = today.getDay();
  const diff = 5 - day;
  const friday = new Date(today);
  friday.setDate(today.getDate() + diff);
  return friday.toISOString().split("T")[0];
}

function getColor(count) {
  if (count >= 4) return "green";
  if (count === 3) return "gold";
  if (count === 2) return "orange";
  if (count === 1) return "red";
  return "black";
}

app.use(express.urlencoded({ extended: true }));

// --- Home ---
app.get("/", (req, res) => {
  const students = Object.keys(currentWeek);
  const selected = req.query.student || students[0] || "Student 1";

  if (!currentWeek[selected]) currentWeek[selected] = 0;

  const count = currentWeek[selected];

  const options = students
    .map(
      (s) =>
        `<option ${s === selected ? "selected" : ""}>${s}</option>`
    )
    .join("");

  res.send(`
    <h1>Weekly Check-in Tracker</h1>

    <form method="GET">
      <select name="student" onchange="this.form.submit()">
        ${options}
      </select>
    </form>

    <h2 style="color:${getColor(count)}">This Week: ${count} / 4</h2>

    <form method="POST" action="/add">
      <input type="hidden" name="student" value="${selected}">
      <button>Add Check-In</button>
    </form>

    <form method="POST" action="/endweek">
      <input type="hidden" name="student" value="${selected}">
      <button>End Week (Save)</button>
    </form>

    <form method="POST" action="/addstudent">
      <input name="student" placeholder="New student name" required>
      <button>Add Student</button>
    </form>
  `);
});

// --- Add check-in ---
app.post("/add", (req, res) => {
  const student = req.body.student;
  currentWeek[student] = Math.min((currentWeek[student] || 0) + 1, 4);
  res.redirect("/?student=" + encodeURIComponent(student));
});

// --- Add student ---
app.post("/addstudent", (req, res) => {
  const student = req.body.student;
  if (!currentWeek[student]) currentWeek[student] = 0;
  res.redirect("/?student=" + encodeURIComponent(student));
});

// --- Save week to Google Sheets ---
app.post("/endweek", async (req, res) => {
  const student = req.body.student;
  const count = currentWeek[student] || 0;
  const friday = getFriday();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:C`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[student, friday, count]],
    },
  });

  currentWeek[student] = 0;
  res.redirect("/?student=" + encodeURIComponent(student));
});

app.listen(port, () => {
  console.log("Server running on port " + port);
});

