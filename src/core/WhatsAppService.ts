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

      let phone: string | null = null;
      let whatsAppLid: string | null = null;

      if (msg.from.endsWith('@lid')) {
        whatsAppLid = msg.from.replace('@lid', '');
        try {
          if (typeof this.client.getContactLidAndPhone === 'function') {
            const details = await this.client.getContactLidAndPhone([msg.from]);
            if (details && details.length > 0 && details[0]?.pn) {
              phone = details[0].pn;
            }
          }
          if (!phone && typeof msg.getContact === 'function') {
            const contact = await msg.getContact();
            if (contact && contact.number && !contact.number.includes('@')) {
              phone = contact.number;
            }
          }
        } catch (err: any) {
          console.warn(`[WhatsAppService] Could not resolve phone from LID (${msg.from}): ${err.message}`);
        }
      } else {
        phone = msg.from.replace('@c.us', '');
      }

      const cleanFrom = phone || whatsAppLid || msg.from;
      const profileName = msg._data?.notifyName || msg._data?.pushname || msg._data?.name || null;
      const conversation = this.activeConversations.get(cleanFrom);
      const targetLogin = conversation ? conversation.login : null;
      const targetRole = conversation ? conversation.role : null;

      // 1. Dispatch incoming message to githa-backend for Lead management
      if (env.GITHA_BACKEND_URL) {
        const leadPayload = {
          timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString().replace('Z', '') : new Date().toISOString().replace('Z', ''),
          phone: phone,
          whatsAppLid: whatsAppLid,
          message: msg.body,
          profileName: profileName
        };

        fetch(`${env.GITHA_BACKEND_URL}/api/leads/incoming`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bridge-Secret': env.GITHA_BRIDGE_SECRET || env.GITHA_BRIDGE_API_KEY
          },
          body: JSON.stringify(leadPayload)
        }).then(res => {
          if (!res.ok) {
            console.error(`[WhatsAppService] Lead dispatch failed with status: ${res.status}`);
          } else {
            console.log(`[WhatsAppService] Lead message forwarded to githa-backend (phone=${phone}, lid=${whatsAppLid})`);
          }
        }).catch((err: any) => {
          console.error(`[WhatsAppService] Error forwarding lead to githa-backend: ${err.message}`);
        });
      } else {
        console.warn('[WhatsAppService] GITHA_BACKEND_URL not configured. Lead message will not be registered.');
      }

      // 2. Dispatch to ms-webhook-githa ONLY for targeted active conversations (avoids spamming all sessions globally)
      if (env.GITHA_WEBHOOK_URL && (targetLogin || targetRole)) {
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
            console.log(`[WhatsAppService] Webhook successfully sent to ${env.GITHA_WEBHOOK_URL} for target ${targetLogin || targetRole}`);
          }
        } catch (err: any) {
          console.error(`[WhatsAppService] Error dispatching webhook to ${env.GITHA_WEBHOOK_URL}: ${err.message}`);
        }
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

    let chatId = to.trim();
    let conversationKey = chatId.replace('@lid', '').replace('@c.us', '');

    if (chatId.endsWith('@lid') || chatId.endsWith('@c.us')) {
      // already contains suffix
    } else if (chatId.length >= 14 && !chatId.startsWith('55')) {
      chatId = `${chatId}@lid`;
    } else {
      let normalizedTo = chatId.replace(/\D/g, '');
      if (normalizedTo.length === 10 || normalizedTo.length === 11) {
        normalizedTo = '55' + normalizedTo;
      }
      chatId = `${normalizedTo}@c.us`;
      conversationKey = normalizedTo;
    }

    console.log(`[WhatsAppService] Sending message to: ${chatId}`);
    const response = await this.client.sendMessage(chatId, message);

    if (login && role) {
      this.activeConversations.set(conversationKey, { login, role });
      console.log(`[WhatsAppService] Associated conversation for ${conversationKey} to login ${login}`);
    }

    return {
      id: response?.id?.id ?? null,
      to: response?.to ?? null,
      timestamp: response?.timestamp ?? null
    };
  }

  public static getStatus(): { initialized: boolean; ready: boolean } {
    return {
      initialized: !!this.client,
      ready: this.isReady
    };
  }
}
