# WhitePages Integration - Implementation Guide

**Status**: ✅ Complete - Ready for Testing
**Created**: 2025-11-24

## Overview

A complete WhitePages API integration system that:
- Automatically identifies contacts eligible for lookup based on data completeness
- Only sends unique records (prevents duplicate API calls)
- Handles empty array responses (no results found)
- Stores all results in a dedicated table for human verification
- Provides comprehensive API endpoints for manual and batch processing

## Architecture

### Components

1. **Model**: [models/whitepages-lookup.js](../models/whitepages-lookup.js)
   - Stores WhitePages API responses
   - Tracks verification status
   - Links to original contact records

2. **Service**: [services/whitepages.service.js](../services/whitepages.service.js)
   - Core business logic for lookups
   - API communication
   - Data parsing and storage
   - Uniqueness filtering

3. **Controller**: [controller/whitepages.controller.js](../controller/whitepages.controller.js)
   - RESTful API endpoints
   - Request validation
   - Response formatting

4. **Database Config**: [config/pddbclient.cjs](../config/pddbclient.cjs)
   - Model registration
   - Auto-sync enabled

## Eligibility Criteria

Contacts are eligible for WhitePages lookup if they have:

**Required:**
- `first_name` (not null)
- `last_name` (not null)

**AND one of:**
- **Option 1**: `address` + `city` + `state` (all not null)
- **Option 2**: `zip` (not null)

**Uniqueness:**
- Contacts that already have a lookup record are automatically excluded
- Prevents duplicate API calls and costs

## Database Schema

### Table: `whitepages_lookups`

```sql
CREATE TABLE whitepages_lookups (
  id SERIAL PRIMARY KEY,

  -- Link to original contact
  contact_id INTEGER NOT NULL,

  -- Search criteria used
  search_first_name VARCHAR(255),
  search_last_name VARCHAR(255),
  search_address TEXT,
  search_city VARCHAR(100),
  search_state VARCHAR(50),
  search_zip VARCHAR(10),

  -- WhitePages API response data
  wp_person_id VARCHAR(50),
  wp_name VARCHAR(255),
  wp_aliases JSON,
  wp_is_dead BOOLEAN DEFAULT false,
  wp_current_addresses JSON,
  wp_historic_addresses JSON,
  wp_owned_properties JSON,
  wp_phones JSON,
  wp_emails JSON,
  wp_date_of_birth VARCHAR(20),
  wp_linkedin_url TEXT,
  wp_company_name VARCHAR(255),
  wp_job_title VARCHAR(255),
  wp_relatives JSON,

  -- Lookup metadata
  lookup_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    -- Values: 'pending', 'success', 'no_results', 'error'
  lookup_error TEXT,
  lookup_at TIMESTAMP,

  -- Verification tracking
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_by VARCHAR(100),
  verified_at TIMESTAMP,
  verification_notes TEXT,

  -- Raw response for debugging
  raw_response JSON,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_wp_lookups_contact_id ON whitepages_lookups(contact_id);
CREATE INDEX idx_wp_lookups_status ON whitepages_lookups(lookup_status);
CREATE INDEX idx_wp_lookups_verified ON whitepages_lookups(verified);
CREATE INDEX idx_wp_lookups_lookup_at ON whitepages_lookups(lookup_at);
CREATE INDEX idx_wp_lookups_person_id ON whitepages_lookups(wp_person_id);
CREATE INDEX idx_wp_lookups_name ON whitepages_lookups(search_first_name, search_last_name);
```

## API Endpoints

### 1. Get Eligible Contacts
**Endpoint**: `GET /v1/whitepages/eligible`

**Description**: Find contacts that meet eligibility criteria and haven't been looked up yet.

**Query Parameters**:
- `limit` (optional, default: 100) - Max contacts to return
- `offset` (optional, default: 0) - Pagination offset

**Response**:
```json
{
  "success": true,
  "count": 45,
  "limit": 100,
  "offset": 0,
  "contacts": [
    {
      "id": 12345,
      "first_name": "John",
      "last_name": "Smith",
      "address": "123 Main St",
      "city": "Roswell",
      "state": "NM",
      "zip": "88203",
      "project_origin": "OLM"
    }
  ]
}
```

### 2. Lookup Single Contact
**Endpoint**: `POST /v1/whitepages/lookup/:contactId`

**Description**: Perform WhitePages lookup for a specific contact.

**Response (Success)**:
```json
{
  "success": true,
  "message": "Lookup completed",
  "lookup": {
    "id": 789,
    "contact_id": 12345,
    "lookup_status": "success",
    "wp_person_id": "PLyZ6DxGqky",
    "wp_name": "John Smith",
    "wp_phones": [
      {
        "number": "(575) 420-7918",
        "type": "mobile",
        "score": 94
      }
    ],
    "wp_emails": ["john@example.com"],
    "wp_current_addresses": [
      {
        "id": "AEoLex3rqlj",
        "address": "123 Main St Roswell, NM 88203"
      }
    ],
    "verified": false
  }
}
```

**Response (No Results)**:
```json
{
  "success": true,
  "message": "Lookup completed",
  "lookup": {
    "id": 790,
    "contact_id": 12346,
    "lookup_status": "no_results",
    "verified": false
  }
}
```

**Error Cases**:
- `404` - Contact not found
- `409` - Contact already has a lookup
- `400` - Contact missing required fields

### 3. Batch Lookup
**Endpoint**: `POST /v1/whitepages/batch`

**Description**: Process multiple eligible contacts in batch.

**Request Body**:
```json
{
  "limit": 50,
  "delay": 1000
}
```

**Parameters**:
- `limit` (optional, default: 50) - Max contacts to process
- `delay` (optional, default: 1000) - Delay in ms between API calls (rate limiting)

**Response**:
```json
{
  "success": true,
  "message": "Batch lookup completed",
  "results": {
    "total": 50,
    "success": 35,
    "no_results": 12,
    "errors": 3
  }
}
```

### 4. Get Lookup Result
**Endpoint**: `GET /v1/whitepages/results/:lookupId`

**Description**: Get detailed results for a specific lookup.

**Response**:
```json
{
  "success": true,
  "lookup": {
    "id": 789,
    "contact_id": 12345,
    "search_first_name": "John",
    "search_last_name": "Smith",
    "search_address": "123 Main St",
    "search_city": "Roswell",
    "search_state": "NM",
    "search_zip": "88203",
    "wp_person_id": "PLyZ6DxGqky",
    "wp_name": "John Smith",
    "wp_aliases": ["Johnny Smith", "J. Smith"],
    "wp_is_dead": false,
    "wp_current_addresses": [...],
    "wp_historic_addresses": [...],
    "wp_phones": [...],
    "wp_emails": [...],
    "wp_date_of_birth": "1983-01-00",
    "wp_linkedin_url": "https://linkedin.com/...",
    "wp_company_name": "Axis Energy",
    "wp_job_title": "Landman",
    "wp_relatives": [...],
    "lookup_status": "success",
    "lookup_at": "2025-11-24T10:30:00Z",
    "verified": false,
    "raw_response": {...}
  }
}
```

### 5. Get Pending Verification
**Endpoint**: `GET /v1/whitepages/pending`

**Description**: Get all successful lookups pending human verification.

**Query Parameters**:
- `limit` (optional, default: 100)
- `offset` (optional, default: 0)

**Response**:
```json
{
  "success": true,
  "count": 87,
  "limit": 100,
  "offset": 0,
  "lookups": [...]
}
```

### 6. Verify Lookup
**Endpoint**: `PUT /v1/whitepages/verify/:lookupId`

**Description**: Mark a lookup as verified by a human.

**Request Body**:
```json
{
  "verified_by": "user@example.com",
  "verification_notes": "Confirmed correct person, phone numbers match"
}
```

**Response**:
```json
{
  "success": true,
  "message": "Lookup marked as verified",
  "lookup": {...}
}
```

### 7. Get Statistics
**Endpoint**: `GET /v1/whitepages/statistics`

**Description**: Get overall lookup statistics.

**Response**:
```json
{
  "success": true,
  "statistics": {
    "total_lookups": 523,
    "successful": 401,
    "no_results": 89,
    "errors": 33,
    "verified": 156,
    "pending_verification": 245
  }
}
```

### 8. Get Contact's Lookups
**Endpoint**: `GET /v1/whitepages/contact/:contactId`

**Description**: Get all lookup records for a specific contact.

**Response**:
```json
{
  "success": true,
  "count": 1,
  "lookups": [...]
}
```

## Usage Examples

### Example 1: Find and Process Eligible Contacts

```bash
# Step 1: Check how many contacts are eligible
curl http://localhost:5151/v1/whitepages/eligible?limit=10

# Step 2: Process a batch of 50 contacts with 2 second delays
curl -X POST http://localhost:5151/v1/whitepages/batch \
  -H "Content-Type: application/json" \
  -d '{"limit": 50, "delay": 2000}'
```

### Example 2: Manual Lookup for Specific Contact

```bash
# Lookup contact ID 12345
curl -X POST http://localhost:5151/v1/whitepages/lookup/12345
```

### Example 3: Review Pending Verifications

```bash
# Get first 25 pending verifications
curl http://localhost:5151/v1/whitepages/pending?limit=25

# Verify a specific lookup
curl -X PUT http://localhost:5151/v1/whitepages/verify/789 \
  -H "Content-Type: application/json" \
  -d '{
    "verified_by": "john.doe@company.com",
    "verification_notes": "Confirmed correct contact information"
  }'
```

### Example 4: Get Overall Statistics

```bash
curl http://localhost:5151/v1/whitepages/statistics
```

## Data Flow

```
1. Contact Extraction (EMNRD, OLM, PLC, etc.)
   ↓
2. Stored in 'contacts' table with jobid, project_origin
   ↓
3. WhitePages Service filters eligible contacts
   - Has first_name + last_name
   - Has (address + city + state) OR zip
   - Not already looked up (checked via whitepages_lookups.contact_id)
   ↓
4. API Call to WhitePages
   ↓
5. Store result in 'whitepages_lookups' table
   - lookup_status: 'success', 'no_results', or 'error'
   - All data fields from API response
   - verified: false (initial state)
   ↓
6. Human Verification Process
   - Review lookup via GET /v1/whitepages/pending
   - Verify via PUT /v1/whitepages/verify/:id
   ↓
7. Verified data ready for use
```

## Empty Array Handling

The WhitePages API returns an empty array `[]` when no results are found. This is properly handled:

```javascript
// In whitepages.service.js
parseWhitepagesResponse(apiResponse) {
  // Handle empty array (no results found)
  if (Array.isArray(apiResponse) && apiResponse.length === 0) {
    return {
      hasResults: false,
      data: null
    };
  }
  // ... rest of parsing logic
}
```

**Database Record for No Results**:
```json
{
  "contact_id": 12345,
  "lookup_status": "no_results",
  "search_first_name": "John",
  "search_last_name": "Smith",
  "lookup_at": "2025-11-24T10:30:00Z",
  "wp_person_id": null,
  "wp_phones": null,
  "wp_emails": null
}
```

## Sample WhitePages Response

Based on your sample file [chad_barbe.json](../../Desktop/chad_barbe.json):

```json
[
  {
    "id": "PLyZ6DxGqky",
    "name": "Chad A Barbe",
    "aliases": ["Charles H Barbe", "Chuck H Barbe", "Chad Allen Barbe"],
    "is_dead": false,
    "current_addresses": [
      {
        "id": "AEoLex3rqlj",
        "address": "3967 Woodbine Way Roswell, NM 88203"
      }
    ],
    "historic_addresses": [...],
    "owned_properties": [...],
    "phones": [
      {
        "number": "(575) 420-7918",
        "type": "mobile",
        "score": 94
      }
    ],
    "emails": ["chbarbe@hotmail.com", ...],
    "date_of_birth": "1983-01-00",
    "linkedin_url": "https://www.linkedin.com/in/chad-barbe-bb67609b",
    "company_name": "Axis Energy",
    "job_title": "Landman",
    "relatives": [...]
  }
]
```

## Testing Checklist

- [ ] Database table created successfully (auto-sync on startup)
- [ ] Can query eligible contacts with proper filtering
- [ ] Single contact lookup works
- [ ] Empty array response (no results) handled correctly
- [ ] Successful lookup stored with all data fields
- [ ] Failed lookup stored with error message
- [ ] Batch processing works with rate limiting
- [ ] Statistics endpoint returns correct counts
- [ ] Verification workflow functions properly
- [ ] Duplicate lookups prevented (contact_id uniqueness)

## Environment Variables

Required in `.env`:

```bash
# WhitePages API Configuration
WP_API_KEY=lRwbNURWJf22E6cWDGyVX7FlWQX3HqPP6Tmv3oG7
WP_API_ROOT=https://api.whitepages.com/
```

## Rate Limiting

To avoid hitting WhitePages API rate limits:

1. **Batch Processing**: Default 1 second delay between requests
2. **Configurable Delay**: Pass `delay` parameter in batch requests
3. **Recommended**: Start with 2000ms (2 seconds) for production

```bash
# Conservative rate limiting (2 second delays)
curl -X POST http://localhost:5151/v1/whitepages/batch \
  -H "Content-Type: application/json" \
  -d '{"limit": 100, "delay": 2000}'
```

## Future Enhancements

- [ ] Scheduled cron job for automatic batch processing
- [ ] Dashboard UI for verification workflow
- [ ] API cost tracking and budgeting
- [ ] Retry logic for failed lookups
- [ ] Contact matching score/confidence
- [ ] Export verified contacts to CSV
- [ ] Integration with email/SMS notification systems

## Related Documentation

- [WhitePages Migration Plan](./whitepages-migration-plan.md)
- [Contact Model](../models/contact.js)
- [WhitePages API Documentation](https://pro.whitepages.com/developer/documentation/)

---

**Status**: Ready for testing. Start the server and database will auto-sync the new table.
