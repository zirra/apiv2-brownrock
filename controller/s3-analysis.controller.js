require('dotenv').config()

// Import services
const AuthService = require('../services/auth.service.js')
const S3Service = require('../services/s3.service.js')
const LoggingService = require('../services/logging.service.js')
const PDFService = require('../services/pdf.service.js')

class S3AnalysisController {
  constructor() {
    // Initialize services
    this.loggingService = new LoggingService()
    this.authService = new AuthService()
    this.s3Service = new S3Service(this.authService, this.loggingService)
    this.pdfService = new PDFService(this.authService, this.s3Service, this.loggingService)

    // S3 Analysis Job State
    this.s3AnalysisRunning = false
    this.s3AnalysisConfig = {
      sourceBucket: process.env.S3_ANALYSIS_BUCKET || 'ocdpdfs',
      sourceFolder: process.env.S3_ANALYSIS_FOLDER || 'analysis-pdfs',
      enabled: process.env.S3_ANALYSIS_ENABLED === 'true',
      schedule: process.env.S3_ANALYSIS_SCHEDULE || '0 2 * * 1', // Mondays at 2 AM
    }
  }

  // S3 PDF Analysis Job Methods
  async processS3PdfsForAnalysis(req, res) {
    if (this.s3AnalysisRunning) {
      if (res) {
        return res.status(429).json({
          success: false,
          message: 'S3 PDF analysis job is already running'
        })
      }
      return { success: false, message: 'S3 PDF analysis job is already running' }
    }

    this.s3AnalysisRunning = true

    try {
      console.log(`[${new Date().toISOString()}] 🔍 Starting S3 PDF Analysis Job`)
      console.log(`📁 Source: s3://${this.s3AnalysisConfig.sourceBucket}/${this.s3AnalysisConfig.sourceFolder}/`)

      await this.loggingService.writeMessage('s3AnalysisStart', 'Started S3 PDF analysis job')
      await this.authService.writeDynamoMessage({
        pkey: 's3Analysis#job',
        skey: 'start',
        origin: 's3AnalysisJob',
        type: 'system',
        data: `Started S3 PDF analysis from s3://${this.s3AnalysisConfig.sourceBucket}/${this.s3AnalysisConfig.sourceFolder}/`
      })

      // Use existing S3 service but list files from the analysis folder
      const pdfFiles = await this.s3Service.listFiles(this.s3AnalysisConfig.sourceFolder)
      const validPdfFiles = pdfFiles.filter(file =>
        file.Key.toLowerCase().endsWith('.pdf') && !file.Key.endsWith('/')
      )

      // Analyze file sizes and filter if needed
      const textractLimit = parseInt(process.env.TEXTRACT_SIZE_LIMIT) || (10 * 1024 * 1024) // 10MB default
      const maxFileSize = parseInt(process.env.MAX_FILE_SIZE) || (50 * 1024 * 1024) // 50MB default max

      let oversizedFiles = []
      let textractUnsuitableFiles = []
      let processableFiles = []

      validPdfFiles.forEach(file => {
        const sizeMB = (file.Size / 1024 / 1024).toFixed(1)

        if (file.Size > maxFileSize) {
          oversizedFiles.push({ file: file.Key, size: sizeMB })
          console.log(`🚫 SKIPPING - File too large (${sizeMB}MB): ${file.Key} - Exceeds max limit (${(maxFileSize/1024/1024).toFixed(1)}MB)`)
        } else if (file.Size > textractLimit) {
          textractUnsuitableFiles.push({ file: file.Key, size: sizeMB })
          processableFiles.push(file)
          console.log(`⚠️ Large file (${sizeMB}MB): ${file.Key} - Textract will fail, using basic extraction only`)
        } else {
          processableFiles.push(file)
          console.log(`✓ Optimal file (${sizeMB}MB): ${file.Key} - All processing methods available`)
        }
      })

      // Log summary of file filtering
      if (oversizedFiles.length > 0) {
        console.log(`\n🚨 DOCUMENT SIZE ALERT:`)
        console.log(`📊 ${oversizedFiles.length} files SKIPPED due to size limits:`)
        oversizedFiles.forEach(item => {
          console.log(`   - ${item.file} (${item.size}MB)`)
        })

        await this.authService.writeDynamoMessage({
          pkey: 's3Analysis#sizeAlert',
          skey: 'oversized',
          origin: 's3AnalysisJob',
          type: 'warning',
          data: `${oversizedFiles.length} files skipped - too large: ${oversizedFiles.map(f => f.file).join(', ')}`
        })
      }

      if (textractUnsuitableFiles.length > 0) {
        console.log(`\n⚠️ TEXTRACT LIMITATION ALERT:`)
        console.log(`📊 ${textractUnsuitableFiles.length} files will use basic extraction only (>10MB):`)
        textractUnsuitableFiles.forEach(item => {
          console.log(`   - ${item.file} (${item.size}MB)`)
        })
      }

      // Update to use filtered files
      const finalFilesToProcess = processableFiles

      if (finalFilesToProcess.length === 0) {
        const message = validPdfFiles.length > 0
          ? `No processable PDF files found (${oversizedFiles.length} files too large)`
          : 'No PDF files found in analysis bucket'

        console.log(`📭 ${message}`)
        const result = { success: false, message }

        await this.authService.writeDynamoMessage({
          pkey: 's3Analysis#job',
          skey: 'complete',
          origin: 's3AnalysisJob',
          type: 'system',
          data: message
        })

        this.s3AnalysisRunning = false
        if (res) return res.status(200).json(result)
        return result
      }

      console.log(`\n📊 PROCESSING SUMMARY:`)
      console.log(`   Total PDFs found: ${validPdfFiles.length}`)
      console.log(`   Files to process: ${finalFilesToProcess.length}`)
      console.log(`   Files skipped (too large): ${oversizedFiles.length}`)
      console.log(`   Files with basic extraction only: ${textractUnsuitableFiles.length}`)

      // Extract just the keys for processing
      const pdfKeys = finalFilesToProcess.map(file => file.Key)

      // Process the PDFs for contact extraction using existing services
      const result = await this.pdfService.processContactsFromPdfs(pdfKeys)

      if (result.success) {
        console.log(`✅ S3 PDF Analysis completed successfully!`)
        console.log(`📊 Extracted ${result.contactCount} contacts from ${result.filesProcessed} files`)

        await this.loggingService.writeMessage('s3AnalysisComplete',
          `SUCCESS: Extracted ${result.contactCount} contacts from ${result.filesProcessed} files`)

        await this.authService.writeDynamoMessage({
          pkey: 's3Analysis#job',
          skey: 'complete',
          origin: 's3AnalysisJob',
          type: 'system',
          data: `SUCCESS: Extracted ${result.contactCount} contacts from ${result.filesProcessed} files`
        })

        // Add analysis-specific metadata
        result.sourceBucket = this.s3AnalysisConfig.sourceBucket
        result.sourceFolder = this.s3AnalysisConfig.sourceFolder
        result.totalFilesFound = validPdfFiles.length
        result.filesProcessed = finalFilesToProcess.length
        result.filesSkippedTooLarge = oversizedFiles.length
        result.filesWithBasicExtractionOnly = textractUnsuitableFiles.length
        result.analysisTimestamp = new Date().toISOString()

        // Add detailed file categorization
        if (oversizedFiles.length > 0) {
          result.skippedFiles = oversizedFiles
        }
        if (textractUnsuitableFiles.length > 0) {
          result.basicExtractionFiles = textractUnsuitableFiles
        }

      } else {
        console.log(`❌ S3 PDF Analysis failed: ${result.message}`)
        await this.loggingService.writeMessage('s3AnalysisFailed', `FAILED: ${result.message}`)

        await this.authService.writeDynamoMessage({
          pkey: 's3Analysis#job',
          skey: 'error',
          origin: 's3AnalysisJob',
          type: 'system',
          data: `FAILED: ${result.message}`
        })
      }

      this.s3AnalysisRunning = false

      if (res) {
        return res.status(result.success ? 200 : 400).json(result)
      }
      return result

    } catch (error) {
      console.error(`💥 S3 PDF Analysis job error: ${error.message}`)
      await this.loggingService.writeMessage('s3AnalysisError', error.message)

      await this.authService.writeDynamoMessage({
        pkey: 's3Analysis#job',
        skey: 'error',
        origin: 's3AnalysisJob',
        type: 'system',
        data: `ERROR: ${error.message}`
      })

      this.s3AnalysisRunning = false

      const errorResult = {
        success: false,
        message: `S3 PDF Analysis failed: ${error.message}`,
        sourceBucket: this.s3AnalysisConfig.sourceBucket,
        sourceFolder: this.s3AnalysisConfig.sourceFolder,
        errorTimestamp: new Date().toISOString()
      }

      if (res) {
        return res.status(500).json(errorResult)
      }
      return errorResult
    }
  }

  async getS3AnalysisStatus(req, res) {
    const status = {
      running: this.s3AnalysisRunning,
      config: this.s3AnalysisConfig,
      lastRun: null,
      nextScheduled: null
    }

    try {
      // You could add logic here to fetch last run time from DynamoDB logs if needed
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

  async updateS3AnalysisConfig(req, res) {
    try {
      const { sourceBucket, sourceFolder, enabled, schedule } = req.body

      if (sourceBucket && typeof sourceBucket === 'string') {
        this.s3AnalysisConfig.sourceBucket = sourceBucket
      }

      if (sourceFolder && typeof sourceFolder === 'string') {
        this.s3AnalysisConfig.sourceFolder = sourceFolder
      }

      if (enabled !== undefined) {
        this.s3AnalysisConfig.enabled = enabled
      }

      if (schedule && typeof schedule === 'string') {
        this.s3AnalysisConfig.schedule = schedule
      }

      console.log(`🔧 S3 Analysis config updated:`, this.s3AnalysisConfig)

      const result = {
        success: true,
        message: 'S3 Analysis configuration updated successfully',
        config: this.s3AnalysisConfig
      }

      if (res) {
        return res.status(200).json(result)
      }
      return result

    } catch (error) {
      const errorResult = {
        success: false,
        message: `Failed to update S3 analysis config: ${error.message}`
      }

      if (res) {
        return res.status(500).json(errorResult)
      }
      return errorResult
    }
  }

  async listS3AnalysisBucket(req, res) {
    try {
      // List files from the analysis folder using existing S3 service
      const files = await this.s3Service.listFiles(this.s3AnalysisConfig.sourceFolder)
      const pdfFiles = files.filter(file =>
        file.Key.toLowerCase().endsWith('.pdf') && !file.Key.endsWith('/')
      )

      const result = {
        success: true,
        bucket: this.s3AnalysisConfig.sourceBucket,
        folder: this.s3AnalysisConfig.sourceFolder,
        totalFiles: files.length,
        pdfFiles: pdfFiles.length,
        files: pdfFiles.slice(0, 50) // Limit to first 50 for response size
      }

      if (res) {
        return res.status(200).json(result)
      }
      return result

    } catch (error) {
      const errorResult = {
        success: false,
        message: `Failed to list S3 analysis folder: ${error.message}`,
        bucket: this.s3AnalysisConfig.sourceBucket,
        folder: this.s3AnalysisConfig.sourceFolder
      }

      if (res) {
        return res.status(500).json(errorResult)
      }
      return errorResult
    }
  }

  getConfig() {
    return this.s3AnalysisConfig
  }

  isRunning() {
    return this.s3AnalysisRunning
  }
}

// Create single instance
const s3AnalysisController = new S3AnalysisController()

// Export controller
module.exports.Controller = { S3AnalysisController: s3AnalysisController }
module.exports.controller = (app) => {
  console.log('🔧 Loading S3 Analysis controller routes...')

  // S3 PDF Analysis Job endpoints
  app.post('/v1/s3-analysis/run', (req, res) => s3AnalysisController.processS3PdfsForAnalysis(req, res))
  app.get('/v1/s3-analysis/status', (req, res) => s3AnalysisController.getS3AnalysisStatus(req, res))
  app.put('/v1/s3-analysis/config', (req, res) => s3AnalysisController.updateS3AnalysisConfig(req, res))
  app.get('/v1/s3-analysis/list-bucket', (req, res) => s3AnalysisController.listS3AnalysisBucket(req, res))

  console.log('✅ S3 Analysis controller routes loaded successfully')
}
