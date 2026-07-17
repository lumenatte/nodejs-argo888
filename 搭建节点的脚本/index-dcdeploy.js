#!/usr/bin/env node

const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { execSync } = require('child_process');

// 基础变量保留配置
const UPLOAD_URL = process.env.UPLOAD_URL || '';
const PROJECT_URL = process.env.PROJECT_URL || '';
const AUTO_ACCESS = process.env.AUTO_ACCESS || false;
const YT_WARPOUT = process.env.YT_WARPOUT || false;
const FILE_PATH = process.env.FILE_PATH || '.npm';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const UUID = process.env.UUID || '94ec543f-c850-44e7-a61a-f84f9a8d51d1';
const KOMARI_ENDPOINT = process.env.KOMARI_ENDPOINT || '';
const KOMARI_TOKEN = process.env.KOMARI_TOKEN || '';
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || 443;
const PORT = process.env.PORT || 3000;
const NAME = process.env.NAME || '';
const CHAT_ID = process.env.CHAT_ID || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// 新增：Argo 隧道相关变量
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';   // 固定隧道域名，留空则使用临时隧道(trycloudflare.com)
const ARGO_AUTH = process.env.ARGO_AUTH || '';       // 固定隧道 Token 或 TunnelSecret JSON，留空则使用临时隧道
const ARGO_PORT = process.env.ARGO_PORT || 8001;     // 内核本地监听端口，cloudflared 会将隧道流量转发到这个端口

// 创建运行文件夹
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH);
}

function generateRandomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const npmRandomName = generateRandomName();
const webRandomName = generateRandomName();
const botRandomName = generateRandomName(); // 新增：cloudflared 可执行文件随机名
let npmPath = path.join(FILE_PATH, npmRandomName);
let webPath = path.join(FILE_PATH, webRandomName);
let botPath = path.join(FILE_PATH, botRandomName); // 新增
let subPath = path.join(FILE_PATH, 'sub.txt');
let listPath = path.join(FILE_PATH, 'list.txt');
let bootLogPath = path.join(FILE_PATH, 'boot.log'); // 新增：cloudflared 临时隧道日志

let subContent = null; // 新增：内存中的订阅内容，供 /sub 路由即时响应

// 根路由响应平台健康检查
app.get("/", function (req, res) {
  res.send("Server is running perfectly via Northflank HTTP!");
});

// 订阅路由：优先返回内存内容，其次回退读文件
app.get(`/${SUB_PATH}`, (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  if (subContent) {
    res.send(subContent);
    return;
  }
  try {
    const fileContent = fs.readFileSync(subPath, 'utf-8');
    res.send(fileContent);
  } catch (err) {
    res.status(503).send('Subscription content not yet available, please try again later.');
  }
});

function getSystemArchitecture() {
  const arch = os.arch();
  return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

function downloadFile(fileName, fileUrl, callback) {
  const filePath = path.join(FILE_PATH, fileName);
  const writer = fs.createWriteStream(filePath);
  axios({ method: 'get', url: fileUrl, responseType: 'stream' })
    .then(response => {
      response.data.pipe(writer);
      writer.on('finish', () => {
        writer.close();
        callback(null, fileName);
      });
      writer.on('error', err => callback(err.message));
    }).catch(err => callback(err.message));
}

// 核心下载逻辑：下载 sb 内核、Komari，以及新增的 cloudflared(Argo)
async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const filesToDownload = [
    { fileName: webRandomName, fileUrl: architecture === 'arm' ? "https://arm64.ssss.nyc.mn/sb" : "https://amd64.ssss.nyc.mn/sb" },
    { fileName: botRandomName, fileUrl: architecture === 'arm' ? "https://arm64.ssss.nyc.mn/bot" : "https://amd64.ssss.nyc.mn/bot" } // 新增：cloudflared
  ];

  if (KOMARI_ENDPOINT && KOMARI_TOKEN) {
    const komariUrl = architecture === 'arm'
      ? "https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-arm64"
      : "https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-amd64";
    filesToDownload.unshift({ fileName: npmRandomName, fileUrl: komariUrl });
  }

  const downloadPromises = filesToDownload.map(fileInfo => {
    return new Promise((resolve, reject) => {
      downloadFile(fileInfo.fileName, fileInfo.fileUrl, (err, fileName) => {
        if (err) reject(err); else resolve(fileName);
      });
    });
  });

  try {
    await Promise.all(downloadPromises);
  } catch (err) {
    console.error('下载依赖失败:', err);
    return;
  }

  // 授权文件
  [npmRandomName, webRandomName, botRandomName].forEach(file => {
    const absPath = path.join(FILE_PATH, file);
    if (fs.existsSync(absPath)) fs.chmodSync(absPath, 0o775);
  });

  // 1. 【保留你的Komari监控组件】
  if (KOMARI_ENDPOINT && KOMARI_TOKEN) {
    const komariCmd = `nohup ${path.join(FILE_PATH, npmRandomName)} -e ${KOMARI_ENDPOINT} -t ${KOMARI_TOKEN} --disable-web-ssh --disable-auto-update >/dev/null 2>&1 &`;
    try {
      exec(komariCmd);
      console.log('Komari 探针已在后台成功拉起！');
    } catch (e) { console.error(e); }
  }

  // 2. 【生成经由 Argo 隧道转发的 VMess-WS 内核配置】
  // 注意：inbound 只监听本地回环地址，真正对外暴露的是 cloudflared 隧道，
  // 而不是像之前那样把 3000 端口直接暴露给平台的公网 HTTPS。
  const config = {
    "log": { "disabled": true, "level": "error" },
    "inbounds": [
      {
        "tag": "vmess-ws-in",
        "type": "vmess",
        "listen": "127.0.0.1",
        "listen_port": parseInt(ARGO_PORT),
        "users": [{ "uuid": UUID }],
        "transport": {
          "type": "ws",
          "path": "/vmess-argo"
        }
      }
    ],
    "outbounds": [{ "type": "direct", "tag": "direct" }]
  };

  fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));

  // 3. 【后台稳定启动内核】
  const runCmd = `nohup ${path.join(FILE_PATH, webRandomName)} run -c ${path.join(FILE_PATH, 'config.json')} >/dev/null 2>&1 &`;
  try {
    exec(runCmd);
    console.log(`VMess 网络内核已启动，本地监听 ${ARGO_PORT} 端口，等待 Argo 隧道转发`);
  } catch (e) { console.error(e); }

  await new Promise(resolve => setTimeout(resolve, 2000));

  // 4. 【启动 cloudflared Argo 隧道】
  await runArgoTunnel();

  await new Promise(resolve => setTimeout(resolve, 3000));
  await extractDomains();
}

// 若使用固定隧道（TunnelSecret JSON 凭证），提前写好 tunnel.json / tunnel.yml
function argoType() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) {
    console.log("ARGO_DOMAIN 或 ARGO_AUTH 为空，将使用临时隧道 (trycloudflare.com)");
    return;
  }

  if (ARGO_AUTH.includes('TunnelSecret')) {
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
    const tunnelYaml = `
tunnel: ${ARGO_AUTH.split('"')[11]}
credentials-file: ${path.join(FILE_PATH, 'tunnel.json')}
protocol: http2

ingress:
  - hostname: ${ARGO_DOMAIN}
    service: http://localhost:${ARGO_PORT}
    originRequest:
      noTLSVerify: true
  - service: http_status:404
`;
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYaml);
  } else {
    console.log(`使用 Token 连接固定隧道，请确保 Cloudflare Zero Trust 后台 Public Hostname 指向本机的 ${ARGO_PORT} 端口`);
  }
}

// 启动 cloudflared：根据 ARGO_AUTH 的形式选择 Token 隧道 / 固定隧道(yml) / 临时隧道
async function runArgoTunnel() {
  if (!fs.existsSync(botPath)) {
    console.log('cloudflared 未就绪，跳过 Argo 隧道启动');
    return;
  }

  let args;
  if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
    // Token 形式：需在 Cloudflare Zero Trust -> Public Hostname 中把 ARGO_DOMAIN 指向 http://localhost:ARGO_PORT
    args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`;
  } else if (ARGO_AUTH.match(/TunnelSecret/)) {
    // 固定隧道 JSON 凭证形式，读取上面 argoType() 生成的 tunnel.yml
    args = `tunnel --edge-ip-version auto --config ${path.join(FILE_PATH, 'tunnel.yml')} run`;
  } else {
    // 临时隧道：不需要任何 Cloudflare 账号配置，域名会打印在 boot.log 里
    args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${bootLogPath} --loglevel info --url http://localhost:${ARGO_PORT}`;
  }

  try {
    await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
    console.log('cloudflared (Argo 隧道) 已在后台启动');
  } catch (e) {
    console.error('cloudflared 启动失败:', e);
  }
}

// 提取 Argo 隧道域名：固定隧道直接用 ARGO_DOMAIN；临时隧道需要从 boot.log 里解析 trycloudflare.com 域名
async function extractDomains() {
  let argoDomain;

  if (ARGO_AUTH && ARGO_DOMAIN) {
    argoDomain = ARGO_DOMAIN;
    console.log('使用固定 Argo 域名:', argoDomain);
    await generateLinks(argoDomain);
    return;
  }

  try {
    const fileContent = fs.readFileSync(bootLogPath, 'utf-8');
    const lines = fileContent.split('\n');
    const argoDomains = [];
    lines.forEach((line) => {
      const domainMatch = line.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
      if (domainMatch) argoDomains.push(domainMatch[1]);
    });

    if (argoDomains.length > 0) {
      argoDomain = argoDomains[0];
      console.log('临时 Argo 域名:', argoDomain);
      await generateLinks(argoDomain);
    } else {
      console.log('尚未获取到临时 Argo 域名，3 秒后重试...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      await extractDomains();
    }
  } catch (error) {
    console.log('boot.log 还未生成，3 秒后重试...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await extractDomains();
  }
}

// 自动生成节点并推送到你的订阅/TG（现在走 Argo 域名，而不是直连平台域名）
async function generateLinks(argoDomain) {
  let ISP = 'Unknown';
  try {
    const metaInfo = execSync('curl -s https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'', { encoding: 'utf-8' });
    ISP = metaInfo.trim() || 'Unknown';
  } catch (e) {}

  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;

  // 构造标准 VMess-WS-TLS 经 Argo 隧道的节点
  // add/port 使用 CFIP/CFPORT（优选 IP 或域名），host/sni 使用 Argo 隧道域名
  const vmessNode = `vmess://${Buffer.from(JSON.stringify({
    v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'auto',
    net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox'
  })).toString('base64')}`;

  const base64Sub = Buffer.from(vmessNode).toString('base64');
  fs.writeFileSync(subPath, base64Sub);
  fs.writeFileSync(listPath, vmessNode, 'utf8');
  subContent = base64Sub; // 供 /sub 路由即时响应

  console.log("你的新 VMess 节点链接 (经 Argo 隧道):", vmessNode);

  // 自动触发你的 TG 机器人推送和订阅服务器上传
  sendTelegram();
  uplodNodes();
}

// 【彻底清除了 90s rm -rf 的逻辑，防止内核文件被删掉线】
function cleanFiles() {
  console.log("已取消 90 秒自动清理，确保网络内核、cloudflared 与 Komari 监控进程能够永久留存运行。");
}

async function sendTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const message = fs.readFileSync(subPath, 'utf8');
    const escapedName = NAME.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, null, {
      params: { chat_id: CHAT_ID, text: `**${escapedName}节点推送通知**\n\`\`\`${message}\`\`\``, parse_mode: 'MarkdownV2' }
    });
  } catch (e) {}
}

async function uplodNodes() {
  if (!UPLOAD_URL) return;
  const content = fs.readFileSync(listPath, 'utf-8');
  const nodes = content.split('\n').filter(line => /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line));
  if (nodes.length === 0) return;
  try {
    await axios.post(`${UPLOAD_URL}/api/add-nodes`, JSON.stringify({ nodes }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {}
}

async function AddVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) return;
  try { await axios.post('https://keep.gvrander.eu.org/add-url', { url: PROJECT_URL }, { headers: { 'Content-Type': 'application/json' } }); } catch (e) {}
}

async function startserver() {
  argoType();
  await downloadFilesAndRun();
  AddVisitTask();
  cleanFiles();
}
startserver();

app.listen(PORT, () => console.log(`服务启动完成，正在监听端口: ${PORT}`));
