require('dotenv').config()
const ClaudeContactExtractor = require('./ClaudeContactExtractor.cjs')

class PDFService {

  constructor(authService, s3Service, loggingService) {
    this.authService = authService
    this.s3Service = s3Service
    this.loggingService = loggingService
    
    // Initialize PDF Contact Service
    this.pdfContactService = new ClaudeContactExtractor({
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      awsRegion: process.env.AWS_REGION,
      awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    })

  }

  async processContactsFromPdfs(pdfKeys) {
    if (!pdfKeys || pdfKeys.length === 0) {
      console.log('📭 No PDF files to process for contact extraction')
      await this.loggingService.writeMessage('contactExtraction', 'No files to process')

      await this.authService.writeDynamoMessage({ 
        pkey: 'proccessContactsFromPdfs#error',
        skey: 'error',
        origin: 'processContactsFromPdfs', 
        type:'system', 
        data: 'no files to process'
      })

      return { success: false, message: 'No files provided' }
    }
    
    console.log(`🔍 Starting contact extraction from ${pdfKeys.length} PDF files...`)
    await this.loggingService.writeMessage('contactExtraction', `Starting extraction from ${pdfKeys.length} files`)

    try {
      // Generate timestamp for output file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outputKey = `extracted_contacts_${timestamp}.csv`
      
      // Use the processFromAPI method which is the main integration point
      const result = await this.pdfContactService.processFromAPI({
        sourceBucket: this.s3Service.bucketName,
        outputBucket: this.s3Service.bucketName,
        pdfKeys: pdfKeys,
        outputKey: outputKey
      })

      if (result.success) {
        console.log(`✅ Contact extraction completed successfully!`)
        console.log(`📊 Extracted ${result.contactCount} contacts from ${result.filesProcessed} files`)
        console.log(`📁 Results saved to: ${result.outputLocation}`)
        
        await this.loggingService.writeMessage('contactExtraction', 
          `SUCCESS: Extracted ${result.contactCount} contacts from ${result.filesProcessed} files. Saved to ${result.outputLocation}`)
        
        await this.authService.writeDynamoMessage({ 
          pkey: 'processContactsFromPdfs#success',
          skey: 'success',
          origin: 'processContactsFromPdfs', 
          type:'system', 
          data: `SUCCESS: Extracted ${result.contactCount} contacts from ${result.filesProcessed} files. Saved to ${result.outputLocation}`
        })

        // Move processed files to processed bucket
        console.log('📦 Moving processed PDF files...')
        
        await this.authService.writeDynamoMessage({
          pkey: 'file#movement',
          skey: 'start',
          origin: 'processContactsFromPdfs',
          type: 'system',
          data: `Starting to move ${pdfKeys.length} processed files`
        })

        const moveResult = await this.s3Service.moveProcessedFiles(pdfKeys)
        
        if (moveResult.success) {
          console.log(`✅ Successfully moved all ${moveResult.movedCount} processed files`)
          
          await this.authService.writeDynamoMessage({
            pkey: 'file#movement',
            skey: 'success',
            origin: 'processContactsFromPdfs',
            type: 'system',
            data: `Successfully moved ${moveResult.movedCount} files`
          })
        } else {
          console.log(`⚠️ File movement completed with ${moveResult.errorCount} errors`)
          console.log(`✅ Successfully moved ${moveResult.movedCount} files`)
          
          await this.authService.writeDynamoMessage({
            pkey: 'file#movement',
            skey: 'partial#success',
            origin: 'processContactsFromPdfs',
            type: 'system',
            data: `Moved ${moveResult.movedCount}/${pdfKeys.length} files, ${moveResult.errorCount} errors`
          })
        }

        // Add movement results to the return object
        result.fileMovement = moveResult

        return result
      } else {
        console.log(`❌ Contact extraction failed: ${result.message}`)
        await this.loggingService.writeMessage('contactExtraction', `FAILED: ${result.message}`)

        await this.authService.writeDynamoMessage({ 
          pkey: 'processContactsFromPdfs#error',
          skey: 'error#extractionFailed',
          origin: 'processContactsFromPdfs', 
          type:'system', 
          data: `FAILED: ${result.message}`
        })

        return result
      }

    } catch (error) {
      console.error(`💥 Contact extraction error: ${error.message}`)
      await this.loggingService.writeMessage('contactExtraction', `ERROR: ${error.message}`)

      await this.authService.writeDynamoMessage({ 
          pkey: 'processContactsFromPdfs#error',
          skey: 'error#extractionFailed#error',
          origin: 'processContactsFromPdfs', 
          type:'system', 
          data: `FAILED: ${error.message}`
        })

      return { 
        success: false, 
        message: `Contact extraction failed: ${error.message}` 
      }
    }
  }

  async processSingleFile(pdfKey, outputBucket) {
    try {
      // Use your existing extractor instance
      let split = pdfKey.split('/')
      let target = `${split[1]}_${split[2]}`
      target = target.replace('.pdf','')

      const contacts = await this.pdfContactService.processSinglePDF(
        this.s3Service.bucketName,
        pdfKey
      );

      if (contacts.length > 0) {
        let postgresResult = null;

        // Try PostgreSQL first if configured
        if (this.pdfContactService.processingConfig.usePostgres) {
          console.log(`💾 Saving ${contacts.length} contacts to PostgreSQL...`);
          postgresResult = await this.pdfContactService.saveContactsToPostgres(contacts);
        }

        // Fallback to CSV if requested or PostgreSQL failed
        if (outputBucket && (!this.pdfContactService.processingConfig.usePostgres || !postgresResult?.success)) {
          console.log(`📄 Saving ${contacts.length} contacts to CSV backup...`);
          const csvContent = this.pdfContactService.convertToCSV(contacts);
          const outputKey = `${target}_${Date.now()}.csv`;

          await this.pdfContactService.uploadCSVToS3(csvContent, outputBucket, outputKey);
        }

        return {
          success: true,
          contactCount: contacts.length,
          contacts: contacts,
          postgresResult: postgresResult
        };
      }

      return {
        success: true,
        contactCount: contacts.length,
        contacts: contacts
      };

    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  }
}

module.exports = PDFService