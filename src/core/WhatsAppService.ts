import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import os from 'os';
import fs from 'fs';

import { env } from '../config/index.js';
import { isMessageDiscarded } from '../config/discardedPhrases.js';

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

    const resolveWithTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
      let timer: any;
      return Promise.race([
        promise.then((res) => {
          clearTimeout(timer);
          return res;
        }),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), ms);
        })
      ]);
    };

    this.client.on('message_create', async (msg: any) => {
      try {
        const isOutbound = Boolean(msg.fromMe);
        const remoteJid = isOutbound ? msg.to : msg.from;

        // Ignorar mensagens de grupos e status/stories
        if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.includes('broadcast') || msg.broadcast || msg.isStatus) {
          return;
        }

        const direction = isOutbound ? 'OUTBOUND' : 'INBOUND';
        console.log(`[WhatsAppService] Message (${direction}) ${isOutbound ? 'sent to ' + remoteJid : 'received from ' + remoteJid}: "${msg.body}"`);

        let phone: string | null = null;
        let whatsAppLid: string | null = null;

        if (remoteJid.endsWith('@lid')) {
          whatsAppLid = remoteJid.replace('@lid', '');
          try {
            if (typeof (this.client as any).getContactLidAndPhone === 'function') {
              const details: any = await resolveWithTimeout(
                (this.client as any).getContactLidAndPhone([remoteJid]),
                1500,
                null
              );
              if (details && Array.isArray(details) && details.length > 0 && details[0]?.pn) {
                phone = details[0].pn;
                console.log(`[WhatsAppService] Resolved phone ${phone} from LID ${whatsAppLid} via getContactLidAndPhone`);
              }
            }
          } catch (err: any) {
            console.warn(`[WhatsAppService] Error in getContactLidAndPhone: ${err.message}`);
          }

          if (!phone) {
            try {
              if (typeof msg.getContact === 'function') {
                const contact: any = await resolveWithTimeout(msg.getContact(), 1500, null);
                if (contact && contact.number && !contact.number.includes('@')) {
                  phone = contact.number;
                  console.log(`[WhatsAppService] Resolved phone ${phone} from LID ${whatsAppLid} via getContact`);
                }
              }
            } catch (err: any) {
              console.warn(`[WhatsAppService] Error in msg.getContact: ${err.message}`);
            }
          }
        } else if (remoteJid) {
          phone = remoteJid.replace('@c.us', '');
        }

        if (phone) {
          phone = phone.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
        }

        // Se não tiver nem telefone nem WhatsApp LID, ignora o despacho
        if (!phone && !whatsAppLid) {
          console.log(`[WhatsAppService] Skipping lead dispatch: neither phone nor LID could be resolved for ${remoteJid}`);
          return;
        }

        const cleanFrom = phone || whatsAppLid || remoteJid;
        const profileName = msg._data?.notifyName || msg._data?.pushname || msg._data?.name || null;
        const conversation = this.activeConversations.get(cleanFrom);
        const targetLogin = conversation ? conversation.login : null;
        const targetRole = conversation ? conversation.role : null;

        // 1. Dispatch message to githa-backend for Lead management
        const backendUrl = (env.GITHA_BACKEND_URL || 'http://127.0.0.1:8080').replace('localhost', '127.0.0.1');
        const epochMs = (msg.timestamp && msg.timestamp > 1e11) ? msg.timestamp : (msg.timestamp ? msg.timestamp * 1000 : Date.now());
        const dateObj = new Date(epochMs);
        const formattedTimestamp = dateObj.toLocaleString('sv-SE', { timeZone: env.TIMEZONE || 'America/Sao_Paulo' }).replace(' ', 'T');
        const messageText = (msg.body && msg.body.trim()) ? msg.body.trim() : (msg.hasMedia ? '[Mídia]' : '[Mensagem]');

        if (isMessageDiscarded(messageText)) {
          console.log(`[WhatsAppService] ⏭️ Skipping lead dispatch: message "${messageText}" is in discarded phrases list.`);
        } else {
          const leadPayload = {
            timestamp: formattedTimestamp,
            phone: phone,
            whatsAppLid: whatsAppLid,
            message: messageText,
            profileName: profileName,
            direction: direction
          };

          console.log(`[WhatsAppService] Forwarding lead message (${direction}) to ${backendUrl}/api/leads/incoming:`, JSON.stringify(leadPayload));

          try {
            const res = await fetch(`${backendUrl}/api/leads/incoming`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Bridge-Secret': env.GITHA_BRIDGE_SECRET || env.GITHA_BRIDGE_API_KEY
              },
              body: JSON.stringify(leadPayload),
              signal: AbortSignal.timeout(5000)
            });

            if (!res.ok) {
              const errorText = await res.text().catch(() => '');
              console.log(`[WhatsAppService] ❌ Lead dispatch FAILED with HTTP ${res.status}: ${errorText}`);
              console.error(`[WhatsAppService] Lead dispatch failed with HTTP ${res.status}: ${errorText}`);
            } else {
              const resData = await res.json().catch(() => null);
              console.log(`[WhatsAppService] ✅ Lead message (${direction}) forwarded to githa-backend successfully! Response:`, JSON.stringify(resData));
            }
          } catch (err: any) {
            console.log(`[WhatsAppService] ❌ Error forwarding lead to githa-backend: ${err.message}`);
            console.error(`[WhatsAppService] Error forwarding lead to githa-backend: ${err.message}`);
          }
        }

        // 2. Dispatch to ms-webhook-githa ONLY for targeted active conversations (avoids spamming all sessions globally)
        const webhookUrl = env.GITHA_WEBHOOK_URL ? env.GITHA_WEBHOOK_URL.replace('localhost', '127.0.0.1') : null;
        if (webhookUrl && (targetLogin || targetRole)) {
          const payload = {
            accountGroupId: null,
            targetLogin,
            targetRole,
            payload: {
              type: 'WHATSAPP_NOTIFICATION',
              data: {
                status: isOutbound ? 'SENT' : 'RECEIVED',
                from: cleanFrom,
                body: msg.body,
                timestamp: msg.timestamp,
                type: msg.type,
                hasMedia: msg.hasMedia,
                direction: direction
              }
            }
          };

          try {
            const response = await fetch(webhookUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-bridge-secret': env.GITHA_BRIDGE_API_KEY
              },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) {
              console.error(`[WhatsAppService] Webhook dispatch failed. Status: ${response.status} - ${response.statusText}`);
            } else {
              console.log(`[WhatsAppService] Webhook successfully sent to ${webhookUrl} for target ${targetLogin || targetRole}`);
            }
          } catch (err: any) {
            console.error(`[WhatsAppService] Error dispatching webhook to ${webhookUrl}: ${err.message}`);
          }
        }
      } catch (globalErr: any) {
        console.error('[WhatsAppService] Unexpected error processing message:', globalErr);
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
