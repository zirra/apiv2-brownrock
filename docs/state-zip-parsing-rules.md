# State and ZIP Code Parsing Rules

**Purpose**: Ensure all Claude extraction prompts correctly parse US state codes and ZIP codes from addresses

## Critical Rules

### State Codes
**REQUIRED FORMAT**: Always use 2-letter US state abbreviations

**Examples**:
- ✅ CORRECT: `"state": "TX"`, `"state": "NM"`, `"state": "CA"`
- ❌ WRONG: `"state": "Texas"`, `"state": "New Mexico"`, `"state": "Texas 76092"`

### ZIP Codes
**REQUIRED FORMAT**: 5-digit or 9-digit US ZIP codes, stored separately from state

**Examples**:
- ✅ CORRECT: `"zip": "88203"`, `"zip": "77024-1234"`
- ❌ WRONG: `"state": "Texas 76092"`, `"state": "NM 88203"`

## State Name to Abbreviation Mapping

Use this mapping to convert full state names to 2-letter codes:

| Full Name | Abbreviation | Full Name | Abbreviation |
|-----------|--------------|-----------|--------------|
| Alabama | AL | Montana | MT |
| Alaska | AK | Nebraska | NE |
| Arizona | AZ | Nevada | NV |
| Arkansas | AR | New Hampshire | NH |
| California | CA | New Jersey | NJ |
| Colorado | CO | New Mexico | NM |
| Connecticut | CT | New York | NY |
| Delaware | DE | North Carolina | NC |
| Florida | FL | North Dakota | ND |
| Georgia | GA | Ohio | OH |
| Hawaii | HI | Oklahoma | OK |
| Idaho | ID | Oregon | OR |
| Illinois | IL | Pennsylvania | PA |
| Indiana | IN | Rhode Island | RI |
| Iowa | IA | South Carolina | SC |
| Kansas | KS | South Dakota | SD |
| Kentucky | KY | Tennessee | TN |
| Louisiana | LA | Texas | TX |
| Maine | ME | Utah | UT |
| Maryland | MD | Vermont | VT |
| Massachusetts | MA | Virginia | VA |
| Michigan | MI | Washington | WA |
| Minnesota | MN | West Virginia | WV |
| Mississippi | MS | Wisconsin | WI |
| Missouri | MO | Wyoming | WY |
| | | District of Columbia | DC |

## Common Parsing Errors and Solutions

### Error 1: State Contains ZIP Code
**Problem**: `"state": "Texas 76092"`, `"zip": null`
**Solution**: Parse as `"state": "TX"`, `"zip": "76092"`

### Error 2: Full State Name Used
**Problem**: `"state": "New Mexico"`, `"zip": "88203"`
**Solution**: Convert to `"state": "NM"`, `"zip": "88203"`

### Error 3: State and ZIP Combined in Address
**Problem**:
```
"address": "123 Main St, Houston, Texas 77024"
"city": null
"state": null
"zip": null
```
**Solution**: Parse into separate fields:
```
"address": "123 Main St"
"city": "Houston"
"state": "TX"
"zip": "77024"
```

### Error 4: ZIP in State Column
**Problem**: `"state": "88203"`, `"zip": null`
**Solution**: Recognize 5-digit numbers as ZIPs: `"state": null`, `"zip": "88203"`

## Parsing Algorithm

1. **Identify Components**: Split address into: street, city, state, ZIP
2. **Extract ZIP**: Look for 5-digit or 9-digit numbers (format: 12345 or 12345-6789)
3. **Extract State**:
   - If 2 letters → use as-is
   - If full name → convert using mapping table
   - If "State ZIP" format → split and convert state part
4. **Validate**:
   - State must be 2 letters
   - ZIP must be 5 or 9 digits
   - If validation fails, set field to null

## Examples of Correct Parsing

### Example 1: Well-Formatted Address
**Input**: `"123 Main Street, Houston, TX 77024"`
**Output**:
```json
{
  "address": "123 Main Street",
  "city": "Houston",
  "state": "TX",
  "zip": "77024"
}
```

### Example 2: Full State Name
**Input**: `"456 Oak Ave, Dallas, Texas 75201-1234"`
**Output**:
```json
{
  "address": "456 Oak Ave",
  "city": "Dallas",
  "state": "TX",
  "zip": "75201-1234"
}
```

### Example 3: State and ZIP Together
**Input**:
- Address: `"789 Elm St"`
- City: `"Roswell"`
- State column: `"New Mexico 88203"`

**Output**:
```json
{
  "address": "789 Elm St",
  "city": "Roswell",
  "state": "NM",
  "zip": "88203"
}
```

### Example 4: Missing ZIP
**Input**: `"321 Pine Rd, Santa Fe, NM"`
**Output**:
```json
{
  "address": "321 Pine Rd",
  "city": "Santa Fe",
  "state": "NM",
  "zip": null
}
```

## Integration Instructions for Prompts

Add this section to all extraction prompts BEFORE the JSON FORMAT section:

```
⚠️ CRITICAL: STATE AND ZIP CODE PARSING RULES

STATES - MUST USE 2-LETTER ABBREVIATIONS ONLY:
- Texas → TX
- New Mexico → NM
- California → CA
- All other states → Use standard 2-letter US Postal abbreviations

ZIP CODES - SEPARATE FIELD, NOT IN STATE:
- Format: 5 digits (12345) or 9 digits (12345-6789)
- Extract from address string or separate column
- NEVER include in state field

COMMON ERRORS TO FIX:
1. "Texas 76092" → state: "TX", zip: "76092"
2. "New Mexico" → state: "NM"
3. "77024" in state column → state: null, zip: "77024"
4. "NM 88203" → state: "NM", zip: "88203"

PARSING METHODOLOGY:
1. Identify all address components (street, city, state, zip)
2. Extract 5 or 9-digit numbers → these are ZIP codes
3. Find state name or abbreviation:
   - If 2 letters → use as-is (must be uppercase)
   - If full name → convert to 2-letter abbreviation
   - If "State Zip" format → split, convert state, extract zip
4. Validate: state = 2 letters, zip = 5 or 9 digits
5. If parsing fails, set individual fields to null (don't guess)

STATE ABBREVIATION TABLE:
AL=Alabama, AK=Alaska, AZ=Arizona, AR=Arkansas, CA=California, CO=Colorado,
CT=Connecticut, DE=Delaware, FL=Florida, GA=Georgia, HI=Hawaii, ID=Idaho,
IL=Illinois, IN=Indiana, IA=Iowa, KS=Kansas, KY=Kentucky, LA=Louisiana,
ME=Maine, MD=Maryland, MA=Massachusetts, MI=Michigan, MN=Minnesota,
MS=Mississippi, MO=Missouri, MT=Montana, NE=Nebraska, NV=Nevada, NH=New Hampshire,
NJ=New Jersey, NM=New Mexico, NY=New York, NC=North Carolina, ND=North Dakota,
OH=Ohio, OK=Oklahoma, OR=Oregon, PA=Pennsylvania, RI=Rhode Island, SC=South Carolina,
SD=South Dakota, TN=Tennessee, TX=Texas, UT=Utah, VT=Vermont, VA=Virginia,
WA=Washington, WV=West Virginia, WI=Wisconsin, WY=Wyoming, DC=District of Columbia
```

## Testing Checklist

After updating prompts, verify with these test cases:

- [ ] "Houston, Texas 77024" → city: "Houston", state: "TX", zip: "77024"
- [ ] "New Mexico 88203" → state: "NM", zip: "88203"
- [ ] "California" → state: "CA", zip: null
- [ ] "Roswell, NM" → city: "Roswell", state: "NM", zip: null
- [ ] "Dallas, TX 75201-1234" → city: "Dallas", state: "TX", zip: "75201-1234"
