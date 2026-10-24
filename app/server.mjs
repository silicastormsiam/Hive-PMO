import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { addUsage, money, laneTotals } from './costs.mjs';
import { buildPass, SWEEP_EVERY_MS, REASONS } from './watch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PMO_PORT || 3470);
const PMO_HOME = process.env.PMO_HOME || '/var/lib/hive';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const LOG_PATH = process.env.HIVE_LOG || '/workspace/WORKORDER_LOG.txt';

const STAGES = [
  { key: 'capture',   name: 'Capture',   agent: 'Intake agent',     engine: 'harness', where: 'local', who: 'you',  duty: 'an idea or a job lands here and is classified before anything picks it up' },
  { key: 'analyse',   name: 'Analyse',   agent: 'Researcher agent', engine: 'harness', where: 'cloud', who: 'ai',   duty: 'research, blind spots, feasibility, a one-page case' },
  { key: 'approved',  name: 'Approved',  agent: 'THE HUMAN GATE',   engine: 'none',    where: 'none',  who: 'you',  duty: 'read the one-page case, decide, promote' },
  { key: 'planning',  name: 'Planning',  agent: 'Planning agent',   engine: 'harness', where: 'cloud', who: 'ai',   duty: 'break the work into tasks and sub-tasks and route a model to each' },
  { key: 'execution', name: 'Execution', agent: 'Coding agent',     engine: 'harness', where: 'auto',  who: 'ai',   duty: 'the work itself; the PM agent delegates and does not do it' },
  { key: 'testing',   name: 'Testing',   agent: 'Testing agent',    engine: 'harness', where: 'local', who: 'ai',   duty: 'check the work against what was asked for' },
  { key: 'feedback',  name: 'Feedback',  agent: 'Feedback agent',   engine: 'harness', where: 'local', who: 'both', duty: 'the last check of the work against what the card asked for; when it passes the card waits on the owner to confirm it completed' },
  { key: 'done',      name: 'Completed', agent: 'auto',             engine: 'none',    where: 'none',  who: 'ai',   duty: 'the work is finished; it stands here until everything on it is confirmed completed' },
  { key: 'archive',   name: 'Archive',   agent: 'resting',          engine: 'none',    where: 'none',  who: 'you',  duty: 'a confirmed-complete card rests here; nothing is archived until every part of it is completed' },
];
const STAGE = Object.fromEntries(STAGES.map((s) => [s.key, s]));
const ORDER = STAGES.map((s) => s.key);

let cards = [];

async function boot() {
  await pool.query(`create table if not exists cards (
    id serial primary key,
    key text unique not null,
    doc jsonb not null,
    updated_at timestamptz not null default now()
  )`);
  const r = await pool.query('select id, doc from cards order by id');
  cards = r.rows.map((x) => ({ ...x.doc, id: x.id }));
  console.log(`hive: ${cards.length} card(s) read out of the database`);
  await reconcile();
}

async function put(card) {
  if (!card.key || !NAMED.test(String(card.key))) {
    throw new Error('a card needs a work order number (WO-nnn) or a project number (PJ-nnn)');
  }
  const r = await pool.query(
    `insert into cards (key, doc) values ($1, $2::jsonb)
     on conflict (key) do update set doc = excluded.doc, updated_at = now()
     returning id`,
    [card.key, JSON.stringify(card)],
  );
  card.id = r.rows[0].id;
  await pool.query('update cards set doc = $2::jsonb where id = $1', [card.id, JSON.stringify(card)]);
  return card;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function bkkDate() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

async function ensureNumberSeq() {
  await pool.query(
    'create table if not exists number_seq (series text primary key, last_used integer not null)',
  );
}

function highestStanding(series) {
  const re = new RegExp('^' + series + '-(\\d+)$');
  let max = 0;
  for (const c of cards) {
    const m = String(c.key || '').match(re);
    if (m && Number(m[1]) > max && !isTestNumber(m[1])) max = Number(m[1]);
  }
  return max;
}

async function nextNumber(series) {
  await ensureNumberSeq();
  const top = highestStanding(series);
  const r = await pool.query(
    `insert into number_seq (series, last_used) values ($1, $2 + 1)
     on conflict (series) do update
       set last_used = greatest(number_seq.last_used, excluded.last_used - 1) + 1
     returning last_used`, [series, top]);
  return series + '-' + String(Number(r.rows[0].last_used)).padStart(3, '0');
}

async function numberUsed(series, n) {
  await ensureNumberSeq();
  const r = await pool.query('select last_used from number_seq where series = $1', [series]);
  const last = r.rows.length ? Number(r.rows[0].last_used) : 0;
  return n <= Math.max(last, highestStanding(series));
}

async function raiseSeries(series, n) {
  await ensureNumberSeq();
  await pool.query(
    `insert into number_seq (series, last_used) values ($1, $2)
     on conflict (series) do update
       set last_used = greatest(number_seq.last_used, excluded.last_used)`,
    [series, n]);
}

async function nextWorkOrderNumber(series) { return nextNumber(series || 'WO'); }
async function nextProjectNumber() { return nextNumber('PJ'); }

function workOrderEntry(key, title, body) {
  const date = bkkDate();
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const b = String(body || '').trim();
  return [
    `${key} - ${t}`,
    '',
    `Raised by the owner on the Hive board on ${date}.`,
    '',
    'What this is about.',
    b ? '  ' + b.replace(/\n/g, '\n  ') : '  Raised on the Hive board. What it is about is written here next.',
    '',
    'Where it stands now.',
    '  It stands in the first column. The next move is ours.',
    '',
    'What has been delivered.',
    '  Nothing yet.',
    '',
    'What is still owed.',
    '  The work itself. Ours.',
    '',
    'What happens next.',
    '  the owner says when it starts.',
    '',
  ].join('\n');
}

async function mintWorkOrder(title, body, series) {
  return nextWorkOrderNumber(series === 'CW' || series === 'PJ' ? series : 'WO');
}

function waitingOnOwner(card) {
  if (card.binnedAt || card.parkedAt) return false;
  if (card.pinkAt) return true;
  if (card.stage !== 'done' && card.stage !== 'archive') {
    const d = card.stageDone || {};
    if (card.stage === 'feedback' && d.feedback) return true;
    if (d.capture && d.analyse && d.approved && d.planning && d.execution && d.testing && d.feedback) return true;
  }
  return card.stage === 'approved' && !card.approvedAt;
}
const NAMED = /^(WO|PJ|CW)-\d{3,}$/;

const TEST_FROM = 900;
const isTestNumber = (n) => Number(n) >= TEST_FROM;
function named(card) {
  return NAMED.test(String(card.key || ''));
}

const WAITS_KEY = /^(WO|PJ)-\d{3,}$/;
function waitsOnList(card) {
  const raw = Array.isArray(card.waitsOn) ? card.waitsOn : (card.waitsOn ? [card.waitsOn] : []);
  const out = [];
  for (const x of raw) {
    const k = String(x || '').trim().toUpperCase();
    if (WAITS_KEY.test(k) && !out.includes(k)) out.push(k);
  }
  return out;
}
function dependencyState(card) {
  const waiting = [];
  for (const key of waitsOnList(card)) {
    const dep = cards.find((c) => String(c.key || '') === key);
    const finished = !!(dep && (dep.stage === 'done' || dep.stage === 'archive') && !dep.binnedAt);
    if (!finished) {
      waiting.push({
        key,
        onBoard: !!dep,
        stage: dep ? dep.stage : null,
        stageName: dep && STAGE[dep.stage] ? STAGE[dep.stage].name : null,
        binned: !!(dep && dep.binnedAt),
        parked: !!(dep && dep.parkedAt),
        failed: !!(dep && dep.failedAt),
      });
    }
  }
  return { held: waiting.length > 0, waiting };
}
const isProject = (card) => !!card && (card.kind === 'project' || card.pj === true);

const PROJECT_FIELDS = ['kind', 'rag', 'artefacts', 'open', 'openDecisions', 'decisionTotal',
  'lastTouched', 'next', 'folder', 'order', 'logState'];
function copyProjectFields(card, inc) {
  for (const k of PROJECT_FIELDS) {
    if (inc && inc[k] !== undefined) card[k] = inc[k];
  }
}

function readyForWork(card) {
  if (card.binnedAt || card.parkedAt || card.running) return false;
  if (card.stage !== 'capture' && !String(card.boundary || '').trim()) return false;
  if (card.stage === 'capture' && !named(card)) return false;
  if (card.failedAt) return false;
  if (card.pinkAt) return false;
  if (dependencyState(card).held) return false;
  if (waitingOnOwner(card)) return false;
  const st = STAGE[card.stage];
  if (!st || st.engine !== 'harness') return false;
  if (card.stageDone?.[card.stage]) return false;
  return true;
}
function nextStage(key) {
  const i = ORDER.indexOf(key);
  return i >= 0 && i + 1 < ORDER.length ? ORDER[i + 1] : null;
}

function previousStage(key) {
  const i = ORDER.indexOf(key);
  return i > 0 ? ORDER[i - 1] : null;
}

const REPAIR_ROUNDS = Number(process.env.HIVE_REPAIR_ROUNDS || 1);

const FAILED_RUNS_ALLOWED = Number(process.env.HIVE_FAILED_RUNS_ALLOWED || REPAIR_ROUNDS);

function turnPink(card, why) {
  card.pinkAt = new Date().toISOString();
  card.pinkWhy = String(why || '').slice(0, 600);
  card.failedAt = card.pinkAt;
  say(card, `TURNED BRIGHT PINK: ${card.pinkWhy} - this waits on the owner, and nothing runs it again by itself`);
}

async function sendToRepair(card, why) {
  let back = previousStage(card.stage);
  if (back === 'approved') back = previousStage('approved');
  if (!back) return false;
  const again = !!(card.repair && card.repair.checkStage === card.stage);
  const round = (again ? Number(card.repair.round || 0) : 0) + 1;
  const checkStage = again ? card.repair.checkStage : card.stage;
  if (round > REPAIR_ROUNDS) return false;
  card.repair = {
    at: new Date().toISOString(), fromStage: back, checkStage, round,
    note: String(why || '').slice(0, 4000),
  };
  card.stage = back;
  card.failedAt = null;
  card.moves.push({ at: new Date().toISOString(), to: back, note: 'sent back to be repaired; the fresh check follows' });
  owesWork(card, back);
  if (back === 'approved') { card.approvedAt = null; card.stageDone.approved = false; }
  return true;
}

function mayAdvance(card, to) {
  if (card.binnedAt) return { ok: false, why: 'that card is in the bin - bring it back first' };
  if (card.parkedAt) return { ok: false, why: 'that card is off your list - bring it back first' };
  if (to === 'archive') {
    if (!isProject(card) && card.stage !== 'done') {
      return { ok: false, why: 'only a card standing in Completed can go to the Archive' };
    }
    if (card.logState === 'open') {
      return { ok: false, why: 'the work order log says it is still open - it is not completed' };
    }
    if (!card.stageDone?.done) {
      return { ok: false, why: 'the card has not been confirmed completed yet' };
    }
    const openActions = (card.actions || []).filter((a) => !a.done).length;
    if (openActions) {
      return { ok: false, why: `${openActions} action(s) on this card are still open - it is not completed` };
    }
  }
  if (!isProject(card) && card.stage === 'capture' && !named(card)) {
    return { ok: false, why: 'Capture is not finished: this card carries no work order number and no project number, so nothing moves it on' };
  }
  if (waitingOnOwner(card)) return { ok: false, why: 'waiting on the owner: nothing passes the gate but by him' };
  const dep = dependencyState(card);
  if (card.stage !== 'approved' && dep.held) {
    return { ok: false, why: 'waiting on ' + dep.waiting.map((w) => w.key).join(', ') + ', which is not finished' };
  }
  if (card.running) return { ok: false, why: 'the stage worker is still running' };
  const restingProject = isProject(card) && to === 'archive' && !!card.stageDone?.done;
  if (!restingProject && !card.stageDone?.[card.stage]) return { ok: false, why: `the ${STAGE[card.stage].name} stage has not been completed yet` };
  return { ok: true };
}
const MINE_TO_CARRY = /mine to carry/i;
function owesWork(card, from) {  const j = ORDER.indexOf(from);
  if (j < 0) return;
  for (const k of ORDER.slice(j)) card.stageDone[k] = false;
}
async function advance(card, to) {
  const i = ORDER.indexOf(card.stage);
  const j = ORDER.indexOf(to);
  const projectToRest = isProject(card) && to === 'archive' && !!card.stageDone?.done;
  if (!projectToRest && j !== i + 1) return { ok: false, why: 'a card moves one stage at a time' };
  if (to === 'done') {
    return { ok: false, why: 'the stages finish the work; Completed is the owner\'s confirmation alone, and the card waits where it stands until he gives it' };
  }
  const gate = mayAdvance(card, to);
  if (!gate.ok) return gate;
  card.stage = to;
  card.moves.push({ at: new Date().toISOString(), to });
  owesWork(card, to);
  if (to === 'done' || to === 'archive') card.failedRuns = 0;
  if (to === 'done') card.archivedAt = new Date().toISOString();
  if (to === 'archive') {
    card.archivedAt = new Date().toISOString();
    card.stageDone.archive = true;
    say(card, 'the card was put in the Archive - everything on it was confirmed completed');
  }
  await touch(card);
  const ownWork = MINE_TO_CARRY.test(card.project || '') || /^CW-\d+$/.test(String(card.key || ''));
  if (to === 'approved' && ownWork) {
    card.approvedAt = new Date().toISOString();
    card.stageDone.approved = true;
    say(card, "the gate was not put to the owner: this order is the agent's own to carry, and an agent's own jobs are not put to the owner for approval");
    return advance(card, 'planning');
  }
  return { ok: true };
}
async function touch(card) {
  card.updatedAt = new Date().toISOString();
  await put(card);
}
function say(card, text) {
  card.activity.push({ at: new Date().toISOString(), text });
}
function newCard(b) {
  return {
    key: b.key || null,
    project: String(b.project || '').trim(),
    title: String(b.title || '').trim(),
    body: String(b.body || '').trim(),
    boundary: String(b.boundary || '').trim(),
    stage: 'capture',
    stageDone: {},
    waitsOn: waitsOnList(b),
    actions: b.actions || [],
    running: false,
    approvedAt: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    moves: [],
    activity: [],
    evidence: [],
    usage: null,
    costUsd: null,
    priceBasis: '',
  };
}

async function reconcile() {
  let owed = 0, moved = 0;
  for (const card of cards) {
    if (card.binnedAt || card.parkedAt || card.stage === 'done' || card.stage === 'archive') continue;
    if (!card.stageDone) card.stageDone = {};
    if (card.running && !card.hand) {
      card.running = false;
      say(card, 'no hand holds this card: the mark that says agent working was left by a worker that stopped, and it is off now');
      await touch(card);
    }
    if (card.stage === 'approved' && /^CW-\d+$/.test(String(card.key || '')) && !card.approvedAt) {
      card.approvedAt = new Date().toISOString();
      card.stageDone.approved = true;
      say(card, "the gate was not put to the owner: this is the agent's own card, and an agent's own jobs are not put to the owner for approval");
      await touch(card);
    }
    if (card.stage === 'approved') {
      if (card.approvedAt && !(card.stageDone && card.stageDone.approved)) {
        card.approvedAt = null;
        say(card, 'the owner has not answered yet: a stopped stage came back to this gate, and the card waits on the owner');
        await touch(card);
        owed++;
      }
      if (card.approvedAt && (await advance(card, 'planning')).ok) moved++;
      continue;
    }
    {
      const nxtOf = nextStage(card.stage);
      if (!nxtOf || nxtOf === 'done') {
        const lastPassed = (card.evidence || []).some((e) => e.stageKey === card.stage && Number(e.exit) !== 1);
        if (lastPassed) {
          if (!card.stageDone[card.stage]) {
            card.stageDone[card.stage] = true;
            say(card, 'every stage of this card has run; it stands waiting on the owner, and its last stage is not owed again');
            await touch(card);
            owed++;
          }
          continue;
        }
      }
    }
    if (!card.stageDone[card.stage]) continue;
    const ran = (card.evidence || []).some((e) => e.stageKey === card.stage);
    if (ran) {
      const nxt = nextStage(card.stage);
      if (nxt && (await advance(card, nxt)).ok) { moved++; continue; }
      if (!nxt || nxt === 'done') {
        if (!card.stageDone[card.stage]) {
          card.stageDone[card.stage] = true;
          say(card, 'every stage of this card has run; it stands waiting on the owner, and its last stage is not owed again');
          await touch(card);
          owed++;
        }
        continue;
      }
    }
    owesWork(card, card.stage);
    say(card, `standing at ${STAGE[card.stage].name} wearing a "stage completed" mark nobody had earned - it owes that stage`);
    await touch(card);
    owed++;
  }
  if (owed || moved) {
    console.log(`hive: at its own start the board put ${owed} standing card(s) back to work and moved ${moved} on`);
  }
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, must-revalidate' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' });
      return res.end(fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8'));
    }

    if (p === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
      return res.end(fs.readFileSync(path.join(HERE, 'public', 'hive-favicon.svg')));
    }
    if (p === '/team-panel.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(HERE, 'public', 'team-panel.css'), 'utf8'));
    }
    if (p === '/health') return json(res, 200, { ok: true, cards: cards.length });

    if (p === '/api/feed') {
      let live = cards.filter((c) => !c.binnedAt && c.stage !== 'done' && c.stage !== 'archive');
      if (url.searchParams.get('waits') === '1') live = live.filter(waitingOnOwner);
      return json(res, 200, live.map((c) => ({
        name: (c.key && !c.title.includes(c.key) ? `${c.key} — ${c.title}` : c.title).slice(0, 120),
        label: c.stage === 'capture' && !named(c)
          ? 'HELD AT CAPTURE - no work order number'
          : c.stage === 'approved' && !c.approvedAt
          ? 'WAITS ON THE OWNER'
          : c.parkedAt ? 'not now'
          : c.failedAt ? `${STAGE[c.stage].name}: failed, needs a hand`
          : c.running ? `${STAGE[c.stage].name}: agent working`
          : `${STAGE[c.stage].name} · ${STAGE[c.stage].agent}`,
        stage: STAGE[c.stage].name,
        waitsOnOwner: c.stage === 'approved' && !c.approvedAt ? 1 : 0,
        waitsOn: dependencyState(c).waiting.map((w) => w.key),
        blocked: dependencyState(c).held,
        kind: c.kind || 'work',
        rag: c.rag || null,
        id: c.id,
      })));
    }

    if (p === '/api/worker-seen' && req.method === 'POST') {
      workerSeenAt = Date.now();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/board') {
      const cost = laneTotals(cards);
      return json(res, 200, {
        stages: STAGES,
        cards: cards.filter((c) => !c.binnedAt).map((c) => {
          const dep = dependencyState(c);
          return { ...c, held: dep.held, waitingOn: dep.waiting.map((w) => w.key) };
        }),
        binned: cards.filter((c) => c.binnedAt),
        parked: cards.filter((c) => c.parkedAt && !c.binnedAt).length,
        waiting: cards.filter(waitingOnOwner).length,
        held: cards.filter((c) => !c.binnedAt && c.stage !== 'done' && c.stage !== 'archive' && dependencyState(c).held).length,
        lanes: cost.lanes,
        usd: cost.usd,
        check: lastCheck,
      });
    }

    if (p === '/api/queen') {
      const SWITCH = process.env.HIVE_QUEEN_SWITCH || 'http://127.0.0.1:3471';
      const clock = { checkAt: lastCheckAt, everyMs: SWEEP_EVERY_MS };
      try {
        const r = await fetch(SWITCH + (req.method === 'POST' ? '/toggle' : '/state'), {
          method: req.method === 'POST' ? 'POST' : 'GET',
          cache: 'no-store',
        });
        const state = await r.json();
        return json(res, 200, { ...state, ...clock });
      } catch (e) {
        return json(res, 200, { on: null, error: 'the Queen switch is not answering', ...clock });
      }
    }

    if (p === '/api/card' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.title || !String(b.title).trim()) return json(res, 400, { error: 'a card needs a title' });
      const SERIES_OK = ['WO', 'CW', 'PJ'];
      const standingKey = String(b.key || '').trim();
      if (!standingKey && !SERIES_OK.includes(String(b.series || '').toUpperCase())) {
        return json(res, 400, {
          error: 'this card names no series: WO is the owner\'s own work order, CW is the agent\'s own work. Say which one and it is minted in that sequence.',
        });
      }
      let key = String(b.key || '').trim();
      const keyPosted = !!key;
      if (key && !NAMED.test(key)) {
        b.rejectedKey = key;
        key = await mintWorkOrder(b.title, b.body);
        b.key = key;
        b.body = String(b.body || '').trim() +
          (b.body ? '\n\n' : '') +
          'A page id was sent as this card\'s key and was not a work order number: ' + b.rejectedKey;
      }
      if (!key) {
        try {
          key = await mintWorkOrder(b.title, b.body, b.series);
        } catch (e) {
          return json(res, 500, { error: 'the work order log could not be written, so no number was minted: ' + (e && e.message ? e.message : e) });
        }
        b.key = key;
      }
      if (keyPosted && key && NAMED.test(key) && !cards.find((c) => String(c.key || '') === key)) {
        const m = key.match(/^(WO|PJ|CW)-(\d+)$/);
        if (m) {
          if (await numberUsed(m[1], Number(m[2]))) {
            b.rejectedKey = key;
            key = await nextNumber(m[1]);
            b.key = key;
            if (keyPosted) {
              b.body = String(b.body || '').trim() +
                (b.body ? '\n\n' : '') +
                'A number that had already gone out was sent as this card\'s key and was refused: ' + b.rejectedKey;
            }
          } else if (!isTestNumber(m[2])) {
            await raiseSeries(m[1], Number(m[2]));
          }
        }
      }
      const standing = key ? cards.find((c) => String(c.key || '') === key) : null;
      if (standing) {
        standing.title = String(b.title).trim();
        if (b.body !== undefined) standing.body = String(b.body).trim();
        if (b.project !== undefined) standing.project = String(b.project).trim();
        if (b.waitsOn !== undefined) standing.waitsOn = waitsOnList(b);
        say(standing, 'this work order was written to the board again - the board carries one card to it');
        await touch(standing);
        return json(res, 200, { card: standing, updated: true, note: 'this key already stood on the board; the standing card was written again' });
      }
      if (!String(b.boundary || '').trim() && b.keepBoundary !== true) {
        b.boundary = 'This card, its own working folder, and whatever its own text names. Nothing else.';
      }
      const rawBody = String(b.body || '').trim();
      const bornBody = /^What this is about/m.test(rawBody) ? rawBody : workOrderEntry(key, b.title, rawBody);
      const card = newCard({ ...b, body: bornBody });
      say(card, 'card landed in Capture');
      await put(card);
      const at = cards.findIndex((c) => c.key && c.key === card.key);
      if (at >= 0) cards[at] = card; else cards.push(card);
      return json(res, 200, { card });
    }

    if (p === '/api/next-number') {
      try {
        const key = await nextWorkOrderNumber();
        return json(res, 200, { next: key, preview: workOrderEntry(key, 'the card you are about to add', '').slice(0, 300) });
      } catch (e) {
        return json(res, 500, { error: String(e && e.message ? e.message : e) });
      }
    }

    if (p === '/api/import' && req.method === 'POST') {
      const b = await readBody(req);
      let made = 0, stepped = 0;
      for (const inc of (Array.isArray(b.cards) ? b.cards : [])) {
        if (!inc || !inc.key || !inc.title) continue;
        let card = cards.find((c) => c.key === inc.key);
        if (!card) {
          card = newCard(inc);
          card.stage = inc.stage || 'capture';
          card.stageDone = inc.stageDone || {};
          card.waitsOn = waitsOnList(inc);
          copyProjectFields(card, inc);
          owesWork(card, card.stage);
          card.approvedAt = inc.approvedAt || null;
          card.actions = inc.actions || [];
          card.evidence = inc.evidence || [];
          card.usage = inc.usage || null;
          card.costUsd = typeof inc.costUsd === 'number' ? inc.costUsd : null;
          card.priceBasis = inc.priceBasis || '';
          card.moves = [{ at: new Date().toISOString(), to: card.stage, note: 'loaded with its true state' }];
          card.activity = [{ at: new Date().toISOString(), text: 'loaded onto the board from its own register' }];
          if (card.stage === 'done') card.archivedAt = new Date().toISOString();
          await put(card);
          cards.push(card);
          made++;
        } else {
          Object.assign(card, {
            project: inc.project ?? card.project,
            title: inc.title, body: inc.body ?? card.body,
            actions: inc.actions || card.actions,
            evidence: inc.evidence?.length ? inc.evidence : card.evidence,
          });
          if (inc.waitsOn !== undefined) card.waitsOn = waitsOnList(inc);
          copyProjectFields(card, inc);
          if (inc.stage && inc.stage !== card.stage) {
            card.moves.push({ at: new Date().toISOString(), to: inc.stage, note: String(inc.moveNote || 'stepped by its own register') });
            card.stage = inc.stage;
          }
          if (inc.clearApproval) { card.approvedAt = null; card.stageDone.approved = false; }
          if (inc.stageDone) card.stageDone = { ...card.stageDone, ...inc.stageDone };
          owesWork(card, card.stage);
          await touch(card);
          stepped++;
        }
      }
      return json(res, 200, { made, stepped, cards: cards.length });
    }

function depthOf(team, task, seen) {
  const deps = task.dependencies || [];
  if (!deps.length) return 0;
  const marks = seen || new Set();
  if (marks.has(task.id)) return 0;
  marks.add(task.id);
  let deepest = 0;
  for (const d of deps) {
    const parent = (team.tasks || []).find((x) => x.id === d);
    if (parent) deepest = Math.max(deepest, depthOf(team, parent, marks) + 1);
  }
  return deepest;
}

    if (p.startsWith('/api/team/')) {
      const id = Number(p.split('/').pop());
      const card = cards.find((c) => c.id === id);
      if (!card) return json(res, 404, { error: 'no such card' });
      const root = path.join(PMO_HOME, 'work', String(card.key || ('card-' + id)), '.agent-teams');
      const teams = [];
      try {
        const order = fs.readdirSync(root).map((dir) => {
          let at = 0;
          try { at = fs.statSync(path.join(root, dir)).mtimeMs; } catch { at = 0; }
          return { dir, at };
        }).sort((a, b) => b.at - a.at);
        for (const { dir, at } of order) {
          const f = path.join(root, dir, 'team.json');
          try {
            const t = JSON.parse(fs.readFileSync(f, 'utf8'));
            let inbox = 0;
            try { inbox = fs.readdirSync(path.join(root, dir, 'inbox')).length; } catch { inbox = 0; }
            teams.push({
              name: t.name || dir, phase: t.phase || '', inbox,
              at: at ? new Date(at).toISOString() : '',
              current: teams.length === 0,
              members: (t.members || []).map((m) => {
                const owned = (t.tasks || []).filter((x) => x.assignee === m.name);
                const fin = owned.filter((x) => x.status === 'completed').length;
                const now = owned.find((x) => x.status === 'in_progress' || x.status === 'claimed');
                return {
                  name: m.name, role: m.role, status: m.status,
                  activity: m.activity || '', model: m.model || '', provider: m.provider || '',
                  done: fin, total: owned.length,
                  progress: owned.length ? Math.round((fin / owned.length) * 100) : 0,
                  currentTask: now ? now.id : '',
                };
              }),
              tasks: (t.tasks || []).map((x) => ({
                id: x.id, subject: x.subject, status: x.status, assignee: x.assignee,
                dependencies: x.dependencies || [],
                depth: depthOf(t, x),
                attempt: x.attempt || 0,
                updatedAt: x.updatedAt || x.claimedAt || x.createdAt || '',
                output: String(x.output || x.report || '').slice(0, 1200),
                unlocks: (t.tasks || []).filter((y) => (y.dependencies || []).includes(x.id)).map((y) => y.id),
              })),
            });
          } catch {  }
        }
      } catch {  }
      const thinTeam = (t) => {
        if (!t) return true;
        const bees = t.members || [];
        const tasks = t.tasks || [];
        const working = bees.some((m) => m.status === 'working' || m.activity === 'working');
        const live = tasks.some((x) => x.status === 'in_progress' || x.status === 'claimed');
        return bees.length === 0 || (!working && !live);
      };
      if (card.running && thinTeam(teams[0])) {
        const st = STAGE[card.stage] || { name: card.stage, agent: 'the agent' };
        const hand = card.hand || 'Agent 1';
        const since = card.calledAt || card.startedAt || card.updatedAt || new Date().toISOString();
        teams.unshift({
          name: String(card.key || ('card-' + id)) + '-' + String(card.stage),
          phase: 'live', inbox: 0, at: since, current: true, live: true,
          note: 'This run has not written its team record yet. The card itself names the agent at work, and this window takes him from there.',
          members: [{
            name: hand, role: st.agent, status: 'working', activity: 'working',
            model: '', provider: '', done: 0, total: 1, progress: 0, currentTask: 'now',
          }],
          tasks: [{
            id: 'now', subject: st.name + ': ' + hand + ' is working this card now',
            status: 'in_progress', assignee: hand, dependencies: [], depth: 0, attempt: 1,
            updatedAt: since, output: '', unlocks: [],
          }],
        });
        teams.forEach((t, i) => { t.current = i === 0; });
      }
      const every = url.searchParams.get('all') === '1';
      const out = every ? teams : teams.slice(0, 1);
      return json(res, 200, { card: card.key, running: !!card.running, teams: out, earlierRuns: Math.max(0, teams.length - out.length) });
    }

    if (p === '/api/work') {
      const ready = cards.filter(readyForWork);
      ready.sort((a, b) => String(b.calledAt || '').localeCompare(String(a.calledAt || '')));
      const work = [];
      for (const c of ready) {
        const items = Array.isArray(c.items) ? c.items : [];
        const open = items.filter((i) => !i.hand && i.state !== 'done' && i.state !== 'failed');
        if (c.stage === 'execution' && open.length) {
          for (const it of open) {
            work.push({
              id: c.id, key: c.key, title: c.title, body: c.body, stage: c.stage,
              stageName: STAGE[c.stage].name, agent: STAGE[c.stage].agent,
              duty: STAGE[c.stage].duty, where: STAGE[c.stage].where,
              word: c.word?.text || '',
              boundary: c.boundary || '',
              usage: c.usage || null,
              repair: c.repair || null,
              evidence: c.evidence.slice(-4),
              item: it.n, itemText: it.text,
            });
          }
          continue;
        }
        work.push({
          id: c.id, key: c.key, title: c.title, body: c.body, stage: c.stage,
          stageName: STAGE[c.stage].name, agent: STAGE[c.stage].agent,
          duty: STAGE[c.stage].duty, where: STAGE[c.stage].where,
          word: c.word?.text || '',
          boundary: c.boundary || '',
          usage: c.usage || null,
          repair: c.repair || null,
          evidence: c.evidence.slice(-4),
          items: items.length ? items : null,
        });
      }
      return json(res, 200, { work });
    }

    if (p === '/api/release-stale' && req.method === 'POST') {
      const released = [];
      for (const card of cards) {
        let changed = false;
        if (card.running) {
          card.running = false;
          say(card, 'the worker let go of this stage - a claim left behind by an earlier run');
          changed = true;
        }
        for (const it of (Array.isArray(card.items) ? card.items : [])) {
          if (it.state === 'running' || it.hand) {
            it.hand = null;
            it.state = 'todo';
            say(card, `the worker let go of work item ${it.n} - a claim left behind by an earlier run`);
            changed = true;
          }
        }
        if (!changed) continue;
        await touch(card);
        released.push(card.key || '#' + card.id);
      }
      return json(res, 200, { released });
    }

    const m = p.match(/^\/api\/card\/(\d+)\/(approve|complete|run|advance|reject|park|unpark|bin|unbin|plainer|destroy|claim|finish|retry|release|word|waits|boundary|items|pink|unpink)$/);
    if (m) {
      const card = cards.find((c) => c.id === Number(m[1]));
      if (!card) return json(res, 404, { error: 'no such card' });
      const b = await readBody(req);

      if (m[2] === 'word') {
        const text = String(b.text || '').trim();
        if (!text) {
          card.word = null;
          say(card, 'the word on this card was taken off');
          await touch(card);
          return json(res, 200, { card, word: null });
        }
        card.word = { at: new Date().toISOString(), text: text.slice(0, 4000) };
        say(card, `the owner put his own word on the card: "${text.slice(0, 300)}"`);
        await touch(card);
        return json(res, 200, { card, word: card.word });
      }

      if (m[2] === 'items') {
        const list = Array.isArray(b.items) ? b.items : String(b.items || '').split('\n');
        const clean = list.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 8);
        card.items = clean.map((text, i) => ({ n: i + 1, text, state: 'todo' }));
        say(card, clean.length
          ? `the card's plan was split into ${clean.length} work item(s), each to be held by a hand of its own`
          : 'the card carries no work items');
        await touch(card);
        return json(res, 200, { card, items: card.items });
      }

      if (m[2] === 'waits') {
        const list = waitsOnList({ waitsOn: b.waitsOn });
        card.waitsOn = list;
        say(card, list.length ? `the wait on this card was set: ${list.join(', ')}` : 'the wait on this card was taken off');
        await touch(card);
        return json(res, 200, { card, waitsOn: list });
      }

      if (m[2] === 'boundary') {
        const text = String(b.boundary || b.text || '').trim();
        card.boundary = text.slice(0, 4000);
        say(card, text
          ? 'the read boundary was written on this card: ' + text.slice(0, 300)
          : 'the read boundary was taken off this card - no hand takes it');
        await touch(card);
        return json(res, 200, { card, boundary: card.boundary });
      }

      if (m[2] === 'complete') {
        const finishedStages = !isProject(card) && card.stage === 'feedback' && (card.stageDone || {}).feedback === true;
        if (!isProject(card) && card.stage !== 'done' && !finishedStages) {
          return json(res, 409, { error: 'this card has not finished its stages yet, so there is nothing to confirm completed' });
        }

        const openActions = (card.actions || []).filter((a) => !a.done).length;
        if (openActions) {
          return json(res, 409, { error: `${openActions} action(s) on this card are still open - it cannot be confirmed completed` });
        }
        if (card.stageDone?.done) {
          return json(res, 409, { error: 'this card is already confirmed completed' });
        }
        card.stageDone.done = true;
        card.completedAt = new Date().toISOString();
        if (card.stage !== 'done') card.stage = 'done';
        say(card, 'the card was confirmed completed - everything on it is completed');
        await touch(card);
        return json(res, 200, { card, confirmed: true });
      }

      if (m[2] === 'approve') {
        if (card.stage !== 'approved') return json(res, 400, { error: 'that card is not at the gate' });
        card.approvedAt = new Date().toISOString();
        card.stageDone.approved = true;
        say(card, MINE_TO_CARRY.test(card.project || '')
          ? "the gate was not put to the owner: this order is the agent's own to carry, and an agent's own jobs are not put to the owner for approval"
          : 'THE OWNER APPROVED IT - the gate is open');
        await touch(card);
        return json(res, 200, { card, moved: await advance(card, 'planning') });
      }
      if (m[2] === 'reject') {
        if (card.stage !== 'approved') return json(res, 400, { error: 'that card is not at the gate' });
        card.approvedAt = null;
        card.stageDone.approved = false;
        card.word = { at: new Date().toISOString(), text: String(b.why || 'no reason given') };
        card.stage = 'analyse';
        owesWork(card, 'analyse');
        say(card, `the owner sent it back: ${String(b.why || 'no reason given')}`);
        await touch(card);
        return json(res, 200, { card });
      }
      if (m[2] === 'advance') {
        const i = ORDER.indexOf(card.stage);
        const to = b.to || ORDER[Math.min(i + 1, ORDER.length - 1)];
        const r = await advance(card, to);
        return json(res, r.ok ? 200 : 409, { card, moved: r });
      }
      if (m[2] === 'release') {
        card.running = false;
        card.hand = null;
        say(card, 'the worker let go of this stage');
        await touch(card);
        return json(res, 200, { card });
      }

      if (m[2] === 'claim') {
        if (b.item) {
          const it = (Array.isArray(card.items) ? card.items : []).find((i) => Number(i.n) === Number(b.item));
          if (!it) return json(res, 404, { error: 'no such work item on this card' });
          if (it.hand) return json(res, 409, { error: 'that work item is already in a hand' });
          if (card.binnedAt || card.parkedAt) return json(res, 409, { error: 'that card is off the list' });
          const itemHand = b.hand ? String(b.hand).slice(0, 40) : null;
          it.hand = itemHand;
          it.state = 'running';
          it.startedAt = new Date().toISOString();
          say(card, `${itemHand || 'a hand'} (the ${STAGE[card.stage].agent}) took work item ${it.n}: ${String(it.text).slice(0, 140)}`);
          await touch(card);
          return json(res, 200, { card, item: it });
        }
        if (card.running) {
          return json(res, 409, { error: 'that card is already in a hand', key: card.key || ('#' + card.id) });
        }
        const hand = b.hand ? String(b.hand).slice(0, 40) : null;
        card.running = true;
        card.calledAt = null;
        card.hand = hand;
        say(card, hand
          ? `${hand} (the ${STAGE[card.stage].agent}) took ${STAGE[card.stage].name}`
          : `${STAGE[card.stage].agent} took ${STAGE[card.stage].name}`);
        await touch(card);
        return json(res, 200, { card });
      }

      if (m[2] === 'finish') {
        if (b.item) {
          const it = (Array.isArray(card.items) ? card.items : []).find((i) => Number(i.n) === Number(b.item));
          if (!it) return json(res, 404, { error: 'no such work item on this card' });
          const itemCost = money(Number(b.costUsd));
          it.ok = b.ok !== false;
          it.state = it.ok ? 'done' : 'failed';
          it.out = String(b.out || '').slice(0, 6000);
          it.hand = (b.hand ? String(b.hand) : '') || it.hand || null;
          it.endedAt = new Date().toISOString();
          if (b.usage) {
            it.usage = b.usage;
            if (typeof b.costUsd === 'number' && isFinite(b.costUsd)) it.costUsd = itemCost;
            card.usage = addUsage(card.usage, b.usage);
            if (typeof b.costUsd === 'number' && isFinite(b.costUsd)) card.costUsd = money((card.costUsd || 0) + Number(b.costUsd));
            if (b.priceBasis) card.priceBasis = String(b.priceBasis);
          }
          say(card, `${it.hand || 'a hand'} ${it.ok ? 'finished' : 'FAILED'} work item ${it.n}: ${String(it.text).slice(0, 90)}`);
          await touch(card);
          return json(res, 200, { card, item: it });
        }
        const st = STAGE[card.stage];
        card.running = false;
        card.stageDone[card.stage] = b.ok !== false;
        card.failedAt = b.ok === false ? new Date().toISOString() : null;
        if (b.ok !== false) { card.failedRuns = 0; card.pinkAt = null; card.pinkWhy = null; }
        const costUsd = money(Number(b.costUsd));
        const hand = (b.hand ? String(b.hand) : (card.hand || '')).slice(0, 40) || null;
        const runMark = b.runMark ? String(b.runMark).slice(0, 120) : null;
        const startedAt = b.startedAt ? String(b.startedAt).slice(0, 40) : null;
        const endedAt = b.endedAt ? String(b.endedAt).slice(0, 40) : new Date().toISOString();
        card.hand = null;
        card.evidence.push({
          at: new Date().toISOString(), stage: st.name, stageKey: card.stage, agent: st.agent,
          hand, runMark, startedAt, endedAt,
          exit: b.ok === false ? 1 : 0, out: String(b.out || '').slice(0, 20000),
          usage: b.usage || null,
          costUsd: typeof b.costUsd === 'number' && isFinite(b.costUsd) ? costUsd : null,
          priceBasis: String(b.priceBasis || ''),
        });
        if (b.usage) {
          card.usage = addUsage(card.usage, b.usage);
          if (typeof b.costUsd === 'number' && isFinite(b.costUsd)) {
            card.costUsd = money((card.costUsd || 0) + Number(b.costUsd));
          }
          if (b.priceBasis) card.priceBasis = String(b.priceBasis);
        }
        if (card.stage === 'capture' && b.ok !== false && !String(card.boundary || '').trim()) {
          const bm = String(b.out || '').match(/^\s*BOUNDARY\s*:\s*(.+)$/im);
          if (bm) card.boundary = bm[1].trim().slice(0, 600);
        }
        const who = hand ? `${hand} (the ${st.agent})` : st.agent;
        say(card, b.ok === false ? `${who} failed at ${st.name}` : `${who} finished ${st.name}`);
        let moved = null;
        const stoppedRun = b.stopped === true;
        if (stoppedRun) {
          card.failedRuns = Number(card.failedRuns || 0) + 1;
          if (card.failedRuns > FAILED_RUNS_ALLOWED) {
            turnPink(card, `it was stopped ${card.failedRuns} times by its own limit and the Queen could not move it`);
            moved = { ok: true, why: 'turned pink: it waits on the owner, not on a hand' };
          } else {
            card.failedAt = null;
            say(card, `the stage was stopped by its own limit - that is ${card.failedRuns} run(s) on this card that did not deliver, so it is given another go by itself`);
            moved = { ok: true, why: 'stopped and left standing, and offered again' };
          }
        } else if (b.ok === false) card.failedRuns = Number(card.failedRuns || 0) + 1;
        if (stoppedRun) {
        } else if (b.ok === false && card.failedRuns > FAILED_RUNS_ALLOWED) {
          turnPink(card, `it failed ${card.failedRuns} times and the Queen could not mend it`);
          moved = { ok: true, why: 'turned pink: it waits on the owner, not on a hand' };
        } else if (b.ok === false) {
          if (await sendToRepair(card, b.out)) {
            say(card, `sent back to ${STAGE[card.stage].name} to be repaired - ${STAGE[card.repair.checkStage].name} comes round again as a fresh check`);
            moved = { ok: true, why: 'sent back to be repaired' };
          } else {
            turnPink(card, `it failed at ${st.name} more times than the board repairs by itself, and the Queen could not mend it`);
          }
        } else {
          const back = card.repair && card.stage === card.repair.fromStage ? card.repair.checkStage : null;
          if (back) {
            moved = await advance(card, back);
            say(card, `${STAGE[back].name} comes round now as the fresh check on the repair`);
          } else {
            card.repair = null;
            const nxt = nextStage(card.stage);
            if (nxt) moved = await advance(card, nxt);
          }
        }
        await touch(card);
        return json(res, 200, { card, moved, waitingOnOwner: waitingOnOwner(card) });
      }

      if (m[2] === 'retry') {
        card.failedAt = null;
        card.pinkAt = null;
        card.pinkWhy = null;
        say(card, 'the failed stage was given another go');
        await touch(card);
        return json(res, 200, { card });
      }
      if (m[2] === 'pink') {
        turnPink(card, b.why || 'the Queen could not mend it');
        await touch(card);
        return json(res, 200, { card });
      }
      if (m[2] === 'unpink') {
        card.pinkAt = null;
        card.pinkWhy = null;
        card.failedAt = null;
        say(card, 'the pink is off - the owner has looked at it, and it stands workable again');
        await touch(card);
        return json(res, 200, { card });
      }

      if (m[2] === 'park') {
        card.parkedAt = new Date().toISOString();
        say(card, 'the owner said: not now - it waits, and it is off his list');
        await touch(card);
        return json(res, 200, { card });
      }
      if (m[2] === 'unpark') {
        card.parkedAt = null;
        say(card, 'the owner brought it back');
        await touch(card);
        return json(res, 200, { card });
      }
      if (m[2] === 'bin') {
        card.binnedAt = new Date().toISOString();
        say(card, `binned${b.reason ? ': ' + String(b.reason) : ''}`);
        await touch(card);
        return json(res, 200, { card });
      }
      if (m[2] === 'unbin') {
        card.binnedAt = null;
        say(card, 'the owner brought it back out of the bin');
        await touch(card);
        return json(res, 200, { card });
      }
      if (m[2] === 'plainer') {
        card.plainerAt = new Date().toISOString();
        say(card, 'the owner said: I do not understand this - it is to be written again in plain words');
        await touch(card);
        return json(res, 200, { card });
      }
      if (m[2] === 'destroy') {
        cards = cards.filter((c) => c.id !== card.id);
        await pool.query('delete from cards where id = $1', [card.id]);
        console.log(`hive: card ${card.id} destroyed on `);
        return json(res, 200, { destroyed: card.id, cards: cards.length });
      }
      if (m[2] === 'run') {
        if (!String(card.boundary || '').trim()) return json(res, 409, { error: 'the read boundary is not written on this card - no hand takes it' });
        if (card.binnedAt) return json(res, 409, { error: 'that card is in the bin - bring it back first' });
        if (card.parkedAt) return json(res, 409, { error: 'that card is off your list - bring it back first' });
        if (card.running) return json(res, 409, { error: 'the stage worker is already on that card' });
        if (card.failedAt) return json(res, 409, { error: 'that stage was stopped and set aside - say "try that stage again" first' });
        const dep = dependencyState(card);
        if (dep.held) return json(res, 409, { error: 'that card waits on ' + dep.waiting.map((w) => w.key).join(', ') + ', which is not finished' });
        if (waitingOnOwner(card)) return json(res, 409, { error: 'that card waits on you, not on a worker - approve it or send it back' });
        const st = STAGE[card.stage];
        if (!st || st.engine !== 'harness') {
          return json(res, 409, { error: `the ${st ? st.name : card.stage} column is not run by a worker` });
        }
        if (card.stageDone?.[card.stage]) {
          return json(res, 409, { error: `the ${st.name} stage is already completed on this card - move it on instead` });
        }
        card.calledAt = new Date().toISOString();
        say(card, `${st.agent} was called for by the owner - it goes to the head of the queue`);
        await touch(card);
        return json(res, 200, { card, called: true, note: 'the worker takes it on its next pass' });
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('hive fault:', e);
    json(res, 500, { error: String(e && e.message || e) });
  }
});

function stopReasonsFor(card) {
  const reasons = [];
  if (card.failedAt) reasons.push('failed');
  if (!String(card.boundary || '').trim()) reasons.push('no-read-boundary');
  try { if (dependencyState(card).held) reasons.push('waiting-on-another-card'); } catch {  }
  if (waitingOnOwner(card)) reasons.push('waiting-on-owner');
  if (!reasons.length) reasons.push('no-run');
  return { blocking: reasons[0], reasons };
}

let lastCheckAt = null;
let lastCheck = null;
let workerSeenAt = 0;
const WORKER_ALIVE_MS = 90000;

async function queenIsOn() {
  const SWITCH = process.env.HIVE_QUEEN_SWITCH || 'http://127.0.0.1:3471';
  try {
    const r = await fetch(SWITCH + '/state', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return j.on === true;
  } catch {
    return false;
  }
}

async function sweepOnce() {
  const now = Date.now();
  lastCheckAt = new Date(now).toISOString();
  const decisions = buildPass(cards, now, { stopReasons: stopReasonsFor });
  const queenOn = await queenIsOn();
  if (!queenOn) {
    let letGo = 0;
    for (const c of cards) {
      if (c.binnedAt || !c.running) continue;
      c.running = false;
      c.hand = null;
      say(c, 'the Queen was switched off and this card was let go - no hand is holding it');
      await touch(c);
      letGo++;
    }
    lastCheck = { at: new Date(now).toISOString(), read: decisions.length, atWork: 0,
                  wrote: 0, cleared: 0, retried: 0, called: 0, queen: 'off' };
    console.log(`hive: the Queen's check ran while she is off - ${decisions.length} card(s) read, 0 agents working, nothing written, nothing called up${letGo ? `, ${letGo} card(s) let go` : ''}`);
    return { scanned: decisions.length, wrote: 0, cleared: 0 };
  }
  let wrote = 0, cleared = 0;
  for (const d of decisions) {
    const card = d.card;
    if (!card || card.binnedAt) continue;
    if (d.stopped && d.wouldWrite) {
      card.stop = { ...d.stop };
      card.stopSig = d.signature;
      card.stopObservedAt = new Date(d.stop.observedAt).toISOString();
      const labels = (d.stop.reasons || []).map((r) => REASONS[r] || r).join(', ');
      say(card, `the Queen's check: this card has stopped - ${labels}. It has not moved for ${d.stop.since}; `
        + `the threshold is ${Math.round(d.stop.thresholdMs / 60000)} minutes, and the basis is: ${d.stop.basis}.`);
      await touch(card);
      wrote++;
    } else if (!d.stopped && card.stopSig) {
      card.stop = null;
      card.stopSig = null;
      card.stopObservedAt = null;
      say(card, 'the Queen\'s check: this card is moving again, so its stopped note is taken off');
      await touch(card);
      cleared++;
    }
  }
  let retried = 0, pinked = 0;
  for (const card of cards) {
    if (!card || card.binnedAt || card.parkedAt) continue;
    if (!card.failedAt) continue;
    if (card.pinkAt) continue;
    if ((card.stage === 'done') || (card.stage === 'archive')) continue;
    const round = Number((card.repair && card.repair.round) || 0);
    const overRounds = round >= REPAIR_ROUNDS;
    const overRuns = Number(card.failedRuns || 0) > FAILED_RUNS_ALLOWED;
    if (overRounds || overRuns) {
      turnPink(card, `it failed ${Number(card.failedRuns || 1)} time(s) and the Queen could not mend it`);
      await touch(card);
      pinked++;
      continue;
    }
    if (Date.now() - Date.parse(card.failedAt) < 90000) continue;
    card.failedAt = null;
    say(card, "the Queen's check found this stage set aside and gave it another go - the worker takes it on its next pass");
    await touch(card);
    retried++;
  }
  let called = 0;
  for (const d of decisions) {
    if (!d.stopped) continue;
    const card = d.card;
    if (!card || card.binnedAt || card.parkedAt || card.failedAt || card.running) continue;
    if (!readyForWork(card)) continue;
    if (card.calledAt && (Date.now() - Date.parse(card.calledAt)) < 3600000) continue;
    card.calledAt = new Date().toISOString();
    say(card, "the Queen's check found this card standing and called it to the head of the worker's queue");
    await touch(card);
    called++;
  }
  const atWork = cards.filter((c) => c.running && !c.binnedAt).length;
  lastCheck = { at: new Date(now).toISOString(), read: decisions.length, atWork,
                wrote, cleared, retried, called, pinked };
  console.log(`hive: the Queen's check ran - ${decisions.length} card(s) read, ${atWork} at work, ${wrote} stopped note(s) written, ${cleared} cleared, ${retried} given another go, ${pinked} turned pink for the owner, ${called} called up`);
  return { scanned: decisions.length, wrote, cleared };
}

boot()
  .then(() => server.listen(PORT, '0.0.0.0', () => {
    console.log(`hive: the board answers on port ${PORT}`);
    console.log(`hive: stages ${STAGES.map((s) => s.name).join(' -> ')}`);
    setInterval(() => { sweepOnce().catch((e) => console.error('hive check fault:', e)); }, SWEEP_EVERY_MS).unref();
    setTimeout(() => { sweepOnce().catch((e) => console.error('hive check fault:', e)); }, 4000).unref();
  }))
  .catch((e) => { console.error('hive could not start:', e); process.exit(1); });
