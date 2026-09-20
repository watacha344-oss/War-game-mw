// 師団規模ウォーゲーム 本体（マップ・部隊・戦闘・補給・AI・描画・操作をこの1ファイルにまとめています）
import { MAP, riverX, BALANCE, AI, SCENARIO, UI } from './config.js';
const B = BALANCE;

// ================= map.js =================
// 地形生成・道路網・経路探索（A*）。DOMには依存しません。

// 0=平地 1=森林 2=丘陵 3=河川 4=橋
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed, scale) {
  const r = rng(seed);
  const gw = Math.ceil(MAP.width / scale) + 2, gh = Math.ceil(MAP.height / scale) + 2;
  const g = Array.from({ length: gw * gh }, () => r());
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x / scale, fy = y / scale, ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = sm(fx - ix), ty = sm(fy - iy);
    const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
}

function buildMap() {
  const cell = MAP.cell, W = Math.ceil(MAP.width / cell), H = Math.ceil(MAP.height / cell);
  const terr = new Uint8Array(W * H), road = new Uint8Array(W * H);
  const nf = makeNoise(MAP.seed, MAP.forestScale), nh = makeNoise(MAP.seed + 7, MAP.hillScale);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      let t = 0;
      if (nh(x, y) > MAP.hillThreshold) t = 2;
      else if (nf(x, y) > MAP.forestThreshold) t = 1;
      if (Math.abs(x - riverX(y)) < MAP.river.halfWidth) t = 3;
      else for (const z of MAP.zones) if (Math.hypot(x - z.x, y - z.y) < z.r) t = z.t;
      terr[j * W + i] = t;
    }
  }
  const nodes = {}, adj = {};
  for (const [k, [x, y]] of Object.entries(MAP.nodes)) { nodes[k] = { name: k, x, y }; adj[k] = []; }
  for (const [a, b] of MAP.edges) {
    adj[a].push(b); adj[b].push(a);
    const A = nodes[a], Bn = nodes[b], len = Math.hypot(Bn.x - A.x, Bn.y - A.y);
    for (let d = 0; d <= len; d += 15) {
      const x = A.x + (Bn.x - A.x) * d / len, y = A.y + (Bn.y - A.y) * d / len;
      const i = Math.floor(x / cell), j = Math.floor(y / cell);
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      road[j * W + i] = 1;
      // 道路が河川にかかる場所とその隣接セルを橋にする
      for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        if (terr[jj * W + ii] === 3) terr[jj * W + ii] = 4;
      }
    }
  }
  return { W, H, cell, terr, road, nodes, adj, nodeList: Object.values(nodes), edges: MAP.edges, noise: { nf, nh } };
}

function cellIndex(map, x, y) {
  const i = Math.min(map.W - 1, Math.max(0, Math.floor(x / map.cell)));
  const j = Math.min(map.H - 1, Math.max(0, Math.floor(y / map.cell)));
  return j * map.W + i;
}

function terrainAt(map, x, y) { return map.terr[cellIndex(map, x, y)]; }

function speedMult(map, def, x, y) {
  const k = cellIndex(map, x, y);
  return map.road[k] ? def.roadBonus : def.terrain[map.terr[k]];
}

function nearestNode(map, x, y) {
  let best = null, bd = Infinity;
  for (const n of map.nodeList) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) { bd = d; best = n; }
  }
  return { node: best, dist: bd };
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// 始点から終点までの通過点（セル中心）の配列を返す。到達不能なら空配列
function findPath(map, def, sx, sy, tx, ty) {
  const { W, H, cell } = map, N = W * H;
  const mult = (k) => (map.road[k] ? def.roadBonus : def.terrain[map.terr[k]]);
  const s = cellIndex(map, sx, sy);
  let g = cellIndex(map, tx, ty);
  if (mult(g) <= 0) {
    let best = -1, bd = 1e9;
    const gi = g % W, gj = Math.floor(g / W);
    for (let r = 1; r < 8 && best < 0; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const i = gi + di, j = gj + dj;
          if (i < 0 || j < 0 || i >= W || j >= H) continue;
          const k = j * W + i;
          if (mult(k) > 0 && di * di + dj * dj < bd) { bd = di * di + dj * dj; best = k; }
        }
      }
    }
    if (best < 0) return [];
    g = best;
  }
  if (s === g) return [{ x: tx, y: ty }];

  const gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const hmin = 1 / Math.max(def.roadBonus, 1);
  const gi = g % W, gj = Math.floor(g / W);
  const h = (k) => {
    const dx = Math.abs((k % W) - gi), dy = Math.abs(Math.floor(k / W) - gj);
    return (Math.max(dx, dy) + 0.414 * Math.min(dx, dy)) * hmin;
  };
  const heap = [];
  const push = (f, k) => {
    heap.push([f, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  gs[s] = 0; push(h(s), s);
  while (heap.length) {
    const k = pop()[1];
    if (done[k]) continue;
    done[k] = 1;
    if (k === g) break;
    const ki = k % W, kj = Math.floor(k / W);
    for (const [dx, dy] of DIRS) {
      const i = ki + dx, j = kj + dy;
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const n = j * W + i, m = mult(n);
      if (m <= 0) continue;
      if (dx && dy && (mult(kj * W + i) <= 0 || mult(j * W + ki) <= 0)) continue;
      const ng = gs[k] + (dx && dy ? 1.414 : 1) / m;
      if (ng < gs[n]) { gs[n] = ng; from[n] = k; push(ng + h(n), n); }
    }
  }
  if (from[g] < 0) return [];
  const pts = [];
  for (let k = g; k !== s && k >= 0; k = from[k]) {
    pts.push({ x: (k % W + 0.5) * cell, y: (Math.floor(k / W) + 0.5) * cell });
  }
  pts.reverse();
  if (cellIndex(map, tx, ty) === g) pts[pts.length - 1] = { x: tx, y: ty };
  return pts;
}

// ================= units.js =================
// 部隊の生成・命令・移動・ログ。DOMには依存しません。

const MODE_LABEL = { advance: '進軍', attack: '攻撃', defend: '防御', hold: '待機' };

// 兵力・車両数・補給率（画面表示用）
function menOf(u) { return Math.round(B.units[u.type].men * Math.max(0, u.hp) / 100); }
function vehOf(u) { return Math.round(B.units[u.type].veh * Math.max(0, u.hp) / 100); }
function supplyPct(u) {
  const d = B.units[u.type];
  const src = u.stock ? u.stock : u;
  const mx = u.stock ? B.supply.stockMax : { fuel: d.maxFuel, ammo: d.maxAmmo, food: d.maxFood };
  let sum = 0, n = 0;
  for (const r of ['fuel', 'ammo', 'food']) {
    if (mx[r] > 0) { sum += Math.max(0, Math.min(1, src[r] / mx[r])); n++; }
  }
  return n ? Math.round(sum / n * 100) : 0;
}


function addLog(s, kind, text) {
  s.log.push({ t: s.time, kind, text });
  if (s.log.length > B.log.max) s.log.shift();
}

function makeUnit(s, side, type, x, y, opts = {}) {
  const d = B.units[type], r = opts.supply ?? 1;
  const key = side + type;
  s.counts[key] = (s.counts[key] || 0) + 1;
  const u = {
    id: 'u' + (s.nextId++), side, type,
    name: (side === 'ally' ? '第' : '独軍第') + s.counts[key] + d.name,
    x, y, hp: opts.hp ?? 100,
    fuel: d.maxFuel * r, ammo: d.maxAmmo * r, food: d.maxFood * r,
    mode: 'hold', legs: [], entr: false, moving: false, engaged: false, target: null,
    role: opts.role || null, post: opts.post || null,
    use: { fuel: 0, ammo: 0, food: 0 }, low: {}, replan: 0,
  };
  if (type === 'supply') {
    u.stock = { fuel: B.supply.stockMax.fuel * r, ammo: B.supply.stockMax.ammo * r, food: B.supply.stockMax.food * r };
    u.linked = true;
  }
  if (opts.role) { u.mode = 'defend'; u.entr = true; }
  s.units.push(u);
  s.menTotal[side] += d.men * u.hp / 100;
  return u;
}

// mode: advance / attack / defend / hold。pts は目的地の配列（複数なら経由地）
function setOrder(s, u, mode, pts, append = false) {
  if (mode === 'hold') { u.mode = 'hold'; u.legs = []; u.entr = false; return; }
  const d = B.units[u.type];
  if (!append) u.legs = [];
  u.mode = mode; u.entr = false;
  for (const p of pts) {
    const last = u.legs[u.legs.length - 1] || u;
    u.legs.push({ x: p.x, y: p.y, path: findPath(s.map, d, last.x, last.y, p.x, p.y) });
  }
}

function moveUnit(s, u, dt) {
  const d = B.units[u.type];
  const eat = d.foodUse * dt;
  u.food = Math.max(0, u.food - eat); u.use.food += eat;
  u.moving = false;
  const leg = u.legs[0];
  if (!leg) { if (u.mode === 'defend') u.entr = true; return; }
  if (u.mode === 'attack' && u.engaged) return;           // 攻撃命令：交戦中は足を止める
  u.stalled = d.fuelUse > 0 && u.fuel <= 0;
  if (u.stalled) return;                                  // 燃料切れ
  const p = leg.path[0];
  if (!p) { u.legs.shift(); return; }
  let m = speedMult(s.map, d, u.x, u.y);
  if (m <= 0) m = 0.3;
  const sp = d.speed * m * (u.food <= 0 ? B.noFoodSpeed : 1) * dt;
  const dx = p.x - u.x, dy = p.y - u.y, dist = Math.hypot(dx, dy);
  if (sp >= dist) { u.x = p.x; u.y = p.y; leg.path.shift(); }
  else { u.x += dx / dist * sp; u.y += dy / dist * sp; }
  u.moving = true;
  if (d.fuelUse > 0) {
    const f = d.fuelUse * dt;
    u.fuel = Math.max(0, u.fuel - f); u.use.fuel += f;
  }
}

// ================= fog.js =================
// 戦場の霧：味方の視界内（偵察含む）にいる敵だけが見える。

function computeVisibility(s) {
  const vis = { ally: new Set(), axis: new Set() };
  for (const a of s.units) {
    const r = B.units[a.type].vision;
    for (const e of s.units) {
      if (e.side === a.side) continue;
      const f = terrainAt(s.map, e.x, e.y) === 1 ? B.forestVisionFactor : 1;
      if (Math.hypot(e.x - a.x, e.y - a.y) <= r * f) vis[a.side].add(e.id);
    }
  }
  s.vis = vis;
}

function isVisible(s, side, u) {
  return u.side === side || s.vis[side].has(u.id);
}

// ================= combat.js =================
// 自動戦闘解決と詳細な戦闘ログ。

function reap(s) {
  const dead = s.units.filter((u) => u.hp <= 0);
  if (!dead.length) return;
  for (const u of dead) {
    addLog(s, 'kill', `☠ ${u.name} 壊滅`);
    s.stats.lost[u.side]++;
    s.fx.push({ kind: 'boom', x: u.x, y: u.y, t: s.time, r: 40 });
  }
  s.units = s.units.filter((u) => u.hp > 0);
}

function resolveCombat(s, dt) {
  reap(s);
  const units = s.units;
  for (const a of units) { a.engaged = false; a.target = null; }
  for (const a of units) {
    const d = B.units[a.type];
    let best = null, bd = Infinity;
    for (const e of units) {
      if (e.side === a.side) continue;
      const dist = Math.hypot(e.x - a.x, e.y - a.y);
      if (dist <= d.range && dist < bd && isVisible(s, a.side, e)) { best = e; bd = dist; }
    }
    if (!best) continue;
    a.engaged = true; a.target = best.id;
    const ammoF = a.ammo > 0 ? 1 : d.noAmmo;
    const foodF = a.food > 0 ? 1 : B.noFoodFactor;
    const moveF = a.moving ? (d.moveAttack ?? B.moveAttackFactor) : 1;
    const defF = B.terrainDefense[terrainAt(s.map, best.x, best.y)] * (best.entr ? B.defendBonus : 1);
    const mod = B.typeMod[a.type]?.[best.type] ?? 1;
    const dmg = d.attack * (a.hp / 100) * mod * ammoF * foodF * moveF * defF * dt;
    best.pending = (best.pending || 0) + dmg;
    if (a.ammo > 0) {
      const used = Math.min(a.ammo, d.ammoUse * dt);
      a.ammo -= used; a.use.ammo += used;
    }
    const key = a.id + '>' + best.id;
    const r = s.rec[key] || (s.rec[key] = { a: a.id, e: best.id, an: a.name, en: best.name, side: a.side, dmg: 0 });
    r.dmg += dmg;
  }
  for (const u of units) if (u.pending) { u.hp -= u.pending; u.pending = 0; }
  reap(s);
}

// 一定間隔で戦闘・補給の集計をログに書き出す
function flushRecords(s) {
  if (s.time - s.lastFlush < B.log.interval) return;
  s.lastFlush = s.time;
  const byId = new Map(s.units.map((u) => [u.id, u]));
  const n0 = (v) => Math.round(v);
  for (const r of Object.values(s.rec)) {
    if (r.dmg < 0.05) continue;
    const a = byId.get(r.a), e = byId.get(r.e);
    const rest = e ? `相手残 ${Math.max(0, n0(e.hp))}%` : '撃破';
    const cost = a
      ? `／消費 燃${a.use.fuel.toFixed(1)} 弾${a.use.ammo.toFixed(1)} 食${a.use.food.toFixed(1)}（残 燃${n0(a.fuel)} 弾${n0(a.ammo)} 食${n0(a.food)}）`
      : '';
    addLog(s, r.side === 'ally' ? 'atkA' : 'atkE', `⚔ ${r.an}→${r.en} 与被害 ${r.dmg.toFixed(1)}（${rest}）${cost}`);
  }
  for (const r of Object.values(s.supRec)) {
    if (r.fuel + r.ammo + r.food < 2) continue;
    addLog(s, r.side === 'ally' ? 'supply' : 'supplyE',
      `🚚 ${r.sn}→${r.un} 補給 燃+${r.fuel.toFixed(1)} 弾+${r.ammo.toFixed(1)} 食+${r.food.toFixed(1)}`);
  }
  s.rec = {}; s.supRec = {};
  for (const u of s.units) u.use = { fuel: 0, ammo: 0, food: 0 };
}

// ================= supply.js =================
// 補給：燃料・弾薬・食料を別々に管理。道路で補給集積所とつながった補給部隊だけが在庫を回復できる。

const RES = ['fuel', 'ammo', 'food'];
const CAP = { fuel: 'maxFuel', ammo: 'maxAmmo', food: 'maxFood' };
const LBL = { fuel: '燃料', ammo: '弾薬', food: '食料' };

function updateSupply(s, dt) {
  const S = B.supply;
  for (const side of ['ally', 'axis']) {
    const sd = s.sides[side], foe = side === 'ally' ? 'axis' : 'ally';
    const mine = s.units.filter((u) => u.side === side), theirs = s.units.filter((u) => u.side === foe);

    // 敵だけがいる道路ノードは遮断される
    const cut = new Set();
    for (const n of s.map.nodeList) {
      const near = (list) => list.some((u) => Math.hypot(u.x - n.x, u.y - n.y) <= S.cutRadius);
      if (near(theirs) && !near(mine)) cut.add(n.name);
    }
    // 集積所から遮断されていない道路をたどって到達できる範囲
    const reach = new Set();
    if (!cut.has(sd.node)) {
      const q = [sd.node]; reach.add(sd.node);
      while (q.length) {
        const k = q.pop();
        for (const m of s.map.adj[k]) if (!reach.has(m) && !cut.has(m)) { reach.add(m); q.push(m); }
      }
    }
    sd.cut = cut; sd.reach = reach;

    const sources = [{ name: '補給集積所', x: sd.x, y: sd.y, r: S.depotRadius, stock: null }];
    for (const su of mine) {
      if (su.type !== 'supply') continue;
      const nn = nearestNode(s.map, su.x, su.y);
      const linked = nn.dist <= S.linkRadius && reach.has(nn.node.name);
      if (side === 'ally' && linked !== su.linked) {
        addLog(s, 'warn', linked ? `🔗 ${su.name} 補給線が回復` : `✂ ${su.name} 補給線が遮断された`);
      }
      su.linked = linked;
      if (linked) for (const r of RES) su.stock[r] = Math.min(S.stockMax[r], su.stock[r] + S.refill[r] * dt);
      sources.push({ name: su.name, x: su.x, y: su.y, r: S.radius, stock: su.stock });
    }

    for (const u of mine) {
      const d = B.units[u.type];
      for (const src of sources) {
        if (src.name === u.name) continue;
        if (src.stock && u.type === 'supply') continue;
        if (Math.hypot(u.x - src.x, u.y - src.y) > src.r) continue;
        for (const r of RES) {
          const need = d[CAP[r]] - u[r];
          if (need <= 0) continue;
          const give = Math.min(need, S.transfer[r] * dt, src.stock ? src.stock[r] : Infinity);
          if (give <= 0) continue;
          u[r] += give;
          if (src.stock) src.stock[r] -= give;
          const key = src.name + '>' + u.name;
          const rec = s.supRec[key] || (s.supRec[key] = { sn: src.name, un: u.name, fuel: 0, ammo: 0, food: 0, side });
          rec[r] += give;
        }
      }
    }
  }
}

// 味方部隊の物資が少なくなったら警告ログを出す
function checkLow(s) {
  for (const u of s.units) {
    if (u.side !== 'ally') continue;
    const d = B.units[u.type];
    for (const r of RES) {
      const cap = d[CAP[r]];
      if (!cap) continue;
      const v = u[r];
      if (v <= 0 && u.low[r] !== 2) { u.low[r] = 2; addLog(s, 'warn', `⚠ ${u.name} ${LBL[r]}切れ`); }
      else if (v > 0 && v < cap * B.supply.lowLevel && !u.low[r]) {
        u.low[r] = 1; addLog(s, 'warn', `⚠ ${u.name} ${LBL[r]}残少（${Math.round(v)}）`);
      } else if (v >= cap * 0.5) u.low[r] = 0;
    }
  }
}

// ================= support.js =================
// 航空支援・空挺：地点を指定して命令。使用回数とクールダウン制。

function initSupport() {
  return {
    air: { uses: B.support.air.uses, cd: 0 },
    para: { uses: B.support.para.uses, cd: 0 },
  };
}

// 成功なら null、失敗ならメッセージ文字列を返す
function requestSupport(s, kind, x, y) {
  const st = s.support[kind], c = B.support[kind];
  if (st.uses <= 0) return '使用回数がありません';
  if (st.cd > 0) return `再使用まで ${Math.ceil(st.cd)} 秒`;
  if (kind === 'para' && terrainAt(s.map, x, y) === 3) return '河川には降下できません';
  st.uses--; st.cd = c.cooldown;
  s.pending.push({ kind, x, y, at: s.time + c.delay });
  addLog(s, 'support', kind === 'air'
    ? `✈ 航空支援を要請（${c.delay}秒後に到達）` : `🪂 空挺降下を要請（${c.delay}秒後に降下）`);
  return null;
}

function updateSupport(s, dt) {
  for (const k of ['air', 'para']) s.support[k].cd = Math.max(0, s.support[k].cd - dt);
  const due = s.pending.filter((p) => p.at <= s.time);
  if (!due.length) return;
  s.pending = s.pending.filter((p) => p.at > s.time);
  for (const p of due) {
    const c = B.support[p.kind];
    if (p.kind === 'air') {
      let hit = 0;
      for (const e of s.units) {
        if (e.side !== 'axis' || Math.hypot(e.x - p.x, e.y - p.y) > c.radius) continue;
        const dmg = c.damage * B.terrainDefense[terrainAt(s.map, e.x, e.y)];
        e.hp -= dmg; hit++;
        addLog(s, 'support', `✈ 爆撃：${e.name} 被害 ${dmg.toFixed(1)}（残 ${Math.max(0, Math.round(e.hp))}%）`);
      }
      if (!hit) addLog(s, 'support', '✈ 爆撃：目標地点に敵影なし');
      s.fx.push({ kind: 'boom', x: p.x, y: p.y, t: s.time, r: c.radius });
    } else {
      const u = makeUnit(s, 'ally', 'para', p.x, p.y, { hp: c.strength, supply: c.supplyRatio });
      addLog(s, 'support', `🪂 ${u.name} が降下完了（兵力${c.strength}%）`);
      s.fx.push({ kind: 'boom', x: p.x, y: p.y, t: s.time, r: 50 });
    }
  }
}

// ================= ai.js =================
// ドイツ軍AI：持ち場を守り、予備隊が脅威へ反撃、襲撃部隊が補給部隊を狙う。

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function updateAI(s, dt) {
  s.ai.timer -= dt;
  if (s.ai.timer > 0) return;
  s.ai.timer = AI.thinkInterval;
  const foes = s.units.filter((u) => u.side === 'ally' && s.vis.axis.has(u.id));
  const obj = s.objective;
  const prio = (t) => { const i = AI.priority.indexOf(t); return i < 0 ? AI.priority.length : i; };
  const pick = (list, u) => {
    let best = null, bs = Infinity;
    for (const f of list) {
      const sc = dist(f, u) + prio(f.type) * AI.priorityWeight;
      if (sc < bs) { bs = sc; best = f; }
    }
    return best;
  };
  const objLost = s.cap.held || s.cap.progress >= AI.alarmProgress;

  for (const u of s.units) {
    if (u.side !== 'axis' || !u.role) continue;
    u.replan = Math.max(0, u.replan - AI.thinkInterval);
    const home = u.post || obj;
    let target = null;
    if (objLost && u.role !== 'raider' && u.type !== 'arty' && u.type !== 'supply' && dist(u, obj) <= AI.counterRadius) {
      target = { x: obj.x, y: obj.y };
    } else if (u.role === 'reserve') {
      target = pick(foes.filter((f) => dist(f, obj) <= AI.alertRadius * (0.5 + AI.aggression)), u);
    } else if (u.role === 'raider') {
      target = pick(foes.filter((f) => f.type === 'supply' && dist(f, u) <= AI.raidRadius), u);
    }
    if (target) {
      if (u.replan <= 0 || !u.legs.length) {
        setOrder(s, u, 'attack', [{ x: target.x, y: target.y }]);
        u.replan = AI.replanInterval;
      }
    } else if (u.type !== 'arty' && u.type !== 'supply' && dist(u, home) > AI.returnRadius && !(u.mode === 'defend' && u.legs.length)) {
      setOrder(s, u, 'defend', [{ x: home.x, y: home.y }]);
    }
  }
}

// ================= game.js =================
// ゲーム状態の生成・1ステップの進行・勝敗判定。DOMには依存しません。

function newGame() {
  const map = buildMap(), N = map.nodes;
  const depot = (side) => ({ node: MAP.depots[side], x: N[MAP.depots[side]].x, y: N[MAP.depots[side]].y, cut: new Set(), reach: new Set() });
  const s = {
    map, time: 0, units: [], nextId: 1, counts: {}, log: [], rec: {}, supRec: {}, lastFlush: 0,
    fx: [], pending: [], result: null, stats: { lost: { ally: 0, axis: 0 } },
    menTotal: { ally: 0, axis: 0 }, hist: [], intel: {}, lastHist: -999,
    cap: { progress: 0, held: false, hold: 0 }, ai: { timer: 0 }, support: initSupport(),
    objective: { x: N[MAP.objective.node].x, y: N[MAP.objective.node].y, radius: MAP.objective.radius, name: MAP.objective.name },
    sides: { ally: depot('ally'), axis: depot('axis') },
    vis: { ally: new Set(), axis: new Set() },
  };
  for (const u of SCENARIO.ally) makeUnit(s, 'ally', u.type, u.x, u.y);
  for (const u of SCENARIO.axis) makeUnit(s, 'axis', u.type, u.x, u.y, { role: u.role, post: { x: u.x, y: u.y } });
  computeVisibility(s);
  updateIntel(s);
  sampleHist(s);
  addLog(s, 'info', `作戦開始：${SCENARIO.title}`);
  return s;
}

function restoreGame(d) {
  const s = newGame();
  Object.assign(s, {
    time: d.time, units: d.units, nextId: d.nextId, counts: d.counts, cap: d.cap,
    support: d.support, pending: d.pending, ai: d.ai, stats: d.stats, log: d.log, lastFlush: d.time,
    hist: d.hist || [], intel: d.intel || {}, lastHist: d.time,
  });
  s.menTotal = d.menTotal || { ally: sideMen(s, 'ally'), axis: sideMen(s, 'axis') };
  computeVisibility(s);
  addLog(s, 'info', '保存データから作戦を再開');
  return s;
}


// 発見した敵の「最後の確認位置」を記録する
function updateIntel(s) {
  const alive = new Set();
  for (const u of s.units) {
    if (u.side !== 'axis') continue;
    alive.add(u.id);
    if (s.vis.ally.has(u.id)) s.intel[u.id] = { id: u.id, name: u.name, type: u.type, x: u.x, y: u.y, hp: u.hp, t: s.time };
  }
  for (const id of Object.keys(s.intel)) if (!alive.has(id)) delete s.intel[id];
}

function sideMen(s, side) {
  let m = 0;
  for (const u of s.units) if (u.side === side) m += menOf(u);
  return m;
}

// 損害・補給グラフ用の履歴（一定間隔で記録）
function sampleHist(s) {
  if (s.time - s.lastHist < UI.historyInterval) return;
  s.lastHist = s.time;
  const al = s.units.filter((u) => u.side === 'ally');
  const sup = al.length ? al.reduce((a, u) => a + supplyPct(u), 0) / al.length : 0;
  s.hist.push({
    t: Math.round(s.time * 10) / 10,
    ca: Math.round(s.menTotal.ally - sideMen(s, 'ally')),
    cx: Math.round(s.menTotal.axis - sideMen(s, 'axis')),
    sup: Math.round(sup),
  });
  if (s.hist.length > UI.historyMax) s.hist.shift();
}

// 航空優勢（青の割合%）
function airSuperiority(s) {
  const a = UI.air;
  const v = a.base + a.perUseLeft * s.support.air.uses + a.perKillDiff * (s.stats.lost.axis - s.stats.lost.ally);
  return Math.max(a.min, Math.min(a.max, v));
}

function updateObjective(s, dt) {
  const o = s.objective, c = s.cap;
  const inside = (side) => s.units.some((u) => u.side === side && Math.hypot(u.x - o.x, u.y - o.y) <= o.radius);
  const a = inside('ally'), e = inside('axis');
  if (a && !e) {
    if (!c.held) {
      c.progress += dt;
      if (c.progress >= B.captureTime) { c.held = true; c.hold = 0; addLog(s, 'info', `🚩 ${o.name} を占領！ ${B.holdTime}秒間確保せよ`); }
    } else c.hold += dt;
  } else if (e && !a) {
    if (c.held) { c.held = false; c.hold = 0; addLog(s, 'warn', `⚠ ${o.name} を奪還された`); }
    c.progress = Math.max(0, c.progress - dt);
  } else if (!a && !e && c.held) {
    c.hold += dt; // 誰もいなければ占領状態を維持
  }
}

function checkEnd(s) {
  if (s.cap.held && s.cap.hold >= B.holdTime) s.result = 'win';
  else if (!s.units.some((u) => u.side === 'ally')) s.result = 'lose';
  else if (s.time >= B.timeLimit) s.result = 'lose';
  if (s.result) addLog(s, 'info', s.result === 'win' ? '🎖 作戦成功' : '作戦失敗');
}

function stepGame(s, dt) {
  if (s.result) return;
  s.time += dt;
  computeVisibility(s);
  updateAI(s, dt);
  for (const u of s.units) moveUnit(s, u, dt);
  updateSupply(s, dt);
  resolveCombat(s, dt);
  updateSupport(s, dt);
  updateObjective(s, dt);
  s.fx = s.fx.filter((f) => s.time - f.t < 1.6);
  checkLow(s);
  updateIntel(s);
  sampleHist(s);
  flushRecords(s);
  checkEnd(s);
}

// ================= save.js =================
// 自動保存（localStorage）と再開。

function saveGame(s) {
  try {
    const data = {
      v: 1, savedAt: Date.now(),
      time: s.time, units: s.units, nextId: s.nextId, counts: s.counts,
      cap: s.cap, support: s.support, pending: s.pending, ai: s.ai,
      stats: s.stats, log: s.log.slice(-60), menTotal: s.menTotal, hist: s.hist, intel: s.intel,
    };
    localStorage.setItem(B.save.key, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(B.save.key);
    const d = raw ? JSON.parse(raw) : null;
    return d && d.v === 1 ? d : null;
  } catch (e) {
    return null;
  }
}

function hasSave() { return loadSave() !== null; }

function clearSave() {
  try { localStorage.removeItem(B.save.key); } catch (e) { /* 何もしない */ }
}

// ================= render.js =================
// Canvas描画：衛星写真風の地形・道路・フェーズライン・NATO記号・矢印・戦場の霧・ミニマップ。
const cam = { x: 0, y: 0, z: 0.5, w: 800, h: 400 };
const CACHE_SCALE = 0.4;
let ctx, cvs, terrainCache, fogCv, fctx, dpr = 1;

// NATO記号の中の兵科図形（-15..15 x -10..10 の枠に収まる SVG パス）
const GLYPH = {
  inf: 'M-15 -10L15 10M15 -10L-15 10',
  tank: 'M-9 0a9 5 0 1 0 18 0a9 5 0 1 0-18 0',
  arty: 'M-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  supply: 'M-10 -4H2V5H-10ZM2 -1H9V5H2Z',
  recon: 'M-15 10L15 -10',
  para: 'M-9 3A9 9 0 0 1 9 3M-9 3L0 9M9 3L0 9',
};
const GLYPH_PATH = {};
const glyphPath = (t) => GLYPH_PATH[t] || (GLYPH_PATH[t] = new Path2D(GLYPH[t]));

function initRender(canvas, state) {
  cvs = canvas;
  ctx = canvas.getContext('2d');
  fogCv = document.createElement('canvas');
  fctx = fogCv.getContext('2d');
  buildTerrain(state.map);
  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cam.w = window.innerWidth; cam.h = window.innerHeight;
  for (const c of [cvs, fogCv]) { c.width = Math.round(cam.w * dpr); c.height = Math.round(cam.h * dpr); }
  cvs.style.width = cam.w + 'px'; cvs.style.height = cam.h + 'px';
  cam.z = Math.max(cam.z, minZoom());
  clampCam();
}

const minZoom = () => Math.min(cam.w / MAP.width, cam.h / MAP.height);

function clampCam() {
  const vw = cam.w / cam.z, vh = cam.h / cam.z;
  cam.x = vw >= MAP.width ? (MAP.width - vw) / 2 : Math.max(0, Math.min(MAP.width - vw, cam.x));
  cam.y = vh >= MAP.height ? (MAP.height - vh) / 2 : Math.max(0, Math.min(MAP.height - vh, cam.y));
}

function zoomAt(sx, sy, factor) {
  const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z;
  cam.z = Math.min(1.6, Math.max(minZoom(), cam.z * factor));
  cam.x = wx - sx / cam.z; cam.y = wy - sy / cam.z;
  clampCam();
}

function centerOn(x, y, z) {
  if (z) cam.z = Math.min(1.6, Math.max(minZoom(), z));
  cam.x = x - cam.w / cam.z / 2; cam.y = y - cam.h / cam.z / 2;
  clampCam();
}

const toWorld = (sx, sy) => ({ x: cam.x + sx / cam.z, y: cam.y + sy / cam.z });
const toScreen = (x, y) => ({ x: (x - cam.x) * cam.z, y: (y - cam.y) * cam.z });

// ---- 衛星写真風の地形（標高の陰影・森・丘・川・道路・集落）を1枚に焼き込む ----
function buildTerrain(map) {
  const K = CACHE_SCALE, w = Math.round(MAP.width * K), h = Math.round(MAP.height * K);
  terrainCache = document.createElement('canvas');
  terrainCache.width = w; terrainCache.height = h;
  const c = terrainCache.getContext('2d');
  const { nf, nh } = map.noise;
  const nfine = makeNoise(MAP.seed + 99, 45), nfld = makeNoise(MAP.seed + 55, 120);   // 森の縁の凹凸・畑の色むら
  const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // 陰影は粗い格子で計算（北西から光が当たる想定）
  const S = 12, gw = Math.ceil(MAP.width / S) + 1, gh = Math.ceil(MAP.height / S) + 1;
  const E = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) E[j * gw + i] = nh(i * S, j * S) + nf(i * S, j * S) * 0.25;
  const SH = new Float32Array(gw * gh);
  for (let j = 1; j < gh - 1; j++) {
    for (let i = 1; i < gw - 1; i++) {
      const ex = (E[j * gw + i + 1] - E[j * gw + i - 1]) / (2 * S), ey = (E[(j + 1) * gw + i] - E[(j - 1) * gw + i]) / (2 * S);
      SH[j * gw + i] = (ex + ey) * 0.5 * 90;
    }
  }

  const img = c.createImageData(w, h), d = img.data;
  const OPEN = [110, 124, 72], OPEN2 = [148, 140, 88], HILL = [122, 106, 74], FOREST = [44, 70, 42], RIVER = [58, 94, 124];
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = px / K, y = py / K;
      const fine = nfine(x, y), fld = sm(0.42, 0.58, nfld(x, y));
      let hill = sm(MAP.hillThreshold - 0.03, MAP.hillThreshold + 0.03, nh(x, y) + (fine - 0.5) * 0.05);
      let forest = sm(MAP.forestThreshold - 0.03, MAP.forestThreshold + 0.03, nf(x, y) + (fine - 0.5) * 0.14) * (1 - hill);
      for (const z of MAP.zones) {
        const k = 1 - sm(z.r - 90, z.r + 30, Math.hypot(x - z.x, y - z.y));
        if (k > 0) { hill = hill * (1 - k) + (z.t === 2 ? k : 0); forest = forest * (1 - k) + (z.t === 1 ? k : 0); }
      }
      const river = 1 - sm(MAP.river.halfWidth - 12, MAP.river.halfWidth + 6, Math.abs(x - riverX(y)));
      const hh = ((px * 374761393 + py * 668265263) >>> 0) & 255;
      const tex = (hh / 255 - 0.5) * 16;
      const gi = Math.min(gh - 1, Math.round(y / S)) * gw + Math.min(gw - 1, Math.round(x / S));
      const shade = 1 + Math.max(-0.35, Math.min(0.35, SH[gi] * (0.5 + hill * 1.2 + forest * 0.4)));
      const o = (py * w + px) * 4;
      for (let k = 0; k < 3; k++) {
        let v = OPEN[k] + (OPEN2[k] - OPEN[k]) * fld;
        v += (HILL[k] - v) * hill;
        v += (FOREST[k] * (0.8 + 0.4 * fine) - v) * forest;
        v = (v + tex * (1 - river)) * shade;
        v += (RIVER[k] - v) * river;
        d[o + k] = v;
      }
      d[o + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);

  c.save(); c.scale(K, K);
  c.lineCap = 'round';
  for (const [a, b] of map.edges) {            // 道路
    const A = map.nodes[a], Bn = map.nodes[b];
    c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(Bn.x, Bn.y);
    c.strokeStyle = 'rgba(28,24,18,0.75)'; c.lineWidth = 11; c.stroke();
    c.strokeStyle = '#b9ae8c'; c.lineWidth = 6; c.stroke();
  }
  const rnd = (i) => { const t = Math.sin(i * 127.1) * 43758.5453; return t - Math.floor(t); };
  for (const v of UI.villages) {                // 集落
    for (let i = 0; i < v.n; i++) {
      const bx = v.x + (rnd(i * 3 + v.x) - 0.5) * 80, by = v.y + (rnd(i * 7 + v.y) - 0.5) * 56;
      c.fillStyle = '#9a9484'; c.fillRect(bx - 6, by - 4, 12, 8);
      c.fillStyle = '#5b574d'; c.fillRect(bx - 6, by - 4, 12, 2.5);
    }
  }
  c.restore();
}

// ---- NATO記号（友軍=長方形/青、敵=ひし形/赤） ----
function drawSymbol(c, u, x, y, o) {
  const ally = u.side === 'ally', k = 0.9 + 0.3 * Math.min(1, cam.z);
  c.save(); c.translate(x, y); c.scale(k, k);
  if (o.ghost) c.globalAlpha = 0.45;
  c.beginPath();
  if (ally) c.rect(-15, -10, 30, 20);
  else { c.moveTo(0, -15); c.lineTo(19, 0); c.lineTo(0, 15); c.lineTo(-19, 0); c.closePath(); }
  c.fillStyle = ally ? 'rgba(36,92,168,0.92)' : 'rgba(158,34,34,0.92)';
  if (o.ghost) { c.setLineDash([3, 3]); c.fillStyle = 'rgba(158,34,34,0.35)'; } else c.fill();
  const flash = u.engaged && (Math.floor(Date.now() / 250) % 2 === 0);
  c.strokeStyle = o.sel ? '#ffe066' : flash ? '#ff8a3c' : ally ? '#a9d4ff' : '#ffb4aa';
  c.lineWidth = o.sel ? 3.2 : 1.8;
  if (o.sel) { c.shadowColor = '#ffe066'; c.shadowBlur = 10; }
  c.stroke(); c.shadowBlur = 0; c.setLineDash([]);
  // 大隊記号「I」
  c.beginPath(); c.moveTo(0, ally ? -10 : -15); c.lineTo(0, ally ? -16 : -21);
  c.strokeStyle = ally ? '#a9d4ff' : '#ffb4aa'; c.lineWidth = 2; c.stroke();
  // 兵科図形
  c.save(); if (!ally) c.scale(0.8, 0.8);
  c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 1.8;
  c.stroke(glyphPath(u.type));
  if (u.type === 'arty') c.fill(glyphPath(u.type));
  c.restore();
  if (!o.ghost) {
    const by = ally ? 13 : 18;
    c.fillStyle = 'rgba(0,0,0,0.65)'; c.fillRect(-15, by, 30, 4);
    c.fillStyle = u.hp > 60 ? '#6fcf6f' : u.hp > 30 ? '#e6c34a' : '#e05a4a';
    c.fillRect(-15, by, 30 * Math.max(0, u.hp) / 100, 4);
    if (ally && (u.stalled || (u.low && (u.low.fuel || u.low.ammo || u.low.food)))) {
      c.beginPath(); c.arc(15, -10, 6, 0, 7); c.fillStyle = '#e0a83a'; c.fill();
      c.fillStyle = '#1a1d20'; c.font = 'bold 9px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('!', 15, -9.5);
    }
  }
  c.restore();
  if (o.label) {
    c.font = 'bold 10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.lineWidth = 3; c.strokeStyle = 'rgba(10,12,14,0.85)'; c.strokeText(o.label, x, y + (ally ? 27 : 32) * k);
    c.fillStyle = ally ? '#d6ebff' : '#ffd0c8'; c.fillText(o.label, x, y + (ally ? 27 : 32) * k);
  }
}

function drawArrow(pts, color, w) {
  if (pts.length < 2) return;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  const a = pts[pts.length - 2], b = pts[pts.length - 1], ang = Math.atan2(b.y - a.y, b.x - a.x), hs = w * 2.3;
  ctx.beginPath();
  ctx.moveTo(b.x + Math.cos(ang) * hs * 0.7, b.y + Math.sin(ang) * hs * 0.7);
  ctx.lineTo(b.x + Math.cos(ang + 2.4) * hs, b.y + Math.sin(ang + 2.4) * hs);
  ctx.lineTo(b.x + Math.cos(ang - 2.4) * hs, b.y + Math.sin(ang - 2.4) * hs);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function routePts(u, maxN, step) {
  const pts = [toScreen(u.x, u.y)];
  for (const leg of u.legs) {
    const n = leg.path.length;
    for (let i = step - 1; i < n; i += step) pts.push(toScreen(leg.path[i].x, leg.path[i].y));
    if (n && (n - 1) % step !== step - 1) pts.push(toScreen(leg.path[n - 1].x, leg.path[n - 1].y));
    if (pts.length >= maxN) break;
  }
  return pts.slice(0, maxN);
}

function labelBox(text, x, y, color) {
  ctx.font = 'bold 11px "Roboto Mono", Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = 'rgba(20,24,28,0.88)'; ctx.fillRect(x - w / 2, y - 10, w, 20);
  ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.strokeRect(x - w / 2, y - 10, w, 20);
  ctx.fillStyle = color; ctx.fillText(text, x, y + 0.5);
}

function draw(s, ui) {
  const z = cam.z;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101316'; ctx.fillRect(0, 0, cam.w, cam.h);

  // ---- ワールド座標系 ----
  ctx.save(); ctx.scale(z, z); ctx.translate(-cam.x, -cam.y);
  ctx.drawImage(terrainCache, 0, 0, MAP.width, MAP.height);
  ctx.lineCap = 'round';
  // 遮断された道路（敵に見えているものだけ赤で警告）
  const seenCut = (name) => {
    const n = s.map.nodes[name];
    return s.sides.ally.cut.has(name) && s.units.some((u) => u.side === 'axis' && s.vis.ally.has(u.id) && Math.hypot(u.x - n.x, u.y - n.y) <= B.supply.cutRadius);
  };
  for (const [a, b] of s.map.edges) {
    if (!(seenCut(a) || seenCut(b))) continue;
    const A = s.map.nodes[a], Bn = s.map.nodes[b];
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(Bn.x, Bn.y);
    ctx.strokeStyle = 'rgba(224,72,58,0.85)'; ctx.lineWidth = 4; ctx.stroke();
  }
  // フェーズライン
  for (const pl of UI.phaseLines) {
    ctx.beginPath();
    pl.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = pl.color; ctx.globalAlpha = 0.25; ctx.lineWidth = 12 / z; ctx.stroke();
    ctx.globalAlpha = 0.95; ctx.lineWidth = 2.4 / z; ctx.setLineDash([16 / z, 8 / z]); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  // 目標地点
  const o = s.objective;
  ctx.beginPath(); ctx.arc(o.x, o.y, o.radius, 0, 7);
  ctx.strokeStyle = s.cap.held ? '#5aa9ff' : s.cap.progress > 0.5 ? '#ffb347' : '#fff3b0';
  ctx.lineWidth = 3 / z; ctx.setLineDash([12 / z, 8 / z]); ctx.stroke(); ctx.setLineDash([]);
  // 味方補給集積所
  const dp = s.sides.ally;
  ctx.fillStyle = '#2f6db3'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / z;
  ctx.fillRect(dp.x - 14, dp.y - 14, 28, 28); ctx.strokeRect(dp.x - 14, dp.y - 14, 28, 28);
  ctx.restore();

  // ---- 戦場の霧（味方の視界外を暗くする）----
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.globalCompositeOperation = 'source-over';
  fctx.clearRect(0, 0, cam.w, cam.h);
  fctx.fillStyle = 'rgba(6,10,14,0.5)'; fctx.fillRect(0, 0, cam.w, cam.h);
  fctx.globalCompositeOperation = 'destination-out';
  fctx.fillStyle = '#000';
  for (const u of s.units) {
    if (u.side !== 'ally') continue;
    const p = toScreen(u.x, u.y);
    fctx.beginPath(); fctx.arc(p.x, p.y, B.units[u.type].vision * z, 0, 7); fctx.fill();
  }
  fctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(fogCv, 0, 0, cam.w, cam.h);

  // ---- 画面座標系 ----
  const byId = new Map(s.units.map((u) => [u.id, u]));
  const shown = (u) => u.side === 'ally' || s.vis.ally.has(u.id);
  const sel = ui.sel ? byId.get(ui.sel) : null;

  // 作戦線（青＝進撃ルート、赤＝発見した敵の移動予測）
  for (const u of s.units) {
    if (!u.legs.length) continue;
    if (u.side === 'ally') drawArrow(routePts(u, 60, 2), u.id === ui.sel ? 'rgba(120,190,255,0.85)' : 'rgba(70,140,230,0.5)', u.id === ui.sel ? 7 : 5);
    else if (shown(u)) drawArrow(routePts(u, 14, 2), 'rgba(230,80,64,0.55)', 5);
  }
  if (sel) {
    sel.legs.forEach((leg, i) => {
      const p = toScreen(leg.x, leg.y);
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.fillStyle = '#ffe066'; ctx.fill();
      ctx.fillStyle = '#222'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y + 0.5);
    });
    const p0 = toScreen(sel.x, sel.y);
    ctx.beginPath(); ctx.arc(p0.x, p0.y, B.units[sel.type].range * z, 0, 7);
    ctx.strokeStyle = 'rgba(255,224,102,0.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 5]); ctx.stroke(); ctx.setLineDash([]);
  }

  // 交戦線
  ctx.lineWidth = 1.5;
  for (const u of s.units) {
    const t = u.target && byId.get(u.target);
    if (!t || !shown(u) || !shown(t)) continue;
    const a = toScreen(u.x, u.y), b = toScreen(t.x, t.y);
    ctx.strokeStyle = u.side === 'ally' ? 'rgba(255,240,150,0.85)' : 'rgba(255,110,90,0.85)';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // 支援要請の予告円
  for (const p of s.pending) {
    const c = B.support[p.kind], q = toScreen(p.x, p.y), r = (p.kind === 'air' ? c.radius : 50) * z;
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 7);
    ctx.strokeStyle = p.kind === 'air' ? '#ff8a5c' : '#8fd3ff'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.max(0, Math.ceil(p.at - s.time))), q.x, q.y);
  }

  // 最後に確認した敵の位置（現在は見えていないもの）
  for (const g of Object.values(s.intel)) {
    if (s.vis.ally.has(g.id) || s.time - g.t > UI.intelMemory) continue;
    const p = toScreen(g.x, g.y);
    if (p.x < -40 || p.y < -40 || p.x > cam.w + 40 || p.y > cam.h + 40) continue;
    drawSymbol(ctx, { type: g.type, side: 'axis', hp: g.hp }, p.x, p.y, { ghost: true });
  }

  // 部隊
  const showLabel = z >= 0.95;
  for (const u of s.units) {
    if (!shown(u)) continue;
    const p = toScreen(u.x, u.y);
    if (p.x < -40 || p.y < -40 || p.x > cam.w + 40 || p.y > cam.h + 40) continue;
    const isSel = u.id === ui.sel;
    drawSymbol(ctx, u, p.x, p.y, { sel: isSel, label: (isSel || showLabel) ? u.name : null });
  }

  // 爆発エフェクト
  for (const f of s.fx) {
    const k = (s.time - f.t) / 1.6, p = toScreen(f.x, f.y);
    ctx.beginPath(); ctx.arc(p.x, p.y, f.r * z * (0.3 + k * 0.7), 0, 7);
    ctx.strokeStyle = `rgba(255,170,80,${1 - k})`; ctx.lineWidth = 4 * (1 - k) + 1; ctx.stroke();
  }

  // ラベル（目標・フェーズライン）
  const op = toScreen(o.x, o.y);
  labelBox('OBJ ' + o.name, op.x, op.y - o.radius * z - 14, '#fff3b0');
  for (const pl of UI.phaseLines) {
    const pt = pl.points[2], q = toScreen(pt[0], pt[1]);
    if (q.x > 20 && q.x < cam.w - 20 && q.y > 30 && q.y < cam.h - 30) labelBox(pl.name, q.x, q.y, pl.color);
  }
}

// ---- ミニマップ（全体図と現在の表示範囲の枠線）----
function drawMinimap(cv, s) {
  const c = cv.getContext('2d'), w = cv.width, h = cv.height, kx = w / MAP.width, ky = h / MAP.height;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  c.drawImage(terrainCache, 0, 0, w, h);
  c.fillStyle = 'rgba(8,12,16,0.3)'; c.fillRect(0, 0, w, h);
  for (const pl of UI.phaseLines) {
    c.beginPath();
    pl.points.forEach(([x, y], i) => (i ? c.lineTo(x * kx, y * ky) : c.moveTo(x * kx, y * ky)));
    c.strokeStyle = pl.color; c.lineWidth = Math.max(1, w / 120); c.stroke();
  }
  const o = s.objective;
  c.beginPath(); c.arc(o.x * kx, o.y * ky, o.radius * kx, 0, 7); c.strokeStyle = '#fff3b0'; c.lineWidth = 1; c.stroke();
  const d = Math.max(3, w / 45);
  for (const u of s.units) {
    if (u.side === 'ally') { c.fillStyle = '#4a90e2'; c.fillRect(u.x * kx - d / 2, u.y * ky - d / 2, d, d); }
    else if (s.vis.ally.has(u.id)) {
      c.fillStyle = '#e25a4a'; c.beginPath();
      c.moveTo(u.x * kx, u.y * ky - d * 0.8); c.lineTo(u.x * kx + d * 0.8, u.y * ky); c.lineTo(u.x * kx, u.y * ky + d * 0.8); c.lineTo(u.x * kx - d * 0.8, u.y * ky); c.fill();
    }
  }
  const vw = cam.w / cam.z, vh = cam.h / cam.z;
  c.strokeStyle = '#ffffff'; c.lineWidth = Math.max(1.5, w / 100);
  c.strokeRect(cam.x * kx, cam.y * ky, Math.min(vw, MAP.width) * kx, Math.min(vh, MAP.height) * ky);
}

function worldFromMini(cv, clientX, clientY) {
  const r = cv.getBoundingClientRect();
  return { x: (clientX - r.left) / r.width * MAP.width, y: (clientY - r.top) / r.height * MAP.height };
}

// ================= input.js =================
// タップ・ドラッグ（パン）・ピンチ（ズーム）の入力処理。

function initInput(canvas, onTap) {
  const ptrs = new Map();
  let start = null, moved = false, prevDist = 0, prevMid = null;

  const mid = () => {
    const [a, b] = [...ptrs.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { start = { x: e.clientX, y: e.clientY }; moved = false; }
    if (ptrs.size === 2) { const m = mid(); prevDist = m.d; prevMid = m; moved = true; }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) moved = true;
      if (moved) { cam.x -= dx / cam.z; cam.y -= dy / cam.z; clampCam(); }
    } else if (ptrs.size === 2) {
      const m = mid();
      cam.x -= (m.x - prevMid.x) / cam.z; cam.y -= (m.y - prevMid.y) / cam.z;
      if (prevDist > 0) zoomAt(m.x, m.y, m.d / prevDist);
      prevDist = m.d; prevMid = m; clampCam();
    }
  });

  const up = (e) => {
    const wasSingle = ptrs.size === 1;
    ptrs.delete(e.pointerId);
    if (wasSingle && !moved && e.type === 'pointerup') {
      const w = toWorld(e.clientX, e.clientY);
      onTap(w.x, w.y, e.clientX, e.clientY);
    }
    if (ptrs.size === 1) { const p = [...ptrs.values()][0]; start = { x: p.x, y: p.y }; moved = true; }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
}

// ================= main.js =================
// 起動・ゲームループ・作戦指示画面（左：編成ツリー / 右：状況 / 下：ミニマップ・ログ・指揮ボタン）の制御。
const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ui = { sel: null, mode: null, append: false, support: null, orderOpen: false };
let state = null, inited = false, paused = true, speedIdx = 0, acc = 0;
let last = performance.now(), hudTimer = 0, logOpen = false, logSig = '', resultShown = false;
let toastTimer = 0, tipTimer = 0, tipCam = null, unitsSig = '';
const rowEls = {};
const TERRAIN_NAME = ['平地', '森林', '丘陵', '河川', '橋'];
const MODE_JP = { advance: '進軍', attack: '攻撃', defend: '防御', hold: '待機' };

const pad = (n) => String(n).padStart(2, '0');
const fmt = (t) => `${pad(Math.floor(t / 60))}:${pad(Math.floor(t % 60))}`;
const clockMin = (t) => UI.clockStartMinutes + Math.floor(t / UI.turnSeconds * UI.turnClockMinutes);
const hrs = (t) => pad(Math.floor(clockMin(t) / 60) % 24) + pad(clockMin(t) % 60);
const clk = (t) => pad(Math.floor(clockMin(t) / 60) % 24) + ':' + pad(clockMin(t) % 60);
const turnNo = (t) => Math.floor(t / UI.turnSeconds) + 1;
const gridRef = (x, y) => String.fromCharCode(65 + Math.min(11, Math.floor(x / 250))) + '-' + (Math.min(7, Math.floor(y / 250)) + 1);
const selUnit = () => (state && ui.sel ? state.units.find((u) => u.id === ui.sel) || null : null);

// ---- NATO記号のSVG（編成ツリー・レポート用）----
function natoSvg(type, side, size) {
  const g = GLYPH[type];
  const fill = type === 'arty' ? '#fff' : 'none';
  const body = side === 'ally'
    ? '<rect x="-15" y="-10" width="30" height="20" fill="#245ca8" stroke="#a9d4ff" stroke-width="2"/>'
    : '<polygon points="0,-15 19,0 0,15 -19,0" fill="#9e2222" stroke="#ffb4aa" stroke-width="2"/>';
  const tr = side === 'ally' ? '' : ' transform="scale(0.8)"';
  return `<svg class="nato" viewBox="-21 -21 42 42" width="${size}" height="${size}">${body}<path d="${g}" fill="${fill}" stroke="#fff" stroke-width="2"${tr}/></svg>`;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function showOverlay(title, body, buttons) {
  $('ovTitle').textContent = title;
  $('ovBody').textContent = body;
  const box = $('ovBtns');
  box.textContent = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.primary) btn.className = 'primary';
    btn.addEventListener('click', () => { $('overlay').hidden = true; if (b.fn) b.fn(); });
    box.appendChild(btn);
  }
  $('overlay').hidden = false;
}

function openMenu() {
  paused = true;
  const btns = [];
  if (state && !state.result) btns.push({ label: '作戦に戻る', primary: true });
  if (hasSave()) btns.push({ label: '続きから', fn: startLoad, primary: !state });
  btns.push({ label: '新規作戦', fn: startNew, primary: !state && !hasSave() });
  showOverlay(SCENARIO.title, SCENARIO.briefing, btns);
  syncButtons();
}

function begin(s) {
  state = s; resultShown = false; acc = 0; unitsSig = '';
  ui.sel = null; ui.mode = null; ui.append = false; ui.support = null; ui.orderOpen = false;
  if (!inited) { initRender(canvas, state); initInput(canvas, onTap); initMini(); inited = true; }
  $('unitsPanel').classList.remove('open'); $('sitPanel').classList.remove('open');
  $('logPanel').hidden = true; logOpen = false; $('intelPanel').hidden = true; hideTip();
  centerOn(650, 900, 0.6);
  paused = true;
  syncButtons(); updateHud(true);
  toast('命令を出したら ▶ で作戦開始');
}
function startNew() { clearSave(); begin(newGame()); }
function startLoad() {
  const d = loadSave();
  if (!d) { startNew(); return; }
  begin(restoreGame(d));
}

// ---- 地図のタップ ----
function nearestUnit(sx, sy, filter) {
  let best = null, bd = 30;
  for (const u of state.units) {
    if (!filter(u)) continue;
    const p = toScreen(u.x, u.y), d = Math.hypot(p.x - sx, p.y - sy);
    if (d < bd) { bd = d; best = u; }
  }
  return best;
}

function hideTip() { $('tip').hidden = true; clearTimeout(tipTimer); tipCam = null; }
function showTip(title, lines, sx, sy, tone) {
  const tip = $('tip');
  tip.className = tone || '';
  $('tipTitle').textContent = title;
  const body = $('tipBody');
  body.textContent = '';
  for (const l of lines) { const d = document.createElement('div'); d.textContent = l; body.appendChild(d); }
  tip.hidden = false;
  const top = $('topbar').offsetHeight + 4, bottom = cam.h - $('bottomBar').offsetHeight - 4;
  tip.style.left = Math.max(6, Math.min(cam.w - tip.offsetWidth - 6, sx + 16)) + 'px';
  tip.style.top = Math.max(top, Math.min(bottom - tip.offsetHeight, sy - 20)) + 'px';
  tipCam = { x: cam.x, y: cam.y, z: cam.z };
  clearTimeout(tipTimer);
  tipTimer = setTimeout(hideTip, 6000);
}

function unitTip(u, sx, sy) {
  const d = B.units[u.type], mine = u.side === 'ally';
  const lines = [`${d.en}　${gridRef(u.x, u.y)}`, `Personnel: ${menOf(u)}　${d.vehLabel} ${vehOf(u)}`];
  if (mine) {
    lines.push(`Supply: 燃${d.maxFuel ? Math.round(u.fuel) : '—'} 弾${Math.round(u.ammo)} 食${Math.round(u.food)}（${supplyPct(u)}%）`);
    lines.push(`Order: ${MODE_JP[u.mode]}${u.engaged ? '・交戦中' : u.moving ? '・移動中' : ''}${u.stalled ? '・燃料切れ' : ''}`);
  } else {
    lines.push(`推定兵力 ${Math.round(u.hp)}%${u.entr ? '・陣地構築' : ''}`);
  }
  showTip(u.name, lines, sx, sy, mine ? 'ally' : 'axis');
}

function areaTip(wx, wy, sx, sy) {
  const s = state, lines = [];
  lines.push('Terrain: ' + TERRAIN_NAME[terrainAt(s.map, wx, wy)] + (s.map.road[Math.min(s.map.W - 1, Math.floor(wx / s.map.cell)) + Math.min(s.map.H - 1, Math.floor(wy / s.map.cell)) * s.map.W] ? '（道路）' : ''));
  const o = s.objective;
  if (Math.hypot(wx - o.x, wy - o.y) <= o.radius) lines.push(`Objective: ${o.name}（${s.cap.held ? '占領中' : '未占領'}）`);
  const nn = nearestNode(s.map, wx, wy);
  if (nn.dist <= 90) lines.push('MSR: ' + (s.sides.ally.cut.has(nn.node.name) ? '遮断中' : '開通'));
  const gun = s.units.find((u) => u.side === 'ally' && u.type === 'arty' && Math.hypot(u.x - wx, u.y - wy) <= B.units.arty.range);
  if (gun) lines.push(`Artillery Fire Zone（${gun.name}）`);
  const sp = s.units.find((u) => u.side === 'axis' && u.type === 'inf' && u.entr && s.vis.ally.has(u.id) && Math.hypot(u.x - wx, u.y - wy) <= 130);
  if (sp) lines.push('Strongpoint（敵歩兵・陣地構築）');
  const gh = Object.values(s.intel).find((g) => !s.vis.ally.has(g.id) && s.time - g.t <= UI.intelMemory && Math.hypot(g.x - wx, g.y - wy) <= 120);
  if (gh) lines.push(`Last known: ${gh.name}（${Math.round(s.time - gh.t)}秒前）`);
  showTip('AREA ' + gridRef(wx, wy), lines.slice(0, 5), sx, sy, '');
}

function onTap(wx, wy, sx, sy) {
  if (!state || state.result) return;
  if (ui.support) {
    const msg = requestSupport(state, ui.support, wx, wy);
    ui.support = null;
    if (msg) toast(msg); else { toast('要請を受理しました'); saveGame(state); }
    syncButtons(); return;
  }
  const mine = nearestUnit(sx, sy, (u) => u.side === 'ally');
  if (mine) {
    if (ui.sel === mine.id && !ui.mode) { ui.sel = null; hideTip(); }        // もう一度タップで選択解除
    else { ui.sel = mine.id; ui.mode = null; ui.append = false; unitTip(mine, sx, sy); }
    syncButtons(); updateHud(true); return;
  }
  const u = selUnit();
  if (u && ui.mode) {
    hideTip();
    setOrder(state, u, ui.mode, [{ x: wx, y: wy }], ui.append);
    const leg = u.legs[u.legs.length - 1];
    if (!leg || !leg.path.length) { u.legs.pop(); toast('その地点へは到達できません'); }
    else ui.append = true;
    saveGame(state);
    return;
  }
  const foe = nearestUnit(sx, sy, (e) => e.side === 'axis' && state.vis.ally.has(e.id));
  if (foe) { unitTip(foe, sx, sy); return; }
  areaTip(wx, wy, sx, sy);
}

// ---- 表示の更新 ----
function setBar(el, pct) {
  el.style.width = pct + '%';
  el.className = pct < 25 ? 'low' : pct < 50 ? 'mid' : '';
}

function buildTree() {
  const tree = $('tree');
  tree.textContent = '';
  for (const k of Object.keys(rowEls)) delete rowEls[k];
  const allies = state.units.filter((u) => u.side === 'ally');
  const root = document.createElement('div');
  root.className = 'node root';
  root.innerHTML = '<div class="nm"></div><div class="sub"></div><div class="sup"><span>Supply</span><div class="bar"><i></i></div><b></b></div>';
  root.querySelector('.nm').textContent = UI.divisionName;
  tree.appendChild(root);
  rowEls.root = { sub: root.querySelector('.sub'), bar: root.querySelector('i'), pct: root.querySelector('b') };
  for (const g of UI.groups) {
    const members = allies.filter((u) => g.types.includes(u.type));
    if (!members.length) continue;
    const head = document.createElement('div');
    head.className = 'grp';
    head.textContent = `${g.label}（${members.length}）`;
    tree.appendChild(head);
    for (const u of members) {
      const row = document.createElement('div');
      row.className = 'node unit';
      row.innerHTML = '<div class="top"><span class="sym"></span><span class="nm"></span><span class="hp"></span></div><div class="sub"></div><div class="sup"><span>Supply</span><div class="bar"><i></i></div><b></b></div>';
      row.querySelector('.sym').innerHTML = natoSvg(u.type, 'ally', 26);
      row.querySelector('.nm').textContent = u.name;
      row.addEventListener('click', () => {
        const cur = state.units.find((x) => x.id === u.id);
        if (!cur) return;
        ui.sel = cur.id; ui.mode = null; ui.append = false;
        centerOn(cur.x, cur.y); syncButtons(); updateHud(true);
      });
      tree.appendChild(row);
      rowEls[u.id] = { row, hp: row.querySelector('.hp'), sub: row.querySelector('.sub'), bar: row.querySelector('i'), pct: row.querySelector('b') };
    }
  }
}

function updateTree() {
  const allies = state.units.filter((u) => u.side === 'ally');
  const sig = allies.map((u) => u.id).join(',');
  if (sig !== unitsSig) { unitsSig = sig; buildTree(); }
  let men = 0, sup = 0;
  for (const u of allies) {
    const r = rowEls[u.id];
    men += menOf(u); sup += supplyPct(u);
    if (!r) continue;
    const d = B.units[u.type], p = supplyPct(u);
    r.hp.textContent = Math.round(u.hp) + '%';
    r.sub.textContent = `Personnel: ${menOf(u)}　${d.vehLabel}: ${vehOf(u)}`;
    setBar(r.bar, p); r.pct.textContent = p + '%';
    r.row.classList.toggle('sel', u.id === ui.sel);
    r.row.classList.toggle('eng', !!u.engaged);
  }
  const avg = allies.length ? Math.round(sup / allies.length) : 0;
  rowEls.root.sub.textContent = `Personnel: ${men}　Battalions: ${allies.length}`;
  setBar(rowEls.root.bar, avg); rowEls.root.pct.textContent = avg + '%';
  $('unitsCount').textContent = String(allies.length);
}

function drawChart(cv, series, max) {
  const c = cv.getContext('2d'), w = cv.width, h = cv.height, H = state.hist;
  c.clearRect(0, 0, w, h);
  c.strokeStyle = 'rgba(255,255,255,0.09)'; c.lineWidth = 1;
  for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, h * i / 4); c.lineTo(w, h * i / 4); c.stroke(); }
  if (H.length < 2) return;
  const tmax = Math.max(B.timeLimit / 2, H[H.length - 1].t);
  for (const sr of series) {
    c.beginPath();
    H.forEach((p, i) => {
      const x = p.t / tmax * w, y = h - 3 - (Math.min(max, p[sr.key]) / max) * (h - 8);
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    });
    c.strokeStyle = sr.color; c.lineWidth = 3; c.stroke();
  }
}

function updateSit() {
  const s = state, c = s.cap;
  $('sTurn').textContent = `TURN ${turnNo(s.time)} — ${hrs(s.time)} HRS`;
  $('sElapsed').textContent = `経過 ${fmt(s.time)} / 制限 ${fmt(B.timeLimit)}`;
  const blue = Math.round(airSuperiority(s));
  $('gBlue').style.width = blue + '%'; $('gRed').style.width = (100 - blue) + '%';
  $('gTxt').textContent = `BLUE ${blue}%  /  RED ${100 - blue}%`;
  const need = c.held ? B.holdTime : B.captureTime, val = c.held ? c.hold : c.progress;
  $('oName').textContent = `${s.objective.name}　${c.held ? '確保中（防衛）' : c.progress > 0.5 ? '占領進行中' : '未占領'}`;
  $('oBar').style.width = Math.min(100, val / need * 100) + '%';
  $('oBar').className = c.held ? 'held' : '';
  const sups = s.units.filter((u) => u.side === 'ally' && u.type === 'supply');
  const linked = sups.filter((u) => u.linked).length;
  $('sMsr').textContent = `MSR: ${linked}/${sups.length} LINKED`;
  $('sMsr').className = sups.length && linked < sups.length ? 'warn' : '';
  const a = s.support.air, p = s.support.para;
  $('sAir').textContent = `AIR SUPPORT ×${a.uses}${a.cd > 0 ? `（CD ${Math.ceil(a.cd)}s）` : ' READY'}`;
  $('sPara').textContent = `AIRBORNE ×${p.uses}${p.cd > 0 ? `（CD ${Math.ceil(p.cd)}s）` : ' READY'}`;
  const H = s.hist, lastH = H[H.length - 1] || { ca: 0, cx: 0, sup: 0 };
  $('cCasTxt').textContent = `ALLIED ${lastH.ca}　AXIS ${lastH.cx}`;
  $('cLogTxt').textContent = `AVG SUPPLY ${Math.round(lastH.sup)}%`;
  let mx = 50;
  for (const p2 of H) mx = Math.max(mx, p2.ca, p2.cx);
  drawChart($('gCas'), [{ key: 'ca', color: '#4a90e2' }, { key: 'cx', color: '#e25a4a' }], mx * 1.1);
  drawChart($('gLog'), [{ key: 'sup', color: '#7fcf7f' }], 100);
}

function updateRadio() {
  const box = $('radio');
  box.textContent = '';
  for (const e of state.log.filter((x) => x.kind !== 'supply' && x.kind !== 'supplyE').slice(-6)) {
    const d = document.createElement('div');
    d.className = 'log ' + e.kind;
    const t = document.createElement('b');
    t.textContent = clk(e.t) + ' ';
    d.append(t, document.createTextNode(e.text));
    box.appendChild(d);
  }
}

function renderFullLog() {
  const list = state.log.slice(-80).reverse();
  const sig = state.log.length + '|' + (list[0] ? list[0].t : 0);
  if (sig === logSig) return;
  logSig = sig;
  const box = $('logList');
  box.textContent = '';
  for (const e of list) {
    const div = document.createElement('div');
    div.className = 'log ' + e.kind;
    const t = document.createElement('b');
    t.textContent = clk(e.t) + ' ';
    div.append(t, document.createTextNode(e.text));
    box.appendChild(div);
  }
}

function openIntel() {
  const s = state, box = $('intelList');
  box.textContent = '';
  const live = s.units.filter((u) => u.side === 'axis' && s.vis.ally.has(u.id));
  const old = Object.values(s.intel).filter((g) => !s.vis.ally.has(g.id) && s.time - g.t <= UI.intelMemory * 2);
  $('intelSum').textContent = `確認中 ${live.length} ／ 最終位置のみ ${old.length} ／ 撃破 ${s.stats.lost.axis}`;
  const add = (o, tag, age) => {
    const row = document.createElement('div');
    row.className = 'irow';
    row.innerHTML = `<span class="sym">${natoSvg(o.type, 'axis', 30)}</span><span class="nm"></span><span class="gr"></span><span class="tag"></span>`;
    row.querySelector('.nm').textContent = `${o.name}（${Math.round(o.hp)}%）`;
    row.querySelector('.gr').textContent = gridRef(o.x, o.y);
    row.querySelector('.tag').textContent = tag;
    row.querySelector('.tag').className = 'tag ' + (age ? 'old' : 'live');
    row.addEventListener('click', () => { centerOn(o.x, o.y, 0.7); $('intelPanel').hidden = true; });
    box.appendChild(row);
  };
  for (const u of live) add(u, 'LIVE', 0);
  for (const g of old) add(g, `${Math.round(s.time - g.t)}s前`, 1);
  if (!live.length && !old.length) { const d = document.createElement('div'); d.className = 'irow empty'; d.textContent = '敵の情報はまだありません。偵察部隊を前進させましょう。'; box.appendChild(d); }
  $('intelPanel').hidden = false;
}

function syncButtons() {
  const has = !!selUnit();
  $('btnPause').textContent = paused ? '▶' : '⏸';
  $('btnSpeed').textContent = `×${B.speeds[speedIdx]}`;
  $('pPlay').classList.toggle('on', !paused);
  $('pPause').classList.toggle('on', paused);
  $('pFast').textContent = `⏩ ×${B.speeds[speedIdx]}`;
  for (const b of document.querySelectorAll('#orderPop [data-mode]')) b.classList.toggle('on', has && ui.mode === b.dataset.mode);
  $('btnDone').disabled = !(has && ui.mode);
  $('orderPop').hidden = !(ui.orderOpen && has);
  $('orderWho').textContent = has ? selUnit().name : '';
  $('cIssue').classList.toggle('on', ui.orderOpen && has);
  const a = state ? state.support.air : { uses: 0, cd: 0 }, p = state ? state.support.para : { uses: 0, cd: 0 };
  $('cAirSub').textContent = `×${a.uses}${a.cd > 0 ? ` ・ ${Math.ceil(a.cd)}s` : ''}`;
  $('cParaSub').textContent = `×${p.uses}${p.cd > 0 ? ` ・ ${Math.ceil(p.cd)}s` : ''}`;
  $('cAir').disabled = !state || a.uses <= 0 || a.cd > 0;
  $('cPara').disabled = !state || p.uses <= 0 || p.cd > 0;
  $('cAir').classList.toggle('on', ui.support === 'air');
  $('cPara').classList.toggle('on', ui.support === 'para');
  $('btnUnits').classList.toggle('on', $('unitsPanel').classList.contains('open'));
  $('btnSitrep').classList.toggle('on', $('sitPanel').classList.contains('open'));
}

function updateHud(force) {
  if (!state) return;
  const c = state.cap;
  $('turnClock').textContent = `TURN ${turnNo(state.time)} · ${hrs(state.time)} HRS`;
  let t = '未占領';
  if (c.held) t = `確保中 ${Math.floor(c.hold)}/${B.holdTime}s`;
  else if (c.progress > 0.5) t = `占領 ${Math.floor(c.progress)}/${B.captureTime}s`;
  $('objStatus').textContent = `OBJ ${state.objective.name}: ${t}`;
  $('objStatus').classList.toggle('held', c.held);
  if (!selUnit() && ui.sel) { ui.sel = null; ui.mode = null; }
  if (force || $('unitsPanel').classList.contains('open')) updateTree();
  if (force || $('sitPanel').classList.contains('open')) updateSit();
  updateRadio();
  drawMinimap($('mini'), state);
  if (logOpen) renderFullLog();
  syncButtons();
}

function finish() {
  resultShown = true; paused = true; clearSave();
  const win = state.result === 'win';
  const L = state.stats.lost;
  showOverlay(win ? '作戦成功' : '作戦失敗',
    `${state.objective.name}を${win ? '確保した' : '確保できなかった'}。\n経過時間 ${fmt(state.time)}（TURN ${turnNo(state.time)}）\n連合軍の損失 ${L.ally}個大隊／ドイツ軍の損失 ${L.axis}個大隊`,
    [{ label: '新規作戦', fn: startNew, primary: true }, { label: '戦闘ログを見る', fn: () => { logOpen = true; $('logPanel').hidden = false; logSig = ''; renderFullLog(); } }]);
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state) {
    if (!paused && !state.result) {
      acc += dt * B.speeds[speedIdx];
      let n = 0;
      while (acc >= B.step && n < 80) { stepGame(state, B.step); acc -= B.step; n++; }
      if (n >= 80) acc = 0;
    }
    draw(state, ui);
    if (tipCam && (tipCam.x !== cam.x || tipCam.y !== cam.y || tipCam.z !== cam.z)) hideTip();
    hudTimer -= dt;
    if (hudTimer <= 0) { hudTimer = 0.25; updateHud(false); }
    if (state.result && !resultShown) finish();
  }
  requestAnimationFrame(frame);
}

// ---- ミニマップ操作 ----
function initMini() {
  const mini = $('mini');
  const dpr2 = Math.min(2, window.devicePixelRatio || 1);
  mini.width = Math.round(mini.clientWidth * dpr2) || 240;
  mini.height = Math.round(mini.clientHeight * dpr2) || 144;
  let drag = false;
  const go = (e) => { const w = worldFromMini(mini, e.clientX, e.clientY); centerOn(w.x, w.y); };
  mini.addEventListener('pointerdown', (e) => { drag = true; mini.setPointerCapture(e.pointerId); go(e); });
  mini.addEventListener('pointermove', (e) => { if (drag) go(e); });
  mini.addEventListener('pointerup', () => { drag = false; });
  mini.addEventListener('pointercancel', () => { drag = false; });
}

// ---- ボタン ----
function setPaused(v) { if (!state || state.result) return; paused = v; syncButtons(); }
function cycleSpeed() { speedIdx = (speedIdx + 1) % B.speeds.length; syncButtons(); }
function togglePanel(id, other) {
  const p = $(id), willOpen = !p.classList.contains('open');
  p.classList.toggle('open', willOpen);
  if (willOpen && window.innerWidth < 760) $(other).classList.remove('open');
  if (state) updateHud(true);
  syncButtons();
}

$('btnPause').addEventListener('click', () => setPaused(!paused));
$('btnSpeed').addEventListener('click', cycleSpeed);
$('pPlay').addEventListener('click', () => setPaused(false));
$('pPause').addEventListener('click', () => setPaused(true));
$('pFast').addEventListener('click', () => { cycleSpeed(); setPaused(false); });
$('btnMenu').addEventListener('click', openMenu);
$('btnUnits').addEventListener('click', () => togglePanel('unitsPanel', 'sitPanel'));
$('btnSitrep').addEventListener('click', () => togglePanel('sitPanel', 'unitsPanel'));
$('btnUnitsClose').addEventListener('click', () => togglePanel('unitsPanel', 'sitPanel'));
$('btnSitClose').addEventListener('click', () => togglePanel('sitPanel', 'unitsPanel'));
for (const id of ['btnLog', 'btnLogAll']) {
  $(id).addEventListener('click', () => {
    logOpen = !logOpen; $('logPanel').hidden = !logOpen;
    if (logOpen && state) { logSig = ''; renderFullLog(); }
  });
}
$('btnLogClose').addEventListener('click', () => { logOpen = false; $('logPanel').hidden = true; });
$('btnIntelClose').addEventListener('click', () => { $('intelPanel').hidden = true; });

$('cIssue').addEventListener('click', () => {
  if (!state) return;
  if (!selUnit()) {
    if (!$('unitsPanel').classList.contains('open')) togglePanel('unitsPanel', 'sitPanel');
    toast('先に部隊を選択してください（地図または左パネル）');
    return;
  }
  ui.orderOpen = !ui.orderOpen; ui.support = null;
  if (!ui.orderOpen) { ui.mode = null; ui.append = false; }
  syncButtons();
});
for (const b of document.querySelectorAll('#orderPop [data-mode]')) {
  b.addEventListener('click', () => {
    const u = selUnit();
    if (!u) { toast('先に部隊を選択してください'); return; }
    const m = b.dataset.mode;
    ui.support = null;
    if (m === 'hold') { setOrder(state, u, 'hold', []); ui.mode = null; toast(`${u.name}：待機`); saveGame(state); }
    else { ui.mode = m; ui.append = false; toast(`${MODE_JP[m]}：目的地をタップ（続けてタップで経由地を追加）`); }
    syncButtons();
  });
}
$('btnDone').addEventListener('click', () => { ui.mode = null; ui.append = false; syncButtons(); });
$('btnOrderClose').addEventListener('click', () => { ui.orderOpen = false; ui.mode = null; ui.append = false; syncButtons(); });

for (const [id, kind] of [['cAir', 'air'], ['cPara', 'para']]) {
  $(id).addEventListener('click', () => {
    if (!state || state.result) return;
    ui.mode = null; ui.orderOpen = false;
    ui.support = ui.support === kind ? null : kind;
    if (ui.support) toast(kind === 'air' ? '爆撃する地点をタップ' : '降下する地点をタップ');
    syncButtons();
  });
}
$('cIntel').addEventListener('click', () => { if (state) openIntel(); });
for (const id of ['cFire', 'cSupply', 'cROE', 'cPlan']) {
  $(id).addEventListener('click', () => toast('準備中：この機能は今後のアップデートで追加予定です'));
}

// ---- 自動保存 ----
setInterval(() => { if (state && !state.result && !paused) saveGame(state); }, B.save.interval * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state && !state.result) { paused = true; saveGame(state); syncButtons(); }
});
window.addEventListener('pagehide', () => { if (state && !state.result) saveGame(state); });

openMenu();
requestAnimationFrame(frame);
