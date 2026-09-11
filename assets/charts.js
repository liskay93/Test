/* charts.js — 외부 의존성 없는 경량 SVG 차트 (라인 / 수익률곡선 / 가로막대 / 스파크라인)
 *
 *  Charts.line(container, {dates, i0, i1, series:[{id,name,values,color,step,dash}], decimals, yFormat, zeroLine, area, height, filename})
 *  Charts.curve(container, {tenors:[{label,years}], curves:[{id,name,color,values:[]}], decimals, yFormat, height, filename})
 *  Charts.bars(container, {items:[{label,value}], format, height})
 *  Charts.sparkline(container, values, {width,height})
 *
 *  color: 1~8 (카테고리 팔레트 슬롯) 또는 'gray'(참고선). 시리즈 색은 항목에 고정되며 필터로 바뀌지 않는다.
 *  모든 차트는 범례(2개 이상), 크로스헤어 툴팁(키보드 ←/→ 지원), 표 보기, CSV 다운로드를 제공한다.
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const stateMap = new WeakMap();
  const TABLE_ROWS = 500;

  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v; // 내부 상수 마크업 전용 (데이터 문자열은 절대 넣지 않음)
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function s(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
    return e;
  }

  function colorVar(c) {
    if (c === 'gray') return 'var(--deemph)';
    if (typeof c === 'number') return `var(--series-${c})`;
    return c || 'var(--series-1)';
  }

  const fmt = {
    num(v, dec = 2) {
      if (v == null || !isFinite(v)) return '–';
      return v.toLocaleString('ko-KR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    },
    signed(v, dec = 2) {
      if (v == null || !isFinite(v)) return '–';
      const t = fmt.num(Math.abs(v), dec);
      return (v > 0 ? '+' : v < 0 ? '-' : '') + t;
    },
    compact(v) {
      if (v == null || !isFinite(v)) return '–';
      const a = Math.abs(v), sign = v < 0 ? '-' : '';
      const pick = (div, dec, suf) => sign + fmt.num(Math.round(a / div * 10 ** dec) / 10 ** dec, dec) + suf;
      // 반올림 결과가 상위 단위에 도달하면('10,000.0억') 상위 단위로 승격
      if (a >= 1e12 || Math.round(a / 1e8 * 10) / 10 >= 1e4) return pick(1e12, 2, '조');
      if (a >= 1e8 || Math.round(a / 1e4) >= 1e4) return pick(1e8, 1, '억');
      if (a >= 1e4 || Math.round(a) >= 1e4) return pick(1e4, 0, '만');
      return sign + fmt.num(a, 0);
    }
  };

  function getState(container) {
    let st = stateMap.get(container);
    if (!st) {
      st = { hidden: new Set(), table: false, opts: null, kind: null, ro: null };
      stateMap.set(container, st);
      if (global.ResizeObserver) {
        let lastW = container.clientWidth;
        st.ro = new ResizeObserver(() => {
          const w = container.clientWidth;
          if (!w || Math.abs(w - lastW) < 4 || !st.opts) return;
          lastW = w;
          clearTimeout(st.timer);
          st.timer = setTimeout(() => RENDERERS[st.kind](container, st.opts), 80);
        });
        st.ro.observe(container);
      }
    }
    return st;
  }

  /** 현재 시리즈에 없는 숨김 id 제거, 전부 숨겨졌으면 초기화 (컨트롤 변경 뒤 잘못된 빈 화면 방지) */
  function pruneHidden(st, series) {
    for (const id of [...st.hidden]) if (!series.some(sr => sr.id === id)) st.hidden.delete(id);
    if (series.length && series.every(sr => st.hidden.has(sr.id))) st.hidden.clear();
  }

  // 터치 기기: 탭/드래그로 띄운 툴팁은 차트 밖을 탭할 때 닫는다 (문서 리스너는 하나만 등록)
  let touchTip = null;
  function registerTouchTooltip(wrap, hide) { touchTip = { wrap, hide }; }
  document.addEventListener('pointerdown', e => {
    if (touchTip && !touchTip.wrap.contains(e.target)) { touchTip.hide(); touchTip = null; }
  }, true);

  function niceTicks(min, max, count = 5) {
    if (!(max > min)) { max = min + 1; min = min - 1; }
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10);
    const ticks = [];
    for (let t = Math.ceil(min / step - 1e-9) * step; t <= max + 1e-9; t += step) ticks.push(+t.toFixed(10));
    return { ticks, step };
  }

  function decimalsForStep(step) {
    const str = String(step);
    if (str.includes('e')) return 4;
    const i = str.indexOf('.');
    return i < 0 ? 0 : Math.min(6, str.length - i - 1);
  }

  function domainOf(arrays, i0, i1, includeZero) {
    let min = Infinity, max = -Infinity;
    for (const a of arrays) {
      for (let i = i0; i <= i1; i++) {
        const v = a[i];
        if (v == null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (min === Infinity) return null;
    if (includeZero) { min = Math.min(min, 0); max = Math.max(max, 0); }
    if (min === max) { min -= Math.abs(min) * 0.05 || 1; max += Math.abs(max) * 0.05 || 1; }
    const pad = (max - min) * 0.06;
    return [min - pad, max + pad];
  }

  function xTicks(dates, i0, i1, plotW) {
    const n = i1 - i0 + 1;
    const maxTicks = Math.max(2, Math.floor(plotW / 72));
    if (n <= 70) {
      const stride = Math.max(1, Math.ceil(n / maxTicks));
      const out = [];
      for (let i = i0; i <= i1; i += stride) out.push({ i, label: dates[i].slice(5).replace('-', '/') });
      return out;
    }
    const months = [];
    for (let i = i0; i <= i1; i++) {
      const ym = dates[i].slice(0, 7);
      if (i === 0 || dates[i - 1].slice(0, 7) !== ym) {
        months.push({ i, year: dates[i].slice(0, 4), mon: +dates[i].slice(5, 7) });
      }
    }
    const strides = [1, 2, 3, 6, 12, 24, 36, 60, 120];
    for (const st of strides) {
      const sel = months.filter(mo => st >= 12 ? (mo.mon === 1 && (+mo.year) % (st / 12) === 0) : ((mo.mon - 1) % st === 0));
      if (sel.length <= maxTicks || st === strides[strides.length - 1]) {
        return sel.map(mo => ({
          i: mo.i,
          label: st >= 12 ? mo.year : (mo.mon === 1 ? mo.year : `${mo.year.slice(2)}.${String(mo.mon).padStart(2, '0')}`)
        }));
      }
    }
    return [];
  }

  function buildPath(values, i0, i1, xs, ys, step, maxPts) {
    const n = i1 - i0 + 1;
    const bucket = Math.max(1, Math.ceil(n / Math.max(50, maxPts)));
    let d = '', pen = false;
    const emit = (i, v) => {
      const x = xs(i).toFixed(1), y = ys(v).toFixed(1);
      if (!pen) { d += `M${x} ${y}`; pen = true; }
      else if (step) d += `H${x}V${y}`;
      else d += `L${x} ${y}`;
    };
    if (bucket === 1) {
      for (let i = i0; i <= i1; i++) {
        const v = values[i];
        if (v == null) { pen = false; continue; }
        emit(i, v);
      }
      return d;
    }
    for (let b = i0; b <= i1; b += bucket) {
      const e = Math.min(i1, b + bucket - 1);
      let mi = -1, ma = -1, allNull = true;
      for (let i = b; i <= e; i++) {
        const v = values[i];
        if (v == null) continue;
        allNull = false;
        if (mi < 0 || v < values[mi]) mi = i;
        if (ma < 0 || v > values[ma]) ma = i;
      }
      if (allNull) { pen = false; continue; }
      const first = Math.min(mi, ma), second = Math.max(mi, ma);
      emit(first, values[first]);
      if (second !== first) emit(second, values[second]);
    }
    return d;
  }

  function lastValidIn(values, i0, i1) {
    for (let i = i1; i >= i0; i--) if (values[i] != null) return i;
    return -1;
  }

  function downloadCsv(filename, header, rows) {
    const esc = v => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const body = [header.map(esc).join(',')].concat(rows.map(r => r.map(esc).join(','))).join('\n');
    const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function makeTooltip() {
    return h('div', { class: 'chart-tooltip', role: 'status', 'aria-live': 'polite', hidden: '' });
  }

  function placeTooltip(tip, plotWrap, x, y) {
    const w = plotWrap.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14;
    if (left + tw > w - 4) left = Math.max(4, x - tw - 14);
    let top = y - th / 2;
    top = Math.max(4, Math.min(plotWrap.clientHeight - th - 4, top));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function toolbar(container, st, series, rerender, extra) {
    const legend = h('div', { class: 'chart-legend', role: 'group', 'aria-label': '범례 (클릭하면 숨기기/보이기)' });
    if (series.length >= 2 || st.hidden.size) {
      const visibleCount = series.filter(sr => !st.hidden.has(sr.id)).length;
      for (const sr of series) {
        const hidden = st.hidden.has(sr.id);
        const item = h('button', {
          class: 'legend-item' + (hidden ? ' is-hidden' : ''), type: 'button',
          'aria-pressed': String(!hidden), title: '클릭하면 숨기기/보이기'
        }, h('span', { class: 'legend-key' + (sr.kind === 'rect' ? ' is-rect' : ''), style: `background:${colorVar(sr.color)}` }),
           h('span', { class: 'legend-name', text: sr.name }));
        item.addEventListener('click', () => {
          if (hidden) st.hidden.delete(sr.id);
          else if (visibleCount > 1) st.hidden.add(sr.id);
          rerender();
        });
        legend.appendChild(item);
      }
    }
    const btnTable = h('button', { class: 'chart-btn', type: 'button', 'aria-pressed': String(st.table), text: st.table ? '차트' : '표' });
    btnTable.addEventListener('click', () => { st.table = !st.table; rerender(); });
    const btnCsv = h('button', { class: 'chart-btn', type: 'button', text: 'CSV' });
    btnCsv.addEventListener('click', extra.csv);
    return h('div', { class: 'chart-toolbar' }, legend, h('div', { class: 'chart-actions' }, btnTable, btnCsv));
  }

  /* ------------------------------------------------------------------ */
  /* 라인 차트                                                            */
  /* ------------------------------------------------------------------ */
  function line(container, opts) {
    const st = getState(container);
    st.kind = 'line'; st.opts = opts;
    container.classList.add('chart');
    container.textContent = '';
    const { dates, i0, i1 } = opts;
    const series = opts.series.filter(sr => sr && Array.isArray(sr.values));
    pruneHidden(st, series);
    const dec = opts.decimals ?? 2;
    const yFormat = opts.yFormat || (v => fmt.num(v, dec));
    const height = opts.height || 280;
    const width = Math.max(260, container.clientWidth || 640);
    const rerender = () => line(container, opts);
    const visible = series.filter(sr => !st.hidden.has(sr.id));

    container.appendChild(toolbar(container, st, series, rerender, {
      csv: () => {
        const header = ['일자'].concat(series.map(sr => sr.name));
        const rows = [];
        for (let i = i0; i <= i1; i++) rows.push([dates[i]].concat(series.map(sr => sr.values[i])));
        downloadCsv(`${opts.filename || 'chart'}_${dates[i0]}_${dates[i1]}.csv`, header, rows);
      }
    }));

    if (st.table) {
      const from = Math.max(i0, i1 - TABLE_ROWS + 1);
      const tbl = h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {}, h('th', { text: '일자' }), series.map(sr => h('th', { text: sr.name })))),
        h('tbody', {}, (() => {
          const trs = [];
          for (let i = i1; i >= from; i--) {
            trs.push(h('tr', {}, h('td', { text: dates[i] }), series.map(sr => h('td', { class: 'num', text: sr.values[i] == null ? '–' : yFormat(sr.values[i]) }))));
          }
          return trs;
        })()));
      container.appendChild(h('div', { class: 'chart-table' }, tbl));
      if (i1 - i0 + 1 > TABLE_ROWS) container.appendChild(h('p', { class: 'chart-note', text: `최근 ${TABLE_ROWS}행만 표시 · 전체 구간은 CSV 로 내려받을 수 있습니다` }));
      return;
    }

    const plotWrap = h('div', { class: 'chart-plot', role: 'group', tabindex: '0', 'aria-label': opts.ariaLabel || '시계열 차트 (←/→ 로 날짜 이동)' });
    container.appendChild(plotWrap);

    const domain = domainOf(visible.map(sr => sr.values), i0, i1, !!opts.zeroLine);
    if (!domain || i1 < i0) {
      plotWrap.appendChild(h('div', { class: 'chart-empty', text: opts.emptyText || '선택한 기간에 표시할 데이터가 없습니다' }));
      return;
    }
    const { ticks, step } = niceTicks(domain[0], domain[1], Math.max(3, Math.round(height / 60)));
    const tickDec = Math.max(decimalsForStep(step), 0);
    const tickFmt = v => (opts.yFormat ? opts.yFormat(v, tickDec) : fmt.num(v, tickDec));
    const labelW = Math.max(...ticks.map(t => tickFmt(t).length), 3) * 6.6 + 10;
    const endLabels = opts.endLabels !== false && visible.length <= 4;
    let endLabelW = 0;
    if (endLabels) {
      for (const sr of visible) {
        const li = lastValidIn(sr.values, i0, i1);
        if (li >= 0) endLabelW = Math.max(endLabelW, yFormat(sr.values[li]).length * 7 + 18);
      }
    }
    const ml = Math.round(labelW), mr = endLabels ? Math.max(48, Math.round(endLabelW)) : 12, mt = 10, mb = 24;
    const plotW = width - ml - mr, plotH = height - mt - mb;
    const xs = i => ml + (i1 === i0 ? plotW / 2 : (i - i0) / (i1 - i0) * plotW);
    const ys = v => mt + (domain[1] - v) / (domain[1] - domain[0]) * plotH;

    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });
    svg.appendChild(s('title')).textContent = opts.ariaLabel || '시계열 차트';

    // 격자 + y축 라벨
    const gGrid = s('g', { class: 'grid' });
    for (const t of ticks) {
      const y = ys(t).toFixed(1);
      gGrid.appendChild(s('line', { x1: ml, x2: width - mr, y1: y, y2: y, class: t === 0 ? 'axis-line' : 'grid-line' }));
      const txt = s('text', { x: ml - 6, y, class: 'axis-label', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      txt.textContent = tickFmt(t);
      gGrid.appendChild(txt);
    }
    if (opts.zeroLine && !ticks.includes(0) && domain[0] < 0 && domain[1] > 0) {
      const y = ys(0).toFixed(1);
      gGrid.appendChild(s('line', { x1: ml, x2: width - mr, y1: y, y2: y, class: 'axis-line' }));
    }
    svg.appendChild(gGrid);
    // x축
    const gX = s('g', { class: 'xaxis' });
    gX.appendChild(s('line', { x1: ml, x2: width - mr, y1: height - mb, y2: height - mb, class: 'axis-line' }));
    for (const tk of xTicks(dates, i0, i1, plotW)) {
      const x = xs(tk.i);
      gX.appendChild(s('line', { x1: x, x2: x, y1: height - mb, y2: height - mb + 4, class: 'axis-line' }));
      const txt = s('text', { x, y: height - mb + 15, class: 'axis-label', 'text-anchor': x > width - mr - 24 ? 'end' : (x < ml + 12 ? 'start' : 'middle') });
      txt.textContent = tk.label;
      gX.appendChild(txt);
    }
    svg.appendChild(gX);

    // 면적(단일 시리즈)
    const gLines = s('g', { class: 'lines' });
    if (opts.area && visible.length === 1) {
      const sr = visible[0];
      let d = '', segStart = null;
      for (let i = i0; i <= i1 + 1; i++) {
        const v = i <= i1 ? sr.values[i] : null;
        if (v != null && segStart == null) segStart = i;
        if ((v == null || i === i1 + 1) && segStart != null) {
          const segEnd = i - 1;
          const p = buildPath(sr.values, segStart, segEnd, xs, ys, false, plotW * 2);
          if (p) d += p + `L${xs(segEnd).toFixed(1)} ${(height - mb).toFixed(1)}L${xs(segStart).toFixed(1)} ${(height - mb).toFixed(1)}Z`;
          segStart = null;
        }
      }
      const area = s('path', { d, class: 'area-fill' });
      area.style.fill = colorVar(sr.color);
      gLines.appendChild(area);
    }
    for (const sr of visible) {
      const d = buildPath(sr.values, i0, i1, xs, ys, !!sr.step, plotW * 2);
      if (!d) continue;
      const p = s('path', { d, class: 'series-line', fill: 'none', 'stroke-width': sr.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      p.style.stroke = colorVar(sr.color);
      if (sr.dash) p.setAttribute('stroke-dasharray', '5 4');
      gLines.appendChild(p);
    }
    svg.appendChild(gLines);

    // 끝값 라벨 (4개 이하): 겹치면 리더선으로 연결
    if (endLabels) {
      const labels = [];
      for (const sr of visible) {
        const li = lastValidIn(sr.values, i0, i1);
        if (li < 0) continue;
        labels.push({ sr, x: xs(li), yLine: ys(sr.values[li]), y: ys(sr.values[li]), text: yFormat(sr.values[li]) });
      }
      labels.sort((a, b) => a.y - b.y);
      const minGap = 13;
      for (let k = 1; k < labels.length; k++) if (labels[k].y - labels[k - 1].y < minGap) labels[k].y = labels[k - 1].y + minGap;
      const bottom = height - mb - 4;
      if (labels.length && labels[labels.length - 1].y > bottom) {
        const shift = labels[labels.length - 1].y - bottom;
        for (const l of labels) l.y -= shift;
      }
      if (labels.length && labels[0].y < mt + 4) {
        const shift = mt + 4 - labels[0].y;
        for (const l of labels) l.y += shift;
      }
      const gEnd = s('g', { class: 'end-labels' });
      for (const l of labels) {
        const x1 = width - mr + 2;
        if (Math.abs(l.y - l.yLine) > 1.5) {
          const ld = s('line', { x1: l.x + 2, y1: l.yLine.toFixed(1), x2: x1 + 8, y2: l.y.toFixed(1), class: 'leader-line' });
          gEnd.appendChild(ld);
        }
        const dot = s('circle', { cx: l.x.toFixed(1), cy: l.yLine.toFixed(1), r: 4, class: 'end-dot' });
        dot.style.fill = colorVar(l.sr.color);
        gEnd.appendChild(dot);
        const t = s('text', { x: x1 + 10, y: l.y.toFixed(1), class: 'end-label', 'dominant-baseline': 'middle' });
        t.textContent = l.text;
        gEnd.appendChild(t);
      }
      svg.appendChild(gEnd);
    }

    // 크로스헤어 + 툴팁
    const gCross = s('g', { class: 'crosshair', visibility: 'hidden' });
    const vline = s('line', { y1: mt, y2: height - mb, class: 'crosshair-line' });
    gCross.appendChild(vline);
    const dots = visible.map(sr => {
      const c = s('circle', { r: 4.5, class: 'hover-dot' });
      c.style.fill = colorVar(sr.color);
      gCross.appendChild(c);
      return c;
    });
    svg.appendChild(gCross);
    const overlay = s('rect', { x: ml, y: mt, width: plotW, height: plotH, fill: 'transparent', class: 'overlay' });
    svg.appendChild(overlay);
    plotWrap.appendChild(svg);
    const tip = makeTooltip();
    plotWrap.appendChild(tip);

    let curIdx = -1;
    function showAt(idx, clientX) {
      idx = Math.max(i0, Math.min(i1, idx));
      curIdx = idx;
      const scale = svg.getBoundingClientRect().width / width;
      const x = xs(idx);
      vline.setAttribute('x1', x); vline.setAttribute('x2', x);
      visible.forEach((sr, k) => {
        const v = sr.values[idx];
        if (v == null) { dots[k].setAttribute('visibility', 'hidden'); return; }
        dots[k].setAttribute('visibility', 'visible');
        dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', ys(v));
      });
      gCross.setAttribute('visibility', 'visible');
      tip.textContent = '';
      tip.appendChild(h('div', { class: 'tip-date', text: dates[idx] }));
      for (const sr of visible) {
        const v = sr.values[idx];
        tip.appendChild(h('div', { class: 'tip-row' },
          h('span', { class: 'tip-key', style: `background:${colorVar(sr.color)}` }),
          h('span', { class: 'tip-val', text: v == null ? '–' : yFormat(v) }),
          h('span', { class: 'tip-name', text: sr.name })));
      }
      tip.hidden = false;
      let py = mt * scale + plotH * scale / 2;
      placeTooltip(tip, plotWrap, x * scale, py);
    }
    function hide() { gCross.setAttribute('visibility', 'hidden'); tip.hidden = true; curIdx = -1; }
    const onPointer = e => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (width / r.width);
      const idx = Math.round(i0 + (px - ml) / plotW * (i1 - i0));
      showAt(idx);
      if (e.pointerType === 'touch') registerTouchTooltip(plotWrap, hide);
    };
    overlay.addEventListener('pointermove', onPointer);
    overlay.addEventListener('pointerdown', onPointer);
    overlay.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') hide(); });
    plotWrap.addEventListener('keydown', e => {
      if (e.key === 'Escape') { hide(); return; }
      const stepN = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); showAt((curIdx < 0 ? i1 : curIdx) - stepN); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); showAt((curIdx < 0 ? i1 - 1 : curIdx) + stepN); }
      else if (e.key === 'Home') { e.preventDefault(); showAt(i0); }
      else if (e.key === 'End') { e.preventDefault(); showAt(i1); }
    });
    plotWrap.addEventListener('blur', hide);
  }

  /* ------------------------------------------------------------------ */
  /* 수익률 곡선 (x = 만기 범주)                                            */
  /* ------------------------------------------------------------------ */
  function curve(container, opts) {
    const st = getState(container);
    st.kind = 'curve'; st.opts = opts;
    container.classList.add('chart');
    container.textContent = '';
    const tenors = opts.tenors || [];
    const curves = (opts.curves || []).filter(c => c && Array.isArray(c.values));
    pruneHidden(st, curves);
    const dec = opts.decimals ?? 2;
    const yFormat = opts.yFormat || (v => fmt.num(v, dec));
    const height = opts.height || 280;
    const width = Math.max(260, container.clientWidth || 640);
    const rerender = () => curve(container, opts);
    const visible = curves.filter(c => !st.hidden.has(c.id));

    container.appendChild(toolbar(container, st, curves, rerender, {
      csv: () => {
        const header = ['만기'].concat(curves.map(c => c.name));
        const rows = tenors.map((t, k) => [t.label].concat(curves.map(c => c.values[k])));
        downloadCsv(`${opts.filename || 'curve'}.csv`, header, rows);
      }
    }));

    if (st.table) {
      const tbl = h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {}, h('th', { text: '만기' }), curves.map(c => h('th', { text: c.name })))),
        h('tbody', {}, tenors.map((t, k) => h('tr', {}, h('td', { text: t.label }), curves.map(c => h('td', { class: 'num', text: c.values[k] == null ? '–' : yFormat(c.values[k]) }))))));
      container.appendChild(h('div', { class: 'chart-table' }, tbl));
      return;
    }

    const plotWrap = h('div', { class: 'chart-plot', role: 'group', tabindex: '0', 'aria-label': opts.ariaLabel || '수익률 곡선 (←/→ 로 만기 이동)' });
    container.appendChild(plotWrap);
    const T = tenors.length;
    const domain = T ? domainOf(visible.map(c => c.values), 0, T - 1, false) : null;
    if (!domain) {
      plotWrap.appendChild(h('div', { class: 'chart-empty', text: opts.emptyText || '표시할 데이터가 없습니다' }));
      return;
    }
    const { ticks, step } = niceTicks(domain[0], domain[1], Math.max(3, Math.round(height / 60)));
    const tickDec = decimalsForStep(step);
    const tickFmt = v => fmt.num(v, tickDec);
    const ml = Math.round(Math.max(...ticks.map(t => tickFmt(t).length), 3) * 6.6 + 10), mr = 16, mt = 10, mb = 24;
    const plotW = width - ml - mr, plotH = height - mt - mb;
    const padX = Math.min(24, plotW / (T + 1) / 2);
    const xs = k => ml + padX + (T === 1 ? plotW / 2 - padX : k / (T - 1) * (plotW - padX * 2));
    const ys = v => mt + (domain[1] - v) / (domain[1] - domain[0]) * plotH;

    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });
    svg.appendChild(s('title')).textContent = opts.ariaLabel || '수익률 곡선';
    const gGrid = s('g', { class: 'grid' });
    for (const t of ticks) {
      const y = ys(t).toFixed(1);
      gGrid.appendChild(s('line', { x1: ml, x2: width - mr, y1: y, y2: y, class: t === 0 ? 'axis-line' : 'grid-line' }));
      const txt = s('text', { x: ml - 6, y, class: 'axis-label', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      txt.textContent = tickFmt(t);
      gGrid.appendChild(txt);
    }
    svg.appendChild(gGrid);
    const gX = s('g', { class: 'xaxis' });
    gX.appendChild(s('line', { x1: ml, x2: width - mr, y1: height - mb, y2: height - mb, class: 'axis-line' }));
    const labelEvery = Math.max(1, Math.ceil(T / Math.max(2, Math.floor(plotW / 44))));
    tenors.forEach((t, k) => {
      const x = xs(k);
      gX.appendChild(s('line', { x1: x, x2: x, y1: height - mb, y2: height - mb + 4, class: 'axis-line' }));
      if ((T - 1 - k) % labelEvery === 0) {
        const txt = s('text', { x, y: height - mb + 15, class: 'axis-label', 'text-anchor': 'middle' });
        txt.textContent = t.label;
        gX.appendChild(txt);
      }
    });
    svg.appendChild(gX);

    const gLines = s('g', { class: 'lines' });
    for (const c of visible) {
      let d = '', pen = false;
      for (let k = 0; k < T; k++) {
        const v = c.values[k];
        if (v == null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + xs(k).toFixed(1) + ' ' + ys(v).toFixed(1);
        pen = true;
      }
      const p = s('path', { d, class: 'series-line', fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      p.style.stroke = colorVar(c.color);
      if (c.dash) p.setAttribute('stroke-dasharray', '5 4');
      gLines.appendChild(p);
      for (let k = 0; k < T; k++) {
        const v = c.values[k];
        if (v == null) continue;
        const dot = s('circle', { cx: xs(k).toFixed(1), cy: ys(v).toFixed(1), r: 4, class: 'point-dot' });
        dot.style.fill = colorVar(c.color);
        gLines.appendChild(dot);
      }
    }
    svg.appendChild(gLines);

    const gCross = s('g', { class: 'crosshair', visibility: 'hidden' });
    const vline = s('line', { y1: mt, y2: height - mb, class: 'crosshair-line' });
    gCross.appendChild(vline);
    svg.appendChild(gCross);
    const overlay = s('rect', { x: ml, y: mt, width: plotW, height: plotH, fill: 'transparent', class: 'overlay' });
    svg.appendChild(overlay);
    plotWrap.appendChild(svg);
    const tip = makeTooltip();
    plotWrap.appendChild(tip);
    let cur = -1;
    function showAt(k) {
      k = Math.max(0, Math.min(T - 1, k));
      cur = k;
      const scale = svg.getBoundingClientRect().width / width;
      const x = xs(k);
      vline.setAttribute('x1', x); vline.setAttribute('x2', x);
      gCross.setAttribute('visibility', 'visible');
      tip.textContent = '';
      tip.appendChild(h('div', { class: 'tip-date', text: `만기 ${tenors[k].label}` }));
      for (const c of visible) {
        tip.appendChild(h('div', { class: 'tip-row' },
          h('span', { class: 'tip-key', style: `background:${colorVar(c.color)}` }),
          h('span', { class: 'tip-val', text: c.values[k] == null ? '–' : yFormat(c.values[k]) }),
          h('span', { class: 'tip-name', text: c.name })));
      }
      tip.hidden = false;
      placeTooltip(tip, plotWrap, x * scale, (mt + plotH / 2) * scale);
    }
    function hide() { gCross.setAttribute('visibility', 'hidden'); tip.hidden = true; cur = -1; }
    const onPointer = e => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (width / r.width);
      let best = 0, bd = Infinity;
      for (let k = 0; k < T; k++) { const d = Math.abs(xs(k) - px); if (d < bd) { bd = d; best = k; } }
      showAt(best);
      if (e.pointerType === 'touch') registerTouchTooltip(plotWrap, hide);
    };
    overlay.addEventListener('pointermove', onPointer);
    overlay.addEventListener('pointerdown', onPointer);
    overlay.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') hide(); });
    plotWrap.addEventListener('keydown', e => {
      if (e.key === 'Escape') { hide(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); showAt((cur < 0 ? T - 1 : cur) - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); showAt((cur < 0 ? -1 : cur) + 1); }
    });
    plotWrap.addEventListener('blur', hide);
  }

  /* ------------------------------------------------------------------ */
  /* 가로 막대 (양/음 분기)                                                 */
  /* ------------------------------------------------------------------ */
  function bars(container, opts) {
    const st = getState(container);
    st.kind = 'bars'; st.opts = opts;
    container.classList.add('chart');
    container.textContent = '';
    const items = (opts.items || []).filter(it => it && it.value != null && isFinite(it.value));
    const format = opts.format || (v => fmt.num(v, 0));
    const width = Math.max(260, container.clientWidth || 640);
    const rerender = () => bars(container, opts);
    container.appendChild(toolbar(container, st, [], rerender, {
      csv: () => downloadCsv(`${opts.filename || 'bars'}.csv`, ['항목', '값'], items.map(it => [it.label, it.value]))
    }));
    if (st.table) {
      container.appendChild(h('div', { class: 'chart-table' }, h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {}, h('th', { text: '항목' }), h('th', { text: '값' }))),
        h('tbody', {}, items.map(it => h('tr', {}, h('td', { text: it.label }), h('td', { class: 'num', text: format(it.value) })))))));
      return;
    }
    const plotWrap = h('div', { class: 'chart-plot' });
    container.appendChild(plotWrap);
    if (!items.length) { plotWrap.appendChild(h('div', { class: 'chart-empty', text: '표시할 데이터가 없습니다' })); return; }
    const rowH = 28, barH = 18;
    const labelW = Math.min(150, Math.max(...items.map(it => it.label.length)) * 12 + 12);
    const valueW = Math.max(...items.map(it => format(it.value).length)) * 7 + 12;
    let min = Math.min(0, ...items.map(it => it.value)), max = Math.max(0, ...items.map(it => it.value));
    if (min === max) max = min + 1;
    // 값 라벨은 막대 바깥쪽에 놓이므로 음수가 있으면 왼쪽에도, 양수가 있으면 오른쪽에도 라벨 폭을 예약
    const ml = labelW + (min < 0 ? valueW : 0), mr = 12 + (max > 0 ? valueW : 0), mt = 6, mb = 6;
    const plotW = Math.max(60, width - ml - mr);
    const height = mt + items.length * rowH + mb;
    const xs = v => ml + (v - min) / (max - min) * plotW;
    const x0 = xs(0);
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });
    svg.appendChild(s('title')).textContent = opts.ariaLabel || '가로 막대 차트';
    svg.appendChild(s('line', { x1: x0, x2: x0, y1: mt, y2: height - mb, class: 'axis-line' }));
    const tip = makeTooltip();
    items.forEach((it, k) => {
      const y = mt + k * rowH + (rowH - barH) / 2;
      const lbl = s('text', { x: labelW - 8, y: y + barH / 2, class: 'axis-label bar-label', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      lbl.textContent = it.label;
      svg.appendChild(lbl);
      const x1 = xs(it.value);
      const pos = it.value >= 0;
      const left = Math.min(x0, x1), right = Math.max(x0, x1);
      const w = Math.max(0, right - left);
      const r = Math.min(4, w);
      let d;
      if (pos) d = `M${left} ${y}H${right - r}Q${right} ${y} ${right} ${y + r}V${y + barH - r}Q${right} ${y + barH} ${right - r} ${y + barH}H${left}Z`;
      else d = `M${right} ${y}H${left + r}Q${left} ${y} ${left} ${y + r}V${y + barH - r}Q${left} ${y + barH} ${left + r} ${y + barH}H${right}Z`;
      const bar = s('path', { d, class: 'bar ' + (pos ? 'is-pos' : 'is-neg') });
      svg.appendChild(bar);
      const val = s('text', { x: pos ? right + 6 : left - 6, y: y + barH / 2, class: 'bar-value', 'text-anchor': pos ? 'start' : 'end', 'dominant-baseline': 'middle' });
      val.textContent = format(it.value);
      svg.appendChild(val);
      // 히트 영역은 행 전체(28px 높이, 라벨~값 라벨 끝까지) — 칠해진 막대보다 크게
      const hit = s('rect', { x: labelW, y: mt + k * rowH, width: Math.max(0, width - labelW - 12), height: rowH, fill: 'transparent', class: 'bar-hit', tabindex: '0', role: 'img' });
      const t = s('title'); t.textContent = `${it.label}: ${format(it.value)}`; hit.appendChild(t);
      const show = () => {
        bar.style.opacity = '0.8';
        tip.textContent = '';
        tip.appendChild(h('div', { class: 'tip-row' }, h('span', { class: 'tip-key', style: `background:${pos ? 'var(--pos)' : 'var(--neg)'}` }), h('span', { class: 'tip-val', text: format(it.value) }), h('span', { class: 'tip-name', text: it.label })));
        tip.hidden = false;
        const scale = svg.getBoundingClientRect().width / width;
        placeTooltip(tip, plotWrap, (pos ? right : left) * scale, (y + barH / 2) * scale);
      };
      const hide = () => { bar.style.opacity = ''; tip.hidden = true; };
      hit.addEventListener('pointerenter', show); hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show); hit.addEventListener('blur', hide);
      svg.appendChild(hit);
    });
    plotWrap.appendChild(svg);
    plotWrap.appendChild(tip);
  }

  /* ------------------------------------------------------------------ */
  /* 스파크라인                                                            */
  /* ------------------------------------------------------------------ */
  function sparkline(container, values, opts = {}) {
    const w = opts.width || 96, hgt = opts.height || 28;
    container.textContent = '';
    const pts = [];
    (values || []).forEach((v, i) => { if (v != null) pts.push([i, v]); });
    if (pts.length < 2) return;
    const n = values.length;
    let min = Infinity, max = -Infinity;
    for (const [, v] of pts) { if (v < min) min = v; if (v > max) max = v; }
    if (min === max) { min -= 1; max += 1; }
    const xs = i => 2 + i / (n - 1) * (w - 4);
    const ys = v => 3 + (max - v) / (max - min) * (hgt - 6);
    const svg = s('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: 'spark', 'aria-hidden': 'true' });
    let d = '';
    pts.forEach(([i, v], k) => { d += (k ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(v).toFixed(1); });
    svg.appendChild(s('path', { d, class: 'spark-line', fill: 'none', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    const [li, lv] = pts[pts.length - 1];
    svg.appendChild(s('circle', { cx: xs(li).toFixed(1), cy: ys(lv).toFixed(1), r: 3, class: 'spark-dot' }));
    container.appendChild(svg);
  }

  const RENDERERS = { line, curve, bars };
  global.Charts = { line, curve, bars, sparkline, fmt, h, colorVar };
})(window);
