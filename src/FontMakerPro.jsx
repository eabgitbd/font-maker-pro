import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  PenTool, Brush, MousePointer2, Download, Upload, Save,
  Settings, Type as TypeIcon, RotateCcw, RotateCw,
  LayoutGrid, Sun, Moon, Eye, EyeOff, Trash2,
  ZoomIn, ZoomOut, Maximize, Sidebar, SidebarClose,
  Check, X, Search
} from 'lucide-react';

// --- STYLES & THEME ---
const gridPattern = `bg-[linear-gradient(to_right,rgba(128,128,128,0.1)_1px,transparent_1px),linear-gradient(to_bottom,rgba(128,128,128,0.1)_1px,transparent_1px)] bg-[length:40px_40px]`;

// --- CONSTANTS ---
const DEFAULT_METRICS = { unitsPerEm: 1000, ascender: 800, descender: -200, capHeight: 700, xHeight: 500 };

const generateRange = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
const UPPERCASE = generateRange(65, 90);
const LOWERCASE = generateRange(97, 122);
const NUMBERS = generateRange(48, 57);
const SYMBOLS = [...generateRange(32, 47), ...generateRange(58, 64), ...generateRange(91, 96), ...generateRange(123, 126)];
const ACCENTED = [
  192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 216, 217, 218, 219, 220, 221,
  223,
  224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 248, 249, 250, 251, 252, 253, 255
].sort((a, b) => a - b);

const FULL_CHAR_SET = [...UPPERCASE, ...LOWERCASE, ...NUMBERS, ...SYMBOLS, ...ACCENTED];

const CATEGORIES = [
  { id: 'all', label: 'All', set: FULL_CHAR_SET },
  { id: 'upper', label: 'A–Z', set: UPPERCASE },
  { id: 'lower', label: 'a–z', set: LOWERCASE },
  { id: 'num', label: '0–9', set: NUMBERS },
  { id: 'sym', label: 'Symbols', set: SYMBOLS },
  { id: 'accent', label: 'Accented', set: ACCENTED },
];

// --- PWA SETUP (In-Memory) ---
const initPWA = () => {
  if (typeof window === 'undefined') return;
  const manifest = {
    name: "Font Maker Pro",
    short_name: "FontMaker",
    display: "standalone",
    start_url: ".",
    background_color: "#18181b",
    theme_color: "#18181b",
    description: "Professional vector font editor and compiler.",
    icons: [{
      src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%2327272a'/%3E%3Ctext x='50' y='65' font-family='sans-serif' font-size='50' font-weight='bold' fill='%23a1a1aa' text-anchor='middle'%3EF%3C/text%3E%3C/svg%3E",
      sizes: "192x192", type: "image/svg+xml", purpose: "any maskable"
    }]
  };
  const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
  const manifestUrl = URL.createObjectURL(manifestBlob);
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = manifestUrl;
  document.head.appendChild(link);
};

// --- GEOMETRY HELPERS ---

// Convert a raw pressure-sensitive centerline into a closed, fillable outline polygon.
// This is what makes brush strokes actually show up (and export correctly) as real
// vector shapes instead of a zero-width line.
function buildStrokeOutline(points, maxWidth) {
  if (!points || points.length === 0) return [];
  if (points.length === 1) {
    const r = Math.max(3, (points[0].pressure ?? 0.5) * maxWidth / 2);
    const cx = points[0].x, cy = points[0].y;
    const segs = 14;
    const circle = [];
    for (let i = 0; i < segs; i++) {
      const ang = (i / segs) * Math.PI * 2;
      circle.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
    }
    return circle;
  }
  const left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x, dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const r = Math.max(3, (p.pressure ?? 0.5) * maxWidth / 2);
    left.push({ x: p.x + nx * r, y: p.y + ny * r });
    right.push({ x: p.x - nx * r, y: p.y - ny * r });
  }
  return [...left, ...right.reverse()];
}

function distToSegment(p, a, b) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}

function hitTestPath(point, path, threshold) {
  const pts = path.points;
  if (!pts || pts.length < 2) return false;
  const n = pts.length;
  const segCount = (path.kind === 'brush' || path.closed) ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (distToSegment(point, a, b) < threshold) return true;
  }
  return false;
}

// Anchor handles are stored as offsets from the anchor: `hout` is the control point
// pulled out towards the next anchor, `hin` towards the previous one. Older saves only
// had a single symmetric `hx/hy` (out-handle, mirrored for in) — these getters fall back
// to that so old .fontproj files still load correctly.
function getOutHandle(p) {
  if (p.hout) return p.hout;
  if (p.hx !== undefined) return { x: p.hx, y: p.hy };
  return { x: 0, y: 0 };
}
function getInHandle(p) {
  if (p.hin) return p.hin;
  if (p.hx !== undefined) return { x: -p.hx, y: -p.hy };
  return { x: 0, y: 0 };
}

function lerpPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

function cubicPointAt(P0, P1, P2, P3, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * P0.x + 3 * mt * mt * t * P1.x + 3 * mt * t * t * P2.x + t * t * t * P3.x,
    y: mt * mt * mt * P0.y + 3 * mt * mt * t * P1.y + 3 * mt * t * t * P2.y + t * t * t * P3.y,
  };
}

// De Casteljau split of a cubic bezier at parameter t. Preserves the exact curve shape
// on both sides of the new point, which is what lets "add anchor point" not distort the glyph.
function splitCubicBezier(P0, P1, P2, P3, t) {
  const P01 = lerpPt(P0, P1, t), P12 = lerpPt(P1, P2, t), P23 = lerpPt(P2, P3, t);
  const P012 = lerpPt(P01, P12, t), P123 = lerpPt(P12, P23, t);
  const M = lerpPt(P012, P123, t);
  return { P01, P012, M, P123, P23 };
}

// Sample a cubic segment to find the closest point (and its rough t) to a given point,
// used to hit-test double-clicks on a curve for inserting a new anchor.
function closestTOnCubic(point, P0, P1, P2, P3, steps = 24) {
  let bestT = 0, bestDist = Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt = cubicPointAt(P0, P1, P2, P3, t);
    const d = Math.hypot(point.x - pt.x, point.y - pt.y);
    if (d < bestDist) { bestDist = d; bestT = t; }
  }
  return { t: bestT, dist: bestDist };
}

// Build an SVG path 'd' string for a stored glyph path (brush outline or pen bezier chain).
function pathToD(path, metrics) {
  if (!path || !path.points || path.points.length === 0) return "";
  const toSvg = (pt) => `${pt.x} ${metrics.ascender - pt.y}`;
  if (path.kind === 'brush') {
    let d = `M ${toSvg(path.points[0])}`;
    for (let i = 1; i < path.points.length; i++) d += ` L ${toSvg(path.points[i])}`;
    d += ' Z';
    return d;
  }
  const pts = path.points;
  let d = `M ${toSvg(pts[0])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const aOut = getOutHandle(a), bIn = getInHandle(b);
    const c1 = { x: a.x + aOut.x, y: a.y + aOut.y };
    const c2 = { x: b.x + bIn.x, y: b.y + bIn.y };
    d += ` C ${toSvg(c1)} ${toSvg(c2)} ${toSvg(b)}`;
  }
  if (path.closed && pts.length > 2) {
    const a = pts[pts.length - 1], b = pts[0];
    const aOut = getOutHandle(a), bIn = getInHandle(b);
    const c1 = { x: a.x + aOut.x, y: a.y + aOut.y };
    const c2 = { x: b.x + bIn.x, y: b.y + bIn.y };
    d += ` C ${toSvg(c1)} ${toSvg(c2)} ${toSvg(b)} Z`;
  }
  return d;
}

function draftPenToD(draft, mousePos, metrics) {
  const pts = draft.points;
  const toSvg = (p) => `${p.x} ${metrics.ascender - p.y}`;
  let d = `M ${toSvg(pts[0])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const aOut = getOutHandle(a), bIn = getInHandle(b);
    const c1 = { x: a.x + aOut.x, y: a.y + aOut.y };
    const c2 = { x: b.x + bIn.x, y: b.y + bIn.y };
    d += ` C ${toSvg(c1)} ${toSvg(c2)} ${toSvg(b)}`;
  }
  if (mousePos) {
    const a = pts[pts.length - 1];
    const aOut = getOutHandle(a);
    const c1 = { x: a.x + aOut.x, y: a.y + aOut.y };
    d += ` Q ${toSvg(c1)} ${toSvg(mousePos)}`;
  }
  return d;
}

// --- APP COMPONENT ---
export default function FontMakerPro() {
  const [isLoaded, setIsLoaded] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [showRightPanel, setShowRightPanel] = useState(true);

  // Project State
  const [fontFamily, setFontFamily] = useState("MyCustomFont");
  const [metrics, setMetrics] = useState(DEFAULT_METRICS);

  // Undo/Redo History State
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Editor State
  const [currentUnicode, setCurrentUnicode] = useState(65);
  const [tool, setTool] = useState('brush');
  const [viewTransform, setViewTransform] = useState({ x: 0, y: 0, scale: 0.6 });
  const [showTemplate, setShowTemplate] = useState(true);
  const [templateFont, setTemplateFont] = useState('serif');
  const [brushSize, setBrushSize] = useState(60);

  // Brush drawing (live preview before it's committed as a filled outline)
  const [liveStroke, setLiveStroke] = useState([]);
  const lastPointRef = useRef(null);

  // Pen tool draft state (a path being built anchor-by-anchor)
  const [draftPen, setDraftPen] = useState(null); // { points: [{x, y, hin:{x,y}, hout:{x,y}}] }
  const [mousePos, setMousePos] = useState(null);
  const penHandleActive = useRef(false);

  // Select tool state
  const [selectedPathId, setSelectedPathId] = useState(null);
  const draggingAnchor = useRef(null); // { pathId, index }
  const panRef = useRef(null); // { startClientX, startClientY, startX, startY }

  // Character browser
  const [charCategory, setCharCategory] = useState('all');
  const [charSearch, setCharSearch] = useState('');

  // Interaction Refs & Canvas Sizing
  const svgRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const isDrawing = useRef(false);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    if (!canvasContainerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setCanvasSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    observer.observe(canvasContainerRef.current);
    return () => observer.disconnect();
  }, [showRightPanel]);

  const getCurrentGlyphs = useCallback(() => {
    if (historyIndex >= 0 && history[historyIndex]) return history[historyIndex];
    return {};
  }, [history, historyIndex]);

  const saveToHistory = useCallback((newGlyphsState) => {
    setHistory(prevHistory => {
      const newHistory = prevHistory.slice(0, historyIndex + 1);
      newHistory.push(newGlyphsState);
      setHistoryIndex(newHistory.length - 1);
      return newHistory;
    });
  }, [historyIndex]);

  // Live-mutate the current history slot (used while dragging, before a final commit)
  const updateCurrentGlyphState = (updater) => {
    const currentGlyphs = getCurrentGlyphs();
    const newGlyphs = updater(currentGlyphs);
    setHistory(prev => {
      const newHistory = [...prev];
      newHistory[historyIndex] = newGlyphs;
      return newHistory;
    });
  };

  const clearCurrentGlyph = () => {
    const currentGlyphs = getCurrentGlyphs();
    const newGlyphs = { ...currentGlyphs, [currentUnicode]: { ...currentGlyphs[currentUnicode], paths: [] } };
    saveToHistory(newGlyphs);
    setSelectedPathId(null);
  };

  const deleteSelectedPath = () => {
    if (!selectedPathId) return;
    const currentGlyphs = getCurrentGlyphs();
    const glyph = currentGlyphs[currentUnicode];
    if (!glyph) return;
    const newGlyphs = { ...currentGlyphs, [currentUnicode]: { ...glyph, paths: glyph.paths.filter(p => p.id !== selectedPathId) } };
    saveToHistory(newGlyphs);
    setSelectedPathId(null);
  };

  // Load OpenType.js and initialize
  useEffect(() => {
    initPWA();
    const script = document.createElement('script');
    script.src = "https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js";
    script.onload = () => setIsLoaded(true);
    document.head.appendChild(script);

    const initialGlyphs = {};
    FULL_CHAR_SET.forEach(code => {
      initialGlyphs[code] = { advanceWidth: 600, paths: [] };
    });
    setHistory([initialGlyphs]);
    setHistoryIndex(0);
  }, []);

  // Cancel an in-progress pen path whenever the tool changes away from Pen
  useEffect(() => {
    if (tool !== 'pen' && draftPen) {
      setDraftPen(null);
      setMousePos(null);
    }
    if (tool !== 'select') {
      setSelectedPathId(null);
    }
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- KEYBOARD SHORTCUTS ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

      if (e.ctrlKey || e.metaKey) {
        if (isTyping) return;
        if (e.key === 'z') { e.preventDefault(); if (e.shiftKey) handleRedo(); else handleUndo(); }
        else if (e.key === 'y') { e.preventDefault(); handleRedo(); }
        return;
      }

      if (isTyping) return;

      if (tool === 'pen' && draftPen) {
        if (e.key === 'Escape') { setDraftPen(null); setMousePos(null); return; }
        if (e.key === 'Enter') { finalizePen(false); return; }
        if (e.key === 'Backspace') {
          e.preventDefault();
          setDraftPen(prev => {
            if (!prev) return prev;
            if (prev.points.length <= 1) return null;
            return { points: prev.points.slice(0, -1) };
          });
          return;
        }
      }

      if (tool === 'select' && selectedPathId && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        deleteSelectedPath();
        return;
      }

      if (e.key === 'v' || e.key === 'V') setTool('select');
      if (e.key === 'p' || e.key === 'P') setTool('pen');
      if (e.key === 'b' || e.key === 'B') setTool('brush');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [historyIndex, history, tool, draftPen, selectedPathId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUndo = () => { if (historyIndex > 0) { setHistoryIndex(historyIndex - 1); setSelectedPathId(null); } };
  const handleRedo = () => { if (historyIndex < history.length - 1) { setHistoryIndex(historyIndex + 1); setSelectedPathId(null); } };

  // --- COORDINATE CONVERSION ---
  // Screen pixels -> font-space coordinates (Y-up, baseline = 0)
  const screenToSVG = (clientX, clientY) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const pt = svgRef.current.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const globalPoint = pt.matrixTransform(svgRef.current.getScreenCTM().inverse());
    const viewX = (globalPoint.x - viewTransform.x) / viewTransform.scale;
    const viewY = (globalPoint.y - viewTransform.y) / viewTransform.scale;
    return { x: viewX, y: metrics.ascender - viewY };
  };

  // --- BRUSH TOOL ---
  const brushDown = (e, coords) => {
    e.target.setPointerCapture(e.pointerId);
    isDrawing.current = true;
    const pressure = e.pointerType === 'pen' ? e.pressure : 0.5;
    lastPointRef.current = coords;
    setLiveStroke([{ ...coords, pressure }]);
  };

  const brushMove = (e, coords) => {
    const pressure = e.pointerType === 'pen' ? e.pressure : 0.5;
    const last = lastPointRef.current;
    const minDist = 4 / viewTransform.scale;
    if (!last || Math.hypot(coords.x - last.x, coords.y - last.y) > minDist) {
      lastPointRef.current = coords;
      setLiveStroke(prev => [...prev, { ...coords, pressure }]);
    }
  };

  const brushUp = (e) => {
    isDrawing.current = false;
    lastPointRef.current = null;
    setLiveStroke(prevStroke => {
      if (prevStroke.length >= 1) {
        const outline = buildStrokeOutline(prevStroke, brushSize);
        if (outline.length >= 3) {
          const newPath = { id: `p${Date.now()}`, kind: 'brush', points: outline, closed: true };
          const currentGlyphs = getCurrentGlyphs();
          const glyph = currentGlyphs[currentUnicode] || { advanceWidth: 600, paths: [] };
          const newGlyphs = { ...currentGlyphs, [currentUnicode]: { ...glyph, paths: [...glyph.paths, newPath] } };
          saveToHistory(newGlyphs);
        }
      }
      return [];
    });
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
  };

  // --- PEN TOOL ---
  const penDown = (e, coords) => {
    e.target.setPointerCapture(e.pointerId);
    if (!draftPen) {
      setDraftPen({ points: [{ x: coords.x, y: coords.y, hin: { x: 0, y: 0 }, hout: { x: 0, y: 0 } }] });
    } else {
      const first = draftPen.points[0];
      const closeThreshold = 10 / viewTransform.scale;
      if (draftPen.points.length >= 2 && Math.hypot(coords.x - first.x, coords.y - first.y) < closeThreshold) {
        finalizePen(true);
        return;
      }
      setDraftPen(prev => ({ points: [...prev.points, { x: coords.x, y: coords.y, hin: { x: 0, y: 0 }, hout: { x: 0, y: 0 } }] }));
    }
    penHandleActive.current = true;
  };

  const penUpdateHandle = (coords) => {
    setDraftPen(prev => {
      if (!prev) return prev;
      const points = [...prev.points];
      const last = points[points.length - 1];
      const dx = coords.x - last.x, dy = coords.y - last.y;
      // Dragging while placing an anchor creates a symmetric smooth handle (classic pen-tool feel).
      points[points.length - 1] = { ...last, hout: { x: dx, y: dy }, hin: { x: -dx, y: -dy } };
      return { points };
    });
  };

  const penUp = (e) => {
    penHandleActive.current = false;
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
  };

  const finalizePen = (closed) => {
    if (!draftPen || draftPen.points.length < 2) { setDraftPen(null); setMousePos(null); return; }
    const newPath = { id: `p${Date.now()}`, kind: 'pen', points: draftPen.points, closed };
    const currentGlyphs = getCurrentGlyphs();
    const glyph = currentGlyphs[currentUnicode] || { advanceWidth: 600, paths: [] };
    const newGlyphs = { ...currentGlyphs, [currentUnicode]: { ...glyph, paths: [...glyph.paths, newPath] } };
    saveToHistory(newGlyphs);
    setDraftPen(null);
    setMousePos(null);
  };

  // --- SELECT / PAN TOOL ---
  const selectDown = (e, coords) => {
    e.target.setPointerCapture(e.pointerId);
    const currentGlyphs = getCurrentGlyphs();
    const glyph = currentGlyphs[currentUnicode];
    const anchorThreshold = 8 / viewTransform.scale;

    if (selectedPathId && glyph) {
      const selPath = glyph.paths.find(p => p.id === selectedPathId);
      if (selPath && selPath.kind === 'pen') {
        for (let i = 0; i < selPath.points.length; i++) {
          const pt = selPath.points[i];
          if (Math.hypot(coords.x - pt.x, coords.y - pt.y) < anchorThreshold) {
            draggingAnchor.current = { pathId: selPath.id, index: i };
            return;
          }
        }
      }
    }

    const hitThreshold = 6 / viewTransform.scale;
    if (glyph) {
      for (let i = glyph.paths.length - 1; i >= 0; i--) {
        if (hitTestPath(coords, glyph.paths[i], hitThreshold)) {
          setSelectedPathId(glyph.paths[i].id);
          return;
        }
      }
    }

    setSelectedPathId(null);
    panRef.current = { startClientX: e.clientX, startClientY: e.clientY, startX: viewTransform.x, startY: viewTransform.y };
  };

  const selectMove = (e, coords) => {
    if (draggingAnchor.current) {
      const { pathId, index } = draggingAnchor.current;
      updateCurrentGlyphState(prev => {
        const glyph = prev[currentUnicode];
        if (!glyph) return prev;
        const paths = glyph.paths.map(p => {
          if (p.id !== pathId) return p;
          const points = [...p.points];
          points[index] = { ...points[index], x: coords.x, y: coords.y };
          return { ...p, points };
        });
        return { ...prev, [currentUnicode]: { ...glyph, paths } };
      });
    } else if (panRef.current) {
      const dx = e.clientX - panRef.current.startClientX;
      const dy = e.clientY - panRef.current.startClientY;
      setViewTransform(prev => ({ ...prev, x: panRef.current.startX + dx, y: panRef.current.startY + dy }));
    }
  };

  const selectUp = (e) => {
    if (draggingAnchor.current) {
      saveToHistory(getCurrentGlyphs());
      draggingAnchor.current = null;
    }
    panRef.current = null;
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
  };

  // --- ADD / REMOVE ANCHOR POINTS (pen paths only) ---
  const removeAnchorPoint = (pathId, index) => {
    const currentGlyphs = getCurrentGlyphs();
    const glyph = currentGlyphs[currentUnicode];
    if (!glyph) return;
    const path = glyph.paths.find(p => p.id === pathId);
    if (!path || path.points.length <= 2) return; // keep at least 2 anchors
    const newPoints = path.points.filter((_, i) => i !== index);
    const newPaths = glyph.paths.map(p => p.id === pathId ? { ...p, points: newPoints } : p);
    saveToHistory({ ...currentGlyphs, [currentUnicode]: { ...glyph, paths: newPaths } });
  };

  const insertAnchorPoint = (pathId, segIndex, t) => {
    const currentGlyphs = getCurrentGlyphs();
    const glyph = currentGlyphs[currentUnicode];
    if (!glyph) return;
    const path = glyph.paths.find(p => p.id === pathId);
    if (!path) return;
    const n = path.points.length;
    const nextIndex = (segIndex + 1) % n;
    const a = path.points[segIndex], b = path.points[nextIndex];
    const aOut = getOutHandle(a), bIn = getInHandle(b);
    const P0 = { x: a.x, y: a.y };
    const P1 = { x: a.x + aOut.x, y: a.y + aOut.y };
    const P2 = { x: b.x + bIn.x, y: b.y + bIn.y };
    const P3 = { x: b.x, y: b.y };
    const { P01, P012, M, P123, P23 } = splitCubicBezier(P0, P1, P2, P3, t);

    const newA = { ...a, hout: { x: P01.x - a.x, y: P01.y - a.y } };
    const newB = { ...b, hin: { x: P23.x - b.x, y: P23.y - b.y } };
    const newPoint = {
      x: M.x, y: M.y,
      hin: { x: P012.x - M.x, y: P012.y - M.y },
      hout: { x: P123.x - M.x, y: P123.y - M.y },
    };

    const pts = [...path.points];
    pts[segIndex] = newA;
    pts[nextIndex] = newB;
    if (nextIndex === 0) {
      pts.push(newPoint); // closing edge: new point belongs at the end, just before wrapping to index 0
    } else {
      pts.splice(nextIndex, 0, newPoint);
    }

    const newPaths = glyph.paths.map(p => p.id === pathId ? { ...p, points: pts } : p);
    saveToHistory({ ...currentGlyphs, [currentUnicode]: { ...glyph, paths: newPaths } });
  };

  // Double-click a node on the selected pen path to delete it, or double-click empty
  // space on its curve to insert a new anchor there (the curve shape is preserved exactly).
  const onSvgDoubleClick = (e) => {
    if (tool !== 'select' || !selectedPathId) return;
    const coords = screenToSVG(e.clientX, e.clientY);
    const currentGlyphs = getCurrentGlyphs();
    const glyph = currentGlyphs[currentUnicode];
    if (!glyph) return;
    const path = glyph.paths.find(p => p.id === selectedPathId);
    if (!path || path.kind !== 'pen') return;

    const anchorThreshold = 8 / viewTransform.scale;
    for (let i = 0; i < path.points.length; i++) {
      const pt = path.points[i];
      if (Math.hypot(coords.x - pt.x, coords.y - pt.y) < anchorThreshold) {
        removeAnchorPoint(path.id, i);
        return;
      }
    }

    const n = path.points.length;
    const segCount = path.closed ? n : n - 1;
    const hitThreshold = 8 / viewTransform.scale;
    for (let i = 0; i < segCount; i++) {
      const a = path.points[i], b = path.points[(i + 1) % n];
      const aOut = getOutHandle(a), bIn = getInHandle(b);
      const P0 = { x: a.x, y: a.y };
      const P1 = { x: a.x + aOut.x, y: a.y + aOut.y };
      const P2 = { x: b.x + bIn.x, y: b.y + bIn.y };
      const P3 = { x: b.x, y: b.y };
      const { t, dist } = closestTOnCubic(coords, P0, P1, P2, P3);
      if (dist < hitThreshold) {
        insertAnchorPoint(path.id, i, t);
        return;
      }
    }
  };

  // --- POINTER DISPATCH ---
  const onSvgPointerDown = (e) => {
    const coords = screenToSVG(e.clientX, e.clientY);
    if (tool === 'brush') brushDown(e, coords);
    else if (tool === 'pen') penDown(e, coords);
    else if (tool === 'select') selectDown(e, coords);
  };

  const onSvgPointerMove = (e) => {
    const coords = screenToSVG(e.clientX, e.clientY);
    if (tool === 'pen') {
      setMousePos(coords);
      if (penHandleActive.current) penUpdateHandle(coords);
    } else if (tool === 'brush' && isDrawing.current) {
      brushMove(e, coords);
    } else if (tool === 'select') {
      selectMove(e, coords);
    }
  };

  const onSvgPointerUp = (e) => {
    if (tool === 'brush') brushUp(e);
    else if (tool === 'pen') penUp(e);
    else if (tool === 'select') selectUp(e);
  };

  const onSvgPointerLeave = (e) => {
    if (tool === 'brush' && isDrawing.current) brushUp(e);
    else if (tool === 'select') selectUp(e);
  };

  // --- VIEW CONTROLS ---
  const handleZoomIn = () => setViewTransform(prev => ({ ...prev, scale: Math.min(5, prev.scale + 0.1) }));
  const handleZoomOut = () => setViewTransform(prev => ({ ...prev, scale: Math.max(0.1, prev.scale - 0.1) }));
  const handleResetView = () => setViewTransform({ x: 0, y: 0, scale: 0.6 });

  const handleFitToWindow = () => {
    const currentGlyphs = getCurrentGlyphs();
    const activeGlyph = currentGlyphs[currentUnicode] || { advanceWidth: 600 };
    const glyphW = Math.max(activeGlyph.advanceWidth || 600, 600);
    const glyphH = metrics.unitsPerEm || 1000;
    const padding = 1.2;
    const scaleX = canvasSize.w / (glyphW * padding);
    const scaleY = canvasSize.h / (glyphH * padding);
    const newScale = Math.min(scaleX, scaleY, 3);
    setViewTransform({ x: -(glyphW / 2) * newScale, y: -(glyphH / 2) * newScale, scale: newScale });
  };

  // --- EXPORT/SAVE/LOAD ---
  const exportFont = () => {
    if (!window.opentype) return alert("Engine loading, please wait.");
    const fontGlyphs = [];
    const currentGlyphs = getCurrentGlyphs();

    const notdefPath = new window.opentype.Path();
    notdefPath.moveTo(100, 0); notdefPath.lineTo(100, 700);
    notdefPath.lineTo(500, 700); notdefPath.lineTo(500, 0); notdefPath.close();
    fontGlyphs.push(new window.opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 600, path: notdefPath }));

    Object.entries(currentGlyphs).forEach(([unicodeStr, glyphData]) => {
      const unicode = parseInt(unicodeStr);
      if (!glyphData || !glyphData.paths || glyphData.paths.length === 0) return;

      const path = new window.opentype.Path();
      glyphData.paths.forEach(p => {
        if (!p.points || p.points.length === 0) return;
        path.moveTo(p.points[0].x, p.points[0].y);
        if (p.kind === 'brush') {
          for (let i = 1; i < p.points.length; i++) path.lineTo(p.points[i].x, p.points[i].y);
        } else {
          for (let i = 0; i < p.points.length - 1; i++) {
            const a = p.points[i], b = p.points[i + 1];
            const aOut = getOutHandle(a), bIn = getInHandle(b);
            const c1 = { x: a.x + aOut.x, y: a.y + aOut.y };
            const c2 = { x: b.x + bIn.x, y: b.y + bIn.y };
            path.curveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
          }
          if (p.closed && p.points.length > 2) {
            const a = p.points[p.points.length - 1], b = p.points[0];
            const aOut = getOutHandle(a), bIn = getInHandle(b);
            const c1 = { x: a.x + aOut.x, y: a.y + aOut.y };
            const c2 = { x: b.x + bIn.x, y: b.y + bIn.y };
            path.curveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
          }
        }
        path.close(); // always close each contour so it fills correctly in the exported font
      });

      fontGlyphs.push(new window.opentype.Glyph({
        name: String.fromCharCode(unicode), unicode, advanceWidth: glyphData.advanceWidth || 600, path
      }));
    });

    const font = new window.opentype.Font({
      familyName: fontFamily, styleName: 'Regular',
      unitsPerEm: metrics.unitsPerEm, ascender: metrics.ascender, descender: metrics.descender,
      glyphs: fontGlyphs
    });
    font.download();
  };

  const saveProject = () => {
    const data = JSON.stringify({ fontFamily, metrics, glyphs: getCurrentGlyphs() });
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fontFamily.replace(/\s+/g, '_')}.fontproj`;
    a.click();
  };

  const loadProject = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        setFontFamily(data.fontFamily || "ImportedFont");
        setMetrics(data.metrics || DEFAULT_METRICS);
        setHistory([data.glyphs || {}]);
        setHistoryIndex(0);
        setSelectedPathId(null);
      } catch (err) {
        alert("Invalid project file.");
      }
    };
    reader.readAsText(file);
  };

  // --- UI DATA ---
  const currentGlyphs = getCurrentGlyphs();
  const activeGlyph = currentGlyphs[currentUnicode] || { paths: [], advanceWidth: 600 };
  const filledCount = Object.values(currentGlyphs).filter(g => g?.paths?.length > 0).length;

  const visibleChars = CATEGORIES.find(c => c.id === charCategory).set.filter(code => {
    if (!charSearch) return true;
    return String.fromCharCode(code).toLowerCase().includes(charSearch.toLowerCase()) ||
      code.toString(16).includes(charSearch.toLowerCase());
  });

  const th = theme === 'dark' ?
    { bg: 'bg-[#121212]', panel: 'bg-[#1e1e1e]', border: 'border-[#2d2d2d]', text: 'text-[#e0e0e0]', textMuted: 'text-[#888888]', accent: 'bg-indigo-500', accentHover: 'hover:bg-indigo-400' } :
    { bg: 'bg-[#f4f4f5]', panel: 'bg-white', border: 'border-[#e4e4e7]', text: 'text-[#18181b]', textMuted: 'text-[#71717a]', accent: 'bg-indigo-600', accentHover: 'hover:bg-indigo-500' };

  if (!isLoaded) {
    return (
      <div className={`h-screen w-screen flex items-center justify-center ${th.bg} ${th.text}`}>
        <div className="animate-pulse flex flex-col items-center">
          <TypeIcon size={48} className="mb-4 opacity-50" />
          <p className="font-mono text-sm tracking-widest uppercase">Initializing Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-screen w-screen flex flex-col overflow-hidden font-sans selection:bg-indigo-500/30 transition-colors duration-300 ${th.bg} ${th.text} ${gridPattern}`}>
      {/* TOP MENU BAR */}
      <header className={`flex items-center justify-between px-4 py-2 border-b ${th.panel} ${th.border} backdrop-blur-md bg-opacity-90 z-20`}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-md bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-lg">
            <TypeIcon size={18} strokeWidth={3} />
          </div>
          <div>
            <h1 className="font-bold text-sm tracking-wide">Font Maker Pro</h1>
            <input
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              className={`text-xs bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded px-1 -ml-1 ${th.textMuted} w-32`}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-mono ${th.textMuted} mr-1`}>{filledCount}/{FULL_CHAR_SET.length} drawn</span>
          <div className={`w-px h-6 ${th.border} border-l`}></div>
          <label className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${th.border} border hover:bg-black/5 dark:hover:bg-white/5`}>
            <Upload size={14} /> Import
            <input type="file" accept=".fontproj" className="hidden" onChange={loadProject} />
          </label>
          <button onClick={saveProject} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${th.border} border hover:bg-black/5 dark:hover:bg-white/5`}>
            <Save size={14} /> Save
          </button>
          <button onClick={exportFont} className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-bold text-white transition-colors shadow-sm ${th.accent} ${th.accentHover}`}>
            <Download size={14} /> Export OTF
          </button>
          <div className={`w-px h-6 mx-2 ${th.border} border-l`}></div>
          <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} className={`p-1.5 rounded-md ${th.border} border hover:bg-black/5 dark:hover:bg-white/5`} title="Toggle Theme">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button onClick={() => setShowRightPanel(p => !p)} className={`p-1.5 rounded-md ${th.border} border hover:bg-black/5 dark:hover:bg-white/5 ${showRightPanel ? th.text : th.textMuted}`} title="Toggle Right Panel">
            {showRightPanel ? <SidebarClose size={16} /> : <Sidebar size={16} />}
          </button>
        </div>
      </header>

      {/* CONTEXTUAL TOOL BAR */}
      <div className={`flex items-center gap-4 px-4 py-1.5 border-b text-xs ${th.panel} ${th.border} ${th.textMuted} z-10`}>
        {tool === 'brush' && (
          <>
            <span className="font-semibold uppercase tracking-wide text-[10px]">Brush</span>
            <div className="flex items-center gap-2">
              <span>Size</span>
              <input type="range" min="10" max="180" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} className="w-32 accent-indigo-500" />
              <span className="font-mono w-8">{brushSize}</span>
            </div>
            <span className="opacity-70">Draw freehand — pressure (stylus) or speed controls thickness.</span>
          </>
        )}
        {tool === 'pen' && (
          <>
            <span className="font-semibold uppercase tracking-wide text-[10px]">Pen</span>
            <span className="opacity-70">Click to place anchors · drag while placing to curve · click the first (green) point to close · Enter to finish open · Esc to cancel · Backspace to undo last point.</span>
            {draftPen && (
              <div className="flex items-center gap-1 ml-auto">
                {draftPen.points.length >= 3 && (
                  <button onClick={() => finalizePen(true)} className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/20 text-emerald-500 hover:bg-emerald-500/30"><Check size={12} /> Close Path</button>
                )}
                <button onClick={() => { setDraftPen(null); setMousePos(null); }} className="flex items-center gap-1 px-2 py-1 rounded bg-red-500/20 text-red-500 hover:bg-red-500/30"><X size={12} /> Cancel</button>
              </div>
            )}
          </>
        )}
        {tool === 'select' && (
          <>
            <span className="font-semibold uppercase tracking-wide text-[10px]">Select</span>
            <span className="opacity-70">Drag empty canvas to pan · click a shape to select it · drag a red node to reshape · double-click a node to delete it · double-click a curve to add one · Delete to remove selected shape.</span>
            {selectedPathId && (
              <button onClick={deleteSelectedPath} className="flex items-center gap-1 px-2 py-1 rounded bg-red-500/20 text-red-500 hover:bg-red-500/30 ml-auto"><Trash2 size={12} /> Delete Shape</button>
            )}
          </>
        )}
      </div>

      {/* MAIN WORKSPACE */}
      <main className="flex-1 flex overflow-hidden relative">

        {/* LEFT TOOLBAR */}
        <aside className={`w-14 flex flex-col items-center py-4 gap-2 border-r z-10 ${th.panel} ${th.border} shadow-[4px_0_24px_rgba(0,0,0,0.05)]`}>
          {[
            { id: 'select', icon: MousePointer2, title: 'Select / Pan / Edit Nodes (V)' },
            { id: 'pen', icon: PenTool, title: 'Bezier Pen (P)' },
            { id: 'brush', icon: Brush, title: 'Pressure Brush (B)' },
          ].map(t => (
            <button
              key={t.id}
              title={t.title}
              onClick={() => setTool(t.id)}
              className={`p-2.5 rounded-xl transition-all duration-200 ${tool === t.id ? `${th.accent} text-white shadow-md scale-105` : `${th.textMuted} hover:bg-black/5 dark:hover:bg-white/10 hover:text-current`}`}
            >
              <t.icon size={20} strokeWidth={tool === t.id ? 2.5 : 2} />
            </button>
          ))}

          <div className={`w-8 border-b my-2 ${th.border}`}></div>

          <button
            onClick={handleUndo}
            disabled={historyIndex <= 0}
            className={`p-2.5 rounded-xl transition-all duration-200 ${historyIndex <= 0 ? 'opacity-40 cursor-not-allowed' : `hover:bg-black/5 dark:hover:bg-white/10 hover:text-current ${th.textMuted}`}`}
            title="Undo (Ctrl+Z)"
          >
            <RotateCcw size={20} />
          </button>
          <button
            onClick={handleRedo}
            disabled={historyIndex >= history.length - 1}
            className={`p-2.5 rounded-xl transition-all duration-200 ${historyIndex >= history.length - 1 ? 'opacity-40 cursor-not-allowed' : `hover:bg-black/5 dark:hover:bg-white/10 hover:text-current ${th.textMuted}`}`}
            title="Redo (Ctrl+Y)"
          >
            <RotateCw size={20} />
          </button>
        </aside>

        {/* CENTER CANVAS */}
        <div ref={canvasContainerRef} className="flex-1 relative overflow-hidden bg-transparent"
             style={{ cursor: tool === 'select' ? (draggingAnchor.current ? 'grabbing' : 'grab') : 'crosshair' }}
             onWheel={(e) => {
               if (e.ctrlKey || e.metaKey) {
                 e.preventDefault();
                 const newScale = Math.max(0.1, Math.min(5, viewTransform.scale - e.deltaY * 0.005));
                 setViewTransform(prev => ({ ...prev, scale: newScale }));
               } else {
                 setViewTransform(prev => ({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
               }
             }}>

          <svg
            ref={svgRef}
            className="w-full h-full touch-none"
            onPointerDown={onSvgPointerDown}
            onPointerMove={onSvgPointerMove}
            onPointerUp={onSvgPointerUp}
            onPointerLeave={onSvgPointerLeave}
            onDoubleClick={onSvgDoubleClick}
          >
            <g transform={`translate(${viewTransform.x + canvasSize.w / 2}, ${viewTransform.y + canvasSize.h / 2}) scale(${viewTransform.scale})`}>

              {/* Guidelines */}
              <g className={`opacity-30 ${theme === 'dark' ? 'stroke-white' : 'stroke-black'}`} strokeWidth={1 / viewTransform.scale}>
                <line x1="-2000" y1="0" x2="2000" y2="0" stroke="currentColor" strokeDasharray="5,5" />
                <text x="-20" y="-10" fontSize={20 / viewTransform.scale} fill="currentColor" textAnchor="end">Ascender</text>

                <line x1="-2000" y1={metrics.ascender - metrics.capHeight} x2="2000" y2={metrics.ascender - metrics.capHeight} stroke="currentColor" />
                <line x1="-2000" y1={metrics.ascender - metrics.xHeight} x2="2000" y2={metrics.ascender - metrics.xHeight} stroke="currentColor" strokeDasharray="2,2" />

                <line x1="-2000" y1={metrics.ascender} x2="2000" y2={metrics.ascender} stroke="currentColor" className="opacity-50" strokeWidth={2 / viewTransform.scale} />
                <text x="-20" y={metrics.ascender - 10} fontSize={20 / viewTransform.scale} fill="currentColor" textAnchor="end">Baseline</text>

                <line x1="-2000" y1={metrics.ascender - metrics.descender} x2="2000" y2={metrics.ascender - metrics.descender} stroke="currentColor" />
                <text x="-20" y={metrics.ascender - metrics.descender + 30} fontSize={20 / viewTransform.scale} fill="currentColor" textAnchor="end">Descender</text>

                <line x1="0" y1="-1000" x2="0" y2="2000" stroke="currentColor" strokeDasharray="5,5" />
                <line x1={activeGlyph.advanceWidth} y1="-1000" x2={activeGlyph.advanceWidth} y2="2000" stroke="currentColor" strokeDasharray="5,5" />
                <text x={activeGlyph.advanceWidth + 10} y={metrics.ascender} fontSize={20 / viewTransform.scale} fill="currentColor" transform={`rotate(90 ${activeGlyph.advanceWidth + 10} ${metrics.ascender})`}>Advance Width</text>
              </g>

              {/* TEMPLATE OVERLAY */}
              {showTemplate && (
                <text
                  x={activeGlyph.advanceWidth / 2}
                  y={metrics.ascender}
                  fontSize={metrics.unitsPerEm}
                  fontFamily={templateFont}
                  textAnchor="middle"
                  fill="currentColor"
                  opacity={theme === 'dark' ? "0.1" : "0.15"}
                  className="pointer-events-none select-none"
                >
                  {String.fromCharCode(currentUnicode)}
                </text>
              )}

              {/* Committed glyph paths (filled, real vector shapes) */}
              <g className={theme === 'dark' ? 'fill-white' : 'fill-black'}>
                {activeGlyph.paths.map(path => (
                  <path key={path.id} d={pathToD(path, metrics)} fillRule="nonzero" />
                ))}
              </g>

              {/* Live brush preview while drawing */}
              {liveStroke.length > 0 && (
                <path d={pathToD({ kind: 'brush', points: buildStrokeOutline(liveStroke, brushSize) }, metrics)}
                      className={theme === 'dark' ? 'fill-white' : 'fill-black'} opacity={0.85} />
              )}

              {/* In-progress pen path */}
              {draftPen && (
                <g>
                  <path d={draftPenToD(draftPen, mousePos, metrics)} fill="none" stroke="#818cf8" strokeWidth={2 / viewTransform.scale} strokeDasharray={mousePos ? "5,4" : "none"} />
                  {draftPen.points.map((pt, i) => (
                    <circle key={i} cx={pt.x} cy={metrics.ascender - pt.y} r={5 / viewTransform.scale}
                            fill={i === 0 ? '#22c55e' : '#818cf8'} stroke="white" strokeWidth={1 / viewTransform.scale} />
                  ))}
                </g>
              )}

              {/* Selected path highlight + editable nodes */}
              {selectedPathId && tool === 'select' && (() => {
                const p = activeGlyph.paths.find(x => x.id === selectedPathId);
                if (!p) return null;
                return (
                  <g>
                    <path d={pathToD(p, metrics)} fill="none" stroke="#ef4444" strokeWidth={2 / viewTransform.scale} strokeDasharray="6,4" />
                    {p.kind === 'pen' && p.points.map((pt, i) => (
                      <circle key={i} cx={pt.x} cy={metrics.ascender - pt.y} r={5 / viewTransform.scale}
                              fill="#ef4444" stroke="white" strokeWidth={1 / viewTransform.scale} />
                    ))}
                  </g>
                );
              })()}

            </g>
          </svg>

          {/* Floating Controls */}
          <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2">
            <div className={`flex items-center backdrop-blur-md ${th.panel} bg-opacity-70 ${th.border} border rounded-md shadow-sm overflow-hidden z-10`}>
              <button onClick={handleFitToWindow} className={`p-2 border-r ${th.border} hover:bg-black/10 dark:hover:bg-white/10 ${th.textMuted} hover:text-current transition-colors`} title="Fit to Window">
                <Maximize size={16} />
              </button>
              <button onClick={handleZoomOut} className={`p-2 hover:bg-black/10 dark:hover:bg-white/10 ${th.textMuted} hover:text-current transition-colors`} title="Zoom Out">
                <ZoomOut size={16} />
              </button>
              <button onClick={handleResetView} className={`px-2 py-1 text-[10px] font-mono border-x ${th.border} ${th.textMuted} hover:bg-black/10 dark:hover:bg-white/10 hover:text-current transition-colors min-w-[50px] text-center cursor-pointer`} title="Reset View (100%)">
                {(viewTransform.scale * 100).toFixed(0)}%
              </button>
              <button onClick={handleZoomIn} className={`p-2 hover:bg-black/10 dark:hover:bg-white/10 ${th.textMuted} hover:text-current transition-colors`} title="Zoom In">
                <ZoomIn size={16} />
              </button>
            </div>
          </div>

          {/* Canvas Controls Instructions */}
          <div className={`absolute top-4 left-4 p-3 rounded-lg backdrop-blur-md ${th.panel} bg-opacity-70 ${th.border} border text-xs shadow-sm max-w-xs pointer-events-none`}>
            <ul className={`space-y-1 ${th.textMuted}`}>
              <li><kbd className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 font-sans">Wheel</kbd> Pan canvas</li>
              <li><kbd className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 font-sans">Ctrl+Wheel</kbd> Zoom in/out</li>
              <li><kbd className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 font-sans">Ctrl+Z / Ctrl+Y</kbd> Undo/Redo</li>
              <li><kbd className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 font-sans">V / P / B</kbd> Switch tool</li>
              <li><kbd className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 font-sans">Double-click</kbd> Add/remove node (Select)</li>
            </ul>
          </div>
        </div>

        {/* RIGHT METRICS PANEL */}
        {showRightPanel && (
          <aside className={`w-72 flex flex-col border-l z-10 ${th.panel} ${th.border} overflow-y-auto shadow-[-4px_0_24px_rgba(0,0,0,0.05)] transition-all duration-300`}>

            <div className="p-4 border-b border-inherit">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xs font-bold uppercase tracking-wider flex items-center gap-2"><Settings size={14} /> Glyph Data</h2>
                <button
                  onClick={() => setShowTemplate(!showTemplate)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-semibold border ${th.border} transition-colors ${showTemplate ? th.accent + ' text-white border-transparent' : th.textMuted + ' hover:bg-black/5 dark:hover:bg-white/5'}`}
                  title="Toggle Template Overlay"
                >
                  {showTemplate ? <Eye size={12} /> : <EyeOff size={12} />} {showTemplate ? 'Hide Template' : 'Show Template'}
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-3">
                    <div className={`w-14 h-14 flex items-center justify-center text-3xl font-serif rounded border ${th.border} bg-black/5 dark:bg-white/5`}>
                      {String.fromCharCode(currentUnicode)}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-mono font-bold">U+{currentUnicode.toString(16).padStart(4, '0').toUpperCase()}</div>
                      <div className={`text-xs ${th.textMuted} truncate`}>{activeGlyph.paths.length} shape{activeGlyph.paths.length !== 1 ? 's' : ''}</div>
                    </div>
                    <button
                      onClick={clearCurrentGlyph}
                      className="p-2 text-red-500 hover:bg-red-500/10 rounded transition-colors"
                      title="Clear all shapes in this glyph"
                    ><Trash2 size={16} /></button>
                  </div>
                </div>

                <div>
                  <label className={`flex justify-between text-[10px] uppercase font-semibold tracking-wider mb-1 ${th.textMuted}`}>
                    <span>Advance Width</span>
                    <span className="font-mono text-current">{activeGlyph.advanceWidth || 600}</span>
                  </label>
                  <input
                    type="range" min="100" max="2000"
                    value={activeGlyph.advanceWidth || 600}
                    onChange={(e) => {
                      const newVal = parseInt(e.target.value);
                      updateCurrentGlyphState(prev => ({ ...prev, [currentUnicode]: { ...prev[currentUnicode], advanceWidth: newVal } }));
                    }}
                    onPointerUp={() => saveToHistory(getCurrentGlyphs())}
                    className="w-full accent-indigo-500 h-1 bg-black/10 dark:bg-white/10 rounded-full appearance-none outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:rounded-full cursor-pointer"
                  />
                </div>

                <div>
                  <label className={`flex justify-between text-[10px] uppercase font-semibold tracking-wider mb-1 ${th.textMuted}`}>
                    <span>Template Font</span>
                  </label>
                  <select
                    value={templateFont}
                    onChange={(e) => setTemplateFont(e.target.value)}
                    className={`w-full text-xs rounded px-2 py-1.5 border ${th.border} bg-transparent`}
                  >
                    <option value="serif">Serif</option>
                    <option value="sans-serif">Sans-serif</option>
                    <option value="monospace">Monospace</option>
                    <option value="cursive">Cursive</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="p-4 border-b border-inherit flex-1">
              <h2 className="text-xs font-bold uppercase tracking-wider mb-4 flex items-center gap-2"><LayoutGrid size={14} /> Font Metrics</h2>
              <div className="space-y-4">
                {['unitsPerEm', 'ascender', 'descender'].map(metric => (
                  <div key={metric}>
                    <label className={`flex justify-between text-[10px] uppercase font-semibold tracking-wider mb-1 ${th.textMuted}`}>
                      <span>{metric.replace(/([A-Z])/g, ' $1').trim()}</span>
                      <span className="font-mono text-current">{metrics[metric]}</span>
                    </label>
                    <input
                      type="range"
                      min={metric === 'descender' ? -500 : 500}
                      max={metric === 'unitsPerEm' ? 2048 : 1500}
                      value={metrics[metric]}
                      onChange={(e) => setMetrics({ ...metrics, [metric]: parseInt(e.target.value) })}
                      className="w-full accent-indigo-500 h-1 bg-black/10 dark:bg-white/10 rounded-full appearance-none outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:rounded-full cursor-pointer"
                    />
                  </div>
                ))}
              </div>
              <p className={`text-[10px] mt-4 italic ${th.textMuted}`}>Global metrics apply to all glyphs.</p>
            </div>
          </aside>
        )}
      </main>

      {/* BOTTOM GLYPH STRIP */}
      <footer className={`h-32 border-t ${th.panel} ${th.border} flex flex-col z-20 shadow-[0_-4px_24px_rgba(0,0,0,0.05)]`}>
        <div className={`px-4 py-1.5 border-b ${th.border} flex items-center justify-between gap-3`}>
          <div className="flex items-center gap-1">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                onClick={() => setCharCategory(c.id)}
                className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wide transition-colors ${charCategory === c.id ? `${th.accent} text-white` : `${th.textMuted} hover:bg-black/5 dark:hover:bg-white/5`}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border ${th.border}`}>
            <Search size={12} className={th.textMuted} />
            <input
              value={charSearch}
              onChange={(e) => setCharSearch(e.target.value)}
              placeholder="Search glyph or hex..."
              className="bg-transparent text-xs outline-none w-36"
            />
          </div>
        </div>
        <div className="flex-1 overflow-x-auto overflow-y-hidden whitespace-nowrap px-2 py-2 flex items-center gap-1 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
          {visibleChars.map(code => {
            const glyph = currentGlyphs[code];
            const hasData = glyph?.paths?.length > 0;
            const isSelected = currentUnicode === code;
            return (
              <button
                key={code}
                onClick={() => { setCurrentUnicode(code); setSelectedPathId(null); }}
                className={`
                  h-full min-w-[44px] flex flex-col items-center justify-center rounded-md border transition-all relative
                  ${isSelected ? `border-indigo-500 bg-indigo-500/10 ${theme === 'dark' ? 'text-indigo-300' : 'text-indigo-700'}` :
                    `${th.border} hover:bg-black/5 dark:hover:bg-white/5 ${hasData ? 'opacity-100' : 'opacity-50'}`}
                `}
              >
                <span className="text-xl font-serif leading-none mb-1">{String.fromCharCode(code)}</span>
                <span className={`text-[9px] font-mono ${isSelected ? 'opacity-100' : 'opacity-50'}`}>
                  {code.toString(16).toUpperCase()}
                </span>
                {hasData && <div className={`absolute bottom-1 w-1 h-1 rounded-full ${isSelected ? 'bg-indigo-500' : th.textMuted}`}></div>}
              </button>
            );
          })}
          {visibleChars.length === 0 && (
            <span className={`text-xs italic px-2 ${th.textMuted}`}>No glyphs match "{charSearch}".</span>
          )}
        </div>
      </footer>
    </div>
  );
}
