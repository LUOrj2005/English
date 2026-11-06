'use strict';

/* ---------- 小工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

async function request(path, options = {}) {
  const res = await fetch(path, options);
  const type = res.headers.get('content-type') || '';
  let data;
  if (type.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text().catch(() => '');
  }
  if (!res.ok) {
    const msg = (data && data.error) || (typeof data === 'string' && data) || `请求失败（${res.status}）`;
    throw new Error(msg);
  }
  return data;
}

const el = {
  dictInput: $('#dictInput'),
  dictBtn: $('#dictBtn'),
  dictResult: $('#dictResult'),
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  pasteInput: $('#pasteInput'),
  translateBtn: $('#translateBtn'),
  docStatus: $('#docStatus'),
  docResult: $('#docResult'),
  docFileName: $('#docFileName'),
  vocabCount: $('#vocabCount'),
  vocabList: $('#vocabList'),
  vocabStats: $('#vocabStats'),
  vocabSearch: $('#vocabSearch'),
  vocabFilters: $('#vocabFilters'),
  dueCount: $('#dueCount'),
  reviewStats: $('#reviewStats'),
  reviewModes: $('#reviewModes'),
  flashCard: $('#flashCard'),
  quizCard: $('#quizCard'),
  dictationCard: $('#dictationCard'),
  popover: $('#wordPopover'),
  popBody: $('#popBody'),
  wordDetail: $('#wordDetail'),
  toast: $('#toast'),
  aiState: $('#aiState')
};

const state = {
  vocab: [],
  vocabFilter: 'all',
  vocabQuery: '',
  busy: false,
  popAnchor: null,
  docName: '',
  docQuery: '',
  detailWord: ''
};

const review = {
  mode: 'flash',
  dueCount: 0,
  total: 0,
  queue: [],
  index: 0,
  revealed: false,
  quiz: [],
  qi: 0,
  score: 0,
  answered: false,
  selected: null,
  dictation: [],
  di: 0,
  dscore: 0,
  dchecked: false
};

/* ---------- 提示 ---------- */
let toastTimer = null;
function toast(message, kind = 'info') {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  el.toast.classList.toggle('error', kind === 'error');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
}

/* ---------- AI 调用 ---------- */
async function askAI(messages, { json = true, temperature = 0.2, maxTokens = 4096 } = {}) {
  const data = await request('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, json, temperature, maxTokens })
  });
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (!content) throw new Error('AI 没有返回内容');
  if (!json) return content;
  return parseJSON(content);
}

function parseJSON(text) {
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

/* ---------- 词典：词卡 ---------- */
function loadingCard(word) {
  return `<div class="word-card loading"><span class="spinner"></span><p>正在生成「${esc(word)}」的学习卡片…</p></div>`;
}

function errorCard(message) {
  return `<div class="word-card error-box">
    <h3>查询失败</h3>
    <p>${esc(message)}</p>
    <p class="muted small">请检查「设置」页中的 API Key、接口地址与模型名称。</p>
  </div>`;
}

function chipsHTML(list) {
  return list.map((item) => {
    const meta = [item.pos, item.meaning].filter(Boolean).join(' ');
    return `<button class="chip" data-word="${esc(item.word)}">
      <span class="chip-word">${esc(item.word)}</span>
      ${meta ? `<span class="chip-meta">${esc(meta)}</span>` : ''}
    </button>`;
  }).join('');
}

function renderWordCard(container, data, opts = {}) {
  const word = data.word || opts.word || '';
  const senses = Array.isArray(data.senses) ? data.senses.filter((s) => s && (s.pos || s.meaning)) : [];
  const derivatives = Array.isArray(data.derivatives) ? data.derivatives.filter((d) => d && d.word) : [];
  const synonyms = Array.isArray(data.synonyms) ? data.synonyms.filter((d) => d && d.word) : [];
  const antonyms = Array.isArray(data.antonyms) ? data.antonyms.filter((d) => d && d.word) : [];
  const examples = (Array.isArray(data.examples) ? data.examples : [])
    .map((e) => (typeof e === 'string' ? { en: e, zh: '' } : e))
    .filter((e) => e && e.en);
  const collocations = Array.isArray(data.collocations) ? data.collocations.filter((c) => c && c.phrase) : [];

  const sections = [
    data.root ? `<section class="sec"><h3>词根 · 构词</h3><p class="sec-text">${esc(data.root)}</p></section>` : '',
    derivatives.length ? `<section class="sec"><h3>派生词（同根词）</h3><div class="chips">${chipsHTML(derivatives)}</div></section>` : '',
    synonyms.length ? `<section class="sec"><h3>近义词</h3><div class="chips">${chipsHTML(synonyms)}</div></section>` : '',
    antonyms.length ? `<section class="sec"><h3>反义词</h3><div class="chips">${chipsHTML(antonyms)}</div></section>` : '',
    examples.length ? `<section class="sec"><h3>例句</h3>${examples.map((ex) => `
      <div class="example">
        <div class="ex-head"><p class="ex-en">${esc(ex.en)}</p><button class="icon-btn" data-action="speak" data-word="${esc(ex.en)}" title="朗读例句">🔊</button></div>
        ${ex.zh ? `<p class="ex-zh">${esc(ex.zh)}</p>` : ''}
      </div>`).join('')}</section>` : '',
    collocations.length ? `<section class="sec"><h3>常见搭配</h3><div class="colloc-list">${collocations.map((c) => `
      <div class="colloc"><span class="colloc-phrase">${esc(c.phrase)}</span><span class="colloc-zh">${esc(c.zh || '')}</span></div>`).join('')}</div></section>` : ''
  ].join('');

  container.innerHTML = `
    <article class="word-card ${opts.popover ? 'compact' : ''}">
      <header class="word-head">
        <div class="word-title">
          <h2>${esc(word)}</h2>
          ${data.phonetic ? `<span class="phonetic">${esc(data.phonetic)}</span>` : ''}
        </div>
        <div class="word-tools">
          <button class="icon-btn" data-action="speak" data-word="${esc(word)}" title="朗读">🔊</button>
          <button class="btn primary sm" data-action="save" data-word="${esc(word)}">加入生词本</button>
          ${opts.popover ? '<button class="icon-btn" data-action="close-popover" title="关闭">✕</button>' : ''}
        </div>
      </header>
      ${senses.length ? `<div class="senses">${senses.map((s) => `
        <div class="sense">${s.pos ? `<span class="pos">${esc(s.pos)}</span>` : ''}<span class="meaning">${esc(s.meaning || '')}</span></div>`).join('')}</div>` : ''}
      ${sections}
    </article>`;
}

/* ---------- 词典：查询主流程 ---------- */
const seqByTarget = new WeakMap();

async function lookupWord(rawWord, opts = {}) {
  const word = String(rawWord || '').trim();
  if (!word) return;

  const target = opts.target || el.dictResult;
  const seq = (seqByTarget.get(target) || 0) + 1;
  seqByTarget.set(target, seq);

  const finish = (ok = true) => {
    if (opts.anchor) positionPopover(opts.anchor);
    if (typeof opts.onDone === 'function') opts.onDone(ok);
  };

  target.innerHTML = loadingCard(word);
  if (opts.anchor) positionPopover(opts.anchor);

  try {
    const result = await request('/api/dict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, context: opts.context || '', forceAI: Boolean(opts.forceAI) })
    });
    if (seqByTarget.get(target) !== seq) return;
    const card = result && result.card;
    if (!card || typeof card !== 'object') throw new Error('返回格式异常');
    if (!card.word) card.word = word;
    renderWordCard(target, card, { ...opts, word });
    finish(true);
  } catch (err) {
    if (seqByTarget.get(target) !== seq) return;
    target.innerHTML = errorCard(err.message);
    finish(false);
  }
}

function runDictSearch() {
  const value = el.dictInput.value.trim();
  if (!value) return;
  lookupWord(value);
}

/* ---------- 朗读 ---------- */
let ttsVoice = null;

function pickEnglishVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const isEn = (v) => String(v.lang || '').toLowerCase().startsWith('en');
  return voices.find((v) => v.lang === 'en-US' && v.localService)
    || voices.find((v) => v.lang === 'en-US')
    || voices.find((v) => isEn(v) && v.localService)
    || voices.find(isEn)
    || null;
}

if (window.speechSynthesis) {
  ttsVoice = pickEnglishVoice();
  speechSynthesis.addEventListener('voiceschanged', () => {
    ttsVoice = pickEnglishVoice() || ttsVoice;
  });
}

// 服务端 TTS 兜底音频（浏览器不提供 speechSynthesis 或原生失败时使用）
let ttsAudioEl = null;
function speakViaAudio(text) {
  const src = '/api/tts?type=2&text=' + encodeURIComponent(String(text).trim());
  if (!ttsAudioEl) ttsAudioEl = new Audio();
  try { ttsAudioEl.pause(); } catch (e) { /* ignore */ }
  ttsAudioEl.src = src;
  const p = ttsAudioEl.play();
  if (p && typeof p.catch === 'function') {
    p.catch((e) => toast('朗读播放失败：' + (e && e.message ? e.message : '请检查网络或服务'), 'error'));
  }
}

function speakWord(word) {
  if (!word) return;
  const text = String(word).trim();
  if (!text) return;
  if (ttsAudioEl) { try { ttsAudioEl.pause(); } catch (e) { /* ignore */ } }

  // 浏览器不提供原生 TTS（如 http 非安全上下文）→ 走服务端 TTS
  if (!window.speechSynthesis) {
    speakViaAudio(text);
    return;
  }

  let started = false;
  let failed = false;
  const build = () => {
    const utter = new SpeechSynthesisUtterance(text);
    const zh = /[\u4e00-\u9fa5]/.test(text);
    utter.lang = zh ? 'zh-CN' : 'en-US';
    utter.rate = 0.9;
    if (!zh) {
      const voice = ttsVoice || pickEnglishVoice();
      if (voice && /^en/i.test(String(voice.lang || ''))) {
        try { utter.voice = voice; } catch (e) { /* ignore */ }
      }
    }
    return utter;
  };
  const fallback = () => { if (!failed) { failed = true; speakViaAudio(text); } };
  const wire = (utter) => {
    utter.onstart = () => { started = true; };
    utter.onerror = (e) => {
      const err = e && e.error;
      if (err === 'canceled' || err === 'interrupted') return; // 主动打断不算故障
      fallback(); // 原生失败（如无英语语音包）→ 降级服务端 TTS
    };
  };

  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  const u = build();
  wire(u);
  try { speechSynthesis.resume(); } catch (e) { /* ignore */ }
  speechSynthesis.speak(u);

  // Android cancel→speak 竞态兜底：250ms 未真正开始则重试一次
  setTimeout(() => {
    if (!started && !speechSynthesis.speaking && !failed) {
      const r = build();
      wire(r);
      try { speechSynthesis.resume(); } catch (e) { /* ignore */ }
      speechSynthesis.speak(r);
    }
  }, 250);
  // 原生始终没开始也没报错 → 降级服务端 TTS
  setTimeout(() => {
    if (!started && !speechSynthesis.speaking && !failed) fallback();
  }, 700);
}

/* ---------- 生词本 ---------- */
function statusLabel(status) {
  return { new: '新词', learning: '学习中', mastered: '已掌握' }[status] || '新词';
}

async function saveWord(word) {
  try {
    await request('/api/vocab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word })
    });
    toast(`已加入生词本：${word}`);
    refreshVocab();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshVocab() {
  try {
    state.vocab = await request('/api/vocab');
  } catch (err) {
    return;
  }
  updateVocabStats();
  reviewStatsText();
  if ($('#view-vocab').classList.contains('active')) renderVocab();
  applyVocabHighlight();
}

function currentVocabSet() {
  return new Set(state.vocab.map((it) => String(it.word || '').trim().toLowerCase()).filter(Boolean));
}

function applyVocabHighlight() {
  const set = currentVocabSet();
  $$('#docResult .w').forEach((span) => {
    const token = (span.dataset.w || '').toLowerCase();
    span.classList.toggle('hl', set.has(token));
  });
  updateDocLegend();
}

function updateDocLegend() {
  const legend = $('#docLegend');
  if (!legend) return;
  const words = new Set($$('#docResult .w.hl').map((span) => (span.dataset.w || '').toLowerCase()));
  legend.textContent = words.size ? `文中已收录生词高亮：${words.size} 个` : '文中暂无已收录生词';
}

function updateVocabStats() {
  const total = state.vocab.length;
  const learning = state.vocab.filter((it) => it.status === 'learning').length;
  const mastered = state.vocab.filter((it) => it.status === 'mastered').length;
  el.vocabStats.textContent = `共 ${total} 词 · 学习中 ${learning} · 已掌握 ${mastered}`;
  el.vocabCount.textContent = String(total);
}

function statusOptions(current) {
  return ['new', 'learning', 'mastered'].map((s) =>
    `<option value="${s}" ${current === s ? 'selected' : ''}>${statusLabel(s)}</option>`).join('');
}

function renderVocab() {
  const q = state.vocabQuery.trim().toLowerCase();
  const items = state.vocab.filter((it) => {
    const okStatus = state.vocabFilter === 'all' || it.status === state.vocabFilter;
    const okQuery = !q || it.word.toLowerCase().includes(q);
    return okStatus && okQuery;
  });

  updateVocabStats();

  if (!items.length) {
    el.vocabList.innerHTML = `<div class="empty-line">${state.vocab.length ? '没有符合筛选条件的生词' : '生词本还是空的，去词典查一个词并加入吧'}</div>`;
    return;
  }

  el.vocabList.innerHTML = items.map((item) => {
    const senses = Array.isArray(item.senses) ? item.senses : [];
    const brief = senses.slice(0, 2).map((s) => `${s.pos || ''} ${s.meaning || ''}`.trim()).join('；');
    return `<div class="vocab-row" data-word="${esc(item.word)}">
      <div class="vw-main">
        <div class="vw-word">${esc(item.word)}${item.phonetic ? `<span class="phonetic">${esc(item.phonetic)}</span>` : ''}</div>
        <div class="vw-meta">${esc(brief || '（暂无释义）')}</div>
      </div>
      <select class="status-select" data-word="${esc(item.word)}">${statusOptions(item.status)}</select>
      <button class="btn ghost sm" data-action="lookup">查看</button>
      <button class="btn danger sm" data-action="remove">删除</button>
    </div>`;
  }).join('');
}

function exportCSV() {
  if (!state.vocab.length) {
    toast('生词本为空，无法导出');
    return;
  }
  const rows = [['单词', '音标', '释义', '状态', '加入时间']];
  state.vocab.forEach((it) => {
    rows.push([
      it.word,
      it.phonetic || '',
      (it.senses || []).map((s) => `${s.pos || ''} ${s.meaning || ''}`.trim()).join('; '),
      statusLabel(it.status),
      it.addedAt ? new Date(it.addedAt).toLocaleString('zh-CN') : ''
    ]);
  });
  const csv = '\uFEFF' + rows.map((row) =>
    row.map((cell) => `"${String(cell == null ? '' : cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `生词本-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------- 文档翻译 ---------- */
function cleanText(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function splitParagraphs(text) {
  return text.split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[-=]{3,}$/.test(s));
}

function splitSentences(paragraph) {
  const parts = paragraph.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’）)]*)?/g) || [paragraph];
  return parts.map((s) => s.trim()).filter(Boolean);
}

function chunkSegments(segments, maxChars = 1200, maxItems = 14) {
  const batches = [];
  let current = [];
  let chars = 0;
  segments.forEach((seg, index) => {
    current.push(index);
    chars += seg.src.length + 1;
    if (chars >= maxChars || current.length >= maxItems) {
      batches.push({ start: current[0], items: current.map((i) => segments[i].src) });
      current = [];
      chars = 0;
    }
  });
  if (current.length) {
    batches.push({ start: current[0], items: current.map((i) => segments[i].src) });
  }
  return batches;
}

async function translateBatch(items, direction = 'en2zh', zhMode = 'full') {
  const isZh = direction === 'zh2en';
  const system = isZh
    ? '你是一名专业的中英翻译。只输出 JSON 对象，不要输出其他内容。'
    : '你是一名专业的英汉翻译，译文准确、自然、符合上下文，使用简体中文。只输出 JSON 对象，不要输出其他内容。';

  let instruction;
  if (!isZh) {
    instruction = `请把下面 JSON 数组中的英文逐句翻译成简体中文。共 ${items.length} 句，必须返回 ${items.length} 条译文，顺序一一对应。`;
  } else if (zhMode === 'keywords') {
    instruction = `请处理下面 JSON 数组中的中文句子：每句只把其中的名词、动词、形容词、副词替换成对应的英文单词，其余文字（虚词、助词、连词、标点）保持中文原样；不要整句翻译，不要改变语序，英文单词之间用空格分隔。共 ${items.length} 句，必须返回 ${items.length} 条结果，顺序一一对应。`;
  } else {
    instruction = `请把下面 JSON 数组中的中文逐句翻译成自然、地道的英文。共 ${items.length} 句，必须返回 ${items.length} 条译文，顺序一一对应。`;
  }

  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${instruction}
返回格式：{"translations":["第1条","第2条", ...]}
文本列表：${JSON.stringify(items)}`
    }
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await askAI(messages, { temperature: 0.2, maxTokens: 2048 });
      const list = data && data.translations;
      if (Array.isArray(list) && list.length === items.length) {
        return list.map((t) => String(t == null ? '' : t));
      }
      if (Array.isArray(list) && list.length && attempt === 1) {
        const fixed = new Array(items.length).fill('—');
        list.forEach((t, i) => {
          if (i < fixed.length) fixed[i] = String(t == null ? '—' : t);
        });
        return fixed;
      }
    } catch (err) {
      if (attempt === 1) throw err;
    }
  }
  throw new Error('译文数量与原文不一致');
}

function renderEnglish(text) {
  const wordRe = /[A-Za-z][A-Za-z'’\-]*/g;
  const known = currentVocabSet();
  let out = '';
  let last = 0;
  let match;
  wordRe.lastIndex = 0;
  while ((match = wordRe.exec(text)) !== null) {
    out += esc(text.slice(last, match.index));
    const token = match[0];
    const cls = known.has(token.toLowerCase()) ? 'w hl' : 'w';
    out += `<span class="${cls}" data-w="${esc(token)}">${esc(token)}</span>`;
    last = match.index + match[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

function renderRow(seg, direction = 'en2zh') {
  if (direction === 'zh2en') {
    return `<div class="row">
      <div class="col zh"><span class="zh-text">${esc(seg.src)}</span><button class="icon-btn sent-speak" data-action="speak" data-word="${esc(seg.src)}" title="朗读译文">🔊</button></div>
      <div class="col en"><div class="en-wrap">
        <div class="en-text">${renderEnglish(seg.out || '…')}</div>
        <button class="icon-btn sent-speak" data-action="speak" data-word="${esc(seg.out || '')}" title="朗读整句">🔊</button>
      </div></div>
    </div>`;
  }
  return `<div class="row">
    <div class="col en"><div class="en-wrap">
      <div class="en-text">${renderEnglish(seg.src)}</div>
      <button class="icon-btn sent-speak" data-action="speak" data-word="${esc(seg.src)}" title="朗读整句">🔊</button>
    </div></div>
    <div class="col zh"><span class="zh-text">${esc(seg.out || '…')}</span><button class="icon-btn sent-speak" data-action="speak" data-word="${esc(seg.out || '')}" title="朗读译文">🔊</button></div>
  </div>`;
}

function updateProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  el.docStatus.innerHTML = `<span>正在翻译 ${done}/${total} …</span><span class="bar"><i style="width:${pct}%"></i></span>`;
}

function setBusy(busy) {
  state.busy = busy;
  el.translateBtn.disabled = busy;
  el.translateBtn.textContent = busy ? '翻译中…' : '生成中英对照';
}

async function startTranslate() {
  if (state.busy) return;

  const dirInput = $('input[name="dir"]:checked');
  const direction = dirInput ? dirInput.value : 'en2zh';
  const zhModeInput = $('input[name="zhMode"]:checked');
  const zhMode = zhModeInput ? zhModeInput.value : 'full';

  const text = el.pasteInput.value.trim();
  if (!text) {
    toast(direction === 'zh2en' ? '请先上传文件或粘贴中文文本' : '请先上传文件或粘贴英文文本', 'error');
    return;
  }

  const mode = $('input[name="align"]:checked');
  const alignMode = mode ? mode.value : 'sentence';
  const paragraphs = splitParagraphs(cleanText(text));
  if (!paragraphs.length) {
    toast('没有识别到可翻译的内容', 'error');
    return;
  }

  const segments = [];
  paragraphs.forEach((paragraph, paraIndex) => {
    const parts = alignMode === 'sentence' ? splitSentences(paragraph) : [paragraph];
    parts.forEach((src) => segments.push({ src, out: '', para: paraIndex }));
  });
  if (!segments.length) {
    toast('没有识别到可翻译的内容', 'error');
    return;
  }

  state.busy = true;
  setBusy(true);
  el.docResult.classList.add('hidden');
  updateProgress(0, segments.length);

  const batches = chunkSegments(
    segments,
    alignMode === 'sentence' ? 1200 : 1500,
    alignMode === 'sentence' ? 14 : 6
  );
  let cursor = 0;
  let done = 0;
  const startedAt = Date.now();

  try {
    const workers = Array.from({ length: Math.min(3, batches.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= batches.length) return;
        const batch = batches[index];
        try {
          const translations = await translateBatch(batch.items, direction, zhMode);
          batch.items.forEach((_, offset) => {
            segments[batch.start + offset].out = translations[offset] || '—';
          });
        } catch (err) {
          batch.items.forEach((_, offset) => {
            segments[batch.start + offset].out = `［翻译失败：${err.message}］`;
          });
        }
        done += batch.items.length;
        updateProgress(done, segments.length);
      }
    });
    await Promise.all(workers);
  } finally {
    setBusy(false);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const title = (state.docName || segments[0].src).replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名文档';
  try {
    el.docStatus.innerHTML = '<span>正在保存到数据库…</span>';
    const saved = await request('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, direction, zhMode, align: alignMode, segments })
    });
    toast(`已保存并打开对照阅读页：${title}`);
    location.href = `/reader.html?id=${saved.id}`;
    return;
  } catch (err) {
    toast(`保存失败，改为页面内展示：${err.message}`, 'error');
  }

  const groups = new Map();
  segments.forEach((seg) => {
    if (!groups.has(seg.para)) groups.set(seg.para, []);
    groups.get(seg.para).push(seg);
  });
  const bodyHTML = Array.from(groups.values())
    .map((list) => `<div class="para-block">${list.map((seg) => renderRow(seg, direction)).join('')}</div>`)
    .join('');

  const dirLabel = direction === 'en2zh'
    ? '英译中'
    : (zhMode === 'keywords' ? '中译英 · 实词英译' : '中译英 · 全文英译');
  const hint = direction === 'en2zh' ? '点击英文单词查看解释' : '点击右侧英文单词查看解释';
  const colsHead = direction === 'en2zh'
    ? '<span>ENGLISH</span><span>中文</span>'
    : `<span>中文</span><span>${zhMode === 'keywords' ? '中英混排' : 'ENGLISH'}</span>`;

  el.docResult.classList.remove('hidden');
  el.docResult.innerHTML = `
    <div class="doc-head">
      <h2>中英对照</h2>
      <span class="muted">${dirLabel} · ${alignMode === 'sentence' ? '按句' : '按段'} · ${segments.length} ${alignMode === 'sentence' ? '句' : '段'} · 用时 ${elapsed}s · ${hint}</span>
      <span class="doc-legend" id="docLegend"></span>
    </div>
    <div class="doc-cols-head">${colsHead}</div>
    <div class="doc-body">${bodyHTML}</div>`;
  updateDocLegend();
  el.docStatus.innerHTML = `<span class="ok">翻译完成：${segments.length} ${alignMode === 'sentence' ? '句' : '段'}，用时 ${elapsed}s（未能存入数据库）</span>`;
}

async function handleFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  el.docFileName.textContent = `已载入：${file.name}`;
  state.docName = file.name.replace(/\.[^.]+$/, '');
  try {
    if (ext === 'docx') {
      el.docStatus.textContent = '正在解析 Word 文档…';
      const buffer = await file.arrayBuffer();
      const res = await fetch('/api/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `解析失败（${res.status}）`);
      el.pasteInput.value = data.text || '';
      el.docStatus.textContent = '';
      toast(`已解析 ${file.name}，共 ${el.pasteInput.value.length} 字符`);
    } else if (['txt', 'md', 'markdown', 'text'].includes(ext)) {
      el.pasteInput.value = await file.text();
      el.docStatus.textContent = '';
      toast(`已载入 ${file.name}，共 ${el.pasteInput.value.length} 字符`);
    } else {
      throw new Error('仅支持 .txt / .md / .docx');
    }
  } catch (err) {
    el.docStatus.textContent = '';
    toast(err.message, 'error');
  }
}

/* ---------- 文档历史记录 ---------- */
function docDirLabel(doc) {
  if (doc.direction === 'en2zh') return '英译中';
  return doc.zhMode === 'keywords' ? '中译英 · 实词' : '中译英 · 全文';
}

async function loadDocHistory() {
  const box = $('#docHistory');
  if (!box) return;
  try {
    const q = state.docQuery.trim();
    const list = await request(`/api/documents${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (!list.length) {
      box.innerHTML = `<div class="empty-line">${q ? '没有匹配标题的记录' : '还没有保存过对照记录，生成一次对照后会自动存在这里'}</div>`;
      return;
    }
    box.innerHTML = list.map((doc) => {
      const created = doc.createdAt ? new Date(doc.createdAt).toLocaleString('zh-CN') : '';
      return `<div class="dh-row" data-id="${doc.id}">
        <div class="dh-main">
          <a class="dh-title" href="/reader.html?id=${doc.id}">${esc(doc.title)}</a>
          <div class="dh-meta">${docDirLabel(doc)} · ${doc.align === 'paragraph' ? '按段' : '按句'} · ${doc.segCount} 条 · ${esc(created)}</div>
        </div>
        <button class="btn ghost sm" data-action="doc-open">打开</button>
        <button class="btn danger sm" data-action="doc-remove">删除</button>
      </div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty-line">历史记录加载失败：${esc(err.message)}</div>`;
  }
}

/* ---------- 复习：闪卡 / 测验 / 听写 ---------- */
function reviewStatsText() {
  if (!el.reviewStats) return;
  const total = state.vocab.length || review.total || 0;
  el.reviewStats.textContent = `今日待复习 ${review.dueCount} · 生词 ${total}`;
  if (el.dueCount) el.dueCount.textContent = String(review.dueCount || 0);
}

function reviewEmpty(title, text) {
  return `<div class="review-empty">
    <h3>${esc(title)}</h3>
    <p class="muted">${esc(text)}</p>
    <button class="btn ghost sm" data-action="review-refresh">刷新</button>
  </div>`;
}

function sensesBrief(item) {
  return (Array.isArray(item.senses) ? item.senses : [])
    .slice(0, 3)
    .map((s) => `${s.pos ? s.pos + ' ' : ''}${s.meaning || ''}`.trim())
    .filter(Boolean)
    .join('；');
}

async function loadReviewQueue() {
  try {
    const data = await request('/api/review/queue?limit=100');
    review.queue = Array.isArray(data.items) ? data.items : [];
    review.dueCount = Number(data.dueCount) || 0;
    review.total = Number(data.total) || 0;
    review.index = 0;
    review.revealed = false;
    reviewStatsText();
    if (review.mode === 'flash') renderFlash();
  } catch (err) {
    el.flashCard.innerHTML = reviewEmpty('无法加载复习队列', err.message);
  }
}

function renderFlash() {
  if (!review.queue.length) {
    el.flashCard.innerHTML = state.vocab.length
      ? reviewEmpty('这一轮复习完成了', '到期的词都已复习；选择「忘记」的词会在 10 分钟后重新出现。')
      : reviewEmpty('生词本还是空的', '先去词典或文档里把生词加入生词本，再回来复习。');
    return;
  }

  const item = review.queue[review.index];
  if (!item) {
    el.flashCard.innerHTML = reviewEmpty('这一轮复习完成了', '到期的词都已复习。');
    return;
  }

  const brief = sensesBrief(item);
  el.flashCard.innerHTML = `
    <div class="review-progress"><span>剩余 ${review.queue.length - review.index} 张</span><span>第 ${review.index + 1} / ${review.queue.length} 张</span></div>
    <div class="flash-word">${esc(item.word)}</div>
    <div class="flash-sub">
      ${item.phonetic ? `<span>${esc(item.phonetic)}</span>` : ''}
      <button class="icon-btn" data-action="speak" data-word="${esc(item.word)}" title="朗读">🔊</button>
    </div>
    ${review.revealed
      ? `<div class="flash-answer">${esc(brief || '（暂无释义）')}</div>
        <div class="grade-row">
          <button class="btn ghost" data-action="review-grade" data-grade="forgot">忘记</button>
          <button class="btn ghost" data-action="review-grade" data-grade="hard">模糊</button>
          <button class="btn primary" data-action="review-grade" data-grade="good">记得</button>
          <button class="btn ghost" data-action="review-grade" data-grade="easy">简单</button>
        </div>`
      : `<button class="btn primary review-reveal" data-action="review-reveal">显示答案</button>`}
    <p class="muted small">${item.dueAt ? `原定复习：${esc(new Date(item.dueAt).toLocaleString('zh-CN'))} · ` : ''}已复习 ${Number(item.reviewCount) || 0} 次</p>
  `;
}

async function gradeCurrent(grade) {
  const item = review.queue[review.index];
  if (!item) return;
  try {
    const data = await request(`/api/review/${encodeURIComponent(item.word)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grade })
    });
    const local = state.vocab.find((it) => it.word.toLowerCase() === item.word.toLowerCase());
    if (local && data.item) Object.assign(local, data.item);
    review.dueCount = Number(data.dueCount) || 0;
    review.queue.splice(review.index, 1);
    review.revealed = false;
    updateVocabStats();
    reviewStatsText();
    renderFlash();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function renderQuizStart() {
  const ready = state.vocab.filter((it) => sensesBrief(it));
  review.quiz = [];
  review.qi = 0;
  review.score = 0;
  review.answered = false;
  el.quizCard.innerHTML = `<div class="review-empty">
    <h3>单词测验</h3>
    <p class="muted">${ready.length >= 4
      ? `从 ${state.vocab.length} 个生词中随机抽取最多 10 题，包含英中互选与拼写。`
      : '至少需要 4 个带释义的生词才能开始测验。'}</p>
    <button class="btn primary" data-action="quiz-start" ${ready.length >= 4 ? '' : 'disabled'}>开始测验</button>
  </div>`;
}

function buildQuiz() {
  const pool = state.vocab.filter((it) => sensesBrief(it));
  if (pool.length < 4) {
    renderQuizStart();
    return;
  }
  const picked = shuffle(pool).slice(0, Math.min(10, pool.length));
  review.quiz = picked.map((item) => {
    const brief = sensesBrief(item);
    const others = pool.filter((it) => it.word.toLowerCase() !== item.word.toLowerCase());
    const roll = Math.random();
    if (roll < 0.36) {
      const distractors = shuffle(others).map(sensesBrief).filter((s) => s && s !== brief).slice(0, 3);
      const choices = shuffle([brief, ...distractors]);
      if (choices.length >= 2) {
        return { type: 'en2zh', item, prompt: item.word, phonetic: item.phonetic || '', choices, answer: choices.indexOf(brief) };
      }
    }
    if (roll < 0.72) {
      const distractors = shuffle(others).map((it) => it.word).slice(0, 3);
      const choices = shuffle([item.word, ...distractors]);
      return { type: 'zh2en', item, prompt: brief, choices, answer: choices.indexOf(item.word) };
    }
    return { type: 'spell', item, prompt: brief, answer: item.word };
  });
  review.qi = 0;
  review.score = 0;
  review.answered = false;
  review.selected = null;
  renderQuiz();
}

function renderQuiz() {
  if (!review.quiz.length) {
    renderQuizStart();
    return;
  }
  if (review.qi >= review.quiz.length) {
    el.quizCard.innerHTML = `<div class="review-empty">
      <h3>测验完成</h3>
      <p class="muted">得分 ${review.score} / ${review.quiz.length}</p>
      <div class="grade-row">
        <button class="btn primary" data-action="quiz-restart">再来一轮</button>
        <button class="btn ghost" data-action="review-refresh">刷新队列</button>
      </div>
    </div>`;
    return;
  }

  const q = review.quiz[review.qi];
  let body = '';
  if (q.type === 'en2zh') {
    body = `<div class="flash-word">${esc(q.prompt)}</div>
      ${q.phonetic ? `<div class="flash-sub"><span>${esc(q.phonetic)}</span><button class="icon-btn" data-action="speak" data-word="${esc(q.prompt)}" title="朗读">🔊</button></div>` : ''}
      <p class="muted small">选出正确的中文释义</p>`;
  } else if (q.type === 'zh2en') {
    body = `<div class="quiz-prompt">${esc(q.prompt)}</div><p class="muted small">选出对应的英文单词</p>`;
  } else {
    body = `<div class="quiz-prompt">${esc(q.prompt)}</div><p class="muted small">根据中文释义拼写英文</p>`;
  }

  const options = q.choices
    ? `<div class="quiz-options">${q.choices.map((choice, index) => {
      let cls = 'quiz-option';
      if (review.answered) {
        if (index === q.answer) cls += ' correct';
        if (index === review.selected && index !== q.answer) cls += ' wrong';
      }
      return `<button class="${cls}" data-action="quiz-option" data-index="${index}" ${review.answered ? 'disabled' : ''}>${esc(choice)}</button>`;
    }).join('')}</div>`
    : '';

  const spellRow = q.type === 'spell' && !review.answered
    ? `<div class="spell-row"><input id="spellInput" type="text" autocomplete="off" spellcheck="false" placeholder="输入英文单词"><button class="btn primary" data-action="quiz-submit">提交</button></div>`
    : '';

  const correctAnswer = q.type === 'spell' ? q.answer : (q.choices ? q.choices[q.answer] : '');
  const feedback = review.answered
    ? `<div class="quiz-feedback ${review.selected === q.answer || (q.type === 'spell' && review.selected === q.answer) ? 'ok' : 'bad'}">
        ${(q.type === 'spell' ? review.selected === q.answer : review.selected === q.answer)
          ? '回答正确'
          : `正确答案：${esc(correctAnswer)}`}
      </div>`
    : '';

  el.quizCard.innerHTML = `
    <div class="review-progress"><span>第 ${review.qi + 1} / ${review.quiz.length} 题</span><span>得分 ${review.score}</span></div>
    ${body}${options}${spellRow}${feedback}
    ${review.answered ? '<button class="btn primary quiz-next" data-action="quiz-next">下一题</button>' : ''}
  `;

  if (q.type === 'spell' && !review.answered) {
    const input = $('#spellInput');
    if (input) input.focus();
  }
}

function answerChoice(index) {
  const q = review.quiz[review.qi];
  if (!q || !q.choices || review.answered) return;
  review.answered = true;
  review.selected = index;
  if (index === q.answer) review.score += 1;
  submitReviewGrade(index === q.answer ? 'good' : 'forgot', q.item.word);
  renderQuiz();
}

function submitSpell() {
  const q = review.quiz[review.qi];
  if (!q || q.type !== 'spell' || review.answered) return;
  const input = $('#spellInput');
  const value = input ? input.value.trim() : '';
  if (!value) return;
  const ok = value.toLowerCase() === q.answer.toLowerCase();
  review.answered = true;
  review.selected = ok ? q.answer : value;
  if (ok) review.score += 1;
  submitReviewGrade(ok ? 'good' : 'forgot', q.item.word);
  renderQuiz();
}

async function submitReviewGrade(grade, word) {
  try {
    const data = await request(`/api/review/${encodeURIComponent(word)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grade })
    });
    review.dueCount = Number(data.dueCount) || review.dueCount;
    const local = state.vocab.find((it) => it.word.toLowerCase() === word.toLowerCase());
    if (local && data.item) Object.assign(local, data.item);
    reviewStatsText();
    updateVocabStats();
  } catch (err) { /* 评分失败不影响继续答题 */ }
}

function renderDictationStart() {
  el.dictationCard.innerHTML = `<div class="review-empty">
    <h3>听写</h3>
    <p class="muted">${state.vocab.length
      ? '播放单词发音，凭听力写出英文单词，最多 10 个；可重复播放。'
      : '生词本为空，先加入一些生词。'}</p>
    <button class="btn primary" data-action="dict-start" ${state.vocab.length ? '' : 'disabled'}>开始听写</button>
  </div>`;
}

function buildDictation() {
  if (!state.vocab.length) {
    renderDictationStart();
    return;
  }
  review.dictation = shuffle(state.vocab).slice(0, Math.min(10, state.vocab.length)).map((item) => ({ item }));
  review.di = 0;
  review.dscore = 0;
  review.dchecked = false;
  renderDictation();
}

function renderDictation() {
  if (!review.dictation.length) {
    renderDictationStart();
    return;
  }
  if (review.di >= review.dictation.length) {
    el.dictationCard.innerHTML = `<div class="review-empty">
      <h3>听写完成</h3>
      <p class="muted">得分 ${review.dscore} / ${review.dictation.length}</p>
      <div class="grade-row">
        <button class="btn primary" data-action="dict-restart">再来一轮</button>
        <button class="btn ghost" data-action="review-refresh">刷新队列</button>
      </div>
    </div>`;
    return;
  }

  const current = review.dictation[review.di];
  const item = current.item;
  el.dictationCard.innerHTML = `
    <div class="review-progress"><span>第 ${review.di + 1} / ${review.dictation.length} 个</span><span>得分 ${review.dscore}</span></div>
    <div class="dictation-play">
      <button class="icon-btn big" data-action="speak" data-word="${esc(item.word)}" title="播放发音">🔊</button>
      <span class="muted small">点击播放，可重复听</span>
    </div>
    ${review.dchecked
      ? `<div class="flash-word">${esc(item.word)}</div>
        <div class="flash-sub">${item.phonetic ? `<span>${esc(item.phonetic)}</span>` : ''}</div>
        <div class="flash-answer">${esc(sensesBrief(item) || '（暂无释义）')}</div>
        <button class="btn primary quiz-next" data-action="dict-next">下一个</button>`
      : `<div class="spell-row"><input id="dictationInput" type="text" autocomplete="off" spellcheck="false" placeholder="听到什么就写什么"><button class="btn primary" data-action="dict-submit">提交</button></div>`}
  `;

  if (!review.dchecked) {
    const input = $('#dictationInput');
    if (input) input.focus();
    setTimeout(() => speakWord(item.word), 400);
  }
}

function submitDictation() {
  if (review.dchecked) return;
  const current = review.dictation[review.di];
  if (!current) return;
  const input = $('#dictationInput');
  const value = input ? input.value.trim() : '';
  if (!value) return;
  const ok = value.toLowerCase() === current.item.word.toLowerCase();
  review.dchecked = true;
  if (ok) review.dscore += 1;
  submitReviewGrade(ok ? 'good' : 'forgot', current.item.word);
  renderDictation();
}

function setReviewMode(mode) {
  review.mode = mode;
  $$('#reviewModes button').forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  $('#flashPane').classList.toggle('hidden', mode !== 'flash');
  $('#quizPane').classList.toggle('hidden', mode !== 'quiz');
  $('#dictationPane').classList.toggle('hidden', mode !== 'dictation');
  if (mode === 'flash') loadReviewQueue();
  if (mode === 'quiz') renderQuizStart();
  if (mode === 'dictation') renderDictationStart();
}

/* ---------- Anki 导出 ---------- */
async function exportAnki() {
  try {
    const res = await fetch('/api/export/anki');
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data && data.error) || `导出失败（${res.status}）`);
    }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `词镜生词-${new Date().toISOString().slice(0, 10)}.apkg`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Anki 牌组已导出，可在 Anki 中「导入」');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- 点词弹层 ---------- */
function positionPopover(anchor) {
  if (!anchor || el.popover.classList.contains('hidden')) return;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(400, window.innerWidth - 24);
  el.popover.style.width = `${width}px`;
  const height = el.popover.offsetHeight;
  let left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 12) {
    const above = rect.top - height - 8;
    top = above >= 12 ? above : Math.max(12, window.innerHeight - height - 12);
  }
  el.popover.style.left = `${left}px`;
  el.popover.style.top = `${top}px`;
}

function openPopover(anchor, word, context) {
  state.popAnchor = anchor;
  el.popover.classList.remove('hidden');
  el.popover.scrollTop = 0;
  lookupWord(word, { target: el.popBody, context, popover: true, anchor });
}

function hidePopover() {
  el.popover.classList.add('hidden');
  state.popAnchor = null;
}

/* ---------- 视图切换 ---------- */
function switchView(name) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  if (name !== 'doc') hidePopover();
  if (name === 'doc') loadDocHistory();
  if (name === 'vocab') refreshVocab();
  if (name === 'review') {
    refreshVocab();
    loadReviewQueue();
  }
  if (name === 'settings') loadStatus();
}

function openWordDetail(word) {
  state.detailWord = word;
  const meta = $('#wordDetailMeta');
  if (meta) meta.textContent = `生词本 · ${word}`;
  const aiStatus = $('#wordAiStatus');
  if (aiStatus) aiStatus.textContent = '';
  switchView('word');
  const navDisabled = state.vocab.length < 2;
  const prevBtn = $('#wordPrevBtn');
  const nextBtn = $('#wordNextBtn');
  if (prevBtn) prevBtn.disabled = navDisabled;
  if (nextBtn) nextBtn.disabled = navDisabled;
  renderOtherVocab(word);
  lookupWord(word, { target: el.wordDetail });
}

function navWordDetail(offset) {
  if (state.vocab.length < 2 || !state.detailWord) return;
  const idx = state.vocab.findIndex((it) => it.word.toLowerCase() === state.detailWord.toLowerCase());
  if (idx < 0) return;
  const next = state.vocab[(idx + offset + state.vocab.length) % state.vocab.length];
  openWordDetail(next.word);
}

function renderOtherVocab(currentWord) {
  const box = $('#wordOthers');
  if (!box) return;
  const current = String(currentWord || '').toLowerCase();
  const others = state.vocab.filter((item) => item.word.toLowerCase() !== current);
  if (!others.length) {
    box.innerHTML = '<div class="empty-line">生词本里还没有其他单词</div>';
    return;
  }
  const shown = others.slice(0, 40);
  box.innerHTML = `
    <div class="sec">
      <h3>其他生词（${others.length}）</h3>
      <div class="chips">${shown.map((item) => `
        <button type="button" class="chip" data-word="${esc(item.word)}">
          <span class="chip-word">${esc(item.word)}</span>
          ${item.phonetic ? `<span class="chip-meta">${esc(item.phonetic)}</span>` : ''}
        </button>`).join('')}</div>
      ${others.length > shown.length ? '<p class="muted small">仅显示前 40 个，可回生词本搜索</p>' : ''}
    </div>`;
}

/* ---------- 设置 ---------- */
async function loadStatus() {
  try {
    const status = await request('/api/status');
    el.aiState.innerHTML = `<i class="${status.keyConfigured ? 'ok' : 'bad'}"></i><span>${status.keyConfigured ? 'AI 已就绪' : '未配置 Key'}</span>`;
    el.aiState.title = status.keyConfigured
      ? `AI 已就绪 · ${status.model || ''}`.trim()
      : '未配置 API Key，请到设置页填写';
    el.vocabCount.textContent = String(status.vocabCount || 0);
    review.dueCount = Number(status.dueCount) || 0;
    reviewStatsText();
    const baseUrlInput = $('#baseUrlInput');
    const modelInput = $('#modelInput');
    if (baseUrlInput.value !== status.baseUrl) baseUrlInput.value = status.baseUrl;
    if (modelInput.value !== status.model) modelInput.value = status.model;
    const dictStatus = $('#dictStatus');
    if (dictStatus) {
      dictStatus.textContent = status.dictCount ? `已导入 ${status.dictCount} 条` : '尚未导入';
    }
    loadDictPage(true);
  } catch (err) {
    el.aiState.innerHTML = '<i class="bad"></i><span>服务未连接</span>';
    el.aiState.title = '无法连接到本地服务，请确认 server.js 正在运行';
  }
}

/* ---------- 事件绑定 ---------- */
el.dictBtn.addEventListener('click', runDictSearch);
el.dictInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runDictSearch();
  }
});

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

el.reviewModes.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-mode]');
  if (!btn) return;
  setReviewMode(btn.dataset.mode);
});

document.addEventListener('click', (event) => {
  const speakBtn = event.target.closest('[data-action="speak"]');
  if (speakBtn) {
    speakWord(speakBtn.dataset.word || '');
    return;
  }

  const saveBtn = event.target.closest('[data-action="save"]');
  if (saveBtn) {
    saveWord(saveBtn.dataset.word || '');
    return;
  }

  const reviewAction = event.target.closest('[data-action]');
  if (reviewAction) {
    const name = reviewAction.dataset.action;
    if (name === 'review-reveal') {
      review.revealed = true;
      renderFlash();
      return;
    }
    if (name === 'review-grade') {
      gradeCurrent(reviewAction.dataset.grade);
      return;
    }
    if (name === 'review-refresh') {
      loadReviewQueue();
      return;
    }
    if (name === 'quiz-start') {
      buildQuiz();
      return;
    }
    if (name === 'quiz-option') {
      answerChoice(Number(reviewAction.dataset.index));
      return;
    }
    if (name === 'quiz-submit') {
      submitSpell();
      return;
    }
    if (name === 'quiz-next') {
      review.qi += 1;
      review.answered = false;
      review.selected = null;
      renderQuiz();
      return;
    }
    if (name === 'quiz-restart') {
      buildQuiz();
      return;
    }
    if (name === 'dict-start') {
      buildDictation();
      return;
    }
    if (name === 'dict-submit') {
      submitDictation();
      return;
    }
    if (name === 'dict-next') {
      review.di += 1;
      review.dchecked = false;
      renderDictation();
      return;
    }
    if (name === 'dict-restart') {
      buildDictation();
      return;
    }
  }

  if (event.target.closest('[data-action="close-popover"]')) {
    hidePopover();
    return;
  }

  const chip = event.target.closest('.chip[data-word]');
  if (chip) {
    const word = chip.dataset.word;
    if (chip.closest('#wordPopover')) {
      lookupWord(word, {
        target: el.popBody,
        popover: true,
        anchor: state.popAnchor
      });
    } else if ($('#view-word').classList.contains('active')) {
      state.detailWord = word;
      $('#wordDetailMeta').textContent = `生词本 · ${word}`;
      $('#wordAiStatus').textContent = '';
      renderOtherVocab(word);
      lookupWord(word, { target: el.wordDetail });
    } else {
      el.dictInput.value = word;
      lookupWord(word);
    }
    return;
  }

  const wordSpan = event.target.closest('.w');
  if (wordSpan) {
    const row = wordSpan.closest('.row');
    const context = row ? (row.querySelector('.col.en') || {}).innerText || '' : '';
    openPopover(wordSpan, wordSpan.dataset.w, context);
  }
});

document.addEventListener('mousedown', (event) => {
  if (el.popover.classList.contains('hidden')) return;
  if (event.target.closest('#wordPopover') || event.target.closest('.w')) return;
  hidePopover();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target && event.target.id === 'spellInput') {
    event.preventDefault();
    submitSpell();
    return;
  }
  if (event.key === 'Enter' && event.target && event.target.id === 'dictInput') {
    event.preventDefault();
    submitDictation();
    return;
  }
  if (event.key === 'Escape') {
    hidePopover();
    return;
  }
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
      event.preventDefault();
      switchView('dict');
      el.dictInput.focus();
      el.dictInput.select();
    }
  }
});

window.addEventListener('scroll', () => {
  if (!el.popover.classList.contains('hidden')) positionPopover(state.popAnchor);
}, true);

window.addEventListener('resize', () => {
  if (!el.popover.classList.contains('hidden')) positionPopover(state.popAnchor);
});

/* 文件上传 */
el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    el.fileInput.click();
  }
});
['dragover', 'dragenter'].forEach((name) => {
  el.dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('drag');
  });
});
['dragleave', 'drop'].forEach((name) => {
  el.dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    el.dropzone.classList.remove('drag');
  });
});
el.dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) handleFile(file);
});
el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (file) handleFile(file);
  el.fileInput.value = '';
});

el.translateBtn.addEventListener('click', startTranslate);

/* 文档历史记录 */
const docSearchInput = $('#docSearch');
if (docSearchInput) {
  let docSearchTimer = null;
  docSearchInput.addEventListener('input', () => {
    state.docQuery = docSearchInput.value;
    clearTimeout(docSearchTimer);
    docSearchTimer = setTimeout(loadDocHistory, 250);
  });
}

const docHistoryBox = $('#docHistory');
if (docHistoryBox) {
  docHistoryBox.addEventListener('click', async (event) => {
    const row = event.target.closest('.dh-row');
    if (!row) return;
    const id = row.dataset.id;

    if (event.target.closest('[data-action="doc-open"]')) {
      location.href = `/reader.html?id=${id}`;
      return;
    }

    if (event.target.closest('[data-action="doc-remove"]')) {
      const title = (row.querySelector('.dh-title') || {}).textContent || '';
      if (!window.confirm(`删除记录「${title}」？`)) return;
      try {
        await request(`/api/documents/${id}`, { method: 'DELETE' });
        toast('记录已删除');
        loadDocHistory();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });
}

$$('input[name="dir"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const dir = $('input[name="dir"]:checked').value;
    $('#zhModeGroup').classList.toggle('hidden', dir !== 'zh2en');
    el.pasteInput.placeholder = dir === 'zh2en'
      ? '在此粘贴中文段落…'
      : 'Paste an English article here…';
  });
});

/* 自定义词典 */
const dictFileInput = $('#dictFileInput');
$('#importDictBtn').addEventListener('click', () => dictFileInput.click());
dictFileInput.addEventListener('change', async () => {
  const file = dictFileInput.files && dictFileInput.files[0];
  dictFileInput.value = '';
  if (!file) return;
  const dictStatus = $('#dictStatus');
  dictStatus.textContent = `正在导入 ${file.name} …`;
  try {
    const text = await file.text();
    const result = await request(`/api/dictionary/import?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text
    });
    dictStatus.textContent = `已导入 ${result.imported} 条${result.skipped ? `，跳过 ${result.skipped} 行` : ''} · 已加入生词本 ${result.vocabAdded || 0} 条 · 词典共 ${result.count} 条`;
    toast(`已导入 ${result.imported} 条词条`);
    loadDictPage(true);
    refreshVocab();
  } catch (err) {
    dictStatus.textContent = `导入失败：${err.message}`;
    toast(err.message, 'error');
  }
});

$('#clearDictBtn').addEventListener('click', async () => {
  if (!window.confirm('清空自定义词典？生词本与 AI 词卡缓存不受影响。')) return;
  try {
    const result = await request('/api/dictionary', { method: 'DELETE' });
    $('#dictStatus').textContent = '已清空自定义词典';
    toast(`已删除 ${result.deleted || 0} 条词条`);
    loadDictPage(true);
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* 词典内容浏览 */
const dictBrowse = { q: '', offset: 0, limit: 50, total: 0, items: [], loading: false };

function renderDictList() {
  const list = $('#dictList');
  const status = $('#dictBrowseStatus');
  const moreBtn = $('#dictMoreBtn');
  if (!dictBrowse.total) {
    list.innerHTML = '<div class="empty-line">词典还是空的，先上传词典文件</div>';
    status.textContent = '共 0 条';
    moreBtn.classList.add('hidden');
    return;
  }
  if (!dictBrowse.items.length) {
    list.innerHTML = '<div class="empty-line">没有匹配的词条</div>';
    status.textContent = `匹配 0 条 / 共 ${dictBrowse.total} 条`;
    moreBtn.classList.add('hidden');
    return;
  }
  list.innerHTML = dictBrowse.items.map((item) => {
    const senses = Array.isArray(item.senses) ? item.senses : [];
    const brief = senses.map((s) => `${s.pos ? `<span class="pos">${esc(s.pos)}</span>` : ''}${esc(s.meaning || '')}`).join('；');
    return `<div class="dict-row">
      <div class="dict-word">${esc(item.word)}${item.phonetic ? `<span class="phonetic">${esc(item.phonetic)}</span>` : ''}</div>
      <div class="dict-senses">${brief || '（暂无释义）'}</div>
    </div>`;
  }).join('');
  status.textContent = `${dictBrowse.q ? `匹配 ${dictBrowse.total} 条` : `共 ${dictBrowse.total} 条`} · 已显示 ${dictBrowse.items.length} 条`;
  moreBtn.classList.toggle('hidden', dictBrowse.items.length >= dictBrowse.total);
}

async function loadDictPage(reset = true) {
  if (dictBrowse.loading) return;
  dictBrowse.loading = true;
  if (reset) {
    dictBrowse.offset = 0;
    dictBrowse.items = [];
  }
  try {
    const params = new URLSearchParams({
      q: dictBrowse.q,
      limit: String(dictBrowse.limit),
      offset: String(dictBrowse.offset)
    });
    const data = await request(`/api/dictionary?${params.toString()}`);
    dictBrowse.total = Number(data.matched || 0);
    dictBrowse.items = dictBrowse.items.concat(data.items || []);
    dictBrowse.offset = dictBrowse.items.length;
    renderDictList();
  } catch (err) {
    $('#dictBrowseStatus').textContent = `读取词典失败：${err.message}`;
  } finally {
    dictBrowse.loading = false;
  }
}

let dictSearchTimer = 0;
$('#dictSearchInput').addEventListener('input', (event) => {
  clearTimeout(dictSearchTimer);
  const value = event.target.value;
  dictSearchTimer = setTimeout(() => {
    dictBrowse.q = value.trim();
    loadDictPage(true);
  }, 300);
});
$('#dictMoreBtn').addEventListener('click', () => loadDictPage(false));

/* 生词本交互 */
el.vocabList.addEventListener('click', async (event) => {
  const row = event.target.closest('.vocab-row');
  if (!row) return;
  const word = row.dataset.word;

  if (event.target.closest('[data-action="lookup"]')) {
    openWordDetail(word);
    return;
  }

  if (event.target.closest('[data-action="remove"]')) {
    if (!window.confirm(`从生词本删除「${word}」？`)) return;
    try {
      await request(`/api/vocab/${encodeURIComponent(word)}`, { method: 'DELETE' });
      toast(`已删除：${word}`);
      refreshVocab();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

el.vocabList.addEventListener('change', async (event) => {
  const select = event.target.closest('.status-select');
  if (!select) return;
  const word = select.dataset.word;
  try {
    await request(`/api/vocab/${encodeURIComponent(word)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: select.value })
    });
    const item = state.vocab.find((it) => it.word.toLowerCase() === word.toLowerCase());
    if (item) item.status = select.value;
    updateVocabStats();
    toast('状态已更新');
  } catch (err) {
    toast(err.message, 'error');
  }
});

el.vocabSearch.addEventListener('input', () => {
  state.vocabQuery = el.vocabSearch.value;
  renderVocab();
});

el.vocabFilters.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-filter]');
  if (!btn) return;
  state.vocabFilter = btn.dataset.filter;
  $$('#vocabFilters button').forEach((b) => b.classList.toggle('active', b === btn));
  renderVocab();
});

$('#exportBtn').addEventListener('click', exportCSV);
$('#wordBackBtn').addEventListener('click', () => switchView('vocab'));
$('#wordPrevBtn').addEventListener('click', () => navWordDetail(-1));
$('#wordNextBtn').addEventListener('click', () => navWordDetail(1));
document.addEventListener('keydown', (event) => {
  const target = event.target;
  const tag = target && target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable);

  if (event.key === '/' && !typing) {
    event.preventDefault();
    switchView('dict');
    el.dictInput.focus();
    el.dictInput.select();
    return;
  }
  if (tag === 'INPUT' && target.id === 'dictationInput' && event.key === 'Enter') {
    event.preventDefault();
    submitDictation();
    return;
  }
  if (typing) return;

  if (event.key === 'Escape') {
    if ($('#view-word').classList.contains('active')) {
      switchView('vocab');
      return;
    }
    hidePopover();
    return;
  }

  if ($('#view-word').classList.contains('active')) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      navWordDetail(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      navWordDetail(1);
      return;
    }
    if (event.key === ' ' && !(target && target.closest('button, a'))) {
      event.preventDefault();
      speakWord(state.detailWord);
      return;
    }
  }

  if ($('#view-review').classList.contains('active') && !$('#flashPane').classList.contains('hidden')) {
    if (!review.revealed && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      review.revealed = true;
      renderFlash();
      return;
    }
    const grades = { '1': 'forgot', '2': 'hard', '3': 'good', '4': 'easy' };
    if (review.revealed && grades[event.key]) {
      event.preventDefault();
      gradeCurrent(grades[event.key]);
    }
  }
});
$('#wordAiBtn').addEventListener('click', () => {
  const word = state.detailWord;
  if (!word) return;
  $('#wordAiStatus').textContent = '正在用 AI 分析词根与衍生词…';
  lookupWord(word, {
    target: el.wordDetail,
    forceAI: true,
    onDone: (ok) => { $('#wordAiStatus').textContent = ok ? 'AI 结果已更新' : 'AI 查询失败，请检查 Key 或网络'; }
  });
});
$('#exportAnkiBtn').addEventListener('click', exportAnki);

/* 设置表单 */
$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const apiKey = $('#apiKeyInput').value.trim();
  const baseUrl = $('#baseUrlInput').value.trim();
  const model = $('#modelInput').value.trim();
  try {
    const status = await request('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, baseUrl, model })
    });
    $('#apiKeyInput').value = '';
    $('#settingsStatus').textContent = status.keyConfigured ? '已保存，AI 可用' : '已保存，但还没有配置 Key';
    toast('设置已保存');
    loadStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#clearCacheBtn').addEventListener('click', async () => {
  try {
    const result = await request('/api/word-cards', { method: 'DELETE' });
    toast(`已清除 ${result.deleted || 0} 张词卡缓存`);
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#testBtn').addEventListener('click', async () => {
  $('#settingsStatus').textContent = '正在测试…';
  try {
    const data = await request('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        json: false,
        temperature: 0,
        maxTokens: 30,
        messages: [{ role: 'user', content: '请只回复四个字：连接成功' }]
      })
    });
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    $('#settingsStatus').textContent = `连接正常：${String(reply || '').trim().slice(0, 30)}`;
  } catch (err) {
    $('#settingsStatus').textContent = err.message;
  }
});

/* ---------- 初始化 ---------- */
if (location.hash === '#doc') switchView('doc');
loadStatus();
refreshVocab();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 离线功能不可用 */ });
  });
}
