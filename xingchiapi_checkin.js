/**
 * 星驰API公益站自动签到（Quantumult X / Loon / Surge / Node.js）
 * 站点：https://xingchiapi.com/dashboard
 *
 * 接口（依据 2026-11-20 的站点前端代码）：
 * - POST /api/v1/auth/refresh    使用 refresh_token 换取 access_token
 * - GET  /api/v1/user/checkin   查询签到状态
 * - POST /api/v1/user/checkin   领取每日签到额度
 *
 * 为什么不直接使用账号密码：站点当前登录开启了 Turnstile，人机验证令牌不能由
 * 普通定时脚本可靠生成。因此本脚本使用浏览器登录后获得的 refresh_token。
 * 刷新令牌如果发生轮换，脚本会自动写入持久化存储；Node.js 会写入脚本同目录的
 * xingchiapi_tokens.json。
 *
 * 配置方式一：直接填写 CONFIG。
 * 单账号：account: "refresh_token"
 * 多账号：accounts: [{ name: "账号1", refreshToken: "..." }, ...]
 * 也可仅使用短期 accessToken，但过期后需要手动更新。
 *
 * refresh_token 获取方法：先在浏览器正常登录，然后打开开发者工具 → Application
 * （应用）→ Local Storage → https://xingchiapi.com，复制 refresh_token 的值。
 * 该令牌等同于登录凭据，请勿发给他人、上传网盘或提交到公开仓库。
 *
 * 配置方式二（持久化存储，优先于 CONFIG）：
 * XINGCHIAPI_ACCOUNT  = refresh_token
 * XINGCHIAPI_ACCOUNTS = [{"name":"账号1","refreshToken":"..."}]
 * XINGCHIAPI_BASE_URL = https://xingchiapi.com
 * XINGCHIAPI_POLICY   = 可选；QX 策略 / Surge 策略 / Loon 节点或策略组
 * XINGCHIAPI_TIMEOUT  = 可选；请求超时秒数，默认 20
 *
 * Node.js 还支持同名环境变量。首次成功刷新后，会优先使用
 * xingchiapi_tokens.json 中保存的新 refresh_token。
 *
 * 定时任务示例（文件地址按实际情况修改）：
 * Quantumult X [task_local]
 * 5 0 * * * xingchiapi_checkin.js, tag=星驰API签到, enabled=true
 *
 * Surge [Script]
 * 星驰API签到 = type=cron,cronexp="5 0 * * *",script-path=xingchiapi_checkin.js,timeout=120
 *
 * Loon 3.5.1 (983)+ [Script]
 * cron "5 0 * * *" then script("xingchiapi_checkin.js") with tag="星驰API签到", timeout=120
 *
 * Node.js
 * node xingchiapi_checkin.js
 *
 * 无需 MITM。refresh_token 和 access_token 只发送给 CONFIG.baseUrl 指定的站点。
 */

const CONFIG = {
  account: "", // 单账号 refresh_token
  accessToken: "", // 可选；仅用于没有 refresh_token 的临时配置
  accounts: [
    // { name: "账号1", refreshToken: "..." },
    // { name: "账号2", accessToken: "..." },
  ],
  baseUrl: "https://xingchiapi.com",
  policy: "",
  timeoutSeconds: 20,
  timezone: "Asia/Shanghai",
};

const API_PREFIX = "/api/v1";
const REFRESH_PATH = "/auth/refresh";
const CHECKIN_PATH = "/user/checkin";
const STORED_TOKEN_MAP_KEY = "XINGCHIAPI_REFRESH_TOKENS";
const NODE_TOKEN_FILE = "xingchiapi_tokens.json";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

let finished = false;

function isQuantumultX() {
  return typeof $task !== "undefined";
}

function isLoon() {
  return typeof $loon !== "undefined";
}

function isNode() {
  return (
    typeof process !== "undefined" &&
    process.versions &&
    typeof process.versions.node === "string"
  );
}

function finish() {
  if (finished) return;
  finished = true;
  if (typeof $done === "function") $done();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTime(date) {
  const d = date || new Date();
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes()) +
    ":" +
    pad2(d.getSeconds())
  );
}

function log(message) {
  console.log("[" + formatTime() + "] " + message);
}

function notify(title, content) {
  try {
    if (typeof $notify === "function") {
      $notify(title, "", content);
    } else if (
      typeof $notification !== "undefined" &&
      typeof $notification.post === "function"
    ) {
      $notification.post(title, "", content);
    } else {
      log("[通知] " + title + "\n" + content);
    }
  } catch (error) {
    log("通知发送失败（不影响签到）: " + errorMessage(error));
  }
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error) {
  if (error && typeof error === "object") {
    return String(error.message || error.error || JSON.stringify(error));
  }
  return String(error || "未知错误");
}

function readPersistent(key) {
  try {
    if (typeof $prefs !== "undefined" && typeof $prefs.valueForKey === "function") {
      const value = $prefs.valueForKey(key);
      return value === null || value === undefined ? "" : value;
    }
    if (
      typeof $persistentStore !== "undefined" &&
      typeof $persistentStore.read === "function"
    ) {
      const value = $persistentStore.read(key);
      return value === null || value === undefined ? "" : value;
    }
    if (isNode() && process.env && process.env[key]) {
      return process.env[key];
    }
  } catch (error) {
    log("读取持久化配置失败 [" + key + "]: " + errorMessage(error));
  }
  return "";
}

function writePersistent(value, key) {
  try {
    if (typeof $prefs !== "undefined" && typeof $prefs.setValueForKey === "function") {
      return $prefs.setValueForKey(String(value), key) !== false;
    }
    if (
      typeof $persistentStore !== "undefined" &&
      typeof $persistentStore.write === "function"
    ) {
      return $persistentStore.write(String(value), key) !== false;
    }
  } catch (error) {
    log("写入持久化配置失败 [" + key + "]: " + errorMessage(error));
  }
  return false;
}

function nodeTokenFilePath() {
  if (!isNode()) return "";
  const path = require("path");
  return path.join(typeof __dirname === "string" ? __dirname : process.cwd(), NODE_TOKEN_FILE);
}

function loadNodeTokenMap() {
  if (!isNode()) return {};
  try {
    const fs = require("fs");
    const file = nodeTokenFilePath();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    log("读取 Node 令牌文件失败: " + errorMessage(error));
    return {};
  }
}

function saveNodeTokenMap(map) {
  if (!isNode()) return false;
  try {
    const fs = require("fs");
    const file = nodeTokenFilePath();
    const tempFile = file + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(map, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempFile, file);
    return true;
  } catch (error) {
    log("保存 Node 令牌文件失败: " + errorMessage(error));
    return false;
  }
}

function parseObject(value, label) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (error) {
    log(label + " 解析失败: " + errorMessage(error));
  }
  return {};
}

function loadRotatedTokenMap() {
  const stored = parseObject(readPersistent(STORED_TOKEN_MAP_KEY), STORED_TOKEN_MAP_KEY);
  return Object.assign({}, stored, loadNodeTokenMap());
}

function saveRotatedToken(accountKey, refreshToken) {
  if (!accountKey || !refreshToken) return;
  const map = loadRotatedTokenMap();
  if (map[accountKey] === refreshToken) return;
  map[accountKey] = refreshToken;
  const serialized = JSON.stringify(map);
  const persistentSaved = writePersistent(serialized, STORED_TOKEN_MAP_KEY);
  const nodeSaved = saveNodeTokenMap(map);
  if (persistentSaved || nodeSaved) {
    log("[" + accountKey + "] 已保存轮换后的 refresh_token");
  } else if (!isNode()) {
    log("[" + accountKey + "] 警告：无法持久化新的 refresh_token");
  }
}

function normalizeAccount(item, index) {
  if (!item || typeof item !== "object") return null;
  const name = trimString(item.name) || "账号" + (index + 1);
  const key = trimString(item.key) || name;
  const refreshToken = trimString(
    item.refreshToken || item.refresh_token || item.token || item.account
  );
  const accessToken = trimString(item.accessToken || item.access_token);
  if (!refreshToken && !accessToken) return null;
  return { name: name, key: key, refreshToken: refreshToken, accessToken: accessToken };
}

function parseAccountArray(value, label) {
  let array = value;
  if (typeof value === "string") {
    try {
      array = JSON.parse(value);
    } catch (error) {
      log(label + " 解析失败: " + errorMessage(error));
      return [];
    }
  }
  if (!Array.isArray(array)) {
    if (value) log(label + " 必须是 JSON 数组");
    return [];
  }
  return array.map(normalizeAccount).filter(Boolean);
}

function collectAccounts() {
  const storedMulti = trimString(readPersistent("XINGCHIAPI_ACCOUNTS"));
  let accounts = storedMulti
    ? parseAccountArray(storedMulti, "XINGCHIAPI_ACCOUNTS")
    : parseAccountArray(CONFIG.accounts, "CONFIG.accounts");

  if (!accounts.length) {
    const refreshToken =
      trimString(readPersistent("XINGCHIAPI_ACCOUNT")) || trimString(CONFIG.account);
    const accessToken =
      trimString(readPersistent("XINGCHIAPI_ACCESS_TOKEN")) || trimString(CONFIG.accessToken);
    if (refreshToken || accessToken) {
      accounts = [
        {
          name: "默认账号",
          key: "default",
          refreshToken: refreshToken,
          accessToken: accessToken,
        },
      ];
    }
  }

  const rotated = loadRotatedTokenMap();
  accounts.forEach(function (account) {
    if (trimString(rotated[account.key])) account.refreshToken = trimString(rotated[account.key]);
  });
  return accounts;
}

function getRuntimeConfig() {
  const baseUrl =
    trimString(readPersistent("XINGCHIAPI_BASE_URL")) ||
    trimString(CONFIG.baseUrl) ||
    "https://xingchiapi.com";
  const timeoutRaw =
    trimString(readPersistent("XINGCHIAPI_TIMEOUT")) || String(CONFIG.timeoutSeconds || 20);
  const timeout = Number(timeoutRaw);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    policy: trimString(readPersistent("XINGCHIAPI_POLICY")) || trimString(CONFIG.policy),
    timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : 20,
    timezone: trimString(CONFIG.timezone) || "Asia/Shanghai",
  };
}

function applyNetworkOptions(request, runtime) {
  if (isQuantumultX()) {
    request.opts = {
      redirection: true,
      "skip-cert-verify": false,
      "auto-cookie": false,
    };
    if (runtime.policy) request.opts.policy = runtime.policy;
    return request;
  }

  if (isNode() && typeof $httpClient === "undefined") return request;

  request["auto-redirect"] = true;
  request["auto-cookie"] = false;
  if (isLoon()) {
    request.timeout = runtime.timeoutSeconds * 1000;
    if (runtime.policy) request.node = runtime.policy;
  } else {
    request.timeout = runtime.timeoutSeconds;
    request["full-header-mode"] = true;
    if (runtime.policy) request.policy = runtime.policy;
  }
  return request;
}

function headerValues(headers, wantedName) {
  const wanted = wantedName.toLowerCase();
  const values = [];
  if (Array.isArray(headers)) {
    headers.forEach(function (header) {
      if (!header || String(header.field || "").toLowerCase() !== wanted) return;
      if (Array.isArray(header.value)) values.push.apply(values, header.value);
      else if (header.value !== undefined && header.value !== null) values.push(header.value);
    });
    return values;
  }
  if (!headers || typeof headers !== "object") return values;
  Object.keys(headers).forEach(function (name) {
    if (name.toLowerCase() !== wanted) return;
    const value = headers[name];
    if (Array.isArray(value)) values.push.apply(values, value);
    else if (value !== undefined && value !== null) values.push(value);
  });
  return values;
}

function getHeader(headers, name) {
  const values = headerValues(headers, name);
  return values.length ? String(values[0]) : "";
}

function deleteHeader(headers, wantedName) {
  const wanted = wantedName.toLowerCase();
  Object.keys(headers).forEach(function (name) {
    if (name.toLowerCase() === wanted) delete headers[name];
  });
}

function nodeRequestOnce(options, runtime) {
  return new Promise(function (resolve, reject) {
    let target;
    try {
      target = new URL(options.url);
    } catch (error) {
      reject(new Error("无效请求地址: " + options.url));
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      reject(new Error("Node 模式仅支持 HTTP/HTTPS 地址"));
      return;
    }
    const transport = require(target.protocol === "https:" ? "https" : "http");
    const req = transport.request(
      target,
      {
        method: String(options.method || "GET").toUpperCase(),
        headers: options.headers || {},
      },
      function (response) {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", function (chunk) {
          chunks.push(chunk);
        });
        response.on("end", function () {
          resolve({
            status: Number(response.statusCode || 0),
            headers: response.headers || {},
            body: chunks.join(""),
          });
        });
      }
    );
    req.setTimeout(runtime.timeoutSeconds * 1000, function () {
      req.destroy(new Error("请求超时（" + runtime.timeoutSeconds + " 秒）"));
    });
    req.on("error", reject);
    if (options.body !== undefined && options.body !== null) req.write(String(options.body));
    req.end();
  });
}

function nodeRequest(options, runtime, redirectCount) {
  const count = redirectCount || 0;
  return nodeRequestOnce(options, runtime).then(function (response) {
    const location = getHeader(response.headers, "location");
    const isRedirect = [301, 302, 303, 307, 308].indexOf(response.status) >= 0;
    if (!isRedirect || !location) return response;
    if (count >= 5) throw new Error("重定向次数过多");

    const currentUrl = new URL(options.url);
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== currentUrl.origin) {
      throw new Error("为保护令牌，已拒绝跨站重定向至 " + nextUrl.origin);
    }

    const nextHeaders = Object.assign({}, options.headers || {});
    const nextOptions = {
      url: nextUrl.href,
      method: options.method,
      headers: nextHeaders,
      body: options.body,
    };
    const method = String(options.method || "GET").toUpperCase();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      nextOptions.method = "GET";
      delete nextOptions.body;
      deleteHeader(nextHeaders, "content-type");
      deleteHeader(nextHeaders, "content-length");
    }
    return nodeRequest(nextOptions, runtime, count + 1);
  });
}

function rawRequest(options, runtime) {
  return new Promise(function (resolve, reject) {
    if (isQuantumultX()) {
      $task.fetch(options).then(
        function (response) {
          resolve({
            status: Number(response.statusCode || response.status || 0),
            headers: response.headers || {},
            body: typeof response.body === "string" ? response.body : "",
          });
        },
        function (reason) {
          reject(new Error(errorMessage(reason)));
        }
      );
      return;
    }

    if (typeof $httpClient !== "undefined") {
      const method = String(options.method || "GET").toLowerCase();
      const clientMethod = $httpClient[method];
      if (typeof clientMethod !== "function") {
        reject(new Error("当前工具不支持 HTTP 方法: " + method.toUpperCase()));
        return;
      }
      clientMethod(options, function (error, response, data) {
        if (error) {
          reject(new Error(errorMessage(error)));
          return;
        }
        resolve({
          status: Number((response && (response.status || response.statusCode)) || 0),
          headers: (response && response.headers) || {},
          body: typeof data === "string" ? data : "",
        });
      });
      return;
    }

    if (isNode()) {
      nodeRequest(options, runtime).then(resolve, reject);
      return;
    }
    reject(new Error("不支持的脚本环境：缺少 $task.fetch、$httpClient 或 Node.js"));
  });
}

function request(options, runtime) {
  const configured = applyNetworkOptions(options, runtime);
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error("请求超时（" + runtime.timeoutSeconds + " 秒）"));
    }, runtime.timeoutSeconds * 1000);

    rawRequest(configured, runtime).then(
      function (response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      },
      function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function safeMessage(value, account) {
  let text = String(value || "未知错误").replace(/[\r\n]+/g, " ").slice(0, 240);
  [account.refreshToken, account.accessToken].forEach(function (secret) {
    if (secret) text = text.split(secret).join("***");
  });
  return text;
}

function parseApiResponse(response, label, account) {
  const contentType = getHeader(response.headers, "content-type").toLowerCase();
  if (contentType.indexOf("text/html") >= 0) {
    throw new Error(label + "返回 HTML（HTTP " + response.status + "），可能被 WAF 拦截");
  }

  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch (error) {
    throw new Error(label + "返回非 JSON（HTTP " + response.status + "）");
  }

  const code = payload && payload.code;
  if (response.status < 200 || response.status >= 300 || code !== 0) {
    const reason = payload && payload.reason ? " [" + payload.reason + "]" : "";
    const message = payload && (payload.message || payload.detail || payload.error);
    const error = new Error(
      label + "失败（HTTP " + response.status + ", code=" + code + ")" + reason +
        ": " + safeMessage(message, account)
    );
    error.status = response.status;
    error.code = code;
    error.reason = payload && payload.reason;
    throw error;
  }
  return payload.data;
}

function apiUrl(runtime, path) {
  return runtime.baseUrl + API_PREFIX + path;
}

function commonHeaders(accessToken) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": USER_AGENT,
  };
  if (accessToken) headers.Authorization = "Bearer " + accessToken;
  return headers;
}

async function refreshAccessToken(account, runtime) {
  if (!account.refreshToken) {
    if (!account.accessToken) throw new Error("未配置 refresh_token 或 access_token");
    return account.accessToken;
  }

  const headers = commonHeaders("");
  headers["Content-Type"] = "application/json";
  const response = await request(
    {
      url: apiUrl(runtime, REFRESH_PATH),
      method: "POST",
      headers: headers,
      body: JSON.stringify({ refresh_token: account.refreshToken }),
    },
    runtime
  );
  const data = parseApiResponse(response, "刷新令牌", account);
  if (!data || !trimString(data.access_token)) {
    throw new Error("刷新接口未返回 access_token");
  }
  account.accessToken = trimString(data.access_token);
  if (trimString(data.refresh_token)) {
    account.refreshToken = trimString(data.refresh_token);
    saveRotatedToken(account.key, account.refreshToken);
  }
  return account.accessToken;
}

async function getCheckinStatus(account, runtime, accessToken) {
  const query = "?timezone=" + encodeURIComponent(runtime.timezone);
  const response = await request(
    {
      url: apiUrl(runtime, CHECKIN_PATH) + query,
      method: "GET",
      headers: commonHeaders(accessToken),
    },
    runtime
  );
  return parseApiResponse(response, "查询签到状态", account);
}

async function claimCheckin(account, runtime, accessToken) {
  const response = await request(
    {
      url: apiUrl(runtime, CHECKIN_PATH),
      method: "POST",
      headers: commonHeaders(accessToken),
    },
    runtime
  );
  return parseApiResponse(response, "领取签到额度", account);
}

function numberText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "未知";
}

function resultLine(result) {
  const icon = result.status === "fail" ? "❌" : result.status === "already" ? "🟡" : "✅";
  return (
    icon +
    " " +
    result.name +
    "\n" +
    result.message +
    (result.totalCount === null
      ? ""
      : "\n累计签到 " +
        numberText(result.totalCount) +
        " 次｜累计领取 " +
        numberText(result.totalAmount))
  );
}

async function processAccount(account, runtime) {
  log("====== 开始处理账号: " + account.name + " ======");
  try {
    const accessToken = await refreshAccessToken(account, runtime);
    let status = await getCheckinStatus(account, runtime, accessToken);
    if (!status || status.enabled === false) {
      return {
        name: account.name,
        status: "fail",
        message: "站点未启用每日签到",
        totalCount: status ? Number(status.total_count) : null,
        totalAmount: status ? Number(status.total_amount) : null,
      };
    }

    if (status.claimed_today === true) {
      return {
        name: account.name,
        status: "already",
        message: "今日已签到",
        totalCount: Number.isFinite(Number(status.total_count)) ? Number(status.total_count) : null,
        totalAmount: Number.isFinite(Number(status.total_amount)) ? Number(status.total_amount) : null,
      };
    }

    let claim;
    try {
      claim = await claimCheckin(account, runtime, accessToken);
    } catch (error) {
      if (error.reason !== "CHECKIN_ALREADY_CLAIMED") throw error;
      status = await getCheckinStatus(account, runtime, accessToken);
      return {
        name: account.name,
        status: "already",
        message: "服务端确认今日已签到",
        totalCount: Number.isFinite(Number(status.total_count)) ? Number(status.total_count) : null,
        totalAmount: Number.isFinite(Number(status.total_amount)) ? Number(status.total_amount) : null,
      };
    }

    status = claim && claim.status ? claim.status : await getCheckinStatus(account, runtime, accessToken);
    const verified = status && status.claimed_today === true;
    return {
      name: account.name,
      status: verified ? "success" : "fail",
      message: verified
        ? "签到成功，领取 " + numberText(claim && claim.amount) + " 额度"
        : "接口已返回成功，但状态核验未显示今日已签到",
      totalCount: status && Number.isFinite(Number(status.total_count)) ? Number(status.total_count) : null,
      totalAmount:
        status && Number.isFinite(Number(status.total_amount)) ? Number(status.total_amount) : null,
    };
  } catch (error) {
    const message = safeMessage(errorMessage(error), account);
    log("[" + account.name + "] 失败: " + message);
    return {
      name: account.name,
      status: "fail",
      message: message,
      totalCount: null,
      totalAmount: null,
    };
  }
}

async function main() {
  log("星驰API自动签到启动");
  const runtime = getRuntimeConfig();
  const accounts = collectAccounts();
  if (!accounts.length) {
    notify(
      "[星驰API] 签到失败",
      "未检测到 refresh_token：请填写 CONFIG.account / CONFIG.accounts，或写入 XINGCHIAPI_ACCOUNT / XINGCHIAPI_ACCOUNTS"
    );
    return;
  }

  const results = [];
  for (let index = 0; index < accounts.length; index += 1) {
    results.push(await processAccount(accounts[index], runtime));
  }

  results.forEach(function (result) {
    log(resultLine(result).replace(/\n/g, " | "));
  });
  const failures = results.filter(function (result) {
    return result.status === "fail";
  }).length;
  const title = failures
    ? "[星驰API] 签到完成（失败 " + failures + "/" + results.length + "）"
    : "[星驰API] 签到完成（" + results.length + " 个账号）";
  notify(title, results.map(resultLine).join("\n\n"));
}

main()
  .catch(function (error) {
    const message = "脚本异常: " + errorMessage(error);
    log(message);
    notify("[星驰API] 签到失败", message);
  })
  .finally(finish);

