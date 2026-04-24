import { createHmac } from 'crypto';

export function generateJwt(customerId: string, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ customer_id: customerId, iat: Math.floor(Date.now() / 1000) }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}
