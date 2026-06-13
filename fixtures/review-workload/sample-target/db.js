// A tiny sample module with deliberate, obvious issues for the review rehearsal.
const { execSync } = require("child_process");

function getUser(db, username) {
  // SQL injection: username is interpolated straight into the query string.
  return db.query("SELECT * FROM users WHERE name = '" + username + "'");
}

function runReport(name) {
  // Command injection: untrusted name flows into a shell command.
  return execSync("generate-report " + name).toString();
}

function readToken(headers) {
  // Unchecked access: headers.authorization may be undefined -> crash.
  return headers.authorization.split(" ")[1];
}

module.exports = { getUser, runReport, readToken };
