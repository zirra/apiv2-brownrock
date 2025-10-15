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
    native: `Extract contact information from this oil & gas PDF document. Return JSON array only.

EXTRACT:
- Names (individuals, companies, trusts)
- Complete addresses
- Phone/email if present
- Ownership info (percentages, interest types)
- Mineral rights ownership percentage (as decimal, e.g., 25.5 for 25.5%)

PRIORITY SOURCES (extract ALL):
- Postal delivery tables/certified mail lists
- Transaction report, Transaction Report Details
- Interest owner tables (WI, ORRI, MI, UMI owners)
- Revenue/mailing lists

EXCLUDE (skip entirely):
- Attorneys, lawyers, law firms
- Legal professionals (Esq., J.D., P.C., P.A., PLLC, LLP)
- Legal services/representatives
EXCEPTION: Include trusts/trustees from postal/interest tables (they're owners, not lawyers)

POSTAL TABLES:
- Ignore tracking numbers
- Extract recipient names + addresses
- Extract names + addresses
- Combine address components
- Trusts go in "company" field with full dtd notation

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
  "notes": "Additional details",
  "record_type": "individual/company/joint",
  "document_section": "Source table/section"
}

OWNERSHIP TYPE MAPPING:
- WI = Working Interest
- ORRI = Overriding Royalty Interest
- UMI = Unleased Mineral Interest
- Only use these three codes, set to null for any other type

PERCENTAGE EXTRACTION:
- Convert fractions to decimals (e.g., 1/4 = 25.0, 3/8 = 37.5)
- Extract percentages as numbers (e.g., "25.5%" becomes 25.5)
- If multiple percentages exist, use the primary/largest one
- Set to null if no percentage information found

Requirements:
- Must have name/company AND address
- Remove duplicates
- When uncertain if legal professional, exclude UNLESS from postal/interest table
- No text outside JSON array`,

    text: `Extract contact information from this oil & gas document. Return JSON array only.

EXTRACT:
- Names (individuals, companies, trusts)
- Complete addresses
- Phone/email if present
- Ownership info (percentages, interest types)
- Mineral rights ownership percentage (as decimal, e.g., 25.5 for 25.5%)

PRIORITY SOURCES (extract ALL):
- Postal delivery tables/certified mail lists
- Transaction report, Transaction Report Details, CertifiedPro.net reports
- **Tables with columns like "Name 1", "Name 2", "Address1", "Address2" - these are recipient lists**
- Interest owner tables (WI, ORRI, MI, UMI owners)
- Revenue/mailing lists
- **Tract ownership breakdowns (pages with "Summary of Interests" by tract)**
- **Unit-level ownership summaries (consolidated ownership across all tracts)**

SPECIAL FORMATS:
- **For tables with "Name 1" and "Name 2" columns:**
  * Combine Name 1 and Name 2 as a single entity
  * If Name 2 is blank, use only Name 1
  * Example: Name 1="Bureau of Land Management", Name 2="Department of the Interior, USA" → company="Bureau of Land Management, Department of the Interior, USA"
- Combine Address1 and Address2 fields into complete address
- Extract all rows regardless of "Mailing Status" column

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

POSTAL TABLES:
- Ignore tracking numbers, USPS Article Numbers, mailing dates, reference numbers
- Extract recipient names from ANY name field (Name, Name 1, Name 2, Recipient Name)
- Combine all address components (Address1, Address2, Street Address, City, State, Zip)
- Trusts go in "company" field with full dtd notation

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
  "notes": "Additional details",
  "record_type": "individual/company/joint",
  "document_section": "Source table/section (e.g., 'Tract 1', 'Unit Summary', 'Postal Table', 'Transaction Report')"
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
- Must have name/company AND (address OR ownership_info)
- Remove duplicates (same owner across multiple tracts = one record with all tracts listed)
- When uncertain if legal professional, exclude UNLESS from postal/interest table
- For owners appearing in multiple tracts, consolidate into single record with all tract numbers
- **Process every row in postal/transaction tables even if status shows "Mailed", "Delivered", or other**
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
