require('dotenv').config()
const Papa = require('papaparse')
const DynamoClient = require('../config/dynamoclient.cjs')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand
} = require('@aws-sdk/lib-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb')

class ContactService {
  constructor(authService, s3Service) {
    this.authService = authService
    this.s3Service = s3Service
    this.TableName = process.env.DYNAMO_TABLE
    
    const dbcredentials = { 
      accessKeyId: process.env.DYNACC_KEY_ID,
      secretAccessKey: process.env.DYNACC_SEC_ID
    }
    this.client = new DynamoDBClient({region: 'us-east-1', credentials: dbcredentials});
    this.myDynamoClient = DynamoDBDocumentClient.from(this.client);
  }

  cleanRecordForDynamo(record) {
    const cleaned = {}
    
    for (const [key, value] of Object.entries(record)) {
      // Skip empty or null values
      if (value === null || value === undefined || value === '') {
        continue
      }
      
      // Clean the key name (DynamoDB doesn't like certain characters)
      const cleanKey = key.replace(/[^a-zA-Z0-9_]/g, '_')
      
      // Convert value to string and trim whitespace
      let cleanValue = String(value).trim()
      
      // Skip if still empty after trimming
      if (cleanValue === '') {
        continue
      }
      
      // Handle boolean-like strings
      if (cleanValue.toLowerCase() === 'true') {
        cleaned[cleanKey] = true
      } else if (cleanValue.toLowerCase() === 'false') {
        cleaned[cleanKey] = false
      } else {
        // Keep as string
        cleaned[cleanKey] = cleanValue
      }
    }
    
    return cleaned
  }

  async processCSVsToDynamo() {
    console.log('📊 Starting CSV processing to DynamoDB...')
    
    try {
      // List all CSV files in the claude-csv bucket/folder
      const csvFiles = await this.s3Service.listFiles('claude-csv')
      
      if (csvFiles.length === 0) {
        console.log('📭 No CSV files found in claude-csv folder')
        await this.authService.writeDynamoMessage({
          pkey: 'csv#processing',
          skey: 'no#files',
          origin: 'csvProcessor',
          type: 'system',
          data: 'No CSV files found to process'
        })
        return { success: false, message: 'No CSV files found' }
      }

      let totalRecordsProcessed = 0
      let filesProcessed = 0
      const validCsvFiles = csvFiles.filter(item => 
        item.Key.endsWith('.csv') && !item.Key.endsWith('/')
      )

      console.log(`📁 Found ${validCsvFiles.length} CSV files to process`)

      for (const csvFile of validCsvFiles) {
        try {
          console.log(`🔄 Processing CSV: ${csvFile.Key}`)
          
          // Download CSV content from S3
          const csvContent = await this.s3Service.downloadCSVFromS3(csvFile.Key)
          
          // Parse CSV and process records
          const recordsProcessed = await this.parseAndStoreCsvData(csvContent, csvFile.Key)
          
          totalRecordsProcessed += recordsProcessed
          filesProcessed++
          
          console.log(`✅ Processed ${recordsProcessed} records from ${csvFile.Key}`)
          
        } catch (fileError) {
          console.error(`❌ Error processing file ${csvFile.Key}: ${fileError.message}`)
          await this.authService.writeDynamoMessage({
            pkey: 'csv#processing',
            skey: 'file#error',
            origin: 'csvProcessor',
            type: 'error',
            data: `Error processing ${csvFile.Key}: ${fileError.message}`
          })
        }
      }

      const result = {
        success: true,
        filesProcessed,
        totalRecordsProcessed,
        message: `Successfully processed ${totalRecordsProcessed} records from ${filesProcessed} CSV files`
      }

      console.log(`✅ CSV processing completed: ${result.message}`)
      
      await this.authService.writeDynamoMessage({
        pkey: 'csv#processing',
        skey: 'success',
        origin: 'csvProcessor',
        type: 'system',
        data: result.message
      })

      return result

    } catch (error) {
      console.error('💥 CSV processing failed:', error.message)
      
      await this.authService.writeDynamoMessage({
        pkey: 'csv#processing',
        skey: 'error',
        origin: 'csvProcessor',
        type: 'error',
        data: `CSV processing failed: ${error.message}`
      })

      return {
        success: false,
        message: `CSV processing failed: ${error.message}`
      }
    }
  }

  async parseAndStoreCsvData(csvContent, fileName) {
    try {
      const parseResult = Papa.parse(csvContent, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false, // Keep as strings to avoid type issues
        transformHeader: (header) => header.trim()
      })

      if (parseResult.errors.length > 0) {
        console.warn(`⚠️ CSV parsing warnings for ${fileName}:`, parseResult.errors)
      }

      const records = parseResult.data
      console.log(`📋 Parsed ${records.length} records from ${fileName}`)

      let recordsStored = 0

      // Process records in batches
      const batchSize = 25
      
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize)
        
        for (const record of batch) {
          try {
            // Skip empty records
            if (!record || Object.keys(record).length === 0) continue

            // Clean and prepare the record for DynamoDB
            const cleanedRecord = this.cleanRecordForDynamo(record)
            
            // Create DynamoDB item with cleaned CSV data plus additional fields
            const dynamoItem = {
              ...cleanedRecord,
              acknowledged: false,
              islegal: false,
              processedAt: new Date().toISOString(),
              sourceFile: fileName,
              pkey: `contact#${Date.now()}#${Math.random().toString(36).substr(2, 9)}`,
              skey: `${fileName.replace(/[^a-zA-Z0-9]/g, '_')}#${recordsStored + 1}`
            }

            await DynamoClient.addItem({
              TableName: this.TableName,
              Item: dynamoItem
            })

            recordsStored++

          } catch (recordError) {
            console.error(`❌ Error storing record ${recordsStored + 1}: ${recordError.message}`)
            console.error('Problematic record:', JSON.stringify(record, null, 2))
          }
        }

        // Add delay between batches
        if (i + batchSize < records.length) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }

      return recordsStored

    } catch (error) {
      console.error(`Error parsing CSV data from ${fileName}:`, error.message)
      throw error
    }
  }

  async queryContacts(options = {}) {
    const {
      limit = 25,
      lastEvaluatedKey = null,
      filters = {}
    } = options;

    try {
      const scanParams = {
        TableName: this.TableName,
        Limit: limit,
      };

      // Base filter expression
      const filterExpressions = ['begins_with(pkey, :contactPrefix)'];
      const expressionAttributeValues = {
        ':contactPrefix': 'contact#',
      };
      const expressionAttributeNames = {};

      // Pagination
      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }

      // Optional filters
      if (filters.company) {
        filterExpressions.push('contains(#company, :company)');
        expressionAttributeNames['#company'] = 'company';
        expressionAttributeValues[':company'] = filters.company;
      }

      if (filters.record_type) {
        filterExpressions.push('#record_type = :record_type');
        expressionAttributeNames['#record_type'] = 'record_type';
        expressionAttributeValues[':record_type'] = filters.record_type;
      }

      if (filters.acknowledged !== undefined) {
        filterExpressions.push('#acknowledged = :acknowledged');
        expressionAttributeNames['#acknowledged'] = 'acknowledged';
        expressionAttributeValues[':acknowledged'] = filters.acknowledged;
      }

      if (filters.islegal !== undefined) {
        filterExpressions.push('#islegal = :islegal');
        expressionAttributeNames['#islegal'] = 'islegal';
        expressionAttributeValues[':islegal'] = filters.islegal;
      }

      // Final filter expression
      scanParams.FilterExpression = filterExpressions.join(' AND ');
      scanParams.ExpressionAttributeValues = expressionAttributeValues;

      if (Object.keys(expressionAttributeNames).length > 0) {
        scanParams.ExpressionAttributeNames = expressionAttributeNames;
      }

      // Execute the scan
      const response = await this.myDynamoClient.send(new ScanCommand(scanParams));

      const items = response.Items || [];

      const hasMore = !!response.LastEvaluatedKey;
      const nextPageKey = hasMore
        ? encodeURIComponent(JSON.stringify(response.LastEvaluatedKey))
        : null;

      return {
        success: true,
        contacts: items,
        pagination: {
          hasMore,
          nextPageKey,
          itemCount: items.length,
          requestedLimit: limit,
        },
        appliedFilters: filters,
      };

    } catch (error) {
      console.error('Error querying contacts:', error);
      return {
        success: false,
        message: `Query failed: ${error.message}`,
        contacts: [],
        pagination: {
          hasMore: false,
          nextPageKey: null,
          itemCount: 0,
        },
      };
    }
  }

  async queryContactStatistics() {
    try {
      const { ScanCommand } = require('@aws-sdk/client-dynamodb')

      const scanParams = {
        TableName: this.TableName,
        FilterExpression: 'begins_with(pkey, :contactPrefix)',
        ExpressionAttributeValues: marshall({
          ':contactPrefix': 'contact#'
        }),
        Select: 'ALL_ATTRIBUTES'
      }

      const command = new ScanCommand(scanParams)
      const response = await DynamoClient.dynamoClient.send(command)

      const items = response.Items ? response.Items.map(item => unmarshall(item)) : []

      // Calculate statistics
      const stats = {
        total: items.length,
        acknowledged: items.filter(item => item.acknowledged === true).length,
        legal: items.filter(item => item.islegal === true).length,
        byRecordType: {},
        byCompany: {},
        processed_today: 0
      }

      // Count by record type and company
      const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD format

      items.forEach(item => {
        // Count by record type
        if (item.record_type) {
          stats.byRecordType[item.record_type] = (stats.byRecordType[item.record_type] || 0) + 1
        }

        // Count by company
        if (item.company) {
          stats.byCompany[item.company] = (stats.byCompany[item.company] || 0) + 1
        }

        // Count processed today
        if (item.processedAt && item.processedAt.startsWith(today)) {
          stats.processed_today++
        }
      })

      return {
        success: true,
        statistics: stats
      }

    } catch (error) {
      console.error('Error calculating contact statistics:', error.message)
      return {
        success: false,
        message: `Statistics calculation failed: ${error.message}`
      }
    }
  }

  async updateContact(pkey, skey, updates) {
    try {
      const updateExpressions = []
      const expressionAttributeValues = {}
      const expressionAttributeNames = {}

      if (updates.acknowledged !== undefined) {
        updateExpressions.push('#acknowledged = :acknowledged')
        expressionAttributeNames['#acknowledged'] = 'acknowledged'
        expressionAttributeValues[':acknowledged'] = updates.acknowledged
      }

      if (updates.islegal !== undefined) {
        updateExpressions.push('#islegal = :islegal')
        expressionAttributeNames['#islegal'] = 'islegal'
        expressionAttributeValues[':islegal'] = updates.islegal
      }

      if (updateExpressions.length === 0) {
        return {
          success: false,
          message: 'No valid updates provided'
        }
      }

      // Add updated timestamp
      updateExpressions.push('#updatedAt = :updatedAt')
      expressionAttributeNames['#updatedAt'] = 'updatedAt'
      expressionAttributeValues[':updatedAt'] = new Date().toISOString()

      const updateParams = {
        TableName: this.TableName,
        Key: marshall({ pkey, skey }),
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues),
        ReturnValues: 'ALL_NEW'
      }

      const command = new UpdateCommand(updateParams)
      const response = await DynamoClient.dynamoClient.send(command)

      return {
        success: true,
        message: 'Contact updated successfully',
        updatedItem: response.Attributes ? unmarshall(response.Attributes) : null
      }

    } catch (error) {
      console.error('Error updating contact:', error.message)
      return {
        success: false,
        message: `Update failed: ${error.message}`
      }
    }
  }
}

module.exports = ContactService