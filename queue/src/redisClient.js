import Redis from 'ioredis';

// `rediss://` URLs (Upstash and most managed Redis) enable TLS automatically.
export function createRedisClient(url) {
  const client = new Redis(url, { maxRetriesPerRequest: null });
  client.on('error', (err) => console.error('[redis] connection error:', err.message));
  return client;
}
