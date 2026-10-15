// api/contact.js — Vercel Serverless Function
// 워크숍/강연/연구 문의를 이메일로 전달합니다.
// 필요한 환경변수 (Vercel > Settings > Environment Variables):
//   RESEND_API_KEY   — https://resend.com 에서 발급
//   CONTACT_TO       — 문의를 받을 이메일 (예: thenextgenerationz.com@gmail.com)
//   CONTACT_FROM     — 발신 주소. Resend에서 도메인 인증 전에는
//                      onboarding@resend.dev 를 그대로 쓰면 됩니다.
//   KV_REST_API_URL / KV_REST_API_TOKEN — (있으면) 들어온 문의를 'tng_inbox'에 함께 보관합니다.
//                      관리자 일정 화면(/admin/schedule)의 '홈페이지 신청' 목록이 여기서 읽습니다.

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const INBOX_KEY = 'tng_inbox';

async function redis(cmd) {
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}
const cut = (s, n) => String(s == null ? '' : s).slice(0, n);

// 문의 한 건을 보관합니다. 실패해도 메일 발송은 그대로 진행합니다.
async function keep(entry) {
  if (!RURL || !RTOK) return false;
  const r = await redis(['GET', INBOX_KEY]);
  let list = [];
  try { list = JSON.parse((r && r.result) || '[]') || []; } catch (e) { list = []; }
  list.unshift(entry);
  if (list.length > 500) list = list.slice(0, 500);
  await redis(['SET', INBOX_KEY, JSON.stringify(list)]);
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { org, name, email, phone, type, message, website, term } = req.body || {};

  // 허니팟 — 봇이 채우면 성공한 척하고 버립니다
  if (website) return res.status(200).json({ success: true });

  if (!org || !name || !email || !type || !message) {
    return res.status(400).json({ error: '필수 항목이 누락되었습니다' });
  }
  if (!String(email).includes('@')) {
    return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });
  }
  if (String(message).length > 5000) {
    return res.status(400).json({ error: '문의 내용이 너무 깁니다' });
  }

  // 홈페이지로 들어온 신청·문의 보관 (관리자 화면에서 확인)
  const t = String(type);
  const kind = t.startsWith('한 장의 목차') ? 'session' : t.startsWith('한 권의 정치') ? 'publishing' : 'contact';
  let kept = false;
  try {
    kept = await keep({
      id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: Date.now(),
      kind,
      type: cut(type, 120),
      org: cut(org, 120),
      name: cut(name, 60),
      email: cut(email, 120),
      phone: cut(phone, 40),
      term: cut(term, 60),
      message: cut(String(message).replace(/^\[신청 구분\][^\n]*\n\n?/, ''), 5000),
      status: 'new',
    });
  } catch (err) {
    console.error('inbox keep error:', err);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO;
  const from = process.env.CONTACT_FROM || 'onboarding@resend.dev';

  if (!apiKey || !to) {
    console.error('contact: missing RESEND_API_KEY or CONTACT_TO');
    if (kept) return res.status(200).json({ success: true });
    return res.status(500).json({ error: 'Server configuration missing' });
  }

  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;line-height:1.7;color:#0B1623">
      <h2 style="margin:0 0 4px">새 문의 — ${esc(type)}</h2>
      <p style="margin:0 0 20px;color:#4B5768;font-size:13px">thenextgenerationz.com/ko</p>
      <table cellpadding="8" style="border-collapse:collapse;font-size:14px">
        <tr><td style="color:#4B5768">기관</td><td><strong>${esc(org)}</strong></td></tr>
        <tr><td style="color:#4B5768">담당자</td><td>${esc(name)}</td></tr>
        <tr><td style="color:#4B5768">이메일</td><td>${esc(email)}</td></tr>
        <tr><td style="color:#4B5768">연락처</td><td>${esc(phone) || '-'}</td></tr>
        <tr><td style="color:#4B5768">유형</td><td>${esc(type)}</td></tr>
      </table>
      <div style="margin-top:20px;padding:16px;background:#FAF7F1;border-left:3px solid #B81C63;white-space:pre-wrap;font-size:14px">${esc(message)}</div>
    </div>
  `;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: `"더넥스트제너레이션즈(The Next GenerationZ)" <${from}>`,
        to: [to],
        reply_to: email,
        subject: `[문의/${type}] ${org} · ${name}`,
        html,
      }),
    });

    if (response.ok) return res.status(200).json({ success: true });

    const data = await response.json().catch(() => ({}));
    console.error('resend error:', data);
    if (kept) return res.status(200).json({ success: true }); // 보관은 됐으니 신청은 접수된 것으로 봅니다
    return res.status(502).json({ error: 'Failed to send' });
  } catch (err) {
    console.error('contact server error:', err);
    if (kept) return res.status(200).json({ success: true });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
