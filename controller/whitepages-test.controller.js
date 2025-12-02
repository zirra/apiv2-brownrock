require('dotenv').config();
const WhitepagesService = require('../services/whitepages.service');
const Contact = require('../models/contact');
const WhitepagesLookup = require('../models/whitepages-lookup');
const { Op } = require('sequelize');

class WhitepagesTestController {
  constructor() {
    console.log('🧪 WhitepagesTestController initialized');
    this.whitepagesService = new WhitepagesService();
  }

  /**
   * GET /v1/whitepages-test/select-test-contacts
   * Select 25 valid contacts for testing and mark them
   */
  async selectTestContacts(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 25;

      console.log(`🔍 Selecting ${limit} test contacts with COMPLETE address data...`);

      // Find contacts with COMPLETE data quality
      // STRICT Criteria: ALL fields required (first_name, last_name, address, city, state, zip)
      const allContacts = await Contact.findAll({
        where: {
          [Op.and]: [
            { first_name: { [Op.ne]: null } },
            { first_name: { [Op.ne]: '' } },
            { last_name: { [Op.ne]: null } },
            { last_name: { [Op.ne]: '' } },
            { address: { [Op.ne]: null } },
            { address: { [Op.ne]: '' } },
            { city: { [Op.ne]: null } },
            { city: { [Op.ne]: '' } },
            { state: { [Op.ne]: null } },
            { state: { [Op.ne]: '' } },
            { zip: { [Op.ne]: null } },
            { zip: { [Op.ne]: '' } },
            // State must be 2 letters (not "Texas 76092")
            { state: { [Op.regexp]: '^[A-Z]{2}$' } }
          ]
        },
        limit: limit * 3, // Get extra to filter out bad addresses
        order: [['created_at', 'DESC']]
      });

      // Clean up addresses that have city/state/zip embedded
      // For testing purposes, we'll extract just the street portion
      const validContacts = allContacts.map(c => {
        const addr = c.address.trim();

        // If address contains a comma, extract just the street portion (everything before first comma)
        if (addr.includes(',')) {
          const parts = addr.split(',');
          c.address = parts[0].trim();
          console.log(`📝 Cleaned address for ${c.first_name} ${c.last_name}: "${addr}" → "${c.address}"`);
        }

        return c;
      }).slice(0, limit);

      console.log(`✅ Found ${validContacts.length} contacts with complete, properly formatted addresses`);

      // Return summary
      const contactSummary = validContacts.map(c => ({
        id: c.id,
        name: `${c.first_name} ${c.last_name}`,
        address: c.address,
        city: c.city,
        state: c.state,
        zip: c.zip,
        project_origin: c.project_origin
      }));

      res.status(200).json({
        success: true,
        message: `Selected ${validContacts.length} contacts with complete address data`,
        count: validContacts.length,
        contacts: contactSummary
      });

    } catch (error) {
      console.error('❌ Error selecting test contacts:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to select test contacts',
        error: error.message
      });
    }
  }

  /**
   * POST /v1/whitepages-test/run-test
   * Run WhitePages lookups on 25 test contacts
   */
  async runTest(req, res) {
    try {
      const limit = parseInt(req.body.limit) || 25;
      const delayMs = parseInt(req.body.delay) || 2000; // 2 second default delay
      const resetLookups = req.body.reset === true; // Option to clear previous test results

      console.log(`🧪 Starting WhitePages test run (${limit} contacts, ${delayMs}ms delay)...`);

      // Find contacts with COMPLETE data quality
      // STRICT Criteria: ALL fields required (first_name, last_name, address, city, state, zip)
      const allContacts = await Contact.findAll({
        where: {
          [Op.and]: [
            { first_name: { [Op.ne]: null } },
            { first_name: { [Op.ne]: '' } },
            { last_name: { [Op.ne]: null } },
            { last_name: { [Op.ne]: '' } },
            { address: { [Op.ne]: null } },
            { address: { [Op.ne]: '' } },
            { city: { [Op.ne]: null } },
            { city: { [Op.ne]: '' } },
            { state: { [Op.ne]: null } },
            { state: { [Op.ne]: '' } },
            { zip: { [Op.ne]: null } },
            { zip: { [Op.ne]: '' } },
            // State must be 2 letters (not "Texas 76092")
            { state: { [Op.regexp]: '^[A-Z]{2}$' } }
          ]
        },
        limit: limit * 3, // Get extra to filter out bad addresses
        order: [['created_at', 'DESC']]
      });

      // Clean up addresses that have city/state/zip embedded
      // For testing purposes, we'll extract just the street portion
      const contacts = allContacts.map(c => {
        const addr = c.address.trim();

        // If address contains a comma, extract just the street portion (everything before first comma)
        if (addr.includes(',')) {
          const parts = addr.split(',');
          c.address = parts[0].trim();
        }

        return c;
      }).slice(0, limit);

      if (contacts.length === 0) {
        return res.status(200).json({
          success: true,
          message: 'No valid contacts found for testing',
          results: {
            total: 0,
            success: 0,
            no_results: 0,
            errors: 0,
            skipped: 0
          }
        });
      }

      console.log(`📋 Found ${contacts.length} valid test contacts`);

      // If reset flag is set, delete previous lookups for these contacts
      if (resetLookups) {
        const contactIds = contacts.map(c => c.id);
        const deleted = await WhitepagesLookup.destroy({
          where: {
            contact_id: { [Op.in]: contactIds }
          }
        });
        console.log(`🗑️ Reset: Deleted ${deleted} previous lookup records`);
      }

      // Track results
      const results = {
        total: contacts.length,
        success: 0,
        no_results: 0,
        errors: 0,
        skipped: 0,
        details: []
      };

      // Process each contact
      for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];

        try {
          // Check if already looked up
          const existingLookup = await WhitepagesLookup.findOne({
            where: { contact_id: contact.id }
          });

          if (existingLookup && !resetLookups) {
            console.log(`⏭️ Skipping ${contact.first_name} ${contact.last_name} (already looked up)`);
            results.skipped++;
            results.details.push({
              contact_id: contact.id,
              name: `${contact.first_name} ${contact.last_name}`,
              status: 'skipped',
              reason: 'Already has lookup record'
            });
            continue;
          }

          console.log(`🔍 [${i + 1}/${contacts.length}] Looking up: ${contact.first_name} ${contact.last_name}`);

          // Perform lookup
          const lookup = await this.whitepagesService.processContact(contact);

          // Track result
          if (lookup.lookup_status === 'success') {
            results.success++;
            results.details.push({
              contact_id: contact.id,
              name: `${contact.first_name} ${contact.last_name}`,
              status: 'success',
              phones_found: lookup.wp_phones ? lookup.wp_phones.length : 0,
              emails_found: lookup.wp_emails ? lookup.wp_emails.length : 0,
              api_url: lookup.api_url
            });
          } else if (lookup.lookup_status === 'no_results') {
            results.no_results++;
            results.details.push({
              contact_id: contact.id,
              name: `${contact.first_name} ${contact.last_name}`,
              status: 'no_results',
              api_url: lookup.api_url
            });
          } else if (lookup.lookup_status === 'error') {
            results.errors++;
            results.details.push({
              contact_id: contact.id,
              name: `${contact.first_name} ${contact.last_name}`,
              status: 'error',
              error: lookup.lookup_error,
              api_url: lookup.api_url
            });
          }

          // Rate limiting delay
          if (i < contacts.length - 1 && delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }

        } catch (error) {
          console.error(`❌ Error processing contact ${contact.id}: ${error.message}`);
          results.errors++;
          results.details.push({
            contact_id: contact.id,
            name: `${contact.first_name} ${contact.last_name}`,
            status: 'error',
            error: error.message
          });
        }
      }

      // Calculate success rate
      const successRate = results.total > 0
        ? ((results.success / (results.total - results.skipped)) * 100).toFixed(1)
        : 0;

      console.log(`✅ Test completed: ${results.success} success, ${results.no_results} no results, ${results.errors} errors, ${results.skipped} skipped`);

      res.status(200).json({
        success: true,
        message: 'WhitePages test completed',
        results: {
          ...results,
          success_rate: `${successRate}%`
        }
      });

    } catch (error) {
      console.error('❌ Error running WhitePages test:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to run WhitePages test',
        error: error.message
      });
    }
  }

  /**
   * GET /v1/whitepages-test/results
   * Get test results summary
   */
  async getTestResults(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 25;

      // Get recent lookups
      const lookups = await WhitepagesLookup.findAll({
        limit,
        order: [['lookup_at', 'DESC']],
        attributes: [
          'id',
          'contact_id',
          'search_first_name',
          'search_last_name',
          'search_city',
          'search_state',
          'search_zip',
          'lookup_status',
          'lookup_error',
          'api_url',
          'lookup_at',
          'wp_phones',
          'wp_emails'
        ]
      });

      // Calculate statistics
      const stats = {
        total: lookups.length,
        success: lookups.filter(l => l.lookup_status === 'success').length,
        no_results: lookups.filter(l => l.lookup_status === 'no_results').length,
        errors: lookups.filter(l => l.lookup_status === 'error').length
      };

      // Format results
      const results = lookups.map(l => ({
        id: l.id,
        contact_id: l.contact_id,
        name: `${l.search_first_name} ${l.search_last_name}`,
        location: `${l.search_city}, ${l.search_state} ${l.search_zip || ''}`.trim(),
        status: l.lookup_status,
        error: l.lookup_error,
        api_url: l.api_url,
        phones_found: l.wp_phones ? l.wp_phones.length : 0,
        emails_found: l.wp_emails ? l.wp_emails.length : 0,
        lookup_at: l.lookup_at
      }));

      res.status(200).json({
        success: true,
        statistics: stats,
        results
      });

    } catch (error) {
      console.error('❌ Error getting test results:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to get test results',
        error: error.message
      });
    }
  }

  /**
   * DELETE /v1/whitepages-test/clear
   * Clear all test lookup results
   */
  async clearTestResults(req, res) {
    try {
      const confirmCode = req.body.confirm;

      if (confirmCode !== 'CLEAR_TEST_DATA') {
        return res.status(400).json({
          success: false,
          message: 'Confirmation code required. Send {"confirm": "CLEAR_TEST_DATA"} to proceed.'
        });
      }

      // Delete all lookups
      const deleted = await WhitepagesLookup.destroy({
        where: {},
        truncate: false
      });

      console.log(`🗑️ Cleared ${deleted} test lookup records`);

      res.status(200).json({
        success: true,
        message: `Cleared ${deleted} lookup records`,
        deleted_count: deleted
      });

    } catch (error) {
      console.error('❌ Error clearing test results:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to clear test results',
        error: error.message
      });
    }
  }
}

// Create single instance
const whitepagesTestController = new WhitepagesTestController();

// Export controller for routes
module.exports.Controller = { WhitepagesTestController: whitepagesTestController };
module.exports.controller = (app) => {
  console.log('🧪 Loading WhitePages Test controller routes...');

  // Test management endpoints
  app.get('/v1/whitepages-test/select-test-contacts', (req, res) =>
    whitepagesTestController.selectTestContacts(req, res));

  app.post('/v1/whitepages-test/run-test', (req, res) =>
    whitepagesTestController.runTest(req, res));

  app.get('/v1/whitepages-test/results', (req, res) =>
    whitepagesTestController.getTestResults(req, res));

  app.delete('/v1/whitepages-test/clear', (req, res) =>
    whitepagesTestController.clearTestResults(req, res));

  console.log('✅ WhitePages Test controller routes loaded successfully');
};
