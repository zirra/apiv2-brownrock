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

class OcdCbtController {
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

  // Main vision processing workflow - processes PDFs from counties
  async processWithVision(req, res) {
    const { execSync } = require('child_process')
    const jobIdService = require('../services/job-id.service')

    // Generate unique job ID for this processing run
    const jobId = jobIdService.generateJobId('OCD_CBT')
    console.log(`🆔 Generated Job ID for this run: ${jobId}`)

    // Track processing metrics
    const metrics = {
      totalFiles: 0,
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

        const response = await this.dataService.callForDataByCounty(county, 'CTB')

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
          const s3Key = `ocd-cbt-pdfs/${county}/${pdf.FileName}`

          if (pdf.FileSize <= this.config.maxFileSize) {
            metrics.totalFiles++
            let localPath = null
            let outputDir = null
            let resizedPdfPath = null

            try {
              this.filesToProcess.push(s3Key)

              // Download PDF with error handling
              console.log(`⬇️ Downloading ${pdf.FileName} locally for Vision processing...`)

              try {
                localPath = await this.pdfController.downloadPdfLocally(pdf.Url, pdf.FileName, county)
              } catch (downloadError) {
                metrics.downloadFailed++
                metrics.skippedFiles.push({ file: pdf.FileName, reason: 'Download failed', error: downloadError.message })
                console.error(`❌ Download failed for ${pdf.FileName}: ${downloadError.message}`)
                await this.loggingService.writeMessage('visionDownloadFailed', `${pdf.FileName}: ${downloadError.message}`)

                // Skip this file and continue to next
                console.log(`⏭️ Skipping ${pdf.FileName} due to download failure`)
                continue
              }

              // Validate downloaded file exists and is valid
              try {
                // Check file exists
                if (!fs.existsSync(localPath)) {
                  throw new Error('Downloaded file does not exist on disk')
                }

                const fileStats = fs.statSync(localPath)

                // Check file is not empty
                if (fileStats.size === 0) {
                  throw new Error('Downloaded file is empty (0 bytes)')
                }

                // Check minimum size (PDFs are typically > 1KB)
                if (fileStats.size < 1024) {
                  throw new Error(`File too small (${fileStats.size} bytes) - likely corrupt or error page`)
                }

                // Quick validation: Check if file starts with PDF header
                const fileBuffer = fs.readFileSync(localPath)
                const header = fileBuffer.toString('ascii', 0, 5)

                if (header !== '%PDF-') {
                  // Get more detailed preview
                  const textPreview = fileBuffer.toString('utf8', 0, Math.min(500, fileBuffer.length))
                  const hexPreview = fileBuffer.toString('hex', 0, Math.min(100, fileBuffer.length))

                  console.error(`\n🔍 FILE DIAGNOSTIC FOR ${pdf.FileName}:`)
                  console.error(`   File size: ${fileStats.size} bytes`)
                  console.error(`   Header (first 5 bytes): "${header}"`)
                  console.error(`   Hex dump (first 100 bytes): ${hexPreview}`)
                  console.error(`   Text preview (first 500 chars):\n${textPreview}`)

                  throw new Error(`Invalid PDF header: "${header}". File appears to be: ${this.detectFileType(fileBuffer)}`)
                }

                // Additional validation: Check PDF version
                const pdfVersion = fileBuffer.toString('ascii', 0, 8)
                console.log(`✅ PDF validation passed (${(fileStats.size / 1024).toFixed(1)} KB, ${pdfVersion})`)
              } catch (validationError) {
                metrics.validationFailed++
                metrics.skippedFiles.push({ file: pdf.FileName, reason: 'Validation failed', error: validationError.message })
                console.error(`❌ PDF validation failed for ${pdf.FileName}: ${validationError.message}`)
                await this.loggingService.writeMessage('visionValidationFailed', `${pdf.FileName}: ${validationError.message}`)

                // Clean up invalid file
                if (localPath && fs.existsSync(localPath)) {
                  try {
                    fs.unlinkSync(localPath)
                    console.log(`🗑️ Removed invalid file: ${localPath}`)
                  } catch (cleanupErr) {
                    console.warn(`⚠️ Could not remove invalid file: ${cleanupErr.message}`)
                  }
                }

                // Skip this file and continue to next
                console.log(`⏭️ Skipping ${pdf.FileName} due to validation failure`)
                continue
              }

              // Prepare temp directory for image output
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
                    documentType: 'ocd-cbt-contacts'
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
                    project_origin: 'CTB',
                    jobid: jobId
                  }))

                  // Save to PostgreSQL
                  if (enrichedContacts.length > 0 && this.postgresContactService) {
                    console.log(`💾 Saving ${enrichedContacts.length} contacts to PostgreSQL...`)
                    const insertResult = await this.postgresContactService.bulkInsertContacts(enrichedContacts)
                    if (insertResult.success) {
                      console.log(`✅ Saved ${insertResult.insertedCount} contacts to PostgreSQL`)
                      metrics.totalContacts += insertResult.insertedCount
                    }
                  }

                  metrics.successfullyProcessed++

                  // Upload original PDF to S3
                  console.log(`☁️ Uploading PDF to S3: ${s3Key}`)
                  await this.s3Service.uploadBufferToS3(pdfBuffer, s3Key)
                  console.log(`✅ Uploaded to S3`)

                  // Cleanup
                  if (!process.env.KEEP_LOCAL_FILES) {
                    if (localPath && fs.existsSync(localPath)) {
                      fs.unlinkSync(localPath)
                      console.log(`🗑️ Removed local file: ${localPath}`)
                    }
                    if (resizedPdfPath && fs.existsSync(resizedPdfPath)) {
                      fs.unlinkSync(resizedPdfPath)
                      console.log(`🗑️ Removed resized PDF: ${resizedPdfPath}`)
                    }
                  }

                  console.log(`📊 Native PDF fallback summary for ${pdf.FileName}:`)
                  console.log(`   - Method: claude-native-pdf-fallback (Ghostscript failed)`)
                  console.log(`   - Processing time: ${nativeTime}ms`)
                  console.log(`   - Contacts extracted: ${contacts.length}`)
                  console.log(`✅ Completed with fallback method: ${pdf.FileName}`)

                  // Skip the rest of the vision processing (images, etc.)
                  continue
                }
              }

              // Get list of generated images
              const imageFiles = fs.readdirSync(outputDir)
                .filter(file => file.endsWith('.png'))
                .sort()
                .map(file => path.join(outputDir, file))

              if (imageFiles.length === 0) {
                throw new Error('No images generated from PDF')
              }

              console.log(`📸 Generated ${imageFiles.length} images from PDF`)

              // Resize images to meet Claude's 2000px dimension limit
              console.log(`📐 Resizing images to meet Claude's dimension requirements...`)
              const resizedImageFiles = []

              for (const imagePath of imageFiles) {
                const resizedPath = imagePath.replace('.png', '_resized.png')

                // Check if magick (v7) is available
                let useV7 = false
                try {
                  execSync('magick --version', { stdio: 'pipe' })
                  useV7 = true
                } catch (e) {
                  // Fall back to convert (v6)
                }

                try {
                  let resizeCommand

                  if (useV7) {
                    // ImageMagick v7 syntax
                    resizeCommand = `magick "${imagePath}" -resize "1800x1800>" "${resizedPath}"`
                  } else {
                    // ImageMagick v6 syntax
                    resizeCommand = `convert "${imagePath}" -resize "1800x1800>" "${resizedPath}"`
                  }

                  execSync(resizeCommand, { stdio: 'pipe', shell: true })
                  resizedImageFiles.push(resizedPath)

                  const originalSize = fs.statSync(imagePath).size
                  const resizedSize = fs.statSync(resizedPath).size
                  console.log(`  ✓ ${path.basename(imagePath)}: ${(originalSize/1024).toFixed(0)}KB → ${(resizedSize/1024).toFixed(0)}KB`)
                } catch (resizeError) {
                  console.warn(`⚠️ Failed to resize ${path.basename(imagePath)}, using original: ${resizeError.message}`)
                  resizedImageFiles.push(imagePath)
                }
              }

              console.log(`✅ Resized ${resizedImageFiles.length} images`)

              // Send images to Claude for analysis
              console.log(`🤖 Sending images to Claude for analysis...`)
              const startClaudeTime = Date.now()

              const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
              const extractor = new ClaudeContactExtractor({
                anthropicApiKey: process.env.ANTHROPIC_API_KEY,
                awsRegion: process.env.AWS_REGION,
                awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
                awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                documentType: 'ocd-cbt-contacts'
              })

              // Convert resized images to base64 for Claude
              const imageData = resizedImageFiles.map(imagePath => {
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
                project_origin: 'CTB',
                jobid: jobId
              }))

              // Save to PostgreSQL
              if (enrichedContacts.length > 0 && this.postgresContactService) {
                console.log(`💾 Saving ${enrichedContacts.length} contacts to PostgreSQL...`)
                const insertResult = await this.postgresContactService.bulkInsertContacts(enrichedContacts)
                if (insertResult.success) {
                  console.log(`✅ Saved ${insertResult.insertedCount} contacts to PostgreSQL`)
                  metrics.totalContacts += insertResult.insertedCount
                }
              }

              metrics.successfullyProcessed++

              // Upload original PDF to S3
              const pdfBuffer = fs.readFileSync(localPath)
              console.log(`☁️ Uploading PDF to S3: ${s3Key}`)
              await this.s3Service.uploadBufferToS3(pdfBuffer, s3Key)
              console.log(`✅ Uploaded to S3`)

              // Cleanup local files
              if (!process.env.KEEP_LOCAL_FILES) {
                if (localPath && fs.existsSync(localPath)) {
                  fs.unlinkSync(localPath)
                  console.log(`🗑️ Removed local file: ${localPath}`)
                }
                if (resizedPdfPath && fs.existsSync(resizedPdfPath)) {
                  fs.unlinkSync(resizedPdfPath)
                  console.log(`🗑️ Removed resized PDF: ${resizedPdfPath}`)
                }
                // Clean up images
                if (outputDir && fs.existsSync(outputDir)) {
                  imageFiles.forEach(img => {
                    try {
                      if (fs.existsSync(img)) fs.unlinkSync(img)
                    } catch (e) {
                      console.warn(`Failed to delete ${img}: ${e.message}`)
                    }
                  })
                  resizedImageFiles.forEach(img => {
                    try {
                      if (fs.existsSync(img)) fs.unlinkSync(img)
                    } catch (e) {
                      console.warn(`Failed to delete ${img}: ${e.message}`)
                    }
                  })
                  try {
                    const remainingFiles = fs.readdirSync(outputDir)
                    remainingFiles.forEach(file => {
                      const filePath = path.join(outputDir, file)
                      try {
                        fs.unlinkSync(filePath)
                      } catch (e) {
                        console.warn(`Failed to delete ${filePath}: ${e.message}`)
                      }
                    })
                    fs.rmdirSync(outputDir)
                  } catch (e) {
                    console.warn(`Failed to remove directory ${outputDir}: ${e.message}`)
                  }
                }
              }

              console.log(`📊 Vision processing summary for ${pdf.FileName}:`)
              console.log(`   - Method: ghostscript-claude-vision`)
              console.log(`   - Images generated: ${imageFiles.length}`)
              console.log(`   - Processing time: ${gsTime + claudeTime}ms`)
              console.log(`   - Contacts extracted: ${contacts.length}`)

              console.log(`✅ Completed Vision processing: ${pdf.FileName}`)

            } catch (processErr) {
              metrics.processingFailed++
              metrics.skippedFiles.push({ file: pdf.FileName, reason: 'Processing failed', error: processErr.message })
              console.error(`❌ Vision processing failed for ${pdf.FileName}: ${processErr.message}`)
              await this.loggingService.writeMessage('visionProcessingFail', `${processErr.message} ${pdf.FileName}`)

              // Cleanup on error
              try {
                if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath)
                if (resizedPdfPath && fs.existsSync(resizedPdfPath)) fs.unlinkSync(resizedPdfPath)
                if (outputDir && fs.existsSync(outputDir)) {
                  const files = fs.readdirSync(outputDir)
                  files.forEach(file => {
                    try {
                      fs.unlinkSync(path.join(outputDir, file))
                    } catch (e) {
                      // Ignore cleanup errors
                    }
                  })
                  try {
                    fs.rmdirSync(outputDir)
                  } catch (e) {
                    // Ignore cleanup errors
                  }
                }
              } catch (cleanupErr) {
                console.error(`❌ Cleanup error: ${cleanupErr.message}`)
              }
            }

            // Add delay between files to avoid Claude rate limits
            if (i < allPdfs.length - 1) {
              console.log(`⏸️ Waiting 3 seconds before next file to avoid rate limits...`)
              await new Promise(resolve => setTimeout(resolve, 3000))
            }
          } else {
            console.log(`⚠️ ${pdf.FileName} skipping due to file size (${pdf.FileSize} bytes > ${this.config.maxFileSize} bytes)`)
          }
        }
      }

      this.appScheduleRunning = false

      // Print comprehensive summary
      console.log('\n═══════════════════════════════════════════════════════════')
      console.log('📊 OCD_CBT VISION PROCESSING JOB SUMMARY')
      console.log('═══════════════════════════════════════════════════════════')
      console.log(`Total files attempted:      ${metrics.totalFiles}`)
      console.log(`✅ Successfully processed:   ${metrics.successfullyProcessed}`)
      console.log(`❌ Download failed:          ${metrics.downloadFailed}`)
      console.log(`❌ Validation failed:        ${metrics.validationFailed}`)
      console.log(`❌ Processing failed:        ${metrics.processingFailed}`)
      console.log(`📇 Total contacts extracted: ${metrics.totalContacts}`)
      console.log('───────────────────────────────────────────────────────────')

      if (metrics.skippedFiles.length > 0) {
        console.log(`\n⚠️ SKIPPED FILES (${metrics.skippedFiles.length}):`)
        metrics.skippedFiles.forEach((skip, idx) => {
          console.log(`${idx + 1}. ${skip.file}`)
          console.log(`   Reason: ${skip.reason}`)
          console.log(`   Error: ${skip.error}`)
        })
      }

      console.log('═══════════════════════════════════════════════════════════\n')

      if (res) {
        return res.status(200).send({
          message: 'OCD_CBT Vision PDF processing completed.',
          method: 'ghostscript-claude-vision',
          metrics: {
            totalFiles: metrics.totalFiles,
            successfullyProcessed: metrics.successfullyProcessed,
            downloadFailed: metrics.downloadFailed,
            validationFailed: metrics.validationFailed,
            processingFailed: metrics.processingFailed,
            totalContacts: metrics.totalContacts,
            skippedFiles: metrics.skippedFiles
          }
        })
      }

      return true

    } catch (err) {
      console.error(`💥 Fatal error in processWithVision(): ${err.message}`)
      await this.loggingService.writeMessage('ocdCbtVisionFatal', err.message)

      if (res) {
        return res.status(500).send({ error: err.message })
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
      const county = req.body.county || 'manual-upload'

      // Generate unique job ID for this upload
      const jobId = jobIdService.generateJobId('OCD_CBT')
      console.log(`🆔 Generated Job ID for upload: ${jobId}`)

      console.log(`📤 Received upload for Vision processing: ${originalName} (${req.file.size} bytes)`)
      console.log(`📋 County: ${county}`)

      // S3 key for upload
      const s3Key = `ocd-cbt-pdfs/${county}/${originalName}`

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
        resizedPdfPath
      ].join(' ')

      execSync(gsCommand, { stdio: 'pipe' })
      const gsTime = Date.now() - startGsTime

      console.log(`✅ Ghostscript image conversion completed in ${gsTime}ms`)

      // Get list of generated images
      const imageFiles = fs.readdirSync(outputDir)
        .filter(file => file.endsWith('.png'))
        .sort()
        .map(file => path.join(outputDir, file))

      if (imageFiles.length === 0) {
        throw new Error('No images generated from PDF')
      }

      console.log(`📸 Generated ${imageFiles.length} images from PDF`)

      // Resize images to meet Claude's 2000px dimension limit
      console.log(`📐 Resizing images to meet Claude's dimension requirements...`)
      const resizedImageFiles = []

      for (const imagePath of imageFiles) {
        const resizedPath = imagePath.replace('.png', '_resized.png')

        // Check if magick (v7) is available
        let useV7 = false
        try {
          execSync('magick --version', { stdio: 'pipe' })
          useV7 = true
        } catch (e) {
          // Fall back to convert (v6)
        }

        try {
          let resizeCommand

          if (useV7) {
            // ImageMagick v7 syntax
            resizeCommand = `magick "${imagePath}" -resize "1800x1800>" "${resizedPath}"`
          } else {
            // ImageMagick v6 syntax
            resizeCommand = `convert "${imagePath}" -resize "1800x1800>" "${resizedPath}"`
          }

          execSync(resizeCommand, { stdio: 'pipe', shell: true })
          resizedImageFiles.push(resizedPath)

          const originalSize = fs.statSync(imagePath).size
          const resizedSize = fs.statSync(resizedPath).size
          console.log(`  ✓ ${path.basename(imagePath)}: ${(originalSize/1024).toFixed(0)}KB → ${(resizedSize/1024).toFixed(0)}KB`)
        } catch (resizeError) {
          console.warn(`⚠️ Failed to resize ${path.basename(imagePath)}, using original: ${resizeError.message}`)
          resizedImageFiles.push(imagePath)
        }
      }

      console.log(`✅ Resized ${resizedImageFiles.length} images`)

      // Send images to Claude for analysis
      console.log(`🤖 Sending images to Claude for analysis...`)
      const startClaudeTime = Date.now()

      const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
      const extractor = new ClaudeContactExtractor({
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        awsRegion: process.env.AWS_REGION,
        awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        documentType: 'ocd-cbt-contacts'
      })

      // Convert resized images to base64 for Claude
      const imageData = resizedImageFiles.map(imagePath => {
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
        record_type: county,
        extraction_method: 'ghostscript-claude-vision',
        project_origin: 'CTB',
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
      const pdfBuffer = fs.readFileSync(uploadedFilePath)
      console.log(`☁️ Uploading PDF to S3: ${s3Key}`)
      await this.s3Service.uploadBufferToS3(pdfBuffer, s3Key)
      console.log(`✅ Uploaded to S3`)

      // Cleanup local files
      if (!process.env.KEEP_LOCAL_FILES) {
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
          fs.unlinkSync(uploadedFilePath)
          console.log(`🗑️ Removed uploaded file: ${uploadedFilePath}`)
        }
        if (resizedPdfPath && fs.existsSync(resizedPdfPath)) {
          fs.unlinkSync(resizedPdfPath)
          console.log(`🗑️ Removed resized PDF: ${resizedPdfPath}`)
        }
        // Clean up images
        if (outputDir && fs.existsSync(outputDir)) {
          imageFiles.forEach(img => {
            try {
              if (fs.existsSync(img)) fs.unlinkSync(img)
            } catch (e) {
              console.warn(`Failed to delete ${img}: ${e.message}`)
            }
          })
          resizedImageFiles.forEach(img => {
            try {
              if (fs.existsSync(img)) fs.unlinkSync(img)
            } catch (e) {
              console.warn(`Failed to delete ${img}: ${e.message}`)
            }
          })
          try {
            const remainingFiles = fs.readdirSync(outputDir)
            remainingFiles.forEach(file => {
              const filePath = path.join(outputDir, file)
              try {
                fs.unlinkSync(filePath)
              } catch (e) {
                console.warn(`Failed to delete ${filePath}: ${e.message}`)
              }
            })
            fs.rmdirSync(outputDir)
          } catch (e) {
            console.warn(`Failed to remove directory ${outputDir}: ${e.message}`)
          }
        }
      }

      const result = {
        success: true,
        file: originalName,
        method: 'ghostscript-claude-vision',
        imagesGenerated: imageFiles.length,
        resolution: `${resolution} DPI`,
        gsTime: gsTime,
        claudeTime: claudeTime,
        contactCount: contacts.length,
        contacts: contacts,
        s3Key: s3Key,
        processingTimestamp: new Date().toISOString()
      }
      /*
      const result = {
        success: true,
        file: originalName,
        county: county,
        s3Key: s3Key,
        processing: {
          method: 'ghostscript-claude-vision',
          imagesGenerated: imageFiles.length,
          processingTime: `${((gsTime + claudeTime) / 1000).toFixed(1)}s`,
          pdfSizeKB: (pdfBuffer.length / 1024).toFixed(1)
        },
        contacts: {
          count: enrichedContacts.length,
          contacts: enrichedContacts
        },
        timestamp: new Date().toISOString()
      }
      */

      return res.status(200).json(result)

    } catch (error) {
      console.error(`❌ Vision processing failed: ${error.message}`)
      console.error(error.stack)

      // Cleanup on error
      try {
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
          fs.unlinkSync(uploadedFilePath)
        }
        if (resizedPdfPath && fs.existsSync(resizedPdfPath)) {
          fs.unlinkSync(resizedPdfPath)
        }
        if (outputDir && fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir)
          files.forEach(file => {
            try {
              fs.unlinkSync(path.join(outputDir, file))
            } catch (e) {
              // Ignore cleanup errors
            }
          })
          try {
            fs.rmdirSync(outputDir)
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      } catch (cleanupErr) {
        console.error(`❌ Cleanup error: ${cleanupErr.message}`)
      }

      return res.status(500).json({
        success: false,
        message: `Vision processing failed: ${error.message}`,
        error: error.stack
      })
    }
  }

  // Cron job initialization
  initializeCronJob() {
    const ocdCbtCronEnabled = process.env.OCD_CBT_CRON_ENABLED === 'true'
    const ocdCbtCronSchedule = process.env.OCD_CBT_CRON_SCHEDULE || '59 23 * * 3' // Wednesdays at 11:59 PM

    if (ocdCbtCronEnabled) {
      console.log(`📅 Initializing OCD_CBT cron job: ${ocdCbtCronSchedule}`)
      cron.schedule(ocdCbtCronSchedule, async () => {
        this.filesToProcess = []
        try {
          console.log(`[${new Date().toISOString()}] 🎨 Starting scheduled OCD_CBT Vision Processing Job`)

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#ocdCbtProcessing',
            skey: 'schedule#start',
            origin: 'scheduler',
            type: 'system',
            data: 'SUCCESS: Started OCD_CBT Vision Processing Job'
          })

          console.log('Start OCD_CBT Vision Processing Success')

          this.appScheduleRunning = true
          await this.loggingService.writeMessage('ocdCbtProcessingStart', 'started')
          await this.processWithVision()
          await this.loggingService.writeMessage('ocdCbtProcessingComplete', 'success')

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#ocdCbtProcessing',
            skey: 'schedule#complete',
            origin: 'scheduler',
            type: 'system',
            data: `SUCCESS: OCD_CBT Vision Processing Complete - ${this.filesToProcess.length} files processed`
          })

          console.log('Completed OCD_CBT Vision Processing Success')
          console.log('-----------------------------------')
          console.log('✅ All PDFs processed with Claude Vision (Ghostscript + Image Analysis)')
          console.log('💾 Contacts already saved to PostgreSQL during processing')
          console.log('-----------------------------------')

          console.log('OCD_CBT vision processing job complete')
          this.appScheduleRunning = false
        } catch (e) {
          console.log('----------- OCD_CBT Vision Processing Failure ---------------')
          console.log(e)
          await this.loggingService.writeMessage('ocdCbtScheduleFailed', e.message)

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#ocdCbtProcessing',
            skey: 'error#failed',
            origin: 'scheduler',
            type: 'system',
            data: `FAILURE: ${e.message}`
          })
          console.log('----------- OCD_CBT Vision Processing Failure ---------------')
          this.appScheduleRunning = false
        }
      })
    } else {
      console.log('⏸️ OCD_CBT cron job is disabled (set OCD_CBT_CRON_ENABLED=true to enable)')
    }
  }
}

// Create single instance
const ocdCbtController = new OcdCbtController()

// Export both the Controller class and controller function for routes
module.exports.Controller = { OcdCbtController: ocdCbtController }
module.exports.upload = upload
module.exports.controller = (app) => {
  console.log('🔧 Loading OCD_CBT controller routes...')

  // Core workflow routes
  app.get('/v1/ocd-cbt/status', (req, res) => ocdCbtController.getStatus(req, res))
  app.get('/v1/ocd-cbt/force-process', (req, res) => ocdCbtController.processWithVision(req, res))

  // Single file upload endpoint - uses multer middleware
  app.post('/v1/ocd-cbt/upload-and-process-vision', upload.single('pdf'), (req, res) => ocdCbtController.uploadAndProcessWithClaudeVision(req, res))

  console.log('✅ OCD_CBT controller routes loaded successfully')
}
