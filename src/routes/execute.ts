import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { WhatsAppHandler } from '../handlers/WhatsAppHandler.js';

const executeSchema = z.object({
  action: z.string(),
  params: z.record(z.string(), z.any()).optional(),
});

export const executeRoutes = async (fastify: FastifyInstance) => {
  fastify.post('/execute', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = executeSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({ 
        error: 'Invalid payload', 
        details: parseResult.error.format() 
      });
    }

    const { action, params } = parseResult.data;

    try {
      let result;

      if (action.startsWith('whatsapp:')) {
        result = await WhatsAppHandler.handle(action, params || {});
      } else if (action === 'system:ping') {
        result = { status: 'pong', timestamp: new Date().toISOString() };
      } else {
        return reply.status(400).send({ error: `Unknown action: ${action}` });
      }

      return { success: true, data: result };
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error executing action';
      fastify.log.error(`Error executing action ${action}: ${errorMessage}`);
      return reply.status(500).send({ 
        success: false, 
        error: errorMessage 
      });
    }
  });
};
