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

    // Parse address components
    const { street, city, state, zip, unit } = this.parseAddress(claudeContact.address || '');

    return {
      name: claudeContact.name || claudeContact.company || null,
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
      acknowledged: false,
      islegal: this.isLegalEntity(claudeContact)
    };
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
      'attorney', 'atty', 'lawyer', 'legal', 'law firm', 'law office',
      'esquire', 'esq', 'j.d.', 'juris doctor', 'p.c.', 'p.a.', 'pllc',
      'llp', 'counsel', 'legal representative', 'legal department'
    ];

    const text = (contact.name + ' ' + contact.company + ' ' + contact.notes).toLowerCase();
    return legalIndicators.some(indicator => text.includes(indicator));
  }

  /**
   * Bulk insert contacts from Claude extraction
   */
  async bulkInsertContacts(claudeContacts) {
    try {
      console.log(`📊 Converting ${claudeContacts.length} Claude contacts to PostgreSQL format...`);

      const postgresContacts = claudeContacts.map(contact =>
        this.mapClaudeToPostgres(contact)
      );

      console.log(`💾 Bulk inserting ${postgresContacts.length} contacts into PostgreSQL...`);

      const result = await this.Contact.bulkCreate(postgresContacts, {
        ignoreDuplicates: true,
        returning: true,
        validate: true
      });

      console.log(`✅ Successfully inserted ${result.length} contacts into PostgreSQL`);

      return {
        success: true,
        insertedCount: result.length,
        skippedCount: postgresContacts.length - result.length,
        message: `Inserted ${result.length}/${postgresContacts.length} contacts`
      };

    } catch (error) {
      console.error(`❌ PostgreSQL bulk insert failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        insertedCount: 0
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
        state
      } = options;

      const where = {};

      if (name) where.name = { [this.sequelize.Sequelize.Op.iLike]: `%${name}%` };
      if (company) where.llc_owner = { [this.sequelize.Sequelize.Op.iLike]: `%${company}%` };
      if (acknowledged !== undefined) where.acknowledged = acknowledged;
      if (islegal !== undefined) where.islegal = islegal;
      if (city) where.city = { [this.sequelize.Sequelize.Op.iLike]: `%${city}%` };
      if (state) where.state = { [this.sequelize.Sequelize.Op.iLike]: `%${state}%` };

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
   * Test database connection
   */
  async testConnection() {
    try {
      await this.sequelize.authenticate();
      return {
        success: true,
        message: 'PostgreSQL connection successful'
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