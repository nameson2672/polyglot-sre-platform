import { pino } from 'pino';
import { config, consumerId } from '../config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: {
    service: 'notifier-worker',
    consumer_id: consumerId,
  },
});
