const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getDb, getPlayerByUsername, createPlayer, updateRatings, getLeaderboard } = require("./database");

const JWT_SECRET = process.env.JWT_SECRET || "chess_secret_key_2024";
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

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

app.post("/auth/register", async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const existing = getPlayerByUsername(username);
  if (existing) return res.status(400).json({ error: "Username already taken" });
  const passwordHash = await bcrypt.hash(password, 10);
  const player = createPlayer(username, passwordHash, displayName || username);
  const token = jwt.sign({ id: player.id, username: player.username }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: player.id, username: player.username, displayName: player.display_name, rating: player.rating } });
});

app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  const player = getPlayerByUsername(username);
  if (!player) return res.status(400).json({ error: "User not found" });
  if (!player.password_hash) return res.status(400).json({ error: "This account uses Google login" });
  const valid = await bcrypt.compare(password, player.password_hash);
  if (!valid) return res.status(400).json({ error: "Wrong password" });
  const token = jwt.sign({ id: player.id, username: player.username }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: player.id, username: player.username, displayName: player.display_name, rating: player.rating } });
});

app.get("/auth/me", authMiddleware, (req, res) => {
  const player = getPlayerByUsername(req.user.username);
  if (!player) return res.status(404).json({ error: "User not found" });
  res.json({ user: { id: player.id, username: player.username, displayName: player.display_name, rating: player.rating, games: player.games, wins: player.wins, losses: player.losses, draws: player.draws } });
});

app.get("/leaderboard", (_, res) => res.json(getLeaderboard(20)));

const rooms = {};

function createRoom(roomId, timeLimit) {
  rooms[roomId] = {
    id: roomId, chess: new Chess(), players: {}, spectators: [],
    status: "waiting", timeLimit: timeLimit * 60 * 1000,
    timers: { white: timeLimit * 60 * 1000, black: timeLimit * 60 * 1000 },
    lastMoveTime: null, timerInterval: null, moveHistory: [], drawOffer: null,
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
      const rc = finishGame(room, winner);
      io.to(roomId).emit("gameOver", { type: "timeout", winner, message: `Time's up! ${winner === "white" ? "White" : "Black"} wins!`, ratingChanges: rc });
    } else {
      io.to(roomId).emit("timerUpdate", { timers: { ...room.timers } });
    }
  }, 1000);
}

function stopTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function finishGame(room, result) {
  const list = Object.values(room.players);
  if (list.length < 2) return null;
  const white = list.find((p) => p.color === "white");
  const black = list.find((p) => p.color === "black");
  if (!white || !black) return null;
  try { return updateRatings(white.username, black.username, result, room.moveHistory.length, room.timeLimit / 60000); }
  catch (e) { console.error("Rating error:", e); return null; }
}

io.on("connection", (socket) => {
  socket.on("authenticate", ({ token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const player = getPlayerByUsername(decoded.username);
      if (player) {
        socket.username = player.username;
        socket.displayName = player.display_name;
        socket.rating = player.rating;
        socket.emit("authenticated", { username: player.username, displayName: player.display_name, rating: player.rating });
      }
    } catch { socket.emit("authError", { message: "Invalid token" }); }
  });

  socket.on("joinRoom", ({ roomId, timeLimit }) => {
    if (!socket.username) return socket.emit("error", { message: "Please login first" });
    let room = rooms[roomId] || createRoom(roomId, timeLimit || 10);
    const playerCount = Object.keys(room.players).length;
    const player = getPlayerByUsername(socket.username);

    if (playerCount >= 2) {
      room.spectators.push(socket.id); socket.join(roomId);
      socket.emit("joinedAsSpectator", { roomId, fen: room.chess.fen(), message: "You joined as a spectator", timers: room.timers, timeLimit: room.timeLimit, moveHistory: room.moveHistory });
      return;
    }

    const color = assignColor(room);
    room.players[socket.id] = { color, username: player.username, name: player.display_name, rating: player.rating };
    socket.join(roomId);
    socket.emit("joinedRoom", { roomId, color, playerName: player.display_name, playerRating: player.rating, fen: room.chess.fen(), message: color === "white" ? "You are White — your turn first!" : "You are Black — wait for White", timers: room.timers, timeLimit: room.timeLimit, moveHistory: room.moveHistory });

    if (Object.keys(room.players).length === 2) {
      room.status = "playing";
      const playerList = Object.entries(room.players).map(([id, p]) => ({ socketId: id, name: p.name, color: p.color, rating: p.rating }));
      io.to(roomId).emit("gameStart", { players: playerList, fen: room.chess.fen(), turn: "white", message: "Game started! White goes first.", timers: room.timers, timeLimit: room.timeLimit, moveHistory: room.moveHistory });
      startTimer(roomId);
    }
  });

  socket.on("makeMove", ({ roomId, move }) => {
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
    let gameOver = null, rc = null;

    if (room.chess.isCheckmate()) { gameOver = { type: "checkmate", winner: player.color }; room.status = "finished"; stopTimer(room); rc = finishGame(room, player.color); }
    else if (room.chess.isDraw()) { gameOver = { type: "draw" }; room.status = "finished"; stopTimer(room); rc = finishGame(room, "draw"); }
    else if (room.chess.isStalemate()) { gameOver = { type: "stalemate" }; room.status = "finished"; stopTimer(room); rc = finishGame(room, "draw"); }

    io.to(roomId).emit("moveMade", { move: result, fen, turn: nextTurn, inCheck: room.chess.inCheck(), gameOver, movedBy: { socketId: socket.id, name: player.name, color: player.color }, timers: { ...room.timers }, moveHistory: room.moveHistory, ratingChanges: rc });
  });

  socket.on("offerDraw", ({ roomId }) => {
    const room = rooms[roomId]; if (!room || !room.players[socket.id]) return;
    const player = room.players[socket.id]; room.drawOffer = player.color;
    io.to(roomId).emit("drawOffered", { by: player.color, message: `${player.name} offers a draw` });
  });

  socket.on("acceptDraw", ({ roomId }) => {
    const room = rooms[roomId]; if (!room || !room.drawOffer) return;
    room.status = "finished"; stopTimer(room);
    const rc = finishGame(room, "draw");
    io.to(roomId).emit("gameOver", { type: "draw", winner: null, message: "Draw agreed! 🤝", ratingChanges: rc });
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
    Object.keys(room.players).forEach((id) => { room.players[id].color = room.players[id].color === "white" ? "black" : "white"; });
    const playerList = Object.entries(room.players).map(([id, p]) => ({ socketId: id, name: p.name, color: p.color, rating: p.rating }));
    io.to(roomId).emit("gameRestarted", { players: playerList, fen: room.chess.fen(), turn: "white", message: "Game restarted! Colors swapped.", timers: room.timers, timeLimit: room.timeLimit, moveHistory: [] });
    startTimer(roomId);
  });

  socket.on("resign", ({ roomId }) => {
    const room = rooms[roomId]; if (!room || !room.players[socket.id]) return;
    const player = room.players[socket.id];
    const winner = player.color === "white" ? "black" : "white";
    room.status = "finished"; stopTimer(room);
    const rc = finishGame(room, winner);
    io.to(roomId).emit("gameOver", { type: "resign", winner, message: `${player.name} resigned. ${winner === "white" ? "White" : "Black"} wins!`, ratingChanges: rc });
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

// Database эхлүүлсний дараа сервер ажиллуулах
getDb().then(() => {
  server.listen(PORT, () => console.log(`\n🚀 Chess server: http://localhost:${PORT}\n`));
}).catch((err) => {
  console.error("Database init failed:", err);
  process.exit(1);
});
