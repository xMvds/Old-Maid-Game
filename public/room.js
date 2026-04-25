const socket = io();

const APP_VERSION = "V2.0";

function $(id){ return document.getElementById(id); }

const roomId = "TABLE";
const BROWSER_KEY_STORAGE = "om_browser_key";

function getBrowserKey(){
  let k = localStorage.getItem(BROWSER_KEY_STORAGE) || "";
  if(k) return k;
  try{
    k = (crypto?.randomUUID?.() || "");
  }catch(_){ k = ""; }
  if(!k){
    k = `b_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  }
  localStorage.setItem(BROWSER_KEY_STORAGE, k);
  return k;
}

// If you duplicate a tab, some browsers copy sessionStorage.
// We only auto-reconnect on real reloads; new tabs always join as a new player.
let NAV_TYPE = 'navigate';
try{
  const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation') && performance.getEntriesByType('navigation')[0]) || null;
  NAV_TYPE = nav?.type || 'navigate';
}catch(_){ NAV_TYPE = 'navigate'; }

// HUD
const connBadge = $("connBadge");
const stateBadge = $("stateBadge");
const playersBadge = $("playersBadge");

// Overlays
const joinOverlay = $("joinOverlay");
const helpOverlay = $("helpOverlay");
const pickOverlay = $("pickOverlay");

// Join UI
const nameInput = $("name");
const joinBtn = $("joinBtn");
const joinErr = $("joinErr");

// Main UI
const turnLine = $("turnLine");
const leaveBtn = $("leaveBtn");

// Pick overlay
const pickTitle = $("pickTitle");
const pickSub = $("pickSub");
const drawCards = $("drawCards");
// (No close button / no defend hint banner)
if(pickOverlay) pickOverlay.hidden = true;

// Set version text (bottom-left)
try{
  const v = $("versionTag");
  if(v) v.textContent = `Old Maid ${APP_VERSION}`;
}catch(_){/* ignore */}

// Hand
const handEl = $("hand");

// FX
const fxLayer = $("fxLayer");
let lastActionT = 0;

// State
let lastState = null;
let you = null;
let lastPublic = null;

// Mode: 'player' | 'spectator'
let mode = 'player';

// Defend interaction
let nudgeSent = false;
let raisedIndex = null;

// Pick confirmation (two-click)
let selectedPickIndex = null;
let lastPickCreatedAt = null;
let lastPickAnimatedAt = null;
let drawLinkFx = null;

// --- UI helpers
function toast(text, ms=1200){
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

function showJoinError(message){
  joinErr.textContent = message || "";
  joinErr.hidden = !message;
}

function focusNameInput(){
  try{
    nameInput.focus();
    nameInput.select();
  }catch(_){/* ignore */}
}

function setConnBadge(connected){
  connBadge.textContent = connected ? "Verbonden" : "Offline";
  connBadge.style.borderColor = connected ? "rgba(120,255,170,0.35)" : "rgba(255,70,70,0.35)";
}

function openHelp(){ helpOverlay.hidden = false; }
function closeHelp(){ helpOverlay.hidden = true; }

$("helpBtn").addEventListener("click", openHelp);
$("openHelpFromJoin").addEventListener("click", openHelp);
$("closeHelp").addEventListener("click", closeHelp);
helpOverlay.addEventListener("click", (e) => {
  if(e.target === helpOverlay) closeHelp();
});

function bindHostLongPress(el){
  if(!el) return;
  let timer = null;
  const clear = () => {
    if(timer){
      clearTimeout(timer);
      timer = null;
    }
  };
  el.addEventListener('pointerdown', (e) => {
    // Mobile shortcut (touch/pen). Keep desktop D-key flow unchanged.
    if(e.pointerType === 'mouse') return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      window.open('/host', '_blank');
      toast('Host geopend', 1000);
    }, 700);
  });
  el.addEventListener('pointerup', clear);
  el.addEventListener('pointercancel', clear);
  el.addEventListener('pointerleave', clear);
}

bindHostLongPress($("joinTitle"));
bindHostLongPress($("gameBadge"));

// Keep the name field empty by default; blank = auto "Speler N" server-side.
nameInput.value = "";

function getName(){
  return (nameInput.value || "").trim().slice(0,18);
}

function join(reconnectKey){
  showJoinError("");

  // Reconnect: do not overwrite saved name, and don't auto-generate a new one.
  const name = reconnectKey ? "" : getName();
  if(!reconnectKey && name){
    localStorage.setItem("om_last_name", name);
    localStorage.setItem("om_name", name);
  }

  socket.emit("joinTable", { name, reconnectKey, browserKey: getBrowserKey() }, (res) => {
    if(!res?.ok){
      if(reconnectKey){
        sessionStorage.removeItem(`om_reconnect_${roomId}`);
        return join(null);
      }
      return showJoinError(res?.error || "Kon niet joinen.");
    }
    if(res.spectator){
      mode = 'spectator';
      you = null;
      lastState = null;
      joinOverlay.style.display = "none";
      showSpectatorBanner(true);
      render();
      return;
    }

    mode = 'player';
    showSpectatorBanner(false);
    if(res.reconnectKey) sessionStorage.setItem(`om_reconnect_${roomId}`, res.reconnectKey);
    joinOverlay.style.display = "none";
  });
}

joinBtn.addEventListener("click", () => {
  join(null);
});

nameInput.addEventListener("keydown", (e) => {
  if(e.key === "Enter") joinBtn.click();
});


// Dev-step moved to /host only.

leaveBtn.addEventListener("click", () => {
  if(!confirm("Leave seat = GAME OVER. Doorgaan?")) return;
  socket.emit("leaveSeat", { roomId }, (res) => {
    if(!res?.ok) toast(res?.error || "Kon seat niet verlaten.", 1600);
  });
});


// Pick overlay is automatic (no manual close/reopen)

// --- Debug panel (press D 3× quickly)
const dbgPanel = $("dbgPanel");
if(dbgPanel){
  const panel = dbgPanel;
  const btnClose = $("dbgClose");
  const btnCopy = $("dbgCopy");
  const btnHost = $("dbgHost");

  function buildDebugDump(){
    return {
      ts: new Date().toISOString(),
      navType: NAV_TYPE,
      you,
      lastState,
      lastPublic,
      socketId: socket.id,
      origin: location.origin,
    };
  }

  let autoHideTimer = null;
  function hidePanel(){
    panel.classList.remove("show");
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
  function armAutoHide(){
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(hidePanel, 6000);
  }
  function showPanel(){
    panel.classList.add("show");
    armAutoHide();
  }

  panel.addEventListener("pointerdown", armAutoHide);
  btnClose?.addEventListener("click", hidePanel);

  btnCopy?.addEventListener("click", async () => {
    armAutoHide();
    const txt = JSON.stringify(buildDebugDump(), null, 2);
    try{ await navigator.clipboard.writeText(txt); toast("📋 Debug state gekopieerd", 1100); }
    catch{ toast("Kon niet kopiëren", 1200); }
  });

  btnHost?.addEventListener("click", () => {
    armAutoHide();
    window.open("/host", "_blank");
  });

  let dHits = [];
  document.addEventListener("keydown", (e) => {
    if(e.repeat) return;
    const tag = (document.activeElement && document.activeElement.tagName || "").toLowerCase();
    if(tag === "input" || tag === "textarea") return;
    if(String(e.key || "").toLowerCase() !== "d") return;
    const now = Date.now();
    dHits = dHits.filter((t) => now - t < 1200);
    dHits.push(now);
    if(dHits.length >= 3){
      dHits = [];
      showPanel();
    }
  });

  const dbgTarget = document.querySelector("#gameBadge");
  if(dbgTarget){
    let tapHits = [];
    dbgTarget.addEventListener("pointerup", (e) => {
      if(e && e.pointerType && e.pointerType === "mouse") return;
      const now = Date.now();
      tapHits = tapHits.filter((t) => now - t < 900);
      tapHits.push(now);
      if(tapHits.length >= 3){
        tapHits = [];
        showPanel();
      }
    });
  }
}

// --- Socket events
let joinDecided = false;

socket.on("connect", () => {
  setConnBadge(true);

  // Watch public state (useful even before joining)
  socket.emit('watchTable', {}, (res) => {
    if(!res?.ok) {/* ignore */}
  });

  // Default: show join overlay until we decide (based on publicState).
  joinOverlay.style.display = "flex";
  showJoinError("");
  showSpectatorBanner(false);
  nameInput.value = "";
  focusNameInput();
});

socket.on("disconnect", () => {
  setConnBadge(false);
  joinOverlay.style.display = "flex";
  showJoinError("Niet verbonden met de server. Zit je op dezelfde link/Wi‑Fi?");
  showSpectatorBanner(false);
  focusNameInput();
});

socket.on("publicState", (state) => {
  lastPublic = state;

  // Join button label: join vs spectate
  if(joinOverlay && joinOverlay.style.display !== 'none'){
    if(state?.started) joinBtn.textContent = 'Spectate';
    else joinBtn.textContent = 'Join tafel';
  }

  // Spectators render from public state.
  if(mode === 'spectator'){
    render();
  }

  // Decide initial join behavior exactly once per load.
  if(!joinDecided){
    joinDecided = true;

    const key = sessionStorage.getItem(`om_reconnect_${roomId}`) || "";
    const canReconnect = !!(state?.started) && !!key;
    if(canReconnect){
      join(key);
    }else if(!state?.started){
      // Lobby: refresh behaves like logout (force name input again)
      sessionStorage.removeItem(`om_reconnect_${roomId}`);
      joinOverlay.style.display = "flex";
      showJoinError("");
      mode = 'player';
      showSpectatorBanner(false);
      nameInput.value = "";
      focusNameInput();
    }else{
      // Allow spectate (no seat) while the game is running.
      joinOverlay.style.display = "flex";
      showJoinError("Spel is al gestart. Je kunt wel meekijken (spectate). Vul evt. je naam in en klik Join.");
      nameInput.value = "";
      focusNameInput();
    }
  }

  // If you are spectating and the game returns to lobby, keep watching the lobby.
  if(mode === 'spectator' && !state?.started){
    joinOverlay.style.display = 'none';
    showJoinError('');
    showSpectatorBanner(true);
  }
});

socket.on("state", (state, youState) => {
  lastState = state;
  you = youState;
  mode = 'player';
  showSpectatorBanner(false);

  // reset one-time nudge state each defend window
  if(!state?.defend){
    nudgeSent = false;
    raisedIndex = null;
  }

  joinOverlay.style.display = "none";
  render();
});

socket.on("revealPick", (payload) => {
  if(!payload) return;
  const txt = payload.isJoker ? "🃏 JOKER! Je pakte de Joker." : `Je pakte: ${payload.label}`;
  toast(txt, payload.isJoker ? 1800 : 1100);
});

socket.on("action", (action) => {
  if(!action) return;
  if(action.t && action.t < lastActionT) return;
  lastActionT = Math.max(lastActionT, action.t || 0);
  runActionFX(action);
});

// When YOUR card is taken by someone else, animate the exact card lifting up and vanishing.
socket.on("lostCard", (payload) => {
  if(!payload) return;
  if(mode !== 'player' || !you) return;
  animateLostFromHand(payload.index, payload.card);
});

// --- Card rendering
function rankLabel(rank){
  if(rank === 1) return "A";
  if(rank === 11) return "J";
  if(rank === 12) return "Q";
  if(rank === 13) return "K";
  if(rank == null) return "";
  return String(rank);
}

function cardFace(card){
  const el = document.createElement("div");
  el.className = "card-face";

  const corner = document.createElement('div');
  corner.className = 'card-corner';

  const isJoker = (card?.suit === 'JOKER') || (card?.label === 'JOKER') || (card?.isJoker) || (card?.rank === 0);
  if(isJoker){
    corner.textContent = "🃏";
    el.classList.add("joker");
  }else{
    corner.textContent = rankLabel(card?.rank);
    const suit = card?.suit;
    if(suit === "♥" || suit === "♦" || suit === "hearts" || suit === "diamonds") el.classList.add("red");
  }

  el.appendChild(corner);
  return el;
}

function showSpectatorBanner(on){
  const b = $("spectatorBanner");
  if(!b) return;
  if(on){
    b.textContent = lastPublic?.started
      ? '👀 Spel is al bezig — je kijkt mee (spectator). Wacht tot het spel voorbij is om mee te doen.'
      : '👀 Je kijkt mee in de lobby. Je kunt blijven kijken zonder opnieuw je naam in te voeren.';
  }
  b.hidden = !on;
  // Hide player-only UI when spectating
  const handArea = $("handArea");
  const leave = $("leaveBtn");
  if(handArea) handArea.style.display = on ? 'none' : '';
  if(leave) leave.style.display = on ? 'none' : '';
  if(pickOverlay) pickOverlay.hidden = true;
  document.body.classList.remove('picking');
}

function viewState(){
  return (mode === 'player' && lastState) ? lastState : lastPublic;
}


function cardBack(){
  const el = document.createElement("div");
  el.className = "card-back";
  el.textContent = "🂠";
  return el;
}

// --- FX helpers
function seatElement(seat){
  return document.querySelector(`.seat[data-seat="${seat}"]`);
}

function localPosFromRect(rect, baseRect){
  return {
    x: rect.left + rect.width/2 - baseRect.left,
    y: rect.top + rect.height/2 - baseRect.top
  };
}

function getPosForSeat(seat){
  const seatEl = seatElement(seat);
  const base = fxLayer.getBoundingClientRect();
  if(!seatEl) return { x: base.width/2, y: base.height/2 };
  const r = seatEl.getBoundingClientRect();
  return localPosFromRect(r, base);
}

function getPosForPile(){
  // Pile UI removed; treat "middle" as the center of the table.
  const base = fxLayer.getBoundingClientRect();
  const t = $("table");
  const tr = t ? t.getBoundingClientRect() : base;
  const rect = {
    left: tr.left + tr.width/2 - 1,
    top: tr.top + tr.height/2 - 1,
    width: 2,
    height: 2
  };
  return localPosFromRect(rect, base);
}

function makeFlyEl(isJoker=false){
  const fly = document.createElement("div");
  fly.className = "fx-fly";
  const card = document.createElement("div");
  card.className = "fx-card" + (isJoker ? " joker" : "");
  card.textContent = isJoker ? "🃏" : "🂠";
  fly.appendChild(card);
  return fly;
}

function makeMiniCard(){
  const c = document.createElement("div");
  c.className = "mini-card";
  return c;
}

function animateFly(from, to, { isJoker=false, duration=900 }={}){
  const fly = makeFlyEl(isJoker);
  fly.style.left = `${from.x}px`;
  fly.style.top = `${from.y}px`;
  fxLayer.appendChild(fly);

  fly.animate([
    { transform: `translate(-50%,-50%) scale(1)`, offset: 0 },
    { transform: `translate(-50%,-50%) scale(1.08)`, offset: 0.35 },
    { transform: `translate(-50%,-50%) scale(1)`, offset: 1 }
  ], { duration, easing: "ease" });

  fly.animate([
    { left: `${from.x}px`, top: `${from.y}px` },
    { left: `${to.x}px`, top: `${to.y}px` }
  ], { duration, easing: "cubic-bezier(.2,.85,.2,1)" });

  setTimeout(() => fly.remove(), duration + 40);
}

function animateDiscards(fromSeat, count){
  const from = getPosForSeat(fromSeat);
  const to = getPosForPile();
  const n = Math.min(6, Math.max(1, count));
  for(let i=0;i<n;i++){
    setTimeout(() => {
      const el = makeMiniCard();
      el.style.position = "absolute";
      el.style.left = `${from.x}px`;
      el.style.top = `${from.y}px`;
      el.style.transform = "translate(-50%,-50%)";
      fxLayer.appendChild(el);
      el.animate([
        { left: `${from.x}px`, top: `${from.y}px`, opacity: 1 },
        { left: `${to.x + (Math.random()*20-10)}px`, top: `${to.y + (Math.random()*12-6)}px`, opacity: 0.2 }
      ], { duration: 520, easing: "ease-in" });
      setTimeout(() => el.remove(), 420);
    }, i*80);
  }
}

function zapSeat(seat){
  const el = seatElement(seat);
  if(!el) return;
  el.classList.add("zap");
  setTimeout(() => el.classList.remove("zap"), 600);
}

function runActionFX(action){
  if(!action?.type) return;

  if(action.type === "beginDraw"){
    const from = getPosForSeat(action.activeSeat);
    const to = getPosForSeat(action.targetSeat);
    animateFly(from, to, { isJoker:false, duration: 1200 });
    return;
  }

  if(action.type === "drawResolved"){
    const from = getPosForSeat(action.targetSeat);
    const to = getPosForSeat(action.activeSeat);
    animateFly(from, to, { isJoker: !!action.pickedIsJoker, duration: 1500 });

    if(action.discardedCount){
      setTimeout(() => animateDiscards(action.activeSeat, action.discardedCount), 360);
    }

    // Removed hard "zap" flashes; seat state now uses smooth fades.
    return;
  }

  if(action.type === "eliminate"){
    return;
  }

  if(action.type === "winner"){
    return;
  }
}

// --- Render helpers
function seatFanTransform(i, n){
  const mid = (n - 1) / 2;
  const dx = (i - mid) * 10;
  const rot = (i - mid) * 2.1;
  return `translateX(${dx}px) rotate(${rot}deg)`;
}

// Cards on the table: centered horizontal row (left→right), positioned in the middle of the table.
// This avoids the ring/ellipse layout and keeps the selection readable.
function pickTableTransform(i, n){
  const y = 16; // slight downshift so it visually sits "on" the table surface
  if(n <= 1) return `translate(0px, ${y}px) rotate(0deg)`;

  // Keep pick cards visually next to each other (minimal overlap).
  // We prefer full side-by-side spacing, and only shrink when the stage is very narrow.
  const cardW = 68;
  const preferredGap = 10;
  const preferredSpacing = cardW + preferredGap;

  const stageW = drawCards?.clientWidth || 860;
  const maxSpan = Math.max(220, stageW - cardW - 14);
  const maxSpacingThatFits = maxSpan / Math.max(1, (n - 1));
  const spacing = Math.max(44, Math.min(preferredSpacing, maxSpacingThatFits));

  const mid = (n - 1) / 2;
  const x = (i - mid) * spacing;
  return `translate(${x.toFixed(1)}px, ${y}px) rotate(0deg)`;
}

function renderSeats(){
  const s = viewState();
  if(!s) return;

  const table = $("table");
  const opponentsRow = $("opponentsRow");

  const players = (s?.players || []).slice().sort((a,b)=>a.seat-b.seat);
  const pending = s?.pendingDraw;
  const activeSeat = pending?.activeSeat;
  const targetSeat = pending?.targetSeat;

  const started = !!s?.started;
  const phase = s?.phase || 'lobby';
  const isGame = started && phase !== 'gameover';

  // Player-perspective: show *other* players opposite you, spaced on an arc.
  const youSeat = (mode === 'player' && you && typeof you.seat === 'number') ? you.seat : null;
  const list = (mode === 'player' && youSeat != null)
    ? players.filter(p => p.seat !== youSeat)
    : players;

  // Anchor for "you" so animations have a consistent destination.
  if(mode === 'player' && youSeat != null){
    let a = table.querySelector(`.seat.seatAnchor[data-seat="${youSeat}"]`);
    if(!a){
      a = document.createElement('div');
      a.className = 'seat seatAnchor';
      a.dataset.seat = String(youSeat);
      table.appendChild(a);
    }
  }

  const container = opponentsRow || table;

  // Keyed rendering: update existing seats instead of replacing DOM (prevents flicker/"knips").
  const existing = new Map();
  container.querySelectorAll('.seat').forEach(el => {
    const seat = Number(el.dataset.seat);
    if(Number.isFinite(seat)) existing.set(seat, el);
  });

  function opponentArcPos(i, n){
    if(n <= 1) return { x: 50, y: 22 };
    const spread = Math.min(160, 70 + n * 18); // degrees
    const start = 270 - spread / 2;
    const end = 270 + spread / 2;
    const t = (n === 1) ? 0.5 : (i / (n - 1));
    const deg = start + (end - start) * t;
    const rad = deg * Math.PI / 180;
    // Ellipse roughly matching the table surface.
    const cx = 50;
    const cy = 50;
    const rx = 40;
    const ry = 30;
    return {
      x: cx + rx * Math.cos(rad),
      y: cy + ry * Math.sin(rad),
    };
  }

  function buildSeatEl(seat){
    const seatEl = document.createElement('div');
    seatEl.className = 'seat';
    seatEl.dataset.seat = String(seat);

    const nameEl = document.createElement('div');
    nameEl.className = 'seat-name';

    const meta = document.createElement('div');
    meta.className = 'seat-meta';

    const count = document.createElement('span');
    count.className = 'badge small seat-count';

    const icons = document.createElement('span');
    icons.className = 'seat-icons seat-iconsSlot';

    meta.appendChild(count);
    meta.appendChild(icons);

    const cards = document.createElement('div');
    cards.className = 'seat-cards';

    seatEl.appendChild(nameEl);
    seatEl.appendChild(meta);
    seatEl.appendChild(cards);
    return seatEl;
  }

  function updateSeatEl(seatEl, p, idx, total){
    const seat = p.seat;
    seatEl.dataset.seat = String(seat);

    const nameEl = seatEl.querySelector('.seat-name');
    if(nameEl) nameEl.textContent = p.name;

    // Count + icons
    const countEl = seatEl.querySelector('.seat-count');
    if(countEl) countEl.textContent = String(p.cardCount);

    const iconsSlot = seatEl.querySelector('.seat-iconsSlot');
    if(iconsSlot){
      iconsSlot.innerHTML = '';
      if(p.offline){
        const iEl = document.createElement('span');
        iEl.textContent = '📴';
        iEl.title = 'Offline';
        iconsSlot.appendChild(iEl);
      }
      if(p.eliminated){
        const iEl = document.createElement('span');
        iEl.textContent = '☠️';
        iEl.title = 'Af';
        iconsSlot.appendChild(iEl);
      }
    }

    // Seat cards stack
    const cards = seatEl.querySelector('.seat-cards');
    if(cards){
      const show = Math.max(0, p.cardCount);
      const n = Math.min(show, 16);
      // Rebuild only this small section (cheap) — but keep seat element stable.
      cards.innerHTML = '';
      for(let j=0;j<n;j++){
        const c = document.createElement('div');
        c.className = 'seat-card';
        c.textContent = '🂠';
        c.style.transform = seatFanTransform(j, n);
        cards.appendChild(c);
      }
      if(show > n){
        const more = document.createElement('div');
        more.className = 'seat-more';
        more.textContent = `+${show - n}`;
        cards.appendChild(more);
      }
    }

    // Classes (smooth transitions in CSS)
    seatEl.classList.remove('turn', 'target');
    seatEl.classList.toggle('draw-active', isGame && seat === activeSeat);
    seatEl.classList.toggle('you', mode === 'player' && you?.seat === seat);
    seatEl.classList.toggle('winner', s?.winnerSeat === seat);

    // Position on arc (only in opponentsRow)
    if(container === opponentsRow){
      const pos = opponentArcPos(idx, total);
      seatEl.style.left = `${pos.x}%`;
      seatEl.style.top = `${pos.y}%`;
    }
  }

  for(let i=0;i<list.length;i++){
    const p = list[i];
    const seat = p.seat;
    let seatEl = existing.get(seat);
    if(!seatEl){
      seatEl = buildSeatEl(seat);
      container.appendChild(seatEl);
    }
    updateSeatEl(seatEl, p, i, list.length);
    existing.delete(seat);
  }

  // Remove seats no longer present
  for(const [,el] of existing){
    el.remove();
  }
}

function clearDrawLinkFx(){
  if(!drawLinkFx) return;
  drawLinkFx.remove();
  drawLinkFx = null;
}

function updateDrawLinkFx(){
  const s = viewState();
  const pending = s?.pendingDraw;
  const active = pending?.activeSeat;
  const target = pending?.targetSeat;
  if(typeof active !== 'number' || typeof target !== 'number'){
    clearDrawLinkFx();
    return;
  }
  if(!fxLayer) return;
  const fromEl = seatElement(active);
  const toEl = seatElement(target);
  const table = $("table");
  if(!fromEl || !toEl || !table){
    clearDrawLinkFx();
    return;
  }

  const tr = table.getBoundingClientRect();
  const fr = fromEl.getBoundingClientRect();
  const rr = toEl.getBoundingClientRect();
  const x1 = fr.left + fr.width / 2 - tr.left;
  const y1 = fr.top + fr.height / 2 - tr.top;
  const x2 = rr.left + rr.width / 2 - tr.left;
  const y2 = rr.top + rr.height / 2 - tr.top;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if(len < 14){
    clearDrawLinkFx();
    return;
  }
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;

  if(!drawLinkFx){
    drawLinkFx = document.createElement('div');
    drawLinkFx.className = 'fx-draw-link';
    drawLinkFx.innerHTML = '<div class="fx-draw-line"></div><div class="fx-draw-arrow"></div>';
    fxLayer.appendChild(drawLinkFx);
  }
  drawLinkFx.style.left = `${x1}px`;
  drawLinkFx.style.top = `${y1}px`;
  drawLinkFx.style.width = `${len}px`;
  drawLinkFx.style.transform = `rotate(${angle}deg)`;
  drawLinkFx.style.setProperty('--travel', `${Math.max(0, len - 18)}px`);
}

function renderTopLabels(){
  const s = viewState();
  if(!s) return;
  const started = !!s?.started;
  const phase = s?.phase || 'lobby';
  const players = s?.players || [];
  const max = s?.settings?.maxPlayers || 6;
  playersBadge.textContent = `${players.length}/${max}`;

  if(!started) stateBadge.textContent = 'Lobby';
  else if(phase === 'gameover') stateBadge.textContent = 'Einde';
  else stateBadge.textContent = 'Spel';

  if(mode === 'spectator' && started && phase !== 'gameover'){
    turnLine.textContent = `👀 Spel bezig • je kijkt mee.`;
  } else if(!started){
    turnLine.textContent = `Wachten op host start… (${players.length}/${max})`;
  } else if(phase === 'gameover'){
    const w = players.find(p=>p.seat===s.winnerSeat);
    turnLine.textContent = w ? `🏁 WIN: ${w.name}` : '🏁 Einde';
  } else {
    turnLine.textContent = 'Speelronde bezig…';
  }

  // discard pile UI removed
}

function renderPickOverlay(){
  if(mode !== 'player'){
    pickOverlay.hidden = true;
    document.body.classList.remove('picking');
    drawCards.innerHTML = '';
    return;
  }
  const started = !!lastState?.started;
  const phase = lastState?.phase || 'lobby';
  const draw = lastState?.draw;
  const pending = lastState?.pendingDraw;

  const shouldShow = !!(started && phase === 'choosing' && draw && you && pending && pending.activeSeat === you.seat);

  const createdAt = pending?.createdAt ?? null;
  if(createdAt !== lastPickCreatedAt){
    selectedPickIndex = null;
    lastPickCreatedAt = createdAt;
    lastPickAnimatedAt = null;
  }

  if(!shouldShow){
    pickOverlay.hidden = true;
    document.body.classList.remove('picking');
    drawCards.innerHTML = '';
    selectedPickIndex = null;
    return;
  }

  pickOverlay.hidden = false;
  document.body.classList.add('picking');

  pickTitle.textContent = `KIES 1 kaart van ${draw.targetName}…`;
  const confirmTxt = selectedPickIndex == null
    ? 'Klik 1× om te selecteren, 2× om te pakken.'
    : '✅ Geselecteerd • klik nogmaals om te bevestigen.';
  pickSub.textContent = confirmTxt;

  const n = draw.targetCardCount;
  drawCards.innerHTML = '';
  for(let i=0;i<n;i++){
    const c = document.createElement('button');
    c.className = 'pick';
    c.appendChild(cardBack());
    if(draw.hintIndex === i) c.classList.add('hint');
    if(selectedPickIndex === i) c.classList.add('selected');
    c.style.setProperty('--fan', pickTableTransform(i, n));
    c.addEventListener('click', () => {
      if(selectedPickIndex !== i){
        selectedPickIndex = i;
        renderPickOverlay();
        return;
      }

      // Confirm
      // Animate: chosen card goes to you, others slide back to target (no blur/modal).
      try{
        animatePickConfirmOut(pending?.activeSeat, pending?.targetSeat, i);
        drawCards.style.pointerEvents = 'none';
      }catch{}

      socket.emit('chooseCard', { roomId, index: i }, (res) => {
        if(!res?.ok) toast(res?.error || 'Kon kaart niet pakken.', 1600);
      });
      selectedPickIndex = null;
    });
    drawCards.appendChild(c);
  }

  // One-time intro animation: cards slide from target seat to the center.
  if(createdAt && createdAt !== lastPickAnimatedAt){
    lastPickAnimatedAt = createdAt;
    requestAnimationFrame(() => animatePickCardsIn(draw.targetSeat, n));
  }
}

function animatePickConfirmOut(activeSeat, targetSeat, selectedIndex){
  const btns = Array.from(drawCards?.querySelectorAll?.('.pick') || []);
  if(!btns.length) return;

  const duration = 1100;
  const stagger = 70;

  function seatCenter(seat){
    const el = seatElement(seat);
    if(el){
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    }
    const t = $("table");
    const tr = t ? t.getBoundingClientRect() : null;
    return tr ? { x: tr.left + tr.width/2, y: tr.top + tr.height*0.58 } : { x: window.innerWidth/2, y: window.innerHeight/2 };
  }

  const toActive = seatCenter(activeSeat);
  const toTarget = seatCenter(targetSeat);

  btns.forEach((btn, idx) => {
    const r = btn.getBoundingClientRect();
    const ghost = btn.cloneNode(true);
    ghost.classList.remove('selected');
    ghost.style.position = 'fixed';
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    ghost.style.transform = 'none';
    ghost.style.margin = '0';
    ghost.style.zIndex = '9999';
    ghost.style.pointerEvents = 'none';
    document.body.appendChild(ghost);

    // Hide originals so layout stays stable until the next state tick.
    btn.style.visibility = 'hidden';

    const end = (idx === selectedIndex) ? toActive : toTarget;
    const sx = r.left + r.width/2;
    const sy = r.top + r.height/2;
    const dx = end.x - sx;
    const dy = end.y - sy;
    const rot = (idx === selectedIndex) ? 0 : (Math.random()*14 - 7);

    const delay = idx * stagger;
    ghost.animate([
      { transform: 'translate(0px,0px) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot.toFixed(1)}deg)`, opacity: 0.15 }
    ], {
      duration,
      delay,
      easing: 'cubic-bezier(.2,.85,.2,1)',
      fill: 'forwards'
    });

    setTimeout(() => ghost.remove(), duration + delay + 80);
  });

  setTimeout(() => {
    if(drawCards) drawCards.style.pointerEvents = '';
  }, duration + btns.length * stagger + 80);
}

function animatePickCardsIn(targetSeat, n){
  const seatEl = seatElement(targetSeat);
  if(!seatEl) return;
  const seatRect = seatEl.getBoundingClientRect();
  const startX = seatRect.left + seatRect.width/2;
  const startY = seatRect.top + seatRect.height/2;

  const cards = Array.from(drawCards.querySelectorAll('.pick'));
  if(!cards.length) return;

  const duration = 1200;
  const stagger = 180;

  for(let i=0;i<cards.length;i++){
    const el = cards[i];
    const rect = el.getBoundingClientRect();
    const endX = rect.left + rect.width/2;
    const endY = rect.top + rect.height/2;
    const dx = startX - endX;
    const dy = startY - endY;
    const fan = (getComputedStyle(el).getPropertyValue('--fan') || pickTableTransform(i, n)).trim();
    const finalT = `translate(-50%,-50%) ${fan}`.trim();
    const startT = `translate(${dx}px, ${dy}px) ${finalT}`.trim();

    // Temporarily override transform for the intro animation.
    el.style.transform = startT;
    el.style.opacity = '0';

    const delay = i * stagger;
    const anim = el.animate([
      { transform: startT, opacity: 0 },
      { transform: finalT, opacity: 1 }
    ], {
      duration,
      delay,
      easing: 'cubic-bezier(.20,.90,.20,1)',
      fill: 'forwards'
    });
    anim.onfinish = () => {
      el.style.opacity = '';
      el.style.transform = '';
    };
  }
}

// When you lose a card (someone draws from you), show which one: lift + fade.
function animateLostFromHand(index, card){
  // Try to clone the visible card element before the next state render removes it.
  const els = Array.from(handEl?.querySelectorAll?.('.handCard') || []);
  const src = (index != null ? els[index] : null) || els[els.length - 1] || null;

  let ghost;
  if(src){
    const r = src.getBoundingClientRect();
    ghost = src.cloneNode(true);
    ghost.classList.remove('raised', 'nudgeable');
    ghost.classList.add('ghostLost');
    ghost.style.position = 'fixed';
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    ghost.style.transform = 'none';
    ghost.style.margin = '0';
  }else{
    const w = 148, h = 202;
    ghost = document.createElement('div');
    ghost.className = 'ghostLost';
    ghost.style.position = 'fixed';
    ghost.style.left = `${(window.innerWidth - w) / 2}px`;
    ghost.style.top = `${(window.innerHeight - h) / 2}px`;
    ghost.style.width = `${w}px`;
    ghost.style.height = `${h}px`;
    ghost.appendChild(cardFace(card || {}));
  }

  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '999';
  document.body.appendChild(ghost);

  ghost.animate([
    { transform: 'translate(0px, 0px) rotate(0deg) scale(1)', opacity: 1 },
    { transform: 'translate(0px, -140px) rotate(-6deg) scale(1.02)', opacity: 0 }
  ], {
    // Make it much slower so it's very clear which card was taken.
    duration: 3600,
    easing: 'cubic-bezier(.20,.85,.20,1)',
    fill: 'forwards'
  });

  setTimeout(() => ghost.remove(), 3780);
}

function renderHand(){
  handEl.innerHTML = '';
  const hand = you?.hand || [];

  const n = hand.length;
  const mid = (n - 1) / 2;
  const compact = window.matchMedia('(max-width: 520px)').matches;
  const cardW = compact ? 112 : 146;
  const handW = handEl.clientWidth || handEl.parentElement?.clientWidth || Math.floor(window.innerWidth * 0.92);
  const maxSpacing = cardW + 8;
  const minSpacing = 28;
  const spacing = (n > 1)
    ? Math.max(minSpacing, Math.min(maxSpacing, (handW - cardW) / (n - 1)))
    : 0;

  const defend = lastState?.defend;
  const canNudge = !!(defend && !nudgeSent);

  document.body.classList.toggle('canNudge', !!canNudge);

  for(let i=0;i<n;i++){
    const card = hand[i];
    const btn = document.createElement('button');
    btn.className = 'handCard';
    btn.type = 'button';

    const x = (i - mid) * spacing;
    const rot = 0;
    const y = 0;
    btn.style.setProperty('--x', `${x}px`);
    btn.style.setProperty('--rot', `${rot}deg`);
    btn.style.setProperty('--y', `${y}px`);
    btn.style.setProperty('--z', String(i));

    if(raisedIndex === i) btn.classList.add('raised');
    if(canNudge) btn.classList.add('nudgeable');

    btn.appendChild(cardFace(card));

    btn.addEventListener('click', () => {
      if(!canNudge) return;
      if(nudgeSent) return;

      nudgeSent = true;
      raisedIndex = i;

      socket.emit('bluffNudge', { roomId, index: i }, (res) => {
        if(!res?.ok){
          nudgeSent = false;
          raisedIndex = null;
          toast(res?.error || 'Kon hint niet sturen.', 1600);
        }
        render();
      });
      render();
    });

    handEl.appendChild(btn);
  }
}

function render(){
  const s = viewState();
  if(!s) return;
  renderSeats();
  updateDrawLinkFx();
  renderTopLabels();
  renderPickOverlay();
  if(mode === 'player' && you) renderHand();
  document.body.classList.toggle('isEliminated', mode === 'player' && !!you?.eliminated);
}
