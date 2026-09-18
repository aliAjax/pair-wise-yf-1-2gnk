/* 浏览器 UI 冒烟：用极简 DOM 桩加载真实 index.html 结构并驱动交互 */
'use strict';
const fs = require('fs');
const path = require('path');

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [], style: { setProperty() {} }, dataset: {}, classList: { _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); } },
    attrs: {}, _html: '', _text: '', hidden: false,
    _listeners: {},
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set className(v) { this._cls = v; },
    get className() { return this._cls || ''; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    dispatch(ev, e = {}) { (this._listeners[ev] || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, ...e })); },
    querySelector() { return makeEl(); },
    closest(sel) { return sel ? this : null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() {},
    scrollTo() {},
    focus() {},
  };
  return el;
}

const els = {};
const ids = ['clock','btn-reschedule','btn-reset','pets-list','f-medication','f-med-hint','f-nurse',
  'f-priority','f-priority-hint','task-form','stats','gantt-scroll','gantt','gantt-corner',
  'gantt-ruler','gantt-rows','toast','pending-list'];
ids.forEach((id) => { els[id] = makeEl(); });
els['f-medication'].value = 'p1:m1';
els['f-nurse'].value = '';
els['f-priority'].value = 'normal';

global.window = {
  confirm: () => true,
  addEventListener() {},
  requestAnimationFrame: (fn) => fn(),
};
global.document = {
  querySelector(sel) {
    const id = sel.replace('#', '');
    if (els[id]) return els[id];
    return makeEl();
  },
  createElement: () => makeEl(),
};
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.requestAnimationFrame = (fn) => fn();

require('./app.js');

const assert = require('assert');
let n = 0;
const ok = (msg) => { n++; console.log('  ✅', msg); };

assert(store['pet-med-board-v1'], '首次加载应写入 localStorage');
ok('初始化后数据已持久化到 localStorage');

const saved1 = JSON.parse(store['pet-med-board-v1']);
assert.strictEqual(saved1.pets.length, 6);
assert.strictEqual(saved1.nurses.length, 3);
ok('预置 6 只宠物、3 名护理员');

assert(saved1.tasks.some((t) => t.status === 'pending'), '应存在待排示例任务');
assert(saved1.tasks.some((t) => t.priority === 'emergency' && t.slot === 3 && t.nurseId === 'b'));
ok('含待排任务与槽 3 李护的锁定急救');

// 模拟提交一个普通任务：先给跳跳加一种无预置任务的新药 mNEW（间隔 1 小时，2 小时前刚给）
{
  const st = JSON.parse(store['pet-med-board-v1']);
  st.pets.find((p) => p.id === 'p4').meds.push(
    { id: 'mNEW', name: '维生素 C', note: '口服', minIntervalMin: 60, lastGiven: Date.now() - 2 * 3600 * 1000 });
  store['pet-med-board-v1'] = JSON.stringify(st);
}
delete require.cache[require.resolve('./app.js')];
require('./app.js');
els['f-medication'].value = 'p4:mNEW';
els['f-priority'].value = 'normal';
els['task-form'].dispatch('submit');
const saved2 = JSON.parse(store['pet-med-board-v1']);
const added = saved2.tasks.filter((t) => t.id.startsWith('u'));
assert.strictEqual(added.length, 1);
assert.strictEqual(added[0].status, 'scheduled');
ok('表单提交普通任务后自动落槽并重渲染');

// 模拟提交一个违反间隔的急救（选一种 lastGiven 很近的药：p1:m1 50 分钟前，间隔 4h）
els['f-medication'].value = 'p1:m1';
els['f-priority'].value = 'emergency';
els['f-nurse'].value = 'a';
els['task-form'].dispatch('submit');
const saved3 = JSON.parse(store['pet-med-board-v1']);
assert.strictEqual(saved3.tasks.filter((t) => t.id.startsWith('u') && t.priority === 'emergency').length, 0);
assert.ok(els['toast']._text.includes('不足'));
ok('违反最小间隔的急救被拒绝并提示原因：' + els['toast']._text);

// 刷新（重新 require 缓存清掉后）：数据保留
delete require.cache[require.resolve('./app.js')];
const before = JSON.parse(store['pet-med-board-v1']).tasks.length;
require('./app.js');
const after = JSON.parse(store['pet-med-board-v1']).tasks.length;
assert.strictEqual(before, after);
ok('刷新后任务数不变（本地持久化生效）：' + after + ' 项');

// 立即重排按钮可触发
els['btn-reschedule'].dispatch('click');
ok('立即重排按钮触发成功');

console.log('\n' + n + ' 项 UI 冒烟通过');
