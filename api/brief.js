// api/brief.js — 「글」(브리핑) 페이지를 서버에서 완성된 HTML로 내보냅니다.
// 검색엔진(특히 네이버)이 글 내용을 그대로 읽을 수 있게 하려는 것입니다.
//
//   /ko/briefings            → mode=list   글 목록
//   /ko/briefings/:slug      → mode=post   글 하나 (slug = 글 주소, 없으면 글 id)
//   /sitemap.xml             → mode=sitemap  고정 페이지 + 발행된 글
//
// 글 데이터는 관리자 API(api/admin.js)와 같은 Redis 키(tng_posts)를 읽기만 합니다.

import { CSS, NAV, FOOT, TAIL } from './_lib/shell.js';

const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE = 'https://www.thenextgenerationz.com';
const OG_DEFAULT = SITE + '/img/og-image.jpg';

// 고정 페이지 (사이트맵). 페이지를 새로 만들면 여기에 추가합니다.
const STATIC = [
  ['/', '2026-10-27', 'weekly', '1.0'],
  ['/ko', '2026-11-02', 'weekly', '1.0'],
  ['/ko/about', '2026-11-04', 'monthly', '0.7'],
  ['/ko/session', '2026-10-29', 'weekly', '0.9'],
  ['/ko/record', '2026-11-02', 'weekly', '0.9'],
  ['/ko/poli-code', '2026-11-05', 'monthly', '0.8'],
  ['/ko/poli-codes', '2026-11-05', 'monthly', '0.7'],
  ['/ko/publishing', '2026-10-29', 'monthly', '0.8'],
];

async function loadPosts() {
  if (!RURL || !RTOK) return [];
  try {
    const r = await fetch(RURL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', 'tng_posts']),
    }).then((x) => x.json());
    if (!r || r.result == null) return [];
    return JSON.parse(r.result) || [];
  } catch (e) {
    return [];
  }
}
function livePosts(all, lang) {
  const now = Date.now();
  return all
    .filter((p) => p.status === 'published' && p.publishAt <= now && (p.lang || 'ko') === lang)
    .sort((a, b) => b.publishAt - a.publishAt);
}
const keyOf = (p) => p.slug || p.id;
const urlOf = (p) => '/ko/briefings/' + encodeURIComponent(keyOf(p));

// ---------- 글자 다루기 ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function imgUrl(u) {
  u = String(u || '').trim();
  const m = u.match(/action=img&(?:amp;)?id=([A-Za-z0-9_-]+)/);
  if (m) return '/media/' + m[1];
  return u;
}
function absUrl(u) {
  u = imgUrl(u);
  return /^https?:\/\//.test(u) ? u : SITE + (u.startsWith('/') ? '' : '/') + u;
}
function ytId(s) {
  const m = s.match(/(?:youtu\.be\/|watch\?v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : '';
}
// 문장 안: **굵게**, [글자](주소), 맨 주소
function inline(text) {
  let t = esc(text);
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_, a, u) => {
    const ext = /^https?:/.test(u) && !u.includes('thenextgenerationz.com');
    return '<a href="' + u + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + a + '</a>';
  });
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, pre, u) => pre + '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
  return t;
}
function video(id) {
  return '<div class="video"><iframe src="https://www.youtube.com/embed/' + id + '" title="YouTube 영상" allowfullscreen loading="lazy"></iframe></div>';
}
// 본문 표기 (관리자 화면 안내와 같음)
//   빈 줄 = 문단 / ## 소제목 / ### 작은 제목 / - 목록 / 1. 번호 목록 / > 인용
//   [강조 문구] / [img:주소] 또는 [img:주소|사진 설명] / [video:유튜브ID] / 유튜브 링크 단독 / **굵게** / [글자](주소)
export function renderBody(raw) {
  const out = [];
  const toc = [];
  String(raw || '').replace(/\r/g, '').split(/\n\s*\n/).forEach((block) => {
    const b = block.trim();
    if (!b) return;
    let m;
    if ((m = b.match(/^\[img:([^\]|]+)(?:\|([^\]]*))?\]$/))) {
      out.push('<figure><img loading="lazy" src="' + esc(imgUrl(m[1])) + '" alt="' + esc(m[2] || '') + '">' + (m[2] ? '<figcaption>' + esc(m[2]) + '</figcaption>' : '') + '</figure>');
      return;
    }
    if ((m = b.match(/^\[video:([\w-]{11})\]$/))) { out.push(video(m[1])); return; }
    const y = ytId(b);
    if (y && b.length < 80 && /youtu/.test(b)) { out.push(video(y)); return; }
    if (/^###\s+/.test(b) && !b.includes('\n')) { out.push('<h3>' + inline(b.replace(/^###\s+/, '')) + '</h3>'); return; }
    if (/^##\s+/.test(b) && !b.includes('\n')) {
      const t = b.replace(/^##\s+/, '');
      const id = 's' + (toc.length + 1);
      toc.push([id, t]);
      out.push('<h2 id="' + id + '">' + inline(t) + '</h2>');
      return;
    }
    if (/^\[[^\]]+\]$/.test(b) && !/^\[(img|video):/.test(b)) { out.push('<p class="tagline">' + esc(b.slice(1, -1)) + '</p>'); return; }
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*[-•·]\s+/.test(l))) {
      out.push('<ul>' + lines.map((l) => '<li>' + inline(l.replace(/^\s*[-•·]\s+/, '')) + '</li>').join('') + '</ul>');
      return;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      out.push('<ol>' + lines.map((l) => '<li>' + inline(l.replace(/^\s*\d+[.)]\s+/, '')) + '</li>').join('') + '</ol>');
      return;
    }
    if (lines.every((l) => /^>\s?/.test(l))) {
      out.push('<blockquote>' + lines.map((l) => inline(l.replace(/^>\s?/, ''))).join('<br>') + '</blockquote>');
      return;
    }
    out.push('<p>' + lines.map(inline).join('<br>') + '</p>');
  });
  return { html: out.join('\n'), toc };
}
function plain(body) {
  return String(body || '')
    .replace(/\[img:[^\]]+\]/g, '').replace(/\[video:[^\]]+\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/^#+\s+/gm, '').replace(/^\s*([-•·>]|\d+[.)])\s+/gm, '')
    .replace(/\*\*/g, '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
}
function excerpt(body, n) {
  const t = plain(body);
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t;
}
function firstImg(body) {
  const m = String(body || '').match(/\[img:([^\]|]+)/);
  return m ? absUrl(m[1]) : '';
}
function ymd(ms) {
  const d = new Date(ms + 9 * 3600 * 1000); // 한국 시간
  return d.getUTCFullYear() + '. ' + (d.getUTCMonth() + 1) + '. ' + d.getUTCDate() + '.';
}
function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}
function readMin(body) {
  return Math.max(1, Math.round(plain(body).length / 500));
}

// ---------- 페이지 틀 ----------
const EXTRA_CSS = `
.bw{max-width:720px;margin:0 auto;padding:40px 5vw 96px}
.bw .crumb{margin-bottom:28px}
.b-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--m);display:block;margin-bottom:14px}
.b-title{font-size:clamp(28px,4.4vw,42px);font-weight:700;letter-spacing:-.04em;line-height:1.3;margin-bottom:16px}
.b-lead{font-size:16px;color:var(--ink-soft);line-height:1.85;margin-bottom:40px}
.b-meta{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:13.5px;color:var(--ink-soft);margin-bottom:36px;padding-bottom:22px;border-bottom:1px solid var(--bdr)}
.b-meta a{color:var(--ink);font-weight:600;text-decoration:none}
.b-meta .d{font-family:var(--mono);font-size:12px;letter-spacing:.05em;color:var(--m)}
.b-toc{background:var(--bg2,#FAF7F1);border:1px solid var(--bdr);border-radius:6px;padding:18px 22px;margin:0 0 36px;font-size:14.5px}
.b-toc b{display:block;font-size:12px;font-family:var(--mono);letter-spacing:.14em;color:var(--m);margin-bottom:8px}
.b-toc ol{margin:0;padding-left:20px}.b-toc li{margin:3px 0}
.b-toc a{color:var(--ink);text-decoration:none}.b-toc a:hover{color:var(--m)}
.b-body{font-size:16.5px;line-height:1.95;letter-spacing:-.011em;color:#1a2531}
.b-body p{margin:0 0 22px}
.b-body h2{font-size:23px;font-weight:700;letter-spacing:-.03em;line-height:1.45;margin:52px 0 16px;scroll-margin-top:84px}
.b-body h3{font-size:18.5px;font-weight:700;letter-spacing:-.025em;line-height:1.5;margin:34px 0 12px}
.b-body ul,.b-body ol{margin:0 0 24px;padding-left:22px}.b-body li{margin:6px 0}
.b-body blockquote{margin:28px 0;padding:4px 0 4px 18px;border-left:3px solid var(--bdr);color:var(--ink-soft)}
.b-body .tagline{font-family:var(--serif);font-size:20px;font-weight:700;letter-spacing:-.02em;line-height:1.6;color:var(--ink);margin:36px 0;padding-left:20px;border-left:3px solid var(--m)}
.b-body figure{margin:34px 0}.b-body figure img{width:100%;height:auto;border-radius:6px;display:block;border:1px solid var(--bdr)}
.b-body figcaption{font-size:13px;color:var(--ink-soft);margin-top:8px;text-align:center}
.b-body .video{position:relative;padding-top:56.25%;margin:34px 0;border-radius:6px;overflow:hidden;background:#000}
.b-body .video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.b-body a{color:var(--m);text-decoration:none;border-bottom:1px solid rgba(184,28,99,.3)}
.b-author{display:grid;grid-template-columns:72px 1fr;gap:18px;align-items:center;margin-top:56px;padding:22px;border:1px solid var(--bdr);border-radius:8px;background:var(--bg2,#FAF7F1)}
.b-author img{width:72px;height:72px;border-radius:50%;object-fit:cover;object-position:50% 25%;filter:grayscale(1)}
.b-author b{font-size:15.5px}.b-author p{margin:4px 0 0;font-size:14px;color:var(--ink-soft);line-height:1.7}
.b-author a{color:var(--m);font-weight:600;text-decoration:none}
.b-cta{margin-top:18px;font-size:14.5px;color:var(--ink-soft);line-height:1.8}
.b-cta a{color:var(--m);font-weight:600;text-decoration:none}
.b-more{margin-top:56px}
.b-more h2{font-size:15px;font-family:var(--mono);letter-spacing:.14em;color:var(--m);font-weight:500;margin-bottom:6px}
.b-list{display:flex;flex-direction:column}
.b-card{display:block;text-decoration:none;color:inherit;padding:26px 0;border-top:1px solid var(--bdr)}
.b-card:last-child{border-bottom:1px solid var(--bdr)}
.b-card:hover h3,.b-card:hover h2{color:var(--m)}
.b-card .d{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;color:var(--m);display:block;margin-bottom:8px}
.b-card h2,.b-card h3{font-size:21px;font-weight:700;letter-spacing:-.03em;line-height:1.45;margin:0 0 8px;transition:color .15s}
.b-card p{font-size:14.5px;color:var(--ink-soft);line-height:1.75;margin:0}
.b-empty{padding:64px 0;text-align:center;color:var(--ink-soft);border-top:1px solid var(--bdr);border-bottom:1px solid var(--bdr)}
@media(max-width:640px){.bw{padding:28px 6vw 80px}.b-author{grid-template-columns:56px 1fr}.b-author img{width:56px;height:56px}}
`;

function page({ title, desc, canonical, ogType = 'website', ogImage = OG_DEFAULT, ld = [], extraHead = '', body, robots = '' }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${robots ? `<meta name="robots" content="${robots}">` : `<link rel="canonical" href="${canonical}">`}
<meta property="og:site_name" content="더넥스트제너레이션즈">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:locale" content="ko_KR">
<meta name="twitter:card" content="summary_large_image">
${extraHead}
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png?v=3">
<link rel="apple-touch-icon" sizes="180x180" href="/img/favicon-180.png?v=3">
<link href="https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css">
${ld.map((x) => '<script type="application/ld+json">' + JSON.stringify(x).replace(/</g, '\\u003c') + '</script>').join('\n')}
<style>${CSS}${EXTRA_CSS}</style>
</head>
<body>

${NAV}

${body}

${FOOT}

<script>
${TAIL}</script>
<script src="/a.js" defer></script>
</body>
</html>`;
}

const ORG = { '@type': 'Organization', '@id': SITE + '/#organization', name: '더넥스트제너레이션즈', url: SITE + '/ko', logo: SITE + '/img/nav-icon.png' };
const AUTHOR = { '@type': 'Person', name: '김희원', url: SITE + '/ko/about', jobTitle: '더넥스트제너레이션즈 대표' };
const LIST_DESC = '지방의원 의정 실무, AI 의정 활용, POLI CODE, 그리고 기록에 대한 김희원의 글. 더넥스트제너레이션즈.';

function card(p, tag) {
  const d = p.desc || excerpt(p.body, 110);
  return `<a class="b-card" href="${urlOf(p)}"><span class="d">${ymd(p.publishAt)}</span><${tag}>${esc(p.title || '(제목 없음)')}</${tag}><p>${esc(d)}</p></a>`;
}

function listPage(posts) {
  const items = posts.length
    ? '<div class="b-list">' + posts.map((p) => card(p, 'h2')).join('\n') + '</div>'
    : '<div class="b-empty">곧 첫 글이 올라옵니다.</div>';
  const ld = [{
    '@context': 'https://schema.org', '@type': 'Blog', name: '더넥스트제너레이션즈 글', url: SITE + '/ko/briefings',
    description: LIST_DESC, publisher: ORG, author: AUTHOR,
    blogPost: posts.slice(0, 20).map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: SITE + urlOf(p), datePublished: iso(p.publishAt) })),
  }];
  return page({
    title: '글 — 지방의원 의정 실무와 AI 활용 | 더넥스트제너레이션즈',
    desc: LIST_DESC,
    canonical: SITE + '/ko/briefings',
    ld,
    body: `<main class="bw">
  <p class="crumb"><a href="/ko">더넥스트제너레이션즈</a> / 글</p>
  <span class="b-eyebrow">Briefing</span>
  <h1 class="b-title">글</h1>
  <p class="b-lead">지방의원의 의정 실무, AI로 일하는 법, POLI CODE, 그리고 정치를 기록하는 일에 대해 씁니다.</p>
  ${items}
</main>`,
  });
}

function postPage(p, others) {
  const { html, toc } = renderBody(p.body);
  const desc = (p.desc || excerpt(p.body, 150)).slice(0, 200);
  const canonical = SITE + urlOf(p);
  const img = firstImg(p.body) || OG_DEFAULT;
  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: p.title, description: desc, image: [img],
      datePublished: iso(p.publishAt), dateModified: iso(Math.max(p.updatedAt || 0, p.publishAt)),
      author: AUTHOR, publisher: ORG, mainEntityOfPage: canonical, inLanguage: 'ko-KR',
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '더넥스트제너레이션즈', item: SITE + '/ko' },
        { '@type': 'ListItem', position: 2, name: '글', item: SITE + '/ko/briefings' },
        { '@type': 'ListItem', position: 3, name: p.title, item: canonical },
      ],
    },
  ];
  const tocHtml = toc.length >= 3
    ? '<nav class="b-toc" aria-label="목차"><b>CONTENTS</b><ol>' + toc.map(([id, t]) => '<li><a href="#' + id + '">' + esc(t.replace(/\*\*/g, '')) + '</a></li>').join('') + '</ol></nav>'
    : '';
  const more = others.length
    ? '<div class="b-more"><h2>MORE</h2><div class="b-list">' + others.map((o) => card(o, 'h3')).join('\n') + '</div></div>'
    : '';
  return page({
    title: p.title + ' | 더넥스트제너레이션즈',
    desc,
    canonical,
    ogType: 'article',
    ogImage: img,
    ld,
    extraHead: `<meta property="article:published_time" content="${iso(p.publishAt)}">\n<meta property="article:author" content="김희원">`,
    body: `<main class="bw">
  <p class="crumb"><a href="/ko">더넥스트제너레이션즈</a> / <a href="/ko/briefings">글</a></p>
  <article>
    <h1 class="b-title">${esc(p.title)}</h1>
    <div class="b-meta"><span class="d">${ymd(p.publishAt)}</span><span>글 <a href="/ko/about">김희원</a> · 더넥스트제너레이션즈 대표</span><span>${readMin(p.body)}분 분량</span></div>
    ${tocHtml}
    <div class="b-body">
${html}
    </div>
  </article>
  <aside class="b-author">
    <img src="/img/founder-photo.jpg" alt="김희원" width="72" height="72" loading="lazy">
    <div><b>김희원 · 더넥스트제너레이션즈 대표</b>
      <p>『나는 지방의원이다』 대표저자. 지방의원 워크숍과 정책 연구를 해 왔습니다. <a href="/ko/about">소개 보기 →</a></p></div>
  </aside>
  <p class="b-cta">의원님의 의정활동을 설계하고 기록하는 「한 장의 목차」·「한 해의 기록」·「한 권의 정치」 — <a href="/ko#series">의정 기록 시리즈 보기 →</a></p>
  ${more}
</main>`,
  });
}

function notFound() {
  return page({
    title: '글을 찾을 수 없습니다 | 더넥스트제너레이션즈',
    desc: '요청하신 글이 없거나 비공개로 바뀌었습니다.',
    canonical: SITE + '/ko/briefings',
    robots: 'noindex',
    body: `<main class="bw"><span class="b-eyebrow">404</span><h1 class="b-title">글을 찾을 수 없습니다</h1>
  <p class="b-lead">주소가 바뀌었거나 비공개로 전환된 글입니다.</p><p><a href="/ko/briefings" style="color:var(--m);font-weight:600;text-decoration:none">글 목록으로 →</a></p></main>`,
  });
}

function sitemap(posts) {
  const rows = STATIC.map(([path, lm, cf, pr]) => `  <url>\n    <loc>${SITE}${path}</loc>\n    <lastmod>${lm}</lastmod>\n    <changefreq>${cf}</changefreq>\n    <priority>${pr}</priority>\n  </url>`);
  const newest = posts.length ? Math.max(...posts.map((p) => Math.max(p.updatedAt || 0, p.publishAt))) : 0;
  // 발행된 글이 하나도 없으면 글 목록 주소는 사이트맵에 넣지 않음
  if (posts.length) rows.push(`  <url>\n    <loc>${SITE}/ko/briefings</loc>\n${newest ? `    <lastmod>${iso(newest).slice(0, 10)}</lastmod>\n` : ''}    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`);
  posts.forEach((p) => {
    rows.push(`  <url>\n    <loc>${SITE}${urlOf(p).replace(/&/g, '&amp;')}</loc>\n    <lastmod>${iso(Math.max(p.updatedAt || 0, p.publishAt)).slice(0, 10)}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

export default async function handler(req, res) {
  const mode = String(req.query.mode || 'list');
  const all = await loadPosts();
  const posts = livePosts(all, 'ko');

  if (mode === 'sitemap') {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).send(sitemap(posts));
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (mode === 'post') {
    const slug = decodeURIComponent(String(req.query.slug || '')).trim();
    const p = posts.find((x) => x.slug === slug) || posts.find((x) => x.id === slug);
    if (!p) {
      res.setHeader('Cache-Control', 'public, s-maxage=60');
      return res.status(404).send(notFound());
    }
    // id로 들어왔는데 글 주소(slug)가 있으면 정식 주소로 보냄
    if (p.slug && slug !== p.slug) {
      res.setHeader('Location', urlOf(p));
      return res.status(301).end();
    }
    const others = posts.filter((x) => x.id !== p.id).slice(0, 3);
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    return res.status(200).send(postPage(p, others));
  }

  // 예전 주소(/ko/briefings?id=…)는 새 주소로
  const oldId = String(req.query.id || '');
  if (oldId) {
    const p = posts.find((x) => x.id === oldId);
    res.setHeader('Location', p ? urlOf(p) : '/ko/briefings');
    return res.status(301).end();
  }
  // 발행된 글이 없으면 글 목록은 숨김(메인으로 보냄). 첫 글을 발행하면 자동으로 열림
  if (!posts.length) {
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    res.setHeader('Location', '/ko');
    return res.status(302).end();
  }
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  return res.status(200).send(listPage(posts));
}
