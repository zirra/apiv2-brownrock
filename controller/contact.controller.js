require('dotenv').config()
const fs = require('fs')
//const authenticateJWT = require('../config/authenticate.cjs')

// Import services
const AuthService = require('../services/auth.service.js')
const S3Service = require('../services/s3.service.js')
const LoggingService = require('../services/logging.service.js')
const ContactService = require('../services/contact.service.js')
const PostgresContactService = require('../services/postgres-contact.service.js')

class ContactController {
  constructor() {
    // Initialize services
    this.loggingService = new LoggingService()
    this.authService = new AuthService()
    this.s3Service = new S3Service(this.authService, this.loggingService)
    this.contactService = new ContactService(this.authService, this.s3Service)
    this.postgresContactService = new PostgresContactService()
  }

  // DynamoDB Contact Management
  async getContacts(req, res) {
    try {
      const {
        limit = 25,
        lastEvaluatedKey,
        company,
        record_type,
        acknowledged,
        islegal
      } = req.query

      const result = await this.contactService.queryContacts({
        limit: parseInt(limit),
        lastEvaluatedKey: lastEvaluatedKey ? JSON.parse(decodeURIComponent(lastEvaluatedKey)) : null,
        filters: {
          company,
          record_type,
          acknowledged: acknowledged !== undefined ? acknowledged === 'true' : undefined,
          islegal: islegal !== undefined ? islegal === 'true' : undefined
        }
      })

      res.status(200).json(result)

    } catch (error) {
      console.error('Error fetching contacts:', error.message)
      res.status(500).json({
        success: false,
        message: `Error fetching contacts: ${error.message}`
      })
    }
  }

  async getContactStats(req, res) {
    try {
      const stats = await this.contactService.queryContactStatistics()
      res.status(200).json(stats)
    } catch (error) {
      console.error('Error fetching contact stats:', error.message)
      res.status(500).json({
        success: false,
        message: `Error fetching stats: ${error.message}`
      })
    }
  }

  async updateContactStatus(req, res) {
    try {
      const { pkey, skey, acknowledged, islegal } = req.body

      if (!pkey || !skey) {
        return res.status(400).json({
          success: false,
          message: 'pkey and skey are required'
        })
      }

      const updateResult = await this.contactService.updateContact(pkey, skey, { acknowledged, islegal })

      res.status(updateResult.success ? 200 : 400).json(updateResult)

    } catch (error) {
      console.error('Error updating contact:', error.message)
      res.status(500).json({
        success: false,
        message: `Update failed: ${error.message}`
      })
    }
  }

  // PostgreSQL Contact Management
  async getPostgresContacts(req, res) {
    try {
      // Check if service exists
      if (!this.postgresContactService) {
        return res.status(500).json({
          success: false,
          message: 'PostgresContactService not initialized'
        })
      }

      const {
        limit = 25,
        offset = 0,
        name,
        company,
        acknowledged,
        islegal,
        city,
        state,
        search,
        requireFirstName,
        requireLastName,
        requireBothNames,
        sortBy = 'created_at',
        sortOrder = 'DESC'
      } = req.query

      const result = await this.postgresContactService.searchContacts({
        limit: parseInt(limit),
        offset: parseInt(offset),
        name,
        company,
        acknowledged: acknowledged !== undefined ? acknowledged === 'true' : undefined,
        islegal: islegal !== undefined ? islegal === 'true' : undefined,
        city,
        state,
        search,
        requireFirstName: requireFirstName === 'true',
        requireLastName: requireLastName === 'true',
        requireBothNames: requireBothNames === 'true',
        sortBy,
        sortOrder: sortOrder.toUpperCase()
      })

      res.status(200).json(result)

    } catch (error) {
      console.error('Error fetching PostgreSQL contacts:', error.message)
      res.status(500).json({
        success: false,
        message: `Error fetching contacts: ${error.message}`
      })
    }
  }

  async getPostgresContactStats(req, res) {
    try {
      // Check if service exists
      if (!this.postgresContactService) {
        return res.status(500).json({
          success: false,
          message: 'PostgresContactService not initialized'
        })
      }

      const result = await this.postgresContactService.getContactStats()
      res.status(200).json(result)

    } catch (error) {
      console.error('Error fetching PostgreSQL contact stats:', error.message)
      res.status(500).json({
        success: false,
        message: `Error fetching stats: ${error.message}`
      })
    }
  }

  async exportPostgresContactsCSV(req, res) {
    try {
      // Check if service exists
      if (!this.postgresContactService) {
        return res.status(500).json({
          success: false,
          message: 'PostgresContactService not initialized'
        })
      }

      const {
        name,
        company,
        acknowledged,
        islegal,
        city,
        state,
        requireFirstName,
        requireLastName,
        requireBothNames
      } = req.query

      // Fetch all contacts matching the filters (no pagination for export)
      const result = await this.postgresContactService.searchContacts({
        limit: 1000000, // Large limit to get all records
        offset: 0,
        name,
        company,
        acknowledged: acknowledged !== undefined ? acknowledged === 'true' : undefined,
        islegal: islegal !== undefined ? islegal === 'true' : undefined,
        city,
        state,
        requireFirstName: requireFirstName === 'true',
        requireLastName: requireLastName === 'true',
        requireBothNames: requireBothNames === 'true'
      })

      if (!result.success || !result.contacts || result.contacts.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No contacts found matching the criteria'
        })
      }

      // Convert to CSV format
      const Papa = require('papaparse')
      const csv = Papa.unparse(result.contacts, {
        header: true,
        columns: ['id', 'name', 'company', 'first_name', 'last_name', 'address', 'phone', 'fax', 'email', 'notes', 'record_type', 'document_section', 'source_file', 'acknowledged', 'islegal', 'created_at', 'updated_at']
      })

      // Set headers for CSV download
      const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', `attachment; filename="contacts-export-${timestamp}.csv"`)
      res.status(200).send(csv)

    } catch (error) {
      console.error('Error exporting PostgreSQL contacts to CSV:', error.message)
      res.status(500).json({
        success: false,
        message: `Error exporting contacts: ${error.message}`
      })
    }
  }

  // PostgreSQL CSV Processing
  async processCSVsToPostgres() {
    console.log('🐘 Starting CSV processing to PostgreSQL...')

    try {
      // List all CSV files in the claude-csv bucket/folder
      const csvFiles = await this.s3Service.listFiles('claude-csv')

      if (csvFiles.length === 0) {
        console.log('📭 No CSV files found in claude-csv folder for PostgreSQL processing')
        return { success: false, message: 'No CSV files found' }
      }

      let totalRecordsProcessed = 0
      let filesProcessed = 0
      const validCsvFiles = csvFiles.filter(item =>
        item.Key.endsWith('.csv') && !item.Key.endsWith('/')
      )

      console.log(`📁 Found ${validCsvFiles.length} CSV files to process for PostgreSQL`)

      for (const csvFile of validCsvFiles) {
        try {
          console.log(`🔄 Processing CSV for PostgreSQL: ${csvFile.Key}`)

          // Download CSV content from S3
          const csvContent = await this.s3Service.downloadCSVFromS3(csvFile.Key)

          // Parse CSV and extract contact data
          const contactsFromCsv = await this.parseCSVToContactFormat(csvContent, csvFile.Key)

          // Insert contacts into PostgreSQL
          const insertResult = await this.postgresContactService.bulkInsertContacts(contactsFromCsv)

          if (insertResult.success) {
            totalRecordsProcessed += insertResult.insertedCount
            filesProcessed++
            console.log(`✅ Processed ${insertResult.insertedCount} records from ${csvFile.Key} to PostgreSQL`)
          } else {
            console.error(`❌ Failed to insert contacts from ${csvFile.Key}: ${insertResult.error}`)
          }

        } catch (fileError) {
          console.error(`❌ Error processing file ${csvFile.Key} for PostgreSQL: ${fileError.message}`)
        }
      }

      const result = {
        success: true,
        filesProcessed,
        totalRecordsProcessed,
        message: `Successfully processed ${totalRecordsProcessed} records from ${filesProcessed} CSV files to PostgreSQL`
      }

      console.log(`✅ PostgreSQL CSV processing completed: ${result.message}`)
      return result

    } catch (error) {
      console.error('💥 PostgreSQL CSV processing failed:', error.message)
      return {
        success: false,
        message: `PostgreSQL CSV processing failed: ${error.message}`
      }
    }
  }

  async parseCSVToContactFormat(csvContent, fileName) {
    try {
      const Papa = require('papaparse')
      const parseResult = Papa.parse(csvContent, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        transformHeader: (header) => header.trim()
      })

      if (parseResult.errors.length > 0) {
        console.warn(`⚠️ CSV parsing warnings for ${fileName}:`, parseResult.errors)
      }

      const records = parseResult.data
      console.log(`📋 Parsed ${records.length} records from ${fileName} for PostgreSQL`)

      // Convert CSV records to Claude contact format expected by PostgresContactService
      const contacts = records.filter(record => record && Object.keys(record).length > 0).map(record => {
        // Safely combine first and last name
        const firstName = (record.first_name || '').trim()
        const lastName = (record.last_name || '').trim()
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || record.name || ''

        return {
          name: fullName,
          company: record.company || record.llc_owner || '',
          first_name: firstName,
          last_name: lastName,
          address: record.address || '',
          phone: record.phone1 || record.phone || '',
          fax: record.fax || '',
          email: record.email1 || record.email || '',
          notes: record.notes || '',
          record_type: record.record_type || null,
          document_section: record.document_section || null,
          source_file: record.source_file || fileName || null
        }
      })

      return contacts

    } catch (error) {
      console.error(`Error parsing CSV data from ${fileName} for PostgreSQL:`, error.message)
      throw error
    }
  }

  // Debug/Test Endpoints
  async testDynamoClient(req, res) {
    try {
      console.log('🧪 Testing DynamoClient...')
      res.status(200).json({
        success: true,
        message: 'DynamoClient test successful'
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        message: `DynamoClient test failed: ${error.message}`
      })
    }
  }

  async testContacts(req, res) {
    try {
      const result = await this.contactService.queryContacts({ limit: 5 })
      res.status(200).json(result)
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }

  async testPostgres(_req, res) {
    try {
      console.log('🧪 Testing PostgreSQL connection and model...')

      // Check if service exists
      if (!this.postgresContactService) {
        return res.status(500).json({
          success: false,
          message: 'PostgresContactService not initialized'
        })
      }

      const result = await this.postgresContactService.testConnection()
      res.status(200).json(result)
    } catch (error) {
      console.error('❌ testPostgres error:', error)
      res.status(500).json({
        success: false,
        message: error.message,
        stack: error.stack
      })
    }
  }

  async postgresStatus(_req, res) {
    res.json({
      postgresServiceExists: !!this.postgresContactService,
      serviceMethods: this.postgresContactService ?
        Object.getOwnPropertyNames(Object.getPrototypeOf(this.postgresContactService)) : [],
      timestamp: new Date().toISOString()
    })
  }

  async updatePostgresContactStatus(req, res) {
    try {
      // Check if service exists
      if (!this.postgresContactService) {
        return res.status(500).json({
          success: false,
          message: 'PostgresContactService not initialized'
        })
      }

      const { id, acknowledged, islegal } = req.body

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'id is required'
        })
      }

      // Build updates object with only provided fields
      const updates = {}
      if (acknowledged !== undefined) updates.acknowledged = acknowledged
      if (islegal !== undefined) updates.islegal = islegal

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one field (acknowledged or islegal) must be provided'
        })
      }

      const result = await this.postgresContactService.updateContactStatus(id, updates)

      res.status(result.success ? 200 : 404).json(result)

    } catch (error) {
      console.error('Error updating PostgreSQL contact:', error.message)
      res.status(500).json({
        success: false,
        message: `Update failed: ${error.message}`
      })
    }
  }

  async deduplicatePostgresContacts(req, res) {
    try {
      // Check if service exists
      if (!this.postgresContactService) {
        return res.status(500).json({
          success: false,
          message: 'PostgresContactService not initialized'
        })
      }

      const { dryRun = 'true', mode = 'strict' } = req.query

      // Validate mode
      const validModes = ['strict', 'name-only', 'name-company', 'fuzzy']
      if (!validModes.includes(mode)) {
        return res.status(400).json({
          success: false,
          message: `Invalid mode. Must be one of: ${validModes.join(', ')}`
        })
      }

      console.log(`🔄 Deduplication request received (mode: ${mode}, dryRun: ${dryRun})`)

      const result = await this.postgresContactService.deduplicateContactsByMode(mode, dryRun === 'true')

      res.status(200).json(result)

    } catch (error) {
      console.error('Error deduplicating contacts:', error.message)
      res.status(500).json({
        success: false,
        message: `Deduplication failed: ${error.message}`
      })
    }
  }
}

// Create single instance
const contactController = new ContactController()

// Export controller
module.exports.Controller = { ContactController: contactController }
module.exports.controller = (app) => {
  console.log('🔧 Loading Contact controller routes...')

  // DynamoDB contact management endpoints
  app.get('/v1/contacts', (req, res) => contactController.getContacts(req, res))
  app.get('/v1/contacts/stats', (req, res) => contactController.getContactStats(req, res))
  app.put('/v1/contacts/update', (req, res) => contactController.updateContactStatus(req, res))

  // PostgreSQL contact management endpoints
  app.get('/v1/postgres/contacts', (req, res) => contactController.getPostgresContacts(req, res))
  app.get('/v1/postgres/contacts/stats', (req, res) => contactController.getPostgresContactStats(req, res))
  app.get('/v1/postgres/contacts/export', (req, res) => contactController.exportPostgresContactsCSV(req, res))
  app.put('/v1/postgres/contacts/update', (req, res) => contactController.updatePostgresContactStatus(req, res))
  app.post('/v1/postgres/contacts/deduplicate', (req, res) => contactController.deduplicatePostgresContacts(req, res))

  // Debug endpoints
  app.get('/v1/test-dynamo', (req, res) => contactController.testDynamoClient(req, res))
  app.get('/v1/test-contacts', (req, res) => contactController.testContacts(req, res))
  app.get('/v1/test-postgres', (req, res) => contactController.testPostgres(req, res))
  app.get('/v1/postgres-status', (req, res) => contactController.postgresStatus(req, res))

  console.log('✅ Contact controller routes loaded successfully')
}
