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
  _dealingStarted: false,
  state: null,
  sheetData: null,
  _pendingAnswer: null,
  _pendingCard: null,
  _pendingCardStr: null,
  _pendingStackIdx: null,
  _pendingTarget: null,
  _answerOverride: false,
  _notificationsEnabled: false,
  _lastNotifiedTurn: null,  // prevent duplicate notifications

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
    localStorage.setItem('bv_room', code);
    localStorage.setItem('bv_id', playerId);
    localStorage.setItem('bv_name', name);
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

    localStorage.setItem('bv_room', code);
    localStorage.setItem('bv_id', playerId);
    localStorage.setItem('bv_name', name);
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

      if (count >= needed) {
        // Auto-deal when the last player joins — only the host triggers it
        if (BV.isHost && !BV._dealingStarted) {
          BV._dealingStarted = true;
          document.getElementById('lobby-status').textContent = 'All players present — dealing cards…';
          BV.dealCards();
        } else {
          document.getElementById('lobby-status').textContent = 'All ' + needed + ' players present — dealing…';
        }
        // Always show manual deal button as fallback for everyone
        document.getElementById('lobby-host-controls').style.display = 'block';
        document.getElementById('start-btn').disabled = false;
        document.getElementById('start-btn').textContent = 'Deal Cards Manually';
      } else {
        document.getElementById('lobby-status').textContent = count + ' / ' + needed + ' players joined…';
        document.getElementById('lobby-host-controls').style.display = 'block';
        document.getElementById('start-btn').disabled = true;
        document.getElementById('start-btn').textContent = 'Waiting for players…';
      }
    });
  },

  // ── DEAL CARDS ─────────────────────────────────────────────────

  async dealCards() {
    try {
    const snap = await db.ref(`rooms/${BV.roomCode}`).once('value');
    if (!snap.exists()) throw new Error('Room not found');
    const room = snap.val();
    const players = room.players;
    const n = room.playerCount;
    const actualCount = Object.keys(players).length;
    if (actualCount < n) throw new Error('Only ' + actualCount + ' of ' + n + ' players have joined');
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

    // Store names in game state so all clients can look them up without async cache
    const playerNames = {};
    playerIds.forEach(pid => { playerNames[pid] = players[pid].name; });

    const gameState = {
      criminals,
      hands,
      stacks,
      topCards: [stacks[0][0] || '', stacks[1][0] || '', stacks[2][0] || ''],
      playerCards,      // cards sitting in front of each player (1+ chips only)
      zeroChipCards: [], // cards answered with 0 chips — still playable on anyone
      chips: 40,
      invCount: 0,
      turnOrder: playerIds,
      playerNames,      // { playerId: "Name" } — reliable across all clients
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
    } catch(e) {
      console.error('dealCards error:', e);
      BV._dealingStarted = false;
      const statusEl = document.getElementById('lobby-status');
      if (statusEl) statusEl.textContent = 'Error dealing cards: ' + e.message;
      const btn = document.getElementById('start-btn');
      if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
      document.getElementById('lobby-host-controls').style.display = 'block';
    }
  },

  // ── GAME PAGE INIT ─────────────────────────────────────────────

  initGamePage() {
    const params = new URLSearchParams(window.location.search);
    BV.roomCode = params.get('room') || localStorage.getItem('bv_room');
    BV.myId = params.get('id') || localStorage.getItem('bv_id');
    BV.myName = localStorage.getItem('bv_name');

    if (!BV.roomCode || !BV.myId) { window.location.href = 'index.html'; return; }

    document.getElementById('header-room-code').textContent = 'Room ' + BV.roomCode;
    document.getElementById('header-player-name').textContent = BV.myName || '—';

    BV.sheetData = {};
    SUSPECTS.forEach(lt => { BV.sheetData[lt] = {}; });

    // First check room status — if still lobby, cards were never dealt
    db.ref('rooms/' + BV.roomCode).once('value', snap => {
      if (!snap.exists()) {
        BV._showStuckScreen('Room not found. It may have expired.');
        return;
      }
      const room = snap.val();
      BV.isHost = room.hostId === BV.myId;

      if (room.status === 'lobby' || !room.gameState) {
        // Cards never dealt — show recovery screen
        BV._showStuckScreen(null, room);
        return;
      }

      // Normal game — watch state
      BV._startWatchingGame();
    });
  },

  _showStuckScreen(errorMsg, room) {
    const turnEl = document.getElementById('turn-text');
    if (turnEl) turnEl.textContent = errorMsg || 'Cards have not been dealt yet.';

    const panel = document.getElementById('action-panel');
    if (!panel) return;
    panel.style.display = 'block';

    if (errorMsg) {
      panel.innerHTML = '<div class="action-step-label">Error</div>' +
        '<div class="action-text">' + errorMsg + '</div>' +
        '<button class="btn btn-ghost" onclick="window.location=\"index.html\"">Back to Lobby</button>';
      return;
    }

    const players = room.players || {};
    const count = Object.keys(players).length;
    const needed = room.playerCount;
    const ready = count >= needed;

    panel.innerHTML = '<div class="action-step-label">Game Not Started</div>' +
      '<div class="action-text">' + count + ' of ' + needed + ' players have joined.' +
      (ready ? ' Everyone is here — cards can be dealt.' : ' Waiting for more players.') + '</div>' +
      (ready ? '<button class="btn btn-primary" onclick="BV._forceDeal()" style="margin-top:8px">Deal Cards Now</button>' : '') +
      '<button class="btn btn-ghost" style="margin-top:8px;margin-left:8px" onclick="window.location=\"index.html\"">Back to Home</button>';
  },

  async _forceDeal() {
    const panel = document.getElementById('action-panel');
    if (panel) panel.innerHTML = '<div class="action-text">Dealing cards…</div>';
    try {
      await BV.dealCards();
    } catch(e) {
      if (panel) panel.innerHTML = '<div class="action-text" style="color:var(--blood)">Error dealing: ' + e.message + '</div>';
    }
  },

  _startWatchingGame() {
    BV.initNotifications();
    BV._updateNotifBtn();
    BV.sheetData = BV.sheetData || {};
    SUSPECTS.forEach(lt => { if (!BV.sheetData[lt]) BV.sheetData[lt] = {}; });

    db.ref('rooms/' + BV.roomCode + '/gameState').on('value', snap => {
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
    // Fire notification if relevant
    BV._checkAndNotify(gs);
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
    const isFinalRound = gs.status === 'final-round';
    const turnEl = document.getElementById('turn-text');
    if (isFinalRound) {
      const winner = BV._playerName(gs, gs.winnerId);
      const myAccused = gs.accusations?.[BV.myId];
      turnEl.textContent = myAccused
        ? 'You have made your final accusation. Waiting for others…'
        : winner + ' solved it! Make your final accusation now.';
    } else if (gs.phase === 'waiting-answer') {
      const target = BV._playerName(gs, gs.pendingInv?.targetId);
      const asker = BV._playerName(gs, gs.pendingInv?.askerId);
      turnEl.textContent = gs.pendingInv?.targetId === BV.myId
        ? asker + ' is questioning you — answer below.'
        : 'Waiting for ' + target + ' to answer…';
    } else if (myTurn && !isEliminated) {
      turnEl.textContent = 'Your turn — tap an investigation card below.';
    } else {
      const current = BV._playerName(gs, gs.turnOrder[gs.currentTurnIdx]);
      turnEl.textContent = current + "'s turn to investigate.";
    }

    document.getElementById('chips-value').textContent = gs.chips;

    // Hint text on inv cards section
    const hint = document.getElementById('inv-cards-hint');
    if (hint) {
      if (myTurn && !isEliminated && gs.phase === 'choose-card') {
        hint.textContent = 'tap a card to investigate';
        hint.style.color = 'var(--sepia)';
      } else {
        hint.textContent = '';
      }
    }

    BV._renderHand(gs);
    // No new investigations during final round
    const canInvestigate = myTurn && !isEliminated && gs.phase === 'choose-card' && !isFinalRound;
    BV._renderInvCards(gs, canInvestigate);
    BV._renderActionPanel(gs, myTurn, isEliminated, isFinalRound);
    BV._renderPlayerCardsTable(gs);
    BV._renderSheet();
    BV._renderLog(gs);
  },

  // ── HAND ───────────────────────────────────────────────────────

  _renderHand(gs) {
    const el = document.getElementById('view-hand-row');
    if (!el) return;
    const hand = gs.hands?.[BV.myId] || [];
    el.innerHTML = hand.length
      ? hand.map(lt => '<span class="hand-letter">' + lt + '</span>').join('')
      : '<span style="font-style:italic;font-size:12px;color:var(--muted)">—</span>';
  },

  // ── INVESTIGATION CARDS ────────────────────────────────────────

  _renderInvCards(gs, canSelect) {
    const grid = document.getElementById('inv-cards-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Stack top cards (empty string means stack is exhausted)
    (gs.topCards || []).forEach((card, si) => {
      if (!card || card === '') return;
      const el = document.createElement('div');
      el.className = 'inv-card' + (canSelect ? ' selectable' : '');
      if (BV._pendingCard === 'stack-' + si) el.classList.add('selected');
      el.innerHTML = '<div class="inv-card-stack">Stack ' + (si+1) + '</div>' +
        '<div class="inv-card-letters">' + card + '</div>' +
        '<div class="inv-card-chips">' + BV._ghostChips(3) + '</div>';
      if (canSelect) el.onclick = () => BV._selectCard('stack-' + si, card, si, gs);
      grid.appendChild(el);
    });

    // 0-chip replayable cards
    (gs.zeroChipCards || []).forEach((entry, zi) => {
      const el = document.createElement('div');
      el.className = 'inv-card zero-chip' + (canSelect ? ' selectable' : '');
      if (BV._pendingCard === 'zero-' + zi) el.classList.add('selected');
      el.innerHTML = '<div class="inv-card-stack replay">0 chips — replay</div>' +
        '<div class="inv-card-letters">' + entry.card + '</div>' +
        '<div class="inv-card-chips">' + BV._ghostChips(3) + '</div>';
      if (canSelect) el.onclick = () => BV._selectCard('zero-' + zi, entry.card, null, gs);
      grid.appendChild(el);
    });

    if (!grid.children.length) {
      grid.innerHTML = '<div class="waiting-msg" style="padding:10px 0">No cards available.</div>';
    }
  },

  // ── ACTION PANEL ───────────────────────────────────────────────

  _renderActionPanel(gs, myTurn, isEliminated, isFinalRound) {
    const panel = document.getElementById('action-panel');
    if (!panel) return;

    // Card selected — show target picker
    if (myTurn && !isEliminated && BV._pendingCard && gs.phase === 'choose-card') {
      panel.style.display = 'block';
      let html = '<div class="action-step-label">Choose who to interrogate</div>' +
        '<div class="action-text">Card: <strong style="letter-spacing:.15em;font-size:15px">' + BV._pendingCardStr + '</strong></div>' +
        '<div class="player-btn-grid">';
      gs.turnOrder.forEach(pid => {
        if (pid === BV.myId) return;
        const elim = gs.eliminated?.includes(pid);
        // Eliminated players can still be questioned — just show a marker
        const label = BV._playerName(gs, pid) + (elim ? ' ✗' : '');
        html += '<button class="player-select-btn" onclick="BV._selectTarget(\'' + pid + '\')">' + label + '</button>';
      });
      html += '</div><button class="btn btn-ghost" style="font-size:11px" onclick="BV._cancelCard()">← Back</button>';
      panel.innerHTML = html;
      return;
    }

    // Waiting for answer
    if (gs.phase === 'waiting-answer') {
      panel.style.display = 'block';
      const inv = gs.pendingInv;
      if (inv.targetId === BV.myId) {
        panel.innerHTML = '<div class="action-step-label">Answer the interrogation</div>' +
          '<div class="action-text">See the prompt that appeared on your screen.</div>';
      } else {
        panel.innerHTML = '<div class="action-step-label">Investigation underway</div>' +
          '<div class="action-text"><strong>' + BV._playerName(gs, inv.askerId) + '</strong> asked ' +
          '<strong>' + BV._playerName(gs, inv.targetId) + '</strong> about ' +
          '<strong style="letter-spacing:.1em">' + inv.card + '</strong>. Waiting for answer…</div>';
      }
      return;
    }

    // Final round — prompt unaccused players to accuse
    if (isFinalRound) {
      const myAccused = gs.accusations?.[BV.myId];
      if (!myAccused) {
        panel.style.display = 'block';
        panel.innerHTML = '<div class="action-step-label">Final Round</div>' +
          '<div class="action-text">The case has been cracked! Tap <strong>Accuse</strong> in the top right to make your final guess and potentially tie for the win.</div>';
      } else {
        panel.style.display = 'block';
        panel.innerHTML = '<div class="action-step-label">Final Round</div>' +
          '<div class="action-text">You have made your accusation. Waiting for other players…</div>';
      }
      return;
    }

    // Not your turn
    if (!myTurn || isEliminated) {
      panel.style.display = 'none';
      return;
    }

    // Your turn, no card selected yet
    panel.style.display = 'none';
  },

  // ── TURN FLOW ──────────────────────────────────────────────────

  _selectCard(pendingKey, cardStr, stackIdx, gs) {
    BV._pendingCard = pendingKey;
    BV._pendingCardStr = cardStr;
    BV._pendingStackIdx = stackIdx;
    BV._pendingTarget = null;
    // Re-render to show target picker in action panel
    BV._renderInvCards(gs, false);
    BV._renderActionPanel(gs, true, false);
  },

  _cancelCard() {
    BV._pendingCard = null;
    BV._pendingCardStr = null;
    BV._pendingStackIdx = null;
    BV._pendingTarget = null;
    const gs = BV.state;
    BV._renderInvCards(gs, true);
    BV._renderActionPanel(gs, true, false);
  },

  async _selectTarget(targetId) {
    const pendingInv = {
      askerId: BV.myId,
      targetId,
      card: BV._pendingCardStr,
      stackIdx: BV._pendingStackIdx,
      isZeroReplay: BV._pendingCard?.startsWith('zero-'),
      zeroReplayIdx: BV._pendingCard?.startsWith('zero-')
        ? parseInt(BV._pendingCard.split('-')[1]) : null,
    };

    BV._pendingCard = null;
    BV._pendingCardStr = null;
    BV._pendingStackIdx = null;
    BV._pendingTarget = null;

    await db.ref('rooms/' + BV.roomCode + '/gameState').update({
      phase: 'waiting-answer',
      pendingInv
    });
  },

    // ── PLAYER CARDS TABLE ─────────────────────────────────────────

  _renderPlayerCardsTable(gs) {
    const table = document.getElementById('player-cards-table');
    if (!table) return;
    const playerCards = gs.playerCards || {};
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    gs.turnOrder.forEach((pid, idx) => {
      const isTurn = idx === gs.currentTurnIdx && gs.phase === 'choose-card';
      const isElim = gs.eliminated?.includes(pid);
      const isMe = pid === BV.myId;
      const name = BV._playerName(gs, pid);
      const cards = playerCards[pid] || [];

      const tr = document.createElement('tr');

      // Name cell
      const nameTd = document.createElement('td');
      let nameHtml = '';
      if (isTurn) nameHtml += '<span class="pulse-dot" style="width:7px;height:7px;margin-right:5px;display:inline-block"></span>';
      nameHtml += '<span class="pname-cell' + (isTurn ? ' pname-turn' : isElim ? ' pname-elim' : '') + '">' +
        name + (isMe ? ' ✦' : '') + (isElim ? ' ✗' : '') + '</span>';
      nameTd.innerHTML = nameHtml;
      nameTd.style.whiteSpace = 'nowrap';

      // Cards cell
      const cardsTd = document.createElement('td');
      if (!cards.length) {
        cardsTd.innerHTML = '<span class="no-cards-msg">—</span>';
      } else {
        cards.forEach(entry => {
          let pips = '';
          for (let i = 0; i < 3; i++) {
            pips += i < entry.count
              ? '<span class="chip-pip"></span>'
              : '<span class="chip-pip-empty"></span>';
          }
          cardsTd.innerHTML += '<div class="pcard-entry">' + pips +
            '<span style="margin-left:4px">' + entry.card + '</span></div>';
        });
      }

      tr.appendChild(nameTd);
      tr.appendChild(cardsTd);
      tbody.appendChild(tr);
    });
  },

  // ── SHEET ──────────────────────────────────────────────────────

  _renderSheet() {
    // Only render if visible on screen (always visible now)
    BV.renderSheet();
  },

  // ── LOG ────────────────────────────────────────────────────────

  _renderLog(gs) {
    const tbody = document.getElementById('log-tbody');
    if (!tbody) return;
    const entries = gs.log || [];
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;font-style:italic;color:var(--muted);padding:10px">No investigations yet.</td></tr>';
      return;
    }
    tbody.innerHTML = [...entries].reverse().slice(0, 50).map(e => {
      let pips = '';
      if (e.count === 0) pips = '<span class="log-zero">0</span>';
      else for (let i = 0; i < e.count; i++) pips += '<div class="log-pip"></div>';
      return '<tr><td>' + e.n + '</td><td>' + e.asker + '</td><td>' + e.target +
        '</td><td style="letter-spacing:.1em">' + e.card +
        '</td><td><div class="log-pips">' + pips + '</div></td></tr>';
    }).join('');
  },

    // ── ANSWER ─────────────────────────────────────────────────────

  _showAnswerPrompt(inv) {
    document.getElementById('answer-overlay').style.display = 'flex';
    const who = document.getElementById('answer-who');
    if (who) who.textContent = BV._playerName(BV.state, inv.askerId) + ' asks you about:';
    const lettersEl = document.getElementById('answer-card-letters');
    if (lettersEl) lettersEl.textContent = inv.card;

    // Auto-calculate answer from hand
    const myHand = BV.state.hands?.[BV.myId] || [];
    const autoCount = inv.card.split('').filter(lt => myHand.includes(lt)).length;
    BV._debugLog('Auto-answer: card=' + inv.card + ' hand=' + myHand.join(',') + ' count=' + autoCount);

    // Show what will be submitted so player can see before it fires
    const disp = document.getElementById('answer-selected-display');
    if (disp) disp.textContent = 'Auto-answering: ' + autoCount + ' chip' + (autoCount === 1 ? '' : 's');

    // Highlight the correct button
    const sel = document.getElementById('chip-selector');
    sel.innerHTML = '';
    for (let i = 0; i <= 3; i++) {
      const btn = document.createElement('button');
      btn.className = 'chip-count-btn' + (i === autoCount ? ' sel' : '');
      btn.textContent = i;
      btn.disabled = true; // display only
      sel.appendChild(btn);
    }

    document.getElementById('answer-err').textContent = '';
    document.getElementById('answer-confirm-btn').style.display = 'none';
    const overrideBtn = document.getElementById('answer-override-btn');
    if (overrideBtn) overrideBtn.style.display = 'none';

    // Auto-submit after a short delay so player can see the answer
    BV._pendingAnswer = autoCount;
    BV._answerOverride = true; // bypass validation
    setTimeout(() => BV.submitAnswer(), 1500);
  },

  _selectChipCount(n) {
    BV._pendingAnswer = n;
    BV._answerOverride = false;
    document.querySelectorAll('.chip-count-btn').forEach((b, i) => b.classList.toggle('sel', i === n));
    document.getElementById('answer-confirm-btn').disabled = false;
    // Hide override button if chip count changes
    const overrideBtn = document.getElementById('answer-override-btn');
    if (overrideBtn) overrideBtn.style.display = 'none';
    const errEl = document.getElementById('answer-err');
    if (errEl) errEl.textContent = '';
    // Show confirmation so player knows their tap registered
    const disp = document.getElementById('answer-selected-display');
    if (disp) disp.textContent = 'Selected: ' + n + ' chip' + (n === 1 ? '' : 's');
    BV._debugLog('Chip selected: ' + n);
  },

  _submitOverride() {
    BV._answerOverride = true;
    BV._debugLog('Override confirmed by player');
    const overrideBtn = document.getElementById('answer-override-btn');
    if (overrideBtn) overrideBtn.style.display = 'none';
    const errEl = document.getElementById('answer-err');
    if (errEl) errEl.textContent = '';
    BV.submitAnswer();
  },

  async submitAnswer() {
    BV._debugLog('Submit tapped. _pendingAnswer=' + BV._pendingAnswer);
    if (BV._pendingAnswer === null) {
      const errEl = document.getElementById('answer-err');
      if (errEl) errEl.textContent = 'Please tap a number first (0, 1, 2, or 3).';
      return;
    }
    const count = BV._pendingAnswer;
    const inv = BV.state.pendingInv;
    const gs = BV.state;

    // Soft validation — warn if answer doesn't match hand, but allow override
    const myHand = gs.hands[BV.myId] || [];
    const actualCount = inv.card.split('').filter(lt => myHand.includes(lt)).length;
    BV._debugLog('Submitting count=' + count + ' actualCount=' + actualCount + ' hand=' + myHand.join(','));
    BV._debugLog('inv.card=' + inv.card + ' inv.stackIdx=' + inv.stackIdx + ' isZeroReplay=' + inv.isZeroReplay);
    BV._debugLog('roomCode=' + BV.roomCode + ' myId=' + BV.myId);

    if (myHand.length > 0 && count !== actualCount && !BV._answerOverride) {
      const errEl = document.getElementById('answer-err');
      const overrideBtn = document.getElementById('answer-override-btn');
      if (errEl) errEl.textContent =
        'Your hand suggests ' + actualCount + ' match' + (actualCount === 1 ? '' : 'es') +
        ', but you selected ' + count + '. Are you sure?';
      if (overrideBtn) overrideBtn.style.display = 'inline-block';
      return;
    }
    // Clear override flag for next time
    BV._answerOverride = false;

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
      newTopCards[si] = stacks[si][0] || false;
    }

    // Always record in playerCards for tracking — shows chip count to all players
    if (!newPlayerCards[inv.targetId]) newPlayerCards[inv.targetId] = [];
    newPlayerCards[inv.targetId].push({ card: inv.card, count });

    if (count === 0) {
      // 0 chips: also goes back to the pool so it can be asked again
      newZeroChipCards.push({ card: inv.card });
    }
    // 1-3 chips: card stays in front of player only (not replayable)

    const newChips = Math.max(0, (gs.chips || 40) - count);

    // Next turn: the questioned player goes next, but skip them if eliminated
    const eliminated = gs.eliminated || [];
    let nextTurnIdx = gs.turnOrder.indexOf(inv.targetId);
    // If that player is eliminated, advance to the next non-eliminated player
    if (eliminated.includes(inv.targetId)) {
      const n = gs.turnOrder.length;
      for (let i = 1; i <= n; i++) {
        const idx = (nextTurnIdx + i) % n;
        if (!eliminated.includes(gs.turnOrder[idx])) {
          nextTurnIdx = idx;
          break;
        }
      }
    }

    const logEntry = {
      n: (gs.log?.length || 0) + 1,
      asker: BV._playerName(gs, inv.askerId),
      target: BV._playerName(gs, inv.targetId),
      card: inv.card,
      count
    };

    updates['phase'] = 'choose-card';
    updates['pendingInv'] = null;
    // Only update stacks/topCards when card came from a stack (not a zero-chip replay)
    if (!inv.isZeroReplay) {
      updates['stacks'] = stacks;
      // Sanitize topCards — Firebase rejects null/undefined in arrays, use empty string for empty stacks
      updates['topCards'] = newTopCards.map(c => c || '');
    }
    updates['playerCards'] = newPlayerCards;
    updates['zeroChipCards'] = newZeroChipCards;
    updates['invCount'] = (gs.invCount || 0) + 1;
    updates['chips'] = newChips;
    updates['currentTurnIdx'] = nextTurnIdx;
    updates['log'] = [...(gs.log || []), logEntry];

    if (newChips <= 3) updates['status'] = 'ended';

    BV._debugLog('Writing to Firebase...');
    try {
      await db.ref('rooms/' + BV.roomCode + '/gameState').update(updates);
      BV._debugLog('Firebase write OK');
      document.getElementById('answer-overlay').style.display = 'none';
      BV._pendingAnswer = null;
    } catch(e) {
      BV._debugLog('Firebase ERROR: ' + e.message);
      const errEl = document.getElementById('answer-err');
      if (errEl) errEl.textContent = 'Connection error — please try again. (' + e.message + ')';
      // Re-enable submit so they can retry
      const btn = document.getElementById('answer-confirm-btn');
      if (btn) btn.disabled = false;
    }
  },

  // ── ACCUSATION ─────────────────────────────────────────────────

  async confirmAccusation() {
    const sel = window.getAccuseSelection ? window.getAccuseSelection() : [];
    if (sel.length !== 3) return;

    const correct = [...sel].sort().join('') === [...(BV.state.criminals || [])].sort().join('');
    const updates = {};
    updates[`accusations/${BV.myId}`] = { letters: sel, correct, at: Date.now() };

    const gs = BV.state;

    if (correct) {
      // First correct answer — enter final round so others can tie
      const alreadyWon = gs.winnerId;
      if (alreadyWon) {
        // Second+ correct answer — just record it, check if everyone has accused
        updates['accusations/' + BV.myId] = { letters: sel, correct, at: Date.now() };
        const allAccused = gs.turnOrder.every(pid =>
          gs.accusations?.[pid] || pid === BV.myId
        );
        if (allAccused) updates['status'] = 'ended';
      } else {
        // First winner — start final round
        updates['winnerId'] = BV.myId;
        updates['status'] = 'final-round';
        updates['phase'] = 'final-round';
        // Check if everyone else has already accused — if so end immediately
        const othersAllAccused = gs.turnOrder
          .filter(pid => pid !== BV.myId)
          .every(pid => gs.accusations?.[pid]);
        if (othersAllAccused) updates['status'] = 'ended';
      }
    } else {
      const newElim = [...(gs.eliminated || []), BV.myId];
      updates['eliminated'] = newElim;

      // Check if game should end
      const allAccused = gs.turnOrder.every(pid =>
        newElim.includes(pid) || gs.accusations?.[pid] || pid === BV.myId
      );
      if (gs.status === 'final-round' && allAccused) {
        updates['status'] = 'ended';
      } else if (newElim.length >= gs.turnOrder.length) {
        updates['status'] = 'ended';
      } else if (gs.status !== 'final-round') {
        // Normal play — advance turn if it was accuser's turn
        const isAccusersTurn = gs.turnOrder[gs.currentTurnIdx] === BV.myId;
        if (isAccusersTurn) {
          const n = gs.turnOrder.length;
          let nextTurnIdx = gs.currentTurnIdx;
          for (let i = 1; i <= n; i++) {
            const idx = (gs.currentTurnIdx + i) % n;
            if (!newElim.includes(gs.turnOrder[idx])) {
              nextTurnIdx = idx;
              break;
            }
          }
          updates['currentTurnIdx'] = nextTurnIdx;
          updates['phase'] = 'choose-card';
        }
      }
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
    const correctAccusers = (gs.turnOrder || []).filter(pid => gs.accusations?.[pid]?.correct);

    if (winner) {
      stamp.className = 'stamp win';
      stamp.textContent = 'CASE CLOSED';
      if (correctAccusers.length > 1) {
        const names = correctAccusers.map(pid => BV._playerName(gs, pid)).join(' & ');
        document.getElementById('end-message').textContent =
          names + ' all cracked the case! ' + chipsLeft + ' chips remaining.';
      } else {
        document.getElementById('end-message').textContent =
          BV._playerName(gs, winner) + ' exposed Black Vienna with ' + chipsLeft + ' chips remaining.';
      }
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
      let accText = '\u2014', score = '0', cls = 'score-zero';
      const isWinner = pid === winner;
      const isTied = acc?.correct && !isWinner;
      if (acc) {
        accText = acc.letters.join(', ') + (acc.correct ? ' \u2713' : ' \u2717');
        if (isWinner) { score = (chipsLeft * 3).toString(); cls = 'score-win'; }
        else if (isTied) { score = chipsLeft.toString(); cls = 'score-win'; }
      }
      const star = isWinner ? ' \u2605' : isTied ? ' \u2606' : '';
      tbody.innerHTML += '<tr><td>' + BV._playerName(gs, pid) + star + '</td><td>' + accText + '</td><td class="' + cls + '">' + score + '</td></tr>';
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
    // Store expiry timestamp in Firebase — 30 days
    const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
    db.ref('rooms/' + code + '/expiresAt').set(expiresAt);
  },

  _playerName(gs, pid) {
    // Use names stored in game state — always reliable, no async needed
    if (gs?.playerNames?.[pid]) return gs.playerNames[pid];
    // Fallback to cache (for lobby/pre-game calls)
    if (BV._cachedNames?.[pid]) return BV._cachedNames[pid];
    return pid?.substring(0,6) || '?';
  },
};

// ── Push Notifications ───────────────────────────────────────────

BV.initNotifications = async function() {
  // Register service worker
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    console.log('Push notifications not supported');
    return;
  }
  try {
    await navigator.serviceWorker.register('/sw.js');
    console.log('Service worker registered');

    // Restore saved preference
    const saved = localStorage.getItem('bv_notifications');
    if (saved === 'granted') {
      BV._notificationsEnabled = Notification.permission === 'granted';
    }
  } catch(e) {
    console.log('Service worker registration failed:', e);
  }
};

BV.requestNotifications = async function() {
  if (!('Notification' in window)) {
    alert('Your browser does not support notifications.');
    return false;
  }
  if (Notification.permission === 'granted') {
    BV._notificationsEnabled = true;
    localStorage.setItem('bv_notifications', 'granted');
    BV._updateNotifBtn();
    return true;
  }
  if (Notification.permission === 'denied') {
    alert('Notifications are blocked. Please enable them in your browser settings for this site.');
    return false;
  }
  const permission = await Notification.requestPermission();
  BV._notificationsEnabled = permission === 'granted';
  if (BV._notificationsEnabled) {
    localStorage.setItem('bv_notifications', 'granted');
    // Send a test notification
    BV._notify('Black Vienna', "Notifications enabled! You'll be alerted when it's your turn.");
  }
  BV._updateNotifBtn();
  return BV._notificationsEnabled;
};

BV._notify = function(title, body) {
  if (!BV._notificationsEnabled) return;
  if (Notification.permission !== 'granted') return;
  // Don't notify if page is visible and focused
  if (document.visibilityState === 'visible') return;

  navigator.serviceWorker.ready.then(reg => {
    reg.showNotification(title, {
      body,
      tag: 'black-vienna-turn',
      renotify: true,
      icon: '/icon.png',
      data: { url: window.location.href }
    });
  }).catch(() => {
    // Fallback to basic notification
    new Notification(title, { body });
  });
};

BV._updateNotifBtn = function() {
  const btn = document.getElementById('notif-toggle-btn');
  if (!btn) return;
  if (BV._notificationsEnabled && Notification.permission === 'granted') {
    btn.textContent = '🔔';
    btn.title = 'Notifications on — tap to learn more';
    btn.style.opacity = '1';
  } else {
    btn.textContent = '🔕';
    btn.title = 'Tap to enable turn notifications';
    btn.style.opacity = '0.6';
  }
};

BV._checkAndNotify = function(gs) {
  if (!gs) return;
  const myTurn = gs.turnOrder?.[gs.currentTurnIdx] === BV.myId;
  const isFinalRound = gs.status === 'final-round';
  const myAccused = gs.accusations?.[BV.myId];

  // Build a unique key for this notification moment
  const notifKey = gs.invCount + '-' + gs.currentTurnIdx + '-' + gs.status;
  if (notifKey === BV._lastNotifiedTurn) return; // already notified for this state

  if (myTurn && gs.phase === 'choose-card' && !isFinalRound) {
    BV._lastNotifiedTurn = notifKey;
    BV._notify('Black Vienna — Your Turn', "It's your turn to investigate in room " + BV.roomCode + "!");
  } else if (gs.phase === 'waiting-answer' && gs.pendingInv?.targetId === BV.myId) {
    BV._lastNotifiedTurn = notifKey;
    const asker = BV._playerName(gs, gs.pendingInv.askerId);
    BV._notify('Black Vienna — Answer Needed', asker + ' is questioning you in room ' + BV.roomCode + '!');
  } else if (isFinalRound && !myAccused) {
    BV._lastNotifiedTurn = notifKey;
    const winner = BV._playerName(gs, gs.winnerId);
    BV._notify('Black Vienna — Final Round!', winner + ' cracked the case! Make your final accusation.');
  }
};

// ── Rejoin saved game ────────────────────────────────────────────
BV._checkRejoin = async function() {
  const code = localStorage.getItem('bv_room');
  const id = localStorage.getItem('bv_id');
  const name = localStorage.getItem('bv_name');
  if (!code || !id || !name) return;

  // Check if the room still exists
  try {
    const snap = await db.ref('rooms/' + code).once('value');
    if (!snap.exists()) {
      // Room gone — clear saved data
      localStorage.removeItem('bv_room');
      localStorage.removeItem('bv_id');
      localStorage.removeItem('bv_name');
      return;
    }
    const room = snap.val();

    // Show rejoin banner
    const banner = document.getElementById('rejoin-banner');
    const roomEl = document.getElementById('rejoin-room');
    const nameEl = document.getElementById('rejoin-name');
    if (banner && roomEl && nameEl) {
      roomEl.textContent = code;
      nameEl.textContent = name;
      banner.style.display = 'flex';
    }
  } catch(e) {
    console.log('Rejoin check failed:', e);
  }
};

BV._rejoin = function() {
  const code = localStorage.getItem('bv_room');
  const id = localStorage.getItem('bv_id');
  window.location.href = 'game.html?room=' + code + '&id=' + id;
};

BV._clearSaved = function() {
  localStorage.removeItem('bv_room');
  localStorage.removeItem('bv_id');
  localStorage.removeItem('bv_name');
  const banner = document.getElementById('rejoin-banner');
  if (banner) banner.style.display = 'none';
};

// ── Debug logger ─────────────────────────────────────────────────
BV._debugLog = function(msg) {
  const panel = document.getElementById('answer-debug');
  if (!panel) return;
  const time = new Date().toLocaleTimeString();
  panel.style.display = 'block';
  panel.innerHTML = panel.innerHTML + time + ': ' + msg + '<br>';
};

// Global error catcher — shows JS errors on screen for mobile debugging
window.addEventListener('error', function(e) {
  const panel = document.getElementById('answer-debug');
  if (panel) {
    panel.style.display = 'block';
    panel.innerHTML += '⚠ ' + e.message + ' (line ' + e.lineno + ')<br>';
  }
});

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
    const saved = localStorage.getItem('bv_room');
    if (saved) {
      BV.roomCode = saved;
      BV.myId = localStorage.getItem('bv_id');
      BV.myName = localStorage.getItem('bv_name');
      // Show rejoin prompt if they have a saved game
      BV._checkRejoin();
    }
  });
}
