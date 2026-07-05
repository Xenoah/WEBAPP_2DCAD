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
  // 寸法スタイル
  dimStyles: [{ name: 'STANDARD', textH: 3.5, arrow: 2.5, extOffset: 0.8, extBeyond: 1.25, gap: 1, prec: 2, scale: 1 }],
  curDimStyle: 'STANDARD',
  // 拘束
  constraints: [],              // {id, kind, refs:[{id,pt}], value?, pos?, data?}
  nextCid: 1,
  conStatus: null,              // 直近ソルバー診断 {converged, dof, redundant, nEqs, nVars, maxRes}
  // 画像データ（undo スナップショット外で保持: キー → dataURL）
  imageData: {},
  nextImgKey: 1,
  // 修正コマンド既定値
  filletR: 0, chamferD1: 0, chamferD2: 0,
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
  else if (e.type === 'dim') {
    const g = dimGeometry(e);
    for (const s of g.segs) pts.push(s[0], s[1]);
    if (g.label) pts.push(g.label.p);
  } else if (e.type === 'image') {
    for (const c of imageCorners(e)) pts.push(c);
  }
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
  if (e.type === 'dim') {
    const g = dimGeometry(e);
    for (const s of g.segs) if (distPtSeg(p, s[0], s[1]) <= tol) return true;
    if (g.label) {
      const w = g.label.str.length * g.label.h * 0.7, hh = g.label.h * 1.3;
      if (dist(p, g.label.p) <= Math.max(w, hh)) return true;
    }
    return false;
  }
  if (e.type === 'image') {
    // 回転を戻したローカル座標で矩形判定
    const cs = Math.cos(-(e.rot || 0)), sn = Math.sin(-(e.rot || 0));
    const lx = (p.x - e.x) * cs - (p.y - e.y) * sn;
    const ly = (p.x - e.x) * sn + (p.y - e.y) * cs;
    return lx >= -tol && lx <= e.w + tol && ly >= -tol && ly <= e.h + tol;
  }
  return false;
}
function imageCorners(e) {
  const cs = Math.cos(e.rot || 0), sn = Math.sin(e.rot || 0);
  return [[0, 0], [e.w, 0], [e.w, e.h], [0, e.h]].map(([lx, ly]) =>
    ({ x: e.x + lx * cs - ly * sn, y: e.y + lx * sn + ly * cs }));
}

/* ================================================================ エンティティ変換 */
function mapPts(e, fn) {
  const c = clone(e);
  if (c.type === 'line') { const p1 = fn({ x: e.x1, y: e.y1 }), p2 = fn({ x: e.x2, y: e.y2 }); c.x1 = p1.x; c.y1 = p1.y; c.x2 = p2.x; c.y2 = p2.y; }
  else if (c.type === 'circle' || c.type === 'arc') { const p = fn({ x: e.cx, y: e.cy }); c.cx = p.x; c.cy = p.y; }
  else if (c.type === 'pline') c.pts = e.pts.map(p => Object.assign({}, p, fn(p)));
  else if (c.type === 'dim') {
    if (e.p1) c.p1 = fn(e.p1);
    if (e.p2) c.p2 = fn(e.p2);
    if (e.pos) c.pos = fn(e.pos);
  }
  else { const p = fn({ x: e.x, y: e.y }); c.x = p.x; c.y = p.y; }
  return c;
}
function translateEnt(e, dx, dy) { return mapPts(e, p => ({ x: p.x + dx, y: p.y + dy })); }
function rotateEnt(e, c, a) {
  const cs = Math.cos(a), sn = Math.sin(a);
  const rot = p => ({ x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn, y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cs });
  const o = mapPts(e, rot);
  if (o.type === 'arc') { o.a0 = e.a0 + a; o.a1 = e.a1 + a; }
  if (o.type === 'text' || o.type === 'image') o.rot = (e.rot || 0) + a;
  if (o.type === 'dim' && o.dtype === 'linear') o.ang = (e.ang || 0) + a;
  return o;
}
function scaleEnt(e, c, f) {
  const sc = p => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f });
  const o = mapPts(e, sc);
  if (o.type === 'circle' || o.type === 'arc') o.r = e.r * f;
  if (o.type === 'text') o.h = e.h * f;
  if (o.type === 'image') { o.w = e.w * f; o.h = e.h * f; }
  if (o.type === 'dim' && e.r != null) o.r = e.r * f;
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
  if (o.type === 'text' || o.type === 'image') o.rot = 2 * t - (e.rot || 0);
  if (o.type === 'dim' && o.dtype === 'linear') o.ang = 2 * t - (e.ang || 0);
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
  } else if (e.type === 'image') {
    if (M.end) for (const c of imageCorners(e)) out.push({ x: c.x, y: c.y, kind: 'end' });
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
  // 画像下敷きを最初に描画（他のオブジェクトの下になる）
  for (const e of S.entities) {
    if (e.type !== 'image' || layerOf(e).on === false) continue;
    drawEnt(ctx, e);
  }
  for (const e of S.entities) {
    if (e.type === 'image' || layerOf(e).on === false) continue;
    drawEnt(ctx, e);
  }
  // 寸法拘束の注釈
  drawConstraintAnnos(ctx);
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
  } else if (e.type === 'dim') {
    drawDimGeometry(g, dimGeometry(e), col, opt.dash);
  } else if (e.type === 'image') {
    drawImageEnt(g, e, opt);
  }
  g.setLineDash([]);
}
/* 寸法ジオメトリ（dimGeometry の戻り値）を描画。拘束注釈でも共用 */
function drawDimGeometry(g, geo, col, dash) {
  g.strokeStyle = col;
  g.fillStyle = col;
  g.lineWidth = 1.1;
  g.setLineDash(dash || []);
  for (const s of geo.segs) {
    const a = w2s(s[0]), b = w2s(s[1]);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  g.setLineDash([]);
  for (const ar of geo.arrows) {
    // ar: {p(先端 world), ang(向き world rad), size(world)}
    const tip = w2s(ar.p);
    const L = Math.max(4, ar.size * S.view.scale);
    const a = -ar.ang; // screen 角度（y 反転）
    const x1 = tip.x - L * Math.cos(a) + L * 0.35 * Math.sin(a);
    const y1 = tip.y - L * Math.sin(a) - L * 0.35 * Math.cos(a);
    const x2 = tip.x - L * Math.cos(a) - L * 0.35 * Math.sin(a);
    const y2 = tip.y - L * Math.sin(a) + L * 0.35 * Math.cos(a);
    g.beginPath(); g.moveTo(tip.x, tip.y); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath(); g.fill();
  }
  if (geo.label) {
    const p = w2s(geo.label.p);
    g.save();
    g.translate(p.x, p.y);
    g.rotate(-(geo.label.ang || 0));
    g.font = Math.max(3, geo.label.h * S.view.scale) + 'px "Yu Gothic", "Meiryo", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText(geo.label.str, 0, 0);
    g.restore();
  }
}
function drawImageEnt(g, e, opt) {
  const img = getImgEl(e.src);
  const p = w2s({ x: e.x, y: e.y });
  g.save();
  g.translate(p.x, p.y);
  g.rotate(-(e.rot || 0));
  const sw = e.w * S.view.scale, sh = e.h * S.view.scale;
  if (img && img.complete && img.naturalWidth) {
    g.globalAlpha = e.opacity != null ? e.opacity : 1;
    g.drawImage(img, 0, -sh, sw, sh);
    g.globalAlpha = 1;
  } else {
    g.strokeStyle = '#6d7683';
    g.setLineDash([4, 4]);
    g.strokeRect(0, -sh, sw, sh);
    g.setLineDash([]);
    g.fillStyle = '#6d7683';
    g.font = '11px sans-serif';
    g.fillText('画像読み込み中...', 6, -6);
  }
  if (opt && opt.dash) { // 選択枠
    g.strokeStyle = opt.color || '#59f';
    g.setLineDash(opt.dash);
    g.strokeRect(0, -sh, sw, sh);
    g.setLineDash([]);
  }
  if (e.locked) {
    g.fillStyle = 'rgba(220,230,240,0.7)';
    g.font = '12px sans-serif';
    g.fillText('🔒', 4, -4);
  }
  g.restore();
}
/* 画像要素キャッシュ */
const IMG_CACHE = {};
function getImgEl(key) {
  if (!key || !S.imageData[key]) return null;
  if (!IMG_CACHE[key]) {
    const img = new Image();
    img.onload = scheduleRedraw;
    img.src = S.imageData[key];
    IMG_CACHE[key] = img;
  }
  return IMG_CACHE[key];
}
function drawGrips(e) {
  let pts = [];
  if (e.type === 'line') pts = [{ x: e.x1, y: e.y1 }, { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 }, { x: e.x2, y: e.y2 }];
  else if (e.type === 'circle') { pts = [{ x: e.cx, y: e.cy }]; for (let q = 0; q < 4; q++) pts.push(arcPoint(e, q * Math.PI / 2)); }
  else if (e.type === 'arc') pts = [{ x: e.cx, y: e.cy }, arcPoint(e, e.a0), arcPoint(e, e.a1), arcPoint(e, e.a0 + ccwSpan(e.a0, e.a1) / 2)];
  else if (e.type === 'pline') pts = e.pts;
  else if (e.type === 'dim') { pts = []; if (e.p1) pts.push(e.p1); if (e.p2) pts.push(e.p2); if (e.pos) pts.push(e.pos); }
  else if (e.type === 'image') pts = imageCorners(e);
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
  return Engine.req && ['point', 'dist', 'angle', 'pickone', 'pickpt', 'refpt'].includes(Engine.req.type);
}

/* ================================================================ 履歴 */
function snapshot() {
  return {
    entities: clone(S.entities), layers: clone(S.layers), clayer: S.clayer,
    constraints: clone(S.constraints), dimStyles: clone(S.dimStyles), curDimStyle: S.curDimStyle,
    nextCid: S.nextCid
  };
}
function applySnapshot(sn) {
  S.entities = clone(sn.entities);
  S.layers = clone(sn.layers);
  S.clayer = sn.clayer;
  S.constraints = clone(sn.constraints || []);
  S.dimStyles = clone(sn.dimStyles || S.dimStyles);
  S.curDimStyle = sn.curDimStyle || S.curDimStyle;
  S.nextCid = sn.nextCid || S.nextCid;
  S.conStatus = null;
  S.sel.clear();
  renderLayers(); renderProps(); renderConstraints(); scheduleRedraw();
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
const PICKPT = (prompt, opts) => Object.assign({ type: 'pickpt', prompt }, opts || {});  // {id, pt:クリック点} を返す
const REF = prompt => ({ type: 'refpt', prompt });                                        // {entId, pt, x, y} を返す
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
  // 削除エンティティを参照する拘束も削除
  const before = S.constraints.length;
  S.constraints = S.constraints.filter(c => !c.refs.some(rf => set.has(rf.id)));
  if (S.constraints.length !== before) {
    log((before - S.constraints.length) + ' 個の拘束を削除しました（参照先の削除）');
    renderConstraints();
  }
  scheduleRedraw();
}
function entsOf(ids) { const set = new Set(ids); return S.entities.filter(e => set.has(e.id)); }
function filterUnlocked(ids) {
  const ok = entsOf(ids).filter(e => !layerOf(e).locked && !(e.type === 'image' && e.locked)).map(e => e.id);
  if (ok.length < ids.length) log((ids.length - ok.length) + ' 個はロック中（画層または画像ロック）のため対象外です');
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
  afterGeomEdit(ids);
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
  afterGeomEdit(ids);
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
  afterGeomEdit(ids);
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
  const targets = entsOf(ids).filter(e => e.type === 'pline' || e.type === 'dim');
  if (!targets.length) { log('分解できるオブジェクト（ポリライン・寸法）がありません'); return; }
  Engine.mutate();
  for (const e of targets) {
    if (e.type === 'dim') {
      for (const pe of dimToPrimitives(e)) addEntity(pe);
      continue;
    }
    for (const s of plineSegs(e)) {
      if (s.kind === 'line') addEntity({ type: 'line', layer: e.layer, color: e.color, x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y });
      else addEntity({ type: 'arc', layer: e.layer, color: e.color, cx: s.arc.cx, cy: s.arc.cy, r: s.arc.r, a0: s.arc.a0, a1: s.arc.a1 });
    }
  }
  removeIds(targets.map(t => t.id));
  log(targets.length + ' 個のオブジェクトを分解しました');
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
  TRIM:    { aliases: ['TR'],         fn: cmdTRIM },
  EXTEND:  { aliases: ['EX'],         fn: cmdEXTEND },
  FILLET:  { aliases: ['F'],          fn: cmdFILLET },
  CHAMFER: { aliases: ['CHA'],        fn: cmdCHAMFER },
  DIMLINEAR:   { aliases: ['DLI', 'DIMLIN'], fn: cmdDIMLINEAR },
  DIMALIGNED:  { aliases: ['DAL'],    fn: cmdDIMALIGNED },
  DIMRADIUS:   { aliases: ['DRA'],    fn: cmdDIMRADIUS },
  DIMDIAMETER: { aliases: ['DDI'],    fn: cmdDIMDIAMETER },
  DIMSTYLE:    { aliases: ['D', 'DST'], run: openDimStyleDialog },
  GCCOINCIDENT:    { aliases: ['GCC'],  fn: cmdGCCOINCIDENT },
  GCCOLLINEAR:     { aliases: ['GCL'],  fn: cmdGCCOLLINEAR },
  GCCONCENTRIC:    { aliases: ['GCN'],  fn: cmdGCCONCENTRIC },
  GCPARALLEL:      { aliases: ['GCP'],  fn: cmdGCPARALLEL },
  GCPERPENDICULAR: { aliases: ['GCE'],  fn: cmdGCPERPENDICULAR },
  GCHORIZONTAL:    { aliases: ['GCH'],  fn: cmdGCHORIZONTAL },
  GCVERTICAL:      { aliases: ['GCV'],  fn: cmdGCVERTICAL },
  GCTANGENT:       { aliases: ['GCT'],  fn: cmdGCTANGENT },
  GCSYMMETRIC:     { aliases: ['GCS'],  fn: cmdGCSYMMETRIC },
  GCEQUAL:         { aliases: ['GCQ'],  fn: cmdGCEQUAL },
  GCMIDPOINT:      { aliases: ['GCM'],  fn: cmdGCMIDPOINT },
  GCFIX:           { aliases: ['GCF'],  fn: cmdGCFIX },
  DCHORIZONTAL: { aliases: ['DCH'],  fn: cmdDCHORIZONTAL },
  DCVERTICAL:   { aliases: ['DCV'],  fn: cmdDCVERTICAL },
  DCALIGNED:    { aliases: ['DCA'],  fn: cmdDCALIGNED },
  DCANGLE:      { aliases: ['DCANG'], fn: cmdDCANGLE },
  DCRADIUS:     { aliases: ['DCR'],  fn: cmdDCRADIUS },
  DCDIAMETER:   { aliases: ['DCD'],  fn: cmdDCDIAMETER },
  CONSOLVE:  { aliases: ['RESOLVE'], run: consolveNow },
  CONDELETE: { aliases: ['DELCON'],  fn: cmdCONDELETE },
  IMAGEATTACH: { aliases: ['IAT', 'IMAGE'], run: startImageAttach },
  SAVEJSON: { aliases: ['SJ'], run: fileSaveJSON },
  OPENJSON: { aliases: ['OJ'], run: fileOpenJSON },
  SELFTEST: { aliases: ['CHECK'], run: runSelfCheckUI },
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
  } else if (['pickone', 'pickpt', 'refpt', 'select'].includes(req.type)) {
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
  if (req && ['point', 'dist', 'angle', 'pickone', 'pickpt', 'refpt'].includes(req.type)) {
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
    } else if (req.type === 'pickpt') {
      const e = hitAt(sx, sy);
      if (e) { Engine.req = null; Engine.resume({ id: e.id, pt: s2w(sx, sy) }); }
      else log('オブジェクトが見つかりません');
    } else if (req.type === 'refpt') {
      const e = hitAt(sx, sy);
      if (!e) { log('オブジェクトが見つかりません'); }
      else if (!Solver.constrainable(e)) { log('このオブジェクトには拘束を設定できません（線分・円・円弧・点のみ）'); }
      else {
        const ref = nearestRefPoint(e, s2w(sx, sy));
        Engine.req = null;
        Engine.resume(Object.assign({ entId: e.id }, ref));
      }
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
    if (!document.getElementById('modal-back').hidden) { closeModal(); return; }
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
  const typeNames = { line: '線分', circle: '円', arc: '円弧', pline: 'ポリライン', text: '文字', point: '点', dim: '寸法', image: '画像' };
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
    else if (e.type === 'dim') {
      const dtypeNames = { linear: '長さ寸法', aligned: '平行寸法', radius: '半径寸法', diameter: '直径寸法' };
      rows.push(['種類', dtypeNames[e.dtype] || e.dtype], ['計測値', fmtPrec(dimMeasure(e), 4)], ['表示', dimTextOf(e)]);
    } else if (e.type === 'image') {
      rows.push(['挿入点', fmt(e.x) + ', ' + fmt(e.y)], ['ファイル', e.name || e.src]);
    }
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.className = 'props-row ro';
      r.innerHTML = '<label></label><span></span>';
      r.querySelector('label').textContent = k;
      r.querySelector('span').textContent = v;
      body.appendChild(r);
    }
    if (e.type === 'dim') renderDimProps(body, e);
    if (e.type === 'image') renderImageProps(body, e);
  }
  renderSelectionConstraints(body, ents);
}
/* 寸法の編集可能プロパティ */
function renderDimProps(body, e) {
  // スタイル選択
  const row = document.createElement('div'); row.className = 'props-row';
  row.innerHTML = '<label>スタイル</label>';
  const sel = document.createElement('select');
  for (const st of S.dimStyles) {
    const o = document.createElement('option');
    o.value = st.name; o.textContent = st.name;
    if ((e.style || S.curDimStyle) === st.name) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => { pushHistory(); e.style = sel.value; scheduleRedraw(); renderProps(); };
  row.appendChild(sel);
  body.appendChild(row);
  // 文字上書き
  const row2 = document.createElement('div'); row2.className = 'props-row';
  row2.innerHTML = '<label>文字上書き</label>';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = e.text || '';
  inp.placeholder = '(自動)';
  inp.onchange = () => { pushHistory(); e.text = inp.value || null; scheduleRedraw(); renderProps(); };
  row2.appendChild(inp);
  body.appendChild(row2);
}
/* 画像の編集可能プロパティ */
function renderImageProps(body, e) {
  const numRow = (label, get, set, step) => {
    const row = document.createElement('div'); row.className = 'props-row';
    row.innerHTML = '<label></label>';
    row.querySelector('label').textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = step || 'any';
    inp.value = get();
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) { inp.value = get(); return; }
      pushHistory(); set(v); scheduleRedraw(); renderProps();
    };
    row.appendChild(inp);
    body.appendChild(row);
  };
  numRow('幅', () => fmt(e.w), v => { if (v > 0) { e.h = e.h * (v / e.w); e.w = v; } });
  numRow('高さ', () => fmt(e.h), v => { if (v > 0) e.h = v; });
  numRow('回転角', () => fmt(deg(e.rot || 0)), v => { e.rot = rad(v); });
  // 不透明度
  const rowO = document.createElement('div'); rowO.className = 'props-row';
  rowO.innerHTML = '<label>不透明度</label>';
  const rng = document.createElement('input');
  rng.type = 'range'; rng.min = '0.1'; rng.max = '1'; rng.step = '0.05';
  rng.value = e.opacity != null ? e.opacity : 1;
  rng.oninput = () => { e.opacity = parseFloat(rng.value); scheduleRedraw(); };
  rng.onchange = () => { S.dirty = true; updateTitle(); };
  rowO.appendChild(rng);
  body.appendChild(rowO);
  // ロック
  const rowL = document.createElement('div'); rowL.className = 'props-row';
  rowL.innerHTML = '<label>ロック</label>';
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = !!e.locked;
  chk.onchange = () => { pushHistory(); e.locked = chk.checked; scheduleRedraw(); renderProps(); };
  rowL.appendChild(chk);
  body.appendChild(rowL);
}
/* 選択オブジェクトに関連する拘束一覧 */
function renderSelectionConstraints(body, ents) {
  const idSet = new Set(ents.map(e => e.id));
  const cons = S.constraints.filter(c => c.refs.some(rf => idSet.has(rf.id)));
  if (!cons.length) return;
  const sub = document.createElement('div');
  sub.className = 'props-sub';
  sub.textContent = '拘束 (' + cons.length + ')';
  body.appendChild(sub);
  for (const c of cons) body.appendChild(constraintRow(c));
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
  S.constraints = []; S.nextCid = 1; S.conStatus = null;
  S.dimStyles = [{ name: 'STANDARD', textH: 3.5, arrow: 2.5, extOffset: 0.8, extBeyond: 1.25, gap: 1, prec: 2, scale: 1 }];
  S.curDimStyle = 'STANDARD';
  S.imageData = {};
  updateTitle(); renderLayers(); renderProps(); renderConstraints();
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
      S.constraints = []; S.nextCid = 1; S.conStatus = null;
      S.imageData = {};
      updateTitle(); renderLayers(); renderProps(); renderConstraints();
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
    // 寸法は線分+文字に分解、画像・拘束は DXF に保持できないため除外（JSON 保存で保持）
    const exp = [];
    let nDim = 0, nImg = 0;
    for (const e of S.entities) {
      if (e.type === 'dim') { nDim++; for (const pe of dimToPrimitives(e)) exp.push(pe); }
      else if (e.type === 'image') nImg++;
      else exp.push(e);
    }
    const text = writeDXF({ layers: S.layers, entities: exp });
    const blob = new Blob([text], { type: 'application/dxf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = S.fileName || 'drawing.dxf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    S.dirty = false;
    updateTitle();
    log(a.download + ' に書き出しました（DXF R12、' + exp.length + ' オブジェクト）');
    const notes = [];
    if (nDim) notes.push('寸法 ' + nDim + ' 個は線分・文字に分解');
    if (nImg) notes.push('画像 ' + nImg + ' 個は除外');
    if (S.constraints.length) notes.push('拘束 ' + S.constraints.length + ' 個は除外');
    if (notes.length) toast('DXF 書き出し: ' + notes.join(' / ') + '（完全な状態は JSON 保存を使用）');
    else toast('DXF を書き出しました');
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

/* ================================================================ 編集コマンド (TRIM / EXTEND / FILLET / CHAMFER) */
function segParam(a, b, p) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return 0;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
}
/* 対象と切り取りエッジ群の交点を集める */
function collectIntPts(e, cutters) {
  const pts = [];
  const mySegs = entIntSegs(e);
  for (const c of cutters) {
    if (c.id === e.id) continue;
    for (const s1 of mySegs) for (const s2 of entIntSegs(c))
      for (const p of segInts(s1, s2)) pts.push(p);
  }
  return pts;
}
/* トリム: クリック位置を含む区間を除去した結果を返す（純関数） */
function trimPieces(e, cutters, click) {
  const pts = collectIntPts(e, cutters);
  if (e.type === 'line') {
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    const ts = pts.map(p => segParam(a, b, p)).filter(t => t > 1e-6 && t < 1 - 1e-6).sort((x, y) => x - y);
    if (!ts.length) return { err: '切り取りエッジとの交点がありません' };
    const tc = Math.max(0, Math.min(1, segParam(a, b, click)));
    let lo = 0, hi = 1;
    for (const t of ts) { if (t <= tc) lo = t; else { hi = t; break; } }
    const mk = (t0, t1) => ({
      type: 'line', layer: e.layer, color: e.color,
      x1: a.x + (b.x - a.x) * t0, y1: a.y + (b.y - a.y) * t0,
      x2: a.x + (b.x - a.x) * t1, y2: a.y + (b.y - a.y) * t1
    });
    const add = [];
    if (lo > 1e-6) add.push(mk(0, lo));
    if (hi < 1 - 1e-6) add.push(mk(hi, 1));
    return { add };
  }
  if (e.type === 'circle') {
    const angs = pts.map(p => Math.atan2(p.y - e.cy, p.x - e.cx));
    const uniq = [];
    for (const t of angs) if (!uniq.some(u => Math.abs(ccwSpan(u, t)) < 1e-6 || Math.abs(ccwSpan(t, u)) < 1e-6)) uniq.push(t);
    if (uniq.length < 2) return { err: '円をトリムするには交点が 2 つ以上必要です' };
    const ac = Math.atan2(click.y - e.cy, click.x - e.cx);
    let lo = null, hi = null, loSpan = Infinity, hiSpan = Infinity;
    for (const t of uniq) {
      const s1 = ccwSpan(t, ac), s2 = ccwSpan(ac, t);
      if (s1 < loSpan) { loSpan = s1; lo = t; }
      if (s2 < hiSpan) { hiSpan = s2; hi = t; }
    }
    return { add: [{ type: 'arc', layer: e.layer, color: e.color, cx: e.cx, cy: e.cy, r: e.r, a0: hi, a1: lo }] };
  }
  if (e.type === 'arc') {
    const span = ccwSpan(e.a0, e.a1);
    const sOf = p => ccwSpan(e.a0, Math.atan2(p.y - e.cy, p.x - e.cx));
    const ss = pts.map(sOf).filter(s => s > 1e-6 && s < span - 1e-6).sort((x, y) => x - y);
    if (!ss.length) return { err: '切り取りエッジとの交点がありません' };
    const sc = sOf(click);
    let lo = 0, hi = span;
    for (const s of ss) { if (s <= sc) lo = s; else { hi = s; break; } }
    const add = [];
    if (lo > 1e-6) add.push({ type: 'arc', layer: e.layer, color: e.color, cx: e.cx, cy: e.cy, r: e.r, a0: e.a0, a1: e.a0 + lo });
    if (hi < span - 1e-6) add.push({ type: 'arc', layer: e.layer, color: e.color, cx: e.cx, cy: e.cy, r: e.r, a0: e.a0 + hi, a1: e.a1 });
    return { add };
  }
  return { err: 'トリムできるのは線分・円・円弧のみです（ポリラインは分解してください）' };
}
/* 延長: クリックに近い端を境界エッジまで延長した結果を返す（純関数） */
function extendTarget(e, boundaries, click) {
  if (e.type === 'line') {
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    const extEnd = dist(click, b) < dist(click, a) ? 'b' : 'a';
    const cand = [];
    for (const bd of boundaries) {
      if (bd.id === e.id) continue;
      for (const s of entIntSegs(bd)) {
        let ps = [];
        if (s.kind === 'line') {
          const p = lineLineInt(a, b, s.a, s.b, false);
          if (p) {
            const u = segParam(s.a, s.b, p);
            if (u >= -1e-9 && u <= 1 + 1e-9) ps = [p];
          }
        } else {
          const C = s.kind === 'circle' ? { c: s.c, r: s.r, arc: null } : { c: { x: s.arc.cx, y: s.arc.cy }, r: s.arc.r, arc: s.arc };
          ps = lineCircleInt(a, b, C.c, C.r, false).filter(p => !C.arc || arcContains(C.arc, Math.atan2(p.y - C.c.y, p.x - C.c.x)));
        }
        for (const p of ps) {
          const t = segParam(a, b, p);
          if (extEnd === 'b' && t > 1 + 1e-9) cand.push({ t, p });
          if (extEnd === 'a' && t < -1e-9) cand.push({ t, p });
        }
      }
    }
    if (!cand.length) return { err: '延長方向に境界エッジとの交点がありません' };
    const best = extEnd === 'b'
      ? cand.reduce((m, c) => (c.t < m.t ? c : m))
      : cand.reduce((m, c) => (c.t > m.t ? c : m));
    const ne = clone(e);
    if (extEnd === 'b') { ne.x2 = best.p.x; ne.y2 = best.p.y; }
    else { ne.x1 = best.p.x; ne.y1 = best.p.y; }
    return { ent: ne };
  }
  if (e.type === 'arc') {
    const pa0 = arcPoint(e, e.a0), pa1 = arcPoint(e, e.a1);
    const end = dist(click, pa1) < dist(click, pa0) ? 'a1' : 'a0';
    const cand = [];
    for (const bd of boundaries) {
      if (bd.id === e.id) continue;
      for (const s of entIntSegs(bd)) {
        let ps = [];
        if (s.kind === 'line') ps = lineCircleInt(s.a, s.b, { x: e.cx, y: e.cy }, e.r, true);
        else {
          const C = s.kind === 'circle' ? { c: s.c, r: s.r, arc: null } : { c: { x: s.arc.cx, y: s.arc.cy }, r: s.arc.r, arc: s.arc };
          ps = circleCircleInt({ x: e.cx, y: e.cy }, e.r, C.c, C.r).filter(p => !C.arc || arcContains(C.arc, Math.atan2(p.y - C.c.y, p.x - C.c.x)));
        }
        for (const p of ps) {
          const ang = Math.atan2(p.y - e.cy, p.x - e.cx);
          if (arcContains(e, ang)) continue;
          if (end === 'a1') cand.push({ d: ccwSpan(e.a1, ang), ang });
          else cand.push({ d: ccwSpan(ang, e.a0), ang });
        }
      }
    }
    const ok = cand.filter(c => c.d > 1e-9);
    if (!ok.length) return { err: '延長方向に境界エッジとの交点がありません' };
    const best = ok.reduce((m, c) => (c.d < m.d ? c : m));
    const ne = clone(e);
    if (end === 'a1') ne.a1 = best.ang; else ne.a0 = best.ang;
    return { ent: ne };
  }
  return { err: '延長できるのは線分・円弧のみです' };
}
/* フィレット計算（純関数）: e1/e2 は line、c1/c2 は残す側のクリック点 */
function filletCompute(e1, c1, e2, c2, r) {
  const a1 = { x: e1.x1, y: e1.y1 }, b1 = { x: e1.x2, y: e1.y2 };
  const a2 = { x: e2.x1, y: e2.y1 }, b2 = { x: e2.x2, y: e2.y2 };
  const X = lineLineInt(a1, b1, a2, b2, false);
  if (!X) return { err: '2 本の線分が平行のため処理できません' };
  const mkU = (a, b, click) => {
    const L = dist(a, b);
    if (L < 1e-9) return null;
    const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const s = Math.sign((click.x - X.x) * u.x + (click.y - X.y) * u.y) || 1;
    return { x: u.x * s, y: u.y * s };
  };
  const u1 = mkU(a1, b1, c1), u2 = mkU(a2, b2, c2);
  if (!u1 || !u2) return { err: '線分の長さが 0 です' };
  const cosPhi = u1.x * u2.x + u1.y * u2.y;
  const phi = Math.acos(Math.max(-1, Math.min(1, cosPhi)));
  if (phi < 1e-6 || Math.PI - phi < 1e-6) return { err: '2 線分の角度が小さすぎます' };
  const tLen = r / Math.tan(phi / 2);
  const farEnd = (a, b, u) => {
    const pa = (a.x - X.x) * u.x + (a.y - X.y) * u.y;
    const pb = (b.x - X.x) * u.x + (b.y - X.y) * u.y;
    return pa > pb ? { p: a, proj: pa } : { p: b, proj: pb };
  };
  const f1 = farEnd(a1, b1, u1), f2 = farEnd(a2, b2, u2);
  if (tLen > f1.proj - 1e-9 || tLen > f2.proj - 1e-9) return { err: '半径（距離）が大きすぎます' };
  const t1 = { x: X.x + u1.x * tLen, y: X.y + u1.y * tLen };
  const t2 = { x: X.x + u2.x * tLen, y: X.y + u2.y * tLen };
  let arc = null;
  if (r > 1e-9) {
    const bis = { x: u1.x + u2.x, y: u1.y + u2.y };
    const bl = Math.hypot(bis.x, bis.y);
    if (bl < 1e-9) return { err: '角度が 180° に近すぎます' };
    const C = { x: X.x + bis.x / bl * (r / Math.sin(phi / 2)), y: X.y + bis.y / bl * (r / Math.sin(phi / 2)) };
    let aa = Math.atan2(t1.y - C.y, t1.x - C.x), ab = Math.atan2(t2.y - C.y, t2.x - C.x);
    if (ccwSpan(aa, ab) > Math.PI) { const t = aa; aa = ab; ab = t; }
    arc = { cx: C.x, cy: C.y, r, a0: aa, a1: ab };
  }
  return { X, t1, t2, f1: f1.p, f2: f2.p, arc };
}
/* 面取り計算（純関数）: 距離 d1, d2 */
function chamferCompute(e1, c1, e2, c2, d1, d2) {
  const base = filletCompute(e1, c1, e2, c2, 0);
  if (base.err) return base;
  const X = base.X;
  const u = (t, X0) => {
    const L = dist(X0, t) || 1;
    return { x: (t.x - X0.x) / L, y: (t.y - X0.y) / L };
  };
  // filletCompute(r=0) の t1/t2 は X に一致するため、u は farEnd 方向から取り直す
  const u1 = u(base.f1, X), u2 = u(base.f2, X);
  const proj1 = (base.f1.x - X.x) * u1.x + (base.f1.y - X.y) * u1.y;
  const proj2 = (base.f2.x - X.x) * u2.x + (base.f2.y - X.y) * u2.y;
  if (d1 > proj1 - 1e-9 || d2 > proj2 - 1e-9) return { err: '面取り距離が大きすぎます' };
  const q1 = { x: X.x + u1.x * d1, y: X.y + u1.y * d1 };
  const q2 = { x: X.x + u2.x * d2, y: X.y + u2.y * d2 };
  return { X, t1: q1, t2: q2, f1: base.f1, f2: base.f2 };
}
function* pickEnt(prompt, types, typeMsg) {
  while (true) {
    const id = yield PICK(prompt);
    if (id == null) return null;
    const e = S.entities.find(x => x.id === id);
    if (!e) continue;
    if (types && !types.includes(e.type)) { log(typeMsg || '対象外のオブジェクトです'); continue; }
    if (layerOf(e).locked) { log('ロック画層のオブジェクトです'); continue; }
    return e;
  }
}
function* cmdTRIM() {
  let ids = yield SEL('切り取りエッジを選択 (Enter=すべてのオブジェクト):');
  const useAll = !ids.length;
  if (useAll) log('すべてのオブジェクトを切り取りエッジとして使用します');
  let n = 0;
  while (true) {
    const res = yield PICKPT('トリムするオブジェクトを選択 <終了>:');
    if (!res) break;
    const e = S.entities.find(x => x.id === res.id);
    if (!e) continue;
    if (layerOf(e).locked) { log('ロック画層のオブジェクトです'); continue; }
    const cutters = useAll ? visibleEntities() : entsOf(ids);
    const r = trimPieces(e, cutters, res.pt);
    if (r.err) { log(r.err); continue; }
    Engine.mutate();
    for (const ne of r.add) { ne.id = S.nextId++; S.entities.push(ne); }
    removeIds([e.id]);
    n++;
    scheduleRedraw();
  }
  if (n) log(n + ' 個をトリムしました');
}
function* cmdEXTEND() {
  let ids = yield SEL('境界エッジを選択 (Enter=すべてのオブジェクト):');
  const useAll = !ids.length;
  if (useAll) log('すべてのオブジェクトを境界エッジとして使用します');
  let n = 0;
  while (true) {
    const res = yield PICKPT('延長するオブジェクトを選択（延長する側をクリック）<終了>:');
    if (!res) break;
    const e = S.entities.find(x => x.id === res.id);
    if (!e) continue;
    if (layerOf(e).locked) { log('ロック画層のオブジェクトです'); continue; }
    const boundaries = useAll ? visibleEntities() : entsOf(ids);
    const r = extendTarget(e, boundaries, res.pt);
    if (r.err) { log(r.err); continue; }
    Engine.mutate();
    replaceEnts([Object.assign(r.ent, { id: e.id })]);
    n++;
    afterGeomEdit([e.id]);
    scheduleRedraw();
  }
  if (n) log(n + ' 個を延長しました');
}
function* cmdFILLET() {
  log('現在のフィレット半径 = ' + fmt(S.filletR));
  let first = null;
  while (true) {
    const res = yield PICKPT(first ? '2 本目の線分を選択:' : '1 本目の線分を選択 または [半径(R)]:', first ? {} : { keywords: ['R'] });
    if (res == null) return;
    if (res.kw === 'R') {
      const r = yield DST('フィレット半径を指定 <' + fmt(S.filletR) + '>:', { def: S.filletR });
      if (r != null && typeof r === 'number' && r >= 0) { S.filletR = r; log('フィレット半径 = ' + fmt(r)); }
      continue;
    }
    const e = S.entities.find(x => x.id === res.id);
    if (!e || e.type !== 'line') { log('線分を選択してください'); continue; }
    if (layerOf(e).locked) { log('ロック画層のオブジェクトです'); continue; }
    if (!first) { first = { e, pt: res.pt }; continue; }
    if (first.e.id === e.id) { log('同じ線分です。別の線分を選択してください'); continue; }
    const fc = filletCompute(first.e, first.pt, e, res.pt, S.filletR);
    if (fc.err) { toast(fc.err, 'error'); first = null; continue; }
    Engine.mutate();
    const n1 = clone(first.e); n1.x1 = fc.t1.x; n1.y1 = fc.t1.y; n1.x2 = fc.f1.x; n1.y2 = fc.f1.y;
    const n2 = clone(e); n2.x1 = fc.t2.x; n2.y1 = fc.t2.y; n2.x2 = fc.f2.x; n2.y2 = fc.f2.y;
    replaceEnts([n1, n2]);
    if (fc.arc) addEntity(Object.assign({ type: 'arc', layer: first.e.layer, color: first.e.color }, fc.arc));
    log('フィレット完了 (R = ' + fmt(S.filletR) + ')');
    afterGeomEdit([n1.id, n2.id]);
    return;
  }
}
function* cmdCHAMFER() {
  log('現在の面取り距離 = ' + fmt(S.chamferD1) + ', ' + fmt(S.chamferD2));
  let first = null;
  while (true) {
    const res = yield PICKPT(first ? '2 本目の線分を選択:' : '1 本目の線分を選択 または [距離(D)]:', first ? {} : { keywords: ['D'] });
    if (res == null) return;
    if (res.kw === 'D') {
      const d1 = yield DST('1 本目の面取り距離を指定 <' + fmt(S.chamferD1) + '>:', { def: S.chamferD1 });
      if (d1 == null || typeof d1 !== 'number' || d1 < 0) continue;
      const d2 = yield DST('2 本目の面取り距離を指定 <' + fmt(d1) + '>:', { def: d1 });
      S.chamferD1 = d1;
      S.chamferD2 = (d2 != null && typeof d2 === 'number' && d2 >= 0) ? d2 : d1;
      log('面取り距離 = ' + fmt(S.chamferD1) + ', ' + fmt(S.chamferD2));
      continue;
    }
    const e = S.entities.find(x => x.id === res.id);
    if (!e || e.type !== 'line') { log('線分を選択してください'); continue; }
    if (layerOf(e).locked) { log('ロック画層のオブジェクトです'); continue; }
    if (!first) { first = { e, pt: res.pt }; continue; }
    if (first.e.id === e.id) { log('同じ線分です。別の線分を選択してください'); continue; }
    const cc = chamferCompute(first.e, first.pt, e, res.pt, S.chamferD1, S.chamferD2);
    if (cc.err) { toast(cc.err, 'error'); first = null; continue; }
    Engine.mutate();
    const n1 = clone(first.e); n1.x1 = cc.t1.x; n1.y1 = cc.t1.y; n1.x2 = cc.f1.x; n1.y2 = cc.f1.y;
    const n2 = clone(e); n2.x1 = cc.t2.x; n2.y1 = cc.t2.y; n2.x2 = cc.f2.x; n2.y2 = cc.f2.y;
    replaceEnts([n1, n2]);
    if (dist(cc.t1, cc.t2) > 1e-9) addEntity({ type: 'line', layer: first.e.layer, color: first.e.color, x1: cc.t1.x, y1: cc.t1.y, x2: cc.t2.x, y2: cc.t2.y });
    log('面取り完了 (' + fmt(S.chamferD1) + ', ' + fmt(S.chamferD2) + ')');
    afterGeomEdit([n1.id, n2.id]);
    return;
  }
}

/* ================================================================ 寸法 */
function dimStyleOf(e) {
  return S.dimStyles.find(s => s.name === (e.style || S.curDimStyle)) || S.dimStyles[0];
}
function fmtPrec(n, prec) {
  return Number(n).toFixed(Math.max(0, Math.min(6, prec == null ? 2 : prec)));
}
function dimMeasure(e) {
  if (e.dtype === 'linear') {
    const u = { x: Math.cos(e.ang || 0), y: Math.sin(e.ang || 0) };
    return Math.abs((e.p2.x - e.p1.x) * u.x + (e.p2.y - e.p1.y) * u.y);
  }
  if (e.dtype === 'aligned') return dist(e.p1, e.p2);
  if (e.dtype === 'radius') return e.r;
  if (e.dtype === 'diameter') return 2 * e.r;
  return 0;
}
function dimTextOf(e) {
  if (e.text != null && e.text !== '') return e.text;
  const st = dimStyleOf(e);
  const pre = e.dtype === 'radius' ? 'R' : e.dtype === 'diameter' ? '⌀' : '';
  return pre + fmtPrec(dimMeasure(e), st.prec);
}
/* 寸法エンティティ → 描画ジオメトリ {segs:[[a,b]], arrows:[{p,ang,size}], label:{p,ang,h,str}} */
function dimGeometry(e) {
  const st = dimStyleOf(e);
  const k = st.scale || 1;
  const AH = st.arrow * k, TH = st.textH * k, GAP = st.gap * k, EO = st.extOffset * k, EB = st.extBeyond * k;
  const segs = [], arrows = [];
  let label = null;
  if (e.dtype === 'linear' || e.dtype === 'aligned') {
    let u;
    if (e.dtype === 'aligned') {
      const L = dist(e.p1, e.p2);
      u = L < 1e-12 ? { x: 1, y: 0 } : { x: (e.p2.x - e.p1.x) / L, y: (e.p2.y - e.p1.y) / L };
    } else {
      u = { x: Math.cos(e.ang || 0), y: Math.sin(e.ang || 0) };
    }
    const n = { x: -u.y, y: u.x };
    const off1 = (e.pos.x - e.p1.x) * n.x + (e.pos.y - e.p1.y) * n.y;
    const off2 = (e.pos.x - e.p2.x) * n.x + (e.pos.y - e.p2.y) * n.y;
    const q1 = { x: e.p1.x + n.x * off1, y: e.p1.y + n.y * off1 };
    const q2 = { x: e.p2.x + n.x * off2, y: e.p2.y + n.y * off2 };
    const sg1 = Math.sign(off1) || 1, sg2 = Math.sign(off2) || 1;
    if (Math.abs(off1) > EO) segs.push([{ x: e.p1.x + n.x * EO * sg1, y: e.p1.y + n.y * EO * sg1 }, { x: q1.x + n.x * EB * sg1, y: q1.y + n.y * EB * sg1 }]);
    if (Math.abs(off2) > EO) segs.push([{ x: e.p2.x + n.x * EO * sg2, y: e.p2.y + n.y * EO * sg2 }, { x: q2.x + n.x * EB * sg2, y: q2.y + n.y * EB * sg2 }]);
    segs.push([q1, q2]);
    if (dist(q1, q2) > 1e-9) {
      const ua = Math.atan2(q2.y - q1.y, q2.x - q1.x);
      arrows.push({ p: q1, ang: ua + Math.PI, size: AH }, { p: q2, ang: ua, size: AH });
      let la = ua;
      if (Math.cos(la) < -1e-9 || (Math.abs(Math.cos(la)) < 1e-9 && Math.sin(la) < 0)) la += Math.PI;
      const mid = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 };
      const ln = { x: -Math.sin(la), y: Math.cos(la) };
      label = { p: { x: mid.x + ln.x * GAP, y: mid.y + ln.y * GAP }, ang: la, h: TH, str: dimTextOf(e) };
    }
  } else if (e.dtype === 'radius' || e.dtype === 'diameter') {
    const c = e.p1;
    const L = dist(c, e.pos);
    const dir = L < 1e-12 ? { x: 1, y: 0 } : { x: (e.pos.x - c.x) / L, y: (e.pos.y - c.y) / L };
    const pt = { x: c.x + dir.x * e.r, y: c.y + dir.y * e.r };
    if (e.dtype === 'diameter') {
      const p0 = { x: c.x - dir.x * e.r, y: c.y - dir.y * e.r };
      segs.push([p0, e.pos]);
      arrows.push({ p: p0, ang: Math.atan2(-dir.y, -dir.x), size: AH }, { p: pt, ang: Math.atan2(dir.y, dir.x), size: AH });
    } else {
      segs.push([c, e.pos]);
      arrows.push({ p: pt, ang: Math.atan2(dir.y, dir.x), size: AH });
    }
    label = { p: { x: e.pos.x + dir.x * GAP, y: e.pos.y + dir.y * GAP + GAP }, ang: 0, h: TH, str: dimTextOf(e) };
  }
  return { segs, arrows, label };
}
/* 寸法 → DXF/分解用プリミティブ（線分 + 文字） */
function dimToPrimitives(e) {
  const geo = dimGeometry(e);
  const out = [];
  const base = { layer: e.layer, color: e.color };
  for (const s of geo.segs) out.push(Object.assign({ type: 'line', x1: s[0].x, y1: s[0].y, x2: s[1].x, y2: s[1].y }, base));
  for (const ar of geo.arrows) {
    const L = ar.size;
    const bx = ar.p.x - Math.cos(ar.ang) * L, by = ar.p.y - Math.sin(ar.ang) * L;
    const px = -Math.sin(ar.ang) * L * 0.35, py = Math.cos(ar.ang) * L * 0.35;
    out.push(Object.assign({ type: 'line', x1: ar.p.x, y1: ar.p.y, x2: bx + px, y2: by + py }, base));
    out.push(Object.assign({ type: 'line', x1: ar.p.x, y1: ar.p.y, x2: bx - px, y2: by - py }, base));
  }
  if (geo.label) {
    const w = geo.label.str.length * geo.label.h * 0.35;
    out.push(Object.assign({
      type: 'text',
      x: geo.label.p.x - Math.cos(geo.label.ang) * w,
      y: geo.label.p.y - Math.sin(geo.label.ang) * w,
      h: geo.label.h, rot: geo.label.ang, str: geo.label.str
    }, base));
  }
  return out;
}
function pickLinearAng(p1, p2, pos) {
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  return Math.abs(pos.y - mid.y) >= Math.abs(pos.x - mid.x) ? 0 : Math.PI / 2;
}
function* cmdDIMLINEAR() {
  const p1 = yield P('1 本目の補助線の起点を指定:');
  if (!p1) return;
  const p2 = yield P('2 本目の補助線の起点を指定:', { base: p1 });
  if (!p2) return;
  const pos = yield P('寸法線の位置を指定:', {
    preview: (g, cur) => drawDimGeometry(g, dimGeometry({ type: 'dim', dtype: 'linear', p1, p2, pos: cur, ang: pickLinearAng(p1, p2, cur), style: S.curDimStyle }), '#9aa7b5')
  });
  if (!pos) return;
  Engine.mutate();
  addEntity({ type: 'dim', dtype: 'linear', p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y }, pos: { x: pos.x, y: pos.y }, ang: pickLinearAng(p1, p2, pos), style: S.curDimStyle, text: null });
}
function* cmdDIMALIGNED() {
  const p1 = yield P('1 本目の補助線の起点を指定:');
  if (!p1) return;
  const p2 = yield P('2 本目の補助線の起点を指定:', { base: p1 });
  if (!p2) return;
  const pos = yield P('寸法線の位置を指定:', {
    preview: (g, cur) => drawDimGeometry(g, dimGeometry({ type: 'dim', dtype: 'aligned', p1, p2, pos: cur, style: S.curDimStyle }), '#9aa7b5')
  });
  if (!pos) return;
  Engine.mutate();
  addEntity({ type: 'dim', dtype: 'aligned', p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y }, pos: { x: pos.x, y: pos.y }, style: S.curDimStyle, text: null });
}
function* dimRadial(dtype) {
  const e = yield* pickEnt('円または円弧を選択:', ['circle', 'arc'], '円または円弧を選択してください');
  if (!e) return;
  const pos = yield P('寸法の配置位置を指定:', {
    preview: (g, cur) => drawDimGeometry(g, dimGeometry({ type: 'dim', dtype, p1: { x: e.cx, y: e.cy }, r: e.r, pos: cur, style: S.curDimStyle }), '#9aa7b5')
  });
  if (!pos) return;
  Engine.mutate();
  addEntity({ type: 'dim', dtype, p1: { x: e.cx, y: e.cy }, r: e.r, pos: { x: pos.x, y: pos.y }, style: S.curDimStyle, text: null });
}
function* cmdDIMRADIUS() { yield* dimRadial('radius'); }
function* cmdDIMDIAMETER() { yield* dimRadial('diameter'); }

/* ---------------- 寸法スタイル ダイアログ ---------------- */
const DIMSTYLE_FIELDS = [
  ['textH', '文字高さ', 0.1], ['arrow', '矢印サイズ', 0.1], ['extOffset', '補助線オフセット', 0],
  ['extBeyond', '補助線はみ出し', 0], ['gap', '文字と寸法線の間隔', 0], ['prec', '小数点以下桁数', 0], ['scale', '全体尺度', 0.01]
];
function openDimStyleDialog() {
  const body = document.createElement('div');
  // スタイル選択
  const rowSel = document.createElement('div'); rowSel.className = 'modal-row';
  rowSel.innerHTML = '<label>スタイル</label>';
  const sel = document.createElement('select');
  const rebuildSel = () => {
    sel.innerHTML = '';
    for (const st of S.dimStyles) {
      const o = document.createElement('option');
      o.value = st.name;
      o.textContent = st.name + (st.name === S.curDimStyle ? ' (現在)' : '');
      sel.appendChild(o);
    }
  };
  rebuildSel();
  rowSel.appendChild(sel);
  body.appendChild(rowSel);
  // 新規作成
  const rowNew = document.createElement('div'); rowNew.className = 'modal-row';
  rowNew.innerHTML = '<label>新規スタイル</label>';
  const inpNew = document.createElement('input');
  inpNew.type = 'text'; inpNew.placeholder = '新しいスタイル名';
  const btnNew = document.createElement('button');
  btnNew.textContent = '作成';
  btnNew.style.flex = 'none';
  btnNew.onclick = () => {
    const name = inpNew.value.trim();
    if (!name) return;
    if (S.dimStyles.some(s => s.name === name)) { toast('同名のスタイルがあります', 'error'); return; }
    pushHistory();
    const cur = S.dimStyles.find(s => s.name === sel.value) || S.dimStyles[0];
    S.dimStyles.push(Object.assign({}, cur, { name }));
    inpNew.value = '';
    rebuildSel();
    sel.value = name;
    fillFields();
    log('寸法スタイルを作成しました: ' + name);
  };
  rowNew.appendChild(inpNew);
  rowNew.appendChild(btnNew);
  body.appendChild(rowNew);
  // 各フィールド
  const inputs = {};
  for (const [key, label] of DIMSTYLE_FIELDS) {
    const row = document.createElement('div'); row.className = 'modal-row';
    const lab = document.createElement('label'); lab.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = 'any';
    inputs[key] = inp;
    row.appendChild(lab); row.appendChild(inp);
    body.appendChild(row);
  }
  const fillFields = () => {
    const st = S.dimStyles.find(s => s.name === sel.value) || S.dimStyles[0];
    for (const [key] of DIMSTYLE_FIELDS) inputs[key].value = st[key];
  };
  sel.onchange = fillFields;
  fillFields();
  showModal('寸法スタイル管理', body, [
    {
      label: '現在に設定', onClick: () => {
        S.curDimStyle = sel.value;
        rebuildSel(); sel.value = S.curDimStyle;
        log('現在の寸法スタイル: ' + S.curDimStyle);
      }
    },
    {
      label: '選択寸法に適用', onClick: () => {
        const dims = entsOf([...S.sel]).filter(e => e.type === 'dim');
        if (!dims.length) { toast('寸法が選択されていません', 'error'); return; }
        pushHistory();
        for (const d of dims) d.style = sel.value;
        scheduleRedraw(); renderProps();
        log(dims.length + ' 個の寸法にスタイルを適用しました');
      }
    },
    {
      label: '保存', primary: true, onClick: () => {
        const st = S.dimStyles.find(s => s.name === sel.value);
        if (!st) return;
        pushHistory();
        for (const [key, , min] of DIMSTYLE_FIELDS) {
          const v = parseFloat(inputs[key].value);
          if (Number.isFinite(v) && v >= min) st[key] = key === 'prec' ? Math.round(v) : v;
        }
        scheduleRedraw();
        log('寸法スタイルを更新しました: ' + st.name);
      }
    },
    { label: '閉じる', onClick: (close) => close() }
  ]);
}

/* ---------------- 汎用モーダル ---------------- */
function showModal(title, bodyEl, buttons) {
  const back = document.getElementById('modal-back');
  const box = document.getElementById('modal-box');
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const ttl = document.createElement('span');
  ttl.textContent = title;
  const x = document.createElement('button');
  x.textContent = '✕';
  x.onclick = closeModal;
  head.appendChild(ttl); head.appendChild(x);
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'modal-body';
  bodyWrap.appendChild(bodyEl);
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  for (const b of (buttons || [])) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.primary) btn.className = 'primary';
    btn.onclick = () => b.onClick(closeModal);
    foot.appendChild(btn);
  }
  box.appendChild(head); box.appendChild(bodyWrap); box.appendChild(foot);
  back.hidden = false;
}
function closeModal() {
  const back = document.getElementById('modal-back');
  back.hidden = true;
  document.getElementById('modal-box').innerHTML = '';
}

/* ================================================================ 拘束 */
const CON_KINDS = {
  coincident: { jp: '一致' }, collinear: { jp: '同一線上' }, concentric: { jp: '同心円' },
  parallel: { jp: '平行' }, perpendicular: { jp: '直交' }, horizontal: { jp: '水平' }, vertical: { jp: '垂直' },
  tangent: { jp: '接線' }, symmetric: { jp: '対称' }, equal: { jp: '等値' }, midpoint: { jp: '中点' }, fix: { jp: '固定' },
  hdist: { jp: '水平距離', dim: true }, vdist: { jp: '垂直距離', dim: true }, adist: { jp: '平行距離', dim: true },
  angle: { jp: '角度', dim: true, unit: '°' }, radius: { jp: '半径', dim: true }, diameter: { jp: '直径', dim: true }
};
/* クリック位置に最も近い拘束参照点を返す */
function nearestRefPoint(e, p) {
  const cands = [];
  if (e.type === 'line') {
    cands.push({ pt: 'start', x: e.x1, y: e.y1 }, { pt: 'end', x: e.x2, y: e.y2 },
      { pt: 'mid', x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 });
  } else if (e.type === 'circle') {
    cands.push({ pt: 'center', x: e.cx, y: e.cy });
  } else if (e.type === 'arc') {
    const s = arcPoint(e, e.a0), t = arcPoint(e, e.a1);
    cands.push({ pt: 'center', x: e.cx, y: e.cy }, { pt: 'start', x: s.x, y: s.y }, { pt: 'end', x: t.x, y: t.y });
  } else {
    cands.push({ pt: null, x: e.x, y: e.y });
  }
  let best = cands[0], bd = Infinity;
  for (const c of cands) { const d = dist(p, c); if (d < bd) { bd = d; best = c; } }
  return best;
}
function addConstraint(c) {
  c.id = S.nextCid++;
  Engine.mutate();
  S.constraints.push(c);
  log('拘束を追加: ' + CON_KINDS[c.kind].jp + ' (#' + c.id + ')');
  solveConstraintsNow();
}
function solveConstraintsNow() {
  if (!S.constraints.length) {
    S.conStatus = null;
    renderConstraints(); scheduleRedraw();
    return null;
  }
  let r;
  try { r = Solver.solve(S.entities, S.constraints); }
  catch (err) { console.error(err); toast('ソルバーエラー: ' + err.message, 'error'); return null; }
  if (r.converged) r.apply();
  else toast('拘束を満たす解が見つかりません（矛盾拘束の可能性）。拘束パネルを確認してください。', 'error');
  S.conStatus = r;
  renderConstraints(); renderProps(); scheduleRedraw();
  return r;
}
function consolveNow() {
  if (!S.constraints.length) { log('拘束がありません'); return; }
  pushHistory();
  const r = solveConstraintsNow();
  if (r) log('再計算: ' + (r.converged ? '収束' : '未収束') + '（反復 ' + r.iters + ' 回、最大残差 ' + r.maxRes.toExponential(2) + '）');
}
/* 修正コマンド後、拘束対象が動いた場合に再計算 */
function afterGeomEdit(ids) {
  if (!S.constraints.length) return;
  const idSet = new Set(ids);
  if (S.constraints.some(c => c.refs.some(rf => idSet.has(rf.id)))) solveConstraintsNow();
}
/* 拘束 1 行分の DOM（パネル・プロパティ共用） */
function constraintRow(c) {
  const meta = CON_KINDS[c.kind] || { jp: c.kind };
  const row = document.createElement('div');
  row.className = 'con-row';
  const kind = document.createElement('span');
  kind.className = 'con-kind';
  kind.textContent = '#' + c.id + ' ' + meta.jp;
  const ents = document.createElement('span');
  ents.className = 'con-ents';
  ents.textContent = c.refs.map(rf => 'ID' + rf.id + (rf.pt ? ':' + rf.pt : '')).join(', ');
  ents.title = ents.textContent;
  row.appendChild(kind);
  row.appendChild(ents);
  if (meta.dim) {
    const inp = document.createElement('input');
    inp.className = 'con-val';
    inp.type = 'text';
    inp.value = fmtPrec(c.value, 4).replace(/\.?0+$/, '') + (meta.unit || '');
    inp.title = '拘束値を編集して Enter';
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) { inp.value = fmtPrec(c.value, 4); return; }
      pushHistory();
      c.value = v;
      log('拘束 #' + c.id + ' の値を ' + v + ' に変更しました');
      solveConstraintsNow();
    };
    row.appendChild(inp);
  }
  const del = document.createElement('button');
  del.className = 'con-del';
  del.textContent = '✕';
  del.title = 'この拘束を削除';
  del.onclick = () => {
    pushHistory();
    S.constraints = S.constraints.filter(x => x.id !== c.id);
    log('拘束 #' + c.id + ' を削除しました');
    solveConstraintsNow();
  };
  row.appendChild(del);
  return row;
}
function renderConstraints() {
  const stEl = document.getElementById('con-status');
  const listEl = document.getElementById('con-list');
  if (!stEl || !listEl) return;
  const st = S.conStatus;
  if (!S.constraints.length) {
    stEl.innerHTML = '<span class="con-empty">拘束なし</span>';
  } else if (!st) {
    stEl.textContent = '拘束: ' + S.constraints.length + '（未計算 — 再計算を実行してください）';
  } else {
    let cls = 'con-ok', msg = '✔ 適合';
    if (!st.converged) { cls = 'con-err'; msg = '✖ 矛盾拘束の疑い（収束せず、最大残差 ' + st.maxRes.toExponential(1) + '）'; }
    else if (st.redundant > 0) { cls = 'con-warn'; msg = '⚠ 過拘束（冗長 ' + st.redundant + ' 式）'; }
    else if (st.dof === 0) { msg = '✔ 完全拘束'; }
    stEl.innerHTML = '';
    const l1 = document.createElement('div');
    l1.textContent = '拘束: ' + S.constraints.length + ' ／ 式: ' + st.nEqs + ' ／ 変数: ' + st.nVars;
    const l2 = document.createElement('div');
    l2.textContent = '未拘束自由度: ' + st.dof;
    const l3 = document.createElement('div');
    l3.className = cls;
    l3.textContent = msg;
    stEl.append(l1, l2, l3);
  }
  listEl.innerHTML = '';
  for (const c of S.constraints) listEl.appendChild(constraintRow(c));
}
/* 寸法拘束の注釈をキャンバスに描画 */
const CON_COLOR = '#c79bff';
function drawConstraintAnnos(g) {
  for (const c of S.constraints) {
    const meta = CON_KINDS[c.kind];
    if (!meta || !meta.dim || !c.pos) continue;
    const ents = c.refs.map(rf => S.entities.find(e => e.id === rf.id));
    if (ents.some(e => !e)) continue;
    let pseudo = null;
    if (c.kind === 'hdist' || c.kind === 'vdist' || c.kind === 'adist') {
      const pA = Solver.refPointOf(ents[0], c.refs[0].pt);
      const pB = Solver.refPointOf(ents[1], c.refs[1].pt);
      if (!pA || !pB) continue;
      pseudo = {
        type: 'dim', dtype: c.kind === 'adist' ? 'aligned' : 'linear',
        ang: c.kind === 'vdist' ? Math.PI / 2 : 0,
        p1: pA, p2: pB, pos: c.pos, style: S.curDimStyle,
        text: 'd' + c.id + '=' + fmtPrec(c.value, 2)
      };
    } else if (c.kind === 'radius' || c.kind === 'diameter') {
      if (ents[0].cx == null) continue;
      pseudo = {
        type: 'dim', dtype: c.kind,
        p1: { x: ents[0].cx, y: ents[0].cy }, r: ents[0].r, pos: c.pos, style: S.curDimStyle,
        text: (c.kind === 'radius' ? 'R' : '⌀') + c.id + '=' + fmtPrec(c.value, 2)
      };
    } else if (c.kind === 'angle') {
      const st = dimStyleOf({ style: S.curDimStyle });
      drawDimGeometry(g, {
        segs: [], arrows: [],
        label: { p: c.pos, ang: 0, h: st.textH * (st.scale || 1), str: '∠' + c.id + '=' + fmtPrec(c.value, 2) + '°' }
      }, CON_COLOR);
      continue;
    }
    if (pseudo) drawDimGeometry(g, dimGeometry(pseudo), CON_COLOR);
  }
}
/* ---------------- 幾何拘束コマンド ---------------- */
function* pick2Lines(label) {
  const e1 = yield* pickEnt('1 本目の線分を選択:', ['line'], '線分を選択してください');
  if (!e1) return null;
  const e2 = yield* pickEnt('2 本目の線分を選択:', ['line'], '線分を選択してください');
  if (!e2) return null;
  if (e1.id === e2.id) { log('同じオブジェクトです'); return null; }
  return [e1, e2];
}
function* cmdGCCOINCIDENT() {
  const a = yield REF('1 点目を指定（端点 / 中点 / 中心の近くをクリック）:');
  if (!a) return;
  const b = yield REF('2 点目を指定:');
  if (!b) return;
  if (a.entId === b.entId && a.pt === b.pt) { log('同じ点です'); return; }
  addConstraint({ kind: 'coincident', refs: [{ id: a.entId, pt: a.pt }, { id: b.entId, pt: b.pt }] });
}
function* cmdGCPARALLEL() {
  const p = yield* pick2Lines(); if (!p) return;
  addConstraint({ kind: 'parallel', refs: [{ id: p[0].id }, { id: p[1].id }] });
}
function* cmdGCPERPENDICULAR() {
  const p = yield* pick2Lines(); if (!p) return;
  addConstraint({ kind: 'perpendicular', refs: [{ id: p[0].id }, { id: p[1].id }] });
}
function* cmdGCCOLLINEAR() {
  const p = yield* pick2Lines(); if (!p) return;
  addConstraint({ kind: 'collinear', refs: [{ id: p[0].id }, { id: p[1].id }] });
}
function* cmdGCCONCENTRIC() {
  const e1 = yield* pickEnt('1 つ目の円 / 円弧を選択:', ['circle', 'arc'], '円または円弧を選択してください');
  if (!e1) return;
  const e2 = yield* pickEnt('2 つ目の円 / 円弧を選択:', ['circle', 'arc'], '円または円弧を選択してください');
  if (!e2) return;
  if (e1.id === e2.id) { log('同じオブジェクトです'); return; }
  addConstraint({ kind: 'concentric', refs: [{ id: e1.id }, { id: e2.id }] });
}
function* cmdGCHORIZONTAL() {
  const e = yield* pickEnt('水平にする線分を選択:', ['line'], '線分を選択してください');
  if (!e) return;
  addConstraint({ kind: 'horizontal', refs: [{ id: e.id }] });
}
function* cmdGCVERTICAL() {
  const e = yield* pickEnt('垂直にする線分を選択:', ['line'], '線分を選択してください');
  if (!e) return;
  addConstraint({ kind: 'vertical', refs: [{ id: e.id }] });
}
function* cmdGCTANGENT() {
  const e1 = yield* pickEnt('1 つ目のオブジェクトを選択（線分 / 円 / 円弧）:', ['line', 'circle', 'arc']);
  if (!e1) return;
  const e2 = yield* pickEnt('2 つ目のオブジェクトを選択（線分 / 円 / 円弧）:', ['line', 'circle', 'arc']);
  if (!e2) return;
  if (e1.id === e2.id) { log('同じオブジェクトです'); return; }
  if (e1.type === 'line' && e2.type === 'line') { log('線分同士に接線拘束は設定できません'); return; }
  const data = {};
  if (e1.type === 'line' || e2.type === 'line') {
    const ln = e1.type === 'line' ? e1 : e2;
    const ci = e1.type === 'line' ? e2 : e1;
    const dx = ln.x2 - ln.x1, dy = ln.y2 - ln.y1;
    const n = Math.hypot(dx, dy) || 1;
    data.s = Math.sign((dx * (ci.cy - ln.y1) - dy * (ci.cx - ln.x1)) / n) || 1;
  } else {
    const d = Math.hypot(e1.cx - e2.cx, e1.cy - e2.cy);
    data.mode = Math.abs(d - (e1.r + e2.r)) <= Math.abs(d - Math.abs(e1.r - e2.r)) ? 'ext' : 'int';
    data.sg = Math.sign(e1.r - e2.r) || 1;
  }
  addConstraint({ kind: 'tangent', refs: [{ id: e1.id }, { id: e2.id }], data });
}
function* cmdGCSYMMETRIC() {
  const a = yield REF('対称にする 1 点目を指定:');
  if (!a) return;
  const b = yield REF('対称にする 2 点目を指定:');
  if (!b) return;
  const ax = yield* pickEnt('対称軸の線分を選択:', ['line'], '線分を選択してください');
  if (!ax) return;
  addConstraint({ kind: 'symmetric', refs: [{ id: a.entId, pt: a.pt }, { id: b.entId, pt: b.pt }, { id: ax.id }] });
}
function* cmdGCEQUAL() {
  const e1 = yield* pickEnt('1 つ目のオブジェクトを選択（線分 / 円 / 円弧）:', ['line', 'circle', 'arc']);
  if (!e1) return;
  const e2 = yield* pickEnt('2 つ目のオブジェクトを選択:', ['line', 'circle', 'arc']);
  if (!e2) return;
  if (e1.id === e2.id) { log('同じオブジェクトです'); return; }
  const isLine1 = e1.type === 'line', isLine2 = e2.type === 'line';
  if (isLine1 !== isLine2) { log('等値拘束は 線分同士（長さ）または 円 / 円弧同士（半径）にのみ設定できます'); return; }
  addConstraint({ kind: 'equal', refs: [{ id: e1.id }, { id: e2.id }] });
}
function* cmdGCMIDPOINT() {
  const a = yield REF('中点に拘束する点を指定:');
  if (!a) return;
  const ln = yield* pickEnt('線分を選択:', ['line'], '線分を選択してください');
  if (!ln) return;
  addConstraint({ kind: 'midpoint', refs: [{ id: a.entId, pt: a.pt }, { id: ln.id }] });
}
function* cmdGCFIX() {
  const a = yield REF('固定する点を指定（端点 / 中点 / 中心）:');
  if (!a) return;
  addConstraint({ kind: 'fix', refs: [{ id: a.entId, pt: a.pt }], data: { x: a.x, y: a.y } });
}
/* ---------------- 寸法拘束コマンド ---------------- */
function* dcDist2(kind) {
  const a = yield REF('1 点目を指定:');
  if (!a) return;
  const b = yield REF('2 点目を指定:');
  if (!b) return;
  if (a.entId === b.entId && a.pt === b.pt) { log('同じ点です'); return; }
  const pA = { x: a.x, y: a.y }, pB = { x: b.x, y: b.y };
  let cur;
  if (kind === 'hdist') cur = Math.abs(pB.x - pA.x);
  else if (kind === 'vdist') cur = Math.abs(pB.y - pA.y);
  else cur = dist(pA, pB);
  const pos = yield P('拘束注釈の配置位置を指定:');
  if (!pos) return;
  const vs = yield STR('拘束値を入力 <' + fmtPrec(cur, 4) + '>:', { def: '' });
  let v = parseFloat(vs);
  if (!Number.isFinite(v) || v < 0) v = cur;
  const data = {};
  if (kind === 'hdist') data.s = Math.sign(pB.x - pA.x) || 1;
  if (kind === 'vdist') data.s = Math.sign(pB.y - pA.y) || 1;
  addConstraint({ kind, refs: [{ id: a.entId, pt: a.pt }, { id: b.entId, pt: b.pt }], value: v, pos: { x: pos.x, y: pos.y }, data });
}
function* cmdDCHORIZONTAL() { yield* dcDist2('hdist'); }
function* cmdDCVERTICAL() { yield* dcDist2('vdist'); }
function* cmdDCALIGNED() { yield* dcDist2('adist'); }
function* cmdDCANGLE() {
  const p = yield* pick2Lines(); if (!p) return;
  const d1 = { x: p[0].x2 - p[0].x1, y: p[0].y2 - p[0].y1 };
  const d2 = { x: p[1].x2 - p[1].x1, y: p[1].y2 - p[1].y1 };
  const cur = deg(Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y));
  const pos = yield P('拘束注釈の配置位置を指定:');
  if (!pos) return;
  const vs = yield STR('角度を入力（度） <' + fmtPrec(cur, 2) + '>:', { def: '' });
  let v = parseFloat(vs);
  if (!Number.isFinite(v)) v = cur;
  addConstraint({ kind: 'angle', refs: [{ id: p[0].id }, { id: p[1].id }], value: v, pos: { x: pos.x, y: pos.y } });
}
function* dcRadial(kind) {
  const e = yield* pickEnt('円または円弧を選択:', ['circle', 'arc'], '円または円弧を選択してください');
  if (!e) return;
  const cur = kind === 'radius' ? e.r : 2 * e.r;
  const pos = yield P('拘束注釈の配置位置を指定:');
  if (!pos) return;
  const vs = yield STR('拘束値を入力 <' + fmtPrec(cur, 4) + '>:', { def: '' });
  let v = parseFloat(vs);
  if (!Number.isFinite(v) || v <= 0) v = cur;
  addConstraint({ kind, refs: [{ id: e.id }], value: v, pos: { x: pos.x, y: pos.y } });
}
function* cmdDCRADIUS() { yield* dcRadial('radius'); }
function* cmdDCDIAMETER() { yield* dcRadial('diameter'); }
function* cmdCONDELETE() {
  let ids = yield SEL('拘束を削除するオブジェクトを選択:');
  if (!ids.length) { log('選択がありません'); return; }
  const idSet = new Set(ids);
  const del = S.constraints.filter(c => c.refs.some(rf => idSet.has(rf.id)));
  if (!del.length) { log('選択オブジェクトに拘束はありません'); return; }
  Engine.mutate();
  const delSet = new Set(del.map(c => c.id));
  S.constraints = S.constraints.filter(c => !delSet.has(c.id));
  log(del.length + ' 個の拘束を削除しました');
  solveConstraintsNow();
}

/* ================================================================ 画像下敷き */
const elImgInput = document.getElementById('image-input');
function startImageAttach() {
  elImgInput.value = '';
  elImgInput.click();
}
elImgInput.addEventListener('change', () => {
  const f = elImgInput.files && elImgInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataURL = String(reader.result);
    const img = new Image();
    img.onload = () => {
      const key = 'img' + (S.nextImgKey++);
      S.imageData[key] = dataURL;
      IMG_CACHE[key] = img;
      Engine.start('IMAGEATTACH', { fn: function* () { yield* placeImage(key, img.naturalWidth, img.naturalHeight, f.name); } });
    };
    img.onerror = () => toast('画像を読み込めませんでした', 'error');
    img.src = dataURL;
  };
  reader.readAsDataURL(f);
});
function ghostRect(g, p, w, h) {
  gline(g, p, { x: p.x + w, y: p.y });
  gline(g, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h });
  gline(g, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h });
  gline(g, { x: p.x, y: p.y + h }, p);
}
function* placeImage(key, nw, nh, name) {
  const asp = nh / nw;
  const p = yield P('画像の挿入点（左下）を指定:', {
    preview: (g, cur) => ghostRect(g, cur, 100, 100 * asp)
  });
  if (!p) { delete S.imageData[key]; delete IMG_CACHE[key]; return; }
  const defW = 100;
  const w = yield DST('画像の幅を指定 <' + fmt(defW) + '>:', {
    base: p, def: defW,
    preview: (g, cur) => ghostRect(g, p, Math.max(1e-6, dist(p, cur)), Math.max(1e-6, dist(p, cur)) * asp)
  });
  let width = (w != null && typeof w === 'number' && w > 0) ? w : defW;
  Engine.mutate();
  addEntity({ type: 'image', x: p.x, y: p.y, w: width, h: width * asp, rot: 0, opacity: 0.8, locked: false, src: key, name: name || '' });
  log('画像を配置しました: ' + (name || key) + '（幅 ' + fmt(width) + '）');
  toast('画像を配置しました。プロパティパネルで不透明度・ロックを設定できます');
}

/* ================================================================ JSON プロジェクト保存 / 復元 */
const JSON_APP_TAG = 'WEBAPP_2DCAD';
function buildJSONDoc() {
  const usedImages = {};
  for (const e of S.entities) if (e.type === 'image' && S.imageData[e.src]) usedImages[e.src] = S.imageData[e.src];
  return {
    app: JSON_APP_TAG, format: 'project', version: 1, savedAt: new Date().toISOString(),
    fileName: S.fileName,
    layers: clone(S.layers), clayer: S.clayer,
    entities: clone(S.entities),
    constraints: clone(S.constraints),
    dimStyles: clone(S.dimStyles), curDimStyle: S.curDimStyle,
    imageData: usedImages,
    nextId: S.nextId, nextCid: S.nextCid, nextImgKey: S.nextImgKey
  };
}
function validateJSONDoc(doc) {
  return !!(doc && doc.app === JSON_APP_TAG && Array.isArray(doc.entities) && Array.isArray(doc.layers));
}
function applyJSONDoc(doc, srcName) {
  S.entities = doc.entities || [];
  S.layers = (doc.layers && doc.layers.length) ? doc.layers : [{ name: '0', color: 7, ltype: 'CONTINUOUS', on: true, locked: false }];
  if (!S.layers.some(l => l.name === '0')) S.layers.unshift({ name: '0', color: 7, ltype: 'CONTINUOUS', on: true, locked: false });
  S.clayer = (doc.clayer && S.layers.some(l => l.name === doc.clayer)) ? doc.clayer : '0';
  S.constraints = doc.constraints || [];
  S.dimStyles = (doc.dimStyles && doc.dimStyles.length) ? doc.dimStyles
    : [{ name: 'STANDARD', textH: 3.5, arrow: 2.5, extOffset: 0.8, extBeyond: 1.25, gap: 1, prec: 2, scale: 1 }];
  S.curDimStyle = (doc.curDimStyle && S.dimStyles.some(s => s.name === doc.curDimStyle)) ? doc.curDimStyle : S.dimStyles[0].name;
  S.imageData = doc.imageData || {};
  for (const k of Object.keys(IMG_CACHE)) delete IMG_CACHE[k];
  let maxId = 0, maxCid = 0;
  for (const e of S.entities) maxId = Math.max(maxId, e.id || 0);
  for (const c of S.constraints) maxCid = Math.max(maxCid, c.id || 0);
  S.nextId = Math.max(doc.nextId || 1, maxId + 1);
  S.nextCid = Math.max(doc.nextCid || 1, maxCid + 1);
  S.nextImgKey = doc.nextImgKey || (Object.keys(S.imageData).length + 1);
  S.sel.clear();
  S.undoStack = []; S.redoStack = [];
  S.dirty = false;
  S.conStatus = null;
  S.fileName = doc.fileName || (srcName ? srcName.replace(/\.json$/i, '') + '.dxf' : 'drawing.dxf');
  updateTitle(); renderLayers(); renderProps(); renderConstraints();
  zoomExtents();
}
function fileSaveJSON() {
  try {
    const doc = buildJSONDoc();
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.fileName || 'drawing.dxf').replace(/\.dxf$/i, '') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    S.dirty = false;
    updateTitle();
    log(a.download + ' に保存しました（JSON プロジェクト: ' + doc.entities.length + ' オブジェクト、拘束 ' + doc.constraints.length + '、画像 ' + Object.keys(doc.imageData).length + '）');
    toast('JSON プロジェクトを保存しました（寸法・画像・拘束を含む）');
  } catch (err) {
    console.error(err);
    toast('JSON 保存に失敗しました: ' + err.message, 'error');
  }
}
const elJsonInput = document.getElementById('json-input');
function fileOpenJSON() {
  if (S.dirty && !confirm('未保存の変更があります。破棄して別のプロジェクトを開きますか？')) return;
  elJsonInput.value = '';
  elJsonInput.click();
}
elJsonInput.addEventListener('change', () => {
  const f = elJsonInput.files && elJsonInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const doc = JSON.parse(String(reader.result));
      if (!validateJSONDoc(doc)) { toast('WEBAPP_2DCAD の JSON プロジェクトではありません', 'error'); return; }
      applyJSONDoc(doc, f.name);
      log(f.name + ' を読み込みました（' + S.entities.length + ' オブジェクト、拘束 ' + S.constraints.length + '、寸法スタイル ' + S.dimStyles.length + '）');
      toast('JSON プロジェクトを読み込みました');
      if (S.constraints.length) solveConstraintsNow();
    } catch (err) {
      console.error(err);
      toast('JSON の読み込みに失敗しました: ' + err.message, 'error');
    }
  };
  reader.readAsText(f);
});

/* ================================================================ セルフチェック */
function runSelfCheckTests() {
  const results = [];
  const T = (name, fn) => {
    try {
      const r = fn();
      results.push({ name, ok: r === true, detail: r === true ? '' : String(r) });
    } catch (err) {
      results.push({ name, ok: false, detail: '例外: ' + err.message });
    }
  };
  const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-6);

  T('幾何: 線分交点計算', () => {
    const p = lineLineInt({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }, true);
    return (p && near(p.x, 5) && near(p.y, 0)) || '交点 (5,0) が得られませんでした';
  });
  T('トリム: 線分の中抜き', () => {
    const target = { id: 1, type: 'line', layer: '0', x1: 0, y1: 0, x2: 10, y2: 0 };
    const cutters = [
      { id: 2, type: 'line', x1: 3, y1: -5, x2: 3, y2: 5 },
      { id: 3, type: 'line', x1: 7, y1: -5, x2: 7, y2: 5 }
    ];
    const r = trimPieces(target, cutters, { x: 5, y: 0 });
    return (r.add && r.add.length === 2 && near(r.add[0].x2, 3) && near(r.add[1].x1, 7)) || JSON.stringify(r);
  });
  T('トリム: 円 → 円弧化', () => {
    const target = { id: 1, type: 'circle', layer: '0', cx: 0, cy: 0, r: 5 };
    const cutters = [{ id: 2, type: 'line', x1: -10, y1: 0, x2: 10, y2: 0 }];
    const r = trimPieces(target, cutters, { x: 0, y: 5 });
    return (r.add && r.add.length === 1 && r.add[0].type === 'arc') || JSON.stringify(r);
  });
  T('延長: 線分 → 境界', () => {
    const target = { id: 1, type: 'line', layer: '0', x1: 0, y1: 0, x2: 5, y2: 0 };
    const bounds = [{ id: 2, type: 'line', x1: 8, y1: -5, x2: 8, y2: 5 }];
    const r = extendTarget(target, bounds, { x: 5, y: 0 });
    return (r.ent && near(r.ent.x2, 8)) || JSON.stringify(r);
  });
  T('フィレット: 直交 2 線分 R5', () => {
    const e1 = { id: 1, type: 'line', x1: 0, y1: 0, x2: 20, y2: 0 };
    const e2 = { id: 2, type: 'line', x1: 0, y1: 0, x2: 0, y2: 20 };
    const r = filletCompute(e1, { x: 15, y: 0 }, e2, { x: 0, y: 15 }, 5);
    return (r.arc && near(r.arc.r, 5) && near(r.t1.x, 5) && near(r.t2.y, 5) && near(r.arc.cx, 5) && near(r.arc.cy, 5)) || JSON.stringify(r);
  });
  T('面取り: 直交 2 線分 (3,4)', () => {
    const e1 = { id: 1, type: 'line', x1: 0, y1: 0, x2: 20, y2: 0 };
    const e2 = { id: 2, type: 'line', x1: 0, y1: 0, x2: 0, y2: 20 };
    const r = chamferCompute(e1, { x: 15, y: 0 }, e2, { x: 0, y: 15 }, 3, 4);
    return (r.t1 && near(r.t1.x, 3) && near(r.t2.y, 4)) || JSON.stringify(r);
  });
  T('寸法: 長さ寸法の計測値', () => {
    const d = { type: 'dim', dtype: 'linear', p1: { x: 0, y: 0 }, p2: { x: 30, y: 40 }, pos: { x: 15, y: 60 }, ang: 0, style: 'STANDARD' };
    return near(dimMeasure(d), 30) || '計測値 ' + dimMeasure(d) + ' ≠ 30';
  });
  T('寸法: 平行寸法の計測値', () => {
    const d = { type: 'dim', dtype: 'aligned', p1: { x: 0, y: 0 }, p2: { x: 30, y: 40 }, pos: { x: 0, y: 60 }, style: 'STANDARD' };
    return near(dimMeasure(d), 50) || '計測値 ' + dimMeasure(d) + ' ≠ 50';
  });
  T('寸法: ジオメトリ生成（矢印 2 + ラベル）', () => {
    const d = { type: 'dim', dtype: 'linear', p1: { x: 0, y: 0 }, p2: { x: 30, y: 0 }, pos: { x: 15, y: 10 }, ang: 0, style: 'STANDARD' };
    const g = dimGeometry(d);
    return (g.arrows.length === 2 && g.label && g.label.str === '30.00' && g.segs.length === 3) ||
      JSON.stringify({ arrows: g.arrows.length, label: g.label && g.label.str, segs: g.segs.length });
  });
  T('寸法: 半径 / 直径寸法', () => {
    const dr = { type: 'dim', dtype: 'radius', p1: { x: 0, y: 0 }, r: 12, pos: { x: 20, y: 0 }, style: 'STANDARD' };
    const dd = { type: 'dim', dtype: 'diameter', p1: { x: 0, y: 0 }, r: 12, pos: { x: 20, y: 0 }, style: 'STANDARD' };
    return (dimTextOf(dr) === 'R12.00' && dimTextOf(dd) === '⌀24.00') || dimTextOf(dr) + ' / ' + dimTextOf(dd);
  });
  T('寸法スタイル: 精度・適用', () => {
    S.dimStyles.push({ name: '__TEST__', textH: 5, arrow: 3, extOffset: 1, extBeyond: 1, gap: 1, prec: 1, scale: 2 });
    try {
      const d = { type: 'dim', dtype: 'linear', p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, pos: { x: 5, y: 5 }, ang: 0, style: '__TEST__' };
      const g = dimGeometry(d);
      return (dimTextOf(d) === '10.0' && near(g.label.h, 10)) || dimTextOf(d) + ' / h=' + g.label.h;
    } finally {
      S.dimStyles = S.dimStyles.filter(s => s.name !== '__TEST__');
    }
  });
  T('寸法: DXF 用分解', () => {
    const d = { type: 'dim', dtype: 'linear', p1: { x: 0, y: 0 }, p2: { x: 30, y: 0 }, pos: { x: 15, y: 10 }, ang: 0, style: 'STANDARD', layer: '0' };
    const prims = dimToPrimitives(d);
    const lines = prims.filter(p => p.type === 'line').length;
    const texts = prims.filter(p => p.type === 'text').length;
    return (lines === 7 && texts === 1) || 'lines=' + lines + ' texts=' + texts;
  });
  T('拘束: 平行ソルブ収束', () => {
    const ents = [
      { id: 1, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { id: 2, type: 'line', x1: 0, y1: 5, x2: 10, y2: 8 }
    ];
    const r = Solver.solve(ents, [{ id: 1, kind: 'parallel', refs: [{ id: 1 }, { id: 2 }] }]);
    r.apply();
    const cross = (ents[0].x2 - ents[0].x1) * (ents[1].y2 - ents[1].y1) - (ents[0].y2 - ents[0].y1) * (ents[1].x2 - ents[1].x1);
    return (r.converged && Math.abs(cross) < 1e-3) || JSON.stringify({ conv: r.converged, cross });
  });
  T('拘束: 固定 + 水平 + 距離 → 完全拘束', () => {
    const ents = [{ id: 1, type: 'line', x1: 0, y1: 0, x2: 10, y2: 3 }];
    const cons = [
      { id: 1, kind: 'fix', refs: [{ id: 1, pt: 'start' }], data: { x: 0, y: 0 } },
      { id: 2, kind: 'horizontal', refs: [{ id: 1 }] },
      { id: 3, kind: 'adist', refs: [{ id: 1, pt: 'start' }, { id: 1, pt: 'end' }], value: 50 }
    ];
    const r = Solver.solve(ents, cons);
    r.apply();
    return (r.converged && r.dof === 0 && near(Math.hypot(ents[0].x2, ents[0].y2), 50, 1e-3)) ||
      JSON.stringify({ conv: r.converged, dof: r.dof, len: Math.hypot(ents[0].x2, ents[0].y2) });
  });
  T('拘束: 過拘束（冗長）検出', () => {
    const ents = [{ id: 1, type: 'line', x1: 0, y1: 0, x2: 10, y2: 1 }];
    const cons = [
      { id: 1, kind: 'horizontal', refs: [{ id: 1 }] },
      { id: 2, kind: 'horizontal', refs: [{ id: 1 }] }
    ];
    const r = Solver.solve(ents, cons);
    return (r.converged && r.redundant >= 1) || JSON.stringify({ conv: r.converged, redundant: r.redundant });
  });
  T('拘束: 矛盾検出', () => {
    const ents = [{ id: 1, type: 'line', x1: 0, y1: 0, x2: 50, y2: 0 }];
    const cons = [
      { id: 1, kind: 'hdist', refs: [{ id: 1, pt: 'start' }, { id: 1, pt: 'end' }], value: 50, data: { s: 1 } },
      { id: 2, kind: 'hdist', refs: [{ id: 1, pt: 'start' }, { id: 1, pt: 'end' }], value: 60, data: { s: 1 } }
    ];
    const r = Solver.solve(ents, cons);
    return (!r.converged) || '矛盾拘束が収束扱いになっています';
  });
  T('拘束: 未拘束自由度の計数', () => {
    const ents = [{ id: 1, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }];
    const r = Solver.solve(ents, [{ id: 1, kind: 'fix', refs: [{ id: 1, pt: 'start' }], data: { x: 0, y: 0 } }]);
    return (r.dof === 2) || 'dof=' + r.dof + ' ≠ 2';
  });
  T('画像: 変換（尺度・回転・当たり判定）', () => {
    const e = { id: 999, type: 'image', x: 0, y: 0, w: 10, h: 5, rot: 0, opacity: 1, locked: false, src: '__none__' };
    const s = scaleEnt(e, { x: 0, y: 0 }, 2);
    const rot = rotateEnt(e, { x: 0, y: 0 }, Math.PI / 2);
    const hit = hitTest(e, { x: 5, y: 2 }, 0.1);
    const miss = hitTest(e, { x: 5, y: 8 }, 0.1);
    return (near(s.w, 20) && near(s.h, 10) && near(rot.rot, Math.PI / 2) && hit && !miss) ||
      JSON.stringify({ w: s.w, rot: rot.rot, hit, miss });
  });
  T('JSON: プロジェクト往復整合', () => {
    const doc = buildJSONDoc();
    const parsed = JSON.parse(JSON.stringify(doc));
    return (validateJSONDoc(parsed) &&
      parsed.entities.length === S.entities.length &&
      parsed.constraints.length === S.constraints.length &&
      parsed.dimStyles.length === S.dimStyles.length) || 'JSON 往復で件数が一致しません';
  });
  T('DXF: 書き出し / 読み込み往復', () => {
    const sample = [
      { id: 1, type: 'line', layer: '0', color: 256, x1: 0, y1: 0, x2: 10, y2: 10 },
      { id: 2, type: 'circle', layer: '0', color: 1, cx: 5, cy: 5, r: 3 },
      { id: 3, type: 'pline', layer: '0', color: 256, closed: true, pts: [{ x: 0, y: 0, bulge: 0.5 }, { x: 10, y: 0, bulge: 0 }, { x: 10, y: 10, bulge: 0 }] }
    ];
    const text = writeDXF({ layers: [{ name: '0', color: 7, ltype: 'CONTINUOUS', on: true, locked: false }], entities: sample });
    const back = parseDXF(text);
    const pl = back.entities.find(e => e.type === 'pline');
    return (back.entities.length === 3 && pl && pl.closed && near(pl.pts[0].bulge, 0.5)) ||
      JSON.stringify({ n: back.entities.length, pl: pl && pl.pts });
  });
  T('UI: タブ / 拘束パネル / モーダルの存在', () => {
    return (!!document.getElementById('ribbon-tabs') &&
      document.querySelectorAll('.ribbon-page').length >= 6 &&
      !!document.getElementById('con-list') &&
      !!document.getElementById('modal-back')) || 'UI 要素が見つかりません';
  });
  return results;
}
function runSelfCheckUI() {
  const results = runSelfCheckTests();
  const body = document.createElement('div');
  let nOk = 0;
  for (const r of results) {
    if (r.ok) nOk++;
    const row = document.createElement('div');
    row.className = 'check-row ' + (r.ok ? 'ok' : 'ng');
    const mark = document.createElement('span');
    mark.className = 'ck-mark';
    mark.textContent = r.ok ? '✔' : '✖';
    const name = document.createElement('span');
    name.className = 'ck-name';
    name.textContent = r.name;
    row.appendChild(mark);
    row.appendChild(name);
    if (r.detail) {
      const det = document.createElement('div');
      det.className = 'ck-detail';
      det.textContent = r.detail;
      name.appendChild(document.createElement('br'));
      name.appendChild(det);
    }
    body.appendChild(row);
  }
  const sum = document.createElement('div');
  sum.className = 'check-summary ' + (nOk === results.length ? 'ok' : 'ng');
  sum.textContent = nOk === results.length
    ? 'すべて正常: ' + nOk + ' / ' + results.length + ' 項目'
    : '異常あり: ' + nOk + ' / ' + results.length + ' 項目が正常';
  body.appendChild(sum);
  showModal('セルフチェック — 追加機能の状態', body, [{ label: '閉じる', primary: true, onClick: close => close() }]);
  log('セルフチェック: ' + nOk + ' / ' + results.length + ' 項目が正常');
}

/* ================================================================ タブ・パネルの配線 */
document.querySelectorAll('#ribbon-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ribbon-tabs button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.ribbon-page').forEach(p => p.classList.toggle('active', p.dataset.page === btn.dataset.tab));
  });
});
document.getElementById('con-solve-btn').addEventListener('click', consolveNow);
document.getElementById('con-clear-btn').addEventListener('click', () => {
  if (!S.constraints.length) return;
  if (!confirm('すべての拘束（' + S.constraints.length + ' 個）を削除しますか？')) return;
  pushHistory();
  S.constraints = [];
  S.conStatus = null;
  log('すべての拘束を削除しました');
  renderConstraints(); renderProps(); scheduleRedraw();
});

/* ================================================================ 初期化 */
resizeCanvas();
renderLayers();
renderProps();
renderConstraints();
renderToggles();
updateTitle();
zoomExtents();
log('WEBAPP 2DCAD — コマンドを入力してください（例: L=線分, TR=トリム, DLI=寸法, GCP=平行拘束）');
setPrompt('コマンド:');
