require('dotenv').config()
const cron = require('node-cron')

// Import services
const AuthService = require('../services/auth.service.js')
const S3Service = require('../services/s3.service.js')
const LoggingService = require('../services/logging.service.js')
const DataService = require('../services/data.service.js')
const PDFService = require('../services/pdf.service.js')

// Import other controllers
const { Controller: PdfControllerModule } = require('./pdf.controller.js')
const { Controller: ContactControllerModule } = require('./contact.controller.js')
const { Controller: S3AnalysisControllerModule } = require('./s3-analysis.controller.js')

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

    // State
    this.filesToProcess = []
    this.appScheduleRunning = false

    // Configuration for local processing
    this.config = {
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 500000,
      processLocally: process.env.PROCESS_LOCALLY === 'true',
    }

    // Initialize cron job
    this.initializeCronJob()
  }

  // Main workflow - processes PDFs from applicants
  async test(req, res) {
    try {
      this.appScheduleRunning = true
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

        const allPdfs = items.flatMap(item => item.ImagingFiles || [])

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

                console.log(`✅ Locally processed and uploaded: ${pdf.FileName}`)

                this.pdfController.processingResults = this.pdfController.processingResults || []
                this.pdfController.processingResults.push({
                  filename: pdf.FileName,
                  applicant: applicant,
                  s3Key: s3Key,
                  ...processingResult
                })
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
        console.log('process files')

        console.log('-----------------------------------')
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
  }
}

// Create single instance
const emnrdController = new EmnrdController()

// Export both the Controller class and controller function for routes
module.exports.Controller = { EmnrdController: emnrdController }
module.exports.controller = (app) => {
  console.log('🔧 Loading EMNRD controller routes...')

  // Core workflow routes
  app.get('/v1/running', (req, res) => emnrdController.getStatus(req, res))
  app.get('/v1/force', (req, res) => emnrdController.test(req, res))

  // Debug endpoints
  app.get('/v1/debug-methods', (req, res) => emnrdController.debugMethods(req, res))

  console.log('✅ EMNRD controller routes loaded successfully')
}
