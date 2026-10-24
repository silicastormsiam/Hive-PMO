import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const logLine = console.log.bind(console);
const logErr = console.error.bind(console);
const stamp = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
console.log = (...a) => logLine(stamp(), ...a);
console.error = (...a) => logErr(stamp(), ...a);

const BOARD = process.env.HIVE_BOARD || 'http://127.0.0.1:3470';
const DSH = process.env.DSH_BIN || 'dsh';
const DSH_HOME = process.env.DSH_HOME || (process.env.HOME || '') + '/.dsh';
const PMO_HOME = process.env.PMO_HOME || '/var/lib/hive';
const RUN_CWD = process.env.HIVE_RUN_CWD || PMO_HOME;
const WORK_ROOT = process.env.HIVE_WORK_ROOT || path.join(PMO_HOME, 'work');
function workDirFor(key) {
  const safe = String(key || 'card').replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(WORK_ROOT, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const QUEEN_MODE = process.env.HIVE_QUEEN !== '0';
const QUEEN_DIR = path.join(WORK_ROOT, 'queen');
const QUEEN_TRAY = path.join(QUEEN_DIR, 'tray.json');
const QUEEN_DONE = path.join(QUEEN_DIR, 'done.json');
const QUEEN_PATCH = process.env.HIVE_PATCH || path.join(PMO_HOME, 'runner', 'team-bees.patch.yml');
let queenChild = null;
let queenOut = '';

function queenBrief() {
  return [
    "You are the Queen of the board. The board belongs to its owner.",
    'START YOUR TEAM NOW: create ONE team, approval="automatic", with FOUR to SIX bees - four is the floor and six is his cap. You make ONE team and you keep it for the whole day. Never make a second team.',
    'THEN WORK FOR EVER, in this loop:',
    '1. Read ' + QUEEN_TRAY + '.',
    '2. WAKE EVERY 60 SECONDS AND SAY ONE LINE. ONE bash call per tick: sleep 60; then bash ' + path.join(QUEEN_DIR, 'tick.sh') + '. It prints your tray and every live card on the board. Read it, then say ONE short line in your own words: what you checked and what you did - and write that same line to ' + path.join(QUEEN_DIR, 'last-report.txt') + '. Then tick again. Never sleep past your look and never stay silent.',
    'YOUR BEES WORK AT THE SAME TIME. When a card carries work items, give one item to each bee and set them all going together - never one bee, then wait, then the next.',
    'BEFORE YOU MEND A FAILED STAGE, read what it failed on and CHECK WHETHER THE WORK ALREADY STANDS. Many cards fail because the job was already done. If the work is there, answer VERDICT: PASS with the evidence you read and move the card on; do not run the same work again.',
    'A CARD IN THE FEEDBACK COLUMN WHOSE STAGES ARE ALL DONE IS WAITING ON THE OWNER, NOT ON YOU: no feedback comes from anyone else. Say so in your line and leave it for him. A card in Feedback that still owes the Feedback stage is yours: run the last check against what the card asked for.',
    'NEVER READ THE BOARD\'S OWN PROGRAM OR THIS RUNNER\'S CODE (server.mjs, worker.mjs) and never any other document. tick.sh already prints every live card and the work offered to you. Reading the program burns the owner\'s tokens and tells you nothing the tick does not print.',
    '3. When the job names a card, the job carries a "brief" field. That brief is the whole of what you must do for this card: do exactly what it says, stage by stage, with your team. Give each stage to a bee as a task.',
    '4. After each stage write its file into the card\'s own folder that the brief names. Its FIRST LINE is exactly "VERDICT: PASS" or "VERDICT: FAIL".',
    '5. After the last stage of the job, AND AT ONCE IF ANY STAGE ANSWERS FAIL, write ' + QUEEN_DONE + ' with {"job": <the job number>, "at": "<the time>"}. A failed stage ends the job: write it and go back to step 1. Never leave a job without its done marker: the runner waits on that marker, and a missing one holds the card where it stands.',
    '6. Go back to step 1. NEVER END YOUR TURN while this board stands: the machine stops the run when your turn ends, and a stopped run is a dead team.',
    'IF A CARD STANDS FAILED you get ONE go at it and no more. Mend it if you can, quickly. If you cannot, say VERDICT: FAIL in one line with the reason: the card turns BRIGHT PINK for the owner, and nothing runs it again until the owner has looked at it.',
    'WHAT YOU MAY WRITE: only the card folders under ' + WORK_ROOT + ' and the queen folder inside it. Everything outside is refused by the machine.',
  ].join('\n');
}

function ensureQueen() {
  if (queenChild && queenChild.exitCode === null) return queenChild;
  fs.mkdirSync(QUEEN_DIR, { recursive: true });
  if (!fs.existsSync(QUEEN_TRAY)) fs.writeFileSync(QUEEN_TRAY, JSON.stringify({ job: null }));
  queenChild = spawn(DSH, ['--profile', 'headless', '--patch', QUEEN_PATCH, '/agent-teams ' + queenBrief()], {
    cwd: WORK_ROOT,
    env: { ...process.env, DSH_PERMISSION_MODE: 'workspace-write' },
  });
  queenOut = '';
  let queenBuf = '';
  const keepTail = (d) => {
    const text = String(d || '');
    queenOut += text;
    if (queenOut.length > 120000) queenOut = queenOut.slice(-60000);
    queenBuf += text;
    if (queenBuf.length > 4000) queenBuf = queenBuf.slice(-2000);
  };
  queenChild.stdout.on('data', keepTail);
  queenChild.stderr.on('data', keepTail);
  queenChild.on('close', () => { queenChild = null; });
  console.log('worker: the Queen is up, and she keeps one team for the whole day');
  return queenChild;
}

function stopQueen() {
  if (queenChild && queenChild.exitCode === null) {
    try { queenChild.kill('SIGKILL'); } catch {  }
  }
  queenChild = null;
}

async function runByQueen(w, list, runMark, workCwd, hand, timeoutMs) {
  fs.mkdirSync(QUEEN_DIR, { recursive: true });
  const before = sessionDirs(WORK_ROOT);
  ensureQueen();
  try { fs.unlinkSync(QUEEN_DONE); } catch {  }

  const link = path.join(workCwd, '.agent-teams');
  const real = path.join(WORK_ROOT, '.agent-teams');
  let linked = false;
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) fs.unlinkSync(link);
    else if (st.isDirectory()) fs.renameSync(link, link + '.before-the-queen-' + Date.now());
  } catch {  }
  try { fs.symlinkSync(real, link, 'dir'); linked = true; } catch {  }

  const job = {
    job: w.id,
    key: w.key,
    hand,
    stages: list,
    at: new Date().toISOString(),
    brief: passBrief(w, list, runMark, workCwd, hand),
  };
  fs.writeFileSync(QUEEN_TRAY, JSON.stringify(job, null, 1));
  console.log(`worker: the Queen gave card #${w.id} to her team - one team for ${list.map((s) => STAGE_NAME(s)).join(', ')}`);

  const t0 = Date.now();
  const limit = Math.max(60000, Number(timeoutMs) || TIMEOUT);
  let stopped = '';
  let lastProgress = Date.now();
  let lastFiles = stageFilesIn(workCwd).length;
  let lastTokens = 0;
  while (Date.now() - t0 < limit) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!queenChild) { if (stopped) break; ensureQueen(); }
    const m = liveMeter(before, WORK_ROOT);
    if (m && MAX_TOKENS > 0 && m.tokens >= MAX_TOKENS) {
      stopped = `she had used ${m.tokens.toLocaleString()} new tokens, past this run's cap of ${MAX_TOKENS.toLocaleString()}`;
      stopQueen();
      break;
    }
    try {
      const d = JSON.parse(fs.readFileSync(QUEEN_DONE, 'utf8'));
      if (Number(d.job) === Number(w.id)) break;
    } catch {  }
    if (m && Number(m.tokens) > lastTokens) { lastTokens = Number(m.tokens); lastProgress = Date.now(); }
    const nowFiles = stageFilesIn(workCwd).length;
    if (nowFiles !== lastFiles) { lastFiles = nowFiles; lastProgress = Date.now(); }
    if (STALL_MS > 0 && Date.now() - lastProgress >= STALL_MS) {
      stopped = `it made no progress for ${Math.round(STALL_MS / 1000)} seconds - no new stage file and no new token`;
      stopQueen();
      break;
    }
    try {
      const docs = stageFilesIn(workCwd);
      if (docs.length >= list.length) break;
      const said = docs.some((f) => {
        try { return !verdictOf(fs.readFileSync(path.join(workCwd, f), 'utf8')).ok; } catch { return false; }
      });
      if (said) break;
    } catch {  }
  }
  try { fs.writeFileSync(QUEEN_TRAY, JSON.stringify({ job: null })); } catch {  }
  if (linked) { try { fs.unlinkSync(link); } catch {  } }

  const files = stageFilesIn(workCwd);
  let text = '';
  let ok = files.length >= list.length;
  for (const f of files) {
    let one = '';
    try { one = fs.readFileSync(path.join(workCwd, f), 'utf8'); } catch { one = ''; }
    text += one + '\n\n';
    if (!verdictOf(one).ok) ok = false;
  }
  const tailOut = queenOut ? '\n\n' + queenOut.slice(-3000) : '';
  if (stopped) {
    return { ok: false, stopped: true, out: `THE STAGE WAS STOPPED AND SET ASIDE: ${stopped}.\n\nWhat the Queen had done stands below.\n\n${text}${tailOut}` };
  }
  if (!files.length) {
    return { ok: false, out: `the Queen wrote no stage file for card #${w.id}.${tailOut}` };
  }
  return { ok, out: text };
}
const ZSTD = process.env.HIVE_ZSTD || 'zstd';
const EVERY = Number(process.env.HIVE_EVERY_MS || 60000);
const TIMEOUT = Number(process.env.HIVE_TIMEOUT_MS || 900000);
const STALL_MS = Number(process.env.HIVE_STALL_MS || 180000);
const STAGE_BUDGET = {
  capture: 25, analyse: 80, planning: 55, execution: 200, testing: 200, feedback: 130,
};
const MAX_CALLS = Number(process.env.HIVE_MAX_CALLS || 0);
const MAX_TOKENS = Number(process.env.HIVE_MAX_TOKENS || 2000000);
const WATCH_MS = Number(process.env.HIVE_WATCH_MS || 5000);
const budgetFor = (stage) => (MAX_CALLS > 0 ? MAX_CALLS : (STAGE_BUDGET[stage] || 60));

const RATES = {
  input: Number(process.env.HIVE_USD_PER_M_INPUT || 0),
  cacheRead: Number(process.env.HIVE_USD_PER_M_CACHE_READ || 0),
  output: Number(process.env.HIVE_USD_PER_M_OUTPUT || 0),
};
const PRICE_BASIS = process.env.HIVE_PRICE_BASIS || '';

const STAGE_BRIEF = {
  capture: {
    mayNot: 'research it, plan it, do the work, test it or move the card',
    leaves: 'what the work is, how it was classified, where it belongs, and the read boundary on its own line as BOUNDARY: then, in plain words, what this card may read',
    enough: 'Everything this stage needs is on the card below. Do not read the rule book, the board\'s own program or data, or another card\'s folder, and do not do a session opening. Answer at once, in one reply.',
  },
  analyse: {
    mayNot: 'approve it, plan it, do the work, or move the card past the gate',
    leaves: 'the one-page case, the blind spots, what is feasible, and the sources',
  },
  planning: {
    mayNot: 'do the work, test it, or move the card past its own stage',
    leaves: 'the tasks and sub-tasks, who does each, and what each one waits on',
  },
  execution: {
    mayNot: 'test its own work, approve it, or move the card past its own stage',
    leaves: 'what it changed, where it changed it, and the proof it prints',
  },
  testing: {
    mayNot: 'fix what it finds, approve it, or move the card past its own stage',
    leaves: 'each check, its result, and every check that failed',
  },
  feedback: {
    mayNot: "ignore the owner's marks, or move the card past its own stage",
    leaves: 'each correction he marked and where the correction was applied',
  },
};

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const cardArg = argv.indexOf('--card');
const only = cardArg >= 0 ? Number(argv[cardArg + 1]) : null;
const QUEEN_ON = process.env.HIVE_QUEEN !== '0';
const BEES = Math.max(1, Number(process.env.HIVE_BEES || 4));
const HANDS = QUEEN_ON ? BEES : Math.max(1, Number(process.env.HIVE_HANDS || 4));
const COLUMN_HANDS = Math.max(1, Number(process.env.HIVE_HANDS_PER_COLUMN || 4));
const ONLY_WO = (process.env.HIVE_ONLY_WO || '').split(',').map((v) => v.trim()).filter(Boolean);
const CARD_MAX_TOKENS = Number(process.env.HIVE_CARD_MAX_TOKENS || 60000000);
const COLUMN_MAX_TOKENS = Number(process.env.HIVE_COLUMN_MAX_TOKENS || 300000000);
const SPEND_FILE = process.env.HIVE_SPEND_FILE || path.join(PMO_HOME, 'state', 'column-spend.json');
function bkkDay() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function spendBook() {
  try {
    const b = JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8'));
    if (b && b.day === bkkDay()) return b;
  } catch {  }
  return { day: bkkDay(), stages: {} };
}
function spentToday(stage) { return Number(spendBook().stages[stage] || 0); }
function addSpend(stage, tokens) {
  const b = spendBook();
  b.stages[stage] = Number(b.stages[stage] || 0) + Math.max(0, Number(tokens) || 0);
  try {
    fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
    fs.writeFileSync(SPEND_FILE, JSON.stringify(b));
  } catch (e) { console.log(`worker: the spend book could not be written (${e.message})`); }
}

const api = async (p, b) => {
  const r = await fetch(BOARD + p, {
    method: b ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return r.json();
};

function sessionDir(cwd) {
  const mangled = cwd.replace(
    /[^A-Za-z0-9._-]/g,
    (c) => (c === '/' ? '-' : '~' + c.charCodeAt(0).toString(16).padStart(4, '0')),
  );
  return path.join(DSH_HOME, 'sessions', '-' + mangled + '--');
}

function readUsageTeam(sinceMs, marker, cwd) {
  const dir = sessionDir(cwd || RUN_CWD);
  const total = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, calls: 0,
  };
  const models = {};
  let read = 0;
  let marked = false;
  try {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name, 'session.v3.jsonl.zstd');
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < sinceMs) continue;
      const one = readSessionFile(f);
      if (one == null) continue;
      read++;
      if (marker) {
        const raw = decompress(f) || '';
        if (raw.includes(marker)) marked = true;
      }
      for (const k of Object.keys(total)) if (k !== 'calls') total[k] += Number(one[k] || 0);
      total.calls += Number(one.calls || 0);
      if (one.model) models[one.model] = (models[one.model] || 0) + 1;
    }
  } catch { return null; }
  if (!read) return null;
  if (marker && !marked) return null;
  const model = Object.keys(models).sort((a, b) => models[b] - models[a])[0] || '';
  return { ...total, model, session: 'team' };
}

function readUsage(sinceMs, file, marker, cwd) {
  const dir = sessionDir(cwd || RUN_CWD);
  if (file) return readSessionFile(file);
  const candidates = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name, 'session.v3.jsonl.zstd');
      try {
        const st = fs.statSync(f);
        if (st.mtimeMs < sinceMs) continue;
        candidates.push({ file: f, mtimeMs: st.mtimeMs });
      } catch {  }
    }
  } catch { return null; }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (marker) {
    for (const c of candidates) {
      const text = decompress(c.file);
      if (text != null && text.includes(marker)) return readSessionFile(c.file);
    }
    return null;
  }
  return candidates.length ? readSessionFile(candidates[0].file) : null;
}

function decompress(file) {
  try {
    return execFileSync(ZSTD, ['-dc', file], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch {
    try { return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'); }
    catch { return null; }
  }
}

function readSessionFile(target) {
  const text = decompress(target);
  if (text == null) return null;

  const usage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, calls: 0,
  };
  const models = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const u = rec?.data?.usage;
    if (u && typeof u === 'object') {
      for (const k of Object.keys(usage)) if (k !== 'calls') usage[k] += Number(u[k] || 0);
      usage.calls += 1;
    }
    for (const m of line.matchAll(/"model":"([^"]+)"/g)) models[m[1]] = (models[m[1]] || 0) + 1;
  }
  const model = Object.keys(models).sort((a, b) => models[b] - models[a])[0] || '';
  return { ...usage, model, session: path.basename(path.dirname(target)) };
}

function priceOf(usage) {
  const named = RATES.input || RATES.cacheRead || RATES.output;
  const usd =
    (usage.inputTokens * RATES.input +
      usage.cacheReadTokens * RATES.cacheRead +
      usage.outputTokens * RATES.output) / 1e6;
  return {
    costUsd: named ? Math.round(usd * 1e6) / 1e6 : null,
    priceBasis: named ? (PRICE_BASIS || 'rate named on the box') : '',
  };
}

function STAGE_NAME(key) {
  return ({ capture: 'Capture', analyse: 'Analyse', approved: 'Approved', planning: 'Planning',
    execution: 'Execution', testing: 'Testing', feedback: 'Feedback', done: 'Completed',
    archive: 'Archive' })[key] || key;
}

function brief(w, runMark, cwd, hand) {
  const sb = STAGE_BRIEF[w.stage] || {};
  return [
    hand ? `You are ${hand}, the hand the Queen gave this card to, the ${w.agent} on a project board.` : `You are the hand the Queen gave this card to, the ${w.agent} on a project board.`,
    `You do ONE stage and only one: the ${w.stageName} stage.`,
    `THE QUEEN KEEPS THE BOARD AND GAVE THIS CARD TO YOU. The board is the owner's, the work orders and projects on it are his, and this one stage of this one card is yours. Do not take another card and do not lead the board.`,
    `You have your worker bees, and they are the whole of your team.`,
    `START THE TEAM NOW, before anything else: create it with approval="automatic", add the bees this card needs (never fewer than one), give each of them her task, and let them work. The team's own record, under this run\'s own folder, is the activity the owner watches on the board while this card works: it must stand there while you work, not after.`,
    `UP TO SIX BEES, AND NO SEVENTH:. One bee on one work order is your call. Two or three on another is your call. Six on a project is your call. That decision is yours alone, you make it for each card, and it is never fixed for you.`,
    `When you set a bee to a work item, her task is that work item's own text, word for word, exactly as this runner's itemBrief() hands it to her.`,
    `THIS CARD IS THE OWNER'S OWN ORDER, and it is the authority for the team you set up: create the team and its roster with approval="automatic". The card's authority is the approval; there is no plan review inside this run.`,
    `DO NOT STOP FOR A PLAN REVIEW and do not wait for anyone to approve the roster: a run that stands waiting delivers nothing.`,
    `THE ONE REVIEW IN THIS CHAIN IS THE OWNER'S OWN, and it stands on the board at the Approved stage, where nothing of yours may move the card.`,
    `This is NOT a session opening: do not greet, do not name a machine, do not say the time,`,
    `do not say the words of respect, and write no heading. Answer with the work of this stage only.`,
    sb.enough ? sb.enough : '',
    `What this stage is for: ${w.duty}.`,
    w.repair
      ? `THIS STAGE IS A REPAIR, not the first pass. The ${STAGE_NAME(w.repair.checkStage)} stage failed, so the card was sent back to this ${w.stageName} stage to be mended, and when you are done the ${STAGE_NAME(w.repair.checkStage)} stage comes round again as a fresh check. The stage you do now is ${w.stageName} and no other. Mend what failed and say plainly what you changed.`
      : '',
    sb.mayNot ? `What this stage's agent may not do: it ${sb.mayNot}.` : '',
    sb.leaves ? `The evidence this stage must leave behind: ${sb.leaves}.` : '',
    cwd ? `Your working folder for this stage is ${cwd}. You may write there and nowhere else: everything outside it is refused by the machine.` : '',
    w.boundary ? `THE READ BOUNDARY WRITTEN ON THIS CARD: ${w.boundary}` : '',
    w.boundary ? `You may read what that boundary names, and nothing else.` : '',
    `You may not do another stage's work and you may not move the card on the board:`,
    `the board moves it, and only the owner opens the gate.`,
    `THE BOARD IS THE ONLY HAND THAT MOVES THE CARD. You do not move it, no bee moves it, and nothing written in a run moves it.`,
    `THE LAST ACT OF YOUR RUN IS THE VERDICT LINE, exactly as it stands today: the first line of your answer is VERDICT: PASS or VERDICT: FAIL, and a run that gives none is read as a failure.`,
    ``,
    `THE CARD: ${w.title}`,
    w.word ? `THE OWNER'S OWN WORD ON THIS CARD, which he wrote on the card himself. It comes before everything else here: "${w.word}"` : '',
    w.word ? `THAT WORD IS THE CARD'S OWN WORD, typed by the owner on the card at his gate. It is not a note about the work: it is the work's own instruction. The stage that follows the gate reads it, and where his words are there they come before that stage's own plan.` : '',
    `Run mark for this one stage, internal - never repeat it: ${runMark}`,
    w.items ? `THE PLAN'S WORK ITEMS AND THEIR RESULTS, each held and worked by a hand of its own:` : '',
    w.items ? w.items.map((i) => `  ${i.n}. ${i.text} - ${i.state}${i.out ? ': ' + String(i.out).slice(0, 400) : ''}`).join('\n') : '',
    w.items ? `Every item has been worked. Gather them into the result of this stage, name what each hand delivered, and say what is left.` : '',
    w.body ? `What is known: ${w.body}` : '',
    w.evidence.length
      ? `What earlier stages found (the newest four rounds, trimmed to their own opening; the card keeps the whole history):\n${w.evidence.slice(-4).map((e) => `  - ${e.stage}: ${String(e.out).slice(0, 1500)}`).join('\n')}`
      : '',
    ``,
    `READ ONLY WHAT THE CARD NAMES: the card and what earlier stages said on it,`,
    `your own folder, and any path the card names. Do not survey the filesystem, do not`,
    `walk the shared folder, do not read the rule book or the board's own program, and do`,
    `not open another card's folder. If a path you need is not named on the card, say so`,
    `and stop; do not go looking for it.`,
    `THE FIRST LINE OF YOUR ANSWER IS YOUR VERDICT, exactly: VERDICT: PASS when the`,
    `stage's own work is done and true, VERDICT: FAIL when it is not. A stage that gives`,
    `no verdict is read as a failure, and the card goes back to be repaired.`,
    `After that first line, answer with the result of that stage only,`,
    `plainly and in under 400 words. Do not ask questions; do the stage.`,
  ].filter(Boolean).join('\n');
}


const STAGE_CHAIN = ['capture', 'analyse', 'approved', 'planning', 'execution', 'testing', 'feedback', 'done'];

function stagesFor(stage) {
  const i = STAGE_CHAIN.indexOf(String(stage || '').toLowerCase());
  if (i < 0) return [];
  const out = [];
  for (const s of STAGE_CHAIN.slice(i)) {
    if (s === 'approved' || s === 'done') break;
    out.push(s);
  }
  return out;
}

function passBrief(w, list, runMark, cwd, hand) {
  const sb = STAGE_BRIEF[w.stage] || {};
  const names = list.map((s) => STAGE_NAME(s));
  return [
    hand ? `You are ${hand}, the hand the Queen gave card #${w.id} to, on a project board.` : `You are the hand the Queen gave card #${w.id} to, on a project board.`,
    `ONE CARD, ONE TEAM. You keep ONE team for this whole run and you work this card's stages with it, in this order: ${names.join(', then ')}.`,
    `THE QUEEN KEEPS THE BOARD AND GAVE THIS CARD TO YOU. The board is the owner's; this card's work is yours. Do not take another card and do not lead the board.`,
    `START THE TEAM NOW, before anything else: create it with approval="automatic", add the bees this card needs (never fewer than one), give each of them her task, and let them work. You create the team ONCE. You never make a second team, and every stage below is done by the same bees. Your turn stays open with them until the last stage file is written.`,
    `UP TO SIX BEES, AND NO SEVENTH:. How many this card needs is your call.`,
    `THIS CARD IS THE OWNER'S OWN ORDER, and it is the authority for the team you set up: create the team and its roster with approval="automatic". Do not stop for a plan review.`,
    `THE ONE REVIEW IN THIS CHAIN IS THE OWNER'S OWN, and it stands on the board at the Approved stage, which this run never touches.`,
    `This is NOT a session opening: do not greet, do not name a machine, do not say the time, do not say the words of respect, and write no heading.`,
    sb.enough ? sb.enough : '',
    `AFTER EACH STAGE, BEFORE THE NEXT ONE BEGINS, write that stage's own record into ${cwd}/ . THE FILE NAMES ARE FIXED, IN THIS ORDER: ${list.map((s, i) => `STAGE-${i + 1}-${STAGE_NAME(s)}.md`).join(', then ')}. Use exactly those names and no other (once a fixed example in this brief made a stage file carry the wrong stage name). Its FIRST LINE is exactly "VERDICT: PASS" or "VERDICT: FAIL" for that stage, and after that line stands what that stage must leave behind. Write the file for a stage before you start the next one: the board reads those files and moves this card one column for each, in the order they were written.`,
    `A stage that does not pass writes its own VERDICT: FAIL and the card stops there. Do not write a stage you have not done, and do not write a passing verdict for work you did not do.`,
    w.repair
      ? `THIS PASS IS A REPAIR, not the first time. The ${STAGE_NAME(w.repair.checkStage)} stage failed, so the card was sent back to the ${w.stageName} stage to be mended; the ${STAGE_NAME(w.repair.checkStage)} stage comes round again as a fresh check later. Mend what failed and say plainly what you changed.`
      : '',
    `What this first stage is for: ${w.duty}.`,
    sb.mayNot ? `What these stages may not do: they ${sb.mayNot}.` : '',
    `The evidence each stage must leave behind, in its own file: ${list.map((s) => `${STAGE_NAME(s)}: ${(STAGE_BRIEF[s] || {}).leaves || 'its own result'}`).join(' | ')}.`,
    cwd ? `Your working folder for this pass is ${cwd}. You may write there and nowhere else: everything outside it is refused by the machine.` : '',
    w.boundary ? `THE READ BOUNDARY WRITTEN ON THIS CARD: ${w.boundary}` : '',
    w.boundary ? `You may read what that boundary names, and nothing else.` : '',
    `You may not move the card on the board: the board moves it, one column per stage file you write, and only the owner opens the gate.`,
    ``,
    `THE CARD: ${w.title}`,
    w.word ? `THE OWNER'S OWN WORD ON THIS CARD, which he wrote on the card himself. It comes before everything else here: "${w.word}"` : '',
    `Run mark for this pass, internal - never repeat it: ${runMark}`,
    w.body ? `What is known: ${w.body}` : '',
    w.evidence.length
      ? `What earlier work found (the newest four rounds, trimmed to their own opening; the card keeps the whole history):\n${w.evidence.slice(-4).map((e) => `  - ${e.stage}: ${String(e.out).slice(0, 1500)}`).join('\n')}`
      : '',
    ``,
    `READ ONLY WHAT THE CARD NAMES: the card and what earlier work said on it, your own folder,`,
    `and any path the card names. Do not survey the filesystem, do not walk the shared folder,`,
    `do not read the rule book or the board's own program, and do not open another card's folder.`,
    `DO NOT END YOUR TURN UNTIL EVERY STAGE FILE STANDS ON DISK. Your bees do the work and your`,
    `turn is what keeps them alive: the machine stops this run the moment your turn ends, and a bee`,
    `that has not finished dies with it. So stay with them. After you set the bees going, wait for`,
    `them - check the team's own state, wait again, and go on waiting - and write each stage's file`,
    `as that stage's work lands, before you start the next stage. A turn that ends before the files`,
    `are written delivers nothing: the work is lost and the card goes back to where it was.`,
    `Do the stages in the order named. When the last stage's file stands, answer with one short`,
    `line saying what each stage delivered.`,
  ].filter(Boolean).join('\n');
}

function stageFilesIn(cwd) {
  let names = [];
  try { names = fs.readdirSync(cwd); } catch { return []; }
  return names
    .filter((f) => /^STAGE-\d+-.+\.md$/i.test(f))
    .map((f) => ({ f, n: Number((f.match(/^STAGE-(\d+)/i) || [])[1] || 0) }))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.f);
}

function itemBrief(w, runMark, cwd, hand) {
  return [
    hand ? `You are ${hand}, one of the Queen's worker bees, the ${w.agent} on a project board.` : `You are one of the Queen's worker bees, the ${w.agent} on a project board.`,
    `You do ONE WORK ITEM of card ${w.title}, and nothing else.`,
    `THE WORK ITEM: ${w.itemText}`,
    `Your working folder for this task is ${cwd}. You may write there and nowhere else: everything outside it is refused by the machine.`,
    w.boundary ? `THE READ BOUNDARY WRITTEN ON THIS CARD: ${w.boundary}` : '',
    w.boundary ? `You may read what that boundary names, and nothing else.` : '',
    `Run mark for this task, internal - never repeat it: ${runMark}`,
    w.body ? `What is known: ${w.body}` : '',
    `THE FIRST LINE OF YOUR ANSWER IS YOUR VERDICT, exactly: VERDICT: PASS when the item is done and true, VERDICT: FAIL when it is not.`,
    `After that first line, answer with what you did for this item, plainly and in under 300 words. Do not ask questions; do the item.`,
  ].filter(Boolean).join('\n');
}

function sessionDirs(cwd) {
  try { return new Set(fs.readdirSync(sessionDir(cwd || RUN_CWD))); } catch { return new Set(); }
}

function liveMeter(before, cwd) {
  const dir = sessionDir(cwd || RUN_CWD);
  let calls = 0;
  let tokens = 0;
  let mtimeMs = 0;
  let read = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (before.has(name)) continue;
      const f = path.join(dir, name, 'session.v3.jsonl.zstd');
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      const text = decompress(f);
      if (text == null) continue;
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue;
        calls++;
        try {
          const u = JSON.parse(line)?.data?.usage;
          if (u && typeof u === 'object') {
            tokens += Number(u.inputTokens || 0) + Number(u.outputTokens || 0) + Number(u.cacheWriteTokens || 0);
          }
        } catch {  }
      }
      read++;
      if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
    }
  } catch { return null; }
  if (!read) return null;
  return { calls, tokens, mtimeMs };
}

function verdictOf(text) {
  const whole = String(text || '');
  const m = whole.match(/VERDICT\s*[:=\-–]?\s*\**\s*(PASS|FAIL)\b/i);
  if (!m) return { ok: false, why: 'THE STAGE DID NOT GIVE ITS VERDICT. The answer must carry "VERDICT: PASS" or "VERDICT: FAIL"; a stage that gives none is a failure.' };
  return m[1].toUpperCase() === 'PASS'
    ? { ok: true, why: '' }
    : { ok: false, why: 'THE STAGE SAID IT FAILED: it answered "VERDICT: FAIL".' };
}

function runHarness(prompt, budget, cwd, stage, timeoutMs) {
  return new Promise((resolve) => {
    if (String(stage || '').toLowerCase() === 'approved') {
      resolve({
        ok: false,
        gate: true,
        exit: -1,
        out: "THE GATE IS THE OWNER'S, AND NOTHING STARTS THERE. This card stands at the Approved " +
          "stage, so no work was started and no bee was set to it. The card stays where it is " +
          "until the owner reviews it and moves it forward himself, or types his further word on " +
          "the card for the stage that follows the gate.",
      });
      return;
    }
    const runCwd = cwd || RUN_CWD;
    const before = sessionDirs(runCwd);
    const child = spawn(DSH, ['--profile', 'headless', '--patch', QUEEN_PATCH, '/agent-teams ' + prompt], {
      cwd: runCwd,
      env: { ...process.env, DSH_PERMISSION_MODE: 'workspace-write' },
    });
    let out = '';
    let err = '';
    let stopped = '';
    const limit = Math.max(60000, Number(timeoutMs) || TIMEOUT);
    const kill = setTimeout(() => {
      if (!stopped) { stopped = `it ran past ${Math.round(limit / 60000)} minutes`; child.kill('SIGKILL'); }
    }, limit);
    let lastProgress = Date.now();
    let lastCalls = 0, lastTokens = 0, lastOut = 0;
    const watch = (budget > 0 || MAX_TOKENS > 0 || STALL_MS > 0) ? setInterval(() => {
      if (stopped) return;
      const m = liveMeter(before, runCwd);
      if (m != null) {
        if (m.calls > lastCalls || m.tokens > lastTokens || (m.mtimeMs && m.mtimeMs > lastProgress)) {
          lastCalls = m.calls;
          lastTokens = m.tokens;
          if (m.mtimeMs && m.mtimeMs > lastProgress) lastProgress = m.mtimeMs;
        }
        if (MAX_TOKENS > 0 && m.tokens >= MAX_TOKENS) {
          stopped = `it had used ${m.tokens.toLocaleString()} tokens, past this run's cap of ${MAX_TOKENS.toLocaleString()}`;
          child.kill('SIGKILL');
          return;
        }
        if (budget > 0 && m.calls >= budget) {
          stopped = `it had made ${m.calls} model calls, past this stage's budget of ${budget}`;
          child.kill('SIGKILL');
          return;
        }
      }
      if (out.length > lastOut) { lastOut = out.length; lastProgress = Date.now(); }
      if (STALL_MS > 0 && Date.now() - lastProgress >= STALL_MS) {
        stopped = `it made no progress for ${Math.round(STALL_MS / 1000)} seconds - no model call, no token and no output`;
        child.kill('SIGKILL');
      }
    }, WATCH_MS) : null;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(kill);
      if (watch) clearInterval(watch);
      let text = (out.trim() || err.trim());
      if (stopped) {
        text = `THE STAGE WAS STOPPED AND SET ASIDE: ${stopped}.\n` +
          `A stage that is stopped is never repeated by itself. Say the word if it is to be given another go, ` +
          `or name a larger budget for it.\n\nWhat the stage had done before it was stopped stands below.\n\n${text}`;
      }
      const ran = code === 0 && !stopped && out.trim().length > 0;
      const v = ran ? verdictOf(text) : { ok: false, why: '' };
      if (ran && !v.ok) text = v.why + '\n\n' + text;
      resolve({ ok: ran && v.ok, out: text, exit: code, stopped: !!stopped });
    });
    child.on('error', (e) => {
      clearTimeout(kill);
      if (watch) clearInterval(watch);
      resolve({ ok: false, out: `the harness could not be started: ${e.message}`, exit: -1 });
    });
  });
}

const HAND_NAMES = Array.from({ length: HANDS }, (_, i) => `Agent ${i + 1}`);
const handsBusy = new Map();
function takeHand() {
  for (const n of HAND_NAMES) {
    if (!handsBusy.has(n)) { handsBusy.set(n, null); return n; }
  }
  return null;
}
function freeHand(n) { handsBusy.delete(n); }

async function workOne(w, hand) {
    hand = hand || HAND_NAMES[0];
    const isItem = !!w.item;
    await api(`/api/card/${w.id}/claim`, isItem ? { hand, item: w.item } : { hand });
    console.log(isItem
      ? `worker: the Queen gave work item ${w.item} of card #${w.id} to worker bee ${hand} - the ${w.agent}`
      : `worker: the Queen gave card #${w.id} to worker bee ${hand} - the ${w.agent} on the ${w.stageName} stage`);
    const startedAt = Date.now();
    const runMark = `hive-run-${w.id}-${startedAt}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    let r, usage, priced, after;
    try {
      const workCwd = isItem
        ? path.join(workDirFor(w.key || ('card-' + w.id)), 'item-' + w.item)
        : workDirFor(w.key || ('card-' + w.id));
      fs.mkdirSync(workCwd, { recursive: true });
      r = await runHarness(isItem ? itemBrief(w, runMark, workCwd, hand) : brief(w, runMark, workCwd), budgetFor(w.stage), workCwd, w.stage);
      if (r.gate) {
        console.log(`worker: card #${w.id} stands at the gate, which is the owner's alone - nothing was started`);
        try { await api(`/api/card/${w.id}/release`, {}); } catch {  }
        return;
      }
      usage = readUsageTeam(startedAt - 3000, runMark, workCwd);
      priced = usage ? priceOf(usage) : { costUsd: null, priceBasis: '' };
      if (usage) addSpend(w.stage, usage.totalTokens);
    } catch (e) {
      r = { ok: false, out: `the stage could not be run: ${e && e.message ? e.message : e}` };
      usage = null;
      priced = { costUsd: null, priceBasis: '' };
    }
    try {
      after = await api(`/api/card/${w.id}/finish`, {
        ok: r.ok, out: r.out, usage, costUsd: priced.costUsd, priceBasis: priced.priceBasis,
        hand, runMark,
        ...(isItem ? { item: w.item } : {}),
        ...(r.stopped ? { stopped: true } : {}),
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.log(`worker: the board did not take the result for card #${w.id} (${e.message}) - letting go of it`);
      try { await api(`/api/card/${w.id}/release`, {}); } catch {  }
      return;
    }
    if (!after || !after.card) {
      console.log(`worker: the board gave no card back for #${w.id} - letting go of it`);
      try { await api(`/api/card/${w.id}/release`, {}); } catch {  }
      return;
    }
    const money =
      priced.costUsd == null
        ? (usage ? `${usage.totalTokens} tokens, no rate named` : 'no usage read')
        : `${usage.totalTokens} tokens, $${priced.costUsd}`;
    console.log(`worker: card #${w.id}${isItem ? ' item ' + w.item : ''} cost ${money}`);
    if (isItem) {
      const left = (Array.isArray(after.card.items) ? after.card.items : []).filter((i) => i.state !== 'done' && i.state !== 'failed').length;
      console.log(`worker: ${r.ok ? 'done' : 'FAILED'} - work item ${w.item} of card #${w.id}${left ? ', ' + left + ' item(s) still to work' : ', every item worked'}`);
    } else {
      console.log(
        `worker: ${r.ok ? 'done' : 'FAILED'} - card #${w.id} now at ${after.card.stage}` +
        (after.waitingOnOwner ? ' and WAITING ON THE OWNER' : ''),
      );
    }
}


async function workCard(w, hand) {
  hand = hand || HAND_NAMES[0];
  const list = stagesFor(w.stage);
  if (!list.length) { await workOne(w, hand); return; }
  const workCwd = workDirFor(w.key || ('card-' + w.id));
  fs.mkdirSync(workCwd, { recursive: true });
  for (const f of stageFilesIn(workCwd)) { try { fs.unlinkSync(path.join(workCwd, f)); } catch {  } }
  await api(`/api/card/${w.id}/claim`, { hand });
  console.log(`worker: the Queen gave card #${w.id} to worker bee ${hand} - ONE team for ${list.map((s) => STAGE_NAME(s)).join(', ')}`);
  const startedAt = Date.now();
  const runMark = `hive-run-${w.id}-${startedAt}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const budget = list.reduce((n, s) => n + budgetFor(s), 0);
  let r;
  try {
    r = QUEEN_ON
      ? await runByQueen(w, list, runMark, workCwd, hand, Math.min(120, 15 * list.length) * 60000)
      : await runHarness(passBrief(w, list, runMark, workCwd, hand), budget, workCwd, w.stage, Math.min(60, 15 * list.length) * 60000);
  } catch (e) {
    r = { ok: false, out: `the pass could not be run: ${e && e.message ? e.message : e}` };
  }
  if (r.gate) {
    console.log(`worker: card #${w.id} stands at the gate, which is the owner's alone - nothing was started`);
    try { await api(`/api/card/${w.id}/release`, {}); } catch {  }
    return;
  }
  const usage = QUEEN_ON
    ? readUsageTeam(startedAt - 3000, '', WORK_ROOT)
    : readUsageTeam(startedAt - 3000, runMark, workCwd);
  const priced = usage ? priceOf(usage) : { costUsd: null, priceBasis: '' };
  if (usage) addSpend(w.stage, usage.totalTokens);

  const files = stageFilesIn(workCwd);
  const advance = async (text, ok, isLast) => api(`/api/card/${w.id}/finish`, {
    ok, out: text, hand, runMark,
    usage: isLast ? usage : null,
    costUsd: isLast ? priced.costUsd : null,
    priceBasis: isLast ? priced.priceBasis : '',
    ...(isLast && r.stopped ? { stopped: true } : {}),
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
  });

  if (!files.length) {
    let after;
    try { after = await advance(r.out, r.ok, true); }
    catch (e) {
      console.log(`worker: the board did not take the result for card #${w.id} (${e.message}) - letting go of it`);
      try { await api(`/api/card/${w.id}/release`, {}); } catch {  }
      return;
    }
    if (!after || !after.card) {
      console.log(`worker: the board gave no card back for #${w.id} - letting go of it`);
      try { await api(`/api/card/${w.id}/release`, {}); } catch {  }
      return;
    }
    console.log(`worker: ${r.ok ? 'done' : 'FAILED'} - card #${w.id} now at ${after.card.stage} (no stage file was written)`);
    return;
  }

  let done = 0;
  for (let i = 0; i < files.length && i < list.length; i++) {
    let text = '';
    try { text = fs.readFileSync(path.join(workCwd, files[i]), 'utf8'); } catch { text = ''; }
    const v = verdictOf(text);
    const isLast = i === files.length - 1;
    let after;
    try {
      if (i > 0) await api(`/api/card/${w.id}/claim`, { hand });
      after = await advance(text, v.ok, isLast);
    } catch (e) {
      console.log(`worker: the board did not take stage ${i + 1} of card #${w.id} (${e.message}) - letting go of it`);
      try { await api(`/api/card/${w.id}/release`, {}); } catch {  }
      return;
    }
    if (!after || !after.card) {
      console.log(`worker: the board gave no card back for #${w.id} - letting go of it`);
      try { await api(`/api/card/${w.id}/release`, {}); } catch {  }
      return;
    }
    done++;
    console.log(`worker: stage ${i + 1} of card #${w.id} (${STAGE_NAME(list[i])}) wrote ${files[i]} - ${v.ok ? 'PASS' : 'FAIL'} - the card now at ${after.card.stage}`);
    if (!v.ok) break;
  }
  const money = priced.costUsd == null
    ? (usage ? `${usage.totalTokens} tokens, no rate named` : 'no usage read')
    : `${usage.totalTokens} tokens, $${priced.costUsd}`;
  console.log(`worker: card #${w.id} pass finished - ${done} stage(s) moved by one team, cost ${money}`);
}

async function pass() {
  let work = [];
  try {
    ({ work } = await api('/api/work'));
  } catch (e) {
    console.log(`worker: the board is not answering (${e.message})`);
    return 0;
  }
  const list = work.filter((w) => (only ? w.id === only : true)).slice(0, 1);
  for (const w of list) {
    const hand = takeHand() || HAND_NAMES[0];
    try { await (w.item ? workOne(w, hand) : workCard(w, hand)); } finally { freeHand(hand); }
  }
  return list.length;
}

const inflight = new Map();
const cappedStages = new Set();
const retriedFailure = new Map();
async function giveFailedCardsOneGo() {
  let cards = [];
  try {
    const b = await api('/api/board');
    cards = Array.isArray(b.cards) ? b.cards : [];
  } catch { return 0; }
  let given = 0;
  for (const c of cards) {
    if (!c.failedAt || c.binnedAt || c.archivedAt) continue;
    const mark = String(c.failedAt);
    if (retriedFailure.get(c.id) === mark) continue;
    if (retriedFailure.size > 200) retriedFailure.clear();
    try {
      await api(`/api/card/${c.id}/retry`, {});
      retriedFailure.set(c.id, mark);
      given++;
      console.log(`worker: card #${c.id} (${c.key}) failed at ${c.stageName || c.stage} and was given one more go`);
    } catch (e) {
      console.log(`worker: could not give card #${c.id} another go (${e.message})`);
    }
  }
  return given;
}


const QUEEN_LOG_DIR = process.env.HIVE_QUEEN_LOG_DIR || path.join(PMO_HOME, 'logs');
const QUEEN_LOG_BASE = 'HIVE_QUEEN_LOG';
const QUEEN_LOG_MAX = Number(process.env.HIVE_QUEEN_LOG_MAX || 1000000);
let queenLogVersion = { major: 1, minor: 0 };
function queenLogPath(v) { return path.join(QUEEN_LOG_DIR, `${QUEEN_LOG_BASE}_v${v.major}.${v.minor}.txt`); }
function bumpQueenLog(v) {
  let minor = v.minor + 1;
  let major = v.major;
  if (minor > 9) { minor = 0; major += 1; }
  return { major, minor };
}
function appendQueenLog(line) {
  try {
    fs.mkdirSync(QUEEN_LOG_DIR, { recursive: true });
    let p = queenLogPath(queenLogVersion);
    let size = 0;
    try { size = fs.statSync(p).size; } catch { size = 0; }
    if (size > QUEEN_LOG_MAX) {
      queenLogVersion = bumpQueenLog(queenLogVersion);
      p = queenLogPath(queenLogVersion);
    }
    fs.appendFileSync(p, `${stamp()} ${line}\n`);
  } catch (e) {
    console.log(`worker: the Queen's log could not be written (${e.message})`);
  }
}
async function queenLine() {
  try {
    const b = await api('/api/board');
    const w = await api('/api/work');
    const cards = Array.isArray(b.cards) ? b.cards : [];
    const onBoard = cards.filter((c) => !c.binnedAt && c.stage !== 'archive');
    const owe = onBoard.filter((c) => ['capture', 'analyse', 'planning', 'execution', 'testing', 'feedback'].includes(c.stage)
      && !((c.stageDone || {})[c.stage]));
    const failed = onBoard.filter((c) => c.failedAt);
    const parked = onBoard.filter((c) => c.parkedAt);
    const capture = onBoard.filter((c) => c.stage === 'capture');
    const pink = onBoard.filter((c) => c.pinkAt);
    const finished = onBoard.filter((c) => {
      const d = c.stageDone || {};
      if (c.stage === 'feedback' && d.feedback) return true;
      return c.stage !== 'done' && c.stage !== 'archive' && d.capture && d.analyse && d.approved
        && d.planning && d.execution && d.testing && d.feedback;
    });
    const gate = onBoard.filter((c) => c.stage === 'approved' && !c.approvedAt);
    const compiled = onBoard.filter((c) => c.stage === 'done');
    const canWork = owe.filter((c) => !c.pinkAt && !c.parkedAt && !c.failedAt && !c.held);
    const offered = ((w && w.work) || []).length;
    return `checked ${onBoard.length} cards on the board: ${compiled.length} completed, `
      + `${capture.length} in Capture, ${owe.length} owe a stage (${canWork.length} of them can be worked), ${failed.length} failed, `
      + `${pink.length} pink, ${parked.length} parked, ${finished.length} finished waiting on your confirm, `
      + `${gate.length} at the owner's gate; work offered to me: ${offered}`;
  } catch (e) {
    return `the board could not be read (${e.message})`;
  }
}

async function standingTruth(taken) {
  try {
    const b = await api('/api/board');
    const cards = Array.isArray(b.cards) ? b.cards : [];
    const live = cards.filter((c) => !c.binnedAt && !c.archivedAt && !c.parkedAt);
    const waiting = Number(b.waiting || 0) || live.filter((c) => c.stage === 'approved' && !c.approvedAt).length;
    const finished = live.filter((c) => {
      const d = c.stageDone || {};
      return c.stage !== 'done' && c.stage !== 'archive' && d.capture && d.analyse && d.approved
        && d.planning && d.execution && d.testing && d.feedback;
    }).length;
    const failed = live.filter((c) => c.failedAt).map((c) => `${c.key || c.id} at ${c.stageName || c.stage}`);
    const working = live.filter((c) => ['capture', 'analyse', 'planning', 'execution', 'testing', 'feedback'].includes(c.stage)
      && !((c.stageDone || {})[c.stage]));
    console.log(`worker: the board read whole - ${live.length} cards standing, ${working.length} owing a stage, `
      + `${taken} taken by me, ${failed.length} failed, ${finished} finished and waiting on the owner, ${waiting} at his gate`);
    if (failed.length) console.log(`worker: failed and mine to take: ${failed.join('; ')}`);
    let offered = [];
    try { offered = (await api('/api/work')).work || []; } catch { offered = []; }
    const offeredIds = new Set(offered.map((w) => w.id));
    const overlooked = working.filter((c) => !offeredIds.has(c.id));
    if (overlooked.length) {
      console.log(`worker: ${overlooked.length} card(s) owe a stage and the board does not offer them: ${overlooked.map((c) => `${c.key || c.id} at ${c.stageName || c.stage}`).join('; ')}`);
    }
    return { live: live.length, working: working.length, failed: failed.length, finished, waiting };
  } catch (e) {
    console.log(`worker: the board could not be read whole (${e.message})`);
    return null;
  }
}

async function letGoOfOrphans() {
  let board;
  try { board = await api('/api/board'); } catch { return 0; }
  const held = new Set([...inflight.values()].map((e) => e.cardId));
  let letGo = 0;
  for (const c of (board.cards || [])) {
    if (!c.running) continue;
    if (held.has(c.id)) continue;
    const at = Date.parse(c.updatedAt || c.claimedAt || 0);
    if (at && Date.now() - at < 120000) continue;
    try {
      await api(`/api/card/${c.id}/release`, {});
      console.log(`queen: let go of ${c.key || '#' + c.id} - it wore a hand and no run of hers was on it`);
      letGo++;
    } catch {  }
  }
  return letGo;
}

async function passMany() {
  let work = [];
  try {
    ({ work } = await api('/api/work'));
  } catch (e) {
    console.log(`worker: the board is not answering (${e.message})`);
    return 0;
  }
  work.sort((a, b) => (a.stage === 'capture' ? 0 : 1) - (b.stage === 'capture' ? 0 : 1));
  const perStage = {};
  for (const h of inflight.values()) perStage[h.stage] = (perStage[h.stage] || 0) + 1;
  const slotOf = (w) => `${w.id}#${w.item || 0}`;
  let started = 0;
  for (const w of work) {
    if (inflight.size >= HANDS) break;
    if (only && w.id !== only) continue;
    if (ONLY_WO.length && !ONLY_WO.includes(String(w.key || ''))) continue;
    if (inflight.has(slotOf(w))) continue;
    if (QUEEN_ON && inflight.size) {
      const held = new Set([...inflight.values()].map((e) => e.cardId));
      if (!held.has(w.id)) continue;
    }
    const st = String(w.stage || '');
    const spent = Number((w.usage && w.usage.totalTokens) || 0);
    if (CARD_MAX_TOKENS > 0 && spent >= CARD_MAX_TOKENS) {
      try {
        const capHand = takeHand() || 'the worker';
        await api(`/api/card/${w.id}/claim`, { hand: capHand });
        await api(`/api/card/${w.id}/finish`, {
          ok: false, hand: capHand, runMark: 'set-aside',
          startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
          out: `THE CARD WAS SET ASIDE: it has already spent ${spent.toLocaleString()} tokens, past this card's cap of ${CARD_MAX_TOKENS.toLocaleString()}. A hand on the card decides what happens next.`,
        });
        if (capHand !== 'the worker') freeHand(capHand);
        console.log(`worker: card #${w.id} set aside - it has spent ${spent.toLocaleString()} tokens, past its cap`);
      } catch (e) {
        console.log(`worker: could not set card #${w.id} aside (${e.message})`);
      }
      continue;
    }
    if (COLUMN_MAX_TOKENS > 0 && spentToday(st) >= COLUMN_MAX_TOKENS) {
      if (!cappedStages.has(st)) {
        cappedStages.add(st);
        console.log(`worker: the ${st} column has spent ${spentToday(st).toLocaleString()} tokens today, past its cap of ${COLUMN_MAX_TOKENS.toLocaleString()} - no hand starts in it today`);
      }
      continue;
    }
    if ((perStage[st] || 0) >= COLUMN_HANDS) continue;
    const hand = takeHand();
    if (!hand) continue;
    perStage[st] = (perStage[st] || 0) + 1;
    started++;
    handsBusy.set(hand, w.id);
    const entry = { stage: st, promise: null, hand, cardId: w.id };
    inflight.set(slotOf(w), entry);
    entry.promise = (w.item ? workOne(w, hand) : workCard(w, hand))
      .catch((e) => { console.log(`worker: ${hand} on card #${w.id} fell over (${e && e.message ? e.message : e})`); })
      .finally(() => { inflight.delete(slotOf(w)); freeHand(hand); });
  }
  if (started) console.log(`worker: the Queen set ${started} worker bee(s) going - ${inflight.size} at work now`);
  await standingTruth(started);
  return started;
}


process.on('SIGTERM', () => { stopQueen(); process.exit(0); });
process.on('SIGINT', () => { stopQueen(); process.exit(0); });

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly && argv.includes('--truth')) {
  await standingTruth(0);
  process.exit(0);
}

if (invokedDirectly && argv.includes('--round')) {
  await passMany();
  await Promise.all([...inflight.values()].map((e) => e.promise).filter(Boolean));
  process.exit(0);
}

if (invokedDirectly && once) {
  const n = await pass();
  stopQueen();
  console.log(n ? 'worker: one stage done' : 'worker: nothing was ready');
  process.exit(0);
} else if (invokedDirectly) {
  console.log(`worker: standing, asking the board every ${EVERY / 1000}s`);
  try {
    const rel = await api('/api/release-stale', {});
    if (rel && rel.released && rel.released.length) {
      console.log(`worker: let go of ${rel.released.length} card(s) left claimed by an earlier run: ${rel.released.join(', ')}`);
    }
  } catch (e) {
    console.log(`worker: could not clear an earlier claim (${e.message})`);
  }
  const loop = async () => {
    try { await api('/api/worker-seen', {}); } catch {  }
    if (!queenChild) ensureQueen();
    const line = await queenLine();
    appendQueenLog(line);
    console.log('queen: ' + line);
    await letGoOfOrphans();
    try {
      await passMany();
    } catch (e) {
      console.log(`worker: a pass fell over (${e && e.message ? e.message : e}) and the worker carries on`);
    }
    setTimeout(loop, EVERY);
  };
  ensureQueen();
  console.log('worker: the Queen stands from the start - awake before any card is given to her');
  await loop();
}

export { readUsage, readSessionFile, priceOf, sessionDir, pass, brief, STAGE_BRIEF, verdictOf };
