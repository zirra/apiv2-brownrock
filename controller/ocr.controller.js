require('dotenv').config()
const cron = require('node-cron')

// Import services
const AuthService = require('../services/auth.service.js')
const S3Service = require('../services/s3.service.js')
const LoggingService = require('../services/logging.service.js')
const PostgresContactService = require('../services/postgres-contact.service.js')
const OCRService = require('../services/ocr.service.js')
const PDFService = require('../services/pdf.service.js')

class OCRController {
  constructor() {
    // Initialize services
    this.loggingService = new LoggingService()
    this.authService = new AuthService()
    this.s3Service = new S3Service(this.authService, this.loggingService)
    this.postgresContactService = new PostgresContactService()
    this.ocrService = new OCRService(this.authService, this.s3Service, this.loggingService)
    this.pdfService = new PDFService(this.authService, this.s3Service, this.loggingService)

    // OCR Processing State
    this.ocrJobRunning = false

    // Configuration from environment
    this.config = {
      sourceBucket: process.env.S3_ANALYSIS_BUCKET || 'ocdpdfs',
      sourceFolder: process.env.S3_ANALYSIS_FOLDER || 'analysis-pdfs',
      enabled: process.env.S3_ANALYSIS_ENABLED === 'true',
      schedule: process.env.S3_ANALYSIS_SCHEDULE || '0 2 * * 1', // Mondays at 2 AM
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || (50 * 1024 * 1024),
      textractLimit: parseInt(process.env.TEXTRACT_SIZE_LIMIT) || (10 * 1024 * 1024)
    }

    console.log('🔍 OCR Controller initialized')
    console.log(`📁 Source: s3://${this.config.sourceBucket}/${this.config.sourceFolder}/`)
    console.log(`⚙️ Enabled: ${this.config.enabled}`)

    // Initialize cron job if enabled
    if (this.config.enabled) {
      //this.initializeCronJob()
    }
  }

  /**
   * Main OCR processing job - processes all PDFs in the S3 analysis folder
   */
  async processS3PdfsWithOCR(req, res) {
    if (this.ocrJobRunning) {
      const message = 'OCR processing job is already running'
      if (res) {
        return res.status(429).json({ success: false, message })
      }
      return { success: false, message }
    }

    this.ocrJobRunning = true

    try {
      console.log(`\n🔍 [${new Date().toISOString()}] Starting OCR Processing Job`)
      console.log(`📁 Source: s3://${this.config.sourceBucket}/${this.config.sourceFolder}/`)

      await this.loggingService.writeMessage('ocrProcessingStart', 'Started OCR processing job')
      await this.authService.writeDynamoMessage({
        pkey: 'ocrProcessing#job',
        skey: 'start',
        origin: 'ocrProcessingJob',
        type: 'system',
        data: `Started OCR processing from s3://${this.config.sourceBucket}/${this.config.sourceFolder}/`
      })

      // List and categorize files
      const fileAnalysis = await this.analyzeS3Files()

      if (fileAnalysis.processableFiles.length === 0) {
        const message = fileAnalysis.totalFiles > 0
          ? `No processable PDF files found (${fileAnalysis.oversizedFiles.length} files too large)`
          : 'No PDF files found in analysis folder'

        console.log(`📭 ${message}`)
        const result = { success: false, message, ...fileAnalysis }

        await this.authService.writeDynamoMessage({
          pkey: 'ocrProcessing#job',
          skey: 'complete',
          origin: 'ocrProcessingJob',
          type: 'system',
          data: message
        })

        this.ocrJobRunning = false
        if (res) return res.status(200).json(result)
        return result
      }

      // Process each file with multi-tier OCR
      const results = await this.processFilesWithMultiOCR(fileAnalysis.processableFiles)

      // Extract contacts from processed text
      const contactResults = await this.extractContactsFromResults(results)

      // Final results
      const finalResult = {
        success: contactResults.totalContacts > 0,
        message: `Processed ${results.successful}/${fileAnalysis.processableFiles.length} files, extracted ${contactResults.totalContacts} contacts`,
        ...fileAnalysis,
        processingResults: results,
        contactExtractionResults: contactResults,
        timestamp: new Date().toISOString()
      }

      // Log completion
      await this.loggingService.writeMessage('ocrProcessingComplete', finalResult.message)
      await this.authService.writeDynamoMessage({
        pkey: 'ocrProcessing#job',
        skey: 'complete',
        origin: 'ocrProcessingJob',
        type: 'system',
        data: finalResult.message
      })

      console.log(`✅ OCR Processing Job Complete: ${finalResult.message}`)

      this.ocrJobRunning = false

      if (res) {
        return res.status(200).json(finalResult)
      }
      return finalResult

    } catch (error) {
      console.error(`💥 OCR processing job error: ${error.message}`)
      await this.loggingService.writeMessage('ocrProcessingError', error.message)

      await this.authService.writeDynamoMessage({
        pkey: 'ocrProcessing#job',
        skey: 'error',
        origin: 'ocrProcessingJob',
        type: 'system',
        data: `ERROR: ${error.message}`
      })

      this.ocrJobRunning = false

      const errorResult = {
        success: false,
        message: `OCR processing failed: ${error.message}`,
        errorTimestamp: new Date().toISOString()
      }

      if (res) {
        return res.status(500).json(errorResult)
      }
      return errorResult
    }
  }

  /**
   * Analyze S3 files and categorize by size/processability
   */
  async analyzeS3Files() {
    console.log(`📊 Analyzing files in s3://${this.config.sourceBucket}/${this.config.sourceFolder}/`)

    // List all PDF files
    const allFiles = await this.s3Service.listFiles(this.config.sourceFolder)
    const pdfFiles = allFiles.filter(file =>
      file.Key.toLowerCase().endsWith('.pdf') && !file.Key.endsWith('/')
    )

    // Categorize files by size
    let oversizedFiles = []
    let largeFiles = [] // Files that need Tesseract instead of Textract
    let processableFiles = []

    pdfFiles.forEach(file => {
      const sizeMB = (file.Size / 1024 / 1024).toFixed(1)

      if (file.Size > this.config.maxFileSize) {
        oversizedFiles.push({ file: file.Key, size: sizeMB })
        console.log(`🚫 SKIPPING - File too large (${sizeMB}MB): ${file.Key}`)
      } else if (file.Size > this.config.textractLimit) {
        largeFiles.push({ file: file.Key, size: sizeMB })
        processableFiles.push(file)
        console.log(`🔧 Large file (${sizeMB}MB): ${file.Key} - Will use Tesseract OCR`)
      } else {
        processableFiles.push(file)
        console.log(`✅ Standard file (${sizeMB}MB): ${file.Key} - Can use Textract or Tesseract`)
      }
    })

    // Log summary
    if (oversizedFiles.length > 0) {
      console.log(`\n🚨 DOCUMENT SIZE ALERT:`)
      console.log(`📊 ${oversizedFiles.length} files SKIPPED due to size limits:`)
      oversizedFiles.forEach(item => console.log(`   - ${item.file} (${item.size}MB)`))

      await this.authService.writeDynamoMessage({
        pkey: 'ocrProcessing#sizeAlert',
        skey: 'oversized',
        origin: 'ocrProcessingJob',
        type: 'warning',
        data: `${oversizedFiles.length} files skipped - too large: ${oversizedFiles.map(f => f.file).join(', ')}`
      })
    }

    if (largeFiles.length > 0) {
      console.log(`\n⚙️ OCR METHOD SELECTION:`)
      console.log(`📊 ${largeFiles.length} files will use Tesseract OCR (>10MB):`)
      largeFiles.forEach(item => console.log(`   - ${item.file} (${item.size}MB)`))
    }

    console.log(`\n📈 FILE ANALYSIS SUMMARY:`)
    console.log(`   Total PDFs found: ${pdfFiles.length}`)
    console.log(`   Files to process: ${processableFiles.length}`)
    console.log(`   Files skipped (too large): ${oversizedFiles.length}`)
    console.log(`   Files requiring Tesseract: ${largeFiles.length}`)

    return {
      totalFiles: pdfFiles.length,
      processableFiles,
      oversizedFiles,
      largeFiles
    }
  }

  /**
   * Process multiple files with multi-tier OCR
   */
  async processFilesWithMultiOCR(files) {
    console.log(`\n🔄 Processing ${files.length} files with multi-tier OCR...`)

    const results = {
      files: [],
      successful: 0,
      failed: 0,
      totalCharacters: 0,
      methods: {
        textract: 0,
        tesseract: 0,
        'basic-pdf': 0,
        none: 0
      }
    }

    for (const file of files) {
      try {
        console.log(`\n📄 Processing: ${file.Key} (${(file.Size/1024/1024).toFixed(1)}MB)`)

        // Download PDF from S3
        const s3Object = await this.s3Service.getObject(file.Key)
        const pdfBuffer = await s3Object.Body.transformToByteArray()

        // Multi-tier OCR processing
        const ocrResult = await this.ocrService.extractTextWithMultiOCR(Buffer.from(pdfBuffer), file.Key)

        // Track results
        const fileResult = {
          file: file.Key,
          size: file.Size,
          sizeMB: (file.Size/1024/1024).toFixed(1),
          success: ocrResult.success,
          method: ocrResult.method,
          textLength: ocrResult.extractedText.length,
          processingSteps: ocrResult.processingSteps,
          text: ocrResult.extractedText,
          textPreview: ocrResult.extractedText.substring(0, 500) // First 500 chars for debugging
        }

        results.files.push(fileResult)

        if (ocrResult.success) {
          results.successful++
          results.totalCharacters += ocrResult.extractedText.length
          results.methods[ocrResult.method]++
          console.log(`✅ Success: ${ocrResult.method} - ${ocrResult.extractedText.length} chars`)
        } else {
          results.failed++
          results.methods.none++
          console.log(`❌ Failed: No text extracted`)
        }

        // Add delay between files to avoid overwhelming Claude API
        if (files.indexOf(file) < files.length - 1) {
          console.log(`⏱️ Waiting 3 seconds before processing next file...`)
          await new Promise(resolve => setTimeout(resolve, 3000))
        }

      } catch (error) {
        console.error(`💥 Error processing ${file.Key}: ${error.message}`)
        results.files.push({
          file: file.Key,
          size: file.Size,
          success: false,
          method: 'error',
          textLength: 0,
          error: error.message
        })
        results.failed++
        results.methods.none++
      }
    }

    console.log(`\n📊 OCR PROCESSING SUMMARY:`)
    console.log(`   Successful: ${results.successful}/${files.length}`)
    console.log(`   Total characters extracted: ${results.totalCharacters.toLocaleString()}`)
    console.log(`   Methods used:`)
    Object.entries(results.methods).forEach(([method, count]) => {
      if (count > 0) console.log(`     - ${method}: ${count} files`)
    })

    return results
  }

  /**
   * Extract contacts from OCR results using Claude AI
   */
  async extractContactsFromResults(ocrResults) {
    console.log(`\n🤖 Extracting contacts using Claude AI...`)

    const contactResults = {
      totalContacts: 0,
      totalFiles: ocrResults.files.length,
      filesWithContacts: 0,
      contactsByFile: []
    }

    const successfulFiles = ocrResults.files.filter(f => f.success && f.textLength > 0)

    for (const fileResult of successfulFiles) {
      try {
        console.log(`🔍 Analyzing contacts in: ${fileResult.file}`)
        console.log(`📄 Text sample (first 1000 chars): ${fileResult.text.substring(0, 1000)}`)
        console.log(`📄 Middle text sample: ${fileResult.text.substring(Math.floor(fileResult.text.length/2), Math.floor(fileResult.text.length/2) + 1000)}`)

        // Save full text to temp file for inspection
        const fs = require('fs')
        const tempTextFile = `./temp/debug_${Date.now()}_extracted_text.txt`
        fs.writeFileSync(tempTextFile, fileResult.text)
        console.log(`💾 Full extracted text saved to: ${tempTextFile}`)

        // Add status tracking for Claude AI processing
        console.log(`🤖 Sending ${fileResult.textLength.toLocaleString()} characters to Claude AI for contact extraction...`)
        console.log(`⏳ This may take 2-5 minutes for large documents. Please wait...`)

        const claudeStartTime = Date.now()

        // Use existing PDF service to extract contacts (it uses Claude AI)
        const contacts = await this.extractContactsFromText(fileResult.text, fileResult.file)

        const claudeProcessingTime = ((Date.now() - claudeStartTime) / 1000).toFixed(1)
        console.log(`🤖 Claude AI completed in ${claudeProcessingTime}s - returned ${contacts.length} contacts for ${fileResult.file}`)

        const fileContactResult = {
          file: fileResult.file,
          contactCount: contacts.length,
          contacts: contacts,
          ocrMethod: fileResult.method,
          textLength: fileResult.textLength
        }

        contactResults.contactsByFile.push(fileContactResult)

        if (contacts.length > 0) {
          contactResults.totalContacts += contacts.length
          contactResults.filesWithContacts++

          // Save contacts to PostgreSQL
          if (this.postgresContactService && contacts.length > 0) {
            try {
              const saveResult = await this.postgresContactService.bulkInsertContacts(contacts)
              if (saveResult.success) {
                console.log(`✅ Saved ${contacts.length} contacts to PostgreSQL`)
                fileContactResult.savedToPostgres = true
                fileContactResult.insertedCount = saveResult.insertedCount
              } else {
                console.log(`⚠️ Failed to save contacts: ${saveResult.error}`)
                fileContactResult.savedToPostgres = false
                fileContactResult.error = saveResult.error
              }
            } catch (pgError) {
              console.error(`❌ PostgreSQL error: ${pgError.message}`)
              fileContactResult.savedToPostgres = false
              fileContactResult.error = pgError.message
            }
          }

          console.log(`✅ Found ${contacts.length} contacts in ${fileResult.file}`)
        } else {
          console.log(`📭 No contacts found in ${fileResult.file}`)
        }

      } catch (error) {
        console.error(`💥 Contact extraction error for ${fileResult.file}: ${error.message}`)
        contactResults.contactsByFile.push({
          file: fileResult.file,
          contactCount: 0,
          error: error.message
        })
      }
    }

    console.log(`\n📇 CONTACT EXTRACTION SUMMARY:`)
    console.log(`   Total contacts found: ${contactResults.totalContacts}`)
    console.log(`   Files with contacts: ${contactResults.filesWithContacts}/${successfulFiles.length}`)

    return contactResults
  }

  /**
   * Extract contacts from text using existing Claude AI logic
   */
  async extractContactsFromText(text, sourceFile) {
    try {
      // Use the existing ClaudeContactExtractor through PDFService
      // This is a simplified version - you might want to access ClaudeContactExtractor directly
      const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')

      const extractor = new ClaudeContactExtractor({
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        awsRegion: process.env.AWS_REGION,
        awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      })

      const contacts = await extractor.extractContactInfoWithClaude(text)

      // Add source file metadata
      const timestamp = new Date().toISOString()
      contacts.forEach(contact => {
        contact.source_file = sourceFile
        contact.extraction_method = 'ocr-controller'
        contact.processed_at = timestamp
      })

      return contacts

    } catch (error) {
      console.error(`❌ Claude AI contact extraction failed: ${error.message}`)
      return []
    }
  }

  /**
   * Process a single file (for manual testing)
   */
  async processSingleFileWithOCR(req, res) {
    try {
      const { pdfKey } = req.body

      if (!pdfKey) {
        return res.status(400).json({
          success: false,
          message: 'pdfKey is required'
        })
      }

      console.log(`🔍 Processing single file with OCR: ${pdfKey}`)

      // Download file from S3
      const s3Object = await this.s3Service.getObject(pdfKey)
      const pdfBuffer = await s3Object.Body.transformToByteArray()

      // Multi-tier OCR processing
      const ocrResult = await this.ocrService.extractTextWithMultiOCR(Buffer.from(pdfBuffer), pdfKey)

      let contacts = []
      if (ocrResult.success && ocrResult.extractedText.length > 0) {
        // Extract contacts
        contacts = await this.extractContactsFromText(ocrResult.extractedText, pdfKey)

        // Save to PostgreSQL
        if (contacts.length > 0 && this.postgresContactService) {
          const saveResult = await this.postgresContactService.bulkInsertContacts(contacts)
          ocrResult.savedToPostgres = saveResult.success
          ocrResult.insertedCount = saveResult.insertedCount || 0
        }
      }

      const result = {
        success: ocrResult.success,
        file: pdfKey,
        ocrResult,
        contactCount: contacts.length,
        contacts: contacts.slice(0, 10), // Return first 10 contacts
        processingTimestamp: new Date().toISOString()
      }

      res.json(result)

    } catch (error) {
      res.status(500).json({
        success: false,
        message: `Single file OCR processing failed: ${error.message}`
      })
    }
  }

  /**
   * Process single file with Claude only (no OCR) - for testing raw PDF text extraction
   */
  async processSingleFileClaudeOnly(req, res) {
    try {
      const { pdfKey } = req.body

      if (!pdfKey) {
        return res.status(400).json({
          success: false,
          message: 'pdfKey is required'
        })
      }

      console.log(`🔍 Processing single file with Claude only (no OCR): ${pdfKey}`)

      // Download file from S3
      const s3Object = await this.s3Service.getObject(pdfKey)
      const pdfBuffer = await s3Object.Body.transformToByteArray()

      // Use basic PDF text extraction only (skip all OCR)
      const pdf = require('pdf-parse')
      const startTime = Date.now()

      console.log(`📄 Extracting text with basic PDF parser...`)
      const pdfData = await pdf(Buffer.from(pdfBuffer))
      const extractedText = pdfData.text.replace(/\s+/g, ' ').trim()
      const extractionTime = Date.now() - startTime

      console.log(`📄 Basic PDF extraction: ${extractedText.length} characters from ${pdfData.numpages} pages in ${extractionTime}ms`)

      let contacts = []
      const result = {
        success: extractedText.length > 0,
        file: pdfKey,
        method: 'basic-pdf-only',
        extractedText: extractedText.substring(0, 1000) + (extractedText.length > 1000 ? '... (truncated for display)' : ''),
        fullTextLength: extractedText.length,
        pages: pdfData.numpages,
        extractionTime: extractionTime,
        contactCount: 0,
        contacts: [],
        processingTimestamp: new Date().toISOString()
      }

      if (extractedText.length > 0) {
        console.log(`🚀 Calling Claude API with ${extractedText.length.toLocaleString()} characters...`)

        // Extract contacts using Claude
        contacts = await this.extractContactsFromText(extractedText, pdfKey)
        result.contactCount = contacts.length
        result.contacts = contacts.slice(0, 10) // Return first 10 contacts

        // Save to PostgreSQL
        if (contacts.length > 0 && this.postgresContactService) {
          const saveResult = await this.postgresContactService.bulkInsertContacts(contacts)
          result.savedToPostgres = saveResult.success
          result.insertedCount = saveResult.insertedCount || 0
        }
      }

      res.json(result)

    } catch (error) {
      console.error(`❌ Claude-only processing failed: ${error.message}`)
      res.status(500).json({
        success: false,
        message: `Claude-only processing failed: ${error.message}`
      })
    }
  }

  /**
   * Process single file with Ghostscript flattening + Claude (no OCR) - for testing flattened PDF text extraction
   */
  async processSingleFileGhostscriptClaude(req, res) {
    try {
      const { pdfKey } = req.body

      if (!pdfKey) {
        return res.status(400).json({
          success: false,
          message: 'pdfKey is required'
        })
      }

      console.log(`🔍 Processing single file with Ghostscript + Claude (no OCR): ${pdfKey}`)

      // Download file from S3
      const s3Object = await this.s3Service.getObject(pdfKey)
      const pdfBuffer = await s3Object.Body.transformToByteArray()

      // Save to temp file for Ghostscript processing
      const fs = require('fs')
      const path = require('path')
      const { execSync } = require('child_process')

      const tempDir = process.env.OCR_TEMP_DIR || './temp/ocr'
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }

      const inputFile = path.join(tempDir, `gs_input_${Date.now()}.pdf`)
      const outputFile = path.join(tempDir, `gs_output_${Date.now()}.pdf`)

      try {
        // Save original PDF
        fs.writeFileSync(inputFile, Buffer.from(pdfBuffer))
        console.log(`📁 Saved input PDF: ${inputFile}`)

        // Flatten PDF with Ghostscript
        const startGsTime = Date.now()
        const gsQuality = process.env.GS_QUALITY || 'ebook'

        console.log(`🔧 Flattening PDF with Ghostscript (quality: ${gsQuality})...`)

        const gsCommand = [
          'gs',
          '-sDEVICE=pdfwrite',
          '-dCompatibilityLevel=1.4',
          '-dPDFSETTINGS=/' + gsQuality,
          '-dNOPAUSE',
          '-dQUIET',
          '-dBATCH',
          '-sOutputFile=' + outputFile,
          inputFile
        ].join(' ')

        execSync(gsCommand, { stdio: 'pipe' })
        const gsTime = Date.now() - startGsTime

        console.log(`✅ Ghostscript flattening completed in ${gsTime}ms`)

        // Read flattened PDF
        const flattenedBuffer = fs.readFileSync(outputFile)
        console.log(`📊 Original: ${pdfBuffer.length} bytes → Flattened: ${flattenedBuffer.length} bytes`)

        // Extract text from flattened PDF
        const pdf = require('pdf-parse')
        const startExtractTime = Date.now()

        console.log(`📄 Extracting text from flattened PDF...`)
        const pdfData = await pdf(flattenedBuffer)
        const extractedText = pdfData.text.replace(/\s+/g, ' ').trim()
        const extractionTime = Date.now() - startExtractTime

        console.log(`📄 Text extraction: ${extractedText.length} characters from ${pdfData.numpages} pages in ${extractionTime}ms`)

        // Cleanup temp files
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile)
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile)

        let contacts = []
        const result = {
          success: extractedText.length > 0,
          file: pdfKey,
          method: 'ghostscript-flattened',
          originalSize: pdfBuffer.length,
          flattenedSize: flattenedBuffer.length,
          compressionRatio: (pdfBuffer.length / flattenedBuffer.length).toFixed(2),
          gsQuality: gsQuality,
          gsTime: gsTime,
          extractedText: extractedText.substring(0, 1000) + (extractedText.length > 1000 ? '... (truncated for display)' : ''),
          fullTextLength: extractedText.length,
          pages: pdfData.numpages,
          extractionTime: extractionTime,
          contactCount: 0,
          contacts: [],
          processingTimestamp: new Date().toISOString()
        }

        if (extractedText.length > 0) {
          console.log(`🚀 Calling Claude API with ${extractedText.length.toLocaleString()} characters from flattened PDF...`)

          // Extract contacts using Claude
          contacts = await this.extractContactsFromText(extractedText, pdfKey)
          result.contactCount = contacts.length
          result.contacts = contacts.slice(0, 10) // Return first 10 contacts

          // Save to PostgreSQL
          if (contacts.length > 0 && this.postgresContactService) {
            const saveResult = await this.postgresContactService.bulkInsertContacts(contacts)
            result.savedToPostgres = saveResult.success
            result.insertedCount = saveResult.insertedCount || 0
          }
        }

        res.json(result)

      } catch (gsError) {
        // Cleanup on error
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile)
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile)

        throw new Error(`Ghostscript processing failed: ${gsError.message}`)
      }

    } catch (error) {
      console.error(`❌ Ghostscript + Claude processing failed: ${error.message}`)
      res.status(500).json({
        success: false,
        message: `Ghostscript + Claude processing failed: ${error.message}`
      })
    }
  }

  /**
   * Get OCR processing status
   */
  async getOCRStatus(req, res) {
    const status = {
      running: this.ocrJobRunning,
      configuration: this.config,
      ocrServiceStatus: this.ocrService.getStatus(),
      lastRun: null // Could be enhanced to track from DynamoDB
    }

    try {
      if (res) {
        return res.status(200).json({
          success: true,
          status
        })
      }
      return { success: true, status }
    } catch (error) {
      const errorResult = {
        success: false,
        message: error.message,
        status
      }

      if (res) {
        return res.status(500).json(errorResult)
      }
      return errorResult
    }
  }

  /**
   * Update OCR configuration
   */
  async updateOCRConfig(req, res) {
    try {
      const { sourceBucket, sourceFolder, enabled, schedule, maxFileSize, textractLimit } = req.body

      if (sourceBucket && typeof sourceBucket === 'string') {
        this.config.sourceBucket = sourceBucket
      }

      if (sourceFolder && typeof sourceFolder === 'string') {
        this.config.sourceFolder = sourceFolder
      }

      if (enabled !== undefined) {
        this.config.enabled = enabled
      }

      if (schedule && typeof schedule === 'string') {
        this.config.schedule = schedule
      }

      if (maxFileSize && typeof maxFileSize === 'number' && maxFileSize > 0) {
        this.config.maxFileSize = maxFileSize
      }

      if (textractLimit && typeof textractLimit === 'number' && textractLimit > 0) {
        this.config.textractLimit = textractLimit
      }

      console.log(`🔧 OCR configuration updated:`, this.config)

      const result = {
        success: true,
        message: 'OCR configuration updated successfully',
        config: this.config
      }

      if (res) {
        return res.status(200).json(result)
      }
      return result

    } catch (error) {
      const errorResult = {
        success: false,
        message: `Failed to update OCR config: ${error.message}`
      }

      if (res) {
        return res.status(500).json(errorResult)
      }
      return errorResult
    }
  }

  /**
   * List files in the analysis folder
   */
  async listAnalysisFiles(req, res) {
    try {
      const fileAnalysis = await this.analyzeS3Files()

      const result = {
        success: true,
        bucket: this.config.sourceBucket,
        folder: this.config.sourceFolder,
        ...fileAnalysis,
        files: fileAnalysis.processableFiles.slice(0, 50), // Limit response size
        timestamp: new Date().toISOString()
      }

      if (res) {
        return res.status(200).json(result)
      }
      return result

    } catch (error) {
      const errorResult = {
        success: false,
        message: `Failed to list analysis files: ${error.message}`,
        bucket: this.config.sourceBucket,
        folder: this.config.sourceFolder
      }

      if (res) {
        return res.status(500).json(errorResult)
      }
      return errorResult
    }
  }

  /**
   * Initialize cron job for scheduled processing
   */
  initializeCronJob() {
    if (this.config.enabled) {
      console.log(`🕐 Initializing OCR processing cron job: ${this.config.schedule}`)
      cron.schedule(this.config.schedule, async () => {
        try {
          console.log(`[${new Date().toISOString()}] 🔍 Starting scheduled OCR processing job`)
          await this.processS3PdfsWithOCR()
        } catch (error) {
          console.error('💥 Scheduled OCR processing failed:', error.message)
          await this.loggingService.writeMessage('ocrScheduleFailed', error.message)
        }
      })
    } else {
      console.log('⏸️ OCR processing cron job is disabled')
    }
  }
}

// Create single instance
const ocrController = new OCRController()

// Export controller function for routes
module.exports.Controller = { OCRController: ocrController }
module.exports.controller = (app) => {
  console.log('🔍 Loading OCR controller routes...')

  // Main OCR processing endpoints
  app.post('/v1/ocr/process-all', (req, res) => ocrController.processS3PdfsWithOCR(req, res))
  app.post('/v1/ocr/process-single', (req, res) => ocrController.processSingleFileWithOCR(req, res))
  app.post('/v1/ocr/process-claude-only', (req, res) => ocrController.processSingleFileClaudeOnly(req, res))
  app.post('/v1/ocr/process-ghostscript-claude', (req, res) => ocrController.processSingleFileGhostscriptClaude(req, res))

  // Status and configuration endpoints
  app.get('/v1/ocr/status', (req, res) => ocrController.getOCRStatus(req, res))
  app.put('/v1/ocr/config', (req, res) => ocrController.updateOCRConfig(req, res))
  app.get('/v1/ocr/list-files', (req, res) => ocrController.listAnalysisFiles(req, res))

  console.log('✅ OCR controller routes loaded successfully')
}