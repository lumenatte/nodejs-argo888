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
const UUID = process.env.UUID || 'c27e0e4c-b504-4832-b675-8a09701a999e';  
const KOMARI_ENDPOINT = process.env.KOMARI_ENDPOINT || 'https://nezha.eluke.dpdns.org'; 
const KOMARI_TOKEN = process.env.KOMARI_TOKEN || '';       
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';         
const CFPORT = process.env.CFPORT || 443;                    
const PORT = process.env.PORT || 3000;                       
const NAME = process.env.NAME || '';                         
const CHAT_ID = process.env.CHAT_ID || '';                   
const BOT_TOKEN = process.env.BOT_TOKEN || '';               

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
let npmPath = path.join(FILE_PATH, npmRandomName);
let webPath = path.join(FILE_PATH, webRandomName);
let subPath = path.join(FILE_PATH, 'sub.txt');
let listPath = path.join(FILE_PATH, 'list.txt');

// 根路由响应平台健康检查
app.get("/", function(req, res) {
  res.send("Server is running perfectly via Northflank HTTP!");
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
    }).catch(err => callback(err.message));
}

// 核心下载逻辑：仅下载运行所需的 sb 内核及 Komari
async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const filesToDownload = [
    { fileName: webRandomName, fileUrl: architecture === 'arm' ? "https://arm64.ssss.nyc.mn/sb" : "https://amd64.ssss.nyc.mn/sb" }
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
  [npmRandomName, webRandomName].forEach(file => {
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

  // 2. 【生成免Argo直连的VMess-WS内核配置】
  const config = {
    "log": { "disabled": true, "level": "error" },
    "inbounds": [
      {
        "tag": "vmess-ws-in",
        "type": "vmess",
        "listen": "::",
        "listen_port": parseInt(PORT), // 监听 3000 端口，接收平台外部 HTTPS 的转发流量
        "users": [{ "uuid": UUID }],
        "transport": {
          "type": "ws",
          "path": "/vmess-direct" // 改为免 Argo 的直连路径
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
    console.log('VMess 网络内核已启动，监听 3000 端口');
  } catch (e) { console.error(e); }

  await new Promise(resolve => setTimeout(resolve, 3000));
  await generateLinks();
}

// 自动生成节点并推送到你的订阅/TG
async function generateLinks() {
  let SERVER_IP = '';
  try { SERVER_IP = execSync('curl -s --max-time 2 ipv4.ip.sb').toString().trim(); } catch (e) {}
  
  const metaInfo = execSync('curl -s https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'', { encoding: 'utf-8' });
  const ISP = metaInfo.trim();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;

  // 这里的域名提取逻辑：如果你配置了 PROJECT_URL 变量，直接采用它的域名部分；
  // 否则，在客户端手动连接时请将 Address 填上你在 Northflank Networking 看到的那个 code.run 域名。
  let directDomain = PROJECT_URL ? PROJECT_URL.replace(/^https?:\/\//, '').split('/')[0] : 'p01--northflank-1--b75y9wsrddcl.code.run';

  // 构造标准 VMess-WS-TLS 直连节点
  const vmessNode = `vmess://${Buffer.from(JSON.stringify({ 
    v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'none', 
    net: 'ws', type: 'none', host: directDomain, path: '/vmess-direct', tls: 'tls', sni: directDomain, alpn: '', fp: 'firefox'
  })).toString('base64')}`;

  fs.writeFileSync(subPath, Buffer.from(vmessNode).toString('base64'));
  fs.writeFileSync(listPath, vmessNode, 'utf8');

  console.log("你的新 VMess 直连节点链接 (Base64前):", vmessNode);

  // 自动触发你的 TG 机器人推送和订阅服务器上传
  sendTelegram();
  uplodNodes();

  // 订阅分发路由支持
  app.get(`/${SUB_PATH}`, (req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(Buffer.from(vmessNode).toString('base64'));
  });
}

// 【彻底清除了 90s rm -rf 的逻辑，防止内核文件被删掉线】
function cleanFiles() {
  console.log("已取消 90 秒自动清理，确保网络内核与 Komari 监控进程能够永久留存运行。");
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
  await downloadFilesAndRun();
  AddVisitTask();
  cleanFiles();
}
startserver();

app.listen(PORT, () => console.log(`服务启动完成，正在监听端口: ${PORT}`));
