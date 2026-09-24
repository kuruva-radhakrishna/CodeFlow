import { createRedisClient } from '@codeflow/queue';
import { config } from '../config/index.js';

export const redis = createRedisClient(config.redisUrl);
