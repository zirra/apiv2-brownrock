require('dotenv').config();
const axios = require('axios');
const WhitepagesLookup = require('../models/whitepages-lookup');
const Contact = require('../models/contact');
const { Op } = require('sequelize');

class WhitepagesService {
  constructor() {
    this.apiRoot = process.env.WP_API_ROOT || 'https://api.whitepages.com/';
    this.apiKey = process.env.WP_API_KEY;

    if (!this.apiKey) {
      console.warn('⚠️ WP_API_KEY not configured - WhitePages lookups will fail');
    }
  }

  /**
   * Find contacts eligible for WhitePages lookup
   * Criteria: Must have (first + last + city + state + address) OR (first + last + zip)
   * Returns only unique contacts not already looked up
   */
  async findEligibleContacts(limit = 100, offset = 0) {
    try {
      // Find contact IDs that already have lookups
      const existingLookups = await WhitepagesLookup.findAll({
        attributes: ['contact_id'],
        raw: true
      });
      const excludeIds = existingLookups.map(l => l.contact_id);

      // Query for eligible contacts
      const contacts = await Contact.findAll({
        where: {
          id: {
            [Op.notIn]: excludeIds.length > 0 ? excludeIds : [0]
          },
          first_name: { [Op.ne]: null },
          last_name: { [Op.ne]: null },
          [Op.or]: [
            // Option 1: Has full address
            {
              [Op.and]: [
                { city: { [Op.ne]: null } },
                { state: { [Op.ne]: null } },
                { address: { [Op.ne]: null } }
              ]
            },
            // Option 2: Has zip code
            {
              zip: { [Op.ne]: null }
            }
          ]
        },
        limit,
        offset,
        order: [['created_at', 'DESC']]
      });

      console.log(`📋 Found ${contacts.length} eligible contacts for WhitePages lookup`);
      return contacts;

    } catch (error) {
      console.error('❌ Error finding eligible contacts:', error.message);
      throw error;
    }
  }

  /**
   * Perform WhitePages person search
   * API endpoint: https://api.whitepages.com/v1/person
   */
  async lookupPerson(contact) {
    try {
      const fullName = `${contact.first_name} ${contact.last_name}`.trim();
      console.log(`🔍 Looking up: ${fullName}`);

      const params = {
        name: fullName
      };

      // Add address parameters if available (using correct WhitePages parameter names)
      // Only add non-null, non-empty values
      if (contact.address && contact.address.trim()) params.street = contact.address.trim();
      if (contact.city && contact.city.trim()) params.city = contact.city.trim();
      if (contact.state && contact.state.trim()) params.state_code = contact.state.trim();
      if (contact.zip && contact.zip.trim()) {
        // Strip ZIP+4 format (12345-6789) to just 5 digits (12345)
        // WhitePages API doesn't accept ZIP+4 format
        const zip = contact.zip.trim();
        params.zipcode = zip.split('-')[0];
      }

      // Construct full API URL for debugging
      const baseUrl = `${this.apiRoot}v1/person`;
      const queryString = new URLSearchParams(params).toString();
      const fullUrl = `${baseUrl}?${queryString}`;

      console.log('📤 WhitePages API params:', JSON.stringify(params, null, 2));

      const response = await axios.get(baseUrl, {
        params,
        headers: {
          'X-Api-Key': this.apiKey
        },
        timeout: 30000
      });

      console.log(`✅ WhitePages API response received for ${contact.first_name} ${contact.last_name}`);

      return {
        success: true,
        data: response.data,
        status: response.status,
        apiUrl: fullUrl
      };

    } catch (error) {
      console.error(`❌ WhitePages lookup failed for contact ${contact.id}: ${error.message}`);

      // Construct URL even for failed requests
      const fullName = `${contact.first_name} ${contact.last_name}`.trim();
      const params = { name: fullName };
      if (contact.address && contact.address.trim()) params.street = contact.address.trim();
      if (contact.city && contact.city.trim()) params.city = contact.city.trim();
      if (contact.state && contact.state.trim()) params.state_code = contact.state.trim();
      if (contact.zip && contact.zip.trim()) {
        // Strip ZIP+4 format to just 5 digits
        const zip = contact.zip.trim();
        params.zipcode = zip.split('-')[0];
      }

      const baseUrl = `${this.apiRoot}v1/person`;
      const queryString = new URLSearchParams(params).toString();
      const fullUrl = `${baseUrl}?${queryString}`;

      return {
        success: false,
        error: error.message,
        status: error.response?.status || 500,
        apiUrl: fullUrl
      };
    }
  }

  /**
   * Parse WhitePages API response and extract relevant data
   * Handles both successful results and empty arrays
   */
  parseWhitepagesResponse(apiResponse) {
    // Handle empty array (no results found)
    if (Array.isArray(apiResponse) && apiResponse.length === 0) {
      return {
        hasResults: false,
        data: null
      };
    }

    // Handle array with results
    if (Array.isArray(apiResponse) && apiResponse.length > 0) {
      // Use first result (most relevant)
      const person = apiResponse[0];

      return {
        hasResults: true,
        data: {
          wp_person_id: person.id || null,
          wp_name: person.name || null,
          wp_aliases: person.aliases || null,
          wp_is_dead: person.is_dead || false,
          wp_current_addresses: person.current_addresses || null,
          wp_historic_addresses: person.historic_addresses || null,
          wp_owned_properties: person.owned_properties || null,
          wp_phones: person.phones || null,
          wp_emails: person.emails || null,
          wp_date_of_birth: person.date_of_birth || null,
          wp_linkedin_url: person.linkedin_url || null,
          wp_company_name: person.company_name || null,
          wp_job_title: person.job_title || null,
          wp_relatives: person.relatives || null
        }
      };
    }

    // Handle object response format (if API returns single object)
    if (typeof apiResponse === 'object' && apiResponse !== null) {
      return {
        hasResults: true,
        data: {
          wp_person_id: apiResponse.id || null,
          wp_name: apiResponse.name || null,
          wp_aliases: apiResponse.aliases || null,
          wp_is_dead: apiResponse.is_dead || false,
          wp_current_addresses: apiResponse.current_addresses || null,
          wp_historic_addresses: apiResponse.historic_addresses || null,
          wp_owned_properties: apiResponse.owned_properties || null,
          wp_phones: apiResponse.phones || null,
          wp_emails: apiResponse.emails || null,
          wp_date_of_birth: apiResponse.date_of_birth || null,
          wp_linkedin_url: apiResponse.linkedin_url || null,
          wp_company_name: apiResponse.company_name || null,
          wp_job_title: apiResponse.job_title || null,
          wp_relatives: apiResponse.relatives || null
        }
      };
    }

    // Unknown format
    return {
      hasResults: false,
      data: null
    };
  }

  /**
   * Store WhitePages lookup result in database
   */
  async storeLookupResult(contact, apiResult, rawResponse) {
    try {
      const parsed = this.parseWhitepagesResponse(apiResult.data);

      const lookupData = {
        contact_id: contact.id,
        // Search criteria
        search_first_name: contact.first_name,
        search_last_name: contact.last_name,
        search_address: contact.address,
        search_city: contact.city,
        search_state: contact.state,
        search_zip: contact.zip,
        // Lookup metadata
        lookup_at: new Date(),
        lookup_status: parsed.hasResults ? 'success' : 'no_results',
        api_url: apiResult.apiUrl,
        raw_response: rawResponse,
        // WhitePages data (if results found)
        ...(parsed.hasResults ? parsed.data : {})
      };

      const lookup = await WhitepagesLookup.create(lookupData);
      console.log(`💾 Stored lookup result for contact ${contact.id} (status: ${lookupData.lookup_status})`);

      return lookup;

    } catch (error) {
      console.error(`❌ Failed to store lookup result for contact ${contact.id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Store failed lookup (error case)
   */
  async storeFailedLookup(contact, errorMessage, apiUrl = null) {
    try {
      const lookupData = {
        contact_id: contact.id,
        search_first_name: contact.first_name,
        search_last_name: contact.last_name,
        search_address: contact.address,
        search_city: contact.city,
        search_state: contact.state,
        search_zip: contact.zip,
        lookup_at: new Date(),
        lookup_status: 'error',
        lookup_error: errorMessage,
        api_url: apiUrl
      };

      const lookup = await WhitepagesLookup.create(lookupData);
      console.log(`💾 Stored failed lookup for contact ${contact.id}`);

      return lookup;

    } catch (error) {
      console.error(`❌ Failed to store error lookup for contact ${contact.id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Perform lookup for a single contact and store result
   */
  async processContact(contact) {
    try {
      const apiResult = await this.lookupPerson(contact);

      if (apiResult.success) {
        return await this.storeLookupResult(contact, apiResult, apiResult.data);
      } else {
        return await this.storeFailedLookup(contact, apiResult.error, apiResult.apiUrl);
      }

    } catch (error) {
      console.error(`❌ Error processing contact ${contact.id}: ${error.message}`);
      return await this.storeFailedLookup(contact, error.message, null);
    }
  }

  /**
   * Batch process multiple contacts
   */
  async processBatch(contacts, delayMs = 1000) {
    const results = {
      total: contacts.length,
      success: 0,
      no_results: 0,
      errors: 0
    };

    for (const contact of contacts) {
      try {
        const lookup = await this.processContact(contact);

        if (lookup.lookup_status === 'success') results.success++;
        else if (lookup.lookup_status === 'no_results') results.no_results++;
        else if (lookup.lookup_status === 'error') results.errors++;

        // Rate limiting delay
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

      } catch (error) {
        console.error(`❌ Batch processing error for contact ${contact.id}: ${error.message}`);
        results.errors++;
      }
    }

    return results;
  }

  /**
   * Get lookup statistics
   */
  async getStatistics() {
    try {
      const total = await WhitepagesLookup.count();
      const success = await WhitepagesLookup.count({ where: { lookup_status: 'success' } });
      const noResults = await WhitepagesLookup.count({ where: { lookup_status: 'no_results' } });
      const errors = await WhitepagesLookup.count({ where: { lookup_status: 'error' } });
      const verified = await WhitepagesLookup.count({ where: { verified: true } });
      const pending = await WhitepagesLookup.count({ where: { verified: false, lookup_status: 'success' } });

      return {
        total_lookups: total,
        successful: success,
        no_results: noResults,
        errors: errors,
        verified: verified,
        pending_verification: pending
      };

    } catch (error) {
      console.error('❌ Error getting statistics:', error.message);
      throw error;
    }
  }
}

module.exports = WhitepagesService;
