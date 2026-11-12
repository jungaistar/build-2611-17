/* 판정 규칙 고정 — node test/logic.test.js
 * 보고서가 틀리면 팀장이 틀린 판단을 한다. 구분·통합·일정 변경·이슈를 손으로 정한 값과 대조한다. */
'use strict';
var R = require('../js/report.js');
var passed = 0, failed = 0;
function ok(c, label, detail) { if (c) passed++; else { failed++; console.log('  X ' + label + (detail ? '\n      ' + detail : '')); } }
function eq(g, w, label) { ok(JSON.stringify(g) === JSON.stringify(w), label, '기대: ' + JSON.stringify(w) + '  실제: ' + JSON.stringify(g)); }
var REF = R.toDate('2026-11-06');

// 날짜
eq(R.fmt(R.toDate('2026-11-06')), '2026-11-06', 'ISO 날짜');
eq(R.fmt(R.toDate('2026년 11월 6일')), '2026-11-06', '한글 날짜');
eq(R.fmt(R.toDate(46332)), '2026-11-06', '엑셀 일련번호');
eq([R.fmt(R.parseDate('11/6', REF).date), R.parseDate('11/6', REF).guess], ['2026-11-06', true], '연도 없는 날짜는 기준일 연도로 보충하고 표시한다');
eq(R.fmt(R.toDate('1/8', REF)), '2027-01-08', '연말 기준일에서 1월은 다음 해');
eq(R.fmt(R.toDate('11/3~11/7', REF)), '2026-11-07', '기간은 끝 날짜를 기한으로');
eq(R.fmt(R.toDate('11월 13일', REF)), '2026-11-13', '「11월 13일」');
eq(R.toDate('2/30', REF), null, '없는 날짜는 거른다');
eq(R.fmt(R.defaultRef(new Date(2026, 10, 3))), '2026-11-06', '기준일 기본값은 그 주 금요일');

// 업무명 유사도
eq(R.similarity('울산공장 견학 일정조율', '울산 공장견학 일정 조율'), 1, '띄어쓰기만 다르면 같은 업무');
ok(R.similarity('11월 임원 간담회 준비', '임원간담회 준비(11월)') >= 0.75, '어순·괄호가 달라도 같은 업무', R.similarity('11월 임원 간담회 준비', '임원간담회 준비(11월)'));
ok(R.similarity('기념품 입고 정리', '기념품 재고 실사') < 0.6, '앞말만 같은 다른 업무는 묶지 않는다', R.similarity('기념품 입고 정리', '기념품 재고 실사'));
ok(R.similarity('10월 실적 집계', '11월 실적 집계') < 0.6, '숫자(월)가 다르면 다른 업무', R.similarity('10월 실적 집계', '11월 실적 집계'));
ok(R.similarity('보안교육', '하반기 보안교육 실시') >= 0.85, '한쪽이 다른 쪽을 품으면 같은 업무');
eq(R.taskKey('[긴급] 견학 관련 업무'), '긴급견학', '군더더기(관련·업무·괄호) 제거');

// 붙여넣은 텍스트
var t = R.parseText('팀원\t업무명\t추진현황\t일정/기한\t상태\t이슈\n금주\n김민준\t견학 일정\t"2곳 확정\n1곳 대기"\t11/13\t진행중\t-\n차주\n김민준\t견학 일정\t나머지 확정\t11/13\t\t');
eq(t.rows.length, 2, '탭 표 2줄');
eq([t.rows[0]['구분'], t.rows[1]['구분']], ['금주', '차주'], '「금주」「차주」 줄이 아래 줄의 구분이 된다');
eq(t.rows[0]['추진현황'], '2곳 확정\n1곳 대기', '따옴표 안 줄바꿈은 한 칸');
var md = R.parseText('팀원: 이서연\n| 업무명 | 추진현황 | 기한 | 상태 |\n|---|---|---|---|\n| 재고 실사 | 12종 | 11/5 | 진행중 |');
eq([md.rows.length, md.rows[0]['팀원'], md.rows[0]['업무명']], [1, '이서연', '재고 실사'], '마크다운 표 + 「팀원:」 줄');
ok(R.parseText('그냥 메모입니다').issues.some(function (s) { return /머리글/.test(s); }), '머리글이 없으면 알린다');

// 정규화
var n = R.normalize([{ 담당자: '박지훈 님', 과제: '간담회', 진행내용: '장소 확정', 마감일: '11/13', 진행상태: '진행중', 비고: '없음' },
  { 팀원: '', 업무명: '이름 없는 줄', 추진현황: 'x' }, { 팀원: '최', 업무명: '', 추진현황: '내용만' }, {}], { ref: REF });
eq([n.items.length, n.items[0].member, n.items[0].issue], [2, '박지훈', ''], '열 이름 별칭·「님」 제거·「없음」은 이슈 아님');
eq(n.issues.length, 2, '팀원 빈 줄·업무명 빈 줄을 알리고 빈 줄은 조용히 넘긴다');
var wide = R.normalize([{ 팀원: '정하늘', 업무명: '차량 점검', 금주실적: '3대 완료', 차주계획: '보험 갱신', 일정: '11/5', 상태: '완료' }], { ref: REF });
eq(wide.items.map(function (i) { return i.week + ':' + i.progress; }), ['this:3대 완료', 'next:보험 갱신'], '「금주 실적 · 차주 계획」 한 줄 양식은 두 줄로 나눈다');
eq(R.normalize([{ 구분: '기타', 팀원: 'a', 업무명: 'b' }]).issues.length, 1, '모르는 구분 값은 알린다');
eq([R.isDone({ status: '완료' }), R.isDone({ status: '완료 예정' }), R.isDone({ status: '', pct: 100 }), R.isDone({ status: '미완료' })], [true, false, true, false], '완료 판정');

// 구분 판정 — 한 줄씩 손으로 만든 사례
function mk(week, member, task, due, status, issue) { return { 구분: week, 팀원: member, 업무명: task, 추진현황: task + ' 진행', '일정/기한': due, 상태: status || '진행중', 이슈: issue || '' }; }
function run(cur, last) { return R.analyze(R.normalize(cur, { ref: REF }).items, R.normalize(last, { ref: REF }).items, { ref: REF }); }
var a = run([mk('금주', 'A', '견학 일정 조율', '11/13'), mk('금주', 'B', '재고 실사', '11/5'), mk('금주', 'C', '차량 점검', '11/5', '완료'),
  mk('금주', 'D', '보안교육', '11/7'), mk('금주', 'E', '안내문 정비', '11/12'), mk('금주', 'D', '처방 점검', '11/20', '보류')],
[mk('차주', 'A', '견학 일정 조율', '11/6'), mk('금주', 'C', '차량 점검', '11/5'), mk('금주', 'D', '보안교육', '11/7'), mk('금주', 'B', '재고 실사', '11/5'),
  mk('금주', 'D', '처방 점검', '11/20'), mk('금주', 'E', '대장 정리', '10/31')]);
function cat(task) { return a.rows.filter(function (r) { return r.task === task; })[0].cat; }
eq(cat('견학 일정 조율'), 'delayed', '기한이 뒤로 밀리면 지연');
eq(cat('재고 실사'), 'delayed', '기한이 기준일보다 앞서고 미완료면 지연(기한 경과)');
eq(cat('차량 점검'), 'done', '상태 「완료」는 기한이 지났어도 완료');
eq(cat('보안교육'), 'ongoing', '기한이 기준일 이후면 계속');
eq(cat('안내문 정비'), 'new', '지난주에 없으면 신규');
eq(cat('처방 점검'), 'delayed', '상태 「보류」는 지연');
eq(a.changes.map(function (c) { return [c.task, R.fmt(c.from), R.fmt(c.to), c.days]; }), [['견학 일정 조율', '2026-11-06', '2026-11-13', 7]], '일정 변경 추출');
eq(a.missing.map(function (m) { return m.task + ':' + m.kind; }), ['대장 정리:gone'], '지난주에 있던 미완료 업무가 빠지면 확인 필요');
eq(a.rows.map(function (r) { return r.cat; }).slice(0, 3), ['delayed', 'delayed', 'delayed'], '표는 지연부터');
eq(run([mk('금주', 'A', '견학', '11/20')], []).rows[0].cat, 'new', '지난주 보고서가 없으면 신규');
eq(run([mk('금주', 'A', '견학', '11/6')], []).rows[0].cat, 'new', '기한이 기준일 당일이면 경과가 아니다');

// 예제 전체
var s = R.sample(), ref = R.toDate(s.ref);
var res = R.analyze(R.normalize(s.current, { ref: ref }).items, R.normalize(s.last, { ref: ref }).items, { ref: ref });
var c = res.counts;
eq([c.total, c.done, c.ongoing, c.new, c.delayed], [11, 2, 2, 4, 3], '예제: 금주 11건 = 완료 2 · 계속 2 · 신규 4 · 지연 3');
var merged = res.rows.filter(function (r) { return r.merged; });
eq(merged.map(function (r) { return r.members.join(','); }), ['박지훈,정하늘'], '예제: 두 사람이 쓴 임원 간담회 준비를 하나로 통합');
eq(res.changes.length, 3, '예제: 일정 변경 3건');
eq(res.issues.length, 4, '예제: 주요 이슈 4건(같은 문장은 한 번)');
eq(res.missing.filter(function (m) { return m.kind === 'gone'; }).map(function (m) { return m.task; }), ['10월 기념품 불출 대장 정리'], '예제: 빠진 업무 1건');
eq(res.plan.filter(function (p) { return p.kind === '신규 계획'; }).map(function (p) { return p.task; }).sort(), ['11월 인천·울산 견학 실적 집계', '동절기 시설물 점검(난방·배관)'], '예제: 차주 신규 계획은 숫자가 다른 10월 집계와 구분된다');
eq([R.fmt(res.period.from), R.fmt(res.period.to)], ['2026-11-02', '2026-11-06'], '예제: 보고 기간 월~금');

// 초안·내보내기
var dr = R.draft(res);
ok(/금주 업무 11건\(팀원 5명\) 중 완료 2건, 계속 2건, 신규 4건, 지연 3건/.test(dr.lines[0]), '요약 첫 줄은 숫자를 데이터에서 센다', dr.lines[0]);
ok(dr.lines.some(function (l) { return /^지연: .*울산 공장견학/.test(l); }), '요약에 지연 업무가 들어간다');
var sh = R.sheets(res, dr);
eq(Object.keys(sh), ['보고서요약', '전체요약', '업무별현황', '차주계획', '분야_복리후생총무', '분야_사회공헌의전', '분야_자산', '분야_비상계획', '분야_확인필요', '종합관리', '일정변경', '주요이슈', '지난주대비_빠진업무', '다음주_지난주용'], '엑셀 시트 14장(v1.0 7장 + 분야 7장)');
eq(sh['업무별현황'].length - 1, 11, '업무별현황 11줄');
var html = R.printHtml(res, dr, { team: '<경영>' });
ok(/<h1>주간업무보고 \(2026-11-02 ~ 2026-11-06\)<\/h1>/.test(html) && /&lt;경영&gt;/.test(html), '인쇄용 HTML 제목과 글자 escape');
ok(/AI 다듬음/.test(R.printHtml(res, dr, { aiLines: ['- x'] })) && !/AI 다듬음/.test(html), 'AI 문장을 쓸 때만 표시가 붙는다');

// 다음 주로 넘기기: 이번 주 결과를 지난주로 다시 읽으면 같은 업무가 「계속」으로 이어진다
var saved = R.fromSaved(JSON.stringify(R.saveObject(res)));
ok(saved && saved.rows.length === res.rows.length + res.plan.length, '저장 JSON 을 되읽는다');
eq(R.fromSaved('{"kind":"other"}'), null, '다른 JSON 은 거절');
var ref2 = R.toDate('2026-11-13');
var nextWeek = [mk('금주', '김민준', '울산 공장견학 일정 조율', '2026-11-13', '완료'), mk('금주', '박지훈', '11월 임원 간담회 준비', '2026-11-13')];
var res2 = R.analyze(R.normalize(nextWeek, { ref: ref2 }).items, R.normalize(saved.rows, { ref: ref2 }).items, { ref: ref2 });
eq(res2.rows.map(function (r) { return r.task + ':' + r.cat; }), ['11월 임원 간담회 준비:ongoing', '울산 공장견학 일정 조율:done'], '저장한 주가 다음 주의 지난주가 된다');
ok(res2.missing.some(function (m) { return m.task === '사무실 이전 견적 비교' && m.kind === 'gone'; }), '다음 주에 빠진 업무를 잡는다');

// 시트 나누기·팀원 짐작
eq(R.guessMember('업무일지_김민준.xlsx'), '김민준', '파일 이름에서 팀원');
eq(R.guessMember('주간업무보고.xlsx'), '', '팀원 이름이 아닌 파일 이름');
eq(R.routeSheets(['업무일지', '지난주보고서'], 'cur').map(function (x) { return x.role; }), ['cur', 'last'], '예제 엑셀의 지난주 시트는 지난주로');
eq(R.routeSheets(['보고서요약', '업무별현황', '다음주_지난주용'], 'last').map(function (x) { return x.role; }), ['skip', 'skip', 'last'], '내보낸 엑셀은 「다음주_지난주용」만 읽는다');

// AI 요청 모양(실제로 보내지 않는다)
var pr = R.aiPrompt(res, dr);
ok(/새로 만들지 마세요/.test(pr.system) && /울산 공장견학/.test(pr.user), 'AI 지시문은 사실만 다듬게 한다');
var oa = R.aiRequest('openai', 'k', pr), an = R.aiRequest('anthropic', 'k', pr);
eq([oa.url, JSON.parse(oa.init.body).model, oa.init.headers.Authorization], ['https://api.openai.com/v1/chat/completions', 'gpt-4o-mini', 'Bearer k'], 'OpenAI 요청');
eq([an.url, JSON.parse(an.init.body).model, an.init.headers['x-api-key'], an.init.headers['anthropic-version'], an.init.headers['anthropic-dangerous-direct-browser-access']],
  ['https://api.anthropic.com/v1/messages', 'claude-haiku-5-5', 'k', '2023-06-01', 'true'], 'Anthropic 요청');
eq(R.aiLines('anthropic', { content: [{ type: 'text', text: '- 첫째 줄\n\n2) 둘째 줄' }] }), ['첫째 줄', '둘째 줄'], 'AI 응답에서 줄만 뽑는다');
eq(R.aiLines('openai', { choices: [{ message: { content: '• 하나' } }] }), ['하나'], 'OpenAI 응답');

/* ---------- v1.1 업무 분야 — 분류 규칙·확인 필요·중복 집계 없음·사용자 수정 유지·분야별 금주/차주·빈 분야·요약 합 ---------- */
var v10 = passed + failed;
// 분류 규칙
eq(R.FIELDS.map(function (f) { return f.id; }), ['welfare', 'social', 'asset', 'emergency'], '분야 4개는 고정 순서');
eq(R.classifyText('통근버스 노선 개편', '').id, 'welfare', '통근버스 → 복리후생/총무');
eq(R.classifyText('외부 방문객 의전 준비', '').id, 'social', '방문객·의전 → 사회공헌/의전');
eq(R.classifyText('법인차량 정기점검', '').id, 'asset', '법인차량·정기점검 → 자산');
eq(R.classifyText('비상연락망 현행화', '').id, 'emergency', '비상연락망 → 비상계획');
eq(R.classifyText('자료 정리', '회의실 예약 현황 정리').id, 'unsure', '본문 낱말 하나(1점)만으로는 정하지 않는다 — 확인 필요');
eq(R.classifyText('자료 정리', '회의실 예약, 경비 정산').id, 'welfare', '업무명에 낱말이 없어도 추진현황의 낱말이 둘 이상이면 분류한다');
var tie = R.classifyText('방문객 휴게실 비품 교체', '');
ok(tie.id === 'unsure' && tie.scores.social === 3 && tie.scores.asset === 3, '두 분야 점수가 같으면 「분류 확인 필요」', JSON.stringify(tie.scores));
var none = R.classifyText('팀 업무분장표 갱신', '초안 작성');
ok(none.id === 'unsure' && /낱말도 없/.test(none.reason), '맞는 낱말이 없으면 「분류 확인 필요」와 사유');
eq(R.classifyText('간담회 준비', '참석자 차량 배차').id, 'welfare', '업무명 낱말 3점이 본문 낱말 1점을 이긴다(차이 2 = 경계)');
eq(R.classifyText('간담회 준비', '참석자 차량 배차, 차량 점검').id, 'unsure', '본문에 다른 분야 낱말이 둘이면 차이 1 → 확인 필요(경계 아래)');
eq(R.classifyText('회의실 예약', '비품 비품 비품 비품 비품').id, 'welfare', '같은 낱말은 한 번만 센다(여러 번 적어도 점수가 안 오른다)');
eq(R.classifyText('소방 시설 점검', '').id, 'unsure', '「소방시설 점검」은 자산(시설·점검)과 비상계획(소방·소방시설) 점수가 같아 확인 필요');
eq([R.parseField('복리후생/총무'), R.parseField('총무'), R.parseField('사회공헌'), R.parseField('의전'), R.parseField('자산'), R.parseField('비상계획'), R.parseField('비상'), R.parseField('기타'), R.parseField('')],
  ['welfare', 'welfare', 'social', 'social', 'asset', 'emergency', 'emergency', '', ''], '분야 표기를 id 로 읽는다');
// 우선순위: 화면에서 고친 값 → 일지 분야 열 → 지난주 분야 → 자동
eq(R.resolveField(['통근버스 노선 개편'], '', { overrides: { '통근버스노선개편': 'asset' } }).id, 'asset', '화면에서 고친 분야가 자동 판정을 이긴다');
eq(R.resolveField(['통근 버스 노선 개편(2차)'], '', { overrides: { '통근버스노선개편2차': 'asset' } }).src, 'user', '고친 값은 정규화한 업무명 키로 찾는다(띄어쓰기·괄호 무관)');
eq(R.resolveField(['통근버스 노선 개편'], '', { given: 'social', overrides: { '통근버스노선개편': 'asset' } }).id, 'asset', '고친 값 > 일지 분야 열');
eq(R.resolveField(['통근버스 노선 개편'], '', { given: 'social' }).src, 'doc', '일지 분야 열 > 자동');
eq(R.resolveField(['통근버스 노선 개편'], '', { lastField: 'social' }).src, 'last', '지난주 보고서의 분야 > 자동');
eq(R.resolveField(['통근버스 노선 개편'], '', { lastField: 'unsure', given: 'unsure' }).src, 'auto', '「확인 필요」는 이어받지 않고 자동 판정한다');
eq(R.resolveField(['x'], '', { overrides: { 'x': 'nope' } }).src, 'unsure', '모르는 분야 id 는 무시한다');

// 예제 전체 — 4개 분야 모두 · 확인 필요 2건 · 중복 집계 없음
var fields = res.fields;
eq(fields.map(function (f) { return f.id; }), ['welfare', 'social', 'asset', 'emergency', 'unsure'], '분야별 묶음은 4개 고정 + 확인 필요');
eq(fields.map(function (f) { return f.counts.total; }), [3, 2, 2, 2, 2], '예제: 분야별 금주 건수 3·2·2·2 + 확인 필요 2');
eq(fields.map(function (f) { return f.counts.plan; }), [2, 2, 2, 1, 1], '예제: 분야별 차주 건수');
ok(fields.slice(0, 4).every(function (f) { return !f.empty; }), '예제: 4개 분야가 모두 나온다');
eq(fields.reduce(function (n, f) { return n + f.counts.total; }, 0), res.counts.total, '분야별 금주 건수 합 = 전체 금주 건수');
eq(fields.reduce(function (n, f) { return n + f.counts.plan; }, 0), res.counts.next, '분야별 차주 건수 합 = 전체 차주 건수');
eq(fields.reduce(function (n, f) { return n + f.counts.done + f.counts.ongoing + f.counts.new + f.counts.delayed; }, 0), res.counts.total, '분야별 완료+계속+신규+지연 합 = 전체');
var seen = {}; var dup = false;
fields.forEach(function (f) { f.rows.forEach(function (r) { if (seen[r.task]) dup = true; seen[r.task] = 1; }); });
ok(!dup && Object.keys(seen).length === res.rows.length, '한 업무가 두 분야에 중복 집계되지 않는다');
eq(res.counts.unsure, 2, '예제: 분류 확인 필요 2건(업무 단위 — 이어지는 차주 계획은 다시 세지 않음)');
eq(res.rows.filter(function (r) { return r.field.id === 'unsure'; }).map(function (r) { return r.task; }).sort(), ['방문객 휴게실 비품 교체', '팀 업무분장표 갱신'], '예제: 확인 필요 업무 2건');
function fieldOf(task) { return res.rows.filter(function (r) { return r.task === task; })[0].field; }
eq([fieldOf('통근버스 노선 개편').id, fieldOf('울산 공장견학 일정 조율').id, fieldOf('기념품 재고 실사').id, fieldOf('하반기 소방대피훈련 실시').id], ['welfare', 'social', 'asset', 'emergency'], '예제: 분야 판정');
eq(fieldOf('임원간담회 준비(11월)').id, 'welfare', '예제: 두 사람이 쓴 통합 업무도 한 분야');
var linked = res.plan.filter(function (p) { return p.task === '방문객 휴게실 비품 교체'; })[0];
eq([linked.field.id, linked.field.src], ['unsure', 'linked'], '금주 업무와 이어지는 차주 계획은 같은 분야(확인 필요도 그대로)');
eq(res.plan.filter(function (p) { return p.task === '동절기 시설물 점검(난방·배관)'; })[0].field.id, 'asset', '금주에 없는 차주 신규 계획은 스스로 분류한다');

// 분류와 구분은 따로 — 분야를 고쳐도 구분·일정·이슈는 그대로
var ov = {}; ov[R.taskKey('방문객 휴게실 비품 교체')] = 'social'; ov[R.taskKey('기념품 재고 실사')] = 'social';
var res3 = R.analyze(R.normalize(s.current, { ref: ref }).items, R.normalize(s.last, { ref: ref }).items, { ref: ref, fields: ov });
eq(res3.rows.map(function (r) { return r.task + ':' + r.cat; }), res.rows.map(function (r) { return r.task + ':' + r.cat; }), '분야를 고쳐도 구분(신규·계속·완료·지연)은 그대로');
eq([res3.changes.length, res3.issues.length, res3.missing.length], [res.changes.length, res.issues.length, res.missing.length], '분야를 고쳐도 일정 변경·이슈·빠진 업무는 그대로');
eq(res3.fields.map(function (f) { return f.counts.total; }), [3, 4, 1, 2, 1], '고친 분야로 다시 세면 사회공헌 4 · 자산 1 · 확인 필요 1');
eq(res3.plan.filter(function (p) { return p.task === '방문객 휴게실 비품 교체'; })[0].field.id, 'social', '고친 분야가 이어지는 차주 계획에도 적용된다');
eq(res3.counts.unsure, 1, '고치면 확인 필요 건수가 준다');
// 일지에 분야 열이 있으면 그 값(문서 값), 모르는 표기는 알린다
var nd = R.normalize([{ 구분: '금주', 팀원: 'A', 업무명: '자료 정리', 추진현황: 'x', 분야: '자산' }, { 구분: '금주', 팀원: 'A', 업무명: '월간 보고', 추진현황: 'x', 분야: '영업' }], { ref: REF });
eq([nd.items[0].field, nd.items[1].field, nd.issues.length], ['asset', '', 1], '분야 열을 읽고, 모르는 표기는 알린 뒤 자동 분류한다');
var rd = R.analyze(nd.items, [], { ref: REF });
eq([rd.rows[0].field.src, rd.rows[1].field.src], ['doc', 'unsure'], '분야 열이 있는 줄은 「일지 분야 열」, 없는 줄은 자동');
// 지난주 보고서에 적힌 분야를 이어받는다(저장 JSON·다음주_지난주용 시트)
var saved2 = R.fromSaved(JSON.stringify(R.saveObject(res3, ov)));
eq(saved2.fields, ov, '저장 JSON 에 고친 분야가 들어간다');
ok(saved2.rows.every(function (r) { return '분야' in r; }) && saved2.rows.filter(function (r) { return r.업무명 === '팀 업무분장표 갱신'; })[0].분야 === '', '저장 줄마다 분야가 있고 「확인 필요」는 비워 둔다');
eq(R.fromSaved(JSON.stringify(R.saveObject(res))).fields, {}, 'fields 없이 저장해도 빈 객체');
eq(R.fromSaved('{"kind":"build-2611-10/weekly-report","rows":[]}').fields, {}, 'v1.0 저장본(fields 없음)도 읽는다');
var ref3 = R.toDate('2026-11-13');
var wk3 = [mk('금주', '박지훈', '휴게실 비품 교체', '2026-11-13', '완료'), mk('금주', '최유진', '팀 업무분장표 갱신', '2026-11-27')];
var res4 = R.analyze(R.normalize(wk3, { ref: ref3 }).items, R.normalize(saved2.rows, { ref: ref3 }).items, { ref: ref3 });
eq(res4.rows.filter(function (r) { return r.task === '휴게실 비품 교체'; })[0].field.src, 'last', '다음 주에 같은 업무가 이어지면 지난주 보고서의 분야를 쓴다');
eq(res4.rows.filter(function (r) { return r.task === '팀 업무분장표 갱신'; })[0].field.id, 'unsure', '지난주에도 확인 필요였으면 다시 확인 필요');
eq(R.mergeFields({ a: 'asset' }, { b: 'nope', a: 'social' }), { a: 'social' }, '고친 분야 합치기 — 뒤가 이기고 모르는 값은 버린다');

// 요약·종합 관리·팀장 확인
eq(res.decisions.map(function (d) { return d.kind; }).sort(), ['decision', 'gone', 'overdue', 'unsure', 'unsure'], '팀장 확인 필요: 기한 경과 1 · 의사결정 낱말 1 · 누락 1 · 분류 확인 2');
ok(res.decisions.some(function (d) { return d.kind === 'decision' && /결정 필요/.test(d.text) && d.task === '비상연락망 현행화'; }), '이슈의 「결정 필요」를 의사결정 사항으로 모은다');
eq(res.counts.overdue, 1, '예제: 기한 경과 미완료 1건');
var mg = R.management(res);
eq([mg.done.length, mg.newRows.length, mg.changed.length, mg.overdue.length, mg.gone.length, mg.decisions.length], [2, 4, 3, 1, 1, 5], 'Ⅲ 종합 관리사항 건수');
eq(mg.overdue[0].task, '기념품 재고 실사', '기한 경과 미완료 = 기념품 재고 실사');
ok(/^분야별 금주 업무: 복리후생·총무 3건 · 사회공헌·의전 2건 · 자산 2건 · 비상계획 2건 · 확인 필요 2건\.$/.test(dr.lines[1]), '요약 둘째 줄은 분야별 건수를 데이터에서 센다', dr.lines[1]);
ok(dr.lines.some(function (l) { return /팀장 확인·의사결정 필요 5건/.test(l); }), '요약에 팀장 확인 건수');
eq(fieldOf('울산 공장견학 일정 조율').id && res.rows.filter(function (r) { return r.task === '울산 공장견학 일정 조율'; })[0].delta, '기한 11/6 → 11/13 (+7일) / 지난주 업무명 「울산공장 견학 일정조율」', '전주 대비 변경은 기한 변경·지난주 이름으로 만든다');
eq(res.rows.filter(function (r) { return r.task === '통근버스 노선 개편'; })[0].delta, '완료', '지난주 진행중이 완료되면 「완료」');
eq(res.rows.filter(function (r) { return r.task === '비상연락망 현행화'; })[0].delta, '신규(지난주 없음)', '지난주에 없으면 「신규」');

// 엑셀·인쇄 — 분야 열과 분야별 시트, 금주/차주 분리, 빈 분야 표시
eq(sh['업무별현황'][0].slice(0, 3), ['구분(자동)', '분야', '분야 출처'], '업무별현황에 분야 열');
eq(sh['차주계획'][0][1], '분야', '차주계획에 분야 열');
eq(sh['분야_자산'].length - 2, 4, '분야_자산 시트 = 금주 2 + 차주 2');
eq(sh['분야_자산'].slice(2).map(function (r) { return r[0]; }), ['금주', '금주', '차주', '차주'], '분야 시트는 금주 줄 뒤에 차주 줄');
eq(sh['분야_자산'][1], ['주', '구분', '업무명', '담당자', '추진현황', '기한', '상태', '전주 대비 변경', '주요 이슈'], '분야 시트 열');
eq(sh['다음주_지난주용'][0], R.HEAD, '다음주_지난주용에 분야 열(HEAD)');
eq(sh['전체요약'][4].slice(0, 2), ['복리후생 / 총무', 3], '전체요약 시트의 분야별 건수');
var empty = R.analyze(R.normalize([mk('금주', 'A', '통근버스 노선 개편', '11/20')], { ref: REF }).items, [], { ref: REF });
eq(empty.fields.map(function (f) { return f.empty; }), [false, true, true, true, true], '업무가 한 분야뿐이면 나머지는 비어 있음으로 표시');
eq(R.sheets(empty)['분야_자산'][2], ['해당 기간 업무 없음'], '빈 분야 시트에 「해당 기간 업무 없음」');
var eh = R.printHtml(empty);
eq((eh.match(/해당 기간 업무 없음/g) || []).length, 7, '인쇄: 빈 분야 3개 × 금주·차주 + 복리후생 차주 = 7번 「해당 기간 업무 없음」');
ok(!/분류 확인 필요/.test(eh.split('Ⅱ.')[1].split('Ⅲ.')[0]), '확인 필요가 없으면 그 절을 두지 않는다(4개 분야는 비어도 둔다)');
var ph = R.printHtml(res, dr);
ok(/Ⅰ\. 전체 업무 요약/.test(ph) && /Ⅱ\. 분야별 주간업무보고/.test(ph) && /Ⅲ\. 종합 관리사항/.test(ph), '인쇄: Ⅰ·Ⅱ·Ⅲ 구조');
var order = ['1. 복리후생 / 총무', '2. 사회공헌 / 의전', '3. 자산', '4. 비상계획', '※ 분류 확인 필요'].map(function (t) { return ph.indexOf(t); });
ok(order.every(function (i, k) { return i > 0 && (k === 0 || i > order[k - 1]); }), '인쇄: 분야 4개가 고정 순서, 확인 필요는 맨 뒤', order.join(','));
eq((ph.match(/금주 주요 추진실적/g) || []).length, 5, '인쇄: 분야마다 금주 추진실적');
eq((ph.match(/차주 추진계획/g) || []).length, 5, '인쇄: 분야마다 차주 추진계획');
ok(/<th>구분<\/th><th>업무명<\/th><th>담당자<\/th><th>추진현황<\/th><th>기한<\/th><th>상태<\/th><th>전주 대비 변경<\/th><th>주요 이슈<\/th>/.test(ph), '인쇄: 분야 표 열 8개');
ok(/class="c-delayed overdue"/.test(ph) && /지난주 보고서에는 있으나 이번 주 업무일지에서 누락된 업무/.test(ph), '인쇄: 기한 경과 강조와 누락 업무 절');
eq(R.routeSheets(['분야_자산', '전체요약', '종합관리', '업무일지'], 'cur').map(function (x) { return x.role; }), ['skip', 'skip', 'skip', 'cur'], '내보낸 분야 시트는 다시 읽지 않는다');
console.log('v1.0 ' + v10 + ' · v1.1 ' + (passed + failed - v10));

console.log('\n규칙 통과 ' + passed + ' · 실패 ' + failed);
process.exit(failed ? 1 : 0);
