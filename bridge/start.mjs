/**
 * Sobe a ponte com o Agent SDK real. Uso: `npm run bridge`.
 * Usa o login do Claude Code já existente nesta máquina.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { startBridge } from './server.mjs';

const port = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787);

const bridge = await startBridge({ query, port });
console.log(`JARVIS: ponte ouvindo em ${bridge.url}`);

const shutdown = () => {
  bridge.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
