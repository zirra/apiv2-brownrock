/**
 * Extraction Prompts Library
 *
 * Centralized prompt management for different document types
 * Each document type has 'native' (for PDF vision) and 'text' (for extracted text) prompts
 *
 * Template variables (use ${VARIABLE_NAME}):
 * - ${PROJECT_ORIGIN} - Project origin name (e.g., 'OCD Imaging', 'Permian Basin Project')
 * - ${DOCUMENT_TYPE} - Document type name
 */

module.exports = {
  /**
   * Oil & Gas Contact Extraction
   * For extracting contact information from oil & gas documents
   */
  'oil-gas-contacts': {
    native: `Extract contact information from this oil & gas document. Return JSON array only.

⚠️ CRITICAL MULTI-PAGE INSTRUCTION:
You are viewing ALL pages of this document at once. Tables often span MULTIPLE pages.
- Scan EVERY page for table continuations
- A table that starts on page 1 may continue on pages 2, 3, 4, etc.
- Look for consistent column structures across pages (same headers/format)
- Extract EVERY row from ALL pages - do not stop after the first page
- Count total entries to verify completeness (e.g., if you see "34 entries" but table continues, keep extracting)

EXTRACT:
- Names (individuals, companies, trusts)
- Complete addresses
- Phone/email if present
- Ownership info (percentages, interest types)
- Mineral rights ownership percentage (as decimal, e.g., 25.5 for 25.5%)

PRIORITY SOURCES (extract ALL from ALL pages):
- **POSTAL DELIVERY REPORTS/TABLES** (MOST CRITICAL - contains certified mail recipients)
  * Tables titled "Postal Delivery Report" or similar
  * Identified by USPS tracking numbers (starting with 9414...) in first column
  * Column structure: Tracking# | Name | Address | City | State | Zip | Delivery Status
  * ⚠️ THESE TABLES SPAN MULTIPLE PAGES - Extract from ALL pages, not just the first
  * Extract ALL entries across all pages - these are verified recipients of notice
  * Ignore tracking numbers themselves, but use them to identify postal tables
  * Combine address fields into complete address
  * Include delivery status/date in notes field
- Transaction report, Transaction Report Details, CertifiedPro.net reports (check all pages)
- **Tables with columns like "Name 1", "Name 2", "Address1", "Address2" - recipient lists (multi-page)**
- Interest owner tables (WI, ORRI, MI, UMI owners) - check all pages
- Revenue/mailing lists - check all pages
- **Tract ownership breakdowns (pages with "Summary of Interests" by tract)**
- **Unit-level ownership summaries (consolidated ownership across all tracts)**

POSTAL DELIVERY TABLES (CRITICAL IDENTIFICATION):
- **KEY IDENTIFIER**: Look for tables with USPS tracking numbers (format: 9414811898765448760XXX) in the first column
- These tracking numbers indicate a POSTAL DELIVERY REPORT table
- **IGNORE the tracking numbers in extraction** - they are only for table identification
- Extract from columns: Name | Address | City | State | Zip | Delivery Status
- Combine address components: "Address, City, State Zip"
- Put delivery confirmation in notes field (e.g., "Delivered June 13, 2025", "Picked up June 10, 2025")
- ⚠️ CRITICAL: Extract ALL rows from EVERY PAGE where this table continues
- These tables typically span 3-10+ pages - scan the ENTIRE document for continuation rows
- Same column structure = same table continuation (even if headers don't repeat on every page)
- Do not stop extraction until you've checked every page in the document

SPECIAL FORMATS:
- **For tables with "Name 1" and "Name 2" columns:**
  * Combine Name 1 and Name 2 as a single entity
  * If Name 2 is blank, use only Name 1
  * Example: Name 1="Bureau of Land Management", Name 2="Department of the Interior, USA" → company="Bureau of Land Management, Department of the Interior, USA"
- **For Postal Delivery tables:**
  * Single Name column contains individual or company name
  * Address/City/State/Zip in separate columns - combine all
  * Status column shows delivery confirmation - include in notes
- Combine Address1 and Address2 fields into complete address
- Extract all rows regardless of "Mailing Status" column
- **For tables with no headers analyze them for the contact data that we are collecting

OWNERSHIP STRUCTURE:
- Units contain multiple Tracts
- Extract BOTH tract-level AND unit-level ownership
- Unit-level summary typically appears as:
  * "Summary of Interests"
  * "Matador Working Interest" / "Voluntary Joinder" / "Compulsory Pool Interest"
  * Tables showing working interest percentages by tract
  * Overall interest owner breakdowns

EXCLUDE (skip entirely):
- Attorneys, lawyers, law firms
- Legal professionals (Esq., J.D., P.C., P.A., PLLC, LLP)
- Legal services/representatives
EXCEPTION: Include trusts/trustees from postal/interest tables (they're owners, not lawyers)

JSON FORMAT:
{
  "company": "Business name or null",
  "name": "Full name or null",
  "first_name": "First name if separable",
  "last_name": "Last name if separable",
  "address": "Complete address",
  "phone": "Phone with type",
  "email": "Email if present",
  "ownership_info": "Percentages/fractions (keep for reference)",
  "mineral_rights_percentage": "Ownership % as decimal (0-100), null if not specified",
  "ownership_type": "WI, ORRI, or UMI only (null if other or unspecified)",
  "tract_info": "Tract number(s) if tract-level data",
  "unit_level": true/false,
  "notes": "Additional details, delivery status, or address_unknown: true if no address",
  "record_type": "individual/company/joint",
  "document_section": "Source table/section (e.g., 'Tract 1', 'Unit Summary', 'Postal Delivery Report', 'Transaction Report')"
}

OWNERSHIP TYPE MAPPING:
- WI = Working Interest
- ORRI = Overriding Royalty Interest
- UMI = Unleased Mineral Interest
- Only use these three codes, set to null for any other type (including MI, Committed, Uncommitted)

PERCENTAGE EXTRACTION:
- Convert fractions to decimals (e.g., 1/4 = 25.0, 3/8 = 37.5)
- Extract percentages as numbers (e.g., "25.5%" becomes 25.5)
- If multiple percentages exist, use the primary/largest one
- Set to null if no percentage information found

OWNERSHIP PRIORITY:
1. Extract unit-level summary first (this is the overall ownership across all tracts)
2. Then extract individual tract breakdowns
3. Mark unit_level: true for consolidated ownership, false for tract-specific

Requirements:
- Must have name/company AND (address OR be listed in Chronology of Contacts or recapitulation table)
- If no address available, include party if they appear in:
  * **Postal Delivery Report tables (even if delivery failed)**
  * Chronology of Contacts section (even with N/A address)
  * Recapitulation/ownership tables with interest type
  * Mark as "address_unknown": true in notes field
- Remove duplicates
- When uncertain if legal professional, exclude UNLESS from postal/interest table
- For parties marked "Stranger in title" or "Notify" status, include them with whatever information is available
- No text outside JSON array

⚠️ FINAL VERIFICATION BEFORE RESPONDING:
Before you finalize your response, verify:
1. Did you scan ALL pages of the document? (Not just page 1)
2. Did you extract from ALL pages where tables continue? (Tables often span 5-10+ pages)
3. Count your extracted entries - if the document shows "X recipients" and you have fewer, go back and extract the missing pages
4. Look for page numbers or table row numbers that indicate continuation (e.g., entries 1-50 on page 1, entries 51-100 on page 2, etc.)
5. Postal delivery tables are the PRIMARY source - make sure you got EVERY recipient from EVERY page

POSTAL DELIVERY TABLE EXAMPLES:

Example 1 - Standard Entry:
9414811898765448760725 | AmericaWest Resources, LLC Total | PO Box 3383 | Midland | TX | 79702-3383 | Delivered June 13, 2025

EXTRACT AS:
{
  "company": "AmericaWest Resources, LLC Total",
  "name": null,
  "first_name": null,
  "last_name": null,
  "address": "PO Box 3383, Midland, TX 79702-3383",
  "phone": null,
  "email": null,
  "ownership_info": null,
  "mineral_rights_percentage": null,
  "ownership_type": null,
  "tract_info": null,
  "unit_level": false,
  "notes": "Delivered June 13, 2025",
  "record_type": "company",
  "document_section": "Postal Delivery Report"
}

Example 2 - Individual Entry:
9414811898765448760749 | Baker C. Donnelly | PO Box 4777 | Austin | TX | 78765-4777 | Reminder to pick up

EXTRACT AS:
{
  "company": null,
  "name": "Baker C. Donnelly",
  "first_name": "Baker",
  "last_name": "Donnelly",
  "address": "PO Box 4777, Austin, TX 78765-4777",
  "phone": null,
  "email": null,
  "ownership_info": null,
  "mineral_rights_percentage": null,
  "ownership_type": null,
  "tract_info": null,
  "unit_level": false,
  "notes": "Reminder to pick up at Austin post office",
  "record_type": "individual",
  "document_section": "Postal Delivery Report"
}

Example 3 - Trust Entry:
9414811898765448760497 | Richard Donnelly, Trustee Under The George A. Donnelly TR FBO David Preston, Richard Jr. and Martha Brittain Donnelly | PO Box 3506 | Midland | TX | 79702-3506 | Picked up June 13, 2025

EXTRACT AS:
{
  "company": "Richard Donnelly, Trustee Under The George A. Donnelly TR FBO David Preston, Richard Jr. and Martha Brittain Donnelly",
  "name": null,
  "first_name": null,
  "last_name": null,
  "address": "PO Box 3506, Midland, TX 79702-3506",
  "phone": null,
  "email": null,
  "ownership_info": null,
  "mineral_rights_percentage": null,
  "ownership_type": null,
  "tract_info": null,
  "unit_level": false,
  "notes": "Picked up June 13, 2025",
  "record_type": "company",
  "document_section": "Postal Delivery Report"
}

Text content:
\${TEXT_CONTENT}`,

    text: `Extract contact information from the following extracted text content. Return ONLY a JSON array, no other text.

EXTRACT:
- Names (individuals, companies, trusts)
- Complete addresses
- Phone/email if present
- Ownership info (percentages, interest types)
- Mineral rights ownership percentage (as decimal, e.g., 25.5 for 25.5%)

PRIORITY SOURCES (extract ALL):
- Postal Delivery Reports/Tables (MOST CRITICAL - contains certified mail recipients)
- Transaction reports, CertifiedPro.net reports
- Interest owner tables (WI, ORRI, MI, UMI owners)
- Revenue/mailing lists
- Tract ownership breakdowns
- Unit-level ownership summaries

EXCLUDE (skip entirely):
- Attorneys, lawyers, law firms, legal professionals
- EXCEPTION: Include trusts/trustees from postal/interest tables (they're owners, not lawyers)

JSON FORMAT (return array of objects):
{
  "company": "Business name or null",
  "name": "Full name or null",
  "first_name": "First name if separable",
  "last_name": "Last name if separable",
  "address": "Complete address",
  "phone": "Phone with type",
  "email": "Email if present",
  "ownership_info": "Percentages/fractions",
  "mineral_rights_percentage": "Ownership % as decimal (0-100), null if not specified",
  "ownership_type": "WI, ORRI, or UMI only (null if other)",
  "tract_info": "Tract number(s) if tract-level data",
  "unit_level": true/false,
  "notes": "Additional details or address_unknown: true if no address",
  "record_type": "individual/company/joint",
  "document_section": "Source table/section"
}

Requirements:
- Return ONLY the JSON array, no explanatory text
- Must have name/company AND address (or mark address_unknown: true)
- Remove duplicates
- No text outside JSON array

Text content:
\${TEXT_CONTENT}`
  },

  /**
   * Lease Agreement Extraction
   * For extracting lease terms and parties from lease agreements
   */
  'lease-agreements': {
    native: `Extract lease agreement information from this PDF document. Return JSON array only.

EXTRACT:
- Lessor names and addresses
- Lessee names and addresses
- Effective dates and expiration dates
- Lease terms and conditions
- Royalty percentages
- Bonus payments
- Acreage information

JSON FORMAT:
{
  "lessor_name": "Lessor full name or null",
  "lessor_address": "Complete address",
  "lessee_name": "Lessee full name or null",
  "lessee_address": "Complete address",
  "effective_date": "Lease effective date",
  "expiration_date": "Lease expiration date",
  "royalty_percentage": "Royalty % as decimal",
  "bonus_payment": "Bonus amount with currency",
  "acreage": "Total acreage",
  "notes": "Additional lease terms",
  "document_section": "Source section"
}

Requirements:
- Must have lessor OR lessee information
- Extract all monetary amounts with currency
- No text outside JSON array`,

    text: `Extract lease agreement information from this document. Return JSON array only.

EXTRACT:
- Lessor names and addresses
- Lessee names and addresses
- Effective dates and expiration dates
- Lease terms and conditions
- Royalty percentages
- Bonus payments
- Acreage information

JSON FORMAT:
{
  "lessor_name": "Lessor full name or null",
  "lessor_address": "Complete address",
  "lessee_name": "Lessee full name or null",
  "lessee_address": "Complete address",
  "effective_date": "Lease effective date",
  "expiration_date": "Lease expiration date",
  "royalty_percentage": "Royalty % as decimal",
  "bonus_payment": "Bonus amount with currency",
  "acreage": "Total acreage",
  "notes": "Additional lease terms",
  "document_section": "Source section"
}

Requirements:
- Must have lessor OR lessee information
- Extract all monetary amounts with currency
- No text outside JSON array

Text content:
\${TEXT_CONTENT}`
  }
}
