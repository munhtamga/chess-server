const { Pool } = require("pg");
const config = require("./config");

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) { console.error("❌ No database connection string!"); process.exit(1); }

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function initTables() {
  const client = await pool.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT,
      rating INTEGER DEFAULT 1200,
      points BIGINT DEFAULT 0,
      games INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      last_login_bonus DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      description TEXT,
      related_username TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS escrow (
      id SERIAL PRIMARY KEY,
      room_id TEXT UNIQUE NOT NULL,
      white_username TEXT NOT NULL,
      black_username TEXT NOT NULL,
      white_bet BIGINT DEFAULT 0,
      black_bet BIGINT DEFAULT 0,
      total BIGINT DEFAULT 0,
      status TEXT DEFAULT 'pending',
      winner TEXT,
      platform_fee BIGINT DEFAULT 0,
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
      white_points_change BIGINT DEFAULT 0,
      black_points_change BIGINT DEFAULT 0,
      result TEXT NOT NULL,
      moves INTEGER DEFAULT 0,
      time_limit INTEGER,
      played_at TIMESTAMP DEFAULT NOW()
    )
  `);
  client.release();
  console.log("✅ Database tables initialized");
}

// ── Utility ──────────────────────────────────────────────────────────────────
function generateReferralCode(username) {
  return (username.toUpperCase().substring(0, 4) + Math.random().toString(36).substring(2, 6).toUpperCase());
}

async function addTransaction(client, username, type, amount, balanceAfter, description, relatedUsername = null) {
  await client.query(
    `INSERT INTO transactions (username, type, amount, balance_after, description, related_username) VALUES ($1,$2,$3,$4,$5,$6)`,
    [username, type, amount, balanceAfter, description, relatedUsername]
  );
}

// ── Player ────────────────────────────────────────────────────────────────────
async function getPlayerByUsername(username) {
  const res = await pool.query("SELECT * FROM players WHERE username = $1", [username]);
  return res.rows[0] || null;
}

async function createPlayer(username, passwordHash, displayName, referralCode) {
  const myCode = generateReferralCode(username);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO players (username, password_hash, display_name, points, referral_code, referred_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [username, passwordHash, displayName || username, config.STARTING_POINTS, myCode, referralCode || null]
    );
    // Бүртгэлийн bonus
    const player = (await client.query("SELECT * FROM players WHERE username=$1", [username])).rows[0];
    const newPoints = player.points + config.REGISTER_BONUS;
    await client.query("UPDATE players SET points=$1 WHERE username=$2", [newPoints, username]);
    await addTransaction(client, username, "register_bonus", config.REGISTER_BONUS, newPoints, "Welcome bonus");

    // Referral bonus
    if (referralCode) {
      const referrer = (await client.query("SELECT * FROM players WHERE referral_code=$1", [referralCode])).rows[0];
      if (referrer) {
        const refPoints = referrer.points + config.REFERRAL_INVITER;
        await client.query("UPDATE players SET points=$1 WHERE username=$2", [refPoints, referrer.username]);
        await addTransaction(client, referrer.username, "referral_bonus", config.REFERRAL_INVITER, refPoints, `Referred ${username}`, username);
        const invitedPoints = newPoints + config.REFERRAL_INVITED;
        await client.query("UPDATE players SET points=$1 WHERE username=$2", [invitedPoints, username]);
        await addTransaction(client, username, "referral_bonus", config.REFERRAL_INVITED, invitedPoints, `Joined via referral`, referrer.username);
      }
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  return getPlayerByUsername(username);
}

// Нэвтрэлтийн өдрийн bonus
async function claimLoginBonus(username) {
  const player = await getPlayerByUsername(username);
  if (!player) return null;
  const today = new Date().toISOString().split("T")[0];
  if (player.last_login_bonus === today) return { claimed: false, points: player.points };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const newPoints = player.points + config.LOGIN_BONUS;
    await client.query("UPDATE players SET points=$1, last_login_bonus=$2 WHERE username=$3", [newPoints, today, username]);
    await addTransaction(client, username, "login_bonus", config.LOGIN_BONUS, newPoints, "Daily login bonus");
    await client.query("COMMIT");
    return { claimed: true, points: newPoints, bonus: config.LOGIN_BONUS };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Хүлээх минутын point
async function addWaitingPoints(username, minutes) {
  const amount = minutes * config.WAITING_POINT_PER_MIN;
  if (amount <= 0) return;
  const player = await getPlayerByUsername(username);
  if (!player) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const newPoints = player.points + amount;
    await client.query("UPDATE players SET points=$1 WHERE username=$2", [newPoints, username]);
    await addTransaction(client, username, "waiting_bonus", amount, newPoints, `Waited ${minutes} minutes`);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Point шилжүүлэх
async function transferPoints(fromUsername, toUsername, amount) {
  if (amount < config.TRANSFER_MIN) throw new Error(`Minimum transfer is ${config.TRANSFER_MIN}`);
  const fee = Math.floor(amount * config.TRANSFER_FEE);
  const netAmount = amount - fee;
  const from = await getPlayerByUsername(fromUsername);
  const to = await getPlayerByUsername(toUsername);
  if (!from) throw new Error("Sender not found");
  if (!to) throw new Error("Recipient not found");
  if (from.points < amount) throw new Error("Insufficient points");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fromNew = from.points - amount;
    const toNew = to.points + netAmount;
    await client.query("UPDATE players SET points=$1 WHERE username=$2", [fromNew, fromUsername]);
    await client.query("UPDATE players SET points=$1 WHERE username=$2", [toNew, toUsername]);
    await addTransaction(client, fromUsername, "transfer_out", -amount, fromNew, `Sent to ${toUsername} (fee: ${fee})`, toUsername);
    await addTransaction(client, toUsername, "transfer_in", netAmount, toNew, `Received from ${fromUsername}`, fromUsername);
    await client.query("COMMIT");
    return { fromPoints: fromNew, toPoints: toNew, fee, netAmount };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// ── Escrow (Дундын данс) ──────────────────────────────────────────────────────
async function createEscrow(roomId, whiteUsername, blackUsername, whiteBet, blackBet) {
  const white = await getPlayerByUsername(whiteUsername);
  const black = await getPlayerByUsername(blackUsername);
  if (white.points < whiteBet) throw new Error("White has insufficient points");
  if (black.points < blackBet) throw new Error("Black has insufficient points");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const total = whiteBet + blackBet;
    // Тоглогчдоос point хасах
    const whiteNew = white.points - whiteBet;
    const blackNew = black.points - blackBet;
    await client.query("UPDATE players SET points=$1 WHERE username=$2", [whiteNew, whiteUsername]);
    await client.query("UPDATE players SET points=$1 WHERE username=$2", [blackNew, blackUsername]);
    await addTransaction(client, whiteUsername, "escrow_lock", -whiteBet, whiteNew, `Bet locked for room ${roomId}`, blackUsername);
    await addTransaction(client, blackUsername, "escrow_lock", -blackBet, blackNew, `Bet locked for room ${roomId}`, whiteUsername);
    // Escrow үүсгэх
    await client.query(
      `INSERT INTO escrow (room_id, white_username, black_username, white_bet, black_bet, total, status) VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [roomId, whiteUsername, blackUsername, whiteBet, blackBet, total]
    );
    await client.query("COMMIT");
    return { total, whiteNew, blackNew };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

async function resolveEscrow(roomId, winner) {
  const esc = (await pool.query("SELECT * FROM escrow WHERE room_id=$1", [roomId])).rows[0];
  if (!esc || esc.status !== "active") return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const total = esc.total;
    const fee = Math.floor(total * config.BET_PLATFORM_FEE);
    const prize = total - fee;

    let winnerUsername = null;
    if (winner === "white") winnerUsername = esc.white_username;
    else if (winner === "black") winnerUsername = esc.black_username;

    if (winnerUsername) {
      const winPlayer = (await client.query("SELECT points FROM players WHERE username=$1", [winnerUsername])).rows[0];
      const newPoints = winPlayer.points + prize;
      await client.query("UPDATE players SET points=$1 WHERE username=$2", [newPoints, winnerUsername]);
      await addTransaction(client, winnerUsername, "bet_win", prize, newPoints, `Won bet in room ${roomId} (fee: ${fee})`);
    } else {
      // Draw — хоёулд буцаах
      const wp = (await client.query("SELECT points FROM players WHERE username=$1", [esc.white_username])).rows[0];
      const bp = (await client.query("SELECT points FROM players WHERE username=$1", [esc.black_username])).rows[0];
      const whiteRefund = esc.white_bet - Math.floor(esc.white_bet * config.BET_PLATFORM_FEE);
      const blackRefund = esc.black_bet - Math.floor(esc.black_bet * config.BET_PLATFORM_FEE);
      await client.query("UPDATE players SET points=$1 WHERE username=$2", [wp.points + whiteRefund, esc.white_username]);
      await client.query("UPDATE players SET points=$1 WHERE username=$2", [bp.points + blackRefund, esc.black_username]);
      await addTransaction(client, esc.white_username, "bet_draw_refund", whiteRefund, wp.points + whiteRefund, `Draw refund room ${roomId}`);
      await addTransaction(client, esc.black_username, "bet_draw_refund", blackRefund, bp.points + blackRefund, `Draw refund room ${roomId}`);
    }

    await client.query("UPDATE escrow SET status='resolved', winner=$1, platform_fee=$2 WHERE room_id=$3", [winner, fee, roomId]);
    await client.query("COMMIT");
    return { prize, fee, winner };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

async function getEscrow(roomId) {
  const res = await pool.query("SELECT * FROM escrow WHERE room_id=$1", [roomId]);
  return res.rows[0] || null;
}

// ── Rating ────────────────────────────────────────────────────────────────────
function calculateElo(ratingA, ratingB, resultA) {
  const K = 32;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const newRatingA = Math.round(ratingA + K * (resultA - expectedA));
  const newRatingB = Math.round(ratingB + K * ((1 - resultA) - (1 - expectedA)));
  return { newRatingA, newRatingB };
}

async function updateRatings(whiteUsername, blackUsername, result, moves, timeLimit) {
  const white = await getPlayerByUsername(whiteUsername);
  const black = await getPlayerByUsername(blackUsername);
  if (!white || !black) return null;

  const resultA = result === "white" ? 1 : result === "black" ? 0 : 0.5;
  const { newRatingA, newRatingB } = calculateElo(white.rating, black.rating, resultA);

  const whiteBonus = result === "white" ? config.WIN_BONUS : result === "draw" ? config.DRAW_BONUS : config.LOSS_BONUS;
  const blackBonus = result === "black" ? config.WIN_BONUS : result === "draw" ? config.DRAW_BONUS : config.LOSS_BONUS;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const whiteNewPoints = white.points + whiteBonus;
    const blackNewPoints = black.points + blackBonus;

    await client.query(
      `UPDATE players SET rating=$1, games=games+1, wins=wins+$2, losses=losses+$3, draws=draws+$4, points=$5 WHERE username=$6`,
      [newRatingA, result==="white"?1:0, result==="black"?1:0, result==="draw"?1:0, whiteNewPoints, whiteUsername]
    );
    await client.query(
      `UPDATE players SET rating=$1, games=games+1, wins=wins+$2, losses=losses+$3, draws=draws+$4, points=$5 WHERE username=$6`,
      [newRatingB, result==="black"?1:0, result==="white"?1:0, result==="draw"?1:0, blackNewPoints, blackUsername]
    );

    if (whiteBonus > 0) await addTransaction(client, whiteUsername, "game_bonus", whiteBonus, whiteNewPoints, `Game result: ${result}`);
    if (blackBonus > 0) await addTransaction(client, blackUsername, "game_bonus", blackBonus, blackNewPoints, `Game result: ${result}`);

    await client.query(
      `INSERT INTO game_history (white_username,black_username,white_rating_before,black_rating_before,white_rating_after,black_rating_after,white_points_change,black_points_change,result,moves,time_limit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [whiteUsername, blackUsername, white.rating, black.rating, newRatingA, newRatingB, whiteBonus, blackBonus, result, moves, timeLimit]
    );
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }

  return {
    white: { username: white.username, displayName: white.display_name, rating: white.rating, newRating: newRatingA, change: newRatingA - white.rating, pointsChange: whiteBonus },
    black: { username: black.username, displayName: black.display_name, rating: black.rating, newRating: newRatingB, change: newRatingB - black.rating, pointsChange: blackBonus },
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────
async function getLeaderboard(limit = 20) {
  const res = await pool.query(`
    SELECT username, display_name, rating, points, games, wins, losses, draws,
      CASE WHEN games > 0 THEN ROUND(wins * 100.0 / games, 1) ELSE 0 END as win_rate
    FROM players WHERE games > 0
    ORDER BY rating DESC LIMIT $1
  `, [limit]);
  return res.rows;
}

async function getAllPlayers(limit = 100) {
  const res = await pool.query(`
    SELECT username, display_name, rating, points, games, wins, losses, draws, referral_code, created_at
    FROM players ORDER BY points DESC LIMIT $1
  `, [limit]);
  return res.rows;
}

async function getPlayerTransactions(username, limit = 20) {
  const res = await pool.query(`
    SELECT * FROM transactions WHERE username=$1 ORDER BY created_at DESC LIMIT $2
  `, [username, limit]);
  return res.rows;
}

async function getPlatformStats() {
  const totalFees = await pool.query(`SELECT COALESCE(SUM(platform_fee), 0) as total FROM escrow WHERE status='resolved'`);
  const totalPlayers = await pool.query(`SELECT COUNT(*) as total FROM players`);
  const totalGames = await pool.query(`SELECT COUNT(*) as total FROM game_history`);
  const totalPoints = await pool.query(`SELECT COALESCE(SUM(points), 0) as total FROM players`);
  return {
    platformFees: totalFees.rows[0].total,
    totalPlayers: totalPlayers.rows[0].total,
    totalGames: totalGames.rows[0].total,
    totalPoints: totalPoints.rows[0].total,
  };
}

module.exports = {
  initTables, getPlayerByUsername, createPlayer, claimLoginBonus,
  addWaitingPoints, transferPoints, updateRatings,
  createEscrow, resolveEscrow, getEscrow,
  getLeaderboard, getAllPlayers, getPlayerTransactions, getPlatformStats,
};
