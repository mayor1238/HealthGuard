import { loadConfig } from './config';
import { makeCtx } from './context';
import { migrate } from './db/migrations';
import { connect } from './db/sql';
import { seedDemo } from './services/seed';

/** npm run db:migrate | npm run db:seed */
async function main() {
  const cmd = process.argv[2];
  const config = loadConfig();
  const sql = await connect(config.databaseUrl, config.pgliteDir);
  try {
    const applied = await migrate(sql);
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema up to date');
    if (cmd === 'seed') console.log((await seedDemo(makeCtx(sql, config))) ? 'Demo data loaded' : 'Database already has data — seed skipped');
  } finally {
    await sql.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
