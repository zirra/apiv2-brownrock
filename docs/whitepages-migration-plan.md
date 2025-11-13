# Whitepages Migration System - Implementation Plan

**Status**: Planning Phase - On Hold
**Created**: 2025-11-12
**Last Updated**: 2025-11-12

## Overview

Create a weekly end-of-week process to migrate unique contacts from the `contacts` table to `contactsready` table, preparing data for external enrichment via Whitepages API.

## Business Requirements

### Goals
- Extract unique contacts from `contacts` table weekly
- Separate business entities from individual contacts
- Prepare clean data for Whitepages enrichment service
- Track migration status to avoid reprocessing
- Handle legal entities appropriately

### Key Decisions Made
1. **Two-table strategy**: `contactsready` for individuals, `businessentities` for companies
2. **Migration filter**: Exclude `islegal = true` records
3. **Business/Individual split**: Based on presence of `llc_owner` field
4. **Incremental approach**: Add `migrated_to_ready_at` timestamp to `contacts` table
5. **Schedule**: Friday 11:00 PM (`59 23 * * 5`)
6. **Batch size**: 1000 records per batch for performance

## Current System State

### Existing Files

#### [controller/lookup.controller.js](../controller/lookup.controller.js)
- **Status**: Stub exists with Whitepages API configuration
- **Environment Variables**:
  - `WP_API_KEY=lRwbNURWJf22E6cWDGyVX7FlWQX3HqPP6Tmv3oG7`
  - `WP_API_ROOT=https://api.whitepages.com/`
- **Endpoints**:
  - `GET /v1/lookup/` - Currently returns "lookup success"
- **Next Steps**: Will be extended to handle actual Whitepages API calls

#### [models/contact.js](../models/contact.js)
- **Status**: Production model, needs modification
- **Current Fields**: Has `acknowledged` field (not `verified` like ContactReady)
- **Required Changes**: Add `migrated_to_ready_at` TIMESTAMP field
- **Schema**: 259 lines with full contact structure

#### [models/contact-ready.js](../models/contact-ready.js)
- **Status**: Complete model with unique constraints
- **Unique Constraint**: `['name', 'first_name', 'last_name', 'llc_owner', 'address', 'city', 'state', 'zip']`
- **Uses**: `verified` field (not `acknowledged`)
- **Purpose**: Target table for unique individual contacts

#### [models/business-entity.js](../models/business-entity.js)
- **Status**: ⚠️ Just created, has issues that need fixing:
  - Line 3: Class name typo `BusinssEntity` → should be `BusinessEntity`
  - Lines 261-262: Wrong modelName/tableName (says `ContactReady`/`contactsready` → should be `BusinessEntity`/`businessentities`)
- **Structure**: 471 lines, copied from contact-ready.js structure
- **Purpose**: Target table for unique business contacts

#### [services/postgres-contact.service.js](../services/postgres-contact.service.js)
- **Status**: Production service, needs extension
- **Current Features**:
  - Maps Claude contact data to database schema
  - Prioritizes Claude's separate city/state/zip fields over parsing (lines 65-67)
- **Required Changes**: Add migration helper methods

## Files to Create

### 1. services/contact-migration.service.js
**Purpose**: Core business logic for contact migration

**Key Methods**:
```javascript
class ContactMigrationService {
  async migrateToReady() {
    // Main migration orchestration
    // - Fetch unmigrated contacts in batches
    // - Split businesses from individuals
    // - Validate data quality
    // - Insert into target tables
    // - Mark as migrated
    // - Return statistics
  }

  splitBusinessFromIndividual(contact) {
    // Logic: If llc_owner is populated → business
    // Otherwise → individual
  }

  validateContactData(contact) {
    // Check required fields
    // Validate email/phone formats
    // Ensure address completeness
  }

  async processBatch(contacts) {
    // Batch processing with error handling
    // Transaction support for rollback
  }
}
```

**Dependencies**:
- Contact model (source)
- ContactReady model (target for individuals)
- BusinessEntity model (target for businesses)
- PostgresContactService (helper methods)

### 2. controller/contact-migration.controller.js
**Purpose**: HTTP endpoints and cron job scheduler

**Features**:
- Cron job: Friday 11:59 PM (`59 23 * * 5`)
- Manual trigger endpoint: `POST /v1/migration/run-now`
- Status endpoint: `GET /v1/migration/status`
- Statistics tracking and logging

**Structure**:
```javascript
class ContactMigrationController {
  constructor(contactMigrationService, loggingService) {
    // Initialize cron job
    this.scheduleMigration()
  }

  async scheduleMigration() {
    if (process.env.MIGRATION_CRON_ENABLED === 'true') {
      cron.schedule('59 23 * * 5', async () => {
        await this.runMigration()
      })
    }
  }

  async runMigration() {
    // Execute migration
    // Log results
    // Handle errors
  }

  async getMigrationStatus() {
    // Return statistics
  }
}
```

### 3. Database Migration Script
**Purpose**: Add `migrated_to_ready_at` column to `contacts` table

**SQL**:
```sql
ALTER TABLE contacts
ADD COLUMN migrated_to_ready_at TIMESTAMP NULL;

CREATE INDEX idx_contacts_migrated_at
ON contacts(migrated_to_ready_at);
```

## Files to Modify

### 1. [models/contact.js](../models/contact.js)
**Changes Required**:
- Add `migrated_to_ready_at` field definition (after line 258)
- Add index on `migrated_to_ready_at` in indexes array (line 295)

**Code to Add**:
```javascript
migrated_to_ready_at: {
  type: DataTypes.DATE,
  allowNull: true
},
```

### 2. [services/postgres-contact.service.js](../services/postgres-contact.service.js)
**Changes Required**:
- Add `findUnmigratedContacts(limit, offset)` method
- Add `markAsMigrated(contactIds)` method

**Methods to Add**:
```javascript
async findUnmigratedContacts(limit = 1000, offset = 0) {
  const { Op } = require('sequelize');
  return await Contact.findAll({
    where: {
      migrated_to_ready_at: null,
      islegal: false
    },
    limit,
    offset,
    order: [['created_at', 'ASC']]
  });
}

async markAsMigrated(contactIds) {
  return await Contact.update(
    { migrated_to_ready_at: new Date() },
    { where: { id: contactIds } }
  );
}
```

### 3. [models/business-entity.js](../models/business-entity.js) - CRITICAL FIXES NEEDED
**Issues to Fix**:
1. Line 3: `class BusinssEntity` → `class BusinessEntity`
2. Line 261: `modelName: 'ContactReady'` → `modelName: 'BusinessEntity'`
3. Line 262: `tableName: 'contactsready'` → `tableName: 'businessentities'`
4. Line 271: `name: 'contactsready_unique_contact'` → `name: 'businessentities_unique_contact'`
5. Line 471: `module.exports = BusinssEntity` → `module.exports = BusinessEntity`

### 4. [.env](../.env)
**Environment Variables to Add**:
```bash
# Contact Migration Configuration
MIGRATION_CRON_ENABLED=false              # Set to true after testing
MIGRATION_CRON_SCHEDULE=59 23 * * 5       # Friday 11:59 PM
MIGRATION_BATCH_SIZE=1000                 # Records per batch
```

## Implementation Sequence

### Phase 1: Database Setup
1. ✅ Create business-entity.js model (needs fixes)
2. ⏳ Fix business-entity.js typos and configuration
3. ⏳ Add `migrated_to_ready_at` field to Contact model
4. ⏳ Run database migration to add column + index

### Phase 2: Service Layer
1. ⏳ Extend postgres-contact.service.js with helper methods
2. ⏳ Create contact-migration.service.js with core logic
3. ⏳ Write unit tests for migration service

### Phase 3: Controller & Cron
1. ⏳ Create contact-migration.controller.js
2. ⏳ Add environment variables to .env
3. ⏳ Register routes in main app

### Phase 4: Testing
1. ⏳ Test manual trigger endpoint
2. ⏳ Verify business/individual split logic
3. ⏳ Test incremental migration (don't reprocess)
4. ⏳ Verify unique constraints working correctly
5. ⏳ Enable cron job for production

### Phase 5: Whitepages Integration
1. ⏳ Extend lookup.controller.js with actual API calls
2. ⏳ Test with contactsready data
3. ⏳ Handle rate limits and errors
4. ⏳ Update records with enriched data

## Open Questions

### Critical Decisions Needed
1. **Migration Scope**: Which contacts should be migrated?
   - All contacts where `islegal = false`?
   - Only contacts with complete address data?
   - Only contacts with phone OR email?
   - Any project_origin filtering?

2. **Migration Mode**: How to handle existing records?
   - Full migration each time (re-attempt all)?
   - Incremental only (skip already migrated)?
   - Update existing vs insert new?

3. **Data Quality Requirements**: What constitutes a "valid" contact?
   - Must have address?
   - Must have phone OR email?
   - Must have name?
   - Minimum field completeness threshold?

4. **Business Logic**: How to split businesses from individuals?
   - Current plan: If `llc_owner` is populated → business
   - Is this correct?
   - What about trusts, estates, joint ownership?

5. **Error Handling**: What happens when migration fails?
   - Skip record and continue?
   - Rollback entire batch?
   - Retry failed records?

6. **Enrichment Timing**: When does Whitepages enrichment happen?
   - Immediately after migration?
   - Separate process?
   - On-demand via API?

## Migration Logic Pseudocode

```
START Weekly Migration (Friday 11 PM)
│
├─ Fetch unmigrated contacts (batch of 1000)
│  └─ WHERE migrated_to_ready_at IS NULL AND islegal = false
│
├─ For each contact in batch:
│  │
│  ├─ Validate data quality
│  │  ├─ Check required fields
│  │  └─ Skip if incomplete (or mark for manual review)
│  │
│  ├─ Determine type:
│  │  ├─ IF llc_owner is populated → Business
│  │  └─ ELSE → Individual
│  │
│  ├─ Insert into target table:
│  │  ├─ Business → businessentities
│  │  └─ Individual → contactsready
│  │  └─ Handle unique constraint conflicts (update vs skip)
│  │
│  └─ Mark original record:
│     └─ UPDATE contacts SET migrated_to_ready_at = NOW()
│
├─ Log statistics:
│  ├─ Total processed
│  ├─ Businesses migrated
│  ├─ Individuals migrated
│  ├─ Skipped (data quality)
│  └─ Errors
│
└─ Repeat until all unmigrated contacts processed
```

## Integration Points

### Whitepages API Flow
```
contacts table
    ↓ (migration - Friday 11 PM)
contactsready table
    ↓ (enrichment - TBD)
Whitepages API
    ↓ (update)
contactsready table (enriched)
```

### Existing Pipelines
- **EMNRD Vision** (Tuesday 11:59 PM) → `contacts` with `project_origin: 'OCD_IMAGING'`
- **OCD_CBT** (Wednesday 11:59 PM) → `contacts` with `project_origin: 'OCD_CBT'`
- **Migration** (Friday 11:59 PM) → `contacts` → `contactsready` / `businessentities`

## Notes and Considerations

### Design Decisions
- **Incremental vs Full**: Using incremental approach with timestamp to avoid reprocessing
- **Legal Entities**: Staying in `contacts` table, not migrated (islegal = true)
- **Unique Constraints**: Enforced at database level for data integrity
- **Batch Size**: 1000 records for memory management and transaction boundaries

### Data Quality
- Address parsing already fixed (prioritizes Claude fields over parsing)
- Suite/unit numbers correctly kept in address field
- City/state/zip separated correctly

### Performance
- Index on `migrated_to_ready_at` for fast queries
- Batch processing for large datasets
- Existing indexes on contactsready for lookup performance

### Future Enhancements
- Manual review queue for incomplete records
- Enrichment status tracking
- Whitepages API response caching
- Cost tracking for API calls
- Success/failure metrics dashboard

## References

### Related Files
- [controller/lookup.controller.js](../controller/lookup.controller.js) - Whitepages API stub
- [models/contact.js](../models/contact.js) - Source table
- [models/contact-ready.js](../models/contact-ready.js) - Target table (individuals)
- [models/business-entity.js](../models/business-entity.js) - Target table (businesses)
- [services/postgres-contact.service.js](../services/postgres-contact.service.js) - Database service
- [.env](../.env) - Configuration

### Existing Cron Jobs
- EMNRD Vision: `59 23 * * 2` (Tuesday 11:59 PM)
- OCD_CBT: `59 23 * * 3` (Wednesday 11:59 PM)
- Migration (planned): `59 23 * * 5` (Friday 11:59 PM)

---

**Next Steps**: Review open questions and provide clarifications to proceed with implementation.
