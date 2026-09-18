/* 排班算法自测（Node）：node test.js */
'use strict';
const assert = require('assert');
const A = require('./app.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1; }
}

function mkState(now, opts = {}) {
  const s = {
    seq: 0,
    horizonStart: A.floorToSlot(now),
    nurses: [
      { id: 'a', name: '王护', color: '' },
      { id: 'b', name: '李护', color: '' },
      { id: 'c', name: '赵护', color: '' },
    ],
    pets: [{
      id: 'p1', name: '布丁', species: '狗', avatar: '🐕',
      meds: [
        { id: 'm1', name: '药A', note: '', minIntervalMin: opts.min || 60, lastGiven: opts.lastGiven == null ? now - 120 * 60000 : opts.lastGiven },
        { id: 'm2', name: '药B', note: '', minIntervalMin: 1440, lastGiven: null },
        { id: 'm3', name: '药C', note: '', minIntervalMin: 60, lastGiven: now - 120 * 60000 },
        { id: 'm4', name: '药D', note: '', minIntervalMin: 60, lastGiven: now - 120 * 60000 },
      ],
    }],
    tasks: [],
  };
  return s;
}
const add = (s, petId, medId, priority, preferNurseId = null) => {
  s.seq++;
  const t = { id: 'x' + s.seq, petId, medId, priority, preferNurseId, status: 'pending', slot: null, nurseId: null, createdAt: s.seq };
  s.tasks.push(t);
  return t;
};

const now = A.floorToSlot(Date.now());

console.log('1) 基础排班：同槽每人一项，三人可并行');
test('三个普通任务落在当前槽且分给三名不同护理员', () => {
  const s = mkState(now);
  add(s, 'p1', 'm1', 'normal');
  add(s, 'p1', 'm3', 'normal');
  add(s, 'p1', 'm4', 'normal');
  A.reschedule(s, now);
  assert.strictEqual(s.tasks.filter((t) => t.slot === 0).length, 3);
  assert.strictEqual(new Set(s.tasks.map((t) => t.nurseId)).size, 3);
});

test('第四个任务必须等到下一槽', () => {
  const s = mkState(now);
  add(s, 'p1', 'm1', 'normal');
  add(s, 'p1', 'm2', 'normal');
  add(s, 'p1', 'm3', 'normal');
  add(s, 'p1', 'm4', 'normal');
  A.reschedule(s, now);
  assert.strictEqual(s.tasks.filter((t) => t.slot === 0).length, 3);
  assert.strictEqual(s.tasks.filter((t) => t.slot === 1).length, 1);
});

console.log('2) 最小间隔约束');
test('间隔 60 分钟时，同药第二剂最早在第 6 槽', () => {
  const s = mkState(now, { lastGiven: now - 10 * 60000, min: 60 }); // 10 分钟前给药
  const t1 = add(s, 'p1', 'm1', 'normal');
  const t2 = add(s, 'p1', 'm1', 'normal');
  A.reschedule(s, now);
  assert.strictEqual(t1.slot, 5, '第一剂应在第 5 槽（50 分钟后，间隔恰满 60）');
  assert.strictEqual(t2.slot, 11, '第二剂与第一剂再隔 6 槽');
});

console.log('3) 高优先级插队挤掉普通任务，普通任务自动重排');
test('普通任务先排满槽 0，高优任务插入槽 0 后普通任务顺延且仍满足间隔', () => {
  const s = mkState(now);
  const norms = [add(s, 'p1', 'm1', 'normal'), add(s, 'p1', 'm3', 'normal'), add(s, 'p1', 'm4', 'normal')];
  A.reschedule(s, now);
  assert.deepStrictEqual(norms.map((t) => t.slot), [0, 0, 0]);

  const hi = add(s, 'p1', 'm2', 'high'); // 无间隔限制的另一种药
  A.reschedule(s, now);
  assert.strictEqual(hi.slot, 0, '高优抢到最早槽');
  const slot0 = s.tasks.filter((t) => t.slot === 0);
  assert.strictEqual(slot0.length, 3, '槽 0 仍只有三项');
  assert.strictEqual(new Set(slot0.map((t) => t.nurseId)).size, 3, '三名护理员各不重复');
  const displaced = norms.find((t) => t.slot === 1);
  assert.ok(displaced, '恰有一个普通任务被挤到槽 1');
});

console.log('4) 锁定急救不被移动');
test('已锁急救在槽 2/李护，加入高优后位置不变，其他任务避开她', () => {
  const s = mkState(now);
  s.pets[0].meds[0].minIntervalMin = 10;
  s.seq++;
  const lock = { id: 'L1', petId: 'p1', medId: 'm1', priority: 'emergency', preferNurseId: null, status: 'scheduled', slot: 2, nurseId: 'b', createdAt: 1 };
  s.tasks.push(lock);
  for (let i = 0; i < 6; i++) add(s, 'p1', 'm1', 'normal');
  add(s, 'p1', 'm1', 'high');
  A.reschedule(s, now);
  assert.strictEqual(lock.slot, 2);
  assert.strictEqual(lock.nurseId, 'b');
  const at2 = s.tasks.filter((t) => t.slot === 2);
  assert.strictEqual(at2.find((t) => t.nurseId === 'b'), lock, '李护槽 2 仍只有急救');
  // 急救与其前后同药任务间隔
  at2.concat(s.tasks.filter((t) => t.slot === 1 || t.slot === 3)).forEach(() => {});
  s.tasks.filter((t) => t !== lock).forEach((t) => {
    assert.ok(Math.abs(t.slot - 2) >= 1, '有任务与急救间隔不足');
    if (t.slot === 2) assert.notStrictEqual(t.nurseId, 'b');
  });
});

console.log('5) 找不到槽 → 待排并给出原因');
test('最小间隔 1440 分钟且从未给药的药在 12h 窗口内可排；间隔 24h 且 1 小时前刚给药则待排', () => {
  const s = mkState(now);
  s.pets[0].meds[1].minIntervalMin = 1440;
  const okTask = add(s, 'p1', 'm2', 'normal');
  A.reschedule(s, now);
  assert.strictEqual(okTask.status, 'scheduled');

  // 另造一个药：间隔 24h、1h 前刚给药
  s.pets[0].meds.push({ id: 'mLONG', name: '药C', note: '', minIntervalMin: 1440, lastGiven: now - 60 * 60000 });
  const badTask = add(s, 'p1', 'mLONG', 'normal');
  A.reschedule(s, now);
  assert.strictEqual(badTask.status, 'pending');
  assert.ok(badTask.conflict.reason.includes('超出 12 小时排班窗口'), badTask.conflict.reason);
});

test('容量耗尽：窗口只剩 1 槽且三护理员被急救锁死 → 容量冲突原因', () => {
  const s = mkState(now);
  s.pets[0].meds[0].minIntervalMin = 60 * 24; // 同药不互扰靠不同 med…这里直接锁占护理员
  // 让窗口只剩最后一个槽：把 lastGiven 设到窗口末槽附近（间隔 10 分钟药）
  s.pets[0].meds[0].minIntervalMin = 10;
  s.pets[0].meds[0].lastGiven = now + (A.HORIZON_SLOTS - 2) * A.SLOT_MS - 5 * 60000;
  // 三名护理员在最后一槽全被急救锁定（另造三个药避免间隔互扰）
  ['x1', 'x2', 'x3'].forEach((id) => s.pets[0].meds.push({ id, name: id, note: '', minIntervalMin: 10, lastGiven: null }));
  ['a', 'b', 'c'].forEach((nid, i) => {
    s.tasks.push({ id: 'L' + i, petId: 'p1', medId: 'x' + (1 + i), priority: 'emergency', preferNurseId: null, status: 'scheduled', slot: A.HORIZON_SLOTS - 1, nurseId: nid, createdAt: i + 1 });
  });
  const t = add(s, 'p1', 'm1', 'normal');
  A.reschedule(s, now);
  assert.strictEqual(t.status, 'pending');
  assert.ok(t.conflict.reason.includes('护理员') || t.conflict.reason.includes('锁定'), t.conflict.reason);
});

console.log('6) 急救即时锁定的前置校验');
test('间隔不足时拒绝锁定；普通任务挡路不拒绝（重排会挪走）', () => {
  const s = mkState(now, { lastGiven: now - 5 * 60000, min: 60 });
  let t = add(s, 'p1', 'm1', 'emergency');
  let plan = A.planEmergency(s, now, 'a')(t);
  assert.strictEqual(plan.ok, false);
  assert.ok(plan.message.includes('不足'));

  const s2 = mkState(now, { lastGiven: now - 120 * 60000, min: 60 });
  s2.tasks.push({ id: 'n1', petId: 'p1', medId: 'm1', priority: 'normal', preferNurseId: null, status: 'scheduled', slot: 0, nurseId: 'a', createdAt: 1 });
  t = add(s2, 'p1', 'm1', 'emergency');
  plan = A.planEmergency(s2, now, 'b')(t);
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.nurseId, 'b');
  t.status = 'scheduled'; t.slot = plan.slot; t.nurseId = plan.nurseId;
  A.reschedule(s2, now);
  assert.strictEqual(t.slot, 0);
  const moved = s2.tasks.find((x) => x.id === 'n1');
  assert.strictEqual(moved.slot, 6, '挡路的普通任务被挤到满足间隔的槽位');
  assert.notStrictEqual(moved.nurseId, 'b', '且不与急救同护理员');
});

console.log('7) 过槽归档：完成的任务回写 lastGiven 并移除');
test('锚点前两槽的任务在 now 推进后被归档', () => {
  const s = mkState(now);
  s.tasks.push({ id: 'old', petId: 'p1', medId: 'm1', priority: 'normal', preferNurseId: null, status: 'scheduled', slot: -1, nurseId: 'a', createdAt: 1 });
  const before = s.pets[0].meds[0].lastGiven;
  A.reschedule(s, now);
  assert.strictEqual(s.tasks.find((t) => t.id === 'old'), undefined);
  assert.strictEqual(s.pets[0].meds[0].lastGiven, s.horizonStart - A.SLOT_MS);
  assert.notStrictEqual(s.pets[0].meds[0].lastGiven, before);
});

console.log(`\n${passed} 项通过`);
