/* a.js — TNG 방문 수집기 (프라이버시-세이프)
   모든 페이지에 <script src="/a.js" defer></script>
   쿠키 안 씀. 개인정보 안 보냄. ?notrack=1로 내 방문 제외. */
(function () {
  try {
    // 내 방문 제외 처리
    if (location.search.indexOf('notrack=1') >= 0) {
      try { localStorage.setItem('tng_notrack', '1'); } catch (e) {}
    }
    try { if (localStorage.getItem('tng_notrack') === '1') return; } catch (e) {}

    // 세션 첫 진입 여부
    var entry = '0';
    try {
      if (!sessionStorage.getItem('tng_sess')) {
        sessionStorage.setItem('tng_sess', '1');
        entry = '1';
      }
    } catch (e) {}

    // utm 파라미터
    var utm = '';
    try {
      var qs = new URLSearchParams(location.search);
      utm = qs.get('utm_source') || qs.get('utm') || '';
    } catch (e) {}

    var payload = {
      p: location.pathname,
      r: document.referrer || '',
      u: utm,
      d: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'm' : 'd',
      en: entry,
    };

    var body = JSON.stringify(payload);
    var sent = false;
    if (navigator.sendBeacon) {
      try {
        sent = navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      } catch (e) {}
    }
    if (!sent) {
      try {
        fetch('/api/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        });
      } catch (e) {}
    }
  } catch (e) {}
})();
