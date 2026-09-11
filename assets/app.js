/* app.js — 대시보드 조립: 필터, KPI, 패널 정의, 렌더링 */
(function () {
  'use strict';

  const cfg = window.DASHBOARD_CONFIG || {};
  const C = window.Charts;
  const h = C.h;
  const fmt = C.fmt;

  /* ------------------------------------------------------------------ */
  /* 유틸                                                                 */
  /* ------------------------------------------------------------------ */
  function shiftMonths(dateStr, months) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12), nm = total - ny * 12 + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  }
  function shiftDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  }
  function unitSuffix(meta) {
    if (meta.unit === 'pct') return '%';
    if (meta.unit === 'bp') return 'bp';
    if (meta.unit === 'index') return 'pt';
    return '';
  }
  function fmtValue(v, meta) {
    if (v == null) return '–';
    if (meta.unit === 'krw') return fmt.compact(v);
    return fmt.num(v, meta.decimals ?? 2);
  }
  /** 변화량 → {text, dir} (금리는 bp 환산) */
  function changeText(delta, meta, prev) {
    if (delta == null || !isFinite(delta)) return { text: '–', dir: 0 };
    let text;
    switch (meta.change_unit) {
      case 'bp': {
        const bp = meta.unit === 'pct' ? Math.round(delta * 10000) / 100 : Math.round(delta * 100) / 100;
        text = fmt.signed(bp, Number.isInteger(bp) ? 0 : 1) + 'bp';
        break;
      }
      case 'abs': {
        text = fmt.signed(delta, meta.decimals ?? 2);
        if (prev) text += ` (${fmt.signed(delta / prev * 100, 2)}%)`;
        break;
      }
      case 'pt': text = fmt.signed(delta, meta.decimals ?? 2) + 'pt'; break;
      default: text = fmt.signed(delta, 0);
    }
    return { text, dir: Math.sign(delta) };
  }
  function yFormatFor(unit, decimals) {
    if (unit === 'bp') return (v, d) => fmt.num(v, d ?? 0);
    if (unit === 'krw') return v => fmt.compact(v);
    return (v, d) => fmt.num(v, d ?? decimals ?? 2);
  }
  function spreadBp(a, b) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] == null || b[i] == null) ? null : Math.round((a[i] - b[i]) * 10000) / 100;
    return out;
  }
  function diffOf(a, b) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] == null || b[i] == null) ? null : Math.round((a[i] - b[i]) * 1e6) / 1e6;
    return out;
  }
  function cumulative(values, i0, i1) {
    const out = new Array(values.length).fill(null);
    let acc = 0;
    for (let i = i0; i <= i1; i++) { if (values[i] != null) acc += values[i]; out[i] = acc; }
    return out;
  }
  function indexed(values, i0, i1) {
    const out = new Array(values.length).fill(null);
    let base = null;
    for (let i = i0; i <= i1; i++) { if (values[i] != null) { base = values[i]; break; } }
    if (!base) return out;
    for (let i = i0; i <= i1; i++) out[i] = values[i] == null ? null : Math.round(values[i] / base * 10000) / 100;
    return out;
  }
  function sumRange(values, i0, i1) {
    let acc = 0, any = false;
    for (let i = i0; i <= i1; i++) if (values[i] != null) { acc += values[i]; any = true; }
    return any ? acc : null;
  }

  /* ------------------------------------------------------------------ */
  /* 테마                                                                 */
  /* ------------------------------------------------------------------ */
  const THEMES = [['system', '시스템'], ['light', '라이트'], ['dark', '다크']];
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = '테마: ' + (THEMES.find(x => x[0] === t) || THEMES[0])[1];
  }
  function initTheme() {
    let cur = 'system';
    try { cur = localStorage.getItem('dash-theme') || 'system'; } catch (e) { /* ignore */ }
    applyTheme(cur);
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const idx = THEMES.findIndex(x => x[0] === cur);
      cur = THEMES[(idx + 1) % THEMES.length][0];
      applyTheme(cur);
      try { localStorage.setItem('dash-theme', cur); } catch (e) { /* ignore */ }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 상태 / 기간                                                           */
  /* ------------------------------------------------------------------ */
  const PRESETS = [['1M', 1], ['3M', 3], ['6M', 6], ['YTD', 'ytd'], ['1Y', 12], ['3Y', 36], ['5Y', 60], ['10Y', 120], ['전체', 'all']];
  const state = { preset: '1Y', from: null, to: null, i0: 0, i1: 0 };
  let store = null;
  const panels = [];

  function computeRange() {
    const N = store.dates.length;
    let i1 = N - 1;
    if (state.to) { const k = store.indexAtOrBefore(state.to); if (k >= 0) i1 = k; }
    let i0 = 0;
    if (state.from) i0 = Math.min(i1, store.indexAtOrAfter(state.from));
    else if (state.preset === '전체') i0 = 0;
    else if (state.preset === 'YTD') i0 = store.indexAtOrAfter(store.dates[i1].slice(0, 4) + '-01-01');
    else {
      const months = PRESETS.find(p => p[0] === state.preset)[1];
      i0 = store.indexAtOrAfter(shiftMonths(store.dates[i1], -months));
    }
    if (i0 > i1) i0 = i1;
    if (i0 === i1 && i1 > 0) i0 = i1 - 1;
    state.i0 = i0; state.i1 = i1;
  }

  function buildFilterBar() {
    const bar = document.getElementById('filter-bar');
    const group = document.getElementById('presets');
    for (const [label] of PRESETS) {
      const b = h('button', { class: 'btn', type: 'button', text: label, 'aria-pressed': String(label === state.preset) });
      b.addEventListener('click', () => {
        state.preset = label; state.from = null; state.to = null;
        document.getElementById('range-from').value = '';
        document.getElementById('range-to').value = '';
        updatePresetButtons();
        renderAll();
      });
      group.appendChild(b);
    }
    const form = document.getElementById('custom-range');
    const from = document.getElementById('range-from'), to = document.getElementById('range-to');
    from.min = store.dates[0]; from.max = store.dates[store.dates.length - 1];
    to.min = store.dates[0]; to.max = store.dates[store.dates.length - 1];
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!from.value && !to.value) return;
      if (from.value && to.value && from.value > to.value) { [from.value, to.value] = [to.value, from.value]; }
      state.from = from.value || null; state.to = to.value || null;
      if (!state.from) state.preset = '전체';
      updatePresetButtons();
      renderAll();
    });
    bar.hidden = false;
  }
  function updatePresetButtons() {
    const custom = !!(state.from || state.to);
    document.querySelectorAll('#presets .btn').forEach(b => b.setAttribute('aria-pressed', String(!custom && b.textContent === state.preset)));
  }
  function updateRangeSummary() {
    const el = document.getElementById('range-summary');
    el.textContent = `${store.dates[state.i0]} ~ ${store.dates[state.i1]} · 거래일 ${(state.i1 - state.i0 + 1).toLocaleString('ko-KR')}일`;
  }

  /* ------------------------------------------------------------------ */
  /* 섹션 / 패널 골격                                                       */
  /* ------------------------------------------------------------------ */
  const SECTIONS = [
    ['kpi', '주요 지표', '최신 거래일 값과 전일 대비 변화 (금리·스프레드는 bp)'],
    ['curve', '국채 수익률 곡선', '기간 필터의 종료일을 기준으로 과거 시점과 비교'],
    ['rates', '금리 추이', ''],
    ['policy', '정책금리', ''],
    ['credit', '크레딧', '한국 크레딧 스프레드·단기금리·크레딧 커브, 미국 OAS'],
    ['fx', '환율 · 스왑 · 헤지', ''],
    ['bei', '기대인플레이션 (BEI)', '10년 손익분기 인플레이션율'],
    ['vol', '변동성', ''],
    ['demand', '국고채 수급', '투자자별 순매수거래대금 (단위: 원본 데이터 단위)'],
    ['explorer', '시리즈 탐색기', '204개 전체 시리즈 중 최대 4개를 골라 비교'],
    ['info', '데이터 정보', '']
  ];
  const sectionBodies = new Map();

  function buildSections() {
    const main = document.getElementById('main');
    const nav = document.getElementById('site-nav');
    for (const [id, title, desc] of SECTIONS) {
      const body = id === 'kpi' ? h('div', { class: 'kpi-grid', id: 'kpi-grid' }) : h('div', { class: 'grid' });
      const sec = h('section', { class: 'section', id: 'sec-' + id, 'aria-labelledby': 'h-' + id },
        h('div', { class: 'section-head' }, h('h2', { id: 'h-' + id, text: title }), desc ? h('p', { text: desc }) : null),
        body);
      main.appendChild(sec);
      sectionBodies.set(id, body);
      nav.appendChild(h('a', { href: '#sec-' + id, text: title }));
    }
  }

  function addPanel(sectionId, { title, subtitle, span = 6, controls = null, note = null, render }) {
    const body = h('div', { class: 'card-body' });
    const card = h('article', { class: `card span-${span}` },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { text: title }), subtitle ? h('p', { class: 'card-sub', text: subtitle }) : null),
        controls ? h('div', { class: 'card-controls' }, controls) : null),
      body,
      note ? h('p', { class: 'card-note', text: note }) : null);
    sectionBodies.get(sectionId).appendChild(card);
    const p = { card, body, render };
    panels.push(p);
    return p;
  }

  async function renderPanel(p) {
    p.body.classList.add('is-loading');
    try {
      await p.render(p.body);
    } catch (e) {
      console.error(e);
      p.body.textContent = '';
      p.body.appendChild(h('p', { class: 'error', text: '렌더링 오류: ' + (e && e.message ? e.message : e) }));
    } finally {
      p.body.classList.remove('is-loading');
    }
  }

  let renderSeq = 0;
  async function renderAll() {
    computeRange();
    updateRangeSummary();
    const seq = ++renderSeq;
    for (const p of panels) {
      if (seq !== renderSeq) return;
      renderPanel(p);
    }
  }

  /* ------------------------------------------------------------------ */
  /* KPI 타일                                                              */
  /* ------------------------------------------------------------------ */
  function kpiTile(id, opts = {}) {
    if (!store.has(id)) return null;
    const meta = store.meta(id);
    const l = store.latestOf(id);
    const tile = h('div', { class: 'kpi', role: 'group', 'aria-label': meta.name });
    tile.appendChild(h('div', { class: 'kpi-label', text: opts.label || meta.name }));
    const row = h('div', { class: 'kpi-row' });
    const valueEl = h('div', { class: 'kpi-value' });
    if (!l) {
      valueEl.textContent = '–';
      row.appendChild(valueEl); tile.appendChild(row);
      return tile;
    }
    valueEl.textContent = fmtValue(l.value, meta);
    const suf = unitSuffix(meta);
    if (suf) valueEl.appendChild(h('span', { class: 'kpi-unit', text: suf }));
    row.appendChild(valueEl);
    const sparkWrap = h('div', { class: 'kpi-spark' });
    C.sparkline(sparkWrap, l.spark || [], { width: 84, height: 26 });
    row.appendChild(sparkWrap);
    tile.appendChild(row);
    if (meta.change_unit !== 'none') {
      const c = changeText(l.chg_1d, meta, l.prev);
      const cls = c.dir > 0 ? 'up' : c.dir < 0 ? 'down' : 'flat';
      tile.appendChild(h('div', { class: 'kpi-delta ' + cls }, (c.dir > 0 ? '▲ ' : c.dir < 0 ? '▼ ' : '') + c.text, h('span', { class: 'ref', text: '전일 대비' })));
      const more = h('div', { class: 'kpi-more' });
      for (const [k, label] of [['chg_1m', '1M'], ['chg_ytd', 'YTD'], ['chg_1y', '1Y']]) {
        const cc = changeText(l[k], meta, null);
        more.appendChild(h('span', {}, label + ' ', h('span', { class: cc.dir > 0 ? 'up' : cc.dir < 0 ? 'down' : '', text: cc.text })));
      }
      tile.appendChild(more);
    } else {
      tile.appendChild(h('div', { class: 'kpi-more' }, h('span', { text: `기준일 ${l.date}` })));
    }
    return tile;
  }

  function buildKpis() {
    const grid = sectionBodies.get('kpi');
    const ids = [['KR_3y', '국고채 3년'], ['KR_10y', '국고채 10년'], ['KR_POLICY', '한국 기준금리'], ['UST2y', '미국 국채 2년'], ['UST10y', '미국 국채 10년'],
      ['FFR', '미국 기준금리 (FFR)'], ['USDKRW', '달러/원 (USDKRW)'], ['Corp_AA_minus_3y', '회사채 AA- 3년'], ['US_HY_SP', '미국 HY OAS'], ['VKOSPI', 'VKOSPI']];
    for (const [id, label] of ids) { const t = kpiTile(id, { label }); if (t) grid.appendChild(t); }
  }

  /* ------------------------------------------------------------------ */
  /* 패널: 수익률 곡선                                                       */
  /* ------------------------------------------------------------------ */
  const CURVE_COUNTRIES = [['KR', '한국', 'KR_KTB'], ['US', '미국', 'US_UST'], ['JP', '일본', 'JP_JGB'], ['AU', '호주', 'AU_AGB'], ['DE', '독일', 'DE_BUND']];
  const SNAPSHOTS = [
    { key: 'now', name: '기준일', color: 1, months: 0 },
    { key: '1w', name: '1주 전', color: 2, days: -7 },
    { key: '1m', name: '1개월 전', color: 3, months: -1 },
    { key: '3m', name: '3개월 전', color: 4, months: -3 },
    { key: '1y', name: '1년 전', color: 5, months: -12 }
  ];
  function snapshotIndex(snap, i1) {
    const base = store.dates[i1];
    if (!snap.months && !snap.days) return i1;
    const target = snap.days ? shiftDays(base, snap.days) : shiftMonths(base, snap.months);
    return store.indexAtOrBefore(target);
  }
  function tenorLabel(meta) {
    const t = meta.tenor || '';
    return t.toUpperCase();
  }

  function buildCurvePanel() {
    const cs = { country: 'KR', snaps: new Set(['now', '1m', '1y']) };
    const countryChips = h('div', { class: 'chip-group', role: 'group', 'aria-label': '국가' });
    const snapChips = h('div', { class: 'chip-group', role: 'group', 'aria-label': '비교 시점' });
    let panel;
    for (const [cc, name] of CURVE_COUNTRIES) {
      const b = h('button', { class: 'chip', type: 'button', text: name, 'aria-pressed': String(cc === cs.country) });
      b.addEventListener('click', () => { cs.country = cc; countryChips.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderPanel(panel); });
      countryChips.appendChild(b);
    }
    for (const sn of SNAPSHOTS) {
      const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(cs.snaps.has(sn.key)) },
        h('span', { class: 'chip-key', style: `background:${C.colorVar(sn.color)}` }), sn.name);
      b.addEventListener('click', () => {
        if (cs.snaps.has(sn.key)) { if (cs.snaps.size > 1) cs.snaps.delete(sn.key); }
        else cs.snaps.add(sn.key);
        b.setAttribute('aria-pressed', String(cs.snaps.has(sn.key)));
        renderPanel(panel);
      });
      snapChips.appendChild(b);
    }
    panel = addPanel('curve', {
      title: '국채 수익률 곡선', subtitle: '만기별 수익률 (%) — 기준일은 기간 필터의 종료일', span: 12,
      controls: [countryChips, snapChips],
      render: async body => {
        const [, cname, group] = CURVE_COUNTRIES.find(c => c[0] === cs.country);
        const metas = store.seriesInGroup(group).filter(m => m.tenor_years != null).sort((a, b) => a.tenor_years - b.tenor_years);
        const values = await store.many(metas.map(m => m.id));
        const tenors = metas.map(m => ({ label: tenorLabel(m), years: m.tenor_years }));
        const curves = [];
        for (const sn of SNAPSHOTS) {
          if (!cs.snaps.has(sn.key)) continue;
          const idx = snapshotIndex(sn, state.i1);
          if (idx < 0) continue;
          const vals = values.map(v => window.DataStore.lastValid(v, idx)[1]);
          curves.push({ id: sn.key, name: `${sn.name} (${store.dates[idx]})`, color: sn.color, values: vals });
        }
        C.curve(body, { tenors, curves, decimals: 2, yFormat: (v, d) => fmt.num(v, d ?? 2), height: 300, filename: `yield_curve_${cs.country}`, ariaLabel: `${cname} 국채 수익률 곡선` });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 패널: 시계열 (공통 헬퍼)                                                 */
  /* ------------------------------------------------------------------ */
  /** defs: [{id | derive:{a,b,kind}, name, color, step, dash}] */
  function tsPanel(sectionId, { title, subtitle, span = 6, defs, unit = 'pct', decimals = 2, zeroLine = false, area = false, height = 280, note = null, filename }) {
    return addPanel(sectionId, {
      title, subtitle, span, note,
      render: async body => {
        const series = [];
        for (const d of defs) {
          if (d.id) {
            if (!store.has(d.id)) continue;
            const meta = store.meta(d.id);
            series.push({ id: d.id, name: d.name || meta.name, color: d.color, step: d.step, dash: d.dash, values: await store.series(d.id) });
          } else if (d.derive) {
            const { a, b, kind } = d.derive;
            if (!store.has(a) || (b && !store.has(b))) continue;
            const va = await store.series(a);
            let vals;
            if (kind === 'spread') vals = spreadBp(va, await store.series(b));
            else if (kind === 'diff') vals = diffOf(va, await store.series(b));
            else if (kind === 'cum') vals = cumulative(va, state.i0, state.i1);
            else if (kind === 'index') vals = indexed(va, state.i0, state.i1);
            else continue;
            series.push({ id: d.key || (a + '_' + kind), name: d.name, color: d.color, step: d.step, dash: d.dash, values: vals });
          }
        }
        C.line(body, { dates: store.dates, i0: state.i0, i1: state.i1, series, decimals, yFormat: yFormatFor(unit, decimals), zeroLine, area, height, filename, ariaLabel: title });
      }
    });
  }

  function buildRatePanels() {
    tsPanel('rates', { title: '한국 국고채 3년 · 10년 · 기준금리', subtitle: '%', filename: 'kr_rates',
      defs: [{ id: 'KR_3y', name: '국고채 3년', color: 1 }, { id: 'KR_10y', name: '국고채 10년', color: 2 }, { id: 'KR_POLICY', name: '기준금리', color: 3, step: true }] });
    tsPanel('rates', { title: '미국 국채 2년 · 10년 · 기준금리', subtitle: '%', filename: 'us_rates',
      defs: [{ id: 'UST2y', name: '미국 국채 2년', color: 1 }, { id: 'UST10y', name: '미국 국채 10년', color: 2 }, { id: 'FFR', name: 'FFR', color: 3, step: true }] });
    tsPanel('rates', { title: '기간 스프레드 · 한미 금리차', subtitle: 'bp', unit: 'bp', decimals: 0, zeroLine: true, filename: 'term_spreads',
      defs: [
        { derive: { a: 'KR_10y', b: 'KR_3y', kind: 'spread' }, key: 'KR_10_3', name: '국고 10년−3년', color: 1 },
        { derive: { a: 'UST10y', b: 'UST2y', kind: 'spread' }, key: 'US_10_2', name: '미국 10년−2년', color: 2 },
        { derive: { a: 'KR_10y', b: 'UST10y', kind: 'spread' }, key: 'KRUS_10', name: '한미 10년 금리차', color: 3 }
      ] });
    tsPanel('rates', { title: '주요국 국채 10년', subtitle: '%', filename: 'g5_10y',
      defs: [{ id: 'KR_10y', name: '한국', color: 1 }, { id: 'UST10y', name: '미국', color: 2 }, { id: 'JPY10y', name: '일본', color: 3 }, { id: 'GER10y', name: '독일', color: 4 }, { id: 'AUD10y', name: '호주', color: 5 }] });
  }

  function buildPolicyPanel() {
    tsPanel('policy', { title: '주요국 정책금리', subtitle: '% (계단형)', span: 12, height: 300, filename: 'policy_rates',
      defs: [{ id: 'KR_POLICY', name: '한국 (BOK)', color: 1, step: true }, { id: 'FFR', name: '미국 (FFR)', color: 2, step: true }, { id: 'ECB_MRO', name: '유로 (ECB MRO)', color: 3, step: true }, { id: 'BOJ_PR', name: '일본 (BOJ)', color: 4, step: true }, { id: 'AUD_PR', name: '호주 (RBA)', color: 5, step: true }] });
  }

  /* ------------------------------------------------------------------ */
  /* 패널: 크레딧                                                            */
  /* ------------------------------------------------------------------ */
  const CREDIT_SECTORS = [['KR_CREDIT_CORP', '회사채'], ['KR_CREDIT_CARD', '여전채'], ['KR_CREDIT_BANK', '은행채'], ['KR_CREDIT_PUBLIC', '공사채'], ['KR_CREDIT_KDB', '특수채']];
  const RATING_ORDER = ['AAA', 'AA+', 'AA0', 'AA-', 'A+', 'A0', 'A-', 'A1', 'A2', 'A3'];

  function buildCreditPanels() {
    tsPanel('credit', { title: '신용 스프레드 (3년물 − 국고채 3년)', subtitle: 'bp', unit: 'bp', decimals: 0, zeroLine: false, filename: 'credit_spreads',
      defs: [
        { derive: { a: 'Corp_AA_minus_3y', b: 'KR_3y', kind: 'spread' }, key: 'sp_corp_aam', name: '회사채 AA-', color: 1 },
        { derive: { a: 'Corp_A_plus_3y', b: 'KR_3y', kind: 'spread' }, key: 'sp_corp_ap', name: '회사채 A+', color: 2 },
        { derive: { a: 'Card_AA_plus_3y', b: 'KR_3y', kind: 'spread' }, key: 'sp_card_aap', name: '여전채 AA+', color: 3 },
        { derive: { a: 'Bank_AAA_3y', b: 'KR_3y', kind: 'spread' }, key: 'sp_bank_aaa', name: '은행채 AAA', color: 4 }
      ] });
    tsPanel('credit', { title: '단기 금리', subtitle: '%', filename: 'short_rates',
      defs: [{ id: 'KR_POLICY', name: '기준금리', color: 1, step: true }, { id: 'KR_3m', name: '국고채 3개월', color: 2 }, { id: 'CD_AAA_3m', name: 'CD 3개월', color: 3 }, { id: 'CP_A1_3m', name: 'CP A1 3개월', color: 4 }] });
    tsPanel('credit', { title: '미국 회사채 OAS 스프레드', subtitle: 'bp · 2019-04 이후', unit: 'bp', decimals: 0, filename: 'us_oas',
      defs: [{ id: 'US_IG_SP', name: '투자등급(IG)', color: 1 }, { id: 'US_HY_SP', name: '하이일드(HY)', color: 2 }] });

    // 크레딧 커브
    const cs = { sector: 'KR_CREDIT_CORP', ratings: null, showKtb: true };
    const sectorSel = h('select', { 'aria-label': '섹터' }, CREDIT_SECTORS.map(([id, name]) => h('option', { value: id, text: name })));
    const ratingChips = h('div', { class: 'chip-group', role: 'group', 'aria-label': '등급 (최대 4개)' });
    const ktbChip = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true' }, h('span', { class: 'chip-key', style: `background:${C.colorVar('gray')}` }), '국고채 참고');
    let panel;
    function ratingsOf(sector) {
      const set = new Set(store.seriesInGroup(sector).map(m => m.rating).filter(Boolean));
      return RATING_ORDER.filter(r => set.has(r));
    }
    function rebuildRatingChips() {
      const avail = ratingsOf(cs.sector);
      if (!cs.ratings || !cs.ratings.some(r => avail.includes(r))) cs.ratings = avail.slice(0, Math.min(3, avail.length));
      cs.ratings = cs.ratings.filter(r => avail.includes(r));
      ratingChips.textContent = '';
      avail.forEach(r => {
        const on = cs.ratings.includes(r);
        const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(on), text: r });
        if (!on && cs.ratings.length >= 4) b.disabled = true;
        b.addEventListener('click', () => {
          if (on) { if (cs.ratings.length > 1) cs.ratings = cs.ratings.filter(x => x !== r); }
          else if (cs.ratings.length < 4) cs.ratings.push(r);
          rebuildRatingChips();
          renderPanel(panel);
        });
        ratingChips.appendChild(b);
      });
    }
    sectorSel.addEventListener('change', () => { cs.sector = sectorSel.value; cs.ratings = null; rebuildRatingChips(); renderPanel(panel); });
    ktbChip.addEventListener('click', () => { cs.showKtb = !cs.showKtb; ktbChip.setAttribute('aria-pressed', String(cs.showKtb)); renderPanel(panel); });
    panel = addPanel('credit', {
      title: '크레딧 커브 (기준일)', subtitle: '등급별 만기 수익률 (%) — 색은 등급 순서에 고정', span: 6,
      controls: [sectorSel, ratingChips, ktbChip],
      render: async body => {
        const metas = store.seriesInGroup(cs.sector).filter(m => m.tenor_years != null && cs.ratings.includes(m.rating));
        const ktbMetas = cs.showKtb ? store.seriesInGroup('KR_KTB').filter(m => m.tenor_years != null) : [];
        const tenorYears = [...new Set(metas.map(m => m.tenor_years))].sort((a, b) => a - b);
        const tenors = tenorYears.map(y => ({ years: y, label: (metas.find(m => m.tenor_years === y) || {}).tenor.toUpperCase() }));
        const all = metas.concat(ktbMetas);
        const values = await store.many(all.map(m => m.id));
        const valueAt = (meta) => { const k = all.indexOf(meta); return k < 0 ? null : window.DataStore.lastValid(values[k], state.i1)[1]; };
        const curves = [];
        const availRatings = ratingsOf(cs.sector);
        for (const r of cs.ratings) {
          const slot = availRatings.indexOf(r) + 1;
          curves.push({ id: r, name: r, color: Math.min(8, Math.max(1, slot)), values: tenorYears.map(y => { const m = metas.find(x => x.rating === r && x.tenor_years === y); return m ? valueAt(m) : null; }) });
        }
        if (cs.showKtb) {
          curves.push({ id: 'KTB', name: '국고채', color: 'gray', dash: true, values: tenorYears.map(y => { const m = ktbMetas.find(x => Math.abs(x.tenor_years - y) < 1e-6); return m ? valueAt(m) : null; }) });
        }
        C.curve(body, { tenors, curves, decimals: 2, height: 300, filename: `credit_curve_${cs.sector}`, ariaLabel: '크레딧 커브' });
      }
    });
    rebuildRatingChips();
  }

  /* ------------------------------------------------------------------ */
  /* 패널: 환율                                                              */
  /* ------------------------------------------------------------------ */
  function buildFxPanels() {
    // 미니 KPI
    const p = addPanel('fx', { title: '주요 환율', subtitle: '최신 거래일 · 전일 대비', span: 12, render: async body => {
      body.textContent = '';
      const grid = h('div', { class: 'kpi-grid is-compact' });
      for (const id of ['USDKRW', 'DXY', 'USDJPY', 'KRWJPY', 'EURKRW', 'USDEUR', 'AUDKRW', 'USDCNY']) { const t = kpiTile(id); if (t) grid.appendChild(t); }
      body.appendChild(grid);
    } });
    p.card.classList.add('card-kpis');
    tsPanel('fx', { title: '달러/원 환율', subtitle: 'USDKRW (중간값)', unit: 'price', decimals: 2, area: true, filename: 'usdkrw',
      defs: [{ id: 'USDKRW', name: '달러/원', color: 1 }] });
    tsPanel('fx', { title: '주요 환율 지수화 (기간 시작 = 100)', subtitle: '서로 다른 단위를 한 축에서 비교', unit: 'index', decimals: 1, filename: 'fx_indexed',
      defs: [
        { derive: { a: 'USDKRW', kind: 'index' }, key: 'ix_usdkrw', name: '달러/원', color: 1 },
        { derive: { a: 'DXY', kind: 'index' }, key: 'ix_dxy', name: '달러인덱스', color: 2 },
        { derive: { a: 'USDJPY', kind: 'index' }, key: 'ix_usdjpy', name: '달러/엔', color: 3 },
        { derive: { a: 'EURKRW', kind: 'index' }, key: 'ix_eurkrw', name: '유로/원', color: 4 }
      ] });
    tsPanel('fx', { title: 'USD/KRW 스왑레이트 (SMB)', subtitle: '%', filename: 'smb',
      defs: [{ id: 'SMB_USDKRW_1M', name: '1개월', color: 1 }, { id: 'SMB_USDKRW_3M', name: '3개월', color: 2 }, { id: 'SMB_USDKRW_6M', name: '6개월', color: 3 }], zeroLine: true });
    // 헤지 프리미엄: 통화 선택
    const hs = { ccy: 'USDKRW' };
    const ccySel = h('select', { 'aria-label': '통화' }, [['USDKRW', '달러(USD)'], ['JPYKRW', '엔(JPY)'], ['EURKRW', '유로(EUR)'], ['AUDKRW', '호주달러(AUD)']].map(([v, t]) => h('option', { value: v, text: t })));
    let panel;
    ccySel.addEventListener('change', () => { hs.ccy = ccySel.value; renderPanel(panel); });
    panel = addPanel('fx', { title: '환헤지 프리미엄', subtitle: '% · 2024-10 이후 제공', controls: [ccySel],
      render: async body => {
        const defs = ['3M', '6M', '12M'].map((t, k) => ({ id: `${hs.ccy}_HP_${t}`, name: t, color: k + 1 }));
        const series = [];
        for (const d of defs) if (store.has(d.id)) series.push({ ...d, values: await store.series(d.id) });
        C.line(body, { dates: store.dates, i0: state.i0, i1: state.i1, series, decimals: 2, zeroLine: true, yFormat: yFormatFor('pct', 2), filename: `hedge_premium_${hs.ccy}`, ariaLabel: '환헤지 프리미엄', emptyText: '선택한 기간에 데이터가 없습니다 (2024-10-14 이후 제공)' });
      } });
  }

  function buildBeiPanels() {
    tsPanel('bei', { title: '주요국 BEI 10년', subtitle: '%', span: 7, filename: 'bei_10y',
      defs: [{ id: 'KTB_BEI10y', name: '한국', color: 1 }, { id: 'UST_BEI10y', name: '미국', color: 2 }, { id: 'JGB_BEI10y', name: '일본', color: 3 }, { id: 'GER_BEI10y', name: '독일', color: 4 }, { id: 'AUD_BEI10y', name: '호주', color: 5 }] });
    tsPanel('bei', { title: '실질금리 (국채 10년 − BEI 10년)', subtitle: '%', span: 5, zeroLine: true, filename: 'real_yield_10y',
      defs: [
        { derive: { a: 'KR_10y', b: 'KTB_BEI10y', kind: 'diff' }, key: 'real_kr', name: '한국', color: 1 },
        { derive: { a: 'UST10y', b: 'UST_BEI10y', kind: 'diff' }, key: 'real_us', name: '미국', color: 2 }
      ] });
  }

  function buildVolPanels() {
    tsPanel('vol', { title: 'VKOSPI · VIX', subtitle: '변동성지수 (pt)', span: 12, unit: 'index', decimals: 1, height: 260, filename: 'volatility',
      defs: [{ id: 'VKOSPI', name: 'VKOSPI', color: 1 }, { id: 'VIX', name: 'VIX', color: 2 }] });
  }

  /* ------------------------------------------------------------------ */
  /* 패널: 수급                                                              */
  /* ------------------------------------------------------------------ */
  const INVESTORS = [['KTB_NETBUY_FOREIGN', '외국인'], ['KTB_NETBUY_FUND', '기금'], ['KTB_NETBUY_INSURANCE', '보험'], ['KTB_NETBUY_INVTRUST', '투신'], ['KTB_NETBUY_INDIVIDUAL', '개인'], ['KTB_NETBUY_GOVT', '정부'], ['KTB_NETBUY_TOTAL', '전체']];
  function buildDemandPanels() {
    addPanel('demand', { title: '기간 내 투자자별 순매수 합계', subtitle: '선택 기간의 일별 순매수거래대금 합', span: 5,
      note: '값 단위는 원본 데이터(순매수거래대금)를 그대로 따르며 억/조 표기는 원본 단위 기준입니다.',
      render: async body => {
        const items = [];
        for (const [id, label] of INVESTORS) {
          if (!store.has(id)) continue;
          const v = sumRange(await store.series(id), state.i0, state.i1);
          if (v != null) items.push({ label, value: v });
        }
        C.bars(body, { items, format: v => fmt.compact(v), filename: 'ktb_netbuy_sum', ariaLabel: '투자자별 순매수 합계' });
      } });
    tsPanel('demand', { title: '누적 순매수 추이 (기간 시작 = 0)', subtitle: '외국인 · 기금 · 보험 · 투신', span: 7, unit: 'krw', zeroLine: true, filename: 'ktb_netbuy_cum',
      defs: [
        { derive: { a: 'KTB_NETBUY_FOREIGN', kind: 'cum' }, key: 'cum_f', name: '외국인', color: 1 },
        { derive: { a: 'KTB_NETBUY_FUND', kind: 'cum' }, key: 'cum_fd', name: '기금', color: 2 },
        { derive: { a: 'KTB_NETBUY_INSURANCE', kind: 'cum' }, key: 'cum_i', name: '보험', color: 3 },
        { derive: { a: 'KTB_NETBUY_INVTRUST', kind: 'cum' }, key: 'cum_t', name: '투신', color: 4 }
      ] });
  }

  /* ------------------------------------------------------------------ */
  /* 패널: 탐색기                                                            */
  /* ------------------------------------------------------------------ */
  function buildExplorer() {
    const es = { group: 'KR_KTB', selected: ['KR_3y', 'KR_10y'], colors: new Map([['KR_3y', 1], ['KR_10y', 2]]), nextColor: 3, indexMode: 'auto' };
    const groupSel = h('select', { 'aria-label': '그룹' }, store.manifest.groups.slice().sort((a, b) => a.order - b.order).map(g => h('option', { value: g.id, text: g.name })));
    const modeSel = h('select', { 'aria-label': '표시 방식' }, [['auto', '자동 (단위가 다르면 지수화)'], ['raw', '원값'], ['index', '기간 시작 = 100']].map(([v, t]) => h('option', { value: v, text: t })));
    const picker = h('div', { class: 'series-picker', role: 'group', 'aria-label': '시리즈 선택 (최대 4개)' });
    let panel;
    function assignColor(id) {
      if (es.colors.has(id)) return es.colors.get(id);
      const used = new Set(es.selected.map(x => es.colors.get(x)));
      let c = 1; while (used.has(c) && c < 8) c++;
      es.colors.set(id, c);
      return c;
    }
    function rebuildPicker() {
      picker.textContent = '';
      for (const m of store.seriesInGroup(es.group)) {
        const on = es.selected.includes(m.id);
        const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(on), title: `${m.notation} · ${m.field}` },
          on ? h('span', { class: 'chip-key', style: `background:${C.colorVar(es.colors.get(m.id))}` }) : null, m.name);
        if (!on && es.selected.length >= 4) b.disabled = true;
        b.addEventListener('click', () => {
          if (on) { es.selected = es.selected.filter(x => x !== m.id); es.colors.delete(m.id); }
          else if (es.selected.length < 4) { es.selected.push(m.id); assignColor(m.id); }
          rebuildPicker();
          renderPanel(panel);
        });
        picker.appendChild(b);
      }
    }
    groupSel.addEventListener('change', () => { es.group = groupSel.value; rebuildPicker(); });
    modeSel.addEventListener('change', () => { es.indexMode = modeSel.value; renderPanel(panel); });
    panel = addPanel('explorer', { title: '시리즈 비교', subtitle: '그룹을 고른 뒤 시리즈를 선택하세요 (다른 그룹의 시리즈와 함께 비교 가능)', span: 12,
      controls: [groupSel, modeSel],
      render: async body => {
        const metas = es.selected.map(id => store.meta(id));
        const units = new Set(metas.map(m => m.unit));
        const useIndex = es.indexMode === 'index' || (es.indexMode === 'auto' && units.size > 1);
        const series = [];
        for (const m of metas) {
          const raw = await store.series(m.id);
          series.push({ id: m.id, name: m.name + (useIndex ? '' : ` (${m.unit_label || m.unit})`), color: es.colors.get(m.id), values: useIndex ? indexed(raw, state.i0, state.i1) : raw, step: m.group === 'POLICY' });
        }
        const unit = useIndex ? 'index' : (units.size === 1 ? [...units][0] : 'price');
        const dec = useIndex ? 1 : Math.max(...metas.map(m => m.decimals ?? 2), 0);
        body.textContent = '';
        const chartEl = h('div');
        body.appendChild(chartEl);
        if (!series.length) { chartEl.appendChild(h('div', { class: 'chart-empty', text: '시리즈를 선택하세요' })); return; }
        C.line(chartEl, { dates: store.dates, i0: state.i0, i1: state.i1, series, decimals: dec, yFormat: yFormatFor(unit, dec), zeroLine: unit === 'krw', height: 320, filename: 'explorer', ariaLabel: '시리즈 비교' });
        if (useIndex && es.indexMode === 'auto') body.appendChild(h('p', { class: 'card-note', text: '단위가 서로 다른 시리즈가 섞여 있어 기간 시작일 = 100 으로 지수화해 표시합니다.' }));
      } });
    panel.card.querySelector('.card-head').after(picker);
    rebuildPicker();
  }

  /* ------------------------------------------------------------------ */
  /* 패널: 데이터 정보                                                        */
  /* ------------------------------------------------------------------ */
  function buildInfo() {
    addPanel('info', { title: '데이터 출처 · 빌드 정보', span: 6, render: async body => {
      const m = store.manifest;
      body.textContent = '';
      const dl = h('dl', { class: 'info-list' });
      const add = (k, v) => { dl.appendChild(h('dt', { text: k })); dl.appendChild(typeof v === 'string' ? h('dd', { text: v }) : h('dd', {}, v)); };
      add('원본 파일', `${m.source.file} / 시트 ${m.source.sheet}`);
      add('원본 수정 시각', m.source.modified || '–');
      add('산출물 생성 시각(UTC)', m.generated_at);
      add('데이터 기간', `${m.dates.first} ~ ${m.dates.last} (거래일 ${m.dates.count.toLocaleString('ko-KR')}일)`);
      add('시리즈 수', `${m.series.length}개 / 그룹 ${m.groups.length}개`);
      add('영업일 옵션', m.source.business_day_rule || '–');
      add('SHA-256', h('span', { class: 'mono', text: m.source.sha256 || '–' }));
      add('데이터 소스 URL', h('span', { class: 'mono', text: store.base }));
      add('저장소', [h('a', { href: cfg.dataRepoUrl || '#', text: 'Data (원본·변환)' }), ' · ', h('a', { href: cfg.dashboardRepoUrl || '#', text: 'Test (대시보드)' })]);
      body.appendChild(dl);
    } });
    addPanel('info', { title: '정제 내역 (quality_report.json)', subtitle: '원본 대비 결측 처리된 셀', span: 6, render: async body => {
      body.textContent = '';
      let q;
      try {
        const res = await fetch(store.base + (store.manifest.files?.quality_report || 'quality_report.json'), { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        q = await res.json();
      } catch (e) {
        body.appendChild(h('p', { class: 'card-note', text: '정제 내역을 불러오지 못했습니다: ' + e.message }));
        return;
      }
      const rows = [];
      for (const z of q.zero_runs || []) rows.push([store.has(z.series) ? store.meta(z.series).name : z.series, '0값 구간', `${z.from} ~ ${z.to}`, `${z.count.toLocaleString('ko-KR')}셀`]);
      for (const o of q.outliers || []) rows.push([store.has(o.series) ? store.meta(o.series).name : o.series, '이상치', o.date, `${o.value} (주변 중앙값 ${o.neighbor_median})`]);
      for (const d of q.duplicate_series || []) rows.push([d.series.map(id => store.has(id) ? store.meta(id).name : id).join(' = '), '중복(값 동일)', '전 구간', '원본 열이 동일 — 값은 그대로 둠']);
      body.appendChild(h('p', { class: 'card-note', text: `0값 구간 ${(q.zero_runs || []).length}건 (${(q.summary?.zero_run_cells || 0).toLocaleString('ko-KR')}셀) · 이상치 ${(q.outliers || []).length}건 · 중복 시리즈 ${(q.duplicate_series || []).length}건 — 그 외 값은 원본과 동일` }));
      body.appendChild(h('div', { class: 'chart-table' }, h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {}, ['시리즈', '규칙', '기간/일자', '내용'].map(t => h('th', { text: t })))),
        h('tbody', {}, rows.map(r => h('tr', {}, r.map(c => h('td', { text: c }))))))));
    } });
  }

  /* ------------------------------------------------------------------ */
  /* 초기화                                                                 */
  /* ------------------------------------------------------------------ */
  function showError(err) {
    const st = document.getElementById('status');
    st.classList.add('is-error');
    st.textContent = '';
    st.appendChild(h('h2', { text: '데이터를 불러올 수 없습니다' }));
    st.appendChild(h('p', {}, '이 페이지는 Data 저장소의 ', h('code', { text: 'output/' }), ' 산출물만 읽어 옵니다. 다음 중 하나를 확인하세요.'));
    st.appendChild(h('ul', {},
      h('li', {}, 'GitHub Pages 배포: Test 저장소 Secrets 에 ', h('code', { text: 'DATA_REPO_TOKEN' }), ' 을 등록하고 "Deploy dashboard to GitHub Pages" 워크플로를 실행하면 ', h('code', { text: 'data/' }), ' 에 산출물이 복사됩니다.'),
      h('li', {}, '로컬 확인: Data 저장소의 ', h('code', { text: 'output/' }), ' 폴더를 이 저장소의 ', h('code', { text: 'data/' }), ' 로 복사한 뒤 정적 서버로 여세요 (예: ', h('code', { text: 'npx serve .' }), ').'),
      h('li', {}, 'URL 파라미터 ', h('code', { text: '?data=<산출물 base URL>' }), ' 로 소스를 직접 지정할 수도 있습니다.')));
    st.appendChild(h('pre', { text: (err.details || [err.message]).join('\n') }));
    document.getElementById('asof').textContent = '데이터 없음';
  }

  async function main() {
    initTheme();
    document.getElementById('link-data').href = cfg.dataRepoUrl || '#';
    document.getElementById('link-dash').href = cfg.dashboardRepoUrl || '#';
    store = new window.DataStore(cfg.dataSources || ['./data/']);
    try {
      await store.init();
    } catch (e) {
      console.error(e);
      showError(e);
      return;
    }
    document.getElementById('status').remove();
    const m = store.manifest;
    document.getElementById('asof').textContent = `기준일 ${m.dates.last} · 시리즈 ${m.series.length}개 · 산출물 생성 ${m.generated_at.replace('T', ' ').replace('Z', ' UTC')}`;
    document.getElementById('foot-build').textContent = `데이터 기준일 ${m.dates.last}`;
    document.title = `금리·환율·크레딧 대시보드 — ${m.dates.last}`;

    buildFilterBar();
    buildSections();
    buildKpis();
    buildCurvePanel();
    buildRatePanels();
    buildPolicyPanel();
    buildCreditPanels();
    buildFxPanels();
    buildBeiPanels();
    buildVolPanels();
    buildDemandPanels();
    buildExplorer();
    buildInfo();
    await renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})();
