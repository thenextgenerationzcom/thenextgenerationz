// POLI HOME — 메뉴, 기록 분류, 시연 막대. 이 파일은 고치지 않습니다.
(function () {
  var btn = document.querySelector(".menu-btn");
  var nav = document.getElementById("nav");
  if (btn && nav) {
    btn.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  // 기록 분류 버튼
  var filter = document.querySelector("[data-filter]");
  var list = document.querySelector("[data-list]");
  if (filter && list) {
    filter.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      filter.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
      var cat = b.getAttribute("data-cat");
      list.querySelectorAll(".card").forEach(function (c) {
        c.hidden = !!cat && c.getAttribute("data-cat") !== cat;
      });
    });
  }

  // 기록 찾기: 주소에 ?q=검색어 가 있으면 기록 목록을 거름
  if (list) {
    var q = "";
    try { q = (new URLSearchParams(location.search).get("q") || "").trim(); } catch (e) {}
    if (q) {
      var shown = 0;
      list.querySelectorAll(".card").forEach(function (c) {
        var hit = c.textContent.indexOf(q) !== -1;
        c.hidden = !hit; if (hit) shown++;
      });
      var note = document.createElement("p");
      note.className = "lead";
      note.textContent = "‘" + q + "’ 검색 결과 " + shown + "건";
      list.parentNode.insertBefore(note, list);
    }
  }

  // 시연: 분위기 바꾸기 (시연 화면에만 있음)
  var root = document.documentElement;
  var moodBtns = document.querySelectorAll("[data-set-mood]");
  if (moodBtns.length) {
    var sync = function () {
      var m = root.getAttribute("data-mood");
      moodBtns.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-set-mood") === m ? "true" : "false"); });
    };
    moodBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        var m = b.getAttribute("data-set-mood");
        root.setAttribute("data-mood", m);
        try { localStorage.setItem("ph_mood", m); } catch (e) {}
        sync();
      });
    });
    sync();
  }
})();

// 미리 보기 창(iframe) 안에서는 돌아가기 링크를 숨긴다 — 창 위쪽에 목록으로 버튼이 따로 있음
try { if (window.top !== window.self) { var db = document.querySelector(".demo-back"); if (db) db.style.display = "none"; } } catch (e) {}
