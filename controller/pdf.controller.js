require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// Import services
const AuthService = require('../services/auth.service.js')
const S3Service = require('../services/s3.service.js')
const LoggingService = require('../services/logging.service.js')
const DataService = require('../services/data.service.js')
const PDFService = require('../services/pdf.service.js')

class PdfController {
  constructor() {
    // Initialize services
    this.loggingService = new LoggingService()
    this.authService = new AuthService()
    this.s3Service = new S3Service(this.authService, this.loggingService)
    this.dataService = new DataService(this.authService, this.loggingService)
    this.pdfService = new PDFService(this.authService, this.s3Service, this.loggingService)

    // Configuration for local processing
    this.config = {
      localDownloadPath: process.env.LOCAL_PDF_PATH || './downloads/pdfs',
      useGhostscript: process.env.USE_GHOSTSCRIPT === 'true',
      ghostscriptQuality: process.env.GS_QUALITY || 'ebook',
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 500000,
      processLocally: process.env.PROCESS_LOCALLY === 'true',
      useTextract: process.env.USE_TEXTRACT === 'true',
      extractText: process.env.EXTRACT_TEXT === 'true',
      textExtractionMethod: process.env.TEXT_EXTRACTION_METHOD || 'smart',
      smartProcessing: process.env.SMART_PROCESSING !== 'false'
    }

    // Initialize Textract client if needed
    this.textractClient = null
    this.processingResults = []

    // Ensure local directory exists
    this.ensureLocalDirectory()
  }

  // Utility Methods
  ensureLocalDirectory() {
    if (!fs.existsSync(this.config.localDownloadPath)) {
      fs.mkdirSync(this.config.localDownloadPath, { recursive: true })
      console.log(`📁 Created local download directory: ${this.config.localDownloadPath}`)
    }
  }

  async downloadPdfLocally(url, filename, applicant) {
    const applicantDir = path.join(this.config.localDownloadPath, applicant)

    if (!fs.existsSync(applicantDir)) {
      fs.mkdirSync(applicantDir, { recursive: true })
    }

    const localPath = path.join(applicantDir, filename)

    try {
      console.log(`🔐 Downloading ${filename} with authentication...`)

      const token = this.authService.getToken()
      if (!token) {
        await this.authService.login()
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.authService.getToken()}`,
          'Accept': 'application/pdf, */*',
          'User-Agent': 'Mozilla/5.0 (compatible; PDF-Downloader/1.0)'
        },
        redirect: 'follow'
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`)
      }

      const contentType = response.headers.get('content-type')
      console.log(`📄 Content-Type: ${contentType}`)

      if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
        const text = await response.text()
        console.warn(`⚠️ Unexpected content type for ${filename}: ${contentType}`)
        console.warn(`First 500 chars: ${text.substring(0, 500)}...`)
        throw new Error(`Expected PDF but got ${contentType}`)
      }

      const buffer = await response.arrayBuffer()
      const pdfBuffer = Buffer.from(buffer)

      if (!pdfBuffer.toString('ascii', 0, 4).includes('%PDF')) {
        const preview = pdfBuffer.toString('utf8', 0, Math.min(500, pdfBuffer.length))
        console.warn(`⚠️ File ${filename} doesn't appear to be a PDF`)
        console.warn(`Content preview: ${preview}`)

        const debugPath = localPath.replace('.pdf', '.debug.html')
        fs.writeFileSync(debugPath, pdfBuffer)
        console.log(`🐛 Saved debug file: ${debugPath}`)

        throw new Error(`Downloaded content is not a valid PDF`)
      }

      fs.writeFileSync(localPath, pdfBuffer)

      const stats = fs.statSync(localPath)
      console.log(`⬇️ Downloaded ${filename} locally (${stats.size} bytes)`)
      return localPath

    } catch (error) {
      console.error(`❌ Failed to download ${filename}: ${error.message}`)

      try {
        console.log(`🔄 Attempting S3-based download method for ${filename}...`)
        await this.downloadPdfWithS3Method(url, localPath)
        return localPath
      } catch (altError) {
        console.error(`❌ S3-based download also failed: ${altError.message}`)
        throw new Error(`Both download methods failed: ${error.message} | ${altError.message}`)
      }
    }
  }

  async downloadPdfWithS3Method(url, localPath) {
    try {
      console.log(`🔄 Using S3Service download method...`)

      const tempS3Key = `temp/${Date.now()}-${path.basename(localPath)}`

      await this.s3Service.uploadToS3(url, tempS3Key)

      const s3Object = await this.s3Service.getObject(tempS3Key)
      const buffer = await s3Object.Body.transformToByteArray()

      fs.writeFileSync(localPath, Buffer.from(buffer))

      await this.s3Service.deleteObject(tempS3Key)

      console.log(`✅ Downloaded via S3 method: ${path.basename(localPath)}`)
      return localPath

    } catch (error) {
      console.error(`❌ S3 method download failed: ${error.message}`)
      throw error
    }
  }

  async optimizePdfWithGhostscript(inputPath, outputPath = null) {
    if (!this.config.useGhostscript) {
      return { optimizedPath: inputPath, wasOptimized: false }
    }

    const output = outputPath || inputPath.replace('.pdf', '_optimized.pdf')

    try {
      execSync('gs --version', { stdio: 'ignore' })

      const gsCommand = [
        'gs',
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        `-dPDFSETTINGS=/${this.config.ghostscriptQuality}`,
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        '-dAutoRotatePages=/None',
        '-dColorImageResolution=300',
        '-dGrayImageResolution=300',
        '-dMonoImageResolution=600',
        '-dPreserveAnnots=true',
        '-dPreserveMarkedContent=true',
        `-sOutputFile="${output}"`,
        `"${inputPath}"`
      ].join(' ')

      console.log(`🔧 Optimizing PDF with Ghostscript: ${path.basename(inputPath)}`)
      execSync(gsCommand)

      const originalStats = fs.statSync(inputPath)
      const optimizedStats = fs.statSync(output)

      if (optimizedStats.size < originalStats.size) {
        console.log(`✅ PDF optimized: ${originalStats.size} → ${optimizedStats.size} bytes (${Math.round((1 - optimizedStats.size/originalStats.size) * 100)}% reduction)`)

        if (!outputPath) {
          fs.unlinkSync(inputPath)
          fs.renameSync(output, inputPath)
          return { optimizedPath: inputPath, wasOptimized: true, originalSize: originalStats.size, newSize: optimizedStats.size }
        }
        return { optimizedPath: output, wasOptimized: true, originalSize: originalStats.size, newSize: optimizedStats.size }
      } else {
        console.log(`⚠️ Optimization didn't reduce size, keeping original`)
        if (!outputPath) {
          fs.unlinkSync(output)
        }
        return { optimizedPath: inputPath, wasOptimized: false, originalSize: originalStats.size, newSize: originalStats.size }
      }

    } catch (error) {
      console.warn(`⚠️ Ghostscript optimization failed: ${error.message}`)
      if (fs.existsSync(output) && !outputPath) {
        fs.unlinkSync(output)
      }
      return { optimizedPath: inputPath, wasOptimized: false, error: error.message }
    }
  }

  async extractTextFromPdf(pdfPath) {
    try {
      const pdfParse = require('pdf-parse')
      const dataBuffer = fs.readFileSync(pdfPath)
      const data = await pdfParse(dataBuffer)

      const meaningfulText = data.text.replace(/\s+/g, ' ').trim()

      if (meaningfulText.length < 50) {
        console.log(`📷 PDF has minimal text (${meaningfulText.length} chars) - likely image-based`)
        return {
          extractedText: meaningfulText,
          textLength: meaningfulText.length,
          numPages: data.numpages,
          isImageBased: true
        }
      }

      console.log(`📝 Extracted ${meaningfulText.length} characters from PDF (${data.numpages} pages)`)
      return {
        extractedText: meaningfulText,
        textLength: meaningfulText.length,
        numPages: data.numpages,
        isImageBased: false
      }

    } catch (error) {
      console.warn(`⚠️ PDF text extraction failed: ${error.message}`)
      return { extractedText: '', textLength: 0, numPages: 0, isImageBased: true, error: error.message }
    }
  }

  async extractTextWithTextract(pdfPath, s3Key) {
    try {
      if (!this.textractClient) {
        const { TextractClient } = require('@aws-sdk/client-textract')
        this.textractClient = new TextractClient({
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: this.authService.getAWSCredentials ? this.authService.getAWSCredentials() : undefined
        })
      }

      const { AnalyzeDocumentCommand } = require('@aws-sdk/client-textract')

      console.log(`🔍 Starting Textract analysis for ${path.basename(pdfPath)}`)

      // First, ensure the PDF is uploaded to S3 for Textract to access
      console.log(`☁️ Uploading ${path.basename(pdfPath)} to S3 for Textract analysis...`)
      await this.uploadOptimizedToS3(pdfPath, s3Key)

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
          tables.push(this.processTextractTable(block, response.Blocks))
        } else if (block.BlockType === 'KEY_VALUE_SET') {
          forms.push(this.processTextractForm(block, response.Blocks))
        }
      }

      const baseName = pdfPath.replace('.pdf', '')
      const textPath = baseName + '_textract.txt'
      fs.writeFileSync(textPath, extractedText)

      if (tables.length > 0 || forms.length > 0) {
        const structuredPath = baseName + '_structured.json'
        fs.writeFileSync(structuredPath, JSON.stringify({ tables, forms }, null, 2))
        console.log(`📊 Extracted ${tables.length} tables and ${forms.length} form fields`)
      }

      console.log(`📝 Textract extracted ${extractedText.length} characters`)
      return {
        extractedText,
        textLength: extractedText.length,
        textPath,
        tables,
        forms,
        confidence: 'high',
        method: 'textract',
        uploadedToS3: true
      }

    } catch (error) {
      console.warn(`⚠️ Textract failed: ${error.message}`)
      return {
        extractedText: '',
        textLength: 0,
        textPath: null,
        confidence: 'failed',
        error: error.message,
        method: 'textract',
        uploadedToS3: false
      }
    }
  }

  processTextractTable(tableBlock, allBlocks) {
    const table = { rows: [] }

    if (tableBlock.Relationships) {
      const cellIds = tableBlock.Relationships
        .find(rel => rel.Type === 'CHILD')?.Ids || []

      table.cellCount = cellIds.length
      table.id = tableBlock.Id
    }

    return table
  }

  processTextractForm(formBlock, allBlocks) {
    const form = {}

    if (formBlock.EntityTypes && formBlock.EntityTypes.includes('KEY')) {
      form.type = 'key'
      form.id = formBlock.Id
      form.text = formBlock.Text || ''
    }

    return form
  }

  async analyzePdfContent(pdfPath) {
    try {
      const pdfParse = require('pdf-parse')
      const dataBuffer = fs.readFileSync(pdfPath)
      const data = await pdfParse(dataBuffer)

      const meaningfulText = data.text.replace(/\s+/g, ' ').trim()
      const textLength = meaningfulText.length
      const numPages = data.numpages
      const avgTextPerPage = textLength / Math.max(numPages, 1)

      const fileStats = fs.statSync(pdfPath)
      const fileSizeKB = fileStats.size / 1024
      const textDensity = Math.round((textLength / fileSizeKB) * 10) / 10

      let type = 'unknown'
      let recommendation = 'ghostscript-only'
      let hasImages = false

      if (avgTextPerPage > 500 && textDensity > 50) {
        type = 'text-based'
        recommendation = 'ghostscript-only'
        hasImages = false
      } else if (avgTextPerPage < 50 && textDensity < 10) {
        type = 'image-based'
        recommendation = 'textract'
        hasImages = true
      } else if (fileSizeKB > 1000 && textDensity < 30) {
        type = 'mixed'
        recommendation = 'both'
        hasImages = true
      } else {
        type = 'mixed'
        recommendation = 'both'
        hasImages = textDensity < 40
      }

      return {
        type,
        recommendation,
        hasImages,
        textLength,
        numPages,
        avgTextPerPage: Math.round(avgTextPerPage),
        fileSizeKB: Math.round(fileSizeKB),
        textDensity: Math.round(textDensity)
      }

    } catch (error) {
      console.warn(`⚠️ PDF content analysis failed: ${error.message}`)
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

  async smartOptimizeAndExtract(inputPath, s3Key = null) {
    const results = {
      originalPath: inputPath,
      optimizedPath: inputPath,
      wasOptimized: false,
      textExtracted: false,
      extractedText: '',
      textLength: 0,
      method: 'none',
      contentType: 'unknown',
      processingSteps: []
    }

    try {
      console.log(`🧠 Smart processing: ${path.basename(inputPath)}`)

      console.log(`🔍 Step 1: Analyzing PDF content type`)
      const contentAnalysis = await this.analyzePdfContent(inputPath)
      results.contentType = contentAnalysis.type
      results.processingSteps.push(`Analysis: ${contentAnalysis.type}`)

      console.log(`📊 PDF Analysis Results:`)
      console.log(`   - Content Type: ${contentAnalysis.type}`)
      console.log(`   - Text Density: ${contentAnalysis.textDensity}%`)
      console.log(`   - Has Images: ${contentAnalysis.hasImages}`)
      console.log(`   - Recommendation: ${contentAnalysis.recommendation}`)

      if (contentAnalysis.type === 'text-based' || contentAnalysis.recommendation === 'ghostscript-only') {
        console.log(`📝 Step 2: Text-based processing (Ghostscript + basic extraction)`)

        const optimizationResult = await this.optimizePdfWithGhostscript(inputPath)
        results.optimizedPath = optimizationResult.optimizedPath
        results.wasOptimized = optimizationResult.wasOptimized
        results.processingSteps.push(`Ghostscript: ${optimizationResult.wasOptimized ? 'optimized' : 'skipped'}`)

        const textResult = await this.extractTextFromPdf(results.optimizedPath)
        results.extractedText = textResult.extractedText
        results.textLength = textResult.textLength
        results.method = 'ghostscript-basic'
        results.textExtracted = textResult.textLength > 0
        results.processingSteps.push(`Basic extraction: ${textResult.textLength} chars`)

      } else if (contentAnalysis.type === 'image-based' || contentAnalysis.recommendation === 'textract') {
        console.log(`📷 Step 2: Image-based processing (Textract OCR only)`)

        results.optimizedPath = inputPath
        results.wasOptimized = false
        results.processingSteps.push('Ghostscript: skipped (image-heavy)')

        if (this.config.useTextract && s3Key) {
          const textractResult = await this.extractTextWithTextract(inputPath, s3Key)
          results.extractedText = textractResult.extractedText
          results.textLength = textractResult.textLength
          results.method = 'textract-only'
          results.textExtracted = textractResult.textLength > 0
          results.tables = textractResult.tables
          results.forms = textractResult.forms
          results.uploadedToS3 = textractResult.uploadedToS3
          results.processingSteps.push(`Textract: ${textractResult.textLength} chars, ${textractResult.tables?.length || 0} tables`)
        } else {
          results.method = 'skipped'
          results.processingSteps.push('Textract: not configured')
        }

      } else {
        console.log(`🔀 Step 2: Mixed content processing (Ghostscript + Textract)`)

        const optimizationResult = await this.optimizePdfWithGhostscript(inputPath)
        results.optimizedPath = optimizationResult.optimizedPath
        results.wasOptimized = optimizationResult.wasOptimized
        results.processingSteps.push(`Ghostscript: ${optimizationResult.wasOptimized ? 'optimized' : 'skipped'}`)

        const basicTextResult = await this.extractTextFromPdf(results.optimizedPath)

        if (basicTextResult.textLength < 100 && this.config.useTextract && s3Key) {
          const textractResult = await this.extractTextWithTextract(results.optimizedPath, s3Key)
          if (textractResult.textLength > basicTextResult.textLength) {
            results.extractedText = textractResult.extractedText
            results.textLength = textractResult.textLength
            results.method = 'ghostscript-textract'
            results.tables = textractResult.tables
            results.forms = textractResult.forms
            results.uploadedToS3 = textractResult.uploadedToS3
            results.processingSteps.push(`Textract: ${textractResult.textLength} chars (better than basic)`)
          } else {
            results.extractedText = basicTextResult.extractedText
            results.textLength = basicTextResult.textLength
            results.method = 'ghostscript-basic'
            results.processingSteps.push(`Basic: ${basicTextResult.textLength} chars (sufficient)`)
          }
        } else {
          results.extractedText = basicTextResult.extractedText
          results.textLength = basicTextResult.textLength
          results.method = 'ghostscript-basic'
          results.processingSteps.push(`Basic: ${basicTextResult.textLength} chars`)
        }

        results.textExtracted = results.textLength > 0
      }

      if (results.textExtracted && results.extractedText) {
        const textPath = results.optimizedPath.replace('.pdf', `_${results.method}.txt`)
        fs.writeFileSync(textPath, results.extractedText)
        results.textPath = textPath
      }

      console.log(`✅ Smart processing complete: ${results.processingSteps.join(' → ')}`)
      return results

    } catch (error) {
      console.error(`❌ Smart processing failed: ${error.message}`)
      results.error = error.message
      return results
    }
  }

  async optimizeAndExtractText(inputPath, s3Key = null) {
    const results = {
      originalPath: inputPath,
      optimizedPath: inputPath,
      wasOptimized: false,
      textExtracted: false,
      extractedText: '',
      textLength: 0,
      method: 'none',
      processingSteps: []
    }

    try {
      console.log(`📄 Starting combined processing: ${path.basename(inputPath)}`)

      console.log(`🔧 Step 1: Ghostscript optimization`)
      const optimizationResult = await this.optimizePdfWithGhostscript(inputPath)
      results.optimizedPath = optimizationResult.optimizedPath
      results.wasOptimized = optimizationResult.wasOptimized
      results.originalSize = optimizationResult.originalSize
      results.newSize = optimizationResult.newSize
      results.processingSteps.push(`Ghostscript: ${optimizationResult.wasOptimized ? 'optimized' : 'skipped'}`)

      console.log(`📝 Step 2: Basic text extraction`)
      const basicTextResult = await this.extractTextFromPdf(results.optimizedPath)
      results.processingSteps.push(`Basic extraction: ${basicTextResult.textLength} chars`)

      if (basicTextResult.isImageBased || basicTextResult.textLength < 100) {
        console.log(`🔍 Step 3: Advanced text extraction (document appears image-based)`)

        if (this.config.useTextract && s3Key) {
          const textractResult = await this.extractTextWithTextract(results.optimizedPath, s3Key)
          if (textractResult.textLength > basicTextResult.textLength) {
            results.extractedText = textractResult.extractedText
            results.textLength = textractResult.textLength
            results.method = 'textract'
            results.tables = textractResult.tables
            results.forms = textractResult.forms
            results.textExtracted = true
            results.uploadedToS3 = textractResult.uploadedToS3
            results.processingSteps.push(`Textract: ${textractResult.textLength} chars, ${textractResult.tables?.length || 0} tables`)
          }
        } else {
          results.extractedText = basicTextResult.extractedText
          results.textLength = basicTextResult.textLength
          results.method = 'basic'
          results.textExtracted = basicTextResult.textLength > 0
        }
      } else {
        results.extractedText = basicTextResult.extractedText
        results.textLength = basicTextResult.textLength
        results.method = 'basic'
        results.textExtracted = true
        results.processingSteps.push('Used basic extraction (sufficient text found)')
      }

      if (results.textExtracted && results.extractedText) {
        const textPath = results.optimizedPath.replace('.pdf', '_extracted.txt')
        fs.writeFileSync(textPath, results.extractedText)
        results.textPath = textPath
      }

      console.log(`✅ Processing complete: ${results.processingSteps.join(', ')}`)
      return results

    } catch (error) {
      console.error(`❌ Combined processing failed: ${error.message}`)
      results.error = error.message
      return results
    }
  }

  async uploadOptimizedToS3(localPath, s3Key) {
    try {
      const fileBuffer = fs.readFileSync(localPath)

      if (this.s3Service.uploadBufferToS3) {
        await this.s3Service.uploadBufferToS3(fileBuffer, s3Key)
      } else {
        const tempPath = localPath + '.temp'
        fs.copyFileSync(localPath, tempPath)
        await this.s3Service.uploadFileToS3(tempPath, s3Key)
        fs.unlinkSync(tempPath)
      }

      console.log(`☁️ Uploaded optimized PDF to S3: ${s3Key}`)
    } catch (error) {
      console.error(`❌ Failed to upload to S3: ${error.message}`)
      throw error
    }
  }

  async cleanupLocalFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        console.log(`🗑️ Cleaned up local file: ${path.basename(filePath)}`)
      }
    } catch (error) {
      console.warn(`⚠️ Failed to cleanup ${filePath}: ${error.message}`)
    }
  }

  // HTTP Route Handlers
  async processList(req, res) {
    try {
      const folder = (req.query.folder || 'pdfs').replace(/\/?$/, '/')
      const results = await this.s3Service.listFiles(folder)
      res.status(200).send('ok')
    } catch (err) {
      console.error("Error listing files:", err)
      await this.loggingService.writeMessage('s3Error', err)
      return res.status(500).send(err)
    }
  }

  async getPdfList(req, res) {
    try {
      const folder = (req.query.folder || 'pdfs').replace(/\/?$/, '/')
      console.log(folder + '<----')
      const results = await this.s3Service.listFiles(folder)

      if (results.length === 0) {
        console.log("No files found in the specified folder.")
        await this.loggingService.writeMessage('s3error', 'Folder is empty or does not exist')
        return res.status(404).send('Not Found')
      }

      res.status(200).send(results)
    } catch (err) {
      console.error("Error listing files:", err)
      await this.loggingService.writeMessage('s3Error', err)
      return res.status(500).send(err)
    }
  }

  async extractContacts(req, res) {
    try {
      const { pdfKeys } = req.body

      if (!pdfKeys || !Array.isArray(pdfKeys) || pdfKeys.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'pdfKeys array is required'
        })
      }

      const result = await this.pdfService.processContactsFromPdfs(pdfKeys)

      res.status(result.success ? 200 : 400).json(result)
    } catch (error) {
      res.status(500).json({
        success: false,
        message: `Server error: ${error.message}`
      })
    }
  }

  async processSingleFile(req, res) {
    try {
      const { pdfKey, outputBucket } = req.body

      if (!pdfKey) {
        return res.status(400).json({
          success: false,
          message: 'pdfKey is required'
        })
      }

      const result = await this.pdfService.processSingleFile(pdfKey, outputBucket)
      res.json(result)

    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }

  async getByKey(req, res) {
    const key = req.query.key

    if (!key) {
      return res.status(400).send('Missing key')
    }

    try {
      const data = await this.s3Service.getFileMetadata(key)
      res.status(200).send(data)
    } catch (err) {
      console.error('Error fetching metadata:', err)
      await this.loggingService.writeMessage('s3Error', err)

      if (err.name === 'NotFound') {
        return res.status(404).send('File not found')
      }

      return res.status(500).send('Error fetching PDF metadata')
    }
  }

  async getProcessingResults(req, res) {
    try {
      const results = this.processingResults || []
      const summary = {
        totalProcessed: results.length,
        optimized: results.filter(r => r.wasOptimized).length,
        textExtracted: results.filter(r => r.textExtracted).length,
        averageTextLength: results.reduce((sum, r) => sum + (r.textLength || 0), 0) / Math.max(results.length, 1),
        methods: {
          'ghostscript-basic': results.filter(r => r.method === 'ghostscript-basic').length,
          'textract-only': results.filter(r => r.method === 'textract-only').length,
          'ghostscript-textract': results.filter(r => r.method === 'ghostscript-textract').length,
          basic: results.filter(r => r.method === 'basic').length,
          textract: results.filter(r => r.method === 'textract').length
        },
        contentTypes: {
          'text-based': results.filter(r => r.contentType === 'text-based').length,
          'image-based': results.filter(r => r.contentType === 'image-based').length,
          'mixed': results.filter(r => r.contentType === 'mixed').length
        }
      }

      res.status(200).json({
        success: true,
        summary,
        results: results.slice(0, 50)
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }

  async getConfig(req, res) {
    try {
      res.status(200).json({
        success: true,
        config: {
          ...this.config,
          ghostscriptAvailable: await this.isGhostscriptAvailable()
        }
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }

  async updateConfig(req, res) {
    try {
      const { useGhostscript, ghostscriptQuality, processLocally, maxFileSize, useTextract, smartProcessing } = req.body

      if (useGhostscript !== undefined) {
        this.config.useGhostscript = useGhostscript
      }

      if (ghostscriptQuality && ['screen', 'ebook', 'printer', 'prepress'].includes(ghostscriptQuality)) {
        this.config.ghostscriptQuality = ghostscriptQuality
      }

      if (processLocally !== undefined) {
        this.config.processLocally = processLocally
      }

      if (maxFileSize && maxFileSize > 0) {
        this.config.maxFileSize = maxFileSize
      }

      if (useTextract !== undefined) {
        this.config.useTextract = useTextract
      }

      if (smartProcessing !== undefined) {
        this.config.smartProcessing = smartProcessing
      }

      res.status(200).json({
        success: true,
        message: 'Configuration updated successfully',
        config: this.config
      })

    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }

  async isGhostscriptAvailable() {
    try {
      execSync('gs --version', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  async testGhostscript(req, res) {
    try {
      const available = await this.isGhostscriptAvailable()

      if (available) {
        const version = execSync('gs --version', { encoding: 'utf8' }).trim()
        res.status(200).json({
          success: true,
          available: true,
          version: version,
          message: 'Ghostscript is available'
        })
      } else {
        res.status(200).json({
          success: false,
          available: false,
          message: 'Ghostscript is not available'
        })
      }

    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }

  async cleanupLocalFiles(req, res) {
    try {
      const { applicant, all } = req.query

      if (all === 'true') {
        if (fs.existsSync(this.config.localDownloadPath)) {
          fs.rmSync(this.config.localDownloadPath, { recursive: true, force: true })
          this.ensureLocalDirectory()
          console.log('🗑️ Cleaned up all local files')
        }
      } else if (applicant) {
        const applicantDir = path.join(this.config.localDownloadPath, applicant)
        if (fs.existsSync(applicantDir)) {
          fs.rmSync(applicantDir, { recursive: true, force: true })
          console.log(`🗑️ Cleaned up files for applicant: ${applicant}`)
        }
      }

      res.status(200).json({
        success: true,
        message: 'Cleanup completed successfully'
      })

    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }

  async debugConfig(_req, res) {
    try {
      console.log('🔍 Current Configuration Debug:')
      console.log('- LOCAL_PDF_PATH env:', process.env.LOCAL_PDF_PATH)
      console.log('- USE_GHOSTSCRIPT env:', process.env.USE_GHOSTSCRIPT)
      console.log('- PROCESS_LOCALLY env:', process.env.PROCESS_LOCALLY)
      console.log('- MAX_FILE_SIZE env:', process.env.MAX_FILE_SIZE)
      console.log('- SMART_PROCESSING env:', process.env.SMART_PROCESSING)
      console.log('- Config object:', JSON.stringify(this.config, null, 2))

      res.status(200).json({
        success: true,
        environment: {
          LOCAL_PDF_PATH: process.env.LOCAL_PDF_PATH,
          USE_GHOSTSCRIPT: process.env.USE_GHOSTSCRIPT,
          PROCESS_LOCALLY: process.env.PROCESS_LOCALLY,
          MAX_FILE_SIZE: process.env.MAX_FILE_SIZE,
          KEEP_LOCAL_FILES: process.env.KEEP_LOCAL_FILES,
          USE_TEXTRACT: process.env.USE_TEXTRACT,
          SMART_PROCESSING: process.env.SMART_PROCESSING
        },
        activeConfig: this.config,
        directoryExists: fs.existsSync(this.config.localDownloadPath),
        ghostscriptAvailable: await this.isGhostscriptAvailable()
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }
}

// Create single instance
const pdfController = new PdfController()

// Export controller
module.exports.Controller = { PdfController: pdfController }
module.exports.controller = (app) => {
  console.log('🔧 Loading PDF controller routes...')

  // PDF file management
  app.get('/v1/pdflist', (req, res) => pdfController.getPdfList(req, res))
  app.get('/v1/pdfbykey', (req, res) => pdfController.getByKey(req, res))
  app.get('/v1/theprocess', (req, res) => pdfController.processList(req, res))
  app.post('/v1/extract-contacts', (req, res) => pdfController.extractContacts(req, res))
  app.post('/v1/processsingle', (req, res) => pdfController.processSingleFile(req, res))

  // Configuration and optimization endpoints
  app.get('/v1/config', (req, res) => pdfController.getConfig(req, res))
  app.put('/v1/config', (req, res) => pdfController.updateConfig(req, res))
  app.get('/v1/processing-results', (req, res) => pdfController.getProcessingResults(req, res))
  app.get('/v1/test-ghostscript', (req, res) => pdfController.testGhostscript(req, res))
  app.delete('/v1/cleanup-local', (req, res) => pdfController.cleanupLocalFiles(req, res))

  // Debug endpoints
  app.get('/v1/debug-config', (req, res) => pdfController.debugConfig(req, res))

  console.log('✅ PDF controller routes loaded successfully')
}
