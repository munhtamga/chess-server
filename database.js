const { Pool } = require("pg");

// Бүх environment variable-уудыг log хийх
console.log("All env keys:", Object.keys(process.env).filter(k => k.includes('DATA') || k.includes('POST') || k.includes('PG')));

const connectionString = process.env.DATABASE_URL 
  || process.env.DATABASE_PUBLIC_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRESQL_URL;

console.log("Connection string found:", !!connectionString);

const pool = new Pool(
  connectionString 
    ? { connectionString, ssl: { rejectUnauthorized: false } }
    : { host: 'trolley.proxy.rlwy.net', port: 39689, database: 'railway', user: 'postgres', password: 'TlcgAdkAAPiHqaihbshDJZylUAbGcwtu', ssl: { rejectUnauthorized: false } }
);

async function initTables() {
  console.log("Connecting to database...");
  const client = await pool.connect();
  console.log("Connected successfully!");
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT,
      rating INTEGER DEFAULT 1200,
      games INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS game_history (
      id SERIAL PRIMARY KEY,
      white_username TEXT NOT NULL,
      black_username TEXT NOT NULL,
      white_rating_before INTEGER,
      black_rating_before INTEGER,
      white_rating_after INTEGER,
      black_rating_after INTEGER,
      result TEXT NOT NULL,
      moves INTEGER DEFAULT 0,
      time_limit INTEGER,
      played_at TIMESTAMP DEFAULT NOW()
    )
  `);
  client.release();
  console.log("✅ Database tables initialized");
}

function calculateElo(ratingA, ratingB, resultA) {
  const K = 32;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const newRatingA = Math.round(ratingA + K * (resultA - expectedA));
  const newRatingB = Math.round(ratingB + K * ((1 - resultA) - (1 - expectedA)));
  return { newRatingA, newRatingB };
}

async function getPlayerByUsername(username) {
  const res = await pool.query("SELECT * FROM players WHERE username = $1", [username]);
  return res.rows[0] || null;
}

async function createPlayer(username, passwordHash, displayName) {
  await pool.query(
    "INSERT INTO players (username, password_hash, display_name) VALUES ($1, $2, $3)",
    [username, passwordHash, displayName || username]
  );
  return getPlayerByUsername(username);
}

async function updateRatings(whiteUsername, blackUsername, result, moves, timeLimit) {
  const white = await getPlayerByUsername(whiteUsername);
  const black = await getPlayerByUsername(blackUsername);
  if (!white || !black) return null;

  const resultA = result === "white" ? 1 : result === "black" ? 0 : 0.5;
  const { newRatingA, newRatingB } = calculateElo(white.rating, black.rating, resultA);

  await pool.query(
    `UPDATE players SET rating=$1, games=games+1, wins=wins+$2, losses=losses+$3, draws=draws+$4 WHERE username=$5`,
    [newRatingA, result==="white"?1:0, result==="black"?1:0, result==="draw"?1:0, whiteUsername]
  );
  await pool.query(
    `UPDATE players SET rating=$1, games=games+1, wins=wins+$2, losses=losses+$3, draws=draws+$4 WHERE username=$5`,
    [newRatingB, result==="black"?1:0, result==="white"?1:0, result==="draw"?1:0, blackUsername]
  );
  await pool.query(
    `INSERT INTO game_history (white_username,black_username,white_rating_before,black_rating_before,white_rating_after,black_rating_after,result,moves,time_limit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [whiteUsername, blackUsername, white.rating, black.rating, newRatingA, newRatingB, result, moves, timeLimit]
  );

  return {
    white: { username: white.username, displayName: white.display_name, rating: white.rating, newRating: newRatingA, change: newRatingA - white.rating },
    black: { username: black.username, displayName: black.display_name, rating: black.rating, newRating: newRatingB, change: newRatingB - black.rating },
  };
}

async function getLeaderboard(limit = 20) {
  const res = await pool.query(`
    SELECT username, display_name, rating, games, wins, losses, draws,
      CASE WHEN games > 0 THEN ROUND(wins * 100.0 / games, 1) ELSE 0 END as win_rate
    FROM players WHERE games > 0
    ORDER BY rating DESC LIMIT $1
  `, [limit]);
  return res.rows;
}

async function getPlayerGames(username, limit = 10) {
  const res = await pool.query(`
    SELECT * FROM game_history
    WHERE white_username=$1 OR black_username=$1
    ORDER BY played_at DESC LIMIT $2
  `, [username, limit]);
  return res.rows;
}

module.exports = { initTables, getPlayerByUsername, createPlayer, updateRatings, getLeaderboard, getPlayerGames };
