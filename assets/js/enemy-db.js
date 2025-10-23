// enemy-db.js
// 敵の見た目・挙動パラメータ一式と、ステージに応じた抽選ロジック
(function (global) {
  const defs = {
    swarm: {
      name: 'Swarm',
      icon: '🦂',
      size: 28,            // 見た目サイズの基準(px) → 当たり半径の計算に使用
      speed: 120,
      hp: 10,
      dmg: 8,
      reward: 10,
      atk: {
        range: 26,         // これ以内なら攻撃モードに移行（中心距離）
        windup: 0.50,      // 予備動作（静止）時間
        active: 0.20,      // 突き出し演出時間（0→最大まで左へズズッ）
        lunge: 12,         // 突き出し最大距離(px)（左寄りに演出）
        rate: 0.9,         // 1秒あたり攻撃回数（= クールダウン逆数）
        recoil: 0.18       // 余韻(硬直)
      }
    },
    runner: {
      name: 'Runner',
      icon: '🦅',
      size: 24,
      speed: 170,
      hp: 20,
      dmg: 10,
      reward: 10,
      atk: { range: 24, windup: 0.35, active: 0.16, lunge: 16, rate: 1.2, recoil: 0.12 }
    },
    tank: {
      name: 'Tank',
      icon: '🦏',
      size: 36,
      speed: 90,
      hp: 60,
      dmg: 20,
      reward: 40,
      atk: { range: 30, windup: 0.65, active: 0.22, lunge: 10, rate: 0.6, recoil: 0.22 }
    }
  };

  // ステージに応じたスポーン比率
  const weightTable = [
    { stageFrom: 1, stageTo: 3, p: { swarm: 0.70, runner: 0.20, tank: 0.10 } },
    { stageFrom: 4, stageTo: 7, p: { swarm: 0.55, runner: 0.30, tank: 0.15 } },
    { stageFrom: 8, stageTo: 10, p: { swarm: 0.45, runner: 0.33, tank: 0.22 } }
  ];

  function pick(chapter, stage) {
    const rule = weightTable.find(w => stage >= w.stageFrom && stage <= w.stageTo) || weightTable[0];
    const p = rule.p;
    const r = Math.random();
    let acc = 0;
    for (const k of Object.keys(p)) { acc += p[k]; if (r <= acc) return k; }
    return 'swarm';
  }

  function radiusFromSize(sizePx) { return (sizePx || 28) * 0.5; }

  global.EnemyDB = { defs, pick, radiusFromSize };
})(window);