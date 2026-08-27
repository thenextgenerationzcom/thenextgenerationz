// api/contact.js — Vercel Serverless Function
// 워크숍/강연/연구 문의를 이메일로 전달합니다.
// 필요한 환경변수 (Vercel > Settings > Environment Variables):
//   RESEND_API_KEY   — https://resend.com 에서 발급
//   CONTACT_TO       — 문의를 받을 이메일 (예: thenextgenerationz.com@gmail.com)
//   CONTACT_FROM     — 발신 주소. Resend에서 도메인 인증 전에는
//                      onboarding@resend.dev 를 그대로 쓰면 됩니다.

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { org, name, email, phone, type, message, website } = req.body || {};

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

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO;
  const from = process.env.CONTACT_FROM || 'onboarding@resend.dev';

  if (!apiKey || !to) {
    console.error('contact: missing RESEND_API_KEY or CONTACT_TO');
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
        from: `TNG 문의 <${from}>`,
        to: [to],
        reply_to: email,
        subject: `[문의/${type}] ${org} · ${name}`,
        html,
      }),
    });

    if (response.ok) return res.status(200).json({ success: true });

    const data = await response.json().catch(() => ({}));
    console.error('resend error:', data);
    return res.status(502).json({ error: 'Failed to send' });
  } catch (err) {
    console.error('contact server error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
