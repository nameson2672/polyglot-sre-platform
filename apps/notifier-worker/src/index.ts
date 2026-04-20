// OTel SDK MUST be imported first — before any other instrumented modules
import './telemetry.js';

import { main } from './main.js';
import { logger } from './lib/logger.js';

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error in main');
  process.exit(1);
});
