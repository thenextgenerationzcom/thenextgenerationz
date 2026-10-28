/* a.js — TNG 방문 수집기 (프라이버시-세이프)
   모든 페이지에 <script src="/a.js" defer></script>
   쿠키 안 씀. 개인정보 안 보냄. ?notrack=1로 내 방문 제외.
   전환 기록: 페이지 스크립트에서 window.tngCv('라벨') 호출 */
(function () {
  var OFF = false;
  try {
    if (location.search.indexOf('notrack=1') >= 0) {
      try { localStorage.setItem('tng_notrack', '1'); } catch (e) {}
    }
    try { if (localStorage.getItem('tng_notrack') === '1') OFF = true; } catch (e) {}
  } catch (e) {}

  // 자동화 브라우저(헤드리스·크롤러) 신호 — 서버가 봇으로 분류
  var BW = '';
  try { if (navigator.webdriver) BW = '1'; } catch (e) {}

  function send(payload) {
    if (OFF) return;
    try {
      if (BW) payload.bw = BW;
      var body = JSON.stringify(payload);
      var sent = false;
      if (navigator.sendBeacon) {
        try { sent = navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' })); } catch (e) {}
      }
      if (!sent) {
        fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
      }
    } catch (e) {}
  }

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  // 전환 기록. 같은 방문(세션) 안에서 같은 라벨은 한 번만 센다 → 사람 수에 가깝게.
  // 유입경로는 이 방문의 첫 진입 때 값을 함께 보낸다.
  function cv(label) {
    try {
      label = String(label || '').slice(0, 40);
      if (!label) return;
      var key = 'tng_cv_' + label;
      if (ssGet(key)) return;
      ssSet(key, '1');
      send({ t: 'cv', label: label, r: ssGet('tng_src_r') || '', u: ssGet('tng_src_u') || '' });
    } catch (e) {}
  }
  window.tngCv = cv;

  // 페이지별 신청 흐름 이름
  var FLOW = { '/ko/session': '워크숍', '/ko/session.html': '워크숍', '/ko/publishing': '출판', '/ko/publishing.html': '출판' };
  var flow = FLOW[location.pathname] || '';

  try {
    if (OFF) return;

    var utm = '';
    try {
      var qs = new URLSearchParams(location.search);
      utm = qs.get('utm_source') || qs.get('utm') || '';
    } catch (e) {}

    // 세션 첫 진입 여부 + 첫 진입 유입경로 보관
    // 세션 번호: 이 탭에서만 쓰는 임의 값(개인 식별 불가). 방문 흐름(어떤 페이지를 이어 봤는지)을 묶는 데만 쓴다.
    var entry = '0';
    var sid = ssGet('tng_sid');
    if (!sid) { sid = Math.random().toString(36).slice(2, 10); ssSet('tng_sid', sid); }
    if (!ssGet('tng_sess')) {
      ssSet('tng_sess', '1');
      ssSet('tng_src_r', document.referrer || '');
      ssSet('tng_src_u', utm);
      entry = '1';
    }

    // 페이지뷰 전송
    send({
      p: location.pathname,
      r: document.referrer || '',
      u: utm,
      d: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'm' : 'd',
      en: entry,
      s: sid,
      l: (navigator.language || '').slice(0, 12),
      z: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })(),
    });

    // ── 클릭 추적: 신청 버튼(전환) / 내부 링크(메뉴) / 외부 링크(이탈) ──
    document.addEventListener('click', function (e) {
      try {
        var tagged = e.target.closest && e.target.closest('[data-cv]');
        if (tagged) { cv(tagged.getAttribute('data-cv')); }

        var a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (!href) return;
        if (href.charAt(0) === '#') {
          if (flow && href === '#apply' && !tagged) cv(flow + ' 신청 버튼');
          return; // 그 밖의 앵커는 제외
        }

        var url;
        try { url = new URL(href, location.href); } catch (err) { return; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return; // mailto/tel 제외

        var selfHost = location.host.replace(/^www\./, '');
        var linkHost = url.host.replace(/^www\./, '');

        if (linkHost === selfHost) {
          // 내부 메뉴 클릭: 링크 텍스트를 라벨로 (없으면 경로)
          var label = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || url.pathname;
          send({ t: 'menu', label: label });
        } else {
          // 외부 이동: 도메인만 라벨로
          send({ t: 'out', label: linkHost });
        }
      } catch (err) {}
    }, true);

    // ── 신청서 작성 시작: 신청서 칸에 처음 들어간 순간 ──
    if (flow) {
      document.addEventListener('focusin', function (e) {
        try {
          if (e.target.closest && e.target.closest('#applyForm')) cv(flow + ' 신청서 작성 시작');
        } catch (err) {}
      }, true);
    }
  } catch (e) {}
})();
