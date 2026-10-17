import { Router } from 'express';
import { CONFIG } from '../config.js';

const router = Router();

// Returns the backend app version. Auth required — mounted behind requireAuth
// in server/index.ts.
router.get('/', (_req, res) => {
  res.json({ version: CONFIG.appVersion });
});

export default router;
