// 師団規模ウォーゲーム 本体（マップ・部隊・戦闘・補給・AI・描画・操作をこの1ファイルにまとめています）
import { MAP, riverX, BALANCE, AI, SCENARIO } from './config.js';
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
  return { W, H, cell, terr, road, nodes, adj, nodeList: Object.values(nodes), edges: MAP.edges };
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
    if (r.fuel + r.ammo + r.food < 0.5) continue;
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
    cap: { progress: 0, held: false, hold: 0 }, ai: { timer: 0 }, support: initSupport(),
    objective: { x: N[MAP.objective.node].x, y: N[MAP.objective.node].y, radius: MAP.objective.radius, name: MAP.objective.name },
    sides: { ally: depot('ally'), axis: depot('axis') },
    vis: { ally: new Set(), axis: new Set() },
  };
  for (const u of SCENARIO.ally) makeUnit(s, 'ally', u.type, u.x, u.y);
  for (const u of SCENARIO.axis) makeUnit(s, 'axis', u.type, u.x, u.y, { role: u.role, post: { x: u.x, y: u.y } });
  computeVisibility(s);
  addLog(s, 'info', `作戦開始：${SCENARIO.title}`);
  return s;
}

function restoreGame(d) {
  const s = newGame();
  Object.assign(s, {
    time: d.time, units: d.units, nextId: d.nextId, counts: d.counts, cap: d.cap,
    support: d.support, pending: d.pending, ai: d.ai, stats: d.stats, log: d.log, lastFlush: d.time,
  });
  computeVisibility(s);
  addLog(s, 'info', '保存データから作戦を再開');
  return s;
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
      stats: s.stats, log: s.log.slice(-60),
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
// Canvas描画：地形・道路・目標・戦場の霧・兵科アイコン（外部画像は使わない）。

const cam = { x: 0, y: 0, z: 0.5, w: 800, h: 400 };

const TERRAIN_COLORS = ['#b9c48b', '#6a8b58', '#aa9c6c', '#5b8fbe', '#8a7048'];
const CACHE_SCALE = 0.5;
let ctx, cvs, terrainCache, fogCv, fctx, dpr = 1;

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

function buildTerrain(map) {
  terrainCache = document.createElement('canvas');
  terrainCache.width = Math.round(MAP.width * CACHE_SCALE);
  terrainCache.height = Math.round(MAP.height * CACHE_SCALE);
  const c = terrainCache.getContext('2d'), cs = map.cell * CACHE_SCALE;
  for (let j = 0; j < map.H; j++) {
    for (let i = 0; i < map.W; i++) {
      const t = map.terr[j * map.W + i], h = ((i * 73856093) ^ (j * 19349663)) >>> 0;
      c.fillStyle = TERRAIN_COLORS[t];
      c.fillRect(i * cs, j * cs, cs + 0.5, cs + 0.5);
      if (h % 7 < 2) { c.fillStyle = 'rgba(0,0,0,0.06)'; c.fillRect(i * cs, j * cs, cs + 0.5, cs + 0.5); }
      if (t === 1) {
        c.fillStyle = 'rgba(28,66,32,0.55)';
        for (let k = 0; k < 3; k++) {
          const px = i * cs + ((h >> (k * 4)) % 9 + 8) / 20 * cs, py = j * cs + ((h >> (k * 4 + 2)) % 9 + 8) / 20 * cs;
          c.beginPath(); c.arc(px, py, cs * 0.2, 0, 7); c.fill();
        }
      } else if (t === 2) {
        c.strokeStyle = 'rgba(96,78,44,0.6)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(i * cs + cs * 0.2, j * cs + cs * 0.7); c.lineTo(i * cs + cs * 0.5, j * cs + cs * 0.3); c.lineTo(i * cs + cs * 0.8, j * cs + cs * 0.7); c.stroke();
      }
    }
  }
}

function icon(type, x, y, side, hp, selected) {
  const w = 30, h = 22;
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = side === 'ally' ? '#3f7fc9' : '#b9463c';
  ctx.strokeStyle = selected ? '#ffe066' : '#ffffff';
  ctx.lineWidth = selected ? 3 : 1.5;
  ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath();
  if (type === 'inf') { ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.moveTo(w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2); }
  else if (type === 'tank') { ctx.ellipse(-2, 1, 9, 5, 0, 0, 7); ctx.moveTo(4, -1); ctx.lineTo(13, -3); }
  else if (type === 'arty') { ctx.moveTo(-6, 3); ctx.lineTo(8, -7); ctx.stroke(); ctx.beginPath(); ctx.arc(-6, 4, 3, 0, 7); ctx.fill(); }
  else if (type === 'supply') { ctx.rect(-10, -5, 12, 10); ctx.rect(3, -2, 7, 7); }
  else if (type === 'recon') { ctx.moveTo(-w / 2, h / 2); ctx.lineTo(w / 2, -h / 2); }
  else if (type === 'para') { ctx.arc(0, 1, 9, Math.PI, 0); ctx.moveTo(-9, 1); ctx.lineTo(0, 8); ctx.lineTo(9, 1); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-w / 2, h / 2 + 3, w, 4);
  ctx.fillStyle = hp > 60 ? '#6fcf6f' : hp > 30 ? '#e6c34a' : '#e05a4a';
  ctx.fillRect(-w / 2, h / 2 + 3, w * Math.max(0, hp) / 100, 4);
  ctx.restore();
}

function draw(s, ui) {
  const z = cam.z;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#141c17'; ctx.fillRect(0, 0, cam.w, cam.h);

  // ---- ワールド座標系 ----
  ctx.save(); ctx.scale(z, z); ctx.translate(-cam.x, -cam.y);
  ctx.drawImage(terrainCache, 0, 0, MAP.width, MAP.height);
  ctx.lineCap = 'round';
  const seenCut = (name) => {
    const n = s.map.nodes[name];
    return s.sides.ally.cut.has(name) && s.units.some((u) => u.side === 'axis' && s.vis.ally.has(u.id) && Math.hypot(u.x - n.x, u.y - n.y) <= B.supply.cutRadius);
  };
  for (const [a, b] of s.map.edges) {
    const A = s.map.nodes[a], Bn = s.map.nodes[b];
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(Bn.x, Bn.y);
    ctx.strokeStyle = '#5a4a30'; ctx.lineWidth = 14; ctx.stroke();
    ctx.strokeStyle = seenCut(a) || seenCut(b) ? '#d0453a' : '#e2d3a2'; ctx.lineWidth = 8; ctx.stroke();
  }
  // 目標地点
  const o = s.objective;
  ctx.beginPath(); ctx.arc(o.x, o.y, o.radius, 0, 7);
  ctx.strokeStyle = s.cap.held ? '#5aa9ff' : s.cap.progress > 0.5 ? '#ffb347' : '#fff3b0';
  ctx.lineWidth = 3 / z; ctx.setLineDash([12 / z, 8 / z]); ctx.stroke(); ctx.setLineDash([]);
  // 集積所
  const dp = s.sides.ally;
  ctx.fillStyle = '#2f6db3'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / z;
  ctx.fillRect(dp.x - 14, dp.y - 14, 28, 28); ctx.strokeRect(dp.x - 14, dp.y - 14, 28, 28);
  ctx.restore();

  // ---- 戦場の霧（味方の視界外を暗くする）----
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.globalCompositeOperation = 'source-over';
  fctx.clearRect(0, 0, cam.w, cam.h);
  fctx.fillStyle = 'rgba(6,10,14,0.55)'; fctx.fillRect(0, 0, cam.w, cam.h);
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

  // 命令経路
  if (sel) {
    const p0 = toScreen(sel.x, sel.y);
    ctx.strokeStyle = '#ffe066'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y);
    for (const leg of sel.legs) for (const q of leg.path) { const p = toScreen(q.x, q.y); ctx.lineTo(p.x, p.y); }
    ctx.stroke(); ctx.setLineDash([]);
    sel.legs.forEach((leg, i) => {
      const p = toScreen(leg.x, leg.y);
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.fillStyle = '#ffe066'; ctx.fill();
      ctx.fillStyle = '#222'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y + 0.5);
    });
    ctx.beginPath(); ctx.arc(p0.x, p0.y, B.units[sel.type].range * z, 0, 7);
    ctx.strokeStyle = 'rgba(255,224,102,0.5)'; ctx.lineWidth = 1; ctx.stroke();
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

  // 部隊アイコン
  for (const u of s.units) {
    if (!shown(u)) continue;
    const p = toScreen(u.x, u.y);
    if (p.x < -40 || p.y < -40 || p.x > cam.w + 40 || p.y > cam.h + 40) continue;
    icon(u.type, p.x, p.y, u.side, u.hp, u.id === ui.sel);
    if (u.side === 'ally' && u.stalled) { ctx.fillStyle = '#ffb347'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('燃料切れ', p.x, p.y - 18); }
  }

  // 爆発エフェクト
  for (const f of s.fx) {
    const k = (s.time - f.t) / 1.6, p = toScreen(f.x, f.y);
    ctx.beginPath(); ctx.arc(p.x, p.y, f.r * z * (0.3 + k * 0.7), 0, 7);
    ctx.strokeStyle = `rgba(255,170,80,${1 - k})`; ctx.lineWidth = 4 * (1 - k) + 1; ctx.stroke();
  }

  // 目標名
  const op = toScreen(o.x, o.y);
  ctx.fillStyle = '#fff8d0'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(o.name, op.x, op.y - o.radius * z - 6);
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
// 起動・ゲームループ・画面(UI)の結線。

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ui = { sel: null, mode: null, append: false, support: null };
let state = null, inited = false, paused = true, speedIdx = 0, acc = 0;
let last = performance.now(), hudTimer = 0, logOpen = false, logSig = '', resultShown = false, toastTimer = 0;

const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const selUnit = () => (state && ui.sel ? state.units.find((u) => u.id === ui.sel) || null : null);

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
  state = s; resultShown = false; acc = 0;
  ui.sel = null; ui.mode = null; ui.append = false; ui.support = null;
  if (!inited) { initRender(canvas, state); initInput(canvas, onTap); inited = true; }
  centerOn(650, 900, 0.6);
  paused = true;
  syncButtons();
  toast('命令を出したら ▶ で作戦開始');
}
function startNew() { clearSave(); begin(newGame()); }
function startLoad() {
  const d = loadSave();
  if (!d) { startNew(); return; }
  begin(restoreGame(d));
}

function nearestUnit(sx, sy, filter) {
  let best = null, bd = 28;
  for (const u of state.units) {
    if (!filter(u)) continue;
    const p = toScreen(u.x, u.y), d = Math.hypot(p.x - sx, p.y - sy);
    if (d < bd) { bd = d; best = u; }
  }
  return best;
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
  if (mine) { ui.sel = mine.id; ui.mode = null; ui.append = false; syncButtons(); updatePanel(); return; }
  const u = selUnit();
  if (u && ui.mode) {
    setOrder(state, u, ui.mode, [{ x: wx, y: wy }], ui.append);
    const leg = u.legs[u.legs.length - 1];
    if (!leg || !leg.path.length) { u.legs.pop(); toast('その地点へは到達できません'); }
    else ui.append = true;
    saveGame(state);
    return;
  }
  const foe = nearestUnit(sx, sy, (e) => e.side === 'axis' && state.vis.ally.has(e.id));
  if (foe) { toast(`${foe.name}　兵力 ${Math.round(foe.hp)}%`); return; }
  ui.sel = null; ui.mode = null; syncButtons(); updatePanel();
}

function syncButtons() {
  $('btnPause').textContent = paused ? '▶ 再開' : '⏸ 一時停止';
  $('btnSpeed').textContent = `×${B.speeds[speedIdx]}`;
  const has = !!selUnit();
  for (const b of document.querySelectorAll('#cmdBar [data-mode]')) {
    b.disabled = !has;
    b.classList.toggle('on', has && ui.mode === b.dataset.mode);
  }
  $('btnDone').disabled = !(has && ui.mode);
  for (const [id, kind, label] of [['btnAir', 'air', '✈ 航空支援'], ['btnPara', 'para', '🪂 空挺']]) {
    const st = state ? state.support[kind] : { uses: 0, cd: 0 };
    const btn = $(id);
    btn.textContent = `${label} ×${st.uses}` + (st.cd > 0 ? `（${Math.ceil(st.cd)}秒）` : '');
    btn.disabled = !state || st.uses <= 0 || st.cd > 0;
    btn.classList.toggle('on', ui.support === kind);
  }
}

function setBar(id, v, max) {
  const row = $('r' + id);
  const fill = row.querySelector('i'), val = row.querySelector('b');
  if (!max) { fill.style.width = '0'; val.textContent = '—'; fill.classList.remove('low'); return; }
  const ratio = Math.max(0, Math.min(1, v / max));
  fill.style.width = (ratio * 100).toFixed(0) + '%';
  fill.classList.toggle('low', ratio < B.supply.lowLevel);
  val.textContent = Math.round(v);
}

function updatePanel() {
  const u = selUnit(), p = $('unitPanel');
  if (!u) { ui.sel = null; p.hidden = true; return; }
  p.hidden = false;
  const d = B.units[u.type];
  const st = [MODE_LABEL[u.mode]];
  if (u.engaged) st.push('交戦中'); else if (u.moving) st.push('移動中');
  if (u.stalled) st.push('燃料切れ');
  if (u.type === 'supply') st.push(u.linked ? '補給線 接続' : '補給線 遮断');
  $('unitName').textContent = u.name;
  $('unitMeta').textContent = `兵力 ${Math.round(u.hp)}%　${st.join('・')}`;
  setBar('Fuel', u.fuel, d.maxFuel); setBar('Ammo', u.ammo, d.maxAmmo); setBar('Food', u.food, d.maxFood);
  $('stockLine').textContent = u.stock
    ? `在庫 燃${Math.round(u.stock.fuel)} 弾${Math.round(u.stock.ammo)} 食${Math.round(u.stock.food)}` : '';
}

function renderLog() {
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
    t.textContent = fmt(e.t) + ' ';
    div.append(t, document.createTextNode(e.text));
    box.appendChild(div);
  }
}

function updateHud() {
  const c = state.cap;
  $('clock').textContent = `${fmt(state.time)} / ${fmt(B.timeLimit)}`;
  let t = '未占領';
  if (c.held) t = `占領中・防衛 ${Math.floor(c.hold)}/${B.holdTime}秒`;
  else if (c.progress > 0.5) t = `占領進行 ${Math.floor(c.progress)}/${B.captureTime}秒`;
  $('objStatus').textContent = `${state.objective.name}：${t}`;
  $('objStatus').classList.toggle('held', c.held);
  updatePanel(); syncButtons();
  if (logOpen) renderLog();
}

function finish() {
  resultShown = true; paused = true; clearSave();
  const win = state.result === 'win';
  const L = state.stats.lost;
  showOverlay(win ? '作戦成功' : '作戦失敗',
    `${state.objective.name}を${win ? '確保した' : '確保できなかった'}。\n経過時間 ${fmt(state.time)}\n連合軍の損失 ${L.ally}個大隊／ドイツ軍の損失 ${L.axis}個大隊`,
    [{ label: '新規作戦', fn: startNew, primary: true }, { label: '戦闘ログを見る', fn: () => { logOpen = true; $('logPanel').hidden = false; logSig = ''; renderLog(); } }]);
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
    hudTimer -= dt;
    if (hudTimer <= 0) { hudTimer = 0.25; updateHud(); }
    if (state.result && !resultShown) finish();
  }
  requestAnimationFrame(frame);
}

// ---- ボタン ----
$('btnPause').addEventListener('click', () => {
  if (!state || state.result) return;
  paused = !paused; syncButtons();
});
$('btnSpeed').addEventListener('click', () => { speedIdx = (speedIdx + 1) % B.speeds.length; syncButtons(); });
$('btnMenu').addEventListener('click', openMenu);
$('btnLog').addEventListener('click', () => {
  logOpen = !logOpen; $('logPanel').hidden = !logOpen;
  if (logOpen && state) { logSig = ''; renderLog(); }
});
$('btnLogClose').addEventListener('click', () => { logOpen = false; $('logPanel').hidden = true; });

for (const b of document.querySelectorAll('#cmdBar [data-mode]')) {
  b.addEventListener('click', () => {
    const u = selUnit();
    if (!u) { toast('先に部隊をタップして選択してください'); return; }
    const m = b.dataset.mode;
    ui.support = null;
    if (m === 'hold') { setOrder(state, u, 'hold', []); ui.mode = null; toast(`${u.name}：待機`); saveGame(state); }
    else { ui.mode = m; ui.append = false; toast(`${MODE_LABEL[m]}：目的地をタップ（続けてタップで経由地を追加）`); }
    syncButtons();
  });
}
$('btnDone').addEventListener('click', () => { ui.mode = null; ui.append = false; syncButtons(); });

for (const [id, kind] of [['btnAir', 'air'], ['btnPara', 'para']]) {
  $(id).addEventListener('click', () => {
    if (!state || state.result) return;
    ui.mode = null;
    ui.support = ui.support === kind ? null : kind;
    if (ui.support) toast(kind === 'air' ? '爆撃する地点をタップ' : '降下する地点をタップ');
    syncButtons();
  });
}

// ---- 自動保存 ----
setInterval(() => { if (state && !state.result && !paused) saveGame(state); }, B.save.interval * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state && !state.result) { paused = true; saveGame(state); syncButtons(); }
});
window.addEventListener('pagehide', () => { if (state && !state.result) saveGame(state); });

openMenu();
requestAnimationFrame(frame);

