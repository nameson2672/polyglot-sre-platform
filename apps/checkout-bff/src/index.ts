import './telemetry.js';
import { start } from './server.js';

start().catch((err: unknown) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
