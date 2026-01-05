require('dotenv').config();
const { Sequelize } = require('sequelize');

const pgdbconnect = new Sequelize(
  process.env.PGDATABASE,
  process.env.PGUSER,
  process.env.PGPASSWORD,
  {
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT || 5432,
    dialect: 'postgres',
    logging: console.log,
    dialectOptions: {
      ssl: {
        require: false,
        rejectUnauthorized: false
      }
    }
  }
);

(async () => {
  try {
    await pgdbconnect.authenticate();
    console.log('✅ Connected to PostgreSQL');

    // Drop the job_runs table
    await pgdbconnect.query('DROP TABLE IF EXISTS job_runs CASCADE;');
    console.log('✅ Dropped job_runs table');

    // Drop the enum types
    await pgdbconnect.query('DROP TYPE IF EXISTS "enum_job_runs_status" CASCADE;');
    console.log('✅ Dropped enum_job_runs_status type');

    await pgdbconnect.query('DROP TYPE IF EXISTS "enum_job_runs_trigger_type" CASCADE;');
    console.log('✅ Dropped enum_job_runs_trigger_type type');

    console.log('\n✅ Cleanup complete! You can now restart the server.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
})();
