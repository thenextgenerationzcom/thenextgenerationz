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
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxyPbRd6t4u9GRV0UEAmHYKAM4ygTGIs_9qAtHQZHak9jux80dsVCsu5z6iUF80a3EkxA/exec';

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
// botName()은 걸린 이름을 사람이 읽을 수 있게 돌려준다 (없으면 '').
const BOT_SIG = [
  // [UA에 들어 있는 글자, 표시 이름]
  ['googlebot', '구글 검색봇'], ['google-inspectiontool', '구글 검사도구'], ['adsbot-google', '구글 광고봇'],
  ['mediapartners-google', '구글 광고봇'], ['google-read-aloud', '구글 읽기봇'], ['storebot-google', '구글 쇼핑봇'],
  ['yeti', '네이버 검색봇'], ['daumoa', '다음 검색봇'], ['bingbot', '빙 검색봇'], ['applebot', '애플 검색봇'],
  ['yandex', '얀덱스봇'], ['baiduspider', '바이두봇'], ['duckduckbot', '덕덕고봇'],
  ['facebookexternalhit', '메타 미리보기'], ['facebot', '메타 미리보기'], ['facebookcatalog', '메타 미리보기'],
  ['meta-externalagent', '메타 수집기'], ['meta-externalfetcher', '메타 수집기'],
  ['kakaotalk-scrap', '카카오 미리보기'], ['twitterbot', 'X 미리보기'], ['linkedinbot', '링크드인 미리보기'],
  ['slackbot', '슬랙 미리보기'], ['discordbot', '디스코드 미리보기'], ['telegrambot', '텔레그램 미리보기'],
  ['whatsapp', '왓츠앱 미리보기'], ['pinterest', '핀터레스트봇'], ['redditbot', '레딧봇'], ['embedly', '임베드 수집기'],
  ['quora link', '쿼라 미리보기'], ['gptbot', 'OpenAI 수집봇'], ['oai-searchbot', 'OpenAI 검색봇'], ['chatgpt-user', 'ChatGPT 열람'],
  ['claudebot', 'Anthropic 수집봇'], ['claude-user', 'Claude 열람'], ['perplexity', 'Perplexity봇'], ['ccbot', 'CommonCrawl봇'],
  ['ahrefs', 'SEO 분석봇(Ahrefs)'], ['semrush', 'SEO 분석봇(Semrush)'], ['mj12bot', 'SEO 분석봇(Majestic)'],
  ['dotbot', 'SEO 분석봇(Moz)'], ['petalbot', '화웨이 검색봇'], ['bytespider', '바이트댄스봇'],
  ['headlesschrome', '자동화 크롬(헤드리스)'], ['phantomjs', '자동화 브라우저'], ['lighthouse', '구글 속도 측정'],
  ['chrome-lighthouse', '구글 속도 측정'], ['gtmetrix', '속도 측정'], ['pingdom', '가동 감시'], ['uptimerobot', '가동 감시'],
  ['statuscake', '가동 감시'], ['monitoring', '가동 감시'], ['vercel', 'Vercel 점검'],
  ['python-requests', '스크립트(Python)'], ['axios', '스크립트(axios)'], ['go-http-client', '스크립트(Go)'],
  ['curl', '스크립트(curl)'], ['wget', '스크립트(wget)'], ['okhttp', '스크립트(okhttp)'], ['java/', '스크립트(Java)'],
  ['libwww', '스크립트(Perl)'], ['httpclient', '스크립트'], ['scrapy', '수집기(Scrapy)'], ['preview', '링크 미리보기'],
  ['slurp', '야후봇'],
  // 'naver'·'daum'은 넣지 않음: 네이버앱·다음앱 안에서 링크를 연 실제 사람까지 봇으로 걸러졌음
  ['spider', '기타 수집봇'], ['crawl', '기타 수집봇'], ['bot', '기타 봇'],
];
function botName(ua) {
  if (!ua) return 'UA 없음';
  const s = ua.toLowerCase();
  for (const [k, name] of BOT_SIG) if (s.includes(k)) return name;
  return '';
}
function isBot(ua) { return !!botName(ua); }

// 데이터센터 도시: 사람이 거의 살지 않고 서버만 있는 곳(메타·구글·아마존·MS 등).
// 여기서 오는 접속은 링크 미리보기 수집기나 보안 검사기로 보고 사람 통계에서 뺀다.
const DC_CITIES = [
  'prineville', 'forest city', 'altoona', 'los lunas', 'papillion', 'sandston',
  'new albany', 'eagle mountain', 'gallatin', 'stanton springs', 'clonee', 'lulea', 'luleå',
  'the dalles', 'council bluffs', 'moncks corner', 'pryor', 'lenoir', 'boardman',
  'quincy', 'boydton', 'ashburn',
];
function isDcCity(country, city) {
  let c = '';
  try { c = decodeURIComponent(city || ''); } catch (e) { c = city || ''; }
  c = c.toLowerCase().trim();
  if (!c || (country || '').toUpperCase() === 'KR') return false;
  return DC_CITIES.indexOf(c) >= 0;
}

// ── 유입경로 분류 ──
// 결과는 '큰 분류·세부' 형태. 관리자 화면은 '·' 앞을 큰 분류로 묶어서도 보여 준다.
//   직접 보낸 링크 : 우리가 링크 끝에 꼬리표(utm)를 붙여 보낸 것 (이메일·문자·인스타 공유 등)
//   검색          : 구글·네이버·다음 등 검색 결과에서 들어옴
//   SNS·메신저    : 페이스북·인스타·카카오톡 등. 앱 안에서 열려 주소 정보가 없을 때는 '(앱)'으로 표시
//   이메일        : 지메일·네이버메일 등 웹메일에서 꼬리표 없이 들어옴
//   블로그·카페   : 네이버 블로그·카페, 티스토리, 브런치 등
//   다른 사이트    : 그 밖의 웹사이트 링크
//   경로 정보 없음 : 주소를 직접 입력·즐겨찾기·문서/PDF 링크·일부 앱 등. 브라우저가 출처를 알려 주지 않은 경우
const UTM_NAMES = [
  [/^email/, '이메일 발송'], [/^sms|^mms|^text/, '문자'], [/^kakao|^kt/, '카카오톡 공유'],
  [/^igs|^ig|^insta/, '인스타그램 공유'], [/^fb|^facebook/, '페이스북 공유'], [/^th|^threads/, '스레드 공유'],
  [/^x$|^tw/, 'X 공유'], [/^band/, '밴드 공유'], [/^qr/, 'QR 코드'], [/^card|^namecard/, '명함'],
];
function utmLabel(u) {
  const v = String(u).toLowerCase().slice(0, 30);
  for (const [re, name] of UTM_NAMES) if (re.test(v)) return '직접 보낸 링크·' + name + (name.indexOf(v) < 0 ? ' (' + v + ')' : '');
  return '직접 보낸 링크·' + v;
}
// 앱 안 브라우저 판별 (주소 정보가 비어 있을 때 어디서 열었는지 추정)
const INAPP = [
  [/KAKAOTALK/i, 'SNS/메신저·카카오톡'], [/NAVER\(inapp|NAVER\//i, '검색·네이버앱'], [/DaumApps|DaumDevice/i, '검색·다음앱'],
  [/Instagram/i, 'SNS/메신저·인스타그램'], [/FBAN|FBAV|FB_IAB|FB4A/i, 'SNS/메신저·페이스북'], [/Barcelona/i, 'SNS/메신저·스레드'],
  [/\bLine\//i, 'SNS/메신저·라인'], [/BAND\//i, 'SNS/메신저·밴드'], [/everytimeApp/i, 'SNS/메신저·에브리타임'],
  [/GSA\//i, '검색·구글앱'],
];
function inAppName(ua) {
  for (const [re, name] of INAPP) if (re.test(ua || '')) return name;
  return '';
}
const APP_PKG = {
  'com.google.android.gm': '이메일·지메일앱', 'com.google.android.googlequicksearchbox': '검색·구글앱',
  'com.nhn.android.search': '검색·네이버앱', 'com.nhn.android.mail': '이메일·네이버메일앱', 'net.daum.android.daum': '검색·다음앱',
  'com.kakao.talk': 'SNS/메신저·카카오톡', 'com.facebook.katana': 'SNS/메신저·페이스북', 'com.instagram.android': 'SNS/메신저·인스타그램',
  'org.telegram.messenger': 'SNS/메신저·텔레그램', 'com.linkedin.android': 'SNS/메신저·링크드인', 'com.slack': 'SNS/메신저·슬랙',
};
function hostIs(h, list) { return list.some((d) => h === d || h.endsWith('.' + d)); }
function classifySource(ref, utm, host, ua) {
  if (utm) return utmLabel(utm);
  let h = '', proto = '';
  if (ref) {
    try { const u = new URL(ref); h = u.host.toLowerCase().replace(/^www\./, ''); proto = u.protocol; } catch (e) { h = ''; }
  }
  if (!h) {
    const app = inAppName(ua);
    return app ? (/앱$/.test(app) ? app : app + ' (앱 안에서 열림)') : '경로 정보 없음·주소 입력·즐겨찾기 등';
  }
  if (proto === 'android-app:') return APP_PKG[h] || ('앱·' + h);
  const self = (host || '').replace(/^www\./, '');
  if (h === self || h.endsWith('thenextgenerationz.com')) return '사이트 내부';

  // 웹메일 (검색보다 먼저: mail.google.com, mail.naver.com 이 검색으로 잘못 잡히던 문제)
  if (h === 'mail.google.com') return '이메일·지메일';
  if (h === 'mail.naver.com' || h === 'm.mail.naver.com') return '이메일·네이버메일';
  if (hostIs(h, ['mail.daum.net'])) return '이메일·다음메일';
  if (hostIs(h, ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com'])) return '이메일·아웃룩';
  if (/^mail\./.test(h) || /^webmail\./.test(h)) return '이메일·' + h;

  // 블로그·카페 (네이버 검색과 구분)
  if (hostIs(h, ['blog.naver.com'])) return '블로그/카페·네이버 블로그';
  if (hostIs(h, ['cafe.naver.com'])) return '블로그/카페·네이버 카페';
  if (hostIs(h, ['cafe.daum.net'])) return '블로그/카페·다음 카페';
  if (hostIs(h, ['tistory.com'])) return '블로그/카페·티스토리';
  if (hostIs(h, ['brunch.co.kr'])) return '블로그/카페·브런치';
  if (hostIs(h, ['medium.com', 'substack.com'])) return '블로그/카페·' + h;

  // 검색
  if (/(^|\.)google\.[a-z.]+$/.test(h)) return '검색·구글';
  if (hostIs(h, ['search.naver.com', 'm.search.naver.com'])) return '검색·네이버';
  if (hostIs(h, ['search.daum.net', 'm.search.daum.net'])) return '검색·다음';
  if (hostIs(h, ['bing.com'])) return '검색·빙';
  if (hostIs(h, ['duckduckgo.com'])) return '검색·덕덕고';
  if (hostIs(h, ['search.yahoo.com', 'yahoo.com', 'yahoo.co.jp'])) return '검색·야후';
  if (hostIs(h, ['search.zum.com', 'zum.com'])) return '검색·줌';
  if (hostIs(h, ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com'])) return '검색·AI(' + h + ')';
  if (hostIs(h, ['naver.com'])) return '검색·네이버(' + h + ')';
  if (hostIs(h, ['daum.net'])) return '검색·다음(' + h + ')';

  // SNS·메신저 (정확한 주소로 비교: 예전엔 't.co'가 microsoft.com 등에도 걸렸음)
  const sns = [
    [['facebook.com', 'fb.com', 'fb.me'], '페이스북'], [['instagram.com'], '인스타그램'],
    [['threads.net', 'threads.com'], '스레드'], [['t.co', 'x.com', 'twitter.com'], 'X'],
    [['linkedin.com', 'lnkd.in'], '링크드인'], [['youtube.com', 'youtu.be'], '유튜브'],
    [['kakao.com', 'kakaocorp.com', 'kakaocdn.net', 'kakao.co.kr'], '카카오'], [['band.us'], '밴드'],
    [['telegram.org', 't.me'], '텔레그램'], [['slack.com'], '슬랙'],
  ];
  for (const [list, name] of sns) if (hostIs(h, list)) return 'SNS/메신저·' + name;

  return '다른 사이트·' + h;
}

// 브라우저·기기 짧은 이름 (전체 UA는 저장하지 않음)
function browserShort(ua) {
  ua = ua || '';
  const os = /iPhone/.test(ua) ? '아이폰' : /iPad/.test(ua) ? '아이패드' : /Android/.test(ua) ? '안드로이드'
    : /Windows/.test(ua) ? '윈도우' : /Macintosh|Mac OS X/.test(ua) ? '맥' : /Linux/.test(ua) ? '리눅스' : '기타';
  const br = /SamsungBrowser/.test(ua) ? '삼성인터넷' : /Whale/.test(ua) ? '웨일' : /Edg\//.test(ua) ? '엣지'
    : /CriOS|Chrome\//.test(ua) ? '크롬' : /FxiOS|Firefox\//.test(ua) ? '파이어폭스' : /Safari\//.test(ua) ? '사파리' : '';
  const app = inAppName(ua);
  return os + (br ? ' ' + br : '') + (app ? ' · ' + app.split('·').pop().replace(/앱$/, '') + ' 앱 안' : '');
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

  // 메일 열람 확인용 1픽셀: /img/m/{추적코드}.gif → /api/track?mo={추적코드}
  // 코드별 첫 열람 시각·열람 횟수·마지막 기기만 남긴다 (IP는 저장하지 않음)
  if (req.method === 'GET' && req.query && req.query.mo) {
    const k = String(req.query.mo).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    if (k && RURL && RTOK) {
      try {
        const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        const ua = String(req.headers['user-agent'] || '').slice(0, 160);
        await pipeline([['HSETNX', 'mo:first', k, now], ['HINCRBY', 'mo:cnt', k, 1], ['HSET', 'mo:ua', k, ua]]);
      } catch (e) {}
    }
    // 발송 명단 구글 시트의 「첫 열람」·「열람 수」 칸에도 적는다 (메일 클릭과 같은 Apps Script 웹 앱)
    if (k) {
      try {
        await fetch(GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ k: k, to: 'open', ua: String(req.headers['user-agent'] || '').slice(0, 160) }).toString(),
          redirect: 'manual',
          signal: AbortSignal.timeout(6000),
        });
      } catch (e) {}
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.status(200).send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }

  if (req.method !== 'POST') return res.status(405).end();

  const ua = req.headers['user-agent'] || '';
  const country = req.headers['x-vercel-ip-country'] || '';
  const city = req.headers['x-vercel-ip-city'] || '';
  const region = req.headers['x-vercel-ip-country-region'] || '';

  // 진단 모드: Vercel이 넣는 지오 헤더를 그대로 돌려준다 (집계는 안 함)
  if (req.query.debug === '1') {
    return res.status(200).json({
      ua, country, city: (function(){ try { return decodeURIComponent(city); } catch(e){ return city; } })(),
      region, bot: botName(ua) || false, inapp: inAppName(ua) || '', browser: browserShort(ua),
    });
  }

  if (!RURL || !RTOK) return res.status(200).json({ ok: false });

  try {
    const ev = parseBody(await readBody(req));
    const date = kstDate();

    // ── 이벤트 유형 분기 ──
    // ev.t === 'menu' : 메뉴/내부 링크 클릭, ev.t === 'out' : 외부 링크 이동, ev.t === 'cv' : 전환
    const evType = (ev.t || 'pv').toString();

    // 봇 판별: ① User-Agent ② 자동화 브라우저 신호 ③ 데이터센터 도시
    let botReason = '';
    const bn = botName(ua);
    if (bn) botReason = '크롤러·' + bn;
    else if (ev.bw === '1') botReason = '자동화 브라우저';
    else if (isDcCity(country, city)) botReason = '데이터센터·' + (regionLabel(country, city, region).split('·')[1] || '');

    // 봇은 별도 카운터에만 기록하고 사람 통계에는 넣지 않는다 (페이지뷰만 센다)
    if (botReason) {
      const cmds = [];
      if (evType === 'pv') {
        const t = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16);
        const rec = JSON.stringify({ t, why: botReason, p: (ev.p || '/').toString().slice(0, 120), rg: regionLabel(country, city, region) });
        cmds.push(['INCR', 'a:bot:' + date]);
        cmds.push(['HINCRBY', 'a:h:' + date, 'bot:' + botReason, 1]);
        cmds.push(['LPUSH', 'a:botlog:' + date, rec]);
        cmds.push(['LTRIM', 'a:botlog:' + date, 0, 149]);
        cmds.push(['EXPIRE', 'a:bot:' + date, 60 * 86400]);
        cmds.push(['EXPIRE', 'a:h:' + date, 60 * 86400]);
        cmds.push(['EXPIRE', 'a:botlog:' + date, 60 * 86400]);
      }
      if (cmds.length) await pipeline(cmds);
      return res.status(200).json({ ok: true, bot: true });
    }

    // 전환 (신청 버튼·작성 시작·제출·예약 완료 등) — 방문당 1회만 들어온다
    if (evType === 'cv') {
      const label = (ev.label || '').toString().slice(0, 40);
      if (label) {
        const cmds = [['HINCRBY', 'a:h:' + date, 'cv:' + label, 1]];
        // 실제 신청이 일어난 건은 어디서 왔는지 함께 남긴다
        if (/제출|예약 완료|구독/.test(label)) {
          const src = classifySource(ev.r || '', ev.u || '', 'thenextgenerationz.com', ua);
          const short = label.replace(' 신청서 제출', ' 신청').replace('일정 예약 완료', '예약').replace(' 제출', '');
          cmds.push(['HINCRBY', 'a:h:' + date, 'cvsrc:' + short + ' ← ' + src, 1]);
        }
        cmds.push(['EXPIRE', 'a:h:' + date, 60 * 86400]);
        await pipeline(cmds);
      }
      return res.status(200).json({ ok: true });
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

    // 방문 흐름: 세션 번호(브라우저 탭을 닫으면 사라지는 임의 값)별로 본 페이지를 순서대로 이어 붙인다
    const sid = String(ev.s || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
    if (sid) {
      cmds.push(['APPEND', 'a:sj:' + sid, (ev.en === '1' ? '' : ' › ') + path]);
      cmds.push(['EXPIRE', 'a:sj:' + sid, 3 * 86400]);
    }

    if (ev.en === '1') {
      const src = classifySource(ev.r || '', ev.u || '', 'thenextgenerationz.com', ua);
      if (src !== '사이트 내부') {
        cmds.push(['HINCRBY', 'a:h:' + date, 'src:' + src, 1]);
        cmds.push(['HINCRBY', 'a:h:' + date, 'enter:' + path, 1]);
        // 방문 기록 (첫 진입 1건): 시각·진입 페이지·유입·지역·기기·언어·시간대. IP·전체 UA는 남기지 않는다.
        let refHost = '';
        try { refHost = ev.r ? new URL(ev.r).host.replace(/^www\./, '') : ''; } catch (e) {}
        const rec = {
          t: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16),
          s: sid, p: path, src, ref: refHost.slice(0, 60), rg: regionLabel(country, city, region),
          dev, br: browserShort(ua),
          lang: String(ev.l || '').slice(0, 12), tz: String(ev.z || '').slice(0, 40),
        };
        cmds.push(['LPUSH', 'a:log:' + date, JSON.stringify(rec)]);
        cmds.push(['LTRIM', 'a:log:' + date, 0, 299]);
        cmds.push(['EXPIRE', 'a:log:' + date, 60 * 86400]);
      }
    }

    await pipeline(cmds);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({ ok: false });
  }
}
