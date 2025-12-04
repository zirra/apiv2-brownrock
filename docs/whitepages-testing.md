# WhitePages Testing System

**Purpose**: Repeatable testing of WhitePages API integration with 25 valid contacts

## Overview

The WhitePages test system provides a dedicated endpoint for running controlled, repeatable tests against the WhitePages API using real contact data from your database.

## API Endpoints

### 1. Select Test Contacts
**Endpoint**: `GET /v1/whitepages-test/select-test-contacts`

**Description**: Preview which contacts will be used for testing without running lookups.

**Query Parameters**:
- `limit` (optional, default: 25) - Number of contacts to select

**Selection Criteria**:
- Must have `first_name` and `last_name`
- Must have valid 2-letter state code (e.g., "TX", "NM", not "Texas 76092")
- Must have either:
  - Full address (address + city + state), OR
  - ZIP code + state

**Example**:
```bash
curl http://localhost:5151/v1/whitepages-test/select-test-contacts?limit=25
```

**Response**:
```json
{
  "success": true,
  "message": "Selected 25 contacts for testing",
  "count": 25,
  "contacts": [
    {
      "id": 28636,
      "name": "Albert Chang",
      "city": "Santa Fe",
      "state": "NM",
      "zip": "87505",
      "project_origin": "OLM",
      "has_address": true,
      "has_full_location": true
    }
  ]
}
```

### 2. Run Test
**Endpoint**: `POST /v1/whitepages-test/run-test`

**Description**: Execute WhitePages lookups on 25 valid contacts.

**Request Body**:
```json
{
  "limit": 25,
  "delay": 2000,
  "reset": false
}
```

**Parameters**:
- `limit` (optional, default: 25) - Number of contacts to test
- `delay` (optional, default: 2000) - Delay in milliseconds between API calls (rate limiting)
  - Recommended: 250ms for trial keys (4 requests/sec)
  - Recommended: 200ms for optimal trial performance (5 requests/sec)
- `reset` (optional, default: false) - Clear previous test results before running

**Example - First Run** (trial key):
```bash
curl -X POST http://localhost:5151/v1/whitepages-test/run-test \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 25,
    "delay": 250,
    "reset": false
  }'
```

**Example - Reset and Rerun** (trial key):
```bash
curl -X POST http://localhost:5151/v1/whitepages-test/run-test \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 25,
    "delay": 250,
    "reset": true
  }'
```

**Response**:
```json
{
  "success": true,
  "message": "WhitePages test completed",
  "results": {
    "total": 25,
    "success": 8,
    "no_results": 12,
    "errors": 2,
    "skipped": 3,
    "success_rate": "36.4%",
    "details": [
      {
        "contact_id": 28636,
        "name": "Albert Chang",
        "status": "no_results"
      },
      {
        "contact_id": 28728,
        "name": "Sarah Chapman",
        "status": "success",
        "phones_found": 3,
        "emails_found": 2
      },
      {
        "contact_id": 29106,
        "name": "David Disiere",
        "status": "error",
        "error": "Request failed with status code 400"
      }
    ]
  }
}
```

### 3. Get Test Results
**Endpoint**: `GET /v1/whitepages-test/results`

**Description**: View results from previous test runs.

**Query Parameters**:
- `limit` (optional, default: 25) - Number of recent results to retrieve

**Example**:
```bash
curl http://localhost:5151/v1/whitepages-test/results?limit=25
```

**Response**:
```json
{
  "success": true,
  "statistics": {
    "total": 25,
    "success": 8,
    "no_results": 12,
    "errors": 5
  },
  "results": [
    {
      "id": 4,
      "contact_id": 28636,
      "name": "Albert Chang",
      "location": "Santa Fe, NM 87505",
      "status": "no_results",
      "error": null,
      "phones_found": 0,
      "emails_found": 0,
      "lookup_at": "2025-11-25T16:21:08.969Z"
    }
  ]
}
```

### 4. Clear Test Results
**Endpoint**: `DELETE /v1/whitepages-test/clear`

**Description**: Delete all lookup records (use with caution).

**Request Body**:
```json
{
  "confirm": "CLEAR_TEST_DATA"
}
```

**Example**:
```bash
curl -X DELETE http://localhost:5151/v1/whitepages-test/clear \
  -H "Content-Type: application/json" \
  -d '{"confirm": "CLEAR_TEST_DATA"}'
```

**Response**:
```json
{
  "success": true,
  "message": "Cleared 25 lookup records",
  "deleted_count": 25
}
```

## Testing Workflow

### Initial Test Run

1. **Preview test contacts**:
   ```bash
   curl http://localhost:5151/v1/whitepages-test/select-test-contacts?limit=25
   ```

2. **Run test** (conservative 2-second delays):
   ```bash
   curl -X POST http://localhost:5151/v1/whitepages-test/run-test \
     -H "Content-Type: application/json" \
     -d '{"limit": 25, "delay": 2000}'
   ```

3. **Review results**:
   ```bash
   curl http://localhost:5151/v1/whitepages-test/results
   ```

### Retest with Same Contacts

To rerun the test with the same contacts (after fixing issues):

```bash
curl -X POST http://localhost:5151/v1/whitepages-test/run-test \
  -H "Content-Type: application/json" \
  -d '{"limit": 25, "delay": 2000, "reset": true}'
```

The `reset: true` flag will:
- Delete previous lookup records for these contacts
- Allow them to be looked up again
- Provide fresh test data

### Testing After Prompt Updates

After updating extraction prompts for better state/zip parsing:

1. **Clear all test data**:
   ```bash
   curl -X DELETE http://localhost:5151/v1/whitepages-test/clear \
     -H "Content-Type: application/json" \
     -d '{"confirm": "CLEAR_TEST_DATA"}'
   ```

2. **Run new extraction** (process new documents with updated prompts)

3. **Run WhitePages test** on newly extracted contacts:
   ```bash
   curl -X POST http://localhost:5151/v1/whitepages-test/run-test \
     -H "Content-Type: application/json" \
     -d '{"limit": 25, "delay": 2000}'
   ```

4. **Compare results** - Check if success rate improved

## Test Data Quality Criteria

The test automatically filters contacts to ensure data quality:

### ✅ Valid Test Contacts
- First name and last name present
- State is 2-letter code (TX, NM, CA, etc.)
- Either:
  - Full address: street + city + state, OR
  - ZIP code + state

### ❌ Excluded from Tests
- Missing first or last name
- State field contains full name or ZIP (e.g., "Texas 76092")
- Missing all location data (no address, city, state, or zip)
- State is not 2-letter code

## Interpreting Results

### Result Status Types

1. **success**: WhitePages found the person with data
   - `phones_found`: Number of phone numbers returned
   - `emails_found`: Number of email addresses returned

2. **no_results**: WhitePages API returned empty array `[]`
   - Person not found in WhitePages database
   - Address or name may be incorrect

3. **error**: API call failed
   - Check `error` field for details
   - Common errors:
     - `400`: Bad request (malformed data)
     - `403`: Authentication failure
     - `429`: Rate limit exceeded

4. **skipped**: Contact already has lookup record
   - Use `reset: true` to retest

### Success Rate Calculation

```
success_rate = (successful_lookups / (total - skipped)) * 100
```

### Expected Results

**Good Data Quality**:
- Success rate: 30-50% (some people simply aren't in WhitePages)
- Errors: < 10%
- No results: 40-60% (normal for WhitePages)

**Poor Data Quality**:
- Success rate: < 10%
- Errors: > 20%
- Most errors are 400 (bad request) - indicates address parsing issues

## Rate Limiting

**WhitePages API Rate Limits**:
- **Trial API Keys**: 5 requests/second (burst allowance: 5)
- **Paid Plans**: 10 requests/second

**Recommended Delays**:
- **Trial Keys (Safe)**: 250ms (0.25 seconds) - 4 requests/second, stays under 5/sec limit
- **Trial Keys (Optimal)**: 200ms (0.2 seconds) - 5 requests/second, right at limit
- **Paid Plans (Safe)**: 125ms (0.125 seconds) - 8 requests/second, stays under 10/sec limit
- **Paid Plans (Optimal)**: 100ms (0.1 seconds) - 10 requests/second, right at limit

**Important Notes**:
- The 429 errors occur when exceeding requests/second, not daily limits
- If you see 429 errors, increase the delay (e.g., from 200ms to 250ms or 300ms)
- Each lookup consumes 1 API credit
- 25 contacts = 25 API credits (~5 seconds with 200ms delay)

## Automation

### Scheduled Testing

You can schedule periodic tests to monitor API health:

```bash
# Daily test at 2 AM
0 2 * * * curl -X POST http://localhost:5151/v1/whitepages-test/run-test \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "delay": 2000}' \
  >> /var/log/whitepages-test.log 2>&1
```

### CI/CD Integration

```bash
#!/bin/bash
# Test script for CI/CD pipeline

echo "Running WhitePages integration test..."

RESULT=$(curl -s -X POST http://localhost:5151/v1/whitepages-test/run-test \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "delay": 1000, "reset": true}')

SUCCESS_RATE=$(echo $RESULT | jq -r '.results.success_rate' | sed 's/%//')

if (( $(echo "$SUCCESS_RATE < 20" | bc -l) )); then
  echo "FAIL: Success rate too low ($SUCCESS_RATE%)"
  exit 1
fi

echo "PASS: Success rate acceptable ($SUCCESS_RATE%)"
exit 0
```

## Troubleshooting

### No Valid Contacts Found

**Problem**: `"No valid contacts found for testing"`

**Solution**:
1. Check contact data quality in database
2. Verify states are 2-letter codes (not full names)
3. Run extraction jobs to populate contacts table

### All Lookups Return Errors

**Problem**: `errors: 25, success: 0`

**Solution**:
1. Check API key is valid
2. Verify `X-Api-Key` header is being sent
3. Review error messages for specific issues
4. Test with Postman to isolate API vs. code issues

### Low Success Rate

**Problem**: `success_rate: "5%"`

**Causes**:
1. Poor address data quality (check for "Texas 76092" style issues)
2. Outdated contact information
3. People not in WhitePages database

**Solution**:
1. Update extraction prompts for better parsing
2. Test with known-good contacts first
3. Review WhitePages API documentation for data requirements

## Related Documentation

- [WhitePages Integration Guide](./whitepages-integration.md)
- [State/ZIP Parsing Rules](./state-zip-parsing-rules.md)
- [Extraction Prompts](../prompts/extraction-prompts.js)

---

**Note**: This test system is designed for development and QA. For production batch processing, use the main `/v1/whitepages/batch` endpoint instead.
