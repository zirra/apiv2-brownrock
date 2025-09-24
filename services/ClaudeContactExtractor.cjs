const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const TableName = process.env.DYNAMO_TABLE
const DynamoClient = require('../config/dynamoclient.cjs')
const PostgresContactService = require('./postgres-contact.service.js')
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
    this.textractClient = null

    // Configuration from environment
    this.processingConfig = {
      processLocally: process.env.PROCESS_LOCALLY === 'true',
      useGhostscript: process.env.USE_GHOSTSCRIPT === 'true',
      useTextract: process.env.USE_TEXTRACT === 'true',
      gsQuality: process.env.GS_QUALITY || 'ebook',
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 500000,
      keepLocalFiles: process.env.KEEP_LOCAL_FILES === 'true',
      localPdfPath: process.env.LOCAL_PDF_PATH || './downloads/pdfs',
      usePostgres: process.env.USE_POSTGRES !== 'false' // Default to true
    }

    // Initialize PostgreSQL service
    if (this.processingConfig.usePostgres) {
      this.postgresService = new PostgresContactService()
    }
  }

  
  /**
   * Extract text content from PDF buffer (basic method)
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

  /**
   * Optimize PDF with Ghostscript for better OCR results
   */
  async optimizePdfWithGhostscript(inputPath, outputPath = null) {
    try {
      const output = outputPath || inputPath.replace('.pdf', '_optimized.pdf')

      const gsCommand = [
        'gs',
        '-sDEVICE=pdfwrite',
        `-dPDFSETTINGS=/${this.processingConfig.gsQuality}`,
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        '-dColorImageResolution=150',
        '-dGrayImageResolution=150',
        '-dMonoImageResolution=300',
        `-sOutputFile=${output}`,
        inputPath
      ].join(' ')

      this.logger.info(`🖨️ Optimizing PDF with Ghostscript: ${path.basename(inputPath)}`)
      execSync(gsCommand, { stdio: 'pipe' })

      const originalStats = fs.statSync(inputPath)
      const optimizedStats = fs.statSync(output)

      if (optimizedStats.size < originalStats.size * 0.9) {
        this.logger.info(`✅ Optimization successful: ${Math.round((1 - optimizedStats.size/originalStats.size) * 100)}% size reduction`)

        if (!outputPath) {
          fs.renameSync(output, inputPath)
          return { optimizedPath: inputPath, wasOptimized: true, originalSize: originalStats.size, newSize: optimizedStats.size }
        }
        return { optimizedPath: output, wasOptimized: true, originalSize: originalStats.size, newSize: optimizedStats.size }
      } else {
        this.logger.info(`⚠️ Optimization didn't reduce size, keeping original`)
        if (!outputPath) {
          fs.unlinkSync(output)
        }
        return { optimizedPath: inputPath, wasOptimized: false, originalSize: originalStats.size, newSize: originalStats.size }
      }

    } catch (error) {
      this.logger.warn(`⚠️ Ghostscript optimization failed: ${error.message}`)
      return { optimizedPath: inputPath, wasOptimized: false, error: error.message }
    }
  }

  /**
   * Extract text using AWS Textract for image-based PDFs
   */
  async extractTextWithTextract(pdfPath, s3Key) {
    try {
      if (!this.textractClient) {
        const { TextractClient } = require('@aws-sdk/client-textract')
        this.textractClient = new TextractClient({
          region: this.config.awsRegion || 'us-east-1',
          credentials: {
            accessKeyId: this.config.awsAccessKeyId,
            secretAccessKey: this.config.awsSecretAccessKey
          }
        })
      }

      const { AnalyzeDocumentCommand } = require('@aws-sdk/client-textract')

      this.logger.info(`🔍 Starting Textract analysis for ${path.basename(pdfPath)}`)

      // Upload to S3 for Textract
      await this.uploadFileToS3(pdfPath, s3Key)

      const command = new AnalyzeDocumentCommand({
        Document: {
          S3Object: {
            Bucket: process.env.S3_BUCKET_NAME,
            Name: s3Key
          }
        },
        FeatureTypes: ['TABLES', 'FORMS', 'LAYOUT']
      })

      const response = await this.textractClient.send(command)

      let extractedText = ''
      let tables = []
      let forms = []

      for (const block of response.Blocks) {
        if (block.BlockType === 'LINE') {
          extractedText += block.Text + '\n'
        } else if (block.BlockType === 'TABLE') {
          tables.push({ id: block.Id, confidence: block.Confidence })
        } else if (block.BlockType === 'KEY_VALUE_SET') {
          forms.push({ id: block.Id, confidence: block.Confidence })
        }
      }

      this.logger.info(`📝 Textract extracted ${extractedText.length} characters, ${tables.length} tables, ${forms.length} forms`)

      return {
        extractedText,
        textLength: extractedText.length,
        tables,
        forms,
        confidence: 'high',
        method: 'textract',
        uploadedToS3: true
      }

    } catch (error) {
      this.logger.warn(`⚠️ Textract failed: ${error.message}`)
      return {
        extractedText: '',
        textLength: 0,
        confidence: 'failed',
        error: error.message,
        method: 'textract',
        uploadedToS3: false
      }
    }
  }

  /**
   * Upload local file to S3
   */
  async uploadFileToS3(filePath, s3Key) {
    try {
      const fileBuffer = fs.readFileSync(filePath)

      const command = new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: 'application/pdf',
        ServerSideEncryption: 'AES256',
        ACL: 'public-read'
      })

      await this.s3Client.send(command)
      this.logger.info(`✅ Successfully uploaded ${filePath} to S3: ${s3Key}`)
      return true
    } catch (error) {
      this.logger.error(`❌ Failed to upload ${filePath} to S3: ${error.message}`)
      return false
    }
  }

  /**
   * Analyze PDF content to determine best processing approach
   */
  async analyzePdfContent(pdfPath) {
    try {
      const pdfParse = require('pdf-parse')
      const dataBuffer = fs.readFileSync(pdfPath)
      const data = await pdfParse(dataBuffer)

      const textLength = data.text.trim().length
      const numPages = data.numpages
      const avgTextPerPage = textLength / numPages
      const fileSizeBytes = fs.statSync(pdfPath).size
      const fileSizeKB = fileSizeBytes / 1024
      const textDensity = (textLength / fileSizeBytes) * 1000 // text chars per KB

      let type, recommendation

      if (textDensity > 50 && avgTextPerPage > 200) {
        type = 'text-based'
        recommendation = 'ghostscript-only'
      } else if (textDensity < 10 || avgTextPerPage < 50) {
        type = 'image-based'
        recommendation = 'textract'
      } else {
        type = 'mixed'
        recommendation = 'both'
      }

      return {
        type,
        recommendation,
        hasImages: type !== 'text-based',
        textLength,
        numPages,
        avgTextPerPage: Math.round(avgTextPerPage),
        fileSizeKB: Math.round(fileSizeKB),
        textDensity: Math.round(textDensity)
      }

    } catch (error) {
      this.logger.warn(`⚠️ PDF content analysis failed: ${error.message}`)
      return {
        type: 'unknown',
        recommendation: 'both',
        hasImages: true,
        textLength: 0,
        numPages: 0,
        avgTextPerPage: 0,
        fileSizeKB: 0,
        textDensity: 0,
        error: error.message
      }
    }
  }

  /**
   * Smart text extraction using optimized pipeline
   */
  async extractTextOptimized(pdfBuffer, pdfKey) {
    try {
      // Save buffer to temporary file for processing
      const tempDir = this.processingConfig.localPdfPath || './temp'
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }

      let tempFile = path.join(tempDir, `temp_${Date.now()}.pdf`)
      fs.writeFileSync(tempFile, pdfBuffer)

      // Analyze content type
      const contentAnalysis = await this.analyzePdfContent(tempFile)
      this.logger.info(`📊 Content Analysis: ${contentAnalysis.type} (${contentAnalysis.textDensity}% density)`)

      let extractedText = ''
      let method = 'none'

      if (contentAnalysis.type === 'text-based' || contentAnalysis.recommendation === 'ghostscript-only') {
        // Text-based: Ghostscript + basic extraction
        this.logger.info(`📝 Using text-based processing (Ghostscript + basic)`)

        if (this.processingConfig.useGhostscript) {
          const optimizationResult = await this.optimizePdfWithGhostscript(tempFile)
          tempFile = optimizationResult.optimizedPath
        }

        const textResult = await this.extractTextFromPdf(tempFile)
        extractedText = textResult.extractedText
        method = 'ghostscript-basic'

      } else if (contentAnalysis.type === 'image-based' || contentAnalysis.recommendation === 'textract') {
        // Image-based: Textract OCR
        this.logger.info(`📷 Using image-based processing (Textract OCR)`)

        if (this.processingConfig.useTextract && pdfKey) {
          const textractResult = await this.extractTextWithTextract(tempFile, pdfKey)
          extractedText = textractResult.extractedText
          method = 'textract-only'
        } else {
          // Fallback to basic extraction
          const textResult = await this.extractTextFromPdf(tempFile)
          extractedText = textResult.extractedText
          method = 'basic-fallback'
        }

      } else {
        // Mixed content: Ghostscript + Textract (best of both)
        this.logger.info(`🔀 Using mixed processing (Ghostscript + Textract)`)

        if (this.processingConfig.useGhostscript) {
          const optimizationResult = await this.optimizePdfWithGhostscript(tempFile)
          tempFile = optimizationResult.optimizedPath
        }

        const basicResult = await this.extractTextFromPdf(tempFile)

        if (basicResult.textLength < 100 && this.processingConfig.useTextract && pdfKey) {
          const textractResult = await this.extractTextWithTextract(tempFile, pdfKey)
          if (textractResult.textLength > basicResult.textLength) {
            extractedText = textractResult.extractedText
            method = 'ghostscript-textract'
          } else {
            extractedText = basicResult.extractedText
            method = 'ghostscript-basic'
          }
        } else {
          extractedText = basicResult.extractedText
          method = 'ghostscript-basic'
        }
      }

      // Cleanup temp file unless configured to keep
      if (!this.processingConfig.keepLocalFiles && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile)
      }

      this.logger.info(`✅ Extraction complete: ${extractedText.length} chars using ${method}`)

      return extractedText

    } catch (error) {
      this.logger.error(`Error in optimized text extraction: ${error.message}`)
      // Fallback to basic method
      return await this.extractTextFromPDF(pdfBuffer)
    }
  }

  /**
   * Extract text from PDF file path (helper method)
   */
  async extractTextFromPdf(pdfPath) {
    try {
      const pdfParse = require('pdf-parse')
      const dataBuffer = fs.readFileSync(pdfPath)
      const data = await pdfParse(dataBuffer)

      const meaningfulText = data.text.replace(/\s+/g, ' ').trim()

      this.logger.info(`📝 Extracted ${meaningfulText.length} characters from PDF (${data.numpages} pages)`)
      return {
        extractedText: meaningfulText,
        textLength: meaningfulText.length,
        numPages: data.numpages,
        isImageBased: meaningfulText.length < 50
      }

    } catch (error) {
      this.logger.warn(`⚠️ PDF text extraction failed: ${error.message}`)
      return { extractedText: '', textLength: 0, numPages: 0, isImageBased: true, error: error.message }
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

CRITICAL EXCLUSION FILTERS - ABSOLUTELY DO NOT EXTRACT:

Legal Professionals - IMMEDIATELY SKIP and DO NOT INCLUDE any records containing ANY of these terms:
- Attorney, Attorneys, Atty, Lawyer, Lawyers, Legal, Law Firm, Law Office, Law Group, Law Associates
- Esquire, Esq., J.D., Juris Doctor, Counselor, Counsel, Legal Counsel
- Professional titles: P.C., P.A., PLLC, LLP, Professional Corporation, Professional Association
- "Legal Representative", "Legal Department", "Legal Services", "Legal Aid", "Legal Clinic"
- Bar Association, State Bar, Legal Licensing, Paralegal, Legal Assistant
- Law school affiliations, Legal Education, Legal Practice
- ANY business name containing "Law" followed by descriptive terms (Law Offices, Law Group, etc.)
- ANY individual name followed by legal titles or credentials

ADDITIONAL LEGAL EXCLUSIONS:
- Court-appointed representatives, Public Defenders, District Attorneys, Prosecutors
- Legal guardians when acting in professional capacity
- Trustees acting in legal capacity for estates or trusts
- Any entity described as providing "legal services" or "legal advice"
- Mediators, Arbitrators, Legal Consultants
- Title companies when acting as legal representatives
- Real estate attorneys, Oil & Gas attorneys, Mineral rights attorneys

IF IN DOUBT whether someone is a legal professional, ERR ON THE SIDE OF EXCLUSION and DO NOT INCLUDE them.

DOUBLE-CHECK REQUIREMENT: Before including ANY record, verify it contains NO legal professional indicators.

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
ABSOLUTELY SKIP any record that appears to be a legal professional or law firm - NO EXCEPTIONS

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

  /**
   * Save contacts directly to PostgreSQL database
   */
  async saveContactsToPostgres(contacts) {
    if (!this.postgresService) {
      this.logger.warn('PostgreSQL service not initialized, skipping database save');
      return { success: false, message: 'PostgreSQL not configured' };
    }

    if (!contacts || contacts.length === 0) {
      return { success: true, insertedCount: 0, message: 'No contacts to save' };
    }

    try {
      this.logger.info(`💾 Saving ${contacts.length} contacts directly to PostgreSQL...`);

      const result = await this.postgresService.bulkInsertContacts(contacts);

      if (result.success) {
        this.logger.info(`✅ PostgreSQL save successful: ${result.insertedCount} contacts inserted`);
      } else {
        this.logger.error(`❌ PostgreSQL save failed: ${result.error}`);
      }

      return result;

    } catch (error) {
      this.logger.error(`❌ PostgreSQL save error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        insertedCount: 0
      };
    }
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
  async processSinglePDF(sourceBucket, pdfKey) {
    this.logger.info(`🔍 Processing PDF with optimized pipeline: ${pdfKey}`);

    try {
      // Download PDF
      const pdfBuffer = await this.downloadPDFFromS3(sourceBucket, pdfKey);
      if (!pdfBuffer) {
        return [];
      }

      // Use optimized text extraction (Ghostscript + Textract)
      const textContent = await this.extractTextOptimized(pdfBuffer, pdfKey);

      if (!textContent.trim()) {
        this.logger.warn(`❌ No text content extracted from ${pdfKey} using optimized pipeline`);

        // Move file to failed location
        await this.moveFileToFailedBucket(sourceBucket, pdfKey, this.config.failedBucket || sourceBucket, 'failed-pdfs/');

        return [];
      }

      this.logger.info(`✅ Extracted ${textContent.length} chars from ${pdfKey}, sending to Claude...`);

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

    let success = false;
    let outputLocation = null;
    let postgresResult = null;

    // Save to PostgreSQL if enabled
    if (this.processingConfig.usePostgres) {
      this.logger.info(`💾 Saving ${allContacts.length} contacts to PostgreSQL database...`);
      postgresResult = await this.saveContactsToPostgres(allContacts);
      success = postgresResult.success;
      outputLocation = `postgres://contacts (${postgresResult.insertedCount} inserted)`;
    }

    // Fallback to CSV/S3 if PostgreSQL disabled or failed
    if (!this.processingConfig.usePostgres || !success) {
      this.logger.info(`📄 Saving ${allContacts.length} contacts to CSV/S3...`);

      // Generate output key if not provided
      if (!outputKey) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        outputKey = `extracted_contacts_batch_${timestamp}.csv`;
      }

      // Convert to CSV
      const csvContent = this.convertToCSV(allContacts);

      // Upload to S3
      const uploadSuccess = await this.uploadCSVToS3(csvContent, outputBucket, outputKey);

      if (uploadSuccess) {
        success = true;
        outputLocation = `s3://${outputBucket}/${outputKey}`;
        this.logger.info(`📁 CSV backup saved to ${outputLocation}`);
      }
    }

    if (success) {
      this.logger.info(`✅ Successfully processed ${pdfKeys.length} PDFs and extracted ${allContacts.length} contacts`);
      this.logger.info(`📊 Results saved to: ${outputLocation}`);
    }

    return {
      success: success,
      contactCount: allContacts.length,
      outputLocation: outputLocation,
      contacts: allContacts,
      postgresResult: postgresResult
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
