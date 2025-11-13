/**
 * JobIdService
 *
 * Generates unique job identifiers for contact processing runs.
 * JobID format: {project_origin}_{timestamp}_{random}
 *
 * Examples:
 * - OCD_IMAGING_20251112235900_a3f9
 * - OCD_CBT_20251113235900_7b2e
 */
class JobIdService {
  /**
   * Generate a unique job ID for a processing run
   * @param {string} projectOrigin - The project origin (e.g., 'OCD_IMAGING', 'OCD_CBT')
   * @returns {string} Unique job ID
   */
  generateJobId(projectOrigin) {
    // Format: YYYYMMDDHHMMSS
    const timestamp = new Date().toISOString()
      .replace(/[-:]/g, '')      // Remove dashes and colons
      .replace(/\..+/, '')        // Remove milliseconds
      .replace('T', '');          // Remove T separator

    // Generate 4-character random suffix for uniqueness
    const random = Math.random().toString(36).substr(2, 4);

    return `${projectOrigin}_${timestamp}_${random}`;
  }

  /**
   * Parse a job ID back into its components
   * @param {string} jobId - The job ID to parse
   * @returns {object} Object with projectOrigin, timestamp, and random components
   */
  parseJobId(jobId) {
    if (!jobId) return null;

    const parts = jobId.split('_');
    if (parts.length < 3) return null;

    // Handle project origins that might contain underscores (e.g., OCD_IMAGING)
    const random = parts.pop();
    const timestamp = parts.pop();
    const projectOrigin = parts.join('_');

    return {
      projectOrigin,
      timestamp,
      random,
      date: this.parseTimestamp(timestamp)
    };
  }

  /**
   * Parse timestamp string back to Date object
   * @param {string} timestamp - Timestamp in format YYYYMMDDHHMMSS
   * @returns {Date|null} Date object or null if invalid
   */
  parseTimestamp(timestamp) {
    if (!timestamp || timestamp.length !== 14) return null;

    const year = timestamp.substr(0, 4);
    const month = timestamp.substr(4, 2);
    const day = timestamp.substr(6, 2);
    const hour = timestamp.substr(8, 2);
    const minute = timestamp.substr(10, 2);
    const second = timestamp.substr(12, 2);

    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  }

  /**
   * Extract project origin from a job ID
   * @param {string} jobId - The job ID
   * @returns {string|null} Project origin or null
   */
  getProjectOrigin(jobId) {
    const parsed = this.parseJobId(jobId);
    return parsed ? parsed.projectOrigin : null;
  }

  /**
   * Check if a job ID is valid
   * @param {string} jobId - The job ID to validate
   * @returns {boolean} True if valid
   */
  isValidJobId(jobId) {
    if (!jobId || typeof jobId !== 'string') return false;
    const parsed = this.parseJobId(jobId);
    return parsed !== null && parsed.date !== null;
  }
}

// Export singleton instance
module.exports = new JobIdService();
