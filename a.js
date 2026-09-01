/* a.js — TNG 방문 수집기 (프라이버시-세이프)
   모든 페이지에 <script src="/a.js" defer></script>
   쿠키 안 씀. 개인정보 안 보냄. ?notrack=1로 내 방문 제외. */
(function () {
  var OFF = false;
  try {
    if (location.search.indexOf('notrack=1') >= 0) {
      try { localStorage.setItem('tng_notrack', '1'); } catch (e) {}
    }
    try { if (localStorage.getItem('tng_notrack') === '1') OFF = true; } catch (e) {}
  } catch (e) {}

  function send(payload) {
    if (OFF) return;
    try {
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

  try {
    if (OFF) return;

    // 세션 첫 진입 여부
    var entry = '0';
    try {
      if (!sessionStorage.getItem('tng_sess')) {
        sessionStorage.setItem('tng_sess', '1');
        entry = '1';
      }
    } catch (e) {}

    var utm = '';
    try {
      var qs = new URLSearchParams(location.search);
      utm = qs.get('utm_source') || qs.get('utm') || '';
    } catch (e) {}

    // 페이지뷰 전송
    send({
      p: location.pathname,
      r: document.referrer || '',
      u: utm,
      d: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'm' : 'd',
      en: entry,
    });

    // ── 클릭 추적: 내부 링크(메뉴) / 외부 링크(이탈) ──
    document.addEventListener('click', function (e) {
      try {
        var a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#') return; // 앵커는 제외

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
  } catch (e) {}
})();
