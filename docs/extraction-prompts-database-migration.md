# Extraction Prompts Database Migration Plan

## Overview

This document outlines the plan to migrate extraction prompts from a static file-based system to a database-first approach with web interface configuration capability. The goal is to allow customers to adjust and configure prompts from a web interface while maintaining the extraction-prompts.js file as default fallback.

## Current Architecture

### Extraction Prompts Structure
**File:** `prompts/extraction-prompts.js`

Each document type contains an object with two modes:
```javascript
{
  'document-type-key': {
    native: `Prompt for PDF vision processing...`,
    text: `Prompt for text-based processing...`
  }
}
```

### Current Document Types
1. `oil-gas-contacts` - Oil & Gas contact extraction (EMNRD)
2. `oil-gas-contacts-old` - Legacy Oil & Gas extraction
3. `ocd-cbt-contacts` - OCD CBT county-based documents
4. `olm-contacts` - Oil & Mineral Lease documents
5. `plc-contacts` - Pipeline/Location Certificate documents
6. `lease-agreements` - Lease agreement extraction

### Usage Pattern
**Service:** `services/ClaudeContactExtractor.cjs` (line 84)
```javascript
const prompts = extractionPrompts[this.documentType]
return this.substitutePromptVariables(prompts[mode])
```

### Controllers Using Prompts
- **EMNRD Controller** (`controller/emnrd.controller.js`) - Uses `oil-gas-contacts` (default)
- **OCD-CBT Controller** (`controller/ocd-cbt.controller.js`) - Uses `ocd-cbt-contacts`
- **OLM Controller** (`controller/olm.controller.js`) - Uses `olm-contacts`
- **PLC Controller** (`controller/plc.controller.js`) - Uses `plc-contacts`

### Template Variables
- `${PROJECT_ORIGIN}` - Project origin name (e.g., 'OCD_IMAGING')
- `${DOCUMENT_TYPE}` - Document type name
- `${TEXT_CONTENT}` - Placeholder for extracted text content (in 'text' mode)

---

## Proposed Architecture

### Phase 1: Database Schema & Model Creation

#### 1.1 Sequelize Model: `models/extraction-prompt.js`
```javascript
const { DataTypes, Model } = require('sequelize');

class ExtractionPrompt extends Model {
  static init(sequelize) {
    return super.init({
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      document_type: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
        validate: {
          len: [1, 100]
        }
      },
      native_prompt: {
        type: DataTypes.TEXT,
        allowNull: false
      },
      text_prompt: {
        type: DataTypes.TEXT,
        allowNull: false
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      created_by: {
        type: DataTypes.STRING(100),
        allowNull: true
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
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
          fields: ['document_type']
        },
        {
          fields: ['is_active']
        },
        {
          fields: ['created_at']
        }
      ]
    });
  }
}

module.exports = ExtractionPrompt;
```

#### 1.2 Sequelize Model: `models/extraction-prompt-history.js`
```javascript
const { DataTypes, Model } = require('sequelize');

class ExtractionPromptHistory extends Model {
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
        onDelete: 'CASCADE'
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      native_prompt: {
        type: DataTypes.TEXT,
        allowNull: false
      },
      text_prompt: {
        type: DataTypes.TEXT,
        allowNull: false
      },
      changed_by: {
        type: DataTypes.STRING(100),
        allowNull: true
      },
      change_reason: {
        type: DataTypes.TEXT,
        allowNull: true
      }
    }, {
      sequelize,
      modelName: 'ExtractionPromptHistory',
      tableName: 'extraction_prompt_history',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
      indexes: [
        {
          fields: ['prompt_id']
        },
        {
          fields: ['prompt_id', 'version']
        },
        {
          fields: ['created_at']
        }
      ]
    });
  }
}

module.exports = ExtractionPromptHistory;
```

#### 1.3 Seed Migration Script
Create migration to populate initial data from `extraction-prompts.js`:
- Extract all 6 document types
- Insert into `extraction_prompts` table
- Set `created_by` as 'system'
- Set initial `version` as 1

---

### Phase 2: Service Layer Creation

#### 2.1 Service: `services/extraction-prompt.service.js`

```javascript
const extractionPromptsFile = require('../prompts/extraction-prompts.js');

class ExtractionPromptService {
  constructor(sequelize) {
    this.sequelize = sequelize;
    this.ExtractionPrompt = require('../models/extraction-prompt');
    this.ExtractionPromptHistory = require('../models/extraction-prompt-history');
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get prompt by document type and mode
   * Priority: 1. Cache, 2. Database, 3. File fallback
   */
  async getPrompt(documentType, mode, variables = {}) {
    const cacheKey = `${documentType}:${mode}`;

    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        return this.substituteVariables(cached.prompt, variables);
      }
      this.cache.delete(cacheKey);
    }

    // Try database
    try {
      const dbPrompt = await this.ExtractionPrompt.findOne({
        where: {
          document_type: documentType,
          is_active: true
        }
      });

      if (dbPrompt) {
        const promptText = mode === 'native' ? dbPrompt.native_prompt : dbPrompt.text_prompt;
        this.cache.set(cacheKey, { prompt: promptText, timestamp: Date.now() });
        return this.substituteVariables(promptText, variables);
      }
    } catch (error) {
      console.error('Database prompt fetch error:', error.message);
    }

    // Fallback to file
    console.log(`⚠️ Using file fallback for ${documentType}`);
    const filePrompts = extractionPromptsFile[documentType] || extractionPromptsFile['oil-gas-contacts'];
    const promptText = filePrompts[mode] || filePrompts['native'];
    return this.substituteVariables(promptText, variables);
  }

  /**
   * Update prompt in database
   */
  async updatePrompt(documentType, prompts, updatedBy, changeReason) {
    const transaction = await this.sequelize.transaction();

    try {
      const existing = await this.ExtractionPrompt.findOne({
        where: { document_type: documentType }
      });

      if (!existing) {
        throw new Error(`Prompt not found: ${documentType}`);
      }

      // Create history entry
      await this.ExtractionPromptHistory.create({
        prompt_id: existing.id,
        version: existing.version,
        native_prompt: existing.native_prompt,
        text_prompt: existing.text_prompt,
        changed_by: updatedBy,
        change_reason: changeReason
      }, { transaction });

      // Update prompt
      await existing.update({
        native_prompt: prompts.native,
        text_prompt: prompts.text,
        version: existing.version + 1
      }, { transaction });

      await transaction.commit();

      // Invalidate cache
      this.cache.delete(`${documentType}:native`);
      this.cache.delete(`${documentType}:text`);

      return { success: true, version: existing.version + 1 };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  /**
   * Get all available document types
   */
  async getAllPrompts() {
    return await this.ExtractionPrompt.findAll({
      where: { is_active: true },
      order: [['document_type', 'ASC']]
    });
  }

  /**
   * Get prompt history for auditing
   */
  async getPromptHistory(documentType, limit = 10) {
    const prompt = await this.ExtractionPrompt.findOne({
      where: { document_type: documentType }
    });

    if (!prompt) {
      return [];
    }

    return await this.ExtractionPromptHistory.findAll({
      where: { prompt_id: prompt.id },
      order: [['version', 'DESC']],
      limit
    });
  }

  /**
   * Create new prompt
   */
  async createPrompt(documentType, prompts, createdBy, description = null) {
    return await this.ExtractionPrompt.create({
      document_type: documentType,
      native_prompt: prompts.native,
      text_prompt: prompts.text,
      description,
      created_by: createdBy,
      version: 1
    });
  }

  /**
   * Substitute variables in prompt
   */
  substituteVariables(prompt, variables) {
    let result = prompt;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `\${${key}}`;
      result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    }
    return result;
  }

  /**
   * Clear cache (for testing or manual refresh)
   */
  clearCache() {
    this.cache.clear();
  }
}

module.exports = ExtractionPromptService;
```

#### 2.2 Update `services/ClaudeContactExtractor.cjs`

**Changes to constructor** (around line 20-70):
```javascript
constructor(config = {}) {
  // ... existing code ...
  this.promptService = config.promptService || null; // NEW: Inject prompt service
  // ... existing code ...
}
```

**Changes to getPrompt method** (lines 77-91):
```javascript
async getPrompt(mode) {
  // Priority 1: Custom prompts provided directly
  if (this.customPrompts && this.customPrompts[mode]) {
    return this.substitutePromptVariables(this.customPrompts[mode]);
  }

  // Priority 2: Database via service
  if (this.promptService) {
    try {
      const prompt = await this.promptService.getPrompt(
        this.documentType,
        mode,
        this.promptVariables
      );
      return prompt; // Already has variables substituted by service
    } catch (error) {
      this.logger.warn(`⚠️ Failed to get prompt from service: ${error.message}`);
    }
  }

  // Priority 3: File fallback (existing behavior)
  const prompts = extractionPrompts[this.documentType];
  if (!prompts) {
    this.logger.warn(`⚠️ Unknown document type: ${this.documentType}, falling back to oil-gas-contacts`);
    return this.substitutePromptVariables(extractionPrompts['oil-gas-contacts'][mode]);
  }

  return this.substitutePromptVariables(prompts[mode]);
}
```

**Note:** Change `getPrompt()` to `async getPrompt()` and update all call sites.

---

### Phase 3: Controller Integration

Update all controllers to inject `ExtractionPromptService`:

#### Example: `controller/olm.controller.js`

**In constructor:**
```javascript
constructor() {
  // ... existing services ...
  this.promptService = new ExtractionPromptService(this.sequelize);
}
```

**When creating ClaudeContactExtractor:**
```javascript
const extractor = new ClaudeContactExtractor({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  awsRegion: process.env.AWS_REGION,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  documentType: 'olm-contacts',
  promptService: this.promptService  // NEW: Inject service
});
```

**Apply same changes to:**
- `controller/emnrd.controller.js`
- `controller/ocd-cbt.controller.js`
- `controller/plc.controller.js`

---

### Phase 4: Admin API Endpoints

#### 4.1 Create `controller/extraction-prompts.controller.js`

```javascript
const ExtractionPromptService = require('../services/extraction-prompt.service');

class ExtractionPromptsController {
  constructor() {
    this.promptService = new ExtractionPromptService(require('../config/database'));
  }

  // GET /v1/extraction-prompts
  async getAllPrompts(req, res) {
    try {
      const prompts = await this.promptService.getAllPrompts();
      res.json({
        success: true,
        count: prompts.length,
        prompts
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // GET /v1/extraction-prompts/:documentType
  async getPrompt(req, res) {
    try {
      const { documentType } = req.params;
      const { mode = 'native' } = req.query;

      const prompt = await this.promptService.getPrompt(documentType, mode);
      res.json({
        success: true,
        documentType,
        mode,
        prompt
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // PUT /v1/extraction-prompts/:documentType
  async updatePrompt(req, res) {
    try {
      const { documentType } = req.params;
      const { native_prompt, text_prompt, updated_by, change_reason } = req.body;

      if (!native_prompt || !text_prompt) {
        return res.status(400).json({
          success: false,
          message: 'Both native_prompt and text_prompt are required'
        });
      }

      const result = await this.promptService.updatePrompt(
        documentType,
        { native: native_prompt, text: text_prompt },
        updated_by || 'api',
        change_reason || 'Updated via API'
      );

      res.json({
        success: true,
        message: 'Prompt updated successfully',
        version: result.version
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // POST /v1/extraction-prompts
  async createPrompt(req, res) {
    try {
      const { document_type, native_prompt, text_prompt, description, created_by } = req.body;

      if (!document_type || !native_prompt || !text_prompt) {
        return res.status(400).json({
          success: false,
          message: 'document_type, native_prompt, and text_prompt are required'
        });
      }

      const prompt = await this.promptService.createPrompt(
        document_type,
        { native: native_prompt, text: text_prompt },
        created_by || 'api',
        description
      );

      res.status(201).json({
        success: true,
        message: 'Prompt created successfully',
        prompt
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // GET /v1/extraction-prompts/:documentType/history
  async getHistory(req, res) {
    try {
      const { documentType } = req.params;
      const { limit = 10 } = req.query;

      const history = await this.promptService.getPromptHistory(documentType, parseInt(limit));
      res.json({
        success: true,
        documentType,
        count: history.length,
        history
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // POST /v1/extraction-prompts/:documentType/rollback/:version
  async rollbackPrompt(req, res) {
    try {
      const { documentType, version } = req.params;
      const { updated_by } = req.body;

      // Get historical version
      const history = await this.promptService.getPromptHistory(documentType, 100);
      const targetVersion = history.find(h => h.version === parseInt(version));

      if (!targetVersion) {
        return res.status(404).json({
          success: false,
          message: `Version ${version} not found`
        });
      }

      // Update to historical prompts
      const result = await this.promptService.updatePrompt(
        documentType,
        {
          native: targetVersion.native_prompt,
          text: targetVersion.text_prompt
        },
        updated_by || 'api',
        `Rolled back to version ${version}`
      );

      res.json({
        success: true,
        message: `Rolled back to version ${version}`,
        newVersion: result.version
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // GET /v1/extraction-prompts/:documentType/preview
  async previewPrompt(req, res) {
    try {
      const { documentType } = req.params;
      const { mode = 'native', variables = '{}' } = req.query;

      const parsedVariables = JSON.parse(variables);
      const prompt = await this.promptService.getPrompt(documentType, mode, parsedVariables);

      res.json({
        success: true,
        documentType,
        mode,
        variables: parsedVariables,
        preview: prompt
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
}

// Export routes
function controller(app) {
  const ctrl = new ExtractionPromptsController();

  app.get('/v1/extraction-prompts', (req, res) => ctrl.getAllPrompts(req, res));
  app.get('/v1/extraction-prompts/:documentType', (req, res) => ctrl.getPrompt(req, res));
  app.post('/v1/extraction-prompts', (req, res) => ctrl.createPrompt(req, res));
  app.put('/v1/extraction-prompts/:documentType', (req, res) => ctrl.updatePrompt(req, res));
  app.get('/v1/extraction-prompts/:documentType/history', (req, res) => ctrl.getHistory(req, res));
  app.post('/v1/extraction-prompts/:documentType/rollback/:version', (req, res) => ctrl.rollbackPrompt(req, res));
  app.get('/v1/extraction-prompts/:documentType/preview', (req, res) => ctrl.previewPrompt(req, res));
}

module.exports = { controller };
```

#### 4.2 Authentication/Authorization
Add middleware to protect admin endpoints (future enhancement):
```javascript
// Future: Add API key or JWT authentication
const authenticateAdmin = (req, res, next) => {
  // Validate API key from headers
  // Or validate JWT token
  next();
};

app.put('/v1/extraction-prompts/:documentType', authenticateAdmin, (req, res) => ...);
```

---

### Phase 5: Testing & Validation

#### 5.1 Unit Tests: `tests/extraction-prompt.service.test.js`
- Test database prompt retrieval
- Test file fallback when database empty
- Test cache functionality
- Test variable substitution
- Test prompt updates and history tracking

#### 5.2 Integration Tests
- Test each controller still extracts contacts correctly
- Verify database prompts override file prompts
- Test cache invalidation on updates
- Test rollback functionality

---

## Implementation Checklist

### Files to Create (7)
- [ ] `models/extraction-prompt.js` - Main prompt model
- [ ] `models/extraction-prompt-history.js` - History/audit model
- [ ] `services/extraction-prompt.service.js` - Service layer
- [ ] `controller/extraction-prompts.controller.js` - Admin API
- [ ] `migrations/YYYYMMDDHHMMSS-create-extraction-prompts.js` - DB migration
- [ ] `migrations/YYYYMMDDHHMMSS-seed-extraction-prompts.js` - Seed data
- [ ] `tests/extraction-prompt.service.test.js` - Test suite

### Files to Modify (5)
- [ ] `services/ClaudeContactExtractor.cjs` - Use service, make getPrompt async
- [ ] `controller/emnrd.controller.js` - Inject prompt service
- [ ] `controller/ocd-cbt.controller.js` - Inject prompt service
- [ ] `controller/olm.controller.js` - Inject prompt service
- [ ] `controller/plc.controller.js` - Inject prompt service

### Files Unchanged (1)
- `prompts/extraction-prompts.js` - Kept as fallback/defaults

---

## Priority Fallback Strategy

```
┌─────────────────────────────────────┐
│  1. Custom Prompts (Constructor)    │  ← Highest Priority
├─────────────────────────────────────┤
│  2. Database (ExtractionPromptSvc)  │
├─────────────────────────────────────┤
│  3. File (extraction-prompts.js)    │  ← Default Fallback
└─────────────────────────────────────┘
```

---

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/extraction-prompts` | List all prompts |
| GET | `/v1/extraction-prompts/:documentType` | Get specific prompt |
| POST | `/v1/extraction-prompts` | Create new prompt |
| PUT | `/v1/extraction-prompts/:documentType` | Update prompt |
| GET | `/v1/extraction-prompts/:documentType/history` | View version history |
| POST | `/v1/extraction-prompts/:documentType/rollback/:version` | Rollback to previous version |
| GET | `/v1/extraction-prompts/:documentType/preview` | Preview with variable substitution |

---

## Migration Strategy

1. **Phase 1**: Create models and seed database (zero impact)
2. **Phase 2**: Create service with file fallback (zero impact)
3. **Phase 3**: Update ClaudeContactExtractor to support service (backward compatible)
4. **Phase 4**: Update controllers to inject service (transparent upgrade)
5. **Phase 5**: Add admin API endpoints (new functionality)
6. **Phase 6**: Build web UI for prompt management (future)

**Zero Downtime:** Fallback ensures system works even if database empty or service fails.

---

## Caching Strategy

- **Type**: In-memory cache (Map)
- **TTL**: 5 minutes
- **Keys**: `${documentType}:${mode}`
- **Invalidation**: On prompt updates
- **Scope**: Per ExtractionPromptService instance

---

## Version Control & Audit Trail

Every prompt update:
1. Creates entry in `extraction_prompt_history` table
2. Increments `version` number
3. Records `changed_by` and `change_reason`
4. Enables rollback to any previous version

---

## Future Enhancements

### Web Interface Components
- Monaco Editor for syntax highlighting
- Real-time preview with sample data
- Variable placeholder autocomplete (`${PROJECT_ORIGIN}`, etc.)
- Side-by-side diff viewer for history comparison
- One-click rollback functionality
- Prompt testing/validation before saving
- Multi-user editing with conflict detection

### Additional Features
- A/B testing of different prompts
- Prompt performance metrics (extraction quality, token usage)
- Prompt templates and snippets library
- Export/import prompts as JSON
- Prompt versioning with git-like branching

---

## Security Considerations

1. **Authentication**: Admin API endpoints should require authentication
2. **Authorization**: Role-based access (view vs. edit)
3. **Audit Trail**: All changes logged with user and timestamp
4. **Input Validation**: Sanitize prompts to prevent injection
5. **Rate Limiting**: Prevent abuse of prompt updates
6. **Backup**: Regular backups of prompts table

---

## Estimated Implementation Time

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Database Schema (models + migrations) | 2 hours |
| 2 | Seed Migration | 1 hour |
| 3 | ExtractionPromptService | 3 hours |
| 4 | Update ClaudeContactExtractor | 1 hour |
| 5 | Update Controllers (4 files) | 1 hour |
| 6 | Admin API Endpoints | 3 hours |
| 7 | Testing | 2 hours |

**Total:** ~13 hours

---

## Open Questions

1. **Authentication**: API key authentication for admin endpoints, or web interface handles auth separately?
2. **Prompt Variables**: Support custom variables beyond current 3, or keep as-is?
3. **Rollback**: Automatic (load old version) or create new version with old content?
4. **Scope**: Implement full backend (Phases 1-5) now, or start with database + service layer (Phases 1-2)?

---

## Related Documentation

- Current architecture detailed in agent analysis report
- 6 document types with 2 modes each (native/text)
- 4 controllers using prompts (EMNRD, OCD-CBT, OLM, PLC)
- Claude API integration at 4 methods in ClaudeContactExtractor

---

*Document created: 2025-11-21*
*Status: Planning - Awaiting confirmation on open questions*
