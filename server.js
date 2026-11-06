'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// 服务端 TTS 兜底：浏览器在非安全上下文（如 http 局域网访问）不提供 speechSynthesis，
// 由服务端代理有道发音接口返回音频，前端用 <audio> 播放
const ttsCache = new Map();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const VOCAB_PATH = path.join(DATA_DIR, 'vocab.json');
const DB_PATH = path.join(DATA_DIR, 'wordlens.db');
const IMPORT_LOG_PATH = path.join(DATA_DIR, 'import.log');

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  port: 3000,
  host: '127.0.0.1'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

let mammoth = null;
try {
  mammoth = require('mammoth');
} catch (err) {
  console.warn('[提示] 未安装 mammoth，.docx 上传不可用。请在项目目录运行 npm install');
}

/* ---------- SQLite ---------- */
let db = null;

function openDB() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS vocab (
      word TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic TEXT NOT NULL DEFAULT '',
      senses TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      added_at TEXT NOT NULL,
      last_lookup_at TEXT NOT NULL,
      lookup_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS word_cards (
      word TEXT PRIMARY KEY COLLATE NOCASE,
      payload TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dict_entries (
      word TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic TEXT NOT NULL DEFAULT '',
      senses TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'en2zh',
      zh_mode TEXT NOT NULL DEFAULT 'full',
      align TEXT NOT NULL DEFAULT 'sentence',
      segments TEXT NOT NULL DEFAULT '[]',
      seg_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  ensureVocabColumns();
  migrateVocabJson();
}

function ensureVocabColumns() {
  const cols = new Set(db.prepare('PRAGMA table_info(vocab)').all().map((c) => c.name));
  const additions = [
    ['due_at', 'TEXT'],
    ['interval_days', 'REAL NOT NULL DEFAULT 0'],
    ['ease', 'REAL NOT NULL DEFAULT 2.5'],
    ['review_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_review_at', 'TEXT']
  ];
  additions.forEach(([name, def]) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE vocab ADD COLUMN ${name} ${def}`);
  });
}

function migrateVocabJson() {
  if (!fs.existsSync(VOCAB_PATH)) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM vocab').get().n;
  if (count > 0) return;
  const items = readJSON(VOCAB_PATH, []);
  if (!Array.isArray(items) || !items.length) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO vocab (word, phonetic, senses, status, added_at, last_lookup_at, lookup_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    if (!item || !item.word) continue;
    insert.run(
      String(item.word),
      item.phonetic || '',
      JSON.stringify(item.senses || []),
      ['new', 'learning', 'mastered'].includes(item.status) ? item.status : 'new',
      item.addedAt || new Date().toISOString(),
      item.lastLookupAt || new Date().toISOString(),
      Number(item.lookupCount) || 1
    );
  }
  fs.renameSync(VOCAB_PATH, `${VOCAB_PATH}.bak`);
  console.log(`已把 ${items.length} 条生词从 vocab.json 迁移到 SQLite（原文件改名为 vocab.json.bak）`);
}

function rowToVocab(row) {
  if (!row) return null;
  return {
    word: row.word,
    phonetic: row.phonetic || '',
    senses: parseJSONSafe(row.senses, []),
    status: row.status,
    addedAt: row.added_at,
    lastLookupAt: row.last_lookup_at,
    lookupCount: row.lookup_count,
    dueAt: row.due_at || null,
    intervalDays: Number(row.interval_days) || 0,
    ease: Number(row.ease) || 2.5,
    reviewCount: Number(row.review_count) || 0,
    lastReviewAt: row.last_review_at || null
  };
}

function listVocab() {
  return db.prepare('SELECT * FROM vocab ORDER BY added_at DESC, word ASC').all().map(rowToVocab);
}

function saveVocab(word, phonetic, senses) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO vocab (word, phonetic, senses, status, added_at, last_lookup_at, due_at, lookup_count)
    VALUES (?, ?, ?, 'new', ?, ?, ?, 1)
    ON CONFLICT(word) DO UPDATE SET
      phonetic = CASE WHEN excluded.phonetic <> '' THEN excluded.phonetic ELSE vocab.phonetic END,
      senses = CASE WHEN excluded.senses <> '[]' THEN excluded.senses ELSE vocab.senses END,
      last_lookup_at = excluded.last_lookup_at,
      lookup_count = vocab.lookup_count + 1
  `).run(word, phonetic || '', JSON.stringify(senses || []), now, now, now);
}

function addImportedToVocab(entries) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO vocab (word, phonetic, senses, status, added_at, last_lookup_at, due_at, lookup_count)
    VALUES (?, ?, ?, 'new', ?, ?, ?, 1)
  `);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const entry of entries) {
      added += Number(stmt.run(entry.word, entry.phonetic || '', JSON.stringify(entry.senses || []), now, now, now).changes) || 0;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return added;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function reviewQueue(limit = 20) {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM vocab
    WHERE status <> 'mastered' AND (due_at IS NULL OR due_at <= ?)
    ORDER BY (due_at IS NULL) DESC, due_at ASC
    LIMIT ?
  `).all(now, limit).map(rowToVocab);
}

function dueCount() {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT COUNT(*) AS n FROM vocab
    WHERE status <> 'mastered' AND (due_at IS NULL OR due_at <= ?)
  `).get(now).n;
}

function gradeReview(word, grade) {
  const row = db.prepare('SELECT * FROM vocab WHERE word = ?').get(word);
  if (!row) return null;

  let interval = Number(row.interval_days) || 0;
  let ease = Number(row.ease) || 2.5;
  const now = Date.now();
  let dueMs;
  let status;

  if (grade === 'forgot') {
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
    dueMs = now + 10 * 60 * 1000;
    status = 'learning';
  } else {
    if (grade === 'hard') {
      interval = interval > 0 ? interval * 1.2 : 1;
      ease = Math.max(1.3, ease - 0.15);
    } else if (grade === 'easy') {
      interval = interval > 0 ? interval * ease * 1.3 : 3;
      ease = Math.min(3.2, ease + 0.15);
    } else {
      interval = interval > 0 ? interval * ease : 2;
    }
    interval = Math.max(1, Math.round(interval * 10) / 10);
    dueMs = now + interval * DAY_MS;
    status = interval >= 21 ? 'mastered' : 'learning';
  }

  db.prepare(`
    UPDATE vocab SET
      interval_days = ?,
      ease = ?,
      due_at = ?,
      last_review_at = ?,
      review_count = review_count + 1,
      status = ?
    WHERE word = ?
  `).run(
    interval,
    ease,
    new Date(dueMs).toISOString(),
    new Date(now).toISOString(),
    status,
    word
  );

  return rowToVocab(db.prepare('SELECT * FROM vocab WHERE word = ?').get(word));
}

function countRows(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function getCachedCard(word) {
  const row = db.prepare('SELECT payload FROM word_cards WHERE word = ?').get(word);
  if (!row) return null;
  return parseJSONSafe(row.payload, null);
}

function saveCachedCard(word, card) {
  db.prepare(`
    INSERT INTO word_cards (word, payload, model, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(word) DO UPDATE SET
      payload = excluded.payload,
      model = excluded.model,
      created_at = excluded.created_at
  `).run(word, JSON.stringify(card), loadConfig().model, new Date().toISOString());
}

/* ---------- 自定义词典 ---------- */
function getLocalDictCard(word) {
  const row = db.prepare('SELECT word, phonetic, senses FROM dict_entries WHERE word = ?').get(word);
  if (!row) return null;
  const senses = parseJSONSafe(row.senses, []);
  if (!Array.isArray(senses) || !senses.length) return null;
  return {
    word: row.word,
    phonetic: row.phonetic || '',
    senses,
    root: '',
    derivatives: [],
    synonyms: [],
    antonyms: [],
    examples: [],
    collocations: []
  };
}

// 通用元素去重键：字符串直接用；对象取 word/term/text/meaning
function cardItemKey(item) {
  if (item == null) return '';
  if (typeof item === 'object') {
    return String(item.word || item.term || item.text || item.meaning || '')
      .trim().toLowerCase();
  }
  return String(item).trim().toLowerCase();
}

// 释义去重键：去掉词性前缀（n./v. 等），使 "n. 苹果" 与 "苹果" 视为同一条
function senseKey(s) {
  let text;
  if (s == null) return '';
  if (typeof s === 'object') text = s.meaning || s.pos || '';
  else text = String(s);
  return String(text).trim().toLowerCase().replace(/^[a-z]{1,5}\.\s*/, '');
}

// local 在前（保留导入释义顺序），cached 在后追加，按键去重
function mergeUnique(localArr, cachedArr, keyFn) {
  const out = [];
  const seen = new Set();
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      const k = keyFn(it);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  };
  push(localArr);
  push(cachedArr);
  return out;
}

function mergeLocalCard(local, cached) {
  if (!cached) return local;
  return {
    ...cached,
    ...local,
    phonetic: local.phonetic || cached.phonetic || '',
    root: local.root || cached.root || '',
    // 导入释义与 AI 新增释义并存去重，不再二选一覆盖
    senses: mergeUnique(local.senses, cached.senses, senseKey),
    derivatives: mergeUnique(local.derivatives, cached.derivatives, cardItemKey),
    synonyms: mergeUnique(local.synonyms, cached.synonyms, cardItemKey),
    antonyms: mergeUnique(local.antonyms, cached.antonyms, cardItemKey),
    examples: mergeUnique(local.examples, cached.examples, cardItemKey),
    collocations: mergeUnique(local.collocations, cached.collocations, cardItemKey)
  };
}

function splitSenseText(text) {
  return String(text || '')
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const withPos = part.match(/^([a-zA-Z]{1,5}\.)(\s*)(.*)$/);
      if (withPos && withPos[3].trim()) {
        return { pos: withPos[1], meaning: withPos[3].trim() };
      }
      return { pos: '', meaning: part };
    });
}

function clipSample(value, max = 160) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (err) {
    text = String(value);
  }
  text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function pickMeaningText(raw) {
  const fields = [
    'meaning', 'zh', 'def', 'definition', 'translation', 'translations',
    'cn', 'explain', 'explains', 'meaning_cn', 'chinese'
  ];
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => (typeof item === 'string'
          ? item
          : (item && (item.meaning || item.zh || item.def || item.translation || item.tran || item.cn)) || ''))
        .filter(Boolean)
        .join('；');
      if (joined.trim()) return joined.trim();
    }
  }
  return '';
}

function normalizeDictEntry(raw, rejected) {
  const reject = (reason, sample) => {
    if (rejected) rejected.push({ reason, sample: clipSample(sample === undefined ? raw : sample) });
    return null;
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject('不是词条对象');
  }
  const word = String(raw.word || raw.term || raw.headword || '').trim();
  if (!word) return reject('缺少单词字段（word / term / headword）');
  if (word.length > 200) return reject('单词过长（超过 200 字符）');
  const phonetic = String(raw.phonetic || raw.pron || raw.ipa || '').trim();

  let senses = [];
  if (Array.isArray(raw.senses)) {
    senses = raw.senses.flatMap((item) => {
      if (!item) return [];
      if (typeof item === 'string') return splitSenseText(item);
      const meaning = String(
        item.meaning || item.zh || item.def || item.definition ||
        item.translation || item.tran || item.cn || ''
      ).trim();
      if (!meaning) return [];
      return [{ pos: String(item.pos || '').trim(), meaning }];
    });
  } else {
    senses = splitSenseText(pickMeaningText(raw));
  }
  if (!senses.length) return reject('缺少释义（meaning / zh / def / translation / senses）');
  return { word, phonetic, senses };
}

function isSingleDictEntry(data) {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data) &&
    (data.word || data.term || data.headword));
}

function collectDictEntries(data, rejected) {
  const entries = [];
  const push = (raw) => {
    const entry = normalizeDictEntry(raw, rejected);
    if (entry) entries.push(entry);
  };

  if (Array.isArray(data)) {
    data.forEach(push);
    return entries;
  }
  if (!data || typeof data !== 'object') {
    rejected.push({ reason: '顶层不是词条数组或对象', sample: clipSample(data) });
    return entries;
  }
  if (isSingleDictEntry(data)) {
    push(data);
    return entries;
  }

  const wrapperKey = ['entries', 'words', 'data', 'list', 'items', 'dict', 'dictionary']
    .find((key) => Array.isArray(data[key]));
  if (wrapperKey) {
    data[wrapperKey].forEach(push);
    return entries;
  }

  Object.entries(data).forEach(([word, value]) => {
    if (typeof value === 'string') {
      push({ word, meaning: value });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      push({ ...value, word: value.word || value.term || word });
    } else {
      rejected.push({ reason: `键「${word}」的值不是字符串或词条对象`, sample: clipSample(value) });
    }
  });
  return entries;
}

function parseCSVLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function parseDictionaryText(text) {
  const body = text.replace(/\uFEFF/g, '').trim();
  if (!body) return { entries: [], skipped: 0, rejected: [], format: 'empty' };

  if (body.startsWith('[') || body.startsWith('{')) {
    const rejected = [];
    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      // 兼容 JSON Lines：每行一个 JSON 对象
      const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      let lineData = null;
      if (lines.length > 1) {
        try {
          lineData = lines.map((line) => JSON.parse(line));
        } catch (lineErr) {
          lineData = null;
        }
      }
      if (!lineData) {
        const wrapped = new Error(`词典 JSON 解析失败：${err.message}`);
        wrapped.parseError = err.message;
        wrapped.lineCount = lines.length;
        throw wrapped;
      }
      data = lineData;
    }
    const entries = collectDictEntries(data, rejected);
    return { entries, skipped: rejected.length, rejected, format: 'json' };
  }

  const entries = [];
  const rejected = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    let cols;
    if (line.includes('\t')) cols = line.split('\t');
    else if (line.includes('|')) cols = line.split('|');
    else if (line.includes(',')) cols = parseCSVLine(line);
    else cols = line.split(/\s{2,}/);

    const word = String(cols[0] || '').trim();
    if (!word) {
      rejected.push({ reason: `第 ${i + 1} 行缺少单词`, sample: clipSample(line) });
      continue;
    }
    if (/^(word|单词|词汇|headword)$/i.test(word)) continue;

    const phonetic = cols.length >= 3 ? String(cols[1] || '').trim() : '';
    const senseText = cols.length >= 3 ? cols.slice(2).join('；') : String(cols[1] || '');
    const senses = splitSenseText(senseText);
    if (!senses.length) {
      rejected.push({ reason: `第 ${i + 1} 行缺少释义`, sample: clipSample(line) });
      continue;
    }
    entries.push({
      word,
      phonetic,
      senses
    });
  }
  return { entries, skipped: rejected.length, rejected, format: 'text' };
}

function summarizeRejected(rejected) {
  const counts = new Map();
  rejected.forEach(({ reason }) => counts.set(reason, (counts.get(reason) || 0) + 1));
  const reasons = [...counts.entries()].map(([reason, n]) => `${reason} × ${n}`);
  const sample = rejected[0] ? `示例「${rejected[0].sample}」` : '';
  return [reasons.slice(0, 3).join('；'), sample].filter(Boolean).join('；');
}

function logDictImport(level, message, detail = {}) {
  const lines = [`[${new Date().toISOString()}] [词典导入] ${message}`];
  Object.entries(detail).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') lines.push(`  ${key}: ${value}`);
  });
  const text = lines.join('\n');
  if (level === 'error') console.error(text);
  else console.log(text);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(IMPORT_LOG_PATH, `${text}\n`, 'utf8');
  } catch (err) {
    console.error(`[词典导入] 写入日志文件失败：${err.message}`);
  }
}

function importDictionary(entries, source) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO dict_entries (word, phonetic, senses, source, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(word) DO UPDATE SET
      phonetic = CASE WHEN excluded.phonetic <> '' THEN excluded.phonetic ELSE dict_entries.phonetic END,
      senses = excluded.senses,
      source = excluded.source,
      created_at = excluded.created_at
  `);
  db.exec('BEGIN');
  try {
    for (const entry of entries) {
      stmt.run(entry.word, entry.phonetic || '', JSON.stringify(entry.senses), source, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return countRows('dict_entries');
}

/* ---------- 文档对照记录 ---------- */
function rowToDocument(row, withSegments = false) {
  if (!row) return null;
  const doc = {
    id: row.id,
    title: row.title,
    direction: row.direction,
    zhMode: row.zh_mode,
    align: row.align,
    segCount: row.seg_count,
    createdAt: row.created_at
  };
  if (withSegments) doc.segments = parseJSONSafe(row.segments, []);
  return doc;
}

function listDocuments(query) {
  const q = String(query || '').trim();
  if (q) {
    return db.prepare(`
      SELECT * FROM documents WHERE title LIKE ? ORDER BY created_at DESC LIMIT 200
    `).all(`%${q}%`).map((row) => rowToDocument(row));
  }
  return db.prepare('SELECT * FROM documents ORDER BY created_at DESC LIMIT 200').all()
    .map((row) => rowToDocument(row));
}

function saveDocument(payload) {
  const title = String(payload.title || '').trim().slice(0, 120) || '未命名文档';
  const direction = payload.direction === 'zh2en' ? 'zh2en' : 'en2zh';
  const zhMode = payload.zhMode === 'keywords' ? 'keywords' : 'full';
  const align = payload.align === 'paragraph' ? 'paragraph' : 'sentence';
  const segments = (Array.isArray(payload.segments) ? payload.segments : [])
    .map((seg) => ({
      src: String(seg && seg.src != null ? seg.src : ''),
      out: String(seg && seg.out != null ? seg.out : ''),
      para: Number(seg && seg.para) || 0
    }))
    .filter((seg) => seg.src || seg.out);
  if (!segments.length) return null;

  const result = db.prepare(`
    INSERT INTO documents (title, direction, zh_mode, align, segments, seg_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, direction, zhMode, align, JSON.stringify(segments), segments.length, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

async function handleDocuments(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[2] ? Number(parts[2]) : 0;

  if (req.method === 'GET' && parts.length === 2) {
    return sendJSON(res, 200, listDocuments(url.searchParams.get('q')));
  }

  if (req.method === 'POST' && parts.length === 2) {
    const raw = (await readBody(req, 20 * 1024 * 1024)).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (err) {
      return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    }
    const docId = saveDocument(body);
    if (!docId) return sendJSON(res, 400, { error: '没有可保存的对照内容' });
    return sendJSON(res, 200, { ok: true, id: docId });
  }

  if (!id) return sendJSON(res, 404, { error: '接口不存在' });

  if (req.method === 'GET' && parts.length === 3) {
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!row) return sendJSON(res, 404, { error: '记录不存在' });
    return sendJSON(res, 200, rowToDocument(row, true));
  }

  if (req.method === 'PATCH' && parts.length === 3) {
    const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (err) {
      return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    }
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return sendJSON(res, 400, { error: 'title 不能为空' });
    const result = db.prepare('UPDATE documents SET title = ? WHERE id = ?').run(title, id);
    if (!result.changes) return sendJSON(res, 404, { error: '记录不存在' });
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'DELETE' && parts.length === 3) {
    const result = db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    if (!result.changes) return sendJSON(res, 404, { error: '记录不存在' });
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

/* ---------- 通用 ---------- */
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function parseJSONSafe(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadConfig() {
  const fromFile = readJSON(CONFIG_PATH, {});
  const envKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
  return {
    ...DEFAULTS,
    ...fromFile,
    apiKey: envKey || fromFile.apiKey || '',
    baseUrl: String(fromFile.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: fromFile.model || DEFAULTS.model,
    port: Number(fromFile.port) || DEFAULTS.port
  };
}

function updateConfig(patch) {
  const current = readJSON(CONFIG_PATH, {});
  const next = { ...DEFAULTS, ...current };
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
    next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
  delete next.port;
  next.port = Number(current.port) || DEFAULTS.port;
  writeJSON(CONFIG_PATH, next);
  return next;
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('上传内容过大（上限 30MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------- AI ---------- */
function wordMessages(word, context) {
  const contextLine = context
    ? `\n当前语境句（优先给出该语境下的释义，并让第一条例句贴近这个语境）：${context}`
    : '';
  return [
    {
      role: 'system',
      content: '你是一名严谨的英汉词典编纂者，读者是以中文为母语的英语学习者。只输出 JSON 对象，不要输出任何解释文字或 Markdown 代码块。'
    },
    {
      role: 'user',
      content:
`请为英文词汇「${word}」生成学习卡片，严格按下面的 JSON 结构输出，所有释义和说明使用简体中文：
{
  "word": "原词",
  "phonetic": "英式音标，含斜杠；短语可留空",
  "senses": [{"pos": "词性缩写，如 n. / v. / adj.", "meaning": "中文释义"}],
  "root": "词根词缀或构词解析，1-2 句中文",
  "derivatives": [{"word": "同根派生词", "pos": "词性", "meaning": "中文释义"}],
  "synonyms": [{"word": "近义词", "meaning": "中文释义"}],
  "antonyms": [{"word": "反义词", "meaning": "中文释义"}],
  "examples": [{"en": "英文例句", "zh": "中文翻译"}],
  "collocations": [{"phrase": "常见搭配", "zh": "中文释义"}]
}
要求：derivatives 覆盖动词、名词、形容词、副词、否定形式等同根词，最多 8 个；examples 2-3 条且难度适中；synonyms 与 antonyms 各 2-4 个；没有内容的字段输出空数组。${contextLine}`
    }
  ];
}

function parseLooseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (err) { /* 继续尝试截取 */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (err) { /* 解析失败 */ }
  }
  throw new Error('AI 返回的内容不是合法 JSON');
}

async function chatCompletion(messages, opts = {}) {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    const err = new Error('尚未配置 API Key，请到「设置」页填写。');
    err.status = 400;
    throw err;
  }

  const payload = {
    model: cfg.model,
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
    max_tokens: Number(opts.maxTokens) || 4096,
    stream: false
  };
  if (opts.json) payload.response_format = { type: 'json_object' };

  let resp;
  try {
    resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000)
    });
  } catch (err) {
    const msg = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? 'AI 接口响应超时'
      : err.message;
    const wrapped = new Error(`请求 AI 接口失败：${msg}`);
    wrapped.status = 502;
    throw wrapped;
  }

  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = null;
  }
  if (!resp.ok) {
    const detail = data && (data.error?.message || data.message);
    const err = new Error(`AI 接口错误（${resp.status}）：${detail || text.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  if (!data) {
    const err = new Error('AI 接口返回内容无法解析');
    err.status = 502;
    throw err;
  }
  const content = data.choices?.[0]?.message?.content || '';
  if (!content) {
    const err = new Error('AI 接口没有返回内容');
    err.status = 502;
    throw err;
  }
  return { data, content };
}

/* ---------- 接口 ---------- */
async function handleAI(req, res) {
  const raw = (await readBody(req, 20 * 1024 * 1024)).toString('utf8');
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (err) {
    return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJSON(res, 400, { error: 'messages 不能为空' });
  }
  try {
    const { data } = await chatCompletion(body.messages, {
      json: Boolean(body.json),
      temperature: body.temperature,
      maxTokens: body.maxTokens
    });
    return sendJSON(res, 200, data);
  } catch (err) {
    return sendJSON(res, err.status || 502, { error: err.message });
  }
}

async function handleDict(req, res) {
  const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (err) {
    return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
  }

  const word = String(body.word || '').trim();
  if (!word) return sendJSON(res, 400, { error: 'word 不能为空' });
  if (word.length > 120) return sendJSON(res, 400, { error: '查询内容过长' });

  const forceAI = Boolean(body.forceAI);
  if (!forceAI) {
    const local = getLocalDictCard(word);
    if (local) {
      saveVocab(local.word, local.phonetic, local.senses);
      const cached = getCachedCard(word);
      return sendJSON(res, 200, { source: 'dict', card: mergeLocalCard(local, cached) });
    }
    const cached = getCachedCard(word);
    if (cached) {
      return sendJSON(res, 200, { source: 'db', card: cached });
    }
  }

  try {
    const { content } = await chatCompletion(wordMessages(word, body.context), {
      json: true,
      temperature: 0.2,
      maxTokens: 4096
    });
    const card = parseLooseJSON(content);
    if (!card || typeof card !== 'object') throw new Error('AI 返回格式异常');
    if (!card.word) card.word = word;
    // 与本地导入词典合并后再保存/返回：保留导入释义，同时持久化 AI 新增内容，
    // 避免 AI 覆盖导入释义，也避免重新点击单词时 AI 新增释义丢失
    const local = getLocalDictCard(word);
    const merged = local ? mergeLocalCard(local, card) : card;
    saveCachedCard(word, merged);
    return sendJSON(res, 200, { source: 'ai', card: merged });
  } catch (err) {
    return sendJSON(res, err.status || 502, { error: err.message });
  }
}

async function handleDictImport(req, res, url) {
  const source = String(url.searchParams.get('name') || 'upload').slice(0, 120);

  let buf;
  try {
    buf = await readBody(req, 30 * 1024 * 1024);
  } catch (err) {
    logDictImport('error', '读取上传内容失败', { 文件: source, 原因: err.message });
    return sendJSON(res, err.message.includes('过大') ? 413 : 400, { error: err.message });
  }

  const text = buf.toString('utf8');
  if (!text.trim()) {
    logDictImport('error', '词典文件内容为空', { 文件: source, 大小: `${buf.length} 字节` });
    return sendJSON(res, 400, { error: '词典文件内容为空' });
  }

  let parsed;
  try {
    parsed = parseDictionaryText(text);
  } catch (err) {
    logDictImport('error', '词典解析失败', {
      文件: source,
      大小: `${buf.length} 字节`,
      原因: err.message,
      内容预览: clipSample(text, 200),
      行数: err.lineCount,
      堆栈: err.stack
    });
    return sendJSON(res, 400, { error: err.message });
  }
  if (!parsed.entries.length) {
    const summary = summarizeRejected(parsed.rejected);
    logDictImport('error', '没有解析到有效词条', {
      文件: source,
      大小: `${buf.length} 字节`,
      格式: parsed.format,
      跳过: parsed.skipped,
      跳过的原因: summary,
      内容预览: clipSample(text, 200)
    });
    const hint = '文本格式每行：单词,音标,释义（多个释义用 ; 分隔）；JSON 支持词条数组、键值对象、JSON Lines 及常见字段名（word / phonetic / translation / meaning / senses）';
    return sendJSON(res, 400, {
      error: parsed.skipped
        ? `没有解析到有效词条：共 ${parsed.skipped} 条被跳过（${summary}）。${hint}`
        : `没有解析到有效词条。${hint}`
    });
  }

  let total;
  try {
    total = importDictionary(parsed.entries, source);
  } catch (err) {
    logDictImport('error', '写入数据库失败', {
      文件: source,
      条目数: parsed.entries.length,
      原因: err.message,
      堆栈: err.stack
    });
    return sendJSON(res, 500, { error: `写入数据库失败：${err.message}` });
  }

  let vocabAdded = 0;
  try {
    vocabAdded = addImportedToVocab(parsed.entries);
  } catch (err) {
    logDictImport('error', '自动加入生词本失败', {
      文件: source,
      条目数: parsed.entries.length,
      原因: err.message,
      堆栈: err.stack
    });
  }

  logDictImport('info', '导入完成', {
    文件: source,
    大小: `${buf.length} 字节`,
    导入: parsed.entries.length,
    跳过: parsed.skipped,
    跳过的原因: summarizeRejected(parsed.rejected),
    词典总数: total,
    加入生词本: vocabAdded
  });
  return sendJSON(res, 200, {
    ok: true,
    imported: parsed.entries.length,
    skipped: parsed.skipped,
    count: total,
    vocabAdded
  });
}

async function handleDocx(req, res) {
  if (!mammoth) {
    return sendJSON(res, 500, { error: '缺少 mammoth 依赖，请在项目目录运行 npm install' });
  }
  const buf = await readBody(req, 40 * 1024 * 1024);
  if (!buf.length) return sendJSON(res, 400, { error: '文件内容为空' });
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = (result.value || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
  return sendJSON(res, 200, { text });
}

async function handleAnkiExport(req, res) {
  const items = listVocab();
  if (!items.length) {
    return sendJSON(res, 400, { error: '生词本为空，无法导出' });
  }

  let AnkiExport;
  try {
    ({ AnkiExport } = require('anki-apkg-export'));
  } catch (err) {
    return sendJSON(res, 500, { error: '缺少 anki-apkg-export 依赖，请在项目目录运行 npm install' });
  }

  let deck = null;
  try {
    deck = await AnkiExport.create('词镜生词');
    for (const item of items) {
      const card = getCachedCard(item.word) || {};
      const senses = (item.senses || [])
        .map((s) => `<li>${s.pos ? `<b>${escapeHtml(s.pos)}</b> ` : ''}${escapeHtml(s.meaning || '')}</li>`)
        .join('');
      const examples = (Array.isArray(card.examples) ? card.examples : [])
        .filter((ex) => ex && ex.en)
        .slice(0, 2)
        .map((ex) => `<p>${escapeHtml(ex.en)}<br><span style="color:#777">${escapeHtml(ex.zh || '')}</span></p>`)
        .join('');
      const front = `<div style="font-size:26px">${escapeHtml(item.word)}</div>${item.phonetic ? `<div style="color:#666">${escapeHtml(item.phonetic)}</div>` : ''}`;
      const back = `${senses ? `<ul>${senses}</ul>` : '（暂无释义）'}${examples ? `<hr>${examples}` : ''}`;
      deck.addCard(front, back, { tags: ['词镜', statusTag(item.status)] });
    }

    const buffer = await deck.save();
    const filename = `wordlens-vocab-${new Date().toISOString().slice(0, 10)}.apkg`;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="wordlens-vocab.apkg"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': buffer.length
    });
    res.end(buffer);
  } catch (err) {
    if (!res.headersSent) sendJSON(res, 500, { error: `导出失败：${err.message}` });
  } finally {
    if (deck) deck.close();
  }
}

function statusTag(status) {
  return { new: '新词', learning: '学习中', mastered: '已掌握' }[status] || '新词';
}

async function handleVocab(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const word = parts[2] ? decodeURIComponent(parts[2]).trim() : '';

  if (req.method === 'GET' && parts.length === 2) {
    return sendJSON(res, 200, listVocab());
  }

  if (req.method === 'POST' && parts.length === 2) {
    const raw = (await readBody(req)).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (err) {
      return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    }

    const inputWord = String(body.word || '').trim();
    if (!inputWord) return sendJSON(res, 400, { error: 'word 不能为空' });

    const card = getCachedCard(inputWord);
    const local = getLocalDictCard(inputWord);
    const phonetic = body.phonetic || (local && local.phonetic) || (card && card.phonetic) || '';
    const senses = Array.isArray(body.senses) && body.senses.length
      ? body.senses
      : (local && local.senses.length ? local.senses : (card && Array.isArray(card.senses) ? card.senses : []));

    saveVocab(inputWord, phonetic, senses);

    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'PATCH' && parts.length === 3 && word) {
    const raw = (await readBody(req)).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (err) {
      return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    }
    const status = body.status;
    if (!['new', 'learning', 'mastered'].includes(status)) {
      return sendJSON(res, 400, { error: 'status 只能是 new / learning / mastered' });
    }
    const result = db.prepare('UPDATE vocab SET status = ? WHERE word = ?').run(status, word);
    if (!result.changes) return sendJSON(res, 404, { error: '生词不存在' });
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'DELETE' && parts.length === 3 && word) {
    const result = db.prepare('DELETE FROM vocab WHERE word = ?').run(word);
    if (!result.changes) return sendJSON(res, 404, { error: '生词不存在' });
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

// 服务端 TTS：代理有道 dictvoice 发音（美式 type=2 / 英式 type=1），带内存缓存
async function handleTTS(req, res, url) {
  const text = String(url.searchParams.get('text') || '').trim();
  if (!text) return sendJSON(res, 400, { error: 'text 不能为空' });
  if (text.length > 300) return sendJSON(res, 400, { error: 'text 过长' });
  const type = url.searchParams.get('type') === '1' ? '1' : '2';
  const cacheKey = type + '|' + text.toLowerCase();

  const cached = ttsCache.get(cacheKey);
  if (cached) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    return res.end(cached);
  }

  try {
    const target = 'https://dict.youdao.com/dictvoice?audio=' +
      encodeURIComponent(text) + '&type=' + type;
    const r = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 WordLens' },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return sendJSON(res, 502, { error: 'TTS 上游返回 ' + r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return sendJSON(res, 502, { error: 'TTS 上游返回空内容' });
    if (ttsCache.size > 500) ttsCache.clear();
    ttsCache.set(cacheKey, buf);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  } catch (err) {
    return sendJSON(res, 502, { error: 'TTS 获取失败：' + err.message });
  }
}

async function handleAPI(req, res, url) {
  const p = url.pathname;

  if (p === '/api/status' && req.method === 'GET') {
    const cfg = loadConfig();
    return sendJSON(res, 200, {
      keyConfigured: Boolean(cfg.apiKey),
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      vocabCount: countRows('vocab'),
      wordCardCount: countRows('word_cards'),
      dictCount: countRows('dict_entries'),
      docCount: countRows('documents'),
      dueCount: dueCount(),
      storage: 'sqlite',
      dbPath: DB_PATH
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (err) {
      return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    }
    const cfg = updateConfig(body);
    return sendJSON(res, 200, {
      keyConfigured: Boolean(cfg.apiKey),
      baseUrl: cfg.baseUrl,
      model: cfg.model
    });
  }

  if (p === '/api/review/queue' && req.method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    return sendJSON(res, 200, {
      items: reviewQueue(limit),
      dueCount: dueCount(),
      total: countRows('vocab')
    });
  }

  if (p.startsWith('/api/review/') && req.method === 'POST') {
    const word = decodeURIComponent(p.slice('/api/review/'.length)).trim();
    if (!word || word === 'queue') return sendJSON(res, 404, { error: '接口不存在' });

    const raw = (await readBody(req)).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (err) {
      return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    }
    if (!['forgot', 'hard', 'good', 'easy'].includes(body.grade)) {
      return sendJSON(res, 400, { error: 'grade 只能是 forgot / hard / good / easy' });
    }
    const updated = gradeReview(word, body.grade);
    if (!updated) return sendJSON(res, 404, { error: '生词不存在' });
    return sendJSON(res, 200, { ok: true, item: updated, dueCount: dueCount() });
  }

  if (p === '/api/export/anki' && req.method === 'GET') return handleAnkiExport(req, res);

  if (p === '/api/dictionary/import' && req.method === 'POST') return handleDictImport(req, res, url);
  if (p === '/api/dictionary' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const total = countRows('dict_entries');
    const where = q ? 'WHERE word LIKE ?' : '';
    const params = q ? [`%${q}%`] : [];
    const matched = q
      ? Number(db.prepare(`SELECT COUNT(*) AS n FROM dict_entries ${where}`).get(...params).n)
      : total;
    const rows = db.prepare(`
      SELECT word, phonetic, senses, source FROM dict_entries ${where}
      ORDER BY word ASC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const items = rows.map((row) => ({
      word: row.word,
      phonetic: row.phonetic || '',
      senses: parseJSONSafe(row.senses, []),
      source: row.source || ''
    }));
    return sendJSON(res, 200, { count: total, matched, limit, offset, items });
  }
  if (p === '/api/dictionary' && req.method === 'DELETE') {
    const result = db.prepare('DELETE FROM dict_entries').run();
    return sendJSON(res, 200, { ok: true, deleted: result.changes });
  }

  if (p === '/api/tts' && req.method === 'GET') return handleTTS(req, res, url);
  if (p === '/api/dict' && req.method === 'POST') return handleDict(req, res);
  if (p === '/api/ai' && req.method === 'POST') return handleAI(req, res);
  if (p === '/api/docx' && req.method === 'POST') return handleDocx(req, res);
  if (p === '/api/vocab') return handleVocab(req, res, url);
  if (p.startsWith('/api/vocab/')) return handleVocab(req, res, url);
  if (p === '/api/documents' || p.startsWith('/api/documents/')) return handleDocuments(req, res, url);

  if (p === '/api/word-cards' && req.method === 'DELETE') {
    const result = db.prepare('DELETE FROM word_cards').run();
    return sendJSON(res, 200, { ok: true, deleted: result.changes });
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = decodeURIComponent(rel);
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('页面不存在');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleAPI(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    if (!res.headersSent) {
      sendJSON(res, 500, { error: err.message || '服务器内部错误' });
    } else {
      res.end();
    }
  }
});

if (!fs.existsSync(CONFIG_PATH)) {
  writeJSON(CONFIG_PATH, { ...DEFAULTS });
  console.log('已生成 config.json，可在网页「设置」页或直接编辑该文件配置 API Key');
}

try {
  openDB();
  console.log(`SQLite 数据库已就绪：${DB_PATH}`);
} catch (err) {
  console.error('数据库初始化失败：', err.message);
  console.error('本项目使用 Node 内置 node:sqlite，请确认 Node.js 版本不低于 22.5。');
  process.exit(1);
}

function listen(port, retried = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && retried < 5) {
      console.warn(`端口 ${port} 被占用，尝试 ${port + 1} …`);
      listen(port + 1, retried + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, DEFAULTS.host, () => {
    console.log(`词镜已启动：http://${DEFAULTS.host}:${port}`);
    if (!loadConfig().apiKey) {
      console.log('尚未配置 API Key，请在浏览器「设置」页填写 DeepSeek Key。');
    }
  });
}

listen(loadConfig().port);
