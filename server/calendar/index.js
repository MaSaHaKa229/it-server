// Модуль «Задачи и календарь» внутри портала
import express from 'express';
import { requireAuth, requireRole } from './auth.js';
import { errorHandler } from './validate.js';
import { migrate } from './migrate.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import categoryRoutes from './routes/categories.js';
import taskRoutes from './routes/tasks.js';
import miscRoutes from './routes/misc.js';
import statsRoutes from './routes/stats.js';
import seriesRoutes from './routes/series.js';
import absenceRoutes from './routes/absences.js';
import { startSeriesTimer } from './series.js';

export { migrate };

export function apiRouter() {
  startSeriesTimer(); // повторы периодических задач на год вперёд
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));
  r.get('/health', (req, res) => res.json({ ok: true }));
  r.use('/auth', authRoutes);
  r.use('/users', requireAuth, userRoutes);
  r.use('/categories', requireAuth, categoryRoutes);
  r.use('/tasks', requireAuth, taskRoutes);
  r.use('/series', requireAuth, seriesRoutes);
  r.use('/absences', requireAuth, absenceRoutes);
  // Статистика по сотрудникам и отделу — только администраторы календаря
  r.use('/report', requireAuth, requireRole('admin'), statsRoutes);
  r.use('/', requireAuth, miscRoutes);
  r.use((req, res) => res.status(404).json({ error: 'Не найдено' }));
  r.use(errorHandler);
  return r;
}
