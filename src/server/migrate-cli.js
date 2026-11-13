const { isConfigured, checkConnection, closePool } = require('./db');
const { runAdditiveMigrations } = require('./migrate');

async function main() {
  if (!isConfigured()) {
    throw new Error('Database is not configured. Set DB_HOST, DB_USER, and DB_NAME before migrating.');
  }
  if (process.env.DB_NAME !== 'locoxatl') {
    throw new Error('Refusing to migrate: DB_NAME must be exactly "locoxatl".');
  }

  await checkConnection();
  const result = await runAdditiveMigrations();
  if (!result.success) {
    throw new Error('Database migration did not complete.');
  }
  process.stdout.write('LOCOXATL additive migrations completed successfully.\n');
}

main()
  .catch((error) => {
    process.stderr.write(`Database migration failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(closePool);
