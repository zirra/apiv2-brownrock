require('dotenv').config();
const WhitepagesService = require('../services/whitepages.service');
const WhitepagesLookup = require('../models/whitepages-lookup');
const Contact = require('../models/contact');

class WhitepagesController {
  constructor() {
    console.log('🔍 WhitepagesController initialized');
    this.whitepagesService = new WhitepagesService();
  }

  /**
   * GET /v1/whitepages/eligible
   * Find contacts eligible for WhitePages lookup
   */
  async getEligibleContacts(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;

      const contacts = await this.whitepagesService.findEligibleContacts(limit, offset);

      res.status(200).json({
        success: true,
        count: contacts.length,
        limit,
        offset,
        contacts: contacts.map(c => ({
          id: c.id,
          first_name: c.first_name,
          last_name: c.last_name,
          address: c.address,
          city: c.city,
          state: c.state,
          zip: c.zip,
          project_origin: c.project_origin
        }))
      });

    } catch (error) {
      console.error('❌ Error getting eligible contacts:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to get eligible contacts',
        error: error.message
      });
    }
  }

  /**
   * POST /v1/whitepages/lookup/:contactId
   * Perform WhitePages lookup for a specific contact
   */
  async lookupSingleContact(req, res) {
    try {
      const contactId = parseInt(req.params.contactId);

      // Find the contact
      const contact = await Contact.findByPk(contactId);
      if (!contact) {
        return res.status(404).json({
          success: false,
          message: `Contact ${contactId} not found`
        });
      }

      // Check if already looked up
      const existingLookup = await WhitepagesLookup.findOne({
        where: { contact_id: contactId }
      });

      if (existingLookup) {
        return res.status(409).json({
          success: false,
          message: 'Contact already has a WhitePages lookup',
          lookup_id: existingLookup.id,
          lookup_status: existingLookup.lookup_status
        });
      }

      // Validate contact has required fields
      if (!contact.first_name || !contact.last_name) {
        return res.status(400).json({
          success: false,
          message: 'Contact must have first_name and last_name'
        });
      }

      const hasFullAddress = contact.address && contact.city && contact.state;
      const hasZip = contact.zip;

      if (!hasFullAddress && !hasZip) {
        return res.status(400).json({
          success: false,
          message: 'Contact must have either (address + city + state) or zip code'
        });
      }

      // Perform lookup
      console.log(`🔍 Manual lookup requested for contact ${contactId}`);
      const lookup = await this.whitepagesService.processContact(contact);

      res.status(200).json({
        success: true,
        message: 'Lookup completed',
        lookup: {
          id: lookup.id,
          contact_id: lookup.contact_id,
          lookup_status: lookup.lookup_status,
          wp_person_id: lookup.wp_person_id,
          wp_name: lookup.wp_name,
          wp_phones: lookup.wp_phones,
          wp_emails: lookup.wp_emails,
          wp_current_addresses: lookup.wp_current_addresses,
          verified: lookup.verified
        }
      });

    } catch (error) {
      console.error('❌ Error performing single lookup:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to perform lookup',
        error: error.message
      });
    }
  }

  /**
   * POST /v1/whitepages/batch
   * Perform batch WhitePages lookups for eligible contacts
   */
  async lookupBatch(req, res) {
    try {
      const limit = parseInt(req.body.limit) || 50;
      const delayMs = parseInt(req.body.delay) || 1000;

      console.log(`📦 Starting batch lookup for up to ${limit} contacts (${delayMs}ms delay)`);

      // Find eligible contacts
      const contacts = await this.whitepagesService.findEligibleContacts(limit, 0);

      if (contacts.length === 0) {
        return res.status(200).json({
          success: true,
          message: 'No eligible contacts found for lookup',
          results: {
            total: 0,
            success: 0,
            no_results: 0,
            errors: 0
          }
        });
      }

      // Process batch
      const results = await this.whitepagesService.processBatch(contacts, delayMs);

      res.status(200).json({
        success: true,
        message: 'Batch lookup completed',
        results
      });

    } catch (error) {
      console.error('❌ Error performing batch lookup:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to perform batch lookup',
        error: error.message
      });
    }
  }

  /**
   * GET /v1/whitepages/results/:lookupId
   * Get detailed results for a specific lookup
   */
  async getLookupResult(req, res) {
    try {
      const lookupId = parseInt(req.params.lookupId);

      const lookup = await WhitepagesLookup.findByPk(lookupId);

      if (!lookup) {
        return res.status(404).json({
          success: false,
          message: `Lookup ${lookupId} not found`
        });
      }

      res.status(200).json({
        success: true,
        lookup
      });

    } catch (error) {
      console.error('❌ Error getting lookup result:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to get lookup result',
        error: error.message
      });
    }
  }

  /**
   * GET /v1/whitepages/pending
   * Get all lookups pending verification
   */
  async getPendingVerification(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;

      const lookups = await WhitepagesLookup.findAll({
        where: {
          lookup_status: 'success',
          verified: false
        },
        limit,
        offset,
        order: [['lookup_at', 'DESC']]
      });

      res.status(200).json({
        success: true,
        count: lookups.length,
        limit,
        offset,
        lookups
      });

    } catch (error) {
      console.error('❌ Error getting pending verifications:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to get pending verifications',
        error: error.message
      });
    }
  }

  /**
   * PUT /v1/whitepages/verify/:lookupId
   * Mark a lookup as verified
   */
  async verifyLookup(req, res) {
    try {
      const lookupId = parseInt(req.params.lookupId);
      const { verified_by, verification_notes } = req.body;

      const lookup = await WhitepagesLookup.findByPk(lookupId);

      if (!lookup) {
        return res.status(404).json({
          success: false,
          message: `Lookup ${lookupId} not found`
        });
      }

      // Update verification status
      await lookup.update({
        verified: true,
        verified_by: verified_by || 'unknown',
        verified_at: new Date(),
        verification_notes: verification_notes || null
      });

      res.status(200).json({
        success: true,
        message: 'Lookup marked as verified',
        lookup
      });

    } catch (error) {
      console.error('❌ Error verifying lookup:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to verify lookup',
        error: error.message
      });
    }
  }

  /**
   * GET /v1/whitepages/statistics
   * Get lookup statistics
   */
  async getStatistics(req, res) {
    try {
      const stats = await this.whitepagesService.getStatistics();

      res.status(200).json({
        success: true,
        statistics: stats
      });

    } catch (error) {
      console.error('❌ Error getting statistics:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to get statistics',
        error: error.message
      });
    }
  }

  /**
   * GET /v1/whitepages/contact/:contactId
   * Get all lookups for a specific contact
   */
  async getContactLookups(req, res) {
    try {
      const contactId = parseInt(req.params.contactId);

      const lookups = await WhitepagesLookup.findAll({
        where: { contact_id: contactId },
        order: [['lookup_at', 'DESC']]
      });

      res.status(200).json({
        success: true,
        count: lookups.length,
        lookups
      });

    } catch (error) {
      console.error('❌ Error getting contact lookups:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to get contact lookups',
        error: error.message
      });
    }
  }
}

// Create single instance
const whitepagesController = new WhitepagesController();

// Export controller for routes
module.exports.Controller = { WhitepagesController: whitepagesController };
module.exports.controller = (app) => {
  console.log('🔍 Loading WhitePages controller routes...');

  // Discovery endpoints
  app.get('/v1/whitepages/eligible', (req, res) => whitepagesController.getEligibleContacts(req, res));
  app.get('/v1/whitepages/statistics', (req, res) => whitepagesController.getStatistics(req, res));

  // Lookup endpoints
  app.post('/v1/whitepages/lookup/:contactId', (req, res) => whitepagesController.lookupSingleContact(req, res));
  app.post('/v1/whitepages/batch', (req, res) => whitepagesController.lookupBatch(req, res));

  // Results endpoints
  app.get('/v1/whitepages/results/:lookupId', (req, res) => whitepagesController.getLookupResult(req, res));
  app.get('/v1/whitepages/contact/:contactId', (req, res) => whitepagesController.getContactLookups(req, res));

  // Verification endpoints
  app.get('/v1/whitepages/pending', (req, res) => whitepagesController.getPendingVerification(req, res));
  app.put('/v1/whitepages/verify/:lookupId', (req, res) => whitepagesController.verifyLookup(req, res));

  console.log('✅ WhitePages controller routes loaded successfully');
};
