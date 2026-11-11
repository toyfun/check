/*
 * GLaDOS 自动签到（2026 challenge 版）
 * 适用：Surge / Loon / Shadowrocket / Quantumult X
 *
 * 当前签到流程：
 * 1. GET /api/user/checkin/challenge 获取 nonce 和 ttl
 * 2. 至少等待 2.5 秒
 * 3. proof = SHA-256(nonce + ".glados-observe-v1")
 * 4. POST /api/user/checkin，提交 token、nonce、proof
 *
 * 使用方法：
 * 1. 将本文件保存到 Quantumult X 的 Scripts 目录，并配置重写、定时任务和 MITM。
 * 2. 登录 GLaDOS 后打开“积分/签到”页面一次；页面加载 challenge 请求时会自动保存会话。
 * 3. 后续由定时任务自动签到。
 *
 * 注意：
 * - 新会话一般使用 gld:sess 与 gld:sess.sig；必须保存完整 Cookie。
 * - 服务端会校验登录设备，请勿手改 User-Agent；脚本会沿用抓取会话时的请求头。
 * - 如果服务端下发 Cloudflare Turnstile，本脚本不会绕过交互验证，请到网页手动签到。
 *
 * [rewrite_local]
 * ^https?:\/\/glados\.[^/]+\/api\/user\/checkin(?:\/challenge)?(?:\?.*)?$ url script-request-header glados.autosign.js
 *
 * [task_local]
 * 15 7,15 * * * glados.autosign.js, tag=GLaDOS签到
 *
 * [mitm]
 * hostname = glados.cloud, glados.network, glados.rocks, glados.space
 */

'use strict';

var NAME = 'GLaDOS';
var STORE_KEY = 'glados_checkin_session_v2';
var MIN_CHALLENGE_AGE_MS = 2700;
var isCapture = typeof $request !== 'undefined';

(async function () {
  if (isCapture) {
    captureSession();
  } else {
    await runCheckin();
  }
})().catch(function (error) {
  var message = error && error.message ? error.message : String(error);
  console.log('[GLaDOS] ' + message);
  notify(NAME, '运行失败', message);
}).finally(function () {
  finish();
});

function captureSession() {
  var request = $request || {};
  var headers = request.headers || {};
  var cookie = getHeader(headers, 'cookie');
  var userAgent = getHeader(headers, 'user-agent');
  var origin = getOrigin(request.url || '');

  if (!origin || !cookie) {
    notify(NAME, '会话获取失败', '没有捕获到完整 Cookie，请确认已登录后重新打开签到页面。');
    return;
  }

  var session = {
    origin: origin,
    url: request.url,
    headers: sanitizeStoredHeaders(headers),
    capturedAt: new Date().toISOString()
  };

  if (!setStore(JSON.stringify(session), STORE_KEY)) {
    notify(NAME, '会话获取失败', '持久化存储写入失败。');
    return;
  }

  var names = cookieNames(cookie);
  var type = names.indexOf('gld:sess') >= 0 ? '新会话' :
    (names.indexOf('koa:sess') >= 0 ? '旧会话' : '未知会话');
  var uaStatus = userAgent ? 'User-Agent 已保存' : '未捕获 User-Agent';
  notify(NAME, '会话获取成功', getHostname(origin) + ' · ' + type + ' · ' + uaStatus);
}

async function runCheckin() {
  var raw = getStore(STORE_KEY);
  if (!raw) {
    throw new Error('未找到会话。请先登录 GLaDOS，并打开一次签到页面以抓取 Cookie 和 User-Agent。');
  }

  var session;
  try {
    session = JSON.parse(raw);
  } catch (_) {
    throw new Error('已保存的会话格式损坏，请重新打开签到页面抓取。');
  }

  var origin = session.origin || getOrigin(session.url || '');
  var hostname = getHostname(origin);
  var headers = buildHeaders(session.headers || {}, origin);
  var cookie = getHeader(headers, 'cookie');

  if (!origin || !hostname || !cookie) {
    throw new Error('会话缺少域名或 Cookie，请重新抓取。');
  }

  if (!getHeader(headers, 'user-agent')) {
    throw new Error('会话缺少 User-Agent，可能触发 device-mismatch，请重新抓取。');
  }

  console.log('[GLaDOS] 使用域名：' + hostname);
  console.log('[GLaDOS] Cookie 字段：' + cookieNames(cookie).join(', '));

  var challengeReceivedAt = Date.now();
  var challengeResponse = await request('GET', {
    url: origin + '/api/user/checkin/challenge',
    headers: headers,
    timeout: 15
  });
  challengeReceivedAt = Date.now();

  var challenge = parseJson(challengeResponse.body);
  if (challengeResponse.statusCode < 200 || challengeResponse.statusCode >= 300) {
    throw new Error('获取签到验证失败：HTTP ' + challengeResponse.statusCode + formatServerMessage(challenge));
  }
  if (!challenge || challenge.code !== 0 || typeof challenge.nonce !== 'string' || !challenge.nonce) {
    throw new Error('获取签到验证失败' + formatServerMessage(challenge));
  }

  if (challenge.turnstile) {
    throw new Error('服务端要求 Cloudflare Turnstile 交互验证，后台脚本不能代答。请打开网页手动签到。');
  }

  var ttl = Number(challenge.ttl || 300000);
  if (!isFinite(ttl) || ttl <= MIN_CHALLENGE_AGE_MS) {
    throw new Error('签到验证有效期异常，请稍后重试。');
  }

  var proof = sha256(challenge.nonce + '.glados-observe-v1');
  var elapsed = Date.now() - challengeReceivedAt;
  if (elapsed < MIN_CHALLENGE_AGE_MS) {
    await wait(MIN_CHALLENGE_AGE_MS - elapsed);
  }
  if (Date.now() - challengeReceivedAt >= ttl) {
    throw new Error('签到验证已过期，请重新运行任务。');
  }

  var body = {
    token: hostname,
    nonce: challenge.nonce,
    proof: proof,
    tsState: 'off'
  };

  var postHeaders = cloneObject(headers);
  setHeader(postHeaders, 'Content-Type', 'application/json;charset=UTF-8');

  var response = await request('POST', {
    url: origin + '/api/user/checkin',
    headers: postHeaders,
    body: JSON.stringify(body),
    timeout: 20
  });
  var data = parseJson(response.body);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('签到请求失败：HTTP ' + response.statusCode + formatServerMessage(data));
  }
  if (!data) {
    throw new Error('签到接口返回了无法解析的数据。');
  }

  if (data.code === 4 && data.reason === 'device-mismatch') {
    throw new Error('设备校验不一致（device-mismatch）。请使用当前登录设备重新打开签到页抓取 Cookie 与 User-Agent。');
  }

  if (data.code !== 0) {
    throw new Error('签到失败' + formatServerMessage(data));
  }

  var repeated = Boolean(data.repeated) || /repeat|tomorrow|重复|明天/i.test(String(data.message || ''));
  var points = extractPoints(data);
  var title = repeated ? '今日已签到' : '签到成功';
  var detail = [];
  if (data.message) detail.push(String(data.message));
  if (data.points !== undefined && data.points !== null) detail.push('本次积分：' + data.points);
  if (points !== null) detail.push('当前积分：' + points);
  if (data.streak !== undefined && data.streak !== null) detail.push('连续签到：' + data.streak + ' 天');

  notify(NAME, title, detail.join(' · ') || '接口返回成功');
}

function extractPoints(data) {
  if (data && data.list && data.list.length && data.list[0].balance !== undefined) {
    var balance = Number(data.list[0].balance);
    return isFinite(balance) ? Math.round(balance) : data.list[0].balance;
  }
  if (data && data.currentPoints !== undefined) return data.currentPoints;
  return null;
}

function buildHeaders(stored, origin) {
  var result = {};
  var blocked = {
    'host': true,
    'content-length': true,
    'connection': true,
    'accept-encoding': true,
    ':authority': true,
    ':method': true,
    ':path': true,
    ':scheme': true
  };

  Object.keys(stored || {}).forEach(function (key) {
    if (!blocked[String(key).toLowerCase()]) result[key] = stored[key];
  });

  setHeader(result, 'Accept', getHeader(result, 'accept') || 'application/json, text/plain, */*');
  setHeader(result, 'Origin', origin);
  setHeader(result, 'Referer', origin + '/console/checkin');
  return result;
}

function sanitizeStoredHeaders(headers) {
  var output = {};
  Object.keys(headers || {}).forEach(function (key) {
    var lower = String(key).toLowerCase();
    if (lower !== 'content-length' && lower !== 'host' && lower.indexOf(':') !== 0) {
      output[key] = headers[key];
    }
  });
  return output;
}

function request(method, options) {
  return new Promise(function (resolve, reject) {
    if (typeof $task !== 'undefined') {
      var qxOptions = cloneObject(options);
      qxOptions.method = method;
      $task.fetch(qxOptions).then(function (response) {
        resolve({
          statusCode: Number(response.statusCode || response.status || 0),
          headers: response.headers || {},
          body: response.body || ''
        });
      }, reject);
      return;
    }

    if (typeof $httpClient !== 'undefined') {
      var callback = function (error, response, body) {
        if (error) {
          reject(new Error(typeof error === 'string' ? error : JSON.stringify(error)));
          return;
        }
        resolve({
          statusCode: Number((response && (response.statusCode || response.status)) || 0),
          headers: (response && response.headers) || {},
          body: body || ''
        });
      };
      if (method === 'POST') $httpClient.post(options, callback);
      else $httpClient.get(options, callback);
      return;
    }

    reject(new Error('当前运行环境不支持 $task 或 $httpClient。'));
  });
}

function getOrigin(url) {
  var match = String(url || '').match(/^(https?:\/\/[^/]+)/i);
  return match ? match[1] : '';
}

function getHostname(origin) {
  var match = String(origin || '').match(/^https?:\/\/([^/:]+)/i);
  return match ? match[1] : '';
}

function getHeader(headers, name) {
  var target = String(name).toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === target) return headers[keys[i]];
  }
  return '';
}

function setHeader(headers, name, value) {
  var target = String(name).toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === target) {
      headers[keys[i]] = value;
      return;
    }
  }
  headers[name] = value;
}

function cookieNames(cookie) {
  return String(cookie || '').split(';').map(function (item) {
    return item.trim().split('=')[0];
  }).filter(Boolean);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function formatServerMessage(data) {
  if (!data) return '';
  var parts = [];
  if (data.message) parts.push(data.message);
  if (data.reason) parts.push(data.reason);
  return parts.length ? '：' + parts.join(' / ') : '';
}

function cloneObject(value) {
  var output = {};
  Object.keys(value || {}).forEach(function (key) { output[key] = value[key]; });
  return output;
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function getStore(key) {
  if (typeof $prefs !== 'undefined') return $prefs.valueForKey(key);
  if (typeof $persistentStore !== 'undefined') return $persistentStore.read(key);
  return null;
}

function setStore(value, key) {
  if (typeof $prefs !== 'undefined') return $prefs.setValueForKey(value, key);
  if (typeof $persistentStore !== 'undefined') return $persistentStore.write(value, key);
  return false;
}

function notify(title, subtitle, message) {
  console.log('\n============== 通知 ==============');
  console.log(title + ' | ' + subtitle + ' | ' + message);
  if (typeof $notify !== 'undefined') $notify(title, subtitle, message);
  else if (typeof $notification !== 'undefined') $notification.post(title, subtitle, message);
}

function finish() {
  if (typeof $done !== 'undefined') $done({});
}

// Portable SHA-256. Input is converted to UTF-8 first.
function sha256(input) {
  var ascii = utf8Binary(input);
  var mathPow = Math.pow;
  var maxWord = mathPow(2, 32);
  var lengthProperty = 'length';
  var i, j;
  var result = '';
  var words = [];
  var asciiBitLength = ascii[lengthProperty] * 8;
  var hash = [];
  var k = [];
  var primeCounter = 0;
  var isComposite = {};

  for (var candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  ascii += '\x80';
  while (ascii[lengthProperty] % 64 !== 56) ascii += '\x00';
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i);
    words[i >> 2] |= j << ((3 - i) % 4) * 8;
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
  words[words[lengthProperty]] = asciiBitLength;

  for (j = 0; j < words[lengthProperty];) {
    var w = words.slice(j, j += 16);
    var oldHash = hash.slice(0);
    for (i = 0; i < 64; i++) {
      var w15 = w[i - 15];
      var w2 = w[i - 2];
      var a = hash[0];
      var e = hash[4];
      var temp1 = hash[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & hash[5]) ^ ((~e) & hash[6]))
        + k[i]
        + (w[i] = i < 16 ? w[i] : (
          w[i - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + w[i - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
        ) | 0);
      var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
        + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
      hash.pop();
    }
    for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
  }

  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      var b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? '0' : '') + b.toString(16);
    }
  }
  return result;
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function utf8Binary(value) {
  return encodeURIComponent(String(value)).replace(/%([0-9A-F]{2})/g, function (_, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
}
