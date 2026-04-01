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
}));

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

app.notFound((c) => c.json({ error: 'Not Found' }, 404));
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

const port = parseInt(process.env.PORT || '8080');
console.log(`Haraka API starting on port ${port}`);
serve({ fetch: app.fetch, port });
