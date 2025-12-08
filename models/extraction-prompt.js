const { DataTypes, Model } = require('sequelize');

/**
 * ExtractionPrompt Model
 *
 * Stores Claude AI extraction prompts for document processing
 * Enables client self-service prompt management without code deployments
 */
class ExtractionPrompt extends Model {
  static init(sequelize) {
    return super.init({
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      prompt_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'Unique identifier for the prompt (e.g., "oil-gas-contacts", "ocd-cbt-contacts")'
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'Human-readable name (e.g., "Oil & Gas Contact Extraction")'
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Detailed description of what this prompt extracts and when to use it'
      },
      native_prompt: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'Prompt for PDF vision API (Claude with native PDF support)'
      },
      text_prompt: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'Prompt for extracted text content (fallback when vision unavailable)'
      },
      document_types: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true,
        defaultValue: [],
        comment: 'Document types this prompt handles (e.g., ["oil-gas", "pooling-orders"])'
      },
      project_origins: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true,
        defaultValue: [],
        comment: 'Project origins this prompt is designed for (e.g., ["OCD_IMAGING", "OLM", "PLC"])'
      },
      template_variables: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Template variable definitions and defaults (e.g., {"PROJECT_ORIGIN": "OCD Imaging"})'
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Whether this prompt is available for use'
      },
      is_default: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether this is the default prompt for its document type'
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: 'Current version number (increments with each update)'
      },
      created_by: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'User who created this prompt'
      },
      updated_by: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'User who last updated this prompt'
      }
    }, {
      sequelize,
      modelName: 'ExtractionPrompt',
      tableName: 'extraction_prompts',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          unique: true,
          fields: ['prompt_key']
        },
        {
          fields: ['is_active']
        },
        {
          fields: ['is_default']
        },
        {
          fields: ['project_origins'],
          using: 'GIN'
        },
        {
          fields: ['document_types'],
          using: 'GIN'
        }
      ]
    });
  }

  /**
   * Get prompt with template variables replaced
   */
  getProcessedPrompts(variables = {}) {
    let nativePrompt = this.native_prompt;
    let textPrompt = this.text_prompt;

    // Replace template variables like ${PROJECT_ORIGIN}
    Object.entries(variables).forEach(([key, value]) => {
      const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
      nativePrompt = nativePrompt.replace(pattern, value);
      textPrompt = textPrompt.replace(pattern, value);
    });

    return {
      native: nativePrompt,
      text: textPrompt
    };
  }

  /**
   * Create a new version before updating
   */
  async createVersion() {
    const ExtractionPromptVersion = require('./extraction-prompt-version');

    await ExtractionPromptVersion.create({
      prompt_id: this.id,
      version: this.version,
      native_prompt: this.native_prompt,
      text_prompt: this.text_prompt,
      created_by: this.updated_by
    });
  }

  /**
   * Static method to find prompt by key with template replacement
   */
  static async findByKey(promptKey, variables = {}) {
    const prompt = await this.findOne({
      where: {
        prompt_key: promptKey,
        is_active: true
      }
    });

    if (!prompt) {
      return null;
    }

    return {
      ...prompt.toJSON(),
      prompts: prompt.getProcessedPrompts(variables)
    };
  }

  /**
   * Static method to find default prompt for project origin
   */
  static async findDefaultForProject(projectOrigin) {
    const { Op } = require('sequelize');

    return this.findOne({
      where: {
        project_origins: { [Op.contains]: [projectOrigin] },
        is_default: true,
        is_active: true
      }
    });
  }

  /**
   * Static method to find all active prompts for a project
   */
  static async findAllForProject(projectOrigin) {
    const { Op } = require('sequelize');

    return this.findAll({
      where: {
        project_origins: { [Op.contains]: [projectOrigin] },
        is_active: true
      },
      order: [['is_default', 'DESC'], ['name', 'ASC']]
    });
  }
}

module.exports = ExtractionPrompt;
