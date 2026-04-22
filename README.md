# Black Vienna — Multiplayer

A fully real-time multiplayer implementation of the deduction card game Black Vienna, built with vanilla JS + Firebase Realtime Database, deployed on Vercel.

---

## Setup (15–20 minutes)

### 1. Firebase Project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → give it a name (e.g. `black-vienna`) → Continue
3. Disable Google Analytics if you don't need it → Create project

#### Enable Realtime Database
4. In the left sidebar: **Build → Realtime Database**
5. Click **Create Database**
6. Choose a region (us-central1 is fine) → **Next**
7. Start in **test mode** for now → **Enable**

#### Get your config
8. Click the gear icon → **Project settings**
9. Under "Your apps", click **</>** (Web)
10. Register the app (any nickname) — skip Firebase Hosting
11. Copy the `firebaseConfig` object shown

#### Apply security rules
12. In Realtime Database → **Rules** tab
13. Paste the contents of `database.rules.json` and click **Publish**

---

### 2. Add your config

Open `config.js` and replace the placeholder values with your Firebase config:

```js
const firebaseConfig = {
  apiKey:            "AIza...",
  authDomain:        "black-vienna-xxxx.firebaseapp.com",
  databaseURL:       "https://black-vienna-xxxx-default-rtdb.firebaseio.com",
  projectId:         "black-vienna-xxxx",
  storageBucket:     "black-vienna-xxxx.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123..."
};
```

---

### 3. Deploy to Vercel

#### Option A — Vercel CLI (fastest)
```bash
npm i -g vercel
cd black-vienna-multiplayer
vercel
```
Follow the prompts. Your app will be live at a `*.vercel.app` URL.

#### Option B — GitHub + Vercel Dashboard
1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) → **New Project**
3. Import the repo → Deploy (no build settings needed — it's static HTML)

---

## How to Play (Multiplayer Flow)

1. **One player** opens the site and taps **Create Game**
   - Enters their code name, chooses player count (3–6), taps **Create Room**
   - Gets a 4-letter room code

2. **Other players** tap **Join Game**, enter the room code and their code name

3. Once everyone has joined, the **host** taps **Deal Cards**

4. Each player privately sees their hand on their own device

5. The game proceeds in real-time — investigations, answers, and the log all sync automatically

6. Any player can tap **My Sheet** to open their private investigation sheet (stored locally — not synced, so others can't see your notes)

7. Tap **Accuse** at any time to name the three criminals

---

## File Structure

```
black-vienna-multiplayer/
├── index.html          # Title, create game, join game, lobby, rules
├── game.html           # Main game screen (each player's view)
├── style.css           # Shared styles
├── game.js             # All Firebase logic + game state + UI
├── config.js           # Your Firebase config (edit this)
├── database.rules.json # Firebase security rules
├── vercel.json         # Vercel routing config
└── README.md
```

## Firebase Data Structure

```
rooms/
  {ROOMCODE}/
    code: "ABCD"
    hostId: "playerId"
    playerCount: 4
    status: "lobby" | "playing" | "ended"
    players/
      {playerId}/
        name: "Marlowe"
        order: 0
    gameState/
      criminals: ["B","K","T"]
      hands: { playerId: ["A","C",...] }
      stacks: [[...],[...],[...]]
      topCards: ["ABD","BCG","CDH"]
      usedCards: [{card,count}]
      chips: 40
      invCount: 12
      turnOrder: [pid1, pid2, ...]
      currentTurnIdx: 2
      phase: "choose-card" | "waiting-answer"
      pendingInv: { askerId, targetId, cards, stackIdx }
      log: [{n,asker,target,cards,count}]
      accusations: { playerId: {letters,correct} }
      eliminated: [playerId]
      handRevealed: { playerId: true }
```

## Notes

- **Investigation sheets are local** — each player's +/−/○ marks are stored in their browser, not Firebase. This is intentional (your deductions are private).
- **Rooms auto-delete** after 4 hours client-side. For production, add a Firebase scheduled function.
- **No authentication required** — players are identified by a random ID stored in sessionStorage.
- The Spark (free) plan handles this easily: a 6-player game generates ~100 writes and ~500 reads total, far under the 20K/50K daily free limits.
