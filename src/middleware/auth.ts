import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/index.js';

export const authMiddleware = async (request: FastifyRequest, reply: FastifyReply) => {
  const apiKey = request.headers['x-api-key'];

  if (!apiKey || apiKey !== env.GITHA_BRIDGE_API_KEY) {
    console.warn(`[Auth] Unauthorized attempt. Received: "${apiKey}", Expected: "${env.GITHA_BRIDGE_API_KEY}"`);
    return reply.status(401).send({ error: 'Unauthorized: Invalid or missing API Key' });
  }
};
