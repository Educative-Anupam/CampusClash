const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();
const QUESTION_SECONDS = 15;
const QUESTIONS_PER_GAME = 8;

const questions = [
  {
    category: "Science",
    text: "Which planet is known as the Red Planet?",
    choices: ["Venus", "Mars", "Jupiter", "Mercury"],
    answer: 1
  },
  {
    category: "Technology",
    text: "What does CPU stand for?",
    choices: [
      "Central Processing Unit",
      "Computer Power Utility",
      "Core Program Upload",
      "Central Program User"
    ],
    answer: 0
  },
  {
    category: "General Knowledge",
    text: "What is the capital of Japan?",
    choices: ["Seoul", "Beijing", "Tokyo", "Bangkok"],
    answer: 2
  },
  {
    category: "Fun Trivia",
    text: "How many hearts does an octopus have?",
    choices: ["One", "Two", "Three", "Four"],
    answer: 2
  },
  {
    category: "Science",
    text: "What gas do plants absorb from the air?",
    choices: ["Oxygen", "Carbon dioxide", "Hydrogen", "Helium"],
    answer: 1
  },
  {
    category: "Technology",
    text: "Which of these is a web browser?",
    choices: ["Python", "Firefox", "Linux", "Bluetooth"],
    answer: 1
  },
  {
    category: "General Knowledge",
    text: "How many sides does a hexagon have?",
    choices: ["Five", "Six", "Seven", "Eight"],
    answer: 1
  },
  {
    category: "Fun Trivia",
    text: "What is the name of the toy cowboy in Toy Story?",
    choices: ["Buzz", "Rex", "Woody", "Andy"],
    answer: 2
  }
];

function makeRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score
    })),
    questionNumber: room.questionNumber,
    totalQuestions: QUESTIONS_PER_GAME,
    question: room.currentQuestion
      ? {
          category: room.currentQuestion.category,
          text: room.currentQuestion.text,
          choices: room.currentQuestion.choices,
          endsAt: room.endsAt
        }
      : null,
    lastQuestion: room.lastQuestion
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}

function finishQuestion(room) {
  if (room.status !== "question") return;

  clearTimeout(room.timer);
  room.status = "reveal";

  const correctAnswer = room.currentQuestion.answer;
  room.lastQuestion = {
    correctAnswer,
    correctText: room.currentQuestion.choices[correctAnswer],
    leaderboard: [...room.players.values()]
      .map(({ id, name, score }) => ({ id, name, score }))
      .sort((a, b) => b.score - a.score)
  };

  broadcastRoom(room);

  room.timer = setTimeout(() => {
    if (room.questionNumber >= QUESTIONS_PER_GAME) {
      room.status = "finished";
      room.currentQuestion = null;
      broadcastRoom(room);
      return;
    }

    startQuestion(room);
  }, 3500);
}

function startQuestion(room) {
  const question = questions[room.questionNumber % questions.length];

  room.status = "question";
  room.currentQuestion = question;
  room.questionNumber += 1;
  room.endsAt = Date.now() + QUESTION_SECONDS * 1000;

  for (const player of room.players.values()) {
    player.answered = false;
  }

  broadcastRoom(room);
  room.timer = setTimeout(() => finishQuestion(room), QUESTION_SECONDS * 1000);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }, reply) => {
    const playerName = String(name || "").trim().slice(0, 18);
    if (!playerName) return reply({ error: "Enter a nickname." });

    let code;
    do {
      code = makeRoomCode();
    } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      status: "lobby",
      players: new Map(),
      questionNumber: 0,
      currentQuestion: null,
      lastQuestion: null,
      timer: null
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      score: 0,
      answered: false
    });

    rooms.set(code, room);
    socket.join(code);
    reply({ room: publicRoom(room) });
  });

  socket.on("room:join", ({ code, name }, reply) => {
    const roomCode = String(code || "").trim().toUpperCase();
    const playerName = String(name || "").trim().slice(0, 18);
    const room = rooms.get(roomCode);

    if (!playerName) return reply({ error: "Enter a nickname." });
    if (!room) return reply({ error: "Room not found." });
    if (room.status !== "lobby") {
      return reply({ error: "That game has already started." });
    }
    if (room.players.size >= 8) {
      return reply({ error: "That room is full (maximum 8 players)." });
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      score: 0,
      answered: false
    });

    socket.join(roomCode);
    broadcastRoom(room);
    reply({ room: publicRoom(room) });
  });

  socket.on("game:start", ({ code }, reply) => {
    const room = rooms.get(String(code || "").toUpperCase());

    if (!room) return reply({ error: "Room not found." });
    if (room.hostId !== socket.id) {
      return reply({ error: "Only the host can start the game." });
    }
    if (room.status !== "lobby") {
      return reply({ error: "The game has already started." });
    }
    if (room.players.size < 2) {
      return reply({ error: "At least 2 players are needed." });
    }

    room.questionNumber = 0;
    room.lastQuestion = null;
    for (const player of room.players.values()) player.score = 0;

    startQuestion(room);
    reply({ ok: true });
  });

  socket.on("answer:submit", ({ code, choice }, reply) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const player = room?.players.get(socket.id);

    if (!room || room.status !== "question" || !player) {
      return reply({ error: "This question is no longer accepting answers." });
    }
    if (player.answered) {
      return reply({ error: "You already answered." });
    }

    player.answered = true;

    if (Number(choice) === room.currentQuestion.answer) {
      const secondsLeft = Math.max(0, (room.endsAt - Date.now()) / 1000);
      const speedBonus = Math.floor(secondsLeft * 10);
      player.score += 100 + speedBonus;
    }

    reply({ ok: true });
  });

  socket.on("game:again", ({ code }, reply) => {
    const room = rooms.get(String(code || "").toUpperCase());

    if (!room) return reply({ error: "Room not found." });
    if (room.hostId !== socket.id) {
      return reply({ error: "Only the host can start another game." });
    }
    if (room.status !== "finished") {
      return reply({ error: "The current game is not finished yet." });
    }

    room.status = "lobby";
    room.questionNumber = 0;
    room.currentQuestion = null;
    room.lastQuestion = null;

    for (const player of room.players.values()) {
      player.score = 0;
      player.answered = false;
    }

    broadcastRoom(room);
    reply({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (!room.players.has(socket.id)) continue;

      room.players.delete(socket.id);

      if (room.players.size === 0) {
        clearTimeout(room.timer);
        rooms.delete(room.code);
        continue;
      }

      if (room.hostId === socket.id) {
        room.hostId = room.players.keys().next().value;
      }

      broadcastRoom(room);
    }
  });
});

const port = process.env.PORT || 10000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Campus Clash is running on port ${port}`);
});