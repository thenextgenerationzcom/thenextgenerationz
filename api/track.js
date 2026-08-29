// api/track.js — TNG 접속 통계 수집 (프라이버시-세이프)
// 개인정보·원본 IP는 저장하지 않는다. 익명 해시와 집계 숫자만.
//
// 환경변수:
//   KV_REST_API_URL / KV_REST_API_TOKEN — Upstash Redis
//   ANALYTICS_SALT                      — 익명 해시용 소금값

import { createHash } from 'crypto';

const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SALT = process.env.ANALYTICS_SALT || 'tng-default-salt';

async function pipeline(cmds) {
  const r = await fetch(RURL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  return r.json();
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
function kstDate() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function kstHour() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 13);
}

// 유입경로 분류
function classifySource(ref, utm, host) {
  if (utm) return 'UTM·' + utm;
  if (!ref) return '직접 유입';
  let h;
  try { h = new URL(ref).host.replace(/^www\./, ''); } catch (e) { return '직접 유입'; }
  const self = (host || '').replace(/^www\./, '');
  if (h === self || h.endsWith('thenextgenerationz.com')) return '사이트 내부';

  const search = [
    ['google.', '구글'], ['naver.', '네이버'], ['daum.', '다음'],
    ['bing.', '빙'], ['duckduckgo.', 'DuckDuckGo'], ['yahoo.', '야후'],
  ];
  for (const [k, name] of search) if (h.includes(k)) return '검색·' + name;

  const sns = [
    ['facebook.', '페이스북'], ['instagram.', '인스타그램'], ['linkedin.', '링크드인'],
    ['youtube.', '유튜브'], ['youtu.be', '유튜브'], ['t.co', 'X'], ['twitter.', 'X'],
    ['x.com', 'X'], ['threads.', '스레드'], ['kakao', '카카오'], ['band.us', '밴드'],
  ];
  for (const [k, name] of sns) if (h.includes(k)) return 'SNS·' + name;

  return '추천·' + h;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  if (!RURL || !RTOK) return res.status(200).json({ ok: false }); // 조용히 무시

  try {
    const ev = parseBody(await readBody(req));
    const date = kstDate();

    // 익명 방문자 해시 (원본 IP는 저장 안 함, UV 중복제거용)
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    const visitorHash = createHash('sha256').update(ip + '|' + ua + '|' + date + '|' + SALT).digest('hex').slice(0, 24);

    const country = req.headers['x-vercel-ip-country'] || '';
    const path = (ev.p || '/').toString().slice(0, 200);
    const dev = ev.d === 'm' ? 'mobile' : 'desktop';
    const hour = kstHour();

    const cmds = [];
    // 페이지뷰 + 순방문
    cmds.push(['INCR', 'a:pv:' + date]);
    cmds.push(['PFADD', 'a:uv:' + date, visitorHash]);
    // 차원별 집계
    cmds.push(['HINCRBY', 'a:h:' + date, 'path:' + path, 1]);
    cmds.push(['HINCRBY', 'a:h:' + date, 'hr:' + hour, 1]);
    cmds.push(['HINCRBY', 'a:h:' + date, 'dev:' + dev, 1]);
    if (country) cmds.push(['HINCRBY', 'a:h:' + date, 'rg:' + country, 1]);
    // 30일 뒤 자동 만료
    cmds.push(['EXPIRE', 'a:pv:' + date, 60 * 86400]);
    cmds.push(['EXPIRE', 'a:uv:' + date, 60 * 86400]);
    cmds.push(['EXPIRE', 'a:h:' + date, 60 * 86400]);

    // 유입경로는 "세션 첫 진입"일 때만 (내부 이동 오염 방지)
    if (ev.en === '1') {
      const src = classifySource(ev.r || '', ev.u || '', 'thenextgenerationz.com');
      if (src !== '사이트 내부') {
        cmds.push(['HINCRBY', 'a:h:' + date, 'src:' + src, 1]);
        cmds.push(['HINCRBY', 'a:h:' + date, 'enter:' + path, 1]);
      }
    }

    await pipeline(cmds);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({ ok: false }); // 통계 실패가 사용자 경험을 막지 않게
  }
}
