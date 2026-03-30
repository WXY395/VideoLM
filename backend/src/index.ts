import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { configRoutes } from './routes/config';
import { summarizeRoutes } from './routes/summarize';

export interface Env {
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS: allow requests from any Chrome extension origin
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return '*';
      if (origin.startsWith('chrome-extension://')) return origin;
      // Allow localhost for development
      if (origin.startsWith('http://localhost')) return origin;
      return '';
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  })
);

// Health / info endpoint
app.get('/', (c) => {
  return c.json({ name: 'VideoLM API', version: '0.1.0' });
});

// Mount route groups
app.route('/', configRoutes);
app.route('/', summarizeRoutes);

export default app;
