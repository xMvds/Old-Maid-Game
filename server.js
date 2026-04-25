/**
 * Bride Maid / Old Maid (Alice in Borderland inspired) — multiplayer prototype.
 *
 * - Server-authoritative game state
 * - Socket.IO realtime
 * - Hidden hands (only you see your own cards)
 *
 * Fan-made and not affiliated with Netflix.
 */

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const crypto = require("crypto");

function rid(len) {
  // Uppercase hex id (0-9A-F) — good enough for table/player ids
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len).toUpperCase();
}
const os = require("os");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Host/dev page (does not count as a player)
app.get("/host", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});


// Helper endpoint: show LAN URLs to open on phones/tablets (avoid localhost confusion)
app.get("/ip", (_req, res) => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      ips.push(net.address);
    }
  }
  ips.sort();
  const port = PORT;
  res.json({
    ok: true,
    port,
    ips,
    urls: ips.map(ip => `http://${ip}:${port}`)
  });
});

/** --------- Game model --------- */

const rooms = new Map();

// Single-table mode: room codes are not used in the UI.
// The server hosts exactly one active table by default.
const SINGLE_ROOM_ID = "TABLE";

/** Card: { suit: '♠'|'♥'|'♦'|'♣'|'JOKER', rank: 1..13 | null } */
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [1,2,3,4,5,6,7,8,9,10,11,12,13];

function rankLabel(rank){
  if(rank === 1) return "A";
  if(rank === 11) return "J";
  if(rank === 12) return "Q";
  if(rank === 13) return "K";
  return String(rank);
}

function makeDeck(){
  const deck = [];
  for(const suit of SUITS){
    for(const rank of RANKS){
      deck.push({ suit, rank });
    }
  }
  deck.push({ suit: "JOKER", rank: null });
  return deck;
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Alias for readability.
function shuffleInPlace(arr){
  return shuffle(arr);
}

/**
 * Build a start deck with EXACTLY 1 Joker and only pair-able non-joker cards.
 * Non-joker count is always even (0,2,4,...,52), so every non-joker can form duo setjes by rank.
 * Returns <= totalCards when parity/cap requires shrinking.
 */
function buildPairOnlyStartDeck(totalCards){
  const requested = Math.max(0, Number(totalCards) || 0);
  if(requested <= 0) return [];

  // 1 Joker + even amount of non-joker cards.
  let nonJoker = Math.max(0, Math.min(52, requested - 1));
  if(nonJoker % 2 === 1) nonJoker -= 1;

  const byRank = new Map();
  for(const r of RANKS) byRank.set(r, shuffle([...SUITS]));

  function pickRankWithPair(){
    const eligible = RANKS.filter(r => (byRank.get(r) || []).length >= 2);
    if(!eligible.length) return null;
    return eligible[Math.floor(Math.random() * eligible.length)];
  }

  function takePair(rank){
    const suits = byRank.get(rank) || [];
    if(suits.length < 2) return [];
    const a = suits.pop();
    const b = suits.pop();
    byRank.set(rank, suits);
    return [{ suit: a, rank }, { suit: b, rank }];
  }

  const out = [{ suit: "JOKER", rank: null }];
  const pairCount = Math.floor(nonJoker / 2);
  for(let i=0;i<pairCount;i++){
    const r = pickRankWithPair();
    if(r == null) break;
    out.push(...takePair(r));
  }

  return out;
}

function normalizeName(name){
  // Return empty string when not provided; caller decides default.
  return String(name || "").trim().slice(0, 18);
}

function nextDefaultPlayerName(room){
  const used = new Set(room.players.map(p => String(p.name || "").toLowerCase()));
  let i = 1;
  while(i < 999){
    const n = `Speler ${i}`;
    if(!used.has(n.toLowerCase())) return n;
    i++;
  }
  return `Speler ${Math.floor(Math.random()*999)}`;
}


function uniqueName(room, name){
  const base = String(name || "").trim().slice(0, 18) || "Speler";
  const used = new Set(room.players.map(p => String(p.name || "").toLowerCase()));
  const baseKey = base.toLowerCase();
  if(!used.has(baseKey)) return base;

  // Suffix with " 2", " 3", ... while respecting max length (18)
  let i = 2;
  while(i < 999){
    const suffix = ` ${i}`;
    const trimmedBase = base.slice(0, Math.max(1, 18 - suffix.length));
    const candidate = (trimmedBase + suffix).trim().slice(0,18);
    if(!used.has(candidate.toLowerCase())) return candidate;
    i++;
  }
  // Fallback (extremely unlikely)
  return (base.slice(0, 14) + " " + Math.floor(Math.random()*99)).slice(0,18);
}

/**
 * Remove pairs by rank (ignore Joker).
 * For each rank, remove floor(n/2)*2 cards.
 * Mutates hand. Returns discarded cards.
 */
function discardPairs(hand){
  const byRank = new Map();
  hand.forEach((c, idx) => {
    if(c.suit === "JOKER") return;
    const key = c.rank;
    if(!byRank.has(key)) byRank.set(key, []);
    byRank.get(key).push(idx);
  });

  const removeIndices = [];
  for(const indices of byRank.values()){
    const pairs = Math.floor(indices.length/2);
    if(pairs <= 0) continue;
    removeIndices.push(...indices.slice(0, pairs*2));
  }
  removeIndices.sort((a,b)=>b-a);

  const discarded = [];
  for(const idx of removeIndices){
    discarded.push(hand[idx]);
    hand.splice(idx, 1);
  }
  return discarded;
}

function createRoom(idOverride){
  const id = String(idOverride || rid(6)).toUpperCase();
  const room = {
    id,
    createdAt: Date.now(),
    hostSocketId: null,
    hostPlayerId: null,
    started: false,
    direction: "right", // Netflix/show: take from right (counterclockwise). Can toggle.
    players: [], // { id, reconnectKey, name, socketId, seat, hand, eliminated, offline }
    turnSeat: 0,
    phase: "lobby", // lobby | choosing | gameover
    pendingDraw: null, // { activeSeat, targetSeat, hintIndex, createdAt }
    discardPile: [],
    log: [],
    settings: {
      maxPlayers: 6,
      startingHandSize: 7,
      dealMode: "handSize", // 'handSize' | 'full'
      // Requested: Joker loss always redistributes remaining cards.
      redistributeOnJokerLoss: true,
      // Requested: leave seat always redistributes remaining cards.
      redistributeOnLeave: true,
      // Requested: optional auto-pick toggle (global)
      autoPickEnabled: false,
      autoPickSeconds: 12
    },
    _autoTimer: null,
    winnerSeat: null
  };
  rooms.set(id, room);
  return room;
}

function getOrCreateSingleRoom(){
  let room = rooms.get(SINGLE_ROOM_ID);
  if(!room) room = createRoom(SINGLE_ROOM_ID);
  return room;
}

function getRoom(id){ return rooms.get(String(id||"").toUpperCase()); }

function addLog(room, msg){
  room.log.unshift({ t: Date.now(), msg });
  room.log = room.log.slice(0, 60);
}

function publicPlayers(room){
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    cardCount: p.hand.length,
    eliminated: p.eliminated,
    offline: p.offline
  }));
}

function aliveSeats(room){
  return room.players
    .filter(p => !p.eliminated)
    .map(p => p.seat)
    .sort((a,b)=>a-b);
}

function countAlive(room){
  return room.players.filter(p=>!p.eliminated).length;
}

function nextAliveSeat(room, fromSeat, step){
  const n = room.settings.maxPlayers;
  if(n <= 0) return null;
  let s = fromSeat;
  for(let i=0;i<n;i++){
    s = (s + step + n) % n;
    const p = room.players.find(x=>x.seat===s);
    if(p && !p.eliminated) return s;
  }
  return null;
}

function leftTargetSeat(room, activeSeat){
  // left around table in UI = clockwise seat+1
  return nextAliveSeat(room, activeSeat, +1);
}
function rightTargetSeat(room, activeSeat){
  // right around table in UI = counterclockwise seat-1
  return nextAliveSeat(room, activeSeat, -1);
}

function targetSeatForTurn(room, activeSeat){
  return room.direction === "left" ? leftTargetSeat(room, activeSeat) : rightTargetSeat(room, activeSeat);
}

function ensureTurnIsAlive(room){
  const current = room.players.find(p=>p.seat===room.turnSeat);
  if(!current || current.eliminated){
    const next = aliveSeats(room)[0];
    if(next != null) room.turnSeat = next;
  }
}

function broadcastAction(room, action){
  io.to(room.id).emit("action", {
    id: rid(10),
    t: Date.now(),
    ...action
  });
}

function cardToLabel(card){
  return card.suit === "JOKER" ? "JOKER" : `${rankLabel(card.rank)}${card.suit}`;
}

function redistributeCards(room, cards, startSeat){
  const recipients = room.players.filter(p=>!p.eliminated);
  if(recipients.length === 0) return;

  shuffle(cards);
  // order recipients by seat starting from startSeat (inclusive), clockwise
  const ordered = [];
  const n = room.settings.maxPlayers;
  for(let k=0;k<n;k++){
    const seat = (startSeat + k) % n;
    const p = room.players.find(x=>x.seat===seat);
    if(p && !p.eliminated) ordered.push(p);
  }

  let idx = 0;
  for(const card of cards){
    ordered[idx % ordered.length].hand.push(card);
    idx++;
  }

  // After redistribution, discard pairs for everyone who received cards
  for(const p of ordered){
    const discarded = discardPairs(p.hand);
    if(discarded.length) room.discardPile.push(...discarded);
  }
}

function eliminatePlayer(room, player, reason, options = {}){
  if(player.eliminated) return { redistributed: 0 };
  player.eliminated = true;

  const reasonText =
    reason === "jokerLost" ? "Joker kwijt" :
    reason === "noCards" ? "Geen kaarten" :
    reason === "leftSeat" ? "Seat verlaten" :
    "Af";

  addLog(room, `☠️ ${player.name} is af (${reasonText}).`);

  let redistributed = 0;
  const shouldRedistribute = !!options.redistribute;
  const startSeat = options.startSeat ?? (aliveSeats(room)[0] ?? 0);

  if(shouldRedistribute && player.hand.length){
    const remaining = player.hand.splice(0, player.hand.length);
    redistributed = remaining.length;
    addLog(room, `🔁 Kaarten van ${player.name} worden herverdeeld (${redistributed}).`);
    redistributeCards(room, remaining, startSeat);
  }

  broadcastAction(room, {
    type: "eliminate",
    seat: player.seat,
    reason,
    redistributed
  });

  return { redistributed };
}

function checkEliminations(room){
  const newly = [];
  for(const p of room.players){
    if(p.eliminated) continue;
    if(p.hand.length === 0){
      p.eliminated = true;
      addLog(room, `💥 ${p.name} heeft geen kaarten meer (GAME OVER).`);
      newly.push({ seat: p.seat, reason: "noCards" });
    }
  }
  for(const e of newly){
    broadcastAction(room, { type: "eliminate", seat: e.seat, reason: e.reason, redistributed: 0 });
  }
  return newly;
}

function checkWinner(room){
  const alive = room.players.filter(p=>!p.eliminated);
  if(alive.length === 1){
    room.phase = "gameover";
    room.winnerSeat = alive[0].seat;
    addLog(room, `🏁 ${alive[0].name} wint!`);
    broadcastAction(room, { type: "winner", seat: alive[0].seat });
    return true;
  }
  return false;
}

function deal(room){
  const deck = shuffle(makeDeck());

  room.discardPile = [];
  room.pendingDraw = null;
  room.winnerSeat = null;

  for(const p of room.players){
    p.hand = [];
    p.eliminated = false;
  }

  if(room.settings.dealMode === "full"){
    // Deal as much of the deck as possible, but keep it EQUAL for every player.
    // Any remainder cards are removed from play (go to discard pile).
    const pc = Math.max(1, room.players.length);
    const per = Math.floor(deck.length / pc);
    const totalDealt = per * pc;
    const remainder = deck.length - totalDealt;
    if(remainder > 0){
      // burn remainder cards to the middle
      room.discardPile.push(...deck.splice(0, remainder));
    }
    for(let r=0;r<per;r++){
      for(const p of room.players){
        if(deck.length) p.hand.push(deck.pop());
      }
    }
  } else {
    // Everyone gets about N cards. We enforce:
    // - exactly 1 Joker
    // - all other cards are pair-able by rank (duo setjes)
    const requested = Math.max(1, Math.min(13, Number(room.settings.startingHandSize) || 7));
    const pc = Math.max(1, room.players.length);
    const maxPossible = Math.max(1, Math.floor(deck.length / pc));
    const handSize = Math.min(requested, maxPossible);

    if(handSize !== requested){
      addLog(room, `⚠️ Start handsize ${requested} kan niet met ${pc} speler(s). Gebruik ${handSize}.`);
    }

    const targetTotal = pc * handSize;
    const playDeck = buildPairOnlyStartDeck(targetTotal);
    shuffleInPlace(playDeck);

    if(playDeck.length !== targetTotal){
      addLog(room, `ℹ️ Startdeck aangepast naar ${playDeck.length} kaarten (incl. Joker) zodat alle niet-Joker kaarten in duo setjes blijven.`);
    } else {
      addLog(room, `ℹ️ Startdeck: ${playDeck.length} kaarten (incl. Joker); alle niet-Joker kaarten zijn duo setjes op rank.`);
    }

    // Round-robin deal; by parity, some players may get 1 kaart meer/minder.
    while(playDeck.length){
      for(const p of room.players){
        if(playDeck.length) p.hand.push(playDeck.pop());
      }
    }
  }

  // IMPORTANT: do not auto-discard pairs on initial deal.
  // Pairs are discarded only after a draw (active player).

  // Random first alive
  const alive = aliveSeats(room);
  room.turnSeat = alive.length ? alive[Math.floor(Math.random()*alive.length)] : 0;
  room.phase = "choosing";
}

/** Send room state to all sockets, with per-player hidden info */
function emitState(room){
  for(const p of room.players){
    if(!p.socketId) continue;
    const socket = io.sockets.sockets.get(p.socketId);
    if(!socket) continue;

    const you = {
      id: p.id,
      name: p.name,
      seat: p.seat,
      eliminated: p.eliminated,
      hand: p.hand.map(c => ({
        suit: c.suit,
        rank: c.rank,
        label: cardToLabel(c)
      }))
    };

    let draw = null;
    if(room.pendingDraw && room.pendingDraw.activeSeat === p.seat){
      const target = room.players.find(x=>x.seat===room.pendingDraw.targetSeat);
      draw = {
        targetSeat: room.pendingDraw.targetSeat,
        targetName: target?.name ?? "",
        targetCardCount: target?.hand.length ?? 0,
        hintIndex: room.pendingDraw.hintIndex,
        autoPickSeconds: room.settings.autoPickSeconds
      };
    }

    let defend = null;
    if(room.pendingDraw && room.pendingDraw.targetSeat === p.seat){
      const active = room.players.find(x=>x.seat===room.pendingDraw.activeSeat);
      defend = {
        activeSeat: room.pendingDraw.activeSeat,
        activeName: active?.name ?? "",
        yourCardCount: p.hand.length,
        hintIndex: room.pendingDraw.hintIndex
      };
    }

    socket.emit("state", {
      roomId: room.id,
      hostSeat: (room.players.find(pp => pp.id === room.hostPlayerId)?.seat ?? 0),
      started: room.started,
      phase: room.phase,
      direction: room.direction,
      settings: room.settings,
      players: publicPlayers(room),
      turnSeat: room.turnSeat,
      pendingDrawExists: !!room.pendingDraw,
      pendingDraw: room.pendingDraw ? {
        activeSeat: room.pendingDraw.activeSeat,
        targetSeat: room.pendingDraw.targetSeat,
        hintIndex: room.pendingDraw.hintIndex,
        createdAt: room.pendingDraw.createdAt
      } : null,
      draw,
      defend,
      discardPileCount: room.discardPile.length,
      log: room.log,
      winnerSeat: room.winnerSeat
    }, you);
  }

  // Also notify non-player watchers (host/dev screen)
  emitPublicState(room);
}

function emitPublicState(room){
  io.to(room.id).emit("publicState", {
    roomId: room.id,
    started: room.started,
    phase: room.phase,
    direction: room.direction,
    settings: room.settings,
    players: publicPlayers(room),
    turnSeat: room.turnSeat,
    pendingDrawExists: !!room.pendingDraw,
    pendingDraw: room.pendingDraw ? {
      activeSeat: room.pendingDraw.activeSeat,
      targetSeat: room.pendingDraw.targetSeat,
      hintIndex: room.pendingDraw.hintIndex,
      createdAt: room.pendingDraw.createdAt
    } : null,
    discardPileCount: room.discardPile.length,
    log: room.log,
    winnerSeat: room.winnerSeat
  });
}

function requireRoomAndPlayer(socket, roomId){
  const room = getRoom(roomId || SINGLE_ROOM_ID);
  if(!room) return { error: "Room bestaat niet." };
  const player = room.players.find(p=>p.socketId===socket.id);
  if(!player) return { error: "Je zit niet in deze room." };
  return { room, player };
}

/** --------- Turn resolution --------- */

function resolveDraw(room, active, target, idx, meta={ auto:false }){
  const beforeTargetCount = target.hand.length;
  const card = target.hand.splice(idx, 1)[0];

  // Tell the TARGET (only) which exact card was taken, so they can animate it leaving their hand.
  const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : null;
  targetSocket?.emit("lostCard", {
    index: idx,
    card,
    from: target.seat,
    to: active.seat,
    t: Date.now()
  });

  active.hand.push(card);

  const pickedLabel = cardToLabel(card);

  addLog(room, `${meta.auto ? "⏱️ " : ""}${active.name} pakt een kaart van ${target.name}.`);

  // Reveal to active player only
  const activeSocket = active.socketId ? io.sockets.sockets.get(active.socketId) : null;
  activeSocket?.emit("revealPick", {
    label: pickedLabel,
    isJoker: card.suit === "JOKER",
    from: target.seat,
    to: active.seat
  });

  let discardedCount = 0;
  let redistributedCount = 0;
  let eliminatedSeat = null;

  // If Joker is picked: target eliminated immediately
  if(card.suit === "JOKER"){
    eliminatedSeat = target.seat;
    addLog(room, `🃏 ${active.name} pakt de JOKER! ${target.name} is af (GAME OVER).`);

    // eliminate and optionally redistribute remaining target hand
    const { redistributed } = eliminatePlayer(room, target, "jokerLost", {
      redistribute: room.settings.redistributeOnJokerLoss,
      startSeat: active.seat
    });
    redistributedCount = redistributed;
  } else {
    // discard pairs for active only
    const discarded = discardPairs(active.hand);
    if(discarded.length){
      discardedCount = discarded.length;
      room.discardPile.push(...discarded);
      addLog(room, `🗑️ ${active.name} legt ${discarded.length} kaart(en) weg als setjes.`);
    }
  }

  // broadcast a single "draw resolved" action for animation
  broadcastAction(room, {
    type: "drawResolved",
    activeSeat: active.seat,
    targetSeat: target.seat,
    targetHadCount: beforeTargetCount,
    pickedIsJoker: card.suit === "JOKER",
    discardedCount,
    eliminatedSeat,
    redistributedCount,
    auto: !!meta.auto
  });

  room.pendingDraw = null;

  // any player who has 0 cards -> eliminated
  checkEliminations(room);

  if(checkWinner(room)) return;

  // advance turn + begin next draw
  beginNextTurn(room);
}

function autoResolveDraw(room){
  if(!room.pendingDraw) return;
  const active = room.players.find(p=>p.seat===room.pendingDraw.activeSeat);
  const target = room.players.find(p=>p.seat===room.pendingDraw.targetSeat);
  if(!active || !target || active.eliminated || target.eliminated || target.hand.length===0){
    room.pendingDraw = null;
    ensureTurnIsAlive(room);
    return;
  }
  const idx = Math.floor(Math.random()*target.hand.length);
  resolveDraw(room, active, target, idx, { auto: true });
  emitState(room);
}

function clearAutoTimer(room){
  if(room._autoTimer){
    clearTimeout(room._autoTimer);
    room._autoTimer = null;
  }
}

function beginPendingDraw(room){
  if(!room.started || room.phase !== 'choosing') return;
  if(room.pendingDraw) return;

  // If current turn player is offline at the moment their turn starts, eliminate them.
  let guard = 0;
  while(guard++ < room.settings.maxPlayers){
    const active = room.players.find(p=>p.seat===room.turnSeat);
    if(!active || active.eliminated){
      ensureTurnIsAlive(room);
      break;
    }
    if(active.offline){
      addLog(room, `⚡ ${active.name} is offline tijdens zijn beurt → af.`);
      room.pendingDraw = null;
      eliminatePlayer(room, active, 'leftSeat', {
        redistribute: true,
        startSeat: nextAliveSeat(room, active.seat, +1) ?? 0
      });
      if(checkWinner(room)) return;
      const next = nextAliveSeat(room, room.turnSeat, +1);
      room.turnSeat = next ?? room.turnSeat;
      ensureTurnIsAlive(room);
      continue;
    }
    break;
  }

  const active = room.players.find(p=>p.seat===room.turnSeat);
  if(!active || active.eliminated) return;

  const targetSeat = targetSeatForTurn(room, active.seat);
  if(targetSeat == null){
    checkWinner(room);
    return;
  }
  const target = room.players.find(p=>p.seat===targetSeat);
  if(!target || target.eliminated || target.hand.length === 0){
    const next = nextAliveSeat(room, room.turnSeat, +1);
    room.turnSeat = next ?? room.turnSeat;
    ensureTurnIsAlive(room);
    return beginPendingDraw(room);
  }

  room.pendingDraw = {
    activeSeat: active.seat,
    targetSeat,
    hintIndex: null,
    hintUsed: false,
    createdAt: Date.now()
  };

  addLog(room, `👉 ${active.name} pakt een kaart van ${target.name}.`);
  broadcastAction(room, { type: 'beginDraw', activeSeat: active.seat, targetSeat });

  // Optional auto-pick
  clearAutoTimer(room);
  if(room.settings.autoPickEnabled){
    room._autoTimer = setTimeout(() => {
      const r = rooms.get(room.id);
      if(!r) return;
      autoResolveDraw(r);
    }, Math.max(3, room.settings.autoPickSeconds) * 1000);
  }
}

function beginNextTurn(room){
  clearAutoTimer(room);

  const next = nextAliveSeat(room, room.turnSeat, +1);
  room.turnSeat = next ?? room.turnSeat;
  ensureTurnIsAlive(room);

  room.pendingDraw = null;

  if(checkWinner(room)) return;
  beginPendingDraw(room);
}

/** --------- Socket handlers --------- */

io.on("connection", (socket) => {
  /**
   * Single-table join.
   * - If reconnectKey matches an existing player, we reconnect.
   * - Otherwise we join the single room (if not started / not full).
   */
  socket.on("joinTable", (payload, cb) => {
    const room = getOrCreateSingleRoom();
    const requestedName = normalizeName(payload?.name);
    const key = String(payload?.reconnectKey || "");
    const browserKey = String(payload?.browserKey || "").trim().slice(0, 120);

    // Reconnect flow
    if(key && room.started){
      const existing = room.players.find(p => p.reconnectKey === key);
      if(existing){
        existing.socketId = socket.id;
        existing.offline = false;
        socket.join(room.id);

        if(room.hostPlayerId === existing.id){
          room.hostSocketId = socket.id;
        }

        addLog(room, `🔌 ${existing.name} is weer verbonden.`);
        emitState(room);
        return cb?.({ ok: true, roomId: room.id, playerId: existing.id, reconnectKey: existing.reconnectKey, reconnected: true });
      }
    }

    // Browser identity flow:
    // one browser can occupy only one seat in this game (prevents rejoin with new username in same browser).
    if(browserKey){
      const sameBrowser = room.players.find(p => p.browserKey && p.browserKey === browserKey);
      if(sameBrowser){
        sameBrowser.socketId = socket.id;
        sameBrowser.offline = false;
        socket.join(room.id);

        if(room.hostPlayerId === sameBrowser.id){
          room.hostSocketId = socket.id;
        }

        addLog(room, `🔌 ${sameBrowser.name} is weer verbonden (browser).`);
        emitState(room);
        return cb?.({ ok: true, roomId: room.id, playerId: sameBrowser.id, reconnectKey: sameBrowser.reconnectKey, reconnected: true });
      }
    }

    // Fresh join flow
    // If the game is already started, allow watch/spectate without taking a seat.
    if(room.started){
      socket.join(room.id);
      socket.data = socket.data || {};
      socket.data.isSpectator = true;
      // Send an immediate snapshot
      socket.emit("publicState", {
        roomId: room.id,
        started: room.started,
        phase: room.phase,
        direction: room.direction,
        settings: room.settings,
        players: publicPlayers(room),
        turnSeat: room.turnSeat,
        pendingDrawExists: !!room.pendingDraw,
        pendingDraw: room.pendingDraw ? {
          activeSeat: room.pendingDraw.activeSeat,
          targetSeat: room.pendingDraw.targetSeat,
          hintIndex: room.pendingDraw.hintIndex,
          createdAt: room.pendingDraw.createdAt
        } : null,
        discardPileCount: room.discardPile.length,
        log: room.log,
        winnerSeat: room.winnerSeat
      });
      return cb?.({ ok: true, spectator: true, roomId: room.id });
    }

    if(room.players.length >= room.settings.maxPlayers) return cb?.({ ok: false, error: "Tafel is vol." });

    const used = new Set(room.players.map(p=>p.seat));
    let seat = 0;
    while(used.has(seat)) seat++;

    const player = {
      id: rid(8),
      reconnectKey: rid(12),
      name: uniqueName(room, requestedName || nextDefaultPlayerName(room)),
      socketId: socket.id,
      seat,
      hand: [],
      eliminated: false,
      offline: false,
      browserKey: browserKey || null
    };
    room.players.push(player);
    socket.join(room.id);

    addLog(room, `➕ ${player.name} is gejoint.`);
    emitState(room);
    cb?.({ ok: true, roomId: room.id, playerId: player.id, reconnectKey: player.reconnectKey, reconnected: false });
  });

  // Watch-only join (host/dev screen). Does not occupy a player seat.
  socket.on("watchTable", (_payload, cb) => {
    const room = getOrCreateSingleRoom();
    socket.join(room.id);
    // send an immediate snapshot
    socket.emit("publicState", {
      roomId: room.id,
      started: room.started,
      phase: room.phase,
      direction: room.direction,
      settings: room.settings,
      players: publicPlayers(room),
      turnSeat: room.turnSeat,
      pendingDrawExists: !!room.pendingDraw,
      pendingDraw: room.pendingDraw ? {
        activeSeat: room.pendingDraw.activeSeat,
        targetSeat: room.pendingDraw.targetSeat,
        hintIndex: room.pendingDraw.hintIndex,
        createdAt: room.pendingDraw.createdAt
      } : null,
      discardPileCount: room.discardPile.length,
      log: room.log,
      winnerSeat: room.winnerSeat
    });
    cb?.({ ok: true, roomId: room.id });
  });

  // Host/dev controls (no auth; intended for local dev only)
  socket.on("host_startGame", (_payload, cb) => {
    const room = getOrCreateSingleRoom();
    if(room.started) return cb?.({ ok:false, error: "Spel is al gestart." });
    if(room.players.length < 2) return cb?.({ ok:false, error: "Minimaal 2 spelers nodig." });
    room.started = true;
    addLog(room, `🎬 (HOST) Spel gestart (${room.players.length} spelers).`);
    deal(room);
    // Immediately start first draw.
    beginPendingDraw(room);
    emitState(room);
    cb?.({ ok:true });
  });

  socket.on("host_newRound", (_payload, cb) => {
    const room = getOrCreateSingleRoom();
    room.started = false;
    room.phase = "lobby";
    room.pendingDraw = null;
    room.discardPile = [];
    room.log = [];
    room.winnerSeat = null;
    for(const p of room.players){
      p.hand = [];
      p.eliminated = false;
    }

    clearAutoTimer(room);
    emitState(room);
    cb?.({ ok:true });
  });

  socket.on("host_setDirection", (payload, cb) => {
    const room = getOrCreateSingleRoom();
    const dir = payload?.direction === "left" ? "left" : "right";
    room.direction = dir;
    addLog(room, `🧭 (HOST) Richting: ${dir === 'left' ? 'links' : 'rechts'}.`);
    emitState(room);
    cb?.({ ok:true });
  });

  // Host/dev helper: resolve the current pending draw randomly (one click)
  socket.on('host_dev_step', (_payload, cb) => {
    const room = getOrCreateSingleRoom();
    if(!room.started || room.phase === 'gameover') return cb?.({ ok:false, error: 'Niet in spel.' });
    if(!room.pendingDraw) beginPendingDraw(room);
    if(!room.pendingDraw){
      emitState(room);
      return cb?.({ ok:true });
    }
    autoResolveDraw(room);
    cb?.({ ok:true });
  });

  socket.on("host_updateSettings", (payload, cb) => {
    const room = getOrCreateSingleRoom();
    const s = payload?.settings || {};
    // Only allow changes in lobby for sanity
    if(room.started) return cb?.({ ok:false, error: "Settings aanpassen kan alleen in de lobby." });

    if(s.dealMode === 'full' || s.dealMode === 'handSize') room.settings.dealMode = s.dealMode;
    if(typeof s.startingHandSize === 'number'){
      room.settings.startingHandSize = Math.max(1, Math.min(13, Math.floor(s.startingHandSize)));
    }
    if(typeof s.autoPickEnabled === 'boolean') room.settings.autoPickEnabled = s.autoPickEnabled;
    if(typeof s.autoPickSeconds === 'number') room.settings.autoPickSeconds = Math.max(3, Math.min(60, Math.floor(s.autoPickSeconds)));
    // redistributeOnJokerLoss and redistributeOnLeave are always ON.

    emitState(room);
    cb?.({ ok:true });
  });

  socket.on("bluffNudge", (payload, cb) => {
    const { room, player, error } = requireRoomAndPlayer(socket, payload?.roomId);
    if(error) return cb?.({ ok: false, error });
    if(!room.pendingDraw) return cb?.({ ok: false, error: "Er is geen actieve trekactie." });
    if(player.seat !== room.pendingDraw.targetSeat) return cb?.({ ok: false, error: "Jij bent niet de target." });

    if(room.pendingDraw.hintUsed){
      return cb?.({ ok:false, error: "Je hebt al 1× een tell gedaan deze beurt." });
    }

    const idx = payload?.index;
    if(typeof idx !== "number" || idx < 0 || idx >= player.hand.length){
      return cb?.({ ok: false, error: "Ongeldige index." });
    }
    room.pendingDraw.hintIndex = idx;
    room.pendingDraw.hintUsed = true;
    addLog(room, `😏 ${player.name} geeft een 'tell' (kaart omhoog).`);
    broadcastAction(room, { type: "nudge", seat: player.seat, index: idx });
    emitState(room);
    cb?.({ ok: true });
  });

  socket.on("chooseCard", (payload, cb) => {
    const { room, player, error } = requireRoomAndPlayer(socket, payload?.roomId);
    if(error) return cb?.({ ok: false, error });
    if(!room.pendingDraw) return cb?.({ ok: false, error: "Geen actieve trekactie." });
    if(player.seat !== room.pendingDraw.activeSeat) return cb?.({ ok: false, error: "Niet jouw keuze." });

    const target = room.players.find(p=>p.seat===room.pendingDraw.targetSeat);
    if(!target || target.eliminated) return cb?.({ ok: false, error: "Target is af." });
    const idx = payload?.index;
    if(typeof idx !== "number" || idx < 0 || idx >= target.hand.length){
      return cb?.({ ok: false, error: "Ongeldige kaart-keuze." });
    }

    resolveDraw(room, player, target, idx);
    emitState(room);
    cb?.({ ok: true });
  });

  socket.on("leaveSeat", (payload, cb) => {
    const { room, player, error } = requireRoomAndPlayer(socket, payload?.roomId);
    if(error) return cb?.({ ok: false, error });

    // Leaving is only meaningful during active game.
    if(room.started && room.phase !== "gameover" && !player.eliminated){
      addLog(room, `🚪 ${player.name} verlaat zijn seat (GAME OVER).`);

      // cancel pending draw if involved
      if(room.pendingDraw && (room.pendingDraw.activeSeat === player.seat || room.pendingDraw.targetSeat === player.seat)){
        room.pendingDraw = null;
      }

      eliminatePlayer(room, player, "leftSeat", {
        redistribute: true,
        startSeat: nextAliveSeat(room, player.seat, +1) ?? 0
      });

      // If it was their turn, advance
      if(room.turnSeat === player.seat){
        room.turnSeat = nextAliveSeat(room, room.turnSeat, +1) ?? room.turnSeat;
      }

      ensureTurnIsAlive(room);
      checkWinner(room);
      beginPendingDraw(room);
      emitState(room);
      return cb?.({ ok: true });
    }

    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    // mark player offline; if room empty -> delete
    for(const room of rooms.values()){
      const p = room.players.find(x=>x.socketId===socket.id);
      if(!p) continue;

      p.offline = true;
      p.socketId = null;

      addLog(room, `📴 ${p.name} is offline.`);

      // In lobby (game not started), a disconnect counts as a logout.
      if(!room.started){
        room.players = room.players.filter(x => x.id !== p.id);
        addLog(room, `➖ ${p.name} verliet de lobby.`);
        emitState(room);
        break;
      }

      if(room.hostSocketId === socket.id){
        room.hostSocketId = null;
      }

      // Requested behavior:
      // - If someone disconnects but reconnects BEFORE their turn, they may continue.
      // - If someone is offline when it's their turn (or becomes their turn while offline), they are eliminated.
      if(room.started && room.phase !== 'gameover' && !p.eliminated){
        const isTheirTurn = room.turnSeat === p.seat && room.pendingDraw && room.pendingDraw.activeSeat === p.seat;
        if(isTheirTurn){
          addLog(room, `⚡ ${p.name} is offline tijdens zijn beurt → af.`);
          room.pendingDraw = null;

          eliminatePlayer(room, p, 'leftSeat', {
            redistribute: true,
            startSeat: nextAliveSeat(room, p.seat, +1) ?? 0
          });

          ensureTurnIsAlive(room);
          checkWinner(room);
          beginPendingDraw(room);
        }
      }

      emitState(room);
      break;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Old Maid V2.0 running — listening on port ${PORT}`);
});
