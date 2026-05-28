# ♟️ Онлайн Шатрын Multiplayer — Fullstack Тайлбар

## 📁 Файлын бүтэц

```
chess-multiplayer/
├── server.js          ← Node.js + Socket.io backend
├── package.json       ← Backend dependencies
├── useChessSocket.js  ← React custom hook (socket логик)
└── ChessGame.jsx      ← React UI компонент
```

---

## 🏗️ Архитектур

```
┌─────────────────────────────────────────────────────────┐
│                      FRONTEND (React)                    │
│                                                         │
│  ChessGame.jsx                                          │
│  ┌──────────┐   ┌───────────────┐   ┌───────────────┐  │
│  │  Lobby   │→  │ WaitingScreen │→  │  GameScreen   │  │
│  └──────────┘   └───────────────┘   │ + Chessboard  │  │
│                                     └───────────────┘  │
│                        ↕                               │
│              useChessSocket.js (custom hook)           │
│              socket.io-client                          │
└───────────────────────┬─────────────────────────────────┘
                        │  WebSocket (ws://)
                        │
┌───────────────────────┴─────────────────────────────────┐
│                    BACKEND (Node.js)                     │
│                                                         │
│  server.js                                              │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────┐  │
│  │ Express HTTP│   │  Socket.io   │   │  chess.js   │  │
│  │ /rooms      │   │  Server      │   │  (валидац)  │  │
│  └─────────────┘   └──────┬───────┘   └─────────────┘  │
│                            │                            │
│                   ┌────────┴────────┐                   │
│                   │  Room Manager   │                   │
│                   │  rooms: {}      │                   │
│                   └─────────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

---

## 📡 Socket Events

### Client → Server (илгээх)

| Event | Payload | Тайлбар |
|-------|---------|---------|
| `joinRoom` | `{ roomId, playerName }` | Өрөөнд нэгдэх |
| `makeMove` | `{ roomId, move }` | Нүүдэл хийх |
| `resign` | `{ roomId }` | Гар татах |
| `restartGame` | `{ roomId }` | Дахин эхлүүлэх |

### Server → Client (хүлээн авах)

| Event | Тайлбар |
|-------|---------|
| `joinedRoom` | Өнгө болон мэдээлэл |
| `joinedAsSpectator` | Үзэгчээр нэгдсэн |
| `gameStart` | 2 тоглогч бэлэн — тоглоом эхлэв |
| `moveMade` | Нүүдэл хийгдсэн, шинэ FEN |
| `invalidMove` | Буруу нүүдэл |
| `gameRestarted` | Тоглоом дахин эхэлсэн |
| `gameOver` | Resign/Дуусах |
| `playerDisconnected` | Тоглогч салгагдсан |

---

## 🚀 Ажиллуулах заавар

### Backend
```bash
cd chess-multiplayer
npm install
npm start          # http://localhost:3001
# эсвэл
npm run dev        # nodemon-тай (auto-restart)
```

### Frontend
```bash
npx create-react-app chess-client
cd chess-client
npm install react-chessboard chess.js socket.io-client

# useChessSocket.js болон ChessGame.jsx-ийг src/ дотор хуулна
# App.js-д:
# import ChessGame from './ChessGame';
# export default function App() { return <ChessGame />; }

npm start          # http://localhost:3000
```

### .env (frontend)
```
REACT_APP_SERVER_URL=http://localhost:3001
```

---

## 🎮 Тоглоомын урсгал

```
Тоглогч А              Сервер              Тоглогч Б
    │                    │                    │
    │──joinRoom(ABC)──►  │                    │
    │◄──joinedRoom───    │                    │
    │  (color: white)    │                    │
    │                    │  ◄──joinRoom(ABC)──│
    │                    │  ───joinedRoom─►   │
    │                    │    (color: black)  │
    │◄──────────── gameStart ───────────────► │
    │                    │                    │
    │──makeMove(e2→e4)──►│                    │
    │                    │──────moveMade─────►│
    │◄─────moveMade──────│                    │
    │                    │                    │
```

---

## 🔒 Аюулгүй байдал (Production-д)

- `cors` origin-ийг зөвхөн frontend domain-д зааж өгнө
- Rate limiting нэмнэ (`express-rate-limit`)
- Room-ийг 24 цагийн дараа автоматаар цэвэрлэнэ
- Нүүдлийн бүртгэл (move history) хадгалах
- Redis ашиглан олон сервер дэмжих (horizontal scaling)
