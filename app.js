/* app.js — WEBAPP_2DCAD 本体
   AutoCAD ライクなコマンド駆動 2D CAD。依存: dxf.js（先に読み込み） */
'use strict';

/* ================================================================ 状態 */
const S = {
  entities: [],                 // {id,type,layer,color(ACI|256=ByLayer),...}
  layers: [{ name: '0', color: 7, ltype: 'CONTINUOUS', on: true, locked: false }],
  clayer: '0',
  view: { ox: -20, oy: -20, scale: 2 },   // world→screen: sx=(wx-ox)*scale, sy=H-(wy-oy)*scale
  sel: new Set(),
  undoStack: [], redoStack: [],
  dirty: false,
  fileName: 'drawing.dxf',
  lastCmd: '', lastPoint: null, lastTextH: 5,
  nextId: 1,
  settings: {
    grid: true, gridSp: 10,
    snap: false, snapSp: 10,
    ortho: false, polar: false, polarAng: 45,
    osnap: true, osnapModes: { end: true, mid: true, cen: true, quad: true, int: true }
  },
  // ランタイム
  mouse: { sx: 0, sy: 0, on: false },
  curPt: { x: 0, y: 0 },
  snapMark: null,               // {x,y,kind}
  panDrag: null, leftDown: null, selBox: null, boxAnchor: null
};

/* ================================================================ DOM */
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const elLog = document.getElementById('cmd-log');
const elPrompt = document.getElementById('cmd-prompt');
const elInput = document.getElementById('cmd-input');
const elCoords = document.getElementById('status-coords');
const elZoom = document.getElementById('status-zoom');
const elFile = document.getElementById('file-input');
const elToast = document.getElementById('toast');

/* ================================================================ ユーティリティ */
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const angOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const deg = r => r * 180 / Math.PI;
const rad = d => d * Math.PI / 180;
const clone = o => JSON.parse(JSON.stringify(o));
const fmt = n => (Math.round(n * 10000) / 10000).toFixed(4);

function w2s(p) { return { x: (p.x - S.view.ox) * S.view.scale, y: canvas.clientHeight - (p.y - S.view.oy) * S.view.scale }; }
function s2w(sx, sy) { return { x: sx / S.view.scale + S.view.ox, y: (canvas.clientHeight - sy) / S.view.scale + S.view.oy }; }

function toast(msg, kind) {
  elToast.textContent = msg;
  elToast.className = 'show' + (kind === 'error' ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { elToast.className = ''; }, 3500);
}
function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  elLog.appendChild(d);
  while (elLog.children.length > 300) elLog.removeChild(elLog.firstChild);
  elLog.scrollTop = elLog.scrollHeight;
}
function setPrompt(t) { elPrompt.textContent = t || 'コマンド:'; }

function layerOf(e) { return S.layers.find(l => l.name === e.layer) || S.layers[0]; }
function colorOf(e) {
  const c = (e.color == null || e.color === 256) ? layerOf(e).color : e.color;
  return aciToHex(Math.abs(c) || 7);
}
function ltypeDash(name) {
  const scale = S.view.scale;
  const defs = { DASHED: [12.7, 6.35], CENTER: [31.75, 6.35, 6.35, 6.35], HIDDEN: [6.35, 3.175] };
  const p = defs[name];
  if (!p) return [];
  const px = p.map(v => Math.max(1.5, v * scale * 0.35));
  return px;
}

/* ================================================================ 幾何 */
function distPtSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function lineLineInt(p1, p2, p3, p4, seg) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  if (seg && (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9)) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}
function lineCircleInt(a, b, c, r, seg) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - c.x, fy = a.y - c.y;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-12) return [];
  const out = [];
  for (const sgn of [-1, 1]) {
    const t = (-B + sgn * Math.sqrt(disc)) / (2 * A);
    if (!seg || (t >= -1e-9 && t <= 1 + 1e-9)) out.push({ x: a.x + t * dx, y: a.y + t * dy });
  }
  return out;
}
function circleCircleInt(c1, r1, c2, r2) {
  const d = dist(c1, c2);
  if (d < 1e-12 || d > r1 + r2 || d < Math.abs(r1 - r2)) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  if (h2 < 0) return [];
  const h = Math.sqrt(h2);
  const mx = c1.x + a * (c2.x - c1.x) / d, my = c1.y + a * (c2.y - c1.y) / d;
  const px = -(c2.y - c1.y) / d, py = (c2.x - c1.x) / d;
  return [{ x: mx + h * px, y: my + h * py }, { x: mx - h * px, y: my - h * py }];
}
function ccwSpan(a0, a1) { return (a1 - a0 + Math.PI * 4) % (Math.PI * 2); }
function arcContains(arc, a) {
  return ccwSpan(arc.a0, a) <= ccwSpan(arc.a0, arc.a1) + 1e-9;
}
function arcPoint(arc, a) { return { x: arc.cx + arc.r * Math.cos(a), y: arc.cy + arc.r * Math.sin(a) }; }
function circumcircle(p1, p2, p3) {
  const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
}
/* bulge 付き pline セグメント → CCW 正規化円弧 */
function bulgeToArc(p1, p2, b) {
  const theta = 4 * Math.atan(b);
  const d = dist(p1, p2);
  if (d < 1e-12 || Math.abs(b) < 1e-12) return null;
  const r = Math.abs(d / (2 * Math.sin(theta / 2)));
  const h = (d / 2) / Math.tan(theta / 2);
  const nx = -(p2.y - p1.y) / d, ny = (p2.x - p1.x) / d;
  const cx = (p1.x + p2.x) / 2 + nx * h, cy = (p1.y + p2.y) / 2 + ny * h;
  let a0 = Math.atan2(p1.y - cy, p1.x - cx), a1 = Math.atan2(p2.y - cy, p2.x - cx);
  if (b < 0) { const t = a0; a0 = a1; a1 = t; }  // CCW 正規化
  return { cx, cy, r, a0, a1 };
}
/* pline を セグメント配列 [{kind:'line',a,b} | {kind:'arc',arc,a,b}] に分解 */
function plineSegs(e) {
  const out = [];
  const n = e.pts.length;
  const m = e.closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = e.pts[i], b = e.pts[(i + 1) % n];
    const arc = a.bulge ? bulgeToArc(a, b, a.bulge) : null;
    if (arc) out.push({ kind: 'arc', arc, a, b, bulge: a.bulge });
    else out.push({ kind: 'line', a, b });
  }
  return out;
}
function entBBox(e) {
  const pts = [];
  if (e.type === 'line') pts.push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
  else if (e.type === 'circle') pts.push({ x: e.cx - e.r, y: e.cy - e.r }, { x: e.cx + e.r, y: e.cy + e.r });
  else if (e.type === 'arc') {
    pts.push(arcPoint(e, e.a0), arcPoint(e, e.a1));
    for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2; if (arcContains(e, a)) pts.push(arcPoint(e, a)); }
  } else if (e.type === 'pline') {
    for (const s of plineSegs(e)) {
      pts.push(s.a, s.b);
      if (s.kind === 'arc') for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2; if (arcContains(s.arc, a)) pts.push(arcPoint(s.arc, a)); }
    }
    if (!e.closed && e.pts.length) pts.push(e.pts[e.pts.length - 1]);
  } else if (e.type === 'text') {
    const w = e.str.length * e.h * 0.9, hh = e.h * 1.2;
    const cs = Math.cos(e.rot || 0), sn = Math.sin(e.rot || 0);
    for (const [lx, ly] of [[0, 0], [w, 0], [w, hh], [0, hh]])
      pts.push({ x: e.x + lx * cs - ly * sn, y: e.y + lx * sn + ly * cs });
  } else if (e.type === 'point') pts.push({ x: e.x, y: e.y });
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}
function hitTest(e, p, tol) {
  if (e.type === 'line') return distPtSeg(p, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }) <= tol;
  if (e.type === 'circle') return Math.abs(dist(p, { x: e.cx, y: e.cy }) - e.r) <= tol;
  if (e.type === 'arc') {
    if (Math.abs(dist(p, { x: e.cx, y: e.cy }) - e.r) > tol) return false;
    return arcContains(e, Math.atan2(p.y - e.cy, p.x - e.cx));
  }
  if (e.type === 'pline') {
    for (const s of plineSegs(e)) {
      if (s.kind === 'line') { if (distPtSeg(p, s.a, s.b) <= tol) return true; }
      else {
        const c = { x: s.arc.cx, y: s.arc.cy };
        if (Math.abs(dist(p, c) - s.arc.r) <= tol && arcContains(s.arc, Math.atan2(p.y - c.y, p.x - c.x))) return true;
      }
    }
    return false;
  }
  if (e.type === 'text') { const b = entBBox(e); return b && p.x >= b.x0 - tol && p.x <= b.x1 + tol && p.y >= b.y0 - tol && p.y <= b.y1 + tol; }
  if (e.type === 'point') return dist(p, { x: e.x, y: e.y }) <= tol * 1.5;
  return false;
}

/* ================================================================ エンティティ変換 */
function mapPts(e, fn) {
  const c = clone(e);
  if (c.type === 'line') { const p1 = fn({ x: e.x1, y: e.y1 }), p2 = fn({ x: e.x2, y: e.y2 }); c.x1 = p1.x; c.y1 = p1.y; c.x2 = p2.x; c.y2 = p2.y; }
  else if (c.type === 'circle' || c.type === 'arc') { const p = fn({ x: e.cx, y: e.cy }); c.cx = p.x; c.cy = p.y; }
  else if (c.type === 'pline') c.pts = e.pts.map(p => Object.assign({}, p, fn(p)));
  else { const p = fn({ x: e.x, y: e.y }); c.x = p.x; c.y = p.y; }
  return c;
}
function translateEnt(e, dx, dy) { return mapPts(e, p => ({ x: p.x + dx, y: p.y + dy })); }
function rotateEnt(e, c, a) {
  const cs = Math.cos(a), sn = Math.sin(a);
  const rot = p => ({ x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn, y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cs });
  const o = mapPts(e, rot);
  if (o.type === 'arc') { o.a0 = e.a0 + a; o.a1 = e.a1 + a; }
  if (o.type === 'text') o.rot = (e.rot || 0) + a;
  return o;
}
function scaleEnt(e, c, f) {
  const sc = p => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f });
  const o = mapPts(e, sc);
  if (o.type === 'circle' || o.type === 'arc') o.r = e.r * f;
  if (o.type === 'text') o.h = e.h * f;
  return o;
}
function mirrorEnt(e, p1, p2) {
  const d = dist(p1, p2);
  if (d < 1e-9) return clone(e);
  const ux = (p2.x - p1.x) / d, uy = (p2.y - p1.y) / d;
  const t = Math.atan2(uy, ux);
  const ref = p => {
    const vx = p.x - p1.x, vy = p.y - p1.y;
    const dot = vx * ux + vy * uy;
    return { x: p1.x + 2 * dot * ux - vx, y: p1.y + 2 * dot * uy - vy };
  };
  const o = mapPts(e, ref);
  if (o.type === 'arc') { o.a0 = 2 * t - e.a1; o.a1 = 2 * t - e.a0; }
  if (o.type === 'pline') o.pts.forEach(p => { if (p.bulge) p.bulge = -p.bulge; });
  if (o.type === 'text') o.rot = 2 * t - (e.rot || 0);
  return o;
}

/* ================================================================ スナップ */
function entSnapPoints(e) {
  const out = [];
  const M = S.settings.osnapModes;
  if (e.type === 'line') {
    if (M.end) out.push({ x: e.x1, y: e.y1, kind: 'end' }, { x: e.x2, y: e.y2, kind: 'end' });
    if (M.mid) out.push({ x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, kind: 'mid' });
  } else if (e.type === 'circle') {
    if (M.cen) out.push({ x: e.cx, y: e.cy, kind: 'cen' });
    if (M.quad) for (let q = 0; q < 4; q++) out.push(Object.assign(arcPoint(e, q * Math.PI / 2), { kind: 'quad' }));
  } else if (e.type === 'arc') {
    if (M.end) out.push(Object.assign(arcPoint(e, e.a0), { kind: 'end' }), Object.assign(arcPoint(e, e.a1), { kind: 'end' }));
    if (M.mid) out.push(Object.assign(arcPoint(e, e.a0 + ccwSpan(e.a0, e.a1) / 2), { kind: 'mid' }));
    if (M.cen) out.push({ x: e.cx, y: e.cy, kind: 'cen' });
  } else if (e.type === 'pline') {
    for (const s of plineSegs(e)) {
      if (M.end) out.push({ x: s.a.x, y: s.a.y, kind: 'end' }, { x: s.b.x, y: s.b.y, kind: 'end' });
      if (M.mid) {
        if (s.kind === 'line') out.push({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2, kind: 'mid' });
        else out.push(Object.assign(arcPoint(s.arc, s.arc.a0 + ccwSpan(s.arc.a0, s.arc.a1) / 2), { kind: 'mid' }));
      }
    }
  } else if (e.type === 'point' || e.type === 'text') {
    if (M.end) out.push({ x: e.x, y: e.y, kind: 'end' });
  }
  return out;
}
function entIntSegs(e) {
  // 交点計算用のプリミティブ
  if (e.type === 'line') return [{ kind: 'line', a: { x: e.x1, y: e.y1 }, b: { x: e.x2, y: e.y2 } }];
  if (e.type === 'circle') return [{ kind: 'circle', c: { x: e.cx, y: e.cy }, r: e.r }];
  if (e.type === 'arc') return [{ kind: 'arcseg', arc: e }];
  if (e.type === 'pline') return plineSegs(e).map(s => s.kind === 'line' ? s : { kind: 'arcseg', arc: s.arc });
  return [];
}
function segInts(s1, s2) {
  const out = [];
  const asC = s => s.kind === 'circle' ? { c: s.c, r: s.r, arc: null } : { c: { x: s.arc.cx, y: s.arc.cy }, r: s.arc.r, arc: s.arc };
  if (s1.kind === 'line' && s2.kind === 'line') {
    const p = lineLineInt(s1.a, s1.b, s2.a, s2.b, true);
    if (p) out.push(p);
  } else if (s1.kind === 'line' || s2.kind === 'line') {
    const L = s1.kind === 'line' ? s1 : s2, C = asC(s1.kind === 'line' ? s2 : s1);
    for (const p of lineCircleInt(L.a, L.b, C.c, C.r, true))
      if (!C.arc || arcContains(C.arc, Math.atan2(p.y - C.c.y, p.x - C.c.x))) out.push(p);
  } else {
    const C1 = asC(s1), C2 = asC(s2);
    for (const p of circleCircleInt(C1.c, C1.r, C2.c, C2.r)) {
      if (C1.arc && !arcContains(C1.arc, Math.atan2(p.y - C1.c.y, p.x - C1.c.x))) continue;
      if (C2.arc && !arcContains(C2.arc, Math.atan2(p.y - C2.c.y, p.x - C2.c.x))) continue;
      out.push(p);
    }
  }
  return out;
}
function visibleEntities() { return S.entities.filter(e => layerOf(e).on !== false); }

function computeEffective(sx, sy, base) {
  let p = s2w(sx, sy);
  let mark = null;
  // グリッドスナップ
  if (S.settings.snap) {
    const g = S.settings.snapSp;
    p = { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  }
  // 直交 / 極トラッキング
  if (base) {
    if (S.settings.ortho) {
      if (Math.abs(p.x - base.x) >= Math.abs(p.y - base.y)) p = { x: p.x, y: base.y };
      else p = { x: base.x, y: p.y };
    } else if (S.settings.polar) {
      const inc = rad(S.settings.polarAng);
      const th = angOf(base, p);
      const snapTh = Math.round(th / inc) * inc;
      if (Math.abs(((th - snapTh + Math.PI) % (Math.PI * 2)) - Math.PI) < rad(6)) {
        const d = dist(base, p) * Math.cos(th - snapTh);
        p = { x: base.x + d * Math.cos(snapTh), y: base.y + d * Math.sin(snapTh) };
      }
    }
  }
  // オブジェクトスナップ（最優先）
  if (S.settings.osnap) {
    const apPx = 12;
    const tolW = apPx / S.view.scale;
    const raw = s2w(sx, sy);
    let best = null, bestD = tolW;
    const nearEnts = [];
    for (const e of visibleEntities()) {
      const b = entBBox(e);
      if (!b) continue;
      if (raw.x < b.x0 - tolW * 2 || raw.x > b.x1 + tolW * 2 || raw.y < b.y0 - tolW * 2 || raw.y > b.y1 + tolW * 2) continue;
      nearEnts.push(e);
      for (const sp of entSnapPoints(e)) {
        const d = dist(raw, sp);
        if (d < bestD) { bestD = d; best = sp; }
      }
    }
    // 交点
    if (S.settings.osnapModes.int && nearEnts.length >= 2 && nearEnts.length <= 40) {
      for (let i = 0; i < nearEnts.length; i++) for (let j = i + 1; j < nearEnts.length; j++) {
        for (const s1 of entIntSegs(nearEnts[i])) for (const s2 of entIntSegs(nearEnts[j])) {
          for (const ip of segInts(s1, s2)) {
            const d = dist(raw, ip);
            if (d < bestD) { bestD = d; best = { x: ip.x, y: ip.y, kind: 'int' }; }
          }
        }
      }
    }
    if (best) { p = { x: best.x, y: best.y }; mark = best; }
  }
  return { pt: p, mark };
}

/* ================================================================ 描画 */
let redrawQueued = false;
function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; redraw(); });
}
function redraw() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#212830';
  ctx.fillRect(0, 0, W, H);
  drawGrid(W, H);
  for (const e of S.entities) {
    if (layerOf(e).on === false) continue;
    drawEnt(ctx, e);
  }
  // 選択ハイライト + グリップ
  const selSet = Engine.tempSel && Engine.tempSel.size ? new Set([...S.sel, ...Engine.tempSel]) : S.sel;
  for (const id of selSet) {
    const e = S.entities.find(x => x.id === id);
    if (e && layerOf(e).on !== false) drawEnt(ctx, e, { dash: [4, 4] });
  }
  for (const id of selSet) {
    const e = S.entities.find(x => x.id === id);
    if (e && layerOf(e).on !== false) drawGrips(e);
  }
  // コマンドプレビュー
  if (Engine.req && Engine.req.preview && S.mouse.on) {
    ctx.save();
    Engine.req.preview(ctx, S.curPt);
    ctx.restore();
  }
  // 選択ボックス
  drawSelBox();
  // スナップマーカー
  if (S.snapMark && S.mouse.on && wantsPoint()) drawSnapMark(S.snapMark);
  // 十字カーソル
  if (S.mouse.on) drawCrosshair(W, H);
  elZoom.textContent = Math.round(S.view.scale * 100) + '%';
}
function drawGrid(W, H) {
  if (!S.settings.grid) { drawAxes(); return; }
  let sp = S.settings.gridSp;
  while (sp * S.view.scale < 8) sp *= 10;
  while (sp * S.view.scale > 120) sp /= 10;
  const w0 = s2w(0, H), w1 = s2w(W, 0);
  ctx.lineWidth = 1;
  const startX = Math.floor(w0.x / sp) * sp, startY = Math.floor(w0.y / sp) * sp;
  for (let x = startX; x <= w1.x; x += sp) {
    const major = Math.abs(x / (sp * 10) - Math.round(x / (sp * 10))) < 1e-6;
    ctx.strokeStyle = major ? '#39424e' : '#2a323c';
    const s = w2s({ x, y: 0 });
    ctx.beginPath(); ctx.moveTo(s.x + 0.5, 0); ctx.lineTo(s.x + 0.5, H); ctx.stroke();
  }
  for (let y = startY; y <= w1.y; y += sp) {
    const major = Math.abs(y / (sp * 10) - Math.round(y / (sp * 10))) < 1e-6;
    ctx.strokeStyle = major ? '#39424e' : '#2a323c';
    const s = w2s({ x: 0, y });
    ctx.beginPath(); ctx.moveTo(0, s.y + 0.5); ctx.lineTo(W, s.y + 0.5); ctx.stroke();
  }
  drawAxes();
}
function drawAxes() {
  const o = w2s({ x: 0, y: 0 });
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#8b3a3a';
  ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + 40, o.y); ctx.stroke();
  ctx.strokeStyle = '#3a8b3a';
  ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x, o.y - 40); ctx.stroke();
}
function drawEnt(g, e, opt) {
  opt = opt || {};
  const col = opt.color || colorOf(e);
  g.strokeStyle = col;
  g.fillStyle = col;
  g.lineWidth = opt.lw || 1.4;
  g.setLineDash(opt.dash || ltypeDash((layerOf(e).ltype || 'CONTINUOUS')));
  if (e.type === 'line') {
    const a = w2s({ x: e.x1, y: e.y1 }), b = w2s({ x: e.x2, y: e.y2 });
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  } else if (e.type === 'circle') {
    const c = w2s({ x: e.cx, y: e.cy });
    g.beginPath(); g.arc(c.x, c.y, e.r * S.view.scale, 0, Math.PI * 2); g.stroke();
  } else if (e.type === 'arc') {
    const c = w2s({ x: e.cx, y: e.cy });
    g.beginPath(); g.arc(c.x, c.y, e.r * S.view.scale, -e.a0, -e.a1, true); g.stroke();
  } else if (e.type === 'pline') {
    g.beginPath();
    const p0 = w2s(e.pts[0]);
    g.moveTo(p0.x, p0.y);
    const n = e.pts.length, m = e.closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = e.pts[i], b = e.pts[(i + 1) % n];
      if (a.bulge) {
        const arc = bulgeToArc(a, b, a.bulge);
        if (arc) {
          const c = w2s({ x: arc.cx, y: arc.cy });
          const aa = Math.atan2(a.y - arc.cy, a.x - arc.cx), ab = Math.atan2(b.y - arc.cy, b.x - arc.cx);
          g.arc(c.x, c.y, arc.r * S.view.scale, -aa, -ab, a.bulge > 0);
          continue;
        }
      }
      const sb = w2s(b);
      g.lineTo(sb.x, sb.y);
    }
    if (e.closed) g.closePath();
    g.stroke();
  } else if (e.type === 'text') {
    const p = w2s({ x: e.x, y: e.y });
    g.save();
    g.setLineDash([]);
    g.translate(p.x, p.y);
    g.rotate(-(e.rot || 0));
    g.font = Math.max(2, e.h * S.view.scale) + 'px "Yu Gothic", "Meiryo", sans-serif';
    g.textBaseline = 'alphabetic';
    g.fillText(e.str, 0, 0);
    if (opt.dash) { // 選択時は枠
      const w = g.measureText(e.str).width;
      g.setLineDash([4, 4]);
      g.strokeRect(0, 2, w, -e.h * S.view.scale * 1.15);
    }
    g.restore();
  } else if (e.type === 'point') {
    const p = w2s({ x: e.x, y: e.y });
    g.setLineDash([]);
    g.beginPath(); g.moveTo(p.x - 4, p.y); g.lineTo(p.x + 4, p.y); g.moveTo(p.x, p.y - 4); g.lineTo(p.x, p.y + 4); g.stroke();
  }
  g.setLineDash([]);
}
function drawGrips(e) {
  let pts = [];
  if (e.type === 'line') pts = [{ x: e.x1, y: e.y1 }, { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 }, { x: e.x2, y: e.y2 }];
  else if (e.type === 'circle') { pts = [{ x: e.cx, y: e.cy }]; for (let q = 0; q < 4; q++) pts.push(arcPoint(e, q * Math.PI / 2)); }
  else if (e.type === 'arc') pts = [{ x: e.cx, y: e.cy }, arcPoint(e, e.a0), arcPoint(e, e.a1), arcPoint(e, e.a0 + ccwSpan(e.a0, e.a1) / 2)];
  else if (e.type === 'pline') pts = e.pts;
  else pts = [{ x: e.x, y: e.y }];
  ctx.fillStyle = '#2f7fff';
  ctx.strokeStyle = '#dce6f5';
  ctx.lineWidth = 1;
  for (const p of pts) {
    const s = w2s(p);
    ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
    ctx.strokeRect(s.x - 4.5, s.y - 4.5, 9, 9);
  }
}
function drawSnapMark(m) {
  const p = w2s(m);
  ctx.strokeStyle = '#ffb400';
  ctx.lineWidth = 1.8;
  ctx.setLineDash([]);
  ctx.beginPath();
  if (m.kind === 'end') ctx.strokeRect(p.x - 5, p.y - 5, 10, 10);
  else if (m.kind === 'mid') { ctx.moveTo(p.x, p.y - 6); ctx.lineTo(p.x - 6, p.y + 5); ctx.lineTo(p.x + 6, p.y + 5); ctx.closePath(); ctx.stroke(); }
  else if (m.kind === 'cen') { ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2); ctx.stroke(); }
  else if (m.kind === 'quad') { ctx.moveTo(p.x, p.y - 6); ctx.lineTo(p.x + 6, p.y); ctx.lineTo(p.x, p.y + 6); ctx.lineTo(p.x - 6, p.y); ctx.closePath(); ctx.stroke(); }
  else if (m.kind === 'int') { ctx.moveTo(p.x - 5, p.y - 5); ctx.lineTo(p.x + 5, p.y + 5); ctx.moveTo(p.x + 5, p.y - 5); ctx.lineTo(p.x - 5, p.y + 5); ctx.stroke(); }
}
function drawCrosshair(W, H) {
  const { sx, sy } = S.mouse;
  ctx.strokeStyle = 'rgba(220,230,240,0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(0, sy + 0.5); ctx.lineTo(W, sy + 0.5);
  ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, H);
  ctx.stroke();
  if (wantsPoint() || !Engine.gen || (Engine.req && Engine.req.type === 'select')) {
    ctx.strokeRect(sx - 4.5, sy - 4.5, 9, 9);
  }
}
function drawSelBox() {
  let a = null, b = null;
  if (S.selBox) { a = S.selBox.a; b = { x: S.mouse.sx, y: S.mouse.sy }; }
  else if (S.boxAnchor) { a = S.boxAnchor; b = { x: S.mouse.sx, y: S.mouse.sy }; }
  if (!a || !b) return;
  const crossing = b.x < a.x;
  ctx.fillStyle = crossing ? 'rgba(80,200,80,0.12)' : 'rgba(70,130,255,0.12)';
  ctx.strokeStyle = crossing ? '#5c5' : '#59f';
  ctx.setLineDash(crossing ? [5, 4] : []);
  ctx.lineWidth = 1;
  ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  ctx.setLineDash([]);
}
function ghost(g, ents) {
  for (const e of ents) drawEnt(g, e, { color: '#9aa7b5', dash: [5, 4] });
}
function gline(g, a, b, color) {
  const sa = w2s(a), sb = w2s(b);
  g.strokeStyle = color || '#9aa7b5';
  g.setLineDash([5, 4]);
  g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(sa.x, sa.y); g.lineTo(sb.x, sb.y); g.stroke();
  g.setLineDash([]);
}
function wantsPoint() {
  return Engine.req && ['point', 'dist', 'angle', 'pickone'].includes(Engine.req.type);
}

/* ================================================================ 履歴 */
function snapshot() { return { entities: clone(S.entities), layers: clone(S.layers), clayer: S.clayer }; }
function applySnapshot(sn) {
  S.entities = clone(sn.entities);
  S.layers = clone(sn.layers);
  S.clayer = sn.clayer;
  S.sel.clear();
  renderLayers(); renderProps(); scheduleRedraw();
}
function pushHistory() {
  S.undoStack.push(snapshot());
  if (S.undoStack.length > 100) S.undoStack.shift();
  S.redoStack = [];
  S.dirty = true;
  updateTitle();
}
function undo() {
  if (!S.undoStack.length) { log('元に戻す対象がありません'); return; }
  if (Engine.gen) Engine.cancel();
  S.redoStack.push(snapshot());
  applySnapshot(S.undoStack.pop());
  S.dirty = true; updateTitle();
  log('UNDO');
}
function redoOp() {
  if (!S.redoStack.length) { log('やり直す対象がありません'); return; }
  if (Engine.gen) Engine.cancel();
  S.undoStack.push(snapshot());
  applySnapshot(S.redoStack.pop());
  S.dirty = true; updateTitle();
  log('REDO');
}
function updateTitle() {
  document.title = (S.dirty ? '● ' : '') + S.fileName + ' — WEBAPP 2DCAD';
}

/* ================================================================ コマンドエンジン */
const Engine = {
  gen: null, req: null, name: '', usedSel: false, histPushed: false, tempSel: null,
  start(name, def) {
    if (this.gen) this.cancel(true);
    this.name = name;
    this.usedSel = false;
    this.histPushed = false;
    S.lastCmd = name;
    log('コマンド: ' + name, 'cmd');
    if (def.run) { def.run(); this.finishOk(); return; }
    this.gen = def.fn();
    this.resume(undefined);
  },
  resume(value) {
    if (!this.gen) return;
    let r;
    try { r = this.gen.next(value); }
    catch (err) { console.error(err); toast('コマンドエラー: ' + err.message, 'error'); this.hardReset(); return; }
    if (r.done) this.finishOk();
    else this.setReq(r.value);
    scheduleRedraw();
  },
  setReq(req) {
    if (req.type === 'select' && S.sel.size) {
      this.usedSel = true;
      this.req = null;
      const ids = [...S.sel];
      log(ids.length + ' 個が選択されています（先行選択）');
      return this.resume(ids);
    }
    if (req.type === 'select') { this.usedSel = true; this.tempSel = new Set(); }
    this.req = req;
    setPrompt(req.prompt);
  },
  confirmSelect() {
    const ids = [...(this.tempSel || [])];
    for (const id of ids) S.sel.add(id);
    this.tempSel = null;
    this.req = null;
    selChanged();
    this.resume(ids);
  },
  finishOk() {
    if (this.usedSel) S.sel.clear();
    this.gen = null; this.req = null; this.tempSel = null; this.name = '';
    setPrompt('コマンド:');
    selChanged();
  },
  cancel(silent) {
    if (!this.gen) { S.sel.clear(); S.boxAnchor = null; selChanged(); return; }
    try { this.gen.return(); } catch (e) { /* noop */ }
    if (!silent) log('*キャンセル*');
    if (this.usedSel) S.sel.clear();
    this.hardReset();
  },
  hardReset() {
    this.gen = null; this.req = null; this.tempSel = null; this.name = '';
    S.boxAnchor = null; S.selBox = null;
    setPrompt('コマンド:');
    selChanged();
  },
  mutate() {
    if (!this.histPushed) { pushHistory(); this.histPushed = true; }
    S.dirty = true; updateTitle();
  }
};

/* リクエストヘルパ */
const P = (prompt, opts) => Object.assign({ type: 'point', prompt }, opts || {});
const SEL = prompt => ({ type: 'select', prompt });
const PICK = prompt => ({ type: 'pickone', prompt });
const DST = (prompt, opts) => Object.assign({ type: 'dist', prompt }, opts || {});
const ANG = (prompt, opts) => Object.assign({ type: 'angle', prompt }, opts || {});
const STR = (prompt, opts) => Object.assign({ type: 'string', prompt }, opts || {});
const KW = (prompt, keywords, def) => ({ type: 'keyword', prompt, keywords, def });

function addEntity(props) {
  const e = Object.assign({ id: S.nextId++, layer: S.clayer, color: 256 }, props);
  S.entities.push(e);
  scheduleRedraw();
  return e;
}
function removeIds(ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  S.entities = S.entities.filter(e => !set.has(e.id));
  for (const id of set) S.sel.delete(id);
  scheduleRedraw();
}
function entsOf(ids) { const set = new Set(ids); return S.entities.filter(e => set.has(e.id)); }
function filterUnlocked(ids) {
  const ok = entsOf(ids).filter(e => !layerOf(e).locked).map(e => e.id);
  if (ok.length < ids.length) log((ids.length - ok.length) + ' 個はロック画層のため対象外です');
  return ok;
}
function replaceEnts(newOnes) {
  const map = new Map(newOnes.map(e => [e.id, e]));
  S.entities = S.entities.map(e => map.get(e.id) || e);
  scheduleRedraw();
}

/* ================================================================ コマンド実装 */
function* cmdLINE() {
  const pts = [];
  let p = yield P('始点を指定:');
  if (!p) return;
  pts.push(p);
  const added = [];
  while (true) {
    const prev = pts[pts.length - 1];
    const res = yield P('次の点を指定 または [' + (pts.length > 1 ? '閉じる(C)/' : '') + '元に戻す(U)]:', {
      base: prev, allowEnter: true,
      keywords: pts.length > 1 ? ['C', 'U'] : ['U'],
      preview: (g, cur) => gline(g, prev, cur, colorOf({ layer: S.clayer, color: 256 }))
    });
    if (res == null) return;
    if (res.kw === 'U') {
      if (added.length) { const id = added.pop(); removeIds([id]); pts.pop(); }
      else if (pts.length > 1) pts.pop();
      else { log('取り消す点がありません'); }
      continue;
    }
    if (res.kw === 'C') {
      if (pts.length > 1) { Engine.mutate(); addEntity({ type: 'line', x1: pts[pts.length - 1].x, y1: pts[pts.length - 1].y, x2: pts[0].x, y2: pts[0].y }); }
      return;
    }
    Engine.mutate();
    const e = addEntity({ type: 'line', x1: prev.x, y1: prev.y, x2: res.x, y2: res.y });
    added.push(e.id);
    pts.push(res);
    S.lastPoint = res;
  }
}
function* cmdCIRCLE() {
  const c = yield P('円の中心点を指定:');
  if (!c) return;
  let r = yield DST('円の半径を指定 または [直径(D)]:', {
    base: c, keywords: ['D'],
    preview: (g, cur) => {
      gline(g, c, cur);
      const s = w2s(c);
      g.strokeStyle = '#9aa7b5'; g.setLineDash([5, 4]);
      g.beginPath(); g.arc(s.x, s.y, dist(c, cur) * S.view.scale, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
  });
  if (r && r.kw === 'D') {
    const d = yield DST('円の直径を指定:', { base: c });
    if (d == null) return;
    r = d / 2;
  }
  if (r == null || r <= 0) return;
  Engine.mutate();
  addEntity({ type: 'circle', cx: c.x, cy: c.y, r });
}
function* cmdARC() {
  const p1 = yield P('円弧の始点を指定:');
  if (!p1) return;
  const p2 = yield P('円弧の2点目を指定:', { base: p1, preview: (g, cur) => gline(g, p1, cur) });
  if (!p2) return;
  const p3 = yield P('円弧の終点を指定:', {
    base: p2,
    preview: (g, cur) => {
      const cc = circumcircle(p1, p2, cur);
      if (!cc) { gline(g, p1, p2); gline(g, p2, cur); return; }
      const arc = arcFrom3(p1, p2, cur, cc);
      drawEnt(g, Object.assign({ type: 'arc', layer: S.clayer, color: 256 }, arc), { color: '#9aa7b5', dash: [5, 4] });
    }
  });
  if (!p3) return;
  const cc = circumcircle(p1, p2, p3);
  if (!cc) { toast('3点が一直線上にあるため円弧を作成できません', 'error'); return; }
  Engine.mutate();
  addEntity(Object.assign({ type: 'arc' }, arcFrom3(p1, p2, p3, cc)));
}
function arcFrom3(p1, p2, p3, cc) {
  const a0 = Math.atan2(p1.y - cc.y, p1.x - cc.x);
  const am = Math.atan2(p2.y - cc.y, p2.x - cc.x);
  const a1 = Math.atan2(p3.y - cc.y, p3.x - cc.x);
  const ccw = ccwSpan(a0, am) <= ccwSpan(a0, a1);
  return ccw ? { cx: cc.x, cy: cc.y, r: cc.r, a0, a1 } : { cx: cc.x, cy: cc.y, r: cc.r, a0: a1, a1: a0 };
}
function* cmdPLINE() {
  const pts = [];
  let p = yield P('始点を指定:');
  if (!p) return;
  pts.push({ x: p.x, y: p.y, bulge: 0 });
  let closed = false;
  while (true) {
    const prev = pts[pts.length - 1];
    const res = yield P('次の点を指定 または [' + (pts.length > 1 ? '閉じる(C)/' : '') + '元に戻す(U)]:', {
      base: prev, allowEnter: true,
      keywords: pts.length > 1 ? ['C', 'U'] : ['U'],
      preview: (g, cur) => {
        for (let i = 0; i + 1 < pts.length; i++) gline(g, pts[i], pts[i + 1]);
        gline(g, prev, cur);
      }
    });
    if (res == null) break;
    if (res.kw === 'U') { if (pts.length > 1) pts.pop(); continue; }
    if (res.kw === 'C') { closed = true; break; }
    pts.push({ x: res.x, y: res.y, bulge: 0 });
    S.lastPoint = res;
  }
  if (pts.length >= 2) {
    Engine.mutate();
    addEntity({ type: 'pline', pts, closed });
  }
}
function* cmdRECTANG() {
  const p1 = yield P('一方のコーナーを指定:');
  if (!p1) return;
  const p2 = yield P('もう一方のコーナーを指定:', {
    base: p1,
    preview: (g, cur) => {
      gline(g, p1, { x: cur.x, y: p1.y }); gline(g, { x: cur.x, y: p1.y }, cur);
      gline(g, cur, { x: p1.x, y: cur.y }); gline(g, { x: p1.x, y: cur.y }, p1);
    }
  });
  if (!p2) return;
  Engine.mutate();
  addEntity({
    type: 'pline', closed: true,
    pts: [{ x: p1.x, y: p1.y, bulge: 0 }, { x: p2.x, y: p1.y, bulge: 0 }, { x: p2.x, y: p2.y, bulge: 0 }, { x: p1.x, y: p2.y, bulge: 0 }]
  });
}
function* cmdPOINT() {
  while (true) {
    const p = yield P('点を指定 <終了>:', { allowEnter: true });
    if (!p || p.kw) return;
    Engine.mutate();
    addEntity({ type: 'point', x: p.x, y: p.y });
    S.lastPoint = p;
  }
}
function* cmdTEXT() {
  const p = yield P('文字列の挿入基点を指定:');
  if (!p) return;
  let h = yield DST('文字の高さを指定 <' + fmt(S.lastTextH) + '>:', { base: p, def: S.lastTextH });
  if (h == null) return;
  if (h.kw) h = S.lastTextH;
  if (h <= 0) h = S.lastTextH;
  let a = yield ANG('文字列の角度を指定 <0>:', { base: p, def: 0 });
  if (a == null) a = 0;
  const str = yield STR('文字列を入力:');
  if (!str) return;
  S.lastTextH = h;
  Engine.mutate();
  addEntity({ type: 'text', x: p.x, y: p.y, h, rot: a, str });
}
function* cmdMOVE() {
  let ids = yield SEL('オブジェクトを選択:');
  ids = filterUnlocked(ids);
  if (!ids.length) { log('オブジェクトが選択されていません'); return; }
  const base = yield P('基点を指定:');
  if (!base) return;
  const to = yield P('目的点を指定:', {
    base,
    preview: (g, cur) => { gline(g, base, cur); ghost(g, entsOf(ids).map(e => translateEnt(e, cur.x - base.x, cur.y - base.y))); }
  });
  if (!to) return;
  Engine.mutate();
  replaceEnts(entsOf(ids).map(e => translateEnt(e, to.x - base.x, to.y - base.y)));
  log(ids.length + ' 個を移動しました');
}
function* cmdCOPY() {
  let ids = yield SEL('オブジェクトを選択:');
  ids = filterUnlocked(ids);
  if (!ids.length) { log('オブジェクトが選択されていません'); return; }
  const base = yield P('基点を指定:');
  if (!base) return;
  let n = 0;
  while (true) {
    const to = yield P('2点目を指定 <終了>:', {
      base, allowEnter: true,
      preview: (g, cur) => { gline(g, base, cur); ghost(g, entsOf(ids).map(e => translateEnt(e, cur.x - base.x, cur.y - base.y))); }
    });
    if (!to || to.kw) break;
    Engine.mutate();
    for (const e of entsOf(ids)) {
      const c = translateEnt(e, to.x - base.x, to.y - base.y);
      c.id = S.nextId++;
      S.entities.push(c);
    }
    n++;
    S.lastPoint = to;
    scheduleRedraw();
  }
  if (n) log(n + ' 回複写しました');
}
function* cmdROTATE() {
  let ids = yield SEL('オブジェクトを選択:');
  ids = filterUnlocked(ids);
  if (!ids.length) { log('オブジェクトが選択されていません'); return; }
  const base = yield P('基点を指定:');
  if (!base) return;
  const a = yield ANG('回転角度を指定:', {
    base,
    preview: (g, cur) => { gline(g, base, cur); ghost(g, entsOf(ids).map(e => rotateEnt(e, base, angOf(base, cur)))); }
  });
  if (a == null) return;
  Engine.mutate();
  replaceEnts(entsOf(ids).map(e => rotateEnt(e, base, a)));
  log('回転角度: ' + fmt(deg(a)) + '°');
}
function* cmdSCALE() {
  let ids = yield SEL('オブジェクトを選択:');
  ids = filterUnlocked(ids);
  if (!ids.length) { log('オブジェクトが選択されていません'); return; }
  const base = yield P('基点を指定:');
  if (!base) return;
  const f = yield DST('尺度を指定:', {
    base,
    preview: (g, cur) => { gline(g, base, cur); const ff = Math.max(1e-6, dist(base, cur)); ghost(g, entsOf(ids).map(e => scaleEnt(e, base, ff))); }
  });
  if (f == null || f <= 0) { if (f != null) toast('尺度は正の値で指定してください', 'error'); return; }
  Engine.mutate();
  replaceEnts(entsOf(ids).map(e => scaleEnt(e, base, f)));
  log('尺度: ' + fmt(f));
}
function* cmdMIRROR() {
  let ids = yield SEL('オブジェクトを選択:');
  ids = filterUnlocked(ids);
  if (!ids.length) { log('オブジェクトが選択されていません'); return; }
  const p1 = yield P('対称軸の1点目を指定:');
  if (!p1) return;
  const p2 = yield P('対称軸の2点目を指定:', {
    base: p1,
    preview: (g, cur) => { gline(g, p1, cur); if (dist(p1, cur) > 1e-9) ghost(g, entsOf(ids).map(e => mirrorEnt(e, p1, cur))); }
  });
  if (!p2 || dist(p1, p2) < 1e-9) return;
  const kw = yield KW('元のオブジェクトを削除しますか？ [はい(Y)/いいえ(N)] <N>:', ['Y', 'N'], 'N');
  Engine.mutate();
  for (const e of entsOf(ids)) {
    const m = mirrorEnt(e, p1, p2);
    m.id = S.nextId++;
    S.entities.push(m);
  }
  if (kw === 'Y') removeIds(ids);
  scheduleRedraw();
}
function* cmdOFFSET() {
  const d = yield DST('オフセット距離を指定:', {});
  if (d == null || d <= 0) return;
  while (true) {
    const id = yield PICK('オフセットするオブジェクトを選択 <終了>:');
    if (id == null) return;
    const e = S.entities.find(x => x.id === id);
    if (!e) continue;
    if (layerOf(e).locked) { log('ロック画層のオブジェクトです'); continue; }
    if (!['line', 'circle', 'arc'].includes(e.type)) { log('このオブジェクト種別のオフセットは未対応です（線分・円・円弧のみ）'); continue; }
    const side = yield P('オフセットする側の点を指定:');
    if (!side) continue;
    let ne = null;
    if (e.type === 'line') {
      const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
      const L = dist(a, b);
      if (L < 1e-9) continue;
      const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
      const cross = ux * (side.y - a.y) - uy * (side.x - a.x);
      const s = cross >= 0 ? 1 : -1;
      const nx = -uy * s * d, ny = ux * s * d;
      ne = clone(e); ne.x1 += nx; ne.y1 += ny; ne.x2 += nx; ne.y2 += ny;
    } else {
      const c = { x: e.cx, y: e.cy };
      const out = dist(side, c) > e.r;
      const nr = out ? e.r + d : e.r - d;
      if (nr <= 1e-9) { toast('半径が 0 以下になるためオフセットできません', 'error'); continue; }
      ne = clone(e); ne.r = nr;
    }
    ne.id = S.nextId++;
    Engine.mutate();
    S.entities.push(ne);
    scheduleRedraw();
  }
}
function* cmdERASE() {
  let ids = yield SEL('削除するオブジェクトを選択:');
  ids = filterUnlocked(ids);
  if (!ids.length) return;
  Engine.mutate();
  removeIds(ids);
  log(ids.length + ' 個を削除しました');
}
function* cmdEXPLODE() {
  let ids = yield SEL('分解するオブジェクトを選択:');
  ids = filterUnlocked(ids);
  const targets = entsOf(ids).filter(e => e.type === 'pline');
  if (!targets.length) { log('分解できるオブジェクト（ポリライン）がありません'); return; }
  Engine.mutate();
  for (const e of targets) {
    for (const s of plineSegs(e)) {
      if (s.kind === 'line') addEntity({ type: 'line', layer: e.layer, color: e.color, x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y });
      else addEntity({ type: 'arc', layer: e.layer, color: e.color, cx: s.arc.cx, cy: s.arc.cy, r: s.arc.r, a0: s.arc.a0, a1: s.arc.a1 });
    }
  }
  removeIds(targets.map(t => t.id));
  log(targets.length + ' 個のポリラインを分解しました');
}
function* cmdZOOM() {
  const kw = yield KW('ズーム [図形範囲(E)/全体(A)/窓(W)] <E>:', ['E', 'A', 'W'], 'E');
  if (kw === 'W') {
    const p1 = yield P('窓の1点目を指定:');
    if (!p1) return;
    const p2 = yield P('窓の2点目を指定:', { base: p1, preview: (g, cur) => { gline(g, p1, { x: cur.x, y: p1.y }); gline(g, { x: cur.x, y: p1.y }, cur); gline(g, cur, { x: p1.x, y: cur.y }); gline(g, { x: p1.x, y: cur.y }, p1); } });
    if (!p2) return;
    fitRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.max(p1.x, p2.x), Math.max(p1.y, p2.y));
  } else if (kw === 'A') {
    zoomExtents(true);
  } else {
    zoomExtents(false);
  }
}
function* cmdPAN() {
  yield { type: 'pan', prompt: '左ドラッグで画面移動（Enter / Esc で終了）' };
}
function* cmdDIST() {
  const p1 = yield P('1点目を指定:');
  if (!p1) return;
  const p2 = yield P('2点目を指定:', { base: p1, preview: (g, cur) => gline(g, p1, cur, '#ffb400') });
  if (!p2) return;
  const d = dist(p1, p2);
  log('距離 = ' + fmt(d) + '、ΔX = ' + fmt(p2.x - p1.x) + '、ΔY = ' + fmt(p2.y - p1.y) + '、角度 = ' + fmt(deg(angOf(p1, p2))) + '°');
}

/* コマンド登録 */
const COMMANDS = {
  LINE:    { aliases: ['L'],          fn: cmdLINE },
  CIRCLE:  { aliases: ['C'],          fn: cmdCIRCLE },
  ARC:     { aliases: ['A'],          fn: cmdARC },
  PLINE:   { aliases: ['PL'],         fn: cmdPLINE },
  RECTANG: { aliases: ['REC', 'RECTANGLE'], fn: cmdRECTANG },
  POINT:   { aliases: ['PO'],         fn: cmdPOINT },
  TEXT:    { aliases: ['T', 'DT', 'DTEXT'], fn: cmdTEXT },
  MOVE:    { aliases: ['M'],          fn: cmdMOVE },
  COPY:    { aliases: ['CO', 'CP'],   fn: cmdCOPY },
  ROTATE:  { aliases: ['RO'],         fn: cmdROTATE },
  SCALE:   { aliases: ['SC'],         fn: cmdSCALE },
  MIRROR:  { aliases: ['MI'],         fn: cmdMIRROR },
  OFFSET:  { aliases: ['O'],          fn: cmdOFFSET },
  ERASE:   { aliases: ['E', 'DEL'],   fn: cmdERASE },
  EXPLODE: { aliases: ['X'],          fn: cmdEXPLODE },
  ZOOM:    { aliases: ['Z'],          fn: cmdZOOM },
  PAN:     { aliases: ['P'],          fn: cmdPAN },
  DIST:    { aliases: ['DI'],         fn: cmdDIST },
  UNDO:    { aliases: ['U'],          run: undo },
  REDO:    { aliases: ['MREDO'],      run: redoOp },
  REGEN:   { aliases: ['RE'],         run: () => scheduleRedraw() },
  LAYER:   { aliases: ['LA'],         run: () => flashPanel('layers-panel') },
  NEW:     { aliases: [],             run: fileNew },
  OPEN:    { aliases: [],             run: fileOpen },
  SAVEAS:  { aliases: ['SAVE', 'QSAVE', 'EXPORT'], run: fileSave }
};
const ALIASES = {};
for (const [name, def] of Object.entries(COMMANDS)) {
  ALIASES[name] = name;
  for (const a of def.aliases) ALIASES[a] = name;
}
function runCommand(input) {
  const key = input.trim().toUpperCase();
  const name = ALIASES[key];
  if (!name) { log('コマンドが見つかりません: ' + input, 'err'); return; }
  Engine.start(name, COMMANDS[name]);
}

/* ================================================================ 入力ルーティング */
function parsePoint(str, base) {
  let m;
  if ((m = str.match(/^(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)$/))) return { x: +m[1], y: +m[2] };
  const ref = base || S.lastPoint;
  if ((m = str.match(/^@(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)$/))) {
    if (!ref) return null;
    return { x: ref.x + +m[1], y: ref.y + +m[2] };
  }
  if ((m = str.match(/^@(-?\d*\.?\d+)\s*<\s*(-?\d*\.?\d+)$/))) {
    if (!ref) return null;
    const a = rad(+m[2]);
    return { x: ref.x + +m[1] * Math.cos(a), y: ref.y + +m[1] * Math.sin(a) };
  }
  return null;
}
function matchKeyword(txt, keywords) {
  if (!keywords) return null;
  const U = txt.toUpperCase();
  return keywords.find(k => k === U) || null;
}
function submitInput(raw) {
  const txt = raw;
  const T = txt.trim();
  log((elPrompt.textContent || '') + ' ' + T, 'echo');
  if (Engine.req) { routeToReq(txt); return; }
  if (T) runCommand(T);
  else if (S.lastCmd) runCommand(S.lastCmd);
}
function routeToReq(txt) {
  const req = Engine.req;
  const T = txt.trim();
  if (req.type === 'string') {
    Engine.req = null;
    Engine.resume(T === '' ? (req.def != null ? req.def : null) : txt);
    return;
  }
  const kw = T && matchKeyword(T, req.keywords);
  if (kw) { Engine.req = null; Engine.resume({ kw }); return; }
  if (T === '') { // Enter
    if (req.type === 'select') { Engine.confirmSelect(); return; }
    Engine.req = null;
    if (req.def != null) Engine.resume(req.def);
    else Engine.resume(null);
    return;
  }
  if (req.type === 'point') {
    const p = parsePoint(T, req.base);
    if (p) { S.lastPoint = p; Engine.req = null; Engine.resume(p); return; }
    const n = parseFloat(T);
    if (Number.isFinite(n) && req.base && S.mouse.on) { // 直接距離入力
      const dir = angOf(req.base, S.curPt);
      const p2 = { x: req.base.x + n * Math.cos(dir), y: req.base.y + n * Math.sin(dir) };
      S.lastPoint = p2;
      Engine.req = null; Engine.resume(p2);
      return;
    }
    log('無効な点です。x,y / @dx,dy / @距離<角度 で入力してください', 'err');
  } else if (req.type === 'dist' || req.type === 'number') {
    const n = parseFloat(T);
    if (Number.isFinite(n)) { Engine.req = null; Engine.resume(n); }
    else log('数値を入力してください', 'err');
  } else if (req.type === 'angle') {
    const n = parseFloat(T);
    if (Number.isFinite(n)) { Engine.req = null; Engine.resume(rad(n)); }
    else log('角度（度）を入力してください', 'err');
  } else if (req.type === 'keyword') {
    log('[' + (req.keywords || []).join('/') + '] のいずれかを入力してください', 'err');
  } else if (req.type === 'pan') {
    Engine.req = null; Engine.resume(null);
  } else if (req.type === 'pickone' || req.type === 'select') {
    log('オブジェクトをクリックで選択してください', 'err');
  }
}

/* ================================================================ 選択 */
function selChanged() {
  renderProps();
  scheduleRedraw();
}
function hitAt(sx, sy) {
  const p = s2w(sx, sy);
  const tol = 6 / S.view.scale;
  // 後に描いたもの優先
  for (let i = S.entities.length - 1; i >= 0; i--) {
    const e = S.entities[i];
    if (layerOf(e).on === false) continue;
    if (hitTest(e, p, tol)) return e;
  }
  return null;
}
function applyBox(aScr, bScr, target) {
  const crossing = bScr.x < aScr.x;
  const p1 = s2w(Math.min(aScr.x, bScr.x), Math.max(aScr.y, bScr.y));
  const p2 = s2w(Math.max(aScr.x, bScr.x), Math.min(aScr.y, bScr.y));
  const r = { x0: p1.x, y0: p1.y, x1: p2.x, y1: p2.y };
  let n = 0;
  for (const e of visibleEntities()) {
    if (target === S.sel && layerOf(e).locked) { /* 表示上は選べるが後段で除外される */ }
    const b = entBBox(e);
    if (!b) continue;
    const inside = b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1;
    const overlap = b.x1 >= r.x0 && b.x0 <= r.x1 && b.y1 >= r.y0 && b.y0 <= r.y1;
    if (crossing ? overlap : inside) { target.add(e.id); n++; }
  }
  log(n + ' 個を選択しました（計 ' + target.size + ' 個）');
  selChanged();
}
function selectionTarget() { return (Engine.req && Engine.req.type === 'select') ? Engine.tempSel : S.sel; }
function pickAt(sx, sy, shift) {
  const target = selectionTarget();
  const e = hitAt(sx, sy);
  if (e) {
    if (shift) target.delete(e.id);
    else target.add(e.id);
    log((shift ? '1 個を除外' : '1 個を選択') + '（計 ' + target.size + ' 個）');
    selChanged();
    return true;
  }
  return false;
}

/* ================================================================ マウス */
function evPos(ev) {
  const r = canvas.getBoundingClientRect();
  return { sx: ev.clientX - r.left, sy: ev.clientY - r.top };
}
function reqBase() { return Engine.req ? Engine.req.base || Engine.req._p1 : null; }

canvas.addEventListener('mousedown', ev => {
  const { sx, sy } = evPos(ev);
  if (ev.button === 1) {
    ev.preventDefault();
    S.panDrag = { sx, sy, ox: S.view.ox, oy: S.view.oy };
    return;
  }
  if (ev.button !== 0) return;
  const req = Engine.req;
  if (req && req.type === 'pan') {
    S.panDrag = { sx, sy, ox: S.view.ox, oy: S.view.oy };
    return;
  }
  if (req && ['point', 'dist', 'angle', 'pickone'].includes(req.type)) {
    const eff = computeEffective(sx, sy, reqBase());
    const p = eff.pt;
    if (req.type === 'point') {
      S.lastPoint = p;
      Engine.req = null; Engine.resume(p);
    } else if (req.type === 'dist') {
      if (req.base || req._p1) {
        const b = req.base || req._p1;
        Engine.req = null; Engine.resume(dist(b, p));
      } else {
        req._p1 = p;
        setPrompt('2点目を指定:');
        req.preview = (g, cur) => gline(g, p, cur, '#ffb400');
      }
    } else if (req.type === 'angle') {
      if (req.base) { Engine.req = null; Engine.resume(angOf(req.base, p)); }
    } else if (req.type === 'pickone') {
      const e = hitAt(sx, sy);
      if (e) { Engine.req = null; Engine.resume(e.id); }
      else log('オブジェクトが見つかりません');
    }
    scheduleRedraw();
    return;
  }
  // 選択モード（アイドル or select リクエスト）
  if (S.boxAnchor) {
    applyBox(S.boxAnchor, { x: sx, y: sy }, selectionTarget());
    S.boxAnchor = null;
    scheduleRedraw();
    return;
  }
  S.leftDown = { sx, sy, shift: ev.shiftKey };
});
canvas.addEventListener('mousemove', ev => {
  const { sx, sy } = evPos(ev);
  S.mouse.sx = sx; S.mouse.sy = sy; S.mouse.on = true;
  if (S.panDrag) {
    S.view.ox = S.panDrag.ox - (sx - S.panDrag.sx) / S.view.scale;
    S.view.oy = S.panDrag.oy + (sy - S.panDrag.sy) / S.view.scale;
    scheduleRedraw();
  }
  if (S.leftDown && !S.selBox && Math.hypot(sx - S.leftDown.sx, sy - S.leftDown.sy) > 4) {
    S.selBox = { a: { x: S.leftDown.sx, y: S.leftDown.sy }, shift: S.leftDown.shift };
  }
  const eff = computeEffective(sx, sy, reqBase());
  S.curPt = eff.pt;
  S.snapMark = eff.mark;
  elCoords.textContent = fmt(S.curPt.x) + ', ' + fmt(S.curPt.y);
  scheduleRedraw();
});
canvas.addEventListener('mouseup', ev => {
  const { sx, sy } = evPos(ev);
  if (ev.button === 1) { S.panDrag = null; return; }
  if (ev.button !== 0) return;
  if (S.panDrag) { S.panDrag = null; return; }
  if (S.selBox) {
    applyBox(S.selBox.a, { x: sx, y: sy }, selectionTarget());
    S.selBox = null; S.leftDown = null;
    return;
  }
  if (S.leftDown) {
    const hit = pickAt(sx, sy, S.leftDown.shift);
    if (!hit) S.boxAnchor = { x: sx, y: sy };
    S.leftDown = null;
    scheduleRedraw();
  }
});
canvas.addEventListener('mouseleave', () => { S.mouse.on = false; scheduleRedraw(); });
window.addEventListener('mouseup', ev => {
  if (ev.target === canvas) return; // canvas 側のハンドラに任せる
  S.panDrag = null; S.leftDown = null;
  if (S.selBox) { S.selBox = null; scheduleRedraw(); }
});
canvas.addEventListener('contextmenu', ev => {
  ev.preventDefault();
  submitInput('');
});
canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  const { sx, sy } = evPos(ev);
  const before = s2w(sx, sy);
  const f = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  S.view.scale = Math.min(1e5, Math.max(1e-5, S.view.scale * f));
  const after = s2w(sx, sy);
  S.view.ox += before.x - after.x;
  S.view.oy += before.y - after.y;
  scheduleRedraw();
}, { passive: false });

/* ================================================================ ビュー操作 */
function fitRect(x0, y0, x1, y1) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const dx = Math.max(1e-6, x1 - x0), dy = Math.max(1e-6, y1 - y0);
  S.view.scale = Math.min(W / dx, H / dy) * 0.92;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  S.view.ox = cx - W / 2 / S.view.scale;
  S.view.oy = cy - H / 2 / S.view.scale;
  scheduleRedraw();
}
function zoomExtents(includeOrigin) {
  let b = null;
  for (const e of visibleEntities()) {
    const eb = entBBox(e);
    if (!eb) continue;
    if (!b) b = Object.assign({}, eb);
    else { b.x0 = Math.min(b.x0, eb.x0); b.y0 = Math.min(b.y0, eb.y0); b.x1 = Math.max(b.x1, eb.x1); b.y1 = Math.max(b.y1, eb.y1); }
  }
  if (!b) { fitRect(-10, -10, 430, 307); return; }
  if (includeOrigin) { b.x0 = Math.min(b.x0, 0); b.y0 = Math.min(b.y0, 0); b.x1 = Math.max(b.x1, 0); b.y1 = Math.max(b.y1, 0); }
  const mx = (b.x1 - b.x0) * 0.02 + 1, my = (b.y1 - b.y0) * 0.02 + 1;
  fitRect(b.x0 - mx, b.y0 - my, b.x1 + mx, b.y1 + my);
}

/* ================================================================ キーボード */
document.addEventListener('keydown', ev => {
  const typing = ev.target === elInput || ['INPUT', 'SELECT', 'TEXTAREA'].includes(ev.target.tagName);
  if (ev.key === 'Escape') {
    if (Engine.gen) Engine.cancel();
    else { S.sel.clear(); S.boxAnchor = null; S.selBox = null; selChanged(); }
    elInput.value = '';
    scheduleRedraw();
    return;
  }
  const fkeys = { F3: 'osnap', F7: 'grid', F8: 'ortho', F9: 'snap', F10: 'polar' };
  if (fkeys[ev.key]) {
    ev.preventDefault();
    toggleSetting(fkeys[ev.key]);
    return;
  }
  if (ev.ctrlKey && !ev.altKey) {
    const k = ev.key.toLowerCase();
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && ev.shiftKey)) { ev.preventDefault(); redoOp(); return; }
    return;
  }
  if (typing) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    eraseSelection();
    return;
  }
  if (ev.key === 'Enter') { ev.preventDefault(); submitInput(''); return; }
  if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    elInput.focus();
  }
});
elInput.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const v = elInput.value;
    elInput.value = '';
    submitInput(v);
  } else if (ev.key === ' ' && !(Engine.req && Engine.req.type === 'string')) {
    ev.preventDefault();
    const v = elInput.value;
    elInput.value = '';
    submitInput(v);
  }
});
function eraseSelection() {
  if (!S.sel.size) return;
  const ids = filterUnlocked([...S.sel]);
  if (!ids.length) return;
  pushHistory();
  removeIds(ids);
  log(ids.length + ' 個を削除しました');
  selChanged();
}
function toggleSetting(key) {
  S.settings[key] = !S.settings[key];
  if (key === 'ortho' && S.settings.ortho) S.settings.polar = false;
  if (key === 'polar' && S.settings.polar) S.settings.ortho = false;
  renderToggles();
  const names = { osnap: 'OSNAP', grid: 'GRID', ortho: 'ORTHO', snap: 'SNAP', polar: 'POLAR' };
  log('<' + names[key] + ' ' + (S.settings[key] ? 'オン' : 'オフ') + '>');
  scheduleRedraw();
}
function renderToggles() {
  for (const [id, key] of [['tg-snap', 'snap'], ['tg-grid', 'grid'], ['tg-ortho', 'ortho'], ['tg-polar', 'polar'], ['tg-osnap', 'osnap']]) {
    document.getElementById(id).classList.toggle('active', !!S.settings[key]);
  }
}

/* ================================================================ 画層パネル */
const ACI_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 40, 90, 130, 150, 210, 250, 252, 254];
function renderLayers() {
  const list = document.getElementById('layers-list');
  list.innerHTML = '';
  for (const l of S.layers) {
    const row = document.createElement('div');
    row.className = 'layer-row' + (l.name === S.clayer ? ' current' : '');
    const cur = document.createElement('span');
    cur.className = 'lyr-cur';
    cur.textContent = l.name === S.clayer ? '✔' : '';
    cur.title = 'カレント画層に設定';
    cur.onclick = () => { S.clayer = l.name; renderLayers(); };
    const name = document.createElement('span');
    name.className = 'lyr-name';
    name.textContent = l.name;
    name.title = 'カレント画層に設定';
    name.onclick = () => { S.clayer = l.name; renderLayers(); };
    const eye = document.createElement('button');
    eye.className = 'lyr-btn';
    eye.textContent = l.on !== false ? '👁' : '—';
    eye.title = '表示 / 非表示';
    eye.onclick = () => {
      pushHistory();
      l.on = l.on === false;
      if (l.on === false) for (const e of S.entities) if (e.layer === l.name) S.sel.delete(e.id);
      renderLayers(); selChanged();
    };
    const lock = document.createElement('button');
    lock.className = 'lyr-btn';
    lock.textContent = l.locked ? '🔒' : '🔓';
    lock.title = 'ロック / 解除';
    lock.onclick = () => { pushHistory(); l.locked = !l.locked; renderLayers(); };
    const sw = document.createElement('button');
    sw.className = 'lyr-swatch';
    sw.style.background = aciToHex(l.color);
    sw.title = '色 (ACI ' + l.color + ')';
    sw.onclick = ev => openPalette(ev.clientX, ev.clientY, aci => { pushHistory(); l.color = aci; renderLayers(); scheduleRedraw(); });
    const lt = document.createElement('select');
    lt.className = 'lyr-ltype';
    for (const t of ['CONTINUOUS', 'DASHED', 'CENTER', 'HIDDEN']) {
      const o = document.createElement('option');
      o.value = t; o.textContent = t.toLowerCase();
      if ((l.ltype || 'CONTINUOUS') === t) o.selected = true;
      lt.appendChild(o);
    }
    lt.onchange = () => { pushHistory(); l.ltype = lt.value; scheduleRedraw(); };
    const del = document.createElement('button');
    del.className = 'lyr-btn';
    del.textContent = '✕';
    del.title = '画層を削除（未使用のみ）';
    del.onclick = () => {
      if (l.name === '0') { toast('画層 0 は削除できません', 'error'); return; }
      if (S.entities.some(e => e.layer === l.name)) { toast('使用中の画層は削除できません', 'error'); return; }
      pushHistory();
      S.layers = S.layers.filter(x => x !== l);
      if (S.clayer === l.name) S.clayer = '0';
      renderLayers();
    };
    row.append(cur, name, eye, lock, sw, lt, del);
    list.appendChild(row);
  }
}
document.getElementById('layer-add-btn').addEventListener('click', () => {
  const inp = document.getElementById('layer-add-name');
  const name = inp.value.trim();
  if (!name) return;
  if (S.layers.some(l => l.name === name)) { toast('同名の画層があります', 'error'); return; }
  pushHistory();
  S.layers.push({ name, color: 7, ltype: 'CONTINUOUS', on: true, locked: false });
  S.clayer = name;
  inp.value = '';
  renderLayers();
});
function openPalette(x, y, cb) {
  closePalette();
  const pop = document.createElement('div');
  pop.id = 'palette-pop';
  for (const aci of ACI_CHOICES) {
    const b = document.createElement('button');
    b.style.background = aciToHex(aci);
    b.title = 'ACI ' + aci;
    b.onclick = () => { closePalette(); cb(aci); };
    pop.appendChild(b);
  }
  pop.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  pop.style.top = Math.min(y, window.innerHeight - 120) + 'px';
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('mousedown', paletteCloser), 0);
}
function paletteCloser(ev) {
  const pop = document.getElementById('palette-pop');
  if (pop && !pop.contains(ev.target)) closePalette();
}
function closePalette() {
  const pop = document.getElementById('palette-pop');
  if (pop) pop.remove();
  document.removeEventListener('mousedown', paletteCloser);
}
function flashPanel(id) {
  const el = document.getElementById(id);
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/* ================================================================ プロパティパネル */
function renderProps() {
  const body = document.getElementById('props-body');
  body.innerHTML = '';
  const ents = entsOf([...S.sel]);
  if (!ents.length) {
    body.innerHTML = '<div class="props-empty">選択なし</div>';
    return;
  }
  const head = document.createElement('div');
  head.className = 'props-head';
  const typeNames = { line: '線分', circle: '円', arc: '円弧', pline: 'ポリライン', text: '文字', point: '点' };
  head.textContent = ents.length === 1 ? (typeNames[ents[0].type] || ents[0].type) : ents.length + ' 個選択';
  body.appendChild(head);
  // 画層
  const row1 = document.createElement('div'); row1.className = 'props-row';
  row1.innerHTML = '<label>画層</label>';
  const selLayer = document.createElement('select');
  const mixedL = new Set(ents.map(e => e.layer)).size > 1;
  if (mixedL) { const o = document.createElement('option'); o.textContent = '*混在*'; o.value = ''; o.selected = true; selLayer.appendChild(o); }
  for (const l of S.layers) {
    const o = document.createElement('option');
    o.value = l.name; o.textContent = l.name;
    if (!mixedL && ents[0].layer === l.name) o.selected = true;
    selLayer.appendChild(o);
  }
  selLayer.onchange = () => {
    if (!selLayer.value) return;
    pushHistory();
    for (const e of ents) e.layer = selLayer.value;
    scheduleRedraw(); renderProps();
  };
  row1.appendChild(selLayer);
  body.appendChild(row1);
  // 色
  const row2 = document.createElement('div'); row2.className = 'props-row';
  row2.innerHTML = '<label>色</label>';
  const selCol = document.createElement('select');
  const colOpts = [[256, 'ByLayer'], [1, '赤'], [2, '黄'], [3, '緑'], [4, '水色'], [5, '青'], [6, '紫'], [7, '白'], [8, '灰'], [9, '薄灰']];
  const mixedC = new Set(ents.map(e => e.color == null ? 256 : e.color)).size > 1;
  if (mixedC) { const o = document.createElement('option'); o.textContent = '*混在*'; o.value = ''; o.selected = true; selCol.appendChild(o); }
  for (const [v, label] of colOpts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (!mixedC && (ents[0].color == null ? 256 : ents[0].color) === v) o.selected = true;
    selCol.appendChild(o);
  }
  selCol.onchange = () => {
    if (selCol.value === '') return;
    pushHistory();
    for (const e of ents) e.color = parseInt(selCol.value, 10);
    scheduleRedraw(); renderProps();
  };
  row2.appendChild(selCol);
  body.appendChild(row2);
  // ジオメトリ（単一選択時）
  if (ents.length === 1) {
    const e = ents[0];
    const rows = [];
    if (e.type === 'line') rows.push(['始点', fmt(e.x1) + ', ' + fmt(e.y1)], ['終点', fmt(e.x2) + ', ' + fmt(e.y2)], ['長さ', fmt(Math.hypot(e.x2 - e.x1, e.y2 - e.y1))]);
    else if (e.type === 'circle') rows.push(['中心', fmt(e.cx) + ', ' + fmt(e.cy)], ['半径', fmt(e.r)], ['円周', fmt(2 * Math.PI * e.r)]);
    else if (e.type === 'arc') rows.push(['中心', fmt(e.cx) + ', ' + fmt(e.cy)], ['半径', fmt(e.r)], ['開始角', fmt(deg(e.a0)) + '°'], ['終了角', fmt(deg(e.a1)) + '°']);
    else if (e.type === 'pline') rows.push(['頂点数', String(e.pts.length)], ['閉じる', e.closed ? 'はい' : 'いいえ']);
    else if (e.type === 'text') rows.push(['挿入点', fmt(e.x) + ', ' + fmt(e.y)], ['高さ', fmt(e.h)], ['内容', e.str]);
    else if (e.type === 'point') rows.push(['位置', fmt(e.x) + ', ' + fmt(e.y)]);
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.className = 'props-row ro';
      r.innerHTML = '<label></label><span></span>';
      r.querySelector('label').textContent = k;
      r.querySelector('span').textContent = v;
      body.appendChild(r);
    }
  }
}

/* ================================================================ ファイル */
function fileNew() {
  if (S.dirty && !confirm('未保存の変更があります。破棄して新規図面を開始しますか？')) return;
  S.entities = [];
  S.layers = [{ name: '0', color: 7, ltype: 'CONTINUOUS', on: true, locked: false }];
  S.clayer = '0';
  S.sel.clear();
  S.undoStack = []; S.redoStack = [];
  S.dirty = false;
  S.fileName = 'drawing.dxf';
  S.nextId = 1;
  updateTitle(); renderLayers(); renderProps();
  zoomExtents();
  log('新規図面を作成しました');
}
function fileOpen() {
  if (S.dirty && !confirm('未保存の変更があります。破棄して別のファイルを開きますか？')) return;
  elFile.value = '';
  elFile.click();
}
elFile.addEventListener('change', () => {
  const f = elFile.files && elFile.files[0];
  if (!f) return;
  if (/\.dwg$/i.test(f.name)) {
    toast('DWG は非公開バイナリ形式のため直接読み込めません。AutoCAD または ODA File Converter で DXF に変換してください。', 'error');
    log('DWG 読み込み不可: ' + f.name + ' → DXF に変換して開いてください', 'err');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const res = parseDXF(String(reader.result));
      if (!res.entities.length && !res.layers.length) {
        toast('DXF として解釈できませんでした（バイナリ DXF は未対応です）', 'error');
        return;
      }
      S.entities = [];
      S.layers = [{ name: '0', color: 7, ltype: 'CONTINUOUS', on: true, locked: false }];
      for (const l of res.layers) if (l.name !== '0') S.layers.push(l);
      else Object.assign(S.layers[0], l);
      S.clayer = '0';
      S.nextId = 1;
      for (const e of res.entities) {
        if (!S.layers.some(l => l.name === e.layer)) S.layers.push({ name: e.layer, color: 7, ltype: 'CONTINUOUS', on: true, locked: false });
        e.id = S.nextId++;
        S.entities.push(e);
      }
      S.sel.clear();
      S.undoStack = []; S.redoStack = [];
      S.dirty = false;
      S.fileName = f.name.replace(/\.[^.]+$/, '') + '.dxf';
      updateTitle(); renderLayers(); renderProps();
      zoomExtents();
      log(f.name + ' を読み込みました（' + res.entities.length + ' オブジェクト、' + S.layers.length + ' 画層）');
      if (res.skipped) toast('未対応エンティティ ' + res.skipped + ' 個をスキップしました（ブロック参照・ハッチング・スプライン等）');
      else toast('読み込み完了: ' + res.entities.length + ' オブジェクト');
    } catch (err) {
      console.error(err);
      toast('DXF の読み込みに失敗しました: ' + err.message, 'error');
    }
  };
  reader.readAsText(f);
});
function fileSave() {
  try {
    const text = writeDXF({ layers: S.layers, entities: S.entities });
    const blob = new Blob([text], { type: 'application/dxf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = S.fileName || 'drawing.dxf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    S.dirty = false;
    updateTitle();
    log(a.download + ' に書き出しました（DXF R12、' + S.entities.length + ' オブジェクト）');
    toast('DXF を書き出しました');
  } catch (err) {
    console.error(err);
    toast('書き出しに失敗しました: ' + err.message, 'error');
  }
}
window.addEventListener('beforeunload', ev => {
  if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; }
});

/* ================================================================ 初期化 */
function resizeCanvas() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(wrap.clientHeight * dpr));
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleRedraw();
}
window.addEventListener('resize', resizeCanvas);

document.querySelectorAll('[data-cmd]').forEach(btn => {
  btn.addEventListener('click', () => runCommand(btn.dataset.cmd));
});
document.querySelectorAll('[data-toggle]').forEach(btn => {
  btn.addEventListener('click', () => toggleSetting(btn.dataset.toggle));
});

resizeCanvas();
renderLayers();
renderProps();
renderToggles();
updateTitle();
zoomExtents();
log('WEBAPP 2DCAD — コマンドを入力してください（例: L=線分, C=円, Z=ズーム）');
setPrompt('コマンド:');
