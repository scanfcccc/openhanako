// plugins/gateway-bridge/gateway-client.js
// WebSocket + device auth 客户端，发送消息给滨面 Gateway 并流式接收回复
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const GATEWAY_URL = 'wss://claw.13ehappy.com:18789';
const PASSWORD = 'Ruijie@123';
const SESSION_KEY = 'agent:main:d_laoshi';
const IDENTITY_PATH = path.join(os.homedir(), '.openclaw/identity/device.json');

function loadIdentity() {
  return JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
}

function buildConnectParams(ident, nonce, ts) {
  const { deviceId, privateKeyPem } = ident;
  const sigPayload = `v2|${deviceId}|cli|cli|operator|operator.read,operator.write|${ts}||${nonce}`;
  const signature = crypto.sign(null, Buffer.from(sigPayload), privateKeyPem).toString('base64');

  // 从 PEM 提取 raw public key（去掉 SPKI 头部 12 字节）
  const pubKeyObj = crypto.createPublicKey(ident.publicKeyPem);
  const rawPub = pubKeyObj.export({ type: 'spki', format: 'der' })
    .slice(12)
    .toString('base64');

  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: 'cli', version: '1.0', platform: 'windows', mode: 'cli' },
    role: 'operator',
    scopes: ['operator.read', 'operator.write'],
    auth: { password: PASSWORD },
    device: {
      id: deviceId,
      publicKey: rawPub,
      nonce,
      signature,
      signedAt: ts,
    },
    locale: 'zh-CN',
  };
}

/**
 * 发送消息给滨面，等待流式回复完成
 * @param {string} message - 要发送的消息
 * @param {number} [timeoutMs=60000] - 超时时间（毫秒）
 * @param {number} [maxRetries=3] - 最大重试次数
 * @returns {Promise<string>} 滨面的完整回复
 */
async function sendToBainian(message, timeoutMs = 60000, maxRetries = 3) {
  const ident = loadIdentity();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await _doSend(ident, message, timeoutMs);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function _doSend(ident, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL, { rejectUnauthorized: false });
    let fullText = '';
    let done = false;

    const timer = setTimeout(() => {
      done = true;
      ws.close();
      reject(new Error('timeout'));
    }, timeoutMs);

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    ws.on('message', (raw) => {
      if (done) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // 1. 收到 challenge → 用设备身份签名响应
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const { nonce, ts } = msg.payload;
        const connectReq = {
          type: 'req',
          id: crypto.randomUUID(),
          method: 'connect',
          params: buildConnectParams(ident, nonce, ts),
        };
        ws.send(JSON.stringify(connectReq));
        return;
      }

      // 2. connect 成功 → 发送消息
      if (msg.type === 'res' && msg.ok && msg.method !== 'sessions.send') {
        const sendReq = {
          type: 'req',
          id: crypto.randomUUID(),
          method: 'sessions.send',
          params: {
            key: SESSION_KEY,
            message,
            idempotencyKey: crypto.randomUUID(),
          },
        };
        ws.send(JSON.stringify(sendReq));
        return;
      }

      // 3. 流式 agent 事件
      if (msg.type === 'event' && msg.event === 'agent') {
        const payload = msg.payload || {};
        const dataObj = payload.data || {};
        if (payload.stream === 'assistant' && dataObj.delta) {
          fullText += dataObj.delta;
        }
        return;
      }

      // 4. session 完成
      if (msg.type === 'event' && msg.event === 'sessions.changed') {
        if (msg.payload?.phase === 'done') {
          cleanup();
          resolve(fullText);
        }
        return;
      }

      // 5. send 确认（继续等流式事件）
      if (msg.type === 'res' && msg.id && msg.ok) {
        return;
      }

      // 6. 错误
      if (msg.type === 'res' && !msg.ok) {
        cleanup();
        reject(new Error(msg.error?.message || 'unknown error'));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('close', () => {
      clearTimeout(timer);
      // 如果已经收到内容但没收到 done 事件，也返回文本
      if (fullText) resolve(fullText);
    });
  });
}

export { sendToBainian };
