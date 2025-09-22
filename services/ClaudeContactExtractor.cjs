const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const TableName = process.env.DYNAMO_TABLE
const DynamoClient = require('../config/dynamoclient.cjs')
require('dotenv').config()

const {
  CopyObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');


class ClaudeContactExtractor {
  constructor(config) {
    this.anthropic = new Anthropic({
      apiKey: config.anthropicApiKey
    });

    this.s3Client = new S3Client({
      region: config.awsRegion || 'us-east-1',
      ...(config.awsAccessKeyId && config.awsSecretAccessKey && {
        credentials: {
          accessKeyId: config.awsAccessKeyId,
          secretAccessKey: config.awsSecretAccessKey
        }
      })
    })

    this.config = config
    this.logger = console
  }

  
  /**
   * Extract text content from PDF buffer
   */
  async extractTextFromPDF(pdfBuffer) {
    try {
      const data = await pdf(pdfBuffer);
      return data.text;
    } catch (error) {
      this.logger.error('Error extracting text from PDF:', error.message);
      return '';
    }
  }

  stamp() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed, so add 1
    const day = String(today.getDate()).padStart(2, '0');
    const year = today.getFullYear();

    return `${month}_${day}_${year}`;
  }

  async writeDynamoMessage (message) {
    const timestamp = new Date().toISOString()
    try {
      let document = await DynamoClient.addItem({
        TableName,
        Item: {
          pkey: `${message.pkey}#${this.stamp()}`,
          skey: message.skey,
          message: `${message.data}`,
          timestamp
        }
      })
      return document
    } catch (e) {
      console.log(e)
      return e
    }
  }

  /**
   * Use Claude to extract contact information from text
   */
  async extractContactInfoWithClaude(textContent) {
    const prompt = `
Please analyze the following text content from a PDF and extract all contact information from structured data including:

PRIORITY DATA TO EXTRACT:

Company/Entity Names - Look for LLC, Inc, LP, Company, Corporation, Resources, Oil, Gas, Minerals, Holdings, Trust, Partnership, etc.
Individual Names - Personal names that may be property owners, officers, or contacts
Complete Addresses - Street addresses, PO Boxes, City, State, ZIP codes
Contact Information - Phone numbers, fax numbers, email addresses
Ownership Information - Look for percentages, fractions, or ownership indicators like (1), (2), etc.

EXCLUSION FILTERS - DO NOT EXTRACT:

Legal Professionals - Skip any records containing:
- Attorney, Atty, Lawyer, Legal, Law Firm, Law Office, Law Group
- Esquire, Esq., J.D., Juris Doctor
- Professional titles: P.C., P.A., PLLC, LLP when clearly indicating law firms
- "Counsel", "Legal Representative", "Legal Department"
- Bar Association memberships or legal licensing indicators
- Law school affiliations or legal education credentials

Focus Only On:
- Interest owners (mineral, royalty, working interest owners)
- Pooled parties and pooling participants
- Revenue recipients and distribution parties
- Mailing lists for notices and payments
- Business entities involved in oil & gas operations
- Individual property owners and interest holders

SPECIFIC PATTERNS TO LOOK FOR:

Interest Owner Tables:
- Tables with "Owner", "Owners", "Lessor", "Lessee", "Owners to be pooled" headers
- Tables with "WI Owner", "Working Interest Owner", "ORRI Owner", "ORRI Owners", "ORRI Owners to be Pooled", "Overriding Royalty Interest Owner" headers
- Tables with "Unleased Owner", "UMI", "Leased", "Leased Owner" headers
- Tables with "Mineral Interest Owner", "MI Owner", "Uncommitted Mineral Interest" headers

Mailing and Contact Lists:
- Mailing lists for revenue distributions
- Notice recipient lists
- Contact directories for interest owners
- Emergency contact information for operations

Business Operations:
- Oil & gas industry entities (Royalty, Mineral, Resources, Energy, Exploration companies)
- Operating companies and their contacts
- Service companies involved in operations
- Regulatory contact information

Document Types to Process:
- Division order schedules or revenue distribution lists
- Joint interest billing statements
- Working interest schedules and mineral ownership reports
- Royalty distribution statements and decimal interest listings
- Pooling applications and orders
- Unit agreements and participation schedules

EXTRACTION RULES:

If you see a company name immediately followed by an address, treat them as one contact record
Phone numbers in parentheses like (cell), (office), (fax) should be noted with their type
Capture ownership percentages, fractions, or decimal interests if present (e.g., "25%", "1/4", "0.25", "0.125000")
Identify and capture interest types: WI (Working Interest), ORRI (Overriding Royalty Interest), MI (Mineral Interest), UMI (Uncommitted Mineral Interest), NRI (Net Revenue Interest), RI (Royalty Interest)
Include PO Box addresses as complete addresses
If a name appears with ownership indicators like (1) or (2), include that in notes
For husband/wife or joint ownership, create separate records when possible
Extract email addresses if present
Handle "c/o" (care of) addresses appropriately
Look for "Attn:" or "Attention:" lines for contact persons (unless they're attorneys)
Parse multi-line addresses carefully
Distinguish between leased and unleased mineral interests
Capture decimal interest notations common in oil & gas (e.g., 0.125000, 0.25000)

DUPLICATE HANDLING:

Remove duplicate entries based on exact name/company matches
For near-duplicate names (minor spelling variations, abbreviations), consolidate into single record and note variations in notes field
If same person/company appears with different addresses, create separate records but note the relationship in notes field
If same person/company appears with different ownership interests, consolidate into single record with combined ownership information
For husband/wife pairs that may appear separately and jointly, consolidate when clearly referring to same people
Use fuzzy matching for common name variations (e.g., "John Smith" vs "J. Smith", "ABC Company" vs "ABC Co.")
Priority order for consolidation: most complete address > most recent information > highest ownership percentage
Note in 'notes' field when records have been consolidated from duplicates

ADDRESS PARSING GUIDELINES:

Combine multi-line addresses into single address field
Include apartment/unit numbers
Standardize state abbreviations
Preserve ZIP+4 codes when present
Handle international addresses

DATA VALIDATION:

Ensure phone numbers follow standard formats
Validate email addresses have proper format
Check that ZIP codes are reasonable (5 or 9 digits)
Flag incomplete addresses in notes

Return as a JSON array with these field names:

company: Business/organization name (null if individual)
name: Individual's full name (null if company only)
first_name: Individual's first name (if separable)
last_name: Individual's last name (if separable)
address: Complete address including street, city, state, zip
phone: Phone number with type if specified
fax: Fax number if present
email: Email address if present
ownership_info: Any ownership percentages, fractions, decimal interests, or indicators (e.g., "25% WI", "1/8 ORRI", "0.125000 NRI", "UMI", "Unleased")
interest_type: Type of ownership interest (e.g., "Working Interest", "ORRI", "Mineral Interest", "Royalty Interest", "UMI", "Leased", "Unleased")
notes: Additional relevant details like heir/assign status, document references, incomplete data warnings, interest descriptions, duplicate consolidation notes
record_type: "company" or "individual" or "joint"
document_section: Which part of document this came from (if identifiable)

QUALITY REQUIREMENTS:

Only include records with at least a name/company AND address
Mark incomplete records in notes field
If ownership percentage is 0% or negligible, still include the contact
Preserve original formatting for ownership fractions
Include "DBA" (doing business as) information when present
SKIP any record that appears to be a legal professional or law firm

ERROR HANDLING:

If address is incomplete, note what's missing in notes field
If name parsing is uncertain, include full name in 'name' field
For unclear company vs individual determination, default to 'individual' and note uncertainty
If unsure whether someone is a legal professional, err on the side of exclusion

If no contact information is found, return an empty array [].
Only return the JSON array, no additional text or formatting.

Text content to analyze:
${textContent.substring(0, 15000)}
        `.trim();

    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: prompt
        }]
      });

      const responseText = response.content[0].text;

      // Extract JSON from response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const contacts = JSON.parse(jsonMatch[0]);
        return Array.isArray(contacts) ? contacts : [];
      } else {
        this.logger.warn('No JSON array found in Claude response');
        return [];
      }

    } catch (error) {
      this.logger.error('Error processing with Claude:', error.message);
      return [];
    }
  }

  /**
   * Download PDF from S3
   */
  async downloadPDFFromS3(bucketName, key) {
    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key
      });

      const response = await this.s3Client.send(command);

      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.error(`Error downloading ${key} from S3:`, error.message);
      return null;
    }
  }

  /**
   * Upload CSV to S3
   */
  async uploadCSVToS3(csvContent, bucketName, key) {
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: `claude-csv/${key}`,
        Body: csvContent,
        ContentType: 'text/csv',
        ServerSideEncryption: 'AES256',
        ACL: 'public-read'
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      this.logger.error('Error uploading CSV to S3:', error.message);
      return false;
    }
  }

  /**
   * Convert contact data to CSV format
   */
  convertToCSV(contacts) {
    if (!contacts || contacts.length === 0) {
      return 'No contacts found';
    }

    // Get all unique keys from all contacts
    const allKeys = new Set();
    contacts.forEach(contact => {
      Object.keys(contact).forEach(key => allKeys.add(key));
    });

    const headers = Array.from(allKeys);

    // Create CSV header
    const csvRows = [headers.join(',')];

    // Add data rows
    contacts.forEach(contact => {
      const row = headers.map(header => {
        const value = contact[header] || '';
        // Escape quotes and wrap in quotes if contains comma
        if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      });
      csvRows.push(row.join(','));
    });

    return csvRows.join('\n');
  }

  async moveFileToFailedBucket(sourceBucket, sourceKey, targetBucket, targetPrefix) {
    try {
      const destinationKey = path.join(targetPrefix, path.basename(sourceKey));

      // Step 1: Copy the object to the failed location
      await this.s3Client.send(new CopyObjectCommand({
        CopySource: encodeURIComponent(`${sourceBucket}/${sourceKey}`),
        Bucket: targetBucket,
        Key: destinationKey,
        ACL: 'public'
      }));

      // Step 2: Delete the original
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: sourceBucket,
        Key: sourceKey
      }));

      this.logger.info(`Moved failed PDF to s3://${targetBucket}/${destinationKey}`);
    } catch (error) {
      this.logger.error(`Failed to move ${sourceKey} to failed bucket:`, error.message);
    }
  }
  /**
   * Process a single PDF file
   */
  async processSinglePDF(sourceBucket, pdfKey, file) {
    this.logger.info(`Processing PDF: ${pdfKey}`);

    try {
      // Download PDF
      const pdfBuffer = await this.downloadPDFFromS3(sourceBucket, pdfKey);
      if (!pdfBuffer) {
        return [];
      }

      // Extract text
      /* old
      const textContent = await this.extractTextFromPDF(pdfBuffer);
      if (!textContent.trim()) {
        this.logger.warn(`No text content extracted from ${pdfKey}`);
        return [];
      }
      */

      const textContent = await this.extractTextFromPDF(pdfBuffer);
      if (!textContent.trim()) {
        this.logger.warn(`No text content extracted from ${pdfKey}`);

        // Move file to failed location
        await this.moveFileToFailedBucket(sourceBucket, pdfKey, this.config.failedBucket || sourceBucket, 'failed-pdfs/');

        return [];
      }
      // Extract contacts using Claude
      const contacts = await this.extractContactInfoWithClaude(textContent);

      // Add metadata
      const timestamp = new Date().toISOString();
      contacts.forEach(contact => {
        contact.source_file = pdfKey;
        contact.processed_date = timestamp;
      });

      this.logger.info(`Extracted ${contacts.length} contacts from ${pdfKey}`);
      return contacts;

    } catch (error) {
      this.logger.error(`Error processing ${pdfKey}:`, error.message);
      return [];
    }
  }

  /**
   * Process multiple PDF files
   */
  async processPDFList(sourceBucket, pdfKeys, outputBucket, outputKey = null) {

    await this.writeDynamoMessage({ 
      pkey: 'claude#pdfList',
      skey: 'claude#processing',
      origin: 'claude', 
      type:'system', 
      data: `SUCCESS: Starting to process ${pdfKeys.length} PDF files`
    })

    this.logger.info(`Starting to process ${pdfKeys.length} PDF files`);

    const allContacts = [];

    // Process PDFs in batches to avoid overwhelming the API
    const batchSize = 3;
    for (let i = 0; i < pdfKeys.length; i += batchSize) {
      const batch = pdfKeys.slice(i, i + batchSize);

      const batchPromises = batch.map(pdfKey =>
        this.processSinglePDF(sourceBucket, pdfKey)
      );

      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach(async (result, index) => {
        if (result.status === 'fulfilled') {
          allContacts.push(...result.value);
        } else {
          this.logger.error(`Failed to process ${batch[index]}:`, result.reason);
        }
      });

      // Add small delay between batches to respect rate limits
      if (i + batchSize < pdfKeys.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (allContacts.length === 0) {
      this.logger.warn('No contact information extracted from any PDFs');
      return { success: false, contactCount: 0 };
    }
    // Generate output key if not provided
    if (!outputKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      outputKey = `extracted_contacts_${pdfKey}_${timestamp}.csv`;
    }

    // Convert to CSV
    const csvContent = this.convertToCSV(allContacts);

    // Upload to S3
    const uploadSuccess = await this.uploadCSVToS3(csvContent, outputBucket, outputKey);

    if (uploadSuccess) {
      this.logger.info(`Successfully processed ${pdfKeys.length} PDFs and extracted ${allContacts.length} contacts`);
      this.logger.info(`Results saved to s3://${outputBucket}/${outputKey}`);
    }

    return {
      success: uploadSuccess,
      contactCount: allContacts.length,
      outputLocation: `s3://${outputBucket}/${outputKey}`,
      contacts: allContacts
    };
  }

  /**
   * List PDF files in S3 bucket
   */
  async listPDFsInBucket(bucketName, prefix = '') {
    try {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix
      });

      const response = await this.s3Client.send(command);

      if (!response.Contents) {
        return [];
      }

      return response.Contents
        .filter(obj => obj.Key.toLowerCase().endsWith('.pdf'))
        .map(obj => obj.Key);

    } catch (error) {
      this.logger.error('Error listing PDFs in bucket:', error.message);
      return [];
    }
  }

  /**
   * Process PDFs from API request - main integration point
   */
  async processFromAPI(requestData) {
    try {
      const {
        sourceBucket,
        outputBucket,
        pdfKeys = [],
        prefix = '',
        outputKey = null
      } = requestData;

      let filesToProcess = pdfKeys;

      // If no specific files provided, get all PDFs with prefix
      if (filesToProcess.length === 0) {
        filesToProcess = await this.listPDFsInBucket(sourceBucket, prefix);
      }

      if (filesToProcess.length === 0) {
        return {
          success: false,
          message: 'No PDF files found to process'
        };
      }

      const result = await this.processPDFList(
        sourceBucket,
        filesToProcess,
        outputBucket,
        outputKey
      );

      return {
        ...result,
        filesProcessed: filesToProcess.length,
        message: result.success ?
          `Successfully processed ${filesToProcess.length} files and extracted ${result.contactCount} contacts` :
          'Processing failed'
      };

    } catch (error) {
      this.logger.error('Error in processFromAPI:', error.message);
      return {
        success: false,
        message: `Processing error: ${error.message}`
      };
    }
  }
}

module.exports = ClaudeContactExtractor;
