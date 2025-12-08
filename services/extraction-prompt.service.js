const { ExtractionPrompt, ExtractionPromptVersion } = require('../config/pddbclient.cjs');
const { Op } = require('sequelize');

/**
 * Extraction Prompt Management Service
 *
 * Handles CRUD operations and version management for extraction prompts
 */
class ExtractionPromptService {
  /**
   * Get all prompts with optional filtering
   */
  async getAllPrompts(filters = {}) {
    try {
      const where = {};

      if (filters.is_active !== undefined) {
        where.is_active = filters.is_active;
      }

      if (filters.is_default !== undefined) {
        where.is_default = filters.is_default;
      }

      if (filters.project_origin) {
        where.project_origins = { [Op.contains]: [filters.project_origin] };
      }

      if (filters.document_type) {
        where.document_types = { [Op.contains]: [filters.document_type] };
      }

      if (filters.search) {
        where[Op.or] = [
          { name: { [Op.iLike]: `%${filters.search}%` } },
          { description: { [Op.iLike]: `%${filters.search}%` } },
          { prompt_key: { [Op.iLike]: `%${filters.search}%` } }
        ];
      }

      const prompts = await ExtractionPrompt.findAll({
        where,
        order: [
          ['is_default', 'DESC'],
          ['project_origins', 'ASC'],
          ['name', 'ASC']
        ],
        attributes: {
          exclude: ['native_prompt', 'text_prompt'] // Exclude large text fields from list view
        }
      });

      return {
        success: true,
        count: prompts.length,
        prompts
      };
    } catch (error) {
      console.error('Error fetching prompts:', error.message);
      return {
        success: false,
        message: `Failed to fetch prompts: ${error.message}`
      };
    }
  }

  /**
   * Get a specific prompt by key
   */
  async getPromptByKey(promptKey, variables = {}) {
    try {
      const prompt = await ExtractionPrompt.findOne({
        where: { prompt_key: promptKey }
      });

      if (!prompt) {
        return {
          success: false,
          message: `Prompt not found: ${promptKey}`
        };
      }

      // Get processed prompts with template variables replaced
      const processedPrompts = prompt.getProcessedPrompts(variables);

      return {
        success: true,
        prompt: {
          ...prompt.toJSON(),
          processed_prompts: processedPrompts
        }
      };
    } catch (error) {
      console.error(`Error fetching prompt ${promptKey}:`, error.message);
      return {
        success: false,
        message: `Failed to fetch prompt: ${error.message}`
      };
    }
  }

  /**
   * Get prompts for a specific project origin
   */
  async getPromptsForProject(projectOrigin) {
    try {
      const prompts = await ExtractionPrompt.findAll({
        where: {
          project_origins: { [Op.contains]: [projectOrigin] },
          is_active: true
        },
        order: [['is_default', 'DESC'], ['name', 'ASC']]
      });

      return {
        success: true,
        project_origin: projectOrigin,
        count: prompts.length,
        prompts
      };
    } catch (error) {
      console.error(`Error fetching prompts for project ${projectOrigin}:`, error.message);
      return {
        success: false,
        message: `Failed to fetch prompts: ${error.message}`
      };
    }
  }

  /**
   * Create a new prompt
   */
  async createPrompt(promptData, createdBy = 'system') {
    try {
      // Validate required fields
      if (!promptData.prompt_key || !promptData.name || !promptData.native_prompt || !promptData.text_prompt) {
        return {
          success: false,
          message: 'Missing required fields: prompt_key, name, native_prompt, text_prompt'
        };
      }

      // Check if prompt key already exists
      const existing = await ExtractionPrompt.findOne({
        where: { prompt_key: promptData.prompt_key }
      });

      if (existing) {
        return {
          success: false,
          message: `Prompt with key '${promptData.prompt_key}' already exists`
        };
      }

      // Create prompt
      const prompt = await ExtractionPrompt.create({
        ...promptData,
        version: 1,
        created_by: createdBy,
        updated_by: createdBy
      });

      // Create initial version
      await ExtractionPromptVersion.create({
        prompt_id: prompt.id,
        version: 1,
        native_prompt: prompt.native_prompt,
        text_prompt: prompt.text_prompt,
        changes_summary: 'Initial creation',
        created_by: createdBy
      });

      console.log(`✅ Created new prompt: ${promptData.prompt_key}`);

      return {
        success: true,
        message: 'Prompt created successfully',
        prompt
      };
    } catch (error) {
      console.error('Error creating prompt:', error.message);
      return {
        success: false,
        message: `Failed to create prompt: ${error.message}`
      };
    }
  }

  /**
   * Update an existing prompt (creates new version)
   */
  async updatePrompt(promptKey, updates, updatedBy = 'system', changesSummary = null) {
    try {
      const prompt = await ExtractionPrompt.findOne({
        where: { prompt_key: promptKey }
      });

      if (!prompt) {
        return {
          success: false,
          message: `Prompt not found: ${promptKey}`
        };
      }

      // Check if native_prompt or text_prompt changed
      const contentChanged =
        (updates.native_prompt && updates.native_prompt !== prompt.native_prompt) ||
        (updates.text_prompt && updates.text_prompt !== prompt.text_prompt);

      if (contentChanged) {
        // Create version before updating
        await ExtractionPromptVersion.create({
          prompt_id: prompt.id,
          version: prompt.version,
          native_prompt: prompt.native_prompt,
          text_prompt: prompt.text_prompt,
          changes_summary: changesSummary || 'Prompt content updated',
          created_by: updatedBy
        });

        // Increment version
        updates.version = prompt.version + 1;
      }

      // Update prompt
      await prompt.update({
        ...updates,
        updated_by: updatedBy
      });

      console.log(`✅ Updated prompt: ${promptKey} (version ${prompt.version})`);

      return {
        success: true,
        message: 'Prompt updated successfully',
        prompt,
        version_incremented: contentChanged
      };
    } catch (error) {
      console.error(`Error updating prompt ${promptKey}:`, error.message);
      return {
        success: false,
        message: `Failed to update prompt: ${error.message}`
      };
    }
  }

  /**
   * Delete a prompt (soft delete by setting is_active = false)
   */
  async deletePrompt(promptKey, deletedBy = 'system') {
    try {
      const prompt = await ExtractionPrompt.findOne({
        where: { prompt_key: promptKey }
      });

      if (!prompt) {
        return {
          success: false,
          message: `Prompt not found: ${promptKey}`
        };
      }

      // Soft delete
      await prompt.update({
        is_active: false,
        updated_by: deletedBy
      });

      console.log(`✅ Deactivated prompt: ${promptKey}`);

      return {
        success: true,
        message: 'Prompt deactivated successfully'
      };
    } catch (error) {
      console.error(`Error deleting prompt ${promptKey}:`, error.message);
      return {
        success: false,
        message: `Failed to delete prompt: ${error.message}`
      };
    }
  }

  /**
   * Get version history for a prompt
   */
  async getVersionHistory(promptKey) {
    try {
      const prompt = await ExtractionPrompt.findOne({
        where: { prompt_key: promptKey }
      });

      if (!prompt) {
        return {
          success: false,
          message: `Prompt not found: ${promptKey}`
        };
      }

      const versions = await ExtractionPromptVersion.getVersionHistory(prompt.id);

      return {
        success: true,
        prompt_key: promptKey,
        current_version: prompt.version,
        versions
      };
    } catch (error) {
      console.error(`Error fetching version history for ${promptKey}:`, error.message);
      return {
        success: false,
        message: `Failed to fetch version history: ${error.message}`
      };
    }
  }

  /**
   * Rollback to a specific version
   */
  async rollbackToVersion(promptKey, targetVersion, rolledBackBy = 'system') {
    try {
      const prompt = await ExtractionPrompt.findOne({
        where: { prompt_key: promptKey }
      });

      if (!prompt) {
        return {
          success: false,
          message: `Prompt not found: ${promptKey}`
        };
      }

      const version = await ExtractionPromptVersion.getVersion(prompt.id, targetVersion);

      if (!version) {
        return {
          success: false,
          message: `Version ${targetVersion} not found for prompt ${promptKey}`
        };
      }

      // Create version record for current state before rollback
      await ExtractionPromptVersion.create({
        prompt_id: prompt.id,
        version: prompt.version,
        native_prompt: prompt.native_prompt,
        text_prompt: prompt.text_prompt,
        changes_summary: `Before rollback to version ${targetVersion}`,
        created_by: rolledBackBy
      });

      // Update prompt with old version content
      await prompt.update({
        native_prompt: version.native_prompt,
        text_prompt: version.text_prompt,
        version: prompt.version + 1,
        updated_by: rolledBackBy
      });

      // Create version record for rollback
      await ExtractionPromptVersion.create({
        prompt_id: prompt.id,
        version: prompt.version,
        native_prompt: version.native_prompt,
        text_prompt: version.text_prompt,
        changes_summary: `Rolled back to version ${targetVersion}`,
        created_by: rolledBackBy
      });

      console.log(`✅ Rolled back prompt ${promptKey} to version ${targetVersion}`);

      return {
        success: true,
        message: `Successfully rolled back to version ${targetVersion}`,
        prompt,
        rolled_back_from: prompt.version - 1,
        rolled_back_to: targetVersion
      };
    } catch (error) {
      console.error(`Error rolling back prompt ${promptKey}:`, error.message);
      return {
        success: false,
        message: `Failed to rollback: ${error.message}`
      };
    }
  }

  /**
   * Get statistics about prompts
   */
  async getStatistics() {
    try {
      const total = await ExtractionPrompt.count();
      const active = await ExtractionPrompt.count({ where: { is_active: true } });
      const inactive = await ExtractionPrompt.count({ where: { is_active: false } });
      const defaults = await ExtractionPrompt.count({ where: { is_default: true } });

      // Get project distribution
      const allPrompts = await ExtractionPrompt.findAll({
        attributes: ['project_origins'],
        where: { is_active: true }
      });

      const projectCounts = {};
      allPrompts.forEach(prompt => {
        (prompt.project_origins || []).forEach(project => {
          projectCounts[project] = (projectCounts[project] || 0) + 1;
        });
      });

      return {
        success: true,
        statistics: {
          total_prompts: total,
          active_prompts: active,
          inactive_prompts: inactive,
          default_prompts: defaults,
          prompts_by_project: projectCounts
        }
      };
    } catch (error) {
      console.error('Error fetching statistics:', error.message);
      return {
        success: false,
        message: `Failed to fetch statistics: ${error.message}`
      };
    }
  }
}

module.exports = ExtractionPromptService;
