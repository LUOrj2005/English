'use strict';

// 零依赖的 Microsoft Edge 在线朗读（Read Aloud）客户端。
// 只使用 Node.js 内置模块：Node >= 22 自带全局 WebSocket；
// 若项目里装过 ws，则优先用 ws（可携带 Edge 期望的 User-Agent / Origin 头）。
// 这样 git clone 后即使没有 node_modules，句子朗读也能工作（平板 / Termux 场景）。

const crypto = require('node:crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const GEC_VERSION = '2-143.0.3650.96';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';

const WS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
};

/* ---------- Sec-MS-GEC v2 ---------- */
// 微软要求 URL 带 Sec-MS-GEC：<CS64 校验和>-<SHA-256>，
// 输入为「Edge 版权行 + Windows 文件时间刻度（5 分钟取整）+ TrustedClientToken」。

function toUpperHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function swapHalves(value) {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function swapTerm(word, key, m) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), m.swappedWord);
  const product = Math.imul(swapHalves(sum), m.swappedSum) >>> 0;
  return (Math.imul(swapHalves(product), m.swappedProduct) + product) >>> 0;
}

function swapAndMultiply(value, multipliers) {
  for (const multiplier of multipliers) {
    value = Math.imul(swapHalves(value), multiplier) >>> 0;
  }
  return value;
}

function cs64(message, digest) {
  const digestView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const firstKey = (digestView.getUint32(0, true) | 1) >>> 0;
  const secondKey = (digestView.getUint32(4, true) | 1) >>> 0;

  const padded = new Uint8Array(Math.ceil(message.length / 8) * 8);
  padded.set(message);
  const words = new DataView(padded.buffer);

  const SWAP_FIRST_WORD = { swappedWord: 0xEF0569FB, swappedSum: 0x76F50F34, swappedProduct: 0xC3EFEA97 };
  const SWAP_SECOND_WORD = { swappedWord: 0xC31713DB, swappedSum: 0x1881CE3C, swappedProduct: 0x35BD1EC9 };
  const MIX_FIRST_WORD = [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83];
  const MIX_SECOND_WORD = [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69];

  let swapSum = 0;
  let lastSwap = 0;
  let mix = 0;
  let mixSum = 0;
  for (let offset = 0; offset < padded.length; offset += 8) {
    const firstWord = words.getUint32(offset, true);
    const secondWord = words.getUint32(offset + 4, true);
    const firstSwap = swapTerm(firstWord, firstKey, SWAP_FIRST_WORD);
    lastSwap = swapTerm(secondWord, secondKey, SWAP_SECOND_WORD);
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + firstWord, firstKey), MIX_FIRST_WORD);
    mixSum = (mixSum + mix) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + secondWord, secondKey), MIX_SECOND_WORD);
    mixSum = (mixSum + mix) >>> 0;
  }

  const checksum = new Uint8Array(8);
  const view = new DataView(checksum.buffer);
  view.setUint32(0, lastSwap ^ mix, true);
  view.setUint32(4, swapSum ^ mixSum, true);
  return checksum;
}

async function secMsGec(clockOffsetMs = 0) {
  const ticks = Math.floor((Date.now() + clockOffsetMs) / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  const input = `${rounded * 10000000}${TRUSTED_CLIENT_TOKEN}`;
  const message = new TextEncoder().encode(EDGE_COPYRIGHT + input);
  const digest = new Uint8Array(await crypto.webcrypto.subtle.digest('SHA-256', message));
  return `${toUpperHex(cs64(message, digest))}-${toUpperHex(digest)}`;
}

function uuid() {
  return 'xxxxxxxx-xxxx-xxxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// 设备时钟与微软服务器偏差过大时 GEC 会被判 403；用语音列表响应的 Date 头校正一次
async function serverClockOffset() {
  try {
    const r = await fetch(VOICES_URL, { signal: AbortSignal.timeout(8000) });
    const server = Date.parse(r.headers.get('date') || '');
    try { await r.body?.cancel(); } catch (e) { /* ignore */ }
    return Number.isFinite(server) ? server - Date.now() : 0;
  } catch (err) {
    return 0;
  }
}

/* ---------- SSML 与 WebSocket ---------- */
function escapeSSML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function speechConfigMessage() {
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: OUTPUT_FORMAT
        }
      }
    }
  });
  return `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${body}`;
}

function ssmlMessage(text, voice, locale) {
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">`
    + `<voice name="${voice}"><prosody pitch="+0Hz" rate="+0%" volume="+0%">${escapeSSML(text)}</prosody></voice></speak>`;
  return `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
}

function createSocket(url) {
  // 优先使用 ws（可自定义请求头），否则退回 Node 22 内置全局 WebSocket
  if (typeof require === 'function') {
    try {
      const WS = require('ws');
      const ws = new WS(url, { headers: WS_HEADERS, handshakeTimeout: 12000 });
      ws.binaryType = 'arraybuffer';
      return ws;
    } catch (err) { /* 未安装 ws，继续用内置实现 */ }
  }
  if (typeof WebSocket === 'function') {
    let ws;
    try {
      // Node 22 内置（undici）WebSocket 允许传 options，尝试携带 Edge 校验需要的头
      ws = new WebSocket(url, { headers: WS_HEADERS });
    } catch (err) {
      ws = new WebSocket(url);
    }
    ws.binaryType = 'arraybuffer';
    return ws;
  }
  throw new Error('当前 Node.js 没有内置 WebSocket 且未安装 ws，请使用 Node.js >= 22.5 或运行 npm install');
}

function synthOnce(text, opts) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = createSocket(opts.url);
    } catch (err) {
      reject(err);
      return;
    }

    const chunks = [];
    let settled = false;
    let turnEnded = false;
    const timer = setTimeout(() => finish(new Error('Edge TTS 合成超时')), opts.timeout);

    const close = () => {
      try { ws.close(); } catch (e) { /* ignore */ }
      try { ws.terminate?.(); } catch (e) { /* ignore */ }
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      if (err) return reject(err);
      const buf = Buffer.concat(chunks);
      return buf.length ? resolve(buf) : reject(new Error('Edge TTS 返回空音频'));
    };

    ws.onopen = () => {
      try {
        ws.send(speechConfigMessage());
        ws.send(ssmlMessage(text, opts.voice, opts.locale));
      } catch (err) {
        finish(err);
      }
    };

    ws.onmessage = (ev) => {
      const data = ev && ev.data;
      if (data == null) return;
      // 文本帧：turn.end 表示合成结束
      if (typeof data === 'string' || Buffer.isBuffer(data)) {
        const s = String(data);
        if (s.includes('Path:turn.end')) {
          turnEnded = true;
          finish();
        } else if (/Path:audio\b/.test(s)) {
          // 少数实现把二进制帧以文本形式给出，忽略即可
        }
        return;
      }
      // 二进制帧：前 2 字节为 header 长度，随后为 header 文本，再后是 mp3 数据
      const buf = Buffer.from(data);
      const marker = buf.indexOf('Path:audio\r\n');
      if (marker >= 0) chunks.push(buf.subarray(marker + 'Path:audio\r\n'.length));
    };

    ws.onerror = () => finish(new Error('Edge TTS WebSocket 连接失败（检查网络，或设备时间是否准确）'));
    ws.onclose = () => {
      if (settled) return;
      finish(turnEnded ? null : new Error('Edge TTS 连接提前关闭，未收到 turn.end'));
    };
  });
}

/**
 * 合成文本为 MP3 Buffer。
 * @param {string} text 待朗读文本（纯文本，内部会转义为合法 SSML）
 * @param {{isZh?: boolean, voice?: string, timeout?: number}} options
 * @returns {Promise<Buffer>}
 */
async function synthesize(text, options = {}) {
  const isZh = Boolean(options.isZh);
  const voice = options.voice || (isZh ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural');
  const locale = isZh ? 'zh-CN' : 'en-US';
  const timeout = Number(options.timeout) || 45000;

  const buildOpts = async (clockOffsetMs) => ({
    voice,
    locale,
    timeout,
    url: `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
      + `&Sec-MS-GEC=${await secMsGec(clockOffsetMs)}`
      + `&Sec-MS-GEC-Version=${GEC_VERSION}`
      + `&ConnectionId=${uuid()}`
  });

  try {
    return await synthOnce(text, await buildOpts(0));
  } catch (err) {
    // 403 多由本机时钟偏差导致：取服务器时间校正后重试一次
    const offset = await serverClockOffset();
    if (!offset) throw err;
    return synthOnce(text, await buildOpts(offset));
  }
}

module.exports = { synthesize };
