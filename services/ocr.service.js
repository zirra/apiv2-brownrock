require('dotenv').config()
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const pdf = require('pdf-parse')

class OCRService {
  constructor(authService, s3Service, loggingService) {
    this.authService = authService
    this.s3Service = s3Service
    this.loggingService = loggingService

    // OCR Configuration
    this.config = {
      tesseractAvailable: this.checkTesseractAvailability(),
      tempDir: process.env.OCR_TEMP_DIR || './temp/ocr',
      imageQuality: process.env.OCR_IMAGE_QUALITY || '300', // DPI for PDF to image conversion
      tesseractLang: process.env.TESSERACT_LANG || 'eng',
      preprocessImages: process.env.OCR_PREPROCESS === 'true',
      textractLimit: parseInt(process.env.TEXTRACT_SIZE_LIMIT) || (10 * 1024 * 1024),
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || (50 * 1024 * 1024)
    }

    this.ensureTempDirectory()
    console.log(`🔍 OCR Service initialized - Tesseract: ${this.config.tesseractAvailable ? '✅' : '❌'}`)
  }

  checkTesseractAvailability() {
    try {
      execSync('tesseract --version', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  ensureTempDirectory() {
    if (!fs.existsSync(this.config.tempDir)) {
      fs.mkdirSync(this.config.tempDir, { recursive: true })
      console.log(`📁 Created OCR temp directory: ${this.config.tempDir}`)
    }
  }

  /**
   * Multi-tier OCR processing with fallbacks
   * 1. Textract (AWS) - for files <10MB
   * 2. Tesseract (local) - for files >10MB or when Textract fails
   * 3. Basic PDF extraction - final fallback
   */
  async extractTextWithMultiOCR(pdfBuffer, pdfKey) {
    const results = {
      extractedText: '',
      method: 'none',
      fileSize: pdfBuffer.length,
      success: false,
      processingSteps: []
    }

    try {
      console.log(`🔍 Starting multi-OCR processing: ${pdfKey || 'buffer'} (${(results.fileSize/1024/1024).toFixed(1)}MB)`)

      // Save buffer to temp file for processing
      const tempFile = path.join(this.config.tempDir, `ocr_${Date.now()}.pdf`)
      fs.writeFileSync(tempFile, pdfBuffer)
      results.processingSteps.push('Saved to temp file')

      // Tier 1: Try Textract for smaller files
      if (results.fileSize <= this.config.textractLimit) {
        console.log(`📡 Tier 1: Attempting AWS Textract (${(results.fileSize/1024/1024).toFixed(1)}MB <= 10MB)`)

        try {
          const textractResult = await this.extractWithTextract(tempFile, pdfKey)
          if (textractResult.success && textractResult.text.length > 0) {
            results.extractedText = textractResult.text
            results.method = 'textract'
            results.success = true
            results.processingSteps.push(`Textract: ${textractResult.text.length} chars`)

            // Cleanup and return success
            this.cleanupTempFile(tempFile)
            console.log(`✅ Textract extraction successful: ${results.extractedText.length} characters`)
            return results
          }
          results.processingSteps.push('Textract: failed/empty')
        } catch (error) {
          console.log(`⚠️ Textract failed: ${error.message}`)
          results.processingSteps.push(`Textract: error - ${error.message}`)
        }
      } else {
        console.log(`⏭️ Skipping Textract: file too large (${(results.fileSize/1024/1024).toFixed(1)}MB > 10MB)`)
        results.processingSteps.push('Textract: skipped (too large)')
      }

      // Tier 2: Try Tesseract for image-based PDFs
      if (this.config.tesseractAvailable) {
        console.log(`🖼️ Tier 2: Attempting Tesseract OCR`)

        try {
          const tesseractResult = await this.extractWithTesseract(tempFile)
          if (tesseractResult.success && tesseractResult.text.length > 0) {
            results.extractedText = tesseractResult.text
            results.method = 'tesseract'
            results.success = true
            results.processingSteps.push(`Tesseract: ${tesseractResult.text.length} chars`)

            // Cleanup and return success
            this.cleanupTempFile(tempFile)
            console.log(`✅ Tesseract extraction successful: ${results.extractedText.length} characters`)
            return results
          }
          results.processingSteps.push('Tesseract: failed/empty')
        } catch (error) {
          console.log(`⚠️ Tesseract failed: ${error.message}`)
          results.processingSteps.push(`Tesseract: error - ${error.message}`)
        }
      } else {
        console.log(`⏭️ Tesseract not available`)
        results.processingSteps.push('Tesseract: not available')
      }

      // Tier 3: Basic PDF text extraction (final fallback)
      console.log(`📝 Tier 3: Attempting basic PDF text extraction`)

      try {
        const basicResult = await this.extractWithBasicPDF(tempFile)
        if (basicResult.success) {
          results.extractedText = basicResult.text
          results.method = 'basic-pdf'
          results.success = true
          results.processingSteps.push(`Basic PDF: ${basicResult.text.length} chars`)

          console.log(`✅ Basic extraction successful: ${results.extractedText.length} characters`)
        } else {
          results.processingSteps.push('Basic PDF: failed')
          console.log(`❌ All extraction methods failed`)
        }
      } catch (error) {
        console.log(`❌ Basic extraction failed: ${error.message}`)
        results.processingSteps.push(`Basic PDF: error - ${error.message}`)
      }

      // Cleanup
      this.cleanupTempFile(tempFile)

      console.log(`🏁 Multi-OCR complete: ${results.method} - ${results.extractedText.length} chars`)
      console.log(`📋 Steps: ${results.processingSteps.join(' → ')}`)

      return results

    } catch (error) {
      console.error(`💥 Multi-OCR processing error: ${error.message}`)
      results.processingSteps.push(`Fatal error: ${error.message}`)
      return results
    }
  }

  /**
   * Extract text using AWS Textract (integrate with existing service)
   */
  async extractWithTextract(tempFile, pdfKey) {
    try {
      // Use existing ClaudeContactExtractor's Textract method
      const ClaudeContactExtractor = require('./ClaudeContactExtractor.cjs')

      const extractor = new ClaudeContactExtractor({
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        awsRegion: process.env.AWS_REGION,
        awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      })

      // Call the existing Textract method
      const textractResult = await extractor.extractTextWithTextract(tempFile, pdfKey)

      return {
        success: textractResult.extractedText && textractResult.extractedText.length > 0,
        text: textractResult.extractedText || '',
        tables: textractResult.tables || [],
        forms: textractResult.forms || []
      }

    } catch (error) {
      console.log(`⚠️ Textract integration error: ${error.message}`)
      return {
        success: false,
        text: '',
        error: error.message
      }
    }
  }

  /**
   * Extract text using Tesseract OCR
   */
  async extractWithTesseract(pdfPath) {
    try {
      console.log(`🔄 Converting PDF to images for Tesseract processing...`)

      // Step 1: Convert PDF to images using ImageMagick or Poppler
      const imageDir = path.join(this.config.tempDir, `images_${Date.now()}`)
      fs.mkdirSync(imageDir, { recursive: true })

      let convertCommand

      // Try ImageMagick first, fallback to Poppler
      try {
        // ImageMagick command
        convertCommand = [
          'convert',
          '-density', this.config.imageQuality,
          '-quality', '100',
          pdfPath,
          path.join(imageDir, 'page-%03d.png')
        ].join(' ')

        execSync(convertCommand, { stdio: 'pipe' })
        console.log(`✅ PDF converted to images using ImageMagick`)

      } catch (imageMagickError) {
        console.log(`⚠️ ImageMagick failed, trying Poppler...`)

        // Poppler pdftoppm command
        convertCommand = [
          'pdftoppm',
          '-png',
          '-r', this.config.imageQuality,
          pdfPath,
          path.join(imageDir, 'page')
        ].join(' ')

        execSync(convertCommand, { stdio: 'pipe' })
        console.log(`✅ PDF converted to images using Poppler`)
      }

      // Step 2: Get list of generated images
      const imageFiles = fs.readdirSync(imageDir)
        .filter(file => file.endsWith('.png'))
        .sort()
        .map(file => path.join(imageDir, file))

      if (imageFiles.length === 0) {
        throw new Error('No images generated from PDF')
      }

      console.log(`📸 Generated ${imageFiles.length} images from PDF`)

      // Step 3: Process each image with Tesseract
      let allText = ''
      let processedPages = 0

      for (const imagePath of imageFiles) {
        try {
          console.log(`🔍 OCR processing: ${path.basename(imagePath)}`)

          // Preprocess image if enabled
          let processedImagePath = imagePath
          if (this.config.preprocessImages) {
            processedImagePath = await this.preprocessImage(imagePath)
          }

          // Run Tesseract OCR
          const outputPath = processedImagePath.replace('.png', '')
          const tesseractCommand = [
            'tesseract',
            processedImagePath,
            outputPath,
            '-l', this.config.tesseractLang,
            '--oem', '3', // Use LSTM OCR Engine Mode
            '--psm', '6', // Assume uniform block of text
            'quiet'
          ].join(' ')

          execSync(tesseractCommand, { stdio: 'pipe' })

          // Read the extracted text
          const textFile = outputPath + '.txt'
          if (fs.existsSync(textFile)) {
            const pageText = fs.readFileSync(textFile, 'utf8')
            allText += pageText + '\n\n'
            processedPages++

            // Cleanup text file
            fs.unlinkSync(textFile)
          }

          // Cleanup preprocessed image if different from original
          if (processedImagePath !== imagePath && fs.existsSync(processedImagePath)) {
            fs.unlinkSync(processedImagePath)
          }

        } catch (pageError) {
          console.log(`⚠️ Failed to process ${path.basename(imagePath)}: ${pageError.message}`)
        }
      }

      // Cleanup image directory
      this.cleanupDirectory(imageDir)

      const cleanedText = allText.trim()
      console.log(`✅ Tesseract processed ${processedPages}/${imageFiles.length} pages, extracted ${cleanedText.length} characters`)

      return {
        success: cleanedText.length > 0,
        text: cleanedText,
        pagesProcessed: processedPages,
        totalPages: imageFiles.length
      }

    } catch (error) {
      console.error(`❌ Tesseract extraction failed: ${error.message}`)
      return {
        success: false,
        text: '',
        error: error.message
      }
    }
  }

  /**
   * Preprocess images to improve OCR accuracy
   */
  async preprocessImage(imagePath) {
    try {
      const preprocessedPath = imagePath.replace('.png', '_processed.png')

      // ImageMagick preprocessing: enhance contrast, reduce noise
      const preprocessCommand = [
        'convert',
        imagePath,
        '-enhance',
        '-contrast-stretch', '0.15x0.05%',
        '-colorspace', 'gray',
        '-blur', '0x0.5',
        '-sharpen', '0x1',
        preprocessedPath
      ].join(' ')

      execSync(preprocessCommand, { stdio: 'pipe' })
      console.log(`🎨 Preprocessed image: ${path.basename(preprocessedPath)}`)

      return preprocessedPath
    } catch (error) {
      console.log(`⚠️ Image preprocessing failed: ${error.message}, using original`)
      return imagePath
    }
  }

  /**
   * Extract text using basic PDF parsing
   */
  async extractWithBasicPDF(pdfPath) {
    try {
      const dataBuffer = fs.readFileSync(pdfPath)
      const data = await pdf(dataBuffer)

      const cleanedText = data.text.replace(/\s+/g, ' ').trim()

      console.log(`📄 Basic PDF extraction: ${cleanedText.length} characters from ${data.numpages} pages`)

      return {
        success: cleanedText.length > 0,
        text: cleanedText,
        pages: data.numpages
      }
    } catch (error) {
      console.error(`❌ Basic PDF extraction failed: ${error.message}`)
      return {
        success: false,
        text: '',
        error: error.message
      }
    }
  }

  /**
   * Cleanup utilities
   */
  cleanupTempFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch (error) {
      console.warn(`⚠️ Failed to cleanup temp file ${filePath}: ${error.message}`)
    }
  }

  cleanupDirectory(dirPath) {
    try {
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath)
        files.forEach(file => {
          fs.unlinkSync(path.join(dirPath, file))
        })
        fs.rmdirSync(dirPath)
      }
    } catch (error) {
      console.warn(`⚠️ Failed to cleanup directory ${dirPath}: ${error.message}`)
    }
  }

  /**
   * Get OCR service status and capabilities
   */
  getStatus() {
    return {
      tesseractAvailable: this.config.tesseractAvailable,
      tempDir: this.config.tempDir,
      configuration: {
        textractLimit: `${(this.config.textractLimit/1024/1024).toFixed(1)}MB`,
        maxFileSize: `${(this.config.maxFileSize/1024/1024).toFixed(1)}MB`,
        imageQuality: `${this.config.imageQuality}DPI`,
        language: this.config.tesseractLang,
        preprocessing: this.config.preprocessImages
      }
    }
  }
}

module.exports = OCRService