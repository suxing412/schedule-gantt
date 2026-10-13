const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
let source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Preview the proposed replacements before the main page is changed.
if (process.env.TIMELINE_PATCH_PREVIEW === '1') {
  const patches = JSON.parse(fs.readFileSync(path.join(root, '.repair-work', 'timeline.json'), 'utf8'));
  for (const { find, replace } of patches) {
    assert.equal(source.split(find).length, 2, 'preview replacement must be unique');
    source = source.replace(find, replace);
  }
}

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

const dates = section('const DAY_MS =', '// 任务职能');
const timeline = section('// Axis ——', '// RENDER');

function harness() {
  const now = new Date(2026, 9, 9, 12).getTime();
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
  }
  const context = vm.createContext({ Date: FixedDate });
  vm.runInContext(`
    let proj={tasks:[]},zoom='day',dragging=false,axis=null,bds=null;
    const isSum=()=>false;
    const eRange=t=>({s:tD(t.s),e:tD(t.e)});
    const vRows=()=>proj.tasks.map(t=>({t}));
    const rt={
      clientWidth:1000,_left:0,
      get scrollWidth(){return axis?axis.tw:0},
      get scrollLeft(){return this._left},
      set scrollLeft(value){
        this._left=Math.max(0,Math.min(value,Math.max(0,this.scrollWidth-this.clientWidth)));
      }
    };
    const $=()=>rt;
    function render(){
      bds=compBounds(vRows());axis=buildAxis(bds.mn,bds.mx,zoom);
      // Layout changes clamp the browser's existing scroll offset before restoration.
      rt.scrollLeft=rt.scrollLeft;
    }
    function goToday(){rt.scrollLeft=(todayD()-bds.mn)*axis.dw-rt.clientWidth/2}
    ${dates}
    ${timeline}
    globalThis.api={
      tD,fD,monthStart,monthEnd,buildAxis,zoomTimeline,maybeExtend,shrinkWindow,
      today:()=>todayD(),
      configure(options){
        proj.tasks=options.tasks||[];zoom=options.zoom||'day';
        vMn=options.from??null;vMx=options.to??null;
        rt.clientWidth=options.width||1000;render();
        rt.scrollLeft=options.left||0;
      },
      scrollToDay(day){rt.scrollLeft=(day-bds.mn)*axis.dw-rt.clientWidth/2},
      scrollToRight(){rt.scrollLeft=rt.scrollWidth-rt.clientWidth},
      center:()=>bds.mn+(rt.scrollLeft+rt.clientWidth/2)/axis.dw,
      leftDay:()=>bds.mn+rt.scrollLeft/axis.dw,
      bounds:()=>({mn:bds.mn,mx:bds.mx}),
      width:()=>axis.tw,
      maxSpan:()=>MAXSPAN[zoom]
    };
  `, context);
  return context.api;
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);
}

test('calendar groups and weekly cells remain aligned across New Year', () => {
  const a = harness();
  const axis = a.buildAxis(a.tD('2024-12-29'), a.tD('2025-01-10'), 'month');
  assert.deepEqual(Array.from(axis.groups, g => g.label), ['2024年12月', '2025年1月']);
  assert.deepEqual(Array.from(axis.cells, c => c.n), ['12/29', '12/30', '1/6']);
  assert.deepEqual(Array.from(axis.cells, c => c.w), [6, 42, 30]);
  assert.equal(axis.cells.reduce((sum, cell) => sum + cell.w, 0), axis.tw);
  assert.equal(axis.groups.reduce((sum, group) => sum + group.w, 0), axis.tw);
});

test('leap February and month offsets use whole calendar days', () => {
  const a = harness();
  assert.equal(a.fD(a.monthEnd(a.tD('2024-02-12'), 0)), '2024-02-29');
  assert.equal(a.fD(a.monthEnd(a.tD('2023-02-12'), 0)), '2023-02-28');
  assert.equal(a.fD(a.monthStart(a.tD('2024-12-31'), 1)), '2025-01-01');
  const axis = a.buildAxis(a.tD('2024-02-28'), a.tD('2024-03-01'), 'day');
  assert.deepEqual(Array.from(axis.cells, c => c.n), ['28', '29', '1']);
  assert.equal(axis.tw, 3 * 72);
});

test('zooming a distant future viewport preserves its precise center', () => {
  const a = harness(), today = a.today();
  const center = a.tD('2031-10-08') + 0.3125;
  a.configure({ tasks: [{ s: a.fD(today), e: a.fD(today + 5) }], from: today - 7, to: Math.ceil(center) + 60 });
  a.scrollToDay(center);
  close(a.center(), center);
  for (const zoom of ['month', 'week', 'day']) {
    a.zoomTimeline(zoom);
    close(a.center(), center);
    assert.ok(a.bounds().mn < center && a.bounds().mx > center);
  }
});

test('zooming a distant past viewport preserves its center and both dates', () => {
  const a = harness(), today = a.today();
  const center = a.tD('2020-02-29') + 0.25;
  a.configure({ tasks: [{ s: a.fD(today), e: a.fD(today + 5) }], from: Math.floor(center) - 40, to: today + 14 });
  a.scrollToDay(center);
  a.zoomTimeline('month');
  close(a.center(), center);
  assert.ok(a.bounds().mn < center);
  assert.ok(a.bounds().mx >= today + 5);
});

test('right-edge extension restores the date after left-side trimming clamps scrollLeft', () => {
  const a = harness(), today = a.today();
  a.configure({ tasks: [{ s: a.fD(today), e: a.fD(today + 5) }], from: today - 3650, to: today + 14 });
  a.scrollToRight();
  const anchor = a.leftDay(), oldWidth = a.width();
  a.maybeExtend();
  assert.ok(a.width() < oldWidth, 'fixture must force layout to clamp the old offset');
  close(a.leftDay(), anchor);
});

test('left-edge extension restores its date when trimming the distant right side', () => {
  const a = harness(), today = a.today();
  a.configure({ tasks: [{ s: a.fD(today), e: a.fD(today + 5) }], from: today - 14, to: today + 3650, left: 200 });
  const anchor = a.leftDay(), oldWidth = a.width();
  a.maybeExtend();
  assert.ok(a.width() < oldWidth);
  close(a.leftDay(), anchor);
});

test('long project ranges remain complete when they exceed the recycling target', () => {
  const a = harness(), today = a.today(), start = today - 3650;
  a.configure({ tasks: [{ s: a.fD(start), e: a.fD(today) }] });
  a.scrollToRight();
  const anchor = a.leftDay();
  a.maybeExtend();
  close(a.leftDay(), anchor);
  const bounds = a.bounds();
  assert.ok(bounds.mn <= start && bounds.mx >= today);
  assert.ok(bounds.mx - bounds.mn + 1 > a.maxSpan());
  assert.ok(Number.isFinite(a.width()) && a.width() > 0);
});
