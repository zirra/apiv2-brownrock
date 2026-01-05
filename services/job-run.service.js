const { JobRun } = require('../config/pddbclient.cjs');
const { Op } = require('sequelize');

class JobRunService {
  /**
   * Create a new job run record when a job starts
   * @param {Object} jobData - Job initialization data
   * @param {string} jobData.job_id - Unique job identifier from jobIdService
   * @param {string} jobData.job_type - Type of job (OCD_IMAGING, OCD_CBT, OLM, PLC)
   * @param {string} jobData.trigger_type - How job was triggered (cron, manual, api)
   * @returns {Promise<JobRun>} Created job run record
   */
  async createJobRun({ job_id, job_type, trigger_type = 'cron' }) {
    try {
      console.log(`📝 Creating job run record: ${job_id} (${job_type})`);

      const jobRun = await JobRun.create({
        job_id,
        job_type,
        trigger_type,
        status: 'running',
        started_at: new Date()
      });

      console.log(`✅ Job run record created: ${job_id}`);
      return jobRun;
    } catch (error) {
      console.error(`❌ Failed to create job run record for ${job_id}:`, error.message);
      throw error;
    }
  }

  /**
   * Update a job run with new data
   * @param {string} jobId - Job ID to update
   * @param {Object} updateData - Data to update
   * @returns {Promise<JobRun>} Updated job run record
   */
  async updateJobRun(jobId, updateData) {
    try {
      const jobRun = await JobRun.findOne({ where: { job_id: jobId } });

      if (!jobRun) {
        throw new Error(`Job run not found: ${jobId}`);
      }

      await jobRun.update(updateData);
      return jobRun;
    } catch (error) {
      console.error(`❌ Failed to update job run ${jobId}:`, error.message);
      throw error;
    }
  }

  /**
   * Mark a job as completed with final metrics
   * @param {string} jobId - Job ID to mark as completed
   * @param {Object} metrics - Job metrics
   * @returns {Promise<JobRun>} Updated job run record
   */
  async markJobCompleted(jobId, metrics = {}) {
    try {
      console.log(`✅ Marking job ${jobId} as completed`);

      const jobRun = await JobRun.findOne({ where: { job_id: jobId } });

      if (!jobRun) {
        console.warn(`⚠️ Job run not found: ${jobId}, cannot mark as completed`);
        return null;
      }

      const completed_at = new Date();
      const duration_seconds = Math.round(
        (completed_at - new Date(jobRun.started_at)) / 1000
      );

      // Limit skipped_files to first 100 to prevent large JSON
      const skipped_files = metrics.skipped_files || [];
      const limited_skipped = skipped_files.slice(0, 100);

      if (skipped_files.length > 100) {
        console.log(`⚠️ Limiting skipped_files from ${skipped_files.length} to 100 entries`);
      }

      await jobRun.update({
        status: 'completed',
        completed_at,
        duration_seconds,
        total_files: metrics.total_files || metrics.totalFiles || 0,
        download_failed: metrics.download_failed || metrics.downloadFailed || 0,
        validation_failed: metrics.validation_failed || metrics.validationFailed || 0,
        processing_failed: metrics.processing_failed || metrics.processingFailed || 0,
        successfully_processed: metrics.successfully_processed || metrics.successfullyProcessed || 0,
        total_contacts: metrics.total_contacts || metrics.totalContacts || 0,
        skipped_files: limited_skipped
      });

      console.log(`✅ Job ${jobId} marked as completed (duration: ${duration_seconds}s)`);
      return jobRun;
    } catch (error) {
      console.error(`❌ Failed to mark job ${jobId} as completed:`, error.message);
      throw error;
    }
  }

  /**
   * Mark a job as failed with error details
   * @param {string} jobId - Job ID to mark as failed
   * @param {string} errorMessage - Error message
   * @param {string} errorStack - Error stack trace
   * @param {Object} partialMetrics - Partial metrics collected before failure
   * @returns {Promise<JobRun>} Updated job run record
   */
  async markJobFailed(jobId, errorMessage, errorStack = null, partialMetrics = {}) {
    try {
      console.log(`❌ Marking job ${jobId} as failed: ${errorMessage}`);

      const jobRun = await JobRun.findOne({ where: { job_id: jobId } });

      if (!jobRun) {
        console.warn(`⚠️ Job run not found: ${jobId}, cannot mark as failed`);
        return null;
      }

      const completed_at = new Date();
      const duration_seconds = Math.round(
        (completed_at - new Date(jobRun.started_at)) / 1000
      );

      // Limit skipped_files to first 100
      const skipped_files = partialMetrics.skipped_files || partialMetrics.skippedFiles || [];
      const limited_skipped = skipped_files.slice(0, 100);

      await jobRun.update({
        status: 'failed',
        completed_at,
        duration_seconds,
        error_message: errorMessage,
        error_stack: errorStack,
        total_files: partialMetrics.total_files || partialMetrics.totalFiles || 0,
        download_failed: partialMetrics.download_failed || partialMetrics.downloadFailed || 0,
        validation_failed: partialMetrics.validation_failed || partialMetrics.validationFailed || 0,
        processing_failed: partialMetrics.processing_failed || partialMetrics.processingFailed || 0,
        successfully_processed: partialMetrics.successfully_processed || partialMetrics.successfullyProcessed || 0,
        total_contacts: partialMetrics.total_contacts || partialMetrics.totalContacts || 0,
        skipped_files: limited_skipped
      });

      console.log(`❌ Job ${jobId} marked as failed (duration: ${duration_seconds}s)`);
      return jobRun;
    } catch (error) {
      console.error(`❌ Failed to mark job ${jobId} as failed:`, error.message);
      throw error;
    }
  }

  /**
   * Get job runs with filtering and pagination
   * @param {Object} filters - Query filters
   * @param {string} filters.job_type - Filter by job type
   * @param {string} filters.status - Filter by status
   * @param {string} filters.trigger_type - Filter by trigger type
   * @param {string} filters.start_date - Filter by start date (ISO string)
   * @param {string} filters.end_date - Filter by end date (ISO string)
   * @param {number} filters.limit - Number of results to return (default 50, max 500)
   * @param {number} filters.offset - Number of results to skip (default 0)
   * @param {string} filters.sortBy - Field to sort by (default 'started_at')
   * @param {string} filters.sortOrder - Sort order (ASC/DESC, default DESC)
   * @returns {Promise<Object>} { rows, count, pagination }
   */
  async getJobRuns(filters = {}) {
    try {
      const {
        job_type,
        status,
        trigger_type,
        start_date,
        end_date,
        limit = 50,
        offset = 0,
        sortBy = 'started_at',
        sortOrder = 'DESC'
      } = filters;

      const where = {};

      if (job_type) {
        where.job_type = job_type;
      }

      if (status) {
        where.status = status;
      }

      if (trigger_type) {
        where.trigger_type = trigger_type;
      }

      if (start_date || end_date) {
        where.started_at = {};
        if (start_date) {
          where.started_at[Op.gte] = new Date(start_date);
        }
        if (end_date) {
          where.started_at[Op.lte] = new Date(end_date);
        }
      }

      // Cap limit at 500
      const cappedLimit = Math.min(parseInt(limit) || 50, 500);
      const cappedOffset = parseInt(offset) || 0;

      const { rows, count } = await JobRun.findAndCountAll({
        where,
        limit: cappedLimit,
        offset: cappedOffset,
        order: [[sortBy, sortOrder.toUpperCase()]],
      });

      return {
        rows,
        count,
        pagination: {
          total: count,
          limit: cappedLimit,
          offset: cappedOffset,
          hasMore: cappedOffset + cappedLimit < count
        }
      };
    } catch (error) {
      console.error('❌ Failed to get job runs:', error.message);
      throw error;
    }
  }

  /**
   * Get a single job run by job ID
   * @param {string} jobId - Job ID to retrieve
   * @returns {Promise<JobRun|null>} Job run record or null if not found
   */
  async getJobRunById(jobId) {
    try {
      const jobRun = await JobRun.findOne({
        where: { job_id: jobId }
      });

      return jobRun;
    } catch (error) {
      console.error(`❌ Failed to get job run ${jobId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get aggregate statistics for job runs
   * @param {Object} filters - Query filters
   * @param {string} filters.job_type - Filter by job type
   * @param {string} filters.start_date - Filter by start date (ISO string)
   * @param {string} filters.end_date - Filter by end date (ISO string)
   * @returns {Promise<Object>} Aggregate statistics
   */
  async getJobRunStatistics(filters = {}) {
    try {
      const { job_type, start_date, end_date } = filters;

      const where = {};

      if (job_type) {
        where.job_type = job_type;
      }

      if (start_date || end_date) {
        where.started_at = {};
        if (start_date) {
          where.started_at[Op.gte] = new Date(start_date);
        }
        if (end_date) {
          where.started_at[Op.lte] = new Date(end_date);
        }
      }

      // Get overall stats
      const stats = await JobRun.getStatistics(job_type, start_date, end_date);

      // Get stats by job type if no specific job_type filter
      let by_job_type = null;
      if (!job_type) {
        const jobTypes = ['OCD_IMAGING', 'OCD_CBT', 'OLM', 'PLC'];
        by_job_type = {};

        for (const type of jobTypes) {
          by_job_type[type] = await JobRun.getStatistics(type, start_date, end_date);
        }
      }

      return {
        ...stats,
        by_job_type
      };
    } catch (error) {
      console.error('❌ Failed to get job run statistics:', error.message);
      throw error;
    }
  }

  /**
   * Clean up stale jobs (mark jobs running for more than 24 hours as failed)
   * Should be called on application startup
   * @returns {Promise<number>} Number of jobs cleaned up
   */
  async cleanupStaleJobs() {
    try {
      console.log('🧹 Checking for stale job runs...');

      const staleJobs = await JobRun.findStale();

      if (staleJobs.length === 0) {
        console.log('✅ No stale job runs found');
        return 0;
      }

      console.log(`⚠️ Found ${staleJobs.length} stale job runs, marking as failed...`);

      for (const job of staleJobs) {
        const completed_at = new Date();
        const duration_seconds = Math.round(
          (completed_at - new Date(job.started_at)) / 1000
        );

        await job.update({
          status: 'failed',
          completed_at,
          duration_seconds,
          error_message: 'Job marked as failed due to stale status (running > 24 hours)',
          error_stack: 'Cleaned up on application startup'
        });

        console.log(`   ❌ Marked stale job as failed: ${job.job_id}`);
      }

      console.log(`✅ Cleaned up ${staleJobs.length} stale job runs`);
      return staleJobs.length;
    } catch (error) {
      console.error('❌ Failed to clean up stale jobs:', error.message);
      throw error;
    }
  }
}

module.exports = JobRunService;
