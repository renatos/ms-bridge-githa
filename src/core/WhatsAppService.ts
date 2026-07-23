import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import os from 'os';
import fs from 'fs';

import { env } from '../config/index.js';

const { Client, LocalAuth } = pkg;

export class WhatsAppService {
  private static instance: any = null;
  private static client: any = null;
  private static isReady = false;
  private static activeConversations = new Map<string, { login: string; role: string }>();

  public static async initialize(): Promise<void> {
    if (this.client) return;

    let executablePath: string | undefined = undefined;

    // Detect Chromium path automatically based on VM or OS paths
    if (os.arch() === 'arm64' || fs.existsSync('/snap/bin/chromium')) {
      executablePath = '/snap/bin/chromium';
    } else if (fs.existsSync('/usr/bin/chromium-browser')) {
      executablePath = '/usr/bin/chromium-browser';
    } else if (fs.existsSync('/usr/bin/chromium')) {
      executablePath = '/usr/bin/chromium';
    }

    console.log(`[WhatsAppService] Initializing with Chromium path: ${executablePath || 'default (bundled)'}`);

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'ms-bridge-githa'
      }),
      puppeteer: {
        headless: true,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      }
    });

    this.client.on('qr', (qr: string) => {
      console.log('[WhatsAppService] Scan this QR Code to connect:');
      qrcode.generate(qr, { small: true });
    });

    this.client.on('ready', () => {
      console.log('[WhatsAppService] WhatsApp client is ready!');
      this.isReady = true;
    });

    this.client.on('message', async (msg: any) => {
      // Ignorar mensagens de grupos por padrão
      if (msg.from.endsWith('@g.us')) {
        return;
      }

      console.log(`[WhatsAppService] New message received from ${msg.from}: "${msg.body}"`);

      if (!env.GITHA_WEBHOOK_URL) {
        console.log('[WhatsAppService] Webhook URL not configured. Skipping forward.');
        return;
      }

      const cleanFrom = msg.from.replace('@c.us', '');
      const conversation = this.activeConversations.get(cleanFrom);
      const targetLogin = conversation ? conversation.login : null;
      const targetRole = conversation ? conversation.role : null;

      const payload = {
        accountGroupId: null,
        targetLogin,
        targetRole,
        payload: {
          type: 'WHATSAPP_NOTIFICATION',
          data: {
            status: 'RECEIVED',
            from: cleanFrom,
            body: msg.body,
            timestamp: msg.timestamp,
            type: msg.type,
            hasMedia: msg.hasMedia
          }
        }
      };

      try {
        const response = await fetch(env.GITHA_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bridge-secret': env.GITHA_BRIDGE_API_KEY
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          console.error(`[WhatsAppService] Webhook dispatch failed. Status: ${response.status} - ${response.statusText}`);
        } else {
          console.log(`[WhatsAppService] Webhook successfully sent to ${env.GITHA_WEBHOOK_URL}`);
        }
      } catch (err: any) {
        console.error(`[WhatsAppService] Error dispatching webhook to ${env.GITHA_WEBHOOK_URL} (ms-webhook-githa might be offline): ${err.message}`);
      }
    });

    this.client.on('auth_failure', (msg: string) => {
      console.error('[WhatsAppService] Authentication failure:', msg);
    });

    this.client.on('disconnected', (reason: string) => {
      console.warn('[WhatsAppService] Client was logged out:', reason);
      this.isReady = false;
    });

    // Start initialization asynchronously so we don't block Fastify startup
    this.client.initialize().catch((err: any) => {
      console.error('[WhatsAppService] Error initializing WhatsApp client:', err);
    });
  }

  public static async sendMessage(to: string, message: string, login?: string, role?: string): Promise<any> {
    if (!this.client || !this.isReady) {
      throw new Error('Sessão do WhatsApp desconectada ou aguardando leitura do QR Code no servidor (isReady = false). Escaneie o QR Code executando os logs do ms-bridge-githa no servidor.');
    }

    // Standardize Brazilian and international formats
    let normalizedTo = to.replace(/\D/g, ''); // Keep only digits

    if (normalizedTo.length === 10 || normalizedTo.length === 11) {
      normalizedTo = '55' + normalizedTo;
    }

    // Append @c.us if not already present
    const chatId = normalizedTo.endsWith('@c.us') ? normalizedTo : `${normalizedTo}@c.us`;

    console.log(`[WhatsAppService] Sending message to: ${chatId}`);
    const response = await this.client.sendMessage(chatId, message);

    if (login && role) {
      this.activeConversations.set(normalizedTo, { login, role });
      console.log(`[WhatsAppService] Associated conversation for ${normalizedTo} to login ${login}`);
    }

    return {
      id: response.id.id,
      to: response.to,
      timestamp: response.timestamp
    };
  }

  public static getStatus(): { initialized: boolean; ready: boolean } {
    return {
      initialized: !!this.client,
      ready: this.isReady
    };
  }
}
