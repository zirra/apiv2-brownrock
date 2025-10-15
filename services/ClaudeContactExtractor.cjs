const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const TableName = process.env.DYNAMO_TABLE
const DynamoClient = require('../config/dynamoclient.cjs')
const PostgresContactService = require('./postgres-contact.service.js')
const extractionPrompts = require('../prompts/extraction-prompts.js')
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

    // Prompt configuration
    this.documentType = config.documentType || process.env.DEFAULT_DOCUMENT_TYPE || 'oil-gas-contacts'
    this.customPrompts = config.customPrompts || null
    this.promptVariables = config.promptVariables || {
      PROJECT_ORIGIN: process.env.DEFAULT_PROJECT_ORIGIN || 'OCD_IMAGING'
    }

    // Initialize PostgreSQL service
    if (this.processingConfig.usePostgres) {
      this.postgresService = new PostgresContactService()
    }
  }

  /**
   * Get prompt for extraction based on document type and mode
   * @param {string} mode - 'native' for PDF vision or 'text' for extracted text
   * @returns {string} - The prompt text
   */
  getPrompt(mode) {
    // If custom prompts provided, use those
    if (this.customPrompts && this.customPrompts[mode]) {
      return this.substitutePromptVariables(this.customPrompts[mode])
    }

    // Otherwise use predefined prompts from library
    const prompts = extractionPrompts[this.documentType]
    if (!prompts) {
      this.logger.warn(`⚠️ Unknown document type: ${this.documentType}, falling back to oil-gas-contacts`)
      return this.substitutePromptVariables(extractionPrompts['oil-gas-contacts'][mode])
    }

    return this.substitutePromptVariables(prompts[mode])
  }

  /**
   * Substitute template variables in prompts
   * @param {string} prompt - Prompt template with ${VARIABLE} placeholders
   * @returns {string} - Prompt with variables replaced
   */
  substitutePromptVariables(prompt) {
    let result = prompt

    // Replace known variables
    for (const [key, value] of Object.entries(this.promptVariables)) {
      const placeholder = `\${${key}}`
      result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value)
    }

    return result
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
   * Parse Textract response blocks into markdown-formatted tables
   * @param {Array} blocks - Textract response blocks
   * @returns {Object} - Object with tables array and text summary
   */
  parseTextractTables(blocks) {
    const tables = []
    const tableMap = new Map() // Map of TABLE id to its structure
    const cellMap = new Map()  // Map of CELL id to its content

    try {
      // First pass: identify all tables and cells
      for (const block of blocks) {
        if (block.BlockType === 'TABLE') {
          tableMap.set(block.Id, {
            id: block.Id,
            confidence: block.Confidence,
            page: block.Page || 1,
            relationships: block.Relationships || [],
            cells: []
          })
        } else if (block.BlockType === 'CELL') {
          const cellContent = {
            id: block.Id,
            rowIndex: block.RowIndex,
            columnIndex: block.ColumnIndex,
            rowSpan: block.RowSpan || 1,
            columnSpan: block.ColumnSpan || 1,
            confidence: block.Confidence,
            text: '',
            relationships: block.Relationships || []
          }
          cellMap.set(block.Id, cellContent)
        }
      }

      // Second pass: extract cell text from WORD blocks
      for (const block of blocks) {
        if (block.BlockType === 'WORD') {
          // Find which cell this word belongs to
          for (const [cellId, cell] of cellMap.entries()) {
            const relationship = cell.relationships.find(
              rel => rel.Type === 'CHILD' && rel.Ids && rel.Ids.includes(block.Id)
            )
            if (relationship) {
              cell.text += (cell.text ? ' ' : '') + block.Text
            }
          }
        }
      }

      // Third pass: organize cells into tables
      for (const [tableId, table] of tableMap.entries()) {
        const childRelationship = table.relationships.find(rel => rel.Type === 'CHILD')
        if (childRelationship && childRelationship.Ids) {
          for (const cellId of childRelationship.Ids) {
            const cell = cellMap.get(cellId)
            if (cell) {
              table.cells.push(cell)
            }
          }
        }
      }

      // Fourth pass: convert each table to markdown
      for (const [tableId, table] of tableMap.entries()) {
        if (table.cells.length === 0) continue

        // Sort cells by row and column
        table.cells.sort((a, b) => {
          if (a.rowIndex !== b.rowIndex) {
            return a.rowIndex - b.rowIndex
          }
          return a.columnIndex - b.columnIndex
        })

        // Determine table dimensions
        const maxRow = Math.max(...table.cells.map(c => c.rowIndex))
        const maxCol = Math.max(...table.cells.map(c => c.columnIndex))

        // Build 2D array for the table
        const tableArray = Array.from({ length: maxRow }, () =>
          Array.from({ length: maxCol }, () => '')
        )

        // Fill in cell data (handling spans)
        for (const cell of table.cells) {
          const rowIdx = cell.rowIndex - 1 // Convert to 0-based
          const colIdx = cell.columnIndex - 1 // Convert to 0-based

          if (rowIdx >= 0 && colIdx >= 0 && rowIdx < maxRow && colIdx < maxCol) {
            tableArray[rowIdx][colIdx] = cell.text.trim()

            // Handle column spans by filling adjacent cells
            for (let span = 1; span < cell.columnSpan; span++) {
              if (colIdx + span < maxCol) {
                tableArray[rowIdx][colIdx + span] = '' // Mark as spanned
              }
            }
          }
        }

        // Convert to markdown
        let markdown = `\n**Table from Page ${table.page}** (Confidence: ${table.confidence.toFixed(1)}%)\n\n`

        // Add header row
        markdown += '| ' + tableArray[0].join(' | ') + ' |\n'
        markdown += '| ' + tableArray[0].map(() => '---').join(' | ') + ' |\n'

        // Add data rows
        for (let i = 1; i < tableArray.length; i++) {
          markdown += '| ' + tableArray[i].join(' | ') + ' |\n'
        }

        tables.push({
          page: table.page,
          confidence: table.confidence,
          markdown: markdown,
          rowCount: maxRow,
          columnCount: maxCol,
          cellCount: table.cells.length
        })
      }

      this.logger.info(`📊 Parsed ${tables.length} tables from Textract response`)

      return {
        tables,
        tableCount: tables.length,
        summary: tables.map(t =>
          `Page ${t.page}: ${t.rowCount}x${t.columnCount} table (${t.cellCount} cells, ${t.confidence.toFixed(1)}% confidence)`
        ).join('\n')
      }

    } catch (error) {
      this.logger.error(`❌ Error parsing Textract tables: ${error.message}`)
      return {
        tables: [],
        tableCount: 0,
        summary: 'Failed to parse tables',
        error: error.message
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
   * Hybrid PDF processing: Textract table extraction + Claude native vision
   * Splits large PDFs into chunks for Textract, then sends full PDF to Claude with extracted tables
   * @param {Buffer} pdfBuffer - PDF file as buffer
   * @param {string} filename - Original filename for reference
   * @returns {Promise<Array>} - Array of extracted contacts
   */
  async extractContactsFromPDFHybrid(pdfBuffer, filename = 'document.pdf') {
    this.logger.info(`🔀 Starting hybrid PDF processing for ${filename}`)
    this.logger.info(`📄 PDF size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`)

    const sizeThreshold = parseInt(process.env.HYBRID_SIZE_THRESHOLD) || 8388608 // 8MB default
    const chunkSize = parseInt(process.env.HYBRID_CHUNK_SIZE) || 50 // 50 pages default
    const tempPrefix = process.env.HYBRID_TEMP_PREFIX || 'temp/'

    let allExtractedTables = []
    let tableSummary = ''

    try {
      // Step 1: Extract tables using Textract (split if needed)
      if (pdfBuffer.length > sizeThreshold) {
        this.logger.info(`📦 PDF exceeds ${(sizeThreshold / 1024 / 1024).toFixed(1)}MB threshold, splitting for Textract...`)

        // Split PDF into chunks
        const chunks = await this.splitPDF(pdfBuffer, chunkSize)
        this.logger.info(`📑 Split PDF into ${chunks.length} chunks of ${chunkSize} pages each`)

        // Process each chunk with Textract
        for (let i = 0; i < chunks.length; i++) {
          const chunkBuffer = chunks[i]
          const tempKey = `${tempPrefix}${filename.replace('.pdf', '')}_chunk_${i}.pdf`

          this.logger.info(`🔍 Processing chunk ${i + 1}/${chunks.length} with Textract...`)

          try {
            // Save chunk to temp file
            const tempDir = this.processingConfig.localPdfPath || './temp'
            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir, { recursive: true })
            }
            const tempFilePath = path.join(tempDir, `chunk_${Date.now()}_${i}.pdf`)
            fs.writeFileSync(tempFilePath, chunkBuffer)

            // Upload chunk to S3
            await this.uploadFileToS3(tempFilePath, tempKey)

            // Run Textract with retry logic
            let textractAttempt = 0
            let textractSuccess = false
            let textractResponse = null

            while (textractAttempt < 3 && !textractSuccess) {
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
                const startTime = Date.now()

                const command = new AnalyzeDocumentCommand({
                  Document: {
                    S3Object: {
                      Bucket: process.env.S3_BUCKET_NAME,
                      Name: tempKey
                    }
                  },
                  FeatureTypes: ['TABLES', 'FORMS']
                })

                textractResponse = await this.textractClient.send(command)
                const duration = ((Date.now() - startTime) / 1000).toFixed(1)
                this.logger.info(`✅ Textract completed chunk ${i + 1} in ${duration}s`)
                textractSuccess = true

              } catch (textractError) {
                textractAttempt++
                this.logger.warn(`⚠️ Textract attempt ${textractAttempt} failed for chunk ${i + 1}: ${textractError.message}`)

                if (textractAttempt < 3) {
                  const delay = Math.pow(2, textractAttempt) * 1000 // Exponential backoff
                  this.logger.info(`⏸️ Waiting ${delay / 1000}s before retry...`)
                  await new Promise(resolve => setTimeout(resolve, delay))
                } else {
                  this.logger.error(`❌ Textract failed for chunk ${i + 1} after 3 attempts`)
                }
              }
            }

            // Parse tables from Textract response
            if (textractSuccess && textractResponse) {
              const parsedTables = this.parseTextractTables(textractResponse.Blocks || [])

              if (parsedTables.tables.length > 0) {
                this.logger.info(`📊 Found ${parsedTables.tables.length} tables in chunk ${i + 1}`)
                allExtractedTables.push(...parsedTables.tables)
              } else {
                this.logger.info(`📭 No tables found in chunk ${i + 1}`)
              }
            }

            // Cleanup temp file
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath)
            }

            // Delete temp S3 file
            try {
              const deleteCommand = new DeleteObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME,
                Key: tempKey
              })
              await this.s3Client.send(deleteCommand)
              this.logger.info(`🗑️ Deleted temp S3 file: ${tempKey}`)
            } catch (deleteError) {
              this.logger.warn(`⚠️ Failed to delete temp S3 file ${tempKey}: ${deleteError.message}`)
            }

            // Delay between chunks to avoid rate limits
            if (i < chunks.length - 1) {
              this.logger.info(`⏸️ Waiting 2s before next chunk...`)
              await new Promise(resolve => setTimeout(resolve, 2000))
            }

          } catch (chunkError) {
            this.logger.error(`❌ Failed to process chunk ${i + 1}: ${chunkError.message}`)
            // Continue with other chunks
          }
        }

      } else {
        // Small file - process directly with Textract
        this.logger.info(`📄 PDF under size threshold, processing directly with Textract...`)

        const tempDir = this.processingConfig.localPdfPath || './temp'
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true })
        }
        const tempFilePath = path.join(tempDir, `single_${Date.now()}.pdf`)
        fs.writeFileSync(tempFilePath, pdfBuffer)

        const tempKey = `${tempPrefix}${filename}`
        await this.uploadFileToS3(tempFilePath, tempKey)

        try {
          const textractResult = await this.extractTextWithTextract(tempFilePath, tempKey)

          if (textractResult.extractedText) {
            // Parse tables from Textract blocks (need to call AnalyzeDocument again to get blocks)
            this.logger.info(`📊 Parsing tables from Textract response...`)
            // Note: extractTextWithTextract doesn't return blocks, so we need to make another call
            // For now, we'll use the text extraction we already have
          }

          // Cleanup
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath)
          }

          // Delete temp S3 file
          try {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: process.env.S3_BUCKET_NAME,
              Key: tempKey
            })
            await this.s3Client.send(deleteCommand)
          } catch (deleteError) {
            this.logger.warn(`⚠️ Failed to delete temp S3 file: ${deleteError.message}`)
          }

        } catch (textractError) {
          this.logger.warn(`⚠️ Textract failed: ${textractError.message}`)
        }
      }

      // Step 2: Format extracted tables for Claude
      if (allExtractedTables.length > 0) {
        this.logger.info(`📊 Total tables extracted: ${allExtractedTables.length}`)

        tableSummary = '\n\n---\n**EXTRACTED TABLES (from Textract - use as reference in case any tables were missed in the PDF):**\n\n'
        tableSummary += allExtractedTables.map(t => t.markdown).join('\n\n')
      } else {
        this.logger.info(`📭 No tables extracted from Textract`)
        tableSummary = ''
      }

      // Step 3: Send PDF to Claude with table supplement (handle 100-page limit)
      this.logger.info(`🚀 Preparing to send PDF to Claude with ${allExtractedTables.length} supplementary tables...`)

      // Check PDF page count (Claude has 100-page limit)
      const { PDFDocument } = require('pdf-lib')
      const pdfDoc = await PDFDocument.load(pdfBuffer)
      const totalPages = pdfDoc.getPageCount()

      this.logger.info(`📄 PDF has ${totalPages} pages (Claude limit: 100 pages)`)

      let allClaudeContacts = []

      if (totalPages > 100) {
        // PDF exceeds Claude's 100-page limit, split and process chunks
        this.logger.warn(`⚠️ PDF exceeds Claude's 100-page limit, splitting into chunks...`)

        // Use smaller chunks to avoid token limit issues with dense PDFs
        // Default to 50 pages (much safer than 100-page limit for token count)
        const claudeChunkSize = parseInt(process.env.HYBRID_CLAUDE_CHUNK_SIZE) || 50
        const claudeChunks = await this.splitPDF(pdfBuffer, claudeChunkSize)
        this.logger.info(`📑 Split PDF into ${claudeChunks.length} chunks of ${claudeChunkSize} pages for Claude processing`)

        // For large PDFs, skip table data to avoid token limits
        // Claude's vision can see the tables directly in the PDF
        const basePrompt = this.getPrompt('native')
        let prompt

        if (allExtractedTables.length > 20) {
          // Too many tables would exceed token limit
          this.logger.warn(`⚠️ ${allExtractedTables.length} tables found - omitting from prompt to avoid token limit`)
          this.logger.info(`📊 Claude will extract tables directly from PDF using vision`)
          prompt = basePrompt
        } else if (tableSummary.length > 50000) {
          // Table data is too large
          this.logger.warn(`⚠️ Table data too large (${(tableSummary.length / 1000).toFixed(1)}K chars) - omitting to avoid token limit`)
          this.logger.info(`📊 Claude will extract tables directly from PDF using vision`)
          prompt = basePrompt
        } else {
          // Include tables - within limits
          this.logger.info(`📊 Including ${allExtractedTables.length} tables in prompt`)
          prompt = basePrompt + tableSummary
        }

        for (let i = 0; i < claudeChunks.length; i++) {
          this.logger.info(`🔄 Processing Claude chunk ${i + 1}/${claudeChunks.length}...`)

          try {
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
                      data: claudeChunks[i].toString('base64')
                    }
                  },
                  {
                    type: "text",
                    text: prompt
                  }
                ]
              }]
            })

            const responseText = response.content[0].text
            const jsonMatch = responseText.match(/\[[\s\S]*\]/)

            if (jsonMatch) {
              const chunkContacts = JSON.parse(jsonMatch[0])
              const validChunkContacts = Array.isArray(chunkContacts) ? chunkContacts : []
              allClaudeContacts = allClaudeContacts.concat(validChunkContacts)
              this.logger.info(`✅ Chunk ${i + 1}: extracted ${validChunkContacts.length} contacts`)
            } else {
              this.logger.warn(`⚠️ Chunk ${i + 1}: No JSON found in response`)
            }

            // Delay between chunks to avoid rate limits
            if (i < claudeChunks.length - 1) {
              this.logger.info(`⏸️ Waiting 2s before next Claude chunk...`)
              await new Promise(resolve => setTimeout(resolve, 2000))
            }

          } catch (chunkError) {
            this.logger.error(`❌ Claude chunk ${i + 1} failed: ${chunkError.message}`)
            // Continue with other chunks
          }
        }

        this.logger.info(`✅ Processed all ${claudeChunks.length} Claude chunks: ${allClaudeContacts.length} total contacts`)

      } else {
        // PDF is under 100 pages, process as single document
        this.logger.info(`✅ PDF under 100-page limit, processing as single document`)

        const prompt = this.getPrompt('native') + tableSummary

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
        })

        const responseText = response.content[0].text
        const jsonMatch = responseText.match(/\[[\s\S]*\]/)

        if (jsonMatch) {
          allClaudeContacts = JSON.parse(jsonMatch[0])
          allClaudeContacts = Array.isArray(allClaudeContacts) ? allClaudeContacts : []
        } else {
          this.logger.warn('⚠️ No JSON array found in Claude response')
        }
      }

      // Return combined results
      if (allClaudeContacts.length > 0) {
        this.logger.info(`✅ Hybrid processing successful: extracted ${allClaudeContacts.length} contacts`)
        this.logger.info(`📊 Processing summary:`)
        this.logger.info(`   - PDF pages: ${totalPages}`)
        this.logger.info(`   - Tables extracted by Textract: ${allExtractedTables.length}`)
        this.logger.info(`   - Contacts extracted by Claude: ${allClaudeContacts.length}`)

        return allClaudeContacts
      } else {
        this.logger.warn('⚠️ No contacts extracted')
        return []
      }

    } catch (error) {
      this.logger.error(`❌ Hybrid processing failed: ${error.message}`)
      this.logger.error(error.stack)

      // Fallback to native PDF processing without tables
      this.logger.info(`🔄 Falling back to native PDF processing...`)
      try {
        return await this.extractContactsFromPDFNative(pdfBuffer, filename)
      } catch (fallbackError) {
        this.logger.error(`❌ Fallback also failed: ${fallbackError.message}`)
        return []
      }
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

    // Get dynamic prompt based on document type
    const prompt = this.getPrompt('native')

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

    // Get dynamic prompt based on document type and substitute TEXT_CONTENT variable
    let prompt = this.getPrompt('text')
    prompt = prompt.replace(/\$\{TEXT_CONTENT\}/g, textContent)

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
