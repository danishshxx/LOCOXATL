const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMigrationTarget } = require('../src/server/migrate-cli');

test('local migrations only allow locoxatl outside production', () => {
  const railwayProduction = {
    NODE_ENV: 'production',
    RAILWAY_PROJECT_NAME: 'Locoxatl',
    RAILWAY_ENVIRONMENT_NAME: 'production',
    RAILWAY_SERVICE_NAME: 'locoxatl-app',
    CONFIRM_DB_MIGRATION: 'locoxatl',
  };
  assert.doesNotThrow(() => validateMigrationTarget({ DB_NAME: 'locoxatl' }));
  assert.doesNotThrow(() => validateMigrationTarget({ NODE_ENV: 'development', DB_NAME: 'locoxatl' }));
  assert.throws(
    () => validateMigrationTarget({ ...railwayProduction, DB_NAME: 'locoxatl' }),
    /DB_NAME must be exactly "railway"/,
  );
  assert.throws(
    () => validateMigrationTarget({ NODE_ENV: 'development', DB_NAME: 'railway' }),
    /DB_NAME must be exactly "locoxatl"/,
  );
  assert.throws(
    () => validateMigrationTarget({ NODE_ENV: 'staging', DB_NAME: 'locoxatl' }),
    /only local development and production/,
  );
});

test('production migrations require the railway target and explicit confirmation', () => {
  const railwayProduction = {
    NODE_ENV: 'production',
    RAILWAY_PROJECT_NAME: 'Locoxatl',
    RAILWAY_ENVIRONMENT_NAME: 'production',
    RAILWAY_SERVICE_NAME: 'locoxatl-app',
    DB_NAME: 'railway',
    CONFIRM_DB_MIGRATION: 'railway',
  };
  assert.throws(
    () => validateMigrationTarget({ ...railwayProduction, CONFIRM_DB_MIGRATION: undefined }),
    /CONFIRM_DB_MIGRATION=railway/,
  );
  assert.throws(
    () => validateMigrationTarget({ ...railwayProduction, CONFIRM_DB_MIGRATION: 'locoxatl' }),
    /CONFIRM_DB_MIGRATION=railway/,
  );
  assert.doesNotThrow(() => validateMigrationTarget(railwayProduction));
  assert.throws(
    () => validateMigrationTarget({ ...railwayProduction, DB_NAME: 'railway-test' }),
    /DB_NAME must be exactly "railway"/,
  );
  assert.throws(
    () => validateMigrationTarget({ ...railwayProduction, RAILWAY_SERVICE_NAME: 'MySQL' }),
    /Locoxatl\/production\/locoxatl-app on Railway/,
  );
  assert.throws(
    () => validateMigrationTarget({ ...railwayProduction, RAILWAY_PROJECT_NAME: 'Other' }),
    /Locoxatl\/production\/locoxatl-app on Railway/,
  );
  assert.throws(
    () => validateMigrationTarget({
      NODE_ENV: 'development',
      RAILWAY_ENVIRONMENT_NAME: 'production',
      DB_NAME: 'locoxatl',
    }),
    /Railway production requires NODE_ENV=production/,
  );
});
