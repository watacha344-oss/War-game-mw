// ================= 1) マップ =================
// マップ設定：広さ・地形の出来方・道路・目標地点。数値を変えるだけで調整できます。
// 座標の単位は「ワールド単位」（1セル = cell）。マップ全体は width x height。

const RIVER = { baseX: 1450, amplitude: 120, wavelength: 300, halfWidth: 50 };

// 河川の中心線（y座標に対するx座標）。橋の位置を決めるためにも使う
export function riverX(y) {
  return RIVER.baseX + RIVER.amplitude * Math.sin(y / RIVER.wavelength);
}

export const MAP = {
  width: 3000,            // マップの横幅
  height: 1800,           // マップの縦幅
  cell: 50,               // 地形・経路探索の1セルの大きさ
  seed: 1944,             // 地形生成の乱数シード（変えると森・丘の配置が変わる）
  forestScale: 260,       // 森のまとまりの大きさ（大きいほど大きな森）
  forestThreshold: 0.52,  // 小さいほど森が増える
  hillScale: 340,         // 丘のまとまりの大きさ
  hillThreshold: 0.62,    // 小さいほど丘が増える
  river: RIVER,

  // 強制的に地形を上書きする領域（t: 0=平地 1=森 2=丘）
  zones: [
    { x: 200, y: 900, r: 320, t: 0 },    // 連合軍の集結地は平地
    { x: 2500, y: 900, r: 170, t: 2 },   // 目標地点は丘
    { x: 2850, y: 900, r: 150, t: 0 },   // ドイツ軍補給集積所の周辺
  ],

  // 道路網（ノード名: [x, y]）。橋は道路が河川を横切る場所に自動で架かる
  nodes: {
    P0: [150, 900],                     // 連合軍 補給集積所
    A: [600, 700],
    B: [1000, 550],
    BR1: [riverX(550), 550],            // 北の橋
    C: [2000, 600],
    D: [600, 1100],
    E: [1000, 1250],
    BR2: [riverX(1250), 1250],          // 南の橋
    F: [1900, 1200],
    G: [2000, 900],
    OBJ: [2500, 900],                   // 目標地点（高地）
    ED: [2850, 900],                    // ドイツ軍 補給集積所
  },
  edges: [
    ['P0', 'A'], ['A', 'B'], ['B', 'BR1'], ['BR1', 'C'],
    ['P0', 'D'], ['D', 'E'], ['E', 'BR2'], ['BR2', 'F'],
    ['C', 'G'], ['G', 'F'], ['C', 'OBJ'], ['G', 'OBJ'], ['F', 'OBJ'],
    ['OBJ', 'ED'],
  ],

  depots: { ally: 'P0', axis: 'ED' },
  objective: { node: 'OBJ', radius: 130, name: '高地462' },
};

// ================= 2) 数値バランス =================
// 数値バランス設定。テンポや難易度はここで調整します。
// terrain は [平地, 森林, 丘陵, 河川, 橋] の移動倍率（0 は通行不可）。

export const BALANCE = {
  step: 0.25,             // シミュレーション1ステップの秒数
  timeLimit: 1080,        // 作戦の制限時間（秒）＝18分
  captureTime: 20,        // 目標を占領するのに必要な秒数
  holdTime: 120,          // 占領後に防衛し続ける秒数（勝利条件）
  speeds: [1, 2, 4],      // 進行速度の切り替え

  terrainDefense: [1, 0.8, 0.7, 1, 1], // 地形ごとの被ダメージ倍率
  defendBonus: 0.7,       // 防御態勢の被ダメージ倍率
  moveAttackFactor: 0.5,  // 移動しながら撃つときの攻撃力倍率
  noFoodFactor: 0.7,      // 食料切れ時の攻撃力倍率
  noFoodSpeed: 0.8,       // 食料切れ時の移動速度倍率
  forestVisionFactor: 0.5,// 森の中の敵を発見できる距離の倍率

  units: {
    inf: {
      name: '歩兵大隊', speed: 5, roadBonus: 1.3, terrain: [1, 0.7, 0.8, 0, 1],
      vision: 260, range: 130, attack: 1.6, ammoUse: 0.5, fuelUse: 0, foodUse: 0.12,
      maxFuel: 0, maxAmmo: 100, maxFood: 100, noAmmo: 0.15,
    },
    tank: {
      name: '戦車大隊', speed: 8, roadBonus: 1.7, terrain: [1, 0.4, 0.6, 0, 1],
      vision: 300, range: 170, attack: 2.6, ammoUse: 0.7, fuelUse: 0.3, foodUse: 0.12,
      maxFuel: 100, maxAmmo: 100, maxFood: 100, noAmmo: 0,
    },
    arty: {
      name: '砲兵大隊', speed: 5, roadBonus: 1.6, terrain: [1, 0.35, 0.5, 0, 1],
      vision: 200, range: 480, attack: 2.0, ammoUse: 0.8, fuelUse: 0.15, foodUse: 0.12,
      maxFuel: 100, maxAmmo: 100, maxFood: 100, noAmmo: 0, moveAttack: 0,
    },
    supply: {
      name: '補給大隊', speed: 7, roadBonus: 1.8, terrain: [1, 0.3, 0.45, 0, 1],
      vision: 200, range: 90, attack: 0.4, ammoUse: 0.2, fuelUse: 0.12, foodUse: 0.12,
      maxFuel: 100, maxAmmo: 100, maxFood: 100, noAmmo: 0,
    },
    recon: {
      name: '偵察大隊', speed: 10, roadBonus: 1.8, terrain: [1, 0.55, 0.7, 0, 1],
      vision: 480, range: 110, attack: 0.9, ammoUse: 0.3, fuelUse: 0.12, foodUse: 0.12,
      maxFuel: 100, maxAmmo: 100, maxFood: 100, noAmmo: 0,
    },
    para: {
      name: '空挺大隊', speed: 5, roadBonus: 1.3, terrain: [1, 0.75, 0.85, 0, 1],
      vision: 260, range: 130, attack: 1.8, ammoUse: 0.5, fuelUse: 0, foodUse: 0.12,
      maxFuel: 0, maxAmmo: 100, maxFood: 100, noAmmo: 0.15,
    },
  },

  // 兵科どうしの相性（攻撃側 → 防御側）。書かれていない組み合わせは 1.0
  typeMod: {
    inf:  { tank: 0.35, arty: 1.3, supply: 1.6, recon: 1.3 },
    tank: { inf: 1.3, arty: 1.6, supply: 1.8, recon: 1.6, para: 1.3 },
    arty: { tank: 0.6, inf: 1.1, para: 1.1 },
    para: { tank: 0.4, arty: 1.3, supply: 1.6, recon: 1.3 },
  },

  supply: {
    radius: 110,          // 補給部隊が補給できる距離
    depotRadius: 160,     // 補給集積所が補給できる距離
    linkRadius: 90,       // 補給部隊が道路に「接続」しているとみなす距離
    cutRadius: 70,        // 敵が道路ノードを遮断する距離
    transfer: { fuel: 6, ammo: 6, food: 3 },  // 1秒あたりの補給量
    refill: { fuel: 4, ammo: 4, food: 2 },    // 道路接続中の補給部隊の在庫回復量/秒
    stockMax: { fuel: 400, ammo: 400, food: 300 },
    lowLevel: 0.25,       // この割合を切ると警告ログを出す
  },

  support: {
    air: { uses: 2, cooldown: 90, delay: 5, radius: 130, damage: 38 },
    para: { uses: 1, cooldown: 180, delay: 8, strength: 75, supplyRatio: 0.6 },
  },

  log: { interval: 3, max: 200 },
  save: { interval: 10, key: 'divisionWargame.save.v1' },
};

// ================= 3) 敵AI =================
// ドイツ軍AIの挙動設定。

export const AI = {
  thinkInterval: 3,        // AIが状況を判断する間隔（秒）
  replanInterval: 12,      // 同じ部隊に新しい命令を出し直す最短間隔（秒）
  aggression: 0.6,         // 積極性 0〜1（大きいほど遠くの脅威にも予備隊が反応する）
  alertRadius: 900,        // 目標地点からこの距離（×(0.5+積極性)）に入った敵へ予備隊が出撃
  counterRadius: 700,      // 目標を奪われたとき、この距離内の部隊が奪還に向かう
  raidRadius: 900,         // 襲撃部隊が補給部隊を狙う距離
  returnRadius: 200,       // 持ち場からこれ以上離れたら戻る
  alarmProgress: 5,        // 占領進行がこの秒数を超えたら「奪われた」とみなす
  priority: ['supply', 'arty', 'tank', 'recon', 'inf', 'para'], // 狙う優先順位
  priorityWeight: 150,     // 優先順位1つ分の距離換算
};

// ================= 4) 作戦（部隊の初期配置） =================
// 作戦設定：部隊の初期配置。type は inf / tank / arty / supply / recon。
// role（ドイツ軍のみ）: garrison=持ち場を守る / reserve=予備隊（反撃） / raider=補給部隊を襲撃

export const SCENARIO = {
  title: '作戦「森の鉄槌」',
  briefing:
    '1944年冬、アルデンヌ。連合軍師団は西の集結地から東進し、' +
    '高地462を占領して120秒間確保せよ。\n' +
    '川に架かる橋は2本のみ。補給線（道路）を守り、森と丘を使って敵の守りを崩せ。\n\n' +
    '【操作】部隊をタップで選択 → 進軍/攻撃/防御を選び、地図をタップして目的地（続けてタップすると経由地）。' +
    '「待機」で停止。ドラッグで移動、ピンチで拡大縮小。一時停止中も命令できます。',
  ally: [
    { type: 'inf', x: 300, y: 760 }, { type: 'inf', x: 300, y: 840 },
    { type: 'inf', x: 300, y: 960 }, { type: 'inf', x: 300, y: 1040 },
    { type: 'tank', x: 220, y: 840 }, { type: 'tank', x: 220, y: 900 }, { type: 'tank', x: 220, y: 960 },
    { type: 'arty', x: 110, y: 800 }, { type: 'arty', x: 110, y: 1000 },
    { type: 'supply', x: 170, y: 870 }, { type: 'supply', x: 170, y: 930 },
    { type: 'recon', x: 380, y: 900 },
  ],
  axis: [
    { type: 'inf', x: 2420, y: 820, role: 'garrison' },
    { type: 'inf', x: 2420, y: 980, role: 'garrison' },
    { type: 'inf', x: 2570, y: 900, role: 'garrison' },
    { type: 'inf', x: 2330, y: 900, role: 'garrison' },
    { type: 'inf', x: 2480, y: 740, role: 'garrison' },
    { type: 'inf', x: 1730, y: 590, role: 'garrison' },   // 北の橋の前哨
    { type: 'inf', x: 1560, y: 1240, role: 'garrison' },  // 南の橋の前哨
    { type: 'tank', x: 2560, y: 770, role: 'reserve' },
    { type: 'tank', x: 2560, y: 1030, role: 'reserve' },
    { type: 'recon', x: 2300, y: 900, role: 'raider' },
    { type: 'arty', x: 2750, y: 860, role: 'garrison' },
    { type: 'supply', x: 2800, y: 950, role: 'garrison' },
  ],
};

