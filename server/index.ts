import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate } from './db/migrations';
import { connect } from './db/sql';
import { escalateOverdueComplaints } from './services/care';
import { seedDemo } from './services/seed';

async function main() {
  const config = loadConfig();
  const sql = await connect(config.databaseUrl, config.pgliteDir);
  const applied = await migrate(sql);
  const { app, ctx } = await buildApp({ sql, config });
  if (applied.length) app.log.info({ applied }, 'migrations applied');
  if (!config.databaseUrl) app.log.warn('DATABASE_URL not set — using embedded PGlite (development only)');
  if (config.seedDemo && (await seedDemo(ctx))) app.log.info('demo data loaded');

  // Background job: escalate complaints HMOs have ignored past the deadline.
  const timer = setInterval(() => {
    escalateOverdueComplaints(ctx)
      .then((ids) => ids.length && app.log.info({ ids }, 'complaints escalated'))
      .catch((err) => app.log.error(err, 'escalation job failed'));
  }, 15 * 60_000);

  const shutdown = async () => {
    clearInterval(timer);
    await app.close();
    await sql.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
