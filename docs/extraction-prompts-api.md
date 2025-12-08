# Extraction Prompts Management API

**Purpose**: Enable clients to manage Claude AI extraction prompts without code deployments

## Overview

The Extraction Prompts Management system stores Claude AI prompts in PostgreSQL, enabling:
- ✅ Client self-service prompt editing
- ✅ Version control with rollback capability
- ✅ No code deployments needed for prompt updates
- ✅ Audit trail of all changes
- ✅ A/B testing different prompts

## Architecture

### Database Tables

1. **`extraction_prompts`**: Main prompts table
   - Stores active prompts with native (PDF vision) and text versions
   - Indexed by `prompt_key`, `project_origins`, `document_types`
   - Tracks version history

2. **`extraction_prompt_versions`**: Version history
   - Immutable records of all prompt changes
   - Enables rollback to previous versions
   - Tracks who changed what and when

### Files Created

- **Models**:
  - [models/extraction-prompt.js](../models/extraction-prompt.js)
  - [models/extraction-prompt-version.js](../models/extraction-prompt-version.js)

- **Services**:
  - [services/extraction-prompt.service.js](../services/extraction-prompt.service.js)

- **Controllers**:
  - [controller/extraction-prompt.controller.js](../controller/extraction-prompt.controller.js)

- **Migration Script**:
  - [scripts/migrate-prompts-to-database.js](../scripts/migrate-prompts-to-database.js)

## Setup

### 1. Run Migration to Import Existing Prompts

```bash
# Dry run to preview changes
node scripts/migrate-prompts-to-database.js --dry-run

# Import prompts to database
node scripts/migrate-prompts-to-database.js
```

### 2. Environment Configuration

Add to `.env`:
```bash
# Enable database-backed prompts (default: true)
USE_DATABASE_PROMPTS=true
```

### 3. Restart Server

The server will automatically create the tables on startup (via Sequelize `sync`).

## API Endpoints

### List All Prompts

**GET** `/v1/extraction-prompts`

**Query Parameters**:
- `is_active` (boolean) - Filter by active status
- `is_default` (boolean) - Filter by default prompts
- `project_origin` (string) - Filter by project (e.g., "OCD_IMAGING", "OLM", "PLC")
- `document_type` (string) - Filter by document type
- `search` (string) - Search in name, description, or prompt_key

**Example**:
```bash
# Get all active prompts
curl http://localhost:5151/v1/extraction-prompts?is_active=true

# Get prompts for a specific project
curl http://localhost:5151/v1/extraction-prompts?project_origin=OCD_IMAGING

# Search for prompts
curl http://localhost:5151/v1/extraction-prompts?search=oil
```

**Response**:
```json
{
  "success": true,
  "count": 5,
  "prompts": [
    {
      "id": 1,
      "prompt_key": "oil-gas-contacts",
      "name": "Oil & Gas Contact Extraction",
      "description": "Extracts contact information from oil & gas documents...",
      "document_types": ["oil-gas", "pooling-orders"],
      "project_origins": ["OCD_IMAGING"],
      "is_active": true,
      "is_default": true,
      "version": 3,
      "created_at": "2025-01-10T10:00:00Z",
      "updated_at": "2025-01-15T14:30:00Z"
    }
  ]
}
```

### Get Specific Prompt

**GET** `/v1/extraction-prompts/:key`

**Query Parameters**:
- `variables` (JSON string) - Template variables to substitute (e.g., `{"PROJECT_ORIGIN": "OCD Imaging"}`)

**Example**:
```bash
# Get prompt with default variables
curl http://localhost:5151/v1/extraction-prompts/oil-gas-contacts

# Get prompt with custom variables
curl "http://localhost:5151/v1/extraction-prompts/oil-gas-contacts?variables=%7B%22PROJECT_ORIGIN%22%3A%22My%20Project%22%7D"
```

**Response**:
```json
{
  "success": true,
  "prompt": {
    "id": 1,
    "prompt_key": "oil-gas-contacts",
    "name": "Oil & Gas Contact Extraction",
    "native_prompt": "Extract contact information...",
    "text_prompt": "Extract contact information from text...",
    "processed_prompts": {
      "native": "Extract contact information... [with variables replaced]",
      "text": "Extract contact information from text... [with variables replaced]"
    },
    "version": 3,
    "...": "..."
  }
}
```

### Get Prompts for Project

**GET** `/v1/extraction-prompts/project/:projectOrigin`

**Example**:
```bash
curl http://localhost:5151/v1/extraction-prompts/project/OCD_IMAGING
```

### Create New Prompt

**POST** `/v1/extraction-prompts`

**Request Body**:
```json
{
  "prompt_key": "custom-extraction",
  "name": "Custom Document Extraction",
  "description": "Extracts data from custom documents",
  "native_prompt": "Your Claude prompt for PDF vision...",
  "text_prompt": "Your Claude prompt for extracted text...",
  "document_types": ["custom-doc"],
  "project_origins": ["MY_PROJECT"],
  "is_active": true,
  "is_default": false,
  "created_by": "john.doe"
}
```

**Example**:
```bash
curl -X POST http://localhost:5151/v1/extraction-prompts \
  -H "Content-Type: application/json" \
  -d '{
    "prompt_key": "custom-extraction",
    "name": "Custom Document Extraction",
    "native_prompt": "Extract all contacts from this document...",
    "text_prompt": "Extract all contacts from the following text...",
    "document_types": ["custom"],
    "project_origins": ["MY_PROJECT"],
    "created_by": "api-user"
  }'
```

### Update Prompt

**PUT** `/v1/extraction-prompts/:key`

**Request Body**:
```json
{
  "native_prompt": "Updated prompt text...",
  "text_prompt": "Updated text prompt...",
  "description": "Updated description",
  "changes_summary": "Improved extraction for postal delivery tables",
  "updated_by": "john.doe"
}
```

**Example**:
```bash
curl -X PUT http://localhost:5151/v1/extraction-prompts/oil-gas-contacts \
  -H "Content-Type: application/json" \
  -d '{
    "native_prompt": "Improved prompt...",
    "changes_summary": "Added better handling for multi-page tables",
    "updated_by": "john.doe"
  }'
```

**Response**:
```json
{
  "success": true,
  "message": "Prompt updated successfully",
  "prompt": { "...": "..." },
  "version_incremented": true
}
```

### Delete (Deactivate) Prompt

**DELETE** `/v1/extraction-prompts/:key`

**Request Body**:
```json
{
  "deleted_by": "john.doe"
}
```

**Example**:
```bash
curl -X DELETE http://localhost:5151/v1/extraction-prompts/old-prompt \
  -H "Content-Type: application/json" \
  -d '{"deleted_by": "john.doe"}'
```

### Get Version History

**GET** `/v1/extraction-prompts/:key/versions`

**Example**:
```bash
curl http://localhost:5151/v1/extraction-prompts/oil-gas-contacts/versions
```

**Response**:
```json
{
  "success": true,
  "prompt_key": "oil-gas-contacts",
  "current_version": 5,
  "versions": [
    {
      "id": 12,
      "version": 5,
      "changes_summary": "Improved multi-page table extraction",
      "created_by": "john.doe",
      "created_at": "2025-01-15T14:30:00Z"
    },
    {
      "id": 8,
      "version": 4,
      "changes_summary": "Added Parties to Pool section detection",
      "created_by": "jane.smith",
      "created_at": "2025-01-12T10:15:00Z"
    }
  ]
}
```

### Rollback to Previous Version

**POST** `/v1/extraction-prompts/:key/rollback`

**Request Body**:
```json
{
  "version": 3,
  "rolled_back_by": "john.doe"
}
```

**Example**:
```bash
curl -X POST http://localhost:5151/v1/extraction-prompts/oil-gas-contacts/rollback \
  -H "Content-Type: application/json" \
  -d '{
    "version": 3,
    "rolled_back_by": "john.doe"
  }'
```

**Response**:
```json
{
  "success": true,
  "message": "Successfully rolled back to version 3",
  "prompt": { "...": "..." },
  "rolled_back_from": 5,
  "rolled_back_to": 3
}
```

### Get Statistics

**GET** `/v1/extraction-prompts/stats`

**Example**:
```bash
curl http://localhost:5151/v1/extraction-prompts/stats
```

**Response**:
```json
{
  "success": true,
  "statistics": {
    "total_prompts": 6,
    "active_prompts": 5,
    "inactive_prompts": 1,
    "default_prompts": 4,
    "prompts_by_project": {
      "OCD_IMAGING": 2,
      "OCD_CBT": 1,
      "OLM": 1,
      "PLC": 1
    }
  }
}
```

## Client Self-Service Workflow

### Scenario: Client Wants to Improve Extraction

1. **Review current prompt**:
   ```bash
   curl http://localhost:5151/v1/extraction-prompts/oil-gas-contacts
   ```

2. **Update the prompt**:
   ```bash
   curl -X PUT http://localhost:5151/v1/extraction-prompts/oil-gas-contacts \
     -H "Content-Type: application/json" \
     -d '{
       "native_prompt": "[Updated prompt with improvements...]",
       "changes_summary": "Added better extraction for multi-page postal tables",
       "updated_by": "client-user"
     }'
   ```

3. **Test with sample documents**: Run extraction jobs to verify improvements

4. **If results are worse, rollback**:
   ```bash
   curl -X POST http://localhost:5151/v1/extraction-prompts/oil-gas-contacts/rollback \
     -H "Content-Type: application/json" \
     -d '{"version": 4, "rolled_back_by": "client-user"}'
   ```

5. **Check version history**:
   ```bash
   curl http://localhost:5151/v1/extraction-prompts/oil-gas-contacts/versions
   ```

## How It Works

### Automatic Prompt Loading

When processing documents, the `ClaudeContactExtractor` automatically:

1. **Checks database first** (if `USE_DATABASE_PROMPTS=true`)
   ```javascript
   const prompt = await extractor.getPrompt('native')
   ```

2. **Falls back to JS file** if:
   - Database prompt not found
   - Database connection fails
   - `USE_DATABASE_PROMPTS=false`

3. **Template variable substitution**:
   - Replaces `${PROJECT_ORIGIN}` with actual project name
   - Replaces `${DOCUMENT_TYPE}` with document type
   - Custom variables supported

### Version Control

- Every prompt update creates a new version
- Old versions are preserved in `extraction_prompt_versions`
- Rollback creates a new version with old content
- Full audit trail of who changed what and when

## Benefits

### For Clients

✅ **Self-Service**: Update prompts without developer involvement
✅ **No Downtime**: Changes take effect immediately
✅ **Safe Experimentation**: Rollback if results worsen
✅ **Audit Trail**: See history of all changes
✅ **Version Control**: Track improvements over time

### For Developers

✅ **Less Maintenance**: Clients manage their own prompts
✅ **No Deployments**: Changes don't require code releases
✅ **Fallback Safety**: JS file provides backup
✅ **Flexible**: Support multiple projects with different prompts

## Troubleshooting

### Prompts Not Loading from Database

**Check environment variable**:
```bash
echo $USE_DATABASE_PROMPTS
```

**Check logs**:
```bash
# Look for prompt loading messages
tail -f logs/app.log | grep "Loaded prompt from database"
```

**Verify migration ran**:
```bash
curl http://localhost:5151/v1/extraction-prompts/stats
```

### Rollback Failed

**Check version exists**:
```bash
curl http://localhost:5151/v1/extraction-prompts/oil-gas-contacts/versions
```

**Verify version number**:
- Version must exist in version history
- Cannot rollback to version 0 or negative numbers

## Related Documentation

- [Extraction Prompts Library](../prompts/extraction-prompts.js) - Original JS file (fallback)
- [WhitePages Testing](./whitepages-testing.md) - Testing contact extraction
- [Claude Contact Extractor](../services/ClaudeContactExtractor.cjs) - Main extraction service

---

**Note**: The JS file at `prompts/extraction-prompts.js` is kept as a fallback. Database prompts take precedence when available.
