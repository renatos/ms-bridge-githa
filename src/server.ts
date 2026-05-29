import Fastify from 'fastify';
import { env } from './config/index.js';
import { authMiddleware } from './middleware/auth.js';
import { executeRoutes } from './routes/execute.js';
import { WhatsAppService } from './core/WhatsAppService.js';

const fastify = Fastify({
  logger: true,
});

// Health check
fastify.get('/health', async () => {
  const wsStatus = WhatsAppService.getStatus();
  return { 
    status: 'ok', 
    version: '1.0.0',
    whatsapp: wsStatus
  };
});

// API Routes
fastify.register(async (instance) => {
  // Global Auth for all routes in this group
  instance.addHook('preHandler', authMiddleware);
  
  instance.register(executeRoutes, { prefix: '/v1' });
}, { prefix: '/api' });

const start = async () => {
  try {
    // Initialize WhatsApp client
    await WhatsAppService.initialize();

    await fastify.listen({ 
      port: env.PORT, 
      host: '0.0.0.0' // Allow access from containers
    });
    console.log(`🚀 Githa Bridge running on http://localhost:${env.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
