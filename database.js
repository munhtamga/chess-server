const initSqlJs = require("sql.js");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "chess.db");

let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  initTables();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function initTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT,
      rating INTEGER DEFAULT 1200,
      games INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      white_username TEXT NOT NULL,
      black_username TEXT NOT NULL,
      white_rating_before INTEGER,
      black_rating_before INTEGER,
      white_rating_after INTEGER,
      black_rating_after INTEGER,
      result TEXT NOT NULL,
      moves INTEGER DEFAULT 0,
      time_limit INTEGER,
      played_at TEXT DEFAULT (datetime('now'))
    );
  `);
  saveDb();
}

function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function calculateElo(ratingA, ratingB, resultA) {
  const K = 32;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const newRatingA = Math.round(ratingA + K * (resultA - expectedA));
  const newRatingB = Math.round(ratingB + K * ((1 - resultA) - (1 - expectedA)));
  return { newRatingA, newRatingB };
}

function getPlayerByUsername(username) {
  return queryOne("SELECT * FROM players WHERE username = ?", [username]);
}

function createPlayer(username, passwordHash, displayName) {
  run("INSERT INTO players (username, password_hash, display_name) VALUES (?, ?, ?)", [username, passwordHash, displayName || username]);
  return getPlayerByUsername(username);
}

function updateRatings(whiteUsername, blackUsername, result, moves, timeLimit) {
  const white = getPlayerByUsername(whiteUsername);
  const black = getPlayerByUsername(blackUsername);
  if (!white || !black) return null;

  let resultA = result === "white" ? 1 : result === "black" ? 0 : 0.5;
  const { newRatingA, newRatingB } = calculateElo(white.rating, black.rating, resultA);

  run(`UPDATE players SET rating=?, games=games+1, wins=wins+?, losses=losses+?, draws=draws+? WHERE username=?`,
    [newRatingA, result==="white"?1:0, result==="black"?1:0, result==="draw"?1:0, whiteUsername]);
  run(`UPDATE players SET rating=?, games=games+1, wins=wins+?, losses=losses+?, draws=draws+? WHERE username=?`,
    [newRatingB, result==="black"?1:0, result==="white"?1:0, result==="draw"?1:0, blackUsername]);
  run(`INSERT INTO game_history (white_username,black_username,white_rating_before,black_rating_before,white_rating_after,black_rating_after,result,moves,time_limit) VALUES (?,?,?,?,?,?,?,?,?)`,
    [whiteUsername, blackUsername, white.rating, black.rating, newRatingA, newRatingB, result, moves, timeLimit]);

  return {
    white: { username: white.username, displayName: white.display_name, rating: white.rating, newRating: newRatingA, change: newRatingA - white.rating },
    black: { username: black.username, displayName: black.display_name, rating: black.rating, newRating: newRatingB, change: newRatingB - black.rating },
  };
}

function getLeaderboard(limit = 20) {
  return queryAll(`
    SELECT username, display_name, rating, games, wins, losses, draws,
      CASE WHEN games > 0 THEN ROUND(CAST(wins AS FLOAT) * 100.0 / games, 1) ELSE 0 END as win_rate
    FROM players WHERE games > 0
    ORDER BY rating DESC LIMIT ?
  `, [limit]);
}

function getPlayerGames(username, limit = 10) {
  return queryAll(`
    SELECT * FROM game_history
    WHERE white_username=? OR black_username=?
    ORDER BY played_at DESC LIMIT ?
  `, [username, username, limit]);
}

module.exports = { getDb, getPlayerByUsername, createPlayer, updateRatings, getLeaderboard, getPlayerGames };
