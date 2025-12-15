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
const PDFService = require('../services/pdf.service.js')
const PostgresContactService = require('../services/postgres-contact.service.js')

// Import other controllers
const { Controller: PdfControllerModule } = require('./pdf.controller.js')
const { Controller: ContactControllerModule } = require('./contact.controller.js')
const { Controller: S3AnalysisControllerModule } = require('./s3-analysis.controller.js')

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

class EmnrdController {
  constructor() {
    // Initialize services
    this.loggingService = new LoggingService()
    this.authService = new AuthService()
    this.s3Service = new S3Service(this.authService, this.loggingService)
    this.dataService = new DataService(this.authService, this.loggingService)
    this.pdfService = new PDFService(this.authService, this.s3Service, this.loggingService)

    // Reference to other controllers
    this.pdfController = PdfControllerModule.PdfController
    this.contactController = ContactControllerModule.ContactController
    this.s3AnalysisController = S3AnalysisControllerModule.S3AnalysisController
    this.postgresContactService = new PostgresContactService()

    // State
    this.filesToProcess = []
    this.appScheduleRunning = false

    // Configuration for local processing
    this.config = {
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 500000,
      processLocally: process.env.PROCESS_LOCALLY === 'true',
      useHybridPdf: process.env.USE_HYBRID_PDF === 'true', // Hybrid: Textract tables + Claude vision
      useNativePdf: process.env.USE_NATIVE_PDF === 'true', // Use Claude native PDF vision
    }

    // Initialize cron job
    this.initializeCronJob()
  }

  // Main workflow - processes PDFs from applicants
  async test(req, res) {
    const jobIdService = require('../services/job-id.service')

    try {
      this.appScheduleRunning = true

      // Generate unique job ID for this processing run
      const jobId = jobIdService.generateJobId('OCD_IMAGING')
      console.log(`🆔 Generated Job ID for this run: ${jobId}`)

      const applicantNames = this.dataService.getApplicantNames()

      for (let j = 0; j < applicantNames.length; j++) {
        const applicant = applicantNames[j]
        console.log(`🔍 Processing applicant: ${applicant}`)

        if (!this.authService.getToken()) {
          await this.authService.login()
        }

        const response = await this.dataService.callForData(applicant)

        if (!response || !response.data || !Array.isArray(response.data.Items)) {
          console.warn(`⚠️ No valid data returned for applicant "${applicant}". Skipping...`)
          await this.loggingService.writeMessage('missingItems', `No Items for ${applicant}`)
          continue
        }

        const items = response.data.Items
        console.log(`✅ Retrieved ${items.length} items for ${applicant}`)

        // Keep track of which PDF belongs to which item (for App/Order/Case numbers)
        const allPdfs = items.flatMap(item =>
          (item.ImagingFiles || []).map(pdf => ({
            ...pdf,
            AppNumber: item.ApplicationNo || null,
            OrderNumber: item.OrderNo || null,
            CaseNumber: item.AdminOrderNo || null  // Using AdminOrderNo as case number
          }))
        )

        if (!allPdfs.length) {
          console.log(`📭 No ImagingFiles found for "${applicant}".`)
          continue
        }

        for (let i = 0; i < allPdfs.length; i++) {
          const pdf = allPdfs[i]
          const s3Key = `pdfs/${applicant}/${pdf.FileName}`

          if (pdf.FileSize <= this.config.maxFileSize) {
            try {
              this.filesToProcess.push(s3Key)

              if (this.config.processLocally) {
                console.log(`⬇️ Downloading ${pdf.FileName} locally for processing...`)
                const localPath = await this.pdfController.downloadPdfLocally(pdf.Url, pdf.FileName, applicant)

                // Choose processing method based on configuration
                if (this.config.useHybridPdf) {
                  // Hybrid PDF processing: Textract tables + Claude vision
                  console.log(`🔀 Using hybrid PDF processing (Textract + Claude) for ${pdf.FileName}`)

                  const pdfBuffer = fs.readFileSync(localPath)
                  const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
                  const extractor = new ClaudeContactExtractor({
                    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
                    awsRegion: process.env.AWS_REGION,
                    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                  })

                  const startTime = Date.now()
                  const contacts = await extractor.extractContactsFromPDFHybrid(pdfBuffer, pdf.FileName)
                  const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)

                  console.log(`✅ Hybrid PDF processing complete in ${processingTime}s: ${contacts.length} contacts`)

                  // Add metadata to contacts
                  const enrichedContacts = contacts.map(c => ({
                    ...c,
                    source_file: pdf.FileName,
                    record_type: applicant,
                    extraction_method: 'hybrid-textract-claude',
                    project_origin: 'OCD_IMAGING',
                    jobid: jobId,
                    app_number: pdf.AppNumber,
                    order_number: pdf.OrderNumber,
                    case_number: pdf.CaseNumber
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
                  await this.s3Service.uploadBufferToS3(pdfBuffer, s3Key)
                  console.log(`✅ Uploaded to S3`)

                  // Cleanup
                  if (!process.env.KEEP_LOCAL_FILES) {
                    await this.pdfController.cleanupLocalFile(localPath)
                  }

                  console.log(`📊 Processing summary for ${pdf.FileName}:`)
                  console.log(`   - Method: hybrid-textract-claude-vision`)
                  console.log(`   - Processing time: ${processingTime}s`)
                  console.log(`   - Contacts extracted: ${contacts.length}`)

                } else if (this.config.useNativePdf) {
                  // Native PDF processing with Claude vision
                  console.log(`📄 Using Claude native PDF vision for ${pdf.FileName}`)

                  const pdfBuffer = fs.readFileSync(localPath)
                  const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
                  const extractor = new ClaudeContactExtractor({
                    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
                    awsRegion: process.env.AWS_REGION,
                    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                  })

                  const startTime = Date.now()
                  const contacts = await extractor.extractContactsFromPDFNative(pdfBuffer, pdf.FileName)
                  const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)

                  console.log(`✅ Claude native PDF processing complete in ${processingTime}s: ${contacts.length} contacts`)

                  // Add metadata to contacts
                  const enrichedContacts = contacts.map(c => ({
                    ...c,
                    source_file: pdf.FileName,
                    record_type: applicant,
                    extraction_method: 'hybrid-textract-claude',
                    project_origin: 'OCD_IMAGING',
                    jobid: jobId,
                    app_number: pdf.AppNumber,
                    order_number: pdf.OrderNumber,
                    case_number: pdf.CaseNumber
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
                  await this.s3Service.uploadBufferToS3(pdfBuffer, s3Key)
                  console.log(`✅ Uploaded to S3`)

                  // Cleanup
                  if (!process.env.KEEP_LOCAL_FILES) {
                    await this.pdfController.cleanupLocalFile(localPath)
                  }

                  console.log(`📊 Processing summary for ${pdf.FileName}:`)
                  console.log(`   - Method: claude-native-pdf-vision`)
                  console.log(`   - Processing time: ${processingTime}s`)
                  console.log(`   - Contacts extracted: ${contacts.length}`)

                } else {
                  // Traditional Ghostscript + Textract processing
                  const processingResult = this.pdfController.config.smartProcessing ?
                    await this.pdfController.smartOptimizeAndExtract(localPath, s3Key) :
                    await this.pdfController.optimizeAndExtractText(localPath, s3Key)

                  // Upload to S3 only if not already uploaded by Textract
                  if (!processingResult.uploadedToS3) {
                    console.log(`☁️ Uploading processed ${pdf.FileName} to S3...`)
                    await this.pdfController.uploadOptimizedToS3(processingResult.optimizedPath, s3Key)
                  } else {
                    console.log(`✅ ${pdf.FileName} already uploaded to S3 by Textract`)
                  }

                  console.log(`📊 Processing summary for ${pdf.FileName}:`)
                  console.log(`   - Optimization: ${processingResult.wasOptimized ? 'Yes' : 'No'}`)
                  console.log(`   - Text extracted: ${processingResult.textLength} characters`)
                  console.log(`   - Method: ${processingResult.method}`)
                  console.log(`   - Steps: ${processingResult.processingSteps.join(' → ')}`)

                  if (!process.env.KEEP_LOCAL_FILES) {
                    await this.pdfController.cleanupLocalFile(localPath)
                    if (processingResult.optimizedPath !== localPath) {
                      await this.pdfController.cleanupLocalFile(processingResult.optimizedPath)
                    }
                    if (processingResult.textPath) {
                      await this.pdfController.cleanupLocalFile(processingResult.textPath)
                    }
                  }

                  this.pdfController.processingResults = this.pdfController.processingResults || []
                  this.pdfController.processingResults.push({
                    filename: pdf.FileName,
                    applicant: applicant,
                    s3Key: s3Key,
                    ...processingResult
                  })
                }

                console.log(`✅ Locally processed and uploaded: ${pdf.FileName}`)
              } else {
                console.log(`⬇️ Uploading ${pdf.FileName} directly to S3...`)
                await this.s3Service.uploadToS3(pdf.Url, s3Key)
                console.log(`✅ Directly uploaded: ${pdf.FileName}`)
              }

            } catch (processErr) {
              console.error(`❌ Processing failed for ${pdf.FileName}: ${processErr.message}`)
              await this.loggingService.writeMessage('processingFail', `${processErr.message} ${pdf.FileName}`)
            }

            // Add small delay between files to avoid Claude rate limits
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

      if (res) {
        return res.status(200).send({
          message: 'PDF processing completed successfully.',
          processedLocally: this.config.processLocally,
          ghostscriptEnabled: this.pdfController.config.useGhostscript,
          smartProcessing: this.pdfController.config.smartProcessing,
          filesProcessed: this.filesToProcess.length
        })
      }

      return true

    } catch (err) {
      console.error(`💥 Fatal error in test(): ${err.message}`)
      await this.loggingService.writeMessage('testFatal', err.message)

      if (res) {
        return res.status(500).send({ error: err.message })
      }

      return false
    }
  }

  // Vision-based processing workflow - processes PDFs with Claude Vision (converts to images)
  async testWithVision(req, res) {
    const { execSync } = require('child_process')
    const jobIdService = require('../services/job-id.service')

    // Generate unique job ID for this processing run
    const jobId = jobIdService.generateJobId('OCD_IMAGING')
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
      const applicantNames = this.dataService.getApplicantNames()

      for (let j = 0; j < applicantNames.length; j++) {
        const applicant = applicantNames[j]
        console.log(`🔍 Processing applicant with Vision: ${applicant}`)

        if (!this.authService.getToken()) {
          await this.authService.login()
        }

        const response = await this.dataService.callForData(applicant)

        if (!response || !response.data || !Array.isArray(response.data.Items)) {
          console.warn(`⚠️ No valid data returned for applicant "${applicant}". Skipping...`)
          await this.loggingService.writeMessage('missingItems', `No Items for ${applicant}`)
          continue
        }

        const items = response.data.Items
        console.log(`✅ Retrieved ${items.length} items for ${applicant}`)

        // Keep track of which PDF belongs to which item (for App/Order/Case numbers)
        const allPdfs = items.flatMap(item =>
          (item.ImagingFiles || []).map(pdf => ({
            ...pdf,
            AppNumber: item.ApplicationNo || null,
            OrderNumber: item.OrderNo || null,
            CaseNumber: item.AdminOrderNo || null  // Using AdminOrderNo as case number
          }))
        )

        if (!allPdfs.length) {
          console.log(`📭 No ImagingFiles found for "${applicant}".`)
          continue
        }

        for (let i = 0; i < allPdfs.length; i++) {
          const pdf = allPdfs[i]
          const s3Key = `vision-pdfs/${applicant}/${pdf.FileName}`

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
                localPath = await this.pdfController.downloadPdfLocally(pdf.Url, pdf.FileName, applicant)
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
                    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                  })

                  const startNativeTime = Date.now()
                  const contacts = await extractor.extractContactsFromPDFNative(pdfBuffer, pdf.FileName)
                  const nativeTime = Date.now() - startNativeTime

                  console.log(`✅ Claude Native PDF processing succeeded in ${nativeTime}ms: ${contacts.length} contacts`)

                  // Add metadata to contacts
                  const enrichedContacts = contacts.map(c => ({
                    ...c,
                    source_file: pdf.FileName,
                    record_type: applicant,
                    extraction_method: 'claude-native-pdf-fallback',
                    project_origin: 'OCD_IMAGING',
                    jobid: jobId,
                    app_number: pdf.AppNumber,
                    order_number: pdf.OrderNumber,
                    case_number: pdf.CaseNumber
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
                awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
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
                record_type: applicant,
                extraction_method: 'ghostscript-claude-vision',
                project_origin: 'OCD_IMAGING',
                jobid: jobId,
                app_number: pdf.AppNumber,
                order_number: pdf.OrderNumber,
                case_number: pdf.CaseNumber
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
      console.log('📊 VISION PROCESSING JOB SUMMARY')
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
          message: 'Vision PDF processing completed.',
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
      console.error(`💥 Fatal error in testWithVision(): ${err.message}`)
      await this.loggingService.writeMessage('testWithVisionFatal', err.message)

      if (res) {
        return res.status(500).send({ error: err.message })
      }

      return false
    }
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
      s3AnalysisRunning: this.s3AnalysisController.isRunning()
    })
  }

  async debugMethods(_req, res) {
    try {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(this))
      res.status(200).json({
        success: true,
        availableMethods: methods
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }

  /**
   * Upload and process a single PDF with Claude's native PDF vision (no OCR/Textract)
   * Accepts multipart/form-data file upload
   */
  async uploadAndProcessNative(req, res) {
    let uploadedFilePath = null
    const jobIdService = require('../services/job-id.service')

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
      const applicantName = req.body.applicant || 'manual-upload'
      const documentType = req.body.documentType || 'oil-gas-contacts'
      const appNumber = req.body.appNumber || req.body.app_number || null
      const orderNumber = req.body.orderNumber || req.body.order_number || null
      const caseNumber = req.body.caseNumber || req.body.case_number || null

      // Generate unique job ID for this upload
      const jobId = jobIdService.generateJobId('OCD_IMAGING')
      console.log(`🆔 Generated Job ID for upload: ${jobId}`)

      console.log(`📤 Received upload for native PDF processing: ${originalName} (${req.file.size} bytes)`)
      console.log(`📋 Applicant: ${applicantName}`)
      console.log(`📄 Document Type: ${documentType}`)
      if (appNumber) console.log(`📄 App Number: ${appNumber}`)
      if (orderNumber) console.log(`📄 Order Number: ${orderNumber}`)
      if (caseNumber) console.log(`📄 Case Number: ${caseNumber}`)

      // Read PDF buffer
      const pdfBuffer = fs.readFileSync(uploadedFilePath)

      // S3 key for upload
      const s3Key = `pdfs/${applicantName}/${originalName}`

      // Process with Claude's native PDF vision
      console.log(`🔄 Processing with Claude native PDF vision...`)
      const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
      const extractor = new ClaudeContactExtractor({
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        awsRegion: process.env.AWS_REGION,
        awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        documentType: documentType  // Use specified document type
      })

      const startTime = Date.now()
      const contacts = await extractor.extractContactsFromPDFNative(pdfBuffer, originalName)
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)

      console.log(`✅ Claude native PDF processing complete in ${processingTime}s: ${contacts.length} contacts`)

      // Add metadata to contacts
      const enrichedContacts = contacts.map(c => ({
        ...c,
        source_file: originalName,
        record_type: applicantName,
        project_origin: 'OCD_IMAGING',
        jobid: jobId,
        app_number: appNumber,
        order_number: orderNumber,
        case_number: caseNumber
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
      await this.s3Service.uploadBufferToS3(pdfBuffer, s3Key)
      console.log(`✅ Uploaded to S3`)

      // Cleanup local file
      if (!process.env.KEEP_LOCAL_FILES && fs.existsSync(uploadedFilePath)) {
        fs.unlinkSync(uploadedFilePath)
        console.log(`🗑️ Removed local file: ${uploadedFilePath}`)
      }

      const result = {
        success: true,
        file: originalName,
        applicant: applicantName,
        s3Key: s3Key,
        processing: {
          method: 'claude-native-pdf-vision',
          processingTime: `${processingTime}s`,
          pdfSizeKB: (pdfBuffer.length / 1024).toFixed(1)
        },
        contacts: {
          count: enrichedContacts.length,
          contacts: enrichedContacts
        },
        timestamp: new Date().toISOString()
      }

      return res.status(200).json(result)

    } catch (error) {
      console.error(`❌ Native PDF processing failed: ${error.message}`)
      console.error(error.stack)

      // Cleanup on error
      try {
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
          fs.unlinkSync(uploadedFilePath)
        }
      } catch (cleanupErr) {
        console.error(`❌ Cleanup error: ${cleanupErr.message}`)
      }

      return res.status(500).json({
        success: false,
        message: `Native PDF processing failed: ${error.message}`,
        error: error.stack
      })
    }
  }

  /**
   * Upload and process a single PDF with hybrid mode (Textract tables + Claude vision)
   * Accepts multipart/form-data file upload
   */
  async uploadAndProcessHybrid(req, res) {
    let uploadedFilePath = null
    const jobIdService = require('../services/job-id.service')

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
      const applicantName = req.body.applicant || 'manual-upload'
      const documentType = req.body.documentType || 'oil-gas-contacts'
      const appNumber = req.body.appNumber || req.body.app_number || null
      const orderNumber = req.body.orderNumber || req.body.order_number || null
      const caseNumber = req.body.caseNumber || req.body.case_number || null

      // Generate unique job ID for this upload
      const jobId = jobIdService.generateJobId('OCD_IMAGING')
      console.log(`🆔 Generated Job ID for upload: ${jobId}`)

      console.log(`📤 Received upload for hybrid PDF processing: ${originalName} (${req.file.size} bytes)`)
      console.log(`📋 Applicant: ${applicantName}`)
      console.log(`📄 Document Type: ${documentType}`)
      if (appNumber) console.log(`📄 App Number: ${appNumber}`)
      if (orderNumber) console.log(`📄 Order Number: ${orderNumber}`)
      if (caseNumber) console.log(`📄 Case Number: ${caseNumber}`)

      // Read PDF buffer
      const pdfBuffer = fs.readFileSync(uploadedFilePath)

      // S3 key for upload
      const s3Key = `pdfs/${applicantName}/${originalName}`

      // Process with hybrid mode (Textract + Claude)
      console.log(`🔀 Processing with hybrid mode (Textract tables + Claude vision)...`)
      const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
      const extractor = new ClaudeContactExtractor({
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        awsRegion: process.env.AWS_REGION,
        awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        documentType: documentType  // Use specified document type
      })

      const startTime = Date.now()
      const contacts = await extractor.extractContactsFromPDFHybrid(pdfBuffer, originalName)
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)

      console.log(`✅ Hybrid PDF processing complete in ${processingTime}s: ${contacts.length} contacts`)

      // Add metadata to contacts
      const enrichedContacts = contacts.map(c => ({
        ...c,
        source_file: originalName,
        record_type: applicantName,
        project_origin: 'OCD_IMAGING',
        jobid: jobId,
        app_number: appNumber,
        order_number: orderNumber,
        case_number: caseNumber
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
      await this.s3Service.uploadBufferToS3(pdfBuffer, s3Key)
      console.log(`✅ Uploaded to S3`)

      // Cleanup local file
      if (!process.env.KEEP_LOCAL_FILES && fs.existsSync(uploadedFilePath)) {
        fs.unlinkSync(uploadedFilePath)
        console.log(`🗑️ Removed local file: ${uploadedFilePath}`)
      }

      const result = {
        success: true,
        file: originalName,
        applicant: applicantName,
        s3Key: s3Key,
        processing: {
          method: 'hybrid-textract-claude-vision',
          processingTime: `${processingTime}s`,
          pdfSizeKB: (pdfBuffer.length / 1024).toFixed(1),
          pdfSizeMB: (pdfBuffer.length / 1024 / 1024).toFixed(2)
        },
        contacts: {
          count: enrichedContacts.length,
          contacts: enrichedContacts
        },
        timestamp: new Date().toISOString()
      }

      return res.status(200).json(result)

    } catch (error) {
      console.error(`❌ Hybrid PDF processing failed: ${error.message}`)
      console.error(error.stack)

      // Cleanup on error
      try {
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
          fs.unlinkSync(uploadedFilePath)
        }
      } catch (cleanupErr) {
        console.error(`❌ Cleanup error: ${cleanupErr.message}`)
      }

      return res.status(500).json({
        success: false,
        message: `Hybrid PDF processing failed: ${error.message}`,
        error: error.stack
      })
    }
  }

  /**
   * Upload and process a single PDF with Ghostscript + Textract + Claude
   * Accepts multipart/form-data file upload
   */
  async uploadAndProcess(req, res) {
    let uploadedFilePath = null
    let localPath = null
    let optimizedPath = null

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
      const applicantName = req.body.applicant || 'manual-upload'

      console.log(`📤 Received upload: ${originalName} (${req.file.size} bytes)`)
      console.log(`📋 Applicant: ${applicantName}`)

      // Create local directory for processing
      const localDir = path.join(process.env.LOCAL_PDF_PATH || './downloads/pdfs', applicantName)
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true })
      }

      localPath = path.join(localDir, originalName)

      // Move uploaded file to processing directory
      fs.renameSync(uploadedFilePath, localPath)
      console.log(`📁 File moved to: ${localPath}`)

      // S3 key for upload
      const s3Key = `pdfs/${applicantName}/${originalName}`

      // Process with smart optimization and text extraction
      console.log(`🔄 Processing with Ghostscript + Textract + Claude...`)
      const processingResult = this.pdfController.config.smartProcessing
        ? await this.pdfController.smartOptimizeAndExtract(localPath, s3Key)
        : await this.pdfController.optimizeAndExtractText(localPath, s3Key)

      optimizedPath = processingResult.optimizedPath

      console.log(`📊 Processing summary:`)
      console.log(`   - Optimization: ${processingResult.wasOptimized ? 'Yes' : 'No'}`)
      console.log(`   - Text extracted: ${processingResult.textLength} characters`)
      console.log(`   - Method: ${processingResult.method}`)
      console.log(`   - Steps: ${processingResult.processingSteps.join(' → ')}`)

      // Upload to S3 if not already uploaded by Textract
      if (!processingResult.uploadedToS3) {
        console.log(`☁️ Uploading processed PDF to S3: ${s3Key}`)
        await this.pdfController.uploadOptimizedToS3(optimizedPath, s3Key)
        console.log(`✅ Uploaded to S3`)
      } else {
        console.log(`✅ Already uploaded to S3 by Textract`)
      }

      // Extract contacts from the extracted text using Claude
      let contacts = []
      if (processingResult.extractedText && processingResult.extractedText.length > 100) {
        console.log(`🤖 Extracting contacts with Claude AI...`)

        // Use ClaudeContactExtractor directly
        const ClaudeContactExtractor = require('../services/ClaudeContactExtractor.cjs')
        const extractor = new ClaudeContactExtractor({
          anthropicApiKey: process.env.ANTHROPIC_API_KEY,
          awsRegion: process.env.AWS_REGION,
          awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
          awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        })

        const extractedContacts = await extractor.extractContactInfoWithClaude(processingResult.extractedText)

        if (extractedContacts && extractedContacts.length > 0) {
          contacts = extractedContacts.map(c => ({
            ...c,
            source_file: originalName,
            record_type: applicantName
          }))
          console.log(`✅ Claude extracted ${contacts.length} contacts`)

          // Save to PostgreSQL
          if (contacts.length > 0) {
            console.log(`💾 Saving ${contacts.length} contacts to PostgreSQL...`)
            const insertResult = await this.postgresContactService.bulkInsertContacts(contacts)

            if (insertResult.success) {
              console.log(`✅ Saved ${insertResult.insertedCount} contacts to PostgreSQL`)
            }
          }
        }
      }

      // Cleanup local files (unless KEEP_LOCAL_FILES is set)
      if (!process.env.KEEP_LOCAL_FILES) {
        if (localPath && fs.existsSync(localPath)) {
          fs.unlinkSync(localPath)
          console.log(`🗑️ Removed local file: ${localPath}`)
        }
        if (optimizedPath && optimizedPath !== localPath && fs.existsSync(optimizedPath)) {
          fs.unlinkSync(optimizedPath)
          console.log(`🗑️ Removed optimized file: ${optimizedPath}`)
        }
        if (processingResult.textPath && fs.existsSync(processingResult.textPath)) {
          fs.unlinkSync(processingResult.textPath)
          console.log(`🗑️ Removed text file: ${processingResult.textPath}`)
        }
      }

      const result = {
        success: true,
        file: originalName,
        applicant: applicantName,
        s3Key: s3Key,
        processing: {
          wasOptimized: processingResult.wasOptimized,
          method: processingResult.method,
          steps: processingResult.processingSteps,
          textLength: processingResult.textLength,
          extractedTextPreview: processingResult.extractedText?.substring(0, 500) +
            (processingResult.extractedText?.length > 500 ? '...' : '')
        },
        contacts: {
          count: contacts.length,
          contacts: contacts
        },
        timestamp: new Date().toISOString()
      }

      return res.status(200).json(result)

    } catch (error) {
      console.error(`❌ Upload processing failed: ${error.message}`)
      console.error(error.stack)

      // Cleanup on error
      try {
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
          fs.unlinkSync(uploadedFilePath)
        }
        if (localPath && fs.existsSync(localPath)) {
          fs.unlinkSync(localPath)
        }
        if (optimizedPath && fs.existsSync(optimizedPath)) {
          fs.unlinkSync(optimizedPath)
        }
      } catch (cleanupErr) {
        console.error(`❌ Cleanup error: ${cleanupErr.message}`)
      }

      return res.status(500).json({
        success: false,
        message: `Processing failed: ${error.message}`,
        error: error.stack
      })
    }
  }

  // Main processing workflow
  async processFilesInBucket() {
    this.filesToProcess = []
    try {
      console.log(`[${new Date().toISOString()}] Good morning! Running Process Files`)
      console.log('-----------------------------------')
      console.log('process files')

      console.log('-----------------------------------')
      console.log('🤖 Starting Claude contact extraction...')

      const contactExtractionResult = await this.pdfService.processContactsFromPdfs(this.filesToProcess)

      if (contactExtractionResult.success) {
        console.log('✅ Claude contact extraction completed successfully!')
        console.log(`📊 Extracted ${contactExtractionResult.contactCount} contacts`)
      } else {
        console.log('❌ Claude contact extraction failed:', contactExtractionResult.message)
      }

      console.log('files done processing')
      this.appScheduleRunning = false
    } catch (e) {
      console.log('----------- Failure ---------------')
      console.log(e)
      await this.loggingService.writeMessage('scheduleFailed', e.message)
      console.log('----------- Failure ---------------')
      this.appScheduleRunning = false
    }
  }

  // Cron job initialization
  initializeCronJob() {
    // Original job - Tuesday 11:59 PM
    const emnrdCronEnabled = process.env.EMNRD_CRON_ENABLED !== 'false' // Enabled by default

    if (emnrdCronEnabled) {
      console.log('📅 Initializing EMNRD cron job: Tuesdays at 11:59 PM')
      cron.schedule('59 23 * * 2', async () => {
      this.filesToProcess = []
      try {
        console.log(`[${new Date().toISOString()}] Good morning! Running daily job at 11:05 AM`)

        await this.authService.writeDynamoMessage({
          pkey: 'schedule#pdfDownload',
          skey: 'schedule#start',
          origin: 'scheduler',
          type:'system',
          data: `SUCCESS: Started Job`
        })

        console.log('Start download pdf Success')

        this.appScheduleRunning = true
        await this.loggingService.writeMessage('downloadStart', 'started')
        await this.test()
        await this.loggingService.writeMessage('downloadComplete', 'success')

        await this.authService.writeDynamoMessage({
          pkey: 'schedule#pdfDownload',
          skey: 'schedule#complete',
          origin: 'scheduler',
          type:'system',
          data: `SUCCESS: PDFs Downloaded`
        })

        console.log('completed pdf Success')
        console.log('-----------------------------------')
        console.log('✅ All PDFs processed with hybrid mode (Textract + Claude)')
        console.log('💾 Contacts already saved to PostgreSQL during local processing')
        console.log('-----------------------------------')

        // PHASE 2 DISABLED: Contacts are now extracted and saved during Phase 1 (hybrid local processing)
        // The hybrid processing (lines 126-175) already:
        // 1. Extracts contacts using Textract + Claude
        // 2. Saves contacts to PostgreSQL
        // 3. Uploads PDFs to S3
        // Therefore, we don't need to process from S3 again

        /* DISABLED - Phase 2 S3 Processing (no longer needed with hybrid mode)
        console.log('🤖 Starting Claude contact extraction...')

        await this.authService.writeDynamoMessage({
          pkey: 'schedule#claudeStart',
          skey: 'schedule#start',
          origin: 'claude',
          type:'system',
          data: `SUCCESS: Claude Started`
        })

        const contactExtractionResult = await this.pdfService.processContactsFromPdfs(this.filesToProcess)

        if (contactExtractionResult.success) {
          console.log('✅ Claude contact extraction completed successfully!')
          console.log(`📊 Extracted ${contactExtractionResult.contactCount} contacts`)
          await this.authService.writeDynamoMessage({
            pkey: 'schedule#claudeStart',
            skey: 'schedule#complete',
            origin: 'claude',
            type:'system',
            data: `SUCCESS: Claude Completed`
          })

          console.log('-----------------------------------')
          console.log('🐘 Starting PostgreSQL processing...')

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#postgresProcessing',
            skey: 'schedule#start',
            origin: 'postgresProcessor',
            type: 'system',
            data: 'SUCCESS: PostgreSQL Processing Started'
          })

          const postgresProcessingResult = await this.contactController.processCSVsToPostgres()

          if (postgresProcessingResult.success) {
            console.log('✅ PostgreSQL processing completed successfully!')
            console.log(`📊 Processed ${postgresProcessingResult.totalRecordsProcessed} records to PostgreSQL`)

            await this.authService.writeDynamoMessage({
              pkey: 'schedule#postgresProcessing',
              skey: 'schedule#complete',
              origin: 'postgresProcessor',
              type: 'system',
              data: `SUCCESS: ${postgresProcessingResult.message}`
            })
          } else {
            console.log('❌ PostgreSQL processing failed:', postgresProcessingResult.message)

            await this.authService.writeDynamoMessage({
              pkey: 'schedule#postgresProcessing',
              skey: 'schedule#error',
              origin: 'postgresProcessor',
              type: 'system',
              data: `FAILED: ${postgresProcessingResult.message}`
            })
          }

        } else {
          console.log('❌ Claude contact extraction failed:', contactExtractionResult.message)
          await this.authService.writeDynamoMessage({
            pkey: 'schedule#claudeStart',
            skey: 'schedule#error',
            origin: 'claude',
            type:'system',
            data: `FAILED: ${contactExtractionResult.message}`
          })
        }
        */

        console.log('files done processing')
        this.appScheduleRunning = false
      } catch (e) {
        console.log('----------- Failure ---------------')
        console.log(e)
        await this.loggingService.writeMessage('scheduleFailed', e.message)

        await this.authService.writeDynamoMessage({
          pkey: 'schedule#failed',
          skey: 'error#failed',
          origin: 'schedule',
          type:'system',
          data: `FAILURE: ${e.message}`
        })
        console.log('----------- Failure ---------------')
        this.appScheduleRunning = false
      }
    })
    } else {
      console.log('⏸️ EMNRD cron job is disabled (set EMNRD_CRON_ENABLED=false to disable)')
    }

    // S3 PDF Analysis Job - Separate schedule
    if (this.s3AnalysisController.getConfig().enabled) {
      console.log(`🔍 Initializing S3 PDF Analysis cron job: ${this.s3AnalysisController.getConfig().schedule}`)
      cron.schedule(this.s3AnalysisController.getConfig().schedule, async () => {
        try {
          console.log(`[${new Date().toISOString()}] 🔍 Starting scheduled S3 PDF Analysis Job`)
          await this.s3AnalysisController.processS3PdfsForAnalysis()
        } catch (error) {
          console.error('💥 Scheduled S3 PDF Analysis failed:', error.message)
          await this.loggingService.writeMessage('s3AnalysisScheduleFailed', error.message)
        }
      })
    } else {
      console.log('⏸️ S3 PDF Analysis cron job is disabled')
    }

    // Vision Processing Job - Uses Claude Vision API (converts PDFs to images)
    const visionCronEnabled = process.env.VISION_CRON_ENABLED === 'true'
    const visionCronSchedule = process.env.VISION_CRON_SCHEDULE || '0 4 * * 4' // Thursdays at 4 AM by default

    if (visionCronEnabled) {
      console.log(`🎨 Initializing Vision Processing cron job: ${visionCronSchedule}`)
      cron.schedule(visionCronSchedule, async () => {
        this.filesToProcess = []
        try {
          console.log(`[${new Date().toISOString()}] 🎨 Starting scheduled Vision Processing Job`)

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#visionProcessing',
            skey: 'schedule#start',
            origin: 'scheduler',
            type: 'system',
            data: 'SUCCESS: Started Vision Processing Job'
          })

          console.log('Start Vision Processing Success')

          this.appScheduleRunning = true
          await this.loggingService.writeMessage('visionProcessingStart', 'started')
          await this.testWithVision()
          await this.loggingService.writeMessage('visionProcessingComplete', 'success')

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#visionProcessing',
            skey: 'schedule#complete',
            origin: 'scheduler',
            type: 'system',
            data: `SUCCESS: Vision Processing Complete - ${this.filesToProcess.length} files processed`
          })

          console.log('Completed Vision Processing Success')
          console.log('-----------------------------------')
          console.log('✅ All PDFs processed with Claude Vision (Ghostscript + Image Analysis)')
          console.log('💾 Contacts already saved to PostgreSQL during processing')
          console.log('-----------------------------------')

          console.log('Vision processing job complete')
          this.appScheduleRunning = false
        } catch (e) {
          console.log('----------- Vision Processing Failure ---------------')
          console.log(e)
          await this.loggingService.writeMessage('visionScheduleFailed', e.message)

          await this.authService.writeDynamoMessage({
            pkey: 'schedule#visionProcessing',
            skey: 'error#failed',
            origin: 'scheduler',
            type: 'system',
            data: `FAILURE: ${e.message}`
          })
          console.log('----------- Vision Processing Failure ---------------')
          this.appScheduleRunning = false
        }
      })
    } else {
      console.log('⏸️ Vision Processing cron job is disabled (set VISION_CRON_ENABLED=true to enable)')
    }
  }
}

// Create single instance
const emnrdController = new EmnrdController()

// Export both the Controller class and controller function for routes
module.exports.Controller = { EmnrdController: emnrdController }
module.exports.upload = upload
module.exports.controller = (app) => {
  console.log('🔧 Loading EMNRD controller routes...')

  // Core workflow routes
  app.get('/v1/running', (req, res) => emnrdController.getStatus(req, res))
  app.get('/v1/force', (req, res) => emnrdController.test(req, res))
  app.get('/v1/force-vision', (req, res) => emnrdController.testWithVision(req, res))

  // Single file upload endpoints - uses multer middleware
  app.post('/v1/emnrd/upload-and-process', upload.single('pdf'), (req, res) => emnrdController.uploadAndProcess(req, res))
  app.post('/v1/emnrd/upload-and-process-native', upload.single('pdf'), (req, res) => emnrdController.uploadAndProcessNative(req, res))
  app.post('/v1/emnrd/upload-and-process-hybrid', upload.single('pdf'), (req, res) => emnrdController.uploadAndProcessHybrid(req, res))

  // Debug endpoints
  app.get('/v1/debug-methods', (req, res) => emnrdController.debugMethods(req, res))

  console.log('✅ EMNRD controller routes loaded successfully')
}
