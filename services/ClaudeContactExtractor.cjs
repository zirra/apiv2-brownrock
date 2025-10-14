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
          // Check file size and compress if needed for Textract
          const stats = fs.statSync(tempFile)
          const textractLimit = parseInt(process.env.TEXTRACT_SIZE_LIMIT) || (10 * 1024 * 1024) // Default 10MB, configurable

          if (stats.size > textractLimit && this.processingConfig.useGhostscript) {
            this.logger.info(`🗜️ PDF too large (${(stats.size/1024/1024).toFixed(1)}MB), compressing for Textract...`)

            // Temporarily use maximum compression for Textract
            const originalQuality = this.processingConfig.gsQuality
            this.processingConfig.gsQuality = 'screen' // Maximum compression

            const optimizationResult = await this.optimizePdfWithGhostscript(tempFile)
            tempFile = optimizationResult.optimizedPath

            // Restore original quality
            this.processingConfig.gsQuality = originalQuality
          }

          const textractResult = await this.extractTextWithTextract(tempFile, pdfKey)
          if (textractResult.extractedText && textractResult.extractedText.length > 0) {
            extractedText = textractResult.extractedText
            method = stats.size > textractLimit ? 'textract-compressed' : 'textract-only'
          } else {
            // Textract failed, fall back to basic extraction
            this.logger.info(`⚠️ Textract failed/returned empty, falling back to basic extraction`)
            const textResult = await this.extractTextFromPdf(tempFile)
            extractedText = textResult.extractedText
            method = 'basic-fallback-from-textract'
          }
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
      this.logger.info(`🔄 Falling back to basic PDF text extraction...`)

      try {
        // Fallback: Save buffer to temp file and use basic extraction
        const tempDir = this.processingConfig.localPdfPath || './temp'
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true })
        }

        const fallbackTempFile = path.join(tempDir, `fallback_${Date.now()}.pdf`)
        fs.writeFileSync(fallbackTempFile, pdfBuffer)

        const fallbackResult = await this.extractTextFromPdf(fallbackTempFile)

        // Cleanup temp file
        if (fs.existsSync(fallbackTempFile)) {
          fs.unlinkSync(fallbackTempFile)
        }

        this.logger.info(`✅ Fallback extraction: ${fallbackResult.extractedText.length} chars`)
        return fallbackResult.extractedText || ''

      } catch (fallbackError) {
        this.logger.error(`❌ Fallback extraction also failed: ${fallbackError.message}`)
        return ''
      }
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
  /**
   * Split PDF into chunks of specified page count
   * @param {Buffer} pdfBuffer - PDF file as buffer
   * @param {number} maxPages - Maximum pages per chunk (default 100)
   * @returns {Promise<Array<Buffer>>} - Array of PDF buffers
   */
  async splitPDF(pdfBuffer, maxPages = 100) {
    try {
      const { PDFDocument } = require('pdf-lib')
      const pdfDoc = await PDFDocument.load(pdfBuffer)
      const totalPages = pdfDoc.getPageCount()

      this.logger.info(`📄 PDF has ${totalPages} pages, splitting into chunks of ${maxPages} pages...`)

      if (totalPages <= maxPages) {
        return [pdfBuffer] // No need to split
      }

      const chunks = []
      for (let i = 0; i < totalPages; i += maxPages) {
        const chunkDoc = await PDFDocument.create()
        const endPage = Math.min(i + maxPages, totalPages)

        // Copy pages to new document
        const copiedPages = await chunkDoc.copyPages(pdfDoc, Array.from({ length: endPage - i }, (_, idx) => i + idx))
        copiedPages.forEach(page => chunkDoc.addPage(page))

        const chunkBytes = await chunkDoc.save()
        chunks.push(Buffer.from(chunkBytes))

        this.logger.info(`✅ Created chunk ${chunks.length}: pages ${i + 1}-${endPage}`)
      }

      return chunks
    } catch (error) {
      this.logger.error(`❌ PDF splitting failed: ${error.message}`)
      throw error
    }
  }

  /**
   * Extract contacts directly from PDF using Claude's native PDF vision capabilities
   * Automatically splits PDFs over 100 pages
   * @param {Buffer} pdfBuffer - PDF file as buffer
   * @param {string} filename - Original filename for reference
   * @returns {Promise<Array>} - Array of extracted contacts
   */
  async extractContactsFromPDFNative(pdfBuffer, filename = 'document.pdf', retryCount = 0) {
    const maxRetries = 3
    const baseDelay = 2000 // 2 seconds

    const prompt = `Extract contact information from this oil & gas PDF document. Return JSON array only.

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
- No text outside JSON array`;

    try {
      this.logger.info(`🚀 Calling Claude API with native PDF processing (attempt ${retryCount + 1}) for ${filename}...`)
      this.logger.info(`📄 PDF size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`)

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBuffer.toString('base64')
              }
            },
            {
              type: "text",
              text: prompt
            }
          ]
        }]
      });

      const responseText = response.content[0].text;

      // Extract JSON from response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const contacts = JSON.parse(jsonMatch[0]);
        const validContacts = Array.isArray(contacts) ? contacts : [];
        this.logger.info(`✅ Claude native PDF processing successful: extracted ${validContacts.length} contacts`);
        return validContacts;
      } else {
        this.logger.warn('No JSON array found in Claude response');
        return [];
      }

    } catch (error) {
      this.logger.error('Error processing PDF with Claude native:', error.message);

      // Handle 100-page limit error by splitting PDF
      if (error.status === 400 && error.message && error.message.includes('100 PDF pages')) {
        this.logger.warn('⚠️ PDF exceeds 100-page limit, splitting into chunks...');

        try {
          const chunks = await this.splitPDF(pdfBuffer, 100)
          this.logger.info(`📑 Split PDF into ${chunks.length} chunks, processing each...`)

          let allContacts = []
          for (let i = 0; i < chunks.length; i++) {
            this.logger.info(`🔄 Processing chunk ${i + 1}/${chunks.length}...`)
            const chunkContacts = await this.extractContactsFromPDFNative(chunks[i], `${filename} (chunk ${i + 1})`, 0)
            allContacts = allContacts.concat(chunkContacts)

            // Delay between chunks to avoid rate limits
            if (i < chunks.length - 1) {
              this.logger.info(`⏸️ Waiting 3 seconds before next chunk...`)
              await new Promise(resolve => setTimeout(resolve, 3000))
            }
          }

          this.logger.info(`✅ Processed all ${chunks.length} chunks: ${allContacts.length} total contacts`)
          return allContacts

        } catch (splitError) {
          this.logger.error(`❌ PDF splitting/processing failed: ${splitError.message}`)
          return []
        }
      }

      // Handle rate limit (429) and overloaded (529) errors with exponential backoff
      if ((error.status === 429 || error.status === 529) && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount)
        this.logger.warn(`Claude ${error.status === 529 ? 'overloaded (529)' : 'rate limited (429)'}, waiting ${delay/1000}s before retry ${retryCount + 1}/${maxRetries}...`);

        await new Promise(resolve => setTimeout(resolve, delay));
        return await this.extractContactsFromPDFNative(pdfBuffer, filename, retryCount + 1);

      } else if (error.status === 429 || error.status === 529) {
        const longDelay = error.status === 529 ? 30000 : 60000
        this.logger.warn(`Claude ${error.status === 529 ? 'overloaded' : 'rate limited'}, final retry in ${longDelay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, longDelay));

        try {
          const retryResponse = await this.anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 8000,
            messages: [{
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: pdfBuffer.toString('base64')
                  }
                },
                {
                  type: "text",
                  text: prompt
                }
              ]
            }]
          });

          const responseText = retryResponse.content[0].text;
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const contacts = JSON.parse(jsonMatch[0]);
            this.logger.info(`✅ Claude native PDF final retry successful: ${contacts.length} contacts`);
            return Array.isArray(contacts) ? contacts : [];
          }
        } catch (retryError) {
          this.logger.error(`Final retry also failed: ${retryError.message}`);
        }
      }

      return [];
    }
  }

  async extractContactInfoWithClaude(textContent, retryCount = 0) {
    const maxRetries = 3
    const baseDelay = 2000 // 2 seconds

    const prompt = `You are extracting contact information from an oil & gas legal document PDF. Return ONLY a JSON array.

STEP 1: SCAN FOR TABLES
Look for ANY tabular data containing names and addresses, including:
- Tables with headers like "Name", "Name 1", "Name 2", "Address", "Address1", "Address2", "City", "State", "Zip"
- "Transaction Report Details", "CertifiedPro.net", "Certified Mail" tables
- "USPS Article Number" or tracking number tables
- Interest owner tables (Working Interest, ORRI, Royalty owners)
- Tract ownership breakdowns
- Mailing lists or recipient lists
- ANY multi-row data with repeated address patterns

STEP 2: EXTRACT FROM EVERY ROW
For each row in these tables:
- Extract ALL name fields (combine if multiple name columns)
- Extract ALL address components and combine them
- Include phone/email if present
- Capture ownership percentages if shown
- Note what type of table/section it came from

TABLE FORMAT VARIATIONS:
1. **Multi-column name format:**
   - "Name 1" + "Name 2" → combine as company or name
   - Example: "Bureau of Land Management" + "Department of the Interior, USA"
   
2. **Multi-column address format:**
   - Combine: Address1, Address2, City, State, Zip
   - Example: "301 Dinosaur Trail" + "" + "Santa Fe" + "NM" + "87508"

3. **Single column format:**
   - Standard name/address in single cells

SOURCES TO EXTRACT (extract ALL rows from ALL of these):
✓ Transaction Report Details / CertifiedPro.net tables
✓ Certified mail/postal delivery tables  
✓ Interest owner tables (WI owners, ORRI owners, Royalty owners)
✓ Tract ownership breakdowns
✓ Unit-level ownership summaries
✓ Revenue distribution lists
✓ Mailing lists
✓ Any table showing recipients or owners with addresses

EXCLUDE:
✗ Law firms, attorneys (unless they're in a trust/owner table)
✗ Legal professionals (Esq., J.D., P.C., P.A., PLLC, LLP as standalone entries)
✓ EXCEPTION: Include trusts and trustees from owner/recipient tables

JSON FORMAT (one object per unique person/company):
{
  "company": "Business/entity name or null",
  "name": "Individual full name or null", 
  "first_name": "First name if individual",
  "last_name": "Last name if individual",
  "address": "Complete combined address",
  "phone": "Phone if present",
  "email": "Email if present",
  "ownership_info": "Any ownership text/fractions",
  "mineral_rights_percentage": "Numeric % (0-100) or null",
  "ownership_type": "WI, ORRI, or UMI only (null otherwise)",
  "tract_info": "Tract number(s) if applicable",
  "unit_level": true/false,
  "notes": "Additional context",
  "record_type": "individual/company/joint",
  "document_section": "Source (e.g., 'Transaction Report', 'Tract 1 Ownership', 'ORRI Table')"
}

OWNERSHIP TYPE CODES:
- WI = Working Interest
- ORRI = Overriding Royalty Interest  
- UMI = Unleased Mineral Interest
- null for any other type

PERCENTAGE HANDLING:
- Convert fractions: 1/4 → 25.0, 3/8 → 37.5
- Extract from "25.5%" → 25.5
- null if not specified

CRITICAL RULES:
1. Extract EVERY row from recipient/owner tables
2. Ignore mailing status (Delivered, Mailed, etc.) - extract the contact anyway
3. Combine duplicate owners across tracts into one record with all tract numbers listed
4. Must have: (name OR company) AND (address OR ownership_info)
5. No explanatory text - ONLY the JSON array

Begin extraction now.
${textContent}
        `.trim();

    try {
      this.logger.info(`🚀 Calling Claude API (attempt ${retryCount + 1}) with ${textContent.length.toLocaleString()} characters...`)

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,  // Increased for larger contact lists
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
        const validContacts = Array.isArray(contacts) ? contacts : [];
        this.logger.info(`✅ Claude API successful: extracted ${validContacts.length} contacts`);
        return validContacts;
      } else {
        this.logger.warn('No JSON array found in Claude response');
        return [];
      }

    } catch (error) {
      this.logger.error('Error processing with Claude:', error.message);

      // Handle rate limit (429) and overloaded (529) errors with exponential backoff
      if ((error.status === 429 || error.status === 529) && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount) // Exponential backoff: 2s, 4s, 8s
        this.logger.warn(`Claude ${error.status === 529 ? 'overloaded (529)' : 'rate limited (429)'}, waiting ${delay/1000}s before retry ${retryCount + 1}/${maxRetries}...`);

        // Wait with exponential backoff with periodic status updates
        if (delay >= 4000) { // For longer waits, show periodic updates
          const updateInterval = Math.min(delay / 4, 5000) // Update every 1/4 of delay time, max 5s
          let elapsed = 0

          const intervalId = setInterval(() => {
            elapsed += updateInterval
            const remaining = Math.max(0, delay - elapsed)
            this.logger.info(`⏳ Still waiting for Claude API... ${(remaining/1000).toFixed(1)}s remaining`)
          }, updateInterval)

          await new Promise(resolve => setTimeout(() => {
            clearInterval(intervalId)
            resolve()
          }, delay))
        } else {
          await new Promise(resolve => setTimeout(resolve, delay))
        }

        // Recursive retry
        return await this.extractContactInfoWithClaude(textContent, retryCount + 1);

      } else if (error.status === 429 || error.status === 529) {
        // Final attempt with longer wait for overloaded servers
        const longDelay = error.status === 529 ? 30000 : 60000 // 30s for overloaded, 60s for rate limit
        this.logger.warn(`Claude ${error.status === 529 ? 'overloaded' : 'rate limited'}, final retry in ${longDelay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, longDelay));

        try {
          const retryResponse = await this.anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 8000,  // Increased for larger contact lists
            messages: [{
              role: "user",
              content: prompt
            }]
          });

          const responseText = retryResponse.content[0].text;
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const contacts = JSON.parse(jsonMatch[0]);
            this.logger.info(`✅ Claude final retry successful: ${contacts.length} contacts extracted`);
            return Array.isArray(contacts) ? contacts : [];
          }
        } catch (retryError) {
          this.logger.error(`Final retry also failed: ${retryError.message}`);
        }
      }

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
        contact.project_origin = 'OCD_IMAGING';
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
    const batchSize = 1; // Reduced to avoid rate limits
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

      // Add delay between batches to respect rate limits
      if (i + batchSize < pdfKeys.length) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // Increased to 3 seconds
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
