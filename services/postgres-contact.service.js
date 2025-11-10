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
    if (claudeContact.email) {
      const validatedEmail = this.validateEmail(claudeContact.email);
      if (validatedEmail) emails.push(validatedEmail);
    }

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

    // Parse address components only if Claude didn't provide separate fields
    // Prefer Claude's separate fields (city, state, zip) over parsed values
    const parsed = this.parseAddress(claudeContact.address || '');

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
      address: claudeContact.address || parsed.street || null,
      city: claudeContact.city || parsed.city || null,
      state: claudeContact.state || parsed.state || null,
      zip: claudeContact.zip || parsed.zip || null,
      unit: claudeContact.unit || parsed.unit || null,
      first_name: firstName || null,
      last_name: lastName || null,
      notes: claudeContact.notes || null,
      record_type: claudeContact.record_type || null,
      document_section: claudeContact.document_section || null,
      source_file: claudeContact.source_file || null,
      mineral_rights_percentage: claudeContact.mineral_rights_percentage || null,
      ownership_type: claudeContact.ownership_type || null,
      project_origin: claudeContact.project_origin || null,
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
   * Validate and clean email address
   * Returns cleaned email or null if invalid
   */
  validateEmail(email) {
    if (!email || typeof email !== 'string') return null;

    // Clean the email
    let cleaned = email.trim().toLowerCase();

    // Remove any surrounding quotes or brackets
    cleaned = cleaned.replace(/^["'<[]+|["'>\]]+$/g, '');

    // Basic email regex (simple but effective)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(cleaned)) {
      console.warn(`⚠️ Invalid email format rejected: "${email}"`);
      return null;
    }

    // Additional checks for common issues
    if (cleaned.includes('..')) return null; // Double dots
    if (cleaned.includes('@.')) return null; // @ followed by dot
    if (cleaned.includes('.@')) return null; // Dot followed by @
    if (cleaned.startsWith('.')) return null; // Starts with dot
    if (cleaned.endsWith('.')) return null; // Ends with dot

    // Length check
    if (cleaned.length < 5 || cleaned.length > 254) return null;

    return cleaned;
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

      // Skip client-side duplicate removal - let database handle duplicates via ignoreDuplicates flag
      // This allows all contacts to be inserted, even if they appear similar
      console.log(`💾 Inserting ${postgresContacts.length} contacts (duplicate removal skipped)...`);

      // Log a sample contact for debugging
      if (postgresContacts.length > 0) {
        console.log('📋 Sample contact data:', JSON.stringify(postgresContacts[0], null, 2));
      }

      const result = await this.Contact.bulkCreate(postgresContacts, {
        ignoreDuplicates: true,
        returning: true,
        validate: true
      });

      console.log(`✅ Successfully inserted ${result.length} contacts into PostgreSQL`);

      if (result.length === 0 && postgresContacts.length > 0) {
        console.warn(`⚠️ Warning: ${postgresContacts.length} contacts were processed but 0 were inserted - possible database duplicates or validation issues`);
      }

      return {
        success: result.length > 0 || postgresContacts.length === 0,
        insertedCount: result.length,
        skippedCount: postgresContacts.length - result.length,
        processedCount: postgresContacts.length,
        message: `Inserted ${result.length}/${postgresContacts.length} contacts`
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

        // Try to find and log the problematic record
        for (const err of error.errors) {
          if (err.record) {
            console.error('Problematic record:', JSON.stringify({
              name: err.record.name,
              company: err.record.llc_owner,
              email1: err.record.email1,
              email2: err.record.email2,
              source_file: err.record.source_file
            }, null, 2));
          }
        }
      }

      // Try to identify which email is causing the problem
      if (error.message.includes('email')) {
        console.error('\n🔍 Scanning for invalid emails in batch:');
        uniqueContacts.forEach((contact, idx) => {
          if (contact.email1 && !this.validateEmail(contact.email1)) {
            console.error(`  Invalid email1 at index ${idx}: "${contact.email1}" (contact: ${contact.name || contact.llc_owner})`);
          }
          if (contact.email2 && !this.validateEmail(contact.email2)) {
            console.error(`  Invalid email2 at index ${idx}: "${contact.email2}" (contact: ${contact.name || contact.llc_owner})`);
          }
        });
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
        search, // New: search across all fields
        requireFirstName = false,
        requireLastName = false,
        requireBothNames = false,
        sortBy = 'created_at',
        sortOrder = 'DESC'
      } = options;

      const where = {};

      // Global search across multiple fields
      if (search) {
        const searchTerm = `%${search}%`;
        where[this.sequelize.Sequelize.Op.or] = [
          { name: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { first_name: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { last_name: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { llc_owner: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { phone1: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { email1: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { address: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { city: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { state: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { zip: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { notes: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { record_type: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { document_section: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { source_file: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } }
        ];
      }

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

      // Validate sortBy to prevent SQL injection
      const allowedSortFields = [
        'id', 'name', 'first_name', 'last_name', 'llc_owner',
        'company', 'city', 'state', 'acknowledged', 'islegal',
        'created_at', 'updated_at'
      ];

      const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
      const sortDirection = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

      const result = await this.Contact.findAndCountAll({
        where,
        limit,
        offset,
        order: [[sortField, sortDirection]]
      });

      return {
        success: true,
        contacts: result.rows,
        total: result.count,
        limit,
        offset,
        sortBy: sortField,
        sortOrder: sortDirection
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
   * Calculate string similarity using Levenshtein distance
   * Returns a value between 0 (completely different) and 1 (identical)
   */
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;

    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) costs[s2.length] = lastValue;
    }

    const maxLength = Math.max(s1.length, s2.length);
    return maxLength === 0 ? 1 : (maxLength - costs[s2.length]) / maxLength;
  }

  /**
   * Deduplicate contacts with multiple strategies
   * @param {string} mode - 'strict', 'name-only', 'name-company', or 'fuzzy'
   * @param {boolean} dryRun - If true, only preview duplicates without deleting
   */
  async deduplicateContactsByMode(mode = 'strict', dryRun = true) {
    try {
      console.log(`🔍 Starting ${mode} deduplication (dryRun: ${dryRun})...`);

      // Fetch all contacts
      const allContacts = await this.Contact.findAll({
        order: [['created_at', 'ASC']]
      });

      console.log(`📊 Found ${allContacts.length} total contacts`);

      const seen = new Map();
      const duplicates = [];
      const unique = [];

      for (const contact of allContacts) {
        const firstNameKey = (contact.first_name || '').toLowerCase().trim();
        const lastNameKey = (contact.last_name || '').toLowerCase().trim();
        const nameKey = (contact.name || '').toLowerCase().trim();
        const companyKey = (contact.llc_owner || '').toLowerCase().trim();
        const phoneKey = (contact.phone1 || '').replace(/\D/g, '');
        const emailKey = (contact.email1 || '').toLowerCase().trim();

        const personKey = (firstNameKey && lastNameKey)
          ? `${firstNameKey}::${lastNameKey}`
          : nameKey;

        let duplicateKey;
        let matchReason;

        // Build duplicate key based on mode
        switch (mode) {
          case 'name-only':
            duplicateKey = personKey;
            matchReason = 'Same first and last name';
            break;

          case 'name-company':
            duplicateKey = `${personKey}|${companyKey}`;
            matchReason = 'Same name and company';
            break;

          case 'fuzzy':
            // For fuzzy mode, we need to check similarity against existing contacts
            let fuzzyMatch = null;
            const fuzzyThreshold = 0.9; // 90% similarity

            for (const [key, existingId] of seen.entries()) {
              const [existingPerson, existingCompany] = key.split('|FUZZY|');

              const nameSimilarity = this.calculateSimilarity(personKey, existingPerson);
              const companySimilarity = companyKey && existingCompany
                ? this.calculateSimilarity(companyKey, existingCompany)
                : 1;

              if (nameSimilarity >= fuzzyThreshold && companySimilarity >= fuzzyThreshold) {
                fuzzyMatch = { key, id: existingId, nameSim: nameSimilarity, companySim: companySimilarity };
                break;
              }
            }

            if (fuzzyMatch) {
              duplicateKey = fuzzyMatch.key;
              matchReason = `Fuzzy match (name: ${(fuzzyMatch.nameSim * 100).toFixed(0)}%, company: ${(fuzzyMatch.companySim * 100).toFixed(0)}%)`;
            } else {
              duplicateKey = `${personKey}|FUZZY|${companyKey}`;
              matchReason = 'Fuzzy match';
            }
            break;

          case 'strict':
          default:
            duplicateKey = `${personKey}|${companyKey}|${phoneKey}|${emailKey}`;
            matchReason = 'Exact match on all fields';
            break;
        }

        // Skip empty keys
        if (!duplicateKey || duplicateKey === '' || personKey === '' || duplicateKey.includes('|||')) {
          continue;
        }

        if (!seen.has(duplicateKey)) {
          seen.set(duplicateKey, contact.id);
          unique.push(contact);
        } else {
          duplicates.push({
            id: contact.id,
            name: contact.name,
            first_name: contact.first_name,
            last_name: contact.last_name,
            company: contact.llc_owner,
            phone: contact.phone1,
            email: contact.email1,
            source_file: contact.source_file,
            created_at: contact.created_at,
            originalId: seen.get(duplicateKey),
            matchReason
          });
        }
      }

      console.log(`✅ Found ${unique.length} unique contacts`);
      console.log(`🔄 Found ${duplicates.length} duplicate contacts`);

      if (duplicates.length > 0) {
        console.log(`\n📋 Duplicate examples (first 10) for mode: ${mode}`);
        duplicates.slice(0, 10).forEach((dup, idx) => {
          const personInfo = dup.first_name && dup.last_name
            ? `${dup.first_name} ${dup.last_name}`
            : dup.name;
          console.log(`  ${idx + 1}. ID ${dup.id}: ${personInfo || dup.company}`);
          console.log(`      Company: ${dup.company || 'none'}`);
          console.log(`      Source: ${dup.source_file || 'unknown'}`);
          console.log(`      Match: ${dup.matchReason}`);
          console.log(`      Original ID: ${dup.originalId}\n`);
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
          mode,
          totalContacts: allContacts.length,
          uniqueContacts: unique.length,
          duplicatesFound: duplicates.length,
          duplicatesDeleted: deletedCount,
          dryRun: false,
          duplicateExamples: duplicates.slice(0, 10)
        };
      }

      return {
        success: true,
        mode,
        totalContacts: allContacts.length,
        uniqueContacts: unique.length,
        duplicatesFound: duplicates.length,
        duplicatesDeleted: 0,
        dryRun: true,
        message: dryRun ? `Dry run completed - found ${duplicates.length} duplicates. Set dryRun=false to delete them.` : 'No duplicates found',
        duplicateExamples: duplicates.slice(0, 10)
      };

    } catch (error) {
      console.error('❌ Deduplication failed:', error.message);
      return {
        success: false,
        mode,
        error: error.message
      };
    }
  }

  /**
   * Deduplicate contacts in the database (backward compatibility)
   * Finds duplicates based on name, company, phone, and email
   * Keeps the oldest record (by created_at) and deletes the rest
   *
   * This method now uses the new mode-based deduplication with 'strict' mode
   */
  async deduplicateContacts(dryRun = true) {
    return this.deduplicateContactsByMode('strict', dryRun);
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

  /**
   * Delete a single contact by ID
   * @param {number} id - Contact ID to delete
   * @returns {Object} - Result object with success status
   */
  async deleteContact(id) {
    try {
      const contact = await this.Contact.findByPk(id);

      if (!contact) {
        console.warn(`⚠️ Contact with ID ${id} not found`);
        return {
          success: false,
          message: `Contact with ID ${id} not found`
        };
      }

      // Store contact info for logging
      const contactInfo = {
        id: contact.id,
        name: contact.name,
        company: contact.llc_owner,
        source_file: contact.source_file
      };

      await contact.destroy();

      console.log(`✅ Deleted contact ID ${id}: ${contactInfo.name || contactInfo.company || 'Unknown'}`);

      return {
        success: true,
        message: `Contact deleted successfully`,
        deletedContact: contactInfo
      };

    } catch (error) {
      console.error(`❌ Failed to delete contact ID ${id}:`, error.message);
      return {
        success: false,
        message: `Delete failed: ${error.message}`
      };
    }
  }

  /**
   * Bulk delete multiple contacts by IDs
   * @param {Array<number>} ids - Array of contact IDs to delete
   * @returns {Object} - Result object with success status and count
   */
  async bulkDeleteContacts(ids) {
    try {
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return {
          success: false,
          message: 'No contact IDs provided'
        };
      }

      console.log(`🗑️ Bulk deleting ${ids.length} contacts...`);

      // Find contacts to be deleted (for logging)
      const contactsToDelete = await this.Contact.findAll({
        where: {
          id: {
            [this.sequelize.Sequelize.Op.in]: ids
          }
        },
        attributes: ['id', 'name', 'llc_owner', 'source_file']
      });

      const deletedCount = await this.Contact.destroy({
        where: {
          id: {
            [this.sequelize.Sequelize.Op.in]: ids
          }
        }
      });

      console.log(`✅ Deleted ${deletedCount} out of ${ids.length} requested contacts`);

      if (deletedCount !== ids.length) {
        console.warn(`⚠️ Some contacts were not found: requested ${ids.length}, deleted ${deletedCount}`);
      }

      return {
        success: true,
        message: `Deleted ${deletedCount} contact(s)`,
        deletedCount,
        requestedCount: ids.length,
        notFoundCount: ids.length - deletedCount,
        deletedContacts: contactsToDelete.map(c => ({
          id: c.id,
          name: c.name,
          company: c.llc_owner
        }))
      };

    } catch (error) {
      console.error(`❌ Bulk delete failed:`, error.message);
      return {
        success: false,
        message: `Bulk delete failed: ${error.message}`
      };
    }
  }
}

module.exports = PostgresContactService;