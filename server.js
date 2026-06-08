require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("./config");
const {
  initTables, getPlayerByUsername, createPlayer, claimLoginBonus,
  addWaitingPoints, transferPoints, updateRatings,
  createEscrow, resolveEscrow, getEscrow,
  getLeaderboard, getAllPlayers, getPlayerTransactions, getPlatformStats,
} = require("./database");

const JWT_SECRET = process.env.JWT_SECRET || "chess_secret_key_2024";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: "Admin only" });
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post("/auth/register", async (req, res) => {
  try {
    const { username, password, displayName, referralCode } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const existing = await getPlayerByUsername(username);
    if (existing) return res.status(400).json({ error: "Username already taken" });
    const passwordHash = await bcrypt.hash(password, 10);
    const player = await createPlayer(username, passwordHash, displayName || username, referralCode);
    const token = jwt.sign({ id: player.id, username: player.username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: player.id, username: player.username, displayName: player.display_name, rating: player.rating, points: player.points, referralCode: player.referral_code } });
  } catch (e) { console.error("Register error:", e); res.status(500).json({ error: "Server error" }); }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const player = await getPlayerByUsername(username);
    if (!player) return res.status(400).json({ error: "User not found" });
    if (!player.password_hash) return res.status(400).json({ error: "This account uses Google login" });
    const valid = await bcrypt.compare(password, player.password_hash);
    if (!valid) return res.status(400).json({ error: "Wrong password" });
    const loginBonus = await claimLoginBonus(username);
    const token = jwt.sign({ id: player.id, username: player.username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: player.id, username: player.username, displayName: player.display_name, rating: player.rating, points: loginBonus.points, referralCode: player.referral_code }, loginBonus });
  } catch (e) { console.error("Login error:", e); res.status(500).json({ error: "Server error" }); }
});

app.post("/auth/admin", (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password" });
  const token = jwt.sign({ isAdmin: true }, JWT_SECRET, { expiresIn: "1d" });
  res.json({ token });
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const player = await getPlayerByUsername(req.user.username);
    if (!player) return res.status(404).json({ error: "User not found" });
    const transactions = await getPlayerTransactions(req.user.username, 20);
    res.json({ user: { id: player.id, username: player.username, displayName: player.display_name, rating: player.rating, points: player.points, games: player.games, wins: player.wins, losses: player.losses, draws: player.draws, referralCode: player.referral_code }, transactions });
  } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// ── Points ────────────────────────────────────────────────────────────────────
app.post("/points/transfer", authMiddleware, async (req, res) => {
  try {
    const { toUsername, amount } = req.body;
    if (!toUsername || !amount) return res.status(400).json({ error: "Missing fields" });
    if (toUsername === req.user.username) return res.status(400).json({ error: "Cannot transfer to yourself" });
    const result = await transferPoints(req.user.username, toUsername, amount);
    res.json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/points/transactions", authMiddleware, async (req, res) => {
  try {
    const transactions = await getPlayerTransactions(req.user.username, 50);
    res.json(transactions);
  } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get("/admin/players", adminMiddleware, async (req, res) => {
  try { res.json(await getAllPlayers(200)); }
  catch (e) { res.status(500).json({ error: "Server error" }); }
});

app.get("/admin/stats", adminMiddleware, async (req, res) => {
  try { res.json(await getPlatformStats()); }
  catch (e) { res.status(500).json({ error: "Server error" }); }
});

app.post("/admin/adjust-points", adminMiddleware, async (req, res) => {
  try {
    const { username, amount, reason } = req.body;
    const player = await getPlayerByUsername(username);
    if (!player) return res.status(404).json({ error: "Player not found" });
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const newPoints = Math.max(0, player.points + amount);
    await pool.query("UPDATE players SET points=$1 WHERE username=$2", [newPoints, username]);
    await pool.query("INSERT INTO transactions (username,type,amount,balance_after,description) VALUES ($1,$2,$3,$4,$5)",
      [username, "admin_adjust", amount, newPoints, reason || "Admin adjustment"]);
    res.json({ success: true, newPoints });
  } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
app.get("/leaderboard", async (_, res) => {
  try { res.json(await getLeaderboard(20)); }
  catch (e) { res.status(500).json({ error: "Server error" }); }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(roomId, timeLimit) {
  rooms[roomId] = {
    id: roomId, chess: new Chess(), players: {}, spectators: [],
    status: "waiting", timeLimit: timeLimit * 60 * 1000,
    timers: { white: timeLimit * 60 * 1000, black: timeLimit * 60 * 1000 },
    lastMoveTime: null, timerInterval: null, moveHistory: [], drawOffer: null,
    bets: { white: 0, black: 0 }, escrowCreated: false,
    joinTimes: {},
  };
  return rooms[roomId];
}

function assignColor(room) {
  const taken = Object.values(room.players).map((p) => p.color);
  if (taken.length === 0) return Math.random() < 0.5 ? "white" : "black";
  return taken[0] === "white" ? "black" : "white";
}

function startTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.lastMoveTime = Date.now();
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    if (!rooms[roomId] || room.status !== "playing") { clearInterval(room.timerInterval); return; }
    const cur = room.chess.turn() === "w" ? "white" : "black";
    room.timers[cur] -= Date.now() - room.lastMoveTime;
    room.lastMoveTime = Date.now();
    if (room.timers[cur] <= 0) {
      room.timers[cur] = 0; room.status = "finished"; clearInterval(room.timerInterval);
      const winner = cur === "white" ? "black" : "white";
      endGame(room, roomId, winner);
    } else {
      io.to(roomId).emit("timerUpdate", { timers: { ...room.timers } });
    }
  }, 1000);
}

function stopTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

async function endGame(room, roomId, result) {
  const list = Object.values(room.players);
  if (list.length < 2) return;
  const white = list.find((p) => p.color === "white");
  const black = list.find((p) => p.color === "black");
  if (!white || !black) return;

  let rc = null, escrowResult = null;
  try {
    rc = await updateRatings(white.username, black.username, result, room.moveHistory.length, room.timeLimit / 60000);
    if (room.escrowCreated) {
      escrowResult = await resolveEscrow(roomId, result);
    }
  } catch (e) { console.error("Game end error:", e); }

  // Хүлээсэн цагийн point
  for (const [, p] of Object.entries(room.players)) {
    if (room.joinTimes[p.username]) {
      const mins = Math.floor((Date.now() - room.joinTimes[p.username]) / 60000);
      if (mins > 0) await addWaitingPoints(p.username, mins).catch(() => {});
    }
  }

  io.to(roomId).emit("gameOver", {
    type: result === "white" || result === "black" ? "win" : result,
    winner: result === "draw" ? null : result,
    message: result === "draw" ? "Draw! 🤝" : `${result === "white" ? white.name : black.name} wins! 🏆`,
    ratingChanges: rc,
    escrowResult,
  });
}

io.on("connection", (socket) => {
  socket.on("authenticate", async ({ token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const player = await getPlayerByUsername(decoded.username);
      if (player) {
        socket.username = player.username;
        socket.displayName = player.display_name;
        socket.rating = player.rating;
        socket.points = player.points;
        socket.emit("authenticated", { username: player.username, displayName: player.display_name, rating: player.rating, points: player.points, referralCode: player.referral_code });
      }
    } catch { socket.emit("authError", { message: "Invalid token" }); }
  });

  socket.on("joinRoom", async ({ roomId, timeLimit, bet }) => {
    if (!socket.username) return socket.emit("error", { message: "Please login first" });
    let room = rooms[roomId] || createRoom(roomId, timeLimit || 10);
    const playerCount = Object.keys(room.players).length;
    const player = await getPlayerByUsername(socket.username);

    if (playerCount >= 2) {
      room.spectators.push(socket.id); socket.join(roomId);
      socket.emit("joinedAsSpectator", { roomId, fen: room.chess.fen(), message: "You joined as a spectator", timers: room.timers, timeLimit: room.timeLimit, moveHistory: room.moveHistory });
      return;
    }

    const color = assignColor(room);
    room.players[socket.id] = { color, username: player.username, name: player.display_name, rating: player.rating, points: player.points };
    room.bets[color] = bet || 0;
    room.joinTimes[player.username] = Date.now();
    socket.join(roomId);

    socket.emit("joinedRoom", { roomId, color, playerName: player.display_name, playerRating: player.rating, playerPoints: player.points, fen: room.chess.fen(), message: color === "white" ? "You are White — your turn first!" : "You are Black — wait for White", timers: room.timers, timeLimit: room.timeLimit, moveHistory: room.moveHistory });

    if (Object.keys(room.players).length === 2) {
      room.status = "playing";
      // Escrow үүсгэх
      if (room.bets.white > 0 || room.bets.black > 0) {
        const wPlayer = Object.values(room.players).find(p => p.color === "white");
        const bPlayer = Object.values(room.players).find(p => p.color === "black");
        try {
          await createEscrow(roomId, wPlayer.username, bPlayer.username, room.bets.white, room.bets.black);
          room.escrowCreated = true;
        } catch (e) {
          io.to(roomId).emit("error", { message: `Bet error: ${e.message}` });
          return;
        }
      }
      const playerList = Object.entries(room.players).map(([id, p]) => ({ socketId: id, name: p.name, color: p.color, rating: p.rating }));
      io.to(roomId).emit("gameStart", { players: playerList, fen: room.chess.fen(), turn: "white", message: "Game started! White goes first.", timers: room.timers, timeLimit: room.timeLimit, moveHistory: room.moveHistory, bets: room.bets });
      startTimer(roomId);
    }
  });

  socket.on("makeMove", async ({ roomId, move }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    const player = room.players[socket.id];
    if (!player) return socket.emit("error", { message: "You are not a player" });
    const cur = room.chess.turn() === "w" ? "white" : "black";
    if (player.color !== cur) return socket.emit("error", { message: "Not your turn" });
    if (room.lastMoveTime) room.timers[cur] = Math.max(0, room.timers[cur] - (Date.now() - room.lastMoveTime));

    let result;
    try { result = room.chess.move(move); } catch { return socket.emit("invalidMove", { move, message: "Invalid move" }); }
    if (!result) return socket.emit("invalidMove", { move, message: "Move not allowed" });

    room.lastMoveTime = Date.now(); room.drawOffer = null;
    room.moveHistory.push({ san: result.san, from: result.from, to: result.to, color: result.color, fen: room.chess.fen(), moveNumber: Math.ceil(room.moveHistory.length / 2) + 1 });

    const fen = room.chess.fen();
    const nextTurn = room.chess.turn() === "w" ? "white" : "black";

    let gameOver = null;
    if (room.chess.isCheckmate()) { gameOver = { type: "checkmate", winner: player.color }; room.status = "finished"; stopTimer(room); await endGame(room, roomId, player.color); }
    else if (room.chess.isDraw()) { gameOver = { type: "draw" }; room.status = "finished"; stopTimer(room); await endGame(room, roomId, "draw"); }
    else if (room.chess.isStalemate()) { gameOver = { type: "stalemate" }; room.status = "finished"; stopTimer(room); await endGame(room, roomId, "draw"); }

    if (!gameOver) {
      io.to(roomId).emit("moveMade", { move: result, fen, turn: nextTurn, inCheck: room.chess.inCheck(), gameOver: null, movedBy: { socketId: socket.id, name: player.name, color: player.color }, timers: { ...room.timers }, moveHistory: room.moveHistory });
    }
  });

  socket.on("offerDraw", ({ roomId }) => {
    const room = rooms[roomId]; if (!room || !room.players[socket.id]) return;
    const player = room.players[socket.id]; room.drawOffer = player.color;
    io.to(roomId).emit("drawOffered", { by: player.color, message: `${player.name} offers a draw` });
  });

  socket.on("acceptDraw", async ({ roomId }) => {
    const room = rooms[roomId]; if (!room || !room.drawOffer) return;
    room.status = "finished"; stopTimer(room);
    await endGame(room, roomId, "draw");
  });

  socket.on("declineDraw", ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    room.drawOffer = null;
    io.to(roomId).emit("drawDeclined", { message: "Draw offer declined" });
  });

  socket.on("restartGame", ({ roomId }) => {
    const room = rooms[roomId]; if (!room || !room.players[socket.id]) return;
    stopTimer(room); room.chess.reset(); room.status = "playing";
    room.timers = { white: room.timeLimit, black: room.timeLimit };
    room.moveHistory = []; room.drawOffer = null;
    room.bets = { white: 0, black: 0 }; room.escrowCreated = false;
    Object.keys(room.players).forEach((id) => { room.players[id].color = room.players[id].color === "white" ? "black" : "white"; });
    const playerList = Object.entries(room.players).map(([id, p]) => ({ socketId: id, name: p.name, color: p.color, rating: p.rating }));
    io.to(roomId).emit("gameRestarted", { players: playerList, fen: room.chess.fen(), turn: "white", message: "Game restarted! Colors swapped.", timers: room.timers, timeLimit: room.timeLimit, moveHistory: [] });
    startTimer(roomId);
  });

  socket.on("resign", async ({ roomId }) => {
    const room = rooms[roomId]; if (!room || !room.players[socket.id]) return;
    const player = room.players[socket.id];
    const winner = player.color === "white" ? "black" : "white";
    room.status = "finished"; stopTimer(room);
    await endGame(room, roomId, winner);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        const player = room.players[socket.id];
        delete room.players[socket.id]; stopTimer(room);
        io.to(roomId).emit("playerDisconnected", { name: player.name, message: `${player.name} disconnected.` });
        if (Object.keys(room.players).length === 0) delete rooms[roomId];
        break;
      }
      const idx = room.spectators.indexOf(socket.id);
      if (idx !== -1) room.spectators.splice(idx, 1);
    }
  });
});

const PORT = process.env.PORT || 3001;
initTables().then(() => {
  server.listen(PORT, () => console.log(`\n🚀 Chess server: http://localhost:${PORT}\n`));
}).catch((err) => { console.error("DB init failed:", err); process.exit(1); });
