/* 화면 — 판정은 report.js 가 한다. 여기서는 읽고, 그리고, 고른 값을 넘길 뿐이다.
 * v1.1: 팀장 보고서(Ⅰ 전체 요약 · Ⅱ 분야별 4개 고정 · Ⅲ 종합 관리)를 그리고, 분야를 고치면 저장해 다시 판정한다. */
(function () {
  'use strict';
  var R = window.Report;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var LS_LAST = 'build-2611-10.lastWeek', LS_AI = 'build-2611-10.ai', LS_FIELDS = 'build-2611-10.fields';
  // 자료 묶음: { label, rows, week, member } · fields: 화면에서 고친 분야 { taskKey: fieldId }
  var state = { cur: [], last: [], res: null, draft: null, ai: null, filter: '', fields: loadFields() };

  function loadFields() { try { return R.mergeFields(JSON.parse(localStorage.getItem(LS_FIELDS) || '{}')); } catch (e) { return {}; } }
  function storeFields() { try { localStorage.setItem(LS_FIELDS, JSON.stringify(state.fields)); } catch (e) { /* 저장 실패는 화면에서 알린다 */ } }

  /* ---------- 읽기 ---------- */
  function sheetRows(ws) {
    return XLSX.utils.sheet_to_json(ws, { defval: '', raw: true, cellDates: true }).map(function (r, i) { r.__row = i + 2; return r; });
  }
  function takeSaved(saved, label) {
    state.last.push({ label: label + ' (' + saved.period.from + ' 주)', rows: saved.rows, week: '', member: '' });
    // 지난주에 고친 분야도 함께 들어온다 — 같은 업무명이면 그 분류를 먼저 쓴다
    if (saved.fields && Object.keys(saved.fields).length) { state.fields = R.mergeFields(state.fields, saved.fields); storeFields(); }
  }
  function readFile(f, target) {
    var ext = (f.name.split('.').pop() || '').toLowerCase();
    var rd = new FileReader();
    rd.onload = function (e) {
      try {
        if (ext === 'json') {
          var saved = R.fromSaved(new TextDecoder().decode(e.target.result));
          if (!saved) throw new Error('이 도구가 저장한 JSON 이 아닙니다');
          takeSaved(saved, f.name);
          return refreshLists();
        }
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        var routes = R.routeSheets(wb.SheetNames, target);
        var fileMember = R.guessMember(f.name);
        routes.forEach(function (rt) {
          if (rt.role === 'skip') return;
          var src = { label: f.name + (wb.SheetNames.length > 1 ? ' · ' + rt.name : ''), rows: sheetRows(wb.Sheets[rt.name]),
            week: rt.week, member: rt.member || fileMember };
          (rt.role === 'last' ? state.last : state.cur).push(src);
        });
        refreshLists();
      } catch (err) { status('<div class="warn">' + esc(f.name) + ' 을 읽지 못했습니다: ' + esc(err.message) + '</div>'); }
    };
    rd.readAsArrayBuffer(f);
  }
  function addText(target) {
    var ta = $(target === 'last' ? 'text-last' : 'text-cur');
    var p = R.parseText(ta.value);
    if (!p.rows.length) return status('<div class="warn">' + p.issues.map(esc).join('<br>') + '</div>');
    (target === 'last' ? state.last : state.cur).push({ label: '붙여 넣은 표 ' + p.rows.length + '줄', rows: p.rows, week: '', member: '', textIssues: p.issues });
    ta.value = '';
    refreshLists();
  }
  function bindDrop(id, input, target) {
    var d = $(id);
    $(input).addEventListener('change', function (e) { Array.prototype.forEach.call(e.target.files, function (f) { readFile(f, target); }); e.target.value = ''; });
    ['dragover', 'dragenter'].forEach(function (t) { d.addEventListener(t, function (e) { e.preventDefault(); d.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { d.addEventListener(t, function () { d.classList.remove('over'); }); });
    d.addEventListener('drop', function (e) { e.preventDefault(); Array.prototype.forEach.call(e.dataTransfer.files, function (f) { readFile(f, target); }); });
  }
  function refreshLists() {
    ['cur', 'last'].forEach(function (k) {
      $('list-' + k).innerHTML = state[k].map(function (s, i) {
        return '<li><span>' + esc(s.label) + (s.member ? ' · 팀원 ' + esc(s.member) : '') + ' — ' + s.rows.length + '줄</span>' +
          '<button class="x" data-k="' + k + '" data-i="' + i + '">빼기</button></li>';
      }).join('');
    });
    status(state.cur.length ? '<div class="note">이번 주 ' + state.cur.length + '묶음 · 지난주 ' + state.last.length + '묶음을 올렸습니다. 「보고서 만들기」를 눌러 주세요.</div>' : '');
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.filelist .x'); if (!b) return;
    state[b.dataset.k].splice(+b.dataset.i, 1); refreshLists();
  });
  function status(h) { $('data-status').innerHTML = h; }

  /* ---------- 만들기 ---------- */
  function refDate() { return R.toDate($('ref').value) || R.defaultRef(new Date()); }
  function norm(list, label, ref) {
    var items = [], issues = [];
    list.forEach(function (s) {
      var n = R.normalize(s.rows, { ref: ref, defaultWeek: s.week, defaultMember: s.member, label: label + '(' + s.label + ')' });
      items = items.concat(n.items); issues = issues.concat(s.textIssues || [], n.issues);
    });
    return { items: items, issues: issues };
  }
  function build(quiet) {
    if (!state.cur.length) return status('<div class="warn">이번 주 업무일지를 먼저 올려 주세요.</div>');
    var ref = refDate();
    var c = norm(state.cur, '업무일지', ref), l = norm(state.last, '지난주', ref);
    if (!c.items.length) return status('<div class="warn">업무일지에서 업무를 한 줄도 읽지 못했습니다. 머리글(팀원·업무명)을 확인해 주세요.</div>');
    state.res = R.analyze(c.items, l.items, { ref: ref, fields: state.fields });
    state.draft = R.draft(state.res);
    if (!quiet) { state.ai = null; state.filter = ''; }
    var iss = c.issues.concat(l.issues);
    if (!quiet) status((iss.length ? '<div class="warn"><b>확인할 줄 ' + iss.length + '개</b><ul>' + iss.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<div class="ok">업무 ' + c.items.length + '줄 · 지난주 ' + l.items.length + '줄을 읽어 보고서를 만들었습니다.</div>');
    render();
    $('s-report').hidden = false; $('s-result').hidden = false; $('s-out').hidden = false;
    if (!quiet) $('s-report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- 그리기 ---------- */
  function who(ms) { return ms.map(esc).join('·'); }
  function due(d, raw, g) { return d ? R.fmt(d) + (g ? '*' : '') : esc(raw || ''); }
  function progs(ps, multi) { return ps.map(function (p) { return (multi ? '<b>' + esc(p.member) + '</b> ' : '') + esc(p.text); }).join('<br>'); }
  function fieldBadge(f) {
    var cls = f.id === 'unsure' ? 'fb fb-unsure' : 'fb fb-' + f.id;
    return '<span class="' + cls + '" title="' + esc(f.reason) + '">' + esc(f.short) + '</span><span class="calc" title="' + esc(f.reason) + '">' + esc(R.SRC[f.src] || f.src) + '</span>';
  }
  // 분야 고치기 — 묶음의 모든 업무명 키에 같은 값을 넣는다
  function fieldSelect(r) {
    var keys = r.names.map(R.taskKey).join('|');
    return '<select class="fsel" data-keys="' + esc(keys) + '" aria-label="' + esc(r.task) + ' 분야">' +
      [R.UNSURE].concat(R.FIELDS).map(function (f) { return '<option value="' + f.id + '"' + (r.field.id === f.id ? ' selected' : '') + '>' + esc(f.id === 'unsure' ? '분류 확인 필요' : f.no + ' ' + f.name) + '</option>'; }).join('') + '</select>';
  }
  function render() {
    var res = state.res, c = res.counts;
    renderReport();
    $('stats').innerHTML = '<div class="stats">' +
      [['금주 업무', c.total, ''], ['완료', c.done, 's-done'], ['계속', c.ongoing, ''], ['신규', c.new, 's-new'], ['지연', c.delayed, 's-delayed'],
        ['일정 변경', c.changes, ''], ['주요 이슈', c.issues, ''], ['차주 계획', c.next, ''], ['통합한 업무', c.merged, ''], ['분류 확인 필요', c.unsure, c.unsure ? 's-unsure' : '']]
        .map(function (s) { return '<div class="stat ' + s[2] + '"><b>' + s[1] + '</b>' + s[0] + '</div>'; }).join('') + '</div>' +
      (res.hasLast ? '' : '<div class="note">지난주 보고서가 없어 모든 업무를 신규로 보았습니다. 지난주 보고서를 올리면 계속·지연을 가립니다.</div>');
    var cats = [['', '전체', c.total], ['delayed', '지연', c.delayed], ['new', '신규', c.new], ['ongoing', '계속', c.ongoing], ['done', '완료', c.done]];
    $('filter').innerHTML = cats.map(function (k) { return '<button class="chip' + (state.filter === k[0] ? ' on' : '') + '" data-f="' + k[0] + '">' + k[1] + ' ' + k[2] + '</button>'; }).join('');
    var rows = res.rows.filter(function (r) { return !state.filter || r.cat === state.filter; });
    $('rows').innerHTML = '<table><thead><tr><th>구분 <span class="calc">자동</span></th><th>분야</th><th>팀원</th><th>업무명</th><th>금주 추진현황</th><th>일정/기한</th><th>상태</th><th>전주 대비 변경</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr data-cat="' + r.cat + '" data-field="' + r.field.id + '"><td><span class="cat cat-' + r.cat + '">' + r.label + '</span></td><td class="fcell">' + fieldBadge(r.field) + '</td><td>' + who(r.members) + '</td>' +
          '<td class="wrap">' + esc(r.task) + (r.merged ? '<span class="calc" title="' + esc(r.names.join(' + ')) + '">통합 ' + r.names.length + '</span>' : '') +
          (r.last && r.last.task !== r.task ? '<span class="was">지난주: ' + esc(r.last.task) + '</span>' : '') +
          r.reasons.map(function (x) { return '<span class="why">' + esc(x) + '</span>'; }).join('') + '</td>' +
          '<td class="wrap">' + progs(r.progress, r.members.length > 1) + r.issues.map(function (i) { return '<span class="iss">이슈: ' + esc(i.text) + '</span>'; }).join('') + '</td>' +
          '<td' + (r.overdue ? ' class="overdue"' : '') + '>' + due(r.due, r.dueRaw, r.dueGuess) + '</td><td>' + esc(r.status) + '</td><td class="wrap delta">' + esc(r.delta) + '</td></tr>';
      }).join('') + '</tbody></table>';
    $('changes').innerHTML = res.changes.length ? '<ul class="mini">' + res.changes.map(function (x) {
      return '<li><b>' + esc(x.task) + '</b> ' + R.fmt(x.from) + ' → ' + R.fmt(x.to) + ' (' + (x.days > 0 ? '+' : '') + x.days + '일, ' + x.kind + ')<br><small>' + who(x.members) + ' · ' + esc(x.basis) + '</small></li>';
    }).join('') + '</ul>' : '<p class="sub">일정이 바뀐 업무가 없습니다.</p>';
    $('issues').innerHTML = res.issues.length ? '<ul class="mini">' + res.issues.map(function (i) {
      return '<li>' + esc(i.text) + '<br><small>' + esc(i.week) + ' · ' + esc(i.task) + ' · ' + esc(i.member) + '</small></li>';
    }).join('') + '</ul>' : '<p class="sub">적힌 이슈가 없습니다.</p>';
    $('missing').innerHTML = res.missing.length ? '<ul class="mini">' + res.missing.map(function (m) {
      return '<li><b>' + esc(m.task) + '</b> (' + who(m.members) + (m.due ? ', 기한 ' + R.fmt(m.due) : '') + ')<br><small>' + esc(m.note) + '</small></li>';
    }).join('') + '</ul>' : '<p class="sub">' + (res.hasLast ? '지난주 업무가 모두 이번 주 일지에 이어집니다.' : '지난주 보고서가 없습니다.') + '</p>';
    $('plan').innerHTML = '<table><thead><tr><th>구분 <span class="calc">자동</span></th><th>분야</th><th>팀원</th><th>업무명</th><th>차주 계획</th><th>일정/기한</th></tr></thead><tbody>' +
      res.plan.map(function (p) {
        return '<tr data-field="' + p.field.id + '"><td>' + esc(p.kind) + '</td><td class="fcell">' + fieldBadge(p.field) + '</td><td>' + who(p.members) + '</td><td class="wrap">' + esc(p.task) + (p.merged ? '<span class="calc">통합 ' + p.names.length + '</span>' : '') + '</td>' +
          '<td class="wrap">' + progs(p.progress, p.members.length > 1) + '</td><td>' + due(p.due, p.dueRaw, p.dueGuess) + (p.soon ? ' <span class="calc">1주 안</span>' : '') + '</td></tr>';
      }).join('') + (res.plan.length ? '' : '<tr><td colspan="6">차주 계획이 없습니다.</td></tr>') + '</tbody></table>';
    renderDraft();
  }
  $('filter').addEventListener('click', function (e) { var b = e.target.closest('.chip'); if (!b) return; state.filter = b.dataset.f; render(); });

  /* ---------- 팀장 보고서 (Ⅰ · Ⅱ · Ⅲ) ---------- */
  function sumLines() { return state.ai && state.ai.use ? state.ai.lines : state.draft.lines; }
  // 분야 표 — 금주·차주 공용. 열: 구분 · 업무명 · 담당자 · 추진현황 · 기한 · 상태 · 전주 대비 변경 · 주요 이슈
  function fieldTable(items, week) {
    if (!items.length) return '<p class="none">해당 기간 업무 없음</p>';
    var isThis = week === 'this';
    return '<div class="tablewrap"><table class="ft ' + (isThis ? 'ft-this' : 'ft-next') + '"><thead><tr>' + R.FIELD_COLS.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
      items.map(function (r) {
        var sel = isThis || r.field.src !== 'linked' ? fieldSelect(r) : '<span class="calc">금주 업무와 같은 분야</span>';
        var iss = r.issues.map(function (i) { return '<span class="iss">' + esc(i.text) + '</span>'; }).join('') +
          (isThis ? r.reasons.filter(function (x) { return /기한 경과/.test(x); }).map(function (x) { return '<span class="why">' + esc(x) + '</span>'; }).join('') : '');
        return '<tr class="' + (isThis ? 'c-' + r.cat + (r.overdue ? ' overdue' : '') : (r.soon ? 'soon' : '')) + '">' +
          '<td>' + (isThis ? '<span class="cat cat-' + r.cat + '">' + r.label + '</span>' : esc(r.kind)) + '</td>' +
          '<td class="wrap"><b>' + esc(r.task) + '</b>' + (r.merged ? '<span class="calc" title="' + esc(r.names.join(' + ')) + '">통합 ' + r.names.length + '</span>' : '') + '<div class="fsel-row">' + sel + '</div></td>' +
          '<td>' + who(r.members) + '</td><td class="wrap">' + progs(r.progress, r.members.length > 1) + '</td>' +
          '<td class="due">' + due(r.due, r.dueRaw, r.dueGuess) + (!isThis && r.soon ? ' <span class="calc">1주 안</span>' : '') + '</td>' +
          '<td>' + esc(isThis ? r.status : '계획') + '</td><td class="wrap delta">' + esc(isThis ? r.delta : (r.soon ? '1주 안 기한' : '')) + '</td><td class="wrap">' + (iss || '<span class="sub">-</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function renderReport() {
    var res = state.res, c = res.counts, p = res.period, mg = R.management(res);
    // 열고 닫은 상태는 다시 그려도 유지한다
    var openState = {};
    Array.prototype.forEach.call(document.querySelectorAll('#rep-fields details.field'), function (d) { openState[d.dataset.field] = d.open; });
    $('rep-title').textContent = state.draft.title + ($('team').value.trim() ? ' · ' + $('team').value.trim() : '');
    $('rep-summary').innerHTML =
      '<div class="sumgrid">' +
        '<div class="sum"><b>' + c.total + '</b>금주 업무</div><div class="sum s-done"><b>' + c.done + '</b>완료</div>' +
        '<div class="sum"><b>' + (c.ongoing + c.new) + '</b>진행 <small>계속 ' + c.ongoing + ' · 신규 ' + c.new + '</small></div>' +
        '<div class="sum s-delayed"><b>' + c.delayed + '</b>지연 <small>기한 경과 ' + c.overdue + '</small></div>' +
        '<div class="sum"><b>' + c.next + '</b>차주 계획</div><div class="sum' + (c.decisions ? ' s-dec' : '') + '"><b>' + c.decisions + '</b>팀장 확인 필요</div>' +
      '</div>' +
      '<div class="grid2">' +
        '<div><h4>분야별 업무 건수</h4><div class="tablewrap"><table class="fcount"><thead><tr><th>분야</th><th>금주</th><th>완료</th><th>계속</th><th>신규</th><th>지연</th><th>차주</th></tr></thead><tbody>' +
          res.fields.map(function (f) { return '<tr' + (f.unsure ? ' class="unsure"' : '') + (f.empty ? ' class="empty"' : '') + '><td><a href="#field-' + f.id + '">' + esc(f.no + ' ' + f.name) + '</a></td><td>' + f.counts.total + '</td><td>' + f.counts.done + '</td><td>' + f.counts.ongoing + '</td><td>' + f.counts.new + '</td><td' + (f.counts.delayed ? ' class="hot"' : '') + '>' + f.counts.delayed + '</td><td>' + f.counts.plan + '</td></tr>'; }).join('') +
          '<tr class="total"><td>합계</td><td>' + c.total + '</td><td>' + c.done + '</td><td>' + c.ongoing + '</td><td>' + c.new + '</td><td>' + c.delayed + '</td><td>' + c.next + '</td></tr></tbody></table></div></div>' +
        '<div><h4>요약' + (state.ai && state.ai.use ? ' <span class="ai-tag">AI 다듬음 — 검토 필요</span>' : ' <span class="calc">규칙 문장</span>') + '</h4><ul class="lines">' + sumLines().map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></div>' +
      '</div>' +
      '<div class="grid2 boxes">' +
        '<div class="box"><h4>주요 일정 변경사항 <span class="calc">' + res.changes.length + '</span></h4>' + (res.changes.length ? '<ul class="mini">' + res.changes.map(function (x) { return '<li><b>' + esc(x.task) + '</b> ' + R.fmt(x.from) + ' → ' + R.fmt(x.to) + ' (' + (x.days > 0 ? '+' : '') + x.days + '일, ' + x.kind + ')<br><small>' + who(x.members) + ' · ' + esc(x.basis) + '</small></li>'; }).join('') + '</ul>' : '<p class="none">일정이 바뀐 업무 없음</p>') + '</div>' +
        '<div class="box box-dec" id="rep-decisions"><h4>팀장 확인 및 의사결정 필요사항 <span class="calc">' + res.decisions.length + '</span></h4>' + (res.decisions.length ? '<ul class="mini dec">' + res.decisions.map(function (d) { return '<li><span class="kind k-' + d.kind + '">' + esc(R.DEC[d.kind]) + '</span><b>' + esc(d.task) + '</b> <small>' + who(d.members) + '</small><br><small>' + esc(d.text) + '</small></li>'; }).join('') + '</ul>' : '<p class="none">없음</p>') + '</div>' +
      '</div>';
    $('rep-fields').innerHTML = res.fields.map(function (f, i) {
      if (f.unsure && f.empty) return '';
      var open = openState[f.id] == null ? true : openState[f.id];
      return '<details class="field' + (f.unsure ? ' unsure' : '') + (f.empty ? ' empty' : '') + '" id="field-' + f.id + '" data-field="' + f.id + '"' + (open ? ' open' : '') + '>' +
        '<summary><span class="fno">' + esc(f.unsure ? '※' : (i + 1) + '.') + '</span><span class="fname">' + esc(f.name) + '</span>' +
          '<span class="fcounts">금주 <b>' + f.counts.total + '</b> · 차주 <b>' + f.counts.plan + '</b>' + (f.counts.delayed ? ' · <b class="hot">지연 ' + f.counts.delayed + '</b>' : '') + (f.counts.overdue ? ' · <b class="hot">기한 경과 ' + f.counts.overdue + '</b>' : '') + (f.counts.issues ? ' · 이슈 ' + f.counts.issues : '') + '</span><span class="tog" aria-hidden="true"></span></summary>' +
        '<div class="fbody">' +
          (f.unsure ? '<p class="note">자동 분류가 확실하지 않은 업무입니다. 업무명 아래에서 분야를 골라 주세요. 고친 값은 이 브라우저와 저장 JSON 에 남아 다음 주에도 같은 업무명이면 먼저 씁니다.</p>' : '') +
          '<h4 class="wk wk-this">금주 주요 추진실적 <small>' + R.fmt(p.from) + ' ~ ' + R.fmt(p.to) + '</small></h4>' + fieldTable(f.rows, 'this') +
          '<h4 class="wk wk-next">차주 추진계획 <small>' + R.fmt(p.nextFrom) + ' ~ ' + R.fmt(p.nextTo) + '</small></h4>' + fieldTable(f.plan, 'next') +
        '</div></details>';
    }).join('');
    function li(arr, f) { return arr.length ? '<ul class="mini">' + arr.map(f).join('') + '</ul>' : '<p class="none">없음</p>'; }
    $('rep-mgmt').innerHTML = '<div class="grid3">' +
      '<div class="box"><h4>1. 지난주 대비 완료된 업무 <span class="calc">' + mg.done.length + '</span></h4>' + li(mg.done, function (r) { return '<li><b>' + esc(r.task) + '</b> <small>' + who(r.members) + '</small></li>'; }) + '</div>' +
      '<div class="box"><h4>2. 신규 발생 업무 <span class="calc">' + mg.newRows.length + '</span></h4>' + li(mg.newRows, function (r) { return '<li><b>' + esc(r.task) + '</b> <small>' + who(r.members) + ' · 기한 ' + due(r.due, r.dueRaw, r.dueGuess) + '</small></li>'; }) + '</div>' +
      '<div class="box"><h4>3. 기한이 변경된 업무 <span class="calc">' + mg.changed.length + '</span></h4>' + li(mg.changed, function (x) { return '<li><b>' + esc(x.task) + '</b> ' + R.fmt(x.from) + ' → ' + R.fmt(x.to) + ' <small>(' + (x.days > 0 ? '+' : '') + x.days + '일, ' + esc(x.basis) + ')</small></li>'; }) + '</div>' +
      '<div class="box box-hot"><h4>4. 기한이 지났으나 완료되지 않은 업무 <span class="calc">' + mg.overdue.length + '</span></h4>' + li(mg.overdue, function (r) { return '<li><b>' + esc(r.task) + '</b> <small>' + who(r.members) + ' · 기한 ' + R.fmt(r.due) + ' · ' + esc(r.status || '미완료') + '</small></li>'; }) + '</div>' +
      '<div class="box box-hot"><h4>5. 지난주 보고서에는 있으나 이번 주 업무일지에서 누락된 업무 <span class="calc">' + mg.gone.length + '</span></h4>' + li(mg.gone, function (m) { return '<li><b>' + esc(m.task) + '</b> <small>' + who(m.members) + (m.due ? ' · 기한 ' + R.fmt(m.due) : '') + '</small></li>'; }) + '</div>' +
      '<div class="box box-dec"><h4>6. 팀장 확인 또는 의사결정이 필요한 사항 <span class="calc">' + mg.decisions.length + '</span></h4>' + li(mg.decisions, function (d) { return '<li><span class="kind k-' + d.kind + '">' + esc(R.DEC[d.kind]) + '</span><b>' + esc(d.task) + '</b><br><small>' + esc(d.text) + '</small></li>'; }) + '</div>' +
      '</div>';
  }
  // 분야 고치기 → 저장 → 다시 판정(구분·일정은 그대로, 분야만 바뀐다)
  document.addEventListener('change', function (e) {
    var s = e.target.closest('.fsel'); if (!s || !state.res) return;
    s.dataset.keys.split('|').forEach(function (k) { if (k) state.fields[k] = s.value; });
    storeFields();
    build(true);
    $('fields-status').innerHTML = '<div class="ok">분야를 고쳐 저장했습니다(이 브라우저). 「JSON 파일로 저장」에도 함께 들어갑니다. <button class="btn small" id="fields-clear">고친 분야 모두 지우기</button></div>';
  });
  document.addEventListener('click', function (e) {
    if (e.target.id === 'fields-clear') { state.fields = {}; storeFields(); $('fields-status').innerHTML = ''; if (state.res) build(true); }
    if (e.target.id === 'rep-open' || e.target.id === 'rep-close') {
      Array.prototype.forEach.call(document.querySelectorAll('#rep-fields details.field'), function (d) { d.open = e.target.id === 'rep-open'; });
    }
  });
  $('team').addEventListener('input', function () { if (state.res) $('rep-title').textContent = state.draft.title + ($('team').value.trim() ? ' · ' + $('team').value.trim() : ''); });

  function renderDraft() {
    var d = state.draft;
    $('draft').innerHTML = '<h4>' + esc(d.title) + '</h4><p class="sub" style="margin-bottom:6px">전체 업무 요약 문장 — 규칙으로 만든 문장입니다</p><ul>' +
      d.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
    $('ai-out').innerHTML = state.ai ? '<div class="ai-draft"><span class="tag">AI 초안 — 검토 필요</span><ul>' +
      state.ai.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
      '<label class="chk" style="display:flex;gap:6px;align-items:center;margin-top:8px;font-size:13.5px"><input type="checkbox" id="ai-use"' + (state.ai.use ? ' checked' : '') + '> 보고서·인쇄·HTML 저장에 AI 문장을 씁니다</label></div>' : '';
  }
  document.addEventListener('change', function (e) { if (e.target.id === 'ai-use' && state.ai) { state.ai.use = e.target.checked; renderReport(); } });

  /* ---------- 내보내기 ---------- */
  function html() { return R.printHtml(state.res, state.draft, { team: $('team').value.trim(), aiLines: state.ai && state.ai.use ? state.ai.lines : null }); }
  function download(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function stamp() { return R.fmt(state.res.period.from); }
  function printReport() {
    var fr = $('print-frame');
    fr.onload = function () { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { /* 인쇄 창을 열 수 없는 환경 */ } fr.onload = null; };
    fr.srcdoc = html();
  }
  $('btn-print').addEventListener('click', printReport);
  $('btn-html').addEventListener('click', function () { download('주간업무보고_' + stamp() + '.html', new Blob([html()], { type: 'text/html;charset=utf-8' })); });
  $('btn-export').addEventListener('click', function () {
    var wb = XLSX.utils.book_new(), sh = R.sheets(state.res, state.draft);
    if (state.ai) sh['보고서요약'] = sh['보고서요약'].concat([[], ['AI 초안 — 검토 필요']], state.ai.lines.map(function (l) { return [l]; }));
    Object.keys(sh).forEach(function (n) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sh[n]), n); });
    XLSX.writeFile(wb, '주간업무보고_' + stamp() + '.xlsx');
  });
  $('btn-save').addEventListener('click', function () {
    var o = R.saveObject(state.res, state.fields);
    try { localStorage.setItem(LS_LAST, JSON.stringify(o)); } catch (e) { return $('save-status').innerHTML = '<div class="warn">브라우저 저장소에 쓰지 못했습니다. JSON 파일로 저장해 주세요.</div>'; }
    $('save-status').innerHTML = '<div class="ok">' + o.period.from + ' 주 보고(' + o.rows.length + '줄, 고친 분야 ' + Object.keys(o.fields).length + '건)를 저장했습니다. 다음 주에 「저장해 둔 지난주 불러오기」를 누르세요.</div>';
    savedButton();
  });
  $('btn-json').addEventListener('click', function () {
    download('지난주보고_' + stamp() + '.json', new Blob([JSON.stringify(R.saveObject(state.res, state.fields), null, 1)], { type: 'application/json' }));
  });
  function savedObj() { try { return R.fromSaved(localStorage.getItem(LS_LAST)); } catch (e) { return null; } }
  function savedButton() {
    var o = savedObj(), b = $('load-saved');
    b.hidden = !o; if (o) b.textContent = '저장해 둔 지난주 불러오기 (' + o.period.from + ' 주)';
  }
  $('load-saved').addEventListener('click', function () {
    var o = savedObj(); if (!o) return;
    takeSaved(o, '저장해 둔 보고'); refreshLists();
  });

  /* ---------- 양식·예제 ---------- */
  function book(sheetsObj) {
    var wb = XLSX.utils.book_new();
    Object.keys(sheetsObj).forEach(function (n) { XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetsObj[n], { header: R.HEAD }), n); });
    return wb;
  }
  $('btn-template').addEventListener('click', function () {
    var ex = { 구분: '금주', 팀원: '홍길동', 업무명: '(예) 업무명', 추진현황: '(예) 이번 주에 한 일', '일정/기한': '2026-11-06', 상태: '진행중', 이슈: '', 분야: '(선택) 복리후생/총무 · 사회공헌/의전 · 자산 · 비상계획 — 비우면 자동 분류' };
    XLSX.writeFile(book({ 업무일지: [ex, Object.assign({}, ex, { 구분: '차주', 추진현황: '(예) 다음 주에 할 일', 상태: '', 분야: '' })] }), '주간업무일지_양식.xlsx');
  });
  $('btn-sample-file').addEventListener('click', function () {
    var s = R.sample();
    XLSX.writeFile(book({ 업무일지: s.current, 지난주보고서: s.last }), '주간업무보고_예제(가짜데이터).xlsx');
  });
  $('btn-sample').addEventListener('click', function () {
    var s = R.sample();
    state.cur = [{ label: '예제 업무일지(가짜 팀원 5명)', rows: s.current, week: '', member: '' }];
    state.last = [{ label: '예제 지난주 보고서', rows: s.last, week: '', member: '' }];
    $('ref').value = s.ref;
    refreshLists(); build();
  });
  $('btn-reset').addEventListener('click', function () {
    state.cur = []; state.last = []; state.res = null; refreshLists();
    $('s-report').hidden = true; $('s-result').hidden = true; $('s-out').hidden = true;
  });
  $('btn-build').addEventListener('click', function () { build(); });
  $('add-cur').addEventListener('click', function () { addText('cur'); });
  $('add-last').addEventListener('click', function () { addText('last'); });
  bindDrop('drop-cur', 'file-cur', 'cur'); bindDrop('drop-last', 'file-last', 'last');

  /* ---------- AI (선택) ---------- */
  try { var ai = JSON.parse(localStorage.getItem(LS_AI) || 'null'); if (ai) { $('ai-provider').value = ai.provider; $('ai-key').value = ai.key; } } catch (e) { /* 저장값 없음 */ }
  $('ai-forget').addEventListener('click', function () { localStorage.removeItem(LS_AI); $('ai-key').value = ''; });
  $('ai-run').addEventListener('click', function () {
    var provider = $('ai-provider').value, key = $('ai-key').value.trim(), out = $('ai-out');
    if (!state.res) return;
    if (!key) { out.innerHTML = '<div class="warn">API 키를 넣어 주세요. 키가 없어도 위의 규칙 요약은 그대로 쓸 수 있습니다.</div>'; return; }
    if (!window.confirm('보고서 요약과 업무별 내용(업무명·팀원·추진현황)이 ' + (provider === 'openai' ? 'OpenAI' : 'Anthropic') +
      ' 로 전송됩니다.\n사내 자료를 외부 AI 로 보내도 되는지 확인하셨나요?')) return;
    try { localStorage.setItem(LS_AI, JSON.stringify({ provider: provider, key: key })); } catch (e) { /* 저장 실패는 무시 */ }
    var rq = R.aiRequest(provider, key, R.aiPrompt(state.res, state.draft));
    out.innerHTML = '<div class="note">AI 에 요청하는 중입니다…</div>';
    fetch(rq.url, rq.init).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j.error && (j.error.message || j.error.type)) || r.status); return j; }); })
      .then(function (j) {
        var lines = R.aiLines(provider, j);
        if (!lines.length) throw new Error('빈 응답');
        state.ai = { lines: lines, use: false }; renderDraft();
      })
      .catch(function (err) { out.innerHTML = '<div class="warn">AI 요청이 실패했습니다: ' + esc(err.message) + '. 규칙 요약은 그대로 쓸 수 있습니다.</div>'; });
  });

  $('ref').value = R.fmt(R.defaultRef(new Date()));
  savedButton();
})();
