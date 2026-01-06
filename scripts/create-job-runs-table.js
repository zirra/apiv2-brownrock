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

    // Create the job_runs table with proper SQL
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS job_runs (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(100) NOT NULL,
        job_type VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        trigger_type VARCHAR(20) NOT NULL DEFAULT 'cron',
        started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE,
        duration_seconds INTEGER,
        total_files INTEGER NOT NULL DEFAULT 0,
        download_failed INTEGER NOT NULL DEFAULT 0,
        validation_failed INTEGER NOT NULL DEFAULT 0,
        processing_failed INTEGER NOT NULL DEFAULT 0,
        successfully_processed INTEGER NOT NULL DEFAULT 0,
        total_contacts INTEGER NOT NULL DEFAULT 0,
        skipped_files JSONB DEFAULT '[]'::jsonb,
        error_message TEXT,
        error_stack TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

        CONSTRAINT job_runs_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        CONSTRAINT job_runs_trigger_type_check CHECK (trigger_type IN ('cron', 'manual', 'api'))
      );

      -- Create unique index on job_id
      CREATE UNIQUE INDEX IF NOT EXISTS job_runs_job_id_unique ON job_runs (job_id);

      -- Create other indexes
      CREATE INDEX IF NOT EXISTS job_runs_type_status_idx ON job_runs (job_type, status);
      CREATE INDEX IF NOT EXISTS job_runs_type_started_idx ON job_runs (job_type, started_at);
      CREATE INDEX IF NOT EXISTS job_runs_status_idx ON job_runs (status);
      CREATE INDEX IF NOT EXISTS job_runs_trigger_type_idx ON job_runs (trigger_type);
      CREATE INDEX IF NOT EXISTS job_runs_started_at_idx ON job_runs (started_at);

      -- Add comments
      COMMENT ON COLUMN job_runs.job_id IS 'Unique job identifier from jobIdService';
      COMMENT ON COLUMN job_runs.job_type IS 'Type of job: OCD_IMAGING, OCD_CBT, OLM, PLC';
      COMMENT ON COLUMN job_runs.status IS 'Current status of the job run';
      COMMENT ON COLUMN job_runs.trigger_type IS 'How the job was triggered';
      COMMENT ON COLUMN job_runs.started_at IS 'When job execution began';
      COMMENT ON COLUMN job_runs.completed_at IS 'When job finished (null if still running)';
      COMMENT ON COLUMN job_runs.duration_seconds IS 'Duration of job execution in seconds';
    `;

    await pgdbconnect.query(createTableSQL);
    console.log('✅ Created job_runs table with proper structure');

    console.log('\n✅ Setup complete! The job_runs table is ready.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
})();
