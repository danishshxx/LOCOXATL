const { isConfigured, checkConnection, closePool } = require('./db');
const { runAdditiveMigrations } = require('./migrate');

function validateMigrationTarget(env = process.env) {
  if (env.NODE_ENV === 'production') {
    if (
      env.RAILWAY_PROJECT_NAME !== 'Locoxatl'
      || env.RAILWAY_ENVIRONMENT_NAME !== 'production'
      || env.RAILWAY_SERVICE_NAME !== 'locoxatl-app'
    ) {
      throw new Error('Refusing production migration: run only in Locoxatl/production/locoxatl-app on Railway.');
    }
    if (env.DB_NAME !== 'railway') {
      throw new Error('Refusing production migration: DB_NAME must be exactly "railway".');
    }
    if (env.CONFIRM_DB_MIGRATION !== 'railway') {
      throw new Error('Refusing production migration: set CONFIRM_DB_MIGRATION=railway for this run.');
    }
    return;
  }

  if (env.RAILWAY_ENVIRONMENT_NAME === 'production') {
    throw new Error('Refusing migration: Railway production requires NODE_ENV=production and explicit confirmation.');
  }
  if (env.NODE_ENV && env.NODE_ENV !== 'development') {
    throw new Error('Refusing migration: only local development and production are supported environments.');
  }
  if (env.DB_NAME !== 'locoxatl') {
    throw new Error('Refusing local migration: DB_NAME must be exactly "locoxatl".');
  }
}

async function main() {
  if (!isConfigured()) {
    throw new Error('Database is not configured. Set DB_HOST, DB_USER, and DB_NAME before migrating.');
  }
  validateMigrationTarget();

  await checkConnection();
  const result = await runAdditiveMigrations();
  if (!result.success) {
    throw new Error('Database migration did not complete.');
  }
  process.stdout.write(`LOCOXATL schema and additive migrations completed successfully for "${result.databaseName}".\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`Database migration failed: ${error.message}\n`);
      process.exitCode = 1;
    })
    .finally(closePool);
}

module.exports = { main, validateMigrationTarget };
