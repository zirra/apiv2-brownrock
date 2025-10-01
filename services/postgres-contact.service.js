require('dotenv').config();
const { pgdbconnect, Contact } = require('../config/pddbclient.cjs');

class PostgresContactService {
  constructor() {
    this.Contact = Contact;
    this.sequelize = pgdbconnect;
  }

  /**
   * Map Claude's extracted contact format to your PostgreSQL schema
   */
  mapClaudeToPostgres(claudeContact) {
    // Claude returns: company, name, first_name, last_name, address, phone, fax, email, etc.
    // Your model has: name, llc_owner, phone1-phone8, email1-email2, address, city, state, zip, etc.

    const phones = [];
    if (claudeContact.phone) phones.push(claudeContact.phone);
    if (claudeContact.fax) phones.push(claudeContact.fax);

    const emails = [];
    if (claudeContact.email) emails.push(claudeContact.email);

    // Handle name splitting - prioritize existing first_name/last_name, then split full name
    let firstName = claudeContact.first_name || '';
    let lastName = claudeContact.last_name || '';
    let fullName = claudeContact.name || '';

    // If we have first_name and last_name but no full name, construct it
    if (firstName && lastName && !fullName) {
      fullName = `${firstName} ${lastName}`.trim();
    }
    // If we have full name but no first/last name, try to split it
    else if (fullName && !firstName && !lastName) {
      const nameParts = this.splitFullName(fullName);
      firstName = nameParts.firstName;
      lastName = nameParts.lastName;
    }
    // If we have both, use existing values (don't override)

    // Final name to store (prefer full name, fall back to constructed name)
    const finalName = fullName || `${firstName} ${lastName}`.trim() || claudeContact.company || null;

    // Parse address components
    const { street, city, state, zip, unit } = this.parseAddress(claudeContact.address || '');

    return {
      name: finalName,
      llc_owner: claudeContact.company || null,
      phone1: phones[0] || null,
      phone2: phones[1] || null,
      phone3: phones[2] || null,
      phone4: phones[3] || null,
      phone5: phones[4] || null,
      phone6: phones[5] || null,
      phone7: phones[6] || null,
      phone8: phones[7] || null,
      email1: emails[0] || null,
      email2: emails[1] || null,
      address: street || claudeContact.address || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      unit: unit || null,
      first_name: firstName || null,
      last_name: lastName || null,
      notes: claudeContact.notes || null,
      record_type: claudeContact.record_type || null,
      document_section: claudeContact.document_section || null,
      source_file: claudeContact.source_file || null,
      acknowledged: false,
      islegal: this.isLegalEntity(claudeContact)
    };
  }

  /**
   * Split full name into first and last name components
   */
  splitFullName(fullName) {
    if (!fullName || typeof fullName !== 'string') {
      return { firstName: '', lastName: '' };
    }

    // Clean and split the name
    const nameParts = fullName.trim().split(/\s+/).filter(Boolean);

    if (nameParts.length === 0) {
      return { firstName: '', lastName: '' };
    } else if (nameParts.length === 1) {
      // Single name - could be first or last, default to first
      return { firstName: nameParts[0], lastName: '' };
    } else if (nameParts.length === 2) {
      // Simple case: First Last
      return { firstName: nameParts[0], lastName: nameParts[1] };
    } else {
      // Multiple parts - first name is first part, last name is last part
      // Middle names/initials go with first name
      return {
        firstName: nameParts.slice(0, -1).join(' '),
        lastName: nameParts[nameParts.length - 1]
      };
    }
  }

  /**
   * Parse address string into components
   */
  parseAddress(address) {
    if (!address || typeof address !== 'string') {
      return { street: null, city: null, state: null, zip: null, unit: null };
    }

    // Simple address parsing - can be enhanced
    const parts = address.split(',').map(p => p.trim());

    let street = null;
    let city = null;
    let state = null;
    let zip = null;
    let unit = null;

    if (parts.length >= 1) street = parts[0];
    if (parts.length >= 2) city = parts[1];

    // Look for state/zip in last part
    if (parts.length >= 3) {
      const lastPart = parts[parts.length - 1];
      const stateZipMatch = lastPart.match(/([A-Z]{2})\s+(\d{5}(-\d{4})?)/);

      if (stateZipMatch) {
        state = stateZipMatch[1];
        zip = stateZipMatch[2];
      } else {
        state = lastPart;
      }
    }

    return { street, city, state, zip, unit };
  }

  /**
   * Determine if contact appears to be a legal entity
   */
  isLegalEntity(contact) {
    const legalIndicators = [
      'attorney', 'atty', 'lawyer', 'attorneys', 'law firm', 'law office',
      'esquire', 'esq', 'j.d.', 'juris doctor', 'p.c.', 'p.a.',
      'llp', 'pllc', 'counsel', 'counselor', 'legal representative',
      'legal department', 'legal services', 'legal counsel',
      'law group', 'law associates', 'legal aid', 'paralegal',
      'bar association', 'legal clinic', 'advocate'
    ];

    // Check name, company, and notes for legal indicators
    const searchText = (
      (contact.name || '') + ' ' +
      (contact.company || '') + ' ' +
      (contact.notes || '')
    ).toLowerCase();

    // Be more specific - require word boundaries to avoid false matches
    return legalIndicators.some(indicator => {
      const regex = new RegExp(`\\b${indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return regex.test(searchText);
    });
  }

  /**
   * Remove duplicate contacts based on name/company and contact info
   */
  removeDuplicates(contacts) {
    const seen = new Map();
    const unique = [];

    for (const contact of contacts) {
      // Create a key based on name/company and primary contact info
      const nameKey = (contact.name || '').toLowerCase().trim();
      const companyKey = (contact.llc_owner || '').toLowerCase().trim();
      const phoneKey = (contact.phone1 || '').replace(/\D/g, ''); // Remove non-digits
      const emailKey = (contact.email1 || '').toLowerCase().trim();

      // Create composite key for duplicate detection
      const duplicateKey = `${nameKey}|${companyKey}|${phoneKey}|${emailKey}`;

      if (!seen.has(duplicateKey)) {
        seen.set(duplicateKey, true);
        unique.push(contact);
      } else {
        console.log(`🔄 Skipping duplicate: ${contact.name || contact.llc_owner}`);
      }
    }

    return unique;
  }

  /**
   * Bulk insert contacts from Claude extraction
   */
  async bulkInsertContacts(claudeContacts) {
    try {
      console.log(`📊 Converting ${claudeContacts.length} Claude contacts to PostgreSQL format...`);

      const postgresContacts = claudeContacts.map(contact => {
        const mapped = this.mapClaudeToPostgres(contact)
        // Clean phone numbers and emails to prevent validation errors
        Object.keys(mapped).forEach(key => {
          if (key.startsWith('phone') && mapped[key]) {
            // Clean phone: keep only allowed characters and truncate
            const cleanedPhone = mapped[key].replace(/[^\d\s\-\(\)\+\.]/g, '').substring(0, 20).trim()
            mapped[key] = cleanedPhone || null // Set to null if empty after cleaning
          }
          if (key.startsWith('email') && mapped[key]) {
            // Clean email: basic validation and truncate
            const email = mapped[key].trim().toLowerCase()
            if (email.includes('@') && email.includes('.')) {
              mapped[key] = email.substring(0, 255)
            } else {
              mapped[key] = null // Invalid email, set to null
            }
          }
          if (key === 'name' && mapped[key]) {
            mapped[key] = mapped[key].substring(0, 255) // Truncate to max length
          }
          if (key === 'llc_owner' && mapped[key]) {
            mapped[key] = mapped[key].substring(0, 255) // Truncate to max length
          }
        })
        return mapped
      }).filter(contact => {
        // Filter out contacts with no useful data
        return contact.name || contact.llc_owner || contact.phone1 || contact.email1
      });

      console.log(`💾 Bulk inserting ${postgresContacts.length} valid contacts into PostgreSQL...`);

      // Remove duplicates before insertion based on name/company + phone/email
      const uniqueContacts = this.removeDuplicates(postgresContacts);
      console.log(`💾 Inserting ${uniqueContacts.length} unique contacts (${postgresContacts.length - uniqueContacts.length} duplicates removed)...`);

      // Log a sample contact for debugging
      if (uniqueContacts.length > 0) {
        console.log('📋 Sample contact data:', JSON.stringify(uniqueContacts[0], null, 2));
      }

      const result = await this.Contact.bulkCreate(uniqueContacts, {
        ignoreDuplicates: true,
        returning: true,
        validate: true
      });

      console.log(`✅ Successfully inserted ${result.length} contacts into PostgreSQL`);

      if (result.length === 0 && uniqueContacts.length > 0) {
        console.warn(`⚠️ Warning: ${uniqueContacts.length} contacts were processed but 0 were inserted - possible duplicates or validation issues`);
      }

      return {
        success: result.length > 0 || uniqueContacts.length === 0,
        insertedCount: result.length,
        skippedCount: postgresContacts.length - result.length,
        processedCount: uniqueContacts.length,
        message: `Inserted ${result.length}/${postgresContacts.length} contacts (${uniqueContacts.length} unique processed)`
      };

    } catch (error) {
      console.error(`❌ PostgreSQL bulk insert failed: ${error.message}`);
      console.error('Full error details:', error);
      if (error.errors && error.errors.length > 0) {
        console.error('Validation errors:', error.errors.map(e => ({
          message: e.message,
          type: e.type,
          path: e.path,
          value: e.value
        })));
      }
      return {
        success: false,
        error: error.message,
        insertedCount: 0,
        detailedError: error.errors || []
      };
    }
  }

  /**
   * Insert single contact
   */
  async insertContact(claudeContact) {
    try {
      const postgresContact = this.mapClaudeToPostgres(claudeContact);
      const result = await this.Contact.create(postgresContact);

      return {
        success: true,
        contact: result,
        id: result.id
      };
    } catch (error) {
      console.error(`❌ Contact insert failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get contact statistics
   */
  async getContactStats() {
    try {
      const [total, acknowledged, legal, pending] = await Promise.all([
        this.Contact.count(),
        this.Contact.count({ where: { acknowledged: true } }),
        this.Contact.count({ where: { islegal: true } }),
        this.Contact.count({ where: { acknowledged: false, islegal: false } })
      ]);

      return {
        success: true,
        stats: {
          total,
          acknowledged,
          legal,
          pending,
          unacknowledged: total - acknowledged
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Search contacts
   */
  async searchContacts(options = {}) {
    try {
      const {
        limit = 25,
        offset = 0,
        name,
        company,
        acknowledged,
        islegal,
        city,
        state,
        requireFirstName = false,
        requireLastName = false,
        requireBothNames = false
      } = options;

      const where = {};

      if (name) where.name = { [this.sequelize.Sequelize.Op.iLike]: `%${name}%` };
      if (company) where.llc_owner = { [this.sequelize.Sequelize.Op.iLike]: `%${company}%` };
      if (acknowledged !== undefined) where.acknowledged = acknowledged;
      if (islegal !== undefined) where.islegal = islegal;
      if (city) where.city = { [this.sequelize.Sequelize.Op.iLike]: `%${city}%` };
      if (state) where.state = { [this.sequelize.Sequelize.Op.iLike]: `%${state}%` };

      // Filter for non-null names
      if (requireBothNames) {
        where.first_name = { [this.sequelize.Sequelize.Op.ne]: null };
        where.last_name = { [this.sequelize.Sequelize.Op.ne]: null };
      } else {
        if (requireFirstName) {
          where.first_name = { [this.sequelize.Sequelize.Op.ne]: null };
        }
        if (requireLastName) {
          where.last_name = { [this.sequelize.Sequelize.Op.ne]: null };
        }
      }

      const result = await this.Contact.findAndCountAll({
        where,
        limit,
        offset,
        order: [['created_at', 'DESC']]
      });

      return {
        success: true,
        contacts: result.rows,
        total: result.count,
        limit,
        offset
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update contact status
   */
  async updateContactStatus(id, updates) {
    try {
      const [updatedRowsCount] = await this.Contact.update(updates, {
        where: { id }
      });

      if (updatedRowsCount === 0) {
        return { success: false, error: 'Contact not found' };
      }

      const updatedContact = await this.Contact.findByPk(id);
      return {
        success: true,
        contact: updatedContact
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Deduplicate contacts in the database
   * Finds duplicates based on name, company, phone, and email
   * Keeps the oldest record (by created_at) and deletes the rest
   */
  async deduplicateContacts(dryRun = true) {
    try {
      console.log(`🔍 Starting deduplication process (dryRun: ${dryRun})...`);

      // Fetch all contacts
      const allContacts = await this.Contact.findAll({
        order: [['created_at', 'ASC']]
      });

      console.log(`📊 Found ${allContacts.length} total contacts`);

      const seen = new Map();
      const duplicates = [];
      const unique = [];

      for (const contact of allContacts) {
        // Create a key based on name/company and primary contact info
        const nameKey = (contact.name || '').toLowerCase().trim();
        const companyKey = (contact.llc_owner || '').toLowerCase().trim();
        const phoneKey = (contact.phone1 || '').replace(/\D/g, ''); // Remove non-digits
        const emailKey = (contact.email1 || '').toLowerCase().trim();

        // Create composite key for duplicate detection
        const duplicateKey = `${nameKey}|${companyKey}|${phoneKey}|${emailKey}`;

        if (!seen.has(duplicateKey) || duplicateKey === '|||') {
          // Keep the first occurrence (oldest by created_at) or skip if all fields are empty
          if (duplicateKey !== '|||') {
            seen.set(duplicateKey, contact.id);
            unique.push(contact);
          }
        } else {
          // Mark as duplicate
          duplicates.push({
            id: contact.id,
            name: contact.name,
            company: contact.llc_owner,
            phone: contact.phone1,
            email: contact.email1,
            created_at: contact.created_at,
            originalId: seen.get(duplicateKey)
          });
        }
      }

      console.log(`✅ Found ${unique.length} unique contacts`);
      console.log(`🔄 Found ${duplicates.length} duplicate contacts`);

      if (duplicates.length > 0) {
        console.log('\n📋 Duplicate examples (first 10):');
        duplicates.slice(0, 10).forEach((dup, idx) => {
          console.log(`  ${idx + 1}. ID ${dup.id}: ${dup.name || dup.company} (original: ${dup.originalId})`);
        });
      }

      if (!dryRun && duplicates.length > 0) {
        console.log('\n🗑️ Deleting duplicates...');
        const duplicateIds = duplicates.map(d => d.id);

        const deletedCount = await this.Contact.destroy({
          where: {
            id: {
              [this.sequelize.Sequelize.Op.in]: duplicateIds
            }
          }
        });

        console.log(`✅ Deleted ${deletedCount} duplicate contacts`);

        return {
          success: true,
          totalContacts: allContacts.length,
          uniqueContacts: unique.length,
          duplicatesFound: duplicates.length,
          duplicatesDeleted: deletedCount,
          dryRun: false
        };
      }

      return {
        success: true,
        totalContacts: allContacts.length,
        uniqueContacts: unique.length,
        duplicatesFound: duplicates.length,
        duplicatesDeleted: 0,
        dryRun: true,
        message: dryRun ? 'Dry run completed - no records deleted. Set dryRun=false to delete duplicates.' : 'No duplicates found'
      };

    } catch (error) {
      console.error('❌ Deduplication failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Test database connection and model
   */
  async testConnection() {
    try {
      await this.sequelize.authenticate();
      console.log('✅ PostgreSQL connection successful');

      // Test if table exists and can be queried
      const count = await this.Contact.count();
      console.log(`📊 Current contacts in database: ${count}`);

      // Test a simple insert to verify model works
      const testContact = {
        name: 'Test Contact',
        llc_owner: null,
        phone1: '555-0123',
        email1: 'test@example.com',
        address: '123 Test St',
        city: 'Test City',
        state: 'TX',
        zip: '12345',
        acknowledged: false,
        islegal: false
      };

      console.log('🧪 Testing single contact insert...');
      const testResult = await this.Contact.create(testContact);
      console.log('✅ Test insert successful, ID:', testResult.id);

      // Clean up test record
      await testResult.destroy();
      console.log('🧹 Test record cleaned up');

      return {
        success: true,
        message: 'PostgreSQL connection and model working correctly',
        contactCount: count
      };
    } catch (error) {
      console.error('❌ Database test failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = PostgresContactService;