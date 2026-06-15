import { describe, it } from "node:test";
import assert from "node:assert";

// Bug: no input validation
function login(username: string, password: string): boolean {
  const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
  return runQuery(query);
}

function runQuery(_sql: string): boolean {
  return true;
}
