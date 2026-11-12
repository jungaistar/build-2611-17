/* 브라우저에 실제로 띄워 화면이 그려지는지 본다 — node test/smoke.browser.js
 * 규칙 테스트가 다 통과해도 app.js 오타 하나면 빈 화면이 된다. playwright 가 없으면 건너뛴다. */
'use strict';
var http = require('http'), fs = require('fs'), path = require('path');
var chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.log('playwright 가 없어 화면 연기 테스트를 건너뜁니다.'); process.exit(0); }
var ROOT = path.join(__dirname, '..');
var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
var srv = http.createServer(function (q, s) {
  var p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(p, function (e, b) { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); s.end(b); });
});
var passed = 0, failed = 0;
function ok(c, label, d) { if (c) passed++; else { failed++; console.log('  X ' + label + (d ? '  ' + d : '')); } }
srv.listen(0, async function () {
  var base = 'http://127.0.0.1:' + srv.address().port + '/';
  var br = await chromium.launch();
  var pg = await br.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  var errs = []; pg.on('pageerror', function (e) { errs.push(e.message); });
  try {
    await pg.goto(base);
    ok(await pg.isHidden('#s-result') && await pg.isHidden('#s-report'), '처음에는 분석·보고서 영역이 닫혀 있다');
    await pg.click('#btn-sample');
    await pg.waitForSelector('#rows tbody tr', { timeout: 5000 });
    ok(await pg.isVisible('#s-result') && await pg.isVisible('#s-out') && await pg.isVisible('#s-report'), '보고서·분석·저장 영역이 열린다');
    ok(await pg.$$eval('#rows tbody tr', function (t) { return t.length; }) === 11, '업무별 표 11줄');
    ok(await pg.$$eval('#rows tr[data-cat="delayed"]', function (t) { return t.length; }) === 3, '지연 3줄');
    ok(/통합 2/.test(await pg.textContent('#rows')), '통합 표시가 보인다');
    ok(/11-06 → 2026-11-13|2026-11-06 → 2026-11-13/.test(await pg.textContent('#changes')), '일정 변경이 그려진다');
    ok((await pg.$$eval('#issues li', function (t) { return t.length; })) === 4, '주요 이슈 4건');
    ok(/10월 기념품 불출 대장 정리/.test(await pg.textContent('#missing')), '빠진 업무가 보인다');
    ok(/금주 업무 11건/.test(await pg.textContent('#draft')), '보고서 초안 요약');

    // v1.1 팀장 보고서 — 전체 요약 상단 · 분야 4개 고정 순서 · 금주/차주 분리 · 확인 필요 · 접기 · 분야 고치기
    var repTop = await pg.evaluate(function () { return document.querySelector('#s-report').getBoundingClientRect().top + window.scrollY < document.querySelector('#s-result').getBoundingClientRect().top + window.scrollY; });
    ok(repTop, '팀장 보고서가 상세 분석보다 위에 있다');
    var sumFirst = await pg.evaluate(function () { return document.querySelector('#rep-summary').getBoundingClientRect().top < document.querySelector('#rep-fields').getBoundingClientRect().top; });
    ok(sumFirst && /금주 업무/.test(await pg.textContent('#rep-summary')), 'Ⅰ 전체 업무 요약이 분야별 보고 위에 있다');
    var names = await pg.$$eval('#rep-fields details.field summary .fname', function (t) { return t.map(function (x) { return x.textContent; }); });
    ok(JSON.stringify(names) === JSON.stringify(['복리후생 / 총무', '사회공헌 / 의전', '자산', '비상계획', '분류 확인 필요']), '분야 4개가 고정 순서로 + 분류 확인 필요', names.join('|'));
    var wk = await pg.$$eval('#field-welfare h4.wk', function (t) { return t.map(function (x) { return x.className; }); });
    ok(JSON.stringify(wk) === JSON.stringify(['wk wk-this', 'wk wk-next']), '분야마다 금주 추진실적 · 차주 추진계획이 나뉘어 있다', wk.join('|'));
    ok(await pg.$$eval('#field-asset table.ft-this tbody tr', function (t) { return t.length; }) === 2 && await pg.$$eval('#field-asset table.ft-next tbody tr', function (t) { return t.length; }) === 2, '자산: 금주 2 · 차주 2');
    ok(await pg.$$eval('#field-unsure table.ft-this tbody tr', function (t) { return t.length; }) === 2, '분류 확인 필요 2건');
    ok(await pg.$$eval('#rep-fields tr.overdue td.due', function (t) { return t.length && getComputedStyle(t[0]).fontWeight >= 700; }), '기한 경과 줄이 강조된다');
    ok(/기한 경과/.test(await pg.textContent('#rep-decisions')) && /결정 필요/.test(await pg.textContent('#rep-decisions')), '팀장 확인·의사결정 영역이 따로 있다');
    ok(await pg.$$eval('#rep-mgmt .box', function (t) { return t.length; }) === 6, 'Ⅲ 종합 관리사항 6항목');
    var fsum = await pg.textContent('table.fcount tr.total');
    ok(/합계\s*11\s*2\s*2\s*4\s*3\s*8/.test(fsum.replace(/\s+/g, ' ')), '분야별 건수 합계 = 11·2·2·4·3·8', fsum);
    await pg.click('#field-social summary');
    ok(await pg.$eval('#field-social', function (d) { return !d.open; }) && await pg.isHidden('#field-social table'), '분야를 접으면 표가 숨는다');
    await pg.click('#rep-open');
    ok(await pg.$$eval('#rep-fields details.field', function (t) { return t.every(function (d) { return d.open; }); }), '「모두 펼치기」');
    await pg.click('#rep-close');
    ok(await pg.$$eval('#rep-fields details.field', function (t) { return t.every(function (d) { return !d.open; }); }), '「모두 접기」');
    await pg.click('#rep-open');
    // 분야 고치기 → 자산으로 옮겨지고 건수가 바뀌며 구분은 그대로
    var catBefore = await pg.$$eval('#rows tbody tr', function (t) { return t.map(function (r) { return r.dataset.cat; }).join(','); });
    await pg.selectOption('#field-unsure .fsel >> nth=0', 'asset');
    await pg.waitForFunction(function () { return document.querySelectorAll('#field-asset table.ft-this tbody tr').length === 3; }, null, { timeout: 5000 });
    ok(await pg.$$eval('#field-unsure table.ft-this tbody tr', function (t) { return t.length; }) === 1, '분야를 고치면 확인 필요에서 빠진다');
    ok(/저장했습니다/.test(await pg.textContent('#fields-status')), '고친 분야를 저장했다고 알린다');
    ok(await pg.$$eval('#rows tbody tr', function (t) { return t.map(function (r) { return r.dataset.cat; }).join(','); }) === catBefore, '분야를 고쳐도 구분은 그대로');
    ok(await pg.$$eval('#rep-fields details.field', function (t) { return t.every(function (d) { return d.open; }); }), '다시 그려도 펼친 상태가 유지된다');
    await pg.click('#filter .chip[data-f="done"]');
    ok(await pg.$$eval('#rows tbody tr', function (t) { return t.length; }) === 2, '완료만 거르기');
    var dl = await Promise.all([pg.waitForEvent('download'), pg.click('#btn-export')]);
    ok(/\.xlsx$/.test(dl[0].suggestedFilename()), '엑셀 내보내기', dl[0].suggestedFilename());
    var dh = await Promise.all([pg.waitForEvent('download'), pg.click('#btn-html')]);
    ok(/\.html$/.test(dh[0].suggestedFilename()), '인쇄용 HTML 저장');
    var htmlText = fs.readFileSync(await dh[0].path(), 'utf8');
    ok(/Ⅱ\. 분야별 주간업무보고/.test(htmlText) && /1\. 복리후생 \/ 총무/.test(htmlText) && /4\. 비상계획/.test(htmlText) && /size:A4/.test(htmlText), '인쇄용 HTML 에 분야 구분과 A4 설정');
    await pg.click('#btn-save');
    ok(/저장했습니다/.test(await pg.textContent('#save-status')) && /고친 분야 1건/.test(await pg.textContent('#save-status')), '다음 주용으로 저장(고친 분야 포함)');
    await pg.reload();
    ok(await pg.isVisible('#load-saved'), '다시 열면 「저장해 둔 지난주」 버튼이 보인다');
    // 고친 분야가 브라우저에 남아 다시 예제를 돌려도 그대로
    await pg.click('#btn-sample');
    await pg.waitForSelector('#rows tbody tr', { timeout: 5000 });
    ok(await pg.$$eval('#field-asset table.ft-this tbody tr', function (t) { return t.length; }) === 3 && /화면에서 고침/.test(await pg.textContent('#rows')), '다시 열어도 고친 분야를 먼저 쓴다');
    await pg.click('#btn-reset');
    // 붙여넣기만으로도 돈다 — 업무가 한 분야뿐이면 나머지 분야는 「해당 기간 업무 없음」
    await pg.fill('#text-cur', '구분\t팀원\t업무명\t추진현황\t일정/기한\t상태\t이슈\n금주\t김민준\t울산 공장견학 일정 조율\t확정\t2026-11-13\t완료\t');
    await pg.click('#add-cur');
    await pg.click('#load-saved');
    await pg.fill('#ref', '2026-11-13');
    await pg.click('#btn-build');
    await pg.waitForSelector('#rows tbody tr', { timeout: 5000 });
    ok(/완료/.test(await pg.textContent('#rows')) && /사무실 이전 견적 비교/.test(await pg.textContent('#missing')), '붙여넣기 + 저장된 지난주로 다음 주 보고서');
    ok((await pg.$$eval('#rep-fields .none', function (t) { return t.length; })) === 7 && await pg.$$eval('#rep-fields details.field', function (t) { return t.length; }) === 4, '업무 없는 분야도 남기고 「해당 기간 업무 없음」(3분야 × 2 + 사회공헌 차주)');
    ok(/지난주 분야/.test(await pg.textContent('#rows')), '지난주 보고서에 적힌 분야를 이어받는다');
    // 좁은 화면 가로 넘침
    await pg.setViewportSize({ width: 360, height: 800 });
    var over = await pg.evaluate(function () {
      var W = document.documentElement.clientWidth, bad = [];
      document.querySelectorAll('body *').forEach(function (el) {
        var r = el.getBoundingClientRect(); if (!r.width) return;
        for (var p = el.parentElement; p; p = p.parentElement) { var ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return; }
        if (r.right > W + 1) bad.push(el.tagName + '.' + el.className);
      });
      return bad.slice(0, 5);
    });
    ok(!over.length, '360px 가로 넘침 없음', over.join(', '));
    await pg.goto(base + 'guide.html');
    ok(/지난주/.test(await pg.textContent('main')), '사용법 페이지');
  } catch (e) { failed++; console.log('  X 예외: ' + e.message); }
  ok(!errs.length, '페이지 오류 없음', errs.join(' | '));
  await br.close(); srv.close();
  console.log('\n화면 통과 ' + passed + ' · 실패 ' + failed);
  process.exit(failed ? 1 : 0);
});
