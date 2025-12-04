require('dotenv').config();
const { Contact, pgdbconnect } = require('../config/pddbclient.cjs');
const { Op } = require('sequelize');

/**
 * Address Data Normalization Script
 *
 * This script normalizes address data in the contacts table:
 * 1. Extracts clean street addresses (removes embedded city/state/zip)
 * 2. Normalizes ZIP codes to 5-digit format (strips ZIP+4)
 * 3. Ensures state codes are 2-letter uppercase format
 *
 * Run with: node scripts/normalize-address-data.js [--dry-run] [--batch-size=100]
 */

class AddressNormalizer {
  constructor(options = {}) {
    this.dryRun = options.dryRun || false;
    this.batchSize = options.batchSize || 100;
    this.stats = {
      total: 0,
      addressCleaned: 0,
      zipNormalized: 0,
      stateNormalized: 0,
      errors: 0,
      skipped: 0
    };
  }

  /**
   * Extract clean street address (everything before first comma)
   */
  normalizeAddress(address) {
    if (!address || !address.trim()) return null;

    const addr = address.trim();

    // If address contains comma, extract just the street portion
    if (addr.includes(',')) {
      const parts = addr.split(',');
      return parts[0].trim();
    }

    return addr;
  }

  /**
   * Strip ZIP+4 format to 5-digit ZIP
   */
  normalizeZip(zip) {
    if (!zip || !zip.trim()) return null;

    const zipStr = zip.trim();

    // If ZIP has dash (ZIP+4 format), take only first 5 digits
    if (zipStr.includes('-')) {
      return zipStr.split('-')[0];
    }

    return zipStr;
  }

  /**
   * Normalize state to 2-letter uppercase code
   * Handles cases like "Texas 76092" or "Oklahoma 74101"
   */
  normalizeState(state) {
    if (!state || !state.trim()) return null;

    const stateStr = state.trim();

    // If already 2-letter uppercase, return as-is
    if (/^[A-Z]{2}$/.test(stateStr)) {
      return stateStr;
    }

    // If contains space or number, it's malformed (e.g., "Texas 76092")
    // Extract state mapping or return null
    const stateMap = {
      'texas': 'TX',
      'oklahoma': 'OK',
      'new mexico': 'NM',
      'california': 'CA',
      'louisiana': 'LA',
      'arkansas': 'AR',
      // Add more as needed
    };

    // Extract state name before space/number
    const stateName = stateStr.split(/[\s\d]/)[0].toLowerCase();
    return stateMap[stateName] || null;
  }

  /**
   * Process a single contact record
   */
  normalizeContact(contact) {
    const changes = {};
    let hasChanges = false;

    // Normalize address
    if (contact.address) {
      const normalized = this.normalizeAddress(contact.address);
      if (normalized !== contact.address) {
        changes.address = normalized;
        hasChanges = true;
        this.stats.addressCleaned++;
      }
    }

    // Normalize ZIP
    if (contact.zip) {
      const normalized = this.normalizeZip(contact.zip);
      if (normalized !== contact.zip) {
        changes.zip = normalized;
        hasChanges = true;
        this.stats.zipNormalized++;
      }
    }

    // Normalize state
    if (contact.state) {
      const normalized = this.normalizeState(contact.state);
      if (normalized && normalized !== contact.state) {
        changes.state = normalized;
        hasChanges = true;
        this.stats.stateNormalized++;
      }
    }

    return { hasChanges, changes };
  }

  /**
   * Process contacts in batches
   */
  async processBatch(offset) {
    const contacts = await Contact.findAll({
      where: {
        [Op.or]: [
          // Has address with comma
          { address: { [Op.like]: '%,%' } },
          // Has ZIP+4 format
          { zip: { [Op.like]: '%-%' } },
          // Has invalid state format
          {
            [Op.and]: [
              { state: { [Op.ne]: null } },
              { state: { [Op.notRegexp]: '^[A-Z]{2}$' } }
            ]
          }
        ]
      },
      limit: this.batchSize,
      offset,
      order: [['id', 'ASC']]
    });

    if (contacts.length === 0) {
      return false; // No more records
    }

    console.log(`\n📦 Processing batch at offset ${offset} (${contacts.length} records)...`);

    for (const contact of contacts) {
      this.stats.total++;

      try {
        const { hasChanges, changes } = this.normalizeContact(contact);

        if (hasChanges) {
          if (this.dryRun) {
            console.log(`[DRY RUN] Would update contact ${contact.id}:`);
            console.log(`  Original: address="${contact.address}", city="${contact.city}", state="${contact.state}", zip="${contact.zip}"`);
            console.log(`  Changes:`, changes);
          } else {
            await contact.update(changes);
            console.log(`✅ Updated contact ${contact.id}`);
          }
        } else {
          this.stats.skipped++;
        }

      } catch (error) {
        console.error(`❌ Error processing contact ${contact.id}: ${error.message}`);
        this.stats.errors++;
      }
    }

    return true; // More records available
  }

  /**
   * Run the normalization process
   */
  async run() {
    console.log('🚀 Starting address data normalization...\n');
    console.log(`Mode: ${this.dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log(`Batch size: ${this.batchSize}\n`);

    const startTime = Date.now();
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      hasMore = await this.processBatch(offset);
      offset += this.batchSize;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n' + '='.repeat(60));
    console.log('📊 NORMALIZATION COMPLETE');
    console.log('='.repeat(60));
    console.log(`Total contacts processed: ${this.stats.total}`);
    console.log(`Addresses cleaned: ${this.stats.addressCleaned}`);
    console.log(`ZIP codes normalized: ${this.stats.zipNormalized}`);
    console.log(`State codes normalized: ${this.stats.stateNormalized}`);
    console.log(`Skipped (no changes): ${this.stats.skipped}`);
    console.log(`Errors: ${this.stats.errors}`);
    console.log(`Duration: ${duration}s`);
    console.log('='.repeat(60));

    if (this.dryRun) {
      console.log('\n⚠️  This was a DRY RUN. No changes were made to the database.');
      console.log('Run without --dry-run to apply changes.');
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes('--dry-run'),
  batchSize: 100
};

// Check for custom batch size
const batchSizeArg = args.find(arg => arg.startsWith('--batch-size='));
if (batchSizeArg) {
  options.batchSize = parseInt(batchSizeArg.split('=')[1]);
}

// Run the normalizer
(async () => {
  try {
    const normalizer = new AddressNormalizer(options);
    await normalizer.run();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
