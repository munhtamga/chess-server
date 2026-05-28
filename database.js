const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "chess.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    google_id TEXT UNIQUE,
    display_name TEXT,
    rating INTEGER DEFAULT 1200,
    games INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

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
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function calculateElo(ratingA, ratingB, resultA) {
  const K = 32;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const newRatingA = Math.round(ratingA + K * (resultA - expectedA));
  const newRatingB = Math.round(ratingB + K * ((1 - resultA) - (1 - expectedA)));
  return { newRatingA, newRatingB };
}

function getPlayerByUsername(username) {
  return db.prepare("SELECT * FROM players WHERE username = ?").get(username);
}

function getPlayerById(id) {
  return db.prepare("SELECT * FROM players WHERE id = ?").get(id);
}

function createPlayer(username, passwordHash, displayName) {
  db.prepare("INSERT INTO players (username, password_hash, display_name) VALUES (?, ?, ?)").run(username, passwordHash, displayName || username);
  return getPlayerByUsername(username);
}

function updateRatings(whiteUsername, blackUsername, result, moves, timeLimit) {
  const white = getPlayerByUsername(whiteUsername);
  const black = getPlayerByUsername(blackUsername);
  if (!white || !black) return null;

  let resultA = result === "white" ? 1 : result === "black" ? 0 : 0.5;
  const { newRatingA, newRatingB } = calculateElo(white.rating, black.rating, resultA);

  db.prepare(`UPDATE players SET rating=?, games=games+1, wins=wins+?, losses=losses+?, draws=draws+? WHERE username=?`)
    .run(newRatingA, result==="white"?1:0, result==="black"?1:0, result==="draw"?1:0, whiteUsername);
  db.prepare(`UPDATE players SET rating=?, games=games+1, wins=wins+?, losses=losses+?, draws=draws+? WHERE username=?`)
    .run(newRatingB, result==="black"?1:0, result==="white"?1:0, result==="draw"?1:0, blackUsername);

  db.prepare(`INSERT INTO game_history (white_username,black_username,white_rating_before,black_rating_before,white_rating_after,black_rating_after,result,moves,time_limit) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(whiteUsername, blackUsername, white.rating, black.rating, newRatingA, newRatingB, result, moves, timeLimit);

  return {
    white: { username: white.username, displayName: white.display_name, rating: white.rating, newRating: newRatingA, change: newRatingA - white.rating },
    black: { username: black.username, displayName: black.display_name, rating: black.rating, newRating: newRatingB, change: newRatingB - black.rating },
  };
}

function getLeaderboard(limit = 20) {
  return db.prepare(`
    SELECT username, display_name, rating, games, wins, losses, draws,
      CASE WHEN games > 0 THEN ROUND(wins * 100.0 / games, 1) ELSE 0 END as win_rate
    FROM players WHERE games > 0
    ORDER BY rating DESC LIMIT ?
  `).all(limit);
}

function getPlayerGames(username, limit = 10) {
  return db.prepare(`
    SELECT * FROM game_history
    WHERE white_username=? OR black_username=?
    ORDER BY played_at DESC LIMIT ?
  `).all(username, username, limit);
}

module.exports = { getPlayerByUsername, getPlayerById, createPlayer, updateRatings, getLeaderboard, getPlayerGames };
