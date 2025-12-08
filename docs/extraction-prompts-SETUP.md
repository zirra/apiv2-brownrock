# Extraction Prompts Database System - Setup Guide

## ✅ Implementation Complete

The extraction prompts database system has been successfully implemented! Here's what was created:

## 📁 Files Created

### Database Models
- ✅ `models/extraction-prompt.js` - Main prompts table
- ✅ `models/extraction-prompt-version.js` - Version history table
- ✅ Updated `config/pddbclient.cjs` - Added model initialization

### Services
- ✅ `services/extraction-prompt.service.js` - CRUD operations and version management

### API Controllers
- ✅ `controller/extraction-prompt.controller.js` - REST API endpoints

### Migration Scripts
- ✅ `scripts/migrate-prompts-to-database.js` - Import existing prompts from JS file

### Documentation
- ✅ `docs/extraction-prompts-api.md` - Complete API documentation
- ✅ `docs/extraction-prompts-SETUP.md` - This setup guide

### Updated Files
- ✅ `services/ClaudeContactExtractor.cjs` - Load prompts from database with fallback

## 🚀 Quick Start

### Step 1: Restart Your Server

The server will automatically create the database tables on startup:

```bash
# Stop current server (Ctrl+C)
# Start server
npm start
```

You should see in the logs:
```
ExtractionPrompt model attributes: [...]
ExtractionPromptVersion model attributes: [...]
✅ Extraction Prompt controller routes loaded successfully
```

### Step 2: Run Migration Script

Import your existing prompts from the JS file to the database:

```bash
# Preview what will be imported (dry run)
node scripts/migrate-prompts-to-database.js --dry-run

# Import prompts
node scripts/migrate-prompts-to-database.js
```

**Expected output**:
```
🚀 Starting extraction prompts migration...

✨ Creating new prompt: oil-gas-contacts
✨ Creating new prompt: ocd-cbt-contacts
✨ Creating new prompt: olm-contacts
✨ Creating new prompt: plc-contacts
✨ Creating new prompt: lease-agreements
⏭️  Skipping (no changes): oil-gas-contacts-old

============================================================
📊 MIGRATION COMPLETE
============================================================
Total prompts processed: 6
Created: 5
Updated: 0
Skipped (no changes): 1
Errors: 0
Duration: 1.23s
============================================================

✅ Migration successful! Prompts are now in the database.
You can manage them via the API at /v1/extraction-prompts
```

### Step 3: Test the API

```bash
# List all prompts
curl http://localhost:5151/v1/extraction-prompts

# Get specific prompt
curl http://localhost:5151/v1/extraction-prompts/oil-gas-contacts

# Get statistics
curl http://localhost:5151/v1/extraction-prompts/stats
```

### Step 4: Verify Extraction Uses Database Prompts

Process a test document and check the logs for:
```
✅ Loaded prompt from database: oil-gas-contacts (version 1)
```

## 📊 Database Tables

### extraction_prompts
```sql
CREATE TABLE extraction_prompts (
  id SERIAL PRIMARY KEY,
  prompt_key VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  native_prompt TEXT NOT NULL,
  text_prompt TEXT NOT NULL,
  document_types TEXT[],
  project_origins TEXT[],
  template_variables JSONB,
  is_active BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false,
  version INTEGER DEFAULT 1,
  created_by VARCHAR(100),
  updated_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### extraction_prompt_versions
```sql
CREATE TABLE extraction_prompt_versions (
  id SERIAL PRIMARY KEY,
  prompt_id INTEGER REFERENCES extraction_prompts(id),
  version INTEGER NOT NULL,
  native_prompt TEXT NOT NULL,
  text_prompt TEXT NOT NULL,
  changes_summary TEXT,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(prompt_id, version)
);
```

## 🎯 Prompt Keys Imported

The migration will import these prompts:

1. **oil-gas-contacts** (Default for OCD_IMAGING)
   - For: Oil & gas documents, pooling orders, unit declarations
   - Projects: OCD_IMAGING

2. **ocd-cbt-contacts** (Default for OCD_CBT)
   - For: County-based documents, mailing lists
   - Projects: OCD_CBT

3. **olm-contacts** (Default for OLM)
   - For: Oil & mineral leases
   - Projects: OLM

4. **plc-contacts** (Default for PLC)
   - For: Pipeline/location certificates
   - Projects: PLC

5. **lease-agreements**
   - For: Lease contracts and agreements
   - Projects: OLM, OCD_IMAGING

6. **oil-gas-contacts-old** (Inactive - Legacy)
   - Previous version kept for reference

## 🔧 Environment Variables

Add to `.env`:
```bash
# Enable database prompts (default: true)
USE_DATABASE_PROMPTS=true

# If false, will always use prompts/extraction-prompts.js
```

## 📝 How It Works

### Before (JS File Only)
```
ClaudeContactExtractor.getPrompt()
  → Load from prompts/extraction-prompts.js
  → Substitute variables
  → Return prompt
```

### After (Database with Fallback)
```
ClaudeContactExtractor.getPrompt()
  → Try to load from database (if USE_DATABASE_PROMPTS=true)
    → If found: Return database prompt (with version tracking)
    → If not found or error: Fall back to JS file
  → Substitute variables
  → Return prompt
```

## 🎨 Client Self-Service Example

Your client wants to improve extraction for postal delivery tables:

1. **Get current prompt**:
   ```bash
   curl http://localhost:5151/v1/extraction-prompts/oil-gas-contacts
   ```

2. **Update prompt**:
   ```bash
   curl -X PUT http://localhost:5151/v1/extraction-prompts/oil-gas-contacts \
     -H "Content-Type: application/json" \
     -d '{
       "native_prompt": "[Improved prompt text...]",
       "changes_summary": "Enhanced multi-page table detection",
       "updated_by": "client-user"
     }'
   ```

3. **Test extraction** - Run document processing

4. **If worse, rollback**:
   ```bash
   curl -X POST http://localhost:5151/v1/extraction-prompts/oil-gas-contacts/rollback \
     -H "Content-Type: application/json" \
     -d '{"version": 1, "rolled_back_by": "client-user"}'
   ```

5. **View version history**:
   ```bash
   curl http://localhost:5151/v1/extraction-prompts/oil-gas-contacts/versions
   ```

## ✅ Benefits

### For Your Client
- ✅ Edit prompts without waiting for developer
- ✅ No code deployments needed
- ✅ Instant changes (no downtime)
- ✅ Safe rollback if results worsen
- ✅ Full audit trail

### For You (Developer)
- ✅ Less maintenance burden
- ✅ Client self-service reduces tickets
- ✅ Fallback to JS file ensures safety
- ✅ Version control tracks all changes
- ✅ Multi-tenant ready (different clients, different prompts)

## 🔍 Troubleshooting

### Prompts Not Loading from Database

**Check environment**:
```bash
echo $USE_DATABASE_PROMPTS  # Should be "true" or undefined (defaults to true)
```

**Check tables exist**:
```bash
psql -U $PGUSER -d $PGDATABASE -c "\dt extraction*"
```

**Check migration ran**:
```bash
curl http://localhost:5151/v1/extraction-prompts/stats
```

### Tables Not Created

The tables are created automatically via Sequelize `sync: { alter: true }`.

If tables aren't created, check:
1. Database connection is working: `curl http://localhost:5151/v1/test-postgres`
2. Model files are in `models/` directory
3. Models are registered in `config/pddbclient.cjs`

## 📚 API Documentation

See [docs/extraction-prompts-api.md](./extraction-prompts-api.md) for:
- Complete API endpoint documentation
- Request/response examples
- Client self-service workflows
- Version management examples

## 🎉 Success Checklist

- [ ] Server restarted and logs show "ExtractionPrompt model attributes"
- [ ] Migration script ran successfully
- [ ] API endpoint works: `curl http://localhost:5151/v1/extraction-prompts`
- [ ] Statistics show prompts: `curl http://localhost:5151/v1/extraction-prompts/stats`
- [ ] Document extraction logs show "Loaded prompt from database"
- [ ] Can update a prompt via API
- [ ] Can rollback to previous version
- [ ] JS file fallback works when database unavailable

## 🚨 Important Notes

1. **JS File Kept as Fallback**: `prompts/extraction-prompts.js` is still used if database fails
2. **No Breaking Changes**: Existing extraction jobs work without migration
3. **Version Control**: Every prompt update increments version automatically
4. **Audit Trail**: All changes tracked with who/when/what
5. **Multi-Tenant Ready**: Support different prompts per client/project

---

**Status**: ✅ Implementation Complete - Ready to Use!
