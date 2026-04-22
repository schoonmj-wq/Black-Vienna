// ═══════════════════════════════════════════════════════════════════
// BLACK VIENNA — game.js
// Handles Firebase real-time sync, game state, and UI rendering
// ═══════════════════════════════════════════════════════════════════

const SUSPECTS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','Ö'];

// 36 investigation cards, 3 letters each (Ö replaces @ from the physical game)
// Each suspect letter appears on exactly 4 cards
const INV_DECK = [
  'ACL','AGM','AOS','APQ',
  'BCY','BHV','BLM','BQT',
  'CFI','CSX','DHR','DJZ',
  'DLS','DVY','EGW','ENQ',
  'EÖR','EUV','FÖY','FRX',
  'FSZ','GKO','GPX','HNÖ',
  'HUZ','IÖW','IPR','ITZ',
  'JMO','JQX','JTY','KMU',
  'KNT','KPW','LNV','OUW',
];

// ───────────────────────────────────────────────────────────────────
// Card rules:
//  - 3 face-up cards available (one per stack)
//  - After a card is answered:
//      0 chips  → card stays available (can be asked of anyone again)
//      1-3 chips → card is "used" and sits in front of the answering player permanently
//  - Cards with chips on them cannot be replayed
// ───────────────────────────────────────────────────────────────────

const BV = {
  roomCode: null,
  myId: null,
  myName: null,
  myHand: null,
  isHost: false,
  state: null,
  sheetData: null,
  _pendingAnswer: null,
  _pendingCard: null,
  _pendingCardStr: null,

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
      status: 'lobby',
      players: { [playerId]: { name, order: 0, ready: false } },
      createdAt: firebase.database.ServerValue.TIMESTAMP
    });

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

    await db.ref(`rooms/${code}/players/${playerId}`).set({ name, order: currentPlayers, ready: false });

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
      document.getElementById('lobby-status').textContent = count >= needed
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

    const deck = BV._shuffle([...SUSPECTS]);
    const criminals = deck.splice(0, 3).sort();

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

    const invShuffled = BV._shuffle([...INV_DECK]);
    const stacks = [
      invShuffled.slice(0, 12),
      invShuffled.slice(12, 24),
      invShuffled.slice(24, 36)
    ];

    // playerCards: { playerId: [{card, count}] }
    // Cards with 1+ chips sit in front of a player permanently.
    // Cards with 0 chips are returned to available pool.
    const playerCards = {};
    playerIds.forEach(pid => { playerCards[pid] = []; });

    const gameState = {
      criminals,
      hands,
      stacks,
      topCards: [stacks[0][0], stacks[1][0], stacks[2][0]],
      playerCards,      // cards sitting in front of each player (1+ chips only)
      zeroChipCards: [], // cards answered with 0 chips — still playable on anyone
      chips: 40,
      invCount: 0,
      turnOrder: playerIds,
      currentTurnIdx: 0,
      phase: 'choose-card',
      pendingInv: null,
      log: [],
      accusations: {},
      eliminated: [],
      status: 'playing',
      handRevealed: {},
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

    if (!BV.roomCode || !BV.myId) { window.location.href = 'index.html'; return; }

    document.getElementById('header-room-code').textContent = `Room ${BV.roomCode}`;
    document.getElementById('header-player-name').textContent = BV.myName || '—';

    BV.sheetData = {};
    SUSPECTS.forEach(lt => { BV.sheetData[lt] = {}; });

    db.ref(`rooms/${BV.roomCode}/gameState`).on('value', snap => {
      if (!snap.exists()) return;
      const gs = snap.val();
      BV.state = gs;
      BV.myHand = gs.hands?.[BV.myId] || [];

      // Pre-fill own column in sheet
      SUSPECTS.forEach(lt => {
        if (!BV.sheetData[lt][BV.myId]) {
          BV.sheetData[lt][BV.myId] = BV.myHand.includes(lt) ? 'kP' : 'kM';
        }
      });

      BV._onStateChange(gs);
    });
  },

  _onStateChange(gs) {
    if (!gs.handRevealed?.[BV.myId]) {
      BV._showHandReveal();
      return;
    }
    if (gs.status === 'ended') {
      BV._showEndScreen(gs);
      return;
    }
    if (gs.phase === 'waiting-answer' && gs.pendingInv?.targetId === BV.myId) {
      BV._showAnswerPrompt(gs.pendingInv);
    } else {
      document.getElementById('answer-overlay').style.display = 'none';
    }
    BV._renderGame(gs);
  },

  // ── HAND REVEAL ────────────────────────────────────────────────

  _showHandReveal() {
    const hand = BV.state.hands?.[BV.myId] || [];
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
      turnEl.textContent = gs.pendingInv?.targetId === BV.myId
        ? `${asker} is questioning you — answer privately.`
        : `Waiting for ${target} to answer…`;
    } else if (myTurn && !isEliminated) {
      turnEl.textContent = `Your turn — choose an investigation card.`;
    } else {
      const current = BV._playerName(gs, gs.turnOrder[gs.currentTurnIdx]);
      turnEl.textContent = `${current}'s turn to investigate.`;
    }

    document.getElementById('chips-value').textContent = gs.chips;

    const canSelect = myTurn && !isEliminated && gs.phase === 'choose-card';
    BV._renderAvailableCards(gs, canSelect);
    BV._renderPlayerCards(gs);

    // Action panel
    if (canSelect) {
      BV._renderActionIdle();
    } else if (gs.phase === 'waiting-answer' && gs.pendingInv?.targetId !== BV.myId) {
      BV._renderActionWaiting(gs);
    } else if (gs.phase === 'choose-card' && !myTurn) {
      const current = BV._playerName(gs, gs.turnOrder[gs.currentTurnIdx]);
      document.getElementById('action-panel').innerHTML =
        `<div class="waiting-msg">Waiting for <strong style="color:var(--ink)">${current}</strong> to choose a card…</div>`;
    } else {
      document.getElementById('action-panel').innerHTML = '';
    }

    BV._renderLog(gs);
    BV._renderPlayers(gs);
  },

  // ── AVAILABLE CARDS (face-up + replayed 0-chip cards) ──────────

  _renderAvailableCards(gs, canSelect) {
    const row = document.getElementById('inv-cards-row');
    row.innerHTML = '';

    // The 3 top-of-stack cards
    gs.topCards.forEach((card, si) => {
      const el = document.createElement('div');
      if (!card) {
        el.className = 'inv-card';
        el.innerHTML = `<div class="inv-card-label">Stack ${si+1}</div><div class="inv-card-letters" style="color:#3a2410;font-size:12px">Empty</div>`;
      } else {
        el.className = 'inv-card' + (canSelect ? ' selectable' : '');
        if (BV._pendingCard === `stack-${si}`) el.classList.add('selected');
        el.innerHTML = `<div class="inv-card-label">Stack ${si+1}</div>
          <div class="inv-card-letters">${card}</div>
          <div class="inv-card-chips">${BV._ghostChips(3)}</div>`;
        if (canSelect) el.onclick = () => BV._selectCard(`stack-${si}`, card, si, gs);
      }
      row.appendChild(el);
    });

    // 0-chip cards that can be replayed
    const zeroCards = gs.zeroChipCards || [];
    zeroCards.forEach((entry, zi) => {
      const el = document.createElement('div');
      el.className = 'inv-card zero-chip-card' + (canSelect ? ' selectable' : '');
      if (BV._pendingCard === `zero-${zi}`) el.classList.add('selected');
      el.innerHTML = `<div class="inv-card-label" style="color:#5a8040">0 chips — replayable</div>
        <div class="inv-card-letters">${entry.card}</div>
        <div class="inv-card-chips"><div class="chip-ghost"></div><div class="chip-ghost"></div><div class="chip-ghost"></div></div>`;
      if (canSelect) el.onclick = () => BV._selectCard(`zero-${zi}`, entry.card, null, gs);
      row.appendChild(el);
    });
  },

  // ── PLAYER CARDS (cards with 1+ chips sitting in front of players) ──

  _renderPlayerCards(gs) {
    const section = document.getElementById('player-cards-section');
    const playerCards = gs.playerCards || {};
    const hasAny = Object.values(playerCards).some(cards => cards && cards.length > 0);

    if (!hasAny) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';

    const container = document.getElementById('player-cards-container');
    container.innerHTML = '';

    gs.turnOrder.forEach(pid => {
      const cards = playerCards[pid] || [];
      if (!cards.length) return;

      const playerBlock = document.createElement('div');
      playerBlock.className = 'player-card-block';

      const nameEl = document.createElement('div');
      nameEl.className = 'player-card-block-name';
      nameEl.textContent = BV._playerName(gs, pid);
      playerBlock.appendChild(nameEl);

      const cardsRow = document.createElement('div');
      cardsRow.className = 'player-card-block-cards';

      cards.forEach(entry => {
        const el = document.createElement('div');
        el.className = 'inv-card used-card';
        let chipsHtml = '';
        for (let i = 0; i < 3; i++) {
          chipsHtml += i < entry.count
            ? '<div class="chip-dot"></div>'
            : '<div class="chip-ghost"></div>';
        }
        el.innerHTML = `<div class="inv-card-letters">${entry.card}</div>
          <div class="inv-card-chips">${chipsHtml}</div>`;
        cardsRow.appendChild(el);
      });

      playerBlock.appendChild(cardsRow);
      container.appendChild(playerBlock);
    });
  },

  _renderActionIdle() {
    document.getElementById('action-panel').innerHTML =
      `<div class="action-step-label">Step 1</div>
       <div class="action-text">Choose an available investigation card, then pick a player to question.</div>`;
  },

  _renderActionWaiting(gs) {
    const inv = gs.pendingInv;
    document.getElementById('action-panel').innerHTML =
      `<div class="action-step-label">Investigation Underway</div>
       <div class="action-text"><strong>${BV._playerName(gs, inv.askerId)}</strong> asked
       <strong>${BV._playerName(gs, inv.targetId)}</strong> about
       <strong>${inv.card}</strong>.<br>Waiting for answer…</div>`;
  },

  // ── TURN FLOW ──────────────────────────────────────────────────

  _selectCard(pendingKey, cardStr, stackIdx, gs) {
    BV._pendingCard = pendingKey;
    BV._pendingCardStr = cardStr;
    BV._pendingStackIdx = stackIdx; // null for zero-chip replays

    const ap = document.getElementById('action-panel');
    let html = `<div class="action-step-label">Step 2 — Interrogate</div>
      <div class="action-text">Card: <strong>${cardStr}</strong>. Choose who to question.</div>
      <div class="player-btn-grid">`;

    gs.turnOrder.forEach(pid => {
      if (pid === BV.myId) return;
      const elim = gs.eliminated?.includes(pid);
      html += `<button class="player-select-btn" onclick="BV._selectTarget('${pid}')" ${elim ? 'disabled' : ''}>${BV._playerName(gs, pid)}</button>`;
    });
    html += `</div>
      <button class="btn btn-ghost" style="margin-top:10px;font-size:11px" onclick="BV._cancelCard()">← Back</button>`;
    ap.innerHTML = html;

    // Re-render cards so selected state shows
    BV._renderAvailableCards(gs, false);
    // Re-apply selected class
    document.querySelectorAll('.inv-card.selectable, .inv-card').forEach(el => {
      // highlight done via _renderAvailableCards checking BV._pendingCard
    });
    BV._renderAvailableCards(gs, false);
  },

  _cancelCard() {
    BV._pendingCard = null;
    BV._pendingCardStr = null;
    BV._pendingStackIdx = null;
    BV._renderActionIdle();
    BV._renderAvailableCards(BV.state, true);
  },

  async _selectTarget(targetId) {
    const pendingInv = {
      askerId: BV.myId,
      targetId,
      card: BV._pendingCardStr,
      stackIdx: BV._pendingStackIdx,       // null if replaying a 0-chip card
      isZeroReplay: BV._pendingCard?.startsWith('zero-'),
      zeroReplayIdx: BV._pendingCard?.startsWith('zero-')
        ? parseInt(BV._pendingCard.split('-')[1]) : null,
    };

    await db.ref(`rooms/${BV.roomCode}/gameState`).update({
      phase: 'waiting-answer',
      pendingInv
    });

    BV._pendingCard = null;
    BV._pendingCardStr = null;
    BV._pendingStackIdx = null;
  },

  // ── ANSWER ─────────────────────────────────────────────────────

  _showAnswerPrompt(inv) {
    document.getElementById('answer-overlay').style.display = 'flex';
    document.getElementById('answer-eyebrow').textContent =
      `${BV._playerName(BV.state, inv.askerId)} is questioning you`;

    const display = document.getElementById('answer-cards-display');
    display.innerHTML = `<div class="answer-inv-card">${inv.card}</div>`;

    const sel = document.getElementById('chip-selector');
    sel.innerHTML = '';
    BV._pendingAnswer = null;

    for (let i = 0; i <= 3; i++) {
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

    // Validate
    const myHand = gs.hands[BV.myId] || [];
    const actualCount = inv.card.split('').filter(lt => myHand.includes(lt)).length;
    if (count !== actualCount) {
      document.getElementById('answer-err').textContent =
        `That's not right — you have ${actualCount} of those letters. Please recount.`;
      return;
    }

    const updates = {};
    const stacks = gs.stacks.map(s => [...s]);
    const newTopCards = [...gs.topCards];
    const newPlayerCards = JSON.parse(JSON.stringify(gs.playerCards || {}));
    const newZeroChipCards = [...(gs.zeroChipCards || [])];

    if (inv.isZeroReplay) {
      // Card was a 0-chip replay — remove it from zeroChipCards pool
      newZeroChipCards.splice(inv.zeroReplayIdx, 1);
    } else {
      // Card came from a stack — advance the stack
      const si = inv.stackIdx;
      const pos = stacks[si].indexOf(inv.card);
      if (pos > -1) stacks[si].splice(pos, 1);
      newTopCards[si] = stacks[si][0] || null;
    }

    if (count === 0) {
      // 0 chips: card goes back to the pool — anyone can ask it again
      newZeroChipCards.push({ card: inv.card });
    } else {
      // 1-3 chips: card stays in front of this player permanently
      if (!newPlayerCards[inv.targetId]) newPlayerCards[inv.targetId] = [];
      newPlayerCards[inv.targetId].push({ card: inv.card, count });
    }

    const newChips = Math.max(0, (gs.chips || 40) - count);
    const nextTurnIdx = gs.turnOrder.indexOf(inv.targetId);

    const logEntry = {
      n: (gs.log?.length || 0) + 1,
      asker: BV._playerName(gs, inv.askerId),
      target: BV._playerName(gs, inv.targetId),
      card: inv.card,
      count
    };

    updates['phase'] = 'choose-card';
    updates['pendingInv'] = null;
    updates['stacks'] = stacks;
    updates['topCards'] = newTopCards;
    updates['playerCards'] = newPlayerCards;
    updates['zeroChipCards'] = newZeroChipCards;
    updates['invCount'] = (gs.invCount || 0) + 1;
    updates['chips'] = newChips;
    updates['currentTurnIdx'] = nextTurnIdx;
    updates['log'] = [...(gs.log || []), logEntry];

    if (newChips <= 3) updates['status'] = 'ended';

    await db.ref(`rooms/${BV.roomCode}/gameState`).update(updates);

    document.getElementById('answer-overlay').style.display = 'none';
    BV._pendingAnswer = null;
  },

  // ── ACCUSATION ─────────────────────────────────────────────────

  async confirmAccusation() {
    const sel = window.getAccuseSelection ? window.getAccuseSelection() : [];
    if (sel.length !== 3) return;

    const correct = [...sel].sort().join('') === [...(BV.state.criminals || [])].sort().join('');
    const updates = {};
    updates[`accusations/${BV.myId}`] = { letters: sel, correct, at: Date.now() };

    if (correct) {
      updates['status'] = 'ended';
      updates['winnerId'] = BV.myId;
    } else {
      const newElim = [...(BV.state.eliminated || []), BV.myId];
      updates['eliminated'] = newElim;
      if (newElim.length >= BV.state.turnOrder.length) updates['status'] = 'ended';
    }

    await db.ref(`rooms/${BV.roomCode}/gameState`).update(updates);
    if (window.hideAccuse) window.hideAccuse();
  },

  // ── END GAME ───────────────────────────────────────────────────

  _showEndScreen(gs) {
    document.getElementById('end-overlay').style.display = 'flex';

    const reveal = document.getElementById('criminal-reveal');
    reveal.innerHTML = '';
    (gs.criminals || []).forEach(lt => {
      const card = document.createElement('div');
      card.className = 'criminal-card';
      card.textContent = lt;
      reveal.appendChild(card);
    });

    const chipsLeft = gs.chips || 0;
    const winner = gs.winnerId;
    const stamp = document.getElementById('end-stamp');
    if (winner) {
      stamp.className = 'stamp win';
      stamp.textContent = 'CASE CLOSED';
      document.getElementById('end-message').textContent =
        `${BV._playerName(gs, winner)} exposed Black Vienna with ${chipsLeft} chips remaining.`;
    } else {
      stamp.className = 'stamp fail';
      stamp.textContent = 'UNSOLVED';
      document.getElementById('end-message').textContent =
        'The investigation collapsed. Black Vienna escapes.';
    }

    const tbody = document.querySelector('#scores-table tbody');
    tbody.innerHTML = '';
    (gs.turnOrder || []).forEach(pid => {
      const acc = gs.accusations?.[pid];
      let accText = '—', score = '0', cls = 'score-zero';
      if (acc) {
        accText = acc.letters.join(', ') + (acc.correct ? ' ✓' : ' ✗');
        if (acc.correct && pid === winner) { score = (chipsLeft * 3).toString(); cls = 'score-win'; }
        else if (acc.correct) { score = chipsLeft.toString(); cls = 'score-win'; }
      }
      tbody.innerHTML += `<tr>
        <td>${BV._playerName(gs, pid)}${pid === winner ? ' ★' : ''}</td>
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
    list.innerHTML = [...entries].reverse().slice(0, 30).map(e => {
      let chipsHtml = e.count === 0
        ? '<span class="log-zero">0</span>'
        : Array(e.count).fill('<div class="log-chip"></div>').join('');
      return `<div class="log-entry">
        <span class="log-n">${e.n}</span>
        <span class="log-text"><strong>${e.asker}</strong> → <strong>${e.target}</strong>: ${e.card}</span>
        <div class="log-chips">${chipsHtml}</div>
      </div>`;
    }).join('');
  },

  // ── PLAYERS STATUS ─────────────────────────────────────────────

  _renderPlayers(gs) {
    const container = document.getElementById('players-status');
    container.innerHTML = '';
    (gs.turnOrder || []).forEach((pid, idx) => {
      const isTurn = idx === gs.currentTurnIdx && gs.phase === 'choose-card';
      const isElim = gs.eliminated?.includes(pid);
      const item = document.createElement('div');
      item.className = 'player-status-item' + (isTurn ? ' is-turn' : '') + (isElim ? ' eliminated' : '');
      item.innerHTML = `<div class="player-status-dot"></div>${BV._playerName(gs, pid)}${isElim ? ' ✗' : ''}`;
      container.appendChild(item);
    });
  },

  // ── INVESTIGATION SHEET ────────────────────────────────────────

  renderSheet() {
    const gs = BV.state;
    if (!gs) return;
    const playerIds = gs.turnOrder || [];
    const table = document.getElementById('sheet-table');
    let html = `<thead><tr><th class="lh">—</th>`;
    playerIds.forEach(pid => {
      html += `<th title="${BV._playerName(gs,pid)}">${BV._playerName(gs,pid).substring(0,4)}</th>`;
    });
    html += `</tr></thead><tbody>`;
    SUSPECTS.forEach((lt, ri) => {
      html += `<tr class="${ri%2===0 ? 'sheet-row-hi' : ''}"><td class="ltr">${lt}</td>`;
      playerIds.forEach(pid => {
        const val = BV.sheetData?.[lt]?.[pid] || '';
        if (val === 'kP') html += `<td><div class="sheet-cell kP">+</div></td>`;
        else if (val === 'kM') html += `<td><div class="sheet-cell kM">−</div></td>`;
        else {
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
    const cycle = { '': 'P', 'P': 'M', 'M': 'C', 'C': '' };
    BV.sheetData[lt][pid] = cycle[BV.sheetData[lt][pid] || ''] || '';
    BV.renderSheet();
  },

  // ── HELPERS ────────────────────────────────────────────────────

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
    for (let i = a.length-1; i > 0; i--) {
      const j = Math.floor(Math.random()*(i+1));
      [a[i],a[j]] = [a[j],a[i]];
    }
    return a;
  },

  _scheduleCleanup(code) {
    setTimeout(async () => {
      try { await db.ref(`rooms/${code}`).remove(); } catch(e) {}
    }, 4 * 60 * 60 * 1000);
  },

  _playerName(gs, pid) {
    return BV._cachedNames?.[pid] || pid?.substring(0,6) || '?';
  },
};

// ── Name cache ──────────────────────────────────────────────────
BV._cachedNames = {};

function warmNameCache() {
  if (!BV.roomCode) return;
  db.ref(`rooms/${BV.roomCode}/players`).once('value', snap => {
    if (!snap.exists()) return;
    Object.entries(snap.val()).forEach(([pid, p]) => {
      BV._cachedNames[pid] = p.name;
    });
  });
}

// ── Screen helper (index.html only) ─────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ── Auto-init ────────────────────────────────────────────────────
if (document.body.classList.contains('game-body')) {
  warmNameCache();
  document.addEventListener('DOMContentLoaded', () => BV.initGamePage());
} else {
  document.addEventListener('DOMContentLoaded', () => {
    const saved = sessionStorage.getItem('bv_room');
    if (saved) {
      BV.roomCode = saved;
      BV.myId = sessionStorage.getItem('bv_id');
      BV.myName = sessionStorage.getItem('bv_name');
    }
  });
}
