const { DataTypes, Model } = require('sequelize');

class JobRun extends Model {
  static init(sequelize) {
    return super.init({
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      job_id: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'Unique job identifier from jobIdService',
        validate: {
          len: [1, 100],
          notEmpty: true
        }
      },
      job_type: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: 'Type of job: OCD_IMAGING, OCD_CBT, OLM, PLC',
        validate: {
          len: [1, 50],
          notEmpty: true,
          isIn: [['OCD_IMAGING', 'OCD_CBT', 'OLM', 'PLC', 'CTB']]
        }
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'Current status of the job run',
        validate: {
          isIn: [['pending', 'running', 'completed', 'failed']]
        }
      },
      trigger_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'cron',
        comment: 'How the job was triggered',
        validate: {
          isIn: [['cron', 'manual', 'api']]
        }
      },
      started_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: 'When job execution began'
      },
      completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'When job finished (null if still running)'
      },
      duration_seconds: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Duration of job execution in seconds',
        validate: {
          min: 0
        }
      },
      total_files: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Total files attempted to process',
        validate: {
          min: 0
        }
      },
      download_failed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Files that failed to download',
        validate: {
          min: 0
        }
      },
      validation_failed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Files that failed validation',
        validate: {
          min: 0
        }
      },
      processing_failed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Files that failed processing',
        validate: {
          min: 0
        }
      },
      successfully_processed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Files successfully processed',
        validate: {
          min: 0
        }
      },
      total_contacts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Total contacts extracted',
        validate: {
          min: 0
        }
      },
      skipped_files: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
        comment: 'Array of skipped file details: [{file, reason, error}]'
      },
      error_message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Error message if job failed'
      },
      error_stack: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Stack trace if job failed'
      }
    }, {
      sequelize,
      modelName: 'JobRun',
      tableName: 'job_runs',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          unique: true,
          fields: ['job_id'],
          name: 'job_runs_job_id_unique'
        },
        {
          fields: ['job_type', 'status'],
          name: 'job_runs_type_status_idx'
        },
        {
          fields: ['job_type', 'started_at'],
          name: 'job_runs_type_started_idx'
        },
        {
          fields: ['status'],
          name: 'job_runs_status_idx'
        },
        {
          fields: ['trigger_type'],
          name: 'job_runs_trigger_type_idx'
        },
        {
          fields: ['started_at'],
          name: 'job_runs_started_at_idx'
        }
      ]
    });
  }

  // Instance methods

  /**
   * Calculate and set duration in seconds
   */
  calculateDuration() {
    if (this.started_at && this.completed_at) {
      const durationMs = new Date(this.completed_at) - new Date(this.started_at);
      this.duration_seconds = Math.round(durationMs / 1000);
    }
    return this.duration_seconds;
  }

  /**
   * Get success rate percentage
   */
  getSuccessRate() {
    if (this.total_files === 0) return 0;
    return Math.round((this.successfully_processed / this.total_files) * 100);
  }

  /**
   * Get failure count (all types of failures)
   */
  getTotalFailures() {
    return this.download_failed + this.validation_failed + this.processing_failed;
  }

  /**
   * Check if job is still running
   */
  isRunning() {
    return this.status === 'running';
  }

  /**
   * Check if job is stale (running for more than 24 hours)
   */
  isStale() {
    if (!this.isRunning()) return false;
    const hoursSinceStart = (new Date() - new Date(this.started_at)) / (1000 * 60 * 60);
    return hoursSinceStart > 24;
  }

  /**
   * Get formatted summary
   */
  getSummary() {
    return {
      job_id: this.job_id,
      job_type: this.job_type,
      status: this.status,
      trigger_type: this.trigger_type,
      started_at: this.started_at,
      completed_at: this.completed_at,
      duration_seconds: this.duration_seconds,
      success_rate: this.getSuccessRate(),
      total_files: this.total_files,
      successfully_processed: this.successfully_processed,
      total_failures: this.getTotalFailures(),
      total_contacts: this.total_contacts
    };
  }

  // Static methods

  /**
   * Find job runs by job type
   */
  static async findByJobType(jobType) {
    return this.findAll({
      where: { job_type: jobType },
      order: [['started_at', 'DESC']]
    });
  }

  /**
   * Find job runs by status
   */
  static async findByStatus(status) {
    return this.findAll({
      where: { status },
      order: [['started_at', 'DESC']]
    });
  }

  /**
   * Find running jobs
   */
  static async findRunning() {
    return this.findAll({
      where: { status: 'running' },
      order: [['started_at', 'ASC']]
    });
  }

  /**
   * Find stale jobs (running for more than 24 hours)
   */
  static async findStale() {
    const { Op } = require('sequelize');
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return this.findAll({
      where: {
        status: 'running',
        started_at: {
          [Op.lt]: twentyFourHoursAgo
        }
      }
    });
  }

  /**
   * Find recent job runs
   */
  static async findRecent(limit = 50) {
    return this.findAll({
      order: [['started_at', 'DESC']],
      limit
    });
  }

  /**
   * Find job run by job_id
   */
  static async findByJobId(jobId) {
    return this.findOne({
      where: { job_id: jobId }
    });
  }

  /**
   * Get statistics for a job type
   */
  static async getStatistics(jobType = null, startDate = null, endDate = null) {
    const { Op, fn, col } = require('sequelize');
    const where = {};

    if (jobType) {
      where.job_type = jobType;
    }

    if (startDate || endDate) {
      where.started_at = {};
      if (startDate) {
        where.started_at[Op.gte] = new Date(startDate);
      }
      if (endDate) {
        where.started_at[Op.lte] = new Date(endDate);
      }
    }

    const stats = await this.findAll({
      where,
      attributes: [
        [fn('COUNT', col('id')), 'total_runs'],
        [fn('SUM', col('total_files')), 'total_files_processed'],
        [fn('SUM', col('successfully_processed')), 'total_successful'],
        [fn('SUM', col('total_contacts')), 'total_contacts_extracted'],
        [fn('AVG', col('duration_seconds')), 'avg_duration_seconds'],
        [fn('COUNT', col('id')), 'completed_runs']
      ],
      raw: true
    });

    const completedCount = await this.count({
      where: { ...where, status: 'completed' }
    });

    const failedCount = await this.count({
      where: { ...where, status: 'failed' }
    });

    return {
      ...stats[0],
      completed_runs: completedCount,
      failed_runs: failedCount,
      success_rate: stats[0].total_runs > 0
        ? Math.round((completedCount / stats[0].total_runs) * 100)
        : 0
    };
  }
}

module.exports = JobRun;
