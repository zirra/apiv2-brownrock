require('dotenv').config()
const axios = require('axios')
const fs = require('fs')
const { Upload } = require('@aws-sdk/lib-storage')
const {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand
} = require("@aws-sdk/client-s3")

class S3Service {
  constructor(authService, loggingService) {
    this.authService = authService
    this.loggingService = loggingService
    
    const credentials = { 
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
    
    this.bucketName = 'ocdpdfs'
    this.outputBucketName = process.env.PROCESSED_BUCKET || 'ocd-processed-contacts'
    this.s3Client = new S3Client({ region: 'us-east-1', credentials })
  }

  async fileExists(key) {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      })
      await this.s3Client.send(command)
      console.log(`✅ File "${key}" exists in bucket "${this.bucketName}".`)
      return true;
    } catch (err) {
      if (err.name === "NotFound") {
        console.log(`❌ File "${key}" does not exist in bucket "${this.bucketName}".`)
        return false
      }
      console.error("Error checking file:", err)
      throw err
    }
  }

  async uploadToS3(url, outputDir) {
    console.log('EARL: ' + outputDir)
    try {
      const response = await axios.get(url, 
      { 
        headers: {
          Authorization: `Bearer ${this.authService.getToken()}`
        },
        responseType: 'stream'
      })
      
      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucketName,
          Key: outputDir,
          Body: response.data,
          ContentType: 'application/pdf',
          ACL: 'public-read'
        },
      })
      
      upload.on('httpUploadProgress', (progress) => {
        console.log(`Uploaded ${progress.loaded} bytes...`)
      })
      
      await upload.done()
      console.log(`File uploaded to S3 as: ${outputDir}`)
    } catch (err) {
      console.error('Error:', err.message)
      await this.loggingService.writeMessage('uploadError', err.message)
      await this.authService.writeDynamoMessage({ 
        pkey: 'uploadToS3#error',
        skey: 'error',
        origin: 'uploadToS3', 
        type:'system', 
        data: err.message
      })
    }
  }

  /**
   * Upload local file to S3
   */
  async uploadFileToS3(filePath, s3Key) {
    try {
      console.log(`☁️ Uploading local file ${filePath} to S3 as ${s3Key}...`)

      const fileBuffer = fs.readFileSync(filePath)

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: 'application/pdf',
        ServerSideEncryption: 'AES256',
        ACL: 'public-read'
      })

      await this.s3Client.send(command)
      console.log(`✅ Successfully uploaded ${filePath} to s3://${this.bucketName}/${s3Key}`)
      return true

    } catch (error) {
      console.error(`❌ Failed to upload ${filePath} to S3: ${error.message}`)
      await this.loggingService.writeMessage('uploadFileError', error.message)
      await this.authService.writeDynamoMessage({
        pkey: 'uploadFileToS3#error',
        skey: 'error',
        origin: 'uploadFileToS3',
        type: 'system',
        data: error.message
      })
      throw error
    }
  }

  /**
   * Upload buffer to S3 (alternative method)
   */
  async uploadBufferToS3(buffer, s3Key) {
    try {
      console.log(`☁️ Uploading buffer to S3 as ${s3Key}...`)

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: buffer,
        ContentType: 'application/pdf',
        ServerSideEncryption: 'AES256',
        ACL: 'public-read'
      })

      await this.s3Client.send(command)
      console.log(`✅ Successfully uploaded buffer to s3://${this.bucketName}/${s3Key}`)
      return true

    } catch (error) {
      console.error(`❌ Failed to upload buffer to S3: ${error.message}`)
      throw error
    }
  }

  async listFiles(folder = 'pdfs') {
    const prefix = folder.replace(/\/?$/, '/')
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
    })

    const response = await this.s3Client.send(command)
    const results = []

    if (response.Contents && response.Contents.length > 0) {
      response.Contents.forEach((item) => {
        if (item.Key.endsWith('/')) return

        let splitarr = item.Key.split('/')
        let location = `${splitarr[1]}`
        let url = `${process.env.S3_ROOT}${item.Key}`
        item.Url = url
        item.Location = location
        results.push(item)
      })
    }

    return results
  }

  async getFileMetadata(key) {
    const command = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    })

    const metadata = await this.s3Client.send(command)

    return {
      Key: key,
      LastModified: metadata.LastModified,
      ContentLength: metadata.ContentLength,
      ContentType: metadata.ContentType,
      ETag: metadata.ETag,
      Url: `${process.env.S3_ROOT}${key}`,
    }
  }

  async downloadCSVFromS3(key) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key
      })

      const response = await this.s3Client.send(command)
      
      // Convert stream to string
      const chunks = []
      for await (const chunk of response.Body) {
        chunks.push(chunk)
      }
      
      return Buffer.concat(chunks).toString('utf-8')
      
    } catch (error) {
      console.error(`Error downloading CSV ${key}:`, error.message)
      throw error
    }
  }

  async moveFileToProcessedBucket(sourceKey, targetBucket) {
    try {
      // If same bucket, move to processed/ folder, otherwise move to different bucket
      const isSameBucket = targetBucket === this.bucketName
      const targetKey = isSameBucket ? `processed/${sourceKey}` : sourceKey

      // Copy file to processed location
      const copyCommand = new CopyObjectCommand({
        Bucket: targetBucket,
        Key: targetKey,
        CopySource: `${this.bucketName}/${sourceKey}`,
        ACL: 'public-read'
      })

      await this.s3Client.send(copyCommand)

      // Delete from source location (only if actually moved)
      if (!isSameBucket || targetKey !== sourceKey) {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: sourceKey
        })

        await this.s3Client.send(deleteCommand)
      }
      
      console.log(`🔄 Moved ${sourceKey} → ${targetKey} (${targetBucket})`)
      
    } catch (error) {
      console.error(`💥 Error moving file ${sourceKey}:`, error.message)
      throw error
    }
  }

  async moveProcessedFiles(pdfKeys) {
    const processedBucket = process.env.PROCESSED_BUCKET || 'ocd-processed-contacts'
    
    console.log(`📁 Moving ${pdfKeys.length} processed files to ${processedBucket}...`)
    
    let movedCount = 0
    let errorCount = 0
    const errors = []

    for (const pdfKey of pdfKeys) {
      try {
        await this.moveFileToProcessedBucket(pdfKey, processedBucket)
        movedCount++
        console.log(`✅ Moved: ${pdfKey}`)
      } catch (error) {
        errorCount++
        errors.push({ file: pdfKey, error: error.message })
        console.error(`❌ Failed to move ${pdfKey}: ${error.message}`)
      }
    }

    await this.authService.writeDynamoMessage({
      pkey: 'file#movement',
      skey: 'batch#complete',
      origin: 'fileMovement',
      type: 'system',
      data: `Moved ${movedCount} files, ${errorCount} errors`
    })

    return {
      success: errorCount === 0,
      movedCount,
      errorCount,
      errors,
      message: `Moved ${movedCount}/${pdfKeys.length} files successfully`
    }
  }
}

module.exports = S3Service