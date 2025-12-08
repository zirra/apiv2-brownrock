const { DataTypes, Model } = require('sequelize');

/**
 * ExtractionPromptVersion Model
 *
 * Stores version history of extraction prompts
 * Enables rollback and audit trail for prompt changes
 */
class ExtractionPromptVersion extends Model {
  static init(sequelize) {
    return super.init({
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      prompt_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'extraction_prompts',
          key: 'id'
        },
        onDelete: 'CASCADE',
        comment: 'Reference to the parent extraction_prompts record'
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Version number of this prompt'
      },
      native_prompt: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'Prompt for PDF vision API at this version'
      },
      text_prompt: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'Prompt for extracted text at this version'
      },
      changes_summary: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Summary of changes made in this version'
      },
      created_by: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'User who created this version'
      }
    }, {
      sequelize,
      modelName: 'ExtractionPromptVersion',
      tableName: 'extraction_prompt_versions',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false, // Versions are immutable
      indexes: [
        {
          unique: true,
          fields: ['prompt_id', 'version']
        },
        {
          fields: ['prompt_id']
        },
        {
          fields: ['created_at']
        }
      ]
    });
  }

  /**
   * Set up associations
   */
  static associate(models) {
    this.belongsTo(models.ExtractionPrompt, {
      foreignKey: 'prompt_id',
      as: 'prompt'
    });
  }

  /**
   * Get all versions for a prompt
   */
  static async getVersionHistory(promptId) {
    return this.findAll({
      where: { prompt_id: promptId },
      order: [['version', 'DESC']],
      attributes: ['id', 'version', 'changes_summary', 'created_by', 'created_at']
    });
  }

  /**
   * Get specific version content
   */
  static async getVersion(promptId, version) {
    return this.findOne({
      where: {
        prompt_id: promptId,
        version
      }
    });
  }
}

module.exports = ExtractionPromptVersion;
