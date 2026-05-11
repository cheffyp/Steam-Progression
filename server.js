/**
 * Steam Progression — Pi backend
 *
 * Endpoints:
 *   GET  /api/state                    → full state (games + scan state)
 *   POST /api/sync                     → re-fetch library from Steam
 *   POST /api/complete                 → mark/unmark a game as completed
 *   POST /api/scan-achievements        → start background achievement scan
 *   POST /api/scan-stop                → stop in-progress scan
 *   GET  /api/scan-progress            → current scan progress
 *   GET  /api/random                   → pick random game with filters
 *
 * Static files in ./public/ are served at /
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ============ CONFIG ============
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const STEAM_ID = process.env.STEAM_ID || '';

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// ============ STATE ============
const initialState = {
  libraryCache: null,    // { fetchedAt, games: [{appid, name, playtime_forever, has_community_visible_stats, ...}] }
  completions: {},       // { [appid]: { completed, completedAt, manual } }
  achievementCache: {}   // { [appid]: { total, unlocked, fetchedAt, error? } }
};

let state;

// In-memory scan progress (not persisted — resets on server restart)
let scanState = { running: false, total: 0, done: 0, current: null };

function loadState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = Object.assign({}, initialState, parsed);
      console.log('[state] loaded from disk');
    } catch (e) {
      console.error('[state] failed to parse state.json, starting fresh', e);
      state = JSON.parse(JSON.stringify(initialState));
    }
  } else {
    state = JSON.parse(JSON.stringify(initialState));
    console.log('[state] no state file, starting fresh');
  }
}

function saveState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ============ STEAM API ============
async function steamGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Steam API HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('Invalid JSON from Steam API'); }
}

async function fetchLibrary() {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` +
    `?key=${STEAM_API_KEY}&steamid=${STEAM_ID}` +
    `&include_appinfo=1&include_played_free_games=1&format=json`;
  const data = await steamGet(url);
  if (!data.response || !data.response.games) {
    throw new Error('No game data — check that your Steam ID is correct and game details are set to Public in Steam privacy settings');
  }
  return data.response.games;
}

async function fetchAchievementsForGame(appid) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/` +
    `?key=${STEAM_API_KEY}&steamid=${STEAM_ID}&appid=${appid}&format=json`;
  let data;
  try {
    data = await steamGet(url);
  } catch (e) {
    return { error: 'fetch_failed', total: 0, unlocked: 0, fetchedAt: Date.now() };
  }

  if (!data.playerstats || !data.playerstats.success) {
    return { error: 'no_stats', total: 0, unlocked: 0, fetchedAt: Date.now() };
  }

  const achievements = data.playerstats.achievements || [];
  if (achievements.length === 0) {
    return { error: 'no_achievements', total: 0, unlocked: 0, fetchedAt: Date.now() };
  }

  const total = achievements.length;
  const unlocked = achievements.filter(a => a.achieved === 1).length;
  return { total, unlocked, fetchedAt: Date.now() };
}

// ============ BACKGROUND ACHIEVEMENT SCAN ============
async function runAchievementScan() {
  if (scanState.running) return;
  if (!state.libraryCache) return;

  // Only scan games that have community stats
  const games = state.libraryCache.games.filter(g => g.has_community_visible_stats);
  scanState = { running: true, total: games.length, done: 0, current: null };
  console.log(`[scan] starting achievement scan for ${games.length} games`);

  for (const game of games) {
    if (!scanState.running) break;
    scanState.current = game.name;

    const result = await fetchAchievementsForGame(game.appid);
    state.achievementCache[game.appid] = result;

    // Auto-complete if 100% achievements and no manual override exists
    if (result.total > 0 && result.unlocked === result.total) {
      const existing = state.completions[game.appid];
      if (!existing || !existing.manual) {
        state.completions[game.appid] = {
          completed: true,
          completedAt: existing?.completedAt || Date.now(),
          manual: false
        };
        console.log(`[scan] auto-completed: ${game.name}`);
      }
    }

    scanState.done++;
    // Save every 10 games to avoid thrashing disk
    if (scanState.done % 10 === 0) saveState();

    // Polite delay between Steam API requests
    await new Promise(r => setTimeout(r, 200));
  }

  saveState();
  console.log(`[scan] done. Scanned ${scanState.done}/${scanState.total}`);
  scanState.running = false;
  scanState.current = null;
}

// ============ GAME LIST BUILDER ============
function buildGameList() {
  if (!state.libraryCache) return [];
  return state.libraryCache.games.map(g => {
    const completion = state.completions[g.appid];
    const achievements = state.achievementCache[g.appid] || null;
    return {
      appid: g.appid,
      name: g.name,
      playtime_forever: g.playtime_forever || 0,
      has_community_visible_stats: g.has_community_visible_stats || false,
      img_icon_url: g.img_icon_url || '',
      completed: completion?.completed || false,
      completedAt: completion?.completedAt || null,
      manualCompletion: completion?.manual || false,
      achievements
    };
  });
}

// ============ EXPRESS APP ============
const app = express();
app.use(express.json());

// Permissive CORS for local network use
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/sounds', express.static(path.join(__dirname, 'data/sounds')));

// ----- State -----
app.get('/api/state', (req, res) => {
  res.json({
    games: buildGameList(),
    libraryFetchedAt: state.libraryCache?.fetchedAt || null,
    scanState,
    steamConfigured: !!(STEAM_API_KEY && STEAM_ID)
  });
});

// ----- Sync library -----
app.post('/api/sync', async (req, res) => {
  if (!STEAM_API_KEY || !STEAM_ID) {
    return res.status(500).json({ ok: false, error: 'STEAM_API_KEY and STEAM_ID not configured' });
  }
  try {
    const games = await fetchLibrary();
    state.libraryCache = { fetchedAt: Date.now(), games };
    saveState();
    console.log(`[sync] library synced: ${games.length} games`);
    res.json({ ok: true, count: games.length });
  } catch (e) {
    console.error('[sync] failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----- Mark/unmark completion -----
app.post('/api/complete', (req, res) => {
  const { appid, completed } = req.body || {};
  if (!appid) return res.status(400).json({ ok: false, error: 'appid required' });

  if (completed) {
    state.completions[appid] = {
      completed: true,
      completedAt: state.completions[appid]?.completedAt || Date.now(),
      manual: true
    };
  } else {
    delete state.completions[appid];
  }

  saveState();
  res.json({ ok: true });
});

// ----- Achievement scan -----
app.post('/api/scan-achievements', (req, res) => {
  if (scanState.running) return res.json({ ok: false, error: 'Scan already running' });
  if (!state.libraryCache) return res.status(400).json({ ok: false, error: 'Sync your library first' });
  runAchievementScan(); // fire and forget
  res.json({ ok: true });
});

app.post('/api/scan-stop', (req, res) => {
  scanState.running = false;
  res.json({ ok: true });
});

app.get('/api/scan-progress', (req, res) => {
  res.json(scanState);
});

// ----- Random picker -----
app.get('/api/random', (req, res) => {
  const { status, minPlaytime, maxPlaytime, hasAchievements } = req.query;
  let games = buildGameList();

  // Status filter
  if (status === 'not_started') {
    games = games.filter(g => g.playtime_forever === 0 && !g.completed);
  } else if (status === 'in_progress') {
    games = games.filter(g => g.playtime_forever > 0 && !g.completed);
  } else {
    // default: any uncompleted
    games = games.filter(g => !g.completed);
  }

  // Playtime filters (query is in hours, stored in minutes)
  if (minPlaytime) games = games.filter(g => g.playtime_forever >= parseFloat(minPlaytime) * 60);
  if (maxPlaytime) games = games.filter(g => g.playtime_forever <= parseFloat(maxPlaytime) * 60);

  // Achievement filter
  if (hasAchievements === 'yes') games = games.filter(g => g.has_community_visible_stats);
  if (hasAchievements === 'no') games = games.filter(g => !g.has_community_visible_stats);

  if (games.length === 0) return res.json({ ok: true, game: null, totalEligible: 0 });

  const game = games[Math.floor(Math.random() * games.length)];
  res.json({ ok: true, game, totalEligible: games.length });
});

// ============ STARTUP ============
loadState();

const HTTP_PORT = parseInt(process.env.PORT || '3001', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3444', 10);
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

http.createServer(app).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[steam] HTTP listening on http://0.0.0.0:${HTTP_PORT}`);
});

if (TLS_CERT && TLS_KEY) {
  try {
    const credentials = {
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY)
    };
    https.createServer(credentials, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[steam] HTTPS listening on https://0.0.0.0:${HTTPS_PORT}`);
    });
  } catch (e) {
    console.error('[steam] HTTPS failed to start:', e.message);
  }
} else {
  console.log('[steam] HTTPS not configured (set TLS_CERT and TLS_KEY env vars)');
}

console.log(`[steam] state file: ${STATE_FILE}`);
if (!STEAM_API_KEY || !STEAM_ID) {
  console.warn('[steam] WARNING: STEAM_API_KEY or STEAM_ID not set — sync will fail');
}
