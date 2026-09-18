/* ============================================================
 * 宠物住院喂药排班台 —— 纯前端
 * 规则：
 *  - 10 分钟一槽，排班窗口 12 小时（72 槽）
 *  - 每位护理员同一槽最多一项
 *  - 同一药物两次给药间隔 >= 该药物最小间隔（与上次给药 / 锁定任务 / 已排任务三方比对）
 *  - 高优先级任务优先选取最早槽位，可挤掉普通任务；被挤掉的普通任务重新找槽
 *  - 急救任务一旦落槽即锁定，不参与重排，也不能被插队移动
 *  - 找不到合规槽位的任务保持“待排”，并给出具体冲突原因
 * ============================================================ */

'use strict';

const SLOT_MS = 10 * 60 * 1000;
const HORIZON_SLOTS = 72; // 12 小时
const SLOT_W = 46;        // 与 styles.css 的 --slot-w 保持一致
const STORAGE_KEY = 'pet-med-board-v1';

const PRIORITY = {
  normal: { rank: 1, label: '普通' },
  high: { rank: 0, label: '高优先级' },
  emergency: { rank: -1, label: '急救' },
};

/* ---------------- 预置数据 ---------------- */

function seedPets(now) {
  const ago = (m) => now - m * 60 * 1000;
  return [
    {
      id: 'p1', name: '布丁', species: '柯基 · 术后留观', avatar: '🐕',
      meds: [
        { id: 'm1', name: '阿莫西林', note: '口服 0.25g', minIntervalMin: 240, lastGiven: ago(50) },
        { id: 'm2', name: '美洛昔康', note: '口服 0.1mg/kg', minIntervalMin: 720, lastGiven: ago(700) },
      ],
    },
    {
      id: 'p2', name: '雪球', species: '英短猫 · 肠胃炎', avatar: '🐈',
      meds: [
        { id: 'm3', name: '甲硝唑', note: '口服 15mg/kg', minIntervalMin: 480, lastGiven: ago(460) },
        { id: 'm4', name: '胰岛素', note: '皮下 2U', minIntervalMin: 720, lastGiven: ago(690) },
      ],
    },
    {
      id: 'p3', name: '大黄', species: '金毛 · 抢救中', avatar: '🦮',
      meds: [
        { id: 'm5', name: '头孢喹肟', note: '静注 15mg/kg', minIntervalMin: 360, lastGiven: ago(350) },
        { id: 'm6', name: '肾上腺素', note: '静推 0.01mg/kg', minIntervalMin: 20, lastGiven: ago(120) },
      ],
    },
    {
      id: 'p4', name: '跳跳', species: '垂耳兔 · 呼吸道感染', avatar: '🐇',
      meds: [
        { id: 'm7', name: '恩诺沙星', note: '口服 5mg/kg', minIntervalMin: 720, lastGiven: ago(700) },
      ],
    },
    {
      id: 'p5', name: '龟万年', species: '苏卡达 · 脱水补液', avatar: '🐢',
      meds: [
        { id: 'm8', name: '电解质补液', note: '灌服 10ml', minIntervalMin: 360, lastGiven: ago(340) },
      ],
    },
    {
      id: 'p6', name: '团子', species: '布偶猫 · 牙痛', avatar: '🐈‍⬛',
      meds: [
        { id: 'm9', name: '多西环素', note: '口服 5mg/kg', minIntervalMin: 720, lastGiven: ago(710) },
        { id: 'm10', name: '加巴喷丁', note: '口服 10mg/kg', minIntervalMin: 480, lastGiven: ago(460) },
      ],
    },
  ];
}

const SEED_NURSES = [
  { id: 'a', name: '王护', color: 'var(--nurse-a)' },
  { id: 'b', name: '李护', color: 'var(--nurse-b)' },
  { id: 'c', name: '赵护', color: 'var(--nurse-c)' },
];

/** 预置任务：lastGiven 决定了最早可排槽位；急救任务锁定在锚点 + 3 槽（全部交给排班器或直接锁定） */
function seedTasks() {
  const T = (petId, medId, priority, createdAt, slot = null, nurseId = null) =>
    ({ id: 't' + createdAt, petId, medId, priority, status: slot === null ? 'pending' : 'scheduled', slot, nurseId, createdAt });
  return [
    T('p3', 'm5', 'normal', 1),
    T('p6', 'm9', 'normal', 2),
    T('p1', 'm2', 'normal', 3),
    T('p2', 'm3', 'normal', 4),
    T('p4', 'm7', 'normal', 5),
    T('p5', 'm8', 'normal', 6),
    T('p6', 'm10', 'normal', 7),
    T('p2', 'm4', 'normal', 8),
    T('p1', 'm1', 'normal', 9),
    T('p3', 'm5', 'normal', 10),       // 头孢第二剂（同药间隔 6h）
    T('p2', 'm3', 'normal', 11),       // 甲硝唑第二剂（+8h）
    T('p2', 'm4', 'normal', 12),       // 胰岛素第二剂（+12h，会超出窗口 → 待排演示）
    T('p3', 'm6', 'high', 13),         // 高优先级肾上腺素：插到最前
    T('p3', 'm6', 'emergency', 14, 3, 'b'), // 锁定急救：李护，锚点 +3 槽
  ];
}

function createSeedState(now) {
  const anchor = floorToSlot(now);
  return {
    seq: 100,
    horizonStart: anchor,
    nurses: SEED_NURSES.map((n) => ({ ...n })),
    pets: seedPets(now),
    tasks: seedTasks(),
  };
}

/* ---------------- 工具 ---------------- */

function floorToSlot(ts) {
  return Math.floor(ts / SLOT_MS) * SLOT_MS;
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtHM(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtTimeShort(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtRel(ts, now) {
  const diff = Math.round((ts - now) / 60000);
  if (diff === 0) return '现在';
  if (diff > 0) return `${diff} 分钟后`;
  const a = -diff;
  if (a < 60) return `${a} 分钟前`;
  const h = Math.floor(a / 60), m = a % 60;
  return m ? `${h} 小时 ${m} 分钟前` : `${h} 小时前`;
}
function fmtInterval(min) {
  if (min < 60) return `${min} 分钟`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} 小时` : `${h.toFixed(1)} 小时`;
}

function findMed(state, petId, medId) {
  const pet = state.pets.find((p) => p.id === petId);
  const med = pet && pet.meds.find((m) => m.id === medId);
  return { pet, med };
}

/* ---------------- 排班核心 ---------------- */

/** 窗口随时间整体前滚：当前槽滑出窗口后，把窗口对齐到当前槽，窗外的任务视为已给药并归档 */
function ensureHorizon(state, now) {
  const nowSlotInWindow = Math.floor((now - state.horizonStart) / SLOT_MS);
  if (nowSlotInWindow < HORIZON_SLOTS - 6) return;

  const oldAnchor = state.horizonStart;
  const newAnchor = floorToSlot(now);
  const archived = [];
  state.tasks = state.tasks.filter((task) => {
    if (task.slot === null) return true;
    const endAt = oldAnchor + (task.slot + 1) * SLOT_MS;
    if (endAt <= newAnchor) { archived.push(task); return false; }
    return true;
  });
  archived.forEach((t) => {
    const { med } = findMed(state, t.petId, t.medId);
    if (med) med.lastGiven = oldAnchor + t.slot * SLOT_MS;
  });
  // 窗外未归档（锁定但窗口还没到结束）的任务按新锚点换算
  state.tasks.forEach((t) => {
    if (t.slot !== null) {
      const ts = oldAnchor + t.slot * SLOT_MS;
      t.slot = Math.round((ts - newAnchor) / SLOT_MS);
      if (t.slot >= HORIZON_SLOTS) {
        t.status = 'pending'; t.slot = null; t.nurseId = null;
      }
    }
  });
  state.horizonStart = newAnchor;
}

/**
 * 主排班流程（原地修改 state.tasks）。
 * 1. 已过完整槽的任务视为已给药：回写 lastGiven 并移除
 * 2. 锁定急救固定不动，建立占用表
 * 3. 其余任务按 高优先级 → 普通（再按加入先后）贪心选最早合规槽
 * 4. 落不了槽的任务保持 pending
 */
function reschedule(state, now) {
  ensureHorizon(state, now);
  const anchor = state.horizonStart;
  const nowSlot = Math.floor((now - anchor) / SLOT_MS);

  // 1) 过槽任务归档
  const archived = [];
  state.tasks = state.tasks.filter((task) => {
    if (task.status === 'pending' || task.slot === null) return true;
    const administeredAt = anchor + (task.slot + 1) * SLOT_MS;
    if (administeredAt <= now) {
      archived.push(task);
      return false;
    }
    return true;
  });
  archived.forEach((t) => {
    const { med } = findMed(state, t.petId, t.medId);
    if (med) med.lastGiven = anchor + t.slot * SLOT_MS;
  });

  // 2) 锁定任务
  const locked = state.tasks.filter((t) => t.priority === 'emergency' && t.slot !== null);
  const occByNurse = new Map();     // `${nurse}:${slot}` -> task
  const sameMedSlots = new Map();   // `${pet}:${med}` -> [{slot, task}]
  const load = new Map(state.nurses.map((n) => [n.id, 0]));

  locked.forEach((t) => {
    if (t.slot < 0 || t.slot >= HORIZON_SLOTS) return;
    occByNurse.set(`${t.nurseId}:${t.slot}`, t);
    pushSameMed(sameMedSlots, t);
    load.set(t.nurseId, (load.get(t.nurseId) || 0) + 1);
  });

  // 3) 候选任务：全部待排 + 全部非锁定已排（可被插队重排）
  const candidates = state.tasks
    .filter((t) => t.priority !== 'emergency')
    .sort((a, b) =>
      PRIORITY[a.priority].rank - PRIORITY[b.priority].rank ||
      a.createdAt - b.createdAt ||
      (a.id < b.id ? -1 : 1));

  candidates.forEach((task) => {
    const place = findEarliestSlot(state, task, nowSlot, occByNurse, sameMedSlots, load);
    if (place) {
      task.status = 'scheduled';
      task.slot = place.slot;
      task.nurseId = place.nurseId;
      occByNurse.set(`${place.nurseId}:${place.slot}`, task);
      pushSameMed(sameMedSlots, task);
      load.set(place.nurseId, (load.get(place.nurseId) || 0) + 1);
    } else {
      task.status = 'pending';
      task.slot = null;
      task.nurseId = null;
    }
  });

  // 4) 待排任务写明冲突原因
  state.tasks
    .filter((t) => t.status === 'pending')
    .forEach((t) => { t.conflict = diagnose(state, t, nowSlot, occByNurse, sameMedSlots); });

  return state;
}

function pushSameMed(map, task) {
  const key = `${task.petId}:${task.medId}`;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push({ slot: task.slot, task });
}

/** 在 [nowSlot, HORIZON) 内找最早的合规槽 + 最空闲护理员 */
function findEarliestSlot(state, task, nowSlot, occByNurse, sameMedSlots, load) {
  const { med } = findMed(state, task.petId, task.medId);
  const intervalMs = med.minIntervalMin * 60000;
  const anchor = state.horizonStart;

  let earliest = nowSlot;
  if (med.lastGiven) {
    earliest = Math.max(earliest, Math.ceil((med.lastGiven + intervalMs - anchor) / SLOT_MS));
  }

  const others = (sameMedSlots.get(`${task.petId}:${task.medId}`) || [])
    .filter((x) => x.task.id !== task.id);

  const start = Math.max(0, earliest);
  if (start >= HORIZON_SLOTS) return null;
  for (let t = start; t < HORIZON_SLOTS; t++) {
    const tTime = anchor + t * SLOT_MS;
    if (med.lastGiven && tTime < med.lastGiven + intervalMs) continue;
    if (others.some((x) => Math.abs(t - x.slot) * SLOT_MS / 60000 < med.minIntervalMin)) continue;

    const free = state.nurses.filter((n) => !occByNurse.has(`${n.id}:${t}`));
    if (free.length === 0) continue;

    free.sort((x, y) => (load.get(x.id) || 0) - (load.get(y.id) || 0) || (x.id < y.id ? -1 : 1));
    // 用户指定护理员时为软偏好：她在该槽空闲则优先她，否则仍由最空闲者承接
    if (task.preferNurseId && free.some((n) => n.id === task.preferNurseId)) {
      return { slot: t, nurseId: task.preferNurseId };
    }
    return { slot: t, nurseId: free[0].id };
  }
  return null;
}

/**
 * 待排任务诊断：给出可直接读懂的冲突原因。
 * A. 窗口内连“只考虑锁定任务”都没有满足间隔的槽 → 间隔 / 锁定封锁
 * B. 有合规槽但全部护理员被占满 → 容量冲突（列出最近合规槽的占用者）
 * 注：被诊断任务自身不在 occByNurse / sameMedSlots 中（它没排上）。
 */
function diagnose(state, task, nowSlot, finalOcc, finalSameMed) {
  const { med, pet } = findMed(state, task.petId, task.medId);
  const anchor = state.horizonStart;
  const intervalMs = med.minIntervalMin * 60000;

  let earliest = nowSlot;
  if (med.lastGiven) {
    earliest = Math.max(earliest, Math.ceil((med.lastGiven + intervalMs - anchor) / SLOT_MS));
  }

  // 与本任务冲突的锁定同药任务
  const lockedSame = state.tasks.filter(
    (t) => t.priority === 'emergency' && t.slot !== null &&
      t.petId === task.petId && t.medId === task.medId && t.id !== task.id);

  // 排班器视角：最终排上的其他同药任务（含锁定）
  const placedSame = (finalSameMed.get(`${task.petId}:${task.medId}`) || [])
    .filter((x) => x.task.id !== task.id);

  const intervalFineLockedOnly = (t) => {
    const tTime = anchor + t * SLOT_MS;
    if (med.lastGiven && tTime < med.lastGiven + intervalMs) return false;
    return !lockedSame.some((l) => Math.abs(t - l.slot) * SLOT_MS / 60000 < med.minIntervalMin);
  };
  const intervalFineFinal = (t) =>
    intervalFineLockedOnly(t) &&
    !placedSame.some((x) => Math.abs(t - x.slot) * SLOT_MS / 60000 < med.minIntervalMin);

  const earliestLabel = earliest >= HORIZON_SLOTS
    ? fmtHM(anchor + earliest * SLOT_MS)
    : null;

  // 先看“若无锁定任务”是否存在可行槽（仅受 lastGiven 限制）
  let anyWithoutLocks = false;
  for (let t = Math.max(0, earliest); t < HORIZON_SLOTS; t++) {
    const tTime = anchor + t * SLOT_MS;
    if (med.lastGiven && tTime < med.lastGiven + intervalMs) continue;
    anyWithoutLocks = true; break;
  }
  if (!anyWithoutLocks) {
    return {
      reason: `距上次给药未满最小间隔（${fmtInterval(med.minIntervalMin)}），最早可排时间 ${earliestLabel}，已超出 12 小时排班窗口`,
      detail: med.lastGiven
        ? `${pet.name}「${med.name}」上次给药：${fmtHM(med.lastGiven)}（${fmtRel(med.lastGiven, anchor + nowSlot * SLOT_MS)}）`
        : '',
    };
  }

  // 只受锁定任务限制时的可行槽
  const feasibleIfLocks = [];
  for (let t = Math.max(0, earliest); t < HORIZON_SLOTS; t++) {
    if (intervalFineLockedOnly(t)) feasibleIfLocks.push(t);
  }
  if (feasibleIfLocks.length === 0) {
    const blk = lockedSame
      .map((l) => `${fmtHM(anchor + l.slot * SLOT_MS)} 锁定急救（${findMed(state, l.petId, l.medId).pet.name}）`)
      .join('；');
    return {
      reason: `满足最小间隔的槽位均被已锁定的急救任务封锁，急救任务不可移动`,
      detail: `锁定点：${blk}`,
    };
  }

  // 考虑全部已排同药任务后的可行槽
  const feasible = feasibleIfLocks.filter(intervalFineFinal);
  if (feasible.length === 0) {
    // 窗口外有解：最早合法槽由已排同药任务推出
    const beyond = placedSame
      .map((x) => x.slot + med.minIntervalMin / (SLOT_MS / 60000))
      .filter((t) => t >= HORIZON_SLOTS);
    const label = beyond.length ? fmtHM(anchor + Math.min(...beyond) * SLOT_MS) : earliestLabel;
    const who = placedSame
      .map((x) => `${fmtHM(anchor + x.slot * SLOT_MS)} ${x.task.priority === 'emergency' ? '急救' : '已排'}（${findMed(state, x.task.petId, x.task.medId).pet.name}）`)
      .join('；');
    return {
      reason: `与同药已排任务保持 ${fmtInterval(med.minIntervalMin)} 间隔后，下一剂最早 ${label}，已超出 12 小时排班窗口`,
      detail: `同药已排：${who}`,
    };
  }

  // 有合规槽：看容量
  const open = feasible.filter((t) =>
    state.nurses.some((n) => !finalOcc.has(`${n.id}:${t}`)));
  if (open.length > 0) {
    // 理论上不该发生（贪心可落槽），保底文案
    return { reason: '排班器未找到槽位，请点“立即重排”重试', detail: '' };
  }

  const near = feasible.slice(0, 3).map((t) => {
    const who = state.nurses
      .map((n) => finalOcc.get(`${n.id}:${t}`))
      .filter(Boolean)
      .map((x) => {
        const { pet: p, med: md } = findMed(state, x.petId, x.medId);
        return `${state.nurses.find((n) => n.id === x.nurseId).name}${x.priority === 'emergency' ? '急救锁定' : ''}:${p.name}${md.name}`;
      })
      .join('、');
    return `${fmtHM(anchor + t * SLOT_MS)}（${who}）`;
  });

  return {
    reason: `满足最小间隔的槽位上，三名护理员均已被占用（同槽每人仅能执行一项），无法插入`,
    detail: `最近合规槽位：${near.join('；')}`,
  };
}

/**
 * 加入急救任务前校验：目标 = 当前槽，不能与锁定任务同护理员同槽，
 * 且与上次给药 / 已排同药任务（正在执行或锁定）满足间隔。
 * 返回 {ok:true, nurseId} 或 {ok:false, message}
 */
function planEmergency(state, now, preferredNurseId) {
  const anchor = state.horizonStart;
  const nowSlot = Math.max(0, Math.floor((now - anchor) / SLOT_MS));
  return (task) => {
    const { med, pet } = findMed(state, task.petId, task.medId);
    const intervalMs = med.minIntervalMin * 60000;
    const tTime = anchor + nowSlot * SLOT_MS;

    if (med.lastGiven && tTime - med.lastGiven < intervalMs) {
      const wait = Math.ceil((med.lastGiven + intervalMs - now) / 60000);
      return { ok: false, message: `无法锁定：${pet.name}「${med.name}」距上次给药（${fmtHM(med.lastGiven)}）不足 ${fmtInterval(med.minIntervalMin)}，还需约 ${wait} 分钟` };
    }
    // 仅已锁定急救不可移动，构成硬冲突；普通/高优任务会在随后的重排中自动挪走
    const lockedClash = state.tasks.find((x) =>
      x.priority === 'emergency' && x.slot !== null &&
      x.petId === task.petId && x.medId === task.medId &&
      Math.abs(x.slot - nowSlot) * SLOT_MS < intervalMs);
    if (lockedClash) {
      return {
        ok: false,
        message: `无法锁定：${fmtHM(anchor + lockedClash.slot * SLOT_MS)} 已有一剂同药急救锁定，间隔不足 ${fmtInterval(med.minIntervalMin)}，锁定任务不可移动`,
      };
    }

    const lockedHere = state.tasks.filter(
      (x) => x.priority === 'emergency' && x.slot === nowSlot);
    if (preferredNurseId) {
      if (lockedHere.some((x) => x.nurseId === preferredNurseId)) {
        const n = state.nurses.find((x) => x.id === preferredNurseId);
        return { ok: false, message: `无法锁定：${n.name} 在当前槽已有急救任务且不可移动` };
      }
      return { ok: true, nurseId: preferredNurseId, slot: nowSlot };
    }
    const free = state.nurses.filter((n) => !lockedHere.some((x) => x.nurseId === n.id));
    if (free.length === 0) {
      return { ok: false, message: '无法锁定：当前槽三名护理员均在执行急救任务' };
    }
    return { ok: true, nurseId: free[0].id, slot: nowSlot };
  };
}

/* ---------------- 状态持久化 ---------------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.tasks) || !Array.isArray(s.pets)) return null;
    return s;
  } catch { return null; }
}
function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 隐私模式等 */ }
}

/* ============================================================
 * 以下为浏览器 UI 层（Node 环境不执行）
 * ============================================================ */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {

let state = loadState() || createSeedState(Date.now());
reschedule(state, Date.now());
saveState(state);

const $ = (sel) => document.querySelector(sel);

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------------- 渲染：宠物档案 ---------------- */
function renderPets() {
  const now = Date.now();
  $('#pets-list').innerHTML = '';
  state.pets.forEach((pet) => {
    const card = document.createElement('div');
    card.className = 'pet-card';
    const medRows = pet.meds.map((m) => `
      <li>
        <span>
          <span class="med-name">${m.name}</span>
          <span class="med-note"> · ${m.note} · 间隔≥${fmtInterval(m.minIntervalMin)}</span><br>
          <span class="med-last">上次 ${fmtHM(m.lastGiven)}（${fmtRel(m.lastGiven, now)}）</span>
        </span>
        <button type="button" class="quick-add" data-pet="${pet.id}" data-med="${m.id}" title="加入此药的给药任务">＋给药</button>
      </li>`).join('');
    card.innerHTML = `
      <div class="pet-head">
        <span class="pet-avatar">${pet.avatar}</span>
        <span>
          <span class="pet-name">${pet.name}</span>
          <span class="pet-meta"> · ${pet.species}</span>
        </span>
      </div>
      <ul class="med-list">${medRows}</ul>`;
    $('#pets-list').appendChild(card);
  });
}

/* ---------------- 渲染：表单 ---------------- */
function fillMedicationSelect(preferKey) {
  const sel = $('#f-medication');
  sel.innerHTML = '';
  state.pets.forEach((pet) => {
    const og = document.createElement('optgroup');
    og.label = `${pet.avatar} ${pet.name}`;
    pet.meds.forEach((m) => {
      const o = document.createElement('option');
      o.value = `${pet.id}:${m.id}`;
      o.textContent = `${m.name}（间隔≥${fmtInterval(m.minIntervalMin)}）`;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  if (preferKey) sel.value = preferKey;
  updateMedHint();
}
function updateMedHint() {
  const [petId, medId] = $('#f-medication').value.split(':');
  const { pet, med } = findMed(state, petId, medId);
  if (!med) return;
  const now = Date.now();
  const anchor = state.horizonStart;
  const nowSlot = Math.floor((now - anchor) / SLOT_MS);
  const earliest = Math.max(nowSlot, Math.ceil((med.lastGiven + med.minIntervalMin * 60000 - anchor) / SLOT_MS));
  const at = anchor + earliest * SLOT_MS;
  $('#f-med-hint').textContent =
    `${pet.name} · ${med.note}｜上次 ${fmtHM(med.lastGiven)}，最早可排 ${fmtHM(at)}（${fmtRel(at, now)}）`;
}
function updatePriorityHint() {
  const v = $('#f-priority').value;
  const map = {
    normal: '按加入顺序排队；如被高优先级插队，会自动重新找槽。',
    high: '优先抢占最早合规槽，可挤掉普通任务；挤掉的普通任务自动重排。',
    emergency: '立即锁定在当前槽，任何人都不能移动或挤掉它；违反间隔将被拒绝。',
  };
  $('#f-priority-hint').textContent = map[v];
}

function fillNurseSelect() {
  const sel = $('#f-nurse');
  sel.innerHTML = '<option value="">自动（选最空闲护理员）</option>' +
    state.nurses.map((n) => `<option value="${n.id}">${n.name}</option>`).join('');
}

/* ---------------- 渲染：甘特图 ---------------- */
function renderGantt() {
  const now = Date.now();
  const anchor = state.horizonStart;
  const nowSlotFloat = (now - anchor) / SLOT_MS;
  const nowSlot = Math.floor(nowSlotFloat);

  const gantt = $('#gantt');
  gantt.style.setProperty('--slots', HORIZON_SLOTS);

  // 标尺
  const ruler = $('#gantt-ruler');
  ruler.innerHTML = '';
  for (let t = 0; t < HORIZON_SLOTS; t++) {
    const tick = document.createElement('div');
    const major = t % 6 === 0;
    tick.className = 'tick' + (major ? ' major' : '');
    tick.textContent = major ? fmtHM(anchor + t * SLOT_MS) : '';
    ruler.appendChild(tick);
  }

  // 行
  const rows = $('#gantt-rows');
  rows.innerHTML = '';
  state.nurses.forEach((nurse, rowIdx) => {
    const gridRow = rowIdx + 2;
    const label = document.createElement('div');
    label.className = 'row-label';
    label.style.gridRow = gridRow;
    label.style.gridColumn = 1;
    const loadCount = state.tasks.filter((t) => t.status === 'scheduled' && t.nurseId === nurse.id).length;
    label.innerHTML = `
      <span class="nurse-name"><span class="nurse-dot" style="background:${nurse.color}"></span>${nurse.name}</span>
      <span class="nurse-load">${loadCount} 项</span>`;
    rows.appendChild(label);

    for (let t = 0; t < HORIZON_SLOTS; t++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (Math.floor(t / 6) % 2 === 1) cell.classList.add('zebra');
      if (t % 6 === 5) cell.classList.add('hourline');
      cell.style.gridRow = gridRow;
      cell.style.gridColumn = t + 2;
      rows.appendChild(cell);
    }
  });

  // 任务块
  state.tasks.filter((t) => t.status === 'scheduled' && t.slot !== null)
    .forEach((task) => {
      const { pet, med } = findMed(state, task.petId, task.medId);
      const nurseIdx = state.nurses.findIndex((n) => n.id === task.nurseId);
      const chip = document.createElement('div');
      const past = task.slot < nowSlot;
      chip.className = `task-chip p-${task.priority}${past ? ' past' : ''}`;
      chip.style.gridRow = nurseIdx + 2;
      chip.style.gridColumn = task.slot + 2;
      chip.dataset.id = task.id;
      const lock = task.priority === 'emergency'
        ? '<span class="chip-lock">🔒</span>' : '';
      chip.innerHTML =
        `${lock}<div class="chip-pet">${pet.avatar}${pet.name}</div>` +
        `<div class="chip-med">${med.name}</div>` +
        `<button class="chip-del" title="删除任务" data-id="${task.id}"
          style="position:absolute;right:1px;bottom:0;border:none;background:none;color:inherit;cursor:pointer;font-size:10px;opacity:.65;padding:0 2px;">✕</button>`;
      const nurse = state.nurses.find((n) => n.id === task.nurseId);
      chip.title =
        `${fmtHM(anchor + task.slot * SLOT_MS)} · ${nurse.name}\n` +
        `${pet.name}（${pet.species}）\n${med.name} · ${med.note}\n` +
        `最小间隔：${fmtInterval(med.minIntervalMin)}｜优先级：${PRIORITY[task.priority].label}` +
        (task.priority === 'emergency' ? '\n🔒 已锁定，不可移动' : '');
      rows.appendChild(chip);
    });

  // 当前时间线
  const old = gantt.querySelector('.now-marker');
  if (old) old.remove();
  if (nowSlot >= -1 && nowSlot <= HORIZON_SLOTS) {
    const marker = document.createElement('div');
    marker.className = 'now-marker';
    marker.style.left = `${86 + nowSlotFloat * SLOT_W}px`;
    marker.innerHTML = `<span>${fmtHM(now)}</span>`;
    gantt.appendChild(marker);
  }

  renderStats();
}

function renderStats() {
  const sched = state.tasks.filter((t) => t.status === 'scheduled');
  const pending = state.tasks.filter((t) => t.status === 'pending');
  const em = sched.filter((t) => t.priority === 'emergency').length;
  $('#stats').innerHTML =
    `<span>已排 <b>${sched.length}</b></span>` +
    `<span>待排 <b style="color:#b91c1c">${pending.length}</b></span>` +
    `<span>锁定急救 <b>${em}</b></span>` +
    state.nurses.map((n) => {
      const c = sched.filter((t) => t.nurseId === n.id).length;
      return `<span><span class="nurse-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${n.color};margin-right:3px"></span>${n.name} <b>${c}</b></span>`;
    }).join('');
}

/* ---------------- 渲染：待排 ---------------- */
function renderPending() {
  const wrap = $('#pending-list');
  wrap.innerHTML = '';
  const pending = state.tasks
    .filter((t) => t.status === 'pending')
    .sort((a, b) => PRIORITY[a.priority].rank - PRIORITY[b.priority].rank || a.createdAt - b.createdAt);

  if (pending.length === 0) {
    wrap.innerHTML = '<p class="pending-empty">全部任务都已落槽 ✅</p>';
    return;
  }
  pending.forEach((task) => {
    const { pet, med } = findMed(state, task.petId, task.medId);
    const card = document.createElement('div');
    card.className = 'pending-card';
    card.innerHTML = `
      <div class="pending-top">
        <span class="pending-title">${pet.avatar} ${pet.name} · ${med.name}
          <span class="priority-tag ${task.priority}">${PRIORITY[task.priority].label}</span>
        </span>
      </div>
      <p class="conflict-reason">⛔ ${task.conflict ? task.conflict.reason : '未找到合规槽位'}</p>
      ${task.conflict && task.conflict.detail ? `<p class="conflict-detail">${task.conflict.detail}</p>` : ''}
      <div class="pending-actions">
        ${task.priority === 'normal' ? `<button type="button" class="mini-btn" data-act="promote" data-id="${task.id}">⬆ 升为高优先级并重排</button>` : ''}
        <button type="button" class="mini-btn btn-danger" data-act="del" data-id="${task.id}">删除</button>
      </div>`;
    wrap.appendChild(card);
  });
}

function renderAll() {
  renderPets();
  renderGantt();
  renderPending();
}

/* ---------------- 交互 ---------------- */
function commit(msg, type) {
  reschedule(state, Date.now());
  saveState(state);
  renderAll();
  if (msg) toast(msg, type);
}

$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const [petId, medId] = $('#f-medication').value.split(':');
  const priority = $('#f-priority').value;
  const nurseVal = $('#f-nurse').value;
  const now = Date.now();
  if (!findMed(state, petId, medId).med) { toast('请选择有效药物', 'error'); return; }
  state.seq += 1;
  const task = {
    id: 'u' + state.seq,
    petId, medId, priority,
    preferNurseId: nurseVal || null,
    status: 'pending', slot: null, nurseId: null,
    createdAt: state.seq,
  };

  if (priority === 'emergency') {
    const plan = planEmergency(state, now, nurseVal || null)(task);
    if (!plan.ok) { toast(plan.message, 'error'); return; }
    task.status = 'scheduled';
    task.slot = plan.slot;
    task.nurseId = plan.nurseId;
    state.tasks.push(task);
    commit(`🔒 急救已锁定 ${fmtHM(state.horizonStart + plan.slot * SLOT_MS)} 槽，普通任务已自动重排`, 'warn');
    return;
  }

  state.tasks.push(task);
  commit(priority === 'high' ? '高优先级任务已加入并插队排班' : '任务已加入排班池');
});

$('#f-medication').addEventListener('change', updateMedHint);
$('#f-priority').addEventListener('change', updatePriorityHint);

$('#btn-reschedule').addEventListener('click', () => commit('已按最新时间重新排班'));

$('#btn-reset').addEventListener('click', () => {
  if (!window.confirm('确定清空本地数据并恢复预置的 6 只宠物、3 名护理员与示例任务？')) return;
  state = createSeedState(Date.now());
  reschedule(state, Date.now());
  saveState(state);
  fillMedicationSelect();
  renderAll();
  toast('已恢复预置数据');
});

// 宠物卡片：快捷加药
$('#pets-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.quick-add');
  if (!btn) return;
  fillMedicationSelect(`${btn.dataset.pet}:${btn.dataset.med}`);
  $('#f-priority').value = 'normal';
  updatePriorityHint();
  toast(`已选择 ${btn.dataset.pet} 的药物，确认紧急度后提交`);
});

// 待排卡片：升级 / 删除
$('#pending-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  if (btn.dataset.act === 'promote') {
    task.priority = 'high';
    commit(`已将任务升为高优先级并重新插队排班`);
  } else if (btn.dataset.act === 'del') {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    commit('任务已删除');
  }
});

// 甘特图任务块：删除（急救需二次确认）
$('#gantt-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-del');
  if (!btn) return;
  e.stopPropagation();
  const task = state.tasks.find((t) => t.id === btn.dataset.id);
  if (!task) return;
  if (task.priority === 'emergency') {
    if (!window.confirm('这是已锁定的急救任务，锁定记录不会被排班器移动；确定仍要手动删除？')) return;
  }
  state.tasks = state.tasks.filter((t) => t.id !== task.id);
  commit('任务已删除');
});

/* ---------------- 时钟与自动滚动 ---------------- */
function tickClock() {
  $('#clock').textContent = fmtTimeShort(Date.now());
}
setInterval(() => {
  tickClock();
  // 每 30 秒随时间推进重排（过槽归档、当前线移动）
  reschedule(state, Date.now());
  saveState(state);
  renderGantt();
  renderPending();
}, 30000);

fillMedicationSelect();
fillNurseSelect();
updatePriorityHint();
tickClock();
renderAll();

// 初始滚动到当前槽附近
requestAnimationFrame(() => {
  const nowSlot = Math.floor((Date.now() - state.horizonStart) / SLOT_MS);
  const scroller = $('#gantt-scroll');
  scroller.scrollLeft = Math.max(0, (nowSlot - 2) * SLOT_W);
});

} // browser guard

/* Node 导出（供算法自测） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SLOT_MS, HORIZON_SLOTS, floorToSlot, createSeedState,
    reschedule, findEarliestSlot, diagnose, planEmergency, findMed, fmtHM,
  };
}
