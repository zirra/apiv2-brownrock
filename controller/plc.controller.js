require('dotenv').config()
const cron = require('node-cron')
const multer = require('multer')
const fs = require('fs')
const path = require('path')

// Import services
const AuthService = require('../services/auth.service.js')
const S3Service = require('../services/s3.service.js')
const LoggingService = require('../services/logging.service.js')
const DataService = require('../services/data.service.js')
const PostgresContactService = require('../services/postgres-contact.service.js')

// Import other controllers for PDF processing utilities
const { Controller: PdfControllerModule } = require('./pdf.controller.js')

// Configure multer for file uploads
const uploadDir = process.env.UPLOAD_TEMP_DIR || './temp/uploads'
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, `upload-${uniqueSuffix}-${file.originalname}`)
  }
})

const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_UPLOAD_SIZE) || (150 * 1024 * 1024) // 150MB default
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true)
    } else {
      cb(new Error('Only PDF files are allowed'))
    }
  }
})

class PlcController {
  constructor() {
    // Initialize services
    this.loggingService = new LoggingService()
    this.authService = new AuthService()
    this.s3Service = new S3Service(this.authService, this.loggingService)
    this.dataService = new DataService(this.authService, this.loggingService)
    this.postgresContactService = new PostgresContactService()

    // Reference to PDF controller for utility methods
    this.pdfController = PdfControllerModule.PdfController

    // State
    this.filesToProcess = []
    this.appScheduleRunning = false

    // Configuration for local processing
    this.config = {
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 500000,
      processLocally: true // Always process locally for vision
    }

    // Initialize cron job
    this.initializeCronJob()
  }

  // Helper method to detect file type from buffer
  detectFileType(buffer) {
    const header = buffer.toString('hex', 0, Math.min(20, buffer.length))
    const text = buffer.toString('utf8', 0, Math.min(100, buffer.length))

    // Common file signatures
    if (header.startsWith('25504446')) return 'PDF'
    if (header.startsWith('ffd8ff')) return 'JPEG image'
    if (header.startsWith('89504e47')) return 'PNG image'
    if (header.startsWith('474946')) return 'GIF image'
    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) return 'HTML document'
    if (text.startsWith('<?xml')) return 'XML document'
    if (text.startsWith('{') || text.startsWith('[')) return 'JSON document'
    if (header.startsWith('504b0304')) return 'ZIP/Office document'

    return 'Unknown file type'
  }

  getStatus(req, res) {
    res.status(200).send({
      running: this.appScheduleRunning,
      config: this.config,
      filesToProcess: this.filesToProcess.length
    })
  }

  // Main vision processing workflow - processes PDFs from applicants
  async processWithVision(req, res) {
    const { execSync } = require('child_process')
    const jobIdService = require('../services/job-id.service')

    // Generate unique job ID for this processing run
    const jobId = jobIdService.generateJobId('PLC')
    console.log(`🆔 Generated Job ID for this run: ${jobId}`)

    // Track processing metrics
    const metrics = {
      totalFiles: 0,
      uploadFailed: 0,
      downloadFailed: 0,
      validationFailed: 0,
      processingFailed: 0,
      successfullyProcessed: 0,
      totalContacts: 0,
      skippedFiles: [],
      jobId
    }

    try {
      this.appScheduleRunning = true
      const countyNames = this.dataService.getCountyNames()

      for (let j = 0; j < countyNames.length; j++) {
        const county = countyNames[j]
        console.log(`🔍 Processing county with Vision: ${county}`)

        if (!this.authService.getToken()) {
          await this.authService.login()
        }

        const response = await this.dataService.callForDataByCounty(county, 'PLC')

        if (!response || !response.data || !Array.isArray(response.data.Items)) {
          console.warn(`⚠️ No valid data returned for county "${county}". Skipping...`)
          await this.loggingService.writeMessage('missingItems', `No Items for ${county}`)
          continue
        }

        const items = response.data.Items
        console.log(`✅ Retrieved ${items.length} items for ${county}`)

        const allPdfs = items.flatMap(item => item.ImagingFiles || [])

        if (!allPdfs.length) {
          console.log(`📭 No ImagingFiles found for "${county}".`)
          continue
        }

        for (let i = 0; i < allPdfs.length; i++) {
          const pdf = allPdfs[i]
          const s3Key = `plc-pdfs/${county}/${pdf.FileName}`

          if (pdf.FileSize <= this.config.maxFileSize) {
            metrics.totalFiles++

            console.log(`\n📄 [${i + 1}/${allPdfs.length}] Processing: ${pdf.FileName} (${pdf.FileSize} bytes)`)

            // Download PDF locally
            const localPath = path.join(
              process.env.PLC_LOCAL_PDF_PATH || './downloads/plc-pdfs',
              county,
              pdf.FileName
            )

            const localDir = path.dirname(localPath)
            if (!fs.existsSync(localDir)) {
              fs.mkdirSync(localDir, { recursive: true })
            }

            // First, upload PDF from EMNRD API to S3
            try {
              console.log(`☁️ Uploading ${pdf.FileName} to S3: ${s3Key}`)
              await this.s3Service.uploadToS3(pdf.Url, s3Key)
              console.log(`✅ Uploaded to S3: ${s3Key}`)
            } catch (uploadError) {
              console.error(`❌ Upload to S3 failed for ${pdf.FileName}: ${uploadError.message}`)
              metrics.uploadFailed++
              continue
            }

            // Then, download PDF from S3 for local processing
            let fileDownloadSuccess = false
            try {
              console.log(`⬇️ Downloading PDF from S3: ${s3Key}`)
              const pdfBuffer = await this.s3Service.fetchFromS3(s3Key)

              if (!pdfBuffer || pdfBuffer.length === 0) {
                console.error(`❌ Downloaded file is empty or invalid: ${s3Key}`)
                metrics.downloadFailed++
                continue
              }

              const fileType = this.detectFileType(pdfBuffer)
              console.log(`📋 Detected file type: ${fileType}`)

              if (fileType !== 'PDF') {
                console.error(`❌ Invalid file type for ${pdf.FileName}: ${fileType}. Expected PDF. Skipping...`)
                metrics.validationFailed++
                continue
              }

              // Save to local file system
              fs.writeFileSync(localPath, pdfBuffer)
              console.log(`✅ Downloaded to: ${localPath}`)
              fileDownloadSuccess = true

            } catch (downloadError) {
              console.error(`❌ Download failed for ${pdf.FileName}: ${downloadError.message}`)
              metrics.downloadFailed++
              continue
            }

            if (!fileDownloadSuccess) {
              continue
            }

            // Process with Ghostscript + Claude Vision
            let outputDir = null
            let resizedPdfPath = null

            try {
              const tempDir = process.env.UPLOAD_TEMP_DIR || './temp/uploads'
              if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true })
              }

              outputDir = path.join(tempDir, `gs_images_${Date.now()}`)
              if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true })
              }

              // First, try to optimize/flatten the PDF with Ghostscript
              resizedPdfPath = path.join(tempDir, `gs_resized_${Date.now()}.pdf`)
              let pdfToConvert = localPath // Default to original file
              let gsTime = 0

              try {
                console.log(`🔧 Optimizing PDF with Ghostscript...`)
                const gsOptimizeCommand = [
                  'gs',
                  '-sDEVICE=pdfwrite',
                  '-dCompatibilityLevel=1.4',
                  '-dPDFSETTINGS=/ebook',
                  '-dNOPAUSE',
                  '-dQUIET',
                  '-dBATCH',
                  `-sOutputFile=${resizedPdfPath}`,
                  localPath
                ].join(' ')

                execSync(gsOptimizeCommand, { stdio: 'pipe' })
                console.log(`✅ PDF optimized`)
                pdfToConvert = resizedPdfPath // Use optimized version
              } catch (gsOptimizeError) {
                console.warn(`⚠️ PDF optimization failed, will try converting original file directly: ${gsOptimizeError.message}`)
                // Continue with original file
              }

              // Convert PDF to PNG images using Ghostscript
              const startGsTime = Date.now()
              const resolution = process.env.GS_IMAGE_RESOLUTION || '300' // 300 DPI default

              console.log(`🖼️ Converting PDF to PNG images at ${resolution} DPI...`)

              const outputPattern = path.join(outputDir, 'output_%03d.png')
              const gsCommand = [
                'gs',
                '-o', outputPattern,
                '-sDEVICE=png16m',
                `-r${resolution}`,
                pdfToConvert
              ].join(' ')

              try {
                execSync(gsCommand, { stdio: 'pipe' })
                gsTime = Date.now() - startGsTime
                console.log(`✅ Ghostscript image conversion completed in ${gsTime}ms`)
              } catch (gsConvertError) {
                // If conversion fails completely, try with error recovery flags
                console.warn(`⚠️ First conversion attempt failed, trying with error recovery...`)

                try {
                  const gsRecoveryCommand = [
                    'gs',
                    '-o', outputPattern,
                    '-sDEVICE=png16m',
                    `-r${resolution}`,
                    '-dPDFSTOPONERROR=false',  // Don't stop on errors
                    '-dNOSAFER',               // Allow more operations
                    pdfToConvert
                  ].join(' ')

                  execSync(gsRecoveryCommand, { stdio: 'pipe' })
                  gsTime = Date.now() - startGsTime
                  console.log(`✅ Ghostscript conversion succeeded with recovery mode in ${gsTime}ms`)
                } catch (gsRecoveryError) {
                  // Ghostscript completely failed - fall back to Claude Native PDF processing
                  console.warn(`⚠️ Ghostscript failed completely, falling back to Claude Native PDF processing...`)

                  const pdfBuffer = fs.readFileSync(localPath)
                  const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
                  const extractor = new ClaudeContactExtractor({
                    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
                    awsRegion: process.env.AWS_REGION,
                    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                    documentType: 'plc-contacts'
                  })

                  const startNativeTime = Date.now()
                  const contacts = await extractor.extractContactsFromPDFNative(pdfBuffer, pdf.FileName)
                  const nativeTime = Date.now() - startNativeTime

                  console.log(`✅ Claude Native PDF processing succeeded in ${nativeTime}ms: ${contacts.length} contacts`)

                  // Add metadata to contacts
                  const enrichedContacts = contacts.map(c => ({
                    ...c,
                    source_file: pdf.FileName,
                    record_type: county,
                    extraction_method: 'claude-native-pdf-fallback',
                    project_origin: 'PLC',
                    jobid: jobId
                  }))

                  // Save to PostgreSQL
                  if (enrichedContacts.length > 0 && this.postgresContactService) {
                    console.log(`💾 Saving ${enrichedContacts.length} contacts to PostgreSQL...`)
                    const insertResult = await this.postgresContactService.bulkInsertContacts(enrichedContacts)

                    if (insertResult.success) {
                      console.log(`✅ Saved ${insertResult.insertedCount} contacts to PostgreSQL`)
                      metrics.totalContacts += insertResult.insertedCount
                      metrics.successfullyProcessed++
                    } else {
                      console.error(`❌ Failed to save contacts: ${insertResult.error}`)
                    }
                  }

                  // Cleanup
                  if (outputDir && fs.existsSync(outputDir)) {
                    fs.rmSync(outputDir, { recursive: true, force: true })
                  }
                  if (resizedPdfPath && fs.existsSync(resizedPdfPath)) {
                    fs.unlinkSync(resizedPdfPath)
                  }

                  continue // Skip to next PDF
                }
              }

              // Get all generated PNG images
              const imageFiles = fs.readdirSync(outputDir)
                .filter(file => file.endsWith('.png'))
                .sort()
                .map(file => path.join(outputDir, file))

              console.log(`📸 Generated ${imageFiles.length} PNG images`)

              if (imageFiles.length === 0) {
                console.error(`❌ No images generated from PDF`)
                metrics.processingFailed++
                continue
              }

              // Resize images if needed (Claude has 2000px limit)
              const maxDimension = 2000
              console.log(`🔍 Checking image sizes (max dimension: ${maxDimension}px)...`)

              const validImageFiles = []
              for (const imagePath of imageFiles) {
                try {
                  const { execSync } = require('child_process')
                  const identifyOutput = execSync(`identify -format "%wx%h" "${imagePath}"`, { encoding: 'utf8' })
                  const [width, height] = identifyOutput.trim().split('x').map(Number)

                  if (width > maxDimension || height > maxDimension) {
                    console.log(`📐 Image ${path.basename(imagePath)} is ${width}x${height}, resizing...`)
                    const resizeCommand = `convert "${imagePath}" -resize ${maxDimension}x${maxDimension} "${imagePath}"`
                    execSync(resizeCommand, { stdio: 'pipe' })
                    console.log(`✅ Resized ${path.basename(imagePath)}`)
                  }
                  validImageFiles.push(imagePath)
                } catch (resizeError) {
                  console.warn(`⚠️ Could not process ${path.basename(imagePath)}: ${resizeError.message}. Skipping this image.`)
                  // Skip images that fail ImageMagick processing
                }
              }

              // Update imageFiles to only include valid images
              imageFiles.length = 0
              imageFiles.push(...validImageFiles)

              // Process with Claude Vision
              const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
              const extractor = new ClaudeContactExtractor({
                anthropicApiKey: process.env.ANTHROPIC_API_KEY,
                awsRegion: process.env.AWS_REGION,
                awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
                awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                documentType: 'plc-contacts'
              })

              // Prepare image data for Claude
              const startClaudeTime = Date.now()
              const imageData = imageFiles.map(imagePath => {
                const imageBuffer = fs.readFileSync(imagePath)
                return {
                  path: path.basename(imagePath),
                  base64: imageBuffer.toString('base64'),
                  size: imageBuffer.length
                }
              })

              // Call Claude with vision API to analyze images
              const contacts = await extractor.extractContactsFromImages(imageData, pdf.FileName)

              const claudeTime = Date.now() - startClaudeTime
              console.log(`✅ Claude analyzed ${imageFiles.length} images and extracted ${contacts.length} contacts in ${claudeTime}ms`)

              // Add metadata to contacts
              const enrichedContacts = contacts.map(c => ({
                ...c,
                source_file: pdf.FileName,
                record_type: county,
                extraction_method: 'ghostscript-claude-vision',
                project_origin: 'PLC',
                jobid: jobId
              }))

              // Save to PostgreSQL
              if (enrichedContacts.length > 0 && this.postgresContactService) {
                console.log(`💾 Saving ${enrichedContacts.length} contacts to PostgreSQL...`)
                const insertResult = await this.postgresContactService.bulkInsertContacts(enrichedContacts)

                if (insertResult.success) {
                  console.log(`✅ Saved ${insertResult.insertedCount} contacts to PostgreSQL`)
                  metrics.totalContacts += insertResult.insertedCount
                  metrics.successfullyProcessed++
                } else {
                  console.error(`❌ Failed to save contacts: ${insertResult.error}`)
                }
              }

              // Cleanup temp files
              console.log(`🧹 Cleaning up temporary files...`)
              if (outputDir && fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true, force: true })
              }
              if (resizedPdfPath && fs.existsSync(resizedPdfPath)) {
                fs.unlinkSync(resizedPdfPath)
              }

            } catch (processingError) {
              console.error(`❌ Vision processing failed for ${pdf.FileName}: ${processingError.message}`)
              console.error('Stack trace:', processingError.stack)
              metrics.processingFailed++

              // Cleanup on error
              try {
                if (outputDir && fs.existsSync(outputDir)) {
                  fs.rmSync(outputDir, { recursive: true, force: true })
                }
                if (resizedPdfPath && fs.existsSync(resizedPdfPath)) {
                  fs.unlinkSync(resizedPdfPath)
                }
              } catch (cleanupError) {
                console.error(`⚠️ Cleanup failed: ${cleanupError.message}`)
              }
            }

          } else {
            console.log(`⏭️ Skipping ${pdf.FileName}: exceeds size limit (${pdf.FileSize} > ${this.config.maxFileSize})`)
            metrics.skippedFiles.push({
              fileName: pdf.FileName,
              fileSize: pdf.FileSize,
              reason: 'File size exceeds limit'
            })
          }
        }
      }

      this.appScheduleRunning = false

      // Log final metrics
      console.log('\n' + '='.repeat(80))
      console.log('📊 PLC VISION PROCESSING COMPLETE')
      console.log('='.repeat(80))
      console.log(`Job ID: ${metrics.jobId}`)
      console.log(`Total files processed: ${metrics.totalFiles}`)
      console.log(`✅ Successfully processed: ${metrics.successfullyProcessed}`)
      console.log(`❌ Download failed: ${metrics.downloadFailed}`)
      console.log(`❌ Validation failed: ${metrics.validationFailed}`)
      console.log(`❌ Processing failed: ${metrics.processingFailed}`)
      console.log(`👥 Total contacts extracted: ${metrics.totalContacts}`)
      console.log(`⏭️ Files skipped: ${metrics.skippedFiles.length}`)
      console.log('='.repeat(80) + '\n')

      if (res) {
        res.status(200).json({
          success: true,
          message: 'PLC Vision processing completed',
          metrics
        })
      }

      return true

    } catch (err) {
      console.error(`💥 Fatal error in processWithVision(): ${err.message}`)
      await this.loggingService.writeMessage('olmProcessWithVisionFatal', err.message)

      this.appScheduleRunning = false

      if (res) {
        res.status(500).json({
          success: false,
          message: err.message
        })
      }

      return false
    }
  }

  /**
   * Upload and process a single PDF with Claude Vision (Ghostscript + Claude)
   * Accepts multipart/form-data file upload
   */
  async uploadAndProcessWithClaudeVision(req, res) {
    const { execSync } = require('child_process')
    const jobIdService = require('../services/job-id.service')
    let uploadedFilePath = null
    let outputDir = null
    let resizedPdfPath = null

    try {
      // Check if file was uploaded
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No PDF file uploaded. Please upload a PDF file with field name "pdf"'
        })
      }

      uploadedFilePath = req.file.path
      const originalName = req.file.originalname
      const applicant = req.body.applicant || 'manual-upload'

      // Generate unique job ID for this upload
      const jobId = jobIdService.generateJobId('PLC')
      console.log(`🆔 Generated Job ID for upload: ${jobId}`)

      console.log(`📤 Received upload for Vision processing: ${originalName} (${req.file.size} bytes)`)
      console.log(`📋 Applicant: ${applicant}`)

      // S3 key for upload
      const s3Key = `plc-pdfs/${applicant}/${originalName}`

      // Prepare temp directory for image output
      const tempDir = process.env.UPLOAD_TEMP_DIR || './temp/uploads'
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }

      outputDir = path.join(tempDir, `gs_images_${Date.now()}`)
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      // First, optionally resize/flatten the PDF with Ghostscript for better image quality
      resizedPdfPath = path.join(tempDir, `gs_resized_${Date.now()}.pdf`)

      console.log(`🔧 Optimizing PDF with Ghostscript...`)
      try {
        const gsOptimizeCommand = [
          'gs',
          '-sDEVICE=pdfwrite',
          '-dCompatibilityLevel=1.4',
          '-dPDFSETTINGS=/ebook',
          '-dNOPAUSE',
          '-dQUIET',
          '-dBATCH',
          `-sOutputFile=${resizedPdfPath}`,
          uploadedFilePath
        ].join(' ')

        execSync(gsOptimizeCommand, { stdio: 'pipe' })
        console.log(`✅ PDF optimized`)
      } catch (gsOptimizeError) {
        console.warn(`⚠️ PDF optimization failed: ${gsOptimizeError.message}`)
        resizedPdfPath = uploadedFilePath // Use original if optimization fails
      }

      // Convert PDF to PNG images using Ghostscript
      const startGsTime = Date.now()
      const resolution = process.env.GS_IMAGE_RESOLUTION || '300'

      console.log(`🖼️ Converting PDF to PNG images at ${resolution} DPI...`)

      const outputPattern = path.join(outputDir, 'output_%03d.png')
      const gsCommand = [
        'gs',
        '-o', outputPattern,
        '-sDEVICE=png16m',
        `-r${resolution}`,
        resizedPdfPath
      ].join(' ')

      execSync(gsCommand, { stdio: 'pipe' })
      const gsTime = Date.now() - startGsTime
      console.log(`✅ Ghostscript image conversion completed in ${gsTime}ms`)

      // Get all generated PNG images
      const imageFiles = fs.readdirSync(outputDir)
        .filter(file => file.endsWith('.png'))
        .sort()
        .map(file => path.join(outputDir, file))

      console.log(`📸 Generated ${imageFiles.length} PNG images`)

      if (imageFiles.length === 0) {
        throw new Error('No images generated from PDF')
      }

      // Resize images if needed
      const maxDimension = 2000
      console.log(`🔍 Checking image sizes (max dimension: ${maxDimension}px)...`)

      const validImageFiles = []
      for (const imagePath of imageFiles) {
        try {
          const identifyOutput = execSync(`identify -format "%wx%h" "${imagePath}"`, { encoding: 'utf8' })
          const [width, height] = identifyOutput.trim().split('x').map(Number)

          if (width > maxDimension || height > maxDimension) {
            console.log(`📐 Image ${path.basename(imagePath)} is ${width}x${height}, resizing...`)
            const resizeCommand = `convert "${imagePath}" -resize ${maxDimension}x${maxDimension} "${imagePath}"`
            execSync(resizeCommand, { stdio: 'pipe' })
            console.log(`✅ Resized ${path.basename(imagePath)}`)
          }
          validImageFiles.push(imagePath)
        } catch (resizeError) {
          console.warn(`⚠️ Could not process ${path.basename(imagePath)}: ${resizeError.message}. Skipping this image.`)
        }
      }

      // Update imageFiles to only include valid images
      imageFiles.length = 0
      imageFiles.push(...validImageFiles)

      // Process with Claude Vision
      const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
      const extractor = new ClaudeContactExtractor({
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        awsRegion: process.env.AWS_REGION,
        awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        documentType: 'plc-contacts'
      })

      // Prepare image data for Claude
      const startClaudeTime = Date.now()
      const imageData = imageFiles.map(imagePath => {
        const imageBuffer = fs.readFileSync(imagePath)
        return {
          path: path.basename(imagePath),
          base64: imageBuffer.toString('base64'),
          size: imageBuffer.length
        }
      })

      // Call Claude with vision API to analyze images
      const contacts = await extractor.extractContactsFromImages(imageData, originalName)

      const claudeTime = Date.now() - startClaudeTime
      console.log(`✅ Claude analyzed ${imageFiles.length} images and extracted ${contacts.length} contacts in ${claudeTime}ms`)

      // Add metadata to contacts
      const enrichedContacts = contacts.map(c => ({
        ...c,
        source_file: originalName,
        record_type: applicant,
        extraction_method: 'ghostscript-claude-vision',
        project_origin: 'PLC',
        jobid: jobId
      }))

      // Save to PostgreSQL
      if (enrichedContacts.length > 0 && this.postgresContactService) {
        console.log(`💾 Saving ${enrichedContacts.length} contacts to PostgreSQL...`)
        const insertResult = await this.postgresContactService.bulkInsertContacts(enrichedContacts)

        if (insertResult.success) {
          console.log(`✅ Saved ${insertResult.insertedCount} contacts to PostgreSQL`)
        }
      }

      // Upload original PDF to S3
      console.log(`☁️ Uploading PDF to S3: ${s3Key}`)
      const pdfBuffer = fs.readFileSync(uploadedFilePath)
      await this.s3Service.uploadBufferToS3(pdfBuffer, s3Key)
      console.log(`✅ Uploaded to S3`)

      // Cleanup
      console.log(`🧹 Cleaning up temporary files...`)
      if (fs.existsSync(uploadedFilePath)) {
        fs.unlinkSync(uploadedFilePath)
      }
      if (outputDir && fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true })
      }
      if (resizedPdfPath && resizedPdfPath !== uploadedFilePath && fs.existsSync(resizedPdfPath)) {
        fs.unlinkSync(resizedPdfPath)
      }

      res.status(200).json({
        success: true,
        message: 'PLC Vision processing completed',
        jobId,
        fileName: originalName,
        applicant,
        contactsExtracted: contacts.length,
        contactsSaved: enrichedContacts.length,
        s3Key
      })

    } catch (error) {
      console.error(`❌ Upload and process failed: ${error.message}`)
      console.error('Stack trace:', error.stack)

      // Cleanup on error
      try {
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
          fs.unlinkSync(uploadedFilePath)
        }
        if (outputDir && fs.existsSync(outputDir)) {
          fs.rmSync(outputDir, { recursive: true, force: true })
        }
        if (resizedPdfPath && resizedPdfPath !== uploadedFilePath && fs.existsSync(resizedPdfPath)) {
          fs.unlinkSync(resizedPdfPath)
        }
      } catch (cleanupError) {
        console.error(`⚠️ Cleanup failed: ${cleanupError.message}`)
      }

      res.status(500).json({
        success: false,
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    }
  }

  initializeCronJob() {
    const olmCronEnabled = process.env.PLC_CRON_ENABLED === 'true'
    const olmCronSchedule = process.env.PLC_CRON_SCHEDULE || '59 23 * * 4' // Thursdays at 11:59 PM

    if (olmCronEnabled) {
      console.log(`📅 Initializing PLC cron job: ${olmCronSchedule}`)
      cron.schedule(olmCronSchedule, async () => {
        this.filesToProcess = []
        try {
          console.log(`[${new Date().toISOString()}] 🎨 Starting scheduled PLC Vision Processing Job`)

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#olmProcessing',
            skey: 'schedule#start',
            origin: 'scheduler',
            type: 'system',
            data: 'SUCCESS: Started PLC Vision Processing Job'
          })

          console.log('Start PLC Vision Processing Success')

          this.appScheduleRunning = true
          await this.loggingService.writeMessage('olmProcessingStart', 'started')
          await this.processWithVision()
          await this.loggingService.writeMessage('olmProcessingComplete', 'success')

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#olmProcessing',
            skey: 'schedule#complete',
            origin: 'scheduler',
            type: 'system',
            data: 'SUCCESS: Completed PLC Vision Processing Job'
          })

          console.log(`[${new Date().toISOString()}] ✅ Completed scheduled PLC Vision Processing Job`)

        } catch (error) {
          console.error(`[${new Date().toISOString()}] ❌ PLC cron job failed:`, error.message)

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#olmProcessing',
            skey: 'schedule#error',
            origin: 'scheduler',
            type: 'system',
            data: `ERROR: ${error.message}`
          })

          this.appScheduleRunning = false
        }
      })

      console.log('✅ PLC cron job initialized successfully')
    } else {
      console.log('⏸️ PLC cron job disabled (PLC_CRON_ENABLED not set to true)')
    }
  }
}

// Create single instance
const plcController = new PlcController()

// Export controller function for routes
module.exports.Controller = { PlcController: plcController }
module.exports.controller = (app) => {
  console.log('🔍 Loading PLC controller routes...')

  // Status and configuration endpoints
  app.get('/v1/plc/status', (req, res) => plcController.getStatus(req, res))

  // Manual trigger endpoints
  app.get('/v1/plc/force-process', (req, res) => plcController.processWithVision(req, res))

  // Upload and process single file
  app.post('/v1/plc/upload-and-process-vision', upload.single('pdf'), (req, res) => {
    plcController.uploadAndProcessWithClaudeVision(req, res)
  })

  console.log('✅ PLC controller routes loaded successfully')
}
