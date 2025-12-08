require('dotenv').config();
const ExtractionPromptService = require('../services/extraction-prompt.service.js');

/**
 * Extraction Prompt Controller
 *
 * API endpoints for managing extraction prompts
 * Enables clients to view, create, update, and rollback prompts
 */
class ExtractionPromptController {
  constructor() {
    this.extractionPromptService = new ExtractionPromptService();
  }

  /**
   * GET /v1/extraction-prompts
   * List all prompts with optional filtering
   */
  async getAllPrompts(req, res) {
    try {
      const filters = {
        is_active: req.query.is_active === 'true' ? true : req.query.is_active === 'false' ? false : undefined,
        is_default: req.query.is_default === 'true' ? true : req.query.is_default === 'false' ? false : undefined,
        project_origin: req.query.project_origin,
        document_type: req.query.document_type,
        search: req.query.search
      };

      const result = await this.extractionPromptService.getAllPrompts(filters);

      res.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      console.error('Error in getAllPrompts:', error.message);
      res.status(500).json({
        success: false,
        message: `Failed to fetch prompts: ${error.message}`
      });
    }
  }

  /**
   * GET /v1/extraction-prompts/:key
   * Get a specific prompt by key
   */
  async getPromptByKey(req, res) {
    try {
      const { key } = req.params;
      const variables = req.query.variables ? JSON.parse(req.query.variables) : {};

      const result = await this.extractionPromptService.getPromptByKey(key, variables);

      res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
      console.error(`Error in getPromptByKey:`, error.message);
      res.status(500).json({
        success: false,
        message: `Failed to fetch prompt: ${error.message}`
      });
    }
  }

  /**
   * GET /v1/extraction-prompts/project/:projectOrigin
   * Get all prompts for a specific project origin
   */
  async getPromptsForProject(req, res) {
    try {
      const { projectOrigin } = req.params;

      const result = await this.extractionPromptService.getPromptsForProject(projectOrigin);

      res.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      console.error('Error in getPromptsForProject:', error.message);
      res.status(500).json({
        success: false,
        message: `Failed to fetch prompts: ${error.message}`
      });
    }
  }

  /**
   * POST /v1/extraction-prompts
   * Create a new prompt
   */
  async createPrompt(req, res) {
    try {
      const promptData = req.body;
      const createdBy = req.body.created_by || 'api';

      const result = await this.extractionPromptService.createPrompt(promptData, createdBy);

      res.status(result.success ? 201 : 400).json(result);
    } catch (error) {
      console.error('Error in createPrompt:', error.message);
      res.status(500).json({
        success: false,
        message: `Failed to create prompt: ${error.message}`
      });
    }
  }

  /**
   * PUT /v1/extraction-prompts/:key
   * Update an existing prompt
   */
  async updatePrompt(req, res) {
    try {
      const { key } = req.params;
      const updates = req.body;
      const updatedBy = req.body.updated_by || 'api';
      const changesSummary = req.body.changes_summary;

      const result = await this.extractionPromptService.updatePrompt(key, updates, updatedBy, changesSummary);

      res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
      console.error(`Error in updatePrompt:`, error.message);
      res.status(500).json({
        success: false,
        message: `Failed to update prompt: ${error.message}`
      });
    }
  }

  /**
   * DELETE /v1/extraction-prompts/:key
   * Delete (deactivate) a prompt
   */
  async deletePrompt(req, res) {
    try {
      const { key } = req.params;
      const deletedBy = req.body.deleted_by || 'api';

      const result = await this.extractionPromptService.deletePrompt(key, deletedBy);

      res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
      console.error(`Error in deletePrompt:`, error.message);
      res.status(500).json({
        success: false,
        message: `Failed to delete prompt: ${error.message}`
      });
    }
  }

  /**
   * GET /v1/extraction-prompts/:key/versions
   * Get version history for a prompt
   */
  async getVersionHistory(req, res) {
    try {
      const { key } = req.params;

      const result = await this.extractionPromptService.getVersionHistory(key);

      res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
      console.error(`Error in getVersionHistory:`, error.message);
      res.status(500).json({
        success: false,
        message: `Failed to fetch version history: ${error.message}`
      });
    }
  }

  /**
   * POST /v1/extraction-prompts/:key/rollback
   * Rollback to a specific version
   */
  async rollbackToVersion(req, res) {
    try {
      const { key } = req.params;
      const { version } = req.body;
      const rolledBackBy = req.body.rolled_back_by || 'api';

      if (!version) {
        return res.status(400).json({
          success: false,
          message: 'Version number is required in request body'
        });
      }

      const result = await this.extractionPromptService.rollbackToVersion(key, version, rolledBackBy);

      res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
      console.error(`Error in rollbackToVersion:`, error.message);
      res.status(500).json({
        success: false,
        message: `Failed to rollback: ${error.message}`
      });
    }
  }

  /**
   * GET /v1/extraction-prompts/stats
   * Get statistics about prompts
   */
  async getStatistics(req, res) {
    try {
      const result = await this.extractionPromptService.getStatistics();

      res.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      console.error('Error in getStatistics:', error.message);
      res.status(500).json({
        success: false,
        message: `Failed to fetch statistics: ${error.message}`
      });
    }
  }
}

// Create single instance
const extractionPromptController = new ExtractionPromptController();

// Export controller
module.exports.Controller = { ExtractionPromptController: extractionPromptController };
module.exports.controller = (app) => {
  console.log('🔧 Loading Extraction Prompt controller routes...');

  // Prompt management endpoints
  app.get('/v1/extraction-prompts', (req, res) => extractionPromptController.getAllPrompts(req, res));
  app.get('/v1/extraction-prompts/stats', (req, res) => extractionPromptController.getStatistics(req, res));
  app.get('/v1/extraction-prompts/project/:projectOrigin', (req, res) => extractionPromptController.getPromptsForProject(req, res));
  app.get('/v1/extraction-prompts/:key', (req, res) => extractionPromptController.getPromptByKey(req, res));
  app.post('/v1/extraction-prompts', (req, res) => extractionPromptController.createPrompt(req, res));
  app.put('/v1/extraction-prompts/:key', (req, res) => extractionPromptController.updatePrompt(req, res));
  app.delete('/v1/extraction-prompts/:key', (req, res) => extractionPromptController.deletePrompt(req, res));

  // Version management endpoints
  app.get('/v1/extraction-prompts/:key/versions', (req, res) => extractionPromptController.getVersionHistory(req, res));
  app.post('/v1/extraction-prompts/:key/rollback', (req, res) => extractionPromptController.rollbackToVersion(req, res));

  console.log('✅ Extraction Prompt controller routes loaded successfully');
};
