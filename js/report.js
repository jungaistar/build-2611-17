/* 주간업무보고 자동 생성 — 판정 엔진
 *
 * 화면(app.js)은 판정하지 않는다. 읽기·정규화·업무명 유사도·지난주 대비 구분·일정 변경·이슈 모음·
 * 보고서 초안·내보내기 표·AI 요청 모양까지 전부 여기서 만들고 test/logic.test.js 로 고정한다.
 * 브라우저와 node 양쪽에서 읽힌다(UMD).
 *
 * 업무 한 줄(item)
 *   { week:'this'|'next', member, task, progress, due:Date|null, dueRaw, dueGuess, status, issue, pct, src }
 *   week  this = 금주(실적) · next = 차주(계획)
 *   dueGuess  '11/6' 처럼 연도 없이 적혀 기준일 연도로 보충한 날짜 — 문서 값과 신뢰도가 다르다.
 *
 * 구분(category) — 금주 업무만 판정한다
 *   done     완료 : 상태에 「완료·종료」 또는 진척률 100%
 *   delayed  지연 : 기한 경과(기한 < 기준일, 미완료) · 일정이 뒤로 밀림 · 상태에 「지연·차질·보류·중단」
 *   new      신규 : 지난주 보고서에 비슷한 업무가 없음
 *   ongoing  계속 : 그 밖
 */
(function (root) {
  'use strict';
  var DAY = 86400000;

  /* ---------- 날짜 ---------- */
  function utc(y, m, d) {
    var t = new Date(Date.UTC(y, m - 1, d));
    return (t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d) ? t : null;
  }
  // 엑셀 일련번호 · Date · '2026-11-06' · '2026.11.6' · '2026년 11월 6일' 은 그대로,
  // '11/6' · '11.6' · '11월 6일' 은 기준일 연도로 보충한다(guess=true). 기준일과 6달 넘게 떨어지면 앞뒤 해로 옮긴다.
  // '11/3~11/7' 같은 기간은 끝 날짜를 기한으로 본다.
  function parseDate(v, ref) {
    if (v == null || v === '') return { date: null, guess: false };
    if (v instanceof Date) return { date: isNaN(v) ? null : utc(v.getFullYear(), v.getMonth() + 1, v.getDate()), guess: false };
    if (typeof v === 'number' && isFinite(v)) {
      if (v < 20000 || v > 80000) return { date: null, guess: false };
      return { date: new Date(Date.UTC(1899, 11, 30) + Math.round(v) * DAY), guess: false };
    }
    var s = String(v).trim();
    var parts = s.split(/\s*[~～]\s*|\s+-\s+/);
    if (parts.length > 1 && parts[parts.length - 1]) s = parts[parts.length - 1];
    var m = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
    if (m) return { date: utc(+m[1], +m[2], +m[3]), guess: false };
    m = s.match(/(^|[^\d])(\d{1,2})\s*[./월]\s*(\d{1,2})(?!\d)/);
    if (!m) return { date: null, guess: false };
    var ry = ref ? ref.getUTCFullYear() : new Date().getFullYear();
    var d = utc(ry, +m[2], +m[3]);
    if (!d) return { date: null, guess: false };
    if (ref) {
      if (d - ref > 183 * DAY) d = utc(ry - 1, +m[2], +m[3]);
      else if (ref - d > 183 * DAY) d = utc(ry + 1, +m[2], +m[3]);
    }
    return { date: d, guess: true };
  }
  function toDate(v, ref) { return parseDate(v, ref).date; }
  function fmt(d) { return d ? d.toISOString().slice(0, 10) : ''; }
  function md(d) { return d ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate() : ''; }
  function monday(d) { var w = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - w * DAY); }
  function addDays(d, n) { return new Date(d.getTime() + n * DAY); }
  function days(a, b) { return Math.round((b - a) / DAY); }
  // 기준일 기본값: 그 주 금요일(주간보고는 금요일 기준으로 쓴다)
  function defaultRef(today) {
    var t = today instanceof Date ? utc(today.getFullYear(), today.getMonth() + 1, today.getDate()) : toDate(today);
    return addDays(monday(t), 4);
  }

  /* ---------- 열 이름 ---------- */
  // 양식이 달라도 읽는다. 늘릴 때는 코드가 아니라 이 표를 늘린다.
  var ALIASES = {
    week: ['구분', '주차', '금주/차주', '금주차주', 'week'],
    member: ['팀원', '담당', '담당자', '이름', '성명', '작성자', 'member', 'name', 'owner'],
    task: ['업무명', '업무', '과제', '과제명', '항목', '업무항목', 'task'],
    progress: ['추진현황', '진행현황', '추진내용', '진행내용', '추진실적', '실적', '내용', '현황', '업무내용', 'progress'],
    thisProgress: ['금주실적', '금주추진현황', '금주추진실적', '금주내용', '금주업무', '금주'],
    nextPlan: ['차주계획', '차주추진계획', '차주내용', '차주업무', '차주', '다음주계획'],
    due: ['일정기한', '일정', '기한', '마감', '마감일', '완료예정', '완료예정일', '목표일', '납기', 'due', 'deadline'],
    nextDue: ['차주일정', '차주기한', '차주일정기한'],
    status: ['상태', '진행상태', '진척', 'status'],
    pct: ['진척률', '진행률', '진척도', '%'],
    issue: ['이슈', '주요이슈', '특이사항', '문제점', '비고', 'issue', 'issues'],
    field: ['분야', '업무분야', '분류', '업무분류', '카테고리', 'field', 'category'],
    purpose: ['목적', '업무목적', '배경', 'purpose']
  };
  function hnorm(s) { return String(s == null ? '' : s).replace(/[\s()\[\]/·._\-:]+/g, '').toLowerCase(); }
  function pick(row, key) {
    var names = ALIASES[key].map(hnorm);
    for (var k in row) if (names.indexOf(hnorm(k)) >= 0) return row[k];
    return undefined;
  }
  function has(row, key) { return pick(row, key) !== undefined; }
  function str(v) { return v == null ? '' : (v instanceof Date ? fmt(toDate(v)) : String(v)).trim(); }
  function parseWeek(v) {
    var s = hnorm(v);
    if (!s) return '';
    if (/^(금주|이번주|당주|this|실적|금주실적)/.test(s)) return 'this';
    if (/^(차주|다음주|익주|next|계획|차주계획)/.test(s)) return 'next';
    return '?';
  }
  function cleanMember(v) { return str(v).replace(/\s+/g, '').replace(/님$/, ''); }
  var EMPTY_ISSUE = /^(-|–|—|없음|해당\s*없음|특이사항\s*없음|n\/?a|x)$/i;

  /* ---------- 붙여넣은 텍스트 ---------- */
  // 엑셀에서 복사한 표(탭) · 마크다운 표(|) · CSV(,) 를 받는다. 따옴표 안 줄바꿈도 한 칸으로 본다.
  // 줄 하나에 「금주」「차주 계획」만 있으면 그 아래 줄의 구분이 되고, 「팀원: 김민준」 줄은 그 아래 줄의 팀원이 된다.
  function splitRecords(text, delim) {
    var out = [], row = [], cell = '', q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"' && cell.trim() === '') { q = true; cell = ''; }
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    row.push(cell); out.push(row);
    return out.map(function (r) { return r.map(function (x) { return x.trim(); }); });
  }
  function parseText(text, opts) {
    opts = opts || {};
    var issues = [], rows = [];
    text = String(text || '').replace(/^﻿/, '');
    if (!text.trim()) return { rows: rows, issues: ['붙여넣은 내용이 비어 있습니다'] };
    var recs;
    if (/\t/.test(text)) recs = splitRecords(text, '\t');
    else if (/^\s*\|/m.test(text)) {
      recs = text.split(/\r?\n/).map(function (l) {
        l = l.trim();
        if (!/^\|/.test(l)) return [l];
        return l.replace(/^\||\|$/g, '').split('|').map(function (x) { return x.trim(); });
      }).filter(function (r) { return !(r.length > 1 && r.every(function (x) { return /^:?-{2,}:?$/.test(x) || x === ''; })); });
    } else recs = splitRecords(text, ',');
    var header = null, week = opts.defaultWeek || '', member = opts.defaultMember || '';
    var known = Object.keys(ALIASES);
    recs.forEach(function (r, idx) {
      var filled = r.filter(function (x) { return x !== ''; });
      if (!filled.length) return;
      if (filled.length === 1) {
        var only = filled[0].replace(/^[\s\[【■□▶●○#*\-]+|[\]】:：\s]+$/g, '');
        var mm = only.match(/^(팀원|담당자?|이름|성명|작성자)\s*[:：]\s*(.+)$/);
        if (mm) { member = cleanMember(mm[2]); return; }
        var wk = parseWeek(only);
        if ((wk === 'this' || wk === 'next') && only.replace(/\s/g, '').length <= 8) { week = wk; return; }
      }
      var hits = r.filter(function (h) { return known.some(function (k) { return ALIASES[k].map(hnorm).indexOf(hnorm(h)) >= 0; }); }).length;
      if (hits >= 2 && (!header || hits >= header.hits)) { header = { cols: r, hits: hits }; return; }
      if (!header) { issues.push((idx + 1) + '번째 줄: 머리글(팀원·업무명 등) 앞의 줄이라 건너뜁니다'); return; }
      var o = {};
      header.cols.forEach(function (h, j) { if (h) o[h] = r[j] == null ? '' : r[j]; });
      if (week && !has(o, 'week') && !has(o, 'thisProgress') && !has(o, 'nextPlan')) o['구분'] = week === 'this' ? '금주' : '차주';
      if (member && !str(pick(o, 'member'))) o['팀원'] = member;
      rows.push(o);
    });
    if (!header) issues.push('머리글 줄을 찾지 못했습니다 — 첫 줄에 「팀원 · 업무명 · 추진현황 · 일정/기한 · 상태 · 이슈」를 적어 주세요');
    return { rows: rows, issues: issues };
  }

  /* ---------- 정규화 ---------- */
  function pctOf(row, text) {
    var v = pick(row, 'pct');
    if (typeof v === 'number') return v <= 1 && v > 0 ? Math.round(v * 100) : v;
    var m = String(v == null ? '' : v).match(/(\d{1,3})/) || String(text || '').match(/(\d{1,3})\s*%/);
    return m ? +m[1] : null;
  }
  // rows: 객체 배열(엑셀 시트나 parseText 결과). 틀린 줄은 버리지 않고 issues 로 알린다.
  function normalize(rows, opts) {
    opts = opts || {};
    var ref = opts.ref || null, items = [], issues = [], label = opts.label || '업무일지';
    (rows || []).forEach(function (r, i) {
      var rowNo = r.__row || (i + 2);
      var member = cleanMember(pick(r, 'member')) || cleanMember(opts.defaultMember);
      var task = str(pick(r, 'task'));
      var wide = has(r, 'thisProgress') || has(r, 'nextPlan');
      var prog = str(wide ? (pick(r, 'thisProgress') != null ? pick(r, 'thisProgress') : pick(r, 'progress')) : pick(r, 'progress'));
      var plan = wide ? str(pick(r, 'nextPlan')) : '';
      if (!task && !prog && !plan) return;                             // 빈 줄
      if (!task) { issues.push(label + ' ' + rowNo + '행: 업무명이 비어 있어 건너뜁니다'); return; }
      if (!member) { member = '(미기재)'; issues.push(label + ' ' + rowNo + '행(' + task + '): 팀원이 비어 있어 「(미기재)」로 둡니다'); }
      var dueRaw = str(pick(r, 'due')), pd = parseDate(pick(r, 'due'), ref);
      if (dueRaw && !pd.date && !/상시|수시|미정|-/.test(dueRaw)) issues.push(label + ' ' + rowNo + '행(' + task + '): 기한 「' + dueRaw + '」을 날짜로 읽지 못해 원문으로 둡니다');
      var status = str(pick(r, 'status')), issue = str(pick(r, 'issue'));
      if (EMPTY_ISSUE.test(issue)) issue = '';
      var week;
      if (wide) week = 'this';
      else {
        var w = parseWeek(pick(r, 'week'));
        if (w === '?') { issues.push(label + ' ' + rowNo + '행(' + task + '): 구분 「' + str(pick(r, 'week')) + '」을 몰라 금주로 봅니다'); w = ''; }
        week = w || opts.defaultWeek || 'this';
      }
      var fieldRaw = str(pick(r, 'field')), fieldGiven = parseField(fieldRaw);
      if (fieldRaw && !fieldGiven) issues.push(label + ' ' + rowNo + '행(' + task + '): 분야 「' + fieldRaw + '」를 몰라 자동 분류합니다');
      var base = { member: member, task: task, src: label + ' ' + rowNo + '행', field: fieldGiven, fieldRaw: fieldRaw, purpose: str(pick(r, 'purpose')) };
      if (!wide || prog || status) {
        items.push(Object.assign({ week: week, progress: prog, due: pd.date, dueRaw: dueRaw, dueGuess: pd.guess,
          status: status, issue: issue, pct: pctOf(r, prog + ' ' + status) }, base));
      }
      if (plan) {
        var ndRaw = str(pick(r, 'nextDue')) || dueRaw, nd = parseDate(pick(r, 'nextDue') || pick(r, 'due'), ref);
        items.push(Object.assign({ week: 'next', progress: plan, due: nd.date, dueRaw: ndRaw, dueGuess: nd.guess,
          status: '', issue: (!prog && !status) ? issue : '', pct: null }, base));
      }
    });
    return { items: items, issues: issues };
  }

  /* ---------- 업무명 유사도 ---------- */
  var STOP = ['관련', '업무', '작업', '건', '등', '및', '의', '건의'];
  function taskKey(s) {
    var t = String(s == null ? '' : s).normalize('NFC').toLowerCase()
      .replace(/[()\[\]{}<>【】「」『』"'`·,.:;\/\\|_\-~!?※*#]+/g, ' ');
    return t.split(/\s+/).filter(function (w) { return w && STOP.indexOf(w) < 0; })
      .map(function (w) { return w.length > 3 ? w.replace(/관련$/, '') : w; }).join('');
  }
  function bigrams(s) { var o = []; for (var i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2)); return o; }
  function nums(s) { return (String(s).match(/\d+/g) || []).map(Number).sort(function (a, b) { return a - b; }).join(','); }
  // 0~1. 띄어쓰기·괄호·「관련/업무」 같은 군더더기는 무시, 한쪽이 다른 쪽을 품으면 0.85 이상,
  // 숫자(11월·2차 등)가 서로 다르면 다른 업무로 보아 절반으로 깎는다 — 「10월 실적 집계」와 「11월 실적 집계」는 다른 일이다.
  function similarity(a, b) {
    var x = taskKey(a), y = taskKey(b);
    if (!x || !y) return 0;
    var sc;
    if (x === y) sc = 1;
    else {
      var A = bigrams(x), B = bigrams(y), hit = 0;
      var pool = B.slice();
      A.forEach(function (g) { var k = pool.indexOf(g); if (k >= 0) { hit++; pool.splice(k, 1); } });
      sc = (A.length + B.length) ? 2 * hit / (A.length + B.length) : 0;
      var s = x.length <= y.length ? x : y, l = s === x ? y : x;
      if (s.length >= 4 && l.indexOf(s) >= 0) sc = Math.max(sc, 0.85);
    }
    var na = nums(a), nb = nums(b);
    if (na && nb && na !== nb) sc *= 0.5;
    return Math.round(sc * 1000) / 1000;
  }
  function memberList(s) { return String(s || '').split(/[,/·、\s]+/).filter(Boolean); }

  var CLUSTER_TH = 0.75, MATCH_TH = 0.6;

  /* ---------- 업무 분야 (v1.1) ---------- */
  // 보고서의 최상위 분류. 순서는 고정이다. 낱말 표는 개편 요청 원문 3절의 세부 항목에서 뽑았다 —
  // 양식이 바뀌면 코드가 아니라 이 표를 늘린다. 분류와 구분(신규·계속·완료·지연) 판정은 서로 건드리지 않는다.
  var FIELDS = [
    { id: 'welfare', no: '①', name: '복리후생 / 총무', short: '복리후생·총무', keywords: [
      '복리후생', '복지', '편의지원', '편의시설', '통근버스', '통근', '셔틀', '임직원행사', '사내행사', '행사', '간담회', '워크숍', '체육대회',
      '송년회', '시무식', '종무식', '창립기념', '회의실', '사무환경', '사무실', '총무', '행정', '비용정산', '정산', '경비', '법인카드',
      '경조사', '경조', '명절선물', '선물', '건강검진', '동호회', '휴양소', '구내식당', '식당', '근태', '사원증', '출입증', '우편', '문서수발'] },
    { id: 'social', no: '②', name: '사회공헌 / 의전', short: '사회공헌·의전', keywords: [
      '사회공헌', '봉사', '봉사활동', '기부', '후원', '지역사회', '대외기관', '외부방문', '방문객', '의전', '공장견학', '견학', '견학안내',
      '방문일정', '방문절차', '내빈', '귀빈', 'vip', '영접', '환영', '대내외행사', '외빈', '접견', '기념품'] },
    { id: 'asset', no: '③', name: '자산', short: '자산', keywords: [
      '자산', '비품', '사무용품', '소모품', '구매', '발주', '재고', '실사', '입출고', '입고', '출고', '불출', '물품', '시설물', '시설',
      '유지보수', '보수', '수리', '법인차량', '차량', '업무차량', '정기점검', '점검', '자산현황', '집기', '설비', '장비', '리스', '임차', '폐기', '불용'] },
    { id: 'emergency', no: '④', name: '비상계획', short: '비상계획', keywords: [
      '비상', '비상대응', '비상연락', '비상연락망', '연락체계', '재난', '안전', '안전관리', '대응매뉴얼', '비상매뉴얼', '비상상황', '대피',
      '대피훈련', '소방훈련', '비상훈련', '모의훈련', '안전교육', '화재', '정전', '소방', '소방시설', '지진', '태풍', '풍수해', '폭설', '한파',
      '민방위', '응급', '심폐소생', 'aed', '위기', '위기대응', '비상계획', 'bcp', '사고대응'] }
  ];
  var UNSURE = { id: 'unsure', no: '?', name: '분류 확인 필요', short: '확인 필요' };
  var FIELD_IDS = FIELDS.map(function (f) { return f.id; });
  // 업무명에 든 낱말은 3점, 추진현황·이슈·목적에 든 낱말은 1점. 같은 낱말은 한 번만 센다.
  // 가장 높은 분야가 0점이거나 2위와의 차이가 FIELD_MARGIN 미만이면 「분류 확인 필요」 — 임의로 정하지 않는다.
  var FIELD_TASK_W = 3, FIELD_BODY_W = 1, FIELD_MARGIN = 2;
  function ftext(s) { return String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/\s+/g, ''); }
  function fieldById(id) { return FIELDS.filter(function (f) { return f.id === id; })[0] || (id === 'unsure' ? UNSURE : null); }
  // 「복리후생」「총무」「사회공헌/의전」「비상」 같은 표기를 분야 id 로. 모르면 ''.
  function parseField(v) {
    var s = ftext(v).replace(/[\/·,()\[\]①②③④?]/g, '');
    if (!s) return '';
    if (FIELD_IDS.indexOf(s) >= 0) return s;
    if (/^(복리후생|복지|총무|복리후생총무)$/.test(s) || /복리후생|총무/.test(s)) return 'welfare';
    if (/사회공헌|의전/.test(s)) return 'social';
    if (/^자산$/.test(s) || /자산관리|자산$/.test(s)) return 'asset';
    if (/비상|재난|안전/.test(s)) return 'emergency';
    if (/확인|미정|unsure/.test(s)) return 'unsure';
    return '';
  }
  // 업무명(들)과 본문(추진현황·이슈·목적)으로 분야 점수를 매긴다.
  function classifyText(tasks, body) {
    var tt = ftext([].concat(tasks).join(' ')), bt = ftext(body);
    var scores = {}, hits = {};
    FIELDS.forEach(function (f) {
      var s = 0, h = [];
      f.keywords.forEach(function (k) {
        var inT = tt.indexOf(k) >= 0, inB = bt.indexOf(k) >= 0;
        if (inT) s += FIELD_TASK_W;
        if (inB) s += FIELD_BODY_W;
        if (inT || inB) h.push(k);
      });
      scores[f.id] = s; hits[f.id] = h;
    });
    var order = FIELD_IDS.slice().sort(function (a, b) { return scores[b] - scores[a]; });
    var best = order[0], second = order[1];
    if (scores[best] === 0) return { id: 'unsure', scores: scores, hits: hits, reason: '어느 분야의 낱말도 없습니다' };
    if (scores[best] - scores[second] < FIELD_MARGIN) {
      return { id: 'unsure', scores: scores, hits: hits, reason: fieldById(best).short + ' ' + scores[best] + '점 · ' + fieldById(second).short + ' ' + scores[second] + '점으로 비슷합니다' };
    }
    return { id: best, scores: scores, hits: hits, reason: hits[best].join('·') + ' (' + scores[best] + '점)' };
  }
  // 한 업무(묶음)의 분야를 정한다. 우선순위: 사용자가 고친 값 → 일지의 분야 열 → 지난주 보고서의 분야 → 자동 판정.
  //   overrides: { taskKey: fieldId } — 화면에서 고친 값(localStorage·JSON 에 남긴다)
  //   given: 일지 분야 열(parseField 결과), lastField: 짝지은 지난주 업무의 분야
  function resolveField(names, body, opts) {
    opts = opts || {};
    var ov = opts.overrides || {}, keys = names.map(taskKey), k;
    for (k = 0; k < keys.length; k++) if (ov[keys[k]] && fieldById(ov[keys[k]])) return { id: ov[keys[k]], src: 'user', reason: '화면에서 고친 분류' };
    if (opts.given && opts.given !== 'unsure' && fieldById(opts.given)) return { id: opts.given, src: 'doc', reason: '업무일지의 분야 열' };
    if (opts.lastField && opts.lastField !== 'unsure' && fieldById(opts.lastField)) return { id: opts.lastField, src: 'last', reason: '지난주 보고서의 분야' };
    var c = classifyText(names, body);
    return { id: c.id, src: c.id === 'unsure' ? 'unsure' : 'auto', reason: c.reason, scores: c.scores };
  }
  function withName(f) { var d = fieldById(f.id) || UNSURE; f.name = d.name; f.short = d.short; f.no = d.no; return f; }

  // 같은 주의 비슷한 업무를 하나로 묶는다(팀원이 달라도 같은 업무면 통합).
  function cluster(items, th) {
    th = th == null ? CLUSTER_TH : th;
    var groups = [];
    items.forEach(function (it) {
      var best = null, bs = 0;
      groups.forEach(function (g) {
        var s = Math.max.apply(null, g.names.map(function (n) { return similarity(n, it.task); }));
        if (s > bs) { bs = s; best = g; }
      });
      if (best && bs >= th) best.items.push(it);
      else groups.push({ items: [it], names: [] });
      var g = best && bs >= th ? best : groups[groups.length - 1];
      if (g.names.indexOf(it.task) < 0) g.names.push(it.task);
    });
    return groups.map(summarize);
  }
  function isDone(it) {
    var s = String(it.status || '');
    if (/미\s*완료|완료\s*예정|완료\s*전/.test(s)) return false;
    return /완료|종료|마감됨|done|끝/i.test(s) || (it.pct != null && it.pct >= 100);
  }
  function isStatusDelay(it) { return /지연|차질|보류|중단|연기/.test(String(it.status || '')); }
  function summarize(g) {
    var its = g.items, members = [];
    its.forEach(function (i) { memberList(i.member).forEach(function (m) { if (members.indexOf(m) < 0) members.push(m); }); });
    var dated = its.filter(function (i) { return i.due; });
    var latest = dated.reduce(function (a, i) { return !a || i.due > a.due ? i : a; }, null);
    var issues = [];
    its.forEach(function (i) { if (i.issue && !issues.some(function (x) { return x.text === i.issue; })) issues.push({ member: i.member, text: i.issue }); });
    return {
      task: g.names[0], names: g.names, members: members, items: its, merged: its.length > 1 && g.names.length > 1 || members.length > 1,
      progress: its.filter(function (i) { return i.progress; }).map(function (i) { return { member: i.member, text: i.progress }; }),
      due: latest ? latest.due : null, dueRaw: latest ? latest.dueRaw : (its[0].dueRaw || ''), dueGuess: latest ? latest.dueGuess : false,
      status: its.map(function (i) { return i.status; }).filter(Boolean).filter(function (s, k, a) { return a.indexOf(s) === k; }).join(' / '),
      done: its.every(isDone), statusDelay: its.some(isStatusDelay), issues: issues,
      // 일지에 분야 열이 있으면 그 값(첫 번째로 적힌 것) — 자동 판정보다 앞선다
      given: its.map(function (i) { return i.field; }).filter(Boolean)[0] || '',
      body: its.map(function (i) { return [i.progress, i.issue, i.purpose].join(' '); }).join(' ')
    };
  }

  // a 그룹들과 b 그룹들을 한 쌍씩 잇는다 — 점수 높은 쌍부터, 한 번 쓴 것은 다시 쓰지 않는다.
  function groupScore(a, b) {
    var s = 0;
    a.names.forEach(function (x) { b.names.forEach(function (y) { s = Math.max(s, similarity(x, y)); }); });
    var same = a.members.some(function (m) { return b.members.indexOf(m) >= 0; });
    return s + (same && s > 0 ? 0.05 : 0);
  }
  function match(A, B, th) {
    th = th == null ? MATCH_TH : th;
    var pairs = [];
    A.forEach(function (a, i) { B.forEach(function (b, j) { var s = groupScore(a, b); if (s >= th) pairs.push([s, i, j]); }); });
    pairs.sort(function (p, q) { return q[0] - p[0] || p[1] - q[1] || p[2] - q[2]; });
    var ua = {}, ub = {}, out = {};
    pairs.forEach(function (p) { if (!ua[p[1]] && !ub[p[2]]) { ua[p[1]] = ub[p[2]] = 1; out[p[1]] = { idx: p[2], score: Math.min(1, p[0]) }; } });
    return out;
  }

  /* ---------- 분석 ---------- */
  var CAT = { delayed: '지연', new: '신규', ongoing: '계속', done: '완료' };
  var CAT_ORDER = ['delayed', 'new', 'ongoing', 'done'];

  // 이슈 문장에 결재·승인·예산 같은 낱말이 있으면 팀장 확인·의사결정 사항으로 본다
  var DECISION = /승인|결재|결정|의사결정|검토\s*요청|확인\s*요청|예산|판단\s*필요|협의\s*필요|지시\s*필요/;
  // 전주 대비 변경 — 데이터에서만 만든다(지난주 짝·일정 변경·상태 변화)
  function deltaOf(g, L, reasons, changes) {
    if (!L) return '신규(지난주 없음)';
    var parts = [];
    changes.forEach(function (c) { if (c.basis === '지난주 보고 대비') parts.push('기한 ' + md(c.from) + ' → ' + md(c.to) + ' (' + (c.days > 0 ? '+' : '') + c.days + '일)'); });
    // 지난주 상태는 실적(금주) 줄의 것만 — 계획 줄의 「계획」을 상태 변화로 읽지 않는다
    var ls = uniq(L.items.filter(function (i) { return i.week === 'this'; }).map(function (i) { return i.status; }).filter(Boolean)).join(' / ');
    if (g.done && !L.done) parts.push('완료');
    else if (ls && g.status && ls !== g.status) parts.push('상태 ' + ls + ' → ' + g.status);
    if (L.task !== g.task) parts.push('지난주 업무명 「' + L.task + '」');
    return parts.length ? parts.join(' / ') : '변경 없음';
  }

  // cur: 이번 주 업무일지 item 들(금주+차주), last: 지난주 보고서 item 들, opts.ref: 기준일(금주 금요일)
  // opts.fields: 화면에서 고친 분야 { taskKey: fieldId } (v1.1)
  function analyze(cur, last, opts) {
    opts = opts || {};
    var overrides = opts.fields || {};
    var ref = opts.ref ? (opts.ref instanceof Date ? opts.ref : toDate(opts.ref)) : defaultRef(new Date());
    var thisG = cluster(cur.filter(function (i) { return i.week === 'this'; }));
    var nextG = cluster(cur.filter(function (i) { return i.week === 'next'; }));
    // 지난주 보고서는 금주(실적)와 차주(계획)를 한 업무로 묶는다. 기한은 차주 계획 쪽이 더 새 값이다.
    var lastAll = (last || []).slice().sort(function (a, b) { return (a.week === 'next') - (b.week === 'next'); });
    var lastG = cluster(lastAll).map(function (g) {
      var plan = g.items.filter(function (i) { return i.week === 'next' && i.due; }).pop();
      if (plan) { g.due = plan.due; g.dueRaw = plan.dueRaw; g.dueGuess = plan.dueGuess; }
      g.done = g.items.some(isDone) && g.items.filter(function (i) { return i.week === 'this'; }).every(isDone);
      return g;
    });
    var mLast = match(thisG, lastG), mNext = match(thisG, nextG);
    var linkedNext = {}; Object.keys(mNext).forEach(function (k) { linkedNext[mNext[k].idx] = +k; });
    var changes = [], rows = [];

    thisG.forEach(function (g, i) {
      var L = mLast[i] ? lastG[mLast[i].idx] : null, N = mNext[i] ? nextG[mNext[i].idx] : null;
      var reasons = [], moved = 0;
      function change(from, to, basis) {
        if (!from || !to || fmt(from) === fmt(to)) return;
        var dd = days(from, to);
        changes.push({ task: g.task, members: g.members, from: from, to: to, days: dd, basis: basis, kind: dd > 0 ? '연기' : '당김' });
        if (dd > 0) { moved = Math.max(moved, dd); reasons.push('일정 변경 ' + md(from) + ' → ' + md(to) + ' (+' + dd + '일, ' + basis + ')'); }
      }
      if (L) change(L.due, g.due, '지난주 보고 대비');
      if (N && N.due && g.due) change(g.due, N.due, '차주 계획');
      else if (N && N.due && !g.due && L) change(L.due, N.due, '지난주 보고 대비');
      var overdue = !g.done && g.due && g.due < ref;
      if (overdue) reasons.unshift('기한 경과 (기한 ' + md(g.due) + ', 기준일 ' + md(ref) + ')');
      if (!g.done && g.statusDelay) reasons.push('상태: ' + g.status);
      var cat = g.done ? 'done' : (overdue || moved > 0 || g.statusDelay) ? 'delayed' : !L ? 'new' : 'ongoing';
      var own = changes.filter(function (c) { return c.task === g.task; });
      // 분야는 구분과 별개로 정한다 — 구분 판정식은 분야를 보지 않고, 분야 판정은 구분을 보지 않는다
      var field = withName(resolveField(g.names, g.body, { overrides: overrides, given: g.given, lastField: L ? L.given : '' }));
      rows.push({ cat: cat, label: CAT[cat], isNew: !L, task: g.task, names: g.names, members: g.members, merged: g.merged,
        progress: g.progress, due: g.due, dueRaw: g.dueRaw, dueGuess: g.dueGuess, status: g.status, issues: g.issues,
        reasons: reasons, overdue: !!overdue, field: field, key: taskKey(g.task), delta: deltaOf(g, L, reasons, own),
        decision: g.issues.filter(function (x) { return DECISION.test(x.text); }).map(function (x) { return x.text; }),
        last: L ? { task: L.task, due: L.due, score: mLast[i].score, progress: L.progress } : null,
        next: N ? { task: N.task, due: N.due, progress: N.progress } : null });
    });
    rows.sort(function (a, b) {
      return CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat) || a.members[0].localeCompare(b.members[0], 'ko') || 0;
    });

    // 지난주에 있었는데 이번 주 금주 일지에 없는 업무
    var usedLast = {}; Object.keys(mLast).forEach(function (k) { usedLast[mLast[k].idx] = 1; });
    var mLastNext = match(lastG.filter(function (g, j) { return !usedLast[j]; }), nextG.filter(function (g, j) { return linkedNext[j] == null; }));
    var restLast = lastG.filter(function (g, j) { return !usedLast[j]; });
    var missing = [];
    restLast.forEach(function (g, k) {
      if (g.done) missing.push({ task: g.task, members: g.members, due: g.due, kind: 'lastDone', note: '지난주 완료 — 이번 주 일지에서 빠진 것이 정상입니다' });
      else if (mLastNext[k]) missing.push({ task: g.task, members: g.members, due: g.due, kind: 'toNext', note: '이번 주 실적은 없고 차주 계획에 있습니다' });
      else missing.push({ task: g.task, members: g.members, due: g.due, kind: 'gone', note: '이번 주 일지에 없습니다 — 완료·중단 여부를 확인해 주세요' });
    });

    // 차주 계획
    var lastForNext = match(nextG, lastG);
    var plan = nextG.map(function (g, j) {
      var linked = linkedNext[j] != null, L2 = lastForNext[j] ? lastG[lastForNext[j].idx] : null;
      // 금주 업무와 이어지는 계획은 같은 분야다 — 한 업무가 두 분야에 나뉘어 세어지지 않는다
      var field = linked ? Object.assign({}, rows.filter(function (r) { return r.task === thisG[linkedNext[j]].task; })[0].field, { src: 'linked', reason: '금주 업무와 같은 분야' })
        : withName(resolveField(g.names, g.body, { overrides: overrides, given: g.given, lastField: L2 ? L2.given : '' }));
      return { task: g.task, names: g.names, members: g.members, merged: g.merged, progress: g.progress, due: g.due,
        dueRaw: g.dueRaw, dueGuess: g.dueGuess, issues: g.issues, field: field, key: taskKey(g.task),
        decision: g.issues.filter(function (x) { return DECISION.test(x.text); }).map(function (x) { return x.text; }),
        kind: linked ? '계속' : L2 ? '재개' : '신규 계획', soon: !!(g.due && days(ref, g.due) <= 7 && days(ref, g.due) >= 0) };
    }).sort(function (a, b) { return (a.due ? a.due.getTime() : 9e15) - (b.due ? b.due.getTime() : 9e15); });

    // 주요 이슈 — 같은 문장은 한 번만
    var issues = [], seen = {};
    function addIssue(src, g, it) {
      var k = taskKey(it.text);
      if (seen[k]) return; seen[k] = 1;
      issues.push({ week: src, task: g.task, member: it.member, text: it.text });
    }
    rows.forEach(function (r) { r.issues.forEach(function (it) { addIssue('금주', r, it); }); });
    plan.forEach(function (p) { p.issues.forEach(function (it) { addIssue('차주', p, it); }); });

    var counts = { total: rows.length, done: 0, ongoing: 0, new: 0, delayed: 0, next: plan.length,
      nextNew: plan.filter(function (p) { return p.kind === '신규 계획'; }).length,
      issues: issues.length, changes: changes.length, merged: rows.filter(function (r) { return r.merged; }).length + plan.filter(function (p) { return p.merged; }).length,
      gone: missing.filter(function (m) { return m.kind === 'gone'; }).length,
      members: uniq([].concat.apply([], cur.map(function (i) { return memberList(i.member); }))).length };
    rows.forEach(function (r) { counts[r.cat]++; });
    // 확인 필요 건수는 업무 단위 — 금주 업무와 이어지는 차주 계획은 같은 업무라 다시 세지 않는다
    counts.unsure = rows.filter(function (r) { return r.field.id === 'unsure'; }).length + plan.filter(function (p) { return p.field.id === 'unsure' && p.field.src !== 'linked'; }).length;
    counts.overdue = rows.filter(function (r) { return r.overdue; }).length;
    var from = monday(ref);
    var res = { ref: ref, period: { from: from, to: addDays(from, 4), nextFrom: addDays(from, 7), nextTo: addDays(from, 11) },
      rows: rows, plan: plan, changes: changes, issues: issues, missing: missing, counts: counts, hasLast: !!(last && last.length) };
    res.fields = byField(res);
    res.decisions = decisions(res);
    counts.decisions = res.decisions.length;
    return res;
  }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }

  /* ---------- 분야별 묶음 · 요약 · 종합 관리 (v1.1) ---------- */
  // 4개 분야(고정 순서) + 「분류 확인 필요」. 업무 하나는 정확히 한 묶음에만 들어간다.
  function byField(res) {
    return FIELDS.concat([UNSURE]).map(function (f) {
      var rows = res.rows.filter(function (r) { return r.field.id === f.id; });
      var plan = res.plan.filter(function (p) { return p.field.id === f.id; });
      var c = { total: rows.length, done: 0, ongoing: 0, new: 0, delayed: 0, plan: plan.length,
        overdue: rows.filter(function (r) { return r.overdue; }).length,
        issues: rows.reduce(function (n, r) { return n + r.issues.length; }, 0) + plan.reduce(function (n, p) { return n + p.issues.length; }, 0) };
      rows.forEach(function (r) { c[r.cat]++; });
      return { id: f.id, no: f.no, name: f.name, short: f.short, rows: rows, plan: plan, counts: c, empty: !rows.length && !plan.length, unsure: f.id === 'unsure' };
    });
  }
  // 팀장 확인·의사결정 필요사항 — 데이터에서 나온 것만: 분류 확인, 기한 경과 미완료, 지난주 업무 누락, 결재·승인·예산 낱말이 든 이슈
  function decisions(res) {
    var out = [];
    res.rows.forEach(function (r) {
      if (r.overdue) out.push({ kind: 'overdue', task: r.task, members: r.members, text: '기한 ' + md(r.due) + ' 경과, 미완료 — 일정 재설정 또는 조치 필요' });
      r.decision.forEach(function (t) { out.push({ kind: 'decision', task: r.task, members: r.members, text: t }); });
    });
    res.plan.forEach(function (p) { p.decision.forEach(function (t) { out.push({ kind: 'decision', task: p.task, members: p.members, text: t }); }); });
    res.missing.forEach(function (m) { if (m.kind === 'gone') out.push({ kind: 'gone', task: m.task, members: m.members, text: '지난주 보고서에 있었으나 이번 주 일지에 없음 — 완료·중단 여부 확인' }); });
    res.rows.concat(res.plan).forEach(function (r) {
      if (r.field.id === 'unsure' && !out.some(function (o) { return o.kind === 'unsure' && o.task === r.task; })) out.push({ kind: 'unsure', task: r.task, members: r.members, text: '업무 분야 확인 필요 — ' + r.field.reason });
    });
    return out;
  }
  // Ⅲ 종합 관리사항
  function management(res) {
    var by = function (k) { return res.rows.filter(function (r) { return r.cat === k; }); };
    return {
      done: by('done'), newRows: by('new'), changed: res.changes,
      overdue: res.rows.filter(function (r) { return r.overdue; }),
      gone: res.missing.filter(function (m) { return m.kind === 'gone'; }),
      decisions: res.decisions
    };
  }

  /* ---------- 보고서 초안 ---------- */
  function who(ms) { return ms.join('·'); }
  function list(arr, f, n) {
    n = n || 4;
    var s = arr.slice(0, n).map(f).join(', ');
    return arr.length > n ? s + ' 외 ' + (arr.length - n) + '건' : s;
  }
  // 규칙으로 만든 요약 문장. AI 는 이것을 다듬기만 한다.
  function draft(res) {
    var c = res.counts, lines = [];
    var parts = [];
    ['done', 'ongoing', 'new', 'delayed'].forEach(function (k) { if (c[k]) parts.push(CAT[k] + ' ' + c[k] + '건'); });
    lines.push('금주 업무 ' + c.total + '건(팀원 ' + c.members + '명)' + (parts.length ? ' 중 ' + parts.join(', ') : '') + '입니다.');
    var fl = (res.fields || byField(res)).filter(function (f) { return f.counts.total; });
    if (fl.length) lines.push('분야별 금주 업무: ' + fl.map(function (f) { return f.short + ' ' + f.counts.total + '건'; }).join(' · ') + '.');
    var by = function (k) { return res.rows.filter(function (r) { return r.cat === k; }); };
    if (by('done').length) lines.push('완료: ' + list(by('done'), function (r) { return r.task + '(' + who(r.members) + ')'; }) + '.');
    if (by('delayed').length) lines.push('지연: ' + list(by('delayed'), function (r) { return r.task + ' — ' + (r.reasons[0] || '지연'); }, 3) + '.');
    if (by('new').length) lines.push('신규: ' + list(by('new'), function (r) { return r.task + '(' + who(r.members) + ')'; }) + '.');
    if (res.issues.length) lines.push('주요 이슈 ' + res.issues.length + '건: ' + list(res.issues, function (i) { return i.text; }, 2) + '.');
    if (c.next) {
      var soon = res.plan.filter(function (p) { return p.soon; });
      lines.push('차주 계획 ' + c.next + '건' + (c.nextNew ? '(신규 ' + c.nextNew + '건)' : '') +
        (soon.length ? ', 1주 안 기한: ' + list(soon, function (p) { return p.task + ' ' + md(p.due); }, 3) : '') + '.');
    }
    if (c.merged) lines.push('비슷한 업무명 ' + c.merged + '건을 하나로 통합했습니다.');
    if (c.gone) lines.push('지난주 보고서에 있던 ' + c.gone + '건이 이번 주 일지에 없어 확인이 필요합니다.');
    if (c.unsure) lines.push('업무 분야를 정하지 못한 ' + c.unsure + '건은 「분류 확인 필요」에 두었습니다.');
    if (res.decisions && res.decisions.length) lines.push('팀장 확인·의사결정 필요 ' + res.decisions.length + '건입니다.');
    if (!res.hasLast) lines.push('지난주 보고서가 없어 모든 업무를 신규로 보았습니다.');
    var p = res.period;
    return { title: '주간업무보고 (' + fmt(p.from) + ' ~ ' + fmt(p.to) + ')', lines: lines };
  }

  /* ---------- 내보내기 ---------- */
  function joinProg(ps, multi) {
    return ps.map(function (p) { return (multi ? p.member + ': ' : '') + p.text; }).join(multi ? '\n' : ' / ');
  }
  function dueText(d, raw, guess) { return d ? fmt(d) + (guess ? '*' : '') : (raw || ''); }
  // 엑셀 시트(배열의 배열) — 화면 표와 같은 내용
  function sheets(res, dr) {
    dr = dr || draft(res);
    var o = {};
    o['보고서요약'] = [[dr.title], ['기준일', fmt(res.ref)], []].concat(dr.lines.map(function (l) { return [l]; }))
      .concat([[], ['* 표시 날짜는 연도가 없어 기준일 연도로 보충한 값입니다. 구분은 자동 판정입니다.']]);
    var fields = res.fields || byField(res), mg = management(res);
    o['전체요약'] = [['Ⅰ. 전체 업무 요약'], ['금주 업무', res.counts.total, '차주 계획', res.counts.next], []]
      .concat([['분야', '금주', '완료', '계속', '신규', '지연', '기한 경과', '차주 계획']])
      .concat(fields.map(function (f) { return [f.name, f.counts.total, f.counts.done, f.counts.ongoing, f.counts.new, f.counts.delayed, f.counts.overdue, f.counts.plan]; }))
      .concat([[], ['주요 일정 변경']]).concat(res.changes.map(function (c) { return [c.task, who(c.members), fmt(c.from) + ' → ' + fmt(c.to) + ' (' + (c.days > 0 ? '+' : '') + c.days + '일)', c.basis]; }))
      .concat([[], ['팀장 확인·의사결정 필요']]).concat(res.decisions.map(function (d) { return [DEC[d.kind], d.task, who(d.members), d.text]; }));
    o['업무별현황'] = [['구분(자동)', '분야', '분야 출처', '팀원', '업무명', '금주 추진현황', '일정/기한', '상태', '전주 대비 변경', '판정 사유', '지난주 업무명', '이슈', '통합']]
      .concat(res.rows.map(function (r) {
        return [r.label, r.field.name, SRC[r.field.src] || r.field.src, who(r.members), r.task, joinProg(r.progress, r.members.length > 1), dueText(r.due, r.dueRaw, r.dueGuess), r.status,
          r.delta, r.reasons.join(' / '), r.last ? r.last.task : '', r.issues.map(function (i) { return i.text; }).join(' / '), r.merged ? r.names.join(' + ') : ''];
      }));
    o['차주계획'] = [['구분', '분야', '팀원', '업무명', '차주 계획', '일정/기한', '1주 안 기한']].concat(res.plan.map(function (p) {
      return [p.kind, p.field.name, who(p.members), p.task, joinProg(p.progress, p.members.length > 1), dueText(p.due, p.dueRaw, p.dueGuess), p.soon ? '예' : ''];
    }));
    // 분야별 시트 — 금주 추진실적과 차주 추진계획을 한 시트에, 「구분」 열로 나눈다
    fields.forEach(function (f) {
      var head = ['주', '구분', '업무명', '담당자', '추진현황', '기한', '상태', '전주 대비 변경', '주요 이슈'];
      var body = f.rows.map(function (r) { return ['금주', r.label, r.task, who(r.members), joinProg(r.progress, r.members.length > 1), dueText(r.due, r.dueRaw, r.dueGuess), r.status, r.delta, r.issues.map(function (i) { return i.text; }).join(' / ')]; })
        .concat(f.plan.map(function (p) { return ['차주', p.kind, p.task, who(p.members), joinProg(p.progress, p.members.length > 1), dueText(p.due, p.dueRaw, p.dueGuess), '계획', p.soon ? '1주 안 기한' : '', p.issues.map(function (i) { return i.text; }).join(' / ')]; }));
      o[SHEET_FIELD[f.id]] = [[f.no + ' ' + f.name]].concat([head]).concat(body.length ? body : [['해당 기간 업무 없음']]);
    });
    o['종합관리'] = [['Ⅲ. 종합 관리사항'], ['항목', '업무명', '담당자', '내용']]
      .concat(mg.done.map(function (r) { return ['지난주 대비 완료', r.task, who(r.members), joinProg(r.progress, false)]; }))
      .concat(mg.newRows.map(function (r) { return ['신규 발생', r.task, who(r.members), dueText(r.due, r.dueRaw, r.dueGuess)]; }))
      .concat(mg.changed.map(function (c) { return ['기한 변경', c.task, who(c.members), fmt(c.from) + ' → ' + fmt(c.to) + ' (' + c.basis + ')']; }))
      .concat(mg.overdue.map(function (r) { return ['기한 경과 미완료', r.task, who(r.members), '기한 ' + fmt(r.due) + ' · ' + r.status]; }))
      .concat(mg.gone.map(function (m) { return ['지난주 보고에 있으나 누락', m.task, who(m.members), m.note]; }))
      .concat(mg.decisions.map(function (d) { return ['팀장 확인·의사결정', d.task, who(d.members), d.text]; }));
    o['일정변경'] = [['업무명', '팀원', '이전', '변경', '일수', '종류', '비교 기준']].concat(res.changes.map(function (c) {
      return [c.task, who(c.members), fmt(c.from), fmt(c.to), c.days, c.kind, c.basis];
    }));
    o['주요이슈'] = [['구분', '업무명', '팀원', '이슈']].concat(res.issues.map(function (i) { return [i.week, i.task, i.member, i.text]; }));
    o['지난주대비_빠진업무'] = [['업무명', '팀원', '지난주 기한', '확인']].concat(res.missing.map(function (m) { return [m.task, who(m.members), fmt(m.due), m.note]; }));
    o['다음주_지난주용'] = [HEAD].concat(toLastWeek(res).map(function (r) { return HEAD.map(function (h) { return r[h]; }); }));
    return o;
  }
  var SRC = { user: '화면에서 고침', doc: '일지 분야 열', last: '지난주 분야', auto: '자동', unsure: '확인 필요', linked: '금주 업무와 같음' };
  var DEC = { overdue: '기한 경과', decision: '의사결정', gone: '누락 확인', unsure: '분류 확인' };
  var SHEET_FIELD = { welfare: '분야_복리후생총무', social: '분야_사회공헌의전', asset: '분야_자산', emergency: '분야_비상계획', unsure: '분야_확인필요' };
  // v1.1: 「분야」 열이 붙었다. 분야 열이 없는 옛 파일도 그대로 읽는다(자동 분류).
  var HEAD = ['구분', '팀원', '업무명', '추진현황', '일정/기한', '상태', '이슈', '분야'];
  // 이번 주 결과를 다음 주에 「지난주 보고서」로 다시 읽을 수 있는 줄로 바꾼다(같은 양식).
  // 분야도 적어 두므로 다음 주에 같은 업무가 이어지면 그 분야를 먼저 쓴다(「분류 확인 필요」는 비워 둔다).
  function toLastWeek(res) {
    var out = [];
    function fname(f) { return f && f.id !== 'unsure' ? f.name : ''; }
    res.rows.forEach(function (r) {
      out.push({ 구분: '금주', 팀원: r.members.join(', '), 업무명: r.task, 추진현황: joinProg(r.progress, false),
        '일정/기한': r.due ? fmt(r.due) : r.dueRaw, 상태: r.cat === 'done' ? '완료' : (r.status || r.label), 이슈: r.issues.map(function (i) { return i.text; }).join(' / '), 분야: fname(r.field) });
    });
    res.plan.forEach(function (p) {
      out.push({ 구분: '차주', 팀원: p.members.join(', '), 업무명: p.task, 추진현황: joinProg(p.progress, false),
        '일정/기한': p.due ? fmt(p.due) : p.dueRaw, 상태: '계획', 이슈: p.issues.map(function (i) { return i.text; }).join(' / '), 분야: fname(p.field) });
    });
    return out;
  }
  var SAVE_KIND = 'build-2611-10/weekly-report';
  // fields: 화면에서 고친 분야 { taskKey: fieldId } — 다음 주에도 같은 업무명이면 그 분류를 먼저 쓴다
  function saveObject(res, fields) {
    return { kind: SAVE_KIND, version: 2, period: { from: fmt(res.period.from), to: fmt(res.period.to) }, ref: fmt(res.ref), rows: toLastWeek(res), fields: fields || {} };
  }
  // 저장해 둔 JSON 을 「지난주 보고서」 줄로 되돌린다. v1 저장본(분야 없음)도 읽는다.
  function fromSaved(obj) {
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { return null; } }
    if (!obj || obj.kind !== SAVE_KIND || !Array.isArray(obj.rows)) return null;
    if (!obj.fields || typeof obj.fields !== 'object') obj.fields = {};
    return obj;
  }
  // 화면에서 고친 분야를 합친다(뒤의 것이 이긴다). 값이 분야 id 가 아니면 버린다.
  function mergeFields() {
    var out = {};
    Array.prototype.forEach.call(arguments, function (m) {
      if (!m || typeof m !== 'object') return;
      Object.keys(m).forEach(function (k) { if (k && fieldById(m[k]) ) out[k] = m[k]; });
    });
    return out;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function br(s) { return esc(s).replace(/\n/g, '<br>'); }
  // 분야 표 한 장 — 금주(실적)·차주(계획) 공용. 열: 구분 · 업무명 · 담당자 · 추진현황 · 기한 · 상태 · 전주 대비 변경 · 주요 이슈
  var FIELD_COLS = ['구분', '업무명', '담당자', '추진현황', '기한', '상태', '전주 대비 변경', '주요 이슈'];
  function fieldTableHtml(items, week) {
    if (!items.length) return '<p class="none">해당 기간 업무 없음</p>';
    return '<table class="ft ' + (week === 'this' ? 'ft-this' : 'ft-next') + '"><thead><tr>' + FIELD_COLS.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
      items.map(function (r) {
        var isThis = week === 'this';
        var cls = isThis ? 'c-' + r.cat + (r.overdue ? ' overdue' : '') : (r.soon ? ' soon' : '');
        var label = isThis ? r.label : r.kind, status = isThis ? r.status : '계획';
        var delta = isThis ? r.delta : (r.soon ? '1주 안 기한' : '');
        var iss = r.issues.map(function (i) { return i.text; }).concat(isThis ? r.reasons.filter(function (x) { return /기한 경과/.test(x); }) : []);
        return '<tr class="' + cls + '"><td class="tag">' + esc(label) + '</td><td>' + esc(r.task) + (r.merged ? ' <small>(통합 ' + r.names.length + ')</small>' : '') + '</td><td>' + esc(who(r.members)) + '</td><td>' +
          br(joinProg(r.progress, r.members.length > 1)) + '</td><td class="due">' + esc(dueText(r.due, r.dueRaw, r.dueGuess)) + '</td><td>' + esc(status) + '</td><td>' + esc(delta) + '</td><td>' + br(iss.join('\n')) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  // 인쇄용 HTML 문서 한 장(팀장 보고용) — Ⅰ 전체 업무 요약 · Ⅱ 분야별 주간업무보고(4개 고정) · Ⅲ 종합 관리사항.
  // aiLines 가 있으면 요약 문장 자리에 넣고 「AI 다듬음 — 검토 필요」를 붙인다.
  function printHtml(res, dr, opts) {
    dr = dr || draft(res); opts = opts || {};
    var sum = opts.aiLines && opts.aiLines.length ? opts.aiLines : dr.lines;
    var fields = res.fields || byField(res), mg = management(res), h = [];
    h.push('<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>' + esc(dr.title) + '</title><style>' +
      'body{font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#152232;margin:28px;font-size:12px;line-height:1.5;word-break:keep-all;overflow-wrap:break-word}' +
      'h1{font-size:19px;margin:0 0 4px}h2{font-size:14.5px;margin:22px 0 8px;border-bottom:2px solid #154b6e;padding-bottom:3px;break-after:avoid}' +
      'h3{font-size:12.5px;margin:12px 0 4px;break-after:avoid}h3.wk{display:inline-block;padding:2px 9px;border-radius:4px;background:#eef2f6}h3.wk-next{background:#e9f1ea}' +
      '.meta{color:#5b6b7b;margin-bottom:10px}table{border-collapse:collapse;width:100%;margin:4px 0}th,td{border:1px solid #b9c5d1;padding:4px 6px;text-align:left;vertical-align:top}' +
      'th{background:#eef2f6;font-size:11.5px}thead{display:table-header-group}tr{break-inside:avoid}ul{margin:4px 0 0 18px;padding:0}.tag{font-weight:700;white-space:nowrap}' +
      '.c-delayed .tag{color:#b0261a}.c-new .tag{color:#0b6e99}.c-done .tag{color:#0a6045}tr.overdue td.due{color:#b0261a;font-weight:700}tr.overdue{background:#fdf3f1}tr.c-delayed{background:#fff8f6}' +
      '.ft-next tbody{background:#fafdfa}.field{margin-top:14px;padding-top:4px;border-top:3px solid #154b6e;break-inside:auto}.field h2{border-bottom:1px solid #b9c5d1;margin-top:6px}' +
      '.field.unsure{border-top-color:#b0261a}.none{color:#5b6b7b;margin:4px 0 8px;font-style:normal}.sumgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:6px 0 10px}' +
      '.sumgrid div{border:1px solid #b9c5d1;border-radius:6px;padding:5px 8px}.sumgrid b{display:block;font-size:16px}.dec li{margin:2px 0}.kind{font-weight:700;color:#7a1a0c;margin-right:4px}' +
      '.ai{font-size:11px;font-weight:700;background:#efe7fb;color:#4a2e86;border-radius:4px;padding:1px 6px;margin-left:6px}.foot{color:#5b6b7b;font-size:11px;margin-top:16px}' +
      '@page{size:A4;margin:12mm}@media print{body{margin:0}.sumgrid{display:block}.sumgrid div{display:inline-block;width:23%;margin:1%}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>');
    h.push('<h1>' + esc(dr.title) + '</h1><div class="meta">기준일 ' + fmt(res.ref) + (opts.team ? ' · ' + esc(opts.team) : '') + ' · 차주 ' + fmt(res.period.nextFrom) + ' ~ ' + fmt(res.period.nextTo) + '</div>');

    // Ⅰ
    var c = res.counts;
    h.push('<h2>Ⅰ. 전체 업무 요약' + (opts.aiLines && opts.aiLines.length ? '<span class="ai">AI 다듬음 — 검토 필요</span>' : '') + '</h2>');
    h.push('<div class="sumgrid"><div><b>' + c.total + '</b>금주 업무</div><div><b>' + c.done + '</b>완료</div><div><b>' + (c.ongoing + c.new) + '</b>진행(계속 ' + c.ongoing + ' · 신규 ' + c.new + ')</div><div><b>' + c.delayed + '</b>지연(기한 경과 ' + c.overdue + ')</div></div>');
    h.push('<h3>분야별 업무 건수</h3><table><thead><tr><th>분야</th><th>금주</th><th>완료</th><th>계속</th><th>신규</th><th>지연</th><th>기한 경과</th><th>차주 계획</th></tr></thead><tbody>' +
      fields.map(function (f) { return '<tr' + (f.unsure ? ' class="c-delayed"' : '') + '><td class="tag">' + esc(f.no + ' ' + f.name) + '</td><td>' + f.counts.total + '</td><td>' + f.counts.done + '</td><td>' + f.counts.ongoing + '</td><td>' + f.counts.new + '</td><td>' + f.counts.delayed + '</td><td>' + f.counts.overdue + '</td><td>' + f.counts.plan + '</td></tr>'; }).join('') +
      '<tr><th>합계</th><th>' + c.total + '</th><th>' + c.done + '</th><th>' + c.ongoing + '</th><th>' + c.new + '</th><th>' + c.delayed + '</th><th>' + c.overdue + '</th><th>' + c.next + '</th></tr></tbody></table>');
    h.push('<h3>요약</h3><ul>' + sum.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>');
    h.push('<h3>주요 일정 변경사항</h3>' + (res.changes.length ? '<ul>' + res.changes.map(function (x) { return '<li>' + esc(x.task) + ' (' + esc(who(x.members)) + ') ' + fmt(x.from) + ' → ' + fmt(x.to) + ' (' + (x.days > 0 ? '+' : '') + x.days + '일, ' + esc(x.kind) + ', ' + esc(x.basis) + ')</li>'; }).join('') + '</ul>' : '<p class="none">일정이 바뀐 업무 없음</p>'));
    h.push('<h3>팀장 확인 및 의사결정 필요사항</h3>' + (res.decisions.length ? '<ul class="dec">' + res.decisions.map(function (d) { return '<li><span class="kind">[' + DEC[d.kind] + ']</span>' + esc(d.task) + ' (' + esc(who(d.members)) + ') — ' + esc(d.text) + '</li>'; }).join('') + '</ul>' : '<p class="none">없음</p>'));

    // Ⅱ
    h.push('<h2>Ⅱ. 분야별 주간업무보고</h2>');
    fields.forEach(function (f, i) {
      if (f.unsure && f.empty) return;                                   // 확인 필요가 없으면 그 절은 두지 않는다. 4개 분야는 비어도 둔다.
      h.push('<section class="field' + (f.unsure ? ' unsure' : '') + '"><h2>' + (f.unsure ? '※ ' : (i + 1) + '. ') + esc(f.name) +
        ' <small>금주 ' + f.counts.total + '건 · 차주 ' + f.counts.plan + '건' + (f.counts.delayed ? ' · 지연 ' + f.counts.delayed : '') + '</small></h2>');
      if (f.unsure) h.push('<p class="none">자동 분류가 확실하지 않은 업무입니다. 화면에서 분야를 정해 주세요.</p>');
      h.push('<h3 class="wk">금주 주요 추진실적 (' + fmt(res.period.from) + ' ~ ' + fmt(res.period.to) + ')</h3>' + fieldTableHtml(f.rows, 'this'));
      h.push('<h3 class="wk wk-next">차주 추진계획 (' + fmt(res.period.nextFrom) + ' ~ ' + fmt(res.period.nextTo) + ')</h3>' + fieldTableHtml(f.plan, 'next'));
      h.push('</section>');
    });

    // Ⅲ
    function li(arr, f) { return arr.length ? '<ul>' + arr.map(f).join('') + '</ul>' : '<p class="none">없음</p>'; }
    h.push('<h2>Ⅲ. 종합 관리사항</h2>');
    h.push('<h3>1. 지난주 대비 완료된 업무</h3>' + li(mg.done, function (r) { return '<li>' + esc(r.task) + ' (' + esc(who(r.members)) + ') — ' + esc(joinProg(r.progress, false)) + '</li>'; }));
    h.push('<h3>2. 신규 발생 업무</h3>' + li(mg.newRows, function (r) { return '<li>' + esc(r.task) + ' (' + esc(who(r.members)) + ') — 기한 ' + esc(dueText(r.due, r.dueRaw, r.dueGuess) || '미정') + '</li>'; }));
    h.push('<h3>3. 기한이 변경된 업무</h3>' + li(mg.changed, function (x) { return '<li>' + esc(x.task) + ' (' + esc(who(x.members)) + ') ' + fmt(x.from) + ' → ' + fmt(x.to) + ' (' + (x.days > 0 ? '+' : '') + x.days + '일, ' + esc(x.basis) + ')</li>'; }));
    h.push('<h3>4. 기한이 지났으나 완료되지 않은 업무</h3>' + li(mg.overdue, function (r) { return '<li>' + esc(r.task) + ' (' + esc(who(r.members)) + ') — 기한 ' + fmt(r.due) + ', ' + esc(r.status || '미완료') + '</li>'; }));
    h.push('<h3>5. 지난주 보고서에는 있으나 이번 주 업무일지에서 누락된 업무</h3>' + li(mg.gone, function (m) { return '<li>' + esc(m.task) + ' (' + esc(who(m.members)) + (m.due ? ', 기한 ' + fmt(m.due) : '') + ')</li>'; }));
    h.push('<h3>6. 팀장 확인 또는 의사결정이 필요한 사항</h3>' + li(mg.decisions, function (d) { return '<li><span class="kind">[' + DEC[d.kind] + ']</span>' + esc(d.task) + ' — ' + esc(d.text) + '</li>'; }));
    h.push('<div class="foot">구분은 지난주 보고서와 비교한 자동 판정, 분야는 업무명·추진현황·이슈의 낱말로 자동 분류한 값입니다(화면에서 고친 것은 그대로). 숫자는 올린 자료에서만 세었습니다. * 표시 날짜는 연도를 기준일 연도로 보충했습니다. 제출 전 내용을 확인해 주세요.</div></body></html>');
    return h.join('');
  }

  /* ---------- AI (선택) ---------- */
  var AI = {
    openai: { model: 'gpt-4o-mini', url: 'https://api.openai.com/v1/chat/completions' },
    anthropic: { model: 'claude-haiku-5-5', url: 'https://api.anthropic.com/v1/messages' }
  };
  function aiPrompt(res, dr) {
    dr = dr || draft(res);
    var system = '당신은 팀장에게 올릴 주간업무보고의 「핵심 추진사항 요약」 문장을 다듬는 편집자입니다. ' +
      '주어진 사실만 쓰고 숫자·날짜·업무명·담당자를 바꾸거나 새로 만들지 마세요. ' +
      '보고서 문체(~함, ~예정, ~필요)로 한 줄에 한 항목, 5~7줄, 각 줄은 「- 」로 시작합니다. 머리말·맺음말 없이 줄만 출력하세요.';
    var facts = dr.lines.map(function (l) { return '- ' + l; }).join('\n') + '\n\n[업무별]\n' +
      res.rows.map(function (r) { return '- [' + r.label + '] ' + r.task + ' (' + who(r.members) + ') ' + joinProg(r.progress, false) + (r.reasons.length ? ' / ' + r.reasons.join(', ') : ''); }).join('\n');
    return { system: system, user: '다음 규칙 기반 초안을 다듬어 주세요.\n\n' + facts };
  }
  function aiRequest(provider, key, prompt) {
    var p = AI[provider];
    if (!p) throw new Error('알 수 없는 제공자: ' + provider);
    if (provider === 'openai') {
      return { url: p.url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: p.model, temperature: 0.2, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] }) } };
    }
    return { url: p.url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: p.model, max_tokens: 1024, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] }) } };
  }
  // 응답에서 줄만 뽑는다
  function aiLines(provider, json) {
    var t = '';
    if (provider === 'openai') t = json && json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : '';
    else t = json && json.content ? json.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n') : '';
    return String(t || '').split(/\r?\n/).map(function (l) { return l.replace(/^\s*[-*•·]\s*|^\s*\d+[.)]\s*/, '').trim(); }).filter(Boolean);
  }

  /* ---------- 파일·시트 나누기 ---------- */
  var NOT_NAME = ['업무일지', '주간보고', '주간업무', '보고서', '일지', '업무', '금주', '차주', '지난주', '전주', '시트', '양식', '예제', '계획', '실적', '현황'];
  // 파일 이름·시트 이름에서 팀원 이름(한글 2~4자)을 짐작한다. 「업무일지_김민준.xlsx」 → 김민준
  function guessMember(name) {
    var t = String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[\d\s._\-()\[\]]+$/g, '');
    var m = t.match(/(?:^|[_\-\s.])([가-힣]{2,4})$/);
    if (!m || NOT_NAME.some(function (w) { return m[1].indexOf(w) >= 0 || w.indexOf(m[1]) >= 0; })) return '';
    return m[1];
  }
  // 통합문서의 시트를 어디에 쓸지 정한다.
  //   target='cur' : 「지난주·전주」 시트는 지난주 보고서로, 「금주」「차주」 시트는 그 구분으로, 그 밖은 구분 열을 따른다.
  //   target='last': 이 도구가 내보낸 「다음주_지난주용」 시트가 있으면 그것만, 없으면 「지난주」 이름 시트, 그것도 없으면 전부.
  //   요약·안내 시트는 건너뛴다.
  // hnorm 이 「_」를 지우므로 분야 시트는 「분야자산」 꼴로 들어온다
  var SKIP_SHEET = /요약|안내|readme|설명|보고서요약|일정변경|주요이슈|빠진업무|업무별현황|차주계획$|^분야(복리후생총무|사회공헌의전|자산|비상계획|확인필요)$|종합관리|전체요약/i;
  function routeSheets(names, target) {
    var nn = names.map(function (n) { return hnorm(n); });
    if (target === 'last') {
      var own = names.filter(function (n, i) { return nn[i] === hnorm('다음주_지난주용'); });
      var lw = names.filter(function (n, i) { return /지난주|전주/.test(nn[i]); });
      var use = own.length ? own : lw.length ? lw : names.filter(function (n) { return !SKIP_SHEET.test(hnorm(n)); });
      return names.map(function (n) {
        var w = own.indexOf(n) >= 0 ? '' : parseWeek(n);
        return { name: n, role: use.indexOf(n) >= 0 ? 'last' : 'skip', week: w === 'this' || w === 'next' ? w : '', member: guessMember(n) };
      });
    }
    return names.map(function (n, i) {
      if (/지난주|전주/.test(nn[i]) && !/지난주용/.test(nn[i])) return { name: n, role: 'last', week: '', member: '' };
      if (SKIP_SHEET.test(nn[i]) || /지난주용/.test(nn[i])) return { name: n, role: 'skip', week: '', member: '' };
      var w = parseWeek(n);
      return { name: n, role: 'cur', week: w === 'this' || w === 'next' ? w : '', member: guessMember(n) };
    });
  }

  /* ---------- 예제 (가짜 팀원 5명 · 실제 사내 데이터가 아닙니다) ----------
   * v1.1: 4개 분야가 모두 나오고 「분류 확인 필요」 2건(낱말이 두 분야에 같은 점수 · 낱말 없음)이 섞이도록 다시 만들었다.
   * 분야 열은 일부러 두지 않았다 — 자동 분류가 도는 것을 보여 주기 위해서다. */
  function sample() {
    var R = function (a) { return { 구분: a[0], 팀원: a[1], 업무명: a[2], 추진현황: a[3], '일정/기한': a[4], 상태: a[5], 이슈: a[6] || '' }; };
    var last = [
      ['금주', '김민준', '울산공장 견학 일정조율', '협력사 3곳 견학 희망일 접수', '11/6', '진행중'],
      ['금주', '김민준', '인천 견학 실적 집계(10월)', '10월 견학 12회·방문객 248명 집계', '10/30', '완료'],
      ['금주', '이서연', '통근버스 노선 개편', '이용 수요조사 설문 배포', '11/4', '진행중', '야간조 응답 저조'],
      ['금주', '이서연', '10월 기념품 불출 대장 정리', '불출 내역 엑셀 정리 중', '10/31', '진행중'],
      ['금주', '박지훈', '11월 임원 간담회 준비', '장소 후보 2곳 섭외', '11/13', '진행중'],
      ['금주', '최유진', '하반기 소방대피훈련 실시', '훈련 시나리오 초안 작성', '11/7', '진행중'],
      ['금주', '정하늘', '법인차량 정기점검', '3대 중 1대 점검 완료', '11/5', '진행중'],
      ['금주', '정하늘', '사무실 이전 견적 비교', '견적 2건 접수', '11/20', '진행중'],
      ['차주', '김민준', '울산공장 견학 일정조율', '견학 일정 확정 통보', '11/6', '계획'],
      ['차주', '이서연', '통근버스 노선 개편', '설문 집계, 노선안 작성', '11/4', '계획'],
      ['차주', '박지훈', '11월 임원 간담회 준비', '장소 확정', '11/13', '계획'],
      ['차주', '최유진', '하반기 소방대피훈련 실시', '훈련 공지', '11/7', '계획'],
      ['차주', '정하늘', '법인차량 정기점검', '나머지 2대 점검', '11/5', '계획']
    ].map(R);
    var cur = [
      ['금주', '김민준', '울산 공장견학 일정 조율', '협력사 3곳 중 2곳 일정 확정, 1곳 회신 대기', '11/13', '진행중', '1곳 담당자 회신 지연'],
      ['금주', '김민준', '견학 안내 문구 정비(주차·준비물)', '자주 묻는 질문 초안 15문항 작성', '11/12', '진행중'],
      ['금주', '이서연', '통근버스 노선 개편', '설문 결과 집계(응답 82%), 노선안 2개 작성', '11/4', '완료'],
      ['금주', '이서연', '기념품 재고 실사', '품목 18종 중 12종 실사', '11/5', '진행중', '일부 품목 장부와 수량 불일치'],
      ['금주', '박지훈', '임원간담회 준비(11월)', '장소 확정, 참석자 명단 취합 중', '11/13', '진행중'],
      ['금주', '정하늘', '11월 임원간담회 준비', '참석자 차량 배차 계획 작성', '11/13', '진행중'],
      ['금주', '최유진', '하반기 소방대피훈련 실시', '훈련 공지 완료, 11/7 시행 예정', '11/7', '진행중'],
      ['금주', '최유진', '비상연락망 현행화', '부서별 연락처 취합(5개 부서 중 3개)', '11/20', '진행중', '외주 인력 포함 여부 결정 필요'],
      ['금주', '정하늘', '법인차량 정기점검', '3대 점검 완료', '11/5', '완료'],
      ['금주', '정하늘', '사무실 이전 견적 비교', '견적 3건 비교표 작성', '11/27', '진행중', '업체 1곳 현장실사 일정 연기'],
      ['금주', '박지훈', '방문객 휴게실 비품 교체', '교체 품목 정리, 견적 접수', '11/13', '진행중'],
      ['금주', '최유진', '팀 업무분장표 갱신', '초안 작성', '11/27', '진행중'],
      ['차주', '김민준', '울산 공장견학 일정 조율', '남은 1곳 확정, 방문객 명단 접수', '11/13', ''],
      ['차주', '김민준', '11월 인천·울산 견학 실적 집계', '사업장 통합 실적표 작성', '11/30', ''],
      ['차주', '이서연', '기념품 재고 실사', '수량 불일치 품목 재확인', '11/10', ''],
      ['차주', '박지훈', '11월 임원 간담회 준비', '간담회 진행(11/13) 및 결과 정리', '11/13', ''],
      ['차주', '최유진', '비상연락망 현행화', '나머지 2개 부서 취합, 전사 공지', '11/20', ''],
      ['차주', '정하늘', '사무실 이전 견적 비교', '현장실사 후 업체 선정', '11/27', ''],
      ['차주', '박지훈', '방문객 휴게실 비품 교체', '비품 발주', '11/13', ''],
      ['차주', '정하늘', '동절기 시설물 점검(난방·배관)', '점검표 작성, 1차 점검', '11/20', '']
    ].map(R);
    return { ref: '2026-11-06', current: cur, last: last };
  }

  var api = { parseDate: parseDate, toDate: toDate, fmt: fmt, md: md, monday: monday, defaultRef: defaultRef,
    parseText: parseText, normalize: normalize, taskKey: taskKey, similarity: similarity, cluster: cluster, match: match,
    isDone: isDone, analyze: analyze, draft: draft, sheets: sheets, toLastWeek: toLastWeek, saveObject: saveObject, fromSaved: fromSaved,
    printHtml: printHtml, guessMember: guessMember, routeSheets: routeSheets, aiPrompt: aiPrompt, aiRequest: aiRequest, aiLines: aiLines, sample: sample,
    // v1.1 분야
    classifyText: classifyText, resolveField: resolveField, parseField: parseField, fieldById: fieldById, byField: byField, decisions: decisions,
    management: management, mergeFields: mergeFields, fieldTableHtml: fieldTableHtml,
    FIELDS: FIELDS, UNSURE: UNSURE, FIELD_IDS: FIELD_IDS, FIELD_MARGIN: FIELD_MARGIN, FIELD_TASK_W: FIELD_TASK_W, FIELD_BODY_W: FIELD_BODY_W, SRC: SRC, DEC: DEC, SHEET_FIELD: SHEET_FIELD, FIELD_COLS: FIELD_COLS,
    ALIASES: ALIASES, CAT: CAT, HEAD: HEAD, AI: AI, SAVE_KIND: SAVE_KIND, CLUSTER_TH: CLUSTER_TH, MATCH_TH: MATCH_TH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Report = api;
})(this);
