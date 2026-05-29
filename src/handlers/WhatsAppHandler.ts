import { WhatsAppService } from '../core/WhatsAppService.js';

export class WhatsAppHandler {
  static async handle(action: string, params: any) {
    if (action === 'whatsapp:send') {
      return this.sendMessage(params.to, params.message, params.login, params.role);
    }
    throw new Error(`Unsupported WhatsApp action: ${action}`);
  }

  private static async sendMessage(to: string, message: string, login?: string, role?: string): Promise<any> {
    // 1. Normalize number
    let normalizedTo = to.replace(/\D/g, ''); // Keep only digits

    if (normalizedTo.length === 10 || normalizedTo.length === 11) {
      normalizedTo = '55' + normalizedTo;
    }

    console.log(`[WhatsAppHandler] Processing message to: ${normalizedTo}`);

    // 2. Build list of targets (supporting 9th digit fallback for Brazil)
    const targets = [normalizedTo];

    if (normalizedTo.startsWith('55') && normalizedTo.length === 13) {
      const withoutNine = normalizedTo.substring(0, 4) + normalizedTo.substring(5);
      targets.push(withoutNine);
      console.log(`[WhatsAppHandler] Brazilian 13-digit number detected. Will also attempt sending to: ${withoutNine}`);
    }

    // 3. Attempt delivery
    const errors = [];
    for (const target of targets) {
      try {
        const result = await WhatsAppService.sendMessage(target, message, login, role);
        return {
          status: 'completed',
          results: [result]
        };
      } catch (err: any) {
        console.error(`[WhatsAppHandler] Error sending to ${target}: ${err.message}`);
        errors.push({ target, error: err.message });
      }
    }

    throw new Error(`Failed to send message to all targets: ${errors.map(e => `[${e.target}]: ${e.error}`).join(' | ')}`);
  }
}
