const socket = io();

function $(id){ return document.getElementById(id); }

const hConn = $("hConn");
const hState = $("hState");
const hPlayers = $("hPlayers");
const hMeta = $("hMeta");
const hPlayersList = $("hPlayersList");
const hLog = $("hLog");
const hErr = $("hErr");

const btnStart = $("btnStart");
const btnReset = $("btnReset");
const btnDir = $("btnDir");
const btnApply = $("btnApply");
const btnCopy = $("hCopy");
const btnDevStep = $("btnDevStep");

const dealMode = $("dealMode");
const handSize = $("handSize");
const autoPickEnabled = $("autoPickEnabled");
const autoPick = $("autoPick");
const redisJoker = $("redisJoker");
const redisLeave = $("redisLeave");

let last = null;

function toast(text, ms=1200){
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

function setErr(msg){
  hErr.textContent = msg || "";
}

function render(){
  if(!last) return;

  const players = last.players || [];
  hPlayers.textContent = `${players.length}/6`;

  const started = !!last.started;
  const phase = last.phase || "lobby";
  if(!started) hState.textContent = "Lobby";
  else if(phase === "gameover") hState.textContent = "Einde";
  else hState.textContent = "Spel";

  const turn = typeof last.turnSeat === 'number' ? (last.turnSeat + 1) : "—";
  const dirText = last.direction === "left" ? "links" : "rechts";

  const pending = last.pendingDraw ? ` • draw: ${last.pendingDraw.activeSeat+1} → ${last.pendingDraw.targetSeat+1}` : "";
  const winner = (typeof last.winnerSeat === 'number' && last.phase === 'gameover') ? ` • WIN: seat ${last.winnerSeat+1}` : "";

  hMeta.textContent = `turn: ${turn} • richting: ${dirText} • midden: ${last.discardPileCount ?? 0}${pending}${winner}`;

  btnDir.textContent = `Richting: ${dirText}`;

  // Controls enable/disable
  btnStart.disabled = started || players.length < 2;
  btnReset.disabled = !started && phase === 'lobby' && players.length === 0;
  if(btnDevStep) btnDevStep.disabled = !started || phase === 'gameover' || players.length < 2;

  // Form values
  const s = last.settings || {};
  dealMode.value = s.dealMode || 'handSize';
  handSize.value = s.startingHandSize ?? 7;
  autoPick.value = s.autoPickSeconds ?? 12;
  if(autoPickEnabled) autoPickEnabled.checked = !!s.autoPickEnabled;

  // Player list
  hPlayersList.innerHTML = "";
  players.sort((a,b)=>a.seat-b.seat);
  for(const p of players){
    const row = document.createElement('div');
    row.className = 'hostPlayerRow';

    const left = document.createElement('div');
    left.className = 'hostPlayerName';
    left.textContent = `${p.name}`;

    const right = document.createElement('div');
    right.className = 'hostPlayerMeta';
    const flags = [];
    if(p.offline) flags.push('📴');
    if(p.eliminated) flags.push('☠️');
    right.textContent = `${p.cardCount} kaart(en) ${flags.join('')}`.trim();

    row.appendChild(left);
    row.appendChild(right);
    hPlayersList.appendChild(row);
  }

  // Log
  hLog.innerHTML = "";
  const log = Array.isArray(last.log) ? last.log : [];
  for(const item of log.slice(0, 14)){
    const d = document.createElement('div');
    d.className = 'hostLogItem';
    d.textContent = item.msg;
    hLog.appendChild(d);
  }
}

socket.on('connect', () => {
  hConn.textContent = 'Verbonden';
  hConn.style.borderColor = 'rgba(120,255,170,0.35)';

  socket.emit('watchTable', {}, (res) => {
    if(!res?.ok) setErr(res?.error || 'Kon niet watchen.');
  });
});

socket.on('disconnect', () => {
  hConn.textContent = 'Offline';
  hConn.style.borderColor = 'rgba(255,70,70,0.35)';
});

socket.on('publicState', (state) => {
  last = state;
  setErr('');
  render();
});

btnStart.addEventListener('click', () => {
  setErr('');
  socket.emit('host_startGame', {}, (res) => {
    if(!res?.ok) return setErr(res?.error || 'Kon niet starten.');
    toast('🎬 Gestart', 1000);
  });
});

btnReset.addEventListener('click', () => {
  if(!confirm('Reset naar lobby?')) return;
  setErr('');
  socket.emit('host_newRound', {}, (res) => {
    if(!res?.ok) return setErr(res?.error || 'Kon niet resetten.');
    toast('↩️ Reset', 1000);
  });
});

btnDir.addEventListener('click', () => {
  const next = (last?.direction === 'left') ? 'right' : 'left';
  setErr('');
  socket.emit('host_setDirection', { direction: next }, (res) => {
    if(!res?.ok) return setErr(res?.error || 'Kon richting niet zetten.');
    toast('🧭 Richting aangepast', 900);
  });
});

btnApply.addEventListener('click', () => {
  setErr('');
  socket.emit('host_updateSettings', {
    settings: {
      dealMode: dealMode.value,
      startingHandSize: Number(handSize.value),
      autoPickEnabled: !!autoPickEnabled?.checked,
      autoPickSeconds: Number(autoPick.value)
    }
  }, (res) => {
    if(!res?.ok) return setErr(res?.error || 'Kon settings niet opslaan.');
    toast('✅ Settings toegepast', 900);
  });
});

btnCopy.addEventListener('click', async () => {
  const txt = JSON.stringify({ ts: new Date().toISOString(), ...last }, null, 2);
  try{ await navigator.clipboard.writeText(txt); toast('📋 Copied', 900); }
  catch{ toast('Kon niet kopiëren', 1100); }
});

btnDevStep?.addEventListener('click', () => {
  setErr('');
  socket.emit('host_dev_step', {}, (res) => {
    if(!res?.ok) return setErr(res?.error || 'Dev move faalde.');
    toast('🎲 Random move', 800);
  });
});
