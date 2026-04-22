// ═══════════════════════════════════════════════════════════════════
// BLACK VIENNA — game.js
// Handles Firebase real-time sync, game state, and UI rendering
// ═══════════════════════════════════════════════════════════════════

const SUSPECTS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','Ö'];

// 36 investigation cards, 3 letters each
const INV_DECK = [
  'ABD','ACF','AEG','AHI','AJK','ALM','ANO','APQ','ARS','ATU','AVW','AXY',
  'BCG','BEH','BFI','BJL','BKN','BMO','BPR','BQS','BTW','BUX','BVY','BZÖ',
  'CDH','CEI','CFJ','CKM','CLN','COP','CQR','CST','CUV','CWX','CYZ','DÖE',
];

// ───────────────────────────────────────────────────────────────────
// BV namespace
// ───────────────────────────────────────────────────────────────────
const BV = {
  roomCode: null,
  myId: null,       // push key in players list
  myName: null,
  myHand: null,
  isHost: false,
  state: null,      // full game state from Firebase
  sheetData: null,  // local investigation sheet: { [letter]: { [playerId]: '' | 'P' | 'M' | 'C' } }
  _pendingAnswer: null,
  _answerCards: null,

  // ── LOBBY ──────────────────────────────────────────────────────

  async createRoom(name, playerCount) {
    const code = BV._genCode();
    const roomRef = db.ref(`rooms/${code}`);
    const snap = await roomRef.once('value');
    if (snap.exists()) throw new Error('Room collision — try again.');

    const playerId = BV._genId();
    BV.roomCode = code;
    BV.myId = playerId;
    BV.myName = name;
    BV.isHost = true;

    await roomRef.set({
      code,
      hostId: playerId,
      playerCount,
      status: 'lobby',  // lobby | dealing | playing | ended
      players: {
        [playerId]: { name, order: 0, ready: false }
      },
      createdAt: firebase.database.ServerValue.TIMESTAMP
    });

    // Clean up old rooms (best-effort)
    BV._scheduleCleanup(code);

    sessionStorage.setItem('bv_room', code);
    sessionStorage.setItem('bv_id', playerId);
    sessionStorage.setItem('bv_name', name);

    showScreen('lobby-screen');
    BV._watchLobby();
  },

  async joinRoom(code, name) {
    const roomRef = db.ref(`rooms/${code}`);
    const snap = await roomRef.once('value');
    if (!snap.exists()) throw new Error('Room not found. Check the code.');
    const room = snap.val();
    if (room.status !== 'lobby') throw new Error('That game has already started.');
    const currentPlayers = Object.keys(room.players || {}).length;
    if (currentPlayers >= room.playerCount) throw new Error('Room is full.');
    const takenNames = Object.values(room.players || {}).map(p => p.name.toLowerCase());
    if (takenNames.includes(name.toLowerCase())) throw new Error('That name is taken.');

    const playerId = BV._genId();
    BV.roomCode = code;
    BV.myId = playerId;
    BV.myName = name;
    BV.isHost = false;

    await db.ref(`rooms/${code}/players/${playerId}`).set({
      name,
      order: currentPlayers,
      ready: false
    });

    sessionStorage.setItem('bv_room', code);
    sessionStorage.setItem('bv_id', playerId);
    sessionStorage.setItem('bv_name', name);

    showScreen('lobby-screen');
    BV._watchLobby();
  },

  _watchLobby() {
    const code = BV.roomCode;
    document.getElementById('lobby-code').textContent = code;

    db.ref(`rooms/${code}`).on('value', snap => {
      if (!snap.exists()) return;
      const room = snap.val();

      // If game started, move to game page
      if (room.status === 'playing' || room.status === 'dealing') {
        window.location.href = `game.html?room=${code}&id=${BV.myId}`;
        return;
      }

      const players = room.players || {};
      const playerList = document.getElementById('lobby-players');
      playerList.innerHTML = '';
      Object.entries(players).forEach(([pid, p]) => {
        const item = document.createElement('div');
        item.className = 'player-list-item';
        item.innerHTML = `<div class="player-badge${pid === room.hostId ? ' host' : ''}"></div>${p.name}${pid === room.hostId ? ' <span style="font-size:10px;color:var(--sepia);letter-spacing:.15em"> HOST</span>' : ''}`;
        playerList.appendChild(item);
      });

      const count = Object.keys(players).length;
      const needed = room.playerCount;
      const status = document.getElementById('lobby-status');
      status.textContent = count >= needed
        ? `All ${needed} players present. Host can deal.`
        : `${count} / ${needed} players joined…`;

      if (BV.isHost) {
        document.getElementById('lobby-host-controls').style.display = 'block';
        document.getElementById('start-btn').disabled = count < needed;
      }
    });
  },

  // ── DEAL CARDS ─────────────────────────────────────────────────

  async dealCards() {
    const snap = await db.ref(`rooms/${BV.roomCode}`).once('value');
    const room = snap.val();
    const players = room.players;
    const n = room.playerCount;
    const playerIds = Object.keys(players).sort((a,b) => players[a].order - players[b].order);

    // Shuffle suspects
    const deck = BV._shuffle([...SUSPECTS]);
    const criminals = deck.splice(0, 3).sort();

    // Cards per player
    let counts;
    if (n === 3) counts = Array(n).fill(8);
    else if (n === 4) counts = Array(n).fill(6);
    else if (n === 5) counts = [4, 5, 5, 5, 5];
    else counts = Array(n).fill(4);

    const hands = {};
    let di = 0;
    playerIds.forEach((pid, i) => {
      hands[pid] = deck.slice(di, di + counts[i]).sort();
      di += counts[i];
    });

    // Shuffle investigation cards into 3 stacks
    const invShuffled = BV._shuffle([...INV_DECK]);
    const stacks = [
      invShuffled.slice(0, 12),
      invShuffled.slice(12, 24),
      invShuffled.slice(24, 36)
    ];

    const gameState = {
      criminals,
      hands,          // { playerId: ['A','B',...] }
      stacks,         // [[card,...],[...],[...]]
      topCards: [stacks[0][0], stacks[1][0], stacks[2][0]],
      usedCards: [],  // [{card, count, fromStack}]
      chips: 40,
      invCount: 0,
      turnOrder: playerIds,
      currentTurnIdx: 0,  // index into turnOrder
      phase: 'choose-card', // choose-card | waiting-answer
      pendingInv: null,   // { askerId, targetId, cards: [] }
      log: [],
      accusations: {},    // { playerId: { letters, correct } }
      eliminated: [],
      status: 'playing',
      handRevealed: {},   // { playerId: true } — who has seen their hand
    };

    await db.ref(`rooms/${BV.roomCode}/gameState`).set(gameState);
    await db.ref(`rooms/${BV.roomCode}/status`).set('playing');
  },

  // ── GAME PAGE INIT ─────────────────────────────────────────────

  initGamePage() {
    const params = new URLSearchParams(window.location.search);
    BV.roomCode = params.get('room') || sessionStorage.getItem('bv_room');
    BV.myId = params.get('id') || sessionStorage.getItem('bv_id');
    BV.myName = sessionStorage.getItem('bv_name');

    if (!BV.roomCode || !BV.myId) {
      window.location.href = 'index.html';
      return;
    }

    document.getElementById('header-room-code').textContent = `Room ${BV.roomCode}`;
    document.getElementById('header-player-name').textContent = BV.myName || '—';

    // Init local sheet
    BV.sheetData = {};
    SUSPECTS.forEach(lt => {
      BV.sheetData[lt] = {};
    });

    // Watch game state
    db.ref(`rooms/${BV.roomCode}/gameState`).on('value', snap => {
      if (!snap.exists()) return;
      const gs = snap.val();
      BV.state = gs;
      BV.myHand = gs.hands?.[BV.myId] || [];

      // Pre-fill sheet with own hand
      BV.myHand.forEach(lt => {
        if (BV.sheetData[lt]) {
          if (!BV.sheetData[lt][BV.myId]) BV.sheetData[lt][BV.myId] = 'kP';
        }
      });
      SUSPECTS.forEach(lt => {
        if (!BV.myHand.includes(lt)) {
          if (!BV.sheetData[lt][BV.myId] || BV.sheetData[lt][BV.myId] === '') {
            BV.sheetData[lt][BV.myId] = BV.sheetData[lt][BV.myId] || 'kM';
          }
        }
      });

      BV._onStateChange(gs);
    });
  },

  _onStateChange(gs) {
    // Show hand reveal if needed
    if (!gs.handRevealed?.[BV.myId]) {
      BV._showHandReveal();
      return;
    }

    // Game over?
    if (gs.status === 'ended') {
      BV._showEndScreen(gs);
      return;
    }

    // Answering?
    if (gs.phase === 'waiting-answer' && gs.pendingInv?.targetId === BV.myId) {
      BV._showAnswerPrompt(gs.pendingInv);
    } else {
      document.getElementById('answer-overlay').style.display = 'none';
    }

    BV._renderGame(gs);
  },

  // ── HAND REVEAL ────────────────────────────────────────────────

  _showHandReveal() {
    const gs = BV.state;
    const hand = gs.hands?.[BV.myId] || [];
    document.getElementById('hand-player-name').textContent = `Agent ${BV.myName}`;
    const grid = document.getElementById('hand-cards-grid');
    grid.innerHTML = '';
    hand.forEach(lt => {
      const card = document.createElement('div');
      card.className = 'person-card';
      card.textContent = lt;
      grid.appendChild(card);
    });
    document.getElementById('hand-reveal').style.display = 'flex';
  },

  async dismissHand() {
    document.getElementById('hand-reveal').style.display = 'none';
    await db.ref(`rooms/${BV.roomCode}/gameState/handRevealed/${BV.myId}`).set(true);
  },

  // ── MAIN RENDER ────────────────────────────────────────────────

  _renderGame(gs) {
    const myTurn = gs.turnOrder[gs.currentTurnIdx] === BV.myId;
    const isEliminated = gs.eliminated?.includes(BV.myId);

    // Turn banner
    const turnEl = document.getElementById('turn-text');
    if (gs.phase === 'waiting-answer') {
      const target = BV._playerName(gs, gs.pendingInv?.targetId);
      const asker = BV._playerName(gs, gs.pendingInv?.askerId);
      if (gs.pendingInv?.targetId === BV.myId) {
        turnEl.textContent = `${asker} is questioning you — answer privately.`;
      } else {
        turnEl.textContent = `Waiting for ${target} to answer…`;
      }
    } else if (myTurn && !isEliminated) {
      turnEl.textContent = `Your turn — choose an investigation card.`;
    } else {
      const current = BV._playerName(gs, gs.turnOrder[gs.currentTurnIdx]);
      turnEl.textContent = `${current}'s turn to investigate.`;
    }

    // Chips
    document.getElementById('chips-value').textContent = gs.chips;

    // Inv cards
    BV._renderInvCards(gs, myTurn && !isEliminated && gs.phase === 'choose-card');

    // Used cards section
    BV._renderUsedCards(gs);

    // Action panel
    if (myTurn && !isEliminated && gs.phase === 'choose-card') {
      BV._renderActionIdle();
    } else if (gs.phase === 'waiting-answer' && gs.pendingInv?.targetId !== BV.myId) {
      BV._renderActionWaiting(gs);
    } else if (gs.phase === 'choose-card' && !myTurn) {
      const current = BV._playerName(gs, gs.turnOrder[gs.currentTurnIdx]);
      document.getElementById('action-panel').innerHTML = `<div class="waiting-msg">Waiting for <strong style="color:var(--ink)">${current}</strong> to choose a card…</div>`;
    } else {
      document.getElementById('action-panel').innerHTML = '';
    }

    // Log
    BV._renderLog(gs);

    // Players
    BV._renderPlayers(gs);
  },

  _renderInvCards(gs, selectable) {
    const row = document.getElementById('inv-cards-row');
    row.innerHTML = '';
    gs.topCards.forEach((card, si) => {
      if (!card) {
        const el = document.createElement('div');
        el.className = 'inv-card';
        el.innerHTML = `<div class="inv-card-label">Stack ${si+1}</div><div class="inv-card-letters" style="color:#3a2410;font-size:12px">Empty</div>`;
        row.appendChild(el);
        return;
      }
      const el = document.createElement('div');
      el.className = 'inv-card' + (selectable ? ' selectable' : '');
      if (BV._pendingCard === si) el.classList.add('selected');
      el.innerHTML = `<div class="inv-card-label">Stack ${si+1}</div><div class="inv-card-letters">${card}</div><div class="inv-card-chips">${BV._ghostChips(3)}</div>`;
      if (selectable) el.onclick = () => BV._selectCard(si, card, gs);
      row.appendChild(el);
    });
  },

  _renderUsedCards(gs) {
    const used = gs.usedCards || [];
    const canSpecial = gs.invCount >= 6 && Object.keys(gs.handRevealed || {}).length >= (gs.turnOrder?.length || 99);
    const section = document.getElementById('used-section');
    if (!used.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    const row = document.getElementById('used-cards-row');
    row.innerHTML = '';
    used.forEach((u, ui) => {
      const el = document.createElement('div');
      el.className = 'inv-card used-card' + (canSpecial && BV._selectingSpecial ? ' selectable' : '');
      let chipsHtml = '';
      for (let i = 0; i < 3; i++) chipsHtml += i < u.count ? '<div class="chip-dot"></div>' : '<div class="chip-ghost"></div>';
      el.innerHTML = `<div class="inv-card-letters">${u.card}</div><div class="inv-card-chips">${chipsHtml}</div>`;
      if (canSpecial && BV._selectingSpecial) el.onclick = () => BV._pickSpecialCard(ui);
      row.appendChild(el);
    });
  },

  _renderActionIdle() {
    document.getElementById('action-panel').innerHTML =
      `<div class="action-step-label">Step 1</div>
       <div class="action-text">Select one of the three face-up investigation cards above, then choose a player to interrogate.</div>`;
  },

  _renderActionWaiting(gs) {
    const inv = gs.pendingInv;
    const asker = BV._playerName(gs, inv.askerId);
    const target = BV._playerName(gs, inv.targetId);
    document.getElementById('action-panel').innerHTML =
      `<div class="action-step-label">Investigation Underway</div>
       <div class="action-text"><strong>${asker}</strong> asked <strong>${target}</strong> about <strong>${inv.cards.join(' + ')}</strong>.<br>Waiting for answer…</div>`;
  },

  // ── TURN FLOW ──────────────────────────────────────────────────

  _pendingCard: null,     // stack index
  _pendingCardStr: null,
  _selectingSpecial: false,
  _specialCardStr: null,

  _selectCard(si, card, gs) {
    BV._pendingCard = si;
    BV._pendingCardStr = card;
    BV._selectingSpecial = false;
    BV._specialCardStr = null;

    // Render target selection
    const canSpecial = gs.invCount >= 6 && (gs.usedCards?.length > 0);
    const ap = document.getElementById('action-panel');
    let html = `<div class="action-step-label">Step 2 — Interrogate</div>
      <div class="action-text">Card: <strong>${card}</strong>. Choose who to question.</div>
      <div class="player-btn-grid" id="target-btn-grid">`;

    gs.turnOrder.forEach(pid => {
      if (pid === BV.myId) return;
      const elim = gs.eliminated?.includes(pid);
      html += `<button class="player-select-btn${elim?' ':''}" onclick="BV._selectTarget('${pid}')" ${elim?'disabled':''}>${BV._playerName(gs, pid)}</button>`;
    });
    html += `</div>`;

    if (canSpecial) {
      html += `<button class="player-select-btn" style="border-color:var(--green);color:var(--green);margin-top:8px" onclick="BV._startSpecial()">＋ Special Investigation</button>`;
    }

    html += `<button class="btn btn-ghost" style="margin-top:10px;font-size:11px" onclick="BV._cancelCard()">← Back</button>`;
    ap.innerHTML = html;

    BV._renderInvCards(gs, false); // re-render without selectable (keep selected highlight)
    document.querySelectorAll('.inv-card')[si]?.classList.add('selected');
  },

  _cancelCard() {
    BV._pendingCard = null;
    BV._pendingCardStr = null;
    BV._specialCardStr = null;
    BV._selectingSpecial = false;
    BV._renderActionIdle();
    BV._renderInvCards(BV.state, true);
  },

  _startSpecial() {
    BV._selectingSpecial = true;
    BV._renderUsedCards(BV.state);
    const ap = document.getElementById('action-panel');
    ap.innerHTML = `<div class="action-step-label">Special Investigation</div>
      <div class="action-text">Tap a used card above to pair with <strong>${BV._pendingCardStr}</strong>.</div>
      <button class="btn btn-ghost" style="font-size:11px;margin-top:8px" onclick="BV._cancelSpecial()">← Cancel</button>`;
  },

  _cancelSpecial() {
    BV._selectingSpecial = false;
    BV._specialCardStr = null;
    BV._renderUsedCards(BV.state);
    BV._selectCard(BV._pendingCard, BV._pendingCardStr, BV.state);
  },

  _pickSpecialCard(ui) {
    BV._specialCardStr = BV.state.usedCards[ui].card;
    BV._selectingSpecial = false;
    BV._renderUsedCards(BV.state);
    BV._selectCard(BV._pendingCard, BV._pendingCardStr, BV.state);
  },

  async _selectTarget(targetId) {
    const cards = [BV._pendingCardStr];
    if (BV._specialCardStr) cards.push(BV._specialCardStr);

    const pendingInv = {
      askerId: BV.myId,
      targetId,
      cards,
      stackIdx: BV._pendingCard
    };

    // Move to waiting-answer phase
    await db.ref(`rooms/${BV.roomCode}/gameState`).update({
      phase: 'waiting-answer',
      pendingInv
    });

    BV._pendingCard = null;
    BV._pendingCardStr = null;
    BV._specialCardStr = null;
  },

  // ── ANSWER ─────────────────────────────────────────────────────

  _showAnswerPrompt(inv) {
    const overlay = document.getElementById('answer-overlay');
    overlay.style.display = 'flex';
    document.getElementById('answer-eyebrow').textContent = `${BV._playerName(BV.state, inv.askerId)} is questioning you`;

    const display = document.getElementById('answer-cards-display');
    display.innerHTML = '';
    inv.cards.forEach(card => {
      const el = document.createElement('div');
      el.className = 'answer-inv-card';
      el.textContent = card;
      display.appendChild(el);
    });

    // Build chip selector
    const totalLetters = inv.cards.join('').length;
    const sel = document.getElementById('chip-selector');
    sel.innerHTML = '';
    BV._answerCards = inv.cards;
    BV._pendingAnswer = null;

    for (let i = 0; i <= totalLetters; i++) {
      const btn = document.createElement('button');
      btn.className = 'chip-count-btn';
      btn.textContent = i;
      btn.onclick = () => BV._selectChipCount(i);
      sel.appendChild(btn);
    }
    document.getElementById('answer-confirm-btn').disabled = true;
    document.getElementById('answer-err').textContent = '';
  },

  _selectChipCount(n) {
    BV._pendingAnswer = n;
    document.querySelectorAll('.chip-count-btn').forEach((b, i) => b.classList.toggle('sel', i === n));
    document.getElementById('answer-confirm-btn').disabled = false;
  },

  async submitAnswer() {
    if (BV._pendingAnswer === null) return;
    const count = BV._pendingAnswer;
    const inv = BV.state.pendingInv;
    const gs = BV.state;

    // Validate (client-side check — trust but verify)
    const myHand = gs.hands[BV.myId] || [];
    const actualCount = inv.cards.join('').split('').filter(lt => myHand.includes(lt)).length;
    if (count !== actualCount) {
      document.getElementById('answer-err').textContent =
        `That's not right — you have ${actualCount} of those letters. Please recount.`;
      return;
    }

    // Update Firebase: record result, flip top card, advance turn
    const updates = {};
    const stacks = gs.stacks.map(s => [...s]);
    const si = inv.stackIdx;

    // Remove the used card from the stack
    const pos = stacks[si].indexOf(inv.cards[0]);
    if (pos > -1) stacks[si].splice(pos, 1);

    const newTopCards = [...gs.topCards];
    newTopCards[si] = stacks[si][0] || null;

    const newUsed = [...(gs.usedCards || []), { card: inv.cards[0], count }];
    const newInvCount = (gs.invCount || 0) + 1;
    const newChips = Math.max(0, (gs.chips || 40) - count);

    // Next turn: questioned player goes next
    const nextTurnIdx = gs.turnOrder.indexOf(inv.targetId);

    // Log entry
    const logEntry = {
      n: (gs.log?.length || 0) + 1,
      asker: BV._playerName(gs, inv.askerId),
      target: BV._playerName(gs, inv.targetId),
      cards: inv.cards.join('+'),
      count
    };
    const newLog = [...(gs.log || []), logEntry];

    updates['phase'] = 'choose-card';
    updates['pendingInv'] = null;
    updates['stacks'] = stacks;
    updates['topCards'] = newTopCards;
    updates['usedCards'] = newUsed;
    updates['invCount'] = newInvCount;
    updates['chips'] = newChips;
    updates['currentTurnIdx'] = nextTurnIdx;
    updates['log'] = newLog;

    // Check chip end condition
    if (newChips <= 3) {
      updates['status'] = 'ended';
    }

    await db.ref(`rooms/${BV.roomCode}/gameState`).update(updates);

    document.getElementById('answer-overlay').style.display = 'none';
    BV._pendingAnswer = null;
  },

  // ── ACCUSATION ─────────────────────────────────────────────────

  async confirmAccusation() {
    const sel = window.getAccuseSelection ? window.getAccuseSelection() : [];
    if (sel.length !== 3) return;

    const crim = [...(BV.state.criminals || [])].sort();
    const guess = [...sel].sort();
    const correct = guess.join('') === crim.join('');

    const accusation = { letters: guess, correct, at: Date.now() };
    const updates = {};
    updates[`accusations/${BV.myId}`] = accusation;

    if (correct) {
      updates['status'] = 'ended';
      updates['winnerId'] = BV.myId;
    } else {
      const newElim = [...(BV.state.eliminated || []), BV.myId];
      updates['eliminated'] = newElim;
      // If all eliminated, end game
      const active = BV.state.turnOrder.filter(pid => !newElim.includes(pid));
      if (active.length === 0) updates['status'] = 'ended';
    }

    await db.ref(`rooms/${BV.roomCode}/gameState`).update(updates);

    if (window.hideAccuse) window.hideAccuse();
  },

  // ── END GAME ───────────────────────────────────────────────────

  _showEndScreen(gs) {
    const overlay = document.getElementById('end-overlay');
    overlay.style.display = 'flex';

    const reveal = document.getElementById('criminal-reveal');
    reveal.innerHTML = '';
    (gs.criminals || []).forEach(lt => {
      const card = document.createElement('div');
      card.className = 'criminal-card';
      card.textContent = lt;
      reveal.appendChild(card);
    });

    const stamp = document.getElementById('end-stamp');
    const chipsLeft = gs.chips || 0;
    const winner = gs.winnerId;

    if (winner) {
      const wname = BV._playerName(gs, winner);
      stamp.className = 'stamp win';
      stamp.textContent = 'CASE CLOSED';
      document.getElementById('end-message').textContent =
        `${wname} exposed Black Vienna with ${chipsLeft} chips remaining.`;
    } else {
      stamp.className = 'stamp fail';
      stamp.textContent = 'UNSOLVED';
      document.getElementById('end-message').textContent =
        'The investigation collapsed. Black Vienna escapes.';
    }

    // Scores
    const tbody = document.querySelector('#scores-table tbody');
    tbody.innerHTML = '';
    (gs.turnOrder || []).forEach(pid => {
      const name = BV._playerName(gs, pid);
      const acc = gs.accusations?.[pid];
      let accText = '—';
      let score = '0';
      let cls = 'score-zero';

      if (acc) {
        accText = acc.letters.join(', ') + (acc.correct ? ' ✓' : ' ✗');
        if (acc.correct && pid === winner) {
          score = (chipsLeft * 3).toString();
          cls = 'score-win';
        } else if (acc.correct) {
          score = chipsLeft.toString();
          cls = 'score-win';
        }
      }

      tbody.innerHTML += `<tr>
        <td>${name}${pid === winner ? ' ★' : ''}</td>
        <td>${accText}</td>
        <td class="${cls}">${score}</td>
      </tr>`;
    });
  },

  // ── LOG ────────────────────────────────────────────────────────

  _renderLog(gs) {
    const list = document.getElementById('log-list');
    const entries = gs.log || [];
    if (!entries.length) {
      list.innerHTML = '<div class="waiting-msg" style="font-size:12px">No investigations yet.</div>';
      return;
    }
    // Render newest first
    list.innerHTML = [...entries].reverse().slice(0, 30).map(e => {
      let chipsHtml = '';
      if (e.count === 0) chipsHtml = '<span class="log-zero">0</span>';
      else for (let i = 0; i < e.count; i++) chipsHtml += '<div class="log-chip"></div>';
      return `<div class="log-entry">
        <span class="log-n">${e.n}</span>
        <span class="log-text"><strong>${e.asker}</strong> → <strong>${e.target}</strong>: ${e.cards}</span>
        <div class="log-chips">${chipsHtml}</div>
      </div>`;
    }).join('');
  },

  // ── PLAYERS STATUS ─────────────────────────────────────────────

  _renderPlayers(gs) {
    const container = document.getElementById('players-status');
    container.innerHTML = '';
    (gs.turnOrder || []).forEach((pid, idx) => {
      const name = BV._playerName(gs, pid);
      const isTurn = idx === gs.currentTurnIdx && gs.phase === 'choose-card';
      const isElim = gs.eliminated?.includes(pid);
      const item = document.createElement('div');
      item.className = 'player-status-item' + (isTurn ? ' is-turn' : '') + (isElim ? ' eliminated' : '');
      item.innerHTML = `<div class="player-status-dot"></div>${name}${isElim ? ' ✗' : ''}`;
      container.appendChild(item);
    });
  },

  // ── SHEET ──────────────────────────────────────────────────────

  renderSheet() {
    const gs = BV.state;
    if (!gs) return;
    const playerIds = gs.turnOrder || [];
    const table = document.getElementById('sheet-table');
    let html = `<thead><tr><th class="lh">—</th>`;
    playerIds.forEach(pid => {
      const name = BV._playerName(gs, pid);
      html += `<th title="${name}">${name.substring(0, 4)}</th>`;
    });
    html += `</tr></thead><tbody>`;

    SUSPECTS.forEach((lt, ri) => {
      html += `<tr class="${ri%2===0 ? 'sheet-row-hi' : ''}"><td class="ltr">${lt}</td>`;
      playerIds.forEach(pid => {
        const val = BV.sheetData?.[lt]?.[pid] || '';
        if (val === 'kP') {
          html += `<td><div class="sheet-cell kP">+</div></td>`;
        } else if (val === 'kM') {
          html += `<td><div class="sheet-cell kM">−</div></td>`;
        } else {
          const sym = val === 'P' ? '+' : val === 'M' ? '−' : val === 'C' ? '○' : '';
          html += `<td><div class="sheet-cell ${val}" onclick="BV.cycleCell('${lt}','${pid}')">${sym}</div></td>`;
        }
      });
      html += `</tr>`;
    });
    html += `</tbody>`;
    table.innerHTML = html;
  },

  cycleCell(lt, pid) {
    if (!BV.sheetData[lt]) BV.sheetData[lt] = {};
    const cur = BV.sheetData[lt][pid] || '';
    const cycle = { '': 'P', 'P': 'M', 'M': 'C', 'C': '' };
    BV.sheetData[lt][pid] = cycle[cur] || '';
    BV.renderSheet();
  },

  // ── HELPERS ────────────────────────────────────────────────────

  _playerName(gs, pid) {
    return gs?.hands && gs.turnOrder?.includes(pid)
      ? (db.ref && BV._cachedNames?.[pid]) || pid
      : pid;
  },

  _ghostChips(n) {
    return Array(n).fill('<div class="chip-ghost"></div>').join('');
  },

  _genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    return Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  },

  _genId() {
    return Math.random().toString(36).slice(2, 10);
  },

  _shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i+1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  _scheduleCleanup(code) {
    // Remove room after 4 hours (best-effort via Firebase rule or manual)
    setTimeout(async () => {
      try { await db.ref(`rooms/${code}`).remove(); } catch(e) {}
    }, 4 * 60 * 60 * 1000);
  },
};

// ─── Name lookup cache ───────────────────────────────────────────
// Patch _playerName to use actual names from Firebase
BV._cachedNames = {};
const _origPlayerName = BV._playerName.bind(BV);
BV._playerName = function(gs, pid) {
  // Try cached first
  if (BV._cachedNames[pid]) return BV._cachedNames[pid];
  // Watch players node once
  if (BV.roomCode && pid) {
    db.ref(`rooms/${BV.roomCode}/players/${pid}/name`).once('value', snap => {
      if (snap.exists()) BV._cachedNames[pid] = snap.val();
    });
  }
  // Fallback: check gameState hands keys for name lookup
  return BV._cachedNames[pid] || pid.substring(0,6);
};

// Pre-warm name cache
function warmNameCache() {
  if (!BV.roomCode) return;
  db.ref(`rooms/${BV.roomCode}/players`).once('value', snap => {
    if (!snap.exists()) return;
    Object.entries(snap.val()).forEach(([pid, p]) => {
      BV._cachedNames[pid] = p.name;
    });
  });
}

// ─── Screen helper (lobby pages only) ───────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ─── Auto-init game page ─────────────────────────────────────────
if (document.body.classList.contains('game-body')) {
  warmNameCache();
  document.addEventListener('DOMContentLoaded', () => BV.initGamePage());
} else {
  document.addEventListener('DOMContentLoaded', () => {
    // Check if we're returning from a session
    const saved = sessionStorage.getItem('bv_room');
    if (saved) {
      BV.roomCode = saved;
      BV.myId = sessionStorage.getItem('bv_id');
      BV.myName = sessionStorage.getItem('bv_name');
    }
  });
}
