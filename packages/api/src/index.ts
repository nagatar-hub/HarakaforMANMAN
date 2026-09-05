import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { healthRoutes } from './routes/health.js';
import { ruleRoutes } from './routes/rules.js';
import { galleryRoutes } from './routes/gallery.js';
import { runRoutes } from './routes/runs.js';
import { cardRoutes } from './routes/cards.js';
import { dbCardRoutes } from './routes/db-cards.js';
import { postTemplateRoutes } from './routes/post-templates.js';
import { postVariableRoutes } from './routes/post-variables.js';
import { postBannerRoutes } from './routes/post-banners.js';
import { xCredentialRoutes } from './routes/x-credentials.js';
import { postPlanRoutes } from './routes/post-plans.js';
import { storeConfigRoutes } from './routes/store-config.js';
import { customBuybackRoutes } from './routes/custom-buyback.js';
import { orderListImportRoutes } from './routes/order-list-imports.js';
import { STORE_NAME } from './lib/store-scope.js';
import { buildOperatorAuditEntry, persistOperatorAudit } from './lib/operator-audit.js';
import { authorizeInternalMutationRequest, normalizeOperatorEmail } from './lib/internal-api-auth.js';

const app = new Hono();

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return 'http://localhost:3000';
    if (origin.startsWith('http://localhost:')) return origin;
    if (origin.endsWith('.vercel.app')) return origin;
    const allowed = process.env.ALLOWED_ORIGINS?.split(',') || [];
    if (allowed.includes(origin)) return origin;
    return null;
  },
  credentials: true,
  exposeHeaders: ['X-Haraka-Store'],
}));

app.use('*', async (c, next) => {
  c.header('X-Haraka-Store', STORE_NAME);
  const authorization = c.req.header('authorization');
  const requestedActorEmail = c.req.header('x-haraka-operator-email');
  const mutationAuth = authorizeInternalMutationRequest(
    c.req.method,
    authorization,
    undefined,
    requestedActorEmail,
    STORE_NAME,
  );
  if (mutationAuth === 'misconfigured') {
    return c.json({ error: 'APIの認証設定がありません' }, 503);
  }
  if (mutationAuth === 'unauthorized') return c.json({ error: 'Unauthorized' }, 401);
  if (mutationAuth === 'operator_required') {
    return c.json({ error: 'Operator identity required' }, 401);
  }
  const actorEmail = normalizeOperatorEmail(requestedActorEmail) ?? undefined;
  let statusCode = 500;
  try {
    await next();
    statusCode = c.res.status;
  } finally {
    const audit = buildOperatorAuditEntry({
      store: STORE_NAME,
      actorEmail,
      method: c.req.method,
      url: c.req.url,
      statusCode,
      targetId: c.req.header('x-haraka-audit-target-id'),
    });
    if (audit) await persistOperatorAudit(audit);
  }
});

app.route('/api', healthRoutes);
app.route('/api', ruleRoutes);
app.route('/api', galleryRoutes);
app.route('/api', runRoutes);
app.route('/api', cardRoutes);
app.route('/api', dbCardRoutes);
app.route('/api', postTemplateRoutes);
app.route('/api', postVariableRoutes);
app.route('/api', postBannerRoutes);
app.route('/api', xCredentialRoutes);
app.route('/api', postPlanRoutes);
app.route('/api', storeConfigRoutes);
app.route('/api', customBuybackRoutes);
app.route('/api', orderListImportRoutes);

app.notFound((c) => c.json({ error: 'Not Found' }, 404));
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

const port = parseInt(process.env.PORT || '8080');
console.log(`Haraka API starting on port ${port}`);
serve({ fetch: app.fetch, port });
