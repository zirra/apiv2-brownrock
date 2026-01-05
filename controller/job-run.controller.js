const JobRunService = require('../services/job-run.service.js');
const PostgresContactService = require('../services/postgres-contact.service.js');

class JobRunController {
  constructor() {
    this.jobRunService = new JobRunService();
    this.postgresContactService = new PostgresContactService();
  }

  /**
   * GET /v1/job-runs
   * List all job runs with filtering and pagination
   */
  async getJobRuns(req, res) {
    try {
      const {
        job_type,
        status,
        trigger_type,
        start_date,
        end_date,
        limit,
        offset,
        sortBy,
        sortOrder
      } = req.query;

      const result = await this.jobRunService.getJobRuns({
        job_type,
        status,
        trigger_type,
        start_date,
        end_date,
        limit,
        offset,
        sortBy,
        sortOrder
      });

      return res.status(200).json({
        success: true,
        data: result.rows,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error getting job runs:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve job runs',
        message: error.message
      });
    }
  }

  /**
   * GET /v1/job-runs/:job_id
   * Get a specific job run by job ID
   */
  async getJobRunById(req, res) {
    try {
      const { job_id } = req.params;

      if (!job_id) {
        return res.status(400).json({
          success: false,
          error: 'Missing job_id parameter'
        });
      }

      const jobRun = await this.jobRunService.getJobRunById(job_id);

      if (!jobRun) {
        return res.status(404).json({
          success: false,
          error: 'Job run not found',
          job_id
        });
      }

      return res.status(200).json({
        success: true,
        data: jobRun
      });
    } catch (error) {
      console.error('Error getting job run:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve job run',
        message: error.message
      });
    }
  }

  /**
   * GET /v1/job-runs/stats
   * Get aggregate statistics for job runs
   */
  async getJobRunStats(req, res) {
    try {
      const { job_type, start_date, end_date } = req.query;

      const stats = await this.jobRunService.getJobRunStatistics({
        job_type,
        start_date,
        end_date
      });

      return res.status(200).json({
        success: true,
        stats
      });
    } catch (error) {
      console.error('Error getting job run statistics:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve job run statistics',
        message: error.message
      });
    }
  }

  /**
   * GET /v1/job-runs/:job_id/contacts
   * Get contacts associated with a specific job run
   */
  async getJobRunContacts(req, res) {
    try {
      const { job_id } = req.params;
      const { limit = 50, offset = 0 } = req.query;

      if (!job_id) {
        return res.status(400).json({
          success: false,
          error: 'Missing job_id parameter'
        });
      }

      // First verify the job run exists
      const jobRun = await this.jobRunService.getJobRunById(job_id);

      if (!jobRun) {
        return res.status(404).json({
          success: false,
          error: 'Job run not found',
          job_id
        });
      }

      // Get contacts for this job
      const contacts = await this.postgresContactService.getContactsByJobId(
        job_id,
        parseInt(limit),
        parseInt(offset)
      );

      return res.status(200).json({
        success: true,
        job_run: jobRun.getSummary(),
        contacts: contacts.rows,
        pagination: {
          total: contacts.count,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: parseInt(offset) + parseInt(limit) < contacts.count
        }
      });
    } catch (error) {
      console.error('Error getting job run contacts:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve job run contacts',
        message: error.message
      });
    }
  }
}

// Create singleton instance
const jobRunController = new JobRunController();

// Export controller instance
module.exports.Controller = { JobRunController: jobRunController };

// Export route registration function (follows existing pattern)
module.exports.controller = (app) => {
  console.log('Loading JobRun controller routes...');

  // List job runs with filtering
  app.get('/v1/job-runs', (req, res) => jobRunController.getJobRuns(req, res));

  // Get aggregate statistics (must be before /:job_id route)
  app.get('/v1/job-runs/stats', (req, res) => jobRunController.getJobRunStats(req, res));

  // Get specific job run
  app.get('/v1/job-runs/:job_id', (req, res) => jobRunController.getJobRunById(req, res));

  // Get contacts for a job run
  app.get('/v1/job-runs/:job_id/contacts', (req, res) => jobRunController.getJobRunContacts(req, res));

  console.log('JobRun controller routes loaded');
  console.log('  GET /v1/job-runs');
  console.log('  GET /v1/job-runs/stats');
  console.log('  GET /v1/job-runs/:job_id');
  console.log('  GET /v1/job-runs/:job_id/contacts');
};
