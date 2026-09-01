// api/admin.js — TNG 관리자 API (글 관리 + 이미지 + 통계)
// 하나의 함수에서 action 쿼리로 분기하는 라우터 패턴.
//
// 필요한 환경변수 (Vercel > Settings > Environment Variables):
//   KV_REST_API_URL / KV_REST_API_TOKEN  — Upstash Redis (Storage 연결 시 자동)
//   ADMIN_KEY                            — 관리자 인증 키
//
// 공개 action:  list, get, img
// 관리자 action: all, save, remove, uploadimg, overview  (ADMIN_KEY 필요)

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
function kstDate(offsetDays) {
  const now = new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000);
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (KST 기준)
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
      cmds.push(['HGETALL', 'a:h:' + detailDate]);
      cmds.push(['GET', 'a:bot:' + detailDate]);

      const results = await pipeline(cmds);
      const trend = [];
      for (let i = 0; i < dates.length; i++) {
        trend.push({
          date: dates[i],
          pv: Number((results[i * 2] || {}).result) || 0,
          uv: Number((results[i * 2 + 1] || {}).result) || 0,
        });
      }
      // 마지막 두 결과가 HGETALL, GET(bot)
      let rawHash = (results[results.length - 2] || {}).result;
      const botCount = Number((results[results.length - 1] || {}).result) || 0;
      let hashObj = {};
      if (Array.isArray(rawHash)) {
        for (let i = 0; i < rawHash.length; i += 2) hashObj[rawHash[i]] = rawHash[i + 1];
      } else if (rawHash && typeof rawHash === 'object') {
        hashObj = rawHash;
      }
      const dims = groupDims(hashObj);
      if (dims.src) delete dims.src['사이트 내부']; // 과거 오염분 제외

      // 선택일의 PV/UV
      const sel = trend.find((t) => t.date === detailDate) || { pv: 0, uv: 0 };

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ trend, detailDate, dims, selPv: sel.pv, selUv: sel.uv, botCount, dates });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('admin error:', err);
    return res.status(500).json({ error: 'server error' });
  }
}
