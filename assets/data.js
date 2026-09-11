/* data.js — Data 저장소 output/ 산출물 로더 (manifest / dates / latest / series) */
(function (global) {
  'use strict';

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }

  class DataStore {
    constructor(sources) {
      this.sources = sources.slice();
      this.base = null;
      this.manifest = null;
      this.dates = null;
      this.latest = null;
      this.byId = new Map();
      this.groups = new Map();
      this.cache = new Map();
      this.errors = [];
    }

    async init() {
      const q = new URLSearchParams(global.location.search).get('data');
      const candidates = q ? [q.endsWith('/') ? q : q + '/'] : this.sources;
      for (const base of candidates) {
        try {
          const m = await fetchJson(base + 'manifest.json');
          if (!m || !Array.isArray(m.series)) throw new Error('manifest 형식 오류');
          this.base = base;
          this.manifest = m;
          break;
        } catch (e) {
          this.errors.push(`${base} → ${e.message}`);
        }
      }
      if (!this.base) {
        const err = new Error('데이터 소스를 찾을 수 없습니다');
        err.details = this.errors;
        throw err;
      }
      const [dates, latest] = await Promise.all([
        fetchJson(this.base + (this.manifest.dates?.file || 'dates.json')),
        fetchJson(this.base + (this.manifest.files?.latest || 'latest.json'))
      ]);
      this.dates = dates;
      this.latest = latest;
      this.dateIndex = new Map(dates.map((d, i) => [d, i]));
      for (const s of this.manifest.series) this.byId.set(s.id, s);
      for (const g of this.manifest.groups) this.groups.set(g.id, g);
      return this;
    }

    meta(id) {
      const m = this.byId.get(id);
      if (!m) throw new Error(`알 수 없는 시리즈: ${id}`);
      return m;
    }

    has(id) { return this.byId.has(id); }

    latestOf(id) { return (this.latest && this.latest.series && this.latest.series[id]) || null; }

    seriesInGroup(groupId) {
      return this.manifest.series.filter(s => s.group === groupId);
    }

    /** 시리즈 값 배열 (dates 와 인덱스 정렬). 캐시됨. */
    async series(id) {
      if (this.cache.has(id)) return this.cache.get(id);
      const meta = this.meta(id);
      const p = fetchJson(this.base + meta.file).then(j => {
        if (!Array.isArray(j.values) || j.values.length !== this.dates.length) {
          throw new Error(`시리즈 길이 불일치: ${id}`);
        }
        return j.values;
      });
      this.cache.set(id, p);
      try {
        return await p;
      } catch (e) {
        this.cache.delete(id);
        throw e;
      }
    }

    async many(ids) {
      return Promise.all(ids.map(id => this.series(id)));
    }

    /** dateStr(YYYY-MM-DD) 이하인 마지막 거래일 인덱스 (없으면 -1) */
    indexAtOrBefore(dateStr) {
      const d = this.dates;
      let lo = 0, hi = d.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (d[mid] <= dateStr) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans;
    }

    /** dateStr 이상인 첫 거래일 인덱스 (없으면 dates.length) */
    indexAtOrAfter(dateStr) {
      const d = this.dates;
      let lo = 0, hi = d.length - 1, ans = d.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (d[mid] >= dateStr) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
      }
      return ans;
    }

    /** idx 이하에서 가장 최근 유효값 [index, value] (최대 lookback 슬롯) */
    static lastValid(values, idx, lookback = 15) {
      for (let i = idx, n = 0; i >= 0 && n <= lookback; i--, n++) {
        if (values[i] != null) return [i, values[i]];
      }
      return [-1, null];
    }
  }

  global.DataStore = DataStore;
})(window);
