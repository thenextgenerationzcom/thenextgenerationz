// api/admin.js — TNG 관리자 API (글 관리 + 이미지 + 통계)
// 하나의 함수에서 action 쿼리로 분기하는 라우터 패턴.
//
// 필요한 환경변수 (Vercel > Settings > Environment Variables):
//   KV_REST_API_URL / KV_REST_API_TOKEN  — Upstash Redis (Storage 연결 시 자동)
//   ADMIN_KEY                            — 관리자 인증 키
//
// 공개 action:  list, get, img
// 관리자 action: all, save, remove, uploadimg, overview, inbox, inboxmark, sched, schedsave  (ADMIN_KEY 필요)

const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// ---------- Redis 헬퍼 ----------
async function redis(cmd) {
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json(); // { result: ... }
}
async function pipeline(cmds) {
  const r = await fetch(RURL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  return r.json(); // [{result},...]
}
function readBody(req) {
  return new Promise(function (res) {
    if (req.body != null) { res(req.body); return; }
    var d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => res(d));
    req.on('error', () => res(''));
  });
}
function parseBody(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

// ---------- 글 저장/로드 ----------
const POSTS_KEY = 'tng_posts';
async function loadPosts() {
  const r = await redis(['GET', POSTS_KEY]);
  if (!r || r.result == null) return [];
  try { return JSON.parse(r.result) || []; } catch (e) { return []; }
}
async function savePosts(arr) {
  await redis(['SET', POSTS_KEY, JSON.stringify(arr)]);
}

function clean(s, max) {
  s = String(s == null ? '' : s);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); // 제어문자 제거
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}
function publicView(p) {
  return {
    id: p.id, lang: p.lang, title: p.title, body: p.body,
    publishAt: p.publishAt, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

// ---------- 통계 조회 헬퍼 ----------
// track.js의 DC_CITIES와 같은 목록. 봇 필터 도입 전 기록된 지역 줄에 '봇 추정'을 붙이는 데 쓴다.
const DC_CITIES = [
  'prineville', 'forest city', 'altoona', 'los lunas', 'papillion', 'sandston',
  'new albany', 'eagle mountain', 'gallatin', 'stanton springs', 'clonee', 'lulea', 'luleå',
  'the dalles', 'council bluffs', 'moncks corner', 'pryor', 'lenoir', 'boardman',
  'quincy', 'boydton', 'ashburn',
];
// 기간 합계를 보여줄 전환 라벨
const CV_TOTALS = ['워크숍 신청서 제출', '일정 예약 완료'];
function kstDate(offsetDays) {
  const now = new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000);
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (KST 기준)
}
// 유입경로 이름 정리: 예전 기록('UTM·email', '직접 유입', '추천·…', 'SNS·…')을 새 이름으로 맞춘다 (api/track.js 와 같은 규칙)
const UTM_NAMES = [
  [/^email/, '이메일 발송'], [/^sms|^mms|^text/, '문자'], [/^kakao|^kt/, '카카오톡 공유'],
  [/^igs|^ig|^insta/, '인스타그램 공유'], [/^fb|^facebook/, '페이스북 공유'], [/^th|^threads/, '스레드 공유'],
  [/^x$|^tw/, 'X 공유'], [/^band/, '밴드 공유'], [/^qr/, 'QR 코드'], [/^card|^namecard/, '명함'],
];
function niceSrc(k) {
  k = String(k || '');
  if (k.indexOf('UTM·') === 0) {
    const v = k.slice(4).toLowerCase();
    for (const [re, name] of UTM_NAMES) if (re.test(v)) return '직접 보낸 링크·' + name + (name.indexOf(v) < 0 ? ' (' + v + ')' : '');
    return '직접 보낸 링크·' + v;
  }
  if (k === '직접 유입') return '경로 정보 없음·주소 입력·즐겨찾기 등';
  if (k.indexOf('추천·') === 0) return '다른 사이트·' + k.slice(3);
  if (k.indexOf('SNS·') === 0 && k.indexOf('SNS/메신저') !== 0) return 'SNS/메신저·' + k.slice(4);
  if (k === '검색·DuckDuckGo') return '검색·덕덕고';
  return k;
}
function groupDims(hash) {
  // { 'src:검색·구글': '12', 'rg:KR': '30', ... } → { src:{...}, rg:{...}, ... }
  const out = {};
  if (!hash) return out;
  const keys = Object.keys(hash);
  for (const k of keys) {
    const i = k.indexOf(':');
    if (i < 0) continue;
    const dim = k.slice(0, i);
    const name = k.slice(i + 1);
    (out[dim] = out[dim] || {})[name] = Number(hash[k]) || 0;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!RURL || !RTOK) {
    return res.status(500).json({ error: 'Redis not configured' });
  }

  const action = (req.query.action || '').toString();
  const key = req.query.key || req.headers['x-admin-key'] || '';
  const isAdmin = ADMIN_KEY && key === ADMIN_KEY;

  try {
    // ===== 공개: 이미지 서빙 =====
    if (action === 'img') {
      const id = (req.query.id || '').toString().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return res.status(400).end('bad id');
      const r = await redis(['GET', 'tng_img:' + id]);
      if (!r || r.result == null) return res.status(404).end('not found');
      let obj;
      try { obj = JSON.parse(r.result); } catch (e) { return res.status(500).end('corrupt'); }
      const buf = Buffer.from(obj.d, 'base64');
      res.setHeader('Content-Type', obj.m || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(buf);
    }

    // ===== 공개: 발행된 글 목록 =====
    if (action === 'list') {
      const lang = (req.query.lang || '').toString();
      const now = Date.now();
      let posts = await loadPosts();
      posts = posts
        .filter((p) => p.status === 'published' && p.publishAt <= now)
        .filter((p) => (lang ? p.lang === lang : true))
        .sort((a, b) => b.publishAt - a.publishAt)
        .map(publicView);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ posts });
    }

    // ===== 공개: 발행된 글 1개 =====
    if (action === 'get') {
      const id = (req.query.id || '').toString();
      const now = Date.now();
      const posts = await loadPosts();
      const p = posts.find((x) => x.id === id && x.status === 'published' && x.publishAt <= now);
      if (!p) return res.status(404).json({ error: 'not found' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ post: publicView(p) });
    }

    // ===== 여기부터 관리자 전용 =====
    if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });

    // 관리자 키 확인 (Apps Script 일정 관리가 이 키로 관리자인지 물어봄)
    if (action === 'whoami') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true });
    }

    // 관리자: 메일 열람 기록 (api/track.js의 1픽셀)
    if (action === 'opens') {
      const rs = await pipeline([['HGETALL', 'mo:first'], ['HGETALL', 'mo:cnt'], ['HGETALL', 'mo:ua']]);
      const obj = (x) => {
        const v = x && x.result; const o = {};
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i += 2) o[v[i]] = v[i + 1]; } else if (v && typeof v === 'object') Object.assign(o, v);
        return o;
      };
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, first: obj(rs[0]), cnt: obj(rs[1]), ua: obj(rs[2]) });
    }

    // 관리자: 홈페이지로 들어온 신청·문의 (api/contact.js가 보관)
    if (action === 'inbox') {
      const r = await redis(['GET', 'tng_inbox']);
      let list = [];
      try { list = JSON.parse((r && r.result) || '[]') || []; } catch (e) { list = []; }
      const kind = (req.query.kind || '').toString();
      if (kind) list = list.filter((x) => x.kind === kind);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, items: list });
    }

    // 관리자: 메일 등으로 따로 받은 신청을 신청함에 직접 넣기
    if (action === 'inboxadd') {
      const body = parseBody(await readBody(req));
      const org = clean(body.org, 120), name = clean(body.name, 60);
      if (!org || !name) return res.status(400).json({ error: 'need' });
      const r = await redis(['GET', 'tng_inbox']);
      let list = [];
      try { list = JSON.parse((r && r.result) || '[]') || []; } catch (e) { list = []; }
      const at = Number(body.at) || Date.now();
      const item = {
        id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at, kind: ['session', 'publishing', 'contact'].indexOf(body.kind) >= 0 ? body.kind : 'session',
        type: clean(body.type || '한 장의 목차 — 신청·문의', 120), org, name,
        email: clean(body.email, 120), phone: clean(body.phone, 40), term: clean(body.term, 60),
        message: clean(body.message, 5000), status: 'new', source: clean(body.source || '수동 입력', 40),
      };
      list.unshift(item);
      list.sort((x, y) => (y.at || 0) - (x.at || 0));
      await redis(['SET', 'tng_inbox', JSON.stringify(list.slice(0, 500))]);
      return res.status(200).json({ ok: true, item });
    }

    // 관리자: 신청 처리 표시 (added = 신청자 명단에 등록, hidden = 숨김, new = 되돌리기)
    if (action === 'inboxmark') {
      const body = parseBody(await readBody(req));
      const id = clean(body.id, 40);
      const status = ['added', 'hidden', 'new'].indexOf(body.status) >= 0 ? body.status : '';
      if (!id || !status) return res.status(400).json({ error: 'bad request' });
      const r = await redis(['GET', 'tng_inbox']);
      let list = [];
      try { list = JSON.parse((r && r.result) || '[]') || []; } catch (e) { list = []; }
      const it = list.find((x) => x.id === id);
      if (!it) return res.status(404).json({ error: 'not found' });
      it.status = status;
      it.markedAt = Date.now();
      if (body.code != null) it.code = clean(body.code, 40);
      if (body.link != null) it.link = clean(body.link, 300);
      await redis(['SET', 'tng_inbox', JSON.stringify(list)]);
      return res.status(200).json({ ok: true, item: it });
    }

    // 관리자: 내 일정 (일정 관리 화면의 '내 일정')
    if (action === 'sched') {
      const r = await redis(['GET', 'tng_sched']);
      let list = [];
      try { list = JSON.parse((r && r.result) || '[]') || []; } catch (e) { list = []; }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, items: list });
    }
    // 관리자: 내 일정 저장 (items 배열을 id 기준으로 추가·수정) / 삭제 (remove: [id...])
    if (action === 'schedsave') {
      const body = parseBody(await readBody(req));
      const r = await redis(['GET', 'tng_sched']);
      let list = [];
      try { list = JSON.parse((r && r.result) || '[]') || []; } catch (e) { list = []; }
      const rm = Array.isArray(body.remove) ? body.remove.map(String) : [];
      if (rm.length) list = list.filter((x) => rm.indexOf(x.id) < 0);
      const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
      for (const it of items) {
        const date = clean(it.date, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const tm = (v) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : '');
        const rec = {
          id: clean(it.id, 40) || ('s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
          date, start: tm(it.start), end: tm(it.end),
          title: clean(it.title, 120), place: clean(it.place, 120), memo: clean(it.memo, 500),
          block: ['none', 'slots', 'day'].indexOf(it.block) >= 0 ? it.block : 'none',
          blocked: Array.isArray(it.blocked) ? it.blocked.map((x) => clean(x, 5)).slice(0, 10) : [],
          series: clean(it.series, 40),
          updatedAt: Date.now(),
        };
        const i = list.findIndex((x) => x.id === rec.id);
        if (i >= 0) list[i] = rec; else list.push(rec);
      }
      list.sort((x, y) => (x.date + (x.start || '')).localeCompare(y.date + (y.start || '')));
      if (list.length > 2000) list = list.slice(list.length - 2000);
      await redis(['SET', 'tng_sched', JSON.stringify(list)]);
      return res.status(200).json({ ok: true, items: list });
    }

    // 관리자: 전체 글 (상태 포함)
    if (action === 'all') {
      const posts = (await loadPosts()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ posts });
    }

    // 관리자: 글 저장 (신규/수정)
    if (action === 'save') {
      const body = parseBody(await readBody(req));
      const now = Date.now();
      const posts = await loadPosts();

      const title = clean(body.title, 300);
      const content = clean(body.body, 60000);
      const lang = body.lang === 'en' ? 'en' : 'ko';
      const status = body.status === 'hidden' ? 'hidden' : 'published';
      let publishAt = Number(body.publishAt);
      if (!publishAt || isNaN(publishAt)) publishAt = now;

      if (!title && !content) return res.status(400).json({ error: 'empty' });

      if (body.id) {
        const idx = posts.findIndex((p) => p.id === body.id);
        if (idx < 0) return res.status(404).json({ error: 'not found' });
        posts[idx] = { ...posts[idx], title, body: content, lang, status, publishAt, updatedAt: now };
        await savePosts(posts);
        return res.status(200).json({ ok: true, post: posts[idx] });
      } else {
        const id = 'p' + now.toString(36) + Math.random().toString(36).slice(2, 6);
        const post = { id, lang, title, body: content, status, publishAt, createdAt: now, updatedAt: now };
        posts.push(post);
        await savePosts(posts);
        return res.status(200).json({ ok: true, post });
      }
    }

    // 관리자: 글 삭제
    if (action === 'remove') {
      const body = parseBody(await readBody(req));
      const id = (body.id || req.query.id || '').toString();
      let posts = await loadPosts();
      const before = posts.length;
      posts = posts.filter((p) => p.id !== id);
      if (posts.length === before) return res.status(404).json({ error: 'not found' });
      await savePosts(posts);
      return res.status(200).json({ ok: true });
    }

    // 관리자: 이미지 업로드 (base64 JSON)
    if (action === 'uploadimg') {
      const body = parseBody(await readBody(req));
      const data = (body.data || '').toString(); // "data:image/jpeg;base64,...." 또는 순수 base64
      let mime = 'image/jpeg';
      let b64 = data;
      const m = data.match(/^data:([^;]+);base64,(.*)$/);
      if (m) { mime = m[1]; b64 = m[2]; }
      if (!b64 || b64.length < 10) return res.status(400).json({ error: 'no image' });
      if (b64.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'too large' }); // ~3MB
      const id = 'img' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await redis(['SET', 'tng_img:' + id, JSON.stringify({ m: mime, d: b64 })]);
      const url = '/api/admin?action=img&id=' + id;
      return res.status(200).json({ ok: true, url });
    }

    // 관리자: 통계 개요
    if (action === 'overview') {
      const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
      const dates = [];
      for (let i = days - 1; i >= 0; i--) dates.push(kstDate(-i));

      // 상세를 볼 날짜 (기본: 오늘). 최근 days 범위 안에 있어야 함.
      const todayStr = dates[dates.length - 1];
      let detailDate = (req.query.date || '').toString();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(detailDate) || dates.indexOf(detailDate) < 0) {
        detailDate = todayStr;
      }

      const cmds = [];
      for (const d of dates) {
        cmds.push(['GET', 'a:pv:' + d]);
        cmds.push(['PFCOUNT', 'a:uv:' + d]);
      }
      for (const d of dates) {
        cmds.push(['HMGET', 'a:h:' + d].concat(CV_TOTALS.map((l) => 'cv:' + l)));
      }
      const iHash = cmds.length;
      cmds.push(['HGETALL', 'a:h:' + detailDate]);
      cmds.push(['GET', 'a:bot:' + detailDate]);
      cmds.push(['LRANGE', 'a:log:' + detailDate, 0, 299]);
      cmds.push(['LRANGE', 'a:botlog:' + detailDate, 0, 149]);

      const results = await pipeline(cmds);
      const cvTotals = {};
      CV_TOTALS.forEach((l) => (cvTotals[l] = 0));
      for (let i = 0; i < dates.length; i++) {
        const row = (results[dates.length * 2 + i] || {}).result || [];
        CV_TOTALS.forEach((l, j) => (cvTotals[l] += Number(row[j]) || 0));
      }
      const trend = [];
      for (let i = 0; i < dates.length; i++) {
        trend.push({
          date: dates[i],
          pv: Number((results[i * 2] || {}).result) || 0,
          uv: Number((results[i * 2 + 1] || {}).result) || 0,
        });
      }
      let rawHash = (results[iHash] || {}).result;
      const botCount = Number((results[iHash + 1] || {}).result) || 0;
      const parseList = (r) => ((r || {}).result || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      const visits = parseList(results[iHash + 2]);
      const botLog = parseList(results[iHash + 3]);
      // 방문별 이동 경로 (세션 번호로 묶인 페이지 목록)
      const sids = [...new Set(visits.map((v) => v.s).filter(Boolean))];
      if (sids.length) {
        try {
          const jr = await pipeline([['MGET'].concat(sids.map((x) => 'a:sj:' + x))]);
          const arr = (jr[0] || {}).result || [];
          const map = {};
          sids.forEach((x, i) => { if (arr[i]) map[x] = arr[i]; });
          visits.forEach((v) => { if (v.s && map[v.s]) v.j = map[v.s]; });
        } catch (e) {}
      }
      visits.forEach((v) => { v.src = niceSrc(v.src); });
      let hashObj = {};
      if (Array.isArray(rawHash)) {
        for (let i = 0; i < rawHash.length; i += 2) hashObj[rawHash[i]] = rawHash[i + 1];
      } else if (rawHash && typeof rawHash === 'object') {
        hashObj = rawHash;
      }
      const dims = groupDims(hashObj);
      if (dims.src) delete dims.src['사이트 내부']; // 과거 오염분 제외
      // 예전 이름을 새 분류 이름으로 바꾸고, 큰 분류(srcg)를 다시 계산한다
      if (dims.src) {
        const ns = {}, g = {};
        for (const k of Object.keys(dims.src)) {
          const n = niceSrc(k);
          ns[n] = (ns[n] || 0) + dims.src[k];
          const gk = n.split('·')[0];
          g[gk] = (g[gk] || 0) + dims.src[k];
        }
        dims.src = ns; dims.srcg = g;
      }
            if (dims.cvsrc) {
        const nc = {};
        for (const k of Object.keys(dims.cvsrc)) {
          const parts = k.split(' ← ');
          const n = parts.length === 2 ? parts[0] + ' ← ' + niceSrc(parts[1]) : k;
          nc[n] = (nc[n] || 0) + dims.cvsrc[k];
        }
        dims.cvsrc = nc;
      }
      if (dims.bot && dims.bot['크롤러(UA)'] != null) {
        dims.bot['크롤러(이름 기록 전)'] = dims.bot['크롤러(UA)'];
        delete dims.bot['크롤러(UA)'];
      }
      // 봇 필터 도입 전 기록된 데이터센터 도시는 표시만 구분한다 (PV·UV 수치는 되돌릴 수 없음)
      if (dims.rg) {
        const rg = {};
        for (const k of Object.keys(dims.rg)) {
          const city = (k.split('·')[1] || '').toLowerCase().trim();
          rg[DC_CITIES.indexOf(city) >= 0 ? k + '·봇' : k] = dims.rg[k];
        }
        dims.rg = rg;
      }

      // 선택일의 PV/UV
      const sel = trend.find((t) => t.date === detailDate) || { pv: 0, uv: 0 };

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ trend, detailDate, dims, selPv: sel.pv, selUv: sel.uv, botCount, dates, cvTotals, days, visits, botLog });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('admin error:', err);
    return res.status(500).json({ error: 'server error' });
  }
}
