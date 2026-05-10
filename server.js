// Delta Strike multiplayer server.
// Authoritative for: hits, kills, scores, respawn timing.
// Trusts client position (no anti-cheat — hobby project).

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// --- tiny static file server so you can open http://localhost:8080/ and load the client ---
const httpServer = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/' || url === '') url = '/client.html';
  const filePath = path.join(__dirname, url);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const ct = ext === '.html' ? 'text/html; charset=utf-8'
             : ext === '.js'   ? 'application/javascript'
             : ext === '.css'  ? 'text/css'
             : ext === '.json' ? 'application/json'
             : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

const SPAWN_POINTS = [
  [  0, 0,  25], [ 25, 0,   0], [  0, 0, -25], [-25, 0,   0],
  [ 18, 0,  18], [-18, 0,  18], [ 18, 0, -18], [-18, 0, -18],
  [ 45, 0,   0], [-45, 0,   0], [  0, 0,  45], [  0, 0, -45],
];
const PLAYER_COLORS = [
  0xff6cf3, 0xffd84a, 0x00e6ff, 0xff8a3d,
  0x7cffb2, 0xb98cff, 0xff5577, 0x6cd1ff,
];

// world obstacles (must match client) — used to block shots
const OBSTACLES = (() => {
  const list = [];
  const add = (x, y, z, w, h, d) => list.push({
    minX: x - w/2, maxX: x + w/2,
    minY: y,       maxY: y + h,
    minZ: z - d/2, maxZ: z + d/2,
  });
  add(0, 0, 0, 6, 1, 6);
  add(0, 1, 0, 2, 2, 2);
  const buildings = [
    [-30,-30,14,12,16],[ 30,-28,18,10,14],[-28, 32,12,14,12],[ 34, 30,16,12,18],
    [  0,-55,22, 8,10],[  0, 55,22, 8,12],[-60,  0,10,16,22],[ 60,  0,12,18,20],
  ];
  for (const [x,z,w,h,d] of buildings){ add(x,0,z,w,h,d); add(x,h,z, w*0.6, 1, d*0.6); }
  // procedural cover ring is randomized per client; skip for shot-blocking to keep server simple.
  for (let i=0;i<14;i++){
    const a = (i/14)*Math.PI*2;
    add(Math.cos(a)*14, 0, Math.sin(a)*14, 2.4, 1.4, 2.4);
  }
  return list;
})();

function rayHitsObstacleBefore(ox,oy,oz, dx,dy,dz, maxT){
  // axis-aligned slab test for each obstacle, return true if any hit before maxT
  for (const b of OBSTACLES){
    let tmin = -Infinity, tmax = Infinity;
    for (const [o,d,lo,hi] of [
      [ox,dx,b.minX,b.maxX], [oy,dy,b.minY,b.maxY], [oz,dz,b.minZ,b.maxZ]
    ]){
      if (Math.abs(d) < 1e-8){
        if (o < lo || o > hi) { tmin = Infinity; break; }
        continue;
      }
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) break;
    }
    if (tmin <= tmax && tmin > 0.05 && tmin < maxT) return tmin;
  }
  return Infinity;
}

let nextId = 1;
const players = new Map();   // id -> { ws, state, lastShot }

function pickSpawn(){ return SPAWN_POINTS[(Math.random()*SPAWN_POINTS.length)|0]; }

function spawn(p){
  const s = pickSpawn();
  p.state.x = s[0]; p.state.y = s[1]; p.state.z = s[2];
  p.state.hp = 100; p.state.armor = 50; p.state.alive = true;
  p.state.respawnAt = 0;
}

function send(ws, msg){
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg, exceptId){
  const s = JSON.stringify(msg);
  for (const p of players.values()){
    if (exceptId !== undefined && p.state.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(s);
  }
}

wss.on('connection', (ws) => {
  const id = nextId++;
  const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
  const player = {
    ws,
    lastShot: 0,
    state: {
      id, name: 'OP-' + id, color,
      x: 0, y: 0, z: 25, yaw: 0, pitch: 0,
      hp: 100, armor: 50, score: 0, deaths: 0,
      alive: true, crouch: false, sprint: false,
    },
  };
  spawn(player);
  players.set(id, player);

  // tell new player who they are + everyone already here
  send(ws, { type: 'welcome', id, state: player.state });
  for (const other of players.values()){
    if (other === player) continue;
    send(ws, { type: 'join', state: other.state });
  }
  // tell others
  broadcast({ type: 'join', state: player.state }, id);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'state'){
      const s = player.state;
      if (typeof msg.x === 'number') s.x = msg.x;
      if (typeof msg.y === 'number') s.y = msg.y;
      if (typeof msg.z === 'number') s.z = msg.z;
      if (typeof msg.yaw   === 'number') s.yaw   = msg.yaw;
      if (typeof msg.pitch === 'number') s.pitch = msg.pitch;
      s.crouch = !!msg.crouch;
      s.sprint = !!msg.sprint;
      if (typeof msg.name === 'string'){
        const n = msg.name.replace(/[^\x20-\x7e]/g,'').slice(0,16).trim();
        if (n) s.name = n;
      }
      return;
    }

    if (msg.type === 'shot'){
      const now = Date.now();
      if (!player.state.alive) return;
      // rate limit ~ 11/s server-side
      if (now - player.lastShot < 80) return;
      player.lastShot = now;

      const ox = +msg.ox, oy = +msg.oy, oz = +msg.oz;
      let dx = +msg.dx, dy = +msg.dy, dz = +msg.dz;
      const dl = Math.hypot(dx,dy,dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;

      const obstacleT = rayHitsObstacleBefore(ox,oy,oz, dx,dy,dz, 200);

      // hit the closest player whose hitsphere is intersected and closer than obstacle
      let bestT = Math.min(obstacleT, 200);
      let victim = null, isHead = false;
      const HITS = [
        { dy: 1.00, r: 0.55, head: false },
        { dy: 1.85, r: 0.32, head: true  },
      ];
      for (const other of players.values()){
        if (other === player) continue;
        if (!other.state.alive) continue;
        for (const h of HITS){
          const cx = other.state.x;
          const cy = other.state.y + h.dy;
          const cz = other.state.z;
          // ray-sphere
          const mx = ox - cx, my = oy - cy, mz = oz - cz;
          const b = mx*dx + my*dy + mz*dz;
          const c = mx*mx + my*my + mz*mz - h.r*h.r;
          if (c > 0 && b > 0) continue;
          const disc = b*b - c;
          if (disc < 0) continue;
          const t = -b - Math.sqrt(disc);
          if (t > 0.05 && t < bestT){
            bestT = t; victim = other; isHead = h.head;
          }
        }
      }

      const shotMsg = {
        type: 'shot', shooter: player.state.id,
        ox, oy, oz, dx, dy, dz,
        dist: bestT,
      };
      broadcast(shotMsg);

      if (victim){
        const dmg = isHead ? 65 : 28;
        const v = victim.state;
        const armorTake = Math.min(v.armor, dmg * 0.6);
        v.armor -= armorTake;
        v.hp    -= (dmg - armorTake);

        if (v.hp <= 0){
          v.hp = 0; v.alive = false; v.deaths += 1;
          player.state.score += 100;
          broadcast({ type: 'kill', killer: player.state.id, victim: v.id, head: isHead });
          // schedule respawn
          v.respawnAt = Date.now() + 3000;
          setTimeout(() => {
            if (!players.has(v.id)) return;
            spawn(victim);
            broadcast({ type: 'respawn', id: v.id, state: victim.state });
          }, 3000);
        } else {
          // private update so victim's HUD jolts immediately
          send(victim.ws, { type: 'damaged', from: player.state.id, hp: v.hp, armor: v.armor, head: isHead });
        }
      }
      return;
    }

    if (msg.type === 'chat'){
      const text = String(msg.text || '').slice(0, 140);
      if (!text.trim()) return;
      broadcast({ type: 'chat', from: player.state.id, name: player.state.name, text });
      return;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'leave', id });
  });
});

// 20Hz snapshot
setInterval(() => {
  const list = [];
  for (const p of players.values()){
    const s = p.state;
    list.push({
      id: s.id, name: s.name, color: s.color,
      x: s.x, y: s.y, z: s.z,
      yaw: s.yaw, pitch: s.pitch,
      hp: s.hp, armor: s.armor, score: s.score, deaths: s.deaths,
      alive: s.alive, crouch: s.crouch, sprint: s.sprint,
    });
  }
  broadcast({ type: 'snapshot', t: Date.now(), players: list });
}, 50);

httpServer.listen(PORT, () => {
  console.log(`Delta Strike MP listening on http://localhost:${PORT}/  (ws on same port)`);
  console.log(`Open http://localhost:${PORT}/  in two browser windows to test.`);
});
