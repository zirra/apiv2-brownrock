require('dotenv').config();
const { pgdbconnect, Contact, ContactReady } = require('../config/pddbclient.cjs');

class PostgresContactService {
  constructor() {
    this.Contact = Contact;
    this.ContactReady = ContactReady;
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
      jobid: claudeContact.jobid || null,
      app_number: claudeContact.app_number || null,
      order_number: claudeContact.order_number || null,
      case_number: claudeContact.case_number || null,
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

  /**
   * Find all contacts by job ID
   * @param {string} jobId - The job ID to query
   * @returns {Object} - Result object with contacts array
   */
  async findByJobId(jobId) {
    try {
      if (!jobId) {
        return {
          success: false,
          message: 'Job ID is required'
        };
      }

      const contacts = await this.Contact.findAll({
        where: { jobid: jobId },
        order: [['created_at', 'DESC']]
      });

      return {
        success: true,
        contacts,
        count: contacts.length,
        jobId
      };
    } catch (error) {
      console.error(`❌ Failed to find contacts by job ID:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get contacts by job ID with pagination
   * @param {string} jobId - Job ID to find contacts for
   * @param {number} limit - Number of results to return
   * @param {number} offset - Number of results to skip
   * @returns {Promise<Object>} - { rows, count }
   */
  async getContactsByJobId(jobId, limit = 50, offset = 0) {
    try {
      if (!jobId) {
        throw new Error('Job ID is required');
      }

      const { rows, count } = await this.Contact.findAndCountAll({
        where: { jobid: jobId },
        order: [['created_at', 'DESC']],
        limit,
        offset
      });

      return { rows, count };
    } catch (error) {
      console.error(`❌ Failed to get contacts by job ID:`, error.message);
      throw error;
    }
  }

  /**
   * Find the latest job ID for a given project origin
   * @param {string} projectOrigin - The project origin (e.g., 'OCD_IMAGING', 'OCD_CBT')
   * @returns {Object} - Result object with latest job info
   */
  async findLatestJobByOrigin(projectOrigin) {
    try {
      if (!projectOrigin) {
        return {
          success: false,
          message: 'Project origin is required'
        };
      }

      // Find the most recent contact for this project origin
      const latestContact = await this.Contact.findOne({
        where: {
          project_origin: projectOrigin,
          jobid: {
            [this.sequelize.Sequelize.Op.ne]: null
          }
        },
        order: [['created_at', 'DESC']],
        attributes: ['jobid', 'created_at']
      });

      if (!latestContact || !latestContact.jobid) {
        return {
          success: false,
          message: `No jobs found for project origin: ${projectOrigin}`
        };
      }

      // Now get all contacts from that job
      const contacts = await this.Contact.findAll({
        where: { jobid: latestContact.jobid },
        order: [['created_at', 'DESC']]
      });

      return {
        success: true,
        jobId: latestContact.jobid,
        projectOrigin,
        contacts,
        count: contacts.length,
        jobCreatedAt: latestContact.created_at
      };
    } catch (error) {
      console.error(`❌ Failed to find latest job:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get statistics for a specific job
   * @param {string} jobId - The job ID to analyze
   * @returns {Object} - Result object with job statistics
   */
  async getJobStatistics(jobId) {
    try {
      if (!jobId) {
        return {
          success: false,
          message: 'Job ID is required'
        };
      }

      const contacts = await this.Contact.findAll({
        where: { jobid: jobId },
        attributes: [
          'id', 'name', 'llc_owner', 'first_name', 'last_name',
          'phone1', 'email1', 'islegal', 'acknowledged',
          'project_origin', 'source_file', 'created_at'
        ]
      });

      if (contacts.length === 0) {
        return {
          success: false,
          message: `No contacts found for job ID: ${jobId}`
        };
      }

      // Calculate statistics
      const stats = {
        totalContacts: contacts.length,
        individuals: contacts.filter(c => !c.llc_owner).length,
        businesses: contacts.filter(c => c.llc_owner).length,
        withPhone: contacts.filter(c => c.phone1).length,
        withEmail: contacts.filter(c => c.email1).length,
        legal: contacts.filter(c => c.islegal).length,
        acknowledged: contacts.filter(c => c.acknowledged).length,
        projectOrigin: contacts[0].project_origin,
        sourceFiles: [...new Set(contacts.map(c => c.source_file).filter(Boolean))],
        createdAt: contacts[0].created_at
      };

      return {
        success: true,
        jobId,
        statistics: stats,
        contacts: contacts.map(c => ({
          id: c.id,
          name: c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
          company: c.llc_owner,
          phone: c.phone1,
          email: c.email1,
          source: c.source_file
        }))
      };
    } catch (error) {
      console.error(`❌ Failed to get job statistics:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get all unique job IDs for a project origin
   * @param {string} projectOrigin - The project origin to query
   * @returns {Object} - Result object with job IDs and counts
   */
  async getJobsByOrigin(projectOrigin) {
    try {
      if (!projectOrigin) {
        return {
          success: false,
          message: 'Project origin is required'
        };
      }

      // Get all unique job IDs with counts
      const jobs = await this.sequelize.query(
        `SELECT jobid, COUNT(*) as contact_count, MIN(created_at) as job_date
         FROM contacts
         WHERE project_origin = :projectOrigin AND jobid IS NOT NULL
         GROUP BY jobid
         ORDER BY job_date DESC`,
        {
          replacements: { projectOrigin },
          type: this.sequelize.QueryTypes.SELECT
        }
      );

      return {
        success: true,
        projectOrigin,
        jobs: jobs.map(j => ({
          jobId: j.jobid,
          contactCount: parseInt(j.contact_count),
          jobDate: j.job_date
        })),
        totalJobs: jobs.length
      };
    } catch (error) {
      console.error(`❌ Failed to get jobs by origin:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Move non-duplicate contacts from contacts table to contactsready table
   * Uses the unique constraint on contactsready to filter duplicates:
   * (name, first_name, last_name, llc_owner, address, city, state, zip)
   *
   * @param {Object} options - Options for the migration
   * @param {number} options.limit - Maximum number of contacts to process (default: 1000)
   * @param {number} options.offset - Number of contacts to skip (default: 0)
   * @param {string} options.job_id - Filter by specific job_id (optional)
   * @param {string} options.project_origin - Filter by project_origin (optional)
   * @returns {Promise<Object>} - Result with counts of moved, skipped, and failed contacts
   */
  async moveContactsToReady(options = {}) {
    const {
      limit = 1000,
      offset = 0,
      job_id = null,
      project_origin = null
    } = options;

    try {
      console.log('📦 Starting contact migration from contacts to contactsready...');
      console.log(`   Limit: ${limit}, Offset: ${offset}`);
      if (job_id) console.log(`   Filtering by job_id: ${job_id}`);
      if (project_origin) console.log(`   Filtering by project_origin: ${project_origin}`);

      // Build where clause for filtering
      const where = {};
      if (job_id) where.jobid = job_id;
      if (project_origin) where.project_origin = project_origin;

      // Get contacts from contacts table
      const contacts = await this.Contact.findAll({
        where,
        limit,
        offset,
        order: [['created_at', 'DESC']]
      });

      if (contacts.length === 0) {
        console.log('📭 No contacts found to migrate');
        return {
          success: true,
          processed: 0,
          moved: 0,
          skipped: 0,
          failed: 0,
          message: 'No contacts found to migrate'
        };
      }

      console.log(`📊 Found ${contacts.length} contacts to process`);

      let moved = 0;
      let skipped = 0;
      let failed = 0;
      const failedContacts = [];

      // Get valid fields for ContactReady model (only once, outside loop)
      const validFields = Object.keys(this.ContactReady.rawAttributes);

      // Process each contact
      for (const contact of contacts) {
        try {
          // Convert to plain object and remove id/timestamps for insertion
          const contactData = contact.toJSON();
          delete contactData.id;
          delete contactData.created_at;
          delete contactData.updated_at;

          // Filter to only include fields that exist in ContactReady
          const filteredData = {};
          for (const key of validFields) {
            if (key !== 'id' && key !== 'created_at' && key !== 'updated_at' && contactData.hasOwnProperty(key)) {
              filteredData[key] = contactData[key];
            }
          }

          // Try to insert into contactsready
          // findOrCreate will skip if unique constraint is violated
          const [created] = await this.ContactReady.findOrCreate({
            where: {
              name: filteredData.name,
              first_name: filteredData.first_name,
              last_name: filteredData.last_name,
              llc_owner: filteredData.llc_owner,
              address: filteredData.address,
              city: filteredData.city,
              state: filteredData.state,
              zip: filteredData.zip
            },
            defaults: filteredData
          });

          if (created) {
            moved++;
            if (moved % 100 === 0) {
              console.log(`   ✅ Moved ${moved} contacts so far...`);
            }
          } else {
            skipped++;
          }

        } catch (error) {
          failed++;
          failedContacts.push({
            contact_id: contact.id,
            name: contact.name,
            error: error.message
          });
          console.error(`   ❌ Failed to move contact ${contact.id}:`, error.message);
        }
      }

      // Summary
      console.log('\n' + '='.repeat(80));
      console.log('📊 CONTACT MIGRATION SUMMARY');
      console.log('='.repeat(80));
      console.log(`Total processed: ${contacts.length}`);
      console.log(`✅ Successfully moved: ${moved}`);
      console.log(`⏭️ Skipped (duplicates): ${skipped}`);
      console.log(`❌ Failed: ${failed}`);
      console.log('='.repeat(80) + '\n');

      return {
        success: true,
        processed: contacts.length,
        moved,
        skipped,
        failed,
        failedContacts: failedContacts.length > 0 ? failedContacts : undefined,
        message: `Successfully moved ${moved} contacts, skipped ${skipped} duplicates, ${failed} failed`
      };

    } catch (error) {
      console.error('❌ Failed to move contacts to ready:', error.message);
      return {
        success: false,
        error: error.message,
        processed: 0,
        moved: 0,
        skipped: 0,
        failed: 0
      };
    }
  }

  /**
   * Move all contacts from a specific job to contactsready
   * Convenience method that calls moveContactsToReady with job_id filter
   *
   * @param {string} jobId - Job ID to migrate contacts from
   * @returns {Promise<Object>} - Result with counts
   */
  async moveJobContactsToReady(jobId) {
    return this.moveContactsToReady({ job_id: jobId, limit: 10000 });
  }

  /**
   * Move all contacts from a specific project origin to contactsready
   * Processes in batches to handle large datasets
   *
   * @param {string} projectOrigin - Project origin to migrate (e.g., 'OCD_IMAGING')
   * @param {number} batchSize - Number of contacts per batch (default: 1000)
   * @returns {Promise<Object>} - Aggregate result with total counts
   */
  async moveProjectContactsToReady(projectOrigin, batchSize = 1000) {
    console.log(`📦 Starting batch migration for project: ${projectOrigin}`);

    let totalMoved = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalProcessed = 0;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      console.log(`\n🔄 Processing batch starting at offset ${offset}...`);

      const result = await this.moveContactsToReady({
        project_origin: projectOrigin,
        limit: batchSize,
        offset
      });

      if (!result.success) {
        console.error(`❌ Batch failed at offset ${offset}:`, result.error);
        break;
      }

      totalMoved += result.moved;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      totalProcessed += result.processed;

      // If we got fewer contacts than the batch size, we're done
      if (result.processed < batchSize) {
        hasMore = false;
      } else {
        offset += batchSize;
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log(`📊 COMPLETE PROJECT MIGRATION SUMMARY: ${projectOrigin}`);
    console.log('='.repeat(80));
    console.log(`Total processed: ${totalProcessed}`);
    console.log(`✅ Successfully moved: ${totalMoved}`);
    console.log(`⏭️ Skipped (duplicates): ${totalSkipped}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log('='.repeat(80) + '\n');

    return {
      success: true,
      project_origin: projectOrigin,
      total_processed: totalProcessed,
      total_moved: totalMoved,
      total_skipped: totalSkipped,
      total_failed: totalFailed,
      message: `Completed migration for ${projectOrigin}: ${totalMoved} moved, ${totalSkipped} skipped, ${totalFailed} failed`
    };
  }

  /**
   * Get distinct job IDs from contacts table with formatted labels
   */
  async getJobIds() {
    try {
      const { fn, col } = require('sequelize');

      // Get distinct job IDs
      const results = await this.Contact.findAll({
        attributes: [
          [fn('DISTINCT', col('jobid')), 'jobid']
        ],
        where: {
          jobid: {
            [this.sequelize.Sequelize.Op.ne]: null
          }
        },
        order: [[col('jobid'), 'DESC']],
        raw: true
      });

      // Format each job ID
      const formattedJobs = results.map(row => {
        const jobid = row.jobid;
        const tarr = jobid.split('_');
        let lstring;
        let stamp;

        if (tarr.length === 4) {
          stamp = this.formatTimestamp(tarr[2]);
          lstring = `${tarr[0]} ${tarr[1]} ${stamp}`;
        } else {
          stamp = this.formatTimestamp(tarr[1]);
          lstring = `${tarr[0]} ${stamp}`;
        }

        return {
          jobid: jobid,
          label: lstring,
          project: tarr[0],
          subtype: tarr.length === 4 ? tarr[1] : null,
          timestamp: tarr.length === 4 ? tarr[2] : tarr[1],
          formatted_timestamp: stamp
        };
      });

      return {
        success: true,
        jobs: formattedJobs,
        total: formattedJobs.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Format timestamp from job ID (e.g., "20240115123045" -> "Jan 15, 2024 12:30 PM")
   */
  formatTimestamp(timestamp) {
    if (!timestamp || timestamp.length !== 14) {
      return timestamp;
    }

    try {
      const year = timestamp.substring(0, 4);
      const month = timestamp.substring(4, 6);
      const day = timestamp.substring(6, 8);
      const hour = parseInt(timestamp.substring(8, 10));
      const minute = timestamp.substring(10, 12);

      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      const monthName = monthNames[parseInt(month) - 1];
      const period = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;

      return `${monthName} ${parseInt(day)}, ${year} ${displayHour}:${minute} ${period}`;
    } catch (err) {
      return timestamp;
    }
  }

  /**
   * Get contactsready statistics
   */
  async getContactReadyStats() {
    try {
      const [total, verified, legal, pending] = await Promise.all([
        this.ContactReady.count(),
        this.ContactReady.count({ where: { verified: true } }),
        this.ContactReady.count({ where: { islegal: true } }),
        this.ContactReady.count({ where: { verified: false } })
      ]);

      return {
        success: true,
        stats: {
          total,
          verified,
          legal,
          pending,
          verification_rate: total > 0 ? Math.round((verified / total) * 100) : 0
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
   * Search contactsready
   */
  async searchContactsReady(options = {}) {
    try {
      const {
        limit = 25,
        offset = 0,
        name,
        company,
        verified,
        islegal,
        city,
        state,
        search,
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
      if (verified !== undefined) where.verified = verified;
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
        'company', 'city', 'state', 'verified', 'islegal',
        'created_at', 'updated_at'
      ];

      const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
      const sortDirection = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

      const result = await this.ContactReady.findAndCountAll({
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
   * Update contactsready status
   */
  async updateContactReadyStatus(id, updates) {
    try {
      const [updatedRowsCount] = await this.ContactReady.update(updates, {
        where: { id }
      });

      if (updatedRowsCount === 0) {
        return { success: false, error: 'Contact not found' };
      }

      const updatedContact = await this.ContactReady.findByPk(id);
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
   * Delete contact from contactsready
   */
  async deleteContactReady(id) {
    try {
      const deletedRowCount = await this.ContactReady.destroy({
        where: { id }
      });

      if (deletedRowCount === 0) {
        return { success: false, error: 'Contact not found' };
      }

      return {
        success: true,
        message: 'Contact deleted successfully'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get contactsready by ID
   */
  async getContactReadyById(id) {
    try {
      const contact = await this.ContactReady.findByPk(id);

      if (!contact) {
        return { success: false, error: 'Contact not found' };
      }

      return {
        success: true,
        contact
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Export contactsready to CSV format
   */
  async exportContactsReadyToCSV(options = {}) {
    try {
      const {
        verified,
        islegal,
        city,
        state,
        search
      } = options;

      const where = {};

      if (search) {
        const searchTerm = `%${search}%`;
        where[this.sequelize.Sequelize.Op.or] = [
          { name: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { first_name: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { last_name: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { llc_owner: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { address: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } },
          { city: { [this.sequelize.Sequelize.Op.iLike]: searchTerm } }
        ];
      }

      if (verified !== undefined) where.verified = verified;
      if (islegal !== undefined) where.islegal = islegal;
      if (city) where.city = { [this.sequelize.Sequelize.Op.iLike]: `%${city}%` };
      if (state) where.state = { [this.sequelize.Sequelize.Op.iLike]: `%${state}%` };

      const contacts = await this.ContactReady.findAll({
        where,
        order: [['created_at', 'DESC']]
      });

      // Convert to CSV
      const headers = [
        'ID', 'Name', 'First Name', 'Last Name', 'Company',
        'Phone1', 'Phone2', 'Email1', 'Email2',
        'Address', 'City', 'State', 'ZIP', 'Unit',
        'Record Type', 'Document Section', 'Source File',
        'Project Origin', 'App Number', 'Order Number', 'Case Number',
        'Verified', 'Is Legal', 'Created At'
      ];

      const csvRows = [headers.join(',')];

      for (const contact of contacts) {
        const row = [
          contact.id,
          this.escapeCSV(contact.name),
          this.escapeCSV(contact.first_name),
          this.escapeCSV(contact.last_name),
          this.escapeCSV(contact.llc_owner),
          this.escapeCSV(contact.phone1),
          this.escapeCSV(contact.phone2),
          this.escapeCSV(contact.email1),
          this.escapeCSV(contact.email2),
          this.escapeCSV(contact.address),
          this.escapeCSV(contact.city),
          this.escapeCSV(contact.state),
          this.escapeCSV(contact.zip),
          this.escapeCSV(contact.unit),
          this.escapeCSV(contact.record_type),
          this.escapeCSV(contact.document_section),
          this.escapeCSV(contact.source_file),
          this.escapeCSV(contact.project_origin),
          this.escapeCSV(contact.app_number),
          this.escapeCSV(contact.order_number),
          this.escapeCSV(contact.case_number),
          contact.verified,
          contact.islegal,
          contact.created_at
        ];
        csvRows.push(row.join(','));
      }

      return {
        success: true,
        csv: csvRows.join('\n'),
        count: contacts.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = PostgresContactService;