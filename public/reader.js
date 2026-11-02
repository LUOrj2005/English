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
  title: $('#readerTitle'),
  sub: $('#readerSub'),
  meta: $('#readerMeta'),
  body: $('#readerBody'),
  popover: $('#wordPopover'),
  popBody: $('#popBody'),
  toast: $('#toast')
};

const state = {
  doc: null,
  vocabSet: new Set(),
  popAnchor: null,
  lookupSeq: 0
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

function speakWord(word) {
  if (!word || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(word);
  utter.lang = 'en-US';
  utter.rate = 0.9;
  const voice = ttsVoice || pickEnglishVoice();
  if (voice) utter.voice = voice;
  speechSynthesis.speak(utter);
}

/* ---------- 正文渲染：中文在上，英文在下 ---------- */
function renderEnglish(text) {
  const wordRe = /[A-Za-z][A-Za-z'’\-]*/g;
  let out = '';
  let last = 0;
  let match;
  wordRe.lastIndex = 0;
  while ((match = wordRe.exec(text)) !== null) {
    out += esc(text.slice(last, match.index));
    const token = match[0];
    const cls = state.vocabSet.has(token.toLowerCase()) ? 'w hl' : 'w';
    out += `<span class="${cls}" data-w="${esc(token)}">${esc(token)}</span>`;
    last = match.index + match[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

function renderRow(seg, direction) {
  const zh = direction === 'zh2en' ? seg.src : seg.out;
  const en = direction === 'zh2en' ? seg.out : seg.src;
  return `<div class="zr-row">
    <div class="zr-zh">${esc(zh || '…')}</div>
    <div class="zr-en-wrap">
      <div class="zr-en">${renderEnglish(en || '…')}</div>
      <button class="icon-btn sent-speak" data-action="speak" data-word="${esc(en || '')}" title="朗读整句">🔊</button>
    </div>
  </div>`;
}

function dirLabel(doc) {
  if (doc.direction === 'en2zh') return '英译中';
  return doc.zhMode === 'keywords' ? '中译英 · 实词英译' : '中译英 · 全文英译';
}

function renderDoc() {
  const doc = state.doc;
  if (!doc) return;
  document.title = `${doc.title} · 对照阅读`;
  el.title.textContent = doc.title;
  const created = doc.createdAt ? new Date(doc.createdAt).toLocaleString('zh-CN') : '';
  el.sub.textContent = `${dirLabel(doc)} · ${doc.align === 'paragraph' ? '按段' : '按句'} · ${doc.segCount} 条 · 保存于 ${created}`;
  el.meta.textContent = `${doc.segCount} 条对照`;

  const groups = new Map();
  (doc.segments || []).forEach((seg) => {
    const key = Number(seg.para) || 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(seg);
  });

  el.body.innerHTML = Array.from(groups.values())
    .map((list) => `<div class="zr-para">${list.map((seg) => renderRow(seg, doc.direction)).join('')}</div>`)
    .join('') || '<div class="empty-line">这条记录没有内容</div>';
}

function applyVocabHighlight() {
  $$('#readerBody .w').forEach((span) => {
    span.classList.toggle('hl', state.vocabSet.has((span.dataset.w || '').toLowerCase()));
  });
}

/* ---------- 词卡弹层 ---------- */
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
  const examples = Array.isArray(data.examples) ? data.examples.filter((e) => e && e.en) : [];
  const collocations = Array.isArray(data.collocations) ? data.collocations.filter((c) => c && c.phrase) : [];

  const sections = [
    data.root ? `<section class="sec"><h3>词根 · 构词</h3><p class="sec-text">${esc(data.root)}</p></section>` : '',
    derivatives.length ? `<section class="sec"><h3>派生词（同根词）</h3><div class="chips">${chipsHTML(derivatives)}</div></section>` : '',
    synonyms.length ? `<section class="sec"><h3>近义词</h3><div class="chips">${chipsHTML(synonyms)}</div></section>` : '',
    antonyms.length ? `<section class="sec"><h3>反义词</h3><div class="chips">${chipsHTML(antonyms)}</div></section>` : '',
    examples.length ? `<section class="sec"><h3>例句</h3>${examples.map((ex) => `
      <div class="example">
        <p class="ex-en">${esc(ex.en)}</p>
        ${ex.zh ? `<p class="ex-zh">${esc(ex.zh)}</p>` : ''}
      </div>`).join('')}</section>` : '',
    collocations.length ? `<section class="sec"><h3>常见搭配</h3><div class="colloc-list">${collocations.map((c) => `
      <div class="colloc"><span class="colloc-phrase">${esc(c.phrase)}</span><span class="colloc-zh">${esc(c.zh || '')}</span></div>`).join('')}</div></section>` : ''
  ].join('');

  container.innerHTML = `
    <article class="word-card compact">
      <header class="word-head">
        <div class="word-title">
          <h2>${esc(word)}</h2>
          ${data.phonetic ? `<span class="phonetic">${esc(data.phonetic)}</span>` : ''}
        </div>
        <div class="word-tools">
          <button class="icon-btn" data-action="speak" data-word="${esc(word)}" title="朗读">🔊</button>
          <button class="btn primary sm" data-action="save" data-word="${esc(word)}">加入生词本</button>
          <button class="icon-btn" data-action="close-popover" title="关闭">✕</button>
        </div>
      </header>
      ${senses.length ? `<div class="senses">${senses.map((s) => `
        <div class="sense">${s.pos ? `<span class="pos">${esc(s.pos)}</span>` : ''}<span class="meaning">${esc(s.meaning || '')}</span></div>`).join('')}</div>` : ''}
      ${sections}
    </article>`;
}

function positionPopover(anchor) {
  if (!anchor || el.popover.classList.contains('hidden')) return;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(400, window.innerWidth - 24);
  el.popover.style.width = `${width}px`;
  const height = el.popover.offsetHeight;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 12) {
    const above = rect.top - height - 8;
    top = above >= 12 ? above : Math.max(12, window.innerHeight - height - 12);
  }
  el.popover.style.left = `${left}px`;
  el.popover.style.top = `${top}px`;
}

async function lookupWord(word, anchor, context) {
  const seq = ++state.lookupSeq;
  el.popBody.innerHTML = `<div class="word-card loading"><span class="spinner"></span><p>正在生成「${esc(word)}」的学习卡片…</p></div>`;
  positionPopover(anchor);
  try {
    const result = await request('/api/dict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, context: context || '' })
    });
    if (state.lookupSeq !== seq) return;
    const card = result && result.card;
    if (!card || typeof card !== 'object') throw new Error('返回格式异常');
    if (!card.word) card.word = word;
    renderWordCard(el.popBody, card, { word });
    positionPopover(anchor);
  } catch (err) {
    if (state.lookupSeq !== seq) return;
    el.popBody.innerHTML = `<div class="word-card error-box"><h3>查询失败</h3><p>${esc(err.message)}</p></div>`;
    positionPopover(anchor);
  }
}

function openPopover(anchor, word, context) {
  state.popAnchor = anchor;
  el.popover.classList.remove('hidden');
  el.popover.scrollTop = 0;
  lookupWord(word, anchor, context);
}

function hidePopover() {
  el.popover.classList.add('hidden');
  state.popAnchor = null;
}

/* ---------- 生词本 ---------- */
async function saveWord(word) {
  try {
    await request('/api/vocab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word })
    });
    state.vocabSet.add(word.toLowerCase());
    applyVocabHighlight();
    toast(`已加入生词本：${word}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- 加载 ---------- */
async function init() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (!id) {
    el.title.textContent = '缺少记录编号';
    el.body.innerHTML = '<div class="empty-line">链接无效，请从「文档对照」页的历史记录进入。</div>';
    return;
  }

  try {
    const [doc, vocab] = await Promise.all([
      request(`/api/documents/${id}`),
      request('/api/vocab').catch(() => [])
    ]);
    state.doc = doc;
    state.vocabSet = new Set((Array.isArray(vocab) ? vocab : [])
      .map((it) => String(it.word || '').trim().toLowerCase()).filter(Boolean));
    renderDoc();
    updateProgress();
  } catch (err) {
    el.title.textContent = '记录加载失败';
    el.body.innerHTML = `<div class="empty-line">${esc(err.message)}</div>`;
  }
}

/* ---------- 阅读视图控制 ---------- */
const readerView = { scale: 1, hideZh: false };
const progressBar = $('#readerProgressBar');
const zhToggleBtn = $('#zhToggleBtn');

function applyReaderView() {
  document.body.style.setProperty('--reader-scale', String(readerView.scale));
  document.body.classList.toggle('hide-zh', readerView.hideZh);
  zhToggleBtn.textContent = readerView.hideZh ? '显示中文' : '仅英文';
  zhToggleBtn.setAttribute('aria-pressed', String(readerView.hideZh));
}

function updateProgress() {
  if (!progressBar) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
  progressBar.style.width = `${pct}%`;
}

zhToggleBtn.addEventListener('click', () => {
  readerView.hideZh = !readerView.hideZh;
  applyReaderView();
});

$('#fontDownBtn').addEventListener('click', () => {
  readerView.scale = Math.max(0.85, Math.round((readerView.scale - 0.1) * 10) / 10);
  applyReaderView();
});

$('#fontUpBtn').addEventListener('click', () => {
  readerView.scale = Math.min(1.4, Math.round((readerView.scale + 0.1) * 10) / 10);
  applyReaderView();
});

window.addEventListener('scroll', updateProgress, { passive: true });
window.addEventListener('resize', updateProgress);

/* ---------- 事件 ---------- */
$('#backBtn').addEventListener('click', () => {
  location.href = '/index.html#doc';
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

  if (event.target.closest('[data-action="close-popover"]')) {
    hidePopover();
    return;
  }

  const chip = event.target.closest('.chip[data-word]');
  if (chip && chip.closest('#wordPopover')) {
    lookupWord(chip.dataset.word, state.popAnchor, '');
    return;
  }

  const wordSpan = event.target.closest('.w');
  if (wordSpan) {
    const row = wordSpan.closest('.zr-row');
    const context = row ? (row.querySelector('.zr-en') || {}).innerText || '' : '';
    openPopover(wordSpan, wordSpan.dataset.w, context);
  }
});

document.addEventListener('mousedown', (event) => {
  if (el.popover.classList.contains('hidden')) return;
  if (event.target.closest('#wordPopover') || event.target.closest('.w')) return;
  hidePopover();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hidePopover();
});

window.addEventListener('scroll', () => {
  if (!el.popover.classList.contains('hidden')) positionPopover(state.popAnchor);
}, true);

window.addEventListener('resize', () => {
  if (!el.popover.classList.contains('hidden')) positionPopover(state.popAnchor);
});

init();
