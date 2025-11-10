require('dotenv').config()
const cron = require('node-cron')
const multer = require('multer')
const fs = require('fs')
const path = require('path')

class LookupController {

  constructor() {
    console.log('constructor loaded')
    this.wpApiRoot = process.env.WP_API_ROOT
    this.wpApiKey = process.env.WP_API_KEY
  }

  async lookupContact (req, res) {
    res.status(200).send('lookup success')
  }
  
}

// Create single instance
const lookupController = new LookupController()

// Export controller function for routes
module.exports.Controller = { LookupController: lookupController }
module.exports.controller = (app) => {
  console.log('🔍 Loading LookupController controller routes...')
  // Status and configuration endpoints
  app.get('/v1/lookup/', (req, res) => lookupController.lookupContact(req, res))
  console.log('✅ LookupController controller routes loaded successfully')
}