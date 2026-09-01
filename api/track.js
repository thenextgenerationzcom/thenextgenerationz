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

// 봇 판별: User-Agent 기반. 알려진 크롤러/스캐너/헤드리스는 사람 통계에서 제외.
function isBot(ua) {
  if (!ua) return true; // UA 없는 요청은 봇으로 간주
  const s = ua.toLowerCase();
  const sig = [
    'bot', 'spider', 'crawl', 'slurp', 'crawler', 'facebookexternalhit', 'facebot',
    'embedly', 'quora link', 'pinterest', 'redditbot', 'telegrambot', 'whatsapp',
    'slackbot', 'discordbot', 'linkedinbot', 'twitterbot', 'applebot', 'googlebot',
    'bingbot', 'yandex', 'baiduspider', 'duckduckbot', 'yeti', 'daum', 'naver',
    'ahrefs', 'semrush', 'mj12bot', 'dotbot', 'petalbot', 'bytespider',
    'headlesschrome', 'phantomjs', 'python-requests', 'axios', 'go-http-client',
    'curl', 'wget', 'okhttp', 'java/', 'libwww', 'httpclient', 'scrapy',
    'vercel', 'uptimerobot', 'pingdom', 'statuscake', 'gtmetrix', 'lighthouse',
    'chrome-lighthouse', 'google-inspectiontool', 'monitoring', 'preview',
  ];
  for (const k of sig) if (s.includes(k)) return true;
  return false;
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

// 지역 라벨: 국가 + 도시. 국가는 한국/미국 등 친숙한 이름으로.
function regionLabel(country, city, region) {
  const cc = (country || '').toUpperCase();
  const names = { KR: '한국', US: '미국', JP: '일본', CN: '중국', GB: '영국',
    DE: '독일', FR: '프랑스', CA: '캐나다', IN: '인도', SG: '싱가포르',
    IE: '아일랜드', NL: '네덜란드', HK: '홍콩', TW: '대만', AU: '호주' };
  const cName = names[cc] || cc || '알수없음';
  let cty = '';
  try { cty = decodeURIComponent(city || ''); } catch (e) { cty = city || ''; }
  if (cty) return cName + '·' + cty;
  return cName;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const ua = req.headers['user-agent'] || '';
  const country = req.headers['x-vercel-ip-country'] || '';
  const city = req.headers['x-vercel-ip-city'] || '';
  const region = req.headers['x-vercel-ip-country-region'] || '';

  // 진단 모드: Vercel이 넣는 지오 헤더를 그대로 돌려준다 (집계는 안 함)
  if (req.query.debug === '1') {
    return res.status(200).json({
      ua, country, city: (function(){ try { return decodeURIComponent(city); } catch(e){ return city; } })(),
      region, bot: isBot(ua),
    });
  }

  if (!RURL || !RTOK) return res.status(200).json({ ok: false });

  try {
    const ev = parseBody(await readBody(req));
    const date = kstDate();
    const bot = isBot(ua);

    // ── 이벤트 유형 분기 ──
    // ev.t === 'menu' : 메뉴/내부 링크 클릭, ev.t === 'out' : 외부 링크 이동
    const evType = (ev.t || 'pv').toString();

    // 봇은 별도 카운터에만 기록하고 사람 통계에는 넣지 않는다
    if (bot) {
      await pipeline([
        ['INCR', 'a:bot:' + date],
        ['EXPIRE', 'a:bot:' + date, 60 * 86400],
      ]);
      return res.status(200).json({ ok: true, bot: true });
    }

    // 클릭 이벤트 (메뉴/외부) — pv 증가 없이 해당 차원만 기록
    if (evType === 'menu' || evType === 'out') {
      const label = (ev.label || '').toString().slice(0, 120);
      if (label) {
        const dim = evType === 'menu' ? 'menu:' : 'out:';
        await pipeline([
          ['HINCRBY', 'a:h:' + date, dim + label, 1],
          ['EXPIRE', 'a:h:' + date, 60 * 86400],
        ]);
      }
      return res.status(200).json({ ok: true });
    }

    // ── 일반 페이지뷰 ──
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress || '';
    const visitorHash = createHash('sha256').update(ip + '|' + ua + '|' + date + '|' + SALT).digest('hex').slice(0, 24);

    const path = (ev.p || '/').toString().slice(0, 200);
    const dev = ev.d === 'm' ? 'mobile' : 'desktop';
    const hour = kstHour();
    const lang = /^\/ko(\/|$)/.test(path) ? '한국어판' : '영문판';

    const cmds = [];
    cmds.push(['INCR', 'a:pv:' + date]);
    cmds.push(['PFADD', 'a:uv:' + date, visitorHash]);
    cmds.push(['HINCRBY', 'a:h:' + date, 'path:' + path, 1]);
    cmds.push(['HINCRBY', 'a:h:' + date, 'lang:' + lang, 1]);
    cmds.push(['HINCRBY', 'a:h:' + date, 'hr:' + hour, 1]);
    cmds.push(['HINCRBY', 'a:h:' + date, 'dev:' + dev, 1]);
    if (country) cmds.push(['HINCRBY', 'a:h:' + date, 'rg:' + regionLabel(country, city, region), 1]);
    cmds.push(['EXPIRE', 'a:pv:' + date, 60 * 86400]);
    cmds.push(['EXPIRE', 'a:uv:' + date, 60 * 86400]);
    cmds.push(['EXPIRE', 'a:h:' + date, 60 * 86400]);

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
    return res.status(200).json({ ok: false });
  }
}
