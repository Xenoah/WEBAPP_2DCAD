/* solver.js — 幾何拘束 / 寸法拘束ソルバー（WEBAPP_2DCAD）
   依存なし。ブラウザ・Node 両対応。
   方式: 残差方程式を数値ヤコビアン + Levenberg-Marquardt（最小ノルム Gauss-Newton）で解く。
   診断: ヤコビアンのランクから 自由度 (DOF) / 冗長拘束数 を算出。収束しない場合は矛盾拘束の疑い。

   拘束の kind 一覧:
     幾何: coincident collinear concentric parallel perpendicular horizontal vertical
           tangent symmetric equal midpoint fix
     寸法: hdist vdist adist angle(度) radius diameter
   拘束オブジェクト: { id, kind, refs:[{id, pt?}], value?, data? }
     refs[].pt: 'start'|'end'|'mid'|'center'|null（line は start/end/mid、circle/arc は center/start/end、point は省略）
     data: 作成時に確定する符号・モード（tangent の接触側、hdist の向き、fix の座標など） */
'use strict';

const Solver = (() => {

  const VAR_DEFS = {
    line: ['x1', 'y1', 'x2', 'y2'],
    circle: ['cx', 'cy', 'r'],
    arc: ['cx', 'cy', 'r', 'a0', 'a1'],
    point: ['x', 'y']
  };

  function constrainable(e) { return !!VAR_DEFS[e.type]; }

  /* エンティティの参照点を実データから読む（app.js の描画・作成時にも使用） */
  function refPointOf(e, pt) {
    if (!e) return null;
    if (e.type === 'point') return { x: e.x, y: e.y };
    if (e.type === 'line') {
      if (pt === 'end') return { x: e.x2, y: e.y2 };
      if (pt === 'mid') return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
      return { x: e.x1, y: e.y1 };
    }
    if (e.type === 'circle') return { x: e.cx, y: e.cy };
    if (e.type === 'arc') {
      if (pt === 'start') return { x: e.cx + e.r * Math.cos(e.a0), y: e.cy + e.r * Math.sin(e.a0) };
      if (pt === 'end') return { x: e.cx + e.r * Math.cos(e.a1), y: e.cy + e.r * Math.sin(e.a1) };
      return { x: e.cx, y: e.cy };
    }
    return null;
  }

  function wrapPI(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /* ---------------- 連立方程式の構築 ---------------- */
  function buildSystem(ents, cons) {
    const entMap = new Map(ents.map(e => [e.id, e]));
    const idx = new Map();           // entId -> { ent, base }
    const x0 = [];
    const usedIds = new Set();
    for (const c of cons) for (const rf of c.refs) usedIds.add(rf.id);
    for (const id of usedIds) {
      const e = entMap.get(id);
      if (!e || !VAR_DEFS[e.type]) continue;
      idx.set(id, { ent: e, base: x0.length });
      for (const f of VAR_DEFS[e.type]) x0.push(e[f] || 0);
    }
    // 特性長（角度系残差を長さ次元に揃えるためのスケール）
    let L = 1;
    for (const [, rec] of idx) {
      if (rec.ent.type === 'line') L = Math.max(L, Math.hypot(rec.ent.x2 - rec.ent.x1, rec.ent.y2 - rec.ent.y1));
      if (rec.ent.r) L = Math.max(L, rec.ent.r);
    }

    const V = (x, id, f) => {
      const rec = idx.get(id);
      return x[rec.base + VAR_DEFS[rec.ent.type].indexOf(f)];
    };
    const refPt = (x, rf) => {
      const rec = idx.get(rf.id);
      const t = rec.ent.type;
      const g = f => V(x, rf.id, f);
      if (t === 'point') return { x: g('x'), y: g('y') };
      if (t === 'line') {
        if (rf.pt === 'end') return { x: g('x2'), y: g('y2') };
        if (rf.pt === 'mid') return { x: (g('x1') + g('x2')) / 2, y: (g('y1') + g('y2')) / 2 };
        return { x: g('x1'), y: g('y1') };
      }
      if (t === 'arc' && rf.pt === 'start') return { x: g('cx') + g('r') * Math.cos(g('a0')), y: g('cy') + g('r') * Math.sin(g('a0')) };
      if (t === 'arc' && rf.pt === 'end') return { x: g('cx') + g('r') * Math.cos(g('a1')), y: g('cy') + g('r') * Math.sin(g('a1')) };
      return { x: g('cx'), y: g('cy') };
    };
    const lineDir = (x, id) => ({ x: V(x, id, 'x2') - V(x, id, 'x1'), y: V(x, id, 'y2') - V(x, id, 'y1') });
    const radOf = (x, id) => V(x, id, 'r');
    const typeOf = id => idx.has(id) ? idx.get(id).ent.type : null;

    const eqs = [];   // { cid, f }
    const push = (c, f) => eqs.push({ cid: c.id, f });

    for (const c of cons) {
      if (!c.refs.every(rf => idx.has(rf.id))) continue;   // 参照切れ・非対応型は無効
      const [rA, rB, rC] = c.refs;
      const d = c.data || {};
      switch (c.kind) {
        case 'coincident': {
          push(c, x => refPt(x, rA).x - refPt(x, rB).x);
          push(c, x => refPt(x, rA).y - refPt(x, rB).y);
          break;
        }
        case 'horizontal': {
          if (c.refs.length >= 2) push(c, x => refPt(x, rA).y - refPt(x, rB).y);
          else push(c, x => V(x, rA.id, 'y2') - V(x, rA.id, 'y1'));
          break;
        }
        case 'vertical': {
          if (c.refs.length >= 2) push(c, x => refPt(x, rA).x - refPt(x, rB).x);
          else push(c, x => V(x, rA.id, 'x2') - V(x, rA.id, 'x1'));
          break;
        }
        case 'parallel': {
          push(c, x => {
            const a = lineDir(x, rA.id), b = lineDir(x, rB.id);
            const n = (Math.hypot(a.x, a.y) + 1e-12) * (Math.hypot(b.x, b.y) + 1e-12);
            return (a.x * b.y - a.y * b.x) / n * L;
          });
          break;
        }
        case 'perpendicular': {
          push(c, x => {
            const a = lineDir(x, rA.id), b = lineDir(x, rB.id);
            const n = (Math.hypot(a.x, a.y) + 1e-12) * (Math.hypot(b.x, b.y) + 1e-12);
            return (a.x * b.x + a.y * b.y) / n * L;
          });
          break;
        }
        case 'collinear': {
          push(c, x => {
            const a = lineDir(x, rA.id), b = lineDir(x, rB.id);
            const n = (Math.hypot(a.x, a.y) + 1e-12) * (Math.hypot(b.x, b.y) + 1e-12);
            return (a.x * b.y - a.y * b.x) / n * L;
          });
          push(c, x => {
            const a = lineDir(x, rA.id);
            const na = Math.hypot(a.x, a.y) + 1e-12;
            const px = V(x, rB.id, 'x1') - V(x, rA.id, 'x1');
            const py = V(x, rB.id, 'y1') - V(x, rA.id, 'y1');
            return (a.x * py - a.y * px) / na;
          });
          break;
        }
        case 'concentric': {
          const cx = id => typeOf(id) === 'point' ? 'x' : 'cx';
          const cy = id => typeOf(id) === 'point' ? 'y' : 'cy';
          push(c, x => V(x, rA.id, cx(rA.id)) - V(x, rB.id, cx(rB.id)));
          push(c, x => V(x, rA.id, cy(rA.id)) - V(x, rB.id, cy(rB.id)));
          break;
        }
        case 'tangent': {
          const tA = typeOf(rA.id), tB = typeOf(rB.id);
          if (tA === 'line' || tB === 'line') {
            const lid = tA === 'line' ? rA.id : rB.id;
            const cid = tA === 'line' ? rB.id : rA.id;
            const s = d.s || 1;
            push(c, x => {
              const dl = lineDir(x, lid);
              const n = Math.hypot(dl.x, dl.y) + 1e-12;
              const vx = V(x, cid, 'cx') - V(x, lid, 'x1');
              const vy = V(x, cid, 'cy') - V(x, lid, 'y1');
              return (dl.x * vy - dl.y * vx) / n - s * radOf(x, cid);
            });
          } else {
            // 円と円: ext=外接 int=内接
            const mode = d.mode || 'ext', sg = d.sg || 1;
            push(c, x => {
              const dx = V(x, rA.id, 'cx') - V(x, rB.id, 'cx');
              const dy = V(x, rA.id, 'cy') - V(x, rB.id, 'cy');
              const dd = Math.hypot(dx, dy);
              if (mode === 'ext') return dd - (radOf(x, rA.id) + radOf(x, rB.id));
              return dd - sg * (radOf(x, rA.id) - radOf(x, rB.id));
            });
          }
          break;
        }
        case 'symmetric': {
          // rA, rB: 対称点 / rC: 対称軸（line）
          const mir = (x, p) => {
            const px = V(x, rC.id, 'x1'), py = V(x, rC.id, 'y1');
            const dl = lineDir(x, rC.id);
            const n2 = dl.x * dl.x + dl.y * dl.y + 1e-12;
            const vx = p.x - px, vy = p.y - py;
            const t = (vx * dl.x + vy * dl.y) / n2;
            return { x: px + 2 * t * dl.x - vx, y: py + 2 * t * dl.y - vy };
          };
          push(c, x => mir(x, refPt(x, rA)).x - refPt(x, rB).x);
          push(c, x => mir(x, refPt(x, rA)).y - refPt(x, rB).y);
          break;
        }
        case 'equal': {
          const tA = typeOf(rA.id), tB = typeOf(rB.id);
          if (tA === 'line' && tB === 'line') {
            push(c, x => {
              const a = lineDir(x, rA.id), b = lineDir(x, rB.id);
              return Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y);
            });
          } else {
            push(c, x => radOf(x, rA.id) - radOf(x, rB.id));
          }
          break;
        }
        case 'midpoint': {
          // rA: 点参照 / rB: line
          push(c, x => refPt(x, rA).x - (V(x, rB.id, 'x1') + V(x, rB.id, 'x2')) / 2);
          push(c, x => refPt(x, rA).y - (V(x, rB.id, 'y1') + V(x, rB.id, 'y2')) / 2);
          break;
        }
        case 'fix': {
          if (rA.pt || typeOf(rA.id) === 'point') {
            push(c, x => refPt(x, rA).x - d.x);
            push(c, x => refPt(x, rA).y - d.y);
          } else if (typeOf(rA.id) === 'circle' || typeOf(rA.id) === 'arc') {
            push(c, x => V(x, rA.id, 'cx') - d.x);
            push(c, x => V(x, rA.id, 'cy') - d.y);
          } else { // line 全体固定
            push(c, x => V(x, rA.id, 'x1') - d.x1);
            push(c, x => V(x, rA.id, 'y1') - d.y1);
            push(c, x => V(x, rA.id, 'x2') - d.x2);
            push(c, x => V(x, rA.id, 'y2') - d.y2);
          }
          break;
        }
        case 'hdist': {
          const s = d.s || 1;
          push(c, x => (refPt(x, rB).x - refPt(x, rA).x) * s - c.value);
          break;
        }
        case 'vdist': {
          const s = d.s || 1;
          push(c, x => (refPt(x, rB).y - refPt(x, rA).y) * s - c.value);
          break;
        }
        case 'adist': {
          push(c, x => {
            const a = refPt(x, rA), b = refPt(x, rB);
            return Math.hypot(b.x - a.x, b.y - a.y) - c.value;
          });
          break;
        }
        case 'angle': {
          const target = c.value * Math.PI / 180;
          push(c, x => {
            const a = lineDir(x, rA.id), b = lineDir(x, rB.id);
            const ang = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
            return wrapPI(ang - target) * L;
          });
          break;
        }
        case 'radius': {
          push(c, x => radOf(x, rA.id) - c.value);
          break;
        }
        case 'diameter': {
          push(c, x => 2 * radOf(x, rA.id) - c.value);
          break;
        }
        default: break;
      }
    }
    return { idx, x0, eqs, L };
  }

  /* ---------------- 数値線形代数 ---------------- */
  function gaussSolve(A, b) {
    // A: m×m（破壊的）、b: m。解ベクトルを返す。特異なら null。
    const m = b.length;
    const x = b.slice();
    for (let col = 0; col < m; col++) {
      let piv = col;
      for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-14) return null;
      if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; const tb = x[piv]; x[piv] = x[col]; x[col] = tb; }
      const d0 = A[col][col];
      for (let r = col + 1; r < m; r++) {
        const f = A[r][col] / d0;
        if (!f) continue;
        for (let k = col; k < m; k++) A[r][k] -= f * A[col][k];
        x[r] -= f * x[col];
      }
    }
    for (let r = m - 1; r >= 0; r--) {
      let s = x[r];
      for (let k = r + 1; k < m; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  function matRank(J) {
    if (!J.length) return 0;
    const m = J.length, n = J[0].length;
    const A = J.map(row => row.slice());
    let maxNorm = 0;
    for (const row of A) maxNorm = Math.max(maxNorm, Math.hypot(...row));
    const tol = 1e-8 * (maxNorm + 1);
    let rank = 0;
    let col = 0;
    for (let row = 0; row < m && col < n; col++) {
      let piv = -1, best = tol;
      for (let r = row; r < m; r++) if (Math.abs(A[r][col]) > best) { best = Math.abs(A[r][col]); piv = r; }
      if (piv < 0) continue;
      const t = A[piv]; A[piv] = A[row]; A[row] = t;
      for (let r = 0; r < m; r++) {
        if (r === row) continue;
        const f = A[r][col] / A[row][col];
        if (!f) continue;
        for (let k = col; k < n; k++) A[r][k] -= f * A[row][k];
      }
      rank++; row++;
    }
    return rank;
  }

  /* ---------------- ソルバー本体 ---------------- */
  function solve(ents, cons, opts) {
    opts = opts || {};
    const sys = buildSystem(ents, cons);
    const n = sys.x0.length, m = sys.eqs.length;
    const result = {
      nVars: n, nEqs: m, converged: true, iters: 0, maxRes: 0,
      rank: 0, dof: n, redundant: 0,
      apply: () => {}
    };
    if (!m) return result;

    const evalR = xx => sys.eqs.map(e => e.f(xx));
    const jac = xx => {
      const r0 = evalR(xx);
      const J = [];
      for (let j = 0; j < m; j++) J.push(new Array(n));
      for (let i = 0; i < n; i++) {
        const h = 1e-6 * (1 + Math.abs(xx[i]));
        const xp = xx.slice(); xp[i] += h;
        const rp = evalR(xp);
        for (let j = 0; j < m; j++) J[j][i] = (rp[j] - r0[j]) / h;
      }
      return J;
    };
    const norm = v => Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    const maxAbs = v => v.reduce((a, b) => Math.max(a, Math.abs(b)), 0);
    const tol = (opts.tol || 1e-6) * sys.L;

    let x = sys.x0.slice();
    let r = evalR(x);
    let lambda = 1e-6;
    const maxIter = opts.maxIter || 80;
    let it = 0;
    for (; it < maxIter; it++) {
      if (maxAbs(r) < tol) break;
      const J = jac(x);
      let accepted = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        // (J Jᵀ + λI) y = -r,  dx = Jᵀ y  … 最小ノルム更新（現状から最も近い解へ）
        const A = [];
        for (let i = 0; i < m; i++) {
          A.push(new Array(m));
          for (let j = 0; j < m; j++) {
            let s = 0;
            for (let k = 0; k < n; k++) s += J[i][k] * J[j][k];
            A[i][j] = s + (i === j ? lambda * (1 + s) : 0);
          }
        }
        const y = gaussSolve(A, r.map(v => -v));
        if (!y) { lambda *= 10; continue; }
        const dx = new Array(n).fill(0);
        for (let k = 0; k < n; k++) for (let i = 0; i < m; i++) dx[k] += J[i][k] * y[i];
        const xNew = x.map((v, k) => v + dx[k]);
        const rNew = evalR(xNew);
        if (norm(rNew) < norm(r) || maxAbs(rNew) < tol) {
          x = xNew; r = rNew;
          lambda = Math.max(lambda / 3, 1e-10);
          accepted = true;
          break;
        }
        lambda *= 10;
      }
      if (!accepted) break; // 停滞（矛盾拘束の疑い）
    }
    result.iters = it;
    result.maxRes = maxAbs(r);
    result.converged = result.maxRes < tol * 10;

    // 診断（最終点のヤコビアン）
    const Jf = jac(x);
    result.rank = matRank(Jf);
    result.dof = Math.max(0, n - result.rank);
    result.redundant = Math.max(0, m - result.rank);

    result.apply = () => {
      for (const [, rec] of sys.idx) {
        const defs = VAR_DEFS[rec.ent.type];
        for (let i = 0; i < defs.length; i++) rec.ent[defs[i]] = x[rec.base + i];
        if (rec.ent.r != null) rec.ent.r = Math.max(1e-9, Math.abs(rec.ent.r));
      }
    };
    return result;
  }

  return { solve, constrainable, refPointOf, VAR_DEFS };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Solver;
}
